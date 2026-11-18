"""Stage 7b, part 3, test 2: Laya's vega as the teacher, learned from the creature's outcomes.

    python laya_teacher.py   -> logs/steer-trial/neurons/teacher-laya.json  {map id: {"pickup": p, "nothing": 1-p}}

Fits a vega head (frozen 0.8B reader + small calibrated head) on outcome-labelled
situations (agent/src/tools/steerOutcomes.js: what really happened after picking
up, or after staying), balanced between the two labels, then gives its calibrated
probability of "pick up" for the 80 teacher situations decision_write.py uses.
Also reports how often it agrees with the rule-labelled teacher.
"""
import json
import os
import random
import sys
import time

import laya

sys.path.insert(0, os.path.dirname(__file__))
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
NEU = os.path.join(ROOT, "logs", "steer-trial", "neurons")

QUESTIONS = {
    "act": {
        "type": "choice",
        "instructions": "MindBot, a creature in a Minecraft world, sees something lying on the ground in reach. "
                        "Going by how things have turned out for it before, should it pick it up now, or leave it?",
        "criteria": {
            "pickup": "pick up what is lying nearby",
            "nothing": "leave it and do nothing about it now",
        },
    }
}


WITH_OPUS = "--with-opus" in sys.argv


def read_jsonl(p):
    return [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]


def main():
    rows = read_jsonl(os.path.join(NEU, "outcome-rows.jsonl"))
    rng = random.Random(0)
    pick = [r for r in rows if r["label"] == "pickup"]
    stay = [r for r in rows if r["label"] == "nothing"]
    pick = rng.sample(pick, min(len(pick), 2 * len(stay)))  # balance: at most 2 pick-ups per "nothing"
    fit = [{"state": r["text"], "gold": {"act": r["label"]}} for r in pick + stay]
    if WITH_OPUS:  # route B: Opus's corrections join the creature's outcomes, counted double
        corr = read_jsonl(os.path.join(NEU, "opus-corrections.jsonl"))
        fit += [{"state": r["text"], "gold": {"act": r["label"]}} for r in corr for _ in range(2)]
        print(f"[laya] + {len(corr)} Opus corrections (x2)", flush=True)
    rng.shuffle(fit)
    print(f"[laya] fitting vega on {len(fit)} outcome rows ({len(pick)} pick up, {len(stay)} nothing); "
          f"min rows {laya.VegaAgent.min_rows(QUESTIONS)}", flush=True)
    t0 = time.time()
    vega = laya.VegaAgent(device="cuda")
    # calibrate=False: with calibration the temperature railed at its cap (20) and flattened
    # every probability to ~0.5 (2026-11-18); the head alone is 87% right under cross-validation.
    report = vega.fit(fit, questions=QUESTIONS, calibrate=False)
    print(f"[laya] fit in {time.time() - t0:.0f}s: {json.dumps(report, default=str)[:700]}", flush=True)

    sys.path.insert(0, os.path.dirname(__file__))
    import decision_write as dw  # the same 80 teacher situations
    teach = {c["id"]: c for c in dw.teacher_cases()}
    texts = {r["id"]: r["text"] for r in read_jsonl(os.path.join(NEU, "teacher-texts.jsonl"))}
    ids = list(teach)
    outs = vega.predict_batch([texts[i] for i in ids], QUESTIONS, batch_size=16)
    q, agree = {}, 0
    for i, o in zip(ids, outs):
        a = (o.get("answers") or {}).get("act") or {}
        p = float((a.get("probabilities") or {}).get("pickup", 0.5))
        q[i] = {"pickup": round(p, 4), "nothing": round(1 - p, 4), "route": a.get("route"), "rule": teach[i]["right"]}
        agree += (p >= 0.5) == (teach[i]["right"] == "pickup")
    by = {}
    for i in ids:
        k = "rule says pick up" if teach[i]["right"] == "pickup" else "rule says nothing"
        by.setdefault(k, []).append(q[i]["pickup"])
    summary = {k: {"n": len(v), "meanPpickup": round(sum(v) / len(v), 3), "laya picks up": sum(1 for x in v if x >= 0.5)} for k, v in by.items()}
    json.dump({"q": q, "agreeWithRule": agree, "n": len(ids), "summary": summary, "fitReport": json.loads(json.dumps(report, default=str))},
              open(os.path.join(NEU, "teacher-laya-opus.json" if WITH_OPUS else "teacher-laya.json"), "w", encoding="utf8"), indent=1)
    print(f"[laya] teacher for {len(ids)} situations: agrees with the rule on {agree}; {json.dumps(summary)}", flush=True)


if __name__ == "__main__":
    main()
