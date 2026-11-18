// Training examples for the learned layers, from the tick log (stage 4).
//
// Labels judge an act by what came of it over the following minute or so,
// not the next few seconds (a hunt pays off when the meat is eaten; walking
// past a cow costs nothing until noon). For a layer L:
//
//   L had the body, and it went well      -> "do that act here"
//   L had the body, and it went badly     -> "stay quiet here" (let the
//                                            other layers act)
//   L was silent and nothing bad came of it in L's domain -> "stay quiet"
//                                            (sampled: there are many)
//   L spoke but was overridden            -> skipped (nothing came of it)
//   Forage was silent with food in reach, and the body went hungry within
//   the next ten minutes                  -> "take that food" (the act that
//                                            was there: pick up, harvest, hunt).
//                                            The delayed lesson: walking past
//                                            a cow costs nothing until noon.
//
// "Went well/badly" is per layer: Forage is judged by food gained (food bar,
// food carried) and by getting hurt; Wander by getting about safely.
const { vector } = require('./features');

const MENUS = {
  forage: ['eat', 'pickup', 'harvest', 'hunt', 'seekFood', 'none'],
  wander: ['explore', 'fiddle', 'approach', 'idle', 'none'],
};
const WINDOW = { forage: 40, wander: 20 }; // ticks ahead (1.5 s each)
const QUIET_SAMPLE = 5; // keep 1 in this many "stayed quiet" ticks
const GAP_MS = 30000; // a longer gap between ticks ends the look-ahead
const LATER = 400; // ticks (10 min): how far ahead "went hungry later" looks
const HUNGRY_FOOD = 6; // food bar at or below this counts as having gone hungry

function actClass(layer, a) {
  if (layer === 'forage') {
    if (a.type === 'eat') return 'eat';
    if (a.type === 'pickup') return 'pickup';
    if (a.type === 'dig' && a.harvest) return 'harvest';
    if (a.type === 'swingAt') return 'hunt';
    if (a.type === 'seekFood') return 'seekFood';
    return null;
  }
  if (layer === 'wander') {
    if (a.type === 'explore') return 'explore';
    if (a.type === 'approach') return 'approach';
    if (a.type === 'idle') return 'idle';
    return 'fiddle';
  }
  return null;
}

/** What came of tick i for a layer: 'good' | 'bad' | null (can't tell). */
function outcome(layer, ticks, i) {
  const t = ticks[i];
  if (t.result && t.result.ok === false) return 'bad';
  const end = Math.min(ticks.length - 1, i + WINDOW[layer]);
  let hurt = 0; let gained = false; let moved = 0; let died = false;
  for (let k = i + 1; k <= end; k++) {
    const p = ticks[k - 1]; const c = ticks[k];
    if (Date.parse(c.ts) - Date.parse(p.ts) > GAP_MS) break;
    if (p.health != null && c.health != null) {
      if (c.health < p.health) hurt += p.health - c.health;
      if (p.health <= 6 && c.health === 20) died = true;
    }
    if ((c.food ?? 0) > (t.food ?? 0) || (c.foodCarried ?? 0) > (t.foodCarried ?? 0)) gained = true;
    if (p.pos && c.pos) moved += Math.min(12, Math.hypot(c.pos.x - p.pos.x, c.pos.z - p.pos.z));
  }
  if (died || hurt >= 4) return 'bad';
  if (layer === 'forage') return gained ? 'good' : null;
  if (layer === 'wander') return moved > 2 || t.action.type !== 'explore' ? 'good' : null;
  return null;
}

/** Food that was in reach at tick t, as the Forage act that would take it. */
function foodInReach(t) {
  const { FOOD_ANIMALS, FOOD_DROPS } = require('../vault/inheritance');
  if ((t.items || []).some((i) => FOOD_DROPS.includes(i.name) && (i.d == null || i.d <= 8))) return 'pickup';
  if ((t.crops || []).some((c) => c.ripe && (c.d == null || c.d <= 16))) return 'harvest';
  if ((t.near || []).some((e) => FOOD_ANIMALS.includes(e.name) && e.d != null && e.d <= 16)) return 'hunt';
  return null;
}

/** Did the body go hungry within the next ten minutes (without a long gap)? */
function wentHungryLater(ticks, i) {
  const t = ticks[i];
  if ((t.food ?? 20) <= HUNGRY_FOOD) return false; // already hungry: not a "later" lesson
  const end = Math.min(ticks.length - 1, i + LATER);
  for (let k = i + 1; k <= end; k++) {
    if (Date.parse(ticks[k].ts) - Date.parse(ticks[k - 1].ts) > GAP_MS) return false;
    if ((ticks[k].food ?? 20) <= HUNGRY_FOOD) return true;
  }
  return false;
}

/**
 * Forage missed food at tick i: it was silent by day, food was in reach, no
 * hostile was close and Survive/Shelter didn't have the body (being quiet while
 * fleeing a zombie isn't a missed meal), and the body went hungry later.
 * Returns the act that would have taken the food, or null.
 */
function missedFood(ticks, i) {
  const t = ticks[i];
  const a = t.action || {};
  if (!a.layer || (a.voices || []).includes('forage') || t.isDay === false) return null;
  if (a.layer === 'survive' || a.layer === 'shelter') return null;
  if ((t.hostiles || []).some((h) => h.d != null && h.d <= 10)) return null;
  const could = foodInReach(t);
  return could && wentHungryLater(ticks, i) ? could : null;
}

/**
 * Examples for a layer from ticks (sorted, layers mode only).
 * Returns [{ x, y, ts, actual }] where actual = what the hand-written layer did
 * (its class, or 'none' if it was silent), for comparing against it.
 */
function buildExamples(layer, ticks) {
  const out = [];
  let quiet = 0;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    const a = t.action || {};
    if (!a.layer) continue;
    const voices = a.voices || [];
    if (a.layer === layer) {
      const cls = actClass(layer, a);
      if (!cls) continue;
      const o = outcome(layer, ticks, i);
      if (o === 'good') out.push({ x: vector(t), y: cls, ts: t.ts, actual: cls });
      else if (o === 'bad') out.push({ x: vector(t), y: 'none', ts: t.ts, actual: cls });
    } else if (!voices.includes(layer)) {
      if (layer === 'forage') {
        const could = missedFood(ticks, i);
        if (could) { out.push({ x: vector(t), y: could, ts: t.ts, actual: 'none', delayed: true }); continue; }
      }
      if (quiet++ % QUIET_SAMPLE) continue;
      const o = outcome(layer, ticks, i);
      if (o !== 'bad') out.push({ x: vector(t), y: 'none', ts: t.ts, actual: 'none' });
    }
  }
  return out;
}

module.exports = { MENUS, buildExamples, outcome, actClass, foodInReach, wentHungryLater, missedFood };
