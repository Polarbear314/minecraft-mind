// Decision log: one JSON line per Claude consultation, saved for later
// distillation. Each line pairs what the bot saw (and the exact prompt) with
// what Claude decided, what instinct would have done instead, and whether
// Claude's answer actually reached the body. Narrow jobs that pile up enough
// examples here (e.g. "is this a threat?") can later be fine-tuned into small
// local models — the deliberate cortex training its own reflexes.
//
// Files: <dir>/decisions-YYYY-MM-DD.jsonl (local date). Logging must never
// break a tick: every failure here is swallowed.
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

function pos(p) {
  if (!p || typeof p.x !== 'number') return null;
  const r = (n) => Math.round(n * 10) / 10;
  return { x: r(p.x), y: r(p.y), z: r(p.z) };
}

/** A small, JSON-safe description of an action (targets are live objects). */
function summarizeAction(action) {
  if (!action || typeof action !== 'object') return null;
  const out = { type: action.type };
  const t = action.target;
  if (typeof t === 'string') out.target = { name: t };
  else if (t) out.target = { name: t.name || null, distance: t.distance != null ? t.distance : null, position: pos(t.position) };
  for (const k of ['at', 'item', 'reason', 'thought', 'say', 'intention', 'source', 'result']) {
    if (action[k] !== undefined) out[k] = action[k];
  }
  return out;
}

/** The world as the bot saw it, without mineflayer's circular objects. */
function summarizeObservation(o) {
  if (!o) return null;
  const ent = (e) => ({
    name: e.name, distance: e.distance != null ? e.distance : null,
    hostile: !!e.hostile, isPlayer: !!e.isPlayer, position: pos(e.position),
  });
  return {
    health: o.health != null ? o.health : null,
    food: o.food != null ? o.food : null,
    isDay: o.isDay != null ? o.isDay : null,
    position: pos(o.position),
    nearbyEntities: (o.nearbyEntities || []).map(ent),
    nearestHostile: o.nearestHostile ? ent(o.nearestHostile) : null,
    nearbyBlocks: (o.nearbyBlocks || []).map((b) => ({ name: b.name, distance: b.distance != null ? b.distance : null, position: pos(b.position) })),
    nearbyItems: (o.nearbyItems || []).map((i) => ({ name: i.name, distance: i.distance != null ? i.distance : null })),
    inventory: (o.inventory || []).map((i) => ({ name: i.name, count: i.count })),
    chatLines: o.chatLines || null,
    borderDistance: o.borderDistance != null ? o.borderDistance : null,
    affordances: o.affordances ? (({ door, bed, trapdoor, gate, ...rest }) => ({
      ...rest,
      ...(door ? { door: door.distance } : {}),
      ...(bed ? { bed: bed.distance } : {}),
    }))(o.affordances) : null,
  };
}

function summarizeDrives(d) {
  if (!d) return null;
  const r = (n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : null);
  let dominant = null;
  try { dominant = typeof d.dominant === 'function' ? d.dominant() : null; } catch (_) { /* fine */ }
  return { hunger: r(d.hunger), fear: r(d.fear), curiosity: r(d.curiosity), dominant };
}

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let appendWarned = false;

/**
 * Append one JSON line to <dir>/<prefix>-YYYY-MM-DD.jsonl (local date). Never
 * throws; the first failure is reported once, later ones stay silent.
 */
function appendJsonLine(dir, prefix, entry) {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ v: SCHEMA_VERSION, ...entry });
    fs.appendFileSync(path.join(dir, `${prefix}-${localDate(new Date())}.jsonl`), `${line}\n`, 'utf8');
  } catch (err) {
    if (!appendWarned) {
      appendWarned = true;
      console.error(`[log] could not write ${prefix} log (further failures stay silent): ${err.message}`);
    }
  }
}

/**
 * createDecisionLog(dir) -> { record(entry) }. Pass a falsy dir for a no-op log.
 * record() appends synchronously (one small write per consultation, ~every
 * 30s) so a crash can't lose a line that was already decided.
 */
function createDecisionLog(dir) {
  if (!dir) return { record() {}, dir: null };
  return { dir, record: (entry) => appendJsonLine(dir, 'decisions', entry) };
}

module.exports = { appendJsonLine, createDecisionLog, summarizeAction, summarizeObservation, summarizeDrives };
