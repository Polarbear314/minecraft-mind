// What a learned layer sees (docs/design-subsumption.md, stage 4).
//
// One small, readable set of numbers per tick, computed the SAME way from a
// logged tick (for training) and from a live observation (for deciding), so
// that what a layer learns from the logs is what it sees in the world. Each
// number has a name; the classifier's weights are per name, so a person (or
// Opus, in stage 5b) can read "lava nearby -> approach: +0.4" and edit it.
const { FOOD_ANIMALS, FOOD_DROPS, EDIBLE_BY_NATURE } = require('../vault/inheritance');

const FEATURES = [
  'health', 'food', 'hunger', 'fear', 'curiosity',
  'day', 'evening',
  'enclosed', 'roof', 'walls',
  'hostileClose', 'hostiles',
  'animalClose', 'ripeCropClose', 'foodOnGround',
  'foodCarried', 'carriesNoFood',
  'personClose', 'edgeClose',
];

const closeness = (d, range = 16) => (d == null ? 0 : Math.max(0, 1 - d / range));
const nearest = (list, test) => {
  const ds = (list || []).filter(test).map((x) => x.d).filter((d) => d != null);
  return ds.length ? Math.min(...ds) : null;
};

/** Food carried, from the logged count or (older ticks) the inventory string. */
function carried(rec) {
  if (rec.foodCarried != null) return rec.foodCarried;
  let n = 0;
  for (const part of String(rec.inv || '').split(', ')) {
    const m = part.match(/^(\S+) x(\d+)/);
    if (m && EDIBLE_BY_NATURE.includes(m[1])) n += Number(m[2]);
  }
  return n;
}

/** A tick record (logs/ticks-*.jsonl) -> { name: number }. */
function featureMap(rec) {
  const d = rec.drives || {};
  const aff = rec.aff || {};
  const tod = rec.tod;
  const evening = tod != null ? (tod >= 11800 && tod < 23000 ? 1 : 0) : (rec.isDay === false ? 1 : 0);
  const food = carried(rec);
  return {
    health: (rec.health ?? 20) / 20,
    food: (rec.food ?? 20) / 20,
    hunger: (d.hunger ?? 0) / 100,
    fear: (d.fear ?? 0) / 100,
    curiosity: (d.curiosity ?? 0) / 100,
    day: rec.isDay ? 1 : 0,
    evening,
    enclosed: aff.enclosed ? 1 : 0,
    roof: aff.roof ? 1 : 0,
    walls: (aff.walls || 0) / 4,
    hostileClose: closeness(nearest(rec.hostiles, () => true)),
    hostiles: Math.min(1, (rec.hostiles || []).length / 3),
    animalClose: closeness(nearest(rec.near, (e) => FOOD_ANIMALS.includes(e.name))),
    ripeCropClose: closeness(nearest(rec.crops, (c) => c.ripe)),
    foodOnGround: closeness(nearest(rec.items, (i) => FOOD_DROPS.includes(i.name)), 8),
    foodCarried: Math.min(1, food / 8),
    carriesNoFood: food ? 0 : 1,
    personClose: closeness(nearest(rec.near, (e) => e.isPlayer)),
    edgeClose: rec.border == null ? 0 : closeness(rec.border, 32),
  };
}

const vector = (rec) => { const m = featureMap(rec); return FEATURES.map((f) => m[f]); };

/** A live observation (+ drives) -> the same shape as a logged tick record. */
function recordFromObservation(o, drives) {
  const a = o.affordances || null;
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    health: o.health,
    food: o.food,
    isDay: o.isDay,
    tod: o.timeOfDay != null ? Math.round(o.timeOfDay) : null,
    near: (o.nearbyEntities || []).filter((e) => !e.hostile).map((e) => ({ name: e.name, d: e.distance, isPlayer: !!e.isPlayer })),
    hostiles: (o.nearbyEntities || []).filter((e) => e.hostile).map((e) => ({ name: e.name, d: e.distance }))
      .concat(o.nearestHostile && !(o.nearbyEntities || []).some((e) => e.hostile) ? [{ name: o.nearestHostile.name, d: o.nearestHostile.distance }] : []),
    crops: (o.nearbyCrops || []).map((c) => ({ name: c.name, ripe: c.ripe, d: c.distance })),
    items: (o.nearbyItems || []).map((i) => ({ name: i.name, d: r1(i.distance) })),
    foodCarried: (o.inventoryFood || []).reduce((n, i) => n + (i.count || 1), 0),
    border: o.borderDistance,
    aff: a ? { roof: a.roof, walls: a.walls, enclosed: a.enclosed } : null,
    drives: drives ? { hunger: drives.hunger, fear: drives.fear, curiosity: drives.curiosity } : null,
  };
}

module.exports = { FEATURES, featureMap, vector, recordFromObservation, carried };
