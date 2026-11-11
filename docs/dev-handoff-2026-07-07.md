# Minecraft Mind — Session Handoff (2026-07-07)

For the next Claude session: read this first, then `agent/README.md` and the vault's `Agent Brain - Vault Schema.md`. Everything below is built, tested, and running on Henry's Mac.

## What exists

Two connected folders matter: **this project folder** (agent code) and the **Agent Brain** Obsidian vault (`Obsidian - Claude/Agent Brain`) — the bot's live brain. Full spec of the original build is in `Minecraft Mind - One-Shot Build Prompt.md` here.

- `agent/` — Node.js Mineflayer bot. `npm start` connects to a LAN world; `npm run sim` runs a mock-world test harness that verifies the whole pipeline (always run this after edits — it validates YAML, paths, and behavior end-to-end).
- Tick loop (1.5s): perceive → scan blocks → record Concept encounters (EMA valence updates, habituation) → log notable Experiences → update drives → decide → act → persist Drives + Current State to vault.
- Three decision modes (`DECISION_MODE` in `agent/.env`): `rules`, `llm` (Anthropic API), and **`claude-code` (active)** — shells out to the Claude Code CLI (account login, no API key), throttled to one consultation per `LLM_MIN_INTERVAL_MS` (10s), rules fill the gaps, all failures fall back to rules.
- Claude's prompt (`src/decision/llmDecide.js` → `buildPrompt`) includes: founding goal, drive levels, learned feelings about nearby **entities and blocks** (valence, encounter count, prose), and the 5 most recent Experience titles. Claude returns `{action, thought}`; thoughts print in the console and are written into `State/Current State.md`.
- Action vocabulary: flee, **avoid** (move away from a dangerous block — added after the bot stood next to lava for 18 min), eat, seekFood, explore, idle. Rules also auto-avoid hazard blocks within 5 blocks.
- Founding goal: `Goals/Live A Good Life.md` in the vault ("live a good life", given by Henry) — linked as `pursuing` from Current State every tick.
- Viewer: `VIEWER_PORT=3007` serves the bot's first-person view at localhost:3007 (needs `canvas` dep, installed).
- Vault graph colors are configured in `.obsidian/graph.json`: valence green/red/gray, drives orange, locations purple, ontology blue, state white.

## Key decisions already made (don't relitigate)

- Valence: `-fear + hunger + 0.3*curiosity`, hunger contributes POSITIVELY (food becomes liked). EMA alpha 0.2. First impression = full ontology prior; safe encounters with hostiles drift fear toward 40% of prior (habituation). Bands: ±0.3.
- Only hostiles within 10 blocks raise the Fear drive; concept fear weights habituate independently.
- Experiences only for notable events (first encounter, band crossing, damage).
- Minecraft world must be **1.21.4** (mineflayer doesn't support the 26.x year-versions yet). LAN port changes every reopen — `python3 agent/setport.py <port>` updates `.env`.

## DONE (2026-07-07): action-outcome learning / credit assignment

Built and verified with `npm run sim`. Design decisions (agreed with Henry):

- Tracking lives in the tick loop (`src/decision/outcomeTracker.js`), so ALL decision modes learn — rules included — and the sim tests it without mocking the CLI. Context is day/night only.
- A window around an attempt closes when the action type changes, day/night flips, or 6 ticks elapse. Scoring is blunt: damage during the window = failure (0); otherwise food gained (+0.2), fear easing ≥10 (+0.2), and discoveries (+0.15 each, max 2) push up from neutral 0.5. Labels: ≥0.65 success, ≤0.35 failure.
- `src/vault/strategyStore.js` writes `Concepts/Abstract/Strategy/<Exploring At Night>.md` with `is_a: [[Strategy]]`, `success_rate` (EMA, alpha 0.2, first attempt sets it directly), `attempt_count`, `last_outcome`, and a recent-outcomes list in the body. Bands: `strategy/effective` ≥0.6 / `strategy/mixed` / `strategy/ineffective` ≤0.4 (gold in the graph via `type/strategy`).
- Striking outcomes (decisive first attempt or band crossing) get an Experience note; strategy records feed `buildPrompt` sorted by attempt count, capped at 8 — phrased qualitatively ("tried 14 times — it has usually gone badly"), NOT as percentages. Henry noticed percentages in the prompt made the bot's thoughts recite statistics and lose their philosophical voice; `describeRecord()` in strategyStore + a voice instruction in SYSTEM_PROMPT fix this. Keep numbers out of the prompt.
- Ontology gained `Abstract/Strategy.md`; schema doc + ontology README + agent README updated.

Possible follow-ups: richer contexts (location, dominant drive), letting rules consult strategy stats (currently prompt-only), decaying stale strategies.

## DONE (2026-07-08): non-blocking ticks — the bot no longer freezes to think or journal

Henry noticed the bot stood still whenever it logged/consulted. Two causes, both fixed:

- `claudeCodeDecide` used to AWAIT the CLI (up to 30s) inside the tick, stalling the whole loop — the bot's pathfinder goal would complete and it stood frozen mid-world. Now the consultation runs in the background: the tick acts on rules immediately, and Claude's `{action, thought}` is applied on the next tick after it lands, discarded if older than `ANSWER_FRESH_MS` (8s). Do NOT reintroduce an awaited CLI call in the tick path.
- Tick order changed to act-first: perceive → drives → decide → **act** → then all vault writes (encounters, experiences, strategies, state). Novelty for the Curiosity drive is precomputed with cheap `fs.existsSync` probes so drives still update before deciding. The `llm` API mode still awaits (10s timeout) — apply the same background pattern there if Henry ever uses it.

## DONE (2026-07-08): Phase A — Dreaming (built and verified with `npm run sim`)

- `src/reflection/dream.js`: `createDreamer()` — background reflection, triggered by day-break and/or `DREAM_INTERVAL_MS` (default 0 = day-break only; new in config + .env.example). Wired via `opts.dreamer` into loop.js (`maybe()` returns immediately — same background pattern as consultations; created in index.js for claude-code mode only, since it needs the CLI). `askClaudeCli` now exported from claudeCodeDecide with a timeout param (dreams get 90s).
- Dream input is vault-only (recent 20 Experiences, all Strategies, Goals, top-8 strongest-valence Concepts, existing Insight/Skill titles to prevent repeats) — all phrased qualitatively; sentences containing percentages are stripped from Experience excerpts (loop.js writes "Success rate is now 33%..." into some Experience bodies — those must not reach the prompt).
- Output written by `src/vault/dreamStore.js` (Insights/Skills) and `src/vault/goalStore.js` (subgoals). Guardrails enforced in `applyDream`: max 3 notes/dream, never overwrite (existing file = silently skipped), `learned_from` validated against real Experience titles, Skills REQUIRE ≥1 valid learned_from link, all failures silent.
- IMPORTANT FIX: founding goal is now found by frontmatter (the one goal without `serves`) in goalStore.foundingGoalTitle(), used by both loop.js and llmDecide.js — sort order would have let a dreamed subgoal like "Avoid The Dark.md" alphabetically shadow "Live A Good Life.md" after a restart.
- buildPrompt gained two sections: "Goals you have set for yourself" (subgoals) and "What you know how to do" (Skills).
- Vault: Ontology/Abstract/Insight.md + Skill.md, schema doc "Dreaming" section, relation table rows (`learned_from`, `serves`), Ontology + Goals READMEs, graph.json colors (Insight cyan 0x00FFFF, Skill pink 0xFF69B4).
- Sim: stubbed-CLI dream verifies the cap, no-overwrite on repeat dream, bogus learned_from filtering, serves link, founding-goal non-shadowing, day-break trigger firing exactly once, and both feedback loops into buildPrompt.

## DONE (2026-07-08, same day, later): Phase B — Motor primitives (verified with `npm run sim`)

NOTE: this phase was built across two overlapping sessions syncing via OneDrive (actions/perception/rules-experiment/tracker/loop landed from one; craft-unplugging, sim coverage, and docs from the other). Henry confirmed the first session was closed before the second finished.

- Actions `swingAt`, `dig`, `place`, `pickup` in actions.js (slow acts fire-and-forget — never awaited in the tick), exposed in Claude's vocabulary with mechanical descriptions only, never purpose. toAction clamps each to a valid target or falls back (explore/idle). Rules fiddle too: `experiment()` in decide.js, 15% chance when curiosity dominates and calm — accidents can happen between consultations. The sim passes `experimentChance: 0` to stay deterministic.
- **craft is implemented but NOT exposed** (not in VALID_ACTIONS, not in SYSTEM_PROMPT, not in experiment()) — Henry chose to defer it 2026-07-08 until the raw primitives prove out. The blind-craft code (`craftSomethingBlindly`) sits dormant in actions.js. Ask Henry before wiring it up.
- Inventory diff in loop.js: anything newly among the carried things becomes an item Concept encounter (ontology fallback = Material for unknowns, no hints) + a "Now Carrying X" Experience on first encounter, and counts as a discovery for drives and strategy scoring — so "Digging By Day discovered something" scores as success with zero new scoring code.
- strategyStore ACTION_LABELS: Swinging/Digging/Placing/Picking Up (+ Crafting, for whenever it's enabled).
- Sim: forced-action accident chain (dig stone -> cobblestone appears -> swing at chicken -> it drops something -> pickup -> Raw Chicken concept), plus toAction fallback checks and a craft-rejected check. Mock bot gained attack/dig/collectDrops and blockAt now returns position.
- Docs: agent README hands paragraph, schema doc Strategies section note.

## DONE (2026-07-08, same day, latest): Phase C — Intention persistence (verified with `npm run sim`)

- `src/vault/intentionStore.js`: `State/Current Intention.md` (working memory, overwriteable like all of State/). `currentIntention()` returns the active prose or null; `setIntention()` sets/replaces, or clears when given blank (writes `status: none`, never deletes). Capped at 200 chars, never throws.
- Claude's reply gained optional `"intention"`: SYSTEM_PROMPT explains the contract — include to set/replace, `""` to abandon, omit to keep. `toAction` passes it through (`action.intention`; undefined = keep); loop.js persists it after the state write. llm-mode max_tokens bumped 150 -> 250 for the extra field.
- `buildPrompt` shows it back every consultation: `Your standing intention (you set this for yourself; keep at it, change it, or abandon it): "..."`.
- Sim: forced explore sets an intention, an intention-less idle proves it survives, checks cover prompt feedback, toAction set/keep/abandon passthrough, clearing, and prompt removal after abandonment.
- Later (from the original roadmap, still open): let the strategy layer score whole intentions, not just actions.

All three phases (A dreaming, B motor primitives, C intention) are now live. What to watch for in the graph, from the roadmap: first Insight nobody gave it -> first self-authored Goal -> first Concept for a thing it *made* -> first Skill -> first intention held across a full day.

## DONE (2026-07-09): in-game chat — Henry can speak to it, and it can answer (verified with `npm run sim`)

Henry's framing: "one does not learn without a little guidance." Words are a sanctioned guidance channel — counsel, never commands, and never game hints from us. Decisions agreed with Henry: bot may reply, everyone is heard (attributed by name), messages persist as vault notes + prompt.

- `src/perception/chatChannel.js`: `createChatChannel({selfName})` — `hear()` buffers, `drain()` gives the tick the new messages once, `promptLines()` formats the last 6 (however old, with coarse age labels) for the prompt. Wired in index.js via `bot.on('chat')` + `bot.on('whisper')` (own name filtered), passed as `opts.chat` into tick.
- Loop: each heard message = encounter with the speaker + an Experience `"<Name> Said <first 60 chars>"` with the full words in the body (dreams can chew on counsel). `observation.chatLines` rides into buildPrompt. After execute: `action.say` is spoken via `bot.chat()` (256-char cap, try/catch).
- Person concept: perceive() names players by `entity.username` (`isPlayer` flag, never hostile); ontologyMap gained kind `'player'` → `Entity/Person`, prior fear 0 / curiosity 0.7. Vault gained `Ontology/Entity/Person.md` (+ Entity.md subclass line, README class tree, schema doc section "Hearing and speaking").
- Claude: SYSTEM_PROMPT explains heard words are another mind's counsel to weigh, and the optional `"say"` field (speak only when it has something to say); buildPrompt shows "Words spoken in the world's chat"; toAction passes `say` through (whitespace collapsed); llm-mode max_tokens 250 → 350. Rules stay deaf and mute.
- Sim: Henry walks up, speaks, bot answers; checks cover the Person note, the Said-Experience, prompt feed, say passthrough/silence, and by-name player perception.
- Note for testing on the real server: Henry's LAN world must allow a second player's chat to reach the bot (vanilla LAN chat just works); his own username in-game is whatever his Minecraft account is — the bot hears ANY name, no config needed.

## DONE (2026-07-09, later): mobility + decision persistence — it can actually follow Henry now (verified with `npm run sim`)

Henry ran the bot live with chat and reported: it recognized him and said "I'm following you" but never moved anywhere, and "explored" in place. Three root causes, all fixed:

1. **Wander re-targeting bug**: explore/seekFood set a NEW random GoalXZ every 1.5s tick, canceling each path after ~2 blocks — a random walk that never left the spawn area. Now `actions.js` keeps a per-bot `wanders` WeakMap: one committed destination, walked until arrived (≤3 blocks), re-rolled only on arrival or staleness (25s stuck-safety). The goal is re-asserted each tick so interleaved flees don't orphan it.
2. **No verb for following**: added the `approach` motor primitive — "walk toward a creature or person you can see", optionally named via a new `"target"` field in Claude's JSON (matched against perceived names, falls back to nearest, explore if no one around). Mechanical description only, per the no-hints rule. Execution re-resolves the LIVE entity by name each tick (players by username), so a moving person can genuinely be followed. strategyStore label: Approaching.
3. **Rules stomped Claude within one tick**: instinct (hunger 100 → seekFood) overwrote Claude's chosen action on the very next tick, so "explore toward the village" lasted 1.5s. `createClaudeCodeDecide` now HOLDS the applied answer for `holdMs` (default 6000 ≈ 4 ticks), re-validated via toAction against each fresh observation; flee/avoid reflexes always break through; `say`/`intention` fire only on first application (never repeated into chat). Factory gained `ask` + `holdMs` params for sim testability.

Also: the sim's old "≥1 effective AND ≥1 ineffective strategy" check was asserting EMA band thresholds that a lived-in vault (dozens of real attempts pinning rates near 0.5) can no longer reach from one scenario — replaced with a mechanism check (≥1 `last_outcome: success` and ≥1 `failure`). Sim also now records pathfinder goals on the mock bot (`bot._goals`) and covers: wander persistence, approach by-name/nearest/fallback, and the full hold lifecycle (instinct-while-consulting, apply-with-words, hold-without-words, reflex breakthrough, expiry) via a stubbed-`ask` createClaudeCodeDecide.

Watch for next: whether Claude actually picks `approach` when Henry speaks; whether the CLI failures Henry saw (Command failed: claude -p ...) are usage limits — if frequent, consider raising CLI_TIMEOUT_MS or lowering consultation frequency.

## THE ROADMAP (agreed with Henry, 2026-07-08): open-ended growth, in this order

Henry's constraint, non-negotiable: **no game hints.** The bot must never be told what things are for (sheep = food, iron = tools). It gets capabilities and a life; understanding must be earned. The three phases below are ordered so each feeds the next.

### Phase A — Dreaming: the brain rewrites itself (do this first; pure vault, zero game knowledge)

A reflection pass where Claude, AS MindBot in first person, reads its own vault and writes new notes. Trigger: surviving a night (day-break detected in the tick loop) and/or every `DREAM_INTERVAL_MS`; must run in the background like consultations — never block ticks (see warning below).

- Input to the reflection prompt: ONLY its own vault — recent Experiences (~20), all Strategy notes, Goals, strongest-valence Concepts. Nothing about Minecraft.
- Output (structured JSON, parsed and written as notes):
  - **Insights** → new ontology class `Abstract/Insight`, notes in `Concepts/Abstract/Insight/` — beliefs in its own words ("the water places always have salmon"), with `learned_from` links to the Experiences that support them.
  - **Subgoals** → self-authored notes in `Goals/` with a `serves: [[Live A Good Life]]` link ("secure food before dark"). Extend `buildPrompt` to include them.
  - **Skills** → new ontology class `Abstract/Skill`, notes in `Concepts/Abstract/Skill/` — this is Henry's "skill embedding": remembered know-how distilled from repeated successful experience ("when hungry near water, chase the salmon"), with `learned_from` links. Feed into the prompt as "What you know how to do." Skills are written ONLY by dreaming, never by us.
- Guardrails: cap notes per dream (~3), never delete or overwrite existing notes, unique titles, all failures silent. Update schema doc, ontology README, graph.json colors (suggest: Insight cyan, Skill pink). Extend the sim with a stubbed reflection (inject fake CLI JSON) to verify note writing; `npm run sim` must pass.

### Phase B — Motor primitives: hands, not instructions

Expose mineflayer's raw capabilities as new actions with neutral priors and NO explanation of purpose: `swingAt` (nearest entity), `dig` (nearest notable block), `place` (a held block), and item pickup. The existing machinery does the rest with almost no new code: picked-up/created items become Concept encounters (ontology fallback already handles unknowns), the strategy layer scores "Swinging At Night" / "Digging By Day", and dreaming distills repeated accidents into Skills — hunting can be *invented*, not taught. Open question flagged for Henry: crafting needs a recipe to call mineflayer with; listing currently-craftable item names is arguably what the game UI shows any player, but decide with him before adding it.

### Phase C — Intention persistence: projects across ticks

Claude's JSON reply gains an optional `"intention"` field → persisted to `State/Current Intention.md` → fed back into every consultation until replaced or explicitly abandoned. This is what makes multi-step undertakings (a shelter, a stockpile) *possible at all* — without it, even with hands, only one-swing behaviors can exist. Later: let the strategy layer score whole intentions, not just actions.

How we'll know it's working (watch for these in the graph): the first Insight note nobody gave it → the first self-authored Goal → the first Concept for an item it *made* rather than found → the first Skill note → the first intention held across a full day. Emergence isn't guaranteed on any timeline; the design's job is to make it possible (B), thinkable (A), and sustainable (C).

## Gotchas

- OneDrive syncs both folders; edits from Claude can take a few seconds to reach the Mac.
- Never run `npm audit fix --force` (downgrades mineflayer by 13 years).
- Claude CLI on Henry's Mac is the native install (`curl -fsSL https://claude.ai/install.sh | bash`); the npm route is broken on his machine.
- Henry pastes terminal output for debugging — only give him command lines in code blocks.
