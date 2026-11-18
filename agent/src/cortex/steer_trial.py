"""Stage 7b sandbox trial: can a targeted edit to the Gather model's weights stick?

A SEPARATE copy of Qwen3-1.7B (the Gather layer), loaded here, never the live
service's. Same 4-bit quantisation as the live service (the GPU has no room
for an fp16 copy beside the running bot), so its answers match the live
layer's; every edit is kept in fp16 as a patch file and added to one decoder
layer's MLP weights (down_proj: W' = W + dW, plus a bias db).

    python steer_trial.py score   [--patch P.pt] [--out scores.json]
    python steer_trial.py index   [--layers 8,12,16,20,24]       -> units.json
    python steer_trial.py make    --spec spec.json --out P.pt    (spec: the edit Opus chose)
    python steer_trial.py effect  [--layers ...]                 -> each unit's pull on "nothing"

Inputs: logs/steer-trial/cases.jsonl and index.jsonl (agent/src/tools/steerCases.js).
Scoring is the live service's (cortex/layer_service.py): the acts as letters,
one forward pass, the probability of each letter; asked twice with the options
in two shuffled orders (fixed per case, the same before and after an edit) and
averaged.
"""
import hashlib
import json
import os
import random
import sys
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
OUT = os.path.join(ROOT, "logs", "steer-trial")
NAME = "Qwen/Qwen3-1.7B"
LETTERS = "ABCDEFGHIJKL"
PASSES = 2


def arg(name, default=None):
    return sys.argv[sys.argv.index(f"--{name}") + 1] if f"--{name}" in sys.argv else default


def read_jsonl(p):
    with open(p, encoding="utf8") as f:
        return [json.loads(l) for l in f if l.strip()]


# ---------------------------------------------------------------- the model
tok = None
model = None
letter_ids = None


def load():
    global tok, model, letter_ids
    t0 = time.time()
    tok = AutoTokenizer.from_pretrained(NAME)
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.float16)
    model = AutoModelForCausalLM.from_pretrained(NAME, quantization_config=quant, device_map="cuda", dtype=torch.float16)
    model.eval()
    letter_ids = [tok.encode(L, add_special_tokens=False)[0] for L in LETTERS]
    print(f"[trial] {NAME} (sandbox copy, 4-bit) loaded in {time.time() - t0:.0f}s, "
          f"{torch.cuda.memory_allocated() / 1e9:.2f} GB", flush=True)


def prompt(case, acts):
    """Exactly the live service's prompt (layer_service.prompt_for)."""
    lines = [case.get("job", ""), "", "Right now: " + case.get("situation", "")]
    mem = case.get("memories") or []
    if mem:
        lines += ["", "What I remember that fits:"] + [f"- {m}" for m in mem]
    lines += ["", "Which ONE of these should I do now?"] + [f"{LETTERS[i]}. {a}" for i, a in enumerate(acts)]
    lines += ["", "Answer with the letter only."]
    msgs = [{"role": "user", "content": "\n".join(lines)}]
    return tok.apply_chat_template(msgs, enable_thinking=False, add_generation_prompt=True, tokenize=False)


def orders(case):
    """PASSES shuffled orders of the menu, fixed per case (seeded by its id)."""
    n = len(case["acts"])
    rng = random.Random(int(hashlib.md5(case["id"].encode()).hexdigest()[:8], 16))
    out = []
    for _ in range(PASSES):
        o = list(range(n))
        rng.shuffle(o)
        out.append(o)
    return out


@torch.no_grad()
def forward(text, want_hidden=False):
    ids = tok(text, return_tensors="pt").to("cuda")
    res = model(**ids, output_hidden_states=want_hidden)
    return res


@torch.no_grad()
def score_case(case):
    keys = case["keys"]
    total = {k: 0.0 for k in keys}
    for order in orders(case):
        acts = [case["acts"][i] for i in order]
        logits = forward(prompt(case, acts)).logits[0, -1].float()
        probs = torch.softmax(logits[torch.tensor(letter_ids[: len(acts)], device=logits.device)], -1).tolist()
        for pos, i in enumerate(order):
            total[keys[i]] += probs[pos] / PASSES
    pick = max(total, key=total.get)
    return {"id": case["id"], "set": case["set"], "kind": case.get("kind"), "probs": {k: round(v, 4) for k, v in total.items()},
            "pick": pick, "right": case["right"], "ok": pick == case["right"]}


def summary(rows, half=None):
    """half: "check" (the half Opus sees between rounds) or "held" (only for the final report)."""
    out = {}
    for s in ("test", "control"):
        r = [x for x in rows if x["set"] == s and (half is None or x["half"] == half)]
        if not r:
            continue
        out[s] = {
            "n": len(r),
            "right": sum(x["ok"] for x in r),
            "pRight": round(sum(x["probs"].get(x["right"], 0) for x in r) / len(r), 3),
            "pNothing": round(sum(x["probs"].get("nothing", 0) for x in r) / len(r), 3),
            "picks": {k: sum(1 for x in r if x["pick"] == k) for k in sorted({x["pick"] for x in r})},
        }
        if s == "control":
            out[s]["byKind"] = {k: f'{sum(x["ok"] for x in r if x["kind"] == k)}/{sum(1 for x in r if x["kind"] == k)}'
                                for k in sorted({x["kind"] for x in r})}
    return out


# ---------------------------------------------------------------- patches
class Patched(torch.nn.Module):
    """down_proj with a weight patch: y = base(x) + x @ dW^T + db (dW kept as low rank / columns)."""

    def __init__(self, base, cols=None, dcols=None, U=None, V=None, db=None):
        super().__init__()
        self.base = base
        self.cols, self.dcols, self.U, self.V, self.db = cols, dcols, U, V, db

    def forward(self, x):
        y = self.base(x)
        if self.cols is not None:  # dW only in some columns (neurons): y += x[..., cols] @ dcols^T
            y = y + x[..., self.cols] @ self.dcols.T.to(x.dtype)
        if self.U is not None:  # dW = U V^T (rank r)
            y = y + (x @ self.V.to(x.dtype)) @ self.U.T.to(x.dtype)
        if self.db is not None:
            y = y + self.db.to(x.dtype)
        return y


def apply_patch(path):
    p = torch.load(path)
    mlp = model.model.layers[p["layer"]].mlp
    dev = "cuda"
    mlp.down_proj = Patched(mlp.down_proj,
                            cols=p.get("cols").to(dev) if p.get("cols") is not None else None,
                            dcols=p.get("dcols").to(dev) if p.get("dcols") is not None else None,
                            U=p.get("U").to(dev) if p.get("U") is not None else None,
                            V=p.get("V").to(dev) if p.get("V") is not None else None,
                            db=p.get("db").to(dev) if p.get("db") is not None else None)
    if not os.path.basename(path).startswith("_"): print(f"[trial] patch {os.path.basename(path)}: layer {p['layer']}, {p.get('what', '')}", flush=True)
    return p


def down_weight(layer):
    """The layer's down_proj weight in fp16 (dequantised from 4-bit)."""
    import bitsandbytes.functional as F
    w = model.model.layers[layer].mlp.down_proj
    w = w.base if isinstance(w, Patched) else w
    return F.dequantize_4bit(w.weight.data, w.weight.quant_state).to(torch.float16)  # [hidden, inter]


def make_patch(spec, units):
    """Turn the edit Opus chose into a weight patch.

    kinds:
      direction  - add strength x (the spread of situations along it) x a unit
                   direction to the layer's output, always (a bias in down_proj).
      neurons    - scale chosen MLP neurons' outgoing weights by (1 + strength):
                   they push harder when, and only when, they fire.
      keyed      - a rank-1 change W' = W + strength*size * d k^T / (k.k_on): adds the
                   unit direction d in proportion to how much the MLP's input
                   looks like the "worth gathering" key k (fires on the situations
                   that resemble the key, ~0 on the opposite).
    """
    layer = int(spec["layer"])
    L = units["layers"][str(layer)]
    kind = spec["kind"]
    s = float(spec["strength"])
    patch = {"layer": layer, "spec": spec}
    if kind == "direction":
        d = torch.tensor(L["directions"][spec["unit"]]["vector"], dtype=torch.float32)
        size = L["directions"][spec["unit"]]["spread"]  # strength is in spreads along the direction
        patch["db"] = (s * size * d / d.norm()).to(torch.float16)
        patch["what"] = f"direction {spec['unit']} x{s} (always on)"
    elif kind == "neurons":
        cols = torch.tensor([int(n) for n in spec["neurons"]], dtype=torch.long)
        W = down_weight(layer).float().cpu()
        patch["cols"] = cols
        patch["dcols"] = (s * W[:, cols]).to(torch.float16)  # dW[:, cols] = s * W[:, cols]
        patch["what"] = f"neurons {spec['neurons']} outgoing weights x(1{'+' if s >= 0 else ''}{s})"
    elif kind == "keyed":
        d = torch.tensor(L["directions"][spec["unit"]]["vector"], dtype=torch.float32)
        d = d / d.norm()
        k = torch.tensor(L["key"]["vector"], dtype=torch.float32)  # mean MLP input: gatherable minus not
        k_on = torch.tensor(L["key"]["onMean"], dtype=torch.float32)  # mean MLP input on gatherable
        k_off = torch.tensor(L["key"]["offMean"], dtype=torch.float32)
        # gate(x) = k.(x - off) / k.(on - off): 1 on a typical gatherable moment, 0 on a typical other one.
        denom = float(k @ (k_on - k_off))
        size = L["directions"][spec["unit"]]["spread"]  # strength is in spreads along the direction
        patch["U"] = (s * size * d).unsqueeze(1).to(torch.float16)  # [hidden, 1]
        patch["V"] = (k / denom).unsqueeze(1).to(torch.float16)  # [inter, 1]
        patch["db"] = (-(s * size) * float(k @ k_off) / denom * d).to(torch.float16)
        patch["what"] = f"keyed rank-1: direction {spec['unit']} x{s} gated by the 'worth gathering' key"
    else:
        raise ValueError(f"unknown kind {kind}")
    return patch


# ---------------------------------------------------------------- the index
def capture(case, layers):
    """Residual stream after each decoder layer, and each layer's MLP input, at the answer position."""
    acts = [case["acts"][i] for i in orders(case)[0]]
    mlp_in = {}
    hooks = []
    for l in layers:
        dp = model.model.layers[l].mlp.down_proj

        def hook(mod, inp, l=l):
            mlp_in[l] = inp[0][0, -1].float().cpu()
        hooks.append(dp.register_forward_pre_hook(hook))
    try:
        res = forward(prompt(case, acts), want_hidden=True)
    finally:
        for h in hooks:
            h.remove()
    hs = {l: res.hidden_states[l + 1][0, -1].float().cpu() for l in layers}
    logits = res.logits[0, -1].float()
    probs = torch.softmax(logits[torch.tensor(letter_ids[: len(acts)], device=logits.device)], -1).tolist()
    order = orders(case)[0]
    p_nothing = sum(probs[pos] for pos, i in enumerate(order) if case["keys"][i] == "nothing")
    return hs, mlp_in, p_nothing


def short(case):
    s = case["situation"]
    s = s.replace("Hunger ", "H").replace(" (of 100)", "")
    pick = [a for a in case["acts"] if not a.startswith("nothing")]
    return f"{s} | menu: {'; '.join(pick) or '(nothing else)'}"


def build_index(layers):
    cases = read_jsonl(os.path.join(OUT, "index.jsonl"))
    H = {l: [] for l in layers}
    M = {l: [] for l in layers}
    pn = []
    t0 = time.time()
    for c in cases:
        hs, mi, p = capture(c, layers)
        for l in layers:
            H[l].append(hs[l])
            M[l].append(mi[l])
        pn.append(p)
    print(f"[trial] captured {len(cases)} situations in {time.time() - t0:.0f}s", flush=True)
    y = torch.tensor([1.0 if c["gatherable"] else 0.0 for c in cases])
    on, off = y == 1, y == 0
    out = {"model": NAME, "n": len(cases), "gatherable": int(on.sum()), "layers": {}}
    for l in layers:
        X = torch.stack(H[l])  # [n, hidden]
        Xi = torch.stack(M[l])  # [n, inter]
        size = float(X.norm(dim=1).mean())
        dirs = {}
        # 1. the contrast direction: mean(worth gathering) - mean(not)
        contrast = X[on].mean(0) - X[off].mean(0)
        dirs["gather-contrast"] = contrast
        # 2. the top principal directions of the layer
        Xc = X - X.mean(0)
        _, _, Vt = torch.linalg.svd(Xc, full_matrices=False)
        for k in range(4):
            v = Vt[k]
            if float((X[on] @ v).mean() - (X[off] @ v).mean()) < 0:
                v = -v  # oriented so + leans toward "worth gathering"
            dirs[f"pc{k + 1}"] = v
        # 3. along the direction that most separates "nothing" from the rest of the model's own answers
        pnt = torch.tensor(pn)
        w = (pnt - pnt.mean())
        dirs["says-nothing"] = -(Xc * w[:, None]).mean(0)  # minus: + = less "nothing"
        desc = {}
        for name, v in dirs.items():
            u = v / v.norm()
            proj = (X @ u)
            top = torch.argsort(proj, descending=True)[:5].tolist()
            bot = torch.argsort(proj)[:5].tolist()
            sep = float((proj[on].mean() - proj[off].mean()) / (proj.std() + 1e-6))
            corr = float(torch.corrcoef(torch.stack([proj, pnt]))[0, 1])
            desc[name] = {"vector": u.tolist(), "spread": round(float(proj.std()), 3), "gap": round(float(proj[on].mean() - proj[off].mean()), 3), "separation": round(sep, 2), "corrWithNothing": round(corr, 2),
                          "top": [short(cases[i]) for i in top], "bottom": [short(cases[i]) for i in bot]}
        # 4. MLP neurons that fire more on "worth gathering"
        mu_on, mu_off = Xi[on].mean(0), Xi[off].mean(0)
        sd = Xi.std(0) + 1e-3
        z = (mu_on - mu_off) / sd
        neurons = []
        for n in torch.argsort(z.abs(), descending=True)[:12].tolist():
            act = Xi[:, n]
            neurons.append({"neuron": n, "z": round(float(z[n]), 2), "onMean": round(float(mu_on[n]), 3), "offMean": round(float(mu_off[n]), 3),
                            "corrWithNothing": round(float(torch.corrcoef(torch.stack([act, pnt]))[0, 1]), 2),
                            "top": [short(cases[i]) for i in torch.argsort(act, descending=True)[:3].tolist()]})
        key = mu_on - mu_off
        out["layers"][str(l)] = {"residualNorm": round(size, 2), "directions": desc, "neurons": neurons,
                                 "key": {"vector": key.tolist(), "onMean": mu_on.tolist(), "offMean": mu_off.tolist()}}
    return out


@torch.no_grad()
def effects(units, probes, strengths=(2.0,)):
    """Each direction's pull on the choice: add it to the layer output (strength in
    spreads, + = toward "worth gathering"), and see P(nothing) move on a probe of
    gatherable situations and on a probe of night / hostile ones (none in the test set)."""
    def mean_nothing(cs):
        rows = [score_case(c) for c in cs]
        return sum(r["probs"]["nothing"] for r in rows) / len(rows)
    base = {k: mean_nothing(v) for k, v in probes.items()}
    out = {}
    tmp = os.path.join(OUT, "_probe.pt")
    for l, L in units["layers"].items():
        for name in L["directions"]:
            for s in strengths:
                torch.save(make_patch({"layer": int(l), "kind": "direction", "unit": name, "strength": s}, units), tmp)
                apply_patch(tmp)
                out[f"{l}/{name}/{s}"] = {k: round(mean_nothing(v) - base[k], 3) for k, v in probes.items()}
                unpatch(int(l))
    return {"baseNothing": {k: round(v, 3) for k, v in base.items()}, "deltaNothing": out}


def with_patch(path):
    return apply_patch(path)


def unpatch(layer):
    mlp = model.model.layers[layer].mlp
    if isinstance(mlp.down_proj, Patched):
        mlp.down_proj = mlp.down_proj.base


def main():
    cmd = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    load()
    if cmd == "score":
        patches = [p for p in (arg("patch") or "").split(",") if p]
        for p in patches:
            apply_patch(p)
        cases = read_jsonl(arg("cases", os.path.join(OUT, "cases.jsonl")))
        t0 = time.time()
        seen = {}
        for c in cases:  # alternate halves within each set, in time order
            seen[c["set"]] = seen.get(c["set"], -1) + 1
            c["half"] = "check" if seen[c["set"]] % 2 == 0 else "held"
        rows = [dict(score_case(c), half=c["half"]) for c in cases]
        res = {"patches": patches, "summary": {"all": summary(rows), "check": summary(rows, "check"), "held": summary(rows, "held")}, "rows": rows, "secs": round(time.time() - t0)}
        with open(arg("out", os.path.join(OUT, "scores-base.json")), "w", encoding="utf8") as f:
            json.dump(res, f, indent=1)
        print(json.dumps({k: {s: {x: v[s][x] for x in ("right", "pRight", "pNothing", "picks")} for s in v} for k, v in res["summary"].items()}))
    elif cmd == "index":
        layers = [int(x) for x in arg("layers", "6,10,14,18,22").split(",")]
        res = build_index(layers)
        with open(os.path.join(OUT, "units.json"), "w", encoding="utf8") as f:
            json.dump(res, f)
        for l, L in res["layers"].items():
            print(f"layer {l} (size {L['residualNorm']}):", {k: (v["separation"], v["corrWithNothing"]) for k, v in L["directions"].items()})
    elif cmd == "effect":
        with open(os.path.join(OUT, "units.json"), encoding="utf8") as f:
            units = json.load(f)
        idx = read_jsonl(os.path.join(OUT, "index.jsonl"))
        probes = {"gatherable": [c for c in idx if c["gatherable"]][::10][:8],
                  "night or hostile": [c for c in idx if not c["gatherable"] and "pickup" in c["keys"]][::5][:8]}
        res = effects(units, probes, strengths=tuple(float(x) for x in arg("strengths", "2").split(",")))
        with open(os.path.join(OUT, "effects.json"), "w", encoding="utf8") as f:
            json.dump(res, f, indent=1)
        print(json.dumps(res, indent=1))
    elif cmd == "round":
        # Fold in the edit Opus chose this round (replacing the last), score, record flips.
        n = int(arg("n"))
        with open(os.path.join(OUT, f"round-{n}-reply.json"), encoding="utf8") as f:
            reply = json.load(f)
        rounds_file = os.path.join(OUT, "rounds.json")
        rounds = json.load(open(rounds_file, encoding="utf8")) if os.path.exists(rounds_file) else []
        rounds = [r for r in rounds if r["round"] < n]
        entry = {"round": n, "decision": reply["decision"], "spec": reply.get("edit"), "why": reply.get("why"), "expect": reply.get("expect")}
        with open(os.path.join(OUT, "units.json"), encoding="utf8") as f:
            units = json.load(f)
        spec = reply.get("edit")
        if spec and reply["decision"] in ("edit", "adjust", "withdraw"):
            spec = dict(spec)
            if "unit" in spec:
                spec["unit"] = str(spec["unit"]).split("/")[-1]
            if "neurons" in spec:
                spec["neurons"] = [int(str(x).split("/")[-1].lstrip("n")) for x in spec["neurons"]]
            pp = os.path.join(OUT, f"patch-round-{n}.pt")
            torch.save(make_patch(spec, units), pp)
            apply_patch(pp)
            entry["patch"] = os.path.basename(pp)
            cases = read_jsonl(os.path.join(OUT, "cases.jsonl"))
            seen = {}
            for c in cases:
                seen[c["set"]] = seen.get(c["set"], -1) + 1
                c["half"] = "check" if seen[c["set"]] % 2 == 0 else "held"
            rows = [dict(score_case(c), half=c["half"]) for c in cases]
            res = {"patches": [pp], "summary": {"all": summary(rows), "check": summary(rows, "check"), "held": summary(rows, "held")}, "rows": rows}
            json.dump(res, open(os.path.join(OUT, f"scores-round-{n}.json"), "w", encoding="utf8"), indent=1)
            base = {r["id"]: r for r in json.load(open(os.path.join(OUT, "scores-base.json"), encoding="utf8"))["rows"]}
            chk = [r for r in rows if r["half"] == "check"]
            entry["result"] = {"check": res["summary"]["check"]}  # the held-out half stays out of Opus's sight
            entry["flips"] = {
                "fixedTest": [r["id"] for r in chk if r["set"] == "test" and r["ok"] and not base[r["id"]]["ok"]],
                "brokeTest": [r["id"] for r in chk if r["set"] == "test" and not r["ok"] and base[r["id"]]["ok"]],
                "fixedControl": [r["id"] for r in chk if r["set"] == "control" and r["ok"] and not base[r["id"]]["ok"]],
                "brokeControl": [r["id"] for r in chk if r["set"] == "control" and not r["ok"] and base[r["id"]]["ok"]],
                "stillWrongTest": [r["id"] for r in chk if r["set"] == "test" and not r["ok"]],
            }
            print(json.dumps({k: {s: {x: v[s][x] for x in ("right", "pNothing", "picks")} | ({"byKind": v[s]["byKind"]} if s == "control" else {}) for s in v} for k, v in res["summary"].items()}))
            print({k: len(v) for k, v in entry["flips"].items()})
        rounds.append(entry)
        json.dump(rounds, open(rounds_file, "w", encoding="utf8"), indent=1)
    elif cmd == "make":
        with open(os.path.join(OUT, "units.json"), encoding="utf8") as f:
            units = json.load(f)
        with open(arg("spec"), encoding="utf8") as f:
            spec = json.load(f)
        p = make_patch(spec, units)
        torch.save(p, arg("out"))
        print(f"[trial] patch written: {p['what']}")


if __name__ == "__main__":
    main()
