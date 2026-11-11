# Minecraft Mind — Empowerment-Grounded Goal Loop

*Design doc. How the agent generates its own goals, learns from watching others, and keeps every one of those things rooted in the single directive it was born with: **Live a good life.***

---

## 0. The one idea

"Live a good life" is currently inert. It sits in `Goals/Live A Good Life.md` as beautiful prose with no operational meaning — the rule-based `decide()` layer acts straight from drives, and the founding goal only shows up in the decision prompt as a sentence. This doc gives that sentence a *computable* meaning, chosen so that it never names a pickaxe, a village, or a friend, yet **generates** all of those on its own.

The claim is simple and defensible: **a good life, operationalized, is sustained empowerment — the agent continuously expanding the set of futures it can bring about — while staying alive and while continuing to learn.** Three ingredients, mapping onto three things we'd actually call a good life:

- **A survival floor** — don't die, don't starve. This is already built: [[Fear]] and [[Hunger]].
- **Growth** — keep encountering and understanding new things. Already built: [[Curiosity]].
- **Flourishing / autonomy** — keep increasing your own capacity to act on the world. *This is the missing piece.* We add it as a fourth drive: **Empowerment**.

Nothing in that definition is Minecraft-specific. That's the whole point — it's the abstract seed, and specific goals fall out of it.

---

## 1. Why empowerment is the right formal reading of "a good life"

Empowerment is an information-theoretic drive: **seek states where you have the most control over your own future** — the most distinct, reliable outcomes reachable from where you stand. A pickaxe falls out of this for free. Bare-handed, the agent can make very few things happen. Holding a pickaxe, the whole tree of stone → ore → tools → structures becomes reachable. An agent that only wants "more control over what I can cause" will be *pulled toward tools*, toward open terrain over being boxed in, toward staying alive (dead = zero control) — and it will value the pickaxe intensely **without ever being handed the word or told it matters.**

This is not hand-waving; it's the current research consensus on what tracks genuine open-ended exploration. A 2025 study comparing adults, children, and AI agents found that of all intrinsic objectives tested, only entropy and empowerment consistently correlate with how humans actually explore — and empowerment keeps rising as exploration deepens, while novelty-style signals plateau early. Empowerment is the drive that doesn't run out. That makes it the right engine for a *life*, not just a task.

**The honest constraint:** you can't get goals from nothing. Even you never chose hunger or curiosity — evolution handed them over. "Self-generated goals" means specifying one abstract *drive* and letting the specific goals emerge. "Live a good life" = maximize sustained empowerment, subject to the survival floor, while learning. That is the only thing Henry gives. Everything else the agent works out itself.

---

## 2. What changes in the vault

The architecture already does most of the hard part — an Obsidian vault as legible mind, drives with live levels, Concepts with valence, a Strategy library, self-authored subgoals written while "dreaming." We are adding one drive, some frontmatter, and a formalized dreaming step. Nothing gets torn out.

### 2.1 New drive: `Drives/Empowerment.md`

A fourth instance of `[[Drive]]`, same shape as the others (live `level` 0–100, preserved prose body). Prose personality: *"The pull toward capability. Rises when the agent estimates it can reliably bring about more distinct outcomes than before; satisfied — briefly — each time a new capability is secured, then resumes climbing. Where Curiosity wants to know, Empowerment wants to be able."*

Crucially, its `level` is **computed from the agent's own experience, not from the LLM's opinion** (see §4). This is what keeps "a good life" grounded in what the agent has actually lived, rather than smuggled in from human priors.

### 2.2 Empowerment estimate, cheaply, from what already exists

We do not need deep RL. The agent already logs action→outcome results (`outcomeTracker.js`, `strategyStore.js`) and keeps a Strategy library under `Concepts/Abstract/Strategy/`. So define a tractable proxy:

> **Empowerment ≈ the number of distinct outcomes the agent can *reliably* cause from its current state** = count of Strategies with a good logged success rate that are *applicable right now* (given inventory, time of day, location).

- Picking up a tool that makes N previously-failing Strategies start succeeding → a jump in empowerment. The tool's value is *discovered*, never declared.
- **Object/tool-empowerment** per Concept: for each item or block, estimate how many downstream Strategies it enables, computable from the existing `requires` and `co_occurs_with` edges plus strategy success logs. Store it as a `empowerment_weight` field on the Concept, updated by the same EMA the other weights use.

### 2.3 Goals become a self-curating curriculum

Each self-authored subgoal in `Goals/` gains three fields:

```yaml
est_empowerment_gain: 0.0   # how much more the agent expects to be able to do if achieved
learning_progress: 0.0      # rate of improvement while pursuing it (satisfies Curiosity)
priority: 0.0               # derived score used to rank subgoals in the decision prompt
```

Lifecycle, all written by the agent into its own notes:

- **Spawned** — a candidate the agent imagined (see §3), still unproven.
- **Promoted** — `learning_progress` is good and empowerment is climbing → raise `priority`.
- **Retired** (`status: retired`) — plateau, or empowerment stops rising → stop feeding it to the decision prompt.

The Goals folder thus becomes a living, visible curriculum in the graph view — exactly on-brand with the project's whole premise that you can *read* the agent's mind. `serves: [[Live A Good Life]]` stays on every one, so the graph literally shows every self-set goal radiating from the founding directive.

---

## 3. The goal-generation loop (where the LLM plugs in — part 1: dreaming)

The agent already writes subgoals while "dreaming." We formalize that step into the OMNI-style recipe, with one deliberate deviation that is the heart of getting closer to your ideal.

On each dream cycle:

1. **LLM proposes (imagination only).** Feed the LLM recent `Experiences/`, the current Concept graph, active subgoals, and the current drive levels. Ask it to *propose* candidate subgoals in natural language — "reach a place with more resources," "learn what GiantAxe619 keeps making," "secure a light source before dark." This is what LLMs are genuinely good at: naming possibilities.

2. **The agent scores, not the LLM.** Each candidate is ranked by the agent's *own* metrics: `est_empowerment_gain × learning_progress_potential × current_drive_relevance`. **This is the key move.** OMNI and Voyager let the foundation model decide what's *interesting* — which quietly launders human priors back in (the LLM already "knows" pickaxes are good). We keep the LLM as proposer but move the judgment of *what's worth wanting* onto empowerment computed from the agent's own logged experience. The more of that judgment lives in empowerment rather than the LLM's say-so, the closer you are to no-hand-given-goals.

3. **Write the winners** as subgoal notes with the fields from §2.3 and `given_by: MindBot (dreaming)`.

The founding goal is never in this pipeline — it's identified structurally as the one goal without a `serves` link (already implemented in `goalStore.js`), and it's the fixed root the scoring function ultimately optimizes for.

---

## 4. Where the LLM plugs in — part 2: waking decisions

Use the seam that was designed for exactly this: `decide(drives, observation) -> action`. Two-tier, to preserve the hard-won "act before you journal, never freeze at night" safety property in `loop.js`:

- **Reflex tier (rule-based, every tick, unchanged):** if Fear is high and a hostile is near → flee. Cheap, instant, no LLM call. Survival floor is never gated on a model round-trip.
- **Deliberative tier (LLM, only when safe):** when Fear is low, invoke the LLM with `Current State`, the top-`priority` active subgoals, and the relevant Concepts/Strategies. It picks the action that best advances the highest-value subgoal — i.e. the one whose pursuit most raises sustained empowerment. Its output still flows through the existing `execute()` action layer, so perception, actions, and the vault writer don't change.

This means the empowerment drive shows up in behavior two ways: it *shapes which subgoals exist* (via dreaming) and it *breaks ties between actions* (via the waking decision), while Hunger/Fear keep their veto over both.

---

## 5. Learning from watching (the earlier thread, now falling out for free)

You wanted the agent to be *naturally interested* in watching you — not commanded to. With this design, that interest is not a feature you build; it's a **consequence** of the machinery already described.

A player is, at any moment, the single highest-empowerment and highest-learning-progress entity in view: they reliably cause outcomes the agent can't yet reproduce. So the same salience score that ranks Concepts (`surprise × goal_relevance × learning_progress`) will rank "attend to that entity" near the top *precisely when the agent lacks a capability it wants* — and will let interest fade once it can predict them, which is what makes it feel like genuine attention rather than a staring loop.

Mechanically, when the agent attends to a player producing an outcome tied to an open subgoal:

1. It segments the observation into **intent-chunks** (approached tree → swung repeatedly → gained item) rather than logging raw motion — reading through to the *purpose*, which is what makes the demo transferable.
2. It writes a **hypothesized Strategy** note into `Concepts/Abstract/Strategy/`, tagged to the subgoal it might serve.
3. It tries the strategy; the outcome updates its success rate via the existing `outcomeTracker` → which updates empowerment → which closes the loop.

This is the theory-of-mind / cultural-learning direction (cf. MindForge) but it needs no special "watch" command. Watching you and inventing its own goals turn out to be the *same mechanism* pointed at different things.

---

## 6. Build order

1. **Empowerment estimator first** — a read-only function over the existing strategy/outcome logs returning a 0–100 level and per-Concept `empowerment_weight`. Ship it as a new Drive that only *reports*, changing no behavior yet. Verify the number moves sensibly in the mock sim when the fake bot gains/loses a tool.
2. **Goal frontmatter + scoring** — add the three fields; write the ranking function; feed ranked subgoals into the (still rule-based) decision prompt context. Still no LLM.
3. **LLM dreaming step** — the propose→score→write cycle of §3, run on a timer or on "sleep." This is the first real self-goal generation.
4. **LLM deliberative tier** — swap the safe-branch of `decide()` for the model call of §4.
5. **Observational learning** — the salience score + intent-chunk segmentation + hypothesized-Strategy writer of §5.

Each stage is independently verifiable in `simulate.js` against a temp vault, matching the project's existing "show the generated notes, don't claim it works" bar.

---

## 7. Risks and the mitigations baked in

- **Noisy-TV trap** (agent hypnotized by random novelty). Mitigated by rewarding *learning progress* and *empowerment gain*, not raw surprise — flickering torches and falling leaves offer neither.
- **LLM prior leakage** (the model just tells the agent pickaxes are good, defeating the purpose). Mitigated structurally: the LLM only *proposes*; *value* is always empowerment computed from the agent's own logs. You can dial purity up or down by how much weight the scorer gives the LLM's ordering vs. the empowerment estimate.
- **Empowerment estimation cost.** The proxy in §2.2 is a count over already-logged strategies — cheap. Only make it fancier if the cheap version proves too coarse.
- **Freezing to think at night.** Preserved by the two-tier decision: the LLM is never on the survival path.

---

## 8. One-paragraph summary

Add Empowerment as a fourth drive, computed from the agent's own logged ability to cause outcomes. Redefine "Live a good life" as *sustained empowerment, above a survival floor, while still learning* — an abstract seed that names no specific goal. Let the LLM **imagine** candidate subgoals during dreaming, but let the agent's **own empowerment estimate decide** which are worth wanting; write the winners into `Goals/` as a self-curating curriculum, each serving the founding directive. Use the existing `decide()` seam for a two-tier waking loop that keeps survival reflexes off the model's critical path. Watching other players then emerges on its own, because a player is simply the highest-empowerment thing the agent can see. The result is an agent whose every self-set goal traces back, in a graph you can literally open and read, to the one thing it was ever told: live a good life.
