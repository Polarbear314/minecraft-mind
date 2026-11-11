// The agent's eyes on OTHER minds. Mineflayer gives no camera, so "watching"
// is done from world-state deltas: another being's position and held item over
// ticks, plus the block/item changes that happen around them. This tracker
// turns that stream into discrete *episodes* — "someone DELIBERATELY did a
// thing that produced an outcome" — for the interestingness and theory-of-mind
// layers to reason about.
//
// Hard-won lessons from the first live run (a bee "teaching" the agent to grow
// grass, GiantAxe blamed for grass that spread on its own) are baked in here:
//
//   1. Teachers are PLAYERS ONLY. A bee flying by is not a demonstration.
//   2. A change is credited to a being only if that being ACTED — swung its
//      arm or changed what it holds — within a short window. Mere proximity is
//      not enough; the world changes on its own constantly.
//   3. AMBIENT changes never count as demonstrations at all: grass spreading,
//      water/lava flowing, fire, leaves, snow. These fire endless blockUpdates
//      and are nobody's handiwork.
//
// Together these turn "watch whatever changed near the nearest thing" into
// "watch what a person deliberately did," which is the whole point.
'use strict';

const DEFAULT_RADIUS = 6; // blocks: a world change this close may be credited to an acting player
const IDLE_FLUSH_MS = 4000; // an actor quiet this long has finished whatever it was doing
const ACTION_WINDOW_MS = 1800; // a swing/held-change must be this recent to credit an outcome

// Events that complete an act — the moment an outcome exists in the world.
const TERMINAL = new Set(['block_placed', 'block_broken', 'item_dropped', 'item_crafted']);

// Blocks whose changes are overwhelmingly natural/ambient, never a lesson —
// even if a player happens to be swinging nearby. Placing dirt is not the
// demonstration worth learning; grass spreading is nobody's doing.
const AMBIENT_BLOCKS = new Set([
  'grass_block', 'dirt', 'grass', 'short_grass', 'tall_grass', 'fern', 'large_fern',
  'water', 'lava', 'fire', 'snow', 'snow_block', 'ice', 'frosted_ice',
  'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'vine', 'moss_block',
  'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves', 'acacia_leaves',
  'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves', 'azalea_leaves',
]);

function distance(a, b) {
  if (!a || !b) return Infinity;
  if (typeof a.distanceTo === 'function') return a.distanceTo(b);
  const dx = (a.x - b.x), dy = (a.y - b.y), dz = (a.z - b.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function createWatchTracker({
  radius = DEFAULT_RADIUS,
  idleFlushMs = IDLE_FLUSH_MS,
  actionWindowMs = ACTION_WINDOW_MS,
  playersOnly = true,
} = {}) {
  const open = new Map(); // actor name -> in-progress episode
  const done = [];

  function isActor(o) {
    return o && o.name && (!playersOnly || o.isPlayer);
  }

  function episodeFor(name, isPlayer, at) {
    if (!open.has(name)) {
      open.set(name, {
        actor: name, isPlayer: !!isPlayer, startedAt: at, lastAt: at,
        held: undefined, lastSwingAt: -Infinity, actions: [], events: [],
      });
    }
    return open.get(name);
  }

  /** Nearest ACTOR (player, if playersOnly) to a position, within radius. */
  function nearestActor(pos, actors) {
    let best = null;
    let bestD = radius;
    for (const o of actors) {
      const d = distance(pos, o.position);
      if (d <= bestD) { best = o; bestD = d; }
    }
    return best;
  }

  /** Did this actor deliberately act recently — swing or change of grip? */
  function acted(ep, now) {
    if (now - ep.lastSwingAt <= actionWindowMs) return true;
    return ep.actions.some((a) => a.kind === 'held_change');
  }

  function flush(name, at) {
    const ep = open.get(name);
    open.delete(name);
    if (!ep) return;
    const terminal = [...ep.events].reverse().find((e) => TERMINAL.has(e.kind));
    if (!terminal) return; // no outcome -> nothing was demonstrated

    const outcome = terminal.kind === 'block_placed' || terminal.kind === 'item_crafted'
      ? { type: 'made', name: terminal.name, position: terminal.position }
      : terminal.kind === 'block_broken'
        ? { type: 'gathered', name: terminal.name, position: terminal.position }
        : { type: 'dropped', name: terminal.name, position: terminal.position };

    const materials = [];
    for (const a of ep.actions) {
      if (a.kind === 'held_change' && a.from && a.from !== outcome.name && !materials.includes(a.from)) {
        materials.push(a.from);
      }
    }

    const heldPath = ep.actions.filter((a) => a.kind === 'held_change').map((a) => a.to).filter(Boolean);
    const summaryBits = [];
    if (heldPath.length) summaryBits.push(`held ${heldPath.join(', then ')}`);
    summaryBits.push(`${outcome.type === 'gathered' ? 'and out of the ground came' : 'and there appeared'} ${outcome.name}`);

    done.push({
      actor: ep.actor,
      isPlayer: ep.isPlayer,
      startedAt: ep.startedAt,
      endedAt: at,
      actions: ep.actions,
      events: ep.events,
      outcome,
      materials,
      summary: summaryBits.join(', '),
    });
  }

  return {
    /**
     * others: [{ name, isPlayer, position, heldItem }] — beings in view now.
     * worldEvents: [{ kind, name, position, by? }] since last tick, where kind ∈
     *   swing | block_placed | block_broken | item_dropped | item_crafted.
     *   A 'swing' event marks a being deliberately acting (arm swing).
     */
    ingest(now, others = [], worldEvents = []) {
      const actors = (others || []).filter(isActor);

      // 1. Track held-item transitions for actors (players).
      for (const o of actors) {
        const ep = episodeFor(o.name, o.isPlayer, now);
        ep.lastAt = now;
        ep.pos = o.position;
        if (o.heldItem !== undefined && o.heldItem !== ep.held) {
          if (ep.held !== undefined) ep.actions.push({ kind: 'held_change', from: ep.held, to: o.heldItem, at: now });
          ep.held = o.heldItem;
        }
      }

      // 2. First pass: register swings so a same-tick swing counts as "acting"
      //    for a block change that arrives later in the array.
      for (const ev of worldEvents) {
        if (ev.kind !== 'swing') continue;
        const actor = (ev.by && actors.find((a) => a.name === ev.by)) || nearestActor(ev.position, actors);
        if (!actor) continue;
        const ep = episodeFor(actor.name, actor.isPlayer, now);
        ep.lastAt = now;
        ep.lastSwingAt = now;
      }

      // 3. Second pass: outcomes. Credit an outcome only to a PLAYER who ACTED,
      //    and never for an AMBIENT block. Everything else is dropped as noise.
      for (const ev of worldEvents) {
        if (!TERMINAL.has(ev.kind)) continue;
        if (AMBIENT_BLOCKS.has(ev.name)) continue; // grass spreading, water flowing — not a lesson
        const actor = (ev.by && actors.find((a) => a.name === ev.by)) || nearestActor(ev.position, actors);
        if (!actor) continue; // no player acted near it -> the world did it, not a being
        const ep = episodeFor(actor.name, actor.isPlayer, now);
        if (!acted(ep, now)) continue; // present but idle -> a coincidence, not a demonstration
        ep.lastAt = now;
        ep.events.push({ kind: ev.kind, name: ev.name, position: ev.position, at: now });
        flush(actor.name, now);
      }

      // 4. Idle flush (only flushes episodes that actually reached an outcome).
      for (const [name, ep] of [...open]) {
        if (now - ep.lastAt >= idleFlushMs) flush(name, now);
      }
    },

    takeEpisodes() {
      return done.splice(0, done.length);
    },
  };
}

module.exports = { createWatchTracker, DEFAULT_RADIUS, AMBIENT_BLOCKS };
