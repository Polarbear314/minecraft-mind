// The body's own frame of reference: "below", "above", "ahead", "left"...
// relative to where the bot stands and which way it faces. This is what lets
// motor primitives be COMPLETE without being purposeful: the hand can reach
// any neighbouring block (including under the feet and over the head), and
// nothing here knows what reaching there is for. (Fodor & Pylyshyn: a body
// that can dig ahead can dig below; Newell & Simon: every process the machine
// can do needs an expression that designates it.)
//
// Positions are block coordinates. "feet" is the block the bot stands in;
// the head is the block above it.

/** Every direction word the cortex may use, as [right, up, forward] steps. */
const DIRECTIONS = {
  below: [0, -1, 0], // the block under the feet
  above: [0, 2, 0], // the block over the head
  ahead: [0, 0, 1],
  behind: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  'ahead-up': [0, 1, 1], // head height
  'behind-up': [0, 1, -1],
  'left-up': [-1, 1, 0],
  'right-up': [1, 1, 0],
  'ahead-down': [0, -1, 1], // the ground in front
  'behind-down': [0, -1, -1],
  'left-down': [-1, -1, 0],
  'right-down': [1, -1, 0],
};
const DIRECTION_NAMES = Object.keys(DIRECTIONS);
const MOVE_DIRECTIONS = ['ahead', 'behind', 'left', 'right'];

// Block kinds, by name. The body knows these the way a hand knows air from
// stone — not what any of them are for.
const EMPTY = new Set(['air', 'cave_air', 'void_air']);
const REPLACEABLE = new Set([
  'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow', 'vine',
  'seagrass', 'tall_seagrass',
]);
const LIQUID = new Set(['water', 'lava', 'bubble_column']);
const UNBREAKABLE = new Set(['bedrock', 'barrier', 'end_portal_frame', 'command_block', 'structure_block']);

const isEmpty = (b) => !b || EMPTY.has(b.name);
/** Nothing there that would stop a block being set in this spot. */
const isOpen = (b) => !b || EMPTY.has(b.name) || REPLACEABLE.has(b.name);
/** Something a body could stand on or set a block against. */
const isSolid = (b) => !!b && !EMPTY.has(b.name) && !REPLACEABLE.has(b.name) && !LIQUID.has(b.name)
  && b.boundingBox !== 'empty';
const isDiggable = (b) => !!b && !EMPTY.has(b.name) && !LIQUID.has(b.name) && !UNBREAKABLE.has(b.name)
  && b.diggable !== false;

/** Cardinal facing from the entity's yaw: { fx, fz } with one of them ±1. */
function facing(bot) {
  const yaw = (bot && bot.entity && Number(bot.entity.yaw)) || 0;
  // mineflayer: yaw 0 faces -Z; looking direction is (-sin yaw, -cos yaw).
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  return Math.abs(dx) > Math.abs(dz) ? { fx: Math.sign(dx), fz: 0 } : { fx: 0, fz: Math.sign(dz) || -1 };
}

/** The block the feet are in, as integer coordinates, or null. */
function feetOf(bot) {
  const p = bot && bot.entity && bot.entity.position;
  if (!p) return null;
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

/**
 * Resolve a direction word to world block coordinates, relative to the body.
 * Returns { x, y, z } or null for an unknown word / no body.
 */
function resolve(bot, at) {
  const feet = feetOf(bot);
  const step = DIRECTIONS[String(at || '').toLowerCase()];
  if (!feet || !step) return null;
  const { fx, fz } = facing(bot);
  const [r, up, fwd] = step;
  // right-hand vector of a facing (fx, fz) is (-fz, fx)
  return { x: feet.x + fwd * fx + r * -fz, y: feet.y + up, z: feet.z + fwd * fz + r * fx };
}

/** Normalise a direction the cortex wrote ("Below", "under me", "up"...). */
function normalizeDirection(raw) {
  const s = String(raw || '').toLowerCase().trim().replace(/\s+/g, '-');
  if (DIRECTIONS[s]) return s;
  const aliases = {
    down: 'below', under: 'below', 'under-me': 'below', beneath: 'below', 'below-me': 'below',
    up: 'above', over: 'above', overhead: 'above', 'above-me': 'above', 'over-my-head': 'above',
    forward: 'ahead', front: 'ahead', 'in-front': 'ahead', back: 'behind', backward: 'behind',
  };
  return aliases[s] || null;
}

module.exports = {
  DIRECTIONS, DIRECTION_NAMES, MOVE_DIRECTIONS, EMPTY, REPLACEABLE, LIQUID,
  isEmpty, isOpen, isSolid, isDiggable, facing, feetOf, resolve, normalizeDirection,
};
