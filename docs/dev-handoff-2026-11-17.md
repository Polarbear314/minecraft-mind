# Dev handoff — 2026-11-17

Where Minecraft Mind stands after the 2026-11-15 to 17 work, and what to build next. Read this first in a new session; the design docs it points to have the detail.

## Running it (Windows)

- **Everything:** `windows\start-all.bat` opens the SERVER window (visible; type commands like `stop`, `worldborder get` there), the AGENT window (minimized; restarts the bot by itself), the BRAIN view (minimized), and the browser on **http://localhost:3008** (the live brain, the bot's-eye view, its thoughts, the EEG of every region firing).
- **To stop cleanly:** close the AGENT window, type `stop` in the SERVER window, Ctrl+C during its 10-second countdown.
- **Checks:** `cd agent` then `npm run sim` (167 checks, no Minecraft or model calls needed — keep it green).
- **Tools** (in `agent/`): `npm run bakeoff` (compare local models on a dream), `npm run deepdream` (one long Opus reflection over the whole life), `npm run sayvsdo` (does it act on its own goals? writes `docs/results-say-vs-do-<date>.md`), `npm run brain` (the brain view on its own).
- **Machine:** Windows 11, RTX 3060 12 GB. Java 21, Node 26, Git, Claude Code CLI, Ollama with **gemma3:12b** (also qwen3:14b, unused). The Claude CLI runs on the user's subscription (no API key).
- **Secrets stay out of git:** `agent/.env` (incl. `RCON_PASSWORD`) and `server/server.properties` (incl. `rcon.password`) are git-ignored. The server listens on 127.0.0.1 only (game 25565, RCON 25575).

## The architecture now

- **Body** (`agent/src/actions/`, `perception/`): complete, body-relative primitives — `dig/place` with `at` (below, above, ahead, -up, -down…), `move`, `jump`, `use` (doors, beds), `equip`, `craft` (by name), `swingAt`/`approach` (by name), `eat` (anything; edibility is learned). Every action reports `{ok, did}` or `{ok:false, reason}`. Perception adds affordances (sky, walls, enclosed, door/bed, placeable blocks), the world border, time of day.
- **Brain regions in parallel** (`agent/src/brain/`, map in `agent/brain-map.json`), sharing a blackboard (`blackboard.js`, which also writes `logs/brain-live.json`):
  - brainstem/rules + reflexes every 1.5 s (`decision/decide.js`, `decision/reflexes.js`)
  - cortex: Claude Sonnet via CLI every ~30 s, plan held until the next consultation (`decision/claudeCodeDecide.js`, prompt in `decision/llmDecide.js`)
  - always-on on Gemma: amygdala (gut threat → fear), inner voice / Broca's (thought + urge every ~4 s), rumination (every 2 min) (`brain/regions.js`)
  - arbiter: emergencies → Claude → inner-voice urge → reflexes → instinct (`brain/arbiter.js`)
  - hippocampus: dreams at day-break after ≥10 new experiences, Opus, Gemma when Claude hits its usage limit (`reflection/dream.js`, `brain/claudeStatus.js`, `brain/providers.js`)
- **Memory:** the Obsidian vault (`Agent Brain/Agent-Brain`, git-ignored): Concepts, Experiences, Strategies (per direction, day/night), Gaps (what the body couldn't do), Insights/Skills/Goals (dreamed), `Inheritance/` (born knowing, `given_by: nature`), `State/` (incl. `What My Body Knows.md`, `World.md`), `Dreams/`.
- **Logs** (`logs/`, git-ignored): ticks (every tick), decisions (every Claude call), dreams, nights (graded at dawn), deepdream, brain-live.

## The experiment so far

- **Phase 1, from scratch** (`docs/design-learning-from-the-readings.md`, from the PHIL 2400 readings): reasoned its way to shelter, food and the block-placing rule, caught a contradiction in its own records — but never turned an idea into a skill. 0 of 8 nights survived.
- **Phase 2, born knowing** (`docs/design-born-knowing.md`, on since 2026-11-17 00:11Z): inherited knowledge notes + reflexes (dig in at dusk and stay, hunt when hungry, creepers at 8 blocks, beds) + crafting by name + a border that doubles after 3 nights survived in a row (via RCON). Result in the first ~3 hours: 6 of 7 nights survived, 5 in a row; border grew 128 → 256; it hunts and eats beef/mutton; it dreamed "Each Night I Survive Widens My World". It has never crafted.
- **Says vs. does** (`docs/results-say-vs-do-2026-11-17.md`): its self-set goals change what it *thinks* far more than what it *does*. One clear exception (a simple habit: carry/gather blocks before dusk). Multi-step goals (find an empty bed, build walls, make tools) stay words.

## Next: goals become plans, plans become skills

The agreed next step (see the reasoning in the 2026-11-17 conversation; grounded in Newell & Simon's generator + test, Turing/Babbage stored programs, Fodor & Pylyshyn compositionality, Haugeland/Dreyfus practice, Lucken's specification-performance-registration loop):

1. **Plans with a test:** when a dream writes a goal, it also writes an executable plan — a short sequence of the body's primitives — plus a success test the body can check (e.g. *find a bed by day → use bed at dusk; test: slept through the night*).
2. **A plan runner:** executes a plan step by step across ticks so multi-step projects survive between Claude's 30-second decisions (night reflexes and emergencies still first).
3. **Generate and test:** grade every run against its test; promote plans that keep succeeding to **Skills** in the vault that the cortex can call by name; revise or drop the ones that keep failing, with the reason.
4. **Measure with `npm run sayvsdo`:** success = its goals start predicting what it does.

Later: the **empowerment drive** (`docs/design-empowerment-goal-loop.md`) to pull "Live A Good Life" toward capability — tools, a home, expansion.

## Known issues / notes

- Claude has not yet hit the plan's usage limit in a run; the resting/fallback path is tested in the sim but the exact CLI limit message hasn't been captured live (it is logged the first time it happens).
- Amygdala often reads "panic 95%" even when enclosed and safe — a mismatch between gut feeling and situation worth looking at.
- The sim runs on a copy of the live vault; checks that assume "first time" must clean their folder in the temp copy first (see the Gaps/Inheritance checks).
- The user prefers that nothing is deleted without asking.
- Course readings (PHIL 2400 Minds and Machines) are PDFs in the user's Downloads folder; this project's design docs cite them by page.
