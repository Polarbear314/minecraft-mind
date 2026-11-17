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
const { borderOf, clampInside } = require('../perception/worldBorder');
const {
  DIRECTIONS, MOVE_DIRECTIONS, LIQUID, isEmpty, isOpen, isSolid, isDiggable, facing, resolve,
} = require('./bodyFrame');
const { usableKind } = require('../perception/affordances');

const BORDER_KEEP_IN = 6; // blocks: destinations are pulled at least this far inside the border

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

/** An XZ destination, pulled back inside the world border if there is one. */
function goalXZ(bot, x, z) {
  const p = clampInside(borderOf(bot), x, z, BORDER_KEEP_IN);
  return new goals.GoalXZ(p.x, p.z);
}

// ------------------------------------------------------------ results
// Every primitive reports what actually happened, so the mind can learn from
// it (Lucken's "registration"): { ok: true, did } or { ok: false, reason }.
// Reasons are plain first-person words — they become memories.
const done = (did) => ({ ok: true, did });
const fail = (reason) => ({ ok: false, reason });
const pretty = (name) => String(name || 'something').replace(/_/g, ' ');

function blockAtXYZ(bot, p) {
  if (!p || !bot.blockAt || !Vec3) return null;
  try {
    return bot.blockAt(new Vec3(p.x, p.y, p.z));
  } catch (_) {
    return null;
  }
}

/** Is the body already in the middle of breaking this block? */
function isDiggingAt(bot, block) {
  const t = bot.targetDigBlock;
  return !!(t && t.position && block && block.position &&
    t.position.x === block.position.x && t.position.y === block.position.y && t.position.z === block.position.z);
}

/** Break the block in a body-relative direction. */
function digAt(bot, at) {
  const p = resolve(bot, at);
  if (!p) return fail(`I could not tell where "${at}" was`);
  const block = blockAtXYZ(bot, p);
  if (isEmpty(block)) return fail(`there was only air ${at === 'below' ? 'under me' : at === 'above' ? 'over my head' : at}`);
  if (LIQUID.has(block.name)) return fail(`there was only ${pretty(block.name)} there`);
  if (!isDiggable(block)) return fail(`the ${pretty(block.name)} would not break`);
  if (typeof bot.dig !== 'function') return fail('my hands would not answer');
  // Already breaking this very block: keep at it. Re-issuing the dig every
  // tick ABORTED the one in progress, so stone (~7.5 s by hand) never broke
  // (2026-11-16: the bot stood on stone digging "below" for minutes).
  if (isDiggingAt(bot, block)) return done(`still breaking the ${pretty(block.name)} ${at}`);
  // Stand still while breaking what's under or over me.
  if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') bot.pathfinder.setGoal(null);
  fireAndForget(bot.dig(block));
  return done(`breaking the ${pretty(block.name)} ${at}`);
}

/** Set a carried block down in a body-relative direction. */
async function placeAt(bot, at, wanted) {
  const p = resolve(bot, at);
  if (!p) return fail(`I could not tell where "${at}" was`);
  const target = blockAtXYZ(bot, p);
  if (!isOpen(target)) return fail(`the ${pretty(target && target.name)} was already there`);
  const items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
  const isBlock = (i) => (bot.registry && bot.registry.blocksByName ? !!bot.registry.blocksByName[i.name] : true);
  const blocks = items.filter(isBlock);
  if (!blocks.length) return fail('I carried nothing that could be set down as a block');
  const want = String(wanted || '').toLowerCase();
  const item = (want && blocks.find((i) => i.name === want || i.name.includes(want)))
    || blocks[Math.floor(Math.random() * blocks.length)];
  // Something solid beside the spot to set it against: under it first.
  let ref = null;
  let face = null;
  for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
    const b = blockAtXYZ(bot, { x: p.x + dx, y: p.y + dy, z: p.z + dz });
    if (isSolid(b)) {
      ref = b;
      face = new Vec3(-dx, -dy, -dz);
      break;
    }
  }
  if (!ref) return fail('there was nothing beside that spot to set a block against');
  if (typeof bot.placeBlock !== 'function') return fail('my hands would not answer');
  try {
    await bot.equip(item, 'hand');
  } catch (_) {
    return fail(`my hand would not take the ${pretty(item.name)}`);
  }
  if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') bot.pathfinder.setGoal(null);
  fireAndForget(bot.placeBlock(ref, face));
  return done(`set ${pretty(item.name)} down ${at}`);
}

/** Work a block with the hand: open a door, lie in a bed, flip a lever. */
async function useBlock(bot, action) {
  const pos = bot.entity && bot.entity.position;
  let block = null;
  if (action.at) {
    block = blockAtXYZ(bot, resolve(bot, action.at));
  } else if (typeof bot.findBlock === 'function') {
    const want = String((action.target && action.target.name) || action.target || '').toLowerCase();
    try {
      block = bot.findBlock({
        matching: (b) => !!b && b.name !== 'air' && (want ? b.name.includes(want) : !!usableKind(b.name)),
        maxDistance: 6,
      });
    } catch (_) { /* nothing found */ }
  }
  if (!block || isEmpty(block)) return fail('there was nothing there my hand could work');
  const dist = pos && block.position ? block.position.distanceTo(pos) : 0;
  if (dist > 4.5) {
    if (goals) setGoal(bot, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 1));
    return done(`walking to the ${pretty(block.name)}`);
  }
  try {
    if (usableKind(block.name) === 'bed' && typeof bot.sleep === 'function') {
      await Promise.race([bot.sleep(block), new Promise((r) => setTimeout(r, 2500))]);
      return done(`lay down in the ${pretty(block.name)}`);
    }
    if (typeof bot.activateBlock !== 'function') return fail('my hands would not answer');
    await Promise.race([bot.activateBlock(block), new Promise((r) => setTimeout(r, 2500))]);
    return done(`worked the ${pretty(block.name)}`);
  } catch (err) {
    return fail(`the ${pretty(block.name)} would not: ${String(err && err.message || err).slice(0, 80)}`);
  }
}

/** Make one of a named item from what is carried (with a crafting table if one is close). */
async function craftNamed(bot, wanted) {
  const name = String(wanted || '').toLowerCase().trim().replace(/\s+/g, '_');
  const reg = bot.registry;
  if (!reg || !reg.itemsByName || typeof bot.recipesFor !== 'function' || typeof bot.craft !== 'function') {
    return fail('my hands would not answer');
  }
  const item = reg.itemsByName[name] || Object.values(reg.itemsByName).find((i) => i.name.endsWith(name));
  if (!item) return fail(`I could not picture a ${pretty(name)}`);
  let table = null;
  try {
    table = bot.findBlock({ matching: (b) => !!b && b.name === 'crafting_table', maxDistance: 4 });
  } catch (_) { /* none in reach */ }
  let recipes = [];
  try { recipes = bot.recipesFor(item.id, null, 1, table) || []; } catch (_) { /* none */ }
  if (!recipes.length) {
    let needsTable = false;
    try {
      needsTable = !table && typeof bot.recipesAll === 'function' &&
        (bot.recipesAll(item.id, null, true) || []).some((r) => r.requiresTable);
    } catch (_) { /* unknown */ }
    return fail(needsTable
      ? `I would need a crafting table close by to make a ${pretty(item.name)}`
      : `I lacked what it takes to make a ${pretty(item.name)}`);
  }
  try {
    await Promise.race([
      bot.craft(recipes[0], 1, table),
      new Promise((_, reject) => setTimeout(() => reject(new Error('took too long')), 6000)),
    ]);
  } catch (err) {
    return fail(`making the ${pretty(item.name)} failed (${String(err && err.message || err).slice(0, 60)})`);
  }
  return done(`made a ${pretty(item.name)}`);
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
      setGoal(bot, goalXZ(bot, target.x, target.z));
      return;
    }

    case 'returnInside': {
      // Brainstem: walk to the nearest point comfortably inside the border.
      if (!pos || !goals) return;
      wanders.delete(bot); // any wander point out there is void now
      setGoal(bot, goalXZ(bot, pos.x, pos.z));
      return;
    }

    case 'eat': {
      // Put a carried thing in the mouth. ANY carried thing may be tried: the
      // body does not come knowing what is food — what goes down is learned
      // (vault/bodyKnowledge.js), and what won't is registered as a gap.
      const items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
      const item = items.find((i) => i.name === action.item);
      if (!item) return fail(action.item ? `I carry no ${pretty(action.item)}` : 'I had nothing to eat');
      try {
        await bot.equip(item, 'hand');
      } catch (_) {
        return fail(`my hand would not take the ${pretty(item.name)}`);
      }
      // Judge by the BODY, not the eating animation: the consume promise can
      // resolve for things that aren't food, and time out when a hit
      // interrupts a real meal (both happened live, 2026-11-16). What counts
      // is whether the food bar went up — and a bite cut short by a blow
      // teaches nothing about the food.
      const foodBefore = Number(bot.food);
      const healthBefore = Number(bot.health);
      try {
        await Promise.race([
          bot.consume(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 4000)),
        ]);
      } catch (err) {
        if (/full/i.test(String(err && err.message))) return fail('I was too full to eat');
      }
      await new Promise((r) => setTimeout(r, 250)); // the server's food update lands
      if (Number(bot.food) > foodBefore) return done(`ate the ${pretty(item.name)}`);
      if (Number(bot.health) < healthBefore) {
        return fail(`I was hit before I could finish eating the ${pretty(item.name)}`);
      }
      return fail(`the ${pretty(item.name)} would not go down`);
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
          ...clampInside(borderOf(bot), pos.x + randomOffset(24), pos.z + randomOffset(24), BORDER_KEEP_IN),
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
      // Swing the arm at a creature — the one named, else the nearest: attack
      // if in reach, otherwise close the distance (the swing lands on a later
      // tick; a held swingAt keeps at it). Resolved to the LIVE entity by name,
      // so a creature that moves is followed, not a spot where it stood.
      if (!action.target || !action.target.position) return fail('there was no creature there to swing at');
      const entity = (action.target.name && entityByName(bot, action.target.name)) || entityNear(bot, action.target.position);
      if (!entity) return fail(`the ${pretty(action.target.name)} was gone`);
      const dist = pos ? entity.position.distanceTo(pos) : Infinity;
      if (dist <= 3.5 && typeof bot.attack === 'function') {
        bot.attack(entity);
        return done(`swung at the ${pretty(action.target.name)}`);
      }
      if (goals) setGoal(bot, new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2));
      return done(`closing in on the ${pretty(action.target.name)}`);
    }

    case 'dig': {
      // AIMED: dig the neighbouring block in a body-relative direction
      // ("below", "above", "ahead-up"...). Complete, not purposeful: any
      // reachable block, including under the feet — what that is for is
      // for experience to teach.
      if (action.at) return digAt(bot, action.at);
      // TARGETED (older form): break the nearest interesting block, walking
      // to it first if it's out of reach. NOT awaited — the mind keeps ticking.
      if (!action.target || !action.target.position) return fail('there was nothing there to break');
      const block = bot.blockAt && bot.blockAt(action.target.position);
      if (!block) return fail('there was nothing there to break');
      const inReach = action.target.distance == null || action.target.distance <= 4;
      if (inReach && typeof bot.dig === 'function') {
        if (isDiggingAt(bot, block)) return done(`still breaking the ${pretty(block.name)}`);
        fireAndForget(bot.dig(block));
        return done(`breaking the ${pretty(block.name)}`);
      }
      if (goals) {
        const p = action.target.position;
        setGoal(bot, new goals.GoalNear(p.x, p.y, p.z, 2));
      }
      return done('walking to it');
    }

    case 'place':
      // Set a carried block down in a body-relative direction (default: ahead).
      return placeAt(bot, action.at || 'ahead', action.item);

    case 'move': {
      // A few steps in a body-relative direction. Purpose-free locomotion.
      const dir = MOVE_DIRECTIONS.includes(action.at) ? action.at : 'ahead';
      if (!pos || !goals) return fail('my legs would not answer');
      const { fx, fz } = facing(bot);
      const [r, , f] = DIRECTIONS[dir];
      const steps = 3;
      setGoal(bot, goalXZ(bot, pos.x + (f * fx + r * -fz) * steps, pos.z + (f * fz + r * fx) * steps));
      wanders.delete(bot);
      return done(`stepped ${dir}`);
    }

    case 'jump': {
      if (typeof bot.setControlState !== 'function') return fail('my legs would not answer');
      bot.setControlState('jump', true);
      setTimeout(() => {
        try { bot.setControlState('jump', false); } catch (_) { /* fine */ }
      }, 350);
      return done('jumped');
    }

    case 'use':
      // Work a block with the hand — whatever working it does (a door opens,
      // a bed is lain in, a lever flips). Named by kind or by direction.
      return useBlock(bot, action);

    case 'equip': {
      const items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
      const want = String(action.item || '').toLowerCase();
      const item = items.find((i) => i.name === want) || items.find((i) => want && i.name.includes(want));
      if (!item) return fail(want ? `I carry no ${want.replace(/_/g, ' ')}` : 'I did not say what to hold');
      try {
        await bot.equip(item, 'hand');
      } catch (err) {
        return fail(`my hand would not take the ${item.name.replace(/_/g, ' ')}`);
      }
      return done(`holding ${item.name.replace(/_/g, ' ')}`);
    }

    case 'pickup': {
      // Walk to the nearest thing lying on the ground; contact collects it.
      if (!action.target || !action.target.position || !goals) return;
      const p = action.target.position;
      setGoal(bot, new goals.GoalNear(p.x, p.y, p.z, 1));
      return;
    }

    case 'craft':
      // Phase 2 (born knowing how things are made): craft a NAMED thing.
      // Without a name, the old blind fiddling.
      if (action.item) return craftNamed(bot, action.item);
      craftSomethingBlindly(bot);
      return done('fiddled with what I carry');

    case 'idle':
    default:
      if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop();
  }
}

module.exports = { execute, digAt, placeAt, useBlock };
