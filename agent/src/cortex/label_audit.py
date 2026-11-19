"""CPU-only audit of Gather's outcome labels (reads the label rows and tick logs; changes nothing).

    python label_audit.py [--from 64]

1. Each "gathered, then hurt or couldn't" row is traced back to its tick: was the act
   itself refused by the world (result.ok false, e.g. "there was only air ahead"), or did
   the creature get hurt (4+) or die within 30 s?
2. Label variants, re-derived IN MEMORY from the same rows (the live label files are untouched):
     current    as labelled now
     no-air     failed acts (the world refused the dig/pickup) give no label
     no-air+q   no-air, and "did something else, nothing bad came of it" rows only at night or enclosed
     harm-only  "nothing" only when gathering was followed by harm; quiet rows dropped
   For each: label counts, label conflicts (same situation and menu, both labels), and how
   predictable the label is from the situation alone (a small logistic probe on parsed
   situation features, folds by Minecraft day: a ceiling on what any layer could learn).
3. A traceable 30-row sample (row id, tick, what happened in the next 30 s, a rule-based verdict).
Saved: logs/layers/patches/runs/labelaudit-<time>.json and .csv
"""
import csv
import glob
import json
import os
import random
import re
import sys
import time
from collections import Counter, defaultdict

import torch

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
ROWS = os.path.join(ROOT, "logs", "layers", "write")
RUNS = os.path.join(ROOT, "logs", "layers", "patches", "runs")
WINDOW = 20


def arg(name, default=None):
    return sys.argv[sys.argv.index(f"--{name}") + 1] if f"--{name}" in sys.argv else default


def read_jsonl(f):
    out = []
    for line in open(f, encoding="utf8"):
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def load():
    rows = {}
    for f in sorted(glob.glob(os.path.join(ROWS, "gather-rows-*.jsonl"))):
        for r in read_jsonl(f):
            if r.get("mcDay"):
                rows[r["id"]] = r
    ticks = {}
    for day in sorted({r["day"] for r in rows.values()}):
        f = os.path.join(ROOT, "logs", f"ticks-{day}.jsonl")
        ticks[day] = [t for t in read_jsonl(f) if t.get("action") and t.get("aff") and t.get("tod") is not None] if os.path.exists(f) else []
    return sorted(rows.values(), key=lambda r: r["ts"]), ticks


def trace(r, ticks):
    """What happened at and after the row's tick, as gatherLabels.js saw it."""
    i = int(r["id"].rsplit("-", 1)[1])
    T = ticks.get(r["day"], [])
    if i >= len(T) or T[i]["ts"] != r["ts"]:
        return None
    t = T[i]
    res = t.get("result") or {}
    hurt, died, hp = 0, False, [t.get("health")]
    for k in range(i + 1, min(len(T) - 1, i + WINDOW) + 1):
        p, c = T[k - 1], T[k]
        hp.append(c.get("health"))
        if p.get("health") is not None and c.get("health") is not None:
            if c["health"] < p["health"]:
                hurt += p["health"] - c["health"]
            if p["health"] <= 6 and c["health"] == 20:
                died = True
    a = t["action"]
    return {"tick": i, "act": f"{a.get('type')} {a.get('at') or ''}".strip(), "by": a.get("layer") or a.get("source"),
            "refused": res.get("ok") is False, "result": res.get("reason") or res.get("did"), "hurt": hurt, "died": died,
            "health": hp[:: max(1, len(hp) // 6)], "hostiles": [h.get("name") if isinstance(h, dict) else h for h in (t.get("hostiles") or [])][:3]}


def kind(r, tr):
    if r["label"] != "nothing":
        return "good gather"
    if r["why"].startswith("did something else"):
        s = r["situation"]
        night_or_enclosed = s.startswith("It is night") or "closed in on every side" in s
        return "quiet (night/enclosed)" if night_or_enclosed else "quiet (day/open)"
    if tr is None:
        return "bad gather (untraced)"
    if tr["refused"]:
        return "bad gather: world refused the act"
    return "bad gather: died" if tr["died"] else "bad gather: hurt"


def features(r):
    s = r["situation"]
    num = lambda pat: float(m.group(1)) if (m := re.search(pat, s)) else 0.0
    sides = num(r"(\d) of 4 sides closed") if "closed in on every side" not in s else 4.0
    f = [s.startswith("It is day"), "Evening" in s, "Open sky above" not in s,
         sides / 4, num(r"Health (\d+)/20") / 20, num(r"food (\d+)/20") / 20, num(r"Hunger (\d+)") / 100, num(r"fear (\d+)") / 100,
         "Hostile" in s, num(r"Hostile: \w+ (\d+) bloc") / 32, "pickup" in r["keys"], any(k.startswith("dig ") and k != "dig log" for k in r["keys"]),
         "dig log" in r["keys"], len(r["keys"]) / 5]
    return [float(x) for x in f]


def probe(rows):
    """Balanced accuracy of a logistic probe on situation features, folds = Minecraft days (5 groups)."""
    if len({r["label"] == "nothing" for r in rows}) < 2:
        return None
    X = torch.tensor([features(r) for r in rows])
    y = torch.tensor([r["label"] != "nothing" for r in rows]).float()
    days = sorted({r["mcDay"] for r in rows})
    fold = {d: i % 5 for i, d in enumerate(days)}
    f_of = torch.tensor([fold[r["mcDay"]] for r in rows])
    accs = []
    for k in range(5):
        tr, te = f_of != k, f_of == k
        if te.sum() == 0 or len(set(y[te].tolist())) < 2:
            continue
        mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-4
        A = (X - mu) / sd
        w = torch.zeros(A.shape[1], requires_grad=True)
        b = torch.zeros(1, requires_grad=True)
        pos = y[tr].mean()
        wts = torch.where(y[tr] == 1, 0.5 / pos, 0.5 / (1 - pos))
        opt = torch.optim.LBFGS([w, b], max_iter=100)

        def clo():
            opt.zero_grad()
            loss = (torch.nn.functional.binary_cross_entropy_with_logits(A[tr] @ w + b, y[tr], reduction="none") * wts).mean() + 1e-2 * w.pow(2).sum()
            loss.backward()
            return loss

        opt.step(clo)
        pr = (A[te] @ w + b) > 0
        yt = y[te] == 1
        accs.append(((pr[yt]).float().mean() + (~pr[~yt]).float().mean()).item() / 2)
    return round(sum(accs) / len(accs), 3) if accs else None


def conflicts(rows):
    out = {}
    for name, key in (("exact", lambda r: (r["situation"], tuple(r["keys"]))),
                      ("coarse", lambda r: (re.sub(r"\d+", "#", r["situation"].split(" I carry")[0]), tuple(r["keys"])))):
        g = defaultdict(set)
        for r in rows:
            g[key(r)].add(r["label"] == "nothing")
        mixed = {k for k, v in g.items() if len(v) > 1}
        out[name] = {"groups": len(g), "mixedGroups": len(mixed), "rowsInMixed": sum(key(r) in mixed for r in rows), "rows": len(rows)}
    return out


def main():
    start = int(arg("from", 64))
    rows, ticks = load()
    rows = [r for r in rows if r["mcDay"] >= start]
    tr = {r["id"]: trace(r, ticks) for r in rows if r["label"] == "nothing" or random.Random(r["id"]).random() < 0.05}
    for r in rows:
        r["_kind"] = kind(r, tr.get(r["id"]))
    variants = {
        "current": rows,
        "no-air": [r for r in rows if r["_kind"] != "bad gather: world refused the act"],
        "no-air+q": [r for r in rows if r["_kind"] not in ("bad gather: world refused the act", "quiet (day/open)")],
        "harm-only": [r for r in rows if r["_kind"] in ("good gather", "bad gather: died", "bad gather: hurt")],
    }
    out = {"from": start, "rows": len(rows), "kinds": dict(Counter(r["_kind"] for r in rows)),
           "refusedReasons": dict(Counter(re.sub(r"[-\s]*$", "", str(tr[r["id"]]["result"]))
                                          for r in rows if r["_kind"] == "bad gather: world refused the act").most_common(8)),
           "variants": {}}
    for name, vr in variants.items():
        lab = Counter("nothing" if r["label"] == "nothing" else "gather" for r in vr)
        out["variants"][name] = {"rows": len(vr), "labels": dict(lab), "conflicts": conflicts(vr), "probe": probe(vr),
                                 "dayOpen": dict(Counter(("nothing" if r["label"] == "nothing" else "gather") for r in vr
                                                         if r["situation"].startswith("It is day") and "closed in on every side" not in r["situation"]))}
        print(f"[audit] {name}: {out['variants'][name]}", flush=True)
    # The traceable sample: 10 quiet day/open, 5 quiet night/enclosed, 8 refused, 4 harm, 3 good.
    rng = random.Random(7)
    want = [("quiet (day/open)", 10), ("quiet (night/enclosed)", 5), ("bad gather: world refused the act", 8),
            ("bad gather: died", 2), ("bad gather: hurt", 2), ("good gather", 3)]
    verdict = {"quiet (day/open)": "ambiguous counterfactual: another layer acted and was fine; says nothing about gathering",
               "quiet (night/enclosed)": "plausible: gathering would mean digging out at night or out of a shelter",
               "bad gather: world refused the act": "mechanical: the block was gone or the body had turned; not a bad choice",
               "bad gather: died": "real harm (check: was gathering the cause?)", "bad gather: hurt": "real harm (check: was gathering the cause?)",
               "good gather": "plausible"}
    sample = []
    for k, n in want:
        pool = [r for r in rows if r["_kind"] == k]
        for r in rng.sample(pool, min(n, len(pool))):
            t = tr.get(r["id"]) or trace(r, ticks) or {}
            sample.append({"id": r["id"], "mcDay": r["mcDay"], "ts": r["ts"], "label": r["label"], "why": r["why"], "kind": k,
                           "verdict": verdict[k], "act": t.get("act"), "by": t.get("by"), "result": t.get("result"), "hurt30s": t.get("hurt"),
                           "died30s": t.get("died"), "health": " ".join(str(h) for h in t.get("health") or []), "hostiles": ",".join(map(str, t.get("hostiles") or [])),
                           "menu": "|".join(r["keys"]), "situation": r["situation"][:220]})
    rid = f"labelaudit-{time.strftime('%Y%m%d-%H%M%S')}"
    os.makedirs(RUNS, exist_ok=True)
    out["sample"] = sample
    with open(os.path.join(RUNS, f"{rid}.json"), "w", encoding="utf8") as f:
        json.dump(out, f, indent=1)
    with open(os.path.join(RUNS, f"{rid}.csv"), "w", encoding="utf8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(sample[0]))
        w.writeheader()
        w.writerows(sample)
    print(f"[audit] kinds {out['kinds']}\n[audit] refused reasons {out['refusedReasons']}\n[audit] saved runs/{rid}.json and .csv", flush=True)


if __name__ == "__main__":
    main()
