// Stage 7b, part 3, test 4: Opus as the teacher (docs/results-7b-trial.md).
//
//   node agent/src/tools/steerOpusTeacher.js   -> logs/steer-trial/neurons/teacher-opus.json
//
// Opus labels the 80 teacher situations decision_write.py fits to (none from
// the test set): should Gather pick up what lies in reach, or do nothing, and
// how sure. Its answers are the teacher's targets; the solve then writes them
// into the model. This is the form a nightly loop could run: Opus says what the
// lesson is, the solve writes it, the gate checks it.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { loadBrainMap, regionProvider } = require('../brain/brainMap');

const NEU = path.resolve(__dirname, '..', '..', '..', 'logs', 'steer-trial', 'neurons');

async function main() {
  const ids = JSON.parse(fs.readFileSync(path.join(NEU, 'teacher-ids.json'), 'utf8'));
  const texts = Object.fromEntries(fs.readFileSync(path.join(NEU, 'teacher-texts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.id, r.text]));
  const items = ids.map((id, n) => ({ n: n + 1, id, text: texts[id] }));
  const L = [
    'You are teaching MindBot, a creature in a small Minecraft world. Its behaviour comes from a stack of layers; the first that speaks each tick gets the body. One layer, Gather, decides whether to pick up what lies on the ground in reach, or to do nothing and let the other layers act (Survive flees and fights off danger; Shelter digs in and seals itself in at night).',
    'For each situation below, say what Gather should do, "pickup" or "nothing", and how sure you are (0.5 = could go either way, 1 = certain). The goal: stay alive, unhurt and fed, and get on with living. Use what you know about Minecraft (night, hostile mobs, leaving a sealed shelter) as well as what the situation says.',
    'Your answers become the lesson written into the Gather model. Whether the changed model is kept is decided by how it does on situations you have not seen.',
    '',
    ...items.map((x) => `#${x.n}: ${x.text}`),
    '',
    'Reply with JSON only: {"labels": [{"n": 1, "should": "pickup" | "nothing", "sure": 0.5-1}, ...]} (every situation).',
  ];
  const prompt = L.join('\n');
  const provider = regionProvider(loadBrainMap(), 'hippocampus', { timeoutMs: 900000 });
  const t0 = Date.now();
  const reply = await provider.ask(prompt);
  if (!String(reply.by || '').startsWith('claude')) throw new Error(`answered by ${reply.by}`);
  fs.writeFileSync(path.join(NEU, 'opus-teacher.txt'), `${prompt}\n\n===== REPLY (${reply.by}, ${Math.round((Date.now() - t0) / 1000)} s) =====\n${reply.text}\n`);
  const raw = String(reply.text);
  const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const byN = Object.fromEntries(items.map((x) => [x.n, x]));
  const q = {};
  for (const l of j.labels || []) {
    const x = byN[l.n];
    if (!x || !['pickup', 'nothing'].includes(l.should)) continue;
    const sure = Math.min(0.98, Math.max(0.5, Number(l.sure) || 0.85));
    const p = l.should === 'pickup' ? sure : 1 - sure;
    q[x.id] = { pickup: Math.round(p * 1000) / 1000, nothing: Math.round((1 - p) * 1000) / 1000 };
  }
  const missing = ids.filter((id) => !q[id]);
  for (const id of missing) q[id] = { pickup: 0.5, nothing: 0.5 };
  fs.writeFileSync(path.join(NEU, 'teacher-opus.json'), JSON.stringify({ q, by: reply.by, missing: missing.length }, null, 1));
  console.log(`${Object.keys(q).length - missing.length} of ${ids.length} labelled by ${reply.by} in ${Math.round((Date.now() - t0) / 1000)} s; missing ${missing.length}`);
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
