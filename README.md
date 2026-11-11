# Minecraft Mind

**An AI agent that plays Minecraft while its entire memory and personality live as plain markdown in an Obsidian vault.**

Open the vault's graph view and you are looking at how the agent thinks: every creature, block and place it has met is a note with learned feelings attached, every notable moment is an Experience note, and the strategies, skills and goals it writes for itself link back to the experiences that produced them.

Built by Henry Risch (Bowdoin College), Summer 2026, as an experiment in giving an agent persistent, inspectable memory.

## How it works

Every 1.5 seconds the agent runs one tick: **perceive** the world, **update** three drives (Hunger, Fear, Curiosity), **decide** an action, **act**, then **journal** to the vault while its body is already moving.

- **Memory as markdown.** Concept notes carry drive weights and an emotional valence updated by exponential moving average, so the agent can grow used to things that never hurt it. Notable events (first encounters, damage, a feeling crossing a threshold) become timestamped Experience notes.
- **Learning what works.** Each action is scored by what happened while it ran (damage, food, fear easing, discoveries) and written to a Strategy note with a running success rate that feeds back into later decisions.
- **Three decision layers**, set in `.env`: a built-in rules ladder; Claude via the Anthropic API; or Claude via the Claude Code CLI on a normal account login. Claude reads the agent's own vault and returns an action plus a first-person thought. Every failure falls back to rules, so the agent never freezes.
- **Hands, intentions, ears and dreams.** Raw motor primitives with no explanation of their purpose (hunting is meant to be invented, not taught); a standing intention for multi-step plans; in-game chat heard as advice rather than commands; and a "dreaming" pass at daybreak where the agent reflects on its own vault and writes Insights, Skills and subgoals.

The full design is in [`agent/README.md`](agent/README.md) and [`docs/`](docs/).

## Run it

Needs Node 18+ and Minecraft **Java Edition 1.21.4**.

```bash
cd agent
npm install
cp .env.example .env      # set VAULT_PATH, MC_HOST, MC_PORT
npm run sim               # mock-world test of the whole pipeline, no server needed
npm start                 # join a real world (single-player: Esc -> Open to LAN)
```

For `VAULT_PATH`, copy `vault-template/` somewhere and point at it. It contains the agent's founding goal, *Live A Good Life*, and the agent builds everything else. Open the folder in Obsidian to watch it grow.

`tools/minecraft_ip.py` prints the addresses friends need to join your world, and `agent/setport.py <port>` updates `.env` when the LAN port changes.

## What broke, and how I fixed it

- **It stood next to lava for 18 minutes.** The original action set had no way to move away from a dangerous *block*, only from creatures. I added an `avoid` action, and the rules layer now automatically steps away from hazard blocks within 5 blocks.
- **Claude was too slow to drive every tick.** A CLI call takes seconds, and waiting froze the body. Consultations now run in the background on a throttle while instinct rules keep the agent moving. Claude's answer is applied when it arrives (or discarded if stale) and held for about 6 seconds so instinct doesn't overrule it, except for fleeing, which always wins.
- **Version mismatch.** The Minecraft library doesn't support the newest game versions yet, so the world has to run 1.21.4.

`npm run sim` checks the vault output (YAML, file paths, behavior) end to end and is run after every change.
