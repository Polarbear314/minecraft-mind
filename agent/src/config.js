// Loads and validates environment configuration from .env (see .env.example).
require('dotenv').config();

const fs = require('fs');
const path = require('path');

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`[config] Missing required env var ${name} — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value.trim();
}

function intOr(name, fallback) {
  const raw = process.env[name];
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  host: required('MC_HOST'),
  port: intOr('MC_PORT', 25565),
  username: (process.env.MC_USERNAME || 'MindBot').trim(),
  // Optional: undefined lets mineflayer auto-detect the server version.
  version: process.env.MC_VERSION ? process.env.MC_VERSION.trim() : undefined,
  // 'offline' (default, works on LAN worlds and online-mode=false servers) or
  // 'microsoft' (real account: MC_USERNAME = your Microsoft email; first run
  // prints a device code to sign in with — no password stored anywhere).
  auth: (process.env.MC_AUTH || 'offline').trim(),
  vaultPath: required('VAULT_PATH'),
  tickIntervalMs: intOr('TICK_INTERVAL_MS', 1500),
  // 'rules' (default), 'llm' (Anthropic API, needs ANTHROPIC_API_KEY), or
  // 'claude-code' (Claude Code CLI, uses your Claude account login — no key).
  decisionMode: (process.env.DECISION_MODE || 'rules').trim(),
  // How the mind is organised: 'regions' (default: brain regions, Claude as
  // the cortex by day) or 'layers' (a behaviour stack after Brooks, no Claude
  // by day; docs/design-subsumption.md). Dreaming works the same in both.
  mind: ((process.env.MIND || 'regions').trim().toLowerCase() === 'layers') ? 'layers' : 'regions',
  // Stage 4 learned layers (MIND=layers): 'off', 'shadow' (default: log what a
  // learned Forage/Wander would do; the hand-written ones act) or 'on' (a
  // learned layer that passed its gate acts). Models: logs/layers/.
  learnedLayers: (['off', 'shadow', 'on'].includes((process.env.LEARNED_LAYERS || '').trim().toLowerCase())
    ? (process.env.LEARNED_LAYERS || '').trim().toLowerCase() : 'shadow'),
  // Stage 6 language-model layers for Make/Shelter/Gather (MIND=layers):
  // 'off', 'shadow' (default: their picks are logged, the hand-written layers
  // act) or 'on'. Needs the model service: npm run cortex (port CORTEX_PORT).
  upperLayers: (['off', 'shadow', 'on'].includes((process.env.UPPER_LAYERS || '').trim().toLowerCase())
    ? (process.env.UPPER_LAYERS || '').trim().toLowerCase() : 'shadow'),
  cortexPort: intOr('CORTEX_PORT', 3010),
  anthropicKey: process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_API_KEY.trim() : null,
  llmModel: (process.env.LLM_MODEL || 'claude-haiku-4-5').trim(),
  // Dreaming is rare and benefits most from deeper reasoning, so it can run on
  // a stronger model than moment-to-moment decisions (defaults to LLM_MODEL).
  dreamModel: (process.env.DREAM_MODEL || process.env.LLM_MODEL || 'claude-haiku-4-5').trim(),
  // In claude-code mode, consult Claude at most this often; rules fill the gaps.
  llmMinIntervalMs: intOr('LLM_MIN_INTERVAL_MS', 10000),
  // Dreaming (claude-code mode): also reflect every this-many ms in addition
  // to every day-break (0 = day-break only).
  dreamIntervalMs: intOr('DREAM_INTERVAL_MS', 0),
  // If set, serve the bot's first-person view in a browser at this port (0 = off).
  viewerPort: intOr('VIEWER_PORT', 0),
  // Phase 2 world growth: the server's remote console (127.0.0.1 only).
  rcon: {
    port: intOr('RCON_PORT', 25575),
    password: (process.env.RCON_PASSWORD || '').trim() || null,
  },
  // claude-code mode: save every consultation (what it saw, the prompt, what
  // Claude decided, what instinct would have done) as JSON lines here, for
  // later distillation. Defaults to the repo's logs/ folder; set to 'off' to disable.
  decisionLogDir: (() => {
    const v = (process.env.DECISION_LOG_DIR || '').trim();
    if (v.toLowerCase() === 'off') return null;
    return v || path.resolve(__dirname, '..', '..', 'logs');
  })(),
};

if (config.decisionMode === 'llm' && !config.anthropicKey) {
  console.error('[config] DECISION_MODE=llm requires ANTHROPIC_API_KEY (get one at console.anthropic.com).');
  process.exit(1);
}

if (!fs.existsSync(config.vaultPath)) {
  console.error(`[config] VAULT_PATH does not exist: ${config.vaultPath}`);
  process.exit(1);
}

module.exports = config;
