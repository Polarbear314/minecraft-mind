# Minecraft Mind — Brain Regions on a Budget

*Design doc, 2026-11-16. How the agent's mind is split into brain regions, which model (or plain code) runs each one, and how a free open-source model running on this PC keeps the mind dreaming while the Claude subscription's usage limit resets.*

---

## 0. The one idea

**Only think when something happens, and think with the smallest mind that can do the job.**

Today the agent is three layers: rules, a Sonnet cortex consulted on a 30-second timer, and Opus dreaming at every day-break. That works, but it is wasteful in two ways:

- **The cortex is asked whether or not anything happened.** The live log shows the same thought held across many ticks while the bot simply walked.
- **Dreams run on a clock, not on experience.** A Minecraft day is 20 real minutes, so "dream every day-break" can mean up to **72 Opus calls a day**, often over nothing new.

The design below turns most of the brain into free code, gates the expensive parts behind real events, and gives the mind a **second, free brain**: an open-source model on the RTX 3060 that takes over dreaming (and other background thinking) whenever Claude is unavailable — so the bot keeps learning while the subscription rests.

---

## 1. The region map

| Region | Job | Primary | When Claude is resting | Wakes on | Rough calls/day |
|---|---|---|---|---|---|
| **Brainstem** | Flee, avoid hazards, eat when starving, **stay inside the world border** | Code (`decide.js`) | — | Every tick | Free |
| **Hypothalamus** | Hunger / fear / curiosity balance | Code (`drives.js`) | — | Every tick | Free |
| **Cerebellum** | Movement, pathing | Mineflayer pathfinder | — | Every tick | Free |
| **Thalamus** | Decides what reaches the cortex | Code (event gate, §4) | — | Every tick | Free |
| **Amygdala** | "What is this thing to me?" — threat and feeling for a *new kind* of thing | Local model | Local model | First encounter with a kind of thing | A few dozen **ever** |
| **Prefrontal cortex** | Choose what to do, intentions, speech | Haiku (routine) / Sonnet (hard moments) | Rules (as today) | Thalamus events | ~200–400 |
| **Hippocampus** | Dreaming: experiences → insights, subgoals, skills | **Auto: Opus, else local model** | **Local model** | Day-break **and** enough new experiences | ~5–15 |
| **Social cortex** | Watching players: interestingness, intent | Haiku | Local model | A player does something worth watching | Rare |
| **Temporal lobe** | Long-term memory | The vault | — | — | Free |

Compared with today (≈2,900 Sonnet calls + up to 72 Opus calls a day), this is roughly **10–20× less Claude usage**, and the bot keeps learning even with zero Claude available.

---

## 2. Providers: one way to ask, three kinds of mind

Every model call in the agent already goes through the same shape: an `ask(prompt) -> Promise<text>` function (`askClaudeCli`, the dreamer's `ask`, the observer's `moiAsk` / `tomAsk`). The design keeps that shape and adds a small provider layer in `agent/src/brain/`:

- **`claude`** — the existing `claude -p --model <haiku|sonnet|opus>` path. Uses the subscription.
- **`local`** — an open-source model served by **Ollama** on this PC, called over HTTP at `http://127.0.0.1:11434`. Free, private, works offline.
- **`auto`** — Claude first; if Claude reports its usage limit, mark Claude as **resting** and send the request to `local` instead (§3).

Each region names its provider and model in one place, the **brain map** (§7), so swapping a region from Opus to a local model is a config change, not a code change.

### Why not an API key for the fast jobs?

The Claude API would make the amygdala fast and cheap (Haiku 5.5 is $0.10 / $0.50 per million tokens). It stays an *option*, not the plan: a local model is just as fast for these short jobs (no `claude -p` start-up cost), costs nothing, and needs no billing account. If local quality disappoints, the brain map can point the amygdala at the API later.

---

## 3. Resting: what happens when the subscription runs out

When `claude -p` hits the plan's usage limit it fails with a message about the limit (the exact wording must be captured and matched when this is built — **do not guess it**; record a real failure into the decision log first).

The `auto` provider then:

1. Marks Claude **resting** until the reset time in the message if one is given, otherwise retries every 30 minutes with one cheap probe.
2. Routes every `auto` region to its fallback: dreaming and the social cortex go to the **local model**; the cortex falls back to **rules** (exactly what happens on any failure today).
3. Logs the switch once (`[brain] Claude resting until 14:00 — dreaming locally`), not on every call.
4. When a probe succeeds, Claude is awake again and regions return to their primaries.

The body never waits on any of this: decisions are already non-blocking, and dreams already run in the background.

---

## 4. Thalamus: wake the cortex only for real events

A pure-code gate that runs every tick and decides whether this moment is worth a cortex consultation. It wakes the cortex when:

- something **new** comes into view (a kind of thing with no Concept note yet),
- the bot **took damage** or a hostile came close,
- **someone spoke** (chat or whisper),
- **day turned to night** or night to day,
- a drive **crossed a threshold** (hunger above 50, fear above 60…),
- the current **intention finished, failed, or went stale**,
- the **heartbeat** expired: nothing happened for N minutes (default 3), so check in anyway.

Between wakes, the held plan stands and instinct fills the gaps, as today. The decision log records **why** each consultation happened (`trigger: "new-thing:creeper"`), so later analysis can see which triggers produce decisions that differ from instinct — and tune the gate on evidence.

---

## 5. Amygdala: appraise once, remember forever

On the **first encounter with a kind of thing**, the amygdala asks the local model one short question with the Concept's few known facts (where it was met, what happened nearby): *Is this a threat, food, a tool, a person, or nothing? How does it feel?* It returns a small JSON appraisal, which is written into the Concept's frontmatter:

```yaml
appraisal: threat        # threat | food | useful | person | neutral
appraisal_feeling: -0.6  # first impression; experience (valence) takes over from here
appraised_by: local:qwen3-14b
```

After that it is a free vault lookup. The existing valence learning keeps updating how the thing *actually* feels from experience, so a wrong first impression gets corrected by living — exactly like a real amygdala.

There are only a few dozen kinds of things in a 128-block terrarium, so this is a handful of calls total.

---

## 6. Hippocampus: dreaming on an open-source model

### 6.1 Hardware and runtime

- **GPU:** RTX 3060 with **12 GB VRAM**. Comfortable for an **8–14 billion parameter instruction-tuned model at 4-bit quantization** (≈5–9 GB of VRAM), fully on the GPU.
- **Runtime:** **Ollama** for Windows (`winget install Ollama.Ollama`). It runs as a background service, loads the model on demand, unloads it after a few idle minutes (freeing VRAM for games), and supports **JSON-schema-constrained output**, which matters a lot for small models.
- **Disk:** models are 5–9 GB each. C: has ~130 GB free; models can live on D: by setting `OLLAMA_MODELS` if preferred.

### 6.2 Choosing the model

Pick **at install time**, by testing, not from a list in a doc. Start with two or three current open-weight instruct models in the 8–14B range from the Ollama library (good starting candidates as of writing: the Qwen3 and Gemma 3 families), then compare them on the same dream:

1. `npm run sim` must pass with the local provider plugged into the dreamer.
2. Run a **dream bake-off**: give each candidate the identical prompt built from the live vault (`buildDreamPrompt`), five times each, and check:
   - valid JSON every time (schema-constrained output should guarantee this),
   - `learned_from` titles that really exist (`applyDream` already filters bad ones — count how many it had to drop),
   - no numbers or statistics in the bodies,
   - no invented game knowledge ("diamonds are valuable") the vault never taught,
   - no repeats of insights the bot already holds.
3. Keep the best one. Run the same bake-off against an Opus dream as the quality bar.

### 6.3 Making a small model dream well

- **Schema-constrained JSON** (Ollama `format` with the dream schema): removes the most common small-model failure.
- **Trimmed prompt**: small models degrade on long context; cap recent experiences at 12–15 instead of 20.
- **Lower temperature** (≈0.4) for reflection, so it stays grounded in memories.
- **The existing guardrails stay**: at most 3 notes, never overwrite, `learned_from` must link to real experiences, skills must cite at least one.
- **Provenance**: every dreamed note gets `dreamed_by: local:<model>` or `dreamed_by: claude:opus` in its frontmatter. In Obsidian you can filter by it and literally compare what the free mind and Opus each learned — interesting in its own right.

### 6.4 When to dream

- **Trigger:** day-break **and** at least **10 new experiences** since the last dream (or the optional interval).
- **Provider:** `auto` by default (Opus when available, local when Claude is resting). Alternatives in the brain map:
  - `local` always — dreaming becomes completely free, and Opus usage drops to zero.
  - `local` normally, with an occasional **deep dream** on Opus (e.g. once a day) that reviews what the local model wrote and consolidates it. A natural fit for "the hippocampus replays, the cortex consolidates."

---

## 7. The brain map

One file, `agent/brain-map.json`, says which mind runs each region. Defaults shown:

```json
{
  "amygdala":     { "provider": "local",  "model": "<chosen local model>" },
  "cortex":       { "provider": "auto",   "routine": "haiku", "hard": "sonnet", "fallback": "rules" },
  "hippocampus":  { "provider": "auto",   "model": "opus", "fallback": "local", "minNewExperiences": 10 },
  "social":       { "provider": "auto",   "model": "haiku", "fallback": "local" },
  "thalamus":     { "heartbeatMinutes": 3 }
}
```

`LLM_MODEL` and `DREAM_MODEL` in `.env` keep working for backward compatibility (they fill in `cortex.hard` and `hippocampus.model` when the brain map doesn't say otherwise). On startup the agent prints the map, so the agent window shows which mind runs where.

---

## 8. Cortex tiers: Haiku for routine, Sonnet when it matters

When the thalamus wakes the cortex, the trigger decides the tier:

- **Sonnet:** someone spoke, danger, a brand-new kind of thing, an intention finished or failed (time to plan).
- **Haiku:** everything else — heartbeats, drive thresholds, day/night changes.

Both use the same prompt and the same `toAction` validation, so the body can't tell which tier answered. The decision log records the tier, so later you can check whether Haiku's routine choices differ from what Sonnet would have done.

---

## 9. Logging (for distillation later)

- **Decisions:** already built (`logs/decisions-YYYY-MM-DD.jsonl`). Add `trigger`, `tier`, and `provider` fields.
- **Dreams:** new `logs/dreams-YYYY-MM-DD.jsonl` — prompt, raw reply, provider/model, what `applyDream` kept and dropped.
- **Appraisals:** go in the vault (Concept frontmatter), so no separate log is needed.

Together these are the training data for the long-term plan: once a narrow job has thousands of examples, fine-tune a small local model on it and move that job off Claude for good.

---

## 10. Build order

Each step ships on its own, keeps `npm run sim` green, and adds sim checks with stubbed providers (no real model calls in the sim).

1. **World-border reflex** (brainstem). Small, fixes a real death: the bot reconnected 2 blocks outside the border and was killed by border damage on 2026-11-15.
2. **Provider layer + brain map** (`agent/src/brain/`), with Claude and local providers and the `auto` router. Capture the real usage-limit message first.
3. **Local model**: install Ollama, run the dream bake-off (§6.2), pick the model.
4. **Hippocampus**: dream trigger on new experiences, `auto` provider, provenance frontmatter, dream log.
5. **Thalamus** event gate, with `trigger` in the decision log.
6. **Cortex tiers** (Haiku / Sonnet).
7. **Amygdala** appraisals.
8. **Social cortex** on the brain map.

Steps 1–4 deliver what matters most now: a bot that stays alive in its terrarium and keeps learning for free while the subscription rests.

---

## 11. Open questions

1. **Dreaming default:** `auto` (Opus first, local when resting), `local` always (free), or local with a daily Opus deep dream?
2. **Where models live:** C: (default) or D: (`OLLAMA_MODELS`)? D: is a hard drive, so the model loads more slowly the first time after it unloads, but nothing else is affected.
3. **Gaming on the same PC:** the local model and a game share the GPU. Ollama unloads the model after a few idle minutes; is it acceptable for a dream to occasionally slow a game, or should local dreams pause while a game is running?
4. **Local cortex fallback:** when Claude is resting, should the cortex fall back to the local model instead of rules? Slower to build and riskier (a bad small-model decision moves the body), so this doc leaves it as rules for now.
