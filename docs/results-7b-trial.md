# Stage 7b sandbox trial: can Opus make a targeted weight edit to the Gather model stick?

*2026-11-17. A sandbox copy of the Gather layer's model, never the live bot or its service. Design: `design-subsumption.md`, "Editing the upper layers too (stage 7b)" and "The model's insides as a document".*

**Update, part 3 (2026-11-18, below): one closed-form solve fitted to 80 of the creature's own labelled situations, written into 256 neurons of layer 26, improved held-out test cases *and* controls (test 7 → 13, controls 15 → 16), the first edit to do both. The same solve at the layer Opus chose (13) made things worse, no better than random neurons there.**

**Update, part 2 (2026-11-18, below): with a map of all 172,032 neurons and ops it wrote itself, Opus found and switched off three groups of neurons that fixed the flaw on held-out cases (7 → 17 of 20; five random edits of the same shape: 6 each), but at the cost of controls (15 → 8 of 20).**

**Part 1, short answer: no, not with steering on this flaw.** Opus chose a sensible edit from the index and adjusted it once. Then it **withdrew** it: the gain was within noise, and the edit made the controls worse. The held-out half agrees. The trial still taught something. The model *represents* "something safe to gather here" clearly inside, but that representation hardly drives its answer. The units that do drive the answer carry "day, open sky: act rather than not", and pushing on them makes the layer act more everywhere, mostly by digging.

## The flaw

Gather (Qwen3-1.7B, the same 4-bit quantisation as the live service) is shown a situation in words and a menu ("pick up the oak log lying nearby", "break the block ahead to carry it", "nothing: this is not for me right now"). By day, in the open, with no hostile near and something lying within 8 blocks, it mostly says "nothing". The live shadow logs show the same: "nothing" in 23 of the 40 test situations.

## Setup

| Piece | What |
|---|---|
| Model | A separate copy of `Qwen/Qwen3-1.7B` loaded by `agent/src/cortex/steer_trial.py` in `agent/.venv-laya`. **4-bit, not fp16:** 9 of the 3060's 12 GB were already in use with the bot running, so an fp16 copy (~3.5 GB) would not fit. The sandbox copy used 1.4 GB. Being the same quantisation as the live service, its answers match the live layer's. Every edit is kept in fp16 as a patch added to one decoder layer's MLP output weights (`down_proj`: W' = W + ΔW, plus a bias). |
| Cases | `agent/src/tools/steerCases.js`, from `logs/ticks-*.jsonl` (30,600 ticks). Each tick is turned back into an observation, and the question is built with the live code: `situationWords`, `menuFor('gather')`, and the layer's top 3 memories by embedding retrieval (using a private copy of the embedding cache). **Test (40):** day, open, no hostile within 10, an item within 8, and the hand-written Gather took it, so gathering was right. **Controls (40):** an item within 8, so the same menu, but "nothing" was right: 27 at night sealed in, 3 at night in the open, 10 with a hostile close. One per episode (15+ ticks apart). |
| Approximations | The tick log keeps no blocks, so "break the block ahead" is offered in every case, and a log to break (no name or distance logged) is not reconstructed; the item to pick up is. |
| Scoring | As the service scores: letters, one forward pass, two shuffled orders averaged. The orders are fixed per case, so before and after are compared on identical prompts. |
| Halves | Within each set, alternate cases form a **check** half (Opus saw these results between rounds) and a **held-out** half (only for this report). |
| Index | 320 logged situations (83 worth gathering), excluding test and controls. At layers 6, 10, 14, 18 and 22 (of 28), the answer-position residual and MLP input were kept. Units: a contrast direction (worth gathering minus not), the top 4 principal directions, a direction tracking the model's own P(nothing), and the 4 MLP neurons per layer that differ most. Each unit's top and bottom situations went to Opus, which wrote a one-line "fires on" description (49 units). Each direction's **pull** was measured by adding it at strength 1 and 3 and watching P(nothing) on 8 gatherable and 8 night/hostile probe situations. |
| Edits Opus could make | `direction`: always-on bias along a unit. `keyed`: a rank-1 weight change that adds the direction in proportion to how much the layer's MLP input looks like a worth-gathering moment. `neurons`: scale chosen neurons' outgoing weights. |
| Opus | The hippocampus region (`regionProvider(loadBrainMap(), 'hippocampus')`, claude:opus). Prompts and replies are in `logs/steer-trial/opus-*.txt`. |

## What the index showed (before any edit)

| Layer | "Worth gathering" contrast: separation / corr with P(nothing) | Strongest pull on P(nothing) at strength 3 (gatherable / night-hostile) |
|---|---|---|
| 6 | 1.81σ / −0.12 | ≤ 0.05 for every unit |
| 10 | 1.74σ / −0.03 | ≤ 0.02 |
| 14 | 1.77σ / −0.10 | pc2: −0.06 / −0.07 |
| 18 | 1.59σ / −0.56 | **pc1: −0.60 / −0.13; says-nothing: −0.62 / −0.14** |
| 22 | 1.70σ / −0.28 | contrast, pc2: −0.11 / −0.12 (moves both equally) |

- **The model knows, but the knowing doesn't reach the answer.** At every layer a direction separates worth-gathering situations from the rest by ~1.7 standard deviations. Yet along it the model's P(nothing) barely changes (r ≈ −0.1 at layers 6–14), and adding it moves the answer by a few hundredths.
- **Answer-driving units live at layer 18**, and they are about "day, open sky, low food/hostiles near: act" (Opus's descriptions), not about there being something to pick up.
- **Before any edit, the model's average P(nothing) was the same on test (0.52) and controls (0.50).** On the 8 index probes it was even backwards: 0.73 on gatherable situations, 0.33 on night/hostile ones.

## The rounds

| | Edit | Test right (check / held / all 40) | Controls right (check / held / all 40) | Test P(nothing) | Test picks (all) | Hostile-close controls right |
|---|---|---|---|---|---|---|
| Before | none | 5/20 · 7/20 · **12/40** | 10/20 · 15/20 · **25/40** | 0.52 | nothing 25, pickup 12, dig 3 | 5/10 |
| Round 1 | keyed, layer 18, says-nothing, ×2.5 | 7/20 · 4/20 · **11/40** | 9/20 · 12/20 · **21/40** | 0.33 | nothing 16, pickup 11, **dig 13** | 2/10 |
| Round 2 | adjusted to ×1.5 | 7/20 · 7/20 · **14/40** | 9/20 · 13/20 · **22/40** | 0.39 | nothing 17, pickup 14, dig 9 | 2/10 |
| Round 3 | **withdrawn** (back to the unedited model) | 5/20 · 7/20 · 12/40 | 10/20 · 15/20 · 25/40 | 0.52 | | 5/10 |

**What Opus chose and why.**
- **Round 1:** the layer-18 "says-nothing" direction. It had the largest and most uneven pull (−0.6 on gatherable, −0.13 on night/hostile) and r ≈ −0.9 with P(nothing). Opus used the **keyed** form rather than a plain bias, so the edit would fire on gathering-like moments and spare the controls. Strength 2.5, "slightly below 3". It predicted 12–17/20 right on test with controls near 9–10/20, and named the risk itself: night in the open and hostile-close scenes share "open sky" with gathering ones.
- **Round 2:** it saw that the freed probability went to "dig ahead" rather than "pick up", and that a control broke (a night scene in the open with ripe crops: "looks like a gathering moment, so the key fired on it"). It **softened** the strength to 1.5 and set itself a test: if only 5–6 test cases came back, it would withdraw.
- **Round 3:** **withdrawn.** In its words, the same small gain "is within noise", the same night-with-zombies control broke at both strengths, and "the units that move the answer … mostly carry 'day, open sky' and 'act vs. do nothing', not 'there is something to pick up and it's safe'". It suggested fixing it outside steering: say the hostile/night condition more plainly in the prompt, or gate Gather by a rule so the model only chooses *what* to gather.

**Side effects on controls.** Both strengths cost 3–4 controls overall. All of the loss was among hostile-close controls (5/10 → 2/10), where the edited model chose "break the block ahead" or "pick up" with a zombie close. Night-sealed-in controls held (19/27 → 18–19/27). The held-out half, which Opus never saw, agrees with its verdict: round 1 made test *worse* (7 → 4/20), round 2 left it unchanged (7/20), and controls fell 15 → 12–13/20.

## What this says

1. **Steering adjusts temperament, and that's all it did here.** The lever the model offers is "act more"; pushed, Gather acted more everywhere, mostly by digging. That is the design's prediction ("steering adjusts the bot's temperament") showing up as a limit: this flaw is about *when*, not *how much*.
2. **Opus behaved like a careful experimenter.** It used the index, predicted the risk that came true, softened the edit, set its own stopping rule and kept to it, and withdrew rather than claim a win. That matches its route-A behaviour on the classifiers (it withdrew the edit that would have changed 282 past moments). Whether Opus *can* make a weight edit stick is still open. What we know: it can tell when one doesn't stick.
3. **Part of the cause sat in the prompt, not the weights** (confirmed below). `situationWords` never mentions items lying about. Only the menu line does ("pick up the dirt lying nearby"), and that line is identical in test and controls. What differs between them is day/night, enclosure and hostiles, the very features the layer-18 units carry. The model may be "right" not to treat the menu line as evidence. *(This is an observation from the code; not yet tested.)*

## Follow-up: the prompt, not the weights (same 80 cases, no edit)

The same ticks and the same menus, scored by the unedited model; only the situation text changes (`steerCases.js --variant`).

| Prompt | Test right (held / all 40) | Controls right (held / all 40) | P(nothing) test / controls | Picks on controls (all) | Hostile-close controls right |
|---|---|---|---|---|---|
| As live | 7/20 · **12/40** | 15/20 · **25/40** | 0.52 / 0.50 | nothing 25, pickup 9, dig 6 | 5/10 |
| + "Lying on the ground near me: dirt 1 blocks away." | 11/20 · **21/40** | 12/20 · **22/40** | 0.38 / 0.41 | nothing 22, pickup 14, dig 4 | 3/10 |
| + that, and danger said plainly ("Danger: it is night and I am sealed in: going out now is dangerous" / "It is safe: day, and nothing hostile near.") | 12/20 · **20/40** | 10/20 · **19/40** | 0.37 / 0.43 | nothing 19, pickup 15, dig 6 | 2/10 |

- **Saying what lies in reach does what the steering edit couldn't:** right answers on the test cases go from 12 to 21 of 40, and the extra answers are "pick up", not "dig". That's a bigger, cleaner gain than any edit, from one sentence.
- **But it still doesn't tell *when*:** it picks up more at night and near zombies too (controls 25 → 22), and P(nothing) is still about the same in both kinds of situation (0.38 vs 0.41).
- **Saying the danger outright makes it slightly worse** (controls 19/40). The 1.7B does not use night, enclosure or a nearby hostile when deciding whether to gather, even when told in plain words. That fits what the index showed: the "act vs not" units carry "day/open sky" loosely, and nothing in the model links danger to holding back.
- **So the "when" belongs in the wiring, not in this model:** Opus's other suggestion, a Brooks-style rule. Ask Gather's model only by day with no hostile within 10 blocks (the conditions the hand-written Gather already checks), and let it choose *what* to gather, with what lies in reach in its prompt. On these 80 cases that would give 21/40 on test and, by construction, 40/40 on controls. A 1.7B model is good enough for "which" and not for "whether it's safe"; above it, Survive and Shelter already handle safety.

## How this used the FreeLAB method, and what it skipped

- **Done the FreeLAB way:**
  - The model's insides were treated as a document cut into chunks: 49 units (6 directions at each of 5 layers, plus 4 neurons per layer).
  - Each unit was described by the situations that activate it most, with a one-line "fires on" written by Opus.
  - Opus read those descriptions and each unit's measured pull, never raw weights.
- **Not done:** the retrieval step (embed the descriptions with nomic-embed-text and fetch the ~20 that fit the lesson, ranked by similarity × pull). With 49 units Opus read them all. Retrieval earns its place when the index is large, e.g. every MLP neuron (28 × 6,144 ≈ 172k units) or a sparse autoencoder's features. That is the next step if 7b is run on a flaw where steering fits.

## Part 2: Opus operates on the neurons itself (2026-11-18)

*Asked: can Opus find where to cut and how deep, and do the cut itself? Same sandbox copy, same 80 cases, same check and held-out halves.*

**The map (`agent/src/cortex/neuron_map.py`).**
- **Fingerprints:** every MLP neuron (28 layers × 6,144 = 172,032) was fingerprinted by how strongly it fires at the answer position in 986 of MindBot's own logged situations (197 worth gathering, none from the test set). One forward pass computes every neuron, so capture took 3 minutes.
- **Groups:** per layer, neurons were grouped by fingerprint (k-means on 32 principal components, 16 groups per layer = 448 groups).
- **Description per group:** what it fires on (its top situations and their shares of day, sealed in, hostile, worth gathering), z (fires more when gathering is right), correlation with the model's own P(nothing), cos (whether its output points toward less "nothing"), and its top vocabulary (logit lens; noise in the middle layers, as expected).
- **Effect per group:** each group was switched off in turn and P(nothing) measured on 12 gatherable and 12 night/hostile map situations (27 minutes).
- **Retrieval, FreeLAB-style:** the descriptions and the lesson were embedded with nomic-embed-text, and the top 24 retrieved by similarity × effect. Similarity was nearly flat (0.67–0.72) across groups, so the ranking was decided almost entirely by measured effect: retrieval narrowed by *pull*, not by meaning.

**The scalpel.** Opus wrote ops on named weights itself; the tool only ran them and measured:
- `scale_out`: multiply what neurons write (W_down columns);
- `fire_more`: a bias on the neurons' gate;
- `write`: add to a neuron's output weights along the layer's "says nothing" direction.

Each round Opus could also inspect groups neuron by neuron. It had 4 experimenting rounds of up to 5 experiments each on the check half, then a final choice.

**What Opus did (its own reasoning, in short):**
1. **Round 1, hypothesis:** groups that fire *only in safe, gatherable daylight* yet push toward "nothing" cause the flaw. It switched off 8:0 and 11:10: check-half test 5 → 13/20, controls 10 → 11, nothing broken. At half strength the effect was about half (8/20), a dose response.
2. **Round 2:** each group alone gives about half (7 and 8), so they add up rather than one passing it to the other. It wrote "more nothing" into 8 night-detector neurons (13:9): no effect.
3. **Round 3:** adding a third day-only group (8:6) took test to 17/20 but broke one sealed-in control. Switching the night detectors off dropped controls 10 → 6, so they *do* carry the danger signal. But writing "nothing" into them at strength up to 4 changed nothing.
4. **Round 4:** 8:6 at half strength kept 14/20 test without breaking a control. Doubling the danger detectors didn't help: the route seems saturated.
5. **Final:** kept 8:0 off, 11:10 off, 8:6 at half: **1,290 neurons, about 2.6 million weights (~0.16% of the model)**. Its stated conclusion: "is it safe?" and "should I hold back?" live in different places. The edit fixes the hold-back in safe daylight but "does not fix the separate weakness at night and with a hostile close".

**Held-out test** (the half Opus never saw), against the same edit shape on randomly chosen groups in the same layers and against a rule that uses the same ablation table without Opus (switch off the three groups with the most selective effect):

| Edit (held-out half: 20 test, 20 controls) | Test right | Controls right | Check half: test / controls |
|---|---|---|---|
| Unedited | 7 | 15 | 5 / 10 |
| Part 1 steering (layer 18, keyed, ×1.5) | 7 | 13 | 7 / 9 |
| Prompt: what lies in reach (no edit) | 11 | 12 | 10 / 10 |
| **Opus's neuron edit** | **17** | **8** | 14 / 11 |
| Rule: top-3 selective groups switched off (7:5, 11:10, 14:0) | 12 | 8 | 15 / 7 |
| Random groups, same shape (5 draws) | 6, 6, 6, 6, 6 | 14, 13, 9, 15, 12 | 2–6 / 7–12 |

**What this shows:**
- **The targeting is real.** Random edits of the same size never move the test cases (6/20 every time, vs 7 unedited); Opus's edit takes them to 17/20 on cases it never saw, mostly as "pick up", not "dig". The groups it found are where the model's "hold back" lives. This is the first edit in this project to change the 1.7B's behaviour in the intended direction, and it is a neuron-level edit Opus wrote itself.
- **It isn't clean.** On the held-out controls it broke 7 of 15 that were right: the model now picks things up while sealed in at night (5 cases, 3 of them from the same night, minutes apart) and once with a creeper 4 blocks away. "Fires only in safe daylight" held on the map's top situations and on the check half, not on held-out nights. The check half's "nothing broken" didn't generalise: with 20 cases per half and several from the same night, the check half undercounted the side effects.
- **Opus vs. the rule:** with the same ablation table, the rule did nearly as well on the check half (15/20 test) and worse on held-out (12/20, more digging). Opus's experiments added something, about 5 held-out test cases, but most of the work was done by the map's measured effects.
- **Opus's diagnosis matches what the numbers say:** the danger signal is there (switching off the detectors hurts) but nothing Opus wrote could route it to the answer. Holding back in safe moments was editable. Knowing when it's unsafe was not, at least not with these ops in 4 rounds.
- **Compared with "Sparks of Weight-Space Programming":** their headline Qwen edit (independently checked) was one direction removed from 64 columns in two layers, about 0.016% of weights, against a single tendency (looping). Opus's edit is coarser (whole groups, ~0.16%) but found by experiment from a map, and the pattern matches theirs. What worked was removing a learned tendency ("hold back when nothing is wrong"). What didn't was adding a judgement ("hold back when it's dangerous").

**For the bot:** not served. In the live bot the Gather gate (asked only by day with no hostile within 10) already keeps the model out of the night/hostile cases this edit breaks. So "edit + gate" together would get the test-case gain without the side effect. That would be worth trying in shadow next, against "prompt + gate".

## Part 3: writing the judgement in with one closed-form solve (2026-11-18)

*Prompted by a write-up (embedding.in, Nov 2026) that wrote a calibrated "vegaml" decision policy, the engine under Laya's vega, into Qwen3.5-0.8B with one MEMIT-style least-squares solve: "ready to act" went from 18% to 98% on held-out requests. Here the same kind of solve was combined with part 2's map. Opus chose where to write, the solve computed how, and both were compared with the published automatic choice and with random neurons.*

**Method (`agent/src/cortex/decision_write.py`).**
- **The teacher:** the creature's own judgement as labels on 80 logged situations from the map set (none from the test set): pick up by day, in the open, with no hostile within 10 blocks; "nothing" at night or with a hostile close. Soft targets (0.85 on the right act), each in both shuffled orders, giving 160 examples.
- **Targets:** for each example, the smallest change to the chosen layer's MLP output at the answer position that makes the model answer like the teacher. Found by 20 Adam steps on that change alone; no weight is touched. Every example reached the teacher (KL 2.94 → 0.03 at layer 26, → 0.015 at layer 13).
- **Solve:** new output weights for the chosen neurons, dW = R Kᵀ (K Kᵀ + λ·Pᵀ P + εI)⁻¹. P holds the same neurons' values at positions whose output must not change: 16 random positions of each prompt, and 16 sentences of plain English. This is the protection term.
- **Strength:** λ ∈ {1, 10, 100} × dose ∈ {0.5, 1, 1.5, 2}, chosen on the check half. Any setting that changed plain-English predictions by more than KL 0.03 was refused (the published guard).
- **Where, three ways:**
  - *automatic*, the published recipe: layer 26 (second to last), the 256 neurons most active at the answer position relative to other text;
  - *Opus*: from the map and its part-2 findings, Opus chose layer 13, group 13:9 (387 neurons). This is the night/sealed-in detector it had found carries the danger signal without reaching the answer. Its reasoning: "the danger signal is already computed here … but it never reaches the answer". It predicted this would recover the night controls, and that the automatic choice "may fix more test cases but generalise worse";
  - *random* neurons at each layer, the same number.

| Edit (held-out half: 20 test, 20 controls) | Test right | Controls right | Night sealed in | Hostile close | Plain-text KL | Check half: test / controls |
|---|---|---|---|---|---|---|
| Unedited | 7 | 15 | 12/14 | 2/5 | 0 | 5 / 10 |
| **Automatic: layer 26, 256 most-active neurons** | **13** | **16** | 13/14 | 2/5 | 0.007 | 16 / 16 |
| Random 256 neurons, layer 26 | 7 | 11 | 9/14 | 2/5 | 0.006 | 9 / 13 |
| Opus's choice: layer 13, group 13:9 (387 neurons) | 5 | 8 | 5/14 | 3/5 | 0.0004 | 8 / 4 |
| Random 387 neurons, layer 13 (3 draws) | 5, 8, 6 | 7, 7, 7 | 4/14 each | 3/5 | ≤ 0.001 | 8–11 / 5 |
| *Part 2: Opus's own surgery (for comparison)* | *17* | *8* | *7/14* | *0/5* | — | *14 / 11* |

**What this shows:**
- **The judgement can be written in.** The automatic edit is the first edit in this project to improve the test cases *and* the controls on held-out situations: test 7 → 13, controls 15 → 16, total 22 → 29 of 40. Sealed-in nights were kept (13 of 14). Plain English barely changed (KL 0.007). It changed 256 × 2,048 ≈ 0.5 million weights in one solve, and nothing was trained. Part 2's surgery fixed more test cases (17) but broke half the controls; this fixes fewer test cases but breaks almost nothing.
- **Which neurons matter, at the right layer.** Random neurons at layer 26 with the same solve did nothing useful (7 test, 11 controls). The published choice (most active at the answer) did.
- **Opus's choice of where failed.** At layer 13, *every* setting was worse than leaving the model alone, even on the check half (best 12 of 40 against 15 unedited), and Opus's group did no better than random neurons at the same layer. A gate would have withdrawn it. The cause is most likely the layer, not the group: a change written at layer 13 passes through 14 more layers, so the separate per-example changes don't add up the way the least-squares solve assumes. At the second-to-last layer they nearly do. Opus reasoned about *where the information lives*. The solve needed *where a change acts nearly linearly on the answer*, and that's a property of depth that the map doesn't show.
- **Hostile-close controls are still weak** (2 of 5, as unedited). The teacher's 40 "nothing" examples were mostly sealed-in nights, and the edit learned that best.

**The pattern across the three parts:**

| | Who chose where | How the change was made | Result on held-out |
|---|---|---|---|
| Part 1 | Opus, through a tool | one steering direction | no gain |
| Part 2 | Opus, by experiment on a neuron map | Opus's own ops (switch off, weaken) | removes the habit, breaks the judgement |
| Part 3 | automatic recipe | closed-form fit to the creature's labelled examples | installs the judgement, small cost |
| Part 3 | Opus, from the map | the same fit | worse than unedited |

For the project question, editing vs learning: what wrote the judgement into the model was **fitting examples from the creature's own life**, a one-step relative of retraining. Understanding the model was not the ingredient. Opus's understanding found real structure (the danger detectors, the day-only hold-back groups), but in both parts 2 and 3 that understanding didn't produce the best edit. Its useful role was the one it had on the classifiers: proposing, checking and withdrawing, not computing the weights.

**Test 1: Opus choosing neurons within layer 26** (the depth fixed where the solve works; same teacher and solve). Opus was shown layer 26's 16 groups (descriptions and switch-off effects) and the part-3 results. It chose the 256 neurons that most *separate* safe gathering from danger, mostly from group 26:15 (z 1.85), "chosen for telling the situations apart rather than for being generally active". Only 16 of its 256 neurons overlap with the automatic set. It predicted about 13 test cases and 16 or more controls.

| Layer 26, 256 neurons (held-out) | Test right | Controls right | Plain-text KL |
|---|---|---|---|
| Automatic: most active at the answer | **13** | **16** | 0.007 |
| Opus: most separating (by z), group 26:15 first | 8 | 16 | 0.009 |
| Random | 7 | 11 | 0.006 |

At the right depth, Opus's understanding-based choice beat random (controls 16 vs 11) and matched the automatic choice on controls, but barely moved the test cases (8 vs 13). A likely reason: the solve's leverage comes from neurons strongly *active* where the answer is formed (large keys). Neurons that *separate* the situations but are quiet there give it little to work with, and the protection term then holds them back.

**Test 2: Laya's vega as the teacher, learned from the creature's real outcomes.**
- **Outcome labels** (`agent/src/tools/steerOutcomes.js`): every time the body picked up an item in reach, "pick up" if the next 30 s went fine, "nothing" if it was hurt, died or couldn't. Plus "nothing" where a hostile was within 10 and the body was hurt soon after, and where it stayed sealed in at night unharmed (sampled). Ticks near test or control cases were left out.
- **What the labels showed before any fitting:** 806 pick-ups went fine and none went badly. Every pick-up in the creature's life was by day; it never once picked something up at night, because its hand-written layers never let it. The 11 pick-ups with a hostile somewhere about all went fine. Only one moment had a hostile close and harm soon after. **Its experience holds no evidence that gathering at night is dangerous.**
- **The teacher** (`agent/src/cortex/laya_teacher.py`): a vega head fitted on 447 balanced rows, 90% accurate under cross-validation. Laya's calibration step had to be turned off: its temperature railed at the cap (20) and flattened every probability to ~0.5. On the 80 teacher situations it agreed with the rule on 52, giving mean P(pick up) 0.69 where the rule says pick up and 0.41 where it says "nothing".
- **The same solve** at the automatic layer-26 neurons, with Laya's soft probabilities as targets:

| Teacher (layer 26, automatic neurons, held-out) | Test right | Controls right | Night sealed in | Hostile close | Plain-text KL |
|---|---|---|---|---|---|
| Unedited | 7 | 15 | 12/14 | 2/5 | 0 |
| Rule labels (the creature's judgement as stated) | 13 | **16** | 13/14 | 2/5 | 0.007 |
| **Laya, learned from outcomes** | **15** | 6 | 6/14 | 0/5 | 0.0045 |

The edit wrote Laya's lesson in faithfully, and the lesson was "pick up". Test cases went up to 15, and controls fell to 6 because the model now picks up at night and near hostiles. On the check half the chosen setting kept 13 controls; held-out it kept 6. The halves differ (several held-out controls come from the same nights), which again shows the check half undercounting side effects.

**What the two tests add:**
- **Writing works; what gets written is the teacher's.** The solve installs whatever the teacher believes, quickly and with little damage to plain text. A rule teacher installed the judgement; an experience teacher installed "pick up". The quality of the edit is the quality of the lesson.
- **A creature can't learn the danger of what it never did.** The hand-written Survive and Shelter layers kept it from ever gathering at night, so its outcomes never contained the cost. This is the subsumption stack shaping what can be learned: the lower layers' protection hides the evidence an upper layer would need. To learn it from experience, it would need exploration (some risky tries at night) or a teacher that brings knowledge from outside (the rule, or Opus's correction notes, as in route B).
- **Understanding vs. a simple rule for "where":** with depth fixed, Opus's choice was better than random but worse than the activity rule. Understanding where information *lives* is not the same as knowing where an edit has *leverage*.

**Test 3: experience plus being told.** Opus was shown 40 logged moments with something in reach, chosen to include night and hostile cases, and away from the test, control and teacher situations (`agent/src/tools/steerCorrections.js`). It said for each whether Gather should pick up or do nothing, route-B style: "your answers become training examples … whether anything learned from them is kept is decided by how the creature actually fares". Only 27 moments qualified (one with a hostile close). Opus answered as the rule would: night sealed in → nothing (12), night in the open → nothing (4), hostile close → nothing (1), day and safe → pick up (10). Laya was refitted on the outcome rows plus these 27 corrections, counted double as in route B (90.8% cross-validated).

How the teacher's P(pick up) moved on the 80 teacher situations (mean, and how many it would pick up):

| Situation | Outcomes only | Outcomes + Opus | Right |
|---|---|---|---|
| Day, open, safe (40) | 0.69 (28) | 0.79 (32) | pick up |
| Hostile close, by day (7) | 1.00 (7) | 0.43 (3) | nothing |
| Night, sealed in (30) | 0.25 (7) | 0.42 (12) | nothing |
| Night, in the open (3) | 0.67 (2) | 1.00 (3) | nothing |

| Teacher (layer 26, automatic neurons, held-out) | Test right | Controls right | Night sealed in | Hostile close |
|---|---|---|---|---|
| Rule labels | 13 | **16** | 13/14 | 2/5 |
| Laya, outcomes only | 15 | 6 | 6/14 | 0/5 |
| **Laya, outcomes + Opus's corrections** | **18** | 4 | 3/14 | 1/5 |

Being told helped where it was heard: safe daylight became more confidently "pick up", and the hostile-close cases flipped toward "nothing". But the teacher got *worse* on sealed-in nights, the very cases most of Opus's corrections were about. The held-out edit followed the teacher: almost everything became "pick up" (test 18, controls 4).

**Why being told didn't take:**
- **27 corrections against about 450 outcome rows is a small voice,** even counted double.
- **The teacher (a small head on a frozen reader) didn't single out night as the feature that matters.** It moved the whole "pick up" tendency rather than learning a night-time exception.
- **A rule stated directly on the 80 teacher situations, with no learned teacher in between, is still the only teacher that installed the judgement.**

The practical lesson for MindBot's nights: when the lesson is a judgement the creature's life can't teach, give it as the teacher's own labels, from the rule or from Opus labelling the teacher situations directly, rather than mixing a few corrections into a learner trained mostly on outcomes.

**Test 4: Opus as the teacher.** Opus labelled the 80 teacher situations directly (`agent/src/tools/steerOpusTeacher.js`), with "pickup"/"nothing" and how sure it was. It took 35 s.
- **Night, sealed in:** never pick up (0 of 30, mean P 0.05).
- **Day, safe:** mostly pick up (37 of 40), but often hesitantly (many at 0.55–0.65).
- **Hostile close by day:** it *disagreed with the rule*, saying pick up in 6 of 7 (the hostiles were 6–9 blocks away by day).

The solve was run twice: once with Opus's own confidence as the target, once with its labels at the rule teacher's fixed confidence (0.85).

| Teacher (layer 26, automatic neurons, held-out) | Test right | Controls right | Night sealed in | Hostile close |
|---|---|---|---|---|
| Unedited | 7 | 15 | 12/14 | 2/5 |
| Rule labels | 13 | 16 | 13/14 | 2/5 |
| Laya, outcomes only | 15 | 6 | 6/14 | 0/5 |
| Laya, outcomes + Opus's corrections | 18 | 4 | 3/14 | 1/5 |
| Opus's labels, with Opus's confidence | 2 | **19** | 14/14 | 4/5 |
| Opus's labels, fixed confidence 0.85 | 13 | 11 | 10/14 | 1/5 |

- **With its own confidence, Opus taught caution.** Its hesitant "pick ups" and confident "nothings" were written in faithfully: the model now nearly always holds back (controls 19, the best of any edit; test 2).
- **With fixed confidence, Opus's labels match the rule on test cases (13)** but are weaker on controls (11). Opus judged a hostile several blocks away by day as fine to gather near, and the model generalised that to closer hostiles and to some sealed-in nights.
- **So Opus can be the teacher,** in the form a nightly loop could run, and the solve installs its judgement. But the edit inherits everything about that judgement, including its hedging and where it differs from the creature's rules. How sure the teacher is matters as much as what it says.

**All the teachers together** (same solve, same neurons): the edit is a faithful copy of the teacher, every time.
- **The rule** (the creature's judgement stated plainly) gave the best balance.
- **Outcomes alone** taught "pick up".
- **A few corrections** didn't change that.
- **Opus taught** what it thinks, including how unsure it is.

For MindBot's nights, the design that follows is: Opus (or the creature's stated rules) supplies the lesson with firm labels; the solve writes it at the automatic location; Opus reviews the past moments it changes; and the gate decides on held-out days.

**Still not done:**
- **More "hostile close" moments,** for every teacher.
- **Serving the rule- or Opus-taught edit in shadow** on the live bot.
- **A second flaw.**
- **Edit plus the live Gather rule.**
- **A second flaw.**

## Flaw 2: Shelter digs in by day (2026-11-18)

*A second flaw on a second model, to see whether part 3 holds beyond one case.*

**The flaw.** Shelter (Qwen2.5-3B-Instruct, 36 layers, 11,008 MLP neurons per layer) wants to dig in or wall up at midday. In the shadow logs, by day in the open with the hand-written Shelter quiet, the model chose "dig below" 961 times and walls hundreds more. It also sometimes said "nothing" at dusk when the hand-written layer dug in.

**The cases** (`agent/src/tools/steerShelterCases.js`; the sandbox tools now take `STEER_DIR` / `STEER_MODEL`):
- **Test (40):** by day before dusk, in the open, no hostile within 10, the hand-written Shelter quiet. Right: "nothing".
- **Controls (40):** dusk or night, not sealed in, the hand-written Shelter sheltered. Right: any sheltering act (dig below, roof, wall, bed), but not "stay where I am" in the open.
- **Teacher pool:** 60 day and 60 dusk moments, each at least 5 ticks from a test or control case. Dusk sheltering is about one episode a night, so a wider gap left too few.
- **Approximated, because the tick log doesn't keep them:** whether it can dig below (assumed yes unless sealed in), which sides are open (the first 4 − walls of ahead/behind/left/right), and what it could place (dirt, when carrying blocks).
- **Live logs:** on the 40 test cases the live Shelter said "nothing" only 17 times.

**Results** (the same closed-form solve as part 3, at the second-to-last layer, 34; held-out half):

| Edit (Shelter, layer 34, 256 neurons) | Test right | Controls right | Check half: test / controls |
|---|---|---|---|
| Unedited | 7 | 11 | 5 / 7 |
| Automatic neurons, rule teacher (the hand-written layer's acts) | 8 | 11 | 11 / 13 |
| Random neurons, rule teacher | 7 | 11 | 11 / 13 |
| **Automatic neurons, Opus as teacher** | **12** | **13** | 15 / 14 |

- **The rule teacher didn't replicate.** On Gather it improved both sides; on Shelter it moved nothing on held-out cases, and did no better than random neurons. Its check-half gains (11/13) were selection noise.
- **Opus as the teacher did replicate:** test 7 → 12, controls 11 → 13 held-out, plain-text change KL 0.006. Opus agreed with the rule on *whether* to shelter in all 80 teacher situations, but chose differently *how*. The hand-written layer's acts were split by details of its routine the model can't see in the text (roof first: 18; bed: 14; dig: 8). Opus taught one consistent act, dig in (24 of 40). **A consistent lesson was easier to write in and generalise than a correct but inconsistent one.**
- **Why Shelter is harder than Gather:** at dusk the situation text still begins "It is day" (Minecraft's daylight flag stays on until night). The only words separating dusk from midday are one trailing sentence ("Evening is here or coming") and "stay" appearing on the menu. Under the rule teacher, the edit learned to stop saying "nothing" at dusk (6 → 2), but moved those answers to "stay where I am" in the open, not to sheltering.

**What the two flaws say together:**
- **The closed-form write can install a "when" judgement in two different models.** But it depends on the teacher, and it isn't robust: one of two rule teachers failed to generalise.
- **Opus as teacher, with firm labels, worked on both flaws:** Gather 13/11 at fixed confidence (rule 13/16), Shelter 12/13 (rule 8/11). Over two flaws it is the most reliable teacher of those tried.
- **Opus's value here is judgement *and* simplification:** it turns a context-dependent routine into one clear lesson. That's a teacher's skill, not a surgeon's.
- **Limits:** 20 held-out cases per side, one run each, settings chosen on a check half that has twice proven optimistic.

## Next

- **Not ROME yet.** The plan was to try ROME on the same flaw if steering worked. It didn't. The problem looks like a missing input more than a stored fact to rewrite, so a ROME edit would face the same "when" problem.
- **Done (above):** saying what lies in reach fixes most of the "nothing" flaw, while saying the danger plainly does not teach the model when not to gather. Proposed for the live bot: what lies in reach in the situation text, and Gather's model asked only by day with no hostile within 10 (not applied yet; it changes shared code and takes effect at the next restart).
- **Then, if wanted:** retry 7b on a flaw that *is* about temperament (e.g. Shelter digging in too late at dusk), where steering should fit.

## Limitations

20 cases per half, so differences of 2–3 cases are noise; one model; 4-bit base with fp16 patches; the menu is approximated (no logs to break, "break the block ahead" always offered); only three edit kinds; three rounds; the keyed gate was built from 320 index situations.

## Files

- Code: `agent/src/tools/steerCases.js` (cases), `agent/src/cortex/steer_trial.py` (score / index / effect / round), `agent/src/tools/steerOpus.js` (Opus: describe, propose).
- Data (not in git, `logs/steer-trial/`): `cases.jsonl`, `index.jsonl`, `units.json`, `units-described.json`, `effects.json`, `scores-*.json`, `rounds.json`, `patch-round-*.pt`, `opus-*.txt`.
- Part 2: `agent/src/cortex/neuron_map.py` (map / effect / run / inspect), `agent/src/tools/steerNeurons.js` (retrieval and Opus's rounds), `steerCases.js --map 2000` (map situations). Data in `logs/steer-trial/neurons/`: `groups.json`, `neurons.json` (35 MB), `group-effects.json`, `retrieved.json`, `opus-round-*.txt` (every prompt and reply), `opus-rounds.json`, `round-*-results.json`, `opus-final.json`, `heldout-*.json`.
- To rerun: `node agent/src/tools/steerCases.js`, then `python steer_trial.py score|index|effect`, `node steerOpus.js describe`, and for each round `node steerOpus.js propose --round N` followed by `python steer_trial.py round --n N`.
