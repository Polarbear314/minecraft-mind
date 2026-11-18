"""Stage 7b, part 3: write a decision into the Gather model's weights in one closed-form solve.

The combined method (docs/results-7b-trial.md, part 3):
  WHAT  a teacher: the creature's own judgement as labels, from 80 logged
        situations NOT in the test set (pick up by day, in the open, with no
        hostile within 10; "nothing" at night or with a hostile close).
  WHERE one layer's MLP neurons (columns of down_proj): either chosen
        automatically (the published recipe: a late layer, the neurons most
        active at the answer position) or by Opus from the neuron map.
  HOW   MEMIT-style least squares, no gradient step on any weight:
          1. for each teacher example, find the smallest change delta to that
             layer's MLP output at the answer position that makes the model's
             answer match the teacher (a few steps on delta only; weights frozen);
          2. keys k = what the chosen neurons hold there;
          3. dW = R K^T (K K^T + lam * P^T P + eps I)^-1, where P are the same
             neurons' values at positions whose output must NOT change (the
             rest of each prompt, and plain English text): the protection term;
          4. a dose (0.5-2x) and lam chosen on the CHECK half, refusing any edit
             that changes plain-text predictions by more than KL 0.03.
Sandbox only: the separate 4-bit copy of steer_trial.py, the edit kept as an fp16 patch.

    python decision_write.py targets --layer L          -> targets-L.pt (deltas, keys, protected values)
    python decision_write.py auto --layer L [--k 256]   -> where-auto-L.json (most active at the answer)
    python decision_write.py random --layer L --k N --seed s -> where-random-L-s.json
    python decision_write.py eval --where where.json --name X  -> dw-X.json (dose search on check, then held-out)
"""
import json
import os
import random
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(__file__))
import steer_trial as st  # noqa: E402

OUT = os.path.join(st.OUT, "neurons")
N_EACH = 40
STEPS = 20
SMOOTH = 0.85  # the teacher's probability on the right act; the rest share 0.15

PLAIN = [
    "The river runs past the old mill and into the valley, where the farmers grow wheat and barley.",
    "She opened the window, and the smell of rain came in from the garden.",
    "In 1905 Albert Einstein published four papers that changed physics.",
    "To make bread you need flour, water, salt and yeast, and some patience while the dough rises.",
    "The committee will meet on Thursday to discuss the budget for next year.",
    "Cats sleep for most of the day and hunt at dusk and dawn.",
    "The capital of France is Paris, and the capital of Japan is Tokyo.",
    "He put the book back on the shelf and walked slowly to the door.",
    "Photosynthesis turns light, water and carbon dioxide into sugar and oxygen.",
    "The train was late again, so we waited on the platform and talked about the weekend.",
    "A triangle has three sides, and the angles inside it add up to one hundred and eighty degrees.",
    "Mountains in the north are covered with snow for most of the winter.",
    "The museum opens at ten in the morning and closes at six in the evening.",
    "Water boils at one hundred degrees Celsius at sea level.",
    "They planted tomatoes, beans and sunflowers along the fence.",
    "The library has a quiet room where students can read without being disturbed.",
]


def arg(name, default=None):
    return sys.argv[sys.argv.index(f"--{name}") + 1] if f"--{name}" in sys.argv else default


def spread(items, n):
    if len(items) <= n:
        return items
    step = len(items) / n
    return [items[int(k * step)] for k in range(n)]


TEACHER = None  # set by --teacher laya


def teacher_cases():
    """80 logged situations, none from the test set: 40 where gathering was right, 40 where 'nothing' was."""
    cases = st.read_jsonl(os.path.join(st.OUT, "map.jsonl"))
    pos = spread([c for c in cases if c["gatherable"] and "pickup" in c["keys"]], N_EACH)
    neg = spread([c for c in cases if not c["gatherable"] and "pickup" in c["keys"]], N_EACH)
    out = []
    for c in pos + neg:
        right = "pickup" if c["gatherable"] else "nothing"
        q = {k: (SMOOTH if k == right else (1 - SMOOTH) / (len(c["keys"]) - 1)) for k in c["keys"]}
        if TEACHER:  # a learned teacher (laya_teacher.py): its probability of pick up vs nothing; other acts 0.04
            t = TEACHER[c["id"]]
            others = [k for k in c["keys"] if k not in ("pickup", "nothing")]
            q = {k: 0.04 / max(1, len(others)) for k in others}
            q["pickup"] = (1 - 0.04 * bool(others)) * min(0.98, max(0.02, t["pickup"]))
            q["nothing"] = (1 - 0.04 * bool(others)) - q["pickup"]
            right = "pickup" if t["pickup"] >= 0.5 else "nothing"
        out.append({**c, "teacher": q, "right": right})
    return out


def letter_logprobs(logits, n):
    return torch.log_softmax(logits[torch.tensor(st.letter_ids[:n], device=logits.device)].float(), -1)


def targets(layer):
    """Per example and order: the delta at the answer position, the keys, and protected values."""
    for p in st.model.parameters():
        p.requires_grad_(False)
    dp = st.model.model.layers[layer].mlp.down_proj
    examples = teacher_cases()
    state = {"delta": None, "keys": None}

    def add_delta(m, inp, out):
        state["keys"] = inp[0][0].detach().float().cpu()  # [T, 6144]: what the neurons hold at every position
        if state["delta"] is not None:
            out = out.clone()
            out[:, -1] = out[:, -1] + state["delta"].to(out.dtype)
        return out

    h = dp.register_forward_hook(add_delta)
    # The layer's typical size at the answer position, to set the step.
    with torch.no_grad():
        norms = []
        for c in examples[:6]:
            acts = [c["acts"][j] for j in st.orders(c)[0]]
            res = st.forward(st.prompt(c, acts), want_hidden=True)
            norms.append(float(res.hidden_states[layer + 1][0, -1].float().norm()))
    size = sum(norms) / len(norms)
    lr = 0.002 * size
    rows = []
    t0 = time.time()
    try:
        for c in examples:
            for order in st.orders(c):
                acts = [c["acts"][j] for j in order]
                q = torch.tensor([c["teacher"][c["keys"][j]] for j in order], device="cuda")
                ids = st.tok(st.prompt(c, acts), return_tensors="pt").to("cuda")
                delta = torch.zeros(2048, device="cuda", requires_grad=True)
                opt = torch.optim.Adam([delta], lr=lr)
                state["delta"] = delta
                for step in range(STEPS):
                    logits = st.model(**ids).logits[0, -1]
                    lp = letter_logprobs(logits, len(acts))
                    kl = (q * (torch.log(q) - lp)).sum()
                    loss = kl + 1e-3 * (delta.norm() / size) ** 2
                    if step == 0:
                        kl0 = float(kl)
                        keys = state["keys"]
                    if float(kl) < 0.03:
                        break
                    opt.zero_grad()
                    loss.backward()
                    opt.step()
                T = keys.shape[0]
                pos = random.Random(len(rows)).sample(range(T - 1), min(16, T - 1))
                rows.append({"id": c["id"], "right": c["right"], "kl0": kl0, "kl": float(kl),
                             "delta": delta.detach().float().cpu(), "key": keys[-1].clone(),
                             "protect": keys[pos].half()})
            if len(rows) % 20 == 0:
                print(f"[targets] layer {layer}: {len(rows)}/{2 * len(examples)} ({time.time() - t0:.0f}s), last KL {kl0:.2f} -> {float(kl):.3f}", flush=True)
        state["delta"] = None
        plain = []
        with torch.no_grad():
            for s in PLAIN:
                st.model(**st.tok(s, return_tensors="pt").to("cuda"))
                plain.append(state["keys"].half())
    finally:
        h.remove()
    torch.save({"layer": layer, "size": size, "rows": rows, "plain": torch.cat(plain)}, os.path.join(OUT, f"targets-{layer}{SUFFIX}.pt"))
    kls = [r["kl0"] for r in rows]
    print(f"[targets] layer {layer}: {len(rows)} examples in {time.time() - t0:.0f}s; mean KL to teacher {sum(kls) / len(kls):.2f} -> "
          f"{sum(r['kl'] for r in rows) / len(rows):.3f}; mean |delta| {sum(float(r['delta'].norm()) for r in rows) / len(rows):.1f} (layer size {size:.0f})")


def solve(T, cols, lam):
    """dW (2048 x |S|) = R K^T (K K^T + lam * n/Np * P^T P + eps I)^-1."""
    S = torch.tensor(cols)
    K = torch.stack([r["key"][S] for r in T["rows"]]).double()  # [n, s]
    R = torch.stack([r["delta"] for r in T["rows"]]).double()  # [n, 2048]
    P = torch.cat([torch.cat([r["protect"] for r in T["rows"]]), T["plain"]])[:, S].double()  # [Np, s]
    n, Np = K.shape[0], P.shape[0]
    A = K.T @ K + lam * (n / Np) * (P.T @ P)
    A += 1e-4 * A.diagonal().mean() * torch.eye(A.shape[0], dtype=A.dtype)
    W = torch.linalg.solve(A, K.T @ R).T  # [2048, s]
    return W.float()


class Write:
    def __init__(self, layer, cols, dW):
        self.layer, self.ci, self.dW = layer, torch.tensor(cols, device="cuda"), dW.half().cuda()
        self.h = None

    def __enter__(self):
        self.h = st.model.model.layers[self.layer].mlp.down_proj.register_forward_hook(
            lambda m, inp, out: out + inp[0][..., self.ci] @ self.dW.T)
        return self

    def __exit__(self, *a):
        self.h.remove()


@torch.no_grad()
def plain_logprobs():
    out = []
    for s in PLAIN:
        out.append(torch.log_softmax(st.model(**st.tok(s, return_tensors="pt").to("cuda")).logits[0].float(), -1))
    return out


def plain_kl(base):
    now = plain_logprobs()
    return sum(float((b.exp() * (b - n)).sum(-1).mean()) for b, n in zip(base, now)) / len(base)


def halves():
    cases = st.read_jsonl(os.path.join(st.OUT, "cases.jsonl"))
    seen = {}
    for c in cases:
        seen[c["set"]] = seen.get(c["set"], -1) + 1
        c["half"] = "check" if seen[c["set"]] % 2 == 0 else "held"
    return cases


def score(cases):
    return [dict(st.score_case(c), half=c["half"]) for c in cases]


def brief(rows, half):
    s = st.summary(rows, half)
    return {k: {x: v.get(x) for x in ("right", "n", "pNothing", "picks", "byKind")} for k, v in s.items()}


def evaluate(where, name):
    T = torch.load(os.path.join(OUT, f"targets-{where['layer']}{SUFFIX}.pt"))
    cols = sorted(set(int(c) for c in where["neurons"]))
    cases = halves()
    check = [c for c in cases if c["half"] == "check"]
    base_plain = plain_logprobs()
    tried = []
    for lam in (1.0, 10.0, 100.0):
        W = solve(T, cols, lam)
        for dose in (0.5, 1.0, 1.5, 2.0):
            with Write(where["layer"], cols, dose * W):
                kl = plain_kl(base_plain)
                rows = score(check) if kl <= 0.03 else None
            r = {"lam": lam, "dose": dose, "plainKL": round(kl, 4), "dWnorm": round(float((dose * W).norm()), 2)}
            if rows:
                b = brief(rows, None)
                r.update({"check": b, "total": b["test"]["right"] + b["control"]["right"]})
            else:
                r["refused"] = True
            tried.append(r)
            print(f"[eval {name}] lam {lam} dose {dose}: plain KL {kl:.4f}" + (f", check test {r['check']['test']['right']}/20, controls {r['check']['control']['right']}/20" if rows else " (refused)"), flush=True)
    ok = [r for r in tried if not r.get("refused")]
    best = max(ok, key=lambda r: (r["total"], -r["plainKL"])) if ok else None
    result = {"name": name, "where": where, "layer": where["layer"], "neurons": len(cols), "weightsChanged": len(cols) * 2048, "tried": tried, "chosen": best}
    if best:
        W = solve(T, cols, best["lam"]) * best["dose"]
        with Write(where["layer"], cols, W):
            rows = score(cases)
            kl = plain_kl(base_plain)
        result["held"] = brief(rows, "held")
        result["checkFinal"] = brief(rows, "check")
        result["plainKL"] = round(kl, 4)
        base = {r["id"]: r for r in json.load(open(os.path.join(st.OUT, "scores-base.json"), encoding="utf8"))["rows"]}
        held = [r for r in rows if r["half"] == "held"]
        result["heldFixed"] = [r["id"] for r in held if r["ok"] and not base[r["id"]]["ok"]]
        result["heldBroke"] = [r["id"] for r in held if not r["ok"] and base[r["id"]]["ok"]]
        print(f"[eval {name}] CHOSEN lam {best['lam']} dose {best['dose']}: held-out test {result['held']['test']['right']}/20, "
              f"controls {result['held']['control']['right']}/20 {result['held']['control']['byKind']}; plain KL {kl:.4f}", flush=True)
    json.dump(result, open(os.path.join(OUT, f"dw-{name}.json"), "w", encoding="utf8"), indent=1)


def auto_where(layer, k):
    """The published recipe: the neurons most active at the answer position compared with the rest of the text."""
    T = torch.load(os.path.join(OUT, f"targets-{layer}.pt"))
    ans = torch.stack([r["key"] for r in T["rows"]]).abs().mean(0)
    rest = torch.cat([torch.cat([r["protect"] for r in T["rows"]]).float(), T["plain"].float()]).abs().mean(0)
    ratio = ans / (rest + 1e-3)
    cols = ratio.topk(k).indices.tolist()
    json.dump({"layer": layer, "neurons": cols, "how": f"the {k} neurons most active at the answer position relative to other text"},
              open(os.path.join(OUT, f"where-auto-{layer}.json"), "w"), indent=1)
    print(f"[auto] layer {layer}: {k} neurons")


SUFFIX = ""


def main():
    global TEACHER, SUFFIX
    if arg("teacher") in ("laya", "laya-opus", "opus", "opus-hard"):
        TEACHER = json.load(open(os.path.join(OUT, f"teacher-{arg('teacher')}.json"), encoding="utf8"))["q"]
        SUFFIX = f"-{arg('teacher')}"
    cmd = sys.argv[1]
    if cmd == "random":
        layer, k, seed = int(arg("layer")), int(arg("k")), int(arg("seed", 0))
        cols = random.Random(seed).sample(range(6144), k)
        json.dump({"layer": layer, "neurons": cols, "how": f"{k} random neurons (seed {seed})"},
                  open(os.path.join(OUT, f"where-random-{layer}-{seed}.json"), "w"), indent=1)
        return
    if cmd == "auto":
        auto_where(int(arg("layer")), int(arg("k", 256)))
        return
    st.load()
    if cmd == "targets":
        targets(int(arg("layer")))
    elif cmd == "eval":
        where = json.load(open(arg("where"), encoding="utf8"))
        evaluate(where, arg("name"))


if __name__ == "__main__":
    main()
