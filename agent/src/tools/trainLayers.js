// Fit the learned layers from MindBot's own days (docs/design-subsumption.md, stage 4).
//
//   npm run train-layers            fit Forage and Wander, gate, save
//   npm run train-layers -- forage  just one
//
// For each layer: examples from the tick log (learn/examples.js), the most
// recent day held out, a readable classifier fitted on the rest
// (learn/softmax.js). THE GATE: on the held-out day, the learned layer must
// beat the hand-written one it would replace, by the bot's own outcomes:
// balanced accuracy (each act's recall, averaged) against what actually
// worked and what should have stayed quiet. The hand-written layer is scored
// by what it really did there. A model that doesn't clear the bar is kept as
// a version but not served.
//
// Writes logs/layers/<layer>-v<N>.json (every version), logs/layers/<layer>.json
// (the one served, if any passed) and appends to docs/results-layers.md.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { readTicks, splitDays } = require('./days');
const { MENUS, buildExamples } = require('../learn/examples');
const { FEATURES } = require('../learn/features');
const { train, predict, toTable } = require('../learn/softmax');
const { writeLab } = require('../vault/labNotes');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DIR = path.join(ROOT, 'logs', 'layers');
const MARGIN = 0.03;
const MIN_TRAIN = 60;
const MIN_HELD = 30;

function balanced(examples, predictFn) {
  const by = {};
  for (const e of examples) {
    by[e.y] = by[e.y] || { n: 0, right: 0 };
    by[e.y].n += 1;
    if (predictFn(e) === e.y) by[e.y].right += 1;
  }
  const recalls = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Math.round((100 * v.right) / v.n)]));
  const vals = Object.values(by).map((v) => v.right / v.n);
  return { score: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0, recalls, counts: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.n])) };
}

function nextVersion(layer) {
  let v = 0;
  try { for (const f of fs.readdirSync(DIR)) { const m = f.match(new RegExp(`^${layer}-v(\\d+)\\.json$`)); if (m) v = Math.max(v, Number(m[1])); } } catch (_) { /* none yet */ }
  return v + 1;
}

/**
 * extra: examples from outside the bot's own outcomes (Opus's corrections,
 * stage 5), with a weight. They are only ever TRAINED on, never tested on,
 * and never ones from the held-out stretch: the gate stays the bot's own.
 */
/** The examples for a layer, split into what it learns from and the held-out latest day. */
function splitExamples(layer, ticks) {
  const days = splitDays(ticks);
  const full = days.filter((d) => d.length >= 300);
  const heldDay = full[full.length - 1] || days[days.length - 1];
  let cut = heldDay ? heldDay[0].ts : null;
  const all = buildExamples(layer, ticks);
  let trainSet = all.filter((e) => !cut || e.ts < cut);
  let held = all.filter((e) => cut && e.ts >= cut);
  if (held.length < MIN_HELD) { // too few on the last day: hold out the latest quarter instead
    const k = Math.floor(all.length * 0.75);
    trainSet = all.slice(0, k); held = all.slice(k);
    cut = held.length ? held[0].ts : cut;
  }
  return { all, trainSet, held, cut };
}

/** The gate for any model (trained or edited): does it beat the hand-written layer on the held-out day? */
function gateModel(layer, held, model, result) {
  const learned = balanced(held, (e) => predict(model, e.x).pick);
  const handWritten = balanced(held, (e) => e.actual);
  Object.assign(result, {
    score: Math.round(learned.score * 1000) / 1000,
    baseline: Math.round(handWritten.score * 1000) / 1000,
    recalls: learned.recalls,
    baselineRecalls: handWritten.recalls,
    heldCounts: learned.counts,
    passed: learned.score > handWritten.score + MARGIN,
    reason: null,
  });
  if (!result.passed) result.reason = `did not beat the hand-written layer by ${MARGIN} (${result.score} vs ${result.baseline})`;
  result.model = { classes: model.classes, features: model.features, W: model.W, b: model.b };
  result.table = toTable(model);
  return result;
}

function fitLayer(layer, ticks, { now = new Date(), extra = [] } = {}) {
  const { all, trainSet, held, cut } = splitExamples(layer, ticks);
  const outside = extra.filter((e) => !cut || e.ts < cut);
  const result = { layer, route: 'train', at: now.toISOString(), examples: all.length, train: trainSet.length, held: held.length, corrections: outside.length, passed: false };
  if (trainSet.length < MIN_TRAIN || held.length < MIN_HELD) {
    result.reason = `not enough examples yet (${trainSet.length} to learn from, ${held.length} to test on; need ${MIN_TRAIN} and ${MIN_HELD})`;
    return result;
  }
  const classes = MENUS[layer];
  const fitOn = trainSet.concat(outside);
  const model = train(fitOn.map((e) => e.x), fitOn.map((e) => e.y), { classes, features: FEATURES, weights: fitOn.map((e) => e.weight || 1) });
  return gateModel(layer, held, model, result);
}


function save(result) {
  fs.mkdirSync(DIR, { recursive: true });
  if (!result.model) return null;
  const version = nextVersion(result.layer);
  const file = path.join(DIR, `${result.layer}-v${version}.json`);
  fs.writeFileSync(file, JSON.stringify({ version, ...result }, null, 2));
  if (result.passed) fs.writeFileSync(path.join(DIR, `${result.layer}.json`), JSON.stringify({ version, ...result }, null, 2));
  return version;
}

function report(results) {
  const lines = [`\n## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\n`];
  for (const r of results) {
    lines.push(`**${r.layer}${r.version ? ` v${r.version}` : ''}:** ${r.passed ? 'PASSED the gate, now served' : `not served (${r.reason})`}.`);
    if (r.score != null) {
      lines.push(`- ${r.train} examples to learn from, ${r.held} held out (the latest day). Balanced accuracy ${r.score} vs the hand-written layer's ${r.baseline}.`);
      lines.push(`- Held-out examples by act: ${Object.entries(r.heldCounts).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
      lines.push(`- Right per act, learned: ${Object.entries(r.recalls).map(([k, v]) => `${k} ${v}%`).join(', ')}; hand-written: ${Object.entries(r.baselineRecalls).map(([k, v]) => `${k} ${v}%`).join(', ')}.`);
      const top = Object.entries(r.table).filter(([c]) => c !== 'none').map(([c, w]) => {
        const s = Object.entries(w).filter(([f]) => f !== 'bias').sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3);
        return `${c} (${s.map(([f, v]) => `${f} ${v > 0 ? '+' : ''}${v}`).join(', ')})`;
      });
      lines.push(`- Strongest weights: ${top.join('; ')}.`);
    }
    lines.push('');
  }
  const file = path.join(ROOT, 'docs', 'results-layers.md');
  const head = fs.existsSync(file) ? '' : '# Learned layers\n\n*Written by `npm run train-layers`. Each run fits the layers on MindBot\'s own days, holds out the latest day, and serves a layer only if it beats the hand-written one there (balanced accuracy over acts that worked and moments to stay quiet). Model files: `logs/layers/`.*\n';
  fs.appendFileSync(file, head + lines.join('\n'));
  // The same, in the vault's Lab/ folder (for reading in Obsidian; MindBot never reads it).
  try { writeLab((process.env.VAULT_PATH || '').trim(), 'Learned Layers', fs.readFileSync(file, 'utf8')); } catch (_) { /* no vault: docs/ has it */ }
}

function main() {
  const which = process.argv.slice(2).filter((a) => MENUS[a]);
  const layers = which.length ? which : Object.keys(MENUS);
  const ticks = readTicks().filter((t) => t.action && t.action.layer);
  console.log(`${ticks.length} ticks from the behaviour stack.`);
  const corrections = require('../learn/nightly').readCorrections(DIR);
  const results = layers.map((l) => {
    const extra = corrections.filter((c) => c.layer === l).map((c) => ({ x: c.x, y: c.should, ts: c.ts, actual: c.actual, weight: 2 }));
    const r = fitLayer(l, ticks, { extra }); r.version = save(r); return r;
  });
  for (const r of results) {
    console.log(`\n${r.layer}${r.version ? ` v${r.version}` : ''}: ${r.passed ? 'PASSED, now served' : `not served: ${r.reason}`}`);
    if (r.score != null) console.log(`  balanced accuracy ${r.score} vs hand-written ${r.baseline}; held out ${JSON.stringify(r.heldCounts)}`);
  }
  report(results);
  console.log('\nWrote docs/results-layers.md and logs/layers/.');
}

if (require.main === module) main();
module.exports = { fitLayer, gateModel, splitExamples, balanced, save, report, DIR, MIN_TRAIN, MIN_HELD };
