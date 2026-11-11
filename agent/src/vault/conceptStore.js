// Concept notes: the agent's accumulated impressions of things it has met.
// recordEncounter() reads-or-creates the note, runs the EMA update on drive
// weights, recomputes valence + tags, merges relations, and writes it back.
const fs = require('fs');
const path = require('path');
const fm = require('./frontmatter');
const paths = require('./paths');
const { lookup } = require('./ontologyMap');

const ALPHA = 0.2; // EMA: new = old * (1 - ALPHA) + event * ALPHA

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function ema(oldValue, eventValue) {
  const old = Number.isFinite(oldValue) ? oldValue : 0;
  return old * (1 - ALPHA) + eventValue * ALPHA;
}

/**
 * Overall valence. NOTE the sign convention: hunger_weight means "satisfies
 * hunger" and contributes POSITIVELY (the agent likes what feeds it); fear is
 * negative; curiosity nudges positive.
 */
function computeValence(w) {
  return clamp(-w.fear + w.hunger + w.curiosity * 0.3, -1, 1);
}

function valenceBand(v) {
  if (v >= 0.3) return 'positive';
  if (v <= -0.3) return 'negative';
  return 'neutral';
}

/** Coarse type/* tag from the class path (non-hazard Objects band under type/resource). */
function typeTag(classPath) {
  if (classPath.startsWith('Entity')) return 'type/entity';
  if (classPath.includes('Hazard')) return 'type/hazard';
  if (classPath.startsWith('Place')) return 'type/location';
  return 'type/resource';
}

function mergeLinks(existing, additions) {
  const list = Array.isArray(existing) ? existing.slice() : existing ? [existing] : [];
  for (const title of additions || []) {
    if (!title) continue;
    const wikilink = fm.link(title);
    if (!list.includes(wikilink)) list.push(wikilink);
  }
  return list;
}

/**
 * Record one encounter with a thing in the world.
 *
 * kind: 'entity' | 'block' | 'item'; rawName: the raw Minecraft name.
 * opts: {
 *   timestamp: Date,            // defaults to now
 *   tookDamage: boolean,        // damage attributed to this thing -> fear event 1.0
 *   locatedIn: [title, ...],    // location note titles
 *   coOccursWith: [title, ...], // other concept titles seen this tick
 * }
 *
 * Returns { title, isFirstEncounter, valence, band, crossedBand, classPath, file }
 * so the caller can decide whether this encounter is notable enough for an
 * Experience note.
 */
function recordEncounter(vaultPath, kind, rawName, opts = {}) {
  const { classPath, drives: base } = lookup(kind, rawName);
  const title = paths.titleCase(rawName);
  const file = paths.conceptPath(vaultPath, classPath, title);
  const now = (opts.timestamp || new Date()).toISOString();
  const className = classPath.split('/').pop();
  const isFirst = !fs.existsSync(file);
  const isHostileClass = classPath.endsWith('Hostile Mob');

  // Event values the EMA drifts toward. A safe encounter with a hostile pulls
  // fear toward 40% of its prior — this is the habituation mechanism.
  const event = {
    fear: opts.tookDamage ? 1.0 : isHostileClass ? base.fear * 0.4 : base.fear,
    hunger: base.hunger,
    curiosity: base.curiosity,
  };

  let data = {};
  let body = '';
  let weights;
  let count;
  let first;
  let oldValence = null;

  if (isFirst) {
    // First impression = the ontology prior (full fear — it hasn't been
    // habituated yet), or 1.0 fear if the first meeting drew blood.
    weights = {
      fear: opts.tookDamage ? Math.max(base.fear, 1.0) : base.fear,
      hunger: base.hunger,
      curiosity: base.curiosity,
    };
    count = 1;
    first = now;
    const where = opts.locatedIn && opts.locatedIn.length ? ` near ${opts.locatedIn.join(', ')}` : '';
    body = `A ${className.toLowerCase()} the agent first encountered${where} on ${now.slice(0, 10)}.` +
      (opts.tookDamage ? ' The first meeting hurt.' : '');
  } else {
    ({ data, body } = fm.parse(fs.readFileSync(file, 'utf8')));
    weights = {
      fear: ema(data.fear_weight, event.fear),
      hunger: ema(data.hunger_weight, event.hunger),
      curiosity: ema(data.curiosity_weight, event.curiosity),
    };
    count = (Number(data.encounter_count) || 0) + 1;
    first = data.first_encountered || now;
    oldValence = Number.isFinite(Number(data.valence)) ? Number(data.valence) : 0;
  }

  const valence = round3(computeValence(weights));
  const band = valenceBand(valence);
  const crossedBand = !isFirst && valenceBand(oldValence) !== band;

  const affects = [];
  if (weights.fear >= 0.15) affects.push(fm.link('Fear'));
  if (weights.hunger >= 0.15) affects.push(fm.link('Hunger'));
  if (weights.curiosity >= 0.15) affects.push(fm.link('Curiosity'));

  const newData = {
    ...data,
    is_a: fm.link(className),
    affects_drive: affects,
    fear_weight: round3(weights.fear),
    hunger_weight: round3(weights.hunger),
    curiosity_weight: round3(weights.curiosity),
    valence,
    encounter_count: count,
    first_encountered: first,
    last_encountered: now,
    tags: [`valence/${band}`, typeTag(classPath)],
  };

  const locatedIn = mergeLinks(data.located_in, opts.locatedIn);
  if (locatedIn.length) newData.located_in = locatedIn;
  const coOccurs = mergeLinks(data.co_occurs_with, opts.coOccursWith);
  if (coOccurs.length) newData.co_occurs_with = coOccurs;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fm.stringify(newData, body), 'utf8');

  return { title, isFirstEncounter: isFirst, valence, band, crossedBand, classPath, file };
}

/**
 * Ensure a Location note exists (Biome or Landmark instance). Returns its title.
 * Locations are created once and left alone — they're link targets, not
 * emotional objects (a future pass could give places valence too).
 */
function ensureLocation(vaultPath, rawName, className = 'Biome') {
  const title = paths.titleCase(rawName);
  const file = paths.locationPath(vaultPath, title);
  if (!fs.existsSync(file)) {
    const data = {
      is_a: fm.link(className),
      first_visited: new Date().toISOString(),
      tags: ['type/location'],
    };
    const body = `A ${className.toLowerCase()} the agent has visited.`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fm.stringify(data, body), 'utf8');
  }
  return title;
}

module.exports = { recordEncounter, ensureLocation, computeValence, valenceBand, ALPHA };
