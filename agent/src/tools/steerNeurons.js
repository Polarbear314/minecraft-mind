// Stage 7b, part 2: Opus operates on the Gather model's neurons itself
// (docs/results-7b-trial.md). Sandbox only.
//
//   node agent/src/tools/steerNeurons.js round --n N [--final]
//
// Each round Opus gets:
//   - the lesson (the flaw), and the unedited model's score on the CHECK half;
//   - the neuron map retrieved the FreeLAB way: every one of the 448 groups
//     (172,032 neurons) has a description; the descriptions and the lesson are
//     embedded with nomic-embed-text and the top 24 are retrieved, ranked by
//     similarity x how much switching the group off moves the answer;
//   - the groups it asked to inspect last round (their strongest neurons);
//   - every experiment so far and what it did on the check half.
// It replies with groups to inspect and up to 5 experiments, each a list of
// ops on named weights that it writes itself (cortex/neuron_map.py: scale_out,
// fire_more, write). This script runs them (neuron_map.py run) and records the
// results. With --final it names the one edit to keep, or none.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadBrainMap, regionProvider } = require('../brain/brainMap');
const { ollamaEmbedder } = require('../vault/memory');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.join(ROOT, 'logs', 'steer-trial');
const NEU = path.join(OUT, 'neurons');
const PY = path.join(ROOT, 'agent', '.venv-laya', 'Scripts', 'python.exe');
const MAPPY = path.join(ROOT, 'agent', 'src', 'cortex', 'neuron_map.py');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const pct = (x) => `${Math.round(x * 100)}%`;
const RETRIEVE = 24;
const LESSON = 'Gather says "nothing" by day, in the open, with no hostile near and something lying in reach to pick up. Which parts make it hold back from picking up, and which parts would make it pick up only when it is safe (day, open, no hostile), not at night, sealed in, or with a hostile close?';

function groupText(g, eff) {
  const s = g.topShare;
  const e = eff ? ` Switched off, P(nothing) moves ${eff.test >= 0 ? '+' : ''}${eff.test} when gathering is right and ${eff.control >= 0 ? '+' : ''}${eff.control} when it is not.` : '';
  return `Group ${g.id} (layer ${g.layer}, ${g.size} neurons). Fires most on: ${g.top[0]}. Of its top situations: day ${pct(s.day)}, sealed in ${pct(s.sealed)}, hostile near ${pct(s.hostile)}, worth gathering ${pct(s.worthGathering)}. Fires more when worth gathering: z ${g.z}. Tracks the model saying nothing: corr ${g.corrNothing}. When it fires, its output points toward less "nothing": cos ${g.cos}. Vocabulary it pushes up: ${g.up.slice(0, 5).map((w) => JSON.stringify(w)).join(' ')}.${e}`;
}

async function retrieve() {
  const cache = path.join(NEU, 'retrieved.json');
  if (fs.existsSync(cache)) return read(cache);
  const groups = read(path.join(NEU, 'groups.json'));
  const eff = read(path.join(NEU, 'group-effects.json')).offDeltaNothing;
  const embed = ollamaEmbedder({ model: process.env.EMBED_MODEL || 'nomic-embed-text' });
  const texts = groups.map((g) => groupText(g));
  const vecs = [];
  for (let i = 0; i < texts.length; i += 64) vecs.push(...await embed(texts.slice(i, i + 64).map((t) => `search_document: ${t}`)));
  const [q] = await embed([`search_query: ${LESSON}`]);
  const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / Math.sqrt(na * nb); };
  // Effect: how much the group moves the answer at all, and how differently in the two kinds of situation.
  const pull = (e) => Math.abs(e.test) + Math.abs(e.test - e.control);
  const maxPull = Math.max(...groups.map((g) => pull(eff[g.id])));
  const ranked = groups.map((g, i) => ({ id: g.id, sim: cos(q, vecs[i]), pull: pull(eff[g.id]) / maxPull }))
    .map((r) => ({ ...r, score: r.sim * (0.25 + r.pull) }))
    .sort((a, b) => b.score - a.score);
  const out = { lesson: LESSON, top: ranked.slice(0, RETRIEVE), all: ranked.length };
  fs.writeFileSync(cache, JSON.stringify(out, null, 1));
  return out;
}

function pyRun(args) {
  return execFileSync(PY, [MAPPY, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, TRANSFORMERS_VERBOSITY: 'error', HF_HUB_DISABLE_PROGRESS_BARS: '1' } });
}

const fmt = (r) => `test ${r.test.right}/${r.test.n} right (picks ${JSON.stringify(r.test.picks)}, P(nothing) ${r.test.pNothing}); controls ${r.control.right}/${r.control.n} right (${Object.entries(r.control.byKind || {}).map(([k, v]) => `${k} ${v}`).join(', ')}; picks ${JSON.stringify(r.control.picks)})`;

async function round(n, final) {
  const groups = Object.fromEntries(read(path.join(NEU, 'groups.json')).map((g) => [g.id, g]));
  const eff = read(path.join(NEU, 'group-effects.json')).offDeltaNothing;
  const ret = await retrieve();
  const hist = fs.existsSync(path.join(NEU, 'opus-rounds.json')) ? read(path.join(NEU, 'opus-rounds.json')) : [];
  const base = read(path.join(OUT, 'scores-base.json')).summary.check;
  const cases = Object.fromEntries(fs.readFileSync(path.join(OUT, 'cases.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((c) => [c.id, c]));
  const caseText = (id) => (cases[id] ? `${cases[id].situation.replace(' (of 100)', '')} | menu: ${cases[id].acts.filter((a) => !a.startsWith('nothing')).join('; ')}` : id).slice(0, 260);

  const L = [
    'MindBot is a creature in a small Minecraft world, run by a stack of layers (Survive > Make > Shelter > Gather > Forage > Wander; the first that speaks gets the body). The Gather layer is a small open model, Qwen3-1.7B: 28 transformer layers, each with an MLP of 6,144 neurons (172,032 in all). Each tick it is shown the situation in words and a short menu ("pick up the oak log lying nearby", "break the block ahead to carry it", "nothing: this is not for me right now"); its answer is the letter it finds most likely, asked twice with the options shuffled and averaged.',
    '',
    `THE FLAW: ${LESSON}`,
    `Unedited, on the check half: ${fmt({ test: { ...base.test, n: 20 }, control: { ...base.control, n: 20 } })}. Its mean P(nothing) is about the same in both kinds of situation.`,
    'An earlier attempt added one direction to layer 18 (a steering edit chosen through a tool): P(nothing) fell on the test cases but the probability went to "break the block ahead", not "pick up", and controls with a hostile close got worse. It was withdrawn.',
    '',
    'THIS TIME YOU OPERATE YOURSELF, in a sandbox copy (the live creature is untouched). Every neuron has been mapped: run over 986 of MindBot\'s own logged situations, each neuron\'s firing pattern is its fingerprint, and neurons that fire together are grouped (16 groups per layer, 448 groups). Each group is described below by what it fires on, how much it fires more when gathering is right (z), its correlation with the model\'s own P(nothing) (corr), whether its output points toward less "nothing" when it fires (cos), the vocabulary its output pushes up (often noise in middle layers), and what switching the whole group off does to P(nothing) on 12 gatherable and 12 night/hostile situations (none from the test set).',
    `The ${ret.top.length} groups below were retrieved from all ${ret.all} by similarity to the flaw x how much they move the answer. You may name any group id (layer:group, layers 0-27, groups 0-15) to inspect, not only these.`,
    '',
    'Retrieved groups:',
    ...ret.top.map((r) => `- ${groupText(groups[r.id], eff[r.id])}`),
    '',
    'YOUR SCALPEL: ops on named weights, written by you; the tool only executes and measures them.',
    '  {"op": "scale_out", "layer": L, "group": g | "neurons": [n, ...], "factor": f}   W_down[:, n] *= f for those neurons: 0 switches them off, 0.5 weakens, 1.5 strengthens what they write when they fire.',
    '  {"op": "fire_more", "layer": L, "group": g | "neurons": [n, ...], "amount": a}  a bias on the neurons\' gate: they fire more (a > 0) or less (a < 0) in every situation. Typical gate values are about -3 to 3.',
    '  {"op": "write", "layer": L, "neurons": [n, ...], "toward": "less-nothing" | "more-nothing", "amount": a}  W_down[:, n] += a x |W_down[:, n]| x d, where d is that layer\'s "says nothing" direction: when the neuron fires it now also pushes the answer away from (or toward) "nothing". a = 1 adds as much as the neuron already writes.',
    'An experiment is a list of ops applied together. Neurons are numbered 0-6143 within a layer.',
    '',
    'THE GOAL: more "pick up" when gathering is right, without more gathering at night, sealed in or with a hostile close. A change that helps the test cases by breaking controls is not a success. An honest "this cannot be fixed this way" is a fine answer.',
  ];
  const inspected = hist.length ? hist[hist.length - 1].inspected : null;
  if (inspected && Object.keys(inspected).length) {
    L.push('', 'GROUPS YOU ASKED TO INSPECT (their strongest neurons; z, corr and cos as above; up/down: vocabulary; firesMostOn: its top situations):');
    for (const [gid, ns] of Object.entries(inspected)) {
      L.push(`${gid}:`);
      for (const x of ns) L.push(`  ${x.neuron}: z ${x.z}, corr ${x.corrNothing}, cos ${x.cos}, up ${JSON.stringify(x.up.slice(0, 3))}; fires most on: ${x.firesMostOn[0]}`);
    }
  }
  if (hist.length) {
    L.push('', 'YOUR EXPERIMENTS SO FAR (check half: 20 test, 20 controls):');
    for (const h of hist) {
      L.push(`Round ${h.round}. Your notes: ${h.thinking || ''}`);
      for (const e of h.results || []) {
        if (e.name === 'unedited') continue;
        L.push(`  "${e.name}": ${JSON.stringify(e.ops)} -> ${fmt(e.result)}; fixed ${e.fixed.length}, broke ${e.broke.length}${e.broke.filter((id) => id.startsWith('control')).length ? ` (e.g. ${caseText(e.broke.find((id) => id.startsWith('control')))})` : ''}`);
      }
    }
  }
  if (final) {
    L.push('', 'This is the FINAL round. Choose the one edit (a list of ops, from your experiments or a refinement of one) you would keep, or none. It will be tested on held-out situations you have not seen, and compared with random edits of the same size.');
    L.push('Reply with JSON only: {"final": {"name": "...", "ops": [...]} | null, "why": "<three or four sentences: what you learned about how the model does this, and why you keep or reject>"}');
  } else {
    L.push('', `Round ${n}. Plan experiments that test a hypothesis about how the model decides, not only ones that might score well.`);
    L.push('Reply with JSON only: {"thinking": "<two or three sentences: your current hypothesis>", "inspect": ["L:g", ...] (up to 4 groups to see neuron by neuron next round), "experiments": [{"name": "...", "hypothesis": "...", "ops": [...]}] (up to 5)}');
  }
  const prompt = L.join('\n');
  const provider = regionProvider(loadBrainMap(), 'hippocampus', { timeoutMs: 900000 });
  const t0 = Date.now();
  const reply = await provider.ask(prompt);
  if (!String(reply.by || '').startsWith('claude')) throw new Error(`answered by ${reply.by}`);
  fs.writeFileSync(path.join(NEU, `opus-round-${n}.txt`), `${prompt}\n\n===== REPLY (${reply.by}, ${Math.round((Date.now() - t0) / 1000)} s) =====\n${reply.text}\n`);
  const raw = String(reply.text);
  const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  if (final) {
    fs.writeFileSync(path.join(NEU, 'opus-final.json'), JSON.stringify({ ...j, by: reply.by }, null, 1));
    console.log(JSON.stringify(j, null, 1));
    return;
  }
  const exps = (j.experiments || []).slice(0, 5);
  const opsFile = path.join(NEU, `round-${n}-ops.json`);
  fs.writeFileSync(opsFile, JSON.stringify(exps, null, 1));
  const resFile = path.join(NEU, `round-${n}-results.json`);
  pyRun(['run', '--ops', opsFile, '--out', resFile, '--half', 'check']);
  const results = read(resFile);
  const insp = (j.inspect || []).slice(0, 4).filter((g) => groups[g]);
  const inspectedNext = insp.length ? JSON.parse(pyRun(['inspect', '--groups', insp.join(',')])) : {};
  hist.push({ round: n, thinking: j.thinking, experiments: exps, results, inspectAsked: insp, inspected: inspectedNext });
  fs.writeFileSync(path.join(NEU, 'opus-rounds.json'), JSON.stringify(hist, null, 1));
  console.log(`Opus: ${j.thinking}`);
  for (const r of results) console.log(`  ${r.name}: ${fmt(r.result)}${r.fixed ? `; fixed ${r.fixed.length}, broke ${r.broke.length}` : ''}`);
  console.log(`  inspect next: ${insp.join(', ') || '-'}`);
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const opt = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };
  if (cmd === 'round') return round(Number(opt('n') || 1), process.argv.includes('--final'));
  if (cmd === 'retrieve') { const r = await retrieve(); console.log(JSON.stringify(r.top.slice(0, 12), null, 1)); return; }
  throw new Error('usage: steerNeurons.js round --n N [--final] | retrieve');
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
