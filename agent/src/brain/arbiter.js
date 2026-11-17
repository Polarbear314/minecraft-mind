// The arbiter: what the body does THIS tick, given everything the brain's
// parallel regions are saying at once. No region waits for another; the body
// reads the freshest word from each and acts:
//
//   1. Brainstem emergencies (flee a close threat, step off lava, get back
//      inside the border) — always first.
//   2. Claude's deliberate plan (fresh or still held) — the slow cortex steers.
//   3. The inner voice's fresh urge (local model, every few seconds) — fast
//      thought fills the gaps between deliberations, instead of blind wandering.
//   4. Plain instinct.
//
// One-shot urges (dig below, place above...) are acted on once, not every tick.
const EMERGENCY = new Set(['flee', 'avoid', 'returnInside']);
const ONE_SHOT = new Set(['dig', 'place', 'jump', 'use', 'equip', 'eat', 'craft']);
const URGE_FRESH_MS = 8000;

function createArbiter({ decide, blackboard, toAction, urgeFreshMs = URGE_FRESH_MS }) {
  let usedUrgeTs = null;

  return async function arbitrate(drives, observation) {
    let chosen = await decide(drives, observation);
    // Born knowing that animals give meat, "look for food" (from the cortex
    // or instinct) means going after one when it's in reach — not wandering.
    if (chosen.type === 'seekFood' && observation.reflexes) {
      const hunt = observation.reflexes.hunt(drives, observation);
      if (hunt) chosen = { ...hunt, thought: chosen.thought, source: chosen.source };
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

module.exports = { createArbiter, EMERGENCY };
