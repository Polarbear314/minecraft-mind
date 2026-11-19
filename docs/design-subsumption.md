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

**The narrator (2026-11-17).** With the stack deciding, the stream of thought had gone quiet: the layers act but don't put anything into words. `agent/src/brain/narrator.js` gives it back without giving Claude the body. About every 20 s, Claude (the cortex model, Sonnet) is shown the situation and the body's last few acts and says in the first person what it's doing and why. It is **not told which layer acted**: like Gazzaniga's interpreter in split-brain patients, it explains actions it didn't cause. Each thought rides on one tick (the log line, `State/Current State.md`, the brain view's thoughts), and every narration is logged with the layer that really acted (`logs/narration-*.jsonl`), so how often its story matches the real cause can be measured. Actions are never changed by it; if Claude can't answer, the body carries on. `npm run sim`: 288 checks.

**Stage 4 built (2026-11-17): learned Forage and Wander.**
- *What a layer sees* (`agent/src/learn/features.js`): 19 named numbers per tick (health, food, drives, day/evening, shelter, nearest hostile, nearest animal, ripe crops, food on the ground, food carried, a person, the edge), computed the same way from a logged tick and from a live observation.
- *The model* (`learn/softmax.js`): a readable classifier, one weight per feature per act, saved as a table ("animalClose → hunt: +2.1"). A table edited by hand, or by Opus in stage 5b, works with no training.
- *The labels* (`learn/examples.js`): an act is judged by the following minute (food gained → do it here; hurt or refused → stay quiet here), and Forage gets **the delayed lesson**: silent with food in reach, then hungry within ten minutes → "take that food".
- *The gate* (`npm run train-layers`, `tools/trainLayers.js`): fits on all but the latest day, tests on that day, and serves a layer only if its balanced accuracy beats the hand-written layer's (scored by what it really did) by 0.03. Every version is kept in `logs/layers/`; results go to `docs/results-layers.md`.
- *In the stack* (`brain/layers.js`): `LEARNED_LAYERS=off | shadow | on` (default shadow). Shadow logs each tick what the learned layer would do next to what the hand-written one did (`action.shadow` in the tick log). On lets a layer that passed its gate act; if its top pick can't be done here it takes the next; it keeps a little salt (samples 10% of the time).
- *First fit:* Forage v2 learned its own examples well (75–100% per act) but did not pass: the held-out day was the first after the food fixes, where the hand-written Forage made no mistakes the labels can see, and crops and picking up food barely appear in earlier days. Wander had too few examples. **It needs several more days of the fixed bot.** Running in shadow meanwhile.
- `npm run sim`: 298 checks (10 new). Training is by hand for now; doing it every night is stage 5.

**Stage 5 built (2026-11-17): nightly learning.** `agent/src/learn/nightly.js`, run at every sleep in `MIND=layers` (after link consolidation and forgetting, before the dream; `reflection/dream.js`):
1. *Replay:* the ticks since the last review (`logs/layers/last-review.json` survives restarts).
2. *Opus reviews each learned layer:* shown its current weights and the moments that matter for it, chosen the FreeLAB way (its acts that went badly, food it walked past before going hungry with no hostile near, hungry stretches, a few that went well; at most 24), it writes a diagnosis and corrections ("at #3 Forage should have hunted"). It is told its corrections become training data and that it doesn't decide what's kept.
3. *Train:* each layer is refitted on its own outcomes plus every correction so far (counted double), never corrections from the held-out day.
4. *Gate:* as in stage 4, by the bot's own outcomes.
- Corrections: `logs/layers/corrections-*.jsonl`; reviews: `logs/layers/reviews-*.jsonl` and the vault's `Lab/Night Reviews.md`. The `[sleep] learning:` log line and the brain view's hippocampus report each night.
- *First real review* (Opus, 32 s, about 4,000 ticks): 3 Forage and 8 Wander corrections. Its diagnosis caught a real gap in the hand-written layers: **with health at 2–4 and carrots in its pack, the bot doesn't eat to heal**, because eating waits for hunger, while health only comes back with the food bar high. Retrained with the corrections, neither layer passes the gate yet (Forage 0.63 vs 1.0, Wander 0.49 vs 0.67): too few good days so far.
- Not yet: Opus adjusting note weights (stage 2's memory), and route A (editing weights directly, stage 5b).

**Lab notes (2026-11-17).** `npm run days`, `npm run train-layers` and the nightly reviews also write to the vault's `Lab/` folder (`Days`, `Learned Layers`, `Night Reviews`), for reading in Obsidian. MindBot never reads `Lab/` (`agent/src/vault/labNotes.js`).

**Bread (2026-11-17).** Carrying 3+ wheat, Make now works toward bread (planks, a crafting table, setting it down, baking) before its running plan, which pauses meanwhile. It still needs wood for the table.

**Stage 5b built (2026-11-17): Opus edits weights directly (route A).** `agent/src/learn/edit.js`, alternating nightly with route B (corrections + retraining; `logs/layers/last-review.json` counts nights).
1. *Propose:* Opus reads a learned layer's **full** weight table (about 120 named numbers) and today's moments, and proposes up to 6 edits, each one number with a reason and the moments behind it.
2. *Check, the FreeLAB way:* for each edit, every past tick where the layer would now choose differently is found by arithmetic; the most recent 300 are ranked by similarity to the moments behind the edit (`nomic-embed-text` embeddings, cached in `logs/layers/moment-embeddings.json`) × recency; Opus reads the top 8 with how each turned out.
3. *Revise:* Opus keeps, adjusts or withdraws each edit.
4. *Gate:* as for a retrained layer. Logged to `logs/layers/edits-*.jsonl` and `Lab/Night Reviews.md`.
- *First real editing night:* Opus proposed 6 Forage edits and **withdrew** the one that would have changed 282 past moments; proposed 4 Wander edits and **softened** one ("carrying food → fiddle" from −2.2 to −1.5) after seeing it would change 1,022, because "the body nearly always carries some food". Neither edited layer passed the gate yet (Forage 0.50 vs 0.79).
- *Embeddings:* `nomic-embed-text` pulled (274 MB) and `EMBED_MODEL=nomic-embed-text` set in `agent/.env`; `vault/memory.js` retrieval now uses embeddings ("hostile at nightfall and I am out in the open" finds *Died In The Night Under Cover* without shared words). Familiarity alone now gives a Concept at most 0.6 weight, so Pig and Cow no longer outrank fitting memories.
- `npm run sim`: 314 checks.

**Stage 6 built (2026-11-17): Make, Shelter and Gather as language models, in shadow.**

| Layer | Model (4-bit, on the 3060) | Asked every |
|---|---|---|
| Make | Qwen3-4B-Instruct-2507 (~4B, Apache 2.0) | 5 ticks |
| Shelter | Qwen2.5-3B-Instruct (~3B, Qwen research licence) | 2 ticks |
| Gather | Qwen3-1.7B (~2B, Apache 2.0) | 1 tick |

One family, so size is the main difference between the layers (the taper: 4B → 3B → 2B → classifiers → hand-written floor). Gemma and Llama were out: they need a Hugging Face sign-in and licence.
- *The service* (`agent/src/cortex/layer_service.py`, `npm run cortex` or `windows/start-cortex.bat`): all three models in one process with Hugging Face transformers (not Ollama), so their insides are reachable for 7b (`/activations`). A layer doesn't write an answer: its acts are listed as A, B, C…, and one forward pass gives the probability of each letter. That is reliable even at 1.7B, and the probabilities are the layer's "how sure".
- *The layers* (`agent/src/brain/modelLayers.js`): each due layer builds its menu from what the body could do right now (Shelter: dig below, roof over, wall an open side, the bed, stay; Gather: pick up, break wood, break a block to carry; Make: go on with the plan, bread, set the table down, planks, a table), always with "nothing: not for me right now". Its question is the situation in words, its job, and its **top 3 memories from embedding retrieval** (FreeLAB's role by day). The body never waits: answers arrive asynchronously and a layer's last answer stands for 15 s.
- *Modes* (`UPPER_LAYERS` in `agent/.env`): `off`, `shadow` (default: each pick is logged next to the hand-written layer's in `action.shadow`), `on` (the pick acts, unless it chose "nothing" or is under 35% sure; Brooks's wires still inhibit Make). With the service down, the hand-written layers simply carry on.
- *First live test* (the three models loaded: **6.5 GB** of GPU memory; **90–190 ms** per answer after a 1 s warm-up). Untrained:
  - Make baked bread when carrying wheat by a table (100%).
  - Shelter stayed put when sealed in at night (98%) and dug in at dusk (44%, "stay" 39%).
  - Two flaws, fixed: (1) Shelter chose "stay closed in" at sunny midday (97%), so "stay" is now on its menu only in the evening or when enclosed; it then answers "not for me" at midday (99%). (2) **Position bias**: the 1.7B Gather said "nothing" 100% whenever that was the last option, and picked up the carrot 99–100% when it wasn't. Each question is now asked twice, the options shuffled each time, and the probabilities averaged.
  - Still open: retrieval returns much the same three high-weight skills for every situation; the layers' memories need more relevance and less weight.
- Kept in shadow until the baseline days are in. Retraining them (stage 7) needs Unsloth/PEFT and the Anthropic-terms check; editing them (7b) is designed above.
- `npm run sim`: 321 checks (7 new).

**Stage 7b sandbox trial (2026-11-17, `docs/results-7b-trial.md`).** On a separate copy of Gather's 1.7B model, Opus picked a steering edit from the model's indexed insides (layer 18, a keyed rank-1 change), softened it, then **withdrew** it: no real gain, and more gathering with a zombie close. The model represents "worth gathering" inside, but that barely drives its answer. Telling it what lies in reach did what the edit couldn't (12 → 21 of 40 right, no weight change), but it still gathered at night and near hostiles, even with the danger spelled out. So, Brooks-style, the "when" is now wired and the model chooses only "what" (`brain/modelLayers.js`): **Gather's model is asked only by day with no hostile within 10 blocks** (otherwise its answer is "nothing", logged `gated`), and its situation now says what lies on the ground in reach. Takes effect at the next restart of the agent. `npm run sim`: 3 new checks.

**Learning from its own outcomes, stage 1: the nightly weight write (2026-11-18).** The goal: the model layers learn only from what happens to the creature, nothing fed in, written into their weights while it sleeps. Stage 1 builds the loop with Gather still in shadow, so nothing about the body changes yet:
- *By day:*
  - every question a model layer is asked is logged as asked (`logs/questions-<date>.jsonl`), with the patch version that answered;
  - Laya's triage (`cortex/triage.py`, on the CPU) scores moments for "is there a lesson here" into `logs/triage-<date>.jsonl`. `triage.py --fit` refits it on outcome-labelled moments.
- *Labels* (`learn/gatherLabels.js`): Gather's questions, labelled by what happened next. Gathering that filled the pack unharmed is the act. Gathering followed by harm, failure or death is "nothing". Doing something else with nothing bad following is "nothing" (sampled 1 in 5, as in stage 4).
- *Write and gate* (`cortex/nightly_write.py`):
  - the teacher's targets come from those labels only;
  - the closed-form solve writes them into the second-to-last layer (the method of `results-7b-trial.md`, part 3);
  - the strength is chosen on the earlier days' last quarter;
  - the edit is kept only if it beats the unedited layer on the latest (held-out) day by 0.03 balanced accuracy.

  Every version is saved in `logs/layers/patches/`, and `<layer>-current.json` names the one that passed.
- *Serving:* the model service applies the current patch at start and on `POST /reload` (`cortex/layer_service.py`). At dawn, `learn/nightlyWrite.js` runs labels → write → gate → reload in the background. It's on with `NIGHTLY_WRITE=gather` in `agent/.env`, off by default.
- *First run, on logged days* (learn from Nov 17, test on Nov 18): the gate **refused** the edit (balanced accuracy 0.548 → 0.530). The outcome labels hold little signal yet. In two days only 12 gatherings went badly, because the hand-written layers protect the creature from the situations that would teach it. This is the limit seen in the 7b trial ("a protected learner can't discover the dangers it's protected from"), and stage 2 addresses it.
- *Stage 2 (built 2026-11-18, switched on by the settings below):* Gather's own choices cause outcomes, including bad ones, so the nightly write has something of its own to learn from.
  - **One layer acts:** `GATHER_MODE=on` (also `SHELTER_MODE`, `MAKE_MODE`; each over `UPPER_LAYERS`). Gather's model moves the body while Make and Shelter shadow, so a change in behaviour is clearly Gather's.
  - **No fed-in rule:** `GATHER_RULE=off` drops the day/no-hostile rule, so Gather decides for itself when it's safe, and learns it. Survive stays the instinct floor (flee, avoid lava and drops).
  - **Exploration:** `EXPLORE=0.1`. An acting layer takes its second choice 10% of the time (decided once per answer, logged `explored`), so it meets outcomes it would never choose.
  - **The learning curve:** `npm run days` adds Gather's own record per day (acted, explored, gatherings that went well or badly, mistake rate, the patch version live), with the mistake rate as a sparkline across days.
  - **Faster lessons (2026-11-18):**
    - *When it runs:* a write runs every 3 Minecraft days (`WRITE_EVERY`), not once a calendar day. It learns from every Minecraft day up to its last run and is gated on the days since (the days the last patch was live; `logs/layers/write/gather-state.json`). That gives about 20 lessons a real day instead of 1.
    - *How it runs:* in its own detached process (an agent restart had killed it twice), applying its own patch if it passes.
    - *The bar:* a new edit must beat **the layer as it is live now** (the current patch), not just the model as downloaded.
    - *Speed:* about 10 minutes beside the live models, down from 16 (fewer steps, fewer settings tried).
    - *Exploration:* raised to 20%.
    - *First results:* patch v1 passed (balanced accuracy 0.56 → 0.60, learned mostly from the days before Gather acted). A dry run of the per-Minecraft-day write, gated on days 64–66 (Gather acting), would pass 0.54 → 0.605.
  - **The dig-in instinct fixed first** (`decision/reflexes.js`). Live, Shelter's dig count was sometimes lost and the body dug straight down a dozen blocks, into stone and water (two deaths, 2026-11-18). Now, in a closed shaft with nothing overhead and no count, it seals overhead, and it digs at most two blocks more for material. Without the fix those deaths would have blurred Gather's curve.

**Eat to heal (2026-11-17, the gap Opus found).** Survive now eats when health is at 10 or below, the food bar is under 18 (where health starts coming back), and food is carried, whatever the hunger drive says. Live, right after the restart: three potatoes eaten in a row at low health.

`npm run sim`: 307 checks.

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

The MIT CSAIL report (Takehi, Teoh, Zhang & Khattab, November 2026, reported in VentureBeat) says GPT-6 Astra read a small model's weights directly and wrote corrections into them, with no training. It raised Qwen3.5-0.8B's math score from 7.9% to 48.1% while changing 0.016% of its weights. *The paper is not out yet and the figures are self-reported; cite it as a reported result.* **Update (2026-11-17):** the work is now public as "Sparks of Weight-Space Programming" (Nov 2, 2026), with the edited checkpoint on Hugging Face. An independent byte-level check of that checkpoint (Carlos Toledo) found the headline edit is **rank-1**: one direction removed ×6 from 64 columns of `mlp.down_proj` in layers 15 and 19 (a steering-style edit, its strength found by trial). It also found that the gain comes mostly from the model *finishing* instead of looping, and that the 7.9% baseline is mostly a sampling-settings effect (22–44% under Qwen's own settings). Follow-ups: WeightBench (arXiv 2611.18553), a backdoor study (2611.17395), and Claude Opus 5.5 editing Qwen3.5-0.8B for computational biology (2611.20566).

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

#### The model's insides as a document (FreeLAB applied to weight editing)

*Design, 2026-11-17; built when the 3B/4B layers exist (stage 6).* The small layers' weights fit in a prompt; a 3B model's don't, and they mean nothing read raw. FreeLAB's answer to a document too big to read is to index it once and send the reader only the chunks that answer the question. So: treat the model's insides as the document.

1. **Chunks = units of the model, described by what activates them.** Once per model version, run the layer over a few thousand of MindBot's own logged situations (the tick texts, `learn/nightly.js describe()`). For each candidate unit, a direction in one layer's activations (from a sparse autoencoder, or simpler: MLP neurons and the top principal directions of each layer), keep the situations that activate it most and write a one-line description: "fires on: lava ahead, a drop, the edge of the world". Opus or the local model can write the descriptions from the examples (automated interpretability).
2. **Index them once with nomic-embed-text**, cached per model version in `logs/layers/<layer>-units-v<N>.json`, the way FreeLAB embeds a document once at upload.
3. **Ask a question; retrieve the units.** Opus's night review names a lesson ("Shelter keeps placing blocks with nothing to lean on"). The question goes to the index; retrieval returns the 20 or so units that match, ranked by similarity × how strongly they drive the layer's choice of act (their effect on the act's output when nudged).
4. **Opus reads only those** (descriptions, top examples, effect on each act) and proposes edits, using the tools above: steer along a unit's direction (most reliable), a ROME/MEMIT edit at the layer that holds it, or a free-form change to that unit's weights.
5. **Check, the 5b way:** before anything is kept, retrieval finds past moments where the edited model would choose differently, Opus reads the most relevant, keeps, adjusts or withdraws.
6. **Gate:** served only if the bot does better with it on the held-out day; every version kept.

What this needs: the 3B/4B layers (stage 6) served through something that exposes activations (Hugging Face transformers on the 3060, not Ollama, which doesn't), a sparse autoencoder or PCA per layer (minutes to fit on a few thousand situations), and the existing pieces: `vault/memory.js` embeddings, `learn/edit.js` evidence and revise steps, `tools/trainLayers.js` gate.

Why it matters for the project: it turns "Opus can't read a 3-billion-parameter model" into "Opus reads the 20 units that matter for this lesson", which is a plausible account of how weight-space programming at the MIT scale could work, and it makes FreeLAB's retrieval the lens through which one mind edits another.

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
