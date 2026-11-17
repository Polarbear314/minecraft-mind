// B1 of docs/design-plasticity-and-a-learning-cortex.md: before training
// anything, measure how well UNTRAINED local models pick the acts that worked
// in MindBot's own life — and avoid the ones that went badly.
//
//   npm run cortexeval -- gemma3:4b gemma3:12b [--n 120] [--samples 3]
//
// Test set: the most recent day of examples (logs/training/examples.jsonl,
// from `npm run export`), held out by time. For each example the model sees
// the situation and a menu of acts and picks one. Reported per model:
//   - picks what worked (on "good" examples), overall and in HARD moments
//     (hostile near, night, or hungry), vs. two baselines: a random pick, and
//     always picking the commonest good act from earlier days;
//   - steers clear of what went badly (on "bad" examples);
//   - how sure it is (agreement across samples), and whether being sure means
//     being right — the hand-off signal stage B2 would use;
//   - speed and valid answers.
// Writes docs/results-cortex-eval-<date>.md. Run it with the bot STOPPED: two
// models on the GPU at once would slow the live bot's brain to a crawl.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { localProvider } = require('../brain/providers');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EXAMPLES = path.join(ROOT, 'logs', 'training', 'examples.jsonl');
const CORE = ['idle', 'explore', 'seekFood', 'flee', 'eat', 'approach', 'swingAt', 'pickup', 'returnInside', 'jump', 'craft', 'equip'];

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
}

/** Deterministic shuffle (so every model sees the same test set). */
function seeded(arr, seed = 7) {
  const a = arr.slice();
  let s = seed;
  for (let i = a.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const isHard = (e) => e.hostileNear || !e.isDay || /food ([0-6])\/20/.test(e.situation);

/** Split by time: the last day is the test; earlier days give the baseline. */
function split(examples) {
  const days = [...new Set(examples.map((e) => e.ts.slice(0, 10)))].sort();
  const testDay = days[days.length - 1];
  return { earlier: examples.filter((e) => e.ts.slice(0, 10) < testDay), test: examples.filter((e) => e.ts.slice(0, 10) === testDay), testDay };
}

function menuFrom(examples) {
  const counts = {};
  for (const e of examples) counts[e.action] = (counts[e.action] || 0) + 1;
  const common = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 24);
  return [...new Set([...CORE, ...common])];
}

function promptFor(e, menu) {
  return [
    'You are the fast mind of MindBot, a creature living in a Minecraft world. Choose the ONE act most likely to go well right now:',
    'staying alive, unhurt and fed, and getting on with living.',
    '',
    `Situation: ${e.situation}`,
    '',
    `Acts you can choose (directions are relative to your body): ${menu.join(' | ')}`,
    '',
    'Answer with JSON only: {"act": "<one of the acts, exactly as written>"}',
  ].join('\n');
}

async function pick(model, e, menu, samples) {
  const mind = localProvider({ model, temperature: samples > 1 ? 0.7 : 0, numCtx: 2048, timeoutMs: 120000, keepAlive: '5m' });
  const schema = { type: 'object', properties: { act: { type: 'string', enum: menu } }, required: ['act'] };
  const answers = [];
  let ms = 0;
  let invalid = 0;
  for (let i = 0; i < samples; i += 1) {
    const t0 = Date.now();
    try {
      const { text } = await mind.ask(promptFor(e, menu), { schema });
      const act = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).act;
      if (menu.includes(act)) answers.push(act); else invalid += 1;
    } catch (_) { invalid += 1; }
    ms += Date.now() - t0;
  }
  const counts = {};
  for (const a of answers) counts[a] = (counts[a] || 0) + 1;
  const [choice, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [null, 0];
  return { choice, agreement: samples ? n / samples : 0, ms: ms / Math.max(1, samples), invalid };
}

const pct = (x) => (x == null || Number.isNaN(x) ? '—' : `${Math.round(x * 100)}%`);
const share = (arr, f) => (arr.length ? arr.filter(f).length / arr.length : null);

async function main() {
  const models = process.argv.slice(2).filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));
  if (!models.length) throw new Error('name the models: npm run cortexeval -- gemma3:4b gemma3:12b');
  const n = arg('n', 120);
  const samples = arg('samples', 3);
  const all = fs.readFileSync(EXAMPLES, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const { earlier, test, testDay } = split(all);
  const menu = menuFrom(all);
  // Test set: half hard moments, half ordinary, among the good examples; bad ones on their own.
  const goodHard = seeded(test.filter((e) => e.label === 'good' && isHard(e))).slice(0, Math.ceil(n / 2));
  const goodEasy = seeded(test.filter((e) => e.label === 'good' && !isHard(e))).slice(0, Math.floor(n / 2));
  const good = [...goodHard, ...goodEasy];
  const bad = seeded(test.filter((e) => e.label === 'bad')).slice(0, Math.ceil(n / 2));

  // Baselines.
  const counts = {};
  for (const e of earlier.filter((x) => x.label === 'good')) counts[e.action] = (counts[e.action] || 0) + 1;
  const commonest = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const base = {
    random: { good: 1 / menu.length, hard: 1 / menu.length, avoid: 1 - 1 / menu.length },
    commonest: {
      good: share(good, (e) => e.action === commonest), hard: share(goodHard, (e) => e.action === commonest),
      avoid: share(bad, (e) => e.action !== commonest),
    },
  };

  const results = {};
  for (const model of models) {
    console.log(`[eval] ${model}: ${good.length} good + ${bad.length} bad examples, ${samples} sample(s) each...`);
    const rows = [];
    for (const e of [...good, ...bad]) {
      const r = await pick(model, e, menu, samples);
      rows.push({ e, ...r });
      if (rows.length % 20 === 0) console.log(`[eval] ${model}: ${rows.length}/${good.length + bad.length}`);
    }
    const g = rows.filter((r) => r.e.label === 'good');
    const h = g.filter((r) => isHard(r.e));
    const b = rows.filter((r) => r.e.label === 'bad');
    const sure = rows.filter((r) => r.e.label === 'good' && r.agreement === 1);
    const unsure = rows.filter((r) => r.e.label === 'good' && r.agreement < 1);
    const typeOf = (k) => String(k || '').split(' ')[0];
    results[model] = {
      good: share(g, (r) => r.choice === r.e.action),
      goodType: share(g, (r) => typeOf(r.choice) === typeOf(r.e.action)),
      hard: share(h, (r) => r.choice === r.e.action),
      avoid: share(b, (r) => r.choice !== r.e.action),
      sureShare: share(g, (r) => r.agreement === 1),
      sureRight: share(sure, (r) => r.choice === r.e.action),
      unsureRight: share(unsure, (r) => r.choice === r.e.action),
      ms: rows.reduce((s, r) => s + r.ms, 0) / rows.length,
      invalid: rows.reduce((s, r) => s + r.invalid, 0),
      picks: Object.entries(rows.reduce((m, r) => { m[r.choice] = (m[r.choice] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 6),
      misses: h.filter((r) => r.choice !== r.e.action).slice(0, 4).map((r) => ({ s: r.e.situation, did: r.e.action, picked: r.choice })),
    };
  }

  const L = [];
  L.push(`# Local cortex, untrained — ${new Date().toISOString().slice(0, 10)}`);
  L.push('');
  L.push(`*Generated by \`npm run cortexeval\`. Stage B1 of \`design-plasticity-and-a-learning-cortex.md\`. Test set: ${testDay} (held out by time), ${good.length} examples where the act went well (${goodHard.length} of them hard moments: hostile near, night, or hungry) and ${bad.length} where it went badly. Menu of ${menu.length} acts. ${samples} sample(s) per example.*`);
  L.push('');
  L.push('| | Picks what worked | …in hard moments | Same kind of act | Steers clear of what went badly | Sure (all samples agree) | Right when sure | Right when unsure | Time per pick |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  L.push(`| Random pick | ${pct(base.random.good)} | ${pct(base.random.hard)} | — | ${pct(base.random.avoid)} | — | — | — | — |`);
  L.push(`| Always "${commonest}" | ${pct(base.commonest.good)} | ${pct(base.commonest.hard)} | — | ${pct(base.commonest.avoid)} | — | — | — | — |`);
  for (const [m, r] of Object.entries(results)) {
    L.push(`| **${m}** | ${pct(r.good)} | ${pct(r.hard)} | ${pct(r.goodType)} | ${pct(r.avoid)} | ${pct(r.sureShare)} | ${pct(r.sureRight)} | ${pct(r.unsureRight)} | ${(r.ms / 1000).toFixed(1)} s |`);
  }
  L.push('');
  for (const [m, r] of Object.entries(results)) {
    L.push(`**${m}** picked most: ${r.picks.map(([k, c]) => `${k} (${c})`).join(', ')}. Invalid answers: ${r.invalid}.`);
    for (const x of r.misses) L.push(`- *Missed:* ${x.s} — it did **${x.did}** (went well); the model picked **${x.picked}**.`);
    L.push('');
  }
  L.push('**How to read it.** "Picks what worked" is agreement with acts that went well, so it measures imitation of MindBot\'s own good moments, not whether the model would do *better*. That needs a live trial (B2). The useful signals here: is the model clearly above both baselines, especially in hard moments? Does being sure mean being right (if so, "unsure" is a good moment to hand off to Claude)? Is it fast enough to decide every few seconds?');
  const out = path.join(ROOT, 'docs', `results-cortex-eval-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(out, `${L.join('\n')}\n`);
  console.log(L.join('\n'));
  console.log(`\nSaved: ${out}`);
}

if (require.main === module) main().catch((err) => { console.error(`[eval] failed: ${err.message}`); process.exit(1); });

module.exports = { split, menuFrom, promptFor, isHard, seeded };
