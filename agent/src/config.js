// Loads and validates environment configuration from .env (see .env.example).
require('dotenv').config();

const fs = require('fs');

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
  anthropicKey: process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_API_KEY.trim() : null,
  llmModel: (process.env.LLM_MODEL || 'claude-haiku-4-5').trim(),
  // In claude-code mode, consult Claude at most this often; rules fill the gaps.
  llmMinIntervalMs: intOr('LLM_MIN_INTERVAL_MS', 10000),
  // Dreaming (claude-code mode): also reflect every this-many ms in addition
  // to every day-break (0 = day-break only).
  dreamIntervalMs: intOr('DREAM_INTERVAL_MS', 0),
  // If set, serve the bot's first-person view in a browser at this port (0 = off).
  viewerPort: intOr('VIEWER_PORT', 0),
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
