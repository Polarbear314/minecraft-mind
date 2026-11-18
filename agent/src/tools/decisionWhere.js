// Stage 7b, part 3: Opus chooses WHERE a decision is written into the Gather
// model (docs/results-7b-trial.md). The HOW is not Opus's: a closed-form solve
// (cortex/decision_write.py) computes the weights from teacher examples.
//
//   node agent/src/tools/decisionWhere.js     -> logs/steer-trial/neurons/where-opus.json
//
// Opus reads the neuron map (the retrieved groups, as in part 2), what its own
// part-2 experiments found, and how the solve works, and names one layer and up
// to 512 neurons (whole groups and/or single neurons).
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { loadBrainMap, regionProvider } = require('../brain/brainMap');

const NEU = path.resolve(__dirname, '..', '..', '..', 'logs', 'steer-trial', 'neurons');
const read = (f) => JSON.parse(fs.readFileSync(path.join(NEU, f), 'utf8'));
const pct = (x) => `${Math.round(x * 100)}%`;
const MAX = 512;

function groupText(g, e) {
  const s = g.topShare;
  return `Group ${g.id} (layer ${g.layer}, ${g.size} neurons): fires most on: ${g.top[0].slice(0, 150)}. Top situations: day ${pct(s.day)}, sealed in ${pct(s.sealed)}, hostile near ${pct(s.hostile)}, worth gathering ${pct(s.worthGathering)}. z ${g.z}, corr ${g.corrNothing}, cos ${g.cos}. Switched off: P(nothing) ${e.test >= 0 ? '+' : ''}${e.test} when gathering is right, ${e.control >= 0 ? '+' : ''}${e.control} when not.`;
}

// Test 1 (part 3b): the layer is fixed at one where the solve is known to work
// (26), and Opus picks WHICH 256 neurons, as the automatic recipe does, so the
// only difference between the two is how the neurons are chosen.
async function fixedLayer(layer, max) {
  const groups = read('groups.json').filter((g) => g.layer === layer);
  const eff = read('group-effects.json').offDeltaNothing;
  const neurons = read('neurons.json');
  const dw = (n) => read(`dw-${n}.json`);
  const fmt = (r) => `test ${r.held.test.right}/20, controls ${r.held.control.right}/20`;
  const L = [
    'MindBot\'s Gather layer is a small open model, Qwen3-1.7B (28 layers, 6,144 MLP neurons per layer). It is shown the situation in words and a menu ("pick up the oak log lying nearby", "break the block ahead to carry it", "nothing: this is not for me right now") and answers with a letter.',
    'THE FLAW: by day, in the open, with no hostile near and something in reach, it says "nothing" too often; at night, sealed in, or with a hostile close, it often says "pick up".',
    '',
    'THE TOOL: a teacher gives the right answer for 80 logged situations (pick up when day, open, no hostile within 10; "nothing" at night, sealed in, or hostile close). For each, the smallest change to one layer\'s MLP output at the answer position that makes the model answer like the teacher is computed; then one least-squares solve gives the chosen neurons new output weights so that what they hold in each situation produces that change, with a protection term keeping plain text and the rest of each prompt unchanged. The edit can only act through neurons whose activity DIFFERS between the situations.',
    '',
    'WHAT HAPPENED SO FAR (held-out half; unedited: test 7/20, controls 15/20):',
    `- The published automatic choice, the ${max} neurons of layer ${layer} most active at the answer position relative to other text: ${fmt(dw('auto-26'))}. The first edit to improve both.`,
    `- ${max} random neurons of layer ${layer}, same solve: ${fmt(dw('random-26-0'))}. So which neurons matters.`,
    `- Your earlier choice, layer 13 group 13:9 (the night/sealed-in detector): ${fmt(dw('opus-13'))}, worse than unedited in every setting, and no better than random neurons at layer 13. Probably a depth problem: a change at layer 13 passes through 14 more layers, so the per-example changes don't add up as the solve assumes; at layer ${layer} they nearly do.`,
    '',
    `NOW THE LAYER IS FIXED AT ${layer} (second to last) and you choose WHICH ${max} neurons in it. The map of layer ${layer}: its 16 groups, by what makes them fire across 986 of the creature's own situations. z: fires more when gathering is right (+) or less (-); corr: correlation with the model's own P(nothing); cos: whether its output points toward less "nothing". "Switched off" is what removing the whole group does to P(nothing) on 12 gatherable and 12 night/hostile situations.`,
    ...groups.map((g) => `- ${groupText(g, eff[g.id])}`),
    '',
    `Name groups in order of preference; they are filled in that order until ${max} neurons, and within each group the neurons are taken by the measure you name ("z": most different between gatherable and not; "corr": most tied to saying nothing; "cos": output most toward less "nothing"; or "any"). You may also name single neurons (0-6143), which go first.`,
    'Reply with JSON only: {"groups": ["26:g", ...], "within": "z" | "corr" | "cos" | "any", "neurons": [n, ...], "why": "<three or four sentences>", "expect": "<one or two sentences, compared with the automatic choice>"}',
  ];
  const prompt = L.join('\n');
  const provider = regionProvider(loadBrainMap(), 'hippocampus', { timeoutMs: 900000 });
  const t0 = Date.now();
  const reply = await provider.ask(prompt);
  if (!String(reply.by || '').startsWith('claude')) throw new Error(`answered by ${reply.by}`);
  fs.writeFileSync(path.join(NEU, `opus-where-${layer}.txt`), `${prompt}\n\n===== REPLY (${reply.by}, ${Math.round((Date.now() - t0) / 1000)} s) =====\n${reply.text}\n`);
  const raw = String(reply.text);
  const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const key = { z: (x) => Math.abs(x.z), corr: (x) => Math.abs(x.corrNothing), cos: (x) => Math.abs(x.cos), any: () => 0 }[j.within] || ((x) => Math.abs(x.z));
  const list = [];
  const add = (n) => { if (list.length < max && n >= 0 && n < 6144 && !list.includes(n)) list.push(n); };
  for (const n of j.neurons || []) add(Number(String(n).split(':').pop()));
  for (const gid of j.groups || []) {
    const [gl, gg] = String(gid).split(':').map(Number);
    if (gl !== layer) continue;
    const members = [];
    for (let n = 0; n < 6144; n++) if (neurons[`${layer}:${n}`].g === gg) members.push(n);
    members.sort((a, b) => key(neurons[`${layer}:${b}`]) - key(neurons[`${layer}:${a}`]));
    members.forEach(add);
  }
  const auto = new Set(read(`where-auto-${layer}.json`).neurons);
  const where = { layer, neurons: list, how: `chosen by Opus within layer ${layer}: groups ${(j.groups || []).join(', ')}, within by ${j.within}`, overlapWithAuto: list.filter((n) => auto.has(n)).length, why: j.why, expect: j.expect, by: reply.by };
  fs.writeFileSync(path.join(NEU, `where-opus-${layer}.json`), JSON.stringify(where, null, 1));
  console.log(JSON.stringify({ ...where, neurons: `${list.length} neurons` }, null, 1));
}

async function main() {
  const li = process.argv.indexOf('--layer');
  if (li >= 0) return fixedLayer(Number(process.argv[li + 1]), 256);
  const groups = read('groups.json');
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
  const eff = read('group-effects.json').offDeltaNothing;
  const ret = read('retrieved.json');
  const final = read('opus-final.json');
  const rounds = read('opus-rounds.json');
  const L = [
    'MindBot\'s Gather layer is a small open model, Qwen3-1.7B (28 layers, 6,144 MLP neurons per layer). It is shown the situation in words and a menu ("pick up the oak log lying nearby", "break the block ahead to carry it", "nothing: this is not for me right now") and answers with a letter.',
    'THE FLAW: by day, in the open, with no hostile near and something in reach, it says "nothing" too often; and at night, sealed in, or with a hostile close, it often says "pick up". It does not connect danger to holding back.',
    '',
    'WHAT YOU FOUND BEFORE (your own neuron-level experiments in a sandbox copy):',
    `- Your final edit: ${JSON.stringify(final.final && final.final.ops)}. Your conclusion: ${final.why}`,
    ...rounds.map((r) => `- Round ${r.round} notes: ${r.thinking}`),
    '- On held-out cases your edit took the test cases from 7 to 17 of 20 right, but controls fell from 15 to 8 of 20 (it picked things up while sealed in at night). Random edits of the same shape did nothing.',
    '',
    'A DIFFERENT TOOL NOW. You choose only WHERE; a closed-form solve does the HOW:',
    '- A teacher gives the right answer for 80 logged situations (none from the test set): pick up when it is day, open and no hostile within 10 blocks; "nothing" at night, sealed in, or with a hostile close.',
    '- For each, the smallest change to your chosen layer\'s MLP output at the answer position that makes the model answer like the teacher is computed. Then one least-squares solve finds new output weights (down_proj columns) for the neurons you name, so that what those neurons hold in each situation produces that change. A protection term keeps their effect on the rest of each prompt and on plain English text near zero. The strength is chosen on the check half.',
    '- So the edit can only work through neurons whose activity DIFFERS between the situations: the solve can make them write something new, but only where they fire differently. Neurons that carry the danger signal, or the safe-daylight signal, are natural candidates; so are layers where those signals exist but don\'t yet reach the answer.',
    '- For comparison, the published recipe picks the 256 neurons most active at the answer position in the second-to-last layer (26), automatically.',
    '',
    `THE MAP (groups retrieved for this flaw, ranked by similarity x effect; any group id L:g, layers 0-27, groups 0-15, may be named):`,
    ...ret.top.map((r) => `- ${groupText(byId[r.id], eff[r.id])}`),
    '',
    `Choose ONE layer and up to ${MAX} neurons in it: whole groups and/or single neurons (numbers 0-6143 within that layer, e.g. from your earlier inspections). Say why, and what you expect compared with the automatic choice.`,
    'Reply with JSON only: {"layer": L, "groups": ["L:g", ...], "neurons": [n, ...], "why": "<three or four sentences>", "expect": "<one or two sentences>"}',
  ];
  const prompt = L.join('\n');
  const provider = regionProvider(loadBrainMap(), 'hippocampus', { timeoutMs: 900000 });
  const t0 = Date.now();
  const reply = await provider.ask(prompt);
  if (!String(reply.by || '').startsWith('claude')) throw new Error(`answered by ${reply.by}`);
  fs.writeFileSync(path.join(NEU, 'opus-where.txt'), `${prompt}\n\n===== REPLY (${reply.by}, ${Math.round((Date.now() - t0) / 1000)} s) =====\n${reply.text}\n`);
  const raw = String(reply.text);
  const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const layer = Number(j.layer);
  const labels = read('neurons.json'); // neuron -> group, to expand groups into neurons
  const cols = new Set((j.neurons || []).map((n) => Number(String(n).split(':').pop())).filter((n) => n >= 0 && n < 6144));
  for (const gid of j.groups || []) {
    const [gl, gg] = String(gid).split(':').map(Number);
    if (gl !== layer) continue; // one layer only
    for (let n = 0; n < 6144; n++) if (labels[`${layer}:${n}`].g === gg) cols.add(n);
  }
  let list = [...cols];
  if (list.length > MAX) list = list.slice(0, MAX);
  const where = { layer, neurons: list, how: `chosen by Opus: groups ${(j.groups || []).join(', ') || '-'} plus ${(j.neurons || []).length} single neurons`, why: j.why, expect: j.expect, by: reply.by };
  fs.writeFileSync(path.join(NEU, 'where-opus.json'), JSON.stringify(where, null, 1));
  console.log(JSON.stringify({ ...where, neurons: `${list.length} neurons` }, null, 1));
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
