// DELIBERATE MVP CHOICE: this decision layer is rule-based, not LLM-driven.
// The goal of this pass is to get the full Minecraft <-> Obsidian pipeline
// working end-to-end before adding any AI reasoning. The signature
// decide(drives, observation) -> action is the swap point: a future version
// can call an LLM each tick (feeding it the current vault state) and return
// the same action shape, without touching perception, actions, or the vault
// layer.
//
// Priority order: stay-inside-border > flee > avoid-hazard > eat-or-seek-food > explore > idle.

const { lookup } = require('../vault/ontologyMap');

const FEAR_THRESHOLD = 60;
const HUNGER_THRESHOLD = 50;
const HUNGER_URGENT = 75; // above this, finding food preempts even a lesson worth learning
const HEALTH_SAFE = 10; // at/below this, tend to survival — no dawdling to watch someone
const AVOID_RANGE = 5; // blocks: hazard blocks closer than this get walked away from
const EXPERIMENT_CHANCE = 0.15; // when curious and calm: odds of fiddling instead of wandering
const TASTE_CHANCE = 0.25; // when starving with no known food: odds of trying something carried
const BORDER_MARGIN = 4; // blocks: this close to the world border's edge, walk back inside

/** The nearest person in view — a possible teacher to watch. */
function nearestPlayer(observation) {
  return (observation.nearbyEntities || []).find((e) => e.isPlayer) || null;
}

/**
 * Curiosity-driven experimentation (Phase B): pick a random motor primitive
 * that has a valid target right now. Instinct doesn't know what swinging,
 * digging, placing, or picking up are FOR — it fiddles, and the strategy
 * layer and dreaming decide later what the fiddling meant. This is how
 * accidents get to happen between Claude consultations.
 * (craft is implemented in actions.js but NOT offered here — deferred with
 * Henry on 2026-07-08 until the raw primitives prove out.)
 */
function experiment(observation) {
  const options = [];
  const creature = (observation.nearbyEntities || [])[0];
  if (creature) options.push({ type: 'swingAt', target: creature });
  const block = (observation.nearbyBlocks || []).find((b) => b.position);
  if (block) options.push({ type: 'dig', target: block });
  const ground = (observation.nearbyItems || [])[0];
  if (ground) options.push({ type: 'pickup', target: ground });
  if ((observation.inventory || []).length) {
    options.push({ type: 'place' });
  }
  // The complete body (Phase 1): aimed digging and placing anywhere the
  // hand can reach, jumping, working a door or bed in view. Babbling over the
  // whole space is how an unplanned shelter can happen by accident.
  const a = observation.affordances;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  if (a && a.canDig && a.canDig.length) options.push({ type: 'dig', at: pick(a.canDig) });
  if (a && a.canPlace && a.canPlace.length) options.push({ type: 'place', at: pick(a.canPlace) });
  options.push({ type: 'jump' });
  for (const kind of ['door', 'bed', 'trapdoor', 'gate']) {
    if (a && a[kind]) options.push({ type: 'use', target: kind });
  }
  return options.length ? options[Math.floor(Math.random() * options.length)] : null;
}

/**
 * drives: a Drives instance; observation: output of perceive() plus
 * observation.nearbyBlocks from the loop's block scan.
 * Returns { type: 'flee'|'avoid'|'eat'|'seekFood'|'explore'|'idle'|<motor primitive>, ... }.
 * opts.experimentChance overrides EXPERIMENT_CHANCE (the sim passes 0 so its
 * scenario stays deterministic).
 */
function decide(drives, observation, { experimentChance = EXPERIMENT_CHANCE, tasteChance = TASTE_CHANCE } = {}) {
  // Brainstem: the border hurts. Outside it (or about to be), nothing else
  // matters — not even a zombie, which can be fled from once back inside.
  if (observation.borderDistance != null && observation.borderDistance <= BORDER_MARGIN) {
    return { type: 'returnInside' };
  }

  // Phase 2 reflexes (born knowing; reflexes.js), when the loop provides them.
  const reflexes = observation.reflexes || null;
  if (reflexes) {
    const c = reflexes.creeper(observation);
    if (c) return c;
    // From dusk, sheltering comes before running: once closed in, stay (fleeing
    // out of a hole is how phase 1 kept dying); while digging in, only a
    // hostile right on top of us sends us running.
    const s = reflexes.shelter(observation);
    const close = observation.nearestHostile && observation.nearestHostile.distance != null &&
      observation.nearestHostile.distance <= 3;
    if (s && (s.reason || !close)) return s;
  }

  if (drives.fear > FEAR_THRESHOLD && observation.nearestHostile) {
    return { type: 'flee', target: observation.nearestHostile };
  }

  // Hazard blocks (lava, fire) nearby: move away even when calm — knowing a
  // thing is dangerous is useless if no action can express "not near that".
  const hazard = (observation.nearbyBlocks || []).find(
    (b) => b.distance != null && b.distance <= AVOID_RANGE && lookup('block', b.name).drives.fear >= 0.5
  );
  if (hazard) {
    return { type: 'avoid', target: hazard };
  }

  const health = observation.health;
  const lowHealth = health != null && health <= HEALTH_SAFE;

  // Urgent hunger — or any hunger while badly hurt — is survival, and preempts
  // learning. Below this bar, mild hunger will NOT drown out a lesson.
  if (drives.hunger > HUNGER_URGENT || (lowHealth && drives.hunger > HUNGER_THRESHOLD)) {
    if (observation.inventoryFood.length > 0) {
      return { type: 'eat', item: observation.inventoryFood[0].name };
    }
    // Starving with nothing known to be food: sometimes put a carried thing
    // (not a building block, and not something that already wouldn't go
    // down) in the mouth. What goes down is learned (bodyKnowledge.js).
    const blocks = new Set((observation.affordances && observation.affordances.placeable) || []);
    const untried = (observation.inventory || []).filter((i) => !blocks.has(i.name) && !(observation.inedible || []).includes(i.name));
    const h = reflexes && reflexes.hunt(drives, observation);
    if (h) return h; // born knowing: animals give meat
    if (untried.length && Math.random() < tasteChance) {
      return { type: 'eat', item: untried[Math.floor(Math.random() * untried.length)].name };
    }
    return { type: 'seekFood' };
  }

  // LEARNING PATHWAY: when safe, healthy, and curious, and a person is here to
  // watch, go to them. This is what lets "I want to learn" become sustained
  // action instead of being stomped by mild hunger every tick — a living
  // demonstration is worth more than idle wandering (see observational
  // learning: watching another player is the cheapest way to find a goal).
  const teacher = nearestPlayer(observation);
  if (!lowHealth && teacher && drives.dominant() === 'curiosity' && drives.curiosity > 40) {
    return { type: 'approach', target: teacher, reason: 'learn' };
  }

  // Mild hunger, once survival and learning have had their say.
  if (drives.hunger > HUNGER_THRESHOLD) {
    if (observation.inventoryFood.length > 0) {
      return { type: 'eat', item: observation.inventoryFood[0].name };
    }
    const h = reflexes && reflexes.hunt(drives, observation);
    if (h) return h;
    return { type: 'seekFood' };
  }

  if (drives.dominant() === 'curiosity' && drives.curiosity > 40) {
    if (Math.random() < experimentChance) {
      const tryThis = experiment(observation);
      if (tryThis) return tryThis;
    }
    return { type: 'explore' };
  }

  return { type: 'idle' };
}

module.exports = { decide, FEAR_THRESHOLD, HUNGER_THRESHOLD, BORDER_MARGIN };
