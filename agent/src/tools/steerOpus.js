// Stage 7b sandbox trial: Opus's side (docs/results-7b-trial.md).
//
//   node agent/src/tools/steerOpus.js describe          one-line "fires on" for every unit (the index as a document)
//   node agent/src/tools/steerOpus.js propose --round N  pick an edit, or keep / adjust / withdraw the last one
//
// Opus (the hippocampus region: brain/brainMap.js) never sees raw weights. It
// reads the units' descriptions, how well each separates "worth gathering"
// from not, how much each pulls the choice of "nothing" when nudged, and, from
// round 2, what the last edit did on the CHECK half of the test set and
// controls (the held-out half is kept for the final report). The edit it
// names is folded into one layer's weights by cortex/steer_trial.py.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { loadBrainMap, regionProvider } = require('../brain/brainMap');

const OUT = path.resolve(__dirname, '..', '..', '..', 'logs', 'steer-trial');
const read = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
const has = (f) => fs.existsSync(path.join(OUT, f));
const cut = (s, n = 230) => (s.length > n ? `${s.slice(0, n)}…` : s);

function parseJson(text) {
  const raw = String(text || '');
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error(`no JSON in reply: ${raw.slice(0, 300)}`);
  return JSON.parse(raw.slice(s, e + 1));
}

async function askOpus(prompt, tag) {
  const provider = regionProvider(loadBrainMap(), 'hippocampus', { timeoutMs: 600000 });
  if (!provider) throw new Error('no hippocampus provider');
  const t0 = Date.now();
  const reply = await provider.ask(prompt);
  if (!String(reply.by || '').startsWith('claude')) throw new Error(`answered by ${reply.by}, not Claude: not using it`);
  fs.writeFileSync(path.join(OUT, `opus-${tag}.txt`), `${prompt}\n\n===== REPLY (${reply.by}, ${Math.round((Date.now() - t0) / 1000)} s) =====\n${reply.text}\n`);
  return { json: parseJson(reply.text), by: reply.by, secs: Math.round((Date.now() - t0) / 1000) };
}

function unitList(units) {
  const list = [];
  for (const [l, L] of Object.entries(units.layers)) {
    for (const [name, d] of Object.entries(L.directions)) list.push({ key: `${l}/${name}`, layer: Number(l), kind: 'direction', name, d });
    for (const n of L.neurons.slice(0, 4)) list.push({ key: `${l}/n${n.neuron}`, layer: Number(l), kind: 'neuron', name: `n${n.neuron}`, d: n });
  }
  return list;
}

async function describe() {
  const units = read('units.json');
  const list = unitList(units);
  const lines = [
    'You are helping to index the insides of a small language model (Qwen3-1.7B) that serves as the "Gather" layer of MindBot, a creature in a small Minecraft world. Each tick the layer is shown the situation in words and a short menu (e.g. "pick up the oak log lying nearby", "break the block ahead to carry it", "nothing: this is not for me right now"), and its answer is the letter it finds most likely.',
    'Below are units of the model: directions in one layer\'s activations at the answer position (a contrast direction, top principal directions, a direction tracking how much it says "nothing") and single MLP neurons. For each, the situations that push it highest (and for directions, lowest).',
    'For each unit write ONE short line (under 20 words) saying what it seems to respond to, e.g. "fires on: daytime, open sky, something lying in reach; low at night when sealed in". Say "unclear" if the examples don\'t show a pattern. Don\'t guess beyond the examples.',
    '',
  ];
  for (const u of list) {
    lines.push(`### ${u.key} (${u.kind})`);
    if (u.kind === 'direction') {
      lines.push('Highest:', ...u.d.top.slice(0, 4).map((t) => `  + ${cut(t)}`), 'Lowest:', ...u.d.bottom.slice(0, 3).map((t) => `  - ${cut(t)}`));
    } else {
      lines.push('Highest:', ...u.d.top.slice(0, 3).map((t) => `  + ${cut(t)}`));
    }
  }
  lines.push('', 'Reply with JSON only: {"<unit key>": "<one line>", ...} for every unit above.');
  const { json, by, secs } = await askOpus(lines.join('\n'), 'describe');
  fs.writeFileSync(path.join(OUT, 'units-described.json'), JSON.stringify(json, null, 1));
  console.log(`${Object.keys(json).length} units described by ${by} in ${secs} s`);
}

const fmtSummary = (s) => `test (gathering was right): ${s.test.right}/${s.test.n} right, picks ${JSON.stringify(s.test.picks)}, mean P(nothing) ${s.test.pNothing}; controls (nothing was right): ${s.control.right}/${s.control.n} right (${Object.entries(s.control.byKind).map(([k, v]) => `${k} ${v}`).join(', ')}), picks ${JSON.stringify(s.control.picks)}`;

function caseText(cases, id) {
  const c = cases.find((x) => x.id === id);
  return c ? cut(`${c.situation} | menu: ${c.acts.filter((a) => !a.startsWith('nothing')).join('; ')}`, 260) : id;
}

async function propose(round) {
  const units = read('units.json');
  const desc = read('units-described.json');
  const effects = read('effects.json');
  const base = read('scores-base.json');
  const cases = fs.readFileSync(path.join(OUT, 'cases.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const history = has('rounds.json') ? read('rounds.json') : [];
  const list = unitList(units);

  const lines = [
    'MindBot is a creature in a small Minecraft world, run by a stack of layers (Survive > Make > Shelter > Gather > Forage > Wander; the first that speaks gets the body). The Gather layer is a small open model, Qwen3-1.7B (28 layers, residual width 2048, MLP width 6144). Each tick it is shown the situation in words and a menu; its answer is the letter it finds most likely, asked twice with the options shuffled and averaged.',
    '',
    'THE FLAW: by day, in the open, with no hostile near and something lying in reach (a dropped log, dirt, seeds, a carrot), Gather says "nothing: this is not for me right now" most of the time. Meanwhile at night sealed in, at night in the open, or with a hostile close (where "nothing" is right) it often says "pick up" or "break the block ahead". Its mean P(nothing) is about the same in both kinds of situation: it barely tells them apart in its answer.',
    `Before any edit, on the check half: ${fmtSummary(base.summary.check)}.`,
    '',
    'You are trialling a targeted edit to its weights, in a sandbox copy (the live creature is untouched). You cannot read the weights; you work through the units below, found by running the model over 320 logged situations (83 of them "worth gathering": day, open, nothing hostile within 10 blocks, something in reach). For each unit: what it responds to (written from its top examples), "separation" (how far apart worth-gathering and other situations sit along it, in standard deviations), "corr" (correlation with the model\'s own P(nothing) across the 320; negative = higher along it, less "nothing"), and for directions "pull": the change in mean P(nothing) when the direction is added to that layer\'s output at strength 1 and 3 (in spreads of the situations along it), on 8 gatherable situations (G) and on 8 night/hostile ones (N), none of them in the test set.',
    '',
    'Units:',
  ];
  for (const u of list) {
    const e1 = effects.deltaNothing[`${u.layer}/${u.name}/1`] || effects.deltaNothing[`${u.layer}/${u.name}/1.0`];
    const e3 = effects.deltaNothing[`${u.layer}/${u.name}/3`] || effects.deltaNothing[`${u.layer}/${u.name}/3.0`];
    const pull = u.kind === 'direction' && e1 ? ` pull@1 G ${e1.gatherable} N ${e1['night or hostile']}; pull@3 G ${e3.gatherable} N ${e3['night or hostile']}` : '';
    const stats = u.kind === 'direction' ? `separation ${u.d.separation}, corr ${u.d.corrWithNothing}` : `z ${u.d.z} (fires more on worth-gathering if +), corr ${u.d.corrWithNothing}`;
    lines.push(`- ${u.key}: ${desc[u.key] || '(no description)'} [${stats};${pull}]`);
  }
  lines.push(
    '',
    'EDITS you can make (one per round), each folded into ONE layer\'s MLP output weights (down_proj) as a saved patch:',
    '  {"kind": "direction", "layer": L, "unit": "<direction name>", "strength": s}  adds s spreads of that direction to the layer\'s output in EVERY situation (a bias). Negative s pushes the other way.',
    '  {"kind": "keyed", "layer": L, "unit": "<direction name>", "strength": s}  a rank-1 weight change that adds the direction in proportion to how much the MLP\'s input at that layer looks like a typical worth-gathering moment (about 1 there, about 0 on a typical other moment, can go negative). Meant to change the gatherable situations more than the others.',
    '  {"kind": "neurons", "layer": L, "neurons": [n, ...], "strength": s}  scales those MLP neurons\' outgoing weights by (1 + s): they push harder (or, negative, weaker) only when they fire. Neurons are named n<number> above.',
    'Directions are oriented so + leans toward "worth gathering" / "less nothing".',
    '',
    'The goal: more "pick up" when gathering is right, WITHOUT more gathering at night, sealed in, or with a hostile close. A change that helps the test cases by breaking the controls is not a success. Small honest results are fine: say so if you think steering cannot fix this.',
  );
  if (history.length) {
    lines.push('', 'WHAT YOU HAVE TRIED (measured on the check half: 20 test, 20 controls):');
    for (const h of history) {
      lines.push(`Round ${h.round}: ${h.decision}${h.spec ? ` ${JSON.stringify(h.spec)}` : ''}. Your reason: ${h.why}`);
      if (h.result) {
        lines.push(`  Result: ${fmtSummary(h.result.check)}.`);
        if (h.flips) {
          lines.push(`  Test cases it fixed: ${h.flips.fixedTest.length}; test cases it broke: ${h.flips.brokeTest.length}; controls it broke: ${h.flips.brokeControl.length}; controls it fixed: ${h.flips.fixedControl.length}.`);
          for (const id of h.flips.brokeControl.slice(0, 3)) lines.push(`  A control it broke: ${caseText(cases, id)}`);
          for (const id of h.flips.stillWrongTest.slice(0, 2)) lines.push(`  A test case still wrong: ${caseText(cases, id)}`);
        }
      }
    }
    lines.push('', 'Now decide about the LAST edit: "keep" it (and stop), "adjust" it (give the new edit, which replaces it), or "withdraw" it (back to the unedited model; you may give a different edit to try instead, or none).');
    lines.push('Reply with JSON only: {"decision": "keep" | "adjust" | "withdraw", "edit": {...} or null, "why": "<two or three sentences>", "expect": "<what you expect it to do to the test cases and to the controls>"}');
  } else {
    lines.push('', `This is round ${round} of at most 3. Pick the edit you think most likely to fix the flaw without side effects, and a strength.`);
    lines.push('Reply with JSON only: {"decision": "edit", "edit": {...}, "why": "<two or three sentences: which units and why>", "expect": "<what you expect it to do to the test cases and to the controls>"}');
  }
  const { json, by, secs } = await askOpus(lines.join('\n'), `round-${round}`);
  fs.writeFileSync(path.join(OUT, `round-${round}-reply.json`), JSON.stringify({ ...json, by, secs }, null, 1));
  console.log(JSON.stringify({ ...json, by, secs }, null, 1));
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const opt = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
  if (cmd === 'describe') return describe();
  if (cmd === 'propose') return propose(Number(opt('round', 1)));
  throw new Error('usage: steerOpus.js describe | propose --round N');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
