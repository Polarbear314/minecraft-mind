"""Sandbox diagnostic for the stacked nightly write (no patch is saved or served, no state moves).

    python write_diagnostic.py --last 81 --upto 84 [--configs all|<name,name>] [--tag name]

Replays a write on top of the live patch (learn from Minecraft days <= --last, inspect
days --last+1 .. --upto) and asks whether a refused lesson holds separable good parts:

  split    the solve is linear in its targets, so dW = dW_gather + dW_nothing exactly
           (the part from the "gather" rows and the part from the "nothing" rows, all
           rows' keys still constraining both). Mixtures a*dW_gather + b*dW_nothing.
  keep     protect what the live patch already gets right: teacher rows it already
           answers right ask for NO change, plus up to KEEP_EXTRA more such rows per
           answer from the learning days (their keys, zero target).
  keep-g   the "gather" part of keep alone.

Every config is scored on validation (the learning days' every-4th rows, as the write
chooses) AND on the inspected days. The inspected days are a DIAGNOSTIC look, not a
clean test: choosing a recipe from them would fit it to them. A clean test is a recipe
frozen before its days exist (see --configs, run later on new days).

Per config: plain KL of the whole stack, validation (mean probability on the right
answer per answer, and accuracy), inspected balanced accuracy, and a paired bootstrap
of the change against the live patch (rows resampled within each answer).
Saved: logs/layers/patches/runs/diag-<time>[-tag].json and .pt (the parts, per-row results).
"""
import json
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import nightly_write as nw  # noqa: E402  (sets the model and paths from --layer)

st, dw, torch = nw.st, nw.dw, nw.torch
LAM = 10.0
KEEP_EXTRA = 50
GRID = [(a, b) for a in (0.0, 0.5, 1.0) for b in (0.0, 0.5, 1.0) if (a, b) != (0.0, 0.0)]


def arg(name, default=None):
    return sys.argv[sys.argv.index(f"--{name}") + 1] if f"--{name}" in sys.argv else default


def answer_keys(layer, examples):
    """The down_proj input at the answer position for each (case, order), with the hooks as they are."""
    dp = st.model.model.layers[layer].mlp.down_proj
    got = {}
    h = dp.register_forward_hook(lambda m, inp, out: got.__setitem__("k", inp[0][0, -1].detach().float().cpu()))
    out = []
    try:
        with torch.no_grad():
            for c, order in examples:
                st.forward(st.prompt(c, [c["acts"][j] for j in order]))
                out.append(got["k"].clone())
    finally:
        h.remove()
    return out


def boot(live_rows, new_rows, reps=2000, seed=0):
    """Paired bootstrap of the change in balanced accuracy (and per answer), rows resampled within each answer."""
    rng = random.Random(seed)
    by = {}
    for a, b in zip(live_rows, new_rows):
        by.setdefault("nothing" if a["right"] == "nothing" else "gather", []).append((a["ok"], b["ok"]))
    d = {k: sum(y - x for x, y in v) / len(v) for k, v in by.items()}
    sims = []
    for _ in range(reps):
        s = {}
        for k, v in by.items():
            pick = [v[rng.randrange(len(v))] for _ in v]
            s[k] = sum(y - x for x, y in pick) / len(pick)
        sims.append(sum(s.values()) / len(s))
    sims.sort()
    return {"dBalanced": round(sum(d.values()) / len(d), 3), "dGather": round(d.get("gather", 0), 3), "dNothing": round(d.get("nothing", 0), 3),
            "ci95": [round(sims[int(0.025 * reps)], 3), round(sims[int(0.975 * reps)], 3)],
            "pBetter": round(sum(x > 0 for x in sims) / reps, 3)}


def main():
    last, upto = int(arg("last")), int(arg("upto", 10 ** 6))
    rows = [r for r in nw.load_rows() if r["mcDay"] <= upto]
    train, learn, valid, teach, held = nw.split_rows(rows, last)
    rid = f"diag-{time.strftime('%Y%m%d-%H%M%S')}" + (f"-{arg('tag')}" if arg("tag") else "")
    t0 = time.time()
    st.load()
    layer = st.model.config.num_hidden_layers - 2
    base_plain = dw.plain_logprobs()
    meta, saved, parts = nw.live_patch()
    out = {"run": rid, "last": last, "upto": upto, "inspectedDays": sorted({r["mcDay"] for r in held}), "live": meta.get("version") if meta else None,
           "lam": LAM, "teach": len(teach), "valid": len(valid), "inspected": len(held),
           "note": "the inspected days are a diagnostic look, not a clean test"}
    configs = arg("configs", "all")
    with (dw.MultiWrite(parts) if parts else nw.Nothing()):
        live_valid_rows, live_held_rows = nw.score(valid), nw.score(held)
        out["liveValid"], out["liveHeld"] = nw.leaning(live_valid_rows), nw.balanced(live_held_rows)
        print(f"[diag] live v{out['live']}: validation {out['liveValid']}, inspected {out['liveHeld']}", flush=True)
        examples = [(c, o) for c in teach for o in st.orders(c)]
        T = nw.targets(layer, examples)
        ans = torch.stack([r["key"] for r in T["rows"]]).abs().mean(0)
        rest = torch.cat([torch.cat([r["protect"] for r in T["rows"]]).float(), T["plain"].float()]).abs().mean(0)
        cols = (ans / (rest + 1e-3)).topk(nw.K).indices.sort().values.tolist()
        is_g = torch.tensor([c["right"] != "nothing" for c, _ in examples])
        # What the live patch already gets right among the teacher cases, and more such rows to keep.
        right_now = {r["id"]: r["ok"] for r in nw.score(teach)}
        already = torch.tensor([right_now[c["id"]] for c, _ in examples])
        ids = {c["id"] for c in teach}
        extra = []
        for want in ("gather", "nothing"):
            pool = [r for r in learn if r["id"] not in ids and ((r["right"] == "nothing") == (want == "nothing"))]
            pool = nw.spread(pool, KEEP_EXTRA * 2)
            extra += [r for r, s in zip(pool, nw.score(pool)) if s["ok"]][:KEEP_EXTRA]
        ex_extra = [(c, o) for c in extra for o in st.orders(c)]
        keys_extra = answer_keys(layer, ex_extra)
        T_keep = nw.zero_rows(T, already)
        T_keep = {"rows": T_keep["rows"] + [{"delta": torch.zeros_like(T["rows"][0]["delta"]), "key": k, "protect": T["rows"][0]["protect"][:0]} for k in keys_extra],
                  "plain": T["plain"]}
        out["keep"] = {"teacherAlreadyRight": int(already.sum()), "teacherRows": len(examples), "extraKeepRows": len(ex_extra),
                       "teacherAlreadyRightByAnswer": {"gather": int((already & is_g).sum()), "nothing": int((already & ~is_g).sum())}}
        print(f"[diag] keep: {out['keep']}", flush=True)
        W = dw.solve(T, cols, LAM)
        Wg, Wn = dw.solve(nw.zero_rows(T, ~is_g), cols, LAM), dw.solve(nw.zero_rows(T, is_g), cols, LAM)
        Wk = dw.solve(T_keep, cols, LAM)
        is_g_keep = torch.cat([is_g, torch.tensor([c["right"] != "nothing" for c, _ in ex_extra])])
        Wkg = dw.solve(nw.zero_rows(T_keep, ~is_g_keep), cols, LAM)
        out["splitError"] = round(float((Wg + Wn - W).abs().max() / W.abs().max()), 6)
        out["norms"] = {k: round(float(v.norm()), 3) for k, v in {"full": W, "gather": Wg, "nothing": Wn, "keep": Wk, "keepGather": Wkg}.items()}
        todo = [(f"split g{a} n{b}", a * Wg + b * Wn) for a, b in GRID]
        todo += [(f"keep x{d}", d * Wk) for d in (0.5, 1.0, 1.5)]
        todo += [(f"keep-g x{d}", d * Wkg) for d in (0.5, 1.0)]
        if configs != "all":
            names = configs.split(",")
            todo = [t for t in todo if t[0] in names]
        res, per_row = [], {"live": {"valid": live_valid_rows, "held": live_held_rows}}
        for name, dW in todo:
            t = time.time()
            with dw.Write(layer, cols, dW):
                kl = dw.plain_kl(base_plain)
                vr, hr = nw.score(valid), nw.score(held)
            v, h = nw.leaning(vr), nw.balanced(hr)
            r = {"config": name, "plainKL": round(kl, 4), "valid": v, "dValidP": round(v["p"] - out["liveValid"]["p"], 4),
                 "dValidPGather": round(v["pGather"] - out["liveValid"]["pGather"], 4), "dValidPNothing": round(v["pNothing"] - out["liveValid"]["pNothing"], 4),
                 "inspected": h, "vsLive": boot(live_held_rows, hr), "secs": round(time.time() - t)}
            res.append(r)
            per_row[name] = {"valid": vr, "held": hr}
            print(f"[diag] {name}: KL {r['plainKL']}, valid p {v['p']} (d {r['dValidP']:+}, gather {r['dValidPGather']:+}, nothing {r['dValidPNothing']:+}), "
                  f"inspected {h['balanced']} (gather {h['gather']}, nothing {h['nothing']}) vs live {r['vsLive']}", flush=True)
    out["configs"] = res
    out["secs"] = round(time.time() - t0)
    os.makedirs(nw.RUNS, exist_ok=True)
    with open(os.path.join(nw.RUNS, f"{rid}.json"), "w", encoding="utf8") as f:
        json.dump(out, f, indent=1)
    torch.save({"layer": layer, "cols": cols, "lam": LAM, "parts": {"full": W.half(), "gather": Wg.half(), "nothing": Wn.half(), "keep": Wk.half(), "keepGather": Wkg.half()},
                "perRow": per_row, "report": out}, os.path.join(nw.RUNS, f"{rid}.pt"))
    print(f"[diag] saved runs/{rid}.json and .pt in {out['secs']}s", flush=True)


if __name__ == "__main__":
    main()
