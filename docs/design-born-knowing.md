# Minecraft Mind — Born Knowing the Basics

*Design doc, 2026-11-16. The second phase of the experiment: MindBot is given what any creature is born with — knowledge of food, night, danger and making, and a few survival reflexes — and then left to work out, from "Live A Good Life" alone, what to do with its life. Its world grows as it thrives.*

---

## 0. Why: what the from-scratch phase showed

Phase 1 (2026-11-15 to 16) asked whether MindBot could discover survival by itself. Over about 400 memories, dozens of deaths, eight graded nights and a deep dream:

- **It reasoned its way to the right ideas.** Unaided, it concluded that shelter is the answer ("The next thing I have to learn is not a new belief. It is one finished act: closing myself in before the dark comes"), worked out the rule for placing blocks ("set blocks into the open spaces beside solid ground"), learned that field food feeds it, and caught a contradiction in its own records.
- **It never turned an idea into a skill.** It was never fully enclosed on any night. It approached pigs for hundreds of ticks and struck one twice. Thinking outran doing.
- **Why, in the course's terms:** each death carries only a few bits (Turing's "Casablanca by twenty questions"); a six-step act learned under attack, with no ancestors, is a lot to learn from a few bits per death. No real animal learns survival from scratch in one lifetime — instincts carry what earlier generations learned (Buckner's origin empiricism; the empowerment design doc: "Even you never chose hunger or curiosity — evolution handed them over").

So phase 2 changes the question from *"can it discover survival?"* to **"given what any creature is born knowing, what does it do with a good life?"** All of phase 1's data stays as the "before."

## 1. What it is born with

### 1.1 Inherited knowledge: `Inheritance/` in the vault

A small set of notes written in MindBot's own voice and marked `given_by: nature`, separate from everything it learned. The cortex reads them every consultation ("What you were born knowing"); dreams see them too, so beliefs build on them instead of contradicting them. In Obsidian, *born knowing* and *learned* are always distinguishable (useful for the Dennett and Lucken questions: whose knowledge is it?).

| Note | What it says, in short |
|---|---|
| **Food** | Cows, pigs, sheep and chickens give meat when struck down; raw meat can be eaten, and cooked meat feeds far more. Village fields give wheat (bread), carrots and potatoes. Rotten flesh fills a little but can sicken. Bones, sticks, string and seeds are not food. |
| **Night** | Monsters come out in the dark. Being closed in on every side, with a roof, keeps them out; so does a house with its door shut. Sleeping in a bed passes the night. Light keeps monsters from appearing close by. Zombies and skeletons burn in the morning sun. |
| **Danger** | Lava burns. Creepers hiss, then explode — move away when one is close. Skeletons shoot from a distance — put something solid between you. Long falls hurt. Water can drown. |
| **Making** | Striking a tree gives logs; logs become planks; planks make a crafting table and sticks; sticks and planks make wooden tools; a pickaxe breaks stone; stone makes better tools and a furnace. Coal and sticks make torches. |
| **The village** | Villagers are peaceful. The iron golem guards the village. Village houses have beds and doors. |

These are **facts, not instructions**: nothing says what to do with a life, only how the world works.

### 1.2 Survival reflexes (brainstem)

Like an animal's instincts: they keep it alive, and they do not choose its days. Each runs only when the need is real and the cortex hasn't chosen otherwise (arbiter priority: brainstem emergencies → Claude's plan → inner voice → reflexes → plain instinct).

- **Hunt when hungry** — hunger above half, no food carried, a food animal within sight and no hostile close: strike that animal until it falls, gather what it drops, eat.
- **Shelter at dusk** — evening, not enclosed: a bed within reach at nightfall → lie in it; otherwise **dig in** (a built-in routine: dig down until the head is below ground level, then seal the opening overhead with a carried block) and **stay put until morning**.
- **Creeper distance** — a creeper within 6 blocks: move away regardless of the fear drive.
- **Eat** — the edible list grows to include everything in the Food note (raw meat, bread, potatoes...), alongside what the body learns by tasting.

### 1.3 Crafting, by name

Crafting has been implemented but held back since July (a deliberate choice until the raw primitives proved out). It becomes a cortex action with a target: `craft` an item by name ("crafting_table", "wooden_pickaxe", "torch"), using a crafting table if one is within reach, and reporting what it couldn't do as a gap ("I lacked the planks"). Building a life needs tools.

## 2. What it is left to decide

Everything else stays the founding goal's to answer: where it settles, what it builds, whether it befriends the villagers, what it values, what it does with a safe day. The measures of a "good life," all read from data that already exists or is added here:

- **Nights survived in a row** and how (bed, house, dug-in) — the graded nights.
- **What it builds** — successful placements per day, and where (clustered = a structure).
- **What it makes** — crafted items.
- **What it sets out to do** — dreamed subgoals and standing intentions, compared with phase 1's.
- **What it learns beyond its inheritance** — Insights and Skills that cite its own experiences.

## 3. A world that grows as it thrives

The terrarium border expands as MindBot proves it can live:

- **Criterion:** 3 nights in a row survived (graded nights with no death).
- **Growth:** the border doubles — 128 → 256 → 512 → 1024 — then is removed (the full world).
- **How:** the agent asks the server through **RCON** (the server's remote-console port, enabled on 127.0.0.1 only with a local password). The *mind* never touches this; the body journal checks the criterion at each dawn and the code issues `worldborder set <size>`. The growth is written to the vault as an Experience ("The World Grew Wider"), and the border reflex follows the new edge automatically.
- **Shrinking:** never. A bad stretch after growth does not take the world back.

## 4. Build order

1. Inherited-knowledge notes + "What you were born knowing" in the cortex and dream prompts; expanded edible list.
2. Survival reflexes: hunt, dig-in routine and staying sheltered, bed at night, creeper distance.
3. Crafting by name.
4. Growing border: RCON client, server settings, dawn check.
5. Sim checks for all of the above; then restart, with the brain view watching.
