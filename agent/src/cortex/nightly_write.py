"""Nightly weight write for a model layer: the creature's own outcomes, written into its weights.

At dawn (learn/nightlyWrite.js), or by hand:

    python nightly_write.py --layer gather [--dry] [--reload http://127.0.0.1:3010]

Each write BUILDS ON the live patch: lessons accumulate night after night.

1. ROWS: logs/layers/write/<layer>-rows-<day>.jsonl (learn/gatherLabels.js): the
   questions the layer was asked, each labelled by what happened afterwards, with
   its Minecraft day. The Minecraft days since the last write are HELD OUT for the
   gate (the days the last patch was live); every day up to then is for learning.
   <layer>-state.json remembers the last Minecraft day a write was gated on.
2. LIVE: the current patch (<layer>-current.json, its "parts") is put into the
   sandbox model first, so everything below is measured on the layer as it acts now.
3. TEACHER: PER_LABEL rows per answer ("gather" / "nothing"), RECENT_SHARE of them
   from the days the layer itself acted (Minecraft day >= RECENT_FROM: that is where
   its bad outcomes are), each in both shuffled menu orders, with firm targets (0.85
   on the outcome's answer). Nothing is fed in: the targets come only from what
   happened to the creature. Because the live patch is in, a target is only what
   is STILL missing.
4. WRITE: the closed-form solve (cortex/decision_write.py, part 3 of
   docs/results-7b-trial.md) into the second-to-last layer's 256 neurons most
   active at the answer, a new delta on top of the live one. Six SETTINGS of
   lam and dose (with --recent-candidate, also a solve on only the recent
   days' rows), refusing any whose whole stack changes plain English by
   KL > 0.03 from the model as downloaded. The setting is chosen on validation
   (every 4th learning row, 50 per answer) by the mean probability on the
   right answer: it must beat the layer as it is, without lowering either
   answer by more than MAX_DROP. If none does, the write stops there.
   A dry run can replay an earlier write's days: --dry --last <Minecraft day>.
5. GATE: balanced accuracy on the held-out days (did it answer as the outcomes
   say it should), the stack (live parts + the new part) vs the layer as it is
   live now (the current patch, else the model as downloaded). Kept only if it
   is better by 0.03.
6. SAVE: every version in logs/layers/patches/<layer>-v<N>.pt (its parts: the
   live patch's plus the new one) with its report; if it passed,
   <layer>-current.json names it, and the model service applies every part on
   /reload (cortex/layer_service.py).

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
PER_LABEL = int(arg("per-label", 50))  # teacher rows per answer (was 40; 60 took 11.5 min beside the live models)
VALID_PER_LABEL = 50  # validation rows per answer, to choose the setting
MAX_DROP = 0.02  # a setting may not lower either answer's validation probability by more than this
# The settings tried (lam, dose); lam 1 dose 1.5 was always refused (plain KL), lam 100 never won.
SETTINGS = [(1.0, 0.5), (1.0, 1.0), (10.0, 0.5), (10.0, 1.0), (10.0, 1.5), (10.0, 2.0)]
RECENT_FROM = int(arg("recent-from", 64))  # the Minecraft day Gather's model began to act (its own bad outcomes from here)
RECENT_SHARE = 2 / 3  # of the teacher rows per answer, from the days it acted
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


def p_right(r):
    """The probability the layer put on what the outcome says was right (any act, for a "gather" row)."""
    if r["right"] == "nothing":
        return r["probs"].get("nothing", 0.0)
    return sum(v for k, v in r["probs"].items() if k != "nothing")


def leaning(rows):
    """Validation: the mean probability on the right answer, per answer and balanced. Continuous, so it
    tells settings apart on 100 rows where accuracy ties (v4, 2026-11-19: every setting 0.65-0.675)."""
    g = [p_right(r) for r in rows if r["right"] != "nothing"]
    n = [p_right(r) for r in rows if r["right"] == "nothing"]
    mg, mn = sum(g) / len(g), sum(n) / len(n)
    return {"p": round((mg + mn) / 2, 4), "pGather": round(mg, 4), "pNothing": round(mn, 4), **balanced(rows)}


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


def live_patch():
    """The patch live now: (meta, saved parts as stored, [(layer, cols, dW)]), or (None, [], []) if none."""
    cur = os.path.join(PATCHES, f"{LAYER}-current.json")
    if not os.path.exists(cur):
        return None, [], []
    with open(cur, encoding="utf8") as f:
        meta = json.load(f)
    p = torch.load(os.path.join(PATCHES, meta["file"]))
    meta["stack"] = meta.get("stack") or p.get("report", {}).get("stack") or [meta.get("version")]
    return meta, p["parts"], [(pt["layer"], pt["cols"], pt["dW"].float()) for pt in p["parts"]]


def teacher_sample(rows, n):
    """n rows of one answer: RECENT_SHARE from the days the layer acted, the rest spread over the days before."""
    recent = [r for r in rows if r["mcDay"] >= RECENT_FROM]
    old = [r for r in rows if r["mcDay"] < RECENT_FROM]
    k = min(len(recent), round(n * RECENT_SHARE))
    k = max(k, min(len(recent), n - len(old)))  # too few old days: more recent ones
    return spread(old, n - k) + spread(recent, k)


class Nothing:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        pass


def load_rows():
    """Every labelled row with a Minecraft day, one copy each (a calendar day may be labelled twice), oldest first."""
    rows = []
    for f in sorted(glob.glob(os.path.join(ROWS, f"{LAYER}-rows-*.jsonl"))):
        rows += [r for r in st.read_jsonl(f) if r.get("mcDay")]
    seen = {}
    for r in rows:
        seen[r["id"]] = r
    return sorted(seen.values(), key=lambda r: r["ts"])


def split_rows(rows, last):
    """Learn from the days up to `last`, hold out the days after: (train, learn, valid, teach, held)."""
    train = [as_case(r, "train") for r in rows if r["mcDay"] <= last]
    held = [as_case(r, "held") for r in rows if r["mcDay"] > last]
    held = spread([r for r in held if r["right"] != "nothing"], 100) + spread([r for r in held if r["right"] == "nothing"], 100)
    # Validation: every 4th learning row (not the last quarter in time, which would take
    # most of the days the layer acted away from the teacher); it chooses the setting.
    learn = [r for i, r in enumerate(train) if i % 4 != 3]
    valid = [r for i, r in enumerate(train) if i % 4 == 3]
    valid = spread([r for r in valid if r["right"] != "nothing"], VALID_PER_LABEL) + spread([r for r in valid if r["right"] == "nothing"], VALID_PER_LABEL)
    teach = teacher_sample([r for r in learn if r["right"] != "nothing"], PER_LABEL) + teacher_sample([r for r in learn if r["right"] == "nothing"], PER_LABEL)
    for c in teach:
        c["teacher"] = {k: (0.85 if k == c["right"] else 0.15 / (len(c["keys"]) - 1)) for k in c["keys"]}
    return train, learn, valid, teach, held


RUNS = os.path.join(PATCHES, "runs")  # every write's report and candidate weights, one file each, never overwritten


def run_id(dry):
    return f"{LAYER}-{time.strftime('%Y%m%d-%H%M%S')}" + ("-dry" if dry else "")


def save_run(rid, report, layer=None, cols=None, T=None, examples=None, solved=None):
    """Keep this write for later analysis: the report (runs/<id>.json) and, when the solve ran,
    its candidate weights and targets (runs/<id>.pt): per lam the undosed dW, also split into
    the part from the "gather" rows and the part from the "nothing" rows (they add up to it:
    the solve is linear in the targets), and each teacher row's target and key (half)."""
    os.makedirs(RUNS, exist_ok=True)
    report["run"] = rid
    keep = T is not None and cols is not None
    report["runFile"] = os.path.join("runs", f"{rid}.pt") if keep else None
    with open(os.path.join(RUNS, f"{rid}.json"), "w", encoding="utf8") as f:
        json.dump(report, f, indent=1)
    if not keep:
        return None
    is_g = torch.tensor([c["right"] != "nothing" for c, _ in examples])
    cand = {}
    for lam, W in (solved or {}).items():
        cand[str(lam)] = {"dW": W.half(), "gather": dw.solve(zero_rows(T, ~is_g), cols, lam).half(),
                          "nothing": dw.solve(zero_rows(T, is_g), cols, lam).half()}
    torch.save({"layer": layer, "cols": cols, "builtOn": report.get("liveVersion"), "candidates": cand,
                "targets": {"delta": torch.stack([r["delta"] for r in T["rows"]]).half(),
                            "key": torch.stack([r["key"] for r in T["rows"]]).half(),
                            "id": [c["id"] for c, _ in examples], "right": [c["right"] for c, _ in examples],
                            "mcDay": [c["mcDay"] for c, _ in examples], "order": [o for _, o in examples]},
                "report": report}, os.path.join(RUNS, f"{rid}.pt"))
    return os.path.join(RUNS, f"{rid}.pt")


def zero_rows(T, mask):
    """T with the target change of the masked rows set to zero (their keys still constrain the solve)."""
    return {"rows": [dict(r, delta=torch.zeros_like(r["delta"])) if m else r for r, m in zip(T["rows"], mask.tolist())], "plain": T["plain"]}


def main():
    # Minecraft days, not calendar days: learn from every day up to the last write,
    # gate on the days since (the days the last patch was live). First run: the last 3.
    rid = run_id("--dry" in sys.argv)
    rows = load_rows()
    days = sorted({r["mcDay"] for r in rows})
    if not days:
        print("[write] RESULT " + json.dumps({"layer": LAYER, "skipped": "no labelled rows with a Minecraft day yet"}))
        return
    last = None
    if os.path.exists(STATE):
        with open(STATE, encoding="utf8") as f:
            last = json.load(f).get("lastMcDay")
    if arg("last") and "--dry" in sys.argv:  # a dry run may replay an earlier write (--last <Minecraft day>)
        last = int(arg("last"))
    if last is None:
        last = days[-1] - 3 if len(days) > 3 else days[0]
    held_days = [d for d in days if d > last]
    train_days = [d for d in days if d <= last]
    held_day = f"Minecraft days {held_days[0]}-{held_days[-1]}" if held_days else None
    if not held_days or not train_days:
        print("[write] RESULT " + json.dumps({"layer": LAYER, "skipped": "need days to learn from and days since the last write to test on"}))
        return
    train, learn, valid, teach, held = split_rows(rows, last)
    t0 = time.time()
    timing = {}
    st.load()
    timing["load"] = round(time.time() - t0)
    layer = st.model.config.num_hidden_layers - 2
    report = {"layer": LAYER, "model": st.NAME, "writeLayer": layer, "trainDays": [train_days[0], train_days[-1]], "heldDays": held_days, "heldDay": held_day,
              "teach": {"gather": sum(c["right"] != "nothing" for c in teach), "nothing": sum(c["right"] == "nothing" for c in teach),
                        "recent": sum(c["mcDay"] >= RECENT_FROM for c in teach), "recentFrom": RECENT_FROM},
              "held": {"gather": sum(c["right"] != "nothing" for c in held), "nothing": sum(c["right"] == "nothing" for c in held)}}
    if min(report["teach"]["gather"], report["teach"]["nothing"]) < 10 or min(report["held"].values()) < 10:
        report["skipped"] = "too few examples of one answer to teach or to test on (waiting for more days)"
        print("[write] RESULT " + json.dumps({k: report.get(k) for k in ("layer", "skipped", "teach", "held")}))
        return
    base_plain = dw.plain_logprobs()  # the model as downloaded: the KL guard is on the whole stack
    t = time.time()
    before = balanced(score(held))
    timing["heldUnedited"] = round(time.time() - t)
    # The live patch goes in first: targets, validation and the gate all see the layer as it acts now.
    live_meta, live_saved, live_parts = None, [], []
    try:
        live_meta, live_saved, live_parts = live_patch()
    except Exception as err:  # a patch that won't load is no base and no bar
        report["liveError"] = str(err)
    if live_meta:
        report["liveVersion"], report["builtOn"] = live_meta.get("version"), live_meta.get("version")
    best, live, after, kl = None, None, None, None
    T, examples, cols, kept, ok = None, None, None, {}, []
    with (dw.MultiWrite(live_parts) if live_parts else Nothing()):
        if live_parts:
            report["livePlainKL"] = round(dw.plain_kl(base_plain), 4)
            t = time.time()
            live = balanced(score(held))
            timing["heldLive"] = round(time.time() - t)
            report["heldLive"] = live
        base_valid = leaning(score(valid))
        print(f"[write] {'live v' + str(report['liveVersion']) if live_parts else 'unedited'}: validation {base_valid}"
              + (f", held-out {live}" if live else ""), flush=True)
        examples = [(c, o) for c in teach for o in st.orders(c)]
        t = time.time()
        T = targets(layer, examples)
        timing["targets"] = round(time.time() - t)
        print(f"[write] targets for {len(examples)} teacher examples in {timing['targets']}s", flush=True)
        # Where: the published recipe (most active at the answer relative to other text).
        ans = torch.stack([r["key"] for r in T["rows"]]).abs().mean(0)
        rest = torch.cat([torch.cat([r["protect"] for r in T["rows"]]).float(), T["plain"].float()]).abs().mean(0)
        cols = (ans / (rest + 1e-3)).topk(K).indices.sort().values.tolist()
        # Candidates: the whole teacher sample, or only the days the layer acted.
        samples = {"all": T}
        recent_rows = [r for r, (c, _) in zip(T["rows"], examples) if c["mcDay"] >= RECENT_FROM]
        # (off by default: in the first dry run, 2026-11-19, it lost at every setting and cost ~80 s)
        if "--recent-candidate" in sys.argv and 20 <= len(recent_rows) < len(T["rows"]):
            samples["recent"] = {"rows": recent_rows, "plain": T["plain"]}
        t = time.time()
        tried = []
        kept = {}  # the "all" sample's undosed solve per lam, kept with the run
        for sname, TS in samples.items():
            solved = {}
            for lam, dose in SETTINGS:
                if lam not in solved:
                    solved[lam] = dw.solve(TS, cols, lam)
                    if sname == "all":
                        kept[lam] = solved[lam]
                with dw.Write(layer, cols, dose * solved[lam]):
                    k = dw.plain_kl(base_plain)
                    b = leaning(score(valid)) if k <= 0.03 else None
                tried.append({"sample": sname, "lam": lam, "dose": dose, "plainKL": round(k, 4), "valid": b})
                print(f"[write] {sname} lam {lam} dose {dose}: plain KL {k:.4f}" + (f", validation {b}" if b else " (refused)"), flush=True)
        timing["candidates"] = round(time.time() - t)
        # Choose on the continuous score: better than the layer as it is (balanced), and not
        # buying one answer with the other (v4 bought "gather" 0.61 -> 0.72 with "nothing" 0.84 -> 0.71).
        ok = [r for r in tried if r["valid"]]
        fair = [r for r in ok if r["valid"]["pGather"] >= base_valid["pGather"] - MAX_DROP and r["valid"]["pNothing"] >= base_valid["pNothing"] - MAX_DROP]
        better = [r for r in fair if r["valid"]["p"] > base_valid["p"]]
        best = max(better, key=lambda r: (r["valid"]["p"], -r["plainKL"])) if better else None
        report.update({"validLive" if live_parts else "validUnedited": base_valid, "tried": tried, "chosen": best, "neurons": len(cols)})
        if best:
            W = dw.solve(samples[best["sample"]], cols, best["lam"]) * best["dose"]
            t = time.time()
            with dw.Write(layer, cols, W):
                after = balanced(score(held))
                kl = dw.plain_kl(base_plain)
            timing["heldEdited"] = round(time.time() - t)
    if not best:
        report["passed"] = False
        report["reason"] = ("every setting changed plain text too much" if not ok else
                            "no setting did better on validation than the layer as it is, without lowering one answer (not tested on the held-out days)")
        if "--dry" not in sys.argv:  # still move on: the next write tests on the days after these
            with open(STATE, "w", encoding="utf8") as f:
                json.dump({"lastMcDay": held_days[-1], "ts": time.strftime("%Y-%m-%dT%H:%M:%S")}, f)
    else:
        report.update({"heldUnedited": before, "heldEdited": after, "plainKL": round(kl, 4)})
        if "--dry" not in sys.argv:  # the next write tests on the days after these
            with open(STATE, "w", encoding="utf8") as f:
                json.dump({"lastMcDay": held_days[-1], "ts": time.strftime("%Y-%m-%dT%H:%M:%S")}, f)
        # The bar is what's live now: the current patch, if one is served, else the model as downloaded.
        bar = max(before["balanced"], live["balanced"]) if live else before["balanced"]
        report["passed"] = after["balanced"] >= bar + MARGIN and kl <= 0.03
        report["reason"] = (f"held-out {held_day}: balanced accuracy {before['balanced']} unedited"
                            + (f", {live['balanced']} with live v{report.get('liveVersion')}" if live else "")
                            + f" -> {after['balanced']} with " + (f"v{report.get('liveVersion')} + the new part" if live else "the new part")
                            + f" ({'beats' if report['passed'] else 'does not beat'} "
                            + ("the live layer" if live else "the unedited layer") + f" by {MARGIN})")
        os.makedirs(PATCHES, exist_ok=True)
        versions = [int(os.path.basename(f).split("-v")[1].split(".")[0]) for f in glob.glob(os.path.join(PATCHES, f"{LAYER}-v*.pt"))]
        v = max(versions, default=0) + 1
        fname = f"{LAYER}-v{v}.pt"
        # The stack: the live patch's parts (as served) plus this write's part.
        report["stack"] = (live_meta["stack"] if live_meta and live_parts else []) + [v]
        report["parts"] = len(live_saved) + 1
        if "--dry" not in sys.argv:
            parts = [dict(pt) for pt in live_saved] + [{"layer": layer, "cols": cols, "dW": W.half(), "version": v}]
            torch.save({"parts": parts, "report": report}, os.path.join(PATCHES, fname))
            report["version"], report["file"] = v, fname
            if report["passed"]:
                with open(os.path.join(PATCHES, f"{LAYER}-current.json"), "w", encoding="utf8") as f:
                    json.dump({"file": fname, "version": v, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "heldDays": held_days, "held": after,
                               "heldLive": live, "heldUnedited": before, "stack": report["stack"], "parts": report["parts"]}, f, indent=1)
    report["timing"] = timing
    report["secs"] = round(time.time() - t0)
    os.makedirs(PATCHES, exist_ok=True)
    if report.get("version"):  # a saved version's report sits beside it (learn/nightlyWrite.js reads the newest)
        with open(os.path.join(PATCHES, f"{LAYER}-v{report['version']}.json"), "w", encoding="utf8") as f:
            json.dump(report, f, indent=1)
    # Every run, passed, refused or dry, also keeps its own report and candidate weights
    # (runs/<layer>-<time>[-dry].json/.pt), so a refused lesson can still be studied later.
    try:
        save_run(rid, report, layer, cols, T, examples, kept)
    except Exception as err:  # keeping the record must never cost the write itself
        print(f"[write] could not keep the run's weights: {err}", flush=True)
        save_run(rid, report)
    if report.get("passed") and arg("reload") and "--dry" not in sys.argv:  # apply it in the live model service
        try:
            import urllib.request
            req = urllib.request.Request(arg("reload").rstrip("/") + "/reload", data=json.dumps({"layers": [LAYER]}).encode(),
                                         headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=120).read()
            report["applied"] = True
        except Exception as err:  # the patch stays current on disk: the service applies it at its next start
            report["applied"], report["reloadError"] = False, str(err)
    print("[write] RESULT " + json.dumps({k: report.get(k) for k in ("layer", "version", "passed", "reason", "heldUnedited", "heldLive", "heldEdited",
                                                                      "plainKL", "stack", "applied", "timing", "secs")}), flush=True)


if __name__ == "__main__":
    main()
