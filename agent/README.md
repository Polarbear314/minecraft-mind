# Minecraft Mind — Agent

An AI agent that plays Minecraft while its entire memory and personality live as plain markdown in an Obsidian vault (the `Agent Brain` vault in your Obsidian folder). Open the vault's graph view and you are literally looking at how the agent thinks and feels.

## How it thinks

Every 1.5 seconds the agent runs one tick: **perceive** the world → **update** its three drives (Hunger, Fear, Curiosity) → **decide** an action → **act** → then **journal** while the body is already moving: record what it noticed as Concept notes (with drive weights and a running emotional valence, updated by exponential moving average) and **persist** its drives and `State/Current State.md`. Acting before writing is deliberate — the bot never stands still to do bookkeeping. Notable events — first encounters, valence-band crossings, taking damage — also get a timestamped note in `Experiences/`. The full schema is documented in the vault itself: `Agent Brain - Vault Schema.md`.

The agent also learns which of its own **strategies** work (action-outcome learning): each tick's signals — damage, food gained, fear easing, discoveries — are attributed to the action-in-context currently in progress ("Exploring At Night"), and when that window closes (action change, day/night flip, or 6 ticks) the attempt is scored and written to a Strategy note under `Concepts/Abstract/Strategy/` with a success-rate EMA. Striking outcomes get an Experience note, and strategy stats are fed back into Claude's decision prompt so past results shape what it tries next.

The agent has **hands** (motor primitives, Phase B): `swingAt`, `dig`, `place`, `pickup`, and `approach` (walk toward a creature or person, optionally named — following someone is possible, not taught) expose the body's raw capabilities with no explanation of purpose — Claude's prompt describes what each act *does* ("swing your arm at the nearest creature"), never what it's *for*. The rules layer occasionally fiddles with them too when curious and calm (`experiment()` in decide.js). Whatever the fiddling produces — an item dug free, a drop picked up — appears in the inventory, is detected by a per-tick inventory diff, and becomes a Concept encounter plus a "Now Carrying ..." Experience; the strategy layer scores the act ("Digging By Day"), and dreaming can later distill repetition into Skills. Hunting is meant to be *invented*, not taught. (`craft` is implemented in actions.js but deliberately not exposed in any decision vocabulary — deferred until the raw primitives prove out.)

The agent can hold an **intention** (Phase C): Claude's reply may include an optional `"intention"` — a short standing undertaking in its own words ("stay near the water until I find the fish again"). It's persisted to `State/Current Intention.md` and shown back in every consultation until Claude replaces it or abandons it (empty string; omitting the field keeps it). This is what makes multi-step projects possible: without it, even with hands, only one-swing behaviors can exist.

The agent has **ears and a voice**: words spoken in the world's chat (or whispered to it) flow into the mind as perception. Each message becomes an encounter with the speaker — a `Concepts/Entity/Person/<Name>.md` note, since nearby players are perceived by name — plus an Experience carrying exactly what was said, and the last few messages are shown in every Claude consultation ("Words spoken in the world's chat"). Words are counsel, never commands: the prompt tells the agent they're another mind's advice, to be weighed against its own experience. Claude's reply may include an optional `"say"` field — one short sentence spoken aloud via in-game chat for anyone present. Rules stay deaf and mute; only the Claude layers hear and speak.

The agent also **dreams**: in claude-code mode, surviving a night (day-break) — and optionally every `DREAM_INTERVAL_MS` — starts a background reflection pass where Claude, as the agent in first person, reads only its own vault (recent Experiences, Strategies, Goals, strongest-valence Concepts — no game knowledge) and writes up to 3 new notes: **Insights** (beliefs, `Concepts/Abstract/Insight/`, cyan in the graph), self-authored **subgoals** (`Goals/`, with `serves` links to the founding goal), and **Skills** (know-how distilled from repeated successful experience, `Concepts/Abstract/Skill/`, pink, with `learned_from` links to the Experiences that earned them). Skills and subgoals feed back into the decision prompt. Dreams never block ticks, never delete or overwrite notes, and fail silently.

Three decision layers exist, set via `DECISION_MODE` in `.env`. `rules` (default) is the simple built-in priority ladder. `llm` asks Claude via the Anthropic API each tick (needs `ANTHROPIC_API_KEY` from console.anthropic.com). `claude-code` asks Claude through the Claude Code CLI instead — it uses your normal Claude account login, no API key: `npm install -g @anthropic-ai/claude-code`, run `claude` once to sign in, done. In both Claude modes the model reads the agent's own vault — founding goal, drives, learned feelings about the mobs around it — and returns an action plus a first-person thought written into `Current State.md`. The CLI is slow (seconds per call) and shares your account's usage limits, so claude-code mode consults Claude at most every `LLM_MIN_INTERVAL_MS` (default 10s) and runs on rules in between. Consultations are **non-blocking**: the CLI call runs in the background while instinct rules keep the body moving, and Claude's answer is applied on the next tick after it arrives (discarded if stale). Once applied, Claude's chosen action **holds** for ~6s (re-validated each tick) so instinct can't stomp it 1.5s later — except flee/avoid, which are survival reflexes and always break through. `explore`/`seekFood` commit to one wander destination and actually walk there before choosing another. Every failure path falls back to rules; the agent never freezes.

## Setup

1. **Install** (Node 18+):

   ```
   cd agent
   npm install
   ```

2. **Get a Java Edition world reachable.** Mineflayer only supports Java Edition, not Bedrock. Easiest: open a single-player world, press Esc → *Open to LAN* → note the port it prints. Or run a dedicated server jar (`java -jar server.jar`), default port 25565. On LAN worlds set the game mode to allow a second player; the bot joins like any player.

3. **Configure**: copy `.env.example` to `.env`, set `VAULT_PATH` to an empty folder (open it in Obsidian to watch the brain grow), and adjust `MC_HOST`/`MC_PORT` to match your world (`.env.example` documents every variable).

4. **Run the simulation first** — no server needed, verifies the whole pipeline against a mock world and prints the generated notes:

   ```
   npm run sim
   ```

5. **Connect for real:**

   ```
   npm start
   ```

## Layout

```
src/config.js          env loading + validation
src/vault/             everything that reads/writes the Obsidian vault
  ontologyMap.js       Minecraft name -> class path + drive priors (extend here)
  frontmatter.js       YAML frontmatter parse/serialize + [[link]] helper
  paths.js             filename/title conventions
  conceptStore.js      Concept notes + EMA valence updates
  strategyStore.js     Strategy notes + success-rate EMA (action-outcome learning)
  experienceLog.js     episodic Event notes, chained via follows
  goalStore.js         founding goal + self-authored subgoals (serves links)
  intentionStore.js    State/Current Intention.md — the standing undertaking
  dreamStore.js        Insight/Skill notes written by dreaming (append-only)
  driveStore.js        Drive note live fields
  stateStore.js        Current State.md (overwritten every tick)
src/drives/drives.js   Hunger/Fear/Curiosity levels, 0-100
src/perception/        bot state -> plain observation (pure, mockable)
  chatChannel.js       in-game chat buffer: heard words -> perception + prompt
src/decision/          decide() layers (rules/llm/claude-code) + outcomeTracker.js (credit assignment)
src/reflection/        dream.js — background reflection pass (Insights/subgoals/Skills)
src/actions/           pathfinder-backed action execution
src/loop.js            the tick orchestrator
src/index.js           real entry point (npm start)
src/simulate.js        mock-bot harness (npm run sim)
```
