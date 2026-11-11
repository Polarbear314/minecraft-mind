# Minecraft Mind — Observational Learning

*How the agent learns by watching other beings — deciding for itself what's worth watching (OMNI's model of interestingness) and reading through motion to intent (MindForge's theory of mind), all in service of the one directive: **Live a good life.***

This doc describes a module that is **built and runnable today**: `src/observation/`, verified offline via `src/observation/demo.js`.

---

## 1. What "visual" means here

Mineflayer gives the agent no camera and no pixels. But it doesn't need them to *watch* — it needs to notice another being's **state changing over time** and the changes that being causes in the world. That is exactly what the client exposes:

- another entity's **position** and **held item**, tick over tick (`bot.entities[id].heldItem` / equipment metadata);
- **block changes** near them (`blockUpdate` — a crafting table that wasn't there now is);
- **arm swings** (`entitySwingArm`) and **item pickups** (`playerCollect`).

So "watching Henry make a crafting table" decomposes into: *he held planks → planks vanished → a crafting_table block appeared at his feet.* No vision model required. This is the "visual" channel, and the whole module is built on it. (A real pixel-vision pipeline is a separable future project; nothing here depends on it.)

---

## 2. The pipeline

Four stages, each a small module, mirroring how your tick loop already separates perception → decision → action → memory:

```
watchTracker     segments another being's world-state deltas into "episodes"
      │              (held X, then a Y appeared — an act with an outcome)
      ▼
interestingness  keeps only episodes worth learning        ← OMNI
      │              (novel AND useful, judged vs. what I already know)
      ▼
theoryOfMind     infers WHY, and how I might do it myself   ← MindForge
      │              (a belief about the other mind + an imitable method)
      ▼
observationStore writes it into the vault, in the existing ontology
                   (an Experience + an Insight-belief + a subgoal)
```

### Stage 1 — `watchTracker.js` (segmentation)

Stateful across ticks (it must remember what Henry held last tick to notice a *change*). It attributes nearby world-events to the nearest actor and closes an **episode** when an outcome appears in the world (a block placed, a block broken, an item dropped). It infers nothing about meaning — it just cuts the raw stream into candidate acts, the way your eye notices motion before you understand it. Output per episode: the actor, the sequence of held-item changes, the terminal outcome (`made` / `gathered`), and the guessed **materials** (things held that then vanished).

### Stage 2 — `interestingness.js` (OMNI)

OMNI's core insight: *not everything learnable is worth learning* — an agent that attends to every twitch drowns (the noisy-TV trap). OMNI uses a foundation model as a **model of interestingness** to keep only tasks that are learnable **and** interesting **given what's already been done**. Ported here as two layers:

- **Heuristic (offline, no LLM):** a 0–1 score from the vault alone — *novelty* (does anything I already know mention this outcome?), *capability-gap* (making > gathering, in empowerment terms), *curiosity* (the ontology already encodes how intriguing a thing is), *goal-relevance* (does it touch an open subgoal?). This is why the demo runs with no model.
- **The OMNI hook (`moiAsk`):** an optional LLM that makes the final call on borderline episodes, conditioned on a list of **what the agent already knows**. Injected exactly like your `dream.js` / `claudeCodeDecide.js` `ask`. In the demo, the stubbed MoI correctly *ignores* Henry idly breaking dirt while *accepting* a furnace.

Crucially, interestingness is judged against the agent's own knowledge, so it naturally **stops re-learning** what it already has — the demo's second crafting-table is recognised as old news.

### Stage 3 — `theoryOfMind.js` (MindForge)

MindForge's contribution: don't just record *what* another being did — infer *why*. A demonstration is only transferable if you read through the motion to the **intent**. This stage produces a **belief about the other mind** ("Henry knows how to make a crafting table out of wood") plus an **imitable guess at the method**, folding in anything the being *said* (via the existing `chatChannel`) — observation and communication together, which is MindForge's point. Deterministic readings cover the common early-game acts; `tomAsk` swaps in a real LLM for the inference, same shape out.

### Stage 4 — `observationStore.js` (writing to the vault)

One interesting, understood act writes up to three notes, all in your existing ontology so the graph view shows observed learning like everything else:

1. an **Experience** — the episodic memory of having watched;
2. an **Insight** — the belief about the other mind, `learned_from` that Experience (theory of mind, made legible);
3. a **self-authored subgoal** — the agent's own intention to learn the thing, `serves: [[Live A Good Life]]`.

---

## 3. The one principled rule: watching yields hypotheses, not skills

**Watching never writes a `Skill` note.** In this vault a Skill is *certified know-how*, earned by the agent's own repeated success (enforced in `dream.js`). What you learn by watching is a **hypothesis** — a belief about someone else, plus a goal to try it. The agent's own attempts (through the existing decision → strategy-outcome → dreaming loop) are what promote a hypothesis into a real Skill later.

This keeps "what I know" honest, and it closes the loop with the empowerment design: watching **seeds a goal**; pursuing that goal **raises empowerment**; succeeding **earns the Skill**. Watching is the cheap way to point the agent at the right goal — it collapses the enormous space of things it could try down to "the thing I just saw work."

---

## 4. How observed learning reaches behaviour (with almost no new wiring)

Because a watched act writes a **subgoal**, it already flows into the awake mind through machinery you built: `goalStore.subgoalLines()` feeds active subgoals into the decision prompt (your sim asserts this). So the moment the agent writes *"Learn To Make A Crafting Table,"* that intention starts showing up in what it deliberates about — no change to `llmDecide.js` required. The belief-Insight likewise surfaces through the existing Insight-reading paths.

The only genuinely new integration is a thin **adapter** in the tick loop that fills the observer's inputs from live Mineflayer events, then calls `observer.observe(world)` once per tick (non-blocking, like the dreamer):

```js
// in loop.js, once per tick, after perception:
observer.observe({
  now,
  others: observation.nearbyEntities            // {name,isPlayer,position,heldItem}
    .map(e => ({ ...e, heldItem: heldItemOf(bot, e) })),
  worldEvents: drainWorldEvents(),              // from blockUpdate / playerCollect listeners
  chatLines: chatChannel.promptLines(),
  locatedIn,
});
```

`drainWorldEvents()` is a small buffer fed by `bot.on('blockUpdate', …)` and `bot.on('playerCollect', …)` — the observational analogue of how `chatChannel` buffers speech.

---

## 5. Files

```
agent/src/observation/watchTracker.js     stage 1 — segment world-state deltas into episodes
agent/src/observation/interestingness.js  stage 2 — OMNI model of interestingness (moiAsk)
agent/src/observation/theoryOfMind.js     stage 3 — MindForge intent inference (tomAsk)
agent/src/observation/observe.js          orchestrator: createObserver({vaultPath, moiAsk, tomAsk})
agent/src/vault/observationStore.js       stage 4 — writes Experience + Insight + subgoal
agent/src/observation/demo.js             runnable offline demonstration (node src/observation/demo.js)
```

The demo copies the live vault to a temp dir and scripts Henry demonstrating a crafting table, a torch, and (via LLM stubs) a furnace, plus a boring dirt-gather that the OMNI layer rejects. It verifies: valid YAML, beliefs + subgoals written, the boring act ignored, **no Skill written**, subgoals serve the founding goal without shadowing it, and beliefs grounded in the watching Experience. All pass.

---

## 6. What to build next

1. **The loop adapter + event buffer** (§4) — wire `blockUpdate` / `playerCollect` / equipment reads into `observer.observe`. This is the step that makes it live against a real server.
2. **Turn on the LLM hooks** — point `moiAsk` and `tomAsk` at your existing `askClaudeCli`. The heuristic path stays as the offline/fallback.
3. **Attention, not just filtering** — right now the agent watches whatever is near; next, let interestingness *pull the body* (an `approach`/`observe` action) toward a being doing something interesting, so watching becomes a chosen act. This is where it connects to the empowerment drive: a capable being is the highest-empowerment thing in view.
4. **Close the loop to Skills** — when the agent later succeeds at a watched subgoal, have dreaming note that the hypothesis was confirmed (the belief about Henry gets a "and now I can too" and a real Skill is born).

## 7. Known refinements

- Observed subgoals/insights are currently stamped `given_by: MindBot (dreaming)` because they reuse `writeSubgoal`. Watching isn't dreaming; add a `given_by: 'MindBot (watching)'` option to `goalStore.writeSubgoal` / `dreamStore` so provenance is exact.
- Materials inference is a heuristic (held-then-vanished); it will sometimes over- or under-guess inputs. That's fine — the subgoal is explicitly a guess the agent's own attempts will correct.
