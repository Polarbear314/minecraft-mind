"""Nightly weight write for a model layer: the creature's own outcomes, written into its weights.

At dawn (learn/nightlyWrite.js), or by hand:

    python nightly_write.py --layer gather [--dry] [--reload http://127.0.0.1:3010]

1. ROWS: logs/layers/write/<layer>-rows-<day>.jsonl (learn/gatherLabels.js): the
   questions the layer was asked, each labelled by what happened afterwards, with
   its Minecraft day. The Minecraft days since the last write are HELD OUT for the
   gate (the days the last patch was live); every day up to then is for learning.
   <layer>-state.json remembers the last Minecraft day a write was gated on.
2. TEACHER: up to 60 rows per answer ("gather" / "nothing"), each in both
   shuffled menu orders, with firm targets (0.85 on the outcome's answer).
   Nothing is fed in: the targets come only from what happened to the creature.
3. WRITE: the closed-form solve (cortex/decision_write.py, part 3 of
   docs/results-7b-trial.md) into the second-to-last layer's 256 neurons most
   active at the answer; lam and dose chosen on the last quarter of the
   learning days, refusing any setting that changes plain English by KL > 0.03.
4. GATE: balanced accuracy on the held-out days (did it answer as the outcomes
   say it should), edited vs the layer as it is live now (the current patch, else
   the model as downloaded). Kept only if it is better by 0.03.
5. SAVE: every version in logs/layers/patches/<layer>-v<N>.pt with its report;
   if it passed, <layer>-current.json names it, and the model service applies
   it on /reload (cortex/layer_service.py).

Runs on its own copy of the model (4-bit, ~1.4 GB for Gather), beside the live
service: the live layers are only touched through /reload.
"""
import glob
import json
import os
import random
import sys
import time

MODELS = {"gather": "Qwen/Qwen3-1.7B", "shelter": "Qwen/Qwen2.5-3B-Instruct", "make": "Qwen/Qwen3-4B-Instruct-2507"}


def arg(name, default=None):
    return sys.argv[sys.argv.index(f"--{name}") + 1] if f"--{name}" in sys.argv else default


LAYER = arg("layer", "gather")
os.environ.setdefault("STEER_MODEL", MODELS[LAYER])
os.environ.setdefault("STEER_DIR", os.path.join("logs", "layers", "write"))

import torch  # noqa: E402

sys.path.insert(0, os.path.dirname(__file__))
import steer_trial as st  # noqa: E402
import decision_write as dw  # noqa: E402

ROOT = st.ROOT
ROWS = os.path.join(ROOT, "logs", "layers", "write")
PATCHES = os.path.join(ROOT, "logs", "layers", "patches")
PER_LABEL = 40  # teacher rows per answer (60 -> 40: part of making a write ~6 min, not ~16)
STEPS = 10  # steps per teacher example to find its target change (was 20)
MARGIN = 0.03
K = 256
STATE = os.path.join(ROWS, f"{LAYER}-state.json")  # the last Minecraft day a write was gated on


def rows_for(day):
    return st.read_jsonl(os.path.join(ROWS, f"{LAYER}-rows-{day}.jsonl"))


def as_case(r, set_name="eval"):
    acts_right = [k for k in r["keys"] if k != "nothing"] if r["label"] != "nothing" else None
    return {**r, "set": set_name, "right": r["label"], "rightAny": acts_right}


def spread(items, n):
    if len(items) <= n:
        return items
    step = len(items) / n
    return [items[int(i * step)] for i in range(n)]


def balanced(rows):
    g = [r for r in rows if r["right"] != "nothing"]
    n = [r for r in rows if r["right"] == "nothing"]
    acc = lambda xs: sum(x["ok"] for x in xs) / len(xs) if xs else None
    a, b = acc(g), acc(n)
    return {"balanced": round(((a or 0) + (b or 0)) / ((a is not None) + (b is not None) or 1), 3),
            "gather": a and round(a, 3), "nothing": b and round(b, 3), "n": len(rows)}


def score(cases):
    return [st.score_case(c) for c in cases]


def targets(layer, examples):
    """Per example and menu order: the change at the answer position that makes the model answer like the teacher."""
    for p in st.model.parameters():
        p.requires_grad_(False)
    dp = st.model.model.layers[layer].mlp.down_proj
    state = {"delta": None, "keys": None}

    def hook(m, inp, out):
        state["keys"] = inp[0][0].detach().float().cpu()
        if state["delta"] is not None:
            out = out.clone()
            out[:, -1] = out[:, -1] + state["delta"].to(out.dtype)
        return out

    h = dp.register_forward_hook(hook)
    with torch.no_grad():
        res = st.forward(st.prompt(examples[0][0], [examples[0][0]["acts"][j] for j in examples[0][1]]), want_hidden=True)
        size = float(res.hidden_states[layer + 1][0, -1].float().norm())
    rows = []
    try:
        for n, (c, order) in enumerate(examples):
            acts = [c["acts"][j] for j in order]
            q = torch.tensor([c["teacher"][c["keys"][j]] for j in order], device="cuda")
            ids = st.tok(st.prompt(c, acts), return_tensors="pt").to("cuda")
            delta = torch.zeros(st.model.config.hidden_size, device="cuda", requires_grad=True)
            opt = torch.optim.Adam([delta], lr=0.002 * size)
            state["delta"] = delta
            for step in range(STEPS):
                lp = dw.letter_logprobs(st.model(**ids).logits[0, -1], len(acts))
                kl = (q * (torch.log(q) - lp)).sum()
                if step == 0:
                    keys = state["keys"]
                if float(kl) < 0.05:
                    break
                opt.zero_grad()
                (kl + 1e-3 * (delta.norm() / size) ** 2).backward()
                opt.step()
            T = keys.shape[0]
            pos = random.Random(n).sample(range(T - 1), min(16, T - 1))
            rows.append({"delta": delta.detach().float().cpu(), "key": keys[-1].clone(), "protect": keys[pos].half()})
        state["delta"] = None
        plain = []
        with torch.no_grad():
            for s in dw.PLAIN:
                st.model(**st.tok(s, return_tensors="pt").to("cuda"))
                plain.append(state["keys"].half())
    finally:
        h.remove()
    return {"rows": rows, "plain": torch.cat(plain)}


def main():
    # Minecraft days, not calendar days: learn from every day up to the last write,
    # gate on the days since (the days the last patch was live). First run: the last 3.
    rows = []
    for f in sorted(glob.glob(os.path.join(ROWS, f"{LAYER}-rows-*.jsonl"))):
        rows += [r for r in st.read_jsonl(f) if r.get("mcDay")]
    seen = {}
    for r in rows:  # a calendar day may be labelled twice (yesterday, then today): keep one copy
        seen[r["id"]] = r
    rows = sorted(seen.values(), key=lambda r: r["ts"])
    days = sorted({r["mcDay"] for r in rows})
    if not days:
        print("[write] RESULT " + json.dumps({"layer": LAYER, "skipped": "no labelled rows with a Minecraft day yet"}))
        return
    last = None
    if os.path.exists(STATE):
        with open(STATE, encoding="utf8") as f:
            last = json.load(f).get("lastMcDay")
    if last is None:
        last = days[-1] - 3 if len(days) > 3 else days[0]
    held_days = [d for d in days if d > last]
    train_days = [d for d in days if d <= last]
    held_day = f"Minecraft days {held_days[0]}-{held_days[-1]}" if held_days else None
    if not held_days or not train_days:
        print("[write] RESULT " + json.dumps({"layer": LAYER, "skipped": "need days to learn from and days since the last write to test on"}))
        return
    train = [as_case(r, "train") for r in rows if r["mcDay"] <= last]
    held = [as_case(r, "held") for r in rows if r["mcDay"] > last]
    held = spread([r for r in held if r["right"] != "nothing"], 100) + spread([r for r in held if r["right"] == "nothing"], 100)
    cut = int(len(train) * 0.75)  # learn from the earlier part, choose the strength on the later part
    learn, valid = train[:cut], train[cut:]
    valid = spread([r for r in valid if r["right"] != "nothing"], 30) + spread([r for r in valid if r["right"] == "nothing"], 30)
    teach = spread([r for r in learn if r["right"] != "nothing"], PER_LABEL) + spread([r for r in learn if r["right"] == "nothing"], PER_LABEL)
    for c in teach:
        c["teacher"] = {k: (0.85 if (k == c["right"] or (c["right"] != "nothing" and k == c["right"])) else 0.15 / (len(c["keys"]) - 1)) for k in c["keys"]}
    t0 = time.time()
    st.load()
    layer = st.model.config.num_hidden_layers - 2
    report = {"layer": LAYER, "model": st.NAME, "writeLayer": layer, "trainDays": [train_days[0], train_days[-1]], "heldDays": held_days, "heldDay": held_day,
              "teach": {"gather": sum(c["right"] != "nothing" for c in teach), "nothing": sum(c["right"] == "nothing" for c in teach)},
              "held": {"gather": sum(c["right"] != "nothing" for c in held), "nothing": sum(c["right"] == "nothing" for c in held)}}
    if min(report["teach"].values()) < 10 or min(report["held"].values()) < 10:
        report["skipped"] = "too few examples of one answer to teach or to test on (waiting for more days)"
        print("[write] RESULT " + json.dumps({k: report.get(k) for k in ("layer", "skipped", "teach", "held")}))
        return
    examples = [(c, o) for c in teach for o in st.orders(c)]
    T = targets(layer, examples)
    # Where: the published recipe (most active at the answer relative to other text).
    ans = torch.stack([r["key"] for r in T["rows"]]).abs().mean(0)
    rest = torch.cat([torch.cat([r["protect"] for r in T["rows"]]).float(), T["plain"].float()]).abs().mean(0)
    cols = (ans / (rest + 1e-3)).topk(K).indices.sort().values.tolist()
    base_plain = dw.plain_logprobs()
    base_valid = balanced(score(valid))
    tried = []
    for lam in (1.0, 10.0):  # the settings that have won so far (lam 100 never did)
        W = dw.solve(T, cols, lam)
        for dose in (0.5, 1.0, 1.5):
            with dw.Write(layer, cols, dose * W):
                kl = dw.plain_kl(base_plain)
                b = balanced(score(valid)) if kl <= 0.03 else None
            tried.append({"lam": lam, "dose": dose, "plainKL": round(kl, 4), "valid": b})
            print(f"[write] lam {lam} dose {dose}: plain KL {kl:.4f}" + (f", validation {b}" if b else " (refused)"), flush=True)
    ok = [r for r in tried if r["valid"]]
    best = max(ok, key=lambda r: (r["valid"]["balanced"], -r["plainKL"])) if ok else None
    report.update({"validUnedited": base_valid, "tried": tried, "chosen": best, "neurons": len(cols)})
    if not best:
        report["passed"] = False
        report["reason"] = "every setting changed plain text too much"
    else:
        W = dw.solve(T, cols, best["lam"]) * best["dose"]
        before = balanced(score(held))
        # The bar is what's live now: the current patch, if one is served, else the model as downloaded.
        live = None
        cur = os.path.join(PATCHES, f"{LAYER}-current.json")
        if os.path.exists(cur):
            try:
                with open(cur, encoding="utf8") as f:
                    meta = json.load(f)
                prev = torch.load(os.path.join(PATCHES, meta["file"]))
                parts = [(pt["layer"], pt["cols"], pt["dW"].float()) for pt in prev["parts"]]
                with dw.MultiWrite(parts):
                    live = balanced(score(held))
                report["liveVersion"], report["heldLive"] = meta.get("version"), live
            except Exception as err:  # a patch that won't load is no bar
                report["liveError"] = str(err)
        with dw.Write(layer, cols, W):
            after = balanced(score(held))
            kl = dw.plain_kl(base_plain)
        report.update({"heldUnedited": before, "heldEdited": after, "plainKL": round(kl, 4)})
        if "--dry" not in sys.argv:  # the next write tests on the days after these
            with open(STATE, "w", encoding="utf8") as f:
                json.dump({"lastMcDay": held_days[-1], "ts": time.strftime("%Y-%m-%dT%H:%M:%S")}, f)
        bar = max(before["balanced"], live["balanced"]) if live else before["balanced"]
        report["passed"] = after["balanced"] >= bar + MARGIN and kl <= 0.03
        report["reason"] = (f"held-out {held_day}: balanced accuracy {before['balanced']} unedited"
                            + (f", {live['balanced']} with live v{report.get('liveVersion')}" if live else "")
                            + f" -> {after['balanced']} ({'beats' if report['passed'] else 'does not beat'} "
                            + ("the live layer" if live else "the unedited layer") + f" by {MARGIN})")
        os.makedirs(PATCHES, exist_ok=True)
        versions = [int(os.path.basename(f).split("-v")[1].split(".")[0]) for f in glob.glob(os.path.join(PATCHES, f"{LAYER}-v*.pt"))]
        v = max(versions, default=0) + 1
        fname = f"{LAYER}-v{v}.pt"
        if "--dry" not in sys.argv:
            torch.save({"parts": [{"layer": layer, "cols": cols, "dW": W.half()}], "report": report}, os.path.join(PATCHES, fname))
            report["version"], report["file"] = v, fname
            if report["passed"]:
                with open(os.path.join(PATCHES, f"{LAYER}-current.json"), "w", encoding="utf8") as f:
                    json.dump({"file": fname, "version": v, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "heldDays": held_days, "held": after, "heldUnedited": before}, f, indent=1)
    report["secs"] = round(time.time() - t0)
    os.makedirs(PATCHES, exist_ok=True)
    with open(os.path.join(PATCHES, f"{LAYER}-v{report.get('version', 'dry')}.json"), "w", encoding="utf8") as f:
        json.dump(report, f, indent=1)
    if report.get("passed") and arg("reload"):  # apply it in the live model service
        try:
            import urllib.request
            req = urllib.request.Request(arg("reload").rstrip("/") + "/reload", data=json.dumps({"layers": [LAYER]}).encode(),
                                         headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=120).read()
            report["applied"] = True
        except Exception as err:  # the patch stays current on disk: the service applies it at its next start
            report["applied"], report["reloadError"] = False, str(err)
    print("[write] RESULT " + json.dumps({k: report.get(k) for k in ("layer", "version", "passed", "reason", "heldUnedited", "heldEdited", "plainKL", "applied", "secs")}), flush=True)


if __name__ == "__main__":
    main()
