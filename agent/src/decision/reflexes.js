// Survival reflexes (phase 2, docs/design-born-knowing.md): what an animal is
// born doing, not what it chooses to do with its days. They run inside the
// rule layer (decide.js) only when born-knowing is on, and only when the need
// is real:
//
//   creeper  — a creeper within 6 blocks: move away, whatever the fear drive says.
//   shelter  — from dusk: if already closed in, stay put until morning; a bed in
//              reach at night: lie in it; otherwise DIG IN — down until the head
//              is below the ground, then seal the opening overhead with a carried
//              block (and any open side). Phase 1 never managed this six-step act
//              under attack; here it is an instinct.
//   hunt     — hungry with nothing to eat: gather meat lying nearby, else strike
//              the nearest food animal until it falls.
//
// Shelter and creeper reflexes count as emergencies at night (the cortex can't
// talk the body out of its hole after dark); hunting yields to the cortex.
const { FOOD_ANIMALS, MEAT_DROPS } = require('../vault/inheritance');
const { edgeDistance } = require('../perception/worldBorder');

// Prey (or meat) this close to the world border is out of reach: chasing it
// walks the body into the border reflex and back, forever (2026-11-16: the
// pigs and cows grazed at the terrarium's edge and every hunt looped).
const PREY_BORDER_MARGIN = 6;
const reachable = (o, thing) => !o.border || !thing.position ||
  edgeDistance(o.border, thing.position.x, thing.position.z) > PREY_BORDER_MARGIN;

const DUSK = 11800; // timeOfDay: start getting ready
const DAWN = 23000; // timeOfDay: night is over
const CREEPER_RANGE = 8; // 6 was too late: three creeper deaths on the first evening of phase 2
const DIG_DEPTH = 3; // blocks below where the dig began: head below ground, room for a roof
const PREY_RANGE = 16;
const SIDES = ['ahead', 'behind', 'left', 'right', 'ahead-up', 'behind-up', 'left-up', 'right-up'];

function isEvening(o) {
  if (!o.isDay) return true;
  return o.timeOfDay != null && o.timeOfDay >= DUSK && o.timeOfDay < DAWN;
}

function createReflexes() {
  let dig = null; // { startY } while digging in

  /** A creeper close by: get away from it. */
  function creeper(o) {
    const c = (o.nearbyEntities || []).find((e) => e.name === 'creeper' && e.distance != null && e.distance <= CREEPER_RANGE);
    return c ? { type: 'flee', target: c, reflex: 'creeper' } : null;
  }

  /** Evening and night: stay sheltered, sleep, or dig in. */
  function shelter(o) {
    if (!isEvening(o)) { dig = null; return null; }
    const a = o.affordances;
    if (!a || !o.position) return null;
    if (a.enclosed) return { type: 'idle', reflex: 'shelter', reason: 'sheltered until morning' };

    // A bed close by, once it's late enough to sleep (beds work from ~12542).
    if (a.bed && a.bed.distance <= 24 && (!o.isDay || (o.timeOfDay != null && o.timeOfDay >= 12542))) {
      return { type: 'use', target: 'bed', reflex: 'shelter' };
    }

    const feetY = Math.floor(o.position.y);
    if (!dig || feetY > dig.startY) dig = { startY: feetY }; // (re)start where we stand
    const depth = dig.startY - feetY;
    if (depth < DIG_DEPTH) {
      if (a.canDigBelow) return { type: 'dig', at: 'below', reflex: 'shelter' };
      dig = null; // can't dig here (water, air below...): let other instincts move us
      return null;
    }
    // Deep enough: seal overhead, then any open side.
    if (!a.roof) {
      if (a.placeable && a.placeable.length) return { type: 'place', at: 'above', reflex: 'shelter' };
      if (a.canDigBelow) return { type: 'dig', at: 'below', reflex: 'shelter' }; // dig for something to seal with
      return null;
    }
    const open = (a.canPlace || []).filter((d) => SIDES.includes(d));
    if (open.length && a.placeable && a.placeable.length) return { type: 'place', at: open[0], reflex: 'shelter' };
    return { type: 'idle', reflex: 'shelter', reason: 'in my hole, waiting for morning' };
  }

  /** Hungry with nothing to eat: gather meat, or strike a food animal. */
  function hunt(drives, o) {
    if ((o.inventoryFood || []).length) return null;
    const meat = (o.nearbyItems || []).find((i) => MEAT_DROPS.includes(i.name) && reachable(o, i));
    if (meat) return { type: 'pickup', target: meat, reflex: 'hunt' };
    const hostileNear = o.nearestHostile && o.nearestHostile.distance != null && o.nearestHostile.distance <= 8;
    if (hostileNear) return null;
    const prey = (o.nearbyEntities || [])
      .filter((e) => FOOD_ANIMALS.includes(e.name) && e.distance != null && e.distance <= PREY_RANGE && reachable(o, e))
      .sort((x, y) => x.distance - y.distance)[0];
    return prey ? { type: 'swingAt', target: prey, reflex: 'hunt' } : null;
  }

  return { creeper, shelter, hunt, _state: () => dig };
}

/** Reflex actions that outrank even the cortex's plan (night shelter, creepers). */
function isOverriding(action, observation) {
  if (!action || !action.reflex) return false;
  if (action.reflex === 'creeper') return true;
  return action.reflex === 'shelter' && isEvening(observation);
}

module.exports = { createReflexes, isOverriding, isEvening, DUSK, DIG_DEPTH };
