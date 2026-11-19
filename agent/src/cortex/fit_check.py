"""Fit vs generalisation for a saved write's candidates (sandbox; nothing saved to the live patch).

    python fit_check.py --run logs/layers/patches/runs/gather-20261119-141030.pt

The run file (nightly_write.save_run) keeps each candidate's undosed dW per lam and the
ids/orders of its teaching examples. With the live patch in the sandbox (the one the run
was built on), each candidate is scored on
  - its EXACT teaching cases (both menu orders, the answer the outcome says is right):
    can the edit even fit what it was taught?
  - the separate validation cases the write chose its setting on (same days, other rows):
    does what it fit carry over?
Low teach scores = failure to fit; high teach and low validation = failure to generalise.
Saved: logs/layers/patches/runs/fitcheck-<time>.json
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import nightly_write as nw  # noqa: E402

st, dw, torch = nw.st, nw.dw, nw.torch
DOSES = (0.5, 1.0, 2.0)


def arg(name, default=None):
    return sys.argv[sys.argv.index(f"--{name}") + 1] if f"--{name}" in sys.argv else default


def main():
    p = torch.load(arg("run"))
    rep, cols, layer = p["report"], p["cols"], p["layer"]
    last, held_days = rep["trainDays"][1], rep["heldDays"]
    rows = [r for r in nw.load_rows() if r["mcDay"] <= held_days[-1]]
    _, _, valid, teach_now, _ = nw.split_rows(rows, last)
    by_id = {r["id"]: r for r in rows}
    ids = list(dict.fromkeys(p["targets"]["id"]))
    teach = [nw.as_case(by_id[i], "teach") for i in ids if i in by_id]
    out = {"run": os.path.basename(arg("run")), "builtOn": p.get("builtOn"), "learnedUpTo": last, "teachCases": len(teach), "teachMissing": len(ids) - len(teach),
           "teachSameAsNow": len(set(ids) & {c["id"] for c in teach_now}), "valid": len(valid), "configs": []}
    t0 = time.time()
    st.load()
    meta, _, parts = nw.live_patch()
    out["live"] = meta.get("version") if meta else None
    if out["live"] != out["builtOn"]:
        out["warning"] = f"the run was built on v{out['builtOn']} but v{out['live']} is live now"
    base_plain = dw.plain_logprobs()
    with (dw.MultiWrite(parts) if parts else nw.Nothing()):
        lt, lv = nw.leaning(nw.score(teach)), nw.leaning(nw.score(valid))
        out["liveTeach"], out["liveValid"] = lt, lv
        print(f"[fit] live v{out['live']}: teach {lt}, valid {lv}", flush=True)
        for lam, c in p["candidates"].items():
            for dose in DOSES:
                W = c["dW"].float() * dose
                t = time.time()
                with dw.Write(layer, cols, W):
                    kl = dw.plain_kl(base_plain)
                    tt, vv = nw.leaning(nw.score(teach)), nw.leaning(nw.score(valid))
                r = {"lam": float(lam), "dose": dose, "plainKL": round(kl, 4), "teach": tt, "valid": vv,
                     "dTeachP": round(tt["p"] - lt["p"], 4), "dValidP": round(vv["p"] - lv["p"], 4),
                     "dTeachAcc": round(tt["balanced"] - lt["balanced"], 3), "dValidAcc": round(vv["balanced"] - lv["balanced"], 3), "secs": round(time.time() - t)}
                out["configs"].append(r)
                print(f"[fit] lam {lam} x{dose}: KL {r['plainKL']}, teach acc {tt['balanced']} (g {tt['gather']}, n {tt['nothing']}) p {tt['p']} "
                      f"| valid acc {vv['balanced']} (g {vv['gather']}, n {vv['nothing']}) p {vv['p']}", flush=True)
    out["secs"] = round(time.time() - t0)
    rid = f"fitcheck-{time.strftime('%Y%m%d-%H%M%S')}"
    with open(os.path.join(nw.RUNS, f"{rid}.json"), "w", encoding="utf8") as f:
        json.dump(out, f, indent=1)
    print(f"[fit] saved runs/{rid}.json in {out['secs']}s", flush=True)


if __name__ == "__main__":
    main()
