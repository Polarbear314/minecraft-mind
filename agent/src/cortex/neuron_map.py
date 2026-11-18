"""Stage 7b, part 2: a map of EVERY MLP neuron of the Gather model, and Opus's scalpel.

Sandbox only (the same separate 4-bit copy as steer_trial.py; the live bot and
its service are never touched).

    python neuron_map.py map      -> logs/steer-trial/neurons/  (fingerprints, words, groups)
    python neuron_map.py effect   -> each group's pull when switched off
    python neuron_map.py run --ops ops.json --out res.json [--cases cases.jsonl] [--half check|held|all]
    python neuron_map.py inspect --groups 18:3,20:7       -> member neurons, for Opus

THE MAP. Each of the 28 x 6,144 = 172,032 neurons gets a fingerprint: how
strongly it fires (its MLP activation at the answer position) in each of
~1,000 of MindBot's own logged situations. One forward pass computes every
neuron at once. Per layer, neurons are grouped by fingerprint (k-means on the
top principal components; 16 groups per layer = 448 groups). Each neuron and
group also gets:
  - what it fires on: its top situations, and how its firing differs between
    situations worth gathering and the rest (z), and its correlation with the
    model's own P(nothing);
  - what it writes: its output weights projected onto the vocabulary (logit
    lens), top words pushed up and down; and how much its output points along
    the layer's "says nothing" direction (cos).

OPUS'S SCALPEL (ops it writes itself; this tool only executes and measures):
  {"op": "scale_out", "layer": L, "neurons": [n..] | "group": g, "factor": f}
      W_down[:, n] *= f        (0 = switch off, 0.5 = weaken, 1.5 = strengthen)
  {"op": "fire_more", "layer": L, "neurons": [n..] | "group": g, "amount": a}
      a bias on the neuron's gate: it fires more (a > 0) or less everywhere
  {"op": "write", "layer": L, "neurons": [n..], "toward": "less-nothing" | "more-nothing", "amount": a}
      W_down[:, n] += a * |W_down[:, n]| * d  (d: the layer's says-nothing direction):
      the neuron, when it fires, now pushes the answer away from (or toward) "nothing"
Every op becomes a weight patch on that layer (kept in fp16 beside the 4-bit weights).
"""
import json
import os
import random
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(__file__))
import steer_trial as st  # noqa: E402  (model loading, prompts, scoring: the live service's way)

OUT = os.path.join(st.OUT, "neurons")
K = 16  # groups per layer
NL = 28


def arg(name, default=None):
    return sys.argv[sys.argv.index(f"--{name}") + 1] if f"--{name}" in sys.argv else default


def short(c, n=170):
    s = c["situation"].replace(" (of 100)", "")
    m = [a for a in c["acts"] if not a.startswith("nothing")]
    s = f"{s} | menu: {'; '.join(m) or '-'}"
    return s if len(s) <= n else s[:n] + "…"


# ------------------------------------------------------------------ capture
@torch.no_grad()
def capture_all(cases):
    """MLP activations (input to down_proj) and residual at the answer position, every layer."""
    acts = torch.zeros(len(cases), NL, 6144, dtype=torch.float16)
    resid = torch.zeros(len(cases), NL, 2048, dtype=torch.float16)
    pn = torch.zeros(len(cases))
    buf = {}
    hooks = [st.model.model.layers[l].mlp.down_proj.register_forward_pre_hook(
        lambda m, inp, l=l: buf.__setitem__(l, inp[0][0, -1].half().cpu())) for l in range(NL)]
    try:
        for i, c in enumerate(cases):
            order = st.orders(c)[0]
            a = [c["acts"][j] for j in order]
            res = st.forward(st.prompt(c, a), want_hidden=True)
            for l in range(NL):
                acts[i, l] = buf[l]
                resid[i, l] = res.hidden_states[l + 1][0, -1].half().cpu()
            logits = res.logits[0, -1].float()
            probs = torch.softmax(logits[torch.tensor(st.letter_ids[: len(a)], device=logits.device)], -1).tolist()
            pn[i] = sum(probs[p] for p, j in enumerate(order) if c["keys"][j] == "nothing")
            if i % 200 == 0:
                print(f"[map] {i}/{len(cases)}", flush=True)
    finally:
        for h in hooks:
            h.remove()
    return acts, resid, pn


def kmeans(X, k, iters=40, seed=0):
    g = torch.Generator().manual_seed(seed)
    C = X[torch.randperm(len(X), generator=g)[:k]].clone()
    for _ in range(iters):
        lab = torch.cdist(X, C).argmin(1)
        for j in range(k):
            m = lab == j
            C[j] = X[m].mean(0) if m.any() else X[torch.randint(len(X), (1,), generator=g)]
    return lab


def build_map():
    cases = st.read_jsonl(os.path.join(st.OUT, "map.jsonl"))
    t0 = time.time()
    acts, resid, pn = capture_all(cases)
    print(f"[map] captured {len(cases)} situations x 172,032 neurons in {time.time() - t0:.0f}s", flush=True)
    y = torch.tensor([1.0 if c["gatherable"] else 0.0 for c in cases])
    on, off = y == 1, y == 0
    # The final norm and unembedding, for the logit lens.
    W_U = st.model.lm_head.weight  # [vocab, 2048] fp16 on GPU (tied to the embeddings)
    normw = st.model.model.norm.weight.float()
    pnc = (pn - pn.mean())
    neurons, groups, dirs = {}, [], {}
    for l in range(NL):
        A = acts[:, l].float()  # [n, 6144]
        R = resid[:, l].float()
        d = -((R - R.mean(0)) * pnc[:, None]).mean(0)  # + = less "nothing" (as in steer_trial)
        d = d / d.norm()
        dirs[l] = d
        mu_on, mu_off = A[on].mean(0), A[off].mean(0)
        sd = A.std(0) + 1e-4
        z = (mu_on - mu_off) / sd
        Ac = A - A.mean(0)
        corr = (Ac * pnc[:, None]).mean(0) / (A.std(0) * pnc.std() + 1e-6)
        Wd = st.down_weight(l).float()  # [2048, 6144] on GPU
        cos = (d.cuda() @ Wd) / (Wd.norm(dim=0) + 1e-6)  # + = when it fires, it pushes toward less "nothing"
        # logit lens: top words each neuron's output pushes up / down
        up_words, down_words = [], []
        for s in range(0, 6144, 512):  # fp16 and in chunks: the GPU is shared with the live bot
            lg = (W_U @ (Wd[:, s:s + 512] * normw[:, None]).half())  # [vocab, 512]
            up_words.append(lg.topk(5, dim=0).indices.T.cpu())
            down_words.append((-lg).topk(3, dim=0).indices.T.cpu())
            del lg
        up_words = torch.cat(up_words)
        down_words = torch.cat(down_words)
        # fingerprints: z-scored firing over situations, top 32 principal components
        F = Ac.T / (A.std(0)[:, None] * (len(cases) ** 0.5) + 1e-6)  # [6144, n]
        U, S, _ = torch.pca_lowrank(F, q=32, center=False)
        lab = kmeans(U * S, K, seed=l)
        top3 = A.topk(3, dim=0).indices.T  # [6144, 3]
        dec = lambda ids: [st.tok.decode([int(t)]) for t in ids]
        for n in range(6144):
            neurons[f"{l}:{n}"] = {"g": int(lab[n]), "z": round(float(z[n]), 2), "corrNothing": round(float(corr[n]), 2),
                                   "cos": round(float(cos[n]), 3), "up": dec(up_words[n]), "down": dec(down_words[n]),
                                   "top": [int(i) for i in top3[n]]}
        for g in range(K):
            m = (lab == g)
            members = m.nonzero().flatten()
            fire = A[:, m].mean(1)  # the group's mean firing per situation
            ex = fire.topk(5).indices.tolist()
            share = lambda key: round(float(sum(1 for i in ex if key(cases[i]))) / len(ex), 2)
            vsum = Wd[:, m].sum(1)
            lg = (W_U @ (vsum * normw).half()).float()
            groups.append({
                "id": f"{l}:{g}", "layer": l, "size": int(m.sum()),
                "z": round(float(((fire[on].mean() - fire[off].mean()) / (fire.std() + 1e-6))), 2),
                "corrNothing": round(float(torch.corrcoef(torch.stack([fire, pn]))[0, 1]), 2),
                "cos": round(float((d.cuda() @ vsum) / (vsum.norm() + 1e-6)), 3),
                "up": dec(lg.topk(8).indices.cpu()), "down": dec((-lg).topk(5).indices.cpu()),
                "top": [short(cases[i]) for i in ex[:4]],
                "topShare": {"day": share(lambda c: c["situation"].startswith("It is day")),
                             "sealed": share(lambda c: "closed in on every side" in c["situation"]),
                             "hostile": share(lambda c: "Hostile:" in c["situation"]),
                             "worthGathering": share(lambda c: c["gatherable"])},
                "strongest": [int(members[j]) for j in z[m].abs().argsort(descending=True)[:8].tolist()],
            })
        del Wd
        print(f"[map] layer {l} done ({time.time() - t0:.0f}s)", flush=True)
    os.makedirs(OUT, exist_ok=True)
    json.dump(groups, open(os.path.join(OUT, "groups.json"), "w", encoding="utf8"))
    json.dump(neurons, open(os.path.join(OUT, "neurons.json"), "w", encoding="utf8"))
    torch.save({l: lab_for(neurons, l) for l in range(NL)}, os.path.join(OUT, "labels.pt"))
    torch.save({l: dirs[l] for l in range(NL)}, os.path.join(OUT, "directions.pt"))
    json.dump([short(c, 400) for c in cases], open(os.path.join(OUT, "situations.json"), "w", encoding="utf8"))
    print(f"[map] {len(groups)} groups, {len(neurons)} neurons written in {time.time() - t0:.0f}s")


def lab_for(neurons, l):
    return torch.tensor([neurons[f"{l}:{n}"]["g"] for n in range(6144)])


# ------------------------------------------------------------------ the scalpel
class MLPPatch:
    """Per-layer edits: down_proj column scales / additions, and gate biases. Hooks, removable."""

    def __init__(self):
        self.handles = []

    def apply(self, ops, labels, dirs):
        per = {}
        for op in ops:
            l = int(op["layer"])
            ns = op.get("neurons")
            if ns is None and op.get("group") is not None:
                g = int(str(op["group"]).split(":")[-1])
                ns = (labels[l] == g).nonzero().flatten().tolist()
            ns = [int(str(n).split(":")[-1]) for n in ns]
            p = per.setdefault(l, {"scale": torch.ones(6144), "gate": torch.zeros(6144), "add": {}})
            if op["op"] == "scale_out":
                p["scale"][ns] *= float(op["factor"])
            elif op["op"] == "fire_more":
                p["gate"][ns] += float(op["amount"])
            elif op["op"] == "write":
                sign = 1.0 if op.get("toward", "less-nothing") == "less-nothing" else -1.0
                for n in ns:
                    p["add"][n] = p["add"].get(n, 0.0) + sign * float(op["amount"])
            else:
                raise ValueError(f"unknown op {op['op']}")
        for l, p in per.items():
            mlp = st.model.model.layers[l].mlp
            Wd = st.down_weight(l)  # fp16 [2048, 6144]
            changed = ((p["scale"] != 1).nonzero().flatten().tolist())
            add_cols = sorted(p["add"])
            cols = sorted(set(changed) | set(add_cols))
            if cols:
                ci = torch.tensor(cols, device="cuda")
                dW = Wd[:, ci].float() * (p["scale"][cols].cuda() - 1)[None, :]
                if add_cols:
                    d = dirs[l].cuda()
                    for k, n in enumerate(cols):
                        if n in p["add"]:
                            dW[:, k] += p["add"][n] * Wd[:, n].float().norm() * d
                dW = dW.half()
                self.handles.append(mlp.down_proj.register_forward_hook(
                    lambda m, inp, out, ci=ci, dW=dW: out + inp[0][..., ci] @ dW.T))
            if (p["gate"] != 0).any():
                gb = p["gate"].half().cuda()
                self.handles.append(mlp.gate_proj.register_forward_hook(lambda m, inp, out, gb=gb: out + gb))
        return {l: {"scaled": int((p["scale"] != 1).sum()), "gated": int((p["gate"] != 0).sum()), "written": len(p["add"])} for l, p in per.items()}

    def remove(self):
        for h in self.handles:
            h.remove()
        self.handles = []


def load_map():
    labels = torch.load(os.path.join(OUT, "labels.pt"))
    dirs = torch.load(os.path.join(OUT, "directions.pt"))
    return labels, dirs


def with_halves(cases):
    seen = {}
    for c in cases:
        seen[c["set"]] = seen.get(c["set"], -1) + 1
        c["half"] = "check" if seen[c["set"]] % 2 == 0 else "held"
    return cases


def run_ops(ops, cases, labels, dirs):
    patch = MLPPatch()
    touched = patch.apply(ops, labels, dirs) if ops else {}
    try:
        rows = [dict(st.score_case(c), half=c["half"]) for c in cases]
    finally:
        patch.remove()
    return rows, touched


def brief(rows, half):
    s = st.summary(rows, half)
    return {k: {x: v.get(x) for x in ("right", "n", "pNothing", "picks", "byKind")} for k, v in s.items()}


def effects():
    """Switch each group off; how do answers move on a probe of map situations?"""
    labels, dirs = load_map()
    cases = st.read_jsonl(os.path.join(st.OUT, "map.jsonl"))
    rng = random.Random(7)
    gat = [c for c in cases if c["gatherable"]]
    oth = [c for c in cases if not c["gatherable"] and "pickup" in c["keys"]]
    probe = rng.sample(gat, 12) + rng.sample(oth, min(12, len(oth)))
    for c in probe:
        c["set"] = "test" if c["gatherable"] else "control"
        c["right"] = "pickup" if c["gatherable"] else "nothing"
        c["half"] = "check"
    st.PASSES = 1
    base, _ = run_ops([], probe, labels, dirs)
    bn = {s: sum(r["probs"]["nothing"] for r in base if r["set"] == s) / sum(1 for r in base if r["set"] == s) for s in ("test", "control")}
    out = {}
    t0 = time.time()
    for l in range(NL):
        for g in range(K):
            rows, _ = run_ops([{"op": "scale_out", "layer": l, "group": g, "factor": 0}], probe, labels, dirs)
            out[f"{l}:{g}"] = {s: round(sum(r["probs"]["nothing"] for r in rows if r["set"] == s) / sum(1 for r in rows if r["set"] == s) - bn[s], 3)
                               for s in ("test", "control")}
        print(f"[effect] layer {l} ({time.time() - t0:.0f}s)", flush=True)
    json.dump({"base": bn, "offDeltaNothing": out, "probe": [c["id"] for c in probe]},
              open(os.path.join(OUT, "group-effects.json"), "w", encoding="utf8"), indent=1)


def inspect(ids):
    neurons = json.load(open(os.path.join(OUT, "neurons.json"), encoding="utf8"))
    groups = {g["id"]: g for g in json.load(open(os.path.join(OUT, "groups.json"), encoding="utf8"))}
    sits = json.load(open(os.path.join(OUT, "situations.json"), encoding="utf8"))
    out = {}
    for gid in ids:
        g = groups[gid]
        l = g["layer"]
        out[gid] = [{"neuron": f"{l}:{n}", **{k: v for k, v in neurons[f"{l}:{n}"].items() if k not in ("top", "g")},
                     "firesMostOn": [sits[i][:160] for i in neurons[f"{l}:{n}"]["top"][:2]]} for n in g["strongest"]]
    return out


def main():
    cmd = sys.argv[1]
    if cmd == "inspect":
        print(json.dumps(inspect(arg("groups").split(",")), indent=1))
        return
    st.load()
    if cmd == "map":
        build_map()
    elif cmd == "effect":
        effects()
    elif cmd == "run":
        labels, dirs = load_map()
        cases = with_halves(st.read_jsonl(arg("cases", os.path.join(st.OUT, "cases.jsonl"))))
        half = arg("half", "check")
        if half != "all":
            cases = [c for c in cases if c["half"] == half]
        experiments = json.load(open(arg("ops"), encoding="utf8"))  # [{"name", "ops": [...]}]
        results = []
        base_rows, _ = run_ops([], cases, labels, dirs)
        results.append({"name": "unedited", "result": brief(base_rows, None)})
        for e in experiments:
            rows, touched = run_ops(e["ops"], cases, labels, dirs)
            base_ok = {r["id"]: r["ok"] for r in base_rows}
            results.append({"name": e["name"], "ops": e["ops"], "touched": touched, "result": brief(rows, None),
                            "fixed": [r["id"] for r in rows if r["ok"] and not base_ok[r["id"]]],
                            "broke": [r["id"] for r in rows if not r["ok"] and base_ok[r["id"]]]})
            print(f"[run] {e['name']}: {json.dumps(results[-1]['result'])}", flush=True)
        json.dump(results, open(arg("out"), "w", encoding="utf8"), indent=1)


if __name__ == "__main__":
    main()
