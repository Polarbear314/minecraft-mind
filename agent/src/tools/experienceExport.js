// B1 of docs/design-plasticity-and-a-learning-cortex.md: turn the body's
// tick log into examples of SITUATION -> ACTION -> WHAT CAME OF IT, the raw
// material a local cortex could learn from (and the yardstick to test one on).
//
//   npm run export            -> logs/training/examples.jsonl + a summary
//
// Labels come from the world, not from any mind's opinion:
//   bad  — death within the next ~30 s, a real loss of health, or the body
//          refusing the act ("there was only air under me");
//   good — the act was carried out and nothing hurt in the next ~30 s;
//   (anything in between is left out).
// Read-only over logs/; writes only logs/training/.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const LOGS = path.resolve(__dirname, '..', '..', '..', 'logs');
const WINDOW = 20; // ticks after a decision (~30 s at 1.5 s per tick)
const RUN_SAMPLE = 10; // while the same act continues, take one example every N ticks
const BAD_HEALTH_LOSS = 4;

// Acts whose direction matters ("dig below" is not "dig ahead").
const AIMED = new Set(['dig', 'place', 'move', 'use']);
const actionKey = (a) => (a && AIMED.has(a.type) && a.at ? `${a.type} ${a.at}` : (a && a.type) || 'idle');

function readJsonl(prefix, dir = LOGS) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl')).sort(); } catch (_) { return out; }
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_) { /* partial line */ }
    }
  }
  return out;
}

/** The situation in a few plain lines (what the fast cortex would be shown). */
function situationText(t) {
  const a = t.aff || {};
  const parts = [];
  parts.push(`${t.isDay ? 'Daytime' : 'Night'}${t.tod != null ? ` (time ${t.tod})` : ''}. Health ${t.health}/20, food ${t.food}/20.`);
  const where = a.enclosed ? 'closed in on every side' : `${a.sky ? 'open sky above' : 'something over my head'}, ${a.walls || 0} of 4 sides closed`;
  parts.push(`Where I stand: ${where}.${a.bed != null ? ` A bed ${a.bed} blocks away.` : ''}${a.door != null ? ` A door ${a.door} blocks away.` : ''}`);
  parts.push(`I carry ${a.blocks ? `${a.blocks} kind(s) of block I could place` : 'no blocks to place'}${t.inv ? `; in all: ${t.inv}` : ''}.`);
  const h = (t.hostiles || []).map((x) => `${x.name} at ${x.d}`).join(', ');
  parts.push(h ? `Hostile: ${h}.` : 'No hostile creature in sight.');
  if (t.near && t.near.length) parts.push(`Also near: ${t.near.map((x) => `${x.name} at ${x.d}`).join(', ')}.`);
  if (t.border != null && t.border < 12) parts.push(`The edge of the world is ${t.border} blocks away.`);
  return parts.join(' ');
}

/**
 * Build examples from ticks (sorted by time) and death times (ms).
 * Returns [{ ts, situation, action, source, plan, label, why }].
 */
function buildExamples(ticks, deathTimes = []) {
  const deaths = [...deathTimes].sort((a, b) => a - b);
  const out = [];
  let prevKey = null;
  let runLen = 0;
  for (let i = 0; i < ticks.length; i += 1) {
    const t = ticks[i];
    if (!t.action) continue;
    const key = actionKey(t.action);
    runLen = key === prevKey ? runLen + 1 : 0;
    prevKey = key;
    if (runLen % RUN_SAMPLE !== 0) continue; // a new act, or a sample of a continuing one
    const tms = Date.parse(t.ts);
    const after = ticks.slice(i + 1, i + 1 + WINDOW);
    if (after.length < WINDOW) continue; // the future isn't known yet
    const endMs = Date.parse(after[after.length - 1].ts);
    if (endMs - tms > WINDOW * 1.5 * 1000 * 3) continue; // a gap (restart): don't judge across it
    const died = deaths.some((d) => d > tms && d <= endMs);
    const lowest = Math.min(...after.map((x) => (x.health != null ? x.health : t.health)));
    const lost = (t.health != null ? t.health : 20) - lowest;
    const refused = t.result && t.result.ok === false;
    const hurt = after.some((x) => x.tookDamage) || t.tookDamage;
    let label = null;
    let why = null;
    if (died) { label = 'bad'; why = 'died soon after'; }
    else if (refused) { label = 'bad'; why = `the body could not: ${String(t.result.reason || '').slice(0, 80)}`; }
    else if (lost >= BAD_HEALTH_LOSS) { label = 'bad'; why = `lost ${Math.round(lost)} health soon after`; }
    else if (!hurt) { label = 'good'; why = 'carried out, and nothing hurt afterwards'; }
    if (!label) continue;
    out.push({
      ts: t.ts, situation: situationText(t), action: key, source: t.action.source || null,
      plan: t.action.plan || null, label, why, isDay: !!t.isDay, hostileNear: (t.hostiles || []).some((x) => x.d != null && x.d <= 8),
    });
  }
  return out;
}

function loadAll(dir = LOGS) {
  const raw = readJsonl('ticks-', dir);
  const deaths = raw.filter((t) => t.event === 'death').map((t) => Date.parse(t.ts));
  const ticks = raw.filter((t) => !t.event && t.ts && t.action).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { ticks, deaths };
}

function main() {
  const { ticks, deaths } = loadAll();
  const examples = buildExamples(ticks, deaths);
  const outDir = path.join(LOGS, 'training');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'examples.jsonl');
  fs.writeFileSync(file, examples.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const count = (f) => examples.filter(f).length;
  const bySource = {};
  for (const e of examples) bySource[e.source] = (bySource[e.source] || 0) + 1;
  const actions = {};
  for (const e of examples.filter((x) => x.label === 'good')) actions[e.action] = (actions[e.action] || 0) + 1;
  console.log(`[export] ${ticks.length} ticks, ${deaths.length} deaths -> ${examples.length} examples (${count((e) => e.label === 'good')} good, ${count((e) => e.label === 'bad')} bad)`);
  console.log(`[export] by who chose: ${JSON.stringify(bySource)}`);
  console.log(`[export] commonest good acts: ${Object.entries(actions).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  console.log(`[export] wrote ${file}`);
}

if (require.main === module) main();

module.exports = { buildExamples, situationText, actionKey, loadAll, readJsonl, WINDOW };
