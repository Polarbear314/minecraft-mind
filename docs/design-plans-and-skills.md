# Goals become plans, plans become skills

*Design for the step after phase 2 (see `dev-handoff-2026-11-17.md`, "Next"). Builds on `design-learning-from-the-readings.md` §2.2–2.4 and answers `results-say-vs-do-2026-11-17.md`.*

## The problem in one sentence

MindBot's dreamed goals change what it **thinks** but not what it **does**: a goal is prose, the cortex re-decides from scratch every ~30 s, and a multi-step project ("find an empty bed", "build walls", "make tools") never survives long enough between decisions to get done — so it is never tried, never graded, and never becomes a skill.

## The idea

A goal written in a dream comes with a **plan the body can run** and a **test the body can check**. A small **plan runner** carries the plan across ticks. Every run is **graded** against its test. Plans that keep passing become **Skills** the cortex can call by name; plans that keep failing are revised or dropped, with the reason written down.

This is Newell & Simon's generate-and-test with the dream as the generator and the world as the test; Turing's stored program (the same note read as data by the dream and as instructions by the runner); Fodor & Pylyshyn's productivity (a finite set of primitives, an open-ended set of skills); and Lucken's loop of specification (the test), performance (the run trace) and registration (the grade).

## 1. What a plan looks like

A plan is a note in a new vault folder, `Plans/`, linked to the goal it serves. Everything is in plain words a person can read in Obsidian; the frontmatter is also what the runner executes.

```yaml
is_a: "[[Plan]]"
serves: "[[Find An Empty Bed While It Is Light]]"
when: late day            # day | late day | dusk | night | any
needs: []                 # conditions that must hold to start (optional)
steps:
  - explore until near bed
  - approach bed
test: near bed at nightfall
status: trying            # trying | skill | revise | dropped
runs: 0
passed: 0
failed: 0
broke: 0
version: 1
history: []               # earlier versions and why they were replaced (never deleted)
```

**Steps** are the body's existing primitives, one per line: `dig <at>`, `place <at> [block]`, `move <ahead|behind|left|right>`, `jump`, `use <bed|door|at>`, `equip <item>`, `craft <item>`, `approach <creature|block>`, `swingAt <creature>`, `pickup`, `eat <item>`, plus `explore` (walk somewhere new). Any step may end with `until <condition>`. At most 12 steps.

**Conditions** (for `until`, `needs` and `test`) are a small fixed vocabulary the body can check from what it already perceives, every tick:

| Condition | Checked from |
|---|---|
| `carrying <item> [n]` | inventory |
| `holding <item>` | held item |
| `near <thing> [blocks]` | entities, blocks, doors/beds in affordances |
| `enclosed`, `roof over me` | affordances |
| `fed` | food bar ≥ 18 |
| `<condition> at nightfall` | the same condition, checked at dusk (timeOfDay 11 800) |
| `slept`, `survived the night`, `unhurt through the night` | the night report the body journal already writes at dawn (+ a new `sleeping` flag in perception) |

A test graded "now" gets a short grace (a few ticks) after the last step.

**Feasibility gate (§2.3).** When a dream writes a plan, every step must compile to a primitive with legal arguments and every condition must parse. A plan that doesn't compile is not saved; the goal is still written, and the reason goes in the dream log ("I lack a way to …"), so the next dream can see it.

## 2. Where plans come from: dreams

The dream prompt (`reflection/dream.js`) gains:

- a short description of the body's primitives and the condition words (what its body can do and sense — self-knowledge, the same thing the cortex is already told, not game knowledge);
- `subgoals[].plan = { when, needs, steps, test }`;
- a new list `plans: [{ for_goal, when, needs, steps, test }]` so it can write a plan for a goal it **already has** (all 15 current goals have none), capped at 2 per dream;
- a section *"Plans that keep failing, and why"*, so it can write a revised version (`revises: <plan>`).

The plans are the mind's own: nothing is seeded by hand.

## 3. The plan runner

`brain/planRunner.js`, called every tick (1.5 s), holds at most one running plan and returns the action for the current step (`source: 'plan'`). One-shot steps (dig, place, craft…) advance when the body reports `ok` (a dig waits until the block is actually broken); steps with `until` are repeated until the condition holds; every step has a budget (~1 minute) and every run a budget (~4 minutes). A step the body refuses is retried twice, then the run **breaks** with the body's own reason.

**When a plan starts:**
1. *By itself (a habit):* when its `when` window opens, its `needs` hold, no plan is running, and it hasn't run in this window yet. This is the direct route from goal to behaviour.
2. *By the cortex:* a new action `skill` (`"item": "<plan or skill name>"`) starts one; `"action": "stop"` drops the running plan. The cortex prompt shows the running plan and its step.

**Priority (arbiter):**

1. Brainstem emergencies: border, flee/avoid, creeper, a hostile within 5 blocks, health ≤ 8.
2. Night-shelter reflexes (dig in / bed / stay enclosed from dusk).
3. **The running plan.**
4. Claude's fresh decision or held plan, then the inner voice's urge, then the remaining reflexes (hunt) and instinct — as now.

A plan pauses (not fails) during an emergency and resumes after; a death **interrupts** the run (not graded — the world surprised it, Lucken's out-of-spec). Because night shelter outranks plans, night-related plans work by *preparing in daylight* (`when: late day`) and are graded at nightfall or dawn: "be near a bed at nightfall" lets the existing bed reflex do the rest; "be enclosed at nightfall" makes the shelter reflex simply stay put.

## 4. Generate and test

Each run ends as **passed** (test held), **failed** (steps finished but the test didn't hold), **broke** (a step couldn't be done — with the reason), or **interrupted** (emergency took too long, death: not counted). Every run is appended to `logs/plans-YYYY-MM-DD.jsonl` (the trace: steps, results, reasons, grade) and counted in the plan note.

- **Promote:** 3 passes and passes ≥ 2/3 of graded runs → a **Skill** note in `Concepts/Abstract/Skill/` carrying the steps, `when`, `test`, `promoted_from: [[Plan]]` and its record, plus an Experience ("I Learned How To …"). Skills appear in the cortex prompt as callable by name and keep running as habits.
- **Revise:** 3 graded runs without a pass → `status: revise` with the commonest reason. The next dream sees it and may write version 2 (old steps kept in `history`).
- **Drop:** still failing after 2 revisions → `status: dropped`, reason recorded, an Experience written (Shannon's rat letting go of a maze it can't solve). Nothing is deleted.
- Skills keep being graded; one whose last 6 runs pass under half the time goes back to `trying`.

The two prose skills already in the vault stay as they are (know-how, not callable).

## 5. Measuring it

- Plan actions are tagged `source: 'plan'` in the tick log. `npm run sayvsdo` counts them as the **mind's** choices (the dream wrote them) and gains a column: plan runs and passes per goal.
- **Re-run plan:** after ~24 h of running (enough day-breaks for dreams to write plans and for runs to be graded), run `npm run sayvsdo` and compare with 2026-11-17. Success = goals with a plan move from "says it, but doesn't do it" / "neither" to "does it", and at least one plan has been promoted to a Skill. Also check the plan log for the commonest break reasons — that is the next list of capability gaps.

## 6. Sim checks (`npm run sim`, currently 167)

Parser/feasibility gate (good plan compiles, bad verb/direction/condition rejected); dream applies a subgoal with a plan and a plan for an existing goal; runner walks a multi-step plan across ticks, waits on a dig, repeats an `until`, breaks with a reason after retries; emergencies and the night reflex pre-empt a plan, which resumes; Claude's `skill`/`stop`; grading now / at nightfall / at dawn; promotion to a Skill after 3 passes; revise after 3 fails; drop after 2 revisions; a Skill callable by the cortex.

## Status (2026-11-16): built

Approved and built as designed. Code: `agent/src/vault/planStore.js` (the plan language, feasibility gate, notes, promotion/revision/drop), `agent/src/brain/planRunner.js` (the runner and grading), plus changes to `brain/arbiter.js`, `reflection/dream.js`, `decision/llmDecide.js` (`skill`/`stop`), `decision/claudeCodeDecide.js`, `loop.js`, `perception/perceive.js` (`sleeping`, `digging`), `reflection/bodyJournal.js` (`plan` in the tick log), `index.js`, `tools/sayVsDo.js` (plans count as the mind's; a Plans table). Switch: `"plans": true` under `nature` in `agent/brain-map.json`. `npm run sim`: 210 checks (167 + 43 for this).

No plans exist yet: the first ones are written at the next dream (day-break after ≥10 new experiences), which will also see all 15 current goals listed as "no plan yet".

**Re-running the measurement.** After about 24 hours of running with plans on: `cd agent`, `npm run sayvsdo`. Compare with `results-say-vs-do-2026-11-17.md`:
1. The new **Plans** table: did dreams write plans, how many runs, passes, and the commonest reason a plan broke (that list is the next set of capability gaps).
2. The goal table: goals set *after* plans went live should move toward "does it", since plan steps now count as the mind's own actions.
3. Any plan with status `skill`, and its note in `Concepts/Abstract/Skill/`.
4. `logs/plans-*.jsonl` for traces of individual runs; `logs/dreams-*.jsonl` field `rejectedPlans` for plans the feasibility gate refused, and why.

## Strict grading (2026-11-17)

The first day live showed that the grading could be passed without the plan doing anything (Goodhart's law in miniature). "Climb Out Onto Grass" (test: *near grass*) and "Learn Where The Bed Is" (test: *near the bed by its spawn point*) became Skills on tests that were already true. "Wall Where I Wake" passed with none of its steps done, because the cortex started it by day: it jumped straight to waiting for dawn, and the night reflex kept it alive. The same bug graded "Stop And Sink At Dusk" failed three times in one minute. The rules now:

- **A pass must be earned:** the steps must have been done, and the test must **not** already have been true when the plan began. Otherwise the run is "broke" (steps undone) or "moot" (already so; not counted, like "interrupted").
- **A plan only starts in its own time:** the cortex is told "it is not the time for that". A plan whose test already holds doesn't start at all ("it is already so"). A plan still waiting to be graded can't be started again.
- **When its time runs out with steps undone, the run breaks;** it isn't graded on its test. A final "wait" step is the exception: waiting through is the point.
- **"wait until day" means the next morning,** not "it's already daytime".
- **Vault cleanup (nothing deleted):** passes from before strict grading were set aside under `loose_grading` in each plan note. The two promoted Skills went back to `trying`, and their Skill notes are marked `status: withdrawn` (no longer offered to the cortex as know-how). "Stop And Sink At Dusk" went back to `trying`, since its failures came from the bug. `npm run sim`: 221 checks.

## 7. Choices worth a second look

- **Habits start on their own.** Letting a plan start itself when its window opens is what should make goals predict behaviour — but it means the cortex is no longer the only author of what the body does by day. The alternative (only the cortex starts plans) is safer but may reproduce the say-vs-do gap. *Proposed: both.*
- **Night stays with the reflexes.** Plans don't override night shelter; they prepare for it. A plan that wants to try its *own* night shelter would need the reflex to yield, which risks deaths and the border streak. *Proposed: not yet.*
- **The dream is told the primitive and condition words.** That is self-knowledge of its body, not world knowledge — but it does shape what it can plan (a QCCR-worthy point: Haugeland would say the primitives already carry a picture of what skills are).
