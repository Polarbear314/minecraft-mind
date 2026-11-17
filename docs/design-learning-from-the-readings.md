# Minecraft Mind — Learning Capacities, Not Just Beliefs

*Design doc, 2026-11-16. Why MindBot learned helplessness instead of learning to survive, read through the PHIL 2400 Minds and Machines readings, and what to build so it can learn new abilities. Page references are to the course reading editions.*

---

## 0. What happened

In its first 45 minutes in the terrarium, MindBot died 12 times, almost all to zombies at night. Its learning machinery worked exactly as designed:

- Dreams (Opus) turned the deaths into beliefs: *Running In The Dark Does Not Save Me*, *Some Harm Comes Without A Face*, and finally **The Night Hurts Whatever I Do**.
- It set its own subgoals: *Make A Safe Place Before Dark*, *Watch The Sky For Dusk*, *Keep Near The Gentle Animals*.
- The cortex (Sonnet) independently arrived at the classic first-night move: *"dig into the ground somewhere enclosed until daylight."*

And then nothing changed, because **the body cannot do it**. `dig` only targets a few "interesting" blocks nearby, never the block under its feet; `place` cannot be aimed; the action menu is a fixed list of eleven verbs. The plan was never carried out, so it never produced an outcome, so nothing could be learned about it. The bot concluded the only thing its experience allowed: nothing works.

## 1. The diagnosis, in one sentence

**MindBot learns contents — feelings, success rates, prose beliefs — but nothing in it can learn a new capacity.**

Every reading in the course, from very different starting points, lands on this.

| Reading | How it names the problem |
|---|---|
| **Turing** (§6.7) | Lady Lovelace's objection: the machine "can only do what we tell it to do." Turing's answer is a child-machine that learns — but his learning machine needs a body to act with ("it could not be asked to go out and fill the coal scuttle"), and he warns against "pointless repetitive loops." Flee → die → flee is one. |
| **Boden ch.2** (Descartes) | Descartes' second test: a machine fails because its organs "need a special arrangement for each special action." The eleven-verb menu is exactly a set of special arrangements, and the bot "infallibly fails" where no arrangement exists. |
| **Boden ch.3** (Babbage, Lovelace) | The Analytical Engine is general because programs are swappable punched cards, with a "library of its own." MindBot is general in its *symbols* (the LLM can say anything) but special-purpose in its *machinery*. |
| **Boden ch.4** (Turing, McCulloch–Pitts, cybernetics) | Valence and success-rate updates are threshold changes (McCulloch–Pitts) or Ashby's uniselector: they re-tune existing reflexes but cannot create new ones. Craik: maladaptation is "narrowing and distorting the environment until one's conduct appears adequate to it" — a precise description of *The Night Hurts Whatever I Do*. |
| **Newell & Simon** | A physical symbol system needs expressions that designate *every* process the machine can do, and processes that can create and modify expressions. MindBot fails both: its actions aren't expressions it can write, and "dig into the ground" designates nothing the body can access or interpret. Its knowledge sits in the fixed finite control, where N&S say it shouldn't. |
| **Fodor & Pylyshyn** | The menu is a phrase book. A systematic mind that can dig ahead can dig below; one that can place ahead can place above. Capacities stored as an atomic list have arbitrary gaps ("punctate minds"). |
| **Rumelhart; Churchland & Sejnowski; Buckner** | One scalar feeling per named concept is a network with no hidden units: it cannot represent "night is bad *only when* exposed and a zombie is near" (the XOR lesson), so it averages the conjunction into "night is bad, whatever I do." And a cortex consulted every 30 seconds loses to zombies: speed is a selection pressure. |
| **Lucken** | Maker's knowledge needs a closed loop: authorship (a specification), performance (the plan is carried out), registration (outcomes come back). MindBot authors plans it cannot perform, so nothing registers; it only ever holds conditionals. |
| **Dennett** | A belief is what makes behaviour predictable. The intention to dig in predicts nothing the bot does, so by Dennett's test it isn't yet a belief or intention of MindBot at all — just an "opinion." Its links to the world are thermostat-thin. |
| **Haugeland** (both) | The architecture is Cartesian: a text summary goes in, one of eleven symbols comes out, every 30 seconds — a narrow interface, so the LLM-plus-vault is a separable, effectively disembodied mind. Skills live in body–world coupling, and that is exactly where the bot cannot learn. |

So the answer to *"why can't we design the brain so it learns?"* is: **we can, but we've been designing the wrong part.** We built rich learning of *contents* on top of a body whose *capacities* are frozen. Lucken puts the fix precisely: you cannot author what gets learned, but you can author the conditions of learning — a vocabulary to learn *in*, and a loop that closes.

## 2. The design: eight changes, each grounded in the readings

### 2.1 A complete, aimable body (Fodor & Pylyshyn, Newell & Simon, Descartes, Dennett, Haugeland)

Replace argument-less verbs with **parameterized primitives relative to the body**:

- `dig(dx, dy, dz)` — any adjacent block, including below the feet and above the head
- `place(dx, dy, dz)` — with whatever block is held, including directly above
- `move(direction)`, `jump`, `sneak`, `look(yaw, pitch)`
- `use(dx, dy, dz)` — doors, beds, buttons
- `equip(item)`

These stay purpose-free (the project's philosophy) but become **complete**: no hidden purpose in *which* blocks may be dug (restricting `dig` to "interesting" blocks quietly built purpose into the body). Shelter is now *expressible* — dig below twice, step down, place above — and so are a pillar, a wall, a tunnel, and closing a village door behind you. None of these is given to it.

Dennett's enriched thermostat says the same from the other side: the more ways the bot can act (and sense — see 2.7), the more "shelter" and "zombie" in its notes actually mean something about this world.

### 2.2 Skills as stored programs in the vault (Turing, Babbage, Newell & Simon, Fodor & Pylyshyn)

Today a Skill note is prose the body can't run. Make it **an executable expression**: a short sequence of primitive calls with parameters, a precondition, and an expected effect, stored in the vault and run by a small executor.

```yaml
is_a: "[[Skill]]"
precondition: standing on diggable ground, holding a placeable block
steps:
  - dig(0, -1, 0)
  - dig(0, -2, 0)
  - move(down)
  - place(0, 1, 0)
expect: no zombie can reach me
success: alive at dawn with health ≥ 10
```

This is Turing's universal-machine move (the same symbols read "sometimes as data and sometimes as instructions"), Babbage's library of punched-card routines, and Newell & Simon's macro-operators. The cortex's menu becomes **primitives + every Skill the bot has earned**, so it grows without anyone editing code. Fodor & Pylyshyn's productivity: a finite vocabulary, an unbounded set of things it can do.

### 2.3 Close the loop: specify, perform, register (Lucken, Craik, Shannon's rat)

- **Feasibility gate.** Before an intention or dreamed Skill is adopted, check that every step compiles to an operator the body has. If not, store it as a **capability gap** ("I lack a way to X"), not as an intention. Gaps become subgoals (Newell & Simon's means–ends analysis; F&P's "universal subgoaling") or notes for the developer.
- **A written success specification** for every Strategy and Skill (Lucken's authorship). Outcomes are then classified as **breakdown** (died), **deviation** (survived, but hurt), or **out-of-spec** (something nobody anticipated). Only with a spec can the dreamer tell "my plan was wrong" from "the world surprised me."
- **Execution traces** (Lucken's performance): log which steps ran, which failed, and what the body actually did versus what the cortex chose. Without this, a bad plan and bad execution look the same.
- **Intention budgets** (Shannon's maze rat, which erased its memory to escape loops): an intention not achieved within N attempts is dropped, with the reason recorded.

### 2.4 Learn new skills by trying, then compile what works (Turing, Ashby, Dreyfus via Haugeland, Rumelhart/Jordan)

Turing's recipe for a learning machine is rewards and punishments, a random element, and a teacher's channel. MindBot has all three, but its random element (15% blind fiddling) samples a tiny space and is "blind trials" in MacKay's critique of Ashby.

- **Directed motor babbling** over the new parameterized space, steered by curiosity and by open capability gaps ("what happens if I dig below and place above while a zombie is near?").
- **Compile what repeatedly works**: when a sequence of primitives repeatedly relieves a drive in a sensed situation (e.g. damage stops after enclosure), save it as a new Skill (2.2) with its trigger. This is Dreyfus's path from awkward rule-following to a "muscular gestalt," and the plan/context units of Jordan's sequence network.
- **Ashby's double loop, with memory**: when essential variables (health, deaths per night) stay out of bounds, *change strategy* instead of settling on a belief — and remember which change restored stability, the step the Homeostat itself lacked.
- **Learning by watching** (already built) becomes much more useful: a human pillaring up is now something the bot's body can imitate.

### 2.5 Learn in context, not per name (Rumelhart, Buckner, Berliner via N&S, Vaucanson via Boden)

The XOR fix. Condition what is learned on the situation, not just the concept name:

- **Context-keyed strategies**: success rates per `action × night/day × exposed/enclosed × hostiles near`, instead of one global "Fleeing At Night." "Fleeing at night *in the open*" can fail while "hiding at night *enclosed*" succeeds.
- **Causally scoped insights** (Berliner): dreams attribute harm to conditions — *night ∧ exposed ∧ no cover* — not to "night."
- **Later: a small learned threat network** on the GPU, trained on *every* tick (≈1,800 per 45 minutes, not just notable Experiences) with damage-in-the-next-N-ticks as the teaching signal. Hidden units learn the conjunctions; an egocentric block/mob grid gives Buckner's nuisance invariance ("zombie 3 blocks NE at dusk" ≈ "zombie 4 blocks W at midnight," but ≠ "zombie behind a wall").

### 2.6 Beliefs that must earn their keep (Dennett, Haugeland's "understanding," Boden's *nullius in verba*)

- **Insights become hypotheses with predictions**: *"If I am enclosed at night, damage per minute drops."* Each is scored by later prediction success; insights that never predict anything are demoted. This answers Dennett's lectern problem (beliefs fitted to behaviour after the fact don't count) and Vaucanson's fake digestion (notes that never change behaviour).
- **Haugeland's understanding**: the system takes responsibility for its concepts — when something "can't be right," it revises. *The Night Hurts Whatever I Do* rests on a confounded sample (the action space never contained shelter); a capability gap should challenge it, not confirm it.
- **Vary one thing at a time** (Lucken): no "nothing works" insight until single-variable night experiments (house, pillar, hole, light) have been tried.
- **Two tests of the vault as a mind** (Dennett): a *prediction test* (does knowing the vault's beliefs predict the bot's behaviour better than the rules alone?) and an *ablation test* (delete one Insight; does behaviour change?).

### 2.7 Perceive affordances; use the world (Haugeland, Gibson, Wiener, Grey Walter)

- **Affordances each tick, relative to the body**: open sky overhead, a nook that affords shelter, diggable-here, sealable-above, a door, a bed, high ground. "Perception is cheap, representation expensive": look again rather than keep a vault model of the world.
- **Use what the world already knows**: the village is an institution with houses, doors, beds and iron golems. "At dusk, go through a door and close it" uses intelligence already built into the world (Haugeland's road that "knows the way"; the key-in-a-funnel).
- **Predictive purpose** (Wiener; Grey Walter's CORA): nightfall is predictable from the game clock. Fear should rise *at dusk*, before the zombies, and the link from dusk to danger can be conditioned rather than hard-coded.

### 2.8 Fast where it matters; slow where it helps (Churchland & Sejnowski, Haugeland/Brooks)

The 30-second cortex should set context and intentions; it must not be the thing that reacts to a zombie. Brooks-style **activity layers** (night-shelter, keep-distance, forage, go-home) run at tick rate and compete; the cortex picks and tunes layers. Later, distilled networks from the decision log take over fast jobs — trained on *outcomes*, not just on imitating Claude.

## 3. A tension the readings raise (worth a QCCR)

Haugeland would object to the project's founding principle. "Purpose-free motor primitives" is the Cartesian picture of *instructions* to a body; he argues motor capacity is shaped by the specific skills and world it serves. Fodor & Pylyshyn would defend structured, composable primitives as exactly what makes a mind systematic. This design sides with both in sequence: start with complete, composable primitives (F&P), and let *compiled, practiced Skills* — sequences tuned by feedback in the body–world loop — become the real units of competence (Haugeland, Dreyfus). Whether the second really escapes the Cartesian picture is a good open question.

The instructor's Boden question also applies directly: is this **technological AI** (just make it survive — hard-code a shelter routine) or **psychological AI** (make the capacity learnable)? This design chooses psychological AI. The 12 deaths are then a *result*: a theory in robotic form that revealed an omitted process — learning power without motor generality yields helplessness.

## 4. Build order

**Phase 1 — a body that can, and a loop that closes** (breaks the helplessness):
1. Parameterized primitives: `dig/place(dx,dy,dz)`, `move`, `jump`, `use`, `equip` (2.1).
2. Feasibility gate + capability-gap notes + intention budgets (2.3).
3. Execution traces and graded outcomes (alive at dawn, damage per minute, enclosed or exposed) in the decision log (2.3).
4. Affordance features in perception: sky overhead, enclosure, door nearby (2.7).

**Phase 2 — learning new abilities:**
5. Skills as executable vault programs, with an executor and specs (2.2).
6. Directed babbling and compiling successful sequences into Skills (2.4).
7. Context-keyed strategies and causally scoped, testable insights (2.5, 2.6).
8. Predictive dusk fear (2.7).

**Phase 3 — fast learned reflexes:**
9. A small threat network on the GPU, trained by replay at daybreak (2.5).
10. Activity layers with arbitration; distillation from the decision log (2.8).

**Test for success (Phase 1–2):** without being told how, MindBot survives a night by sheltering — and a Skill note it wrote itself, with real `learned_from` links, explains how.
