// The brain map: which mind runs each brain region. Defaults live here; the
// file agent/brain-map.json overrides them; a few .env settings fill gaps
// (LLM_MODEL -> cortex model, DREAM_MODEL -> hippocampus model, LOCAL_MODEL
// and OLLAMA_HOST -> the local model). See docs/design-brain-regions.md.
//
// Region providers:
//   "claude" — the Claude CLI only
//   "local"  — the local model only (Ollama on this PC)
//   "auto"   — Claude first; the region's fallback when Claude is resting
const fs = require('fs');
const path = require('path');
const { claudeProvider, localProvider, autoProvider } = require('./providers');

const MAP_FILE = path.resolve(__dirname, '..', '..', 'brain-map.json');

const DEFAULTS = {
  local: { model: null, host: 'http://127.0.0.1:11434' },
  cortex: { provider: 'claude', model: 'sonnet', fallback: 'rules' },
  hippocampus: { provider: 'auto', model: 'opus', fallback: 'local', minNewExperiences: 10 },
  social: { provider: 'auto', model: 'haiku', fallback: 'local' },
  // Always-on regions: their own loops, in parallel, on the free local model.
  amygdala: { provider: 'local', everyMs: 3000 },
  innerVoice: { provider: 'local', everyMs: 4000 },
  rumination: { provider: 'local', everyMs: 120000 },
  // Phase 2 (docs/design-born-knowing.md): what it is born with, and a world
  // that grows as it thrives. Off unless brain-map.json turns them on.
  nature: { bornKnowing: false, reflexes: false, growth: false, startBorder: 128 },
};

function readMapFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[brain] could not read ${file}: ${err.message} (using defaults)`);
    return {};
  }
}

/** Resolve the map: defaults <- brain-map.json <- env gaps. */
function loadBrainMap({ env = process.env, file = MAP_FILE } = {}) {
  const fromFile = readMapFile(file);
  const map = {};
  for (const region of Object.keys(DEFAULTS)) {
    map[region] = { ...DEFAULTS[region], ...(fromFile[region] || {}) };
  }
  // .env settings only fill what the file left unsaid.
  const fileSays = (region, key) => fromFile[region] && fromFile[region][key] != null; // null = "not set"
  if (env.LLM_MODEL && !fileSays('cortex', 'model')) map.cortex.model = env.LLM_MODEL.trim();
  if (env.DREAM_MODEL && !fileSays('hippocampus', 'model')) map.hippocampus.model = env.DREAM_MODEL.trim();
  if (env.LOCAL_MODEL && !fileSays('local', 'model')) map.local.model = env.LOCAL_MODEL.trim();
  if (env.OLLAMA_HOST && !fileSays('local', 'host')) {
    const h = env.OLLAMA_HOST.trim();
    map.local.host = /^https?:\/\//.test(h) ? h : `http://${h}`;
  }
  return map;
}

/**
 * Build a provider for one region, or null when that region has no usable
 * mind (e.g. "local" with no local model configured). opts.claudeAsk /
 * opts.fetchImpl let the sim stub both minds.
 */
function regionProvider(map, region, { timeoutMs, claudeAsk, fetchImpl } = {}) {
  const spec = map[region];
  if (!spec) return null;
  const local = map.local && map.local.model
    ? localProvider({ model: map.local.model, host: map.local.host, timeoutMs: Math.max(timeoutMs || 0, 180000), fetchImpl })
    : null;
  const claude = spec.model ? claudeProvider({ model: spec.model, timeoutMs, ask: claudeAsk }) : null;
  switch (spec.provider) {
    case 'local':
      return local;
    case 'claude':
      return claude;
    case 'auto':
    default:
      if (!claude) return local;
      return autoProvider({ primary: claude, fallback: spec.fallback === 'local' ? local : null });
  }
}

/** One line per region for the startup banner. */
function describe(map) {
  const local = map.local.model ? `local:${map.local.model}` : 'local:(none set)';
  const line = (name, s) => {
    if (s.provider === 'local') return `${name}=${local}`;
    if (s.provider === 'claude') return `${name}=claude:${s.model}${s.fallback === 'rules' ? ' (else rules)' : ''}`;
    return `${name}=claude:${s.model} (else ${s.fallback === 'local' ? local : s.fallback || 'nothing'})`;
  };
  const always = map.local.model ? ` | always on (${local}): amygdala, inner voice, rumination` : '';
  return [line('cortex', map.cortex), line('hippocampus', map.hippocampus), line('social', map.social)].join(' | ') + always;
}

module.exports = { loadBrainMap, regionProvider, describe, DEFAULTS, MAP_FILE };
