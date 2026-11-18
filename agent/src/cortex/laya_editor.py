"""Stage 7b, part 3: Laya as the editor instead of Opus (docs/results-7b-trial.md).

Laya is a fast local chooser (it scores a fixed set of options; it can't write
hypotheses or new weights). Here it does the part of editing that is a choice:
which of the Gather model's 448 neuron groups to switch off. Its pick is turned
into an edit of the same shape Opus chose (two groups off, the third at half)
and scored on the same held-out cases by neuron_map.py.

    python laya_editor.py     -> logs/steer-trial/neurons/laya-ranking.json, laya-ops.json

Three Laya editors:
  encoder-zero   Laya's small encoder, zero-shot, reading each group's description
                 exactly as Opus read it (with the measured switch-off effect).
  vega-zero      the vega engine (0.8B reader), zero-shot, the same descriptions.
  vega-fitted    vega with a head fitted on the switch-off table: description WITHOUT
                 the effect -> "helps when switched off" (P(nothing) falls >= 0.05 when
                 gathering is right, and by no more than 0.04 when it isn't). Two folds
                 by layer (even / odd): every group is ranked by a head that never saw
                 its own measured effect.
"""
import json
import os
import sys
import time

import laya

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
NEU = os.path.join(ROOT, "logs", "steer-trial", "neurons")
HELPS = ("switch_off", "leave")


def pct(x):
    return f"{round(x * 100)}%"


def text(g, eff=None):
    """The group's description, as steerNeurons.js groupText writes it for Opus."""
    s = g["topShare"]
    t = (f"Group {g['id']} (layer {g['layer']}, {g['size']} neurons). Fires most on: {g['top'][0]}. "
         f"Of its top situations: day {pct(s['day'])}, sealed in {pct(s['sealed'])}, hostile near {pct(s['hostile'])}, "
         f"worth gathering {pct(s['worthGathering'])}. Fires more when worth gathering: z {g['z']}. "
         f"Tracks the model saying nothing: corr {g['corrNothing']}. When it fires, its output points toward less "
         f"\"nothing\": cos {g['cos']}.")
    if eff:
        t += (f" Switched off, P(nothing) moves {eff['test']:+} when gathering is right and "
              f"{eff['control']:+} when it is not.")
    return t


QUESTIONS = {
    "edit": {
        "type": "choice",
        "instructions": ("A small language model controls when a Minecraft creature gathers. Its flaw: by day, in the "
                         "open, with something lying in reach and no danger, it says 'nothing' instead of picking it up. "
                         "Below is one group of its neurons. Should this group be switched off to fix the flaw, "
                         "without making it gather at night, sealed in, or with a hostile close?"),
        "criteria": {
            "switch_off": "switch this group off: it holds the model back when it is safe to gather, and is quiet when it is dangerous",
            "leave": "leave this group alone: switching it off would not help, or would make the model act when it is dangerous",
        },
    }
}


def p_switch(out):
    a = (out.get("answers") or {}).get("edit") or {}
    return float((a.get("probabilities") or {}).get("switch_off", 0.0))


def ops_for(ranked):
    """The same edit shape Opus kept: the top two groups off, the third at half."""
    top = [r["id"] for r in ranked[:3]]
    f = [0, 0, 0.5]
    return [{"op": "scale_out", "layer": int(g.split(":")[0]), "group": int(g.split(":")[1]), "factor": f[k]} for k, g in enumerate(top)]


def main():
    groups = json.load(open(os.path.join(NEU, "groups.json"), encoding="utf8"))
    eff = json.load(open(os.path.join(NEU, "group-effects.json"), encoding="utf8"))["offDeltaNothing"]
    label = {g["id"]: ("switch_off" if eff[g["id"]]["test"] <= -0.05 and eff[g["id"]]["control"] >= -0.04 else "leave") for g in groups}
    with_eff = [text(g, eff[g["id"]]) for g in groups]
    bare = [text(g) for g in groups]
    out = {}
    t0 = time.time()

    print("[laya] encoder, zero-shot...", flush=True)
    enc = laya.load("convaiinnovations/laya", device="cuda")
    res = enc.predict_batch(with_eff, QUESTIONS, batch_size=16)
    out["encoder-zero"] = {g["id"]: p_switch(r) for g, r in zip(groups, res)}
    del enc

    print(f"[laya] vega, zero-shot... ({time.time() - t0:.0f}s)", flush=True)
    vega = laya.VegaAgent(device="cuda")
    res = vega.predict_batch(with_eff, QUESTIONS, batch_size=16)
    out["vega-zero"] = {g["id"]: p_switch(r) for g, r in zip(groups, res)}

    print(f"[laya] vega, fitted out-of-fold (min rows {laya.VegaAgent.min_rows(QUESTIONS)})... ({time.time() - t0:.0f}s)", flush=True)
    fitted = {}
    reports = {}
    for fold in (0, 1):
        train = [k for k, g in enumerate(groups) if g["layer"] % 2 != fold]
        test = [k for k, g in enumerate(groups) if g["layer"] % 2 == fold]
        v = laya.VegaAgent(device="cuda")
        rows = [{"state": bare[k], "gold": {"edit": label[groups[k]["id"]]}} for k in train]
        rep = v.fit(rows, questions=QUESTIONS)
        reports[f"fold{fold}"] = json.loads(json.dumps(rep, default=str))
        res = v.predict_batch([bare[k] for k in test], QUESTIONS, batch_size=16)
        for k, r in zip(test, res):
            fitted[groups[k]["id"]] = p_switch(r)
        del v
    out["vega-fitted"] = fitted

    ranking = {}
    for name, scores in out.items():
        ranked = sorted(({"id": k, "p": round(v, 4), "label": label[k], "effect": eff[k]} for k, v in scores.items()), key=lambda r: -r["p"])
        hits10 = sum(1 for r in ranked[:10] if r["label"] == "switch_off")
        ranking[name] = {"top": ranked[:10], "helpersInTop10": hits10, "ops": ops_for(ranked)}
        print(f"[laya] {name}: top 3 {[r['id'] for r in ranked[:3]]}; helpers in top 10: {hits10} (of {sum(1 for v in label.values() if v == 'switch_off')} in 448)", flush=True)
    json.dump({"ranking": ranking, "fitReports": reports, "positives": sum(1 for v in label.values() if v == "switch_off")},
              open(os.path.join(NEU, "laya-ranking.json"), "w", encoding="utf8"), indent=1, default=str)
    json.dump([{"name": f"laya-{n}", "ops": r["ops"]} for n, r in ranking.items()],
              open(os.path.join(NEU, "laya-ops.json"), "w", encoding="utf8"), indent=1)
    print(f"[laya] done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
