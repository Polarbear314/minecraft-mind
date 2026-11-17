"""Does a PLAIN classifier do as well as fitted Laya? (B1 check)

Same data as laya_eval.py (logs/training/b1-testset.json): fit on the earlier
day's acts that went well, score on the held-out day's good and bad rows.

Contenders, simplest first:
  most-common     always the act done most often in the fit day
  lookup          the most common act for this coarse situation
                  (day/night, hostile near, hungry, hurt, sky open)
  logreg          logistic regression on words + the numbers in the situation
                  (health, food, sides closed, nearest hostile, edge distance)

No new installs: the regression is written with PyTorch from Laya's venv.
Run: agent\\.venv-laya\\Scripts\\python agent\\src\\tools\\plain_eval.py
Writes logs/training/plain-results.json.
"""
import collections
import json
import os
import re
import time

import torch

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
TESTSET = os.path.join(ROOT, "logs", "training", "b1-testset.json")
OUT = os.path.join(ROOT, "logs", "training", "plain-results.json")
torch.manual_seed(0)


def numbers(s):
    f = lambda pat, d=0.0: float(m.group(1)) if (m := re.search(pat, s)) else d
    hostile = [float(x) for x in re.findall(r"(?:zombie|skeleton|spider|creeper|witch|enderman|slime|drowned|husk)\w* at (\d+(?:\.\d+)?)", s)]
    near = min(hostile) if hostile else 40.0
    return [
        f(r"Health (\d+(?:\.\d+)?)/20", 20) / 20,
        f(r"food (\d+(?:\.\d+)?)/20", 20) / 20,
        f(r"(\d) of 4 sides closed") / 4,
        1.0 if "open sky" in s else 0.0,
        min(near, 40) / 40,
        1.0 if near < 8 else 0.0,
        min(f(r"edge of the world is (\d+)", 64), 64) / 64,
        1.0 if s.startswith("Night") else 0.0,
        1.0 if s.startswith(("Dusk", "Evening")) else 0.0,
    ]


def coarse(s):
    n = numbers(s)
    return (n[7] or n[8], n[5], n[1] < 0.5, n[0] < 0.5, n[3])


def words(s):
    toks = re.findall(r"[a-z]+", s.lower())
    return toks + [a + "_" + b for a, b in zip(toks, toks[1:])]


def main():
    data = json.load(open(TESTSET, encoding="utf-8"))
    menu = data["menu"]
    fit = [r for r in data["fit"] if r["action"] in menu]
    test = data["good"] + data["bad"]
    results = []

    def score(name, choose, conf=None, secs=None):
        picks = []
        for r in test:
            c = choose(r["situation"])
            picks.append({"label": r["label"], "hard": r.get("hard", False), "did": r["action"], "choice": c,
                          "conf": conf(r["situation"]) if conf else None})
        good = [p for p in picks if p["label"] == "good"]
        hard = [p for p in good if p["hard"]]
        bad = [p for p in picks if p["label"] == "bad"]
        share = lambda xs, f: round(sum(1 for x in xs if f(x)) / len(xs), 3) if xs else None
        res = {"model": name, "good": share(good, lambda p: p["choice"] == p["did"]),
               "hard": share(hard, lambda p: p["choice"] == p["did"]),
               "avoid": share(bad, lambda p: p["choice"] != p["did"]), "secondsPerPick": secs,
               "picks": collections.Counter(p["choice"] for p in picks).most_common(6)}
        if conf:  # right-rate by confidence quartile, most sure first
            g = sorted(good, key=lambda p: -p["conf"])
            q = len(g) // 4
            res["quartilesRight"] = [share(g[i * q:(i + 1) * q], lambda p: p["choice"] == p["did"]) for i in range(4)]
        print(f"[plain] {name}: {json.dumps({k: v for k, v in res.items() if k != 'picks'})}  picks {res['picks'][:4]}", flush=True)
        results.append(res)

    counts = collections.Counter(r["action"] for r in fit)
    top = counts.most_common(1)[0][0]
    score("most-common", lambda s: top)

    table = collections.defaultdict(collections.Counter)
    for r in fit:
        table[coarse(r["situation"])][r["action"]] += 1
    score("lookup", lambda s: (table[coarse(s)].most_common(1)[0][0] if table[coarse(s)] else top))

    # Logistic regression: vocab from the fit day, plus the numbers.
    vocab = {w: i for i, w in enumerate(sorted({w for r in fit for w in words(r["situation"])}))}
    nnum = len(numbers(""))

    def feats(s):
        x = torch.zeros(len(vocab) + nnum)
        for w in words(s):
            if w in vocab:
                x[vocab[w]] = 1.0
        x[len(vocab):] = torch.tensor(numbers(s))
        return x

    idx = {a: i for i, a in enumerate(menu)}

    def train(rows, epochs=300, l2=1e-3):
        X = torch.stack([feats(r["situation"]) for r in rows])
        y = torch.tensor([idx[r["action"]] for r in rows])
        W = torch.nn.Linear(X.shape[1], len(menu))
        opt = torch.optim.LBFGS(W.parameters(), max_iter=epochs, line_search_fn="strong_wolfe")

        def closure():
            opt.zero_grad()
            loss = torch.nn.functional.cross_entropy(W(X), y) + l2 * W.weight.pow(2).sum()
            loss.backward()
            return loss
        opt.step(closure)
        return W

    # Within-day cross-validation, to compare with Laya's 53% on its fit day.
    shuffled = fit[:]
    g = torch.Generator().manual_seed(0)
    shuffled = [shuffled[i] for i in torch.randperm(len(shuffled), generator=g)]
    k, right = 5, 0
    for f in range(k):
        hold = shuffled[f::k]
        rest = [r for i, r in enumerate(shuffled) if i % k != f]
        Wf = train(rest)
        with torch.no_grad():
            right += sum(int(Wf(feats(r["situation"])).argmax()) == idx[r["action"]] for r in hold)
    cv = right / len(shuffled)
    print(f"[plain] logreg within-day cross-validation: {cv:.3f}", flush=True)

    t0 = time.time()
    W = train(fit)
    fit_secs = time.time() - t0
    with torch.no_grad():
        prob = lambda s: torch.softmax(W(feats(s)), -1)
        t1 = time.time()
        for r in test:
            prob(r["situation"])
        per = (time.time() - t1) / len(test)
        score("logreg", lambda s: menu[int(prob(s).argmax())], conf=lambda s: float(prob(s).max()), secs=round(per, 5))
    results[-1]["cvWithinDay"] = round(cv, 3)
    results[-1]["fitSeconds"] = round(fit_secs, 1)

    json.dump({"testDay": data["testDay"], "results": results}, open(OUT, "w", encoding="utf-8"), indent=2)
    print(f"[plain] wrote {OUT}", flush=True)


if __name__ == "__main__":
    main()
