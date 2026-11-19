// The nightly weight write for the model layers (docs/design-subsumption.md):
// at dawn, after the classifiers' nightly learning, the day's moments become
// outcome labels (learn/gatherLabels.js, quick, here), then the lesson is
// written into the layer's weights and gated on the latest day
// (cortex/nightly_write.py). The write runs as its OWN detached process: it
// takes ~10 minutes, and an agent restart (a disconnect, a death) used to kill it
// midway (2026-11-18, twice). If its edit passes, it applies it itself
// (POST /reload on the model service). Its log: logs/layers/write/nightly-<layer>-<date>.log;
// every version's report: logs/layers/patches/<layer>-v<N>.json.
//
// On with NIGHTLY_WRITE=gather in agent/.env (off by default). Only Gather has
// outcome labels so far.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LABELLERS = { gather: path.join(__dirname, 'gatherLabels.js') };
const WRITE_LOGS = path.join(ROOT, 'logs', 'layers', 'write');

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

/** The newest version's report for a layer (what the last write decided), or null. */
function lastResult(layer, dir = path.join(ROOT, 'logs', 'layers', 'patches')) {
  try {
    const files = fs.readdirSync(dir).filter((f) => new RegExp(`^${layer}-v\\d+\\.json$`).test(f));
    const v = Math.max(...files.map((f) => Number(f.match(/-v(\d+)\./)[1])));
    if (!Number.isFinite(v)) return null;
    return JSON.parse(fs.readFileSync(path.join(dir, `${layer}-v${v}.json`), 'utf8'));
  } catch (_) { return null; }
}

/**
 * runNightlyWrite({ layers, now, endpoint, spawnImpl, python }) -> Promise<[{ layer, started, log, pid } | { layer, error }]>
 * Labels in-process (seconds), then starts each layer's write detached and returns.
 */
async function runNightlyWrite({ layers = ['gather'], now = new Date(), endpoint = 'http://127.0.0.1:3010', spawnImpl = spawn, python = path.join(ROOT, 'agent', '.venv-laya', 'Scripts', 'python.exe') } = {}) {
  const results = [];
  const days = [localDate(new Date(now.getTime() - 86400000)), localDate(now)];
  for (const layer of layers) {
    if (!LABELLERS[layer]) { results.push({ layer, error: 'no outcome labels for this layer yet' }); continue; }
    const lab = await run(process.execPath, [LABELLERS[layer], '--days', days.join(',')], { spawnImpl });
    if (lab.code !== 0) { results.push({ layer, error: `labelling failed: ${lab.out.slice(-300)}` }); continue; }
    const log = path.join(WRITE_LOGS, `nightly-${layer}-${localDate(now)}.log`);
    let fd = 'ignore';
    try { fs.mkdirSync(WRITE_LOGS, { recursive: true }); fd = fs.openSync(log, 'a'); } catch (_) { /* no log file: still run */ }
    const env = { ...process.env, TRANSFORMERS_VERBOSITY: 'error', HF_HUB_DISABLE_PROGRESS_BARS: '1', PYTHONUNBUFFERED: '1' };
    try {
      const p = spawnImpl(python, [path.join(ROOT, 'agent', 'src', 'cortex', 'nightly_write.py'), '--layer', layer, '--reload', endpoint],
        { cwd: ROOT, env, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
      if (p && typeof p.unref === 'function') p.unref(); // survives the agent restarting
      results.push({ layer, started: true, log, pid: p && p.pid });
    } catch (err) {
      results.push({ layer, error: `could not start the write: ${err.message}` });
    }
    if (typeof fd === 'number') { try { fs.closeSync(fd); } catch (_) { /* fine */ } }
  }
  return results;
}

module.exports = { runNightlyWrite, lastResult, localDate };
