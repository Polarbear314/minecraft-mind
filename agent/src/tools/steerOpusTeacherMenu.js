// Stage 7b, flaw 2: Opus as the teacher for any model layer, by menu
// (docs/results-7b-trial.md). Opus sees each teacher situation with the layer's
// menu and names the act it should choose; decision_write.py writes that in at a
// fixed confidence (0.85), the form that worked for Gather.
//
//   node agent/src/tools/steerOpusTeacherMenu.js --dir logs/steer-trial/shelter --ids teacher-ids.json
//     -> <dir>/neurons/teacher-opus-hard.json  {id: {"dist": {act: p}}}
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { loadBrainMap, regionProvider } = require('../brain/brainMap');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const opt = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };

async function main() {
  const dir = path.join(ROOT, opt('dir', 'logs/steer-trial/shelter'));
  const neu = path.join(dir, 'neurons');
  const ids = JSON.parse(fs.readFileSync(path.join(neu, opt('ids', 'teacher-ids.json')), 'utf8'));
  const pool = Object.fromEntries(fs.readFileSync(path.join(dir, 'map.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((c) => [c.id, c]));
  const items = ids.map((id, n) => ({ n: n + 1, c: pool[id] }));
  const job = items[0].c.job;
  const L = [
    'You are teaching MindBot, a creature in a small Minecraft world. Its behaviour comes from a stack of layers; the first that speaks each tick gets the body. One layer speaks for itself:',
    `"${job}"`,
    'For each situation below, choose what this layer should do: one act from its menu (by its key), and say why in a few words. "nothing" means it stays quiet and lets the other layers act (gathering, foraging, wandering by day). The goal: stay alive, unhurt and fed, and get on with living. Use what you know about Minecraft (day and night, when mobs come out) as well as what the situation says.',
    'Your answers become the lesson written into this layer\'s model. Whether the changed model is kept is decided by how it does on situations you have not seen.',
    '',
    ...items.map((x) => `#${x.n}: ${x.c.situation}\n   Menu: ${x.c.keys.map((k, i) => `${k} (${x.c.acts[i]})`).join('; ')}`),
    '',
    'Reply with JSON only: {"labels": [{"n": 1, "act": "<a menu key>"}, ...]} (every situation).',
  ];
  const prompt = L.join('\n');
  const provider = regionProvider(loadBrainMap(), 'hippocampus', { timeoutMs: 900000 });
  const t0 = Date.now();
  const reply = await provider.ask(prompt);
  if (!String(reply.by || '').startsWith('claude')) throw new Error(`answered by ${reply.by}`);
  fs.writeFileSync(path.join(neu, 'opus-teacher.txt'), `${prompt}\n\n===== REPLY (${reply.by}, ${Math.round((Date.now() - t0) / 1000)} s) =====\n${reply.text}\n`);
  const raw = String(reply.text);
  const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const byN = Object.fromEntries(items.map((x) => [x.n, x.c]));
  const q = {};
  const tally = {};
  let agree = 0;
  for (const l of j.labels || []) {
    const c = byN[l.n];
    if (!c || !c.keys.includes(l.act)) continue;
    const dist = Object.fromEntries(c.keys.map((k) => [k, k === l.act ? 0.85 : 0.15 / (c.keys.length - 1)]));
    q[c.id] = { dist, act: l.act, rule: c.teach };
    const kind = c.teach === 'nothing' ? 'day' : 'dusk';
    tally[`${kind} -> ${l.act === 'nothing' ? 'nothing' : l.act === 'stay' ? 'stay' : 'shelter act'}`] = (tally[`${kind} -> ${l.act === 'nothing' ? 'nothing' : l.act === 'stay' ? 'stay' : 'shelter act'}`] || 0) + 1;
    agree += (l.act === 'nothing') === (c.teach === 'nothing');
  }
  const missing = ids.filter((id) => !q[id]);
  fs.writeFileSync(path.join(neu, 'teacher-opus-hard.json'), JSON.stringify({ q, by: reply.by, missing }, null, 1));
  console.log(`${Object.keys(q).length}/${ids.length} labelled by ${reply.by} in ${Math.round((Date.now() - t0) / 1000)} s; agrees with the rule on act-or-not ${agree}; ${JSON.stringify(tally)}; missing ${missing.length}`);
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
