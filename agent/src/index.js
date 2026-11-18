// Entry point: connect to a real Minecraft Java Edition server and start thinking.
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const config = require('./config');
const Drives = require('./drives/drives');
const { tick, getFoundingGoal } = require('./loop');
const { createLlmDecide } = require('./decision/llmDecide');
const { createClaudeCodeDecide } = require('./decision/claudeCodeDecide');
const { createDreamer } = require('./reflection/dream');
const { createChatChannel } = require('./perception/chatChannel');
const { attachObserver } = require('./observation/liveObserver');
const { attachWorldBorder } = require('./perception/worldBorder');
const { createBodyJournal } = require('./reflection/bodyJournal');
const { loadBrainMap, regionProvider, describe: describeBrain } = require('./brain/brainMap');
const { textAsk, localProvider } = require('./brain/providers');
const { createBlackboard } = require('./brain/blackboard');
const { createAmygdala, createInnerVoice, createRumination } = require('./brain/regions');
const { createArbiter } = require('./brain/arbiter');
const { createLayerStack, learnedLoader } = require('./brain/layers');
const { createNarrator } = require('./brain/narrator');
const { toAction } = require('./decision/llmDecide');
const { onExperience } = require('./vault/experienceLog');
const { ensureInheritance } = require('./vault/inheritance');
const { createReflexes } = require('./decision/reflexes');
const { createRcon } = require('./brain/rcon');
const path = require('path');
const { createWorldGrowth, advancementsFile, earnedAdvancements } = require('./brain/worldGrowth');
const { createPlanRunner } = require('./brain/planRunner');

// The brain map (agent/brain-map.json): which mind runs each brain region.
const brain = loadBrainMap();
const claudeMode = config.decisionMode === 'claude-code';
// MIND=layers: the behaviour stack decides by day; Claude only dreams.
const layersMode = config.mind === 'layers';

// The blackboard every region reads and writes, all at once (brain/blackboard.js).
// It also writes logs/brain-live.json every second for the brain view.
const blackboard = createBlackboard({ logDir: config.decisionLogDir });

// Phase 2: born knowing the basics (Inheritance/ notes), survival reflexes,
// and a world border that grows as it thrives (docs/design-born-knowing.md).
const nature = brain.nature || {};
if (nature.bornKnowing) {
  const added = ensureInheritance(config.vaultPath);
  if (added.length) console.log(`[mind] Born knowing: wrote ${added.join(', ')} into Inheritance/.`);
}
const reflexes = nature.reflexes ? createReflexes() : null;
const growth = nature.growth && config.rcon.password
  ? createWorldGrowth({
    vaultPath: config.vaultPath,
    rcon: createRcon({ port: config.rcon.port, password: config.rcon.password }),
    startSize: nature.startBorder || 128,
    // The world grows for real advancements (the server's own record of them),
    // not for surviving nights. SERVER_DIR overrides the repo's server/ folder.
    readEarned: () => {
      const serverDir = (process.env.SERVER_DIR || '').trim() || path.resolve(__dirname, '..', '..', 'server');
      const file = advancementsFile(serverDir, config.username);
      return file ? earnedAdvancements(file) : null;
    },
  })
  : null;
if (nature.growth && !growth) console.log('[mind] World growth is on but RCON_PASSWORD is not set in agent/.env: the border will not grow.');
blackboard.start();
onExperience((title) => blackboard.fire('temporal', `remembered: ${title}`));

// Claude decision layers: 'llm' calls the API each tick; 'claude-code' shells
// out to the Claude Code CLI (account login, no API key) with a throttle.
const llmDecideFn = layersMode
  ? undefined
  : config.decisionMode === 'llm'
    ? createLlmDecide({ apiKey: config.anthropicKey, model: config.llmModel, vaultPath: config.vaultPath })
    : claudeMode
      ? createClaudeCodeDecide({
        model: brain.cortex.model,
        vaultPath: config.vaultPath,
        minIntervalMs: config.llmMinIntervalMs,
        // Claude's chosen course of action stands until it is asked again (only
        // real danger breaks it), so a plan like "hit the pig until it falls"
        // isn't stomped by instinct's wandering seconds later.
        holdMs: config.llmMinIntervalMs,
        logDir: config.decisionLogDir,
        onThink: (stage, info) => {
          if (stage === 'asking') {
            blackboard.fire('thalamus', 'passed the latest signals from the rest of the mind up to the cortex');
            blackboard.fire('frontal', `deliberating (${info.model})…`);
            blackboard.fire('callosum', `cortex → claude:${info.model}`);
          }
        },
      })
      : undefined;

// The arbiter: each tick the body acts on brainstem emergencies first, then
// Claude's plan, then the inner voice's fresh urge, then plain instinct.
// Plans (docs/design-plans-and-skills.md): dreamed goals come with a program
// of the body's own primitives and a test; the runner carries one across ticks.
const planRunner = (claudeMode || layersMode) && nature.plans !== false
  ? createPlanRunner({ vaultPath: config.vaultPath, logDir: config.decisionLogDir, blackboard })
  : null;
// MIND=layers with Claude available: Claude narrates (the stream of thought)
// but never decides (brain/narrator.js).
const narrator = layersMode && claudeMode
  ? createNarrator({ provider: regionProvider(brain, 'cortex', { timeoutMs: 60000 }), blackboard, logDir: config.decisionLogDir })
  : null;
// Stage 6: Make, Shelter and Gather as language models (4B/3B/2B), each
// reading its own top memories (embedding retrieval) and scoring its menu.
const modelLayers = layersMode && config.upperLayers !== 'off' ? (() => {
  const { createModelLayers } = require('./brain/modelLayers');
  const { createMemory, ollamaEmbedder } = require('./vault/memory');
  const model = (process.env.EMBED_MODEL || '').trim();
  const memory = createMemory({
    vaultPath: config.vaultPath,
    embed: model ? ollamaEmbedder({ model }) : null,
    cacheFile: model ? path.resolve(__dirname, '..', '..', 'logs', 'memory-embeddings.json') : null,
  });
  try { memory.refresh(); } catch (_) { /* empty vault */ }
  setInterval(() => { try { memory.refresh(); } catch (_) { /* next time */ } }, 5 * 60 * 1000).unref();
  return createModelLayers({ endpoint: `http://127.0.0.1:${config.cortexPort}`, memory, mode: config.upperLayers });
})() : null;
const layerStack = layersMode ? createLayerStack({
  planRunner, blackboard,
  learned: learnedLoader(path.resolve(__dirname, '..', '..', 'logs', 'layers')),
  learnedMode: config.learnedLayers,
  modelLayers,
}) : null;
const decideFn = layersMode
  ? (narrator ? narrator.narrated(layerStack) : layerStack)
  : claudeMode && llmDecideFn
    ? createArbiter({ decide: llmDecideFn, blackboard, toAction, planRunner })
    : llmDecideFn;
if (layersMode) console.log(`[mind] MIND=layers: the behaviour stack decides (survive > make > shelter > gather > forage > wander); Claude ${narrator ? 'narrates and dreams, but never decides' : 'only dreams'}. Learned layers: ${config.learnedLayers}. Model layers (Make/Shelter/Gather): ${config.upperLayers}.`);

// Always-on regions on the local model, each its own loop (brain/regions.js).
const localMind = brain.local && brain.local.model
  ? localProvider({ model: brain.local.model, host: brain.local.host, timeoutMs: 60000 })
  : null;
const alwaysOn = claudeMode && !layersMode && localMind ? [
  createAmygdala({ provider: localMind, blackboard, vaultPath: config.vaultPath, everyMs: brain.amygdala.everyMs }),
  createInnerVoice({ provider: localMind, blackboard, vaultPath: config.vaultPath, everyMs: brain.innerVoice.everyMs }),
  createRumination({ provider: localMind, blackboard, vaultPath: config.vaultPath, everyMs: brain.rumination.everyMs }),
] : [];

// Dreaming (hippocampus): a background reflection pass over the vault,
// triggered by surviving a night (and optionally DREAM_INTERVAL_MS) once
// enough new experiences have piled up. Runs on whichever mind the brain map
// says — Claude when awake, the local model when Claude is resting.
const dreamProvider = claudeMode ? regionProvider(brain, 'hippocampus', { timeoutMs: 90000 }) : null;
// Stage 5 (MIND=layers): every sleep, Opus reviews each learned layer's day,
// then the layers are retrained and gated (learn/nightly.js). The time of the
// last review survives restarts (logs/layers/last-review.json).
const nightly = layersMode && dreamProvider && config.learnedLayers !== 'off' ? (() => {
  const { nightlyLearning } = require('./learn/nightly');
  const trainer = require('./tools/trainLayers');
  const { readTicks } = require('./tools/days');
  const fs = require('fs');
  const lastFile = path.join(trainer.DIR, 'last-review.json');
  // Stage 5b: route B (Opus's corrections + retraining) and route A (Opus
  // edits the weights directly) alternate, night by night.
  const { ollamaEmbedder } = require('./vault/memory');
  const embed = (process.env.EMBED_MODEL || '').trim() ? ollamaEmbedder({ model: process.env.EMBED_MODEL.trim() }) : null;
  const gate = (layer, model, result) => {
    const { held } = trainer.splitExamples(layer, readTicks().filter((t) => t.action && t.action.layer));
    if (held.length < trainer.MIN_HELD) { result.reason = `not enough held-out examples to test on (${held.length})`; return result; }
    return trainer.gateModel(layer, held, model, result);
  };
  return async () => {
    let last = {};
    try { last = JSON.parse(fs.readFileSync(lastFile, 'utf8')); } catch (_) { /* first night */ }
    const since = last.ts ? new Date(last.ts) : null;
    const nights = Number(last.nights) || 0;
    const route = nights % 2 === 1 ? 'edit' : 'train';
    const now = new Date();
    const summary = await nightlyLearning({
      ticks: readTicks().filter((t) => t.action && t.action.layer), since, provider: dreamProvider, dir: trainer.DIR,
      vaultPath: config.vaultPath, fitLayer: trainer.fitLayer, save: trainer.save, gate, route, embed,
      learned: layerStack ? learnedLoader(trainer.DIR) : () => ({}), now,
    });
    fs.mkdirSync(trainer.DIR, { recursive: true });
    if (summary.reviewed || !since) fs.writeFileSync(lastFile, JSON.stringify({ ts: now.toISOString(), nights: summary.reviewed ? nights + 1 : nights }));
    return summary;
  };
})() : null;
const dreamer = dreamProvider
  ? createDreamer({
    vaultPath: config.vaultPath,
    provider: dreamProvider,
    intervalMs: config.dreamIntervalMs,
    minNewExperiences: brain.hippocampus.minNewExperiences || 0,
    logDir: config.decisionLogDir,
    nightly,
    onSleep: (s) => {
      if (s.replayed != null) {
        blackboard.fire('hippocampus', `slept: replayed ${s.replayed} links, ${s.links} kept, ${s.pruned} faded`);
        console.log(`[sleep] replayed ${s.replayed} links, kept ${s.links}, ${s.pruned} faded${s.prunedLinks.length ? ` (e.g. ${s.prunedLinks.slice(0, 3).join('; ')})` : ''}`);
      }
      if (s.memory) console.log(`[sleep] memory: ${s.memory.live} live Experiences, ${s.memory.archived} folded into gists and archived${s.memory.gists.length ? ` (${s.memory.gists.slice(0, 4).join('; ')})` : ''}`);
      if (s.learning) {
        const L = s.learning;
        console.log(`[sleep] learning (route ${L.route === 'edit' ? 'A: Opus edits weights' : 'B: retraining'}): ${L.error ? `failed (${L.error})` : `${L.reviewed ? `Opus reviewed ${L.reviewedTicks} ticks (${Object.entries(L.corrections || {}).map(([k, v]) => `${k} ${v} corrections`).join(', ')})` : 'no review'}; ${(L.results || []).map((r) => `${r.layer} ${r.passed ? `v${r.version} SERVED` : 'not served'}`).join(', ')}`}`);
        blackboard.fire('hippocampus', `learned: ${(L.results || []).map((r) => `${r.layer} ${r.passed ? 'served' : 'kept hand-written'}`).join(', ')}`);
      }
    },
    onDream: ({ by, written }) => blackboard.fire('hippocampus',
      `dreamed (${by}): ${written.map((w) => w.title).join('; ') || 'nothing new'}`),
  })
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
// Feel the world border (the server sends it on join): the brainstem keeps
// the body inside it.
attachWorldBorder(bot);

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
// claude-code mode it uses the brain map's social region for both (rare,
// background, non-blocking); otherwise it runs on pure heuristics. Attach
// here so its blockUpdate listener is live from connection.
const socialProvider = claudeMode ? regionProvider(brain, 'social', { timeoutMs: 60000 }) : null;
const watchAsk = socialProvider ? textAsk(socialProvider, { json: true }) : undefined;
const observer = attachObserver(bot, {
  vaultPath: config.vaultPath,
  moiAsk: watchAsk,
  tomAsk: watchAsk,
});

// The body's journal: every tick to logs/ticks-*.jsonl, deaths and graded
// nights to the vault as Experiences (reflection/bodyJournal.js).
const journal = createBodyJournal({
  vaultPath: config.vaultPath,
  logDir: config.decisionLogDir,
  onNight: growth ? (report, now) => growth.onNight(report, now) : null,
});
bot.on('death', () => {
  console.log('[mind] Died.');
  journal.noteDeath(new Date());
  if (planRunner) planRunner.noteDeath();
});

bot.once('spawn', () => {
  console.log('[mind] Spawned. Vault:', config.vaultPath);
  const goal = getFoundingGoal(config.vaultPath);
  if (goal) console.log(`[mind] Founding goal: ${goal}`);
  console.log(`[mind] Decision mode: ${config.decisionMode}`);
  if (claudeMode) {
    console.log(`[mind] Brain map: ${describeBrain(brain)}`);
    if (!brain.local.model) console.log('[mind] No local model set (LOCAL_MODEL / brain-map.json): when Claude rests, dreaming waits.');
    console.log(`[mind] Nature: born knowing ${nature.bornKnowing ? 'on' : 'off'} · reflexes ${reflexes ? 'on' : 'off'} · world growth ${growth ? `on (${growth.state().size} blocks, grows on new advancements)` : 'off'} · plans ${planRunner ? 'on' : 'off'}`);
    console.log(`[mind] Decision log: ${config.decisionLogDir || 'off'}`);
  }

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
  // The always-on regions start with the body; they rest whenever it isn't ticking.
  for (const region of alwaysOn) region.start();
  if (alwaysOn.length) console.log(`[mind] Always-on regions firing on ${brain.local.model}: ${alwaysOn.map((r) => r.name).join(', ')}`);

  setInterval(async () => {
    if (thinking) return; // don't overlap slow ticks
    thinking = true;
    try {
      const summary = await tick(bot, drives, config.vaultPath, { decide: decideFn, dreamer, chat, observer, journal, blackboard, reflexes, planRunner, bornKnowing: !!nature.bornKnowing });
      const d = summary.drives;
      const act = summary.action;
      const res = act.result && act.result.ok === false ? ` (couldn't: ${act.result.reason})` : '';
      console.log(
        `[tick] ${act.layer ? `${act.layer}: ` : ''}${act.type}${act.at ? ` ${act.at}` : ''}${act.item ? ` ${act.item}` : ''}${res} | hunger ${Math.round(d.hunger)} fear ${Math.round(d.fear)} ` +
        `curiosity ${Math.round(d.curiosity)} | ${summary.results.length} encounters` +
        (summary.newConceptCount ? ` (${summary.newConceptCount} new)` : '') +
        (summary.action.plan ? ` | plan "${summary.action.plan}" step ${summary.action.planStep + 1}` : '') +
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
