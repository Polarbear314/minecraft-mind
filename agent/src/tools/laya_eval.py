"""B1 with Laya (docs/design-plasticity-and-a-learning-cortex.md).

Scores Laya as MindBot's fast chooser on the SAME held-out situations the
Gemma models were tested on (logs/training/b1-testset.json, written from
cortexEval.js's split). Three contenders:

  laya-encoder   the small ModernBERT encoder, zero-shot
  vega           the vega engine (0.8B frozen reader), zero-shot
  vega-fitted    vega with small heads fitted on the EARLIER day's acts that
                 went well (Laya serves a head only if it beats the engine)

Run with the bot stopped:  .venv-laya\\Scripts\\python src\\tools\\laya_eval.py [--quick]
Writes logs/training/laya-results.json; cortexEval's report is extended by hand.
"""
import json
import os
import sys
import time

import laya

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
TESTSET = os.path.join(ROOT, "logs", "training", "b1-testset.json")
OUT = os.path.join(ROOT, "logs", "training", "laya-results-fitted.json" if "--fitted-only" in sys.argv else "laya-results.json")
QUICK = "--quick" in sys.argv

DESCRIBE = {
    "idle": "stay where I am and do nothing",
    "explore": "walk somewhere new",
    "seekFood": "go looking for food",
    "flee": "run away from a hostile creature",
    "eat": "eat something I carry",
    "approach": "walk up to a creature",
    "swingAt": "strike a creature",
    "pickup": "pick up something lying on the ground",
    "returnInside": "walk back from the edge of the world",
    "jump": "jump",
    "craft": "make something from what I carry",
    "equip": "hold something in my hand",
    "use": "work a door or a bed",
    "dig": "break a nearby block",
}


def describe(act):
    if act in DESCRIBE:
        return DESCRIBE[act]
    verb, _, where = act.partition(" ")
    where = where.replace("-", " ")
    return {"dig": f"break the block {where}", "place": f"set a block {where}", "move": f"step {where}"}.get(verb, act)


def questions_for(menu):
    return {
        "act": {
            "type": "choice",
            "instructions": "MindBot, a creature in a Minecraft world, is in this situation. Which ONE act is most likely "
                            "to go well right now: staying alive, unhurt and fed, and getting on with living?",
            "criteria": {a: describe(a) for a in menu},
        }
    }


def score(name, agent, data, questions, batch=16):
    rows = data["good"] + data["bad"]
    if QUICK:
        rows = data["good"][:6] + data["bad"][:3]
    states = [r["situation"] for r in rows]
    t0 = time.time()
    outs = agent.predict_batch(states, questions, batch_size=batch)
    per = (time.time() - t0) / max(1, len(states))
    picks = []
    sample_answer = ((outs[0] or {}).get("answers") or {}).get("act") if outs else None
    print(f"[laya] {name}: answer fields {sorted((sample_answer or {}).keys())}", flush=True)
    for r, o in zip(rows, outs):
        a = (o.get("answers") or {}).get("act") or {}
        probs = a.get("probabilities") or {}
        top = max(probs.values()) if probs else None
        picks.append({
            "label": r["label"], "hard": r.get("hard", False), "did": r["action"], "choice": a.get("choice"),
            "top": top, "route": a.get("route"), "abstain": a.get("abstain"),
            "conf": a.get("answer_confidence", a.get("confidence")),
            "inSet": len(a.get("prediction_set") or []) if a.get("prediction_set") is not None else None,
        })
    good = [p for p in picks if p["label"] == "good"]
    hard = [p for p in good if p["hard"]]
    bad = [p for p in picks if p["label"] == "bad"]
    share = lambda xs, f: (sum(1 for x in xs if f(x)) / len(xs)) if xs else None
    # "Sure": Laya's own route says auto; otherwise top probability >= 0.5.
    sure = lambda p: (p["route"] == "auto") if p["route"] is not None else (p["top"] is not None and p["top"] >= 0.5)
    res = {
        "model": name,
        "good": share(good, lambda p: p["choice"] == p["did"]),
        "hard": share(hard, lambda p: p["choice"] == p["did"]),
        "avoid": share(bad, lambda p: p["choice"] != p["did"]),
        "sureShare": share(good, sure),
        "sureRight": share([p for p in good if sure(p)], lambda p: p["choice"] == p["did"]),
        "unsureRight": share([p for p in good if not sure(p)], lambda p: p["choice"] == p["did"]),
        "secondsPerPick": per,
        "picks": sorted(((c, sum(1 for p in picks if p["choice"] == c)) for c in set(p["choice"] for p in picks)), key=lambda x: -x[1])[:6],
        "n": len(picks),
        "perPick": picks,
    }
    print(f"[laya] {name}: picks what worked {res['good']}, hard {res['hard']}, avoids bad {res['avoid']}, "
          f"sure {res['sureShare']} (right {res['sureRight']}), {per:.3f}s/pick", flush=True)
    return res


def main():
    data = json.load(open(TESTSET, encoding="utf-8"))
    menu = data["menu"]
    questions = questions_for(menu)
    results = []

    only_fitted = "--fitted-only" in sys.argv
    if not only_fitted:
        print("[laya] loading the encoder...", flush=True)
        enc = laya.load("convaiinnovations/laya", device="cuda")
        results.append(score("laya-encoder", enc, data, questions))
        del enc

    print("[laya] loading the vega engine...", flush=True)
    vega = laya.VegaAgent(device="cuda")
    if not only_fitted:
        results.append(score("vega", vega, data, questions))

    fit_rows = [{"state": r["situation"], "gold": {"act": r["action"]}} for r in data["fit"]]
    if QUICK:
        fit_rows = fit_rows[:200]
    print(f"[laya] fitting heads on {len(fit_rows)} earlier acts that went well (min {laya.VegaAgent.min_rows(questions)})...", flush=True)
    t0 = time.time()
    report = vega.fit(fit_rows, questions=questions)
    fit_secs = time.time() - t0
    act_report = report  # the whole report: which heads were fitted and served, calibration band
    print(f"[laya] fit took {fit_secs:.0f}s; report for act: {json.dumps(act_report, default=str)[:600]}", flush=True)
    r = score("vega-fitted", vega, data, questions)
    r["fitSeconds"] = fit_secs
    r["fitReport"] = act_report
    results.append(r)
    fit_dir = os.path.join(ROOT, "logs", "training", "laya-fit")
    vega.save_calibration(fit_dir)
    print(f"[laya] saved the fitted heads to {fit_dir}", flush=True)

    json.dump({"testDay": data["testDay"], "menu": menu, "results": results}, open(OUT, "w", encoding="utf-8"), indent=2, default=str)
    print(f"[laya] wrote {OUT}", flush=True)


if __name__ == "__main__":
    main()
