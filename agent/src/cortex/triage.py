"""Day-time triage with Laya: flag the moments worth a lesson tonight.

While MindBot lives, this process follows the tick log (logs/ticks-<date>.jsonl)
on its own, so it can never slow the body down or break it. Every sampled
moment, once the next 30 s are known, is described in words (the situation,
what the body did and which layer chose it, what the model layers would have
done, and what came of it), and Laya answers two questions about it:

    lesson  is there something to learn here? (yes / no, with its probability)
    kind    danger (hurt or at risk), missed (food or something useful left in
            reach), wasted (pointless or repetitive), or fine

Flags go to logs/triage-<date>.jsonl, for the night's review (docs/design-subsumption.md:
by day Laya flags, at night Opus decides the lesson, the solve writes it, the gate checks it).

Laya's own LayaTriage preset is for customer-support tickets, so this uses
Laya's general question machinery with MindBot's questions. Zero-shot for now:
its flags are a first filter, not a verdict.

    python triage.py                     follow today's tick log (Ctrl+C to stop)
    python triage.py --replay 2026-11-17 [--limit 400]   triage a past day, print a summary
Options: --device cpu|cuda (default cpu: the GPU belongs to the live layers), --every 20 (sample 1 in N ticks, plus every event)
"""
import datetime as dt
import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
LOGS = os.path.join(ROOT, "logs")
AFTER = 20  # ticks (30 s) of what came next

QUESTIONS = {
    "lesson": {
        "type": "noul",
        "instructions": "MindBot is a creature living in a Minecraft world. Read this moment and what came of it. "
                        "Is there something it should learn from it: did it do something unwise, miss something useful, or get hurt?",
    },
    "kind": {
        "type": "choice",
        "instructions": "What kind of moment was this for MindBot, the creature in this Minecraft world?",
        "criteria": {
            "danger": "it was hurt, or was in danger and didn't get away from it",
            "missed": "it left food or something useful lying in reach, or didn't do what it needed",
            "wasted": "it did something pointless, or the same thing over and over",
            "fine": "nothing to learn: what it did made sense and went fine",
        },
    },
}


def arg(name, default=None):
    return sys.argv[sys.argv.index(f"--{name}") + 1] if f"--{name}" in sys.argv else default


def words(t):
    """A tick in words (the same facts the night review reads)."""
    p = ["It is day." if t.get("isDay") else "It is night."]
    p.append(f"Health {round(t.get('health') or 0)}/20, food {t.get('food', '?')}/20.")
    a = t.get("aff") or {}
    p.append("Sealed in on every side." if a.get("enclosed") else f"{'Something overhead' if a.get('roof') else 'Open sky'}, {a.get('walls', 0)} of 4 sides closed.")
    h = [f"{x['name']} {round(x['d'])} blocks away" for x in (t.get("hostiles") or [])[:3]]
    if h:
        p.append("Hostile: " + ", ".join(h) + ".")
    items = [f"{x['name'].replace('_', ' ')} {round(x['d'])} blocks away" for x in (t.get("items") or []) if x.get("d", 99) <= 8][:3]
    if items:
        p.append("Lying in reach: " + ", ".join(items) + ".")
    ripe = [c["name"] for c in (t.get("crops") or []) if c.get("ripe")][:2]
    if ripe:
        p.append("Ripe crops close by.")
    if t.get("foodCarried") is not None:
        p.append(f"Food carried: {t['foodCarried']}.")
    return " ".join(p)


def act_words(t):
    a = t.get("action") or {}
    s = f"The body did: {a.get('type')}{(' ' + a['at']) if a.get('at') else ''}, chosen by {a.get('layer', '?')}."
    sh = a.get("shadow") or {}
    models = [f"{k} would have chosen {v.get('pick')}" for k, v in sh.items() if k in ("make", "shelter", "gather") and v.get("pick") not in (None, v.get("hand"))]
    if models:
        s += " Its model layers disagreed: " + "; ".join(models) + "."
    if (t.get("result") or {}).get("ok") is False:
        s += f" The body couldn't: {t['result'].get('reason')}."
    return s


def afterwards(ticks, i):
    t, hurt, end = ticks[i], 0, min(len(ticks) - 1, i + AFTER)
    for k in range(i + 1, end + 1):
        a, b = ticks[k - 1], ticks[k]
        if a.get("health") is not None and b.get("health") is not None and b["health"] < a["health"]:
            hurt += a["health"] - b["health"]
    e = ticks[end]
    parts = []
    if hurt:
        parts.append(f"lost {round(hurt)} health")
    if e.get("food") is not None and t.get("food") is not None and e["food"] != t["food"]:
        parts.append(f"food {t['food']} -> {e['food']}")
    if e.get("foodCarried") is not None and t.get("foodCarried") is not None and e["foodCarried"] != t["foodCarried"]:
        parts.append(f"food carried {t['foodCarried']} -> {e['foodCarried']}")
    return "Over the next 30 seconds: " + (", ".join(parts) if parts else "nothing much changed") + ".", hurt


def event(ticks, i):
    """Moments always worth a look: hurt, couldn't act, starving."""
    t = ticks[i]
    if t.get("tookDamage") or (t.get("result") or {}).get("ok") is False:
        return True
    return (t.get("food") or 20) <= 4


def moment(ticks, i):
    after, hurt = afterwards(ticks, i)
    return f"{words(ticks[i])} {act_words(ticks[i])} {after}", hurt


class Triage:
    def __init__(self, device):
        import laya
        t0 = time.time()
        self.agent = laya.load("convaiinnovations/laya", device=device)
        print(f"[triage] Laya encoder loaded on {device} in {time.time() - t0:.0f}s", flush=True)

    def judge(self, texts):
        outs = self.agent.predict_batch(texts, QUESTIONS, batch_size=8)
        res = []
        for o in outs:
            a = o.get("answers") or {}
            les = a.get("lesson") or {}
            kind = a.get("kind") or {}
            p_yes = les.get("noul")  # Laya's yes/no answers: the probability of yes
            res.append({"lesson": round(float(p_yes or 0), 3), "kind": kind.get("choice"),
                        "kindP": round(float(max((kind.get("probabilities") or {"": 0}).values())), 3)})
        return res


def read_new(path, pos):
    if not os.path.exists(path):
        return [], pos
    with open(path, encoding="utf8") as f:
        f.seek(pos)
        data = f.read()
        if not data.endswith("\n"):  # keep a half-written last line for next time
            data = data[: data.rfind("\n") + 1]
        pos += len(data.encode("utf8"))
    out = []
    for line in data.splitlines():
        try:
            t = json.loads(line)
            if t.get("action") and t.get("aff"):
                out.append(t)
        except ValueError:
            pass
    return out, pos


def replay(day, limit, every, tri):
    ticks, _ = read_new(os.path.join(LOGS, f"ticks-{day}.jsonl"), 0)
    ticks = ticks[-limit:] if limit else ticks
    idx = [i for i in range(len(ticks) - AFTER) if i % every == 0 or event(ticks, i)]
    texts, hurts = zip(*[moment(ticks, i) for i in idx])
    t0 = time.time()
    res = tri.judge(list(texts))
    secs = time.time() - t0
    hurt = [r for r, h in zip(res, hurts) if h >= 2]
    calm = [r for r, h in zip(res, hurts) if h == 0]
    mean = lambda xs: round(sum(x["lesson"] for x in xs) / len(xs), 3) if xs else None
    kinds = {}
    for r in res:
        kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
    print(f"[triage] replay {day}: {len(res)} moments in {secs:.0f}s ({secs / max(1, len(res)):.2f}s each)")
    print(f"[triage] mean P(lesson): hurt soon after {mean(hurt)} (n={len(hurt)}), nothing happened {mean(calm)} (n={len(calm)}); kinds {kinds}")
    top = sorted(zip(res, texts), key=lambda x: -x[0]["lesson"])[:3]
    for r, tx in top:
        print(f"  {r['lesson']:.2f} {r['kind']}: {tx[:220]}")


def follow(every, tri):
    pos, day, buf, done = 0, None, [], 0
    print(f"[triage] following the tick log; flags -> logs/triage-<date>.jsonl", flush=True)
    while True:
        today = dt.datetime.now().strftime("%Y-%m-%d")  # local date, as the agent names its logs
        if today != day:
            day, pos, buf, done = today, 0, [], 0
            path = os.path.join(LOGS, f"ticks-{day}.jsonl")
            if os.path.exists(path):  # start at the end: only new moments
                _, pos = read_new(path, 0)
        new, pos = read_new(os.path.join(LOGS, f"ticks-{day}.jsonl"), pos)
        buf.extend(new)
        ready = [i for i in range(done, len(buf) - AFTER) if i % every == 0 or event(buf, i)]
        done = max(done, len(buf) - AFTER)
        if ready:
            texts = [moment(buf, i)[0] for i in ready]
            try:
                res = tri.judge(texts)
            except Exception as err:  # a bad batch must not stop the triage
                print(f"[triage] skipped a batch: {err}", flush=True)
                res = []
            with open(os.path.join(LOGS, f"triage-{day}.jsonl"), "a", encoding="utf8") as f:
                for i, r, tx in zip(ready, res, texts):
                    a = buf[i].get("action") or {}
                    f.write(json.dumps({"ts": buf[i].get("ts"), "layer": a.get("layer"), "act": a.get("type"), **r, "text": tx}) + "\n")
            flagged = sum(1 for r in res if r["lesson"] >= 0.5)
            if flagged:
                print(f"[triage] {len(res)} moments, {flagged} flagged", flush=True)
        if len(buf) > 2000:  # keep memory small; indices stay relative
            cut = len(buf) - 200
            buf, done = buf[cut:], max(0, done - cut)
        time.sleep(15)


def main():
    device = arg("device", "cpu")
    every = int(arg("every", 20))
    tri = Triage(device)
    if "--replay" in sys.argv:
        replay(arg("replay"), int(arg("limit", 400)), every, tri)
    else:
        follow(every, tri)


if __name__ == "__main__":
    main()
