// Outcome labels for the Gather model layer (docs/design-subsumption.md, nightly
// weight writes): what each of its questions should have been answered with,
// judged only by what happened to the creature afterwards. Nothing is fed in.
//
//   node agent/src/learn/gatherLabels.js --days 2026-11-17,2026-11-18
//     -> logs/layers/write/gather-rows-<day>.jsonl
//
// For every tick where Gather's model was asked (shadow entry, not gated) and its
// menu offered something to gather:
//   - the body gathered (pickup / dig, whichever layer chose it) and it went well
//     (the pack grew, no harm in 30 s)            -> that act
//   - the body gathered and it went badly (hurt 4+, died, or couldn't) -> "nothing"
//   - the body did something else and nothing bad came of it (1 in 5, the
//     stage-4 convention for "stayed quiet")      -> "nothing"
// The question is the one the live layer was really asked (logs/questions-<day>.jsonl),
// or, for days before those were logged, rebuilt the way the 7b trial did.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LOGS = path.join(ROOT, 'logs');
const OUT = path.join(LOGS, 'layers', 'write');
const WINDOW = 20; // ticks (30 s)
const QUIET_SAMPLE = 5;

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* partial */ }
  }
  return out;
}

const invCount = (inv) => String(inv || '').split(',').reduce((s, x) => { const m = x.trim().match(/ x(\d+)$/); return s + (m ? Number(m[1]) : 0); }, 0);

/** What came of tick i: 'good' | 'bad' | null. */
function outcome(ticks, i, gathered) {
  const t = ticks[i];
  if (t.result && t.result.ok === false) return 'bad';
  let hurt = 0; let died = false;
  const end = Math.min(ticks.length - 1, i + WINDOW);
  for (let k = i + 1; k <= end; k++) {
    const p = ticks[k - 1]; const c = ticks[k];
    if (Date.parse(c.ts) - Date.parse(p.ts) > 30000) break;
    if (p.health != null && c.health != null) {
      if (c.health < p.health) hurt += p.health - c.health;
      if (p.health <= 6 && c.health === 20) died = true;
    }
  }
  if (died || hurt >= 4) return 'bad';
  if (!gathered) return 'good';
  // Gathering went well if the pack grew (the tick log keeps the inventory as text).
  const later = ticks.slice(i + 1, end + 1).filter((x) => x.inv != null);
  return later.some((x) => invCount(x.inv) > invCount(t.inv)) ? 'good' : null;
}

/** The body's act as a Gather menu key, or null if it wasn't gathering. */
function gatherKey(a) {
  if (a.type === 'pickup') return 'pickup';
  if (a.type === 'dig') return a.at && !['below', 'above'].includes(a.at) ? `dig ${a.at}` : (a.at ? null : 'dig log');
  return null;
}

async function rebuildQuestion(t, memory) {
  const { menuFor, JOB, itemsWords } = require('../brain/modelLayers');
  const { situationWords } = require('../brain/narrator');
  const { isEvening } = require('../decision/reflexes');
  const { observation } = require('../tools/steerCases');
  const o = observation(t);
  const situation = situationWords(o, t.drives) + (isEvening(o) ? ' Evening is here or coming.' : '') + itemsWords(o);
  let memories = [];
  if (memory) {
    try { memories = (await memory.retrieve(situation, { layer: 'gather', k: 3 })).map((h) => `${h.title}: ${h.text.replace(/\s+/g, ' ').slice(0, 160)}`); } catch (_) { /* none */ }
  }
  const menu = menuFor('gather', o);
  return { job: JOB.gather, situation, memories, keys: menu.map((m) => m.key), acts: menu.map((m) => m.text) };
}

async function labelDay(day, memory) {
  const ticks = readJsonl(path.join(LOGS, `ticks-${day}.jsonl`)).filter((t) => t.action && t.aff && t.tod != null);
  const questions = readJsonl(path.join(LOGS, `questions-${day}.jsonl`)).filter((q) => q.layer === 'gather');
  const qTimes = questions.map((q) => Date.parse(q.ts));
  const nearest = (ts) => { // the question asked within 3 s before this tick
    const t = Date.parse(ts);
    let best = null;
    for (let k = 0; k < qTimes.length; k++) if (qTimes[k] <= t && t - qTimes[k] < 3000) best = questions[k];
    return best;
  };
  const rows = [];
  let quiet = 0;
  for (let i = 0; i < ticks.length - WINDOW; i++) {
    const t = ticks[i];
    const sh = (t.action.shadow || {}).gather;
    if (!sh || sh.gated) continue;
    const a = t.action;
    const key = gatherKey(a);
    let label = null; let why = null;
    if (key) {
      const o = outcome(ticks, i, true);
      if (o === 'bad') { label = 'nothing'; why = 'gathered, then hurt or couldn\'t'; } else if (o === 'good') { label = key; why = 'gathered, the pack grew, unharmed'; }
    } else if (quiet++ % QUIET_SAMPLE === 0 && outcome(ticks, i, false) === 'good') {
      label = 'nothing'; why = 'did something else, nothing bad came of it';
    }
    if (!label) continue;
    const q = nearest(t.ts) || await rebuildQuestion(t, memory);
    if (!q.keys || !q.keys.some((k) => k !== 'nothing')) continue; // nothing to gather on the menu
    if (label !== 'nothing' && !q.keys.includes(label)) label = q.keys.find((k) => k !== 'nothing'); // the menu named it differently
    rows.push({ id: `${day}-${i}`, ts: t.ts, day, job: q.job, situation: q.situation, memories: q.memories || [], keys: q.keys, acts: q.acts, label, why, source: questions.length && nearest(t.ts) ? 'asked' : 'rebuilt' });
  }
  return rows;
}

async function main() {
  const i = process.argv.indexOf('--days');
  const days = i >= 0 ? process.argv[i + 1].split(',') : [];
  const { createMemory, ollamaEmbedder } = require('../vault/memory');
  const model = (process.env.EMBED_MODEL || '').trim();
  const cache = path.join(OUT, 'memory-embeddings.json'); // a private copy: never write the live bot's cache
  fs.mkdirSync(OUT, { recursive: true });
  const live = path.join(LOGS, 'memory-embeddings.json');
  if (!fs.existsSync(cache) && fs.existsSync(live)) fs.copyFileSync(live, cache);
  const memory = createMemory({ vaultPath: process.env.VAULT_PATH, embed: model ? ollamaEmbedder({ model }) : null, cacheFile: model ? cache : null });
  try { memory.refresh(); } catch (_) { /* empty vault */ }
  for (const day of days) {
    const rows = await labelDay(day, memory);
    fs.writeFileSync(path.join(OUT, `gather-rows-${day}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    const tally = rows.reduce((m, r) => { const k = `${r.label === 'nothing' ? 'nothing' : 'gather'} (${r.why})`; m[k] = (m[k] || 0) + 1; return m; }, {});
    console.log(`[labels] gather ${day}: ${rows.length} rows ${JSON.stringify(tally)}; asked ${rows.filter((r) => r.source === 'asked').length}, rebuilt ${rows.filter((r) => r.source === 'rebuilt').length}`);
  }
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
module.exports = { labelDay, outcome, gatherKey };
