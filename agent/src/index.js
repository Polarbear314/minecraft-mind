// Entry point: connect to a real Minecraft Java Edition server and start thinking.
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const config = require('./config');
const Drives = require('./drives/drives');
const { tick, getFoundingGoal } = require('./loop');
const { createLlmDecide } = require('./decision/llmDecide');
const { createClaudeCodeDecide, askClaudeCli } = require('./decision/claudeCodeDecide');
const { createDreamer } = require('./reflection/dream');
const { createChatChannel } = require('./perception/chatChannel');
const { attachObserver } = require('./observation/liveObserver');

// Claude decision layers: 'llm' calls the API each tick; 'claude-code' shells
// out to the Claude Code CLI (account login, no API key) with a throttle.
const llmDecideFn =
  config.decisionMode === 'llm'
    ? createLlmDecide({ apiKey: config.anthropicKey, model: config.llmModel, vaultPath: config.vaultPath })
    : config.decisionMode === 'claude-code'
      ? createClaudeCodeDecide({ model: config.llmModel, vaultPath: config.vaultPath, minIntervalMs: config.llmMinIntervalMs })
      : undefined;

// Dreaming: a background reflection pass over the vault, triggered by
// surviving a night (and optionally DREAM_INTERVAL_MS). Needs the Claude CLI,
// so it comes with claude-code mode.
const dreamer =
  config.decisionMode === 'claude-code'
    ? createDreamer({ vaultPath: config.vaultPath, model: config.llmModel, intervalMs: config.dreamIntervalMs })
    : undefined;

console.log(`[mind] Connecting to ${config.host}:${config.port} as ${config.username}...`);

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.username,
  version: config.version, // undefined = auto-detect
  auth: config.auth, // 'offline' or 'microsoft' (device-code sign-in)
});

bot.loadPlugin(pathfinder);

// The ears: in-game chat (and whispers) flow into the mind as perception.
// Henry's words are guidance the agent weighs, never commands it obeys.
const chat = createChatChannel({ selfName: config.username });
bot.on('chat', (username, message) => {
  if (username === bot.username) return; // its own voice is not news
  chat.hear(username, message);
  console.log(`[chat] ${username}: ${message}`);
});
bot.on('whisper', (username, message) => {
  if (username === bot.username) return;
  chat.hear(username, message);
  console.log(`[whisper] ${username}: ${message}`);
});

// Learning by watching: the observer sits beside the loop, turning other
// beings' actions into beliefs (theory of mind) and goals to learn for itself
// — every one serving [[Live A Good Life]]. It decides what's worth watching
// with OMNI-style interestingness and reads intent MindForge-style. In
// claude-code mode it uses Claude for both (rare, background, non-blocking);
// otherwise it runs on pure heuristics. Attach here so its blockUpdate
// listener is live from connection.
const watchAsk =
  config.decisionMode === 'claude-code'
    ? (prompt) => askClaudeCli(prompt, config.llmModel, 60000)
    : undefined;
const observer = attachObserver(bot, {
  vaultPath: config.vaultPath,
  moiAsk: watchAsk,
  tomAsk: watchAsk,
});

bot.once('spawn', () => {
  console.log('[mind] Spawned. Vault:', config.vaultPath);
  const goal = getFoundingGoal(config.vaultPath);
  if (goal) console.log(`[mind] Founding goal: ${goal}`);
  console.log(`[mind] Decision mode: ${config.decisionMode}${llmDecideFn ? ` (${config.llmModel})` : ''}`);

  // Optional first-person view in the browser (VIEWER_PORT in .env).
  if (config.viewerPort) {
    try {
      // Import the web viewer submodule directly: the package's main entry
      // also loads the headless renderer, which demands the native 'canvas'
      // module we don't need.
      let viewer;
      try {
        viewer = require('prismarine-viewer/lib/mineflayer');
      } catch (_) {
        ({ mineflayer: viewer } = require('prismarine-viewer'));
      }
      viewer(bot, { port: config.viewerPort, firstPerson: true });
      console.log(`[mind] Bot's-eye view: http://localhost:${config.viewerPort}`);
    } catch (err) {
      console.error('[mind] Viewer failed to start (npm install first?):', err.message);
    }
  }
  bot.pathfinder.setMovements(new Movements(bot));

  const drives = new Drives();
  let thinking = false;

  setInterval(async () => {
    if (thinking) return; // don't overlap slow ticks
    thinking = true;
    try {
      const summary = await tick(bot, drives, config.vaultPath, { decide: llmDecideFn, dreamer, chat, observer });
      const d = summary.drives;
      console.log(
        `[tick] ${summary.action.type} | hunger ${Math.round(d.hunger)} fear ${Math.round(d.fear)} ` +
        `curiosity ${Math.round(d.curiosity)} | ${summary.results.length} encounters` +
        (summary.newConceptCount ? ` (${summary.newConceptCount} new)` : '') +
        (summary.action.thought ? ` | "${summary.action.thought}"` : '') +
        (summary.action.say ? ` | says: "${summary.action.say}"` : '')
      );
    } catch (err) {
      // One bad tick must never kill the process.
      console.error('[tick error]', err.message);
    } finally {
      thinking = false;
    }
  }, config.tickIntervalMs);
});

bot.on('kicked', (reason) => console.error('[mind] Kicked:', reason));
bot.on('error', (err) => console.error('[mind] Error:', err.message));
bot.on('end', () => {
  console.error('[mind] Disconnected.');
  process.exit(1);
});
