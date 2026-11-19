// The behaviour stack (docs/design-subsumption.md, stage 1): MindBot organised
// by BEHAVIOURS, after Rodney Brooks's subsumption architecture, instead of by
// brain regions. Turned on with MIND=layers; MIND=regions (default) keeps the
// region design (brain/arbiter.js).
//
// Every tick each layer looks at the same situation and either stays quiet
// (null) or proposes an act. The highest layer that speaks wins:
//
//   0 Survive  — always first and never learns: the floor that keeps the body
//                alive while the others learn (border, creepers, fear, hazards,
//                starving with food in hand, a hostile on top of it at night).
//   5 Make     — runs a plan or skill from the vault; makes planks, a table, bread.
//   4 Shelter  — evening and night: bed, stay closed in, or dig in and seal.
//   3 Gather   — by day, fed and safe: pick things up, break wood, keep blocks.
//   2 Forage   — hungry: eat, take meat, hunt, taste, go looking.
//   1 Wander   — the default: go to a person to watch, fiddle, explore.
//
// Brooks's wires across layers: Survive acting, Shelter holding the body in
// the evening, urgent hunger, or food within reach while carrying little
// inhibits Make; food within reach also quiets Gather (a running plan pauses rather than keeping the
// body out after dark).
//
// Stage 1 layers are hand-written, taken from today's reflexes (reflexes.js)
// and instinct (decide.js). Later stages swap each learned layer's propose()
// for a model, with the same shape: (drives, o) -> action | null.
const { createReflexes, isOverriding, isEvening } = require('../decision/reflexes');
const { lookup } = require('../vault/ontologyMap');
const { FEAR_THRESHOLD, HUNGER_THRESHOLD, BORDER_MARGIN } = require('../decision/decide');
const { FOOD_DROPS, FOOD_ANIMALS } = require('../vault/inheritance');
const { recordFromObservation, vector } = require('../learn/features');
const { predict } = require('../learn/softmax');

const HUNGER_URGENT = 75;
const HEALTH_SAFE = 10;
const HEAL_FOOD = 18; // the food bar must be at least this for health to come back
const AVOID_RANGE = 5;
const EXPERIMENT_CHANCE = 0.15; // Wander's salt: fiddle instead of walking on
const TASTE_CHANCE = 0.25; // Forage's salt: starving, try something carried
const HOSTILE_ON_TOP = 3;
const FLEE_RANGE = 10; // fear sends it running only from a hostile this close (2026-11-17: fleeing from 16 blocks away took 10% of the first day)
const GATHER_SAFE = 8; // no hostile this close to stop and gather
const ITEM_RANGE = 8;
const LOG_RANGE = 16;
const ENOUGH_BLOCKS = 8; // carried placeable blocks: enough to seal a shelter
const ENOUGH_LOGS = 16;
const MAKE_COOLDOWN_MS = 30000;
const CROP_REACH = 16;
const STOCK = 4; // carrying fewer bites than this, Forage goes for food in reach even when not hungry
const BREAD_WHEAT = 3;
const BREAD_COOLDOWN_MS = 4000; // the steps to bread (planks, table, set it down, bake) follow quickly

const ORDER = ['survive', 'make', 'shelter', 'gather', 'forage', 'wander']; // who wins, first to last
const RANK = { survive: 0, wander: 1, forage: 2, gather: 3, shelter: 4, make: 5 };

const count = (o, test) => (o.inventory || []).filter((i) => test(i.name)).reduce((n, i) => n + (i.count || 1), 0);
const isLog = (n) => /_(log|stem)$/.test(n);
const isPlanks = (n) => /_planks$/.test(n);
const foodCarried = (o) => (o.inventoryFood || []).reduce((n, i) => n + (i.count || 1), 0);
const hostileWithin = (o, d) => !!(o.nearestHostile && o.nearestHostile.distance != null && o.nearestHostile.distance <= d);

function createLayerStack({
  planRunner = null,
  blackboard = null,
  experimentChance = EXPERIMENT_CHANCE,
  tasteChance = TASTE_CHANCE,
  random = Math.random,
  now = () => Date.now(),
  // Stage 4: learned layers. learned() -> { forage?: { model, served }, wander?: ... }
  // (fresh each call, so new nightly models are picked up). mode: 'off' |
  // 'shadow' (log what the learned layer would do; the hand-written one acts) |
  // 'on' (a model that passed the gate acts; otherwise the hand-written one).
  learned = () => ({}),
  learnedMode = 'shadow',
  learnedSalt = 0.1, // a learned layer sometimes samples instead of taking its top pick
  // Stage 6: the language-model layers for Make, Shelter and Gather
  // (brain/modelLayers.js), shadowing or replacing the hand-written ones.
  modelLayers = null,
} = {}) {
  const ownReflexes = createReflexes();
  let lastMade = 0;

  // ------------------------------------------------------------ 0 Survive
  function survive(drives, o, rx) {
    if (o.borderDistance != null && o.borderDistance <= BORDER_MARGIN) return { type: 'returnInside' };
    const c = rx.creeper(o);
    if (c) return c;
    // Evening and something right on top of us while still out: run.
    if (isEvening(o) && !(o.affordances && o.affordances.enclosed) && hostileWithin(o, HOSTILE_ON_TOP)) {
      return { type: 'flee', target: o.nearestHostile };
    }
    if (drives.fear > FEAR_THRESHOLD && hostileWithin(o, FLEE_RANGE) && !(isEvening(o) && o.affordances && o.affordances.enclosed)) {
      return { type: 'flee', target: o.nearestHostile };
    }
    const hazard = (o.nearbyBlocks || []).find(
      (b) => b.distance != null && b.distance <= AVOID_RANGE && lookup('block', b.name).drives.fear >= 0.5,
    );
    if (hazard) return { type: 'avoid', target: hazard };
    const lowHealth = o.health != null && o.health <= HEALTH_SAFE;
    if ((drives.hunger > HUNGER_URGENT || (lowHealth && drives.hunger > HUNGER_THRESHOLD)) && (o.inventoryFood || []).length) {
      return { type: 'eat', item: o.inventoryFood[0].name };
    }
    // Eat to heal: health only comes back while the food bar is nearly full,
    // so badly hurt with food in the pack, eat whatever the hunger drive says
    // (2026-11-17, found by Opus's first night review: it sat at 2-4 health
    // for a whole day carrying carrots).
    if (lowHealth && o.food != null && o.food < HEAL_FOOD && (o.inventoryFood || []).length) {
      return { type: 'eat', item: o.inventoryFood[0].name, reason: 'to heal' };
    }
    return null;
  }

  // ------------------------------------------------------------ 4 Shelter
  function shelter(drives, o, rx) {
    return rx.shelter(o);
  }

  // ------------------------------------------------------------ 5 Make
  /** What Make would make now: { act, bread } or null. bread = part of turning wheat into bread. */
  function makingNow(o) {
    const log = (o.inventory || []).find((i) => isLog(i.name));
    const planks = count(o, isPlanks);
    const planksFrom = (l) => l.name.replace(/^stripped_/, '').replace(/_(log|stem)$/, '_planks'); // stripped_oak_log -> oak_planks
    const hasTable = count(o, (n) => n === 'crafting_table') > 0;
    if (count(o, (n) => n === 'wheat') >= BREAD_WHEAT) {
      // Bread needs a crafting table within reach: use one, set one down, or make one.
      if (o.tableNear) return { act: { type: 'craft', item: 'bread' }, bread: true };
      if (hasTable) return { act: { type: 'place', at: 'ahead', item: 'crafting_table' }, bread: true };
      if (planks >= 4) return { act: { type: 'craft', item: 'crafting_table' }, bread: true };
      if (log) return { act: { type: 'craft', item: planksFrom(log) }, bread: true };
    }
    if (log && planks < 8) return { act: { type: 'craft', item: planksFrom(log) }, bread: false };
    if (planks >= 4 && !hasTable) return { act: { type: 'craft', item: 'crafting_table' }, bread: false };
    return null;
  }

  function make(drives, o, rx, { inhibited }) {
    const free = !inhibited && !hostileWithin(o, GATHER_SAFE);
    // Bread comes before a running plan (2026-11-17: it carried 7 wheat for a
    // whole day while a plan kept Make busy). The plan pauses meanwhile.
    const m = free ? makingNow(o) : null;
    if (m && m.bread && now() - lastMade >= BREAD_COOLDOWN_MS) {
      if (planRunner) planRunner.next(o, { emergency: true });
      lastMade = now();
      return m.act;
    }
    if (planRunner) {
      const step = planRunner.next(o, { emergency: inhibited });
      if (step) return step;
    }
    if (!m || now() - lastMade < MAKE_COOLDOWN_MS) return null;
    lastMade = now();
    return m.act;
  }

  // ------------------------------------------------------------ 3 Gather
  function gather(drives, o, rx, { foodChance }) {
    if (foodChance) return null; // food in reach and none carried: Forage's turn
    if (isEvening(o) || drives.hunger > HUNGER_THRESHOLD || hostileWithin(o, GATHER_SAFE)) return null;
    if (o.health != null && o.health <= HEALTH_SAFE) return null;
    const item = (o.nearbyItems || []).find((i) => i.distance == null || i.distance <= ITEM_RANGE);
    if (item) return { type: 'pickup', target: item };
    if (count(o, isLog) < ENOUGH_LOGS) {
      const log = (o.nearbyBlocks || []).filter((b) => isLog(b.name) && b.position && (b.distance == null || b.distance <= LOG_RANGE))
        .sort((x, y) => (x.distance || 0) - (y.distance || 0))[0];
      if (log) return { type: 'dig', target: log };
    }
    const a = o.affordances;
    const blocks = a && a.placeable ? count(o, (n) => a.placeable.includes(n)) : 0;
    if (a && blocks < ENOUGH_BLOCKS) {
      const side = (a.canDig || []).find((d) => d !== 'below' && d !== 'above');
      if (side) return { type: 'dig', at: side };
    }
    return null;
  }

  // ------------------------------------------------------------ 2 Forage
  /** Food that can be had right here: lying on the ground, a ripe crop, an animal. */
  function foodInReach(drives, o, rx) {
    const item = (o.nearbyItems || []).find((i) => FOOD_DROPS.includes(i.name) && (i.distance == null || i.distance <= ITEM_RANGE));
    if (item) return { type: 'pickup', target: item };
    const crop = (o.nearbyCrops || []).find((c) => c.ripe && c.position && (c.distance == null || c.distance <= CROP_REACH));
    if (crop) return { type: 'dig', target: crop, harvest: crop.name };
    return rx.hunt(drives, o); // (hunts only when carrying no food)
  }

  function forage(drives, o, rx) {
    const hungry = drives.hunger > HUNGER_THRESHOLD;
    if (hungry && foodCarried(o)) return { type: 'eat', item: o.inventoryFood[0].name };
    if (!hungry) {
      // Fed, but carrying little: by day and with no hostile close, take the
      // food that's right here (2026-11-17: it walked past cows, carrots and
      // wheat while fed, and starved later).
      if (foodCarried(o) >= STOCK || isEvening(o) || hostileWithin(o, GATHER_SAFE)) return null;
      return foodInReach(drives, o, rx);
    }
    const f = foodInReach(drives, o, rx);
    if (f) return f;
    if (drives.hunger > HUNGER_URGENT) {
      const blocks = new Set((o.affordances && o.affordances.placeable) || []);
      const untried = (o.inventory || []).filter((i) => !blocks.has(i.name) && !(o.inedible || []).includes(i.name));
      if (untried.length && random() < tasteChance) {
        return { type: 'eat', item: untried[Math.floor(random() * untried.length)].name };
      }
    }
    return { type: 'seekFood' };
  }

  // ------------------------------------------------------------ 1 Wander
  function experiment(o) {
    const options = [];
    const a = o.affordances;
    const pick = (arr) => arr[Math.floor(random() * arr.length)];
    const creature = (o.nearbyEntities || []).find((e) => !e.isPlayer);
    if (creature) options.push({ type: 'swingAt', target: creature });
    if (a && a.canDig && a.canDig.length) options.push({ type: 'dig', at: pick(a.canDig) });
    if (a && a.canPlace && a.canPlace.length) options.push({ type: 'place', at: pick(a.canPlace) });
    options.push({ type: 'jump' });
    for (const kind of ['door', 'bed', 'trapdoor', 'gate']) if (a && a[kind]) options.push({ type: 'use', target: kind });
    return pick(options);
  }

  function wander(drives, o) {
    const teacher = (o.nearbyEntities || []).find((e) => e.isPlayer);
    const lowHealth = o.health != null && o.health <= HEALTH_SAFE;
    if (!lowHealth && teacher && drives.dominant() === 'curiosity' && drives.curiosity > 40) {
      return { type: 'approach', target: teacher, reason: 'learn' };
    }
    if (drives.curiosity > 40 && random() < experimentChance) return experiment(o);
    if (drives.curiosity > 40 || isEvening(o) === false) return { type: 'explore' };
    return { type: 'idle' };
  }

  const LAYERS = { survive, make, shelter, gather, forage, wander };

  // ------------------------------------------------------------ learned layers
  /** Turn a learned layer's act class into a concrete act here, or null if it can't be done. */
  function resolve(layer, cls, drives, o, rx) {
    if (cls === 'none') return null;
    if (layer === 'forage') {
      if (cls === 'eat') return foodCarried(o) ? { type: 'eat', item: o.inventoryFood[0].name } : undefined;
      if (cls === 'pickup') {
        const item = (o.nearbyItems || []).find((i) => FOOD_DROPS.includes(i.name) && (i.distance == null || i.distance <= ITEM_RANGE));
        return item ? { type: 'pickup', target: item } : undefined;
      }
      if (cls === 'harvest') {
        const crop = (o.nearbyCrops || []).find((c) => c.ripe && c.position && (c.distance == null || c.distance <= CROP_REACH));
        return crop ? { type: 'dig', target: crop, harvest: crop.name } : undefined;
      }
      if (cls === 'hunt') {
        if (hostileWithin(o, GATHER_SAFE)) return undefined;
        const prey = (o.nearbyEntities || []).filter((e) => FOOD_ANIMALS.includes(e.name) && e.distance != null && e.distance <= 16)
          .sort((a, b) => a.distance - b.distance)[0];
        return prey ? { type: 'swingAt', target: prey } : undefined;
      }
      if (cls === 'seekFood') return { type: 'seekFood' };
    }
    if (layer === 'wander') {
      if (cls === 'explore') return { type: 'explore' };
      if (cls === 'fiddle') return experiment(o) || undefined;
      if (cls === 'approach') { const p = (o.nearbyEntities || []).find((e) => e.isPlayer); return p ? { type: 'approach', target: p } : undefined; }
      if (cls === 'idle') return { type: 'idle' };
    }
    return undefined; // undefined = can't here; try the next pick
  }

  /** A learned layer's proposal: its most likely act that can be done here (or quiet). */
  function learnedProposal(layer, model, drives, o, rx, x) {
    const { probs } = predict(model, x);
    let order = Object.entries(probs).sort((a, b) => b[1] - a[1]);
    if (random() < learnedSalt) { // sample one by its probability, then the rest in order
      let r = random(); let chosen = order[0];
      for (const e of order) { r -= e[1]; if (r <= 0) { chosen = e; break; } }
      order = [chosen, ...order.filter((e) => e !== chosen)];
    }
    for (const [cls, p] of order) {
      const act = resolve(layer, cls, drives, o, rx);
      if (act === undefined) continue;
      return { act, cls, p };
    }
    return { act: null, cls: 'none', p: probs.none || 0 };
  }

  /** Swap in (or shadow) the learned layers. Returns { shadow, learnedBy }. */
  function applyLearned(layerName, proposals, drives, o, rx, x, out) {
    const m = (learned() || {})[layerName];
    if (!m || learnedMode === 'off') return;
    const pick = learnedProposal(layerName, m.model, drives, o, rx, x);
    const handCls = proposals[layerName] ? (require('../learn/examples').actClass(layerName, proposals[layerName]) || proposals[layerName].type) : 'none';
    out.shadow[layerName] = { pick: pick.cls, p: Math.round(pick.p * 100) / 100, hand: handCls, v: m.version || null };
    if (learnedMode === 'on' && m.served) {
      proposals[layerName] = pick.act;
      out.learnedBy.push(layerName);
    }
  }

  /** decide(drives, o): every layer proposes; the highest that speaks wins. */
  return function decideByLayers(drives, o) {
    const rx = o.reflexes || ownReflexes;
    const proposals = {};
    proposals.survive = survive(drives, o, rx);
    proposals.shelter = shelter(drives, o, rx);
    proposals.forage = forage(drives, o, rx);
    const learnedOut = { shadow: {}, learnedBy: [] };
    const anyLearned = learnedMode !== 'off' && Object.keys(learned() || {}).length;
    const x = anyLearned ? vector(recordFromObservation(o, drives)) : null;
    if (anyLearned) applyLearned('forage', proposals, drives, o, rx, x, learnedOut);
    // Food right here (a concrete act, not just "go looking") while carrying
    // little: Make and Gather give way to it.
    const foodChance = !!(proposals.forage && proposals.forage.type !== 'seekFood' && foodCarried(o) < STOCK);
    // Make is inhibited (a running plan pauses) while Survive has the body or
    // Shelter is holding it at night.
    // Urgent hunger inhibits it too: a starving body isn't kept busy with a
    // project (2026-11-17: hunger reached 90 while a plan kept exploring).
    const inhibited = !!proposals.survive || !!(proposals.shelter && isOverriding(proposals.shelter, o)) ||
      drives.hunger > HUNGER_URGENT || foodChance;
    for (const name of ORDER) {
      if (name === 'shelter' || name === 'survive' || name === 'forage') continue;
      proposals[name] = LAYERS[name](drives, o, rx, { inhibited, foodChance });
    }
    if (anyLearned) applyLearned('wander', proposals, drives, o, rx, x, learnedOut);
    if (modelLayers) {
      const keyOf = (p) => (!p ? 'nothing' : p.plan ? 'plan step' : p.type === 'idle' ? 'stay'
        : p.type === 'craft' ? `craft ${String(p.item || '').replace(/^.*_planks$/, 'planks').replace('crafting_table', 'table')}`
          : p.type === 'dig' && p.target && /_(log|stem)$/.test(p.target.name || '') ? 'dig log'
            : p.type === 'place' && p.item === 'crafting_table' ? 'place table' : `${p.type}${p.at ? ` ${p.at}` : p.target && p.target === 'bed' ? ' bed' : ''}`);
      for (const name of ['make', 'shelter', 'gather']) {
        const ans = modelLayers.consider(name, o, drives, { planStep: name === 'make' && proposals.make && proposals.make.plan ? proposals.make : null });
        if (!ans) continue;
        learnedOut.shadow[name] = { pick: ans.key, p: Math.round(ans.p * 100) / 100, hand: keyOf(proposals[name]), ms: ans.ms ?? null, ...(ans.gated ? { gated: true } : {}), ...(ans.patch ? { patch: ans.patch } : {}) };
        const swap = modelLayers.actFor(ans);
        if (swap === undefined) continue; // shadow mode: logged only
        if (name === 'make' && inhibited) continue; // Brooks's wires still hold over a model layer
        proposals[name] = swap;
        learnedOut.learnedBy.push(name);
      }
      modelLayers.tick(); // after asking: every layer is asked on the first tick
    }
    const voices = ORDER.filter((n) => proposals[n]);
    const layer = voices[0] || 'wander';
    const act = { ...(proposals[layer] || { type: 'idle' }) };
    act.layer = layer;
    act.voices = voices;
    if (Object.keys(learnedOut.shadow).length) act.shadow = learnedOut.shadow;
    if (learnedOut.learnedBy.includes(layer)) act.learned = layer;
    // A plan step keeps source 'plan': the plan runner only advances steps it
    // recognises as its own (planRunner.afterTick).
    if (!act.plan) act.source = `layer:${layer}`;
    if (blackboard) {
      blackboard.post('layers', layer, { action: act.type, voices },
        `${layer} → ${act.type}${act.at ? ' ' + act.at : ''}${act.item ? ' ' + act.item : ''}${voices.length > 1 ? ` (over ${voices.slice(1).join(', ')})` : ''}`);
    }
    return act;
  };
}

/**
 * Load the learned layers from logs/layers/ (stage 4), re-reading a file only
 * when it changes. Served = <layer>.json (passed the gate); for shadowing, the
 * newest version is used even if it didn't pass.
 */
function learnedLoader(dir, { layers = ['forage', 'wander'] } = {}) {
  const fs = require('fs');
  const path = require('path');
  const cache = {};
  const read = (file) => {
    try {
      const st = fs.statSync(file);
      if (cache[file] && cache[file].mtime === st.mtimeMs) return cache[file].data;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache[file] = { mtime: st.mtimeMs, data };
      return data;
    } catch (_) { return null; }
  };
  return function learned() {
    const out = {};
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return out; }
    for (const layer of layers) {
      const served = read(path.join(dir, `${layer}.json`));
      const prefix = `${layer}-v`;
      const versions = names.filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
        .map((f) => Number(f.slice(prefix.length, -'.json'.length))).filter((n) => Number.isInteger(n) && n > 0);
      const newest = versions.length ? read(path.join(dir, `${layer}-v${Math.max(...versions)}.json`)) : null;
      const pickFile = served || newest;
      if (pickFile && pickFile.model) out[layer] = { model: pickFile.model, served: !!served, version: pickFile.version };
    }
    return out;
  };
}

module.exports = { createLayerStack, learnedLoader, ORDER, RANK };
