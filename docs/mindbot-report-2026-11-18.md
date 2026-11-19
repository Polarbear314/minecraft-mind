# MindBot: A Minecraft Creature That Learns While It Sleeps

*Progress report, 18 November 2026. PHIL 2400, Minds and Machines: course project.*

---

## Abstract

MindBot is an artificial creature living in a small Minecraft world. It is controlled by a program that perceives the world, chooses actions every 1.5 seconds, remembers what happened to it, and changes itself overnight.

Over the project MindBot has had three different minds:
1. **From scratch:** a cloud language model (Claude) deciding everything. It reasoned well and survived poorly.
2. **Born knowing:** the same mind with inherited reflexes and knowledge. It survived most nights but rarely turned its own goals into actions.
3. **Subsumption stack (current):** following a suggestion from the course professor, a stack of behaviours in the style of Rodney Brooks's robots: a hand-written survival layer at the bottom, small learned classifiers above it, and small open-source language models at the top. Claude is off during the day. The creature learns only at night, when Claude Opus reviews the day and changes the layers that need it.

**The project asks two questions.** The first is how the creature's behaviour changes from day to day, and why: which part of the mind changed, and did that change cause the difference? The second came from a recent MIT CSAIL report: can a frontier AI model directly *edit the weights* of a smaller model to improve it, rather than training it?

**Results so far:**
- **Survival:** since a round of fixes the creature lives well: no deaths over the last seven Minecraft days, steady food, harvesting, hunting and baking bread.
- **Learned layers:** none has yet outperformed its hand-written version on held-out data.
- **Weight editing:** Opus edits the small, readable classifiers carefully, withdrawing edits whose effects it judges too broad. In a sandbox trial on a 1.7-billion-parameter language model, a first steering edit failed. A second approach worked partly: Opus received a map of all 172,032 of the model's neurons, built from the creature's own experiences, and wrote neuron-level edits itself. The edit fixed the targeted flaw on situations it had never seen, far better than random edits of the same size. But it also made the model act when it shouldn't.
- **The broader pattern,** which matches the newly published MIT work: an AI can remove a learned *tendency* from another model's weights, but installing *judgement* by direct editing proved much harder.
- **A third attempt installed the judgement:** one closed-form solve fitted to 80 of the creature's own labelled situations, written into 256 neurons near the model's output. It improved the unseen test cases and the controls together, the first edit to do both. When Opus chose *where* to write the same solve, the result was worse than no edit. **What wrote the judgement in was fitting examples from the creature's life, not understanding the model.** When the teacher learned only from the creature's own outcomes, the edit instead taught it to gather at night: its protected life had never shown it the danger. On a second flaw in a second model (Shelter digging in at midday), the rule teacher didn't generalise, but Opus as teacher improved both sides again. Across both flaws, Opus giving firm labels was the most reliable teacher.

---

## 1. Background and motivation

### 1.1 Where the project started

The first phase of MindBot, guided by the course readings, gave the creature a body (perception and basic actions in Minecraft), a memory (an Obsidian vault of linked notes about concepts, experiences, strategies and goals), and a mind made of parallel "brain regions":
- a fast rule-based brainstem;
- a cortex (Claude Sonnet, consulted every ~30 seconds);
- an amygdala, an inner voice and a rumination region running on a small local model;
- a hippocampus (Claude Opus) that "dreams" at daybreak, turning experiences into insights, goals and skills.

**Phase 1 (from scratch).** It reasoned its way to ideas about shelter and food, and it caught contradictions in its own records. But it never turned an idea into a reliable skill, and survived none of its first eight nights.

**Phase 2 (born knowing).** The creature was given inherited knowledge notes and survival reflexes: dig in at dusk, hunt when hungry, keep away from creepers. It survived six of seven nights. A "says vs. does" analysis then showed that its self-set goals changed what it *thought about* far more than what it *did*. Multi-step goals ("find a bed", "build walls") stayed as words. That led to plans with success tests, a plan runner, and promotion of plans that work into skills.

### 1.2 The professor's suggestion: subsumption

In a conversation on 17 November 2026, the course professor suggested organising MindBot by **behaviours stacked in layers** rather than by brain regions, after Rodney Brooks's subsumption architecture (MIT, late 1980s). The suggestion had four parts:
- make the layers small models that can learn;
- make dreaming the only way they learn;
- measure how behaviour changes from day to day.

In Brooks's robots there is no central planner. Each layer is a complete behaviour that is always running. A higher layer *suppresses* those below it when it has something to say and stays quiet otherwise. The robot works with only its bottom layer, and each new layer adds competence without rewriting what is below. Brooks's layers were hand-written and never learned. MindBot's version keeps his structure but makes most layers learnable, and makes sleep the only time learning happens.

### 1.3 The weight-editing question

A report from MIT CSAIL, published in November 2026 as "Sparks of Weight-Space Programming" (Takehi, Teoh, Zhang and Khattab), claimed that a frontier model, GPT-6 Astra, could read a smaller model's weights and write corrections into them directly, with no training. It reportedly raised a 0.8-billion-parameter Qwen model's maths score from 7.9% to 48.1% while changing about 0.016% of its weights.

That raised a question this project is well placed to test. MindBot has learned layers of very different sizes, from classifiers of about 120 named numbers to language models of several billion parameters. Can Opus improve them by editing their weights directly, as well as by writing training examples for them? And how far up the scale does direct editing reach?

### 1.4 The philosophical questions

The project sits in a philosophy of mind course, and the engineering keeps raising philosophical questions:
- **Editing versus learning.** If another mind writes a creature's connections directly, is the creature still learning *itself*?
- **Understanding another mind.** What does one mind need in order to understand another well enough to change it? Is reading a model's weights a kind of understanding, or only the measured effects of changing them?
- **The interpreter.** MindBot's narrator explains actions it did not cause, like the left-brain "interpreter" in Gazzaniga's split-brain patients. How often does its story match the real cause?
- **Where does a mind end?** Opus is configured as MindBot's own hippocampus. When it rewrites MindBot's habits at night, is that self-modification or outside intervention?

---

## 2. What MindBot is now

### 2.1 The behaviour stack

Every tick (1.5 seconds, about 800 per Minecraft day) each layer looks at the situation and either proposes an action or stays quiet. The first layer in the order below that speaks gets the body.

| Order | Layer | Speaks when | What it is | How it learns |
|---|---|---|---|---|
| 1 | **Survive** | a hostile close, low health, lava or a drop, the world's edge | hand-written: flee, avoid, return inside, eat to heal | never: the floor that keeps it alive while the others learn |
| 2 | **Make** | carrying enough to use, or a plan is running | Qwen3-4B language model (shadow) | planned (stages 7 and 7b) |
| 3 | **Shelter** | evening or night | Qwen2.5-3B language model (shadow) | planned |
| 4 | **Gather** | daytime, things worth breaking or picking up | Qwen3-1.7B language model (shadow) | planned |
| 5 | **Forage** | hungry, food in reach | readable classifier (about 120 named weights) | every night |
| 6 | **Wander** | nothing else speaks | readable classifier | every night |

Survive is listed first because it overrides everything, as collision avoidance did in Brooks's robots.

**Brooks's "wires":**
- While Survive acts, or Shelter holds the body in the evening, Make is inhibited and any running plan pauses.
- Urgent hunger also inhibits Make.
- Food in reach while carrying little pauses Make and quiets Gather.

**Randomness stays on purpose:** when calm and curious, Wander still tries something new 15% of the time.

### 2.2 The three kinds of layer

**Hand-written layers.** Survive, and the first versions of every other layer, were written from the reflexes and instincts of the earlier design. They are the baseline every learned layer must beat.

**Readable classifiers (Forage, Wander).** Each is a small logistic regression over 19 named features of the situation (health, food, drives, day/evening, shelter, nearest hostile, nearest animal, ripe crops, food on the ground, food carried, and so on). Its weights form a table anyone can read, for example "animalClose → hunt: +2.1". That readability is what makes direct editing by Opus possible.

**Language-model layers (Make, Shelter, Gather).** Three small open models from the same family (Qwen), sized to the layer's job: 4B, 3B and 1.7B parameters, a deliberate taper from large at the top to small at the bottom. They run together in one local service on the RTX 3060 GPU, using about 6.5 GB.
- **How a layer chooses:** it doesn't write free text. Its possible acts are listed as A, B, C…, and one forward pass gives the probability of each letter. Each question is asked twice with the options shuffled, because the smallest model showed a strong bias toward whichever letter came last.
- **What a layer sees:** the situation in words, its job, and its three most relevant memories.
- **Status:** these layers currently run in **shadow mode**. Their choices are logged next to the hand-written layer's, but the hand-written layer acts.

### 2.3 Memory

MindBot's memory is an Obsidian vault of linked notes.
- **Weights:** every note has a weight between 0 and 1.
- **Retrieval:** follows FreeLAB, the user's summer project. Notes are embedded once with a small open embedding model (nomic-embed-text), and each question retrieves the notes most similar to it, weighted by importance and recency. This finds, for example, a memory titled *Died In The Night Under Cover* for the situation "hostile at nightfall and I am out in the open", with no shared words.
- **Forgetting:** experiences fade. Faded ones are folded into "gist" notes ("this has happened to me 4 times; 3 went badly") and moved to an archive. Nothing is ever deleted.

### 2.4 The narrator

With the layers acting, the creature's stream of thought had gone quiet, since classifiers and letter choices don't produce words. So a narrator was added. About every 20 seconds Claude Sonnet is shown the situation and the body's recent acts, and says in the first person what it is doing and why. It is *not told which layer acted*. Like Gazzaniga's interpreter, it explains actions it didn't cause. Every narration is logged with the true cause, so how often the story matches can be measured. The narrator never changes what the body does.

### 2.5 Sleep: dreaming and nightly learning

At each dawn the creature sleeps. In order:
1. **Consolidation:** the vault's links are tidied.
2. **Forgetting:** old memories fade and are folded into gists.
3. **Nightly learning** for the learned layers.
4. **The dream:** Opus writes the night's insights, goals and plans.

Nightly learning alternates between two routes:
- **Route B (retraining).** Opus reviews the day's important moments for each learned layer (its acts that went badly, food it walked past before going hungry, hungry stretches, a few that went well). It writes a diagnosis and corrections ("at moment 12, Forage should have hunted"). The layer is retrained on its own outcomes plus all corrections so far.
- **Route A (direct editing).** Opus reads the layer's *full* weight table and proposes up to six edits, each a single number with a reason. For each edit, every past moment where the layer would now choose differently is found. The most relevant of those (by embedding similarity to the moments behind the edit) are shown to Opus, which keeps, adjusts or withdraws each edit.

**The gate.** Either way, a changed layer is served only if it beats the hand-written layer on the most recent day (held out from training) by the creature's own outcomes. Opus never sees the gate and never decides what is kept. Every version is saved.

---

## 3. Method: how change is measured

**Day metrics.** A tool (`npm run days`) cuts the tick logs into Minecraft days and measures each:
- distance walked and area covered;
- deaths, ticks hurt, average food and ticks starving;
- what it ate, hunted, harvested, broke and made;
- the share of the night spent enclosed;
- the share of ticks each layer controlled the body.

The aim is to explain any change across days by the layer whose learning preceded it, and to test that by rolling the layer back for a day (ablation).

**Gates and held-out days.** Learned layers are always judged on data they weren't trained on, by outcomes (did the act lead to food, harm, refusal?) rather than by agreement with a teacher.

**Shadow mode.** New layers run beside the old ones, so their choices can be compared before they're trusted with the body.

**Simulation tests.** A test suite (`npm run sim`, 325 checks) exercises the stack, memory, learning and model layers without Minecraft or any model calls. It's kept passing before any change goes live.

---

## 4. Results so far

### 4.1 The creature's life

The bot switched to the behaviour stack on day 38 of its life (days 1–37 were the region design). Recent days:

| Day | Walked (blocks) | Deaths | Average food (of 20) | Ticks starving | Ate | Hunted | Harvested | Night enclosed | Most in control |
|---|---|---|---|---|---|---|---|---|---|
| 38 | 2,070 | 0 | 1.7 | 766 | 2 | 0 | 0 | 100% | Shelter 50%, Forage 49% |
| 39 | 1,759 | 0 | 10.5 | 91 | 8 | 0 | 0 | 100% | Shelter 51%, Wander 27% |
| 41 | 1,655 | 0 | 12.1 | 0 | 7 | 11 | 6 | 100% | Shelter 54%, Make 22% |
| 42 | 394 | 0 | 12.1 | 0 | 14 | 0 | 5 | 100% | Shelter 53%, Gather 25% |
| 43* | 1,525 | 0 | 15.4 | 0 | 12 | 7 | 4 | 100% | Make 29%, Shelter 20% |

*\* partial day (restart). Later days were partial too.*

**What the first days showed:**
- **Day 38: it nearly starved.** It walked past carrots, wheat and animals: crops weren't among the blocks the body scanned, and a running plan kept a hungry body busy. After the food fixes (scanning crops, harvesting, hunting, pausing plans when hungry or when food is in reach) the creature stayed fed.
- **Since the fixes:** no deaths over about seven Minecraft days, average food 12–17, starving ticks at zero, and a shift from aimless walking toward eating, hunting and harvesting.
- **Nights:** it seals itself in every night.
- **Bread:** carrying three wheat, it now bakes bread, making a crafting table first if needed.
- **One death resembled drowning,** and the dream that followed wrote a note titled *Water Above Me Is Not A Roof*.

**Opus's first night review caught a real gap.** With health at 2–4 and food in its pack, the creature didn't eat, because eating waited for hunger, and health only regenerates when the food bar is high. Survive now eats to heal. Right after the change, it ate three potatoes in a row at low health.

### 4.2 The learned bottom layers

Neither learned layer has passed its gate yet. The latest results: Forage scores 0.55 against the hand-written layer's 0.67 on the held-out day, and Wander 0.29 against 0.67. The main reason is data. Since the food fixes the hand-written layers make few mistakes the outcome labels can detect, so there's little to learn from. More days of the fixed creature are needed.

### 4.3 Opus as an editor of readable weights (route A)

On the first editing night, Opus proposed six edits to Forage and four to Wander. When shown the past moments each edit would change:
- **It withdrew** one Forage edit that would have changed 282 past moments.
- **It softened** a Wander edit ("carrying food → fiddle with something" from −2.2 to −1.5) after seeing it would change 1,022 moments, reasoning that "the body nearly always carries some food".

Opus behaves like a cautious editor that weighs an edit's reach against its evidence. The edited layers have not passed the gate yet either.

### 4.4 First tests of the language-model layers

Untrained, in shadow:
- **Make** baked bread when carrying wheat by a table (100% sure).
- **Shelter** stayed put when sealed in at night (98%).
- **Two flaws, fixed:**
  - *Shelter chose "stay closed in" at sunny midday.* Fixed by only offering "stay" in the evening or when enclosed.
  - *The 1.7B Gather model had a strong position bias:* it chose "nothing" 100% of the time whenever that option came last. Fixed by asking twice with shuffled options and averaging.

---

## 5. The weight-editing trial (stage 7b)

### 5.1 Setup

To learn whether Opus can make a targeted edit to a language model's weights *stick*, a sandbox trial was run on a separate copy of the Gather model (Qwen3-1.7B). The live creature and its model service were never touched.
- **The target flaw:** by day, in the open, with no hostile near and something lying within reach (a dropped log, dirt, seeds, a carrot), Gather says "nothing: this is not for me right now" most of the time.
- **Test cases:** 40 logged situations where gathering was right (the hand-written Gather took the item).
- **Controls:** 40 logged situations where "nothing" was right, with the same menu: night sealed in, night in the open, or a hostile close. One case per episode.
- **The questions** were rebuilt from the tick logs with the live code (the same situation text, menu and memory retrieval), and scored as the live service scores.
- **A guard against overfitting:** cases were split into a *check* half, which Opus saw between rounds, and a *held-out* half, used only for the final report.
- **A practical constraint:** the GPU already held 9 of its 12 GB beside the running creature. So the sandbox copy used the same 4-bit quantisation as the live service, and every edit was kept as a separate full-precision patch added to the weights.

**The unedited model,** in all 80 cases: on the 40 test cases it said "nothing" 25 times and picked up the item only 12 times. Its average probability of "nothing" was almost identical on test cases (0.52) and controls (0.50): it barely distinguished a safe moment to gather from a dangerous one.

### 5.2 Part 1: steering through a tool (failed)

**The index.** The model was run over 320 logged situations, and directions in its internal activations were found at five depths: a "worth gathering" contrast, the main principal directions, and a direction tracking how much it says "nothing". Opus wrote a one-line description for each of 49 units from their top examples. Each direction's pull on the answer was measured by adding it to the model's activations.

**The finding.** At every depth there was a clear "worth gathering" direction, separating gatherable situations by about 1.7 standard deviations. But it barely moved the answer. The model *represents* the difference and does not *use* it. The directions that did move the answer, at layer 18, meant something like "day, open sky: act".

**Opus's rounds.**
1. Opus chose a "keyed" rank-1 edit at layer 18, meant to act only in gathering-like moments, at strength 2.5. It predicted the risk itself: night or zombie scenes under open sky might trigger it.
2. The freed probability went to "break the block ahead" rather than "pick up", and controls with a hostile close got worse. Opus softened the edit to 1.5 and set its own stopping rule.
3. Opus withdrew the edit, in its words because "the units that move the answer … mostly carry 'day, open sky' and 'act vs. do nothing', not 'there is something to pick up and it's safe'."

The held-out half agreed: no gain on test cases, and worse controls.

### 5.3 A detour: the prompt, not the weights

The situation text the model saw never mentioned what was lying nearby: only the menu did, and the menu looked the same in test cases and controls. Adding one sentence ("Lying on the ground near me: oak log 3 blocks away.") with no weight change raised correct test answers from 12 to 21 of 40, mostly as "pick up". But the model still gathered at night and near hostiles. Spelling out the danger ("It is night and I am sealed in: going out now is dangerous") made it slightly *worse*: the small model does not use danger when deciding whether to gather.

**Built into the live creature as a result:**
- **What lies in reach:** Gather's model now sees it in its situation text.
- **The rule:** Gather's model is asked only by day with no hostile within 10 blocks.

This is the subsumption answer: the small model chooses *what* to gather, and fixed wiring decides *when* it's safe.

### 5.4 Part 2: Opus operates on the neurons itself

The second attempt gave Opus a map and a scalpel instead of a tool to pull.

**The map.** All 172,032 MLP neurons of the model (28 layers × 6,144) were fingerprinted by how strongly each fires in 986 of the creature's own logged situations. A single forward pass computes every neuron at once, so this took three minutes. Within each layer, neurons were grouped by fingerprint into 16 groups (448 groups in all). Each group was described by:
- what it fires on (its top situations, and their shares of day, sealed in, hostile near, worth gathering);
- whether it fires more when gathering is right;
- its correlation with the model's own probability of "nothing";
- whether its output points toward or away from "nothing";
- the vocabulary its output promotes. As the interpretability literature predicts, this was noise in the middle layers.

Most importantly, each group was **switched off in turn** and the change in the model's answers measured (27 minutes in total). In the style of FreeLAB, the descriptions and the flaw were embedded and the 24 most relevant groups retrieved, ranked by similarity times measured effect. Similarity turned out to be nearly flat across groups (0.67–0.72), so the measured effects decided the ranking.

**The scalpel.** Opus wrote edits on named weights itself; the tool only executed and measured them. Three operations:
- **Scale a neuron's output:** 0 switches it off, 0.5 weakens it, 1.5 strengthens it.
- **Bias a neuron to fire more or less** in every situation.
- **Write into a neuron's output weights** so that, when it fires, it pushes the answer toward or away from "nothing".

Opus had four rounds of up to five experiments each on the check half, could inspect any group neuron by neuron, and then made a final choice.

**What Opus did, in its own reasoning:**
1. **Round 1, its hypothesis:** groups that fire *only in safe, gatherable daylight* yet push toward "nothing" cause the flaw. It switched off two such groups (layer 8 group 0 and layer 11 group 10). Test cases on the check half went from 5 to 13 of 20 right, controls from 10 to 11, and none broke. At half strength the effect was about half: a dose response.
2. **Round 2:** each group alone gave about half the gain, so they add up rather than one relaying the other. It wrote "push toward nothing" into eight night-detector neurons. That had no effect.
3. **Round 3:** a third day-only group (layer 8 group 6) raised test cases to 17 of 20 but broke one control. Switching the night detectors off dropped controls from 10 to 6, so they carry the danger signal. But writing into them, even at four times strength, didn't route that signal to the answer.
4. **Round 4:** the third group at half strength kept 14 of 20 test cases without breaking a control. Doubling the danger detectors did nothing: that route seemed saturated.
5. **Final choice:** two groups off, the third at half, 1,290 neurons and about 2.6 million weights (about 0.16% of the model). Its conclusion: "is it safe?" and "should I hold back?" live in different places in the model. The edit fixes holding back in safe daylight but "does not fix the separate weakness at night and with a hostile close".

**The held-out test.** Opus's edit was compared with five random edits of the same shape (random groups in the same layers) and with a simple rule that used the same switch-off table without Opus (switch off the three groups with the most selective effect).

| What was tried (held-out half: 20 test, 20 controls) | Test right | Controls right |
|---|---|---|
| Unedited | 7 | 15 |
| Part 1: steering edit at layer 18 | 7 | 13 |
| Prompt: say what lies in reach (no edit) | 11 | 12 |
| **Part 2: Opus's own neuron edit** | **17** | **8** |
| Rule from the switch-off table, without Opus | 12 | 8 |
| Random groups, same shape (5 draws) | 6, 6, 6, 6, 6 | 14, 13, 9, 15, 12 |

### 5.5 What the trial shows

- **The targeting is real.** Random edits of the same size never moved the test cases (6 of 20 every time). Opus's edit moved them to 17 of 20, on situations it had never seen, and as "pick up" rather than "dig". This is the first edit in the project to change the language model's behaviour in the intended direction, and Opus wrote it.
- **It is not clean.** On held-out controls the edit made the model pick things up while sealed in at night (five cases, three of them from the same night) and once with a creeper four blocks away. Controls fell from 15 to 8 of 20 right. The check half had shown no damage, but with only 20 cases, several from the same night, it undercounted the side effects. Overall, held-out correct answers rose only from 22 to 25 of 40.
- **Opus added something over the rule,** about five more held-out test cases right and less digging. But most of the work was done by the measured switch-off effects.
- **Removing versus installing.** Opus could *remove* a learned habit: holding back when nothing is wrong. It could not *install* a judgement: holding back when something is dangerous. The danger signal exists in the model (switching it off hurts), but nothing Opus wrote could route it to the answer.

**The edit is not used by the live creature.** The live Gather rule already keeps the model out of exactly the night and hostile cases the edit damages. Edit and rule together may keep the gain without the harm; that is the next test.

### 5.6 Part 3: writing the judgement in with one solve

A week before this report, a developer described writing a calibrated decision policy into a 0.8B Qwen model with one MEMIT-style least-squares solve: no training, no gradient on any weight, 3 milliseconds. Their teacher was a decision model from the same family as the Laya tools already used in this project. That suggested a third attempt that combines both approaches. Opus (with the neuron map) chooses *where* to write, and the solve computes *how*.

**The method:**
- **The teacher:** the creature's own judgement, as labels on 80 logged situations from the map set (none from the test set). Pick up by day, in the open, with no hostile within 10 blocks; "nothing" at night or with a hostile close.
- **Targets:** for each example, the smallest change to one layer's MLP output at the answer position that makes the model answer as the teacher would. These are found by adjusting only that change, never a weight.
- **The solve:** new output weights for the chosen neurons, so that what those neurons hold in each situation produces the required change. A protection term keeps their effect on the rest of each prompt, and on plain English sentences, near zero.
- **Strength:** chosen on the check half, refusing any setting that changed plain-English predictions noticeably.

**Three ways of choosing where:**
- **Automatic** (the published recipe): the second-to-last layer, the 256 neurons most active at the answer.
- **Opus:** from the map and its part-2 findings, it chose the night/sealed-in detector group at layer 13 (387 neurons): "the danger signal is already computed here … but it never reaches the answer". It predicted this would fix the night controls and that the automatic choice would generalise worse.
- **Random** neurons at each layer, as controls.

| Edit (held-out half: 20 test, 20 controls) | Test right | Controls right |
|---|---|---|
| Unedited | 7 | 15 |
| **Automatic: layer 26, 256 most-active neurons** | **13** | **16** |
| Random 256 neurons, layer 26 | 7 | 11 |
| Opus's choice: layer 13, the danger-detector group | 5 | 8 |
| Random 387 neurons, layer 13 (3 draws) | 5–8 | 7 |
| *Part 2: Opus's own surgery* | *17* | *8* |

**What it shows:**
- **The judgement can be written in.** The automatic edit is the first in the project to improve both the test cases and the controls on unseen situations (22 → 29 of 40 right overall), with plain English barely affected. Random neurons with the same solve did nothing, so which neurons are chosen matters.
- **Opus's choice of where failed:** every setting at layer 13 was worse than no edit, and its group did no better than random neurons there. The likely reason is depth. A change written at layer 13 passes through fourteen more layers, so the separate per-example changes don't add up as the solve assumes; at the second-to-last layer they nearly do. Opus reasoned about where the *information* lives. The solve needed a place where a change acts *simply* on the answer, which the map doesn't show.
- **Still weak:** "hostile close" cases (2 of 5), because the teacher's examples were mostly sealed-in nights.

**Two follow-up tests.**

*Opus choosing within the right layer.* With the depth fixed at layer 26, Opus chose the 256 neurons that most *separate* safe gathering from danger, a principled choice that overlapped with the automatic set by only 16 neurons. The result was 8 test cases and 16 controls right: better than random (7 and 11) and as good as the automatic choice on controls, but far behind it on test cases (13). The solve's leverage seems to come from neurons strongly *active* where the answer is formed. Neurons that carry the distinction but are quiet there give it little to work with. Understanding where information lives is not the same as knowing where an edit has leverage.

*A teacher that learned from experience.* The first teacher stated the creature's judgement as a rule. The second was Laya's decision model, fitted on what *actually happened* to the creature after picking things up or staying put. The outcome labels held a surprise:
- **Picking things up had always gone fine.** 806 pick-ups, none harmful.
- **It had never picked anything up at night,** because its hand-written layers never allowed it.
- **Its experience held no evidence at all that gathering at night is dangerous.**

Written into the model with the same solve, that lesson raised the test cases to 15 of 20, but the controls fell to 6, since the model now picked things up at night. The edit faithfully installed what the teacher believed.

| Teacher (same solve, same neurons; held-out) | Test right | Controls right |
|---|---|---|
| Unedited | 7 | 15 |
| The creature's judgement as a rule | 13 | 16 |
| Laya, learned from the creature's outcomes | 15 | 6 |
| Laya, outcomes plus 27 of Opus's corrections | 18 | 4 |
| Opus labelling the teacher situations, with its own confidence | 2 | 19 |
| Opus's labels, at the rule's fixed confidence | 13 | 11 |

*Experience plus being told.* The last test gave the experience-trained teacher some outside knowledge. Opus labelled 27 logged moments in route-B style, the way it corrects the classifiers each night, and answered as the creature's judgement would: stay put at night, hold back with a hostile close, pick up when safe. Laya was refitted on the outcomes plus these corrections. The corrections helped where they were heard: the teacher became surer about safe daylight and turned against picking up with a hostile close. But it got *worse* on sealed-in nights, the very cases most corrections were about, and the edit followed it (test 18, controls 4). Twenty-seven corrections against about 450 outcome rows was too small a voice, and the small learned teacher shifted its overall tendency instead of learning a night-time exception. Only a teacher that stated the judgement directly installed it.

*Opus as the teacher.* Finally, Opus labelled the teacher situations itself, which is the form a nightly loop could run.
- **Its judgements:** it never picked up when sealed in at night, mostly picked up when safe by day, and, unlike the rule, judged gathering acceptable with a hostile several blocks away by day.
- **With Opus's own confidence as the target,** the edit made the model very cautious (controls 19 of 20, the best of any edit; test cases 2), because Opus's "pick up" answers were hesitant while its "nothing" answers were sure.
- **With its labels at a fixed confidence,** the test cases matched the rule teacher (13), and the controls were weaker (11), following Opus's more permissive view of distant hostiles.

Across all five teachers the edit was a faithful copy of the teacher: its lesson, its blind spots and even its hesitation.

---

### 5.7 A second flaw, on a second model

To see whether the closed-form write holds beyond one case, it was tried on a second flaw in a different model.
- **The model:** Shelter's, Qwen2.5-3B, a different version from Gather's.
- **The flaw:** Shelter wants to dig in or wall up at midday, and sometimes says "nothing" at dusk when it should shelter.
- **The cases:** 40 daytime cases where doing nothing was right, and 40 dusk or night cases where sheltering was right, all from the logs.

| Edit (Shelter; held-out half: 20 test, 20 controls) | Test right | Controls right |
|---|---|---|
| Unedited | 7 | 11 |
| Rule teacher (the hand-written layer's own acts) | 8 | 11 |
| Random neurons | 7 | 11 |
| **Opus as teacher** | **12** | **13** |

**The rule teacher didn't replicate:** on held-out cases it did no better than random neurons. **Opus as teacher did:** both sides improved.
- **Why the difference:** Opus agreed with the rule on *whether* to shelter in every one of the 80 teacher situations, but not on *how*. The hand-written layer's acts were split three ways, depending on details of its routine the model can't see in the text. Opus taught one consistent act: dig in. A consistent lesson was easier to write in and to carry over to new situations than a correct but inconsistent one.
- **Why Shelter was harder:** at dusk the creature's situation text still begins "It is day", because Minecraft's daylight flag stays on until night. Only one trailing sentence ("Evening is here or coming") separates dusk from midday.

**Across both flaws,** Opus as teacher, with firm labels, was the most reliable of the teachers tried. Its value was judgement plus simplification, turning a complicated routine into one clear lesson: a teacher's skill rather than a surgeon's. The evidence is still small: 20 held-out cases per side, one run each.

### 5.8 One layer or five

The published method behind the solve spreads an edit over several layers, which tends to generalise better. Both flaws were re-run with the edit spread over five late layers instead of one, solved bottom-up so that each layer takes its share of the change still missing at the output.

| Held-out (test / controls right) | Unedited | One layer | Five layers |
|---|---|---|---|
| Gather, rule teacher | 7 / 15 | **13 / 16** | 9 / 18 |
| Gather, Opus teacher | 7 / 15 | 13 / 11 | 10 / 14 |
| Shelter, rule teacher | 7 / 11 | 8 / 11 | **11 / 14** |
| Shelter, Opus teacher | 7 / 11 | **12 / 13** | 10 / 14 |

Spreading the edit made it **more reliable, not better on average**:
- **Every five-layer edit improved both sides** over the unedited model, including the Shelter rule teacher that had failed at one layer.
- **The best single-layer edits still fixed more test cases.** The five-layer ones leaned toward caution.

For a nightly loop, where no one hand-picks the winning edit, the reliable version is the safer default.

## 6. Relation to other work

**The MIT report, now public.** "Sparks of Weight-Space Programming" (Takehi, Teoh, Zhang and Khattab, November 2026) and its edited checkpoint are now available. For small networks (a car-driving policy, Breakout), GPT-6 Astra wrote new weights from the raw weights in a single reply. For the Qwen model it had a budget of 50 forward passes and "located the cause and edited it out": the model's tendency to loop.

**An independent byte-level check** of the edited checkpoint (Carlos Toledo) found:
- only two weight matrices changed, the MLP output weights at layers 15 and 19;
- the edit is rank-1: one direction removed, six-fold, from 64 columns, with its strength found by trial over several values;
- the gain comes mostly from the model *finishing* its answers instead of looping, not from better reasoning;
- the 7.9% baseline is largely a settings effect: with Qwen's recommended sampling settings the unedited model scores 22–44%.

**Follow-ups appeared within two weeks:**
- WeightBench, a benchmark of 42 weight-editing tasks;
- a security study on whether models can write backdoors this way;
- a paper in which Claude Opus 5.5 edits the same Qwen model for computational biology. Its gains also came largely from the model *submitting* answers it had already computed.

**Earlier interpretability work** supplies most of the methods used here:
- describing every neuron with a stronger model (Bills et al., OpenAI, 2023);
- reading what neurons write into the vocabulary, and switching off chosen neurons to change behaviour (Geva et al., 2022);
- sparse features and steering (Anthropic, 2023–24);
- language-model agents that experiment on another model's neurons (MAIA, MIT, 2024);
- steering along directions (inference-time intervention, 2023; representation engineering, 2023).

The finding that a model can *represent* information it does not *use* has a name in the probing literature ("amnesic probing", Elazar et al., 2021).

**What is different here.** In all of this work the edited model is studied in isolation, on internet text, judged by benchmark or interpretability scores. In MindBot:
- the edited model is a layer in an embodied agent's behaviour stack;
- the neuron map is built from the agent's *own life*;
- an edit counts only if the creature behaves better on held-out situations, and beats random edits of the same size.

The pattern found matches the published work: successful edits remove a single tendency (looping, not finishing, holding back). The harder case, giving a model judgement it lacks, is where this trial's edit fell short.

---

## 7. Discussion

### 7.1 Two kinds of mind to edit

The project now contains, in one creature, two very different objects of editing:
- **Readable classifiers.** Opus reads *everything*: every weight has a name and a meaning ("animalClose → hunt"). It edits them as one might edit a recipe, and checks each change against the past moments it would affect.
- **Opaque language models.** Opus can read almost nothing directly. The 1.7B model's weights would fill about five billion tokens, thousands of times more than Opus can hold at once, and no single weight means anything on its own. Rotate the model's internal coordinates and you get a model that behaves identically with completely different numbers. Opus can work only *through instruments*: a map of which neurons fire when, and experiments that switch parts off and measure the result.

This difference is the trial's main philosophical finding. Understanding a small mind can mean reading it. Understanding a large one, for another mind, means **intervening and observing**: something closer to experimental neuroscience than to reading a text. The FreeLAB-style index helped navigate, but the knowledge that mattered came from causal tests, not from descriptions.

### 7.2 Editing versus learning

Is a mind still learning itself when another writes its connections? The trial suggests a more specific answer than yes or no.
- **What editing can do:** remove a tendency, like a surgeon removing an obstruction.
- **What it failed to do:** install a judgement, which here required the model to connect something it knows (danger) to something it does (holding back).
- **The working alternatives:** a better input (the prompt) and fixed wiring (the subsumption rule). The model's competence came from what it was given and where it was placed, not from rewritten weights.

If this pattern holds on more flaws, "learning" in the full sense (forming new connections between knowledge and action) may need the creature's own experience, through retraining on its outcomes, rather than another mind's edits.

Part 3 sharpened this. The judgement *could* be written into the weights, but only by fitting examples from the creature's own life, in one closed-form step that is a close relative of retraining. Opus's understanding of the model was real: it found the danger detectors and the day-only "hold back" groups. But in both of the later attempts that understanding didn't produce the best edit. In part 3 it pointed to a place where the fit could not work at all. Across the three attempts:
- **Steering through a tool:** no gain.
- **Surgery by understanding:** removed a habit, but broke the judgement.
- **A fit to experience:** installed the judgement.

On this evidence, a mind changes another most reliably by *teaching it from examples*, even when the lesson is written in directly. Understanding is most useful in checking and withdrawing edits, as Opus did with the classifiers, rather than in computing them.

The follow-up tests add two qualifications:
- **The method is only as good as the teacher.** A teacher that stated the creature's judgement installed that judgement. A teacher that learned from the creature's outcomes installed "pick up", because nothing in the creature's life had ever shown it the cost of gathering at night.
- **The subsumption stack shapes what can be learned.** The hand-written layers kept the creature safe, and in doing so hid from it the very evidence an upper layer would need to learn the danger for itself. A protected learner can't discover the risks its protectors spare it. Learning that from experience would need either exploration (some risky tries) or knowledge brought in from outside (a stated rule, or another mind's correction), which is exactly what Opus's night reviews provide in route B.

That is a version of an old question about learning and testimony, made concrete in a Minecraft creature: some things a mind can only know by being told. And being told, the last test suggests, has to be loud enough. A few corrections mixed into a life's worth of contrary experience were not taken up. The judgement was installed only when it was given directly as the lesson.

### 7.3 The narrator and the editor

Two of MindBot's parts are designed to raise questions about where a mind ends:
- **The narrator** tells the creature's story without knowing its causes.
- **The editor (Opus)** changes the creature's mind at night, and is configured as its own hippocampus.

If the editor is part of the mind, MindBot already modifies itself in its sleep, much as human sleep consolidates and prunes memories. If the editor is outside, MindBot is edited, not self-improving. A planned experiment makes this concrete: hand direct editing from Opus to MindBot's own local 4B model, and later train that editor on which of its edits passed the gate. That would be a small, safely bounded version of a mind that improves its own capacity to improve: the idea behind "recursive self-improvement", here in a sandbox with a gate, version history and human oversight.

---

## 8. Limitations

- **Small samples.** The trial used 40 test cases and 40 controls, split into halves of 20. Differences of 2–3 cases are noise, and several controls come from the same night.
- **One model, one flaw.** The weight-editing findings rest on a single 1.7B model and a single flaw.
- **Approximated situations.** The tick logs don't record which blocks were nearby, so "break the block ahead" was offered in every case and logs to break weren't reconstructed.
- **Quantisation.** The sandbox model was 4-bit (the same as the live one), with edits kept as full-precision patches rather than written into the weights.
- **Short history for learned layers.** The learned layers have had only a few days of the fixed creature to learn from; that they haven't passed their gates may change with more data.
- **No ablation across days yet.** The plan to explain changes across days by rolling back a layer for a day has not been run, because no learned layer has yet been served.

---

## 9. Where the project is headed

**Next session:**
1. **Restart the creature.** This also turns on the new Gather rule and prompt.
2. **Follow up the closed-form write:**
   - more "hostile close" teacher situations, and firm labels from Opus or the creature's rules;
   - more "hostile close" examples;
   - then the rule-taught edit in shadow mode on the live creature.
3. **Edit plus rule, in the sandbox:** score Opus's neuron edit together with the live Gather rule. If the rule removes the side effects and keeps the gain, run the edited model in shadow on the live creature for a day or two: weight editing and Brooks-style wiring working together.
4. **Morning check** of the day metrics, the night reviews, and how often the model layers agree with the hand-written ones.

**This week:**
5. **A third flaw, and repeats:** the two flaws so far rest on one run each with 20 held-out cases per side. Repeating them with more cases, and adding a third flaw (for example Make setting its crafting table down whenever it carries one), would show how reliable Opus-as-teacher is.
6. **Outcome labels and a gate for the language-model layers,** so a retrained or edited model can ever be trusted with the body.
7. **More days of the fixed creature,** so the learned bottom layers have enough to learn from and the day-by-day measures have a baseline. This is the project's core result.

**Later, needing decisions:**
8. **Retraining the language-model layers during sleep** (stage 7). This requires installing a fine-tuning library, and a check of Anthropic's terms, since the layers would learn from Opus's corrections.
9. **A local editor:** MindBot's own 4B model takes over direct editing of the readable layers, and is later trained on which of its edits passed. This tests where the editor ends and the mind begins.
10. **Smaller fixes:** for example, don't seal in under water.

**Paused on purpose:** deeper weight-editing research (cleaner units from sparse autoencoders, many more rounds). It's a research project in its own right, and the cheaper levers (input and wiring) gave most of the behavioural gain.

---

## Appendix A. Glossary

- **Ablation:** switching off part of a system (a layer, a group of neurons) to see what changes.
- **Embedding:** a list of numbers representing the meaning of a text, so that similar texts have similar numbers; used here to retrieve memories and units.
- **Forward pass:** one run of a model on an input, producing its output probabilities.
- **Gate:** the test a changed layer must pass (beating the hand-written layer on held-out data) before it may act.
- **Held-out data:** cases kept aside and never used to make or choose an edit, used only to judge it.
- **MLP neuron:** one unit in a transformer layer's feed-forward block. Each layer of the Gather model has 6,144.
- **Quantisation (4-bit):** storing a model's weights in fewer bits to save memory.
- **Shadow mode:** a new layer's choices are logged beside the acting layer's, but don't control the body.
- **Steering:** adding a direction to a model's internal activations to push its behaviour.
- **Subsumption architecture:** Brooks's design of stacked behaviours in which higher layers suppress lower ones.
- **Weight-space programming:** a model editing another model's weights directly, without training.

## Appendix B. Where things are

- **Design:** `docs/design-subsumption.md` (main design and status of every stage), plus the earlier design docs in `docs/`.
- **Results:**
  - `docs/results-days.md` (day metrics);
  - `docs/results-layers.md` (gates);
  - `docs/results-7b-trial.md` (the weight-editing trial in full);
  - `docs/results-say-vs-do-2026-11-17.md` and `docs/results-cortex-eval-2026-11-17.md`.
- **The creature's vault:** `Lab/` holds notes for readers (Days, Learned Layers, Night Reviews, Weight Edit Trial, Progress and Direction); MindBot never reads it.
- **Code:**
  - `agent/src/brain/layers.js` (the stack);
  - `agent/src/brain/modelLayers.js` (language-model layers);
  - `agent/src/learn/` (classifiers, nightly learning, editing);
  - `agent/src/vault/memory.js` (memory);
  - `agent/src/cortex/` (the model service and the weight-editing trial tools).
- **Commands:**
  - `windows\start-all.bat` (start everything);
  - `npm run sim` (tests);
  - `npm run days` (day metrics);
  - `npm run train-layers` (fit and gate the classifiers).
