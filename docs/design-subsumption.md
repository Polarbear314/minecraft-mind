# Subsumption with layers that learn while it sleeps

*From a conversation with the course professor (2026-11-17): organise MindBot by **behaviours** stacked in layers (Rodney Brooks's subsumption architecture), not by brain regions; make the layers small models that can learn; make dreaming the only way they learn; and measure how behaviour changes from day to day.*

*Status: approved in outline. Second draft, 2026-11-17.*

**Stage 1 built (2026-11-17).** `agent/src/brain/layers.js`: the six layers, hand-written from today's reflexes and instinct. Each tick every layer proposes or stays quiet; the first in the order Survive, Make, Shelter, Gather, Forage, Wander that speaks wins. One wire across layers: while Survive acts, or Shelter holds the body in the evening, Make is inhibited and a running plan pauses. Turn it on with `MIND=layers` in `agent/.env` (keep `DECISION_MODE=claude-code` so dreaming still runs). In this mode Claude is not consulted by day and the Gemma regions don't run; `MIND=regions` (the default) is unchanged. Every tick's log entry (`logs/ticks-*.jsonl`) now carries `layer` (who was in control) and `voices` (every layer that spoke), and the console shows `[tick] gather: dig …`. `npm run sim`: 257 checks (15 new). Running live since 2026-11-17.

*First live day (809 ticks), and what it fixed:*
- **Plans never advanced.** The stack relabelled plan steps `layer:make`, and the plan runner only advances steps labelled `plan`. Make jumped 233 ticks on step 1 of "Climb Out Onto Grass" and Gather (speaking 307 times) never got the body. Fixed: plan steps keep their label; plans now pass.
- **Survive fled too much** (84 ticks, a quarter of them from hostiles 11–16 blocks away): fear now sends it running only from a hostile within 10 blocks.
- **A plan kept a starving body busy** (hunger 90 while a plan explored): urgent hunger now inhibits Make, like Survive and night-time Shelter.
- **Night went well:** Shelter dug in, sealed the roof, and held the body enclosed for 401 ticks.

**Stage 2 built (2026-11-17).** `agent/src/vault/memory.js`:
- **Weights:** every note's `weight` (0–1); notes without one start from what they already say (`initialWeight`).
- **Index and retrieval:** `createMemory()` keeps every note in memory, re-reading only files that changed; `retrieve(question, { layer })` ranks by similarity × weight × recency, with each layer's job added to the question. Similarity is word overlap (TF-IDF) by default, or embeddings when `EMBED_MODEL` (e.g. `nomic-embed-text`) is set in `agent/.env` and pulled in Ollama; embeddings are cached in `logs/memory-embeddings.json`. `npm run recall -- "<situation>" --layer shelter` shows what a layer would remember. No layer reads notes yet: the stage 1 layers are hand-written; the 3B/4B layers (stage 6) will.
- **Forgetting** (`forget()`, run at every sleep after link consolidation, `reflection/dream.js`): Experiences over a day old fade (×0.85, ×0.92 if they felt good or bad; pulled back if what they involved was met again). Below 0.08, or the weakest while live memory is over its budget of 300, they are folded into a gist note in `Gists/` (tally of how often, how it went, links to the episodes; tentative under 3 episodes) and moved to `Archive/Experiences/` with when and why. At most 100 leave per sleep. `restore()` brings one back. Gists are written from the tally for now; having Opus write them is part of stage 5.
- *On the live vault:* about 760 Experiences against a budget of 300, so the first few sleeps each archive 100 until it settles. The `[sleep] memory:` log line reports it.
- `npm run sim`: 270 checks (13 new).

**Food fixes (2026-11-17, after day 2 starved).** The bot walked past carrots, wheat and animals.
- *Hunting worked* (a pig killed, three porkchops eaten), but at hunger 55 a plan pulled it away from two more pigs, and for most of the day there were no animals about: only 4 cows and a chicken within 100 blocks. Farm animals barely respawn, so a 128-block world runs out.
- *Crops were invisible:* not in the blocks the body scans. Now `loop.js` scans crops within 16 blocks with how ripe they are (`nearbyCrops`), and whether a crafting table is in reach (`tableNear`).
- *Forage* picks up food lying about, harvests ripe crops, hunts; and when fed but carrying under 4 bites, it takes food in reach by day with no hostile near.
- *A new wire:* food in reach while carrying little inhibits Make (a plan pauses) and quiets Gather.
- *Make* bakes bread from 3 wheat: it uses a crafting table in reach, sets down a carried one, or makes one.
- Ticks now log `crops` in view and `foodCarried`.
- Not done: replanting. Harvested crops don't come back unless replanted, so food will still run out over many days.
- `npm run sim`: 283 checks (10 new).

**Stage 3 built (2026-11-17).** `npm run days` (`agent/src/tools/days.js`) cuts the whole tick log into Minecraft days (at dawn, or where the bot was off for 10+ minutes) and measures each: distance, area, deaths, ticks hurt, average food, starving ticks, ate, hunted, harvested, broke, made, share of the night enclosed, and the share of ticks each layer was in control. Writes `logs/days.json` and `docs/results-days.md` (a table and sparkline trends). First run: 38 days of MindBot's life (30 full), the first 35 in the region design. `npm run sim`: 284 checks.

## What changed since the first draft

| First draft | Now | Why |
|---|---|---|
| Every layer a Laya head over one shared 0.8B reader | **Tapered:** plain classifiers at the bottom, 3B models in the middle, a 4B model at the top | Your idea. Brooks's layers grow in sophistication up the stack, and only the upper layers need to reason. |
| Laya as the fast learner | **No Laya.** A plain logistic regression did as well (33% vs 28%), 200× faster | The gain came from fitting on MindBot's own life, not from Laya (`results-cortex-eval-2026-11-17.md`). |
| Every layer learns every Minecraft night | **Two learning speeds:** bottom layers every Minecraft night, upper layers once a real night | Retraining a 3B or 4B model takes too long to do every 20 minutes. |
| Layers see the whole prompt the cortex sees now | **Weighted memory:** every vault note gets a `weight`; each layer reads only its own top few notes | Small models need short prompts. Lets the vault learn alongside the layers. |
| Notes kept forever | **Forgetting:** episodes fade, sleep turns them into gist notes, faded notes are archived (never deleted) | A mind that keeps everything gets crowded and misled by flukes. |
| Hand-written note relevance | **FreeLAB-style retrieval:** embed notes once, rank by similarity × weight × recency | Upper layers can draw on 100 days of memory in about 1k tokens. |
| "Opus can't edit weights directly" | **Two routes compared:** Opus *edits* the bottom layers' weights directly vs Opus writes examples and the layer *retrains* | The MIT CSAIL weight-space programming report (below). The bottom layers are small and readable enough to try it. |

## The idea

Brooks's robots (MIT, late 1980s–90s) had no central planner. Each **layer** is a whole behaviour that is always running and always trying to steer the body. A higher layer **suppresses** the ones below when it has something to say, and goes quiet otherwise. The robot works with only the bottom layer; each new layer adds to it without rewriting what's below.

Brooks's layers were hand-written and never learned. Here:

- each layer is a **small learned model**, larger the higher it sits;
- the only learning happens **in sleep**: Opus reviews the day, works out which layer was responsible for what went well and badly, and that layer is changed;
- the next day it behaves differently, and we **measure the difference**.

**Claude is off during the day.** The bot runs on its layers alone, so dreaming is the single way it learns: a cleaner experiment. The old design stays in the code behind a setting (`MIND=regions` vs `MIND=layers`), so the two can be compared.

## The stack

Every tick (1.5 s, about 800 per Minecraft day) each layer looks at the situation and either says nothing or says "I want this act, this sure". The highest layer that speaks wins. A layer that answers less often than every tick keeps its last word until it answers again.

| # | Layer | Speaks when… | Acts | Model | Answers | Learns |
|---|---|---|---|---|---|---|
| 5 | **Make** | carrying enough of something to use | craft, equip, place, run a plan | **4B** language model (e.g. Gemma 3 4B or Qwen3 4B) | every ~5 ticks | once a real night |
| 4 | **Shelter** | evening or night | dig/place around itself, use a bed or door | **3B** language model (e.g. Llama 3.2 3B) | every 2–3 ticks | once a real night |
| 3 | **Gather** | daytime, things worth breaking near | dig, pickup, equip | **3B** (shares the model with Shelter, its own adapter) | every 2–3 ticks | once a real night |
| 2 | **Forage** | hungry, food or animals in view | seekFood, approach, swingAt, pickup, eat | **plain classifier** | every tick | every Minecraft night |
| 1 | **Wander** | nothing else is speaking | explore, move, jump, idle | **plain classifier** | every tick | every Minecraft night |
| 0 | **Survive** | hostile close, low health, lava or drop, border | flee, avoid, returnInside, eat | **hand-written** (today's brainstem) | every tick | never: the floor that keeps it alive while the others learn |

Survive sits at the bottom *and* overrides everything, as collision avoidance did in Brooks's robots.

**Each layer learns two things: whether to speak, and what to do.**
- For the plain classifiers, "whether to speak" is their confidence: they speak only when very sure. Today's classifier was right 63% of the time in its most-sure quarter.
- The language models answer "nothing" or an act plus how sure they are.

**The randomness stays** (the "salt" your professor asked about). Wander still fiddles with something 15% of the time when calm and curious, so the bot keeps trying things it has never done.

**Fits on the 3060:** about 3 GB for the 4B model plus 2 GB for the shared 3B model, with Gemma 12B no longer running. The plain classifiers are a few kilobytes each.

## Weighted memory

Every vault note gets a single `weight` from 0 to 1, shown as a property in Obsidian.

- **Concepts already have weights** from Part A (feelings, familiarity, link strengths). Experiences, Goals, Plans and Skills get one now.
- **It rises** when a note is used and things go well, and more for moments that mattered (damage, eating, a first meeting). **It fades** a little every sleep, like the links. Faded notes are archived, never deleted.
- **A quick index in memory:** weights are loaded once and kept up to date, so finding the top notes takes under a millisecond instead of reading 900 files every tick.
- **Each layer reads its own top few notes**, chosen the FreeLAB way (below). Forage gets food notes, Shelter gets walls and night, Make gets recipes and plans.
- **Later:** a small plain classifier can learn which notes actually came before good outcomes, replacing the hand-written score.

### Retrieval the FreeLAB way

[FreeLAB](https://github.com/Polarbear314/freelab) (the author's summer 2026 project) let a small local model answer from documents far longer than its context window. It did that not by making the model read more, but by sending it only the relevant chunks: a small embedding model (nomic-embed-text) ranks chunks against the question, and the model reads about 1k tokens instead of 70k. Plain qwen3:8b found 0 of 3 buried facts in 28k tokens; FreeLAB found 3 of 3.

MindBot's upper layers have the same problem. There are 900+ notes now and thousands after 100 days, and Ollama silently cuts off whatever doesn't fit. So:

- **Every note is embedded once and cached** (FreeLAB's main speed lever), and re-embedded only when it changes.
- **Each layer's question** is the situation plus its own job, e.g. "Shelter: dusk, 2 sides closed, zombie at 12 blocks".
- **Score = similarity × weight × recency**: relevant *and* important *and* not stale.
- **The layer reads its top few notes**, about 1k tokens. Embedding the question takes tens of milliseconds, fine for layers answering every 2–5 ticks.
- The bot is Node, so it calls Ollama's embedding API directly: FreeLAB's method, not its Python code.

FreeLAB also found a small model can't judge its own confidence; B1 found the same (Gemma "sure" 90% of the time, right 18%). So in the stack, confidence comes from the classifiers and the gate, never from a model's own say-so. FreeLAB's draft → judge → answer cascade is *not* used by day: a big layer judging a small one every tick would bring back a central planner. It is used at night, where Opus judges the layers' records.

### Forgetting: keeping the vault from crowding

A human mind doesn't keep everything. Most episodes fade within days (Ebbinghaus's forgetting curve); what survives is mostly the **gist**, turned during sleep from "what happened that night" into "what nights are like" (episodic → semantic consolidation, the same complementary-learning-systems idea as above). Too much detail would hurt the bot too: retrieval would surface near-duplicates and one-off flukes, crowding out what matters, and a single odd night could lead it astray.

So the vault gets a **live memory** the layers retrieve from, and an **archive** they don't:

1. **Experiences fade.** Their weight decays every sleep unless they are recalled or tied to something that mattered. Below a threshold they leave live memory.
2. **Gist at sleep.** Before fading Experiences are archived, Opus groups related ones and writes one **gist note**: "Nights near the edge of the world usually go badly: 9 of 11 times I was hurt." The gist links to the episodes it came from and starts with their combined weight. Twenty episodes become one belief.
3. **Archived, never deleted.** Faded notes move to `Archive/` with when and why. Retrieval skips it; Obsidian can filter it out of the graph. Nothing is lost, and an archived note returns to live memory if the bot meets a strongly matching situation (reconsolidation).
4. **A budget for live memory**, e.g. about 300 Experiences. If over budget at sleep, the weakest go first. Concepts for things never seen again fade the same way. Goals that are finished or abandoned are archived.
5. **Flukes are held back.** A gist built from one or two episodes is marked tentative and weighs less until more episodes agree.

**Measured:** live-memory size per day, gists written, notes archived and returned; and an ablation: a stretch of days with forgetting turned off. Does the bot do better or worse with everything remembered?

## Dreaming: how it learns

**Every Minecraft night** (the bot's own sleep, a few minutes):

1. **Replay:** the day's ticks, each with the situation, the act, what came of it, and which layer was in control.
2. **Opus diagnoses** each layer against the night's goal: what worked, what failed and why. Example: "Forage chased a cow toward lava; it shouldn't speak near lava." Opus doesn't read every tick: the FreeLAB retrieval step pulls out what matters for each layer ("every tick where Forage was in control and health dropped", plus the matching successes). This matters most at the deep dream, which covers many Minecraft days.
3. **The bottom layers change** (Forage, Wander), by route A or B below.
4. **Note weights are adjusted:** notes that led to good outcomes are raised, misleading ones lowered.
5. **The gate:** a change is kept only if the bot does better with it on held-out situations from earlier days, judged by the bot's own outcomes, never by Opus. Otherwise it is rolled back. Every version is kept.

**Once a real night** (deep dream, bot stopped, about 1–2 hours): Opus's diagnoses from all the day's Minecraft nights become training examples for the 3B and 4B layers. A small adapter is retrained for each (LoRA), and the same gate decides whether to keep it.

### Two routes for the bottom layers

The MIT CSAIL report (Takehi, Teoh, Zhang & Khattab, November 2026, reported in VentureBeat) says GPT-6 Astra read a small model's weights directly and wrote corrections into them, with no training. It raised Qwen3.5-0.8B's math score from 7.9% to 48.1% while changing 0.016% of its weights. *The paper is not out yet and the figures are self-reported; cite it as a reported result.*

The bottom layers are plain classifiers, and their weights are readable: each says how much something in the situation pushes toward an act ("lava nearby → approach: +0.4"). There are only a few thousand. So both routes are possible, on alternate nights:

- **A. Editing (weight-space programming):** Opus reads the weights and the day's failures and writes direct edits ("lava nearby → approach should be strongly negative"). No training step.
- **B. Training:** Opus writes corrections as examples; the layer retrains on them plus its own successes and a sample of older days.

Both pass the same gate. Compared across days:
- which route changes behaviour faster and more lastingly;
- whether Opus's edits make sense when a person reads them;
- whether direct edits break things that training wouldn't.

**The philosophy question it raises:** is a mind still learning *itself* when another mind writes its connections directly? Editing versus learning, the "gene editing for neural networks" contrast the report draws.

### Editing the upper layers too (stage 7b)

The 3B and 4B layers learn by retraining first. Editing them directly is unproven (the report doesn't say how Astra did it), but worth trying. Opus can't read billions of numbers, so it works **through tools**, never by reading raw weights. Three ways, most to least reliable:

1. **Steering ("turn up caution").** Opus names a quality a layer lacks. A tool runs the model on contrasting situations ("lava ahead" vs "grass ahead"), finds the direction inside the model that separates them, and adds it into the weights permanently. Opus chooses what to steer and how hard. Well established; runs easily on the 3060.
2. **Targeted belief edits ("lava is not safe to walk toward").** Opus names the belief behind a failure; a known editing method (ROME/MEMIT) finds where the model stores it and computes a small change to one layer's weights. No ordinary training. Built for facts; whether it works for behaviour is part of what we'd learn.
3. **Free-form editing, closest to the MIT report.** Opus gets probes (which parts light up for lava, hunger, night), forms its own theory of what's wrong, writes edits, tests and revises them. The most interesting and the most likely to fail: 0.016% of a 3B model is still about half a million numbers.

The same gate protects the bot. Each upper layer then has three kinds of nights: retraining, steering/belief edits, and free-form edits.

**Expectations:** steering will probably work, belief edits might, free-form might not at all. Each outcome is a finding about how far the idea reaches. And it sharpens the philosophy question: steering adjusts the bot's temperament; free-form editing rewrites its mind.

## Measuring: patterns across days

What changes between day 1 and day 100, and why? Logged per Minecraft day (`npm run days`, new; mostly from `logs/ticks-*.jsonl`):

- **Distance travelled** and area covered;
- deaths, damage taken, hunger at dusk;
- blocks broken, items picked up, crafts made, advancements earned;
- nights survived, time spent sheltered;
- **share of ticks each layer is in control**, how often each speaks;
- for route A vs B nights: how much each layer's behaviour changed the next day.

For any change seen, look for the mechanism: which layer's change came before it. **Ablation:** roll that layer back for a day and see whether the change goes away.

**Pace of days:** a Minecraft day is 20 minutes and can't usefully be sped up (the world would race ahead of the body). That gives about 3 Minecraft days an hour, roughly 70 a day. The bottom layers get ~70 learning steps a real day; the upper layers get one. That difference is itself something to measure: does fast habit or slow skill drive the curves?

## Build order (each stage usable alone)

1. **Behaviour stack, hand-written.** Rewrite the arbiter as layers 0–5, using today's reflexes and instinct as each layer's first version. Log which layer is in control. Claude off by day. `npm run sim` green.
2. **Weighted memory.** `weight` on every note, the in-memory index, FreeLAB-style retrieval of each layer's top notes, and forgetting (fading, gist notes, the archive, the live-memory budget).
3. **Day metrics.** `npm run days`. Run a few days for the baseline curve.
4. **Learned bottom layers.** Fit Forage and Wander classifiers from the existing logs. Each serves only once it beats its hand-written version on held-out situations.
5. **Nightly learning for the bottom layers.** Opus diagnosis, note weights, the gate.
   - **5b.** Route A (Opus edits weights) vs route B (retrain), alternating nights.
6. **Language-model layers.** Shelter and Gather on a 3B model, Make on a 4B model, prompted with their top notes, at first untrained.
7. **Deep-dream training** for the upper layers (needs Unsloth/PEFT installed, your OK first).
   - **7b.** Editing the upper layers: steering, then belief edits, then free-form (see *Editing the upper layers too*).
8. *(Later)* reshuffling the order of the layers; bigger models on top if more hardware turns up.

**If time runs short:**
- **Stages 1–3:** a hand-written subsumption bot with day-by-day measures.
- **Through 5:** learning bottom layers with measured change across days. This is the core result.
- **5b:** adds the editing-vs-training comparison.
- **6–7:** complete the taper.

## What happens to the existing work

Nothing is deleted. The vault, dreams, plasticity, advancements, plans and skills all carry over. Plans become something the Make layer can run. Claude's daytime cortex and the inner voice stay behind `MIND=regions`.

## Choices still open

- **Opus's nightly goal:** "live a good life", or narrower: "stay alive, fed, and able to do more"?
- **The layers and their order:** a starting guess.
- **Anthropic's terms:** the layers train on Opus's corrections (route B) or are edited by Opus (route A). Check what your plan allows before stage 5 (see `design-plasticity-and-a-learning-cortex.md`).
