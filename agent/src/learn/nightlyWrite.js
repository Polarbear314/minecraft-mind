// The nightly weight write for the model layers (docs/design-subsumption.md):
// at dawn, after the classifiers' nightly learning, the day's moments become
// outcome labels (learn/gatherLabels.js), the lesson is written into the
// layer's weights and gated on the latest day (cortex/nightly_write.py), and if
// it passed, the model service applies it (POST /reload). It runs in the
// background, so sleep and the dream never wait for it, and one at a time.
//
// On with NIGHTLY_WRITE=gather in agent/.env (off by default). Only Gather has
// outcome labels so far.
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LABELLERS = { gather: path.join(__dirname, 'gatherLabels.js') };
let running = false;

const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function run(cmd, args, { spawnImpl = spawn, env = process.env } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawnImpl(cmd, args, { cwd: ROOT, env, windowsHide: true }); } catch (err) { resolve({ code: -1, out: String(err.message) }); return; }
    if (p.stdout) p.stdout.on('data', (d) => { out += d; });
    if (p.stderr) p.stderr.on('data', (d) => { out += d; });
    p.on('error', (err) => resolve({ code: -1, out: `${out}\n${err.message}` }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

/**
 * runNightlyWrite({ layers, now, endpoint, spawnImpl, fetchImpl, python }) -> Promise<[{ layer, passed, version, reason } | { layer, error }]>
 */
async function runNightlyWrite({ layers = ['gather'], now = new Date(), endpoint = 'http://127.0.0.1:3010', spawnImpl = spawn, fetchImpl = (...a) => fetch(...a), python = path.join(ROOT, 'agent', '.venv-laya', 'Scripts', 'python.exe') } = {}) {
  if (running) return [{ error: 'a nightly write is already running' }];
  running = true;
  const results = [];
  try {
    const days = [localDate(new Date(now.getTime() - 86400000)), localDate(now)];
    for (const layer of layers) {
      if (!LABELLERS[layer]) { results.push({ layer, error: 'no outcome labels for this layer yet' }); continue; }
      const lab = await run(process.execPath, [LABELLERS[layer], '--days', days.join(',')], { spawnImpl });
      if (lab.code !== 0) { results.push({ layer, error: `labelling failed: ${lab.out.slice(-300)}` }); continue; }
      const env = { ...process.env, TRANSFORMERS_VERBOSITY: 'error', HF_HUB_DISABLE_PROGRESS_BARS: '1', PYTHONUNBUFFERED: '1' };
      const w = await run(python, [path.join(ROOT, 'agent', 'src', 'cortex', 'nightly_write.py'), '--layer', layer], { spawnImpl, env });
      const line = w.out.split('\n').find((l) => l.startsWith('[write] RESULT ')) || w.out.split('\n').reverse().find((l) => l.startsWith('{'));
      let res = null;
      try { res = JSON.parse(line.replace('[write] RESULT ', '')); } catch (_) { /* below */ }
      if (!res) { results.push({ layer, error: `write failed: ${w.out.slice(-300)}` }); continue; }
      if (res.passed) {
        try {
          await fetchImpl(`${endpoint}/reload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layers: [layer] }), signal: AbortSignal.timeout(60000) });
          res.applied = true;
        } catch (err) { res.applied = false; res.reloadError = err.message; }
      }
      results.push(res);
    }
  } finally {
    running = false;
  }
  return results;
}

module.exports = { runNightlyWrite, localDate };
