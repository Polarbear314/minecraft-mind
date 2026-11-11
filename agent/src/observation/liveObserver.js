// The bridge between a LIVE mineflayer bot and the observation pipeline. It
// does two jobs the pure modules deliberately don't:
//
//   1. Turns real mineflayer events into the { others, worldEvents } shape the
//      watchTracker expects — `blockUpdate` becomes block_placed/block_broken,
//      and another being's held item is read off its raw entity.
//   2. Runs the whole thing FIRE-AND-FORGET beside the tick, exactly like the
//      dreamer: observe() returns immediately, never throws, and a failure
//      leaves no trace. Watching must never freeze or crash the body.
//
// Attach once after the bot is created (it registers a blockUpdate listener);
// then call observer.observe(observation, ctx) once per tick from the loop.
'use strict';

const { createObserver } = require('./observe');
const { AMBIENT_BLOCKS } = require('./watchTracker');
const { INTERESTING_BLOCKS } = require('../vault/ontologyMap');

// Names that mean "nothing there" — a block going air -> X is a placement,
// X -> air is a break. null/undefined = the client hasn't loaded the old block.
const AIR = new Set(['air', 'cave_air', 'void_air', null, undefined]);

function isInteresting(name) {
  return !!name && INTERESTING_BLOCKS.includes(name);
}

/**
 * Read another BEING's held item from its raw entity. Players expose it via
 * `heldItem` / `equipment[0]` once metadata has loaded. Returns undefined when
 * unknown — the tracker treats undefined as "no information", never as empty
 * hands (only `null` is empty hands), so an unloaded value fabricates nothing.
 */
function heldItemOf(bot, view) {
  try {
    if (!view.isPlayer || !bot.entities) return undefined; // only players report a held item reliably
    const raw = Object.values(bot.entities).find((e) => e && e.username === view.name);
    if (!raw) return undefined;
    const held = raw.heldItem || (raw.equipment && raw.equipment[0]);
    return held ? held.name : undefined;
  } catch (_) {
    return undefined;
  }
}

/**
 * attachObserver(bot, { vaultPath, moiAsk, tomAsk })
 *   moiAsk / tomAsk: optional async(prompt)->text LLM hooks (OMNI interesting-
 *   ness and MindForge intent). Omit for pure-heuristic, fully-offline running.
 * Returns { observe(observation, { now, locatedIn, chatLines }) }.
 */
function attachObserver(bot, { vaultPath, moiAsk, tomAsk } = {}) {
  const observer = createObserver({ vaultPath, moiAsk, tomAsk });
  let pending = []; // worldEvents buffered between ticks, like chatChannel buffers speech

  // Block changes near the agent are the "visual" channel: a crafting table
  // that wasn't there now is. mineflayer emits (oldBlock, newBlock). Ambient
  // blocks (grass spreading, water/lava flow, leaves) are pre-filtered here so
  // the buffer never fills with the world's own churn — the noise that once
  // had a bee "teaching" the agent to grow grass.
  bot.on('blockUpdate', (oldBlock, newBlock) => {
    try {
      const oldName = oldBlock && oldBlock.name;
      const newName = newBlock && newBlock.name;
      const pos = (newBlock && newBlock.position) || (oldBlock && oldBlock.position);
      if (!pos) return;
      if (isInteresting(newName) && !AMBIENT_BLOCKS.has(newName) && AIR.has(oldName)) {
        pending.push({ kind: 'block_placed', name: newName, position: pos });
      } else if (isInteresting(oldName) && !AMBIENT_BLOCKS.has(oldName) && AIR.has(newName)) {
        pending.push({ kind: 'block_broken', name: oldName, position: pos });
      }
    } catch (_) { /* one malformed update must not matter */ }
  });

  // Arm swings are how we know a being ACTED on purpose (dug, hit, placed) —
  // as opposed to just standing near a change. Only players can be teachers,
  // so only their swings are recorded, tagged with who swung.
  bot.on('entitySwingArm', (entity) => {
    try {
      if (!entity || entity.type !== 'player' || !entity.username) return;
      pending.push({ kind: 'swing', by: entity.username, position: entity.position });
    } catch (_) { /* a lost swing is no loss */ }
  });

  function drain() {
    const out = pending;
    pending = [];
    return out;
  }

  return {
    /**
     * Fire-and-forget. Builds the tracker's inputs from the current
     * observation + the buffered world events, then runs the pipeline in the
     * background. Never blocks the tick, never throws.
     */
    observe(observation, { now, locatedIn, chatLines } = {}) {
      try {
        const others = (observation.nearbyEntities || []).map((e) => ({
          name: e.name,
          isPlayer: e.isPlayer,
          position: e.position,
          heldItem: heldItemOf(bot, e),
        }));
        observer
          .observe({
            now: now || new Date(),
            others,
            worldEvents: drain(),
            chatLines: chatLines != null ? chatLines : observation.chatLines,
            locatedIn: locatedIn || [],
          })
          .then((results) => {
            for (const r of results || []) {
              if (r && r.written && r.written.subgoal) {
                console.log(
                  `[watch] ${r.episode.actor} did something worth learning — ` +
                  `set myself the goal "${r.written.subgoal}" (saw a ${r.episode.outcome.name})`
                );
              }
            }
          })
          .catch(() => {});
      } catch (_) { /* watching must never break the body */ }
    },
  };
}

module.exports = { attachObserver, heldItemOf };
