// Affordances: what the world around the body offers it RIGHT NOW, relative to
// what the body can do (Gibson, via Haugeland: a nook affords shelter, a
// surface affords standing). Computed fresh every tick — "perception is
// cheap, representation expensive": the bot looks again instead of keeping a
// model of the world in its vault.
//
// Nothing here says what any of it is FOR. "No sky overhead" is a fact of
// perception; whether it matters is for experience to teach.
const { isSolid, isDiggable, isOpen, feetOf, DIRECTIONS, resolve } = require('../actions/bodyFrame');

const SKY_SCAN = 24; // blocks above the head checked for any cover
const NEARBY_RANGE = 8; // blocks: how far doors/beds are noticed

let usableIds = null; // block ids of doors/trapdoors/gates/beds, per registry

function usableKind(name) {
  if (!name) return null;
  if (name.endsWith('_bed')) return 'bed';
  if (name.endsWith('_door') && !name.includes('trapdoor')) return 'door';
  if (name.endsWith('_trapdoor')) return 'trapdoor';
  if (name.endsWith('_fence_gate')) return 'gate';
  return null;
}

function at(bot, x, y, z) {
  try {
    return bot.blockAt ? bot.blockAt(new (bot.entity.position.constructor)(x, y, z)) : null;
  } catch (_) {
    return null;
  }
}

/** Nearest door and bed (and other usable blocks) within range. */
function nearbyUsable(bot, feet) {
  const found = {};
  if (typeof bot.findBlocks !== 'function') return found;
  let matching;
  if (bot.registry && Array.isArray(bot.registry.blocksArray)) {
    if (!usableIds) usableIds = bot.registry.blocksArray.filter((b) => usableKind(b.name)).map((b) => b.id);
    matching = usableIds;
  } else {
    matching = (b) => !!b && !!usableKind(b.name); // mock bot
  }
  let positions = [];
  try {
    positions = bot.findBlocks({ matching, maxDistance: NEARBY_RANGE, count: 24 }) || [];
  } catch (_) {
    return found;
  }
  for (const p of positions) {
    const block = bot.blockAt && bot.blockAt(p);
    const kind = block && usableKind(block.name);
    if (!kind) continue;
    const d = Math.round(Math.hypot(p.x - feet.x, p.y - feet.y, p.z - feet.z) * 10) / 10;
    if (!found[kind] || d < found[kind].distance) found[kind] = { name: block.name, distance: d, position: p };
  }
  return found;
}

/**
 * The body's affordances, or null without a body. Shape:
 * { skyOverhead, roof, walls (0-4 sides closed at both feet and head height),
 *   enclosed, standingOn, canDigBelow, canDig: [dirs], canPlace: [dirs],
 *   placeable (carried block kinds), door, bed, trapdoor, gate }
 */
function senseAffordances(bot) {
  const feet = feetOf(bot);
  if (!feet || !bot.blockAt) return null;

  const roof = isSolid(at(bot, feet.x, feet.y + 2, feet.z));
  let skyOverhead = true;
  for (let dy = 2; dy <= SKY_SCAN; dy += 1) {
    const b = at(bot, feet.x, feet.y + dy, feet.z);
    if (b && !isOpen(b) && b.name !== 'water') { skyOverhead = false; break; }
  }
  let walls = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const low = at(bot, feet.x + dx, feet.y, feet.z + dz);
    const high = at(bot, feet.x + dx, feet.y + 1, feet.z + dz);
    const closed = (b) => isSolid(b) || (b && usableKind(b.name) === 'door');
    if (closed(low) && closed(high)) walls += 1;
  }
  const below = at(bot, feet.x, feet.y - 1, feet.z);

  const canDig = [];
  const canPlace = [];
  for (const dir of Object.keys(DIRECTIONS)) {
    const p = resolve(bot, dir);
    const b = p && at(bot, p.x, p.y, p.z);
    if (isDiggable(b)) canDig.push(dir);
    if (isOpen(b) && dir !== 'below') canPlace.push(dir); // body space excluded below
  }

  const items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
  const placeable = items
    .filter((i) => (bot.registry && bot.registry.blocksByName ? !!bot.registry.blocksByName[i.name] : true))
    .map((i) => i.name);

  return {
    skyOverhead,
    roof,
    walls,
    enclosed: roof && walls === 4,
    standingOn: below ? below.name : null,
    canDigBelow: isDiggable(below),
    canDig,
    canPlace: placeable.length ? canPlace : [],
    placeable: [...new Set(placeable)],
    ...nearbyUsable(bot, feet),
  };
}

/** One plain-language line for the cortex's prompt. No purposes, only facts. */
function describeAffordances(a) {
  if (!a) return null;
  const parts = [];
  parts.push(a.skyOverhead ? 'open sky above you' : a.roof ? 'a block directly over your head' : 'something far overhead, blocking the sky');
  parts.push(a.walls === 4 ? 'blocks on all four sides of you' : a.walls === 0 ? 'nothing beside you on any side' : `blocks on ${a.walls} of your four sides`);
  if (a.standingOn) parts.push(`standing on ${a.standingOn.replace(/_/g, ' ')}${a.canDigBelow ? ' (your hands could break it)' : ''}`);
  parts.push(a.placeable.length ? `you carry things you could set down as blocks: ${a.placeable.join(', ')}` : 'you carry nothing that could be set down as a block');
  for (const kind of ['door', 'bed', 'trapdoor', 'gate']) {
    if (a[kind]) parts.push(`a ${a[kind].name.replace(/_/g, ' ')} ${a[kind].distance} blocks away`);
  }
  return parts.join('; ') + '.';
}

module.exports = { senseAffordances, describeAffordances, usableKind };
