// Stage 7b, flaw 2: Shelter (Qwen2.5-3B) wants to dig in or wall up by day
// (docs/results-7b-trial.md, flaw 2). Builds its questions from logged ticks the
// way the live layer does (brain/modelLayers.js menuFor('shelter'), the
// situation in words, its top 3 memories). Writes only to logs/steer-trial/shelter/.
//
//   node agent/src/tools/steerShelterCases.js
//
// What the tick log doesn't keep is approximated (and said so in the results):
// whether it can dig below (assumed yes unless sealed in), which sides are open
// (the first 4 - walls of ahead/behind/left/right), and what it could place
// (dirt, when it carries placeable blocks).
// Out:
//   cases.jsonl  test: by day (before dusk), in the open, the hand-written Shelter
//                stayed quiet -> right: "nothing" (40);
//                control: dusk or night, not sealed in, the hand-written Shelter
//                sheltered (dug in, roofed, walled, bed) -> right: any shelter act (40)
//   map.jsonl    a pool of other such moments, each with the act to teach ("teach")
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { menuFor, JOB } = require('../brain/modelLayers');
const { situationWords } = require('../brain/narrator');
const { isEvening } = require('../decision/reflexes');
const { createMemory, ollamaEmbedder } = require('../vault/memory');
const { observation } = require('./steerCases');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.join(ROOT, 'logs', 'steer-trial', 'shelter');
const SIDES = ['ahead', 'behind', 'left', 'right'];
const SHELTER_ACTS = (keys) => keys.filter((k) => k !== 'nothing' && k !== 'stay');

function readTicks() {
  const dir = path.join(ROOT, 'logs');
  const ticks = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^ticks-.*\.jsonl$/.test(x)).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const t = JSON.parse(line); if (t.action && t.aff && t.tod != null) ticks.push(t); } catch (_) { /* partial */ }
    }
  }
  return ticks;
}

function shelterObs(t) {
  const o = observation(t);
  const open = Math.max(0, 4 - (t.aff.walls || 0));
  o.affordances = {
    ...o.affordances,
    canDigBelow: !t.aff.enclosed,
    placeable: (t.aff.blocks || 0) > 0 ? ['dirt'] : [],
    canPlace: SIDES.slice(0, open),
    bed: t.aff.bed != null ? { distance: Number(t.aff.bed) || 8 } : null,
  };
  return o;
}

const shadow = (t) => ((t.action || {}).shadow || {}).shelter || null;
const hostileD = (t) => Math.min(99, ...(t.hostiles || []).map((h) => h.d));

function spread(idx, n, gap = 15) {
  const one = [];
  for (const i of idx) if (!one.length || i - one[one.length - 1] >= gap) one.push(i);
  if (one.length <= n) return one;
  return Array.from({ length: n }, (_, k) => one[Math.floor(k * one.length / n)]);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ticks = readTicks();
  const idx = ticks.map((_, i) => i);
  const dayQuiet = idx.filter((i) => { const t = ticks[i]; const s = shadow(t); return s && t.isDay && t.tod < 11800 && !t.aff.enclosed && hostileD(t) >= 10 && s.hand === 'nothing'; });
  const duskAct = idx.filter((i) => { const t = ticks[i]; const s = shadow(t); return s && isEvening({ isDay: t.isDay, timeOfDay: t.tod }) && !t.aff.enclosed && ['dig below', 'place above', 'place ahead', 'place behind', 'place left', 'place right', 'use bed'].includes(s.hand); });
  // Alternate: even-spaced picks go to test/control, the rest (away from them) to the teacher pool.
  const test = spread(dayQuiet, 40, 30);
  const control = spread(duskAct, 40, 15);
  const near = new Set();
  // Teacher moments stay at least 5 ticks (7.5 s) from any test or control case: dusk
  // sheltering is rare (about one episode a night), so a wider gap leaves too few.
  for (const i of [...test, ...control]) for (let k = i - 5; k <= i + 5; k++) near.add(k);
  const poolDay = spread(dayQuiet.filter((i) => !near.has(i)), 60, 15);
  const poolDusk = spread(duskAct.filter((i) => !near.has(i)), 60, 2); // dusk moments are scarce: allow them closer together

  const model = (process.env.EMBED_MODEL || '').trim();
  const cacheFile = path.join(ROOT, 'logs', 'steer-trial', 'memory-embeddings.json'); // the private copy from part 1
  const memory = createMemory({ vaultPath: process.env.VAULT_PATH, embed: model ? ollamaEmbedder({ model }) : null, cacheFile: model ? cacheFile : null });
  memory.refresh();

  async function build(i, set, kind) {
    const t = ticks[i];
    const o = shelterObs(t);
    const situation = situationWords(o, t.drives) + (isEvening(o) ? ' Evening is here or coming.' : '');
    let memories = [];
    try { memories = (await memory.retrieve(situation, { layer: 'shelter', k: 3 })).map((h) => `${h.title}: ${h.text.replace(/\s+/g, ' ').slice(0, 160)}`); } catch (_) { /* none */ }
    const menu = menuFor('shelter', o);
    const keys = menu.map((m) => m.key);
    const s = shadow(t);
    const day = set === 'test' || kind === 'day';
    const hand = keys.includes(s.hand) ? s.hand : SHELTER_ACTS(keys)[0];
    return {
      id: `${set}-${i}`, set, kind, ts: t.ts, job: JOB.shelter, situation, memories, keys, acts: menu.map((m) => m.text),
      right: day ? 'nothing' : hand, rightAny: day ? null : SHELTER_ACTS(keys),
      teach: day ? 'nothing' : hand, live: { pick: s.pick, p: s.p, hand: s.hand },
    };
  }
  const cases = [];
  for (const i of test) cases.push(await build(i, 'test', 'by day, in the open'));
  for (const i of control) cases.push(await build(i, 'control', 'dusk or night, sheltering was right'));
  const usable = cases.filter((c) => c.keys.length >= 2 && (c.set === 'test' || c.rightAny.length));
  fs.writeFileSync(path.join(OUT, 'cases.jsonl'), usable.map((c) => JSON.stringify(c)).join('\n') + '\n');
  const pool = [];
  for (const i of poolDay) pool.push(await build(i, 'map', 'day'));
  for (const i of poolDusk) pool.push(await build(i, 'map', 'dusk'));
  const poolOk = pool.filter((c) => c.keys.length >= 2 && (c.teach === 'nothing' || c.keys.includes(c.teach)));
  fs.writeFileSync(path.join(OUT, 'map.jsonl'), poolOk.map((c) => JSON.stringify(c)).join('\n') + '\n');
  const tally = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  console.log(`cases: ${usable.filter((c) => c.set === 'test').length} test, ${usable.filter((c) => c.set === 'control').length} control; pool ${poolOk.length} (${JSON.stringify(tally(poolOk, (c) => c.teach))})`);
  console.log('live Shelter pick on test:', JSON.stringify(tally(usable.filter((c) => c.set === 'test'), (c) => c.live.pick)));
  console.log('live Shelter pick on control:', JSON.stringify(tally(usable.filter((c) => c.set === 'control'), (c) => c.live.pick)));
  console.log('e.g.', usable[0].situation.slice(0, 160), '| menu:', usable[0].keys.join(', '));
}

main().catch((err) => { console.error(err); process.exit(1); });
