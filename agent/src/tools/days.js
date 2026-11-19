// Patterns across days (docs/design-subsumption.md, stage 3).
//
//   npm run days                 every Minecraft day in logs/ticks-*.jsonl
//   npm run days -- --layers     only days the behaviour stack ran (MIND=layers)
//   npm run days -- --last 20    only the last 20 days
//
// A "day" is one Minecraft day-night cycle of the bot's life, cut where the
// game clock wraps (dawn) or where the bot was off for more than 10 minutes.
// Writes logs/days.json and docs/results-days.md (a table, plus a row of
// sparklines for the measures that should change as the layers learn).
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LOGS = path.join(ROOT, 'logs');
const GAP_MS = 10 * 60 * 1000;
const FULL_DAY_TICKS = 600; // fewer ticks than this: a partial day
const NIGHT = [13000, 23000];

function readTicks() {
  const files = fs.readdirSync(LOGS).filter((f) => /^ticks-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(LOGS, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const t = JSON.parse(line); if (t.ts && t.action) out.push(t); } catch (_) { /* skip */ }
    }
  }
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

function splitDays(ticks) {
  const days = [];
  let cur = [];
  for (const t of ticks) {
    const prev = cur[cur.length - 1];
    // Dawn: the game clock went back; for old ticks without a clock, night turned to day.
    const wrapped = prev && (prev.tod != null && t.tod != null ? t.tod + 1000 < prev.tod : prev.isDay === false && t.isDay === true);
    const gap = prev && Date.parse(t.ts) - Date.parse(prev.ts) > GAP_MS;
    if (prev && (wrapped || gap)) { days.push(cur); cur = []; }
    cur.push(t);
  }
  if (cur.length) days.push(cur);
  return days;
}

const did = (t, re) => !!(t.result && t.result.ok !== false && re.test(String(t.result.did || '')));

function measure(day, i) {
  const n = day.length;
  let dist = 0;
  const cells = new Set();
  let deaths = 0;
  for (let k = 0; k < n; k++) {
    const t = day[k];
    if (t.pos) cells.add(`${Math.floor(t.pos.x / 8)},${Math.floor(t.pos.z / 8)}`);
    const p = day[k - 1];
    if (p && p.pos && t.pos) {
      const d = Math.hypot(t.pos.x - p.pos.x, t.pos.z - p.pos.z);
      if (d < 12) dist += d; // a bigger jump is a respawn, not walking
      // Died: health was low and comes back full with a jump in position.
      if (p.health != null && t.health === 20 && p.health <= 6 && d > 12) deaths += 1;
    }
  }
  const layers = {};
  const voices = {};
  for (const t of day) {
    if (t.action.layer) layers[t.action.layer] = (layers[t.action.layer] || 0) + 1;
    for (const v of t.action.voices || []) voices[v] = (voices[v] || 0) + 1;
  }
  const share = (obj) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round((100 * v) / n)]));
  const night = day.filter((t) => (t.tod != null ? t.tod >= NIGHT[0] && t.tod < NIGHT[1] : t.isDay === false));
  const foods = day.map((t) => t.food).filter((f) => f != null);
  // Gather's own record (stage 2: learning from its own outcomes): ticks where its
  // model's choice moved the body, how each gathering turned out, and which
  // nightly patch was live (learn/gatherLabels.js judges an outcome).
  const { outcome: gatherOutcome, gatherKey } = require('../learn/gatherLabels');
  let gGood = 0; let gBad = 0;
  const gPatches = {};
  for (let k = 0; k < n; k++) {
    const t = day[k];
    const sh = (t.action.shadow || {}).gather;
    if (sh && sh.patch != null) gPatches[sh.patch] = (gPatches[sh.patch] || 0) + 1;
    if (t.action.learned !== 'gather' || !gatherKey(t.action)) continue;
    const o = gatherOutcome(day, k, true);
    if (o === 'good') gGood += 1; else if (o === 'bad') gBad += 1;
  }
  const gPatch = Object.entries(gPatches).sort((a, b) => b[1] - a[1])[0];
  return {
    day: i + 1,
    from: day[0].ts,
    to: day[n - 1].ts,
    ticks: n,
    partial: n < FULL_DAY_TICKS,
    mind: Object.keys(layers).length ? 'layers' : 'regions',
    distance: Math.round(dist),
    area: cells.size, // 8x8 cells visited
    deaths,
    damageTicks: day.filter((t) => t.tookDamage).length,
    minHealth: Math.min(...day.map((t) => (t.health == null ? 20 : t.health))),
    avgFood: foods.length ? Math.round((10 * foods.reduce((a, b) => a + b, 0)) / foods.length) / 10 : null,
    starvingTicks: day.filter((t) => t.food != null && t.food <= 3).length,
    ate: day.filter((t) => did(t, /^ate /)).length,
    hunted: day.filter((t) => did(t, /^swung at/)).length,
    harvested: day.filter((t) => t.action.harvest && did(t, /breaking/)).length,
    broke: day.filter((t) => did(t, /^breaking/)).length,
    made: day.filter((t) => did(t, /^made /)).length,
    placed: day.filter((t) => did(t, /^set .* down/)).length,
    refused: day.filter((t) => t.result && t.result.ok === false).length,
    nightTicks: night.length,
    nightEnclosed: night.length ? Math.round((100 * night.filter((t) => t.aff && t.aff.enclosed).length) / night.length) : null,
    animalsSeen: day.filter((t) => (t.near || []).some((e) => /cow|pig|sheep|chicken|rabbit/.test(e.name))).length,
    ripeCropsSeen: day.filter((t) => (t.crops || []).some((c) => c.ripe)).length,
    inControl: share(layers),
    spoke: share(voices),
    gatherActed: day.filter((t) => t.action.learned === 'gather').length,
    gatherExplored: day.filter((t) => t.action.learned === 'gather' && ((t.action.shadow || {}).gather || {}).explored).length, // only when it acted
    gatherGood: gGood,
    gatherBad: gBad,
    gatherMistakeRate: gGood + gBad ? Math.round((100 * gBad) / (gGood + gBad)) : null,
    gatherPatch: gPatch ? Number(gPatch[0]) : null,
  };
}

const SPARK = '▁▂▃▄▅▆▇█';
function spark(values) {
  const v = values.map((x) => (x == null ? 0 : x));
  const lo = Math.min(...v); const hi = Math.max(...v);
  return v.map((x) => SPARK[hi === lo ? 0 : Math.round(((x - lo) / (hi - lo)) * (SPARK.length - 1))]).join('');
}

function main() {
  const args = process.argv.slice(2);
  const lastI = args.indexOf('--last');
  let days = splitDays(readTicks()).map(measure);
  if (args.includes('--layers')) days = days.filter((d) => d.mind === 'layers');
  if (lastI >= 0) days = days.slice(-Number(args[lastI + 1] || 20));
  fs.writeFileSync(path.join(LOGS, 'days.json'), JSON.stringify(days, null, 2));

  const cols = ['day', 'mind', 'ticks', 'distance', 'area', 'deaths', 'damageTicks', 'avgFood', 'starvingTicks', 'ate', 'hunted', 'harvested', 'broke', 'made', 'nightEnclosed'];
  const head = ['Day', 'Mind', 'Ticks', 'Walked', 'Area', 'Deaths', 'Hurt', 'Avg food', 'Starving', 'Ate', 'Hunted', 'Harvested', 'Broke', 'Made', 'Night enclosed %', 'Most in control'];
  const rows = days.map((d) => [...cols.map((c) => (c === 'day' ? `${d.day}${d.partial ? '*' : ''}` : d[c] == null ? '—' : d[c])),
    Object.entries(d.inControl).slice(0, 3).map(([k, v]) => `${k} ${v}%`).join(', ') || '—']);
  const full = days.filter((d) => !d.partial);
  const trend = (k) => `| ${k} | \`${spark(full.map((d) => d[k]))}\` |`;
  const md = [
    '# Patterns across days',
    '',
    `*Written by \`npm run days\` on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC from \`logs/ticks-*.jsonl\`. One row per Minecraft day of MindBot's life; * = partial day (the bot was started, stopped or restarted). "Mind" is regions (Claude by day) or layers (the behaviour stack). Area = 8×8-block cells visited. Hurt = ticks it took damage. Starving = ticks with food at 3 or less. Most in control = share of ticks each layer had the body.*`,
    '',
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    '',
    `## Trends over full days (${full.length})`,
    '',
    '| Measure | Day 1 → latest |',
    '|---|---|',
    ...['distance', 'area', 'deaths', 'avgFood', 'starvingTicks', 'ate', 'harvested', 'made', 'nightEnclosed'].map(trend),
    '',
    ...(days.some((d) => d.gatherActed) ? [
      '## Gather learning from its own outcomes (stage 2)',
      '',
      '*Days when the Gather model acted (GATHER_MODE=on). Acted = ticks its choice moved the body; explored = its second choice, on purpose; went well / badly = how its gatherings turned out over the next 30 s (pack grew unharmed / hurt, failed or died); patch = the nightly weight write live that day (none = as downloaded).*',
      '',
      '| Day | Acted | Explored | Went well | Went badly | Mistake rate % | Patch |',
      '|---|---|---|---|---|---|---|',
      ...days.filter((d) => d.gatherActed).map((d) => `| ${d.day}${d.partial ? '*' : ''} | ${d.gatherActed} | ${d.gatherExplored} | ${d.gatherGood} | ${d.gatherBad} | ${d.gatherMistakeRate ?? '—'} | ${d.gatherPatch != null ? `v${d.gatherPatch}` : 'none'} |`),
      '',
      `Mistake rate, day by day: \`${spark(days.filter((d) => d.gatherActed && d.gatherMistakeRate != null).map((d) => d.gatherMistakeRate))}\``,
      '',
    ] : []),
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, 'docs', 'results-days.md'), md);
  // The same, in the vault's Lab/ folder (for reading in Obsidian; MindBot never reads it).
  try { require('../vault/labNotes').writeLab((process.env.VAULT_PATH || '').trim(), 'Days', md); } catch (_) { /* no vault: docs/ has it */ }

  console.log(`${days.length} days (${full.length} full). Wrote logs/days.json and docs/results-days.md\n`);
  console.log(head.slice(0, 15).map((h) => h.slice(0, 9).padEnd(9)).join(' '));
  for (const r of rows) console.log(r.slice(0, 15).map((x) => String(x).slice(0, 9).padEnd(9)).join(' '));
}

if (require.main === module) main();
module.exports = { splitDays, measure, spark, readTicks };
