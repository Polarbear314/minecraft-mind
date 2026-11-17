# Plasticity, and a cortex that learns while it sleeps

*Design for the steps after plans and skills (`design-plans-and-skills.md`). Two parts: (A) the vault's links change with use, the way connections in a brain do; (B) a local model whose weights change from the bot's own life, with Claude kept for hard cases. A is small and comes first; B is staged so each stage is useful on its own.*

## The problem

All of MindBot's learning lives in the vault, and even there it is coarse:

- A link between two things (`co_occurs_with`) is either there or not. Seen together once or a thousand times, it counts the same. Nothing ever fades.
- Every Concept learns at the same fixed rate (0.2), whether it was met once or a thousand times.
- What the cortex is reminded of is chosen by how strongly the bot *feels* about things, not by what is *connected* to what it is looking at.
- The models never change. Claude Sonnet decides, Opus dreams, Gemma runs the always-on regions, all with frozen weights. "Practice becoming automatic" (Dreyfus, via Haugeland) can only happen in notes, never in the thing that does the deciding.

## Part A: links that strengthen, fade, and steer recall

**A1. Weighted links (Hebb).** Each Concept keeps a strength for every co-occurring thing (`link_strength: {Zombie: 0.62, Dirt: 0.08}`). Each tick the two are perceived together, the strength rises toward 1 with diminishing returns (`w += 0.05 · (1 − w)`). Co-occurrence during something that matters (damage, eating, a first encounter) counts several times over: emotion strengthens memory (amygdala-modulated plasticity).
*`co_occurs_with` stays as the plain list Obsidian draws the graph from; the strengths sit beside it.*

**A2. Sleep consolidates and prunes.** At every dream, before the dream itself:
1. **Replay:** links between things named in the day's Experiences get a boost (the hippocampus replaying what mattered).
2. **Downscale:** every link weakens a little (`w *= 0.9`): Tononi & Cirelli's synaptic homeostasis.
3. **Prune:** links that fall below a threshold leave `co_occurs_with` and move to `faded_links` with when they faded. They are archived, never deleted, and can come back if the two meet again.

In Obsidian you will see the graph thin out where things were only seen together by chance, and thicken where they matter.

**A3. Familiar things change slowly.** A Concept's learning rate shrinks as it becomes familiar: `α = max(0.05, 0.5 / √count)`, so a first meeting moves its feelings a lot and the thousandth barely at all. *This changes habituation: a zombie met hundreds of times will stop getting less frightening as quickly. A choice worth checking.*

**A4. Association steers thought (spreading activation).** The cortex prompt gains "What this calls to mind": for the things in view, their two or three strongest links, with how the bot feels about those. A zombie in view brings to mind what has come with zombies. The dream sees the strongest links too. This is the part that makes the strengths matter: stronger connections change what it thinks about next.

**Measures:** links strengthened and pruned per night (logged); the graph in Obsidian over days; an **ablation test** (Dennett): remove the "calls to mind" section for a stretch and see whether decisions change.

**Sim checks:** strengthening with diminishing returns; emotional boost; replay → downscale → prune order; pruned links archived, not lost, and restored on a new meeting; learning rate falls with familiarity; the prompt shows the strongest neighbours of what is in view.

**Status (2026-11-17): Part A built.** Code: `agent/src/vault/conceptStore.js` (link strengths, salience, the learning rate that slows with familiarity) and `agent/src/vault/plasticity.js` (sleep consolidation, replay, recall). Wiring: `loop.js` (how much each moment matters), `reflection/dream.js` (sleep before every dream; "What goes together most in your memory"), `decision/llmDecide.js` ("What this calls to mind") and `index.js` (`[sleep]` log line). Every dream's log entry carries a `sleep` summary (links replayed, kept and faded). `npm run sim`: 236 checks (15 new).

*On the live vault:* existing links have no strength yet, so they start at a modest 0.1. With a dream at most daybreaks, about a dozen dreams is only a few hours of running. So within the first afternoon, links between things that aren't seen together again will fade. Expect a big first prune of chance pairings. If that's too fast, `DOWNSCALE` in `plasticity.js` is the knob.

## Part B: a local cortex that learns while it sleeps

### The architecture: complementary learning systems

McClelland, McNaughton & O'Reilly (1995): the brain has a **fast learner** (the hippocampus, recording each day's episodes) and a **slow learner** (the neocortex, changing its connections gradually, mostly during sleep while the day is replayed).

| Brain | MindBot |
|---|---|
| Hippocampus: fast, episodic | The vault and the logs (already there) |
| Neocortex: slow weight change | A small local model, fine-tuned at night |
| Sleep replay | Night: choose the day's experiences that worked, mix in older ones, train |
| Deliberate thought for new problems | Claude, called only when the local model is unsure or the situation is new |

Turing's 1950 paper proposes nearly this: build a "child machine" and educate it, rather than programming an adult mind. Claude is the teacher; the world grades the lessons.

### Who decides — is it *self*-improvement?

Three decisions make a change the bot's own (from the earlier conversation, adopted here):

1. **Where the learning signal comes from:** its own life. What worked: outcome-tracker successes, plan steps from passed runs, nights survived, food that went down. What hurt is not imitated.
2. **What's worth learning:** chosen by its own measures. Part A's link strengths and Experience strength rank what mattered.
3. **Whether to keep a change:** a gate (below) using the bot's own measures, never Claude's opinion.

Claude's role, matching your proposal of a cloud model that steers the weight change: at night Claude reviews the day and **proposes**. It suggests which episodes to train on and which to leave out (e.g. "this survived night was luck, not skill"), and can suggest how hard to train. It never trains, and never decides whether the update is kept. A tutor, not a surgeon: the change happens in the bot's own weights, from its own experience, judged by its own results.

### What runs where

- **Fast tier (new):** a small open model (planned: **Gemma 3 4B**, same family as the 12B already running, small enough to train on the 3060) served by Ollama as `mindbot-cortex:v<N>`. It makes the routine decisions every few seconds, giving an action and how sure it is. "How sure" is the agreement among a few quick samples, plus a novelty flag: something never met before, or a situation unlike anything it was trained on.
- **Claude** is consulted when the fast tier is unsure, the situation is novel, or on its usual ~30-second cadence for the first days (to keep it as a baseline). The arbiter's order doesn't change; the fast tier slots in where the inner voice's urges are now.
- **Gemma 12B** keeps the amygdala, inner voice and rumination.

### The nightly cycle ("sleep")

Run when the bot is stopped (the GPU can't hold the 12B model and a training run at once):

1. **Export** the day: ticks + decisions + plan runs → examples of *situation → action*, labelled with what came of it. The situation is a short version of what the cortex prompt shows.
2. **Select:** keep what worked, ranked by the bot's measures; add Claude's proposals; mix in a sample of older good days (against forgetting new things over old).
3. **Train** a LoRA adapter on the base model (QLoRA, Unsloth), a few minutes to an hour on the 3060.
4. **Gate:** score the candidate on held-out situations from earlier days (does it choose what worked there, and avoid what hurt?) and keep `npm run sim` green. If it doesn't beat the current version by a clear margin: roll back. Every version is kept; switching back is changing one tag.
5. **Ship:** convert to GGUF, `ollama create mindbot-cortex:v<N+1>`, log the change.

**Evidence of growth over weeks:** how often it still needs Claude (should fall), deaths per day, nights survived, plan passes, advancements earned. Dreyfus's novice-to-expert as a curve.

### Stages (each useful alone)

- **B1. Data and evaluation, no training.** Export the logs into examples; build the held-out evaluation. Measure how well the *untrained* 4B (and 12B) predict the actions that worked. This shows whether there is anything to learn before installing anything heavy.
  - *First result (2026-11-17, `results-cortex-eval-2026-11-17.md`):* untrained Gemma 3 4B and 12B agree with what worked 17–18% of the time. That's above random (4%) and far above "always explore" in hard moments (15–17% vs 3%), but barely above it overall (16%). The 12B is no better than the 4B. Both are worse than chance at steering clear of what went badly, and they are "sure" about 90% of the time while being right only 18% of the time, so their agreement is no use as a hand-off signal. They fixate on food (`seekFood`/`eat` about 60% of picks) and never choose to stay put when enclosed. Conclusion: untrained, neither is good enough to decide for the bot. There is a lot to learn, but the confidence signal has to come from elsewhere (a calibrated chooser such as Laya, or a learned value).
  - *Laya (same day, same test set):* untrained, Laya's encoder and vega engine are no better. Vega with a small head **fitted on one day** of MindBot's acts that went well (5 minutes on the 3060, reader frozen) picks what worked 28% of the time (27% in hard moments) at 0.1 s per pick. Its calibrated confidence orders its picks: right 40% of the time in its most-sure quarter, 10% in its least-sure. So it gives B2 a usable hand-off signal, which no Gemma configuration did. Fitted heads saved in `logs/training/laya-fit/`. It's the leading candidate for the fast tier. Note this makes the slow learner a **head over a frozen reader**, not a LoRA on Gemma: a smaller change to the plan, and far cheaper to retrain each night.
  - *Plain-classifier check (same day):* a logistic regression on the situation's words and numbers, fitted on the same day, picks what worked 33% of the time (25% in hard moments, 77% avoid) at 0.0005 s per pick; a lookup table gets 23%. So the gain is from fitting on its own life, not from Laya. Laya's edge is only in how evenly its confidence orders its picks.
- **B2. The fast tier, untrained.** Run the base 4B as the routine decider with hand-off to Claude. Measure the hand-off rate and survival against Claude-only.
- **B3. Nightly training and the gate.** Needs the software setup below.

## What it needs from you

- **Software (B3 only, your OK first):** Python 3.12, PyTorch with CUDA, Unsloth/PEFT/TRL, llama.cpp for converting to GGUF, and the Gemma 3 4B base model. Roughly 15–20 GB of downloads; the C: drive has 90 GB free.
- **A check on Claude's terms.** Training a model on Claude's outputs is restricted by Anthropic's terms. This design trains on *actions the world graded*, not on Claude's text, and Claude only proposes what to train on. Still, many of those actions were chosen by Claude, so check what your plan (or Bowdoin's agreement) allows before B3. If it's a problem, B3 can train only on actions from the bot's own plans, reflexes and inner voice, which is cleaner but has less data.
- **Data size:** about 1,200 Claude decisions and 23,000 ticks so far. Enough to start a small adapter; more days help.

## Choices worth a second look

- **A3** slows habituation for familiar things (biologically right, but it changes behaviour).
- **Claude's role at night:** proposer only (recommended), or allowed to set training settings too. Either way the gate, not Claude, keeps or rejects.
- **Model size:** 4B trains comfortably on the 3060; 12B would need the bot stopped and much longer runs.
- **For the QCCR:** if Claude picks the lessons and a gate of the bot's own measures accepts them, whose improvement is it? The design's answer is in "Who decides". Clark & Chalmers would add that the vault already counts as part of its mind.
