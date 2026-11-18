// Stage 7b sandbox trial: build the Gather layer's questions from logged ticks
// (docs/results-7b-trial.md). Read-only on the bot: it writes only to
// logs/steer-trial/.
//
//   node agent/src/tools/steerCases.js
//
// Each logged tick is turned back into an observation, and the question is
// built exactly as the live layer builds it (brain/modelLayers.js menuFor,
// brain/narrator.js situationWords, the layer's top 3 memories). What the
// tick log does not keep is approximated, and said so in the results:
//   - the blocks the body could break: the log keeps none, so "break the block
//     ahead" is offered in every case (live, the 1.7B picks it often, so it is
//     usually on the menu); a log to break is not reconstructed (no name or
//     distance is logged), so cases rest on items lying about.
// Out:
//   cases.jsonl   test (gathering was right), control (nothing was right)
//   index.jsonl   a few hundred varied situations for indexing the model's insides
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { menuFor, JOB } = require('../brain/modelLayers');
const { situationWords } = require('../brain/narrator');
const { isEvening } = require('../decision/reflexes');
const { createMemory, ollamaEmbedder } = require('../vault/memory');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.join(ROOT, 'logs', 'steer-trial');
const N_TEST = 40;
const N_CONTROL = 40;
const N_INDEX = 320;

function readTicks() {
  const dir = path.join(ROOT, 'logs');
  const files = fs.readdirSync(dir).filter((f) => /^ticks-.*\.jsonl$/.test(f)).sort();
  const ticks = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const t = JSON.parse(line); if (t.action && t.aff) ticks.push(t); } catch (_) { /* partial line */ }
    }
  }
  return ticks;
}

/** A logged tick back into the observation shape the live layers read. */
function observation(t) {
  const inventory = String(t.inv || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^(.*?) x(\d+)$/);
    return m ? { name: m[1], count: Number(m[2]) } : { name: s, count: 1 };
  });
  return {
    isDay: t.isDay, timeOfDay: t.tod ?? null, health: t.health, food: t.food,
    affordances: { ...t.aff, canDig: ['ahead'], placeable: [] },
    nearbyEntities: [
      ...(t.hostiles || []).map((h) => ({ name: h.name, distance: h.d, hostile: true })),
      ...(t.near || []).map((n) => ({ name: n.name, distance: n.d, hostile: false, isPlayer: n.name === 'player' })),
    ],
    nearbyCrops: (t.crops || []).map((c) => ({ name: c.name, ripe: c.ripe, distance: c.d })),
    nearbyItems: (t.items || []).map((i) => ({ name: i.name, distance: i.d })),
    nearbyBlocks: [],
    inventory,
    borderDistance: t.border,
  };
}

const closestHostile = (t) => Math.min(99, ...(t.hostiles || []).map((h) => h.d));
const itemNear = (t) => (t.items || []).find((i) => i.d <= 8);
const shadow = (t) => (t.action.shadow || {}).gather || null;

/** Spread picks out: at most one per 15 ticks, then thin evenly to n. */
function spread(idx, n) {
  const one = [];
  for (const i of idx) if (!one.length || i - one[one.length - 1] >= 15) one.push(i);
  if (one.length <= n) return one;
  const step = one.length / n;
  return Array.from({ length: n }, (_, k) => one[Math.floor(k * step)]);
}

const MAP = (() => { const i = process.argv.indexOf('--map'); return i >= 0 ? Number(process.argv[i + 1]) : 0; })();
const VARIANT = (() => { const i = process.argv.indexOf('--variant'); return i >= 0 ? process.argv[i + 1] : null; })();

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ticks = readTicks();
  const idx = ticks.map((_, i) => i).filter((i) => ticks[i].tod != null); // the richer tick format only

  // TEST: by day, open, no hostile within 10, something lying in reach, and the
  // hand-written Gather took it (pickup / dig log): gathering was right.
  const test = spread(idx.filter((i) => {
    const t = ticks[i]; const s = shadow(t);
    return t.isDay && !t.aff.enclosed && closestHostile(t) >= 10 && itemNear(t) && s && ['pickup', 'dig log'].includes(s.hand);
  }), N_TEST);
  // CONTROL: the same menu (something lying in reach), but night and sealed
  // in, night in the open, or a hostile close: "nothing" was right.
  const ctrlPool = idx.filter((i) => {
    const t = ticks[i]; const s = shadow(t);
    return itemNear(t) && s && s.hand === 'nothing' && (!t.isDay || closestHostile(t) < 10);
  });
  const kinds = {
    'night, sealed in': ctrlPool.filter((i) => !ticks[i].isDay && ticks[i].aff.enclosed && closestHostile(ticks[i]) >= 10),
    'night, in the open': ctrlPool.filter((i) => !ticks[i].isDay && !ticks[i].aff.enclosed && closestHostile(ticks[i]) >= 10),
    'hostile close': ctrlPool.filter((i) => closestHostile(ticks[i]) < 10),
  };
  const control = [];
  const share = { 'night, sealed in': 18, 'night, in the open': 8, 'hostile close': 14 };
  for (const [k, list] of Object.entries(kinds)) control.push(...spread(list, share[k]).map((i) => ({ i, kind: k })));
  // Top up from the largest pool if a kind was short.
  const used = new Set(control.map((c) => c.i));
  for (const i of spread(kinds['night, sealed in'].filter((x) => !used.has(x)), N_CONTROL)) { if (control.length >= N_CONTROL) break; control.push({ i, kind: 'night, sealed in' }); }

  // INDEX: varied situations across the whole log (not the test/control ticks).
  const testSet = new Set([...test, ...control.map((c) => c.i)]);
  // Gatherable moments are rare (about 1 in 12), so a share is drawn from them.
  const gatherIdx = spread(idx.filter((i) => !testSet.has(i) && ticks[i].isDay && !ticks[i].aff.enclosed && closestHostile(ticks[i]) >= 10 && itemNear(ticks[i])), 80);
  const gset = new Set(gatherIdx);
  const index = [...spread(idx.filter((i) => !testSet.has(i) && !gset.has(i)), N_INDEX - gatherIdx.length), ...gatherIdx].sort((a, b) => a - b);

  const model = (process.env.EMBED_MODEL || '').trim();
  const cacheFile = path.join(OUT, 'memory-embeddings.json'); // a private copy: never write the live bot's cache
  const live = path.join(ROOT, 'logs', 'memory-embeddings.json');
  if (!fs.existsSync(cacheFile) && fs.existsSync(live)) fs.copyFileSync(live, cacheFile);
  const memory = createMemory({ vaultPath: process.env.VAULT_PATH, embed: model ? ollamaEmbedder({ model }) : null, cacheFile: model ? cacheFile : null });
  memory.refresh();

  async function build(i, set, kind) {
    const t = ticks[i];
    const o = observation(t);
    let situation = situationWords(o, t.drives) + (isEvening(o) ? ' Evening is here or coming.' : '');
    // Prompt variants (a test, not the live prompt): what lies in reach, and danger said plainly.
    if (VARIANT === 'items' || VARIANT === 'items-danger') {
      const near = (t.items || []).filter((x) => x.d <= 8).slice(0, 3).map((x) => `${x.name.replace(/_/g, ' ')} ${Math.round(x.d)} blocks away`);
      if (near.length) situation += ` Lying on the ground near me: ${near.join(', ')}.`;
    }
    if (VARIANT === 'items-danger') {
      const h = closestHostile(t);
      const danger = [];
      if (!t.isDay) danger.push(t.aff.enclosed ? 'It is night and I am sealed in: going out now is dangerous' : 'It is night: going about in the open is dangerous');
      if (h < 10) danger.push(`a hostile is only ${Math.round(h)} blocks away`);
      situation += danger.length ? ` Danger: ${danger.join('; ')}.` : ' It is safe: day, and nothing hostile near.';
    }
    let memories = [];
    try { memories = (await memory.retrieve(situation, { layer: 'gather', k: 3 })).map((h) => `${h.title}: ${h.text.replace(/\s+/g, ' ').slice(0, 160)}`); } catch (_) { /* none */ }
    const menu = menuFor('gather', o);
    const s = shadow(t);
    const gatherable = t.isDay && !t.aff.enclosed && closestHostile(t) >= 10 && !!itemNear(t);
    return {
      id: `${set}-${i}`, set, kind: kind || null, ts: t.ts, job: JOB.gather, situation, memories,
      keys: menu.map((m) => m.key), acts: menu.map((m) => m.text),
      right: set === 'test' ? 'pickup' : set === 'control' ? 'nothing' : null,
      gatherable, live: s ? { pick: s.pick, p: s.p, hand: s.hand } : null,
    };
  }

  if (MAP) {
    // The neuron map's situations (docs/results-7b-trial.md, part 2): many, varied, none from test/control.
    const tc = new Set(fs.readFileSync(path.join(OUT, 'cases.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => Number(JSON.parse(l).id.split('-')[1])));
    const pool = idx.filter((i) => !tc.has(i) && ticks[i].tod != null);
    const g = spread(pool.filter((i) => ticks[i].isDay && !ticks[i].aff.enclosed && closestHostile(ticks[i]) >= 10 && itemNear(ticks[i])), Math.round(MAP * 0.25));
    const gs = new Set(g);
    const rest = spread(pool.filter((i) => !gs.has(i)), MAP - g.length);
    const out = [];
    for (const i of [...rest, ...g].sort((a, b) => a - b)) out.push(await build(i, 'map'));
    fs.writeFileSync(path.join(OUT, 'map.jsonl'), out.map((l) => JSON.stringify(l)).join('\n') + '\n');
    console.log(`map.jsonl: ${out.length} situations, ${out.filter((x) => x.gatherable).length} worth gathering`);
    return;
  }
  if (VARIANT) {
    // The same ticks as cases.jsonl (ids are set-tickIndex; the tick files only grow), a different prompt.
    const prev = fs.readFileSync(path.join(OUT, 'cases.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const out = [];
    for (const c of prev) out.push({ ...(await build(Number(c.id.split('-')[1]), c.set, c.kind)), variant: VARIANT });
    fs.writeFileSync(path.join(OUT, `cases-${VARIANT}.jsonl`), out.map((l) => JSON.stringify(l)).join('\n') + '\n');
    console.log(`cases-${VARIANT}.jsonl: ${out.length}; e.g. ${out[0].situation} || ${out[out.length - 1].situation}`);
    return;
  }
  const lines = [];
  for (const i of test) lines.push(await build(i, 'test', 'gathering was right'));
  for (const c of control) lines.push(await build(c.i, 'control', c.kind));
  fs.writeFileSync(path.join(OUT, 'cases.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const ix = [];
  for (const i of index) ix.push(await build(i, 'index'));
  fs.writeFileSync(path.join(OUT, 'index.jsonl'), ix.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const tally = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  console.log(`ticks ${ticks.length}; test ${test.length}; control ${control.length} ${JSON.stringify(tally(control, (c) => c.kind))}; index ${ix.length} (gatherable ${ix.filter((x) => x.gatherable).length})`);
  console.log('live Gather pick on test:', JSON.stringify(tally(lines.filter((l) => l.set === 'test'), (l) => l.live && l.live.pick)));
  console.log('live Gather pick on control:', JSON.stringify(tally(lines.filter((l) => l.set === 'control'), (l) => l.live && l.live.pick)));
  console.log(`memories by ${memory.usingEmbeddings() ? 'embeddings' : 'words'}`);
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
module.exports = { observation };
