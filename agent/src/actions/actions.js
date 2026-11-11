// Executes decided actions against the bot via mineflayer-pathfinder goals.
// Degrades gracefully when pathfinder isn't loaded (e.g. the mock bot in
// simulate.js), so the pipeline stays testable without a real server.
//
// MOTOR PRIMITIVES (Phase B): swingAt, dig, place, pickup expose the body's
// raw capabilities with NO purpose attached — the code here knows how to
// swing an arm, not why anyone would. Slow bodily acts (digging, placing)
// are fired and NOT awaited: bot.dig() can take seconds and the tick loop
// must never stand still waiting for a hand to finish.
// craft is implemented below but NOT exposed in any decision vocabulary —
// deferred with Henry (2026-07-08) until the raw primitives prove out.
let goals = null;
try {
  ({ goals } = require('mineflayer-pathfinder'));
} catch (_) {
  // Running without mineflayer-pathfinder installed (bare simulation) is fine.
}
let Vec3 = null;
try {
  ({ Vec3 } = require('vec3'));
} catch (_) { /* bare simulation without deps */ }

/** Fire-and-forget: start a slow bodily act, swallow its failure. */
function fireAndForget(promise) {
  Promise.resolve(promise).catch(() => {});
}

/** The live entity object closest to a remembered position (for swingAt). */
function entityNear(bot, position) {
  let closest = null;
  let best = Infinity;
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position || !e.name || e.name === 'item') continue;
    const d = e.position.distanceTo(position);
    if (d < best) {
      best = d;
      closest = e;
    }
  }
  return best <= 2 ? closest : null;
}

/** The nearest live entity matching a perceived name (players by username). */
function entityByName(bot, name) {
  let closest = null;
  let best = Infinity;
  const me = bot.entity && bot.entity.position;
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position) continue;
    const n = e.type === 'player' && e.username ? e.username : e.name;
    if (n !== name) continue;
    const d = me ? e.position.distanceTo(me) : 0;
    if (d < best) {
      best = d;
      closest = e;
    }
  }
  return closest;
}

// Wander persistence: one chosen destination per bot, walked until reached.
// Re-rolling a fresh random target every 1.5s tick used to cancel each path
// after ~2 blocks — the bot "explored" in place forever, a random walk that
// never left its own footprints. Now explore/seekFood commit to a point.
const wanders = new WeakMap(); // bot -> { x, z, setAt }
const WANDER_ARRIVE = 3; // blocks: close enough counts as arrived
const WANDER_STALE_MS = 25000; // stuck safety: re-roll if a point takes too long

/**
 * Blind crafting: gather every recipe currently satisfiable from the
 * inventory (using a crafting table if one is in reach), pick ONE AT RANDOM,
 * and try it. The agent is never told what it could make or why — it fiddles,
 * and whatever appears in its hands is a discovery like any other.
 */
function craftSomethingBlindly(bot) {
  if (!bot.registry || !Array.isArray(bot.registry.itemsArray)) return;
  if (typeof bot.recipesFor !== 'function' || typeof bot.craft !== 'function') return;
  let table = null;
  try {
    if (typeof bot.findBlock === 'function') {
      table = bot.findBlock({ matching: (b) => !!b && b.name === 'crafting_table', maxDistance: 3 });
    }
  } catch (_) { /* no table in reach — 2x2 recipes only */ }
  const craftable = [];
  for (const item of bot.registry.itemsArray) {
    try {
      const recipes = bot.recipesFor(item.id, null, 1, table);
      if (recipes && recipes.length) craftable.push(recipes[0]);
    } catch (_) { /* one bad item id must not stop the fiddling */ }
  }
  if (!craftable.length) return;
  const recipe = craftable[Math.floor(Math.random() * craftable.length)];
  fireAndForget(bot.craft(recipe, 1, table));
}

function setGoal(bot, goal) {
  if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
    bot.pathfinder.setGoal(goal);
  }
}

function randomOffset(range) {
  return Math.floor((Math.random() * 2 - 1) * range);
}

async function execute(bot, action) {
  const pos = bot.entity && bot.entity.position;

  switch (action.type) {
    case 'flee':
    case 'avoid': {
      // Path directly away from the target: a hostile entity (flee) or a
      // dangerous block/place (avoid) — same movement, different reason.
      if (!pos || !action.target || !action.target.position || !goals) return;
      const away = pos.minus(action.target.position);
      const length = Math.sqrt(away.x * away.x + away.z * away.z) || 1;
      const target = pos.offset((away.x / length) * 16, 0, (away.z / length) * 16);
      setGoal(bot, new goals.GoalXZ(Math.round(target.x), Math.round(target.z)));
      return;
    }

    case 'eat': {
      // Equip the chosen food item and consume it.
      const items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
      const item = items.find((i) => i.name === action.item);
      if (!item) return;
      await bot.equip(item, 'hand');
      await bot.consume();
      return;
    }

    case 'seekFood':
    case 'explore': {
      // Wander toward ONE committed point and actually get there (see the
      // wanders note above). ROADMAP: real foraging/hunting logic (targeting
      // passive mobs, harvesting crops) is a future item — seekFood currently
      // wanders and hopes, same as explore.
      if (!pos || !goals) return;
      const prev = wanders.get(bot);
      const arrived = prev && Math.hypot(pos.x - prev.x, pos.z - prev.z) <= WANDER_ARRIVE;
      const stale = prev && Date.now() - prev.setAt > WANDER_STALE_MS;
      if (!prev || arrived || stale) {
        const next = {
          x: Math.round(pos.x + randomOffset(24)),
          z: Math.round(pos.z + randomOffset(24)),
          setAt: Date.now(),
        };
        wanders.set(bot, next);
        setGoal(bot, new goals.GoalXZ(next.x, next.z));
      } else {
        // Keep walking to the same point (re-asserted in case another action
        // — a flee, a dig — replaced the pathfinder goal in between).
        setGoal(bot, new goals.GoalXZ(prev.x, prev.z));
      }
      return;
    }

    case 'approach': {
      // Walk toward a creature or person: mechanically "close the distance",
      // nothing about why. Resolved to the LIVE entity by name each time, so
      // a moving target — someone walking somewhere — can actually be
      // followed rather than chased to where they used to stand.
      if (!action.target || !goals) return;
      const live = action.target.name ? entityByName(bot, action.target.name) : null;
      const p = (live && live.position) || action.target.position;
      if (!p) return;
      setGoal(bot, new goals.GoalNear(p.x, p.y, p.z, 2));
      return;
    }

    case 'swingAt': {
      // Swing the arm at the nearest creature: attack if in reach, otherwise
      // close the distance (the swing may land on a later tick).
      if (!action.target || !action.target.position) return;
      const entity = entityNear(bot, action.target.position);
      const dist = entity && pos ? entity.position.distanceTo(pos) : Infinity;
      if (entity && dist <= 3.5 && typeof bot.attack === 'function') {
        bot.attack(entity);
      } else if (entity && goals) {
        setGoal(bot, new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2));
      }
      return;
    }

    case 'dig': {
      // Break the targeted block: dig if in reach, otherwise walk to it.
      // NOT awaited — digging stone takes seconds and the mind keeps ticking.
      if (!action.target || !action.target.position) return;
      const block = bot.blockAt && bot.blockAt(action.target.position);
      if (!block) return;
      const inReach = action.target.distance == null || action.target.distance <= 4;
      if (inReach && typeof bot.dig === 'function') {
        fireAndForget(bot.dig(block));
      } else if (goals) {
        const p = action.target.position;
        setGoal(bot, new goals.GoalNear(p.x, p.y, p.z, 2));
      }
      return;
    }

    case 'place': {
      // Set something carried down on the ground ahead. The item is chosen at
      // random — the body doesn't know which of its things can be placed; if
      // the chosen one can't be, nothing happens and nothing is learned but
      // the attempt itself.
      const items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
      if (!items.length || !pos || !Vec3) return;
      const item = items[Math.floor(Math.random() * items.length)];
      try {
        await bot.equip(item, 'hand');
      } catch (_) {
        return;
      }
      if (typeof bot.placeBlock !== 'function' || !bot.blockAt) return;
      const ref = bot.blockAt(pos.offset(1, -1, 0));
      if (!ref) return;
      fireAndForget(bot.placeBlock(ref, new Vec3(0, 1, 0)));
      return;
    }

    case 'pickup': {
      // Walk to the nearest thing lying on the ground; contact collects it.
      if (!action.target || !action.target.position || !goals) return;
      const p = action.target.position;
      setGoal(bot, new goals.GoalNear(p.x, p.y, p.z, 1));
      return;
    }

    case 'craft': {
      craftSomethingBlindly(bot);
      return;
    }

    case 'idle':
    default:
      if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop();
  }
}

module.exports = { execute };
