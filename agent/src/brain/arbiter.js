// The arbiter: what the body does THIS tick, given everything the brain's
// parallel regions are saying at once. No region waits for another; the body
// reads the freshest word from each and acts:
//
//   1. Brainstem emergencies (back inside the border, a creeper, a hazard, a
//      hostile within reach, badly hurt with one coming) and the night-shelter
//      reflex — always first.
//   2. A running PLAN (brain/planRunner.js): a multi-step project the mind
//      wrote for itself in a dream, carried across ticks
//      (docs/design-plans-and-skills.md).
//   3. Claude's deliberate choice (fresh or still held) — the slow cortex steers.
//   4. The inner voice's fresh urge (local model, every few seconds).
//   5. Born-knowing reflexes and plain instinct.
//
// One-shot urges (dig below, place above...) are acted on once, not every tick.
const { isOverriding } = require('../decision/reflexes');
const { inDanger } = require('../decision/claudeCodeDecide');

const EMERGENCY = new Set(['flee', 'avoid', 'returnInside']);
const ONE_SHOT = new Set(['dig', 'place', 'jump', 'use', 'equip', 'eat', 'craft']);
const URGE_FRESH_MS = 8000;

/** Does this tick belong to the brainstem, whatever any plan says? */
function isEmergency(chosen, observation) {
  if (chosen.type === 'returnInside' || chosen.type === 'avoid') return true;
  if (chosen.reflex === 'creeper' || isOverriding(chosen, observation)) return true;
  if (inDanger(observation)) return true;
  // Instinct eating when starving is one quick bite: let it through.
  return chosen.type === 'eat' && chosen.source === 'instinct';
}

function createArbiter({ decide, blackboard, toAction, planRunner = null, urgeFreshMs = URGE_FRESH_MS }) {
  let usedUrgeTs = null;

  return async function arbitrate(drives, observation) {
    let chosen = await decide(drives, observation);
    // Born knowing that animals give meat, "look for food" (from the cortex
    // or instinct) means going after one when it's in reach — not wandering.
    if (chosen.type === 'seekFood' && observation.reflexes) {
      const hunt = observation.reflexes.hunt(drives, observation);
      if (hunt) chosen = { ...hunt, thought: chosen.thought, source: chosen.source };
    }

    // The cortex can call a plan or skill by name, or let the running one go.
    if (chosen.type === 'skill' || chosen.type === 'stop') {
      let note = null;
      if (planRunner && chosen.source === 'claude') {
        if (chosen.type === 'stop') planRunner.stop('I chose to let it go');
        else {
          const started = planRunner.start(chosen.item, 'cortex', observation);
          if (!started.ok) note = started.reason;
        }
      }
      blackboard.post('frontal', 'cortex', { thought: chosen.thought || '', action: chosen.type },
        `${chosen.type}${chosen.item ? ` "${chosen.item}"` : ''}${note ? ` (${note})` : ''}`);
      chosen = { ...chosen, type: 'idle' }; // the plan (if any) acts below
      delete chosen.item;
    }

    if (planRunner) {
      const planned = planRunner.next(observation, { emergency: isEmergency(chosen, observation) });
      if (planned) {
        // A plan in hand outranks a fresh thought — but the thought, words and
        // intention the cortex just had still belong to the mind.
        if (chosen.source === 'claude') {
          for (const k of ['thought', 'say', 'intention']) if (chosen[k] !== undefined) planned[k] = chosen[k];
          planned.overrode = chosen.type;
          blackboard.post('frontal', 'cortex', { thought: chosen.thought || '', action: chosen.type },
            `${chosen.type} (but I keep to my plan "${planned.plan}")`);
        }
        return planned;
      }
    }

    if (chosen.source === 'claude') {
      blackboard.post('frontal', 'cortex', { thought: chosen.thought || '', action: chosen.type },
        `${chosen.type}${chosen.at ? ' ' + chosen.at : ''}${chosen.thought ? ` — "${chosen.thought}"` : ''}`);
      return chosen;
    }
    if (chosen.source === 'held') return chosen;
    if (EMERGENCY.has(chosen.type)) return chosen; // brainstem first
    if (chosen.reflex) return chosen; // born-knowing reflexes (hunt, shelter...) beat a passing urge

    // Starving with known food: instinct's eat beats any urge.
    if (chosen.type === 'eat') return chosen;

    const urge = blackboard.get('urge', urgeFreshMs);
    if (urge && !(ONE_SHOT.has(urge.data.action) && urge.ts === usedUrgeTs)) {
      try {
        const act = toAction({ ...urge.data, thought: urge.data.thought }, observation);
        if (act.type === 'skill' || act.type === 'stop') throw new Error('plans are the cortex\'s to call');
        act.source = 'inner voice';
        if (ONE_SHOT.has(act.type)) usedUrgeTs = urge.ts;
        // Intentions and speech belong to the deliberate cortex, not to a passing urge.
        delete act.intention;
        delete act.say;
        return act;
      } catch (_) { /* the urge doesn't fit the world any more */ }
    }
    return chosen;
  };
}

module.exports = { createArbiter, isEmergency, EMERGENCY };
