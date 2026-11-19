"""Sandbox test of the proposed Gather label rules (the live label files and the live patch are untouched).

    python relabel_test.py --last 84 [--upto 90]

Relabels the same rows IN MEMORY (cortex/label_audit.py traces each one to its tick):
  - an act the world refused (e.g. "there was only air ahead") gives no label;
  - "did something else, nothing bad came of it" by day in the open is a SOFT target
    (0.6 on "nothing"), not a firm one: another layer did fine, which is weak evidence;
  - the teacher's "nothing" rows include the real-harm rows (died, or hurt 4+), up to half of them.
Then, on top of the live patch (v5), it builds two candidates the way the nightly write
does (targets, closed-form solve, setting chosen on validation by the same rule):
  old  - the current labels and teacher (what production does now)
  new  - the proposed labels and teacher
and scores live, old and new on the days after --last under the NEW labels (no refused
rows), with accuracy per kind of row and a paired bootstrap against live.
The recipe was fixed before these days were scored; the label audit had only counted them.
Saved: logs/layers/patches/runs/relabel-<time>.json
"""
import json
import os
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(__file__))
import nightly_write as nw  # noqa: E402
import label_audit as la  # noqa: E402
from write_diagnostic import boot  # noqa: E402

st, dw, torch = nw.st, nw.dw, nw.torch
SETTINGS = [(1.0, 0.5), (10.0, 0.5), (10.0, 1.0)]
SOFT = 0.6
HELD_PER_LABEL = 150


def arg(name, default=None):
    return sys.argv[sys.argv.index(f"--{name}") + 1] if f"--{name}" in sys.argv else default


def teacher_dist(c, firm):
    p = firm if c["right"] != "nothing" or c["_kind"] != "quiet (day/open)" else SOFT
    return {k: (p if k == c["right"] else (1 - p) / (len(c["keys"]) - 1)) for k in c["keys"]}


def new_teach(learn):
    g = nw.teacher_sample([r for r in learn if r["right"] != "nothing"], nw.PER_LABEL)
    nothing = [r for r in learn if r["right"] == "nothing"]
    harm = [r for r in nothing if r["_kind"] in ("bad gather: died", "bad gather: hurt")]
    rest = [r for r in nothing if r not in harm]
    harm = nw.spread(harm, nw.PER_LABEL // 2)  # real harm: up to half of the "nothing" rows, the rest the quiet kinds
    left = nw.PER_LABEL - len(harm)
    pick = []
    if left > 0:  # (spread() can't take 0)
        old = [r for r in rest if r["mcDay"] < nw.RECENT_FROM]
        recent = [r for r in rest if r["mcDay"] >= nw.RECENT_FROM]
        k = min(len(recent), max(round(left * nw.RECENT_SHARE), left - len(old)))
        pick = (nw.spread(old, left - k) if left - k > 0 else []) + (nw.spread(recent, k) if k > 0 else [])
    n = harm + pick
    out = g + n
    for c in out:
        c["teacher"] = teacher_dist(c, 0.85)
    return out


def per_kind(cases, scored):
    out = {}
    for c, s in zip(cases, scored):
        k = c["_kind"]
        o = out.setdefault(k, [0, 0])
        o[0] += s["ok"]
        o[1] += 1
    return {k: {"acc": round(a / n, 3), "n": n} for k, (a, n) in out.items()}


def candidate(name, layer, teach, valid, base_plain):
    examples = [(c, o) for c in teach for o in st.orders(c)]
    T = nw.targets(layer, examples)
    ans = torch.stack([r["key"] for r in T["rows"]]).abs().mean(0)
    rest = torch.cat([torch.cat([r["protect"] for r in T["rows"]]).float(), T["plain"].float()]).abs().mean(0)
    cols = (ans / (rest + 1e-3)).topk(nw.K).indices.sort().values.tolist()
    base_valid = nw.leaning(nw.score(valid))
    tried, solved = [], {}
    for lam, dose in SETTINGS:
        solved.setdefault(lam, dw.solve(T, cols, lam))
        with dw.Write(layer, cols, dose * solved[lam]):
            kl = dw.plain_kl(base_plain)
            v = nw.leaning(nw.score(valid)) if kl <= 0.03 else None
        tried.append({"lam": lam, "dose": dose, "plainKL": round(kl, 4), "valid": v})
        print(f"[relabel] {name} lam {lam} x{dose}: KL {kl:.4f} valid {v}", flush=True)
    ok = [r for r in tried if r["valid"]]
    fair = [r for r in ok if r["valid"]["pGather"] >= base_valid["pGather"] - nw.MAX_DROP and r["valid"]["pNothing"] >= base_valid["pNothing"] - nw.MAX_DROP]
    better = [r for r in fair if r["valid"]["p"] > base_valid["p"]]
    chosen = max(better, key=lambda r: (r["valid"]["p"], -r["plainKL"])) if better else None
    # Also keep the best on validation regardless of the rule, so the held-out look is informative either way.
    best_any = max(ok, key=lambda r: r["valid"]["p"]) if ok else None
    return {"teach": dict(Counter(c["_kind"] for c in teach)), "validLive": base_valid, "tried": tried, "chosen": chosen, "bestAny": best_any,
            "W": {lam: solved[lam] for lam in solved}, "cols": cols}


def main():
    last, upto = int(arg("last")), int(arg("upto", 10 ** 6))
    rows, ticks = la.load()
    rows = [r for r in rows if r["mcDay"] <= upto]
    for r in rows:
        r["_kind"] = la.kind(r, la.trace(r, ticks) if r["label"] == "nothing" else None)
    by_id = {r["id"]: r for r in rows}
    old_rows = [r for r in nw.load_rows() if r["mcDay"] <= upto]
    for r in old_rows:
        r["_kind"] = by_id[r["id"]]["_kind"] if r["id"] in by_id else "?"
    # Old: exactly as the nightly write builds it now.
    _, _, old_valid, old_teach, _ = nw.split_rows(old_rows, last)
    # New: the same split on the relabelled rows (refused acts dropped).
    new_rows = [r for r in old_rows if r["_kind"] != "bad gather: world refused the act"]
    train = [nw.as_case(r, "train") for r in new_rows if r["mcDay"] <= last]
    learn = [r for i, r in enumerate(train) if i % 4 != 3]
    valid = [r for i, r in enumerate(train) if i % 4 == 3]
    valid = nw.spread([r for r in valid if r["right"] != "nothing"], nw.VALID_PER_LABEL) + nw.spread([r for r in valid if r["right"] == "nothing"], nw.VALID_PER_LABEL)
    teach = new_teach(learn)
    held = [nw.as_case(r, "held") for r in new_rows if r["mcDay"] > last]
    hharm = [r for r in held if r["_kind"] in ("bad gather: died", "bad gather: hurt")]  # every real-harm row is scored
    hrest = [r for r in held if r["right"] == "nothing" and r not in hharm]
    held = nw.spread([r for r in held if r["right"] != "nothing"], HELD_PER_LABEL) + hharm + nw.spread(hrest, HELD_PER_LABEL - len(hharm))
    for c in held + valid + teach + old_valid + old_teach:
        c.setdefault("_kind", by_id.get(c["id"], {}).get("_kind", "?"))
    out = {"run": f"relabel-{time.strftime('%Y%m%d-%H%M%S')}" + (f"-{arg('only')}" if arg("only") else ""), "last": last, "heldDays": sorted({c["mcDay"] for c in held}),
           "held": dict(Counter(c["_kind"] for c in held)), "harmInLearn": sum(r["_kind"] in ("bad gather: died", "bad gather: hurt") for r in learn)}
    print(f"[relabel] {json.dumps(out)}", flush=True)
    if "--plan" in sys.argv:  # CPU only: show the split and the teachers, then stop
        out["teachNew"], out["teachOld"] = dict(Counter(c["_kind"] for c in teach)), dict(Counter(c["_kind"] for c in old_teach))
        print(f"[relabel] teacher new {out['teachNew']}\n[relabel] teacher old {out['teachOld']}")
        return
    t0 = time.time()
    st.load()
    layer = st.model.config.num_hidden_layers - 2
    base_plain = dw.plain_logprobs()
    meta, _, parts = nw.live_patch()
    out["live"] = meta.get("version") if meta else None
    with (dw.MultiWrite(parts) if parts else nw.Nothing()):
        live_rows = nw.score(held)
        out["heldLive"], out["heldLiveByKind"] = nw.balanced(live_rows), per_kind(held, live_rows)
        print(f"[relabel] live v{out['live']}: held {out['heldLive']} {out['heldLiveByKind']}", flush=True)
        which_runs = [x for x in (("old", old_teach, old_valid), ("new", teach, valid)) if arg("only") in (None, x[0])]
        for name, tch, val in which_runs:
            c = candidate(name, layer, tch, val, base_plain)
            res = {k: c[k] for k in ("teach", "validLive", "tried", "chosen", "bestAny")}
            for which in ("chosen", "bestAny"):
                pick = c[which]
                if not pick or (which == "bestAny" and pick == c["chosen"]):
                    continue
                with dw.Write(layer, c["cols"], pick["dose"] * c["W"][pick["lam"]]):
                    hr = nw.score(held)
                res[f"held_{which}"] = {"setting": [pick["lam"], pick["dose"]], "held": nw.balanced(hr), "byKind": per_kind(held, hr), "vsLive": boot(live_rows, hr)}
                print(f"[relabel] {name} {which} lam {pick['lam']} x{pick['dose']}: held {res[f'held_{which}']}", flush=True)
            out[name] = res
    out["secs"] = round(time.time() - t0)
    with open(os.path.join(nw.RUNS, f"{out['run']}.json"), "w", encoding="utf8") as f:
        json.dump(out, f, indent=1)
    print(f"[relabel] saved runs/{out['run']}.json in {out['secs']}s", flush=True)


if __name__ == "__main__":
    main()
