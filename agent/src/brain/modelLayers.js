// The language-model layers (docs/design-subsumption.md, stage 6):
//
//   Make     ~4B  (Qwen3-4B-Instruct)    answers every ~5 ticks
//   Shelter  ~3B  (Qwen2.5-3B-Instruct)  answers every 2-3 ticks
//   Gather   ~2B  (Qwen3-1.7B)           answers every 1-2 ticks
//
// Each tick a layer that's due builds its menu: the acts it could do RIGHT
// NOW (from what the body sees and carries), plus "nothing for me to do".
// Its question to the model is the situation in words, its own job, and its
// top memories (vault/memory.js retrieval, embeddings: FreeLAB's role by day).
// The model service (cortex/layer_service.py) scores the menu in one pass.
//
// Answers arrive asynchronously; a layer's last answer stands until its next
// (a slow mind's word holds, as Claude's did in the region design). Modes
// (UPPER_LAYERS): 'off'; 'shadow' (default: logged next to what the
// hand-written layer did, in action.shadow); 'on' (the model's pick acts,
// unless it chose "nothing" or isn't sure enough).
const { situationWords } = require('./narrator');
const { isEvening } = require('../decision/reflexes');

const EVERY = { make: 5, shelter: 2, gather: 1 }; // ticks between questions
const FRESH_MS = 15000; // an answer older than this no longer stands
const SURE = 0.35; // in 'on' mode, below this the layer stays quiet
const MEMORIES = 3;
const PASSES = 2; // each question asked this many times, options shuffled, probabilities averaged

const JOB = {
  make: 'I am the part of MindBot that makes things and carries out plans: wood into planks, planks into a crafting table, wheat into bread, and the plans I wrote for myself in dreams.',
  shelter: 'I am the part of MindBot that keeps it safe at night: digging in at dusk, sealing the roof and the open sides, lying in a bed, and staying put until morning.',
  gather: 'I am the part of MindBot that gathers by day: picking up what lies about, breaking wood, keeping enough blocks to build a shelter.',
};
const NOTHING = 'nothing: this is not for me right now (let another part of me act)';
const GATHER_SAFE = 10; // Gather's model is asked only by day with no hostile this close
const ITEM_RANGE = 8;

/**
 * Whether Gather's model is asked at all (2026-11-17, docs/results-7b-trial.md).
 * The 1.7B is good at WHICH thing to gather but not at WHETHER it's safe: on 80
 * logged situations it gathered at night and near zombies as often as by day,
 * even when the danger was spelled out. So the "when" is wired, Brooks-style,
 * as the hand-written Gather has it, and the model only chooses "what".
 */
function gatherSafe(o) {
  if (isEvening(o)) return false;
  return !(o.nearbyEntities || []).some((e) => e.hostile && (e.distance == null || e.distance < GATHER_SAFE));
}

/** What lies on the ground in reach, in words (only the menu said so before: 12 -> 21 of 40 right in the trial). */
function itemsWords(o) {
  const near = (o.nearbyItems || []).filter((i) => i.distance == null || i.distance <= ITEM_RANGE).slice(0, 3)
    .map((i) => `${i.name.replace(/_/g, ' ')}${i.distance != null ? ` ${Math.round(i.distance)} blocks away` : ''}`);
  return near.length ? ` Lying on the ground near me: ${near.join(', ')}.` : '';
}

const isLog = (n) => /_(log|stem)$/.test(n);
const count = (o, test) => (o.inventory || []).filter((i) => test(i.name)).reduce((s, i) => s + (i.count || 1), 0);

/** The acts a layer could do right now: [{ key, text, act }]; "nothing" always last. */
function menuFor(layer, o, { planStep = null } = {}) {
  const out = [];
  const a = o.affordances || {};
  const add = (key, text, act) => out.push({ key, text, act });
  if (layer === 'shelter') {
    if (a.canDigBelow) add('dig below', 'dig down where I stand', { type: 'dig', at: 'below' });
    if (!a.roof && (a.placeable || []).length) add('place above', 'set a block over my head', { type: 'place', at: 'above' });
    for (const side of (a.canPlace || []).filter((d) => ['ahead', 'behind', 'left', 'right'].includes(d)).slice(0, 2)) {
      if ((a.placeable || []).length) add(`place ${side}`, `wall in the open side ${side}`, { type: 'place', at: side });
    }
    if (a.bed && a.bed.distance <= 24) add('use bed', 'go and lie in the bed', { type: 'use', target: 'bed' });
    // Staying put is a shelter act only once it's evening or the body is closed in
    // (2026-11-17: untested, the 3B model chose "stay closed in" at sunny midday).
    if (isEvening(o) || a.enclosed) add('stay', a.enclosed ? 'stay where I am, closed in' : 'stay where I am', { type: 'idle' });
  } else if (layer === 'gather') {
    const item = (o.nearbyItems || []).find((i) => i.distance == null || i.distance <= ITEM_RANGE);
    if (item) add('pickup', `pick up the ${item.name.replace(/_/g, ' ')} lying nearby`, { type: 'pickup', target: item });
    const log = (o.nearbyBlocks || []).filter((b) => isLog(b.name) && b.position).sort((x, y) => (x.distance || 0) - (y.distance || 0))[0];
    if (log) add('dig log', `break the ${log.name.replace(/_/g, ' ')} ${Math.round(log.distance || 0)} blocks away`, { type: 'dig', target: log });
    const side = (a.canDig || []).find((d) => d !== 'below' && d !== 'above');
    if (side) add(`dig ${side}`, `break the block ${side} to carry it`, { type: 'dig', at: side });
  } else if (layer === 'make') {
    const log = (o.inventory || []).find((i) => isLog(i.name));
    const planksName = log ? log.name.replace(/^stripped_/, '').replace(/_(log|stem)$/, '_planks') : null;
    if (planStep) add('plan step', `go on with my plan "${planStep.plan}" (${planStep.type}${planStep.at ? ` ${planStep.at}` : ''})`, planStep);
    if (count(o, (n) => n === 'wheat') >= 3 && o.tableNear) add('craft bread', 'bake bread from my wheat at the crafting table', { type: 'craft', item: 'bread' });
    if (count(o, (n) => n === 'crafting_table')) add('place table', 'set my crafting table down', { type: 'place', at: 'ahead', item: 'crafting_table' });
    if (log) add('craft planks', `turn a ${log.name.replace(/_/g, ' ')} into planks`, { type: 'craft', item: planksName });
    if (count(o, (n) => /_planks$/.test(n)) >= 4 && !count(o, (n) => n === 'crafting_table')) add('craft table', 'make a crafting table from planks', { type: 'craft', item: 'crafting_table' });
  }
  out.push({ key: 'nothing', text: NOTHING, act: null });
  return out;
}

/**
 * createModelLayers({ endpoint, memory, mode, fetchImpl, now })
 *   .consider(layer, o, drives, extra) -> { key, p, act, ms, model } | null  (latest standing answer)
 *   .tick() -> advance the per-layer tick counters (call once per decide)
 */
function createModelLayers({ endpoint = 'http://127.0.0.1:3010', memory = null, mode = 'shadow', fetchImpl = (...a) => fetch(...a), now = () => Date.now(), every = EVERY, random = Math.random, logQuestion = null } = {}) {
  const state = { make: {}, shelter: {}, gather: {} };
  let ticks = 0;
  let down = 0; // when the service was last found unreachable

  async function ask(layer, o, drives, extra) {
    const st = state[layer];
    st.busy = true;
    try {
      const menu = menuFor(layer, o, extra);
      if (menu.length < 2) { st.answer = { key: 'nothing', p: 1, act: null, at: now(), menuSize: 1 }; return; }
      if (layer === 'gather' && !gatherSafe(o)) { st.answer = { key: 'nothing', p: 1, act: null, at: now(), menuSize: menu.length, gated: true }; return; }
      const situation = situationWords(o, drives) + (isEvening(o) ? ' Evening is here or coming.' : '') + (layer === 'gather' ? itemsWords(o) : '');
      let memories = [];
      if (memory) {
        try { memories = (await memory.retrieve(situation, { layer, k: MEMORIES })).map((h) => `${h.title}: ${h.text.replace(/\s+/g, ' ').slice(0, 160)}`); } catch (_) { /* none */ }
      }
      // Asked PASSES times, the options shuffled each time, and the
      // probabilities averaged per act: small models favour some letter
      // positions (2026-11-17: the 1.7B said "nothing" 100% whenever it was
      // the last option, and picked up the carrot 99% when it wasn't).
      const total = Object.fromEntries(menu.map((m) => [m.key, 0]));
      let ms = 0; let model = null; let patch = null;
      for (let pass = 0; pass < PASSES; pass++) {
        const order = menu.slice();
        for (let i = order.length - 1; i > 0; i--) { const k = Math.floor(random() * (i + 1)); [order[i], order[k]] = [order[k], order[i]]; }
        const res = await fetchImpl(`${endpoint}/choose`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ layer, job: JOB[layer], situation, memories, acts: order.map((m) => m.text) }),
        });
        if (!res.ok) throw new Error(`service ${res.status}`);
        const j = await res.json();
        if (j.error) throw new Error(j.error);
        order.forEach((m, i) => { total[m.key] += (j.probs && j.probs[i] != null ? j.probs[i] : (i === j.pick ? 1 : 0)) / PASSES; });
        ms += j.ms || 0; model = j.model || model; patch = j.patch || patch;
      }
      const best = menu.reduce((b, m) => (total[m.key] > total[b.key] ? m : b), menu[0]);
      st.answer = { key: best.key, p: Math.round(total[best.key] * 1000) / 1000, act: best.act, at: now(), ms, model, menuSize: menu.length, memories: memories.length, patch };
      // The exact question, for nightly learning (cortex/nightly_write.py): what the
      // model saw, so a lesson is fitted to real prompts, not reconstructions.
      if (logQuestion) {
        try {
          logQuestion({ ts: new Date(now()).toISOString(), layer, job: JOB[layer], situation, memories, keys: menu.map((m) => m.key), acts: menu.map((m) => m.text), probs: Object.fromEntries(menu.map((m) => [m.key, Math.round(total[m.key] * 1000) / 1000])), patch });
        } catch (_) { /* logging must never stop a layer */ }
      }
    } catch (_) {
      down = now();
    } finally {
      st.busy = false;
    }
  }

  function consider(layer, o, drives, extra = {}) {
    if (mode === 'off' || !state[layer]) return null;
    const st = state[layer];
    const due = ticks % (every[layer] || 1) === 0;
    if (due && !st.busy && now() - down > 30000) ask(layer, o, drives, extra); // fire and forget: the body doesn't wait
    const a = st.answer;
    return a && now() - a.at < FRESH_MS ? a : null;
  }

  return {
    mode,
    consider,
    tick() { ticks += 1; },
    /** In 'on' mode, the act to use in place of the hand-written proposal (undefined = keep the hand-written one). */
    actFor(answer) {
      if (mode !== 'on' || !answer) return undefined;
      if (answer.key === 'nothing' || answer.p < SURE) return null;
      return answer.act ? { ...answer.act } : null;
    },
  };
}

module.exports = { createModelLayers, menuFor, gatherSafe, itemsWords, JOB, EVERY, NOTHING };
