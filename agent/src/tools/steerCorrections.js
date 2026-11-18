// Stage 7b, part 3, test 3: Opus's corrections for the Gather decision, the
// route-B way (learn/nightly.js), to combine with the creature's outcomes in a
// Laya teacher (docs/results-7b-trial.md).
//
//   node agent/src/tools/steerCorrections.js   -> logs/steer-trial/neurons/opus-corrections.jsonl
//
// The outcome-only teacher learned "pick up" everywhere: the creature has never
// gathered at night (its hand-written layers never let it), so its outcomes
// hold no evidence of that danger. Opus is shown 40 logged moments with
// something lying in reach, many of them at night or with a hostile near, and
// says for each whether Gather should pick it up or do nothing, and why. It is
// told its answers become training examples and that it doesn't decide what is
// kept. Moments near the test, control or teacher situations are left out.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { observation } = require('./steerCases');
const { situationWords } = require('../brain/narrator');
const { loadBrainMap, regionProvider } = require('../brain/brainMap');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.join(ROOT, 'logs', 'steer-trial');
const NEU = path.join(OUT, 'neurons');

function readTicks() {
  const dir = path.join(ROOT, 'logs');
  const ticks = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^ticks-.*\.jsonl$/.test(x)).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const t = JSON.parse(line); if (t.action && t.aff) ticks.push(t); } catch (_) { /* partial */ }
    }
  }
  return ticks;
}

const itemNear = (t) => (t.items || []).filter((i) => i.d <= 8);
const hostileD = (t) => Math.min(99, ...(t.hostiles || []).map((h) => h.d));
const text = (t) => {
  const near = itemNear(t).slice(0, 3).map((i) => `${i.name.replace(/_/g, ' ')} ${Math.round(i.d)} blocks away`);
  return `${situationWords(observation(t), t.drives)} Lying on the ground near me: ${near.join(', ')}.`;
};
function spread(list, n) {
  const one = [];
  for (const i of list) if (!one.length || i - one[one.length - 1] >= 15) one.push(i);
  if (one.length <= n) return one;
  return Array.from({ length: n }, (_, k) => one[Math.floor(k * one.length / n)]);
}

async function main() {
  const ticks = readTicks();
  const ids = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => Number(JSON.parse(l).id.split('-')[1]));
  const avoid = new Set();
  for (const i of ids(path.join(OUT, 'cases.jsonl'))) for (let k = i - 15; k <= i + 15; k++) avoid.add(k);
  for (const i of ids(path.join(OUT, 'map.jsonl'))) for (let k = i - 5; k <= i + 5; k++) avoid.add(k); // the teacher's situations
  const pool = ticks.map((_, i) => i).filter((i) => !avoid.has(i) && ticks[i].tod != null && itemNear(ticks[i]).length);
  const pick = [
    ...spread(pool.filter((i) => !ticks[i].isDay && ticks[i].aff.enclosed), 12),
    ...spread(pool.filter((i) => !ticks[i].isDay && !ticks[i].aff.enclosed), 8),
    ...spread(pool.filter((i) => hostileD(ticks[i]) < 10), 10),
    ...spread(pool.filter((i) => ticks[i].isDay && !ticks[i].aff.enclosed && hostileD(ticks[i]) >= 10), 10),
  ];
  const moments = [...new Set(pick)].sort((a, b) => a - b).map((i, n) => ({ id: n + 1, i, text: text(ticks[i]) }));
  const L = [
    'You are reviewing moments in the life of MindBot, a creature in a small Minecraft world. Its behaviour comes from a stack of layers; the first that speaks each tick gets the body. One layer, Gather, decides whether to pick up what lies on the ground in reach, or to do nothing and let the other layers act (Survive flees and fights off danger; Shelter digs in and seals itself in at night).',
    'For each moment below, say what Gather should do: "pickup" or "nothing", and why in a few words. The goal: stay alive, unhurt and fed, and get on with living. Use what you know about Minecraft (night, hostile mobs, leaving a sealed shelter) as well as what the moment says.',
    'Your answers become training examples for the creature\'s own judgement. Whether anything learned from them is kept is decided by how the creature actually fares, not by you.',
    '',
    ...moments.map((m) => `#${m.id}: ${m.text}`),
    '',
    'Reply with JSON only: {"corrections": [{"id": 1, "should": "pickup" | "nothing", "why": "..."}, ...]} (every moment).',
  ];
  const prompt = L.join('\n');
  const provider = regionProvider(loadBrainMap(), 'hippocampus', { timeoutMs: 900000 });
  const t0 = Date.now();
  const reply = await provider.ask(prompt);
  if (!String(reply.by || '').startsWith('claude')) throw new Error(`answered by ${reply.by}`);
  fs.writeFileSync(path.join(NEU, 'opus-corrections.txt'), `${prompt}\n\n===== REPLY (${reply.by}, ${Math.round((Date.now() - t0) / 1000)} s) =====\n${reply.text}\n`);
  const raw = String(reply.text);
  const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const byId = Object.fromEntries(moments.map((m) => [m.id, m]));
  const rows = (j.corrections || []).filter((c) => byId[c.id] && ['pickup', 'nothing'].includes(c.should))
    .map((c) => ({ i: byId[c.id].i, text: byId[c.id].text, label: c.should, why: c.why, by: 'opus' }));
  fs.writeFileSync(path.join(NEU, 'opus-corrections.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const t = (k) => ticks[k];
  const tally = rows.reduce((m, r) => {
    const k = `${!t(r.i).isDay ? (t(r.i).aff.enclosed ? 'night sealed' : 'night open') : hostileD(t(r.i)) < 10 ? 'hostile close' : 'day safe'} -> ${r.label}`;
    m[k] = (m[k] || 0) + 1; return m;
  }, {});
  console.log(`${rows.length} corrections from ${reply.by} in ${Math.round((Date.now() - t0) / 1000)} s: ${JSON.stringify(tally)}`);
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
