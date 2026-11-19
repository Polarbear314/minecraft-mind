// Mock-bot test harness: runs the entire perceive -> record -> decide -> act ->
// persist pipeline against a fabricated bot and a temporary copy of the vault,
// so everything can be verified without a Minecraft server. Run: npm run sim
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { Vec3 } = require('vec3');
const Drives = require('./drives/drives');
const { tick } = require('./loop');
const { decide: ruleDecide } = require('./decision/decide');

// ---------------------------------------------------------------- mock bot

function makeMockBot() {
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: {},
    health: 20,
    food: 20,
    time: { isDay: false },
    heldItem: null,
    _inventory: [{ name: 'apple', count: 3 }],
    _said: [], // everything the bot speaks aloud via chat()
    _goals: [], // every pathfinder goal set (for wander-persistence checks)
    _blocks: new Map(), // 'x,y,z' -> block name
    _biome: 'plains',

    inventory: {
      items: () => bot._inventory.filter((i) => i.count > 0),
    },
    blockAt(pos) {
      const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
      return { name: bot._blocks.get(key) || 'grass_block', biome: { name: bot._biome }, position: pos };
    },
    findBlocks() {
      return [...bot._blocks.keys()].map((k) => {
        const [x, y, z] = k.split(',').map(Number);
        return new Vec3(x, y, z);
      });
    },
    pathfinder: {
      setGoal: (g) => {
        if (g) bot._goals.push(g);
      },
      stop: () => {},
    },
    chat(message) {
      bot._said.push(message);
    },
    async equip(item) {
      bot.heldItem = item;
    },
    async consume() {
      if (bot.heldItem) {
        const stack = bot._inventory.find((i) => i.name === bot.heldItem.name);
        if (stack) stack.count -= 1;
        bot.food = Math.min(20, bot.food + 4);
        bot.heldItem = null;
      }
    },
    _gain(name) {
      const stack = bot._inventory.find((i) => i.name === name);
      if (stack) stack.count += 1;
      else bot._inventory.push({ name, count: 1 });
    },
    attack(entity) {
      // The struck creature is gone; something small drops where it stood.
      for (const [id, e] of Object.entries(bot.entities)) {
        if (e === entity) {
          delete bot.entities[id];
          bot.entities[9] = {
            name: 'item',
            position: entity.position,
            getDroppedItem: () => ({ name: 'raw_chicken' }),
          };
        }
      }
    },
    async dig(block) {
      // The block breaks; its drop lands at the agent's feet (contact collects).
      const key = `${Math.floor(block.position.x)},${Math.floor(block.position.y)},${Math.floor(block.position.z)}`;
      const name = bot._blocks.get(key);
      if (!name) return;
      bot._blocks.delete(key);
      bot._gain(name === 'stone' ? 'cobblestone' : name);
    },

    // scripting helpers
    setZombie(distance) {
      if (distance == null) {
        delete bot.entities[1];
      } else {
        bot.entities[1] = { name: 'zombie', position: new Vec3(distance, 64, 0.5) };
      }
    },
    addBlock(x, y, z, name) {
      bot._blocks.set(`${x},${y},${z}`, name);
    },
    collectDrops() {
      // Contact pickup: anything lying on the ground joins the inventory.
      for (const [id, e] of Object.entries(bot.entities)) {
        if (e.name === 'item') {
          bot._gain(e.getDroppedItem().name);
          delete bot.entities[id];
        }
      }
    },
  };
  return bot;
}

// ------------------------------------------------------------- temp vault

// Source vault: SIM_VAULT_SRC, then VAULT_PATH from .env, then ../../vault.
require('dotenv').config();
const sourceVault = process.env.SIM_VAULT_SRC || process.env.VAULT_PATH || path.resolve(__dirname, '..', '..', 'vault');
if (!fs.existsSync(sourceVault)) {
  console.error(`Cannot find source vault at ${sourceVault} (set VAULT_PATH in .env or SIM_VAULT_SRC).`);
  process.exit(1);
}
const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-mind-vault-'));
fs.cpSync(sourceVault, vaultPath, { recursive: true });
console.log(`Simulating against a temp copy of the vault:\n  ${vaultPath}\n`);

// -------------------------------------------------------------- scenario

async function main() {
  const bot = makeMockBot();
  const drives = new Drives();
  let tickNo = 0;
  let chatChannel = null; // set once the chat scenario begins

  // step(label) runs a normal rules tick with random experimentation OFF, so
  // the scenario stays deterministic; step(label, forced) forces one action,
  // standing in for a Claude decision (motor primitives are Claude/experiment
  // territory — instinct's priority ladder never picks them on its own).
  async function step(label, forced) {
    tickNo += 1;
    const opts = {
      decide: forced
        ? async () => forced
        : async (d, o) => ruleDecide(d, o, { experimentChance: 0 }),
      chat: chatChannel || undefined,
    };
    const s = await tick(bot, drives, vaultPath, opts);
    console.log(
      `tick ${String(tickNo).padStart(2)} | ${label.padEnd(34)} -> ${s.action.type.padEnd(8)} | ` +
      `hunger ${String(Math.round(s.drives.hunger)).padStart(3)}  fear ${String(Math.round(s.drives.fear)).padStart(3)}  ` +
      `curiosity ${String(Math.round(s.drives.curiosity)).padStart(3)}` +
      (s.newConceptCount ? ` | ${s.newConceptCount} new concept(s)` : '') +
      (s.tookDamage ? ' | TOOK DAMAGE' : '') +
      (s.strategy ? ` | learned: ${s.strategy.title} -> ${s.strategy.label} (rate ${s.strategy.successRate})` : '')
    );
  }

  // Night one: standing on grass, a zombie appears, then attacks.
  bot.addBlock(0, 63, 0, 'grass_block');
  bot.setZombie(4);
  await step('night, zombie spotted (first!)');

  bot.health = 14;
  bot.setZombie(2);
  await step('zombie attacks, health 20 -> 14');

  // It escapes; hunger sets in; there's an apple in the pack.
  bot.setZombie(null);
  bot.food = 6;
  bot.time.isDay = true;
  await step('escaped; starving; day breaks');

  // Exploring, it finds ore.
  bot.addBlock(2, 63, 1, 'diamond_ore');
  bot.addBlock(3, 63, 1, 'stone');
  await step('diamond ore glinting nearby');

  // Habituation: the same zombie keeps its distance for many safe encounters.
  bot._blocks.clear();
  bot.food = 18;
  bot.setZombie(12);
  for (let i = 1; i <= 12; i++) {
    await step(`zombie at safe distance (${i}/12)`);
  }

  // Danger underfoot: lava two blocks away — the agent must walk away from it
  // even though it isn't an entity (this exercises the 'avoid' action).
  bot.setZombie(null);
  bot.addBlock(2, 64, 1, 'lava');
  await step('lava glowing two blocks away');
  await step('still near the lava');

  // Walk clear of the lava: the action changes, which closes the 'avoid'
  // window so its strategy outcome gets written too.
  bot._blocks.clear();
  await step('moved clear of the lava');

  // --------------------------------------- Phase B: motor primitives
  // Forced actions stand in for Claude choosing them. The accident chain the
  // design exists for: dig frees something new -> swing fells a bird ->
  // pickup collects what it dropped -> each gain becomes a Concept with no
  // hint of what it's for, and each act is scored as a strategy.
  bot.addBlock(1, 63, 0, 'stone');
  await step('striking the stone underfoot', {
    type: 'dig',
    target: { name: 'stone', distance: 1.2, position: new Vec3(1, 63, 0) },
    thought: 'What is beneath this grey skin?',
  });
  await step('holding what came loose', { type: 'idle' });

  bot.entities[2] = { name: 'chicken', position: new Vec3(1.5, 64, 0.5) };
  await step('swinging at the small bird', {
    type: 'swingAt',
    target: { position: new Vec3(1.5, 64, 0.5) },
  });
  await step('walking to the fallen thing', {
    type: 'pickup',
    target: { name: 'raw_chicken', position: new Vec3(1.5, 64, 0.5) },
  });
  bot.collectDrops(); // contact: the ground thing joins the inventory
  await step('now carrying the fallen thing', { type: 'idle' });
  await step('setting something down', { type: 'place' });
  await step('resting after the fiddling', { type: 'idle' });

  // ------------------------------------- Phase C: intention persistence
  // A decision carrying an "intention" persists it; absent = kept.
  await step('resolving on an undertaking', {
    type: 'explore',
    intention: 'Stay near the stone and the birds, and come back to them when in need.',
    thought: 'I want to hold onto this place.',
  });
  await step('intention silently held', { type: 'idle' }); // no field -> unchanged

  // --------------------------------------- Chat: words from another mind
  // Henry walks up and speaks. His words must become: a Person concept, an
  // Experience carrying what was said, lines in the decision prompt — and the
  // bot must be able to answer aloud via the "say" field.
  const { createChatChannel } = require('./perception/chatChannel');
  chatChannel = createChatChannel({ selfName: 'MindBot' });
  bot.entities[5] = { name: 'player', type: 'player', username: 'Henry', position: new Vec3(3, 64, 0.5) };
  chatChannel.hear('Henry', 'The night is dangerous, little one. Seek light before dark.');
  await step('Henry appears and speaks', {
    type: 'idle',
    thought: 'A voice — someone is speaking to me.',
    say: 'I hear you. What is light, and where does it live?',
  });
  await step('walking toward Henry', {
    type: 'approach',
    target: { name: 'Henry', position: new Vec3(3, 64, 0.5) },
    thought: 'I will go to the one who speaks.',
  });
  await step('sitting with the words', { type: 'idle' });
  delete bot.entities[5];

  // Wander persistence: two consecutive explores must walk toward the SAME
  // point, not re-roll a fresh random target each tick (the old in-place jig).
  bot._goals.length = 0;
  await step('walking with purpose (1/2)', { type: 'explore', thought: 't' });
  await step('walking with purpose (2/2)', { type: 'explore', thought: 't' });

  // ------------------------------------------------- dreaming (stubbed CLI)

  // Verify the reflection pass end-to-end with a fake CLI reply: JSON wrapped
  // in noise (to exercise extraction), one bogus learned_from title (must be
  // filtered out), and a second identical dream (must write nothing — never
  // overwrite, never duplicate).
  console.log('\n=== Dreaming (stubbed reflection) ===');
  const { createDreamer, buildDreamPrompt } = require('./reflection/dream');
  const expTitles = fs.readdirSync(path.join(vaultPath, 'Experiences'))
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => f.slice(0, -3));
  const fakeReply = JSON.stringify({
    insights: [{
      title: 'The Dark Is When Harm Comes',
      body: 'Every hurt I remember arrived in darkness. The world itself does not change at dusk — but what moves through it does.',
      learned_from: [expTitles[0], 'Not A Real Experience'],
    }],
    subgoals: [{
      title: 'Reach Safety Before Dark',
      body: 'If harm comes with the dark, then a good life needs somewhere to be when the light goes.',
    }],
    skills: [{
      title: 'Walking Away From Glowing Ground',
      body: 'When the ground glows and shimmers with heat, I do not study it — I put distance between us.',
      learned_from: [expTitles[expTitles.length - 1]],
    }],
    // a 4th note beyond the cap must be ignored
    extra_ignored: true,
  });
  const dreamPrompt = buildDreamPrompt(vaultPath);
  if (/\d+\s*%/.test(dreamPrompt)) console.error('  FAIL: dream prompt contains percentages');
  console.log(`  dream prompt: ${dreamPrompt.length} chars, mentions ${expTitles.length} experiences`);
  const dreamer = createDreamer({
    vaultPath,
    ask: async () => `Some CLI banner noise\n${fakeReply}\ntrailing noise`,
  });
  const dream1 = await dreamer.dreamNow('sim');
  console.log(`  first dream wrote ${dream1.length} note(s): ${dream1.map((w) => `${w.kind} "${w.title}"`).join(', ')}`);
  const dream2 = await dreamer.dreamNow('sim-repeat');
  console.log(`  repeat dream wrote ${dream2.length} note(s) (must be 0 — never overwrite)`);

  // Day-break trigger: night -> day must start a background dream.
  let triggered = 0;
  const triggerDreamer = createDreamer({ vaultPath, ask: async () => { triggered += 1; return '{}'; } });
  triggerDreamer.maybe({ isDay: false });
  triggerDreamer.maybe({ isDay: true });
  await new Promise((r) => setTimeout(r, 50)); // let the background dream land
  console.log(`  day-break trigger fired ${triggered} time(s) (must be 1)`);

  // ---------------------------------------------------------- verification

  console.log('\n=== Generated vault file tree (new + updated) ===');
  const allNotes = [];
  (function walk(dir, indent) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        console.log(`${indent}${name}/`);
        walk(full, indent + '  ');
      } else {
        console.log(`${indent}${name}`);
        if (name.endsWith('.md')) allNotes.push(full);
      }
    }
  })(vaultPath, '');

  console.log('\n=== Validation ===');
  let yamlErrors = 0;
  let checked = 0;
  for (const file of allNotes) {
    const content = fs.readFileSync(file, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (!match) continue; // READMEs etc. without frontmatter are fine
    checked += 1;
    try {
      yaml.load(match[1]);
    } catch (err) {
      yamlErrors += 1;
      console.error(`  INVALID YAML: ${path.relative(vaultPath, file)} — ${err.message}`);
    }
  }
  console.log(`  ${checked} notes with frontmatter checked, ${yamlErrors} YAML errors`);

  const expectations = [
    'Concepts/Entity/Mob/Hostile Mob/Zombie.md',
    'Concepts/Object/Resource/Food/Apple.md',
    'Concepts/Object/Resource/Material/Diamond Ore.md',
    'Concepts/Object/Block/Terrain Block/Grass Block.md',
    'Concepts/Object/Block/Hazard Block/Lava.md',
    'Locations/Plains.md',
    'State/Current State.md',
    'Concepts/Abstract/Insight/The Dark Is When Harm Comes.md',
    'Concepts/Abstract/Skill/Walking Away From Glowing Ground.md',
    'Goals/Reach Safety Before Dark.md',
    // Phase B: things it came to hold, and how its fiddling was scored.
    'Concepts/Object/Resource/Material/Cobblestone.md',
    'Concepts/Object/Resource/Material/Raw Chicken.md',
    'Concepts/Entity/Mob/Passive Mob/Chicken.md',
    'Concepts/Abstract/Strategy/Digging By Day.md',
    'Concepts/Abstract/Strategy/Swinging By Day.md',
    'Concepts/Abstract/Strategy/Picking Up By Day.md',
    'State/Current Intention.md',
    // Chat: the speaker becomes a person the agent knows.
    'Concepts/Entity/Person/Henry.md',
    'Concepts/Abstract/Strategy/Approaching By Day.md',
  ];
  let missing = 0;
  for (const rel of expectations) {
    const ok = fs.existsSync(path.join(vaultPath, rel));
    console.log(`  ${ok ? 'OK  ' : 'MISS'} ${rel}`);
    if (!ok) missing += 1;
  }

  const experiences = fs.readdirSync(path.join(vaultPath, 'Experiences')).filter((f) => f !== 'README.md');
  console.log(`  ${experiences.length} Experience notes logged (notable events only, not one per tick)`);

  // Action-outcome learning: the scenario must have produced at least one
  // strategy that went well and one that went badly.
  const stratDir = path.join(vaultPath, 'Concepts', 'Abstract', 'Strategy');
  const stratNotes = fs.existsSync(stratDir)
    ? fs.readdirSync(stratDir).filter((f) => f.endsWith('.md'))
    : [];
  const rates = stratNotes.map((f) => {
    const text = fs.readFileSync(path.join(stratDir, f), 'utf8');
    const m = /^success_rate: ([\d.]+)$/m.exec(text);
    const o = /^last_outcome: (\w+)$/m.exec(text);
    return { note: f, rate: m ? Number(m[1]) : NaN, lastOutcome: o ? o[1] : null };
  });
  // The vault the sim copies is the agent's LIVE brain: dozens of real
  // attempts hold most EMA rates near 0.5, so band thresholds can't be
  // asserted here. What must hold is the mechanism itself — the scenario
  // produced (and recorded) both a success and a failure.
  const succeeded = rates.filter((r) => r.lastOutcome === 'success').length;
  const failed = rates.filter((r) => r.lastOutcome === 'failure').length;
  console.log(`  ${stratNotes.length} Strategy notes learned: ${succeeded} last succeeded, ${failed} last failed`);
  for (const r of rates) console.log(`    ${r.note}: success_rate ${r.rate} (last: ${r.lastOutcome})`);
  const strategyFail = !(succeeded >= 1 && failed >= 1);
  if (strategyFail) console.error('  FAIL: expected at least one recorded success AND one recorded failure');

  // Dreaming guardrails and feedback loop.
  let dreamFail = false;
  function dreamCheck(ok, label) {
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
    if (!ok) dreamFail = true;
  }
  dreamCheck(dream1.length === 3, 'first dream wrote exactly 3 notes (the cap)');
  dreamCheck(dream2.length === 0, 'repeat dream wrote nothing (never overwrite/duplicate)');
  dreamCheck(triggered === 1, 'day-break triggered exactly one background dream');
  const insightText = fs.readFileSync(path.join(vaultPath, 'Concepts/Abstract/Insight/The Dark Is When Harm Comes.md'), 'utf8');
  dreamCheck(!insightText.includes('Not A Real Experience'), 'bogus learned_from link was filtered out');
  dreamCheck(insightText.includes('is_a: "[[Insight]]"'), 'insight has is_a: [[Insight]]');
  const subgoalText = fs.readFileSync(path.join(vaultPath, 'Goals/Reach Safety Before Dark.md'), 'utf8');
  dreamCheck(subgoalText.includes('serves: "[[Live A Good Life]]"'), 'subgoal serves the founding goal');
  const { foundingGoalTitle } = require('./vault/goalStore');
  dreamCheck(foundingGoalTitle(vaultPath) === 'Live A Good Life', 'founding goal not shadowed by the new subgoal');
  const skillText = fs.readFileSync(path.join(vaultPath, 'Concepts/Abstract/Skill/Walking Away From Glowing Ground.md'), 'utf8');
  dreamCheck(skillText.includes('learned_from:'), 'skill carries learned_from links');
  const { buildPrompt, toAction } = require('./decision/llmDecide');
  const decisionPrompt = buildPrompt(vaultPath, drives, {
    health: bot.health, food: bot.food, isDay: bot.time.isDay,
    position: bot.entity.position, nearbyEntities: [], nearbyBlocks: [],
    inventoryFood: bot._inventory, nearestHostile: null,
    chatLines: chatChannel.promptLines(),
  });
  dreamCheck(decisionPrompt.includes('Walking Away From Glowing Ground'), 'skill feeds back into the decision prompt');
  dreamCheck(decisionPrompt.includes('Reach Safety Before Dark'), 'subgoal feeds back into the decision prompt');

  // Phase B: motor primitives reachable through Claude's vocabulary, with
  // safe fallbacks when the world offers no target — and craft NOT exposed.
  const motorObs = {
    nearbyEntities: [], nearbyItems: [], inventory: [], inventoryFood: [], nearestHostile: null,
    nearbyBlocks: [{ name: 'stone', distance: 2, position: new Vec3(1, 63, 0) }],
  };
  dreamCheck(toAction({ action: 'dig', thought: 't' }, motorObs).type === 'dig', 'Claude may dig when a block is in view');
  dreamCheck(toAction({ action: 'swingAt', thought: 't' }, motorObs).type === 'explore', 'swingAt with no creature falls back to explore');
  dreamCheck(toAction({ action: 'pickup', thought: 't' }, motorObs).type === 'explore', 'pickup with nothing on the ground falls back to explore');
  dreamCheck(toAction({ action: 'place', thought: 't' }, motorObs).type === 'explore', 'place with empty hands falls back to explore');
  // Phase 1 kept craft away from Claude (deferred with Henry 2026-07-08);
  // phase 2 (born knowing how things are made) exposes it, by name.
  dreamCheck(toAction({ action: 'craft', item: 'torch', thought: 't' }, motorObs).item === 'torch',
    'craft is exposed to the cortex in phase 2, naming what to make');

  // Phase C: intention persistence across ticks and consultations.
  const { currentIntention, setIntention } = require('./vault/intentionStore');
  dreamCheck(currentIntention(vaultPath) === 'Stay near the stone and the birds, and come back to them when in need.',
    'intention persisted from the action reply and survived an intention-less tick');
  dreamCheck(decisionPrompt.includes('Your standing intention') && decisionPrompt.includes('Stay near the stone'),
    'intention feeds back into the decision prompt');
  dreamCheck(toAction({ action: 'explore', thought: 't', intention: 'try the water' }, motorObs).intention === 'try the water',
    'toAction passes a new intention through');
  dreamCheck(toAction({ action: 'explore', thought: 't' }, motorObs).intention === undefined,
    'toAction leaves the intention alone when the field is absent');
  dreamCheck(toAction({ action: 'explore', thought: 't', intention: '' }, motorObs).intention === '',
    'toAction passes an abandonment through');
  setIntention(vaultPath, '');
  dreamCheck(currentIntention(vaultPath) === null, 'abandoning clears the intention');
  dreamCheck(!buildPrompt(vaultPath, drives, motorObs).includes('Your standing intention'),
    'a cleared intention leaves the prompt');

  // Chat: hearing, remembering, and answering.
  const saidExp = experiences.find((f) => f.includes('Henry Said'));
  dreamCheck(!!saidExp, 'hearing Henry produced an Experience note carrying his words');
  const henryConcept = fs.readFileSync(path.join(vaultPath, 'Concepts/Entity/Person/Henry.md'), 'utf8');
  dreamCheck(henryConcept.includes('is_a: "[[Person]]"'), 'Henry is a Person concept');
  dreamCheck(decisionPrompt.includes('Henry said: "The night is dangerous'),
    'heard words feed into the decision prompt');
  dreamCheck(bot._said.length === 1 && bot._said[0].includes('What is light'),
    'the "say" field was spoken aloud in chat');
  dreamCheck(toAction({ action: 'explore', thought: 't', say: '  hello   there ' }, motorObs).say === 'hello there',
    'toAction passes speech through (whitespace collapsed)');
  dreamCheck(toAction({ action: 'explore', thought: 't' }, motorObs).say === undefined,
    'no say field means silence');
  const { perceive } = require('./perception/perceive');
  bot.entities[6] = { name: 'player', type: 'player', username: 'Henry', position: new Vec3(2, 64, 0.5) };
  const seen = perceive(bot).nearbyEntities.find((e) => e.isPlayer);
  delete bot.entities[6];
  dreamCheck(!!seen && seen.name === 'Henry' && !seen.hostile,
    'a nearby player is perceived by name, as a person, not hostile');

  // Approach: walking toward a being, by name or by nearness.
  const peopleObs = {
    ...motorObs,
    nearbyEntities: [
      { name: 'chicken', distance: 2, position: new Vec3(2, 64, 0), isPlayer: false },
      { name: 'Henry', distance: 5, position: new Vec3(5, 64, 0), isPlayer: true },
    ],
  };
  dreamCheck(toAction({ action: 'approach', thought: 't' }, peopleObs).target.name === 'chicken',
    'approach without a name walks to the nearest being');
  dreamCheck(toAction({ action: 'approach', thought: 't', target: 'henry' }, peopleObs).target.name === 'Henry',
    'approach with a name walks to that being');
  dreamCheck(toAction({ action: 'approach', thought: 't' }, motorObs).type === 'explore',
    'approach with no one around falls back to explore');

  // Wander persistence: the two forced explores must share one destination.
  const xz = bot._goals.filter((g) => g.x !== undefined && g.z !== undefined && g.y === undefined);
  dreamCheck(xz.length >= 2 && xz[xz.length - 1].x === xz[xz.length - 2].x && xz[xz.length - 1].z === xz[xz.length - 2].z,
    'explore commits to one destination across ticks (no in-place jig)');

  // Claude decision hold: Claude's word stands for a few ticks; instinct
  // fills the wait, reflexes break through, words are never repeated.
  const { createClaudeCodeDecide } = require('./decision/claudeCodeDecide');
  const hungry = { fear: 0, hunger: 80, curiosity: 50, dominant: () => 'hunger' };
  const calmObs = {
    nearbyEntities: [], nearbyBlocks: [], nearbyItems: [], inventory: [], inventoryFood: [],
    nearestHostile: null, isDay: true, health: 20, food: 10, position: bot.entity.position,
  };
  const ccAsk = async () => JSON.stringify({ action: 'explore', thought: 'held thought', say: 'spoken once' });
  // minIntervalMs 1e9: the first call consults (lastCall starts at 0), no later call ever does.
  const cc = createClaudeCodeDecide({ model: 'x', vaultPath, minIntervalMs: 1e9, holdMs: 60000, ask: ccAsk });
  const r1 = await cc(hungry, calmObs); // consultation starts in the background
  await new Promise((r) => setTimeout(r, 25));
  const r2 = await cc(hungry, calmObs); // the answer lands and applies
  const r3 = await cc(hungry, calmObs); // held
  const fearful = { fear: 100, hunger: 80, curiosity: 50, dominant: () => 'fear' };
  const hostileObs = {
    ...calmObs,
    nearbyEntities: [{ name: 'zombie', distance: 3, position: new Vec3(3, 64, 0), hostile: true }],
    nearestHostile: { name: 'zombie', distance: 3, position: new Vec3(3, 64, 0) },
  };
  const r4 = await cc(fearful, hostileObs); // reflex breaks through the hold
  dreamCheck(r1.type === 'seekFood', 'instinct acts while the consultation runs');
  dreamCheck(r2.type === 'explore' && r2.say === 'spoken once', "Claude's answer applies, words and all");
  dreamCheck(r3.type === 'explore' && r3.say === undefined, 'the held action persists WITHOUT repeating the words');
  dreamCheck(r4.type === 'flee', 'the flee reflex breaks through the hold');
  const cc2 = createClaudeCodeDecide({ model: 'x', vaultPath, minIntervalMs: 1e9, holdMs: 5, ask: ccAsk });
  await cc2(hungry, calmObs);
  await new Promise((r) => setTimeout(r, 25));
  await cc2(hungry, calmObs); // applies (and starts no new consultation)
  await new Promise((r) => setTimeout(r, 15));
  const r5 = await cc2(hungry, calmObs);
  dreamCheck(r5.type === 'seekFood', 'an expired hold returns control to instinct');

  // Decision log: every consultation becomes one JSON line pairing what the
  // bot saw with what Claude decided and what instinct would have done.
  const os = require('os');
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-mind-declog-'));
  const ccLog = createClaudeCodeDecide({ model: 'x', vaultPath, minIntervalMs: 1e9, holdMs: 60000, ask: ccAsk, logDir });
  await ccLog(hungry, calmObs);
  await new Promise((r) => setTimeout(r, 25));
  await ccLog(hungry, calmObs); // applies -> the line is written
  const ccFail = createClaudeCodeDecide({
    model: 'x', vaultPath, minIntervalMs: 1e9, holdMs: 60000, logDir,
    ask: async () => 'no json here',
  });
  await ccFail(hungry, calmObs);
  await new Promise((r) => setTimeout(r, 25));
  const logFiles = fs.readdirSync(logDir).filter((f) => /^decisions-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  const logLines = logFiles.length
    ? fs.readFileSync(path.join(logDir, logFiles[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : [];
  const appliedLine = logLines.find((l) => l.outcome === 'applied');
  const failedLine = logLines.find((l) => l.outcome === 'failed');
  dreamCheck(logFiles.length === 1 && logLines.length === 2, 'decision log writes one JSON line per consultation');
  dreamCheck(!!appliedLine && appliedLine.parsed.action === 'explore' && appliedLine.applied.type === 'explore' &&
    appliedLine.instinct.type === 'seekFood' && typeof appliedLine.prompt === 'string' && appliedLine.prompt.length > 0 &&
    appliedLine.drives.hunger === 80 && appliedLine.observation.health === 20,
    'logged decision pairs prompt + world + drives with Claude\'s choice and instinct\'s');
  dreamCheck(!!failedLine && failedLine.raw === 'no json here' && !!failedLine.error,
    'failed consultations are logged too (raw reply + error)');
  fs.rmSync(logDir, { recursive: true, force: true });

  // --------------------------------------------- brainstem: the world border
  // On 2026-11-15 the bot reconnected 2 blocks outside the terrarium border
  // and died of border damage. The border must be felt and respected.
  const { execute } = require('./actions/actions');
  const { clampInside, borderOf } = require('./perception/worldBorder');
  const borderBot = makeMockBot();
  borderBot.mindWorldBorder = { x: -192, z: 608, diameter: 128 }; // the terrarium: x -256..-128
  borderBot.entity.position = new Vec3(-125.9, 66, 645.1); // where it died: 2 blocks outside
  const outsideObs = perceive(borderBot);
  dreamCheck(outsideObs.borderDistance < 0, 'perception feels the border (negative distance outside it)');
  const borderReflex = ruleDecide(hungry, { ...outsideObs, nearestHostile: { name: 'zombie', distance: 2, position: new Vec3(-127, 66, 645) } });
  dreamCheck(borderReflex.type === 'returnInside', 'outside the border, returning inside beats everything (even fleeing)');
  borderBot._goals.length = 0;
  await execute(borderBot, borderReflex);
  const back = borderBot._goals[borderBot._goals.length - 1];
  dreamCheck(!!back && back.x <= -134 && back.x >= -250 && back.z <= 666 && back.z >= 550,
    'returnInside walks to a point comfortably inside the border');
  borderBot.entity.position = new Vec3(-192, 66, 608); // dead center
  dreamCheck(ruleDecide(hungry, perceive(borderBot)).type !== 'returnInside', 'well inside the border, no border reflex');
  let allInside = true;
  for (let i = 0; i < 40; i += 1) {
    borderBot.entity.position = new Vec3(-131, 66, 670); // near a corner
    borderBot._goals.length = 0;
    await execute(borderBot, { type: 'explore' });
    await execute(borderBot, { type: 'explore' }); // re-asserts the same point
    const g = borderBot._goals[0];
    if (!g || Math.abs(g.x + 192) > 58 || Math.abs(g.z - 608) > 58) allInside = false;
    await execute(borderBot, { type: 'returnInside' }); // clears the wander point for the next roll
  }
  dreamCheck(allInside, 'explore never picks a destination outside the border');
  dreamCheck(borderOf({ mindWorldBorder: { x: 0, z: 0, diameter: 59999968 } }) === null &&
    JSON.stringify(clampInside(null, 5, 7)) === '{"x":5,"z":7}', 'a vanilla 60-million-block border counts as no border');

  // ------------------------------------------ brain: providers and the map
  const claudeStatus = require('./brain/claudeStatus');
  const { claudeProvider, localProvider, autoProvider } = require('./brain/providers');
  const { loadBrainMap, regionProvider } = require('./brain/brainMap');
  claudeStatus._reset();
  const realLog = console.log;
  // the resting/awake banners are expected noise here; everything else prints
  console.log = (...a) => { if (!String(a[0]).startsWith('[brain]')) realLog(...a); };
  try {
    let claudeCalls = 0;
    const limitErr = Object.assign(new Error('Command failed: claude -p'), { stdout: 'Claude usage limit reached. Your limit will reset at 3pm.' });
    const tired = claudeProvider({ model: 'opus', ask: async () => { claudeCalls += 1; throw limitErr; } });
    let localBody = null;
    const local = localProvider({
      model: 'test-model',
      fetchImpl: async (_url, req) => {
        localBody = JSON.parse(req.body);
        return { ok: true, json: async () => ({ message: { content: '{"insights":[],"subgoals":[],"skills":[]}' } }) };
      },
    });
    const auto = autoProvider({ primary: tired, fallback: local });
    const a1 = await auto.ask('dream', { schema: { type: 'object' } });
    dreamCheck(a1.by === 'local:test-model' && claudeStatus.isResting(),
      'a usage-limit error puts Claude to rest and the local model answers');
    dreamCheck(localBody && localBody.format && localBody.format.type === 'object' && localBody.stream === false,
      'the local model is held to the JSON schema');
    await auto.ask('dream again');
    dreamCheck(claudeCalls === 1, 'while Claude rests, auto does not knock again');
    // the cortex also stays quiet while Claude rests: instinct decides
    let cortexCalls = 0;
    const restingCortex = createClaudeCodeDecide({ model: 'x', vaultPath, minIntervalMs: 0, ask: async () => { cortexCalls += 1; return '{}'; } });
    const rr = await restingCortex(hungry, calmObs);
    dreamCheck(cortexCalls === 0 && rr.type === 'seekFood', 'while Claude rests, the cortex is not consulted (instinct acts)');
    claudeStatus._reset();
    // a limit message that arrives as a normal reply still counts
    const quietLimit = claudeProvider({ model: 'opus', ask: async () => 'You have hit your usage limit · resets 6pm' });
    let threw = false;
    try { await quietLimit.ask('x'); } catch (_) { threw = true; }
    dreamCheck(threw && claudeStatus.isResting(), 'a usage-limit message returned as plain text also means rest');
    claudeStatus._reset();
    const fine = claudeProvider({ model: 'opus', ask: async () => '{"ok":1}' });
    dreamCheck((await autoProvider({ primary: fine, fallback: local }).ask('x')).by === 'claude:opus',
      'when Claude is awake, auto uses Claude');
    dreamCheck(!claudeStatus.looksLikeUsageLimit(new Error('spawn claude ETIMEDOUT')),
      'a plain timeout is not mistaken for the usage limit');

    // brain map: file overrides defaults, .env fills gaps
    const mapFile = path.join(os.tmpdir(), `brain-map-${process.pid}.json`);
    fs.writeFileSync(mapFile, JSON.stringify({ hippocampus: { provider: 'local' }, local: { model: 'file-model' } }));
    const map = loadBrainMap({ file: mapFile, env: { DREAM_MODEL: 'opus', LLM_MODEL: 'sonnet', LOCAL_MODEL: 'env-model' } });
    fs.rmSync(mapFile, { force: true });
    dreamCheck(map.hippocampus.provider === 'local' && map.local.model === 'file-model' && map.cortex.model === 'sonnet' &&
      map.hippocampus.minNewExperiences === 10, 'brain map: file overrides defaults, .env fills only the gaps');
    dreamCheck(regionProvider(map, 'hippocampus').by === 'local:file-model', 'brain map builds the region\'s mind');
  } finally {
    console.log = realLog;
    claudeStatus._reset();
  }

  // ------------------------------------- hippocampus: provenance and trigger
  const { DREAM_SCHEMA } = require('./reflection/dream');
  let sawSchema = null;
  const localDreamer = createDreamer({
    vaultPath,
    logDir: path.join(os.tmpdir(), `dreamlog-${process.pid}`),
    provider: {
      by: 'local:test-model',
      ask: async (_p, opts) => {
        sawSchema = opts && opts.schema;
        return {
          by: 'local:test-model',
          text: JSON.stringify({ insights: [{ title: 'Small Minds Dream Too', body: 'Even a quiet mind remembers.', learned_from: [expTitles[0]] }], subgoals: [], skills: [] }),
        };
      },
    },
  });
  const localDream = await localDreamer.dreamNow('sim-local');
  const paths = require('./vault/paths');
  const localNote = fs.readFileSync(paths.insightPath(vaultPath, 'Small Minds Dream Too'), 'utf8');
  dreamCheck(localDream.length === 1 && /dreamed_by: "?local:test-model"?/.test(localNote),
    'dreamed notes say which mind dreamed them');
  dreamCheck(sawSchema === DREAM_SCHEMA, 'the dreamer hands its JSON schema to the mind');
  const dreamLogDir = path.join(os.tmpdir(), `dreamlog-${process.pid}`);
  const dreamLogLine = fs.readdirSync(dreamLogDir).filter((f) => f.startsWith('dreams-'))
    .map((f) => fs.readFileSync(path.join(dreamLogDir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)))[0][0];
  dreamCheck(dreamLogLine.by === 'local:test-model' && dreamLogLine.written.length === 1 && dreamLogLine.prompt.length > 0,
    'every dream is logged with its prompt, mind, and what it wrote');
  fs.rmSync(dreamLogDir, { recursive: true, force: true });
  let gatedDreams = 0;
  const gated = createDreamer({ vaultPath, minNewExperiences: 10, ask: async () => { gatedDreams += 1; return '{}'; } });
  gated.maybe({ isDay: false });
  gated.maybe({ isDay: true });
  await new Promise((r) => setTimeout(r, 30));
  dreamCheck(gatedDreams === 0, 'no dream at day-break without enough new experiences');

  // Memory links: minds (Opus included) often cite an experience without its
  // timestamp. Those links must resolve to the real note, most recent first,
  // or skills built on them get silently thrown away.
  const { resolveExperienceLink, applyDream } = require('./reflection/dream');
  const linkTitles = ['2026-11-16T0353 - Took Damage From Unknown Cause', '2026-11-16T0359 - Took Damage From Unknown Cause', '2026-11-16T0400 - First Water Encounter'];
  dreamCheck(resolveExperienceLink('Took Damage From Unknown Cause', linkTitles) === '2026-11-16T0359 - Took Damage From Unknown Cause',
    'a link without its timestamp resolves to the most recent matching memory');
  dreamCheck(resolveExperienceLink('2026-11-16T0353 - Took Damage From Unknown Cause', linkTitles) === '2026-11-16T0353 - Took Damage From Unknown Cause',
    'an exact link stays exact');
  dreamCheck(resolveExperienceLink('2026-11-16T0999 - First Water Encounter', linkTitles) === '2026-11-16T0400 - First Water Encounter',
    'a link with a wrong timestamp still finds the memory');
  dreamCheck(resolveExperienceLink('Fleeing By Day', linkTitles) === null, 'a strategy name is not a memory');
  const lastExpTitle = expTitles[expTitles.length - 1];
  const bareTitle = lastExpTitle.replace(/^\d{4}-\d{2}-\d{2}T\d{4}\s*-\s*/, '');
  const bareSkill = applyDream(vaultPath, { skills: [{ title: 'Learned Without A Timestamp', body: 'I remember this.', learned_from: [bareTitle] }] });
  dreamCheck(bareSkill.length === 1, 'a skill citing a memory without its timestamp is kept, not thrown away');

  // ------------------------------------------- Phase 1: a body that can
  // (design-learning-from-the-readings.md). A small block world: solid dirt
  // at y <= 63, air above; the bot stands at y 64 facing -Z (yaw 0).
  console.log('\n=== Phase 1: a complete body, affordances, gaps, graded nights ===');
  const { resolve: resolveDir, normalizeDirection } = require('./actions/bodyFrame');
  const { senseAffordances } = require('./perception/affordances');
  const { recordGap } = require('./vault/gapStore');
  const { setIntention: setIntentionAt, expireStaleIntention, currentIntention: heldIntention } = require('./vault/intentionStore');
  const { strategyTitle } = require('./vault/strategyStore');
  const { createBodyJournal } = require('./reflection/bodyJournal');
  const { buildPrompt: buildCortexPrompt } = require('./decision/llmDecide');
  function makeWorldBot() {
    const wb = makeMockBot();
    const world = new Map(); // overrides: 'x,y,z' -> name ('air' to carve)
    const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
    wb.entity.yaw = 0;
    wb.entity.position = new Vec3(0.5, 64, 0.5);
    wb.blockAt = (p) => {
      const k = key(p.x, p.y, p.z);
      const name = world.has(k) ? world.get(k) : (Math.floor(p.y) <= 63 ? 'dirt' : 'air');
      return { name, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), biome: { name: 'plains' } };
    };
    wb.findBlocks = () => [...world.entries()].filter(([, n]) => n !== 'air').map(([k]) => new Vec3(...k.split(',').map(Number)));
    wb._dug = [];
    wb.dig = async (block) => {
      wb._dug.push(block.position);
      world.set(key(block.position.x, block.position.y, block.position.z), 'air');
      wb._gain(block.name);
    };
    wb._placed = [];
    wb.placeBlock = async (ref, face) => {
      const p = ref.position.plus(face);
      wb._placed.push(p);
      world.set(key(p.x, p.y, p.z), wb.heldItem ? wb.heldItem.name : 'dirt');
    };
    wb.setControlState = () => {};
    wb.activateBlock = async () => {};
    wb.sleep = async () => {};
    wb._inventory = [];
    return wb;
  }
  const wb = makeWorldBot();
  const aheadP = resolveDir(wb, 'ahead');
  const rightP = resolveDir(wb, 'right');
  dreamCheck(aheadP.z === -1 && aheadP.x === 0 && rightP.x === 1 && resolveDir(wb, 'below').y === 63 && resolveDir(wb, 'above').y === 66,
    'body frame: ahead/right/below/above are relative to where the body faces');
  dreamCheck(normalizeDirection('Over My Head') === 'above' && normalizeDirection('under') === 'below',
    'the cortex may say "over my head" or "under"');
  const openGround = senseAffordances(wb);
  dreamCheck(openGround.skyOverhead && openGround.walls === 0 && !openGround.enclosed && openGround.canDigBelow && openGround.placeable.length === 0,
    'on open ground: sky overhead, nothing around, ground diggable, nothing to place');
  // Dig a pit straight down, three blocks (the body falls as each one breaks).
  let pitOk = true;
  for (let i = 0; i < 3; i += 1) {
    const r = await execute(wb, { type: 'dig', at: 'below' });
    if (!r || !r.ok) pitOk = false;
    wb.entity.position = wb.entity.position.offset(0, -1, 0); // gravity
  }
  dreamCheck(pitOk && wb._dug.length === 3 && wb._inventory.some((i) => i.name === 'dirt'),
    'dig below breaks the block under the feet, and the dirt comes with it');
  const inPit = senseAffordances(wb);
  dreamCheck(inPit.walls === 4 && inPit.skyOverhead && !inPit.enclosed, 'in the pit: walls on four sides, but sky still overhead');
  const sealed = await execute(wb, { type: 'place', at: 'above' });
  const afterSeal = senseAffordances(wb);
  dreamCheck(sealed.ok && afterSeal.enclosed && !afterSeal.skyOverhead,
    'place above seals the pit: now enclosed, no sky — a shelter nobody scripted');
  const headHigh = await execute(wb, { type: 'dig', at: 'ahead-up' });
  dreamCheck(headHigh.ok, 'the hand can reach head height too');
  const noAir = await execute(makeWorldBot(), { type: 'dig', at: 'above' });
  dreamCheck(!noAir.ok && /air/.test(noAir.reason), 'digging at empty air fails with a reason in its own words');
  const nothingHeld = await execute(makeWorldBot(), { type: 'place', at: 'ahead' });
  dreamCheck(!nothingHeld.ok && /nothing/.test(nothingHeld.reason), 'placing with no blocks carried fails with a reason');
  const floating = makeWorldBot();
  floating._inventory = [{ name: 'dirt', count: 3 }];
  const nowhere = await execute(floating, { type: 'place', at: 'above' });
  dreamCheck(!nowhere.ok && /beside/.test(nowhere.reason), 'a block cannot be set in mid-air: there must be something beside it');

  // The cortex can say all of this; one-shot acts are not held.
  const pa = toAction({ action: 'place', at: 'over my head', item: 'dirt', thought: 't' }, motorObs);
  const da = toAction({ action: 'dig', at: 'below', thought: 't' }, motorObs);
  const ua = toAction({ action: 'use', target: 'bed', thought: 't' }, motorObs);
  dreamCheck(pa.type === 'place' && pa.at === 'above' && pa.item === 'dirt' && da.type === 'dig' && da.at === 'below' && ua.target === 'bed',
    'the cortex can aim: place above with dirt, dig below, use a bed');
  dreamCheck(toAction({ action: 'place', at: 'above', thought: 't' }, { ...motorObs, inventory: [] }).type === 'place',
    'an aimed attempt passes through even if it may fail (the failure gets registered)');
  const digAsk = async () => JSON.stringify({ action: 'dig', at: 'below', thought: 'down' });
  const ccDig = createClaudeCodeDecide({ model: 'x', vaultPath, minIntervalMs: 1e9, holdMs: 60000, ask: digAsk });
  await ccDig(hungry, calmObs);
  await new Promise((r) => setTimeout(r, 25));
  const d1 = await ccDig(hungry, calmObs);
  const d2 = await ccDig(hungry, calmObs);
  dreamCheck(d1.type === 'dig' && d1.at === 'below' && d1.source === 'claude' && d2.type !== 'dig' && d2.source === 'instinct',
    '"dig below" happens once — never held into a tunnel to bedrock');

  // Capability gaps: a failed attempt becomes a gap note and a memory.
  fs.rmSync(path.join(vaultPath, 'Gaps'), { recursive: true, force: true }); // temp copy only
  const gapBot = makeWorldBot();
  const expBefore = fs.readdirSync(path.join(vaultPath, 'Experiences')).length;
  await tick(gapBot, new Drives(), vaultPath, { decide: async () => ({ type: 'place', at: 'above' }) });
  const gapFiles = fs.existsSync(path.join(vaultPath, 'Gaps')) ? fs.readdirSync(path.join(vaultPath, 'Gaps')) : [];
  const gapExp = fs.readdirSync(path.join(vaultPath, 'Experiences')).filter((f) => f.includes('Could Not'));
  dreamCheck(gapFiles.some((f) => f.startsWith('Could Not Set Down A Block Above')) && gapExp.length >= 1 &&
    fs.readdirSync(path.join(vaultPath, 'Experiences')).length > expBefore, 'a failed attempt is registered: a Gap note and a first-time memory');
  const again = recordGap(vaultPath, { type: 'place', at: 'above' }, 'I carried nothing that could be set down as a block');
  dreamCheck(again && !again.isFirst && again.count >= 2, 'repeat failures count up instead of piling up notes');
  dreamCheck(buildCortexPrompt(vaultPath, hungry, { ...calmObs, affordances: openGround }).includes('Things you have tried that your body could not do'),
    'gaps are shown back to the cortex');
  dreamCheck(buildCortexPrompt(vaultPath, hungry, { ...calmObs, affordances: inPit }).includes('blocks on all four sides'),
    'the cortex is told what the body senses around it');

  // Intention budget: restating keeps the clock; past the budget it is let go.
  const t0 = new Date('2026-11-16T20:00:00Z');
  setIntentionAt(vaultPath, 'Dig in before dark', t0);
  setIntentionAt(vaultPath, 'Dig in before dark', new Date(t0.getTime() + 5 * 60000));
  dreamCheck(expireStaleIntention(vaultPath, new Date(t0.getTime() + 9 * 60000)) === null,
    'an intention within its budget is kept');
  const gone = expireStaleIntention(vaultPath, new Date(t0.getTime() + 11 * 60000));
  dreamCheck(!!gone && gone.text === 'Dig in before dark' && heldIntention(vaultPath) === null,
    'an intention pursued past its budget is let go (restating it did not reset the clock)');

  dreamCheck(strategyTitle('dig:below', 'night') === 'Digging Below At Night' && strategyTitle('place:ahead-up', 'day') === 'Placing Ahead Up By Day',
    'aimed acts are learned as their own strategies ("Digging Below At Night")');

  // Graded nights and deaths.
  const nightLog = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlog-'));
  const j = createBodyJournal({ vaultPath, logDir: nightLog });
  const nightObs = (enclosed) => ({
    ...calmObs, isDay: false, health: 20,
    affordances: { ...openGround, enclosed, skyOverhead: !enclosed, roof: enclosed, walls: enclosed ? 4 : 0 },
  });
  const enclosedNightsBefore = fs.readdirSync(path.join(vaultPath, 'Experiences')).filter((f) => f.includes('Came Through The Night Unhurt Enclosed')).length;
  const jt = new Date('2026-11-16T21:00:00Z');
  for (let i = 0; i < 12; i += 1) {
    j.observe({ observation: nightObs(true), action: { type: 'idle', source: 'instinct' }, tookDamage: false, now: new Date(jt.getTime() + i * 1500) });
  }
  j.observe({ observation: { ...calmObs, isDay: true }, action: { type: 'explore' }, tookDamage: false, now: new Date(jt.getTime() + 20000) });
  const nightExp = fs.readdirSync(path.join(vaultPath, 'Experiences')).filter((f) => f.includes('Came Through The Night Unhurt Enclosed'));
  const nightFiles = fs.readdirSync(nightLog).filter((f) => f.startsWith('nights-'));
  dreamCheck(nightExp.length === enclosedNightsBefore + 1 && nightFiles.length === 1, 'a night spent enclosed and unhurt is graded and remembered as such');
  for (let i = 0; i < 12; i += 1) {
    j.observe({ observation: { ...nightObs(false), health: 20 - i }, action: { type: 'flee' }, tookDamage: true, now: new Date(jt.getTime() + 60000 + i * 1500) });
  }
  j.noteDeath(new Date(jt.getTime() + 80000));
  j.observe({ observation: { ...calmObs, isDay: true }, action: { type: 'explore' }, tookDamage: false, now: new Date(jt.getTime() + 90000) });
  const afterDeath = fs.readdirSync(path.join(vaultPath, 'Experiences'));
  dreamCheck(afterDeath.some((f) => f.includes('Died At Night')) && afterDeath.some((f) => f.includes('Died In The Night In The Open')),
    'dying in the open at night is graded differently from sheltering — the conjunction the bot could not see');
  dreamCheck(fs.readdirSync(nightLog).some((f) => f.startsWith('ticks-')), 'every tick is journaled (raw material for a learned threat model)');
  fs.rmSync(nightLog, { recursive: true, force: true });

  // ----------------------------------- hunting and eating (2026-11-16 fix)
  // The bot starved carrying rotten flesh: its body's food list had six cooked
  // or farmed items, so "eat" was silently swapped for wandering; swingAt could
  // not be aimed; and instinct stomped the cortex's plans after 6 seconds.
  console.log('\n=== Hunting and eating: learned edibility, aimed swings, plans that stand ===');
  const { knownEdible, knownInedible } = require('./vault/bodyKnowledge');
  const starving = { fear: 0, hunger: 90, curiosity: 10, dominant: () => 'hunger' };
  const fleshObs = {
    ...calmObs, health: 6, food: 0,
    inventory: [{ name: 'dirt', count: 3 }, { name: 'rotten_flesh', count: 1 }], inventoryFood: [],
    affordances: { ...openGround, placeable: ['dirt'] },
  };
  const tryEat = toAction({ action: 'eat', thought: 't' }, fleshObs);
  dreamCheck(tryEat.type === 'eat' && tryEat.item === 'rotten_flesh',
    'with nothing "known" to be food, the cortex may still try to eat — and the body picks a carried thing that is not a building block');
  dreamCheck(toAction({ action: 'eat', item: 'porkchop', thought: 't' }, fleshObs).item === 'porkchop',
    'eating something not carried is attempted honestly (and will fail with a reason), not swapped for wandering');
  const tasted = ruleDecide(starving, fleshObs, { experimentChance: 0, tasteChance: 1 });
  dreamCheck(tasted.type === 'eat' && tasted.item === 'rotten_flesh', 'starving instinct sometimes puts a carried thing in its mouth');
  dreamCheck(ruleDecide(starving, { ...fleshObs, inedible: ['rotten_flesh'] }, { experimentChance: 0, tasteChance: 1 }).type === 'seekFood',
    'instinct does not retry something that would not go down');

  // Eating in the world teaches the body: what goes down becomes food.
  const eater = makeWorldBot();
  eater._inventory = [{ name: 'rotten_flesh', count: 2 }];
  eater.food = 2;
  await tick(eater, new Drives(), vaultPath, { decide: async () => ({ type: 'eat', item: 'rotten_flesh' }) });
  dreamCheck(knownEdible(vaultPath).has('rotten_flesh'), 'rotten flesh went down, so the body now knows it as food');
  let nextFood = null;
  await tick(eater, new Drives(), vaultPath, { decide: async (d, o) => { nextFood = o.inventoryFood.map((i) => i.name); return { type: 'idle' }; } });
  dreamCheck(nextFood && nextFood.includes('rotten_flesh'), 'learned food shows up as food on the next tick');
  // The temp copy carries what the live body has learned (it found on
  // 2026-11-17 that wheat won't go down): this check starts from not knowing.
  {
    const bk = path.join(vaultPath, 'State', 'What My Body Knows.md');
    if (fs.existsSync(bk)) {
      const fmB = require('./vault/frontmatter');
      const { data, body } = fmB.parse(fs.readFileSync(bk, 'utf8'));
      data.inedible = (data.inedible || []).filter((x) => x !== 'wheat');
      if (data.misses) delete data.misses.wheat;
      fs.writeFileSync(bk, fmB.stringify(data, body));
    }
  }
  const picky = makeWorldBot();
  picky._inventory = [{ name: 'wheat', count: 2 }];
  picky.food = 5;
  picky.consume = async () => { throw new Error('timed out'); };
  await tick(picky, new Drives(), vaultPath, { decide: async () => ({ type: 'eat', item: 'wheat' }) });
  dreamCheck(!knownInedible(vaultPath).has('wheat'), 'one failed bite is not proof: wheat is not yet "won\'t go down"');
  await tick(picky, new Drives(), vaultPath, { decide: async () => ({ type: 'eat', item: 'wheat' }) });
  dreamCheck(knownInedible(vaultPath).has('wheat') && !knownEdible(vaultPath).has('wheat'),
    'wheat would not go down, twice: now remembered as not food, and registered as a gap');

  // The live bugs of 2026-11-16: the eating animation lies both ways.
  const fooled = makeWorldBot();
  fooled._inventory = [{ name: 'arrow', count: 1 }];
  fooled.food = 5;
  fooled.consume = async () => {}; // "finished eating" — but the food bar never moved
  const fooledResult = await execute(fooled, { type: 'eat', item: 'arrow' });
  dreamCheck(!fooledResult.ok, 'an "eat" that never fills the food bar did not happen (no more eating arrows)');
  const ambushed = makeWorldBot();
  ambushed._inventory = [{ name: 'rotten_flesh', count: 1 }];
  ambushed.food = 3;
  ambushed.consume = async () => { ambushed.health -= 4; throw new Error('timed out'); }; // hit mid-bite
  const ambushedResult = await execute(ambushed, { type: 'eat', item: 'rotten_flesh' });
  dreamCheck(!ambushedResult.ok && !/would not go down/.test(ambushedResult.reason),
    'a bite cut short by a blow is "interrupted", not "won\'t go down"');
  await tick(ambushed, new Drives(), vaultPath, { decide: async () => ({ type: 'eat', item: 'rotten_flesh' }) });
  await tick(ambushed, new Drives(), vaultPath, { decide: async () => ({ type: 'eat', item: 'rotten_flesh' }) });
  dreamCheck(knownEdible(vaultPath).has('rotten_flesh') && !knownInedible(vaultPath).has('rotten_flesh'),
    'food that has gone down stays food: later failed bites cannot unlearn it');

  // Aimed swings: the named creature, never a zombie by accident.
  const herd = {
    ...calmObs,
    nearbyEntities: [
      { name: 'zombie', distance: 2, position: new Vec3(2, 64, 0), hostile: true },
      { name: 'pig', distance: 4, position: new Vec3(4, 64, 0) },
    ],
  };
  dreamCheck(toAction({ action: 'swingAt', target: 'pig', thought: 't' }, herd).target.name === 'pig',
    'swingAt can be aimed at a named creature (the pig, not the nearer zombie)');
  let goneThrew = false;
  try { toAction({ action: 'swingAt', target: 'pig', thought: 't' }, { ...herd, nearbyEntities: [herd.nearbyEntities[0]] }); } catch (_) { goneThrew = true; }
  dreamCheck(goneThrew, 'if the named creature is gone, the swing is dropped — not redirected at whatever is nearest');

  // Plans that stand: a held swingAt persists through hunger and low health,
  // and only a close hostile breaks it.
  const pigOnly = { ...calmObs, health: 6, nearbyEntities: [{ name: 'pig', distance: 4, position: new Vec3(4, 64, 0) }] };
  const huntAsk = async () => JSON.stringify({ action: 'swingAt', target: 'pig', thought: 'I need to eat' });
  const hunter = createClaudeCodeDecide({ model: 'x', vaultPath, minIntervalMs: 1e9, holdMs: 30000, ask: huntAsk });
  await hunter(starving, pigOnly);
  await new Promise((r) => setTimeout(r, 25));
  const h1 = await hunter(starving, pigOnly);
  const h2 = await hunter(starving, pigOnly);
  const h3 = await hunter(starving, pigOnly);
  dreamCheck(h1.type === 'swingAt' && h1.source === 'claude' && h2.type === 'swingAt' && h2.source === 'held' && h3.source === 'held',
    'a chosen hunt is held tick after tick — hurt and hungry is no reason to drop it');
  const ambush = { ...pigOnly, nearestHostile: { name: 'zombie', distance: 3, position: new Vec3(3, 64, 0) },
    nearbyEntities: [{ name: 'zombie', distance: 3, position: new Vec3(3, 64, 0), hostile: true }, ...pigOnly.nearbyEntities] };
  const h4 = await hunter({ ...starving, fear: 90, dominant: () => 'fear' }, ambush);
  dreamCheck(h4.source === 'instinct' && h4.type === 'flee', 'a close zombie still breaks the hold: survival first');

  // ------------------------------------- the parallel brain (blackboard)
  // Every region its own loop, all at once; the body reads the freshest word
  // from each. Stubbed minds here — no real model calls in the sim.
  console.log('\n=== The parallel brain: blackboard, always-on regions, arbiter ===');
  const { createBlackboard } = require('./brain/blackboard');
  const { createAmygdala, createInnerVoice, createRumination, workspaceDigest } = require('./brain/regions');
  const { createArbiter } = require('./brain/arbiter');
  const bbLog = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-'));
  const bb = createBlackboard({ logDir: bbLog });
  dreamCheck(bb.get('percept') === null, 'an empty blackboard has nothing to say');
  const stubMind = (reply) => ({ by: 'local:test', ask: async () => ({ by: 'local:test', text: JSON.stringify(reply) }) });
  const amyg = createAmygdala({ provider: stubMind({ threat: 0.9, feeling: 'terrified', why: 'zombie close, weak' }), blackboard: bb, vaultPath });
  await amyg.once();
  dreamCheck(bb.get('gut') === null, 'regions rest while the body is not running (no fresh percept)');
  bb.post('occipital', 'percept', { observation: { ...herd, health: 6, food: 2, isDay: false, inventory: [], affordances: openGround }, drives: { hunger: 80, fear: 40, curiosity: 10 }, action: { type: 'seekFood' } });
  await amyg.once();
  amyg.stop();
  const gutPost = bb.get('gut');
  dreamCheck(gutPost && gutPost.data.threat === 0.9 && gutPost.data.feeling === 'terrified', 'the amygdala posts a gut feeling');
  const voice = createInnerVoice({ provider: stubMind({ thought: 'The pig is close and my belly aches; I should go to it now.', urge: 'approach', target: 'pig', at: 'none' }), blackboard: bb, vaultPath });
  await voice.once();
  voice.stop();
  const urgePost = bb.get('urge');
  dreamCheck(bb.history('voice').length === 1 && urgePost && urgePost.data.action === 'approach' && urgePost.data.target === 'pig' && !urgePost.data.at,
    'the inner voice posts a thought and an urge (and "none" fields are dropped)');
  const idleVoice = createInnerVoice({ provider: stubMind({ thought: 'Nothing pulls at me right now, I just watch the grass.', urge: 'idle' }), blackboard: bb, vaultPath });
  const urgeTsBefore = bb.get('urge').ts;
  await new Promise((r) => setTimeout(r, 5));
  await idleVoice.once();
  idleVoice.stop();
  dreamCheck(bb.get('urge').ts === urgeTsBefore, '"idle" is not an urge');
  const slight = createInnerVoice({ provider: stubMind({ thought: 'Scratchy.', urge: 'none' }), blackboard: bb, vaultPath });
  const voicesBefore = bb.history('voice').length;
  await slight.once();
  slight.stop();
  dreamCheck(bb.history('voice').length === voicesBefore, 'a one-word "thought" is rejected (Gemma said "Scratchy." in testing)');
  const rum = createRumination({ provider: stubMind({ reflection: 'Every hurt comes in the dark; maybe the dark is the thing to answer.' }), blackboard: bb, vaultPath });
  await rum.once();
  rum.stop();
  dreamCheck(bb.get('rumination') && /dark/.test(bb.get('rumination').data.reflection), 'rumination posts what the last minutes add up to');
  const digest = workspaceDigest(bb);
  dreamCheck(digest && /gut: terrified/.test(digest) && /inner voice/.test(digest) && /turning over/.test(digest),
    'the thalamus digests the rest of the mind for the cortex');
  dreamCheck(buildCortexPrompt(vaultPath, hungry, { ...calmObs, workspace: digest }).includes('From the rest of your mind, just now'),
    'the cortex prompt carries what the thalamus passed up');

  // Arbiter: emergencies > Claude > inner voice urge > instinct.
  const claudeSays = (a) => async () => a;
  const arb = (decide) => createArbiter({ decide, blackboard: bb, toAction });
  const pigView = { ...calmObs, nearbyEntities: [{ name: 'pig', distance: 4, position: new Vec3(4, 64, 0) }] };
  const viaUrge = await arb(claudeSays({ type: 'seekFood', source: 'instinct' }))(starving, pigView);
  dreamCheck(viaUrge.type === 'approach' && viaUrge.target.name === 'pig' && viaUrge.source === 'inner voice',
    'between Claude\'s plans, the body acts on the inner voice\'s fresh urge instead of wandering');
  const viaClaude = await arb(claudeSays({ type: 'explore', source: 'claude', thought: 'go see' }))(starving, pigView);
  dreamCheck(viaClaude.source === 'claude' && bb.get('cortex') && bb.get('cortex').data.thought === 'go see', 'Claude\'s fresh plan beats the urge (and is posted)');
  const viaHeld = await arb(claudeSays({ type: 'swingAt', source: 'held' }))(starving, pigView);
  dreamCheck(viaHeld.source === 'held', 'a held Claude plan beats the urge');
  const viaReflex = await arb(claudeSays({ type: 'flee', source: 'instinct' }))(starving, pigView);
  dreamCheck(viaReflex.type === 'flee' && viaReflex.source === 'instinct', 'a brainstem emergency beats everything');
  bb.post('innerVoice', 'urge', { action: 'dig', at: 'below', thought: 'down' });
  const once1 = await arb(claudeSays({ type: 'seekFood', source: 'instinct' }))(starving, pigView);
  const a2 = arb(claudeSays({ type: 'seekFood', source: 'instinct' }));
  const first = await a2(starving, pigView);
  const second = await a2(starving, pigView);
  dreamCheck(once1.type === 'dig' && first.type === 'dig' && second.type === 'seekFood', 'a one-shot urge ("dig below") is acted on once, not every tick');

  // Drives: the gut feeling raises fear even with nothing close.
  const gutDrives = new Drives();
  gutDrives.update({ food: 20, gutThreat: 0.95 });
  const calmDrives = new Drives();
  calmDrives.update({ food: 20, gutThreat: 0.1 });
  dreamCheck(gutDrives.fear > calmDrives.fear + 10, 'a frightened gut raises fear before anything is close');

  // The live file the brain view animates.
  bb.writeLive();
  const live = JSON.parse(fs.readFileSync(path.join(bbLog, 'brain-live.json'), 'utf8'));
  dreamCheck(live.regions.amygdala.fires >= 1 && live.regions.innerVoice.perMin >= 1 && Array.isArray(live.regions.amygdala.times) &&
    live.events.some((e) => e.region === 'innerVoice'), 'every firing is counted, timed and written for the brain view');
  fs.rmSync(bbLog, { recursive: true, force: true });

  // ------------------------------------------- phase 2: born knowing
  // docs/design-born-knowing.md: inherited knowledge, survival reflexes,
  // crafting by name, and a world that grows as it thrives.
  console.log('\n=== Phase 2: born knowing, reflexes, crafting, a growing world ===');
  const { ensureInheritance, inheritanceLines } = require('./vault/inheritance');
  const { createReflexes, isOverriding } = require('./decision/reflexes');
  const { createWorldGrowth } = require('./brain/worldGrowth');
  const { createRcon } = require('./brain/rcon');
  fs.rmSync(path.join(vaultPath, 'Inheritance'), { recursive: true, force: true }); // temp copy only
  const born = ensureInheritance(vaultPath);
  const bornAgain = ensureInheritance(vaultPath);
  dreamCheck(born.length === 5 && bornAgain.length === 0 && /Food: Cows, pigs/.test(inheritanceLines(vaultPath)),
    'five inherited notes are written once (Food, Night, Danger, Making, The Village), never overwritten');
  const bornNote = fs.readFileSync(path.join(vaultPath, 'Inheritance', 'Food.md'), 'utf8');
  dreamCheck(/given_by: "?nature"?/.test(bornNote), 'inherited knowledge is marked given_by: nature, apart from what it learned');
  dreamCheck(buildCortexPrompt(vaultPath, hungry, calmObs).includes('What you were born knowing'), 'the cortex reads what it was born knowing');
  dreamCheck(buildDreamPrompt(vaultPath).includes('What you were born knowing'), 'dreams read it too (so beliefs build on it)');

  // Raw meat is food by nature.
  const meatBot = makeWorldBot();
  meatBot._inventory = [{ name: 'porkchop', count: 1 }];
  let meatFood = null;
  await tick(meatBot, new Drives(), vaultPath, { bornKnowing: true, decide: async (d, o) => { meatFood = o.inventoryFood.map((i) => i.name); return { type: 'idle' }; } });
  dreamCheck(meatFood && meatFood.includes('porkchop'), 'born knowing: a raw porkchop is food without ever tasting one');

  // Reflexes.
  const rx = createReflexes();
  const dayObs = { ...calmObs, isDay: true, timeOfDay: 6000, position: new Vec3(0.5, 64, 0.5), affordances: { ...openGround } };
  const evening = { ...dayObs, timeOfDay: 12100 };
  const creeperObs = { ...dayObs, reflexes: rx, nearbyEntities: [{ name: 'creeper', distance: 4, position: new Vec3(4, 64, 0), hostile: true }],
    nearestHostile: { name: 'creeper', distance: 4, position: new Vec3(4, 64, 0) } };
  const calmD = { fear: 0, hunger: 0, curiosity: 60, dominant: () => 'curiosity' };
  const cr = ruleDecide(calmD, creeperObs, { experimentChance: 0 });
  dreamCheck(cr.type === 'flee' && cr.reflex === 'creeper', 'a creeper within 6 blocks: move away, even with no fear');
  const pigNear = { ...dayObs, reflexes: rx, nearbyEntities: [{ name: 'pig', distance: 5, position: new Vec3(5, 64, 0) }] };
  const hunted = ruleDecide(starving, pigNear, { experimentChance: 0, tasteChance: 0 });
  dreamCheck(hunted.type === 'swingAt' && hunted.target.name === 'pig' && hunted.reflex === 'hunt', 'hungry with nothing to eat: strike the pig');
  const meatOnGround = { ...pigNear, nearbyItems: [{ name: 'porkchop', distance: 2, position: new Vec3(2, 64, 0) }] };
  dreamCheck(ruleDecide(starving, meatOnGround, { experimentChance: 0, tasteChance: 0 }).type === 'pickup', '...and gather the meat it dropped');
  const pigAndZombie = { ...pigNear, nearestHostile: { name: 'zombie', distance: 7, position: new Vec3(7, 64, 0) } };
  dreamCheck(ruleDecide({ ...starving, fear: 10 }, pigAndZombie, { experimentChance: 0, tasteChance: 0 }).reflex !== 'hunt', 'no hunting with a hostile close');
  dreamCheck(rx.shelter(dayObs) === null, 'by day, no shelter reflex');
  dreamCheck(isOverriding({ type: 'dig', reflex: 'shelter' }, evening) && !isOverriding({ type: 'swingAt', reflex: 'hunt' }, evening),
    'night shelter outranks the cortex; hunting does not');

  // Digging in, end to end, in the block world (gravity applied between ticks).
  const holeBot = makeWorldBot();
  holeBot.time = { isDay: false, timeOfDay: 13500 };
  const holeRx = createReflexes();
  const holeDrives = new Drives();
  const fall = () => {
    for (let n = 0; n < 30; n += 1) {
      const p = holeBot.entity.position;
      if (p.y <= 40 || holeBot.blockAt(new Vec3(p.x, Math.floor(p.y) - 1, p.z)).name !== 'air') break;
      holeBot.entity.position = p.offset(0, -1, 0);
    }
  };
  const holeActs = [];
  for (let i = 0; i < 8; i += 1) {
    const s = await tick(holeBot, holeDrives, vaultPath, { reflexes: holeRx, bornKnowing: true, decide: (d, o) => ruleDecide(d, o, { experimentChance: 0, tasteChance: 0 }) });
    holeActs.push(`${s.action.type}${s.action.at ? ' ' + s.action.at : ''}`);
    fall();
  }
  const holeAff = senseAffordances(holeBot);
  dreamCheck(holeActs.slice(0, 3).every((a) => a === 'dig below') && holeActs.includes('place above') && holeAff.enclosed,
    `at night it digs in and seals itself — a shelter by instinct (${holeActs.join(', ')})`);
  dreamCheck(holeActs[holeActs.length - 1] === 'idle', 'once closed in, it stays put until morning');

  // A held Claude plan cannot drag it out of its hole after dark.
  const nightPlan = createClaudeCodeDecide({ model: 'x', vaultPath, minIntervalMs: 1e9, holdMs: 60000, ask: async () => JSON.stringify({ action: 'explore', thought: 'go look around' }) });
  const inHole = { ...calmObs, isDay: false, timeOfDay: 14000, reflexes: createReflexes(), position: new Vec3(0.5, 61, 0.5), affordances: { ...openGround, enclosed: true, roof: true, walls: 4, skyOverhead: false } };
  await nightPlan(calmD, inHole);
  await new Promise((r) => setTimeout(r, 25));
  const np1 = await nightPlan(calmD, inHole);
  dreamCheck(np1.reflex === 'shelter' && np1.type === 'idle', 'at night, the sheltering reflex overrides a plan to go exploring');
  const bedObs = { ...calmObs, isDay: false, timeOfDay: 13000, position: new Vec3(0.5, 64, 0.5), affordances: { ...openGround, bed: { name: 'red_bed', distance: 6 } } };
  dreamCheck(createReflexes().shelter(bedObs).type === 'use', 'a bed close by at night: lie in it');

  // Crafting by name.
  const crafter = makeWorldBot();
  crafter._inventory = [{ name: 'oak_planks', count: 4 }];
  crafter.registry = { itemsByName: { crafting_table: { id: 1, name: 'crafting_table' }, wooden_pickaxe: { id: 2, name: 'wooden_pickaxe' } }, blocksByName: {} };
  crafter.findBlock = () => null;
  crafter.recipesFor = (id) => (id === 1 ? [{ id }] : []);
  crafter.recipesAll = (id) => (id === 2 ? [{ requiresTable: true }] : []);
  let crafted = null;
  crafter.craft = async (r) => { crafted = r.id; };
  const made = await execute(crafter, { type: 'craft', item: 'crafting_table' });
  const notMade = await execute(crafter, { type: 'craft', item: 'wooden_pickaxe' });
  const unknown = await execute(crafter, { type: 'craft', item: 'spaceship' });
  dreamCheck(made.ok && crafted === 1, 'craft by name: a crafting table from planks');
  dreamCheck(!notMade.ok && /crafting table/.test(notMade.reason) && !unknown.ok,
    'what it can\'t make comes back with a reason ("I would need a crafting table close by")');
  dreamCheck(toAction({ action: 'craft', item: 'Crafting Table', thought: 't' }, motorObs).item === 'crafting_table', 'the cortex can name what to craft');

  // RCON against a fake server, then the growth rules.
  const net = require('net');
  const { packet, readPackets } = require('./brain/rcon');
  const got = [];
  const fakeServer = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const [ps, rest] = readPackets(buf);
      buf = rest;
      for (const p of ps) {
        if (p.type === 3) sock.write(packet(p.body === 'pw' ? p.id : -1, 2, ''));
        else { got.push(p.body); sock.write(packet(p.id, 0, `ok: ${p.body}`)); }
      }
    });
  });
  await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
  const port = fakeServer.address().port;
  const reply = await createRcon({ port, password: 'pw' }).command('worldborder get');
  let badPw = null;
  try { await createRcon({ port, password: 'wrong' }).command('x'); } catch (e) { badPw = e.message; }
  fakeServer.close();
  dreamCheck(reply === 'ok: worldborder get' && got[0] === 'worldborder get' && /rejected/.test(String(badPw)), 'the RCON client logs in, runs a command, and refuses a wrong password');

  const cmds = [];
  const quietLog = { log: () => {}, error: () => {} };
  // The temp copy carries the live world's growth state (border 256 since
  // 2026-11-17): these checks start from a fresh world.
  fs.rmSync(path.join(vaultPath, 'State', 'World.md'), { force: true });
  // The world grows for real advancements, not for surviving nights (2026-11-16).
  const { earnedAdvancements, advancementsFile } = require('./brain/worldGrowth');
  const fakeServer2 = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-mind-server-'));
  fs.writeFileSync(path.join(fakeServer2, 'server.properties'), 'motd=x\nlevel-name=terrarium\n');
  fs.writeFileSync(path.join(fakeServer2, 'usercache.json'), JSON.stringify([{ name: 'MindBot', uuid: 'abc-123' }]));
  const advFile = advancementsFile(fakeServer2, 'MindBot');
  fs.mkdirSync(path.dirname(advFile), { recursive: true });
  const writeAdv = (done) => fs.writeFileSync(advFile, JSON.stringify({
    'minecraft:adventure/root': { done: true },
    'minecraft:husbandry/root': { done: true },
    'minecraft:recipes/misc/stick': { done: true }, // recipe unlocks never count
    'minecraft:story/mine_stone': { done: done.includes('mine_stone') },
    ...(done.includes('sleep') ? { 'minecraft:adventure/sleep_in_bed': { done: true } } : {}),
    DataVersion: 4189,
  }));
  writeAdv([]);
  dreamCheck(advFile === path.join(fakeServer2, 'terrarium', 'advancements', 'abc-123.json') &&
    earnedAdvancements(advFile).join() === 'minecraft:adventure/root,minecraft:husbandry/root',
    'the bot\'s advancements are read from the server\'s own file (recipe unlocks and unfinished ones left out)');
  const growth = createWorldGrowth({ vaultPath, startSize: 128, log: quietLog, saveWaitMs: 0,
    readEarned: () => earnedAdvancements(advFile), rcon: { command: async (c) => { cmds.push(c); return ''; } } });
  const grewBefore = fs.readdirSync(path.join(vaultPath, 'Experiences')).filter((f) => f.includes('The World Grew Wider')).length;
  await growth.onNight({ survived: true });
  dreamCheck(cmds.includes('save-all') && !cmds.some((c) => c.startsWith('worldborder')) && growth.state().credited.length === 2,
    'the first dawn under the new rule only records what it had already done (no growth for old news)');
  for (let i = 0; i < 4; i += 1) await growth.onNight({ survived: true });
  dreamCheck(!cmds.some((c) => c.startsWith('worldborder')) && growth.state().size === 128,
    'surviving night after night no longer grows the world');
  writeAdv(['mine_stone']);
  await growth.onNight({ survived: false });
  dreamCheck(cmds.includes('worldborder set 256') && growth.state().size === 256 && growth.state().grown[0].for[0] === 'minecraft:story/mine_stone',
    'a new advancement (mined stone) grows the world at dawn — even after a death');
  dreamCheck(fs.readdirSync(path.join(vaultPath, 'Experiences')).filter((f) => f.includes('The World Grew Wider')).length === grewBefore + 1,
    'and the mind remembers the world growing');
  await growth.onNight({ survived: true });
  dreamCheck(growth.state().size === 256, 'the same advancement never counts twice');
  writeAdv(['mine_stone', 'sleep']);
  const flaky = createWorldGrowth({ vaultPath, startSize: 128, log: quietLog, saveWaitMs: 0,
    readEarned: () => earnedAdvancements(advFile), rcon: { command: async () => { throw new Error('down'); } } });
  await flaky.onNight({ survived: true });
  dreamCheck(flaky.state().size === 256 && !flaky.state().credited.includes('minecraft:adventure/sleep_in_bed'),
    'if the server can\'t be reached, the advancement stays uncredited and the next dawn retries');
  await growth.onNight({ survived: true });
  dreamCheck(growth.state().size === 512, '…and it does: slept in a bed, 256 → 512');
  const late = createWorldGrowth({ vaultPath, startSize: 128, log: quietLog, saveWaitMs: 0,
    readEarned: () => [...earnedAdvancements(advFile), 'minecraft:story/smelt_iron'], rcon: { command: async (c) => { cmds.push(c); return ''; } } });
  fs.writeFileSync(path.join(vaultPath, 'State', 'World.md'), '---\nborder_size: 1024\ncredited: []\n---\nx');
  await late.onNight({ survived: true });
  dreamCheck(cmds[cmds.length - 1] === 'worldborder set 59999968', 'after 1024 blocks, the next growth lifts the border: the whole world');

  // ------------------------------- hunting at the edge (2026-11-16 fix)
  // Live trace: the pigs and cows grazed at the terrarium's edge; every hunt
  // chased them into the border reflex and back, for minutes, never landing a hit.
  const edgeRx = createReflexes();
  const terrarium = { x: -192, z: 608, half: 64 }; // x -256..-128
  const edgeObs = {
    ...calmObs, isDay: true, timeOfDay: 6000, reflexes: edgeRx, border: terrarium,
    position: new Vec3(-240, 70, 600), affordances: { ...openGround },
    nearbyEntities: [{ name: 'pig', distance: 14, position: new Vec3(-253, 70, 600) }],
  };
  dreamCheck(edgeRx.hunt(starving, edgeObs) === null, 'a pig grazing at the world\'s edge is out of reach: no endless chase into the border');
  const innerPig = { ...edgeObs, nearbyEntities: [...edgeObs.nearbyEntities, { name: 'cow', distance: 9, position: new Vec3(-232, 70, 604) }] };
  const innerHunt = edgeRx.hunt(starving, innerPig);
  dreamCheck(innerHunt && innerHunt.target.name === 'cow', 'it hunts the animal that is inside its world instead');
  const seekArb = createArbiter({ decide: async () => ({ type: 'seekFood', source: 'held', thought: 'food' }), blackboard: createBlackboard({}), toAction });
  const converted = await seekArb(starving, innerPig);
  dreamCheck(converted.type === 'swingAt' && converted.target.name === 'cow' && converted.source === 'held',
    'born knowing animals give meat, "look for food" means going after the cow in reach — not wandering');
  // Stone takes seconds by hand: re-issuing "dig below" every tick used to
  // abort the dig in progress, so it never broke (2026-11-16).
  const stoneBot = makeWorldBot();
  let digCalls = 0;
  stoneBot.dig = async () => { digCalls += 1; };
  const sr1 = await execute(stoneBot, { type: 'dig', at: 'below' });
  stoneBot.targetDigBlock = { position: new Vec3(0, 63, 0) }; // mid-dig on the block below
  const sr2 = await execute(stoneBot, { type: 'dig', at: 'below' });
  dreamCheck(digCalls === 1 && /still breaking/.test(sr2.did) && /breaking/.test(sr1.did),
    'a slow block keeps being broken instead of the dig restarting every tick');
  const creeper7 = { ...edgeObs, nearbyEntities: [{ name: 'creeper', distance: 7, position: new Vec3(-233, 70, 600), hostile: true }] };
  dreamCheck(createReflexes().creeper(creeper7) !== null, 'a creeper at 7 blocks already sends it away (6 was too late)');

  // ------------------------------- goals become plans, plans become skills
  // (docs/design-plans-and-skills.md)
  console.log('\n=== Plans and skills ===');
  const planStore = require('./vault/planStore');
  const { createPlanRunner } = require('./brain/planRunner');
  const { applyDream: applyDreamP, buildDreamPrompt: buildDreamPromptP } = require('./reflection/dream');
  const { writeSubgoal: writeSubgoalP, foundingGoalTitle: foundingP } = require('./vault/goalStore');
  // The temp copy carries the live vault's plans: start from none.
  fs.rmSync(path.join(vaultPath, 'Plans'), { recursive: true, force: true });
  const planLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-mind-plans-'));
  let clock = Date.now();
  const tickClock = () => clock;
  const runnerFor = (opts = {}) => createPlanRunner({ vaultPath, logDir: planLogDir, autoStart: false, now: tickClock, ...opts });
  const pDay = (extra = {}) => ({
    ...calmObs, isDay: true, timeOfDay: 6000, heldItem: null, sleeping: false, digging: false,
    affordances: { enclosed: false, roof: false, skyOverhead: true }, ...extra,
  });
  const pLate = (extra = {}) => pDay({ timeOfDay: 9000, ...extra });
  const pNight = (extra = {}) => pDay({ isDay: false, timeOfDay: 15000, ...extra });
  const founding = foundingP(vaultPath);
  const goalP = (title) => writeSubgoalP(vaultPath, { title, body: title, servesTitle: founding });
  const compiled = (raw) => planStore.compilePlan(raw).plan;
  const planData = (name) => planStore.readPlan(vaultPath, name).data;
  // One full turn of the loop: arbitrate/next, then the body "acts" (result), then afterTick.
  const act = (runner, o, result, emergency = false) => {
    const a = runner.next(o, { emergency }) || { type: 'idle', source: 'instinct' };
    runner.afterTick({ action: a, result, observation: o });
    return a;
  };
  const okR = (did = 'done') => ({ ok: true, did });

  // The language and the feasibility gate.
  const good = planStore.compilePlan({ when: 'Late Day', steps: ['Explore until near a bed', 'approach bed', 'swing at cow', 'pick up'], test: 'near a bed at nightfall' });
  dreamCheck(good.ok && good.plan.when === 'late day' && good.plan.steps[0] === 'explore until near bed' &&
    good.plan.steps[2] === 'swingAt cow' && good.plan.steps[3] === 'pickup' && good.plan.test === 'near bed at nightfall',
    'a dreamed plan compiles into the body\'s own primitives and a test it can check');
  const badVerb = planStore.compilePlan({ when: 'day', steps: ['build a house'], test: 'enclosed' });
  const badDir = planStore.compilePlan({ when: 'day', steps: ['dig sideways'], test: 'enclosed' });
  const badTest = planStore.compilePlan({ when: 'day', steps: ['jump'], test: 'feel safe' });
  dreamCheck(!badVerb.ok && /no way to "build"/.test(badVerb.reason) && !badDir.ok && !badTest.ok && /feel safe/.test(badTest.reason),
    'the feasibility gate refuses verbs the body lacks, directions it can\'t aim, and tests it can\'t check — with the reason');
  const c1 = planStore.parseCondition('carrying 4 oak logs');
  const c2 = planStore.parseCondition('slept through the night');
  dreamCheck(c1.kind === 'carrying' && c1.n === 4 && c2.timing === 'dawn' && planStore.parseCondition('enclosed at nightfall').timing === 'nightfall',
    'conditions parse: counts, nightfall tests and dawn tests');

  // A plan that starts by itself when its time comes (a habit), and runs across ticks.
  goalP('Gather Dirt By Day');
  planStore.writePlan(vaultPath, { name: 'Gather Dirt', goal: 'Gather Dirt By Day', plan: compiled({ when: 'day', steps: ['dig below', 'place ahead', 'jump'], test: 'carrying dirt' }) });
  const habit = createPlanRunner({ vaultPath, logDir: planLogDir, now: tickClock });
  dreamCheck(habit.next(pNight()) === null, 'a day plan does not start itself at night');
  const hb1 = act(habit, pDay(), okR('breaking the dirt below'));
  dreamCheck(hb1.type === 'dig' && hb1.at === 'below' && hb1.source === 'plan' && hb1.plan === 'Gather Dirt',
    'by day, the plan starts by itself and the body digs (source: plan)');
  const hb2 = act(habit, pDay({ digging: true }), undefined);
  dreamCheck(hb2.type === 'idle' && hb2.source === 'plan', 'it waits while the hand is still breaking the block');
  const hb3 = act(habit, pDay(), okR('set dirt down ahead'));
  const hb4 = act(habit, pDay(), okR('jumped'));
  dreamCheck(hb3.type === 'place' && hb3.at === 'ahead' && hb4.type === 'jump', 'then the next steps, one per tick, in order');
  const hb5 = act(habit, pDay(), undefined);
  dreamCheck(hb5.source !== 'plan' && habit.status().running === null && habit.status().waiting.length === 1,
    'steps done: the body is released while the test is checked');
  act(habit, pDay({ inventory: [{ name: 'dirt', count: 2 }] }), undefined);
  const gd = planData('Gather Dirt');
  dreamCheck(gd.passed === 1 && gd.runs === 1 && gd.status === 'trying', 'the test came true: the run is graded passed in the plan note');
  dreamCheck(habit.next(pDay()) === null, 'a plan does not start itself again straight away (once per half day)');

  // Emergencies pause a plan; it resumes.
  const em = runnerFor({ cooldownMs: 0 });
  em.start('Gather Dirt');
  dreamCheck(act(em, pDay(), undefined, true).source !== 'plan', 'an emergency pre-empts the running plan');
  dreamCheck(em.status().running && em.status().running.paused, '…which waits, paused, not failed');
  const resumed = act(em, pDay(), okR());
  dreamCheck(resumed.type === 'dig' && resumed.source === 'plan', 'and resumes where it was when the danger passes');
  em.stop('sim');

  // A step the body refuses is retried, then the run breaks with the body's reason.
  goalP('Make A Table');
  planStore.writePlan(vaultPath, { name: 'Make A Table', goal: 'Make A Table', plan: compiled({ when: 'any', steps: ['craft crafting_table'], test: 'carrying crafting_table' }) });
  const br = runnerFor();
  br.start('make a table'); // by name, forgiving case
  const refuse = { ok: false, reason: 'I lacked what it takes to make a crafting table' };
  for (let i = 0; i < 3; i += 1) act(br, pDay(), refuse);
  dreamCheck(br.status().running === null && planData('Make A Table').broke === 1 &&
    /lacked what it takes/.test(planData('Make A Table').last_reason),
    'a refused step is retried twice, then the run breaks with the body\'s own reason');

  // until-steps, seeking what isn't in view, and a nightfall test.
  goalP('Find A Bed Before Dark');
  planStore.writePlan(vaultPath, { name: 'Bed Before Dark', goal: 'Find A Bed Before Dark', plan: compiled({ when: 'late day', steps: ['explore until near bed 12', 'approach bed'], test: 'near bed at nightfall' }) });
  const bedRun = runnerFor();
  bedRun.start('Bed Before Dark');
  const bedAt = (d) => ({ name: 'red_bed', distance: d, position: new Vec3(d, 64, 0) });
  const s1 = act(bedRun, pLate(), undefined);
  const s2 = act(bedRun, pLate({ affordances: { bed: bedAt(8) } }), undefined);
  dreamCheck(s1.type === 'explore' && s2.type === 'approach' && s2.target.name === 'red_bed',
    '"explore until near bed": walks until a bed is in view, then goes to it');
  act(bedRun, pLate({ affordances: { bed: bedAt(2) } }), undefined);
  dreamCheck(bedRun.status().waiting.some((w) => w.name === 'Bed Before Dark'), 'there: the test waits for nightfall');
  act(bedRun, pLate({ timeOfDay: 11000, affordances: { bed: bedAt(3) } }), undefined);
  dreamCheck(planData('Bed Before Dark').passed === 0, '…and is not judged before dark');
  act(bedRun, pDay({ timeOfDay: 12000, affordances: { bed: bedAt(3) } }), undefined);
  dreamCheck(planData('Bed Before Dark').passed === 1, 'judged at nightfall: near a bed — passed');

  // A plan still running when dusk comes is judged then, even while the night reflex has the body.
  const lateRun = runnerFor();
  lateRun.start('Bed Before Dark');
  act(lateRun, pLate(), undefined); // exploring, no bed yet
  lateRun.next(pDay({ timeOfDay: 12000 }), { emergency: true });
  dreamCheck(lateRun.status().running === null && planData('Bed Before Dark').broke === 1 && planData('Bed Before Dark').passed === 1,
    'dusk falls mid-plan with steps undone: the run breaks ("the time for it passed"), it is not graded on its test');

  // A dawn test: slept through the night; and a death in the night fails it.
  goalP('Sleep Through The Night');
  planStore.writePlan(vaultPath, { name: 'Sleep In A Bed', goal: 'Sleep Through The Night', plan: compiled({ when: 'any', steps: ['use bed'], test: 'slept through the night' }) });
  const sl = runnerFor();
  sl.start('Sleep In A Bed');
  const u1 = act(sl, pNight({ affordances: { bed: bedAt(2) } }), okR('lay down in the red bed'));
  act(sl, pNight({ sleeping: true }), undefined);
  act(sl, pNight({ timeOfDay: 20000 }), undefined);
  act(sl, pDay({ timeOfDay: 100 }), undefined);
  dreamCheck(u1.type === 'use' && u1.target === 'bed' && planData('Sleep In A Bed').passed === 1, 'use bed, sleep, and at dawn: slept through the night — passed');
  sl.start('Sleep In A Bed');
  act(sl, pNight({ affordances: { bed: bedAt(2) } }), okR('lay down in the red bed'));
  act(sl, pNight(), undefined);
  sl.noteDeath();
  act(sl, pDay({ timeOfDay: 100 }), undefined);
  dreamCheck(planData('Sleep In A Bed').failed === 1 && /died/.test(planData('Sleep In A Bed').last_reason), 'a death in the night fails a dawn test, with the reason');

  // Generate and test: three passes make a Skill.
  const gr = runnerFor();
  for (let i = 0; i < 2; i += 1) {
    gr.start('Gather Dirt');
    for (const o of [pDay(), pDay(), pDay(), pDay(), pDay({ inventory: [{ name: 'dirt', count: 1 }] })]) act(gr, o, okR());
  }
  const skillFile = path.join(vaultPath, 'Concepts/Abstract/Skill/Gather Dirt.md');
  dreamCheck(planData('Gather Dirt').status === 'skill' && fs.existsSync(skillFile), 'three passes: the plan is promoted to a Skill');
  const skillNote = fs.readFileSync(skillFile, 'utf8');
  dreamCheck(/promoted_from: "\[\[Plans\/Gather Dirt\]\]"/.test(skillNote) && /- dig below/.test(skillNote) && /skill\/callable/.test(skillNote),
    'the Skill note carries its steps, its test and where it came from');
  dreamCheck(fs.readdirSync(path.join(vaultPath, 'Experiences')).some((f) => f.includes('Learned How To Gather Dirt')), 'and the mind remembers learning it');

  // Three graded runs without a pass: revise; the dream sees why and rewrites it.
  const rv = runnerFor();
  for (let i = 0; i < 2; i += 1) { rv.start('Make A Table'); for (let j = 0; j < 3; j += 1) act(rv, pDay(), refuse); }
  dreamCheck(planData('Make A Table').status === 'revise', 'three runs and never a pass: the plan is marked for revision');
  const promptWithPlans = buildDreamPromptP(vaultPath);
  dreamCheck(/Plans that keep failing[\s\S]*Make A Table[\s\S]*lacked what it takes/.test(promptWithPlans) && /How plans work/.test(promptWithPlans),
    'the next dream is told which plan keeps failing, and why');
  dreamCheck(rv.start('Make A Table').ok === false, 'a plan waiting to be rethought cannot be run');
  const revised = applyDreamP(vaultPath, { insights: [], subgoals: [], skills: [], plans: [
    { revises: 'Make A Table', for_goal: 'Make A Table', when: 'day', steps: ['swingAt tree', 'craft oak_planks', 'craft crafting_table'], test: 'carrying crafting_table' },
  ] });
  const mt = planData('Make A Table');
  dreamCheck(revised.some((w) => w.kind === 'plan' && w.revised) && mt.version === 2 && mt.status === 'trying' &&
    mt.history.length === 1 && mt.history[0].steps[0] === 'craft crafting_table' && mt.steps.length === 3,
    'a dream writes version 2; version 1 is kept in history with why it was replaced');
  // Versions 2 and 3 fail too: dropped, never deleted.
  for (let v = 0; v < 2; v += 1) {
    for (let i = 0; i < 3; i += 1) { rv.start('Make A Table'); planStore.recordRun(vaultPath, 'Make A Table', { grade: 'failed', reason: 'no table appeared' }); rv.stop('sim'); }
    if (v === 0) planStore.revisePlan(vaultPath, 'Make A Table', compiled({ when: 'day', steps: ['craft crafting_table'], test: 'carrying crafting_table' }));
  }
  const dropped = planData('Make A Table');
  dreamCheck(dropped.status === 'dropped' && fs.existsSync(planStore.planPath(vaultPath, 'Make A Table')) && dropped.history.length === 2,
    'still failing after two revisions: dropped, with its history kept (nothing deleted)');

  // Dreams write plans with new goals and for goals already held.
  goalP('Carry Wood Before Dusk');
  const dreamt = applyDreamP(vaultPath, {
    insights: [], skills: [],
    subgoals: [{ title: 'Wall Myself In Before Dark', body: 'Walls before night.', plan: { name: 'Wall In', when: 'late day', steps: ['place left', 'place right', 'place ahead', 'place behind'], test: 'enclosed at nightfall' } }],
    plans: [
      { for_goal: 'Carry Wood Before Dusk', name: 'Gather Wood', when: 'day', steps: ['approach oak_log', 'dig ahead'], test: 'carrying oak_log 4' },
      { for_goal: 'A Goal I Never Set', when: 'day', steps: ['jump'], test: 'fed' },
      { for_goal: 'Carry Wood Before Dusk', when: 'day', steps: ['teleport home'], test: 'fed' },
    ],
  });
  dreamCheck(dreamt.some((w) => w.kind === 'subgoal' && w.title === 'Wall Myself In Before Dark') &&
    planData('Wall In').serves === '[[Wall Myself In Before Dark]]' && planData('Gather Wood').status === 'trying',
    'a dreamed goal arrives with its plan, and an old goal gets one');
  dreamCheck(dreamt.rejected.length === 2 && dreamt.rejected.some((r) => /no goal of mine/.test(r.reason)) && dreamt.rejected.some((r) => /teleport/.test(r.reason)),
    'plans for unknown goals, or that the body cannot run, are refused and the reason kept for the dream log');
  dreamCheck(!/Carry Wood Before Dusk/.test((/Goals you hold that have no plan yet:\n([\s\S]*?)\n\n/.exec(buildDreamPromptP(vaultPath)) || [])[1] || ''),
    'a goal with a plan is no longer listed as needing one');

  // The arbiter: emergencies, then the plan, then Claude; the cortex calls skills by name.
  const pbb = createBlackboard({});
  const pr = runnerFor();
  let cortexSays = { type: 'explore', source: 'claude', thought: 'I want to see the hills', say: 'hello' };
  const parb = createArbiter({ decide: async () => cortexSays, blackboard: pbb, toAction, planRunner: pr });
  cortexSays = { type: 'skill', item: 'gather dirt', source: 'claude', thought: 'I know how to do this' };
  const ps1 = await parb(starving, pDay());
  dreamCheck(ps1.source === 'plan' && ps1.plan === 'Gather Dirt' && ps1.type === 'dig', 'the cortex calls a skill by name and the body starts on it');
  pr.afterTick({ action: ps1, result: okR(), observation: pDay() });
  cortexSays = { type: 'explore', source: 'claude', thought: 'I want to see the hills', say: 'hello' };
  const ps2 = await parb(starving, pDay());
  dreamCheck(ps2.source === 'plan' && ps2.thought === 'I want to see the hills' && ps2.say === 'hello' && ps2.overrode === 'explore',
    'a plan in hand outranks a fresh thought, but keeps the thought and the words');
  const danger = pDay({ nearestHostile: { name: 'zombie', distance: 3, position: new Vec3(3, 64, 0) } });
  cortexSays = { type: 'flee', source: 'instinct', target: danger.nearestHostile };
  const ps3 = await parb(starving, danger);
  dreamCheck(ps3.type === 'flee' && ps3.source === 'instinct', 'a zombie within reach: the brainstem acts, not the plan');
  const dusk = pDay({ timeOfDay: 12500 });
  cortexSays = { type: 'dig', at: 'below', reflex: 'shelter', source: 'instinct' };
  const ps4 = await parb(starving, dusk);
  dreamCheck(ps4.reflex === 'shelter', 'from dusk, the night-shelter reflex comes before any plan');
  cortexSays = { type: 'stop', source: 'claude', thought: 'enough' };
  await parb(starving, pDay());
  dreamCheck(pr.status().running === null, 'the cortex can let the running plan go ("stop")');
  cortexSays = { type: 'skill', item: 'Fly To The Moon', source: 'claude', thought: 'hm' };
  const ps5 = await parb(starving, pDay());
  dreamCheck(ps5.type === 'idle' && pr.status().running === null, 'asking for a plan it doesn\'t have does nothing');
  pbb.post('innerVoice', 'urge', { action: 'skill', item: 'gather dirt', thought: 'maybe' });
  cortexSays = { type: 'explore', source: 'instinct' };
  const ps6 = await parb(calmDrives, pDay());
  dreamCheck(ps6.source !== 'plan' && ps6.type !== 'skill', 'a passing urge cannot call a plan; that is the cortex\'s to do');

  // The cortex's vocabulary and prompt.
  const skillAct = toAction({ action: 'skill', item: 'Gather Dirt', thought: 'x' }, pDay());
  dreamCheck(skillAct.type === 'skill' && skillAct.item === 'Gather Dirt' && toAction({ action: 'stop' }, pDay()).type === 'stop',
    'the cortex may answer "skill" (by name) or "stop"');
  const pr2 = runnerFor();
  pr2.start('Wall In');
  const cortexPrompt = buildPrompt(vaultPath, new Drives(), { ...pLate(), affordances: null, plan: pr2.status() });
  dreamCheck(/carry out by name[\s\S]*"Gather Dirt" \(a skill I have mastered\)/.test(cortexPrompt) &&
    /You are carrying out your plan "Wall In" \(step 1 of 4: place left/.test(cortexPrompt),
    'the cortex sees its skills and plans by name, and the plan its body is in the middle of');
  pr2.stop('sim');
  const planLog = fs.readdirSync(planLogDir).filter((f) => f.startsWith('plans-'));
  const planLines = planLog.length ? fs.readFileSync(path.join(planLogDir, planLog[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  dreamCheck(planLines.length >= 10 && planLines.some((l) => l.grade === 'passed' && l.trace.length >= 3) && planLines.some((l) => l.grade === 'broke' && l.reason),
    'every run is logged to plans-*.jsonl with its trace, grade and reason');
  const tickWithPlan = await tick(makeMockBot(), new Drives(), vaultPath, {
    decide: async () => ({ type: 'jump', source: 'plan', plan: 'Gather Dirt', planRun: 999, planStep: 2 }),
    planRunner: runnerFor(),
  });
  dreamCheck(tickWithPlan.action.plan === 'Gather Dirt', 'the loop carries plan actions through the body and back to the runner');
  // Strict grading (2026-11-17): a pass must be earned. Live, "near grass"
  // passed every time and a night plan passed with none of its steps done.
  goalP('Stand Somewhere Green');
  planStore.writePlan(vaultPath, { name: 'Stand On Grass', goal: 'Stand Somewhere Green', plan: compiled({ when: 'any', steps: ['jump'], test: 'near grass_block' }) });
  const onGrass = pDay({ nearbyBlocks: [{ name: 'grass_block', distance: 1, position: new Vec3(0, 63, 0) }] });
  const strictRun = createPlanRunner({ vaultPath, logDir: planLogDir, now: tickClock, cooldownMs: 0 });
  const st1 = strictRun.next(onGrass);
  dreamCheck(!st1 || st1.plan !== 'Stand On Grass', 'a plan whose test is already true does not start itself (nothing to do)');
  const st2 = strictRun.start('Stand On Grass', 'cortex', onGrass);
  dreamCheck(!st2.ok && /already so/.test(st2.reason), '…and the cortex is told it is already so');
  strictRun.stop('sim');
  goalP('Sink At Dusk');
  planStore.writePlan(vaultPath, { name: 'Sink At Dusk', goal: 'Sink At Dusk', plan: compiled({ when: 'dusk', steps: ['dig below'], test: 'enclosed at nightfall' }) });
  const earlyStart = runnerFor().start('Sink At Dusk', 'cortex', pDay());
  dreamCheck(!earlyStart.ok && /not the time/.test(earlyStart.reason), 'a dusk plan cannot be started by day (it used to skip its steps and be graded anyway)');
  goalP('Wall Up And Wait');
  planStore.writePlan(vaultPath, { name: 'Wall Up And Wait', goal: 'Wall Up And Wait', plan: compiled({ when: 'late day', steps: ['jump', 'wait until day'], test: 'enclosed at nightfall' }) });
  const wwRun = runnerFor();
  wwRun.start('Wall Up And Wait', 'cortex', pLate());
  dreamCheck(wwRun.start('Wall Up And Wait', 'cortex', pLate()).already === true, 'calling a plan that is already running changes nothing');
  act(wwRun, pLate(), okR('jumped'));
  act(wwRun, pLate(), undefined); // waiting
  wwRun.next(pDay({ timeOfDay: 12000, affordances: { enclosed: true } }), { emergency: true });
  dreamCheck(planData('Wall Up And Wait').passed === 1, 'a final "wait until day" counts as done when its time runs out: graded at nightfall (enclosed — passed)');
  const nightRun = runnerFor();
  goalP('Last Through The Dark');
  planStore.writePlan(vaultPath, { name: 'Last Through The Dark', goal: 'Last Through The Dark', plan: compiled({ when: 'night', steps: ['place above', 'wait until day'], test: 'survived the night' }) });
  nightRun.start('Last Through The Dark', 'cortex', pNight());
  act(nightRun, pNight(), { ok: false, reason: 'nothing to set' }); act(nightRun, pNight(), { ok: false, reason: 'nothing to set' });
  nightRun.next(pDay({ timeOfDay: 100 }));
  act(nightRun, pDay({ timeOfDay: 200 }), undefined);
  dreamCheck(planData('Last Through The Dark').passed === 0 && planData('Last Through The Dark').broke === 1,
    'a night plan whose steps were never done does not pass just because the night was survived');
  const { skillLines: skillLinesP } = require('./vault/dreamStore');
  const gdSkill = path.join(vaultPath, 'Concepts/Abstract/Skill/Gather Dirt.md');
  const fmW = require('./vault/frontmatter');
  const skNote = fmW.parse(fs.readFileSync(gdSkill, 'utf8'));
  fs.writeFileSync(gdSkill, fmW.stringify({ ...skNote.data, status: 'withdrawn' }, skNote.body));
  dreamCheck(!/Gather Dirt/.test(skillLinesP(vaultPath) || ''), 'a Skill withdrawn for being earned on an empty test is no longer offered as know-how');

  // ------------------------------- plasticity (design-plasticity-and-a-learning-cortex.md, Part A)
  console.log('\n=== Plasticity ===');
  const cs = require('./vault/conceptStore');
  const plast = require('./vault/plasticity');
  const fmP = require('./vault/frontmatter');
  const { lookup } = require('./vault/ontologyMap');
  const noteOf = (kind, raw) => {
    const file = paths.conceptPath(vaultPath, lookup(kind, raw).classPath, paths.titleCase(raw));
    return { file, ...fmP.parse(fs.readFileSync(file, 'utf8')) };
  };
  const meet = (raw, others, extra = {}) => cs.recordEncounter(vaultPath, 'entity', raw, { coOccursWith: others, ...extra });
  meet('sim_fox', ['Sim Hen']); // first meeting: counts extra
  const w1 = noteOf('entity', 'sim_fox').data.link_strength['Sim Hen'];
  meet('sim_fox', ['Sim Hen']);
  const w2 = noteOf('entity', 'sim_fox').data.link_strength['Sim Hen'];
  for (let i = 0; i < 20; i += 1) meet('sim_fox', ['Sim Hen']);
  const w22 = noteOf('entity', 'sim_fox').data.link_strength['Sim Hen'];
  meet('sim_fox', ['Sim Hen']);
  const w23 = noteOf('entity', 'sim_fox').data.link_strength['Sim Hen'];
  dreamCheck(w1 > 0 && w2 > w1 && w22 > w2 && w22 < 1 && (w23 - w22) < (w2 - w1),
    'links strengthen each time two things are seen together, with diminishing returns (Hebb)');
  meet('sim_owl', ['Sim Mouse']); meet('sim_owl', ['Sim Mouse']);
  const ordinary = noteOf('entity', 'sim_owl').data.link_strength['Sim Mouse'];
  meet('sim_cat', ['Sim Mouse']); meet('sim_cat', ['Sim Mouse'], { salience: 3 });
  const salient = noteOf('entity', 'sim_cat').data.link_strength['Sim Mouse'];
  dreamCheck(salient > ordinary, 'a moment that matters (hurt, eating) links what was seen more strongly');
  dreamCheck(cs.learningRate(1) === 0.5 && cs.learningRate(100) === 0.05 && cs.learningRate(4) === 0.25,
    'familiar things change slowly: the learning rate falls from 0.5 (new) to 0.05 (met a hundred times)');
  meet('sim_wolf', []); // new: met once
  const veteran = noteOf('entity', 'sim_wolf');
  fs.writeFileSync(veteran.file, fmP.stringify({ ...veteran.data, encounter_count: 200 }, veteran.body));
  meet('sim_bear', []);
  const fearBefore = (raw) => noteOf('entity', raw).data.fear_weight;
  const wolf0 = fearBefore('sim_wolf'); const bear0 = fearBefore('sim_bear');
  meet('sim_wolf', [], { tookDamage: true }); meet('sim_bear', [], { tookDamage: true });
  dreamCheck(fearBefore('sim_bear') - bear0 > 5 * (fearBefore('sim_wolf') - wolf0),
    'one bite moves the fear of a new creature far more than of one met two hundred times');

  // Sleep: replay, downscale, prune.
  const fox = noteOf('entity', 'sim_fox');
  fs.writeFileSync(fox.file, fmP.stringify({ ...fox.data, link_strength: { ...fox.data.link_strength, 'Sim Pebble': 0.032 },
    co_occurs_with: [...fox.data.co_occurs_with, '[[Sim Pebble]]', '[[Sim Old Friend]]'] }, fox.body));
  const owlBefore = noteOf('entity', 'sim_owl').data.link_strength['Sim Mouse'];
  const foxBefore = noteOf('entity', 'sim_fox').data.link_strength['Sim Hen'];
  const sleepStats = plast.consolidate(vaultPath, { replay: new Set(['Sim Fox', 'Sim Hen']) });
  const foxAfter = noteOf('entity', 'sim_fox').data;
  const owlAfter = noteOf('entity', 'sim_owl').data.link_strength['Sim Mouse'];
  dreamCheck(foxAfter.link_strength['Sim Hen'] > foxBefore * plast.DOWNSCALE && Math.abs(owlAfter - owlBefore * plast.DOWNSCALE) < 0.002,
    'sleep replays what the day\'s memories involved (strengthened) and weakens every other link a little');
  dreamCheck(!foxAfter.link_strength['Sim Pebble'] && !foxAfter.co_occurs_with.includes('[[Sim Pebble]]') && foxAfter.faded_links['Sim Pebble'],
    'a link that falls too low fades: off the graph, archived under faded_links (not deleted)');
  dreamCheck(foxAfter.link_strength['Sim Old Friend'] === Math.round(plast.UNKNOWN_STRENGTH * plast.DOWNSCALE * 1000) / 1000,
    'links from before strengths existed start at a modest strength and are kept for now');
  dreamCheck(sleepStats.pruned >= 1 && sleepStats.replayed >= 1 && sleepStats.links > 0, 'sleep reports what it replayed, kept and let fade');
  meet('sim_fox', ['Sim Pebble']);
  const backAgain = noteOf('entity', 'sim_fox').data;
  dreamCheck(backAgain.link_strength['Sim Pebble'] > 0 && backAgain.co_occurs_with.includes('[[Sim Pebble]]') && !(backAgain.faded_links || {})['Sim Pebble'],
    'meeting the two together again brings a faded link back');
  const replayed = plast.replayedSince(vaultPath, new Date(0));
  dreamCheck(replayed.size > 0, 'the things the day\'s Experiences involved are found for replay');

  // Spreading activation.
  for (let i = 0; i < 8; i += 1) meet('sim_fox', ['Sim Hen', 'Sim Den']);
  const recall = plast.callsToMind(vaultPath, ['Sim Fox']);
  dreamCheck(/Sim Fox brings to mind Sim Hen/.test(recall || '') && !/\d/.test(recall), 'what is in view calls its strongest links to mind, in words');
  dreamCheck(!/Sim Hen/.test(plast.callsToMind(vaultPath, ['Sim Fox', 'Sim Hen']) || ''), 'what is already in view is not "called to mind"');
  const foxObs = { ...calmObs, affordances: null, nearbyEntities: [{ name: 'sim_fox', distance: 4, position: new Vec3(4, 64, 0) }] };
  dreamCheck(/What this calls to mind[\s\S]*Sim Fox brings to mind Sim Hen/.test(buildPrompt(vaultPath, new Drives(), foxObs)),
    'the cortex is told what the things in view call to mind');
  dreamCheck(/What goes together most in your memory:/.test(buildDreamPromptP(vaultPath)), 'the dream sees what goes together most in its memory');
  let slept = null;
  const { createDreamer: createDreamerP } = require('./reflection/dream');
  const sleeper = createDreamerP({ vaultPath, ask: async () => '{"insights":[],"subgoals":[],"skills":[],"plans":[]}', onSleep: (st) => { slept = st; } });
  await sleeper.dreamNow('sim');
  dreamCheck(slept && Number.isFinite(slept.links), 'every dream begins with sleep: links are consolidated before dreaming');

  // ------------------------------- B1: experience export and the eval's split
  const { buildExamples, situationText } = require('./tools/experienceExport');
  const { split: splitEx, isHard } = require('./tools/cortexEval');
  const tB1 = Date.parse('2026-11-17T12:00:00Z');
  const tk = (i, extra = {}) => ({ ts: new Date(tB1 + i * 1500).toISOString(), health: 20, food: 15, isDay: true,
    aff: { sky: true, walls: 0, enclosed: false, blocks: 1 }, hostiles: [], action: { type: 'explore', source: 'instinct' }, result: null, tookDamage: false, ...extra });
  const safeRun = Array.from({ length: 30 }, (_, i) => tk(i));
  const exA = buildExamples(safeRun);
  dreamCheck(exA.length === 1 && exA[0].label === 'good' && exA[0].action === 'explore',
    'an act carried out with nothing hurting afterwards is a "good" example (one per run of the same act, not one per tick)');
  const hurtRun = Array.from({ length: 30 }, (_, i) => tk(i, { health: i < 5 ? 20 : 12, tookDamage: i === 5,
    action: { type: 'dig', at: 'below', source: 'claude' }, hostiles: [{ name: 'zombie', d: 3 }] }));
  const exB = buildExamples(hurtRun);
  dreamCheck(exB[0].label === 'bad' && exB[0].action === 'dig below' && /lost 8 health/.test(exB[0].why), 'losing health soon after makes it a "bad" example, with the reason');
  const exC = buildExamples(safeRun, [tB1 + 10 * 1500]);
  dreamCheck(exC[0].label === 'bad' && /died/.test(exC[0].why), 'a death soon after makes it "bad"');
  const exD = buildExamples([tk(0, { result: { ok: false, reason: 'there was only air under me' }, action: { type: 'dig', at: 'below' } }), ...safeRun.slice(1)]);
  dreamCheck(exD[0].label === 'bad' && /only air/.test(exD[0].why), 'an act the body refused is "bad"');
  dreamCheck(/Hostile: zombie at 3/.test(situationText(hurtRun[0])) && isHard({ hostileNear: true, isDay: true, situation: '' }),
    'the situation is told in plain words, and a hostile close by marks a hard moment');
  const sp = splitEx([{ ts: '2026-11-16T10:00:00Z' }, { ts: '2026-11-17T10:00:00Z' }, { ts: '2026-11-17T11:00:00Z' }]);
  dreamCheck(sp.testDay === '2026-11-17' && sp.test.length === 2 && sp.earlier.length === 1, 'the test set is held out by time: the latest day');


  // ---- The behaviour stack (MIND=layers; docs/design-subsumption.md, stage 1)
  console.log('\n=== Behaviour stack ===');
  const { createLayerStack, ORDER: LAYER_ORDER } = require('./brain/layers');
  const lDrives = (over = {}) => ({ fear: 0, hunger: 0, curiosity: 50, ...over, dominant() { return 'curiosity'; } });
  const lAff = (over = {}) => ({ enclosed: false, roof: false, canDigBelow: true, canDig: ['ahead', 'below'], canPlace: [], placeable: [], ...over });
  const lObs = (over = {}) => ({ isDay: true, timeOfDay: 3000, health: 20, borderDistance: 40, position: { x: 0, y: 64, z: 0 },
    nearbyEntities: [], nearestHostile: null, nearbyItems: [], nearbyBlocks: [], inventory: [], inventoryFood: [], inedible: [],
    affordances: lAff(), ...over });
  const calm = createLayerStack({ random: () => 0.99 });
  dreamCheck(LAYER_ORDER[0] === 'survive' && LAYER_ORDER[LAYER_ORDER.length - 1] === 'wander', 'the stack runs survive first and wander last');
  const lBorder = calm(lDrives({ hunger: 60 }), lObs({ borderDistance: 2 }));
  dreamCheck(lBorder.layer === 'survive' && lBorder.type === 'returnInside' && lBorder.voices.includes('forage'),
    'at the border Survive wins, and the layers it overrode are logged as voices');
  const lCreeperObs = lObs({ nearbyEntities: [{ name: 'creeper', distance: 5, position: { x: 5, y: 64, z: 0 } }] });
  const lCreeper = calm(lDrives(), lCreeperObs);
  dreamCheck(lCreeper.layer === 'survive' && lCreeper.type === 'flee', 'a creeper close by: Survive flees');
  const lDusk = calm(lDrives(), lObs({ isDay: true, timeOfDay: 12500 }));
  dreamCheck(lDusk.layer === 'shelter' && lDusk.type === 'dig' && lDusk.at === 'below', 'at dusk, out in the open, Shelter digs in');
  const lHome = calm(lDrives(), lObs({ isDay: false, timeOfDay: 18000, affordances: lAff({ enclosed: true, roof: true }) }));
  dreamCheck(lHome.layer === 'shelter' && lHome.type === 'idle', 'closed in at night, Shelter keeps it there');
  const lLogBlock = { name: 'oak_log', distance: 6, position: { x: 6, y: 64, z: 0 } };
  const lGather = calm(lDrives(), lObs({ nearbyBlocks: [lLogBlock] }));
  dreamCheck(lGather.layer === 'gather' && lGather.type === 'dig' && lGather.target === lLogBlock, 'by day, fed and safe, Gather breaks wood');
  const lHungryGather = calm(lDrives({ hunger: 60 }), lObs({ nearbyBlocks: [lLogBlock], inventoryFood: [{ name: 'bread' }], inventory: [{ name: 'bread', count: 1 }] }));
  dreamCheck(lHungryGather.layer === 'forage' && lHungryGather.type === 'eat', 'hungry: Gather goes quiet and Forage eats');
  const lStarving = calm(lDrives({ hunger: 90 }), lObs({ inventoryFood: [{ name: 'bread' }], inventory: [{ name: 'bread', count: 1 }] }));
  dreamCheck(lStarving.layer === 'survive' && lStarving.type === 'eat', 'starving with food in hand: Survive eats');
  dreamCheck(calm(lDrives({ hunger: 60 }), lObs()).type === 'seekFood', 'hungry with nothing to eat or hunt: Forage goes looking');
  const lHurtFed = calm(lDrives({ hunger: 20 }), lObs({ health: 4, food: 12, inventoryFood: [{ name: 'carrot', count: 3 }], inventory: [{ name: 'carrot', count: 3 }] }));
  const lHurtFull = calm(lDrives({ hunger: 5 }), lObs({ health: 4, food: 19, inventoryFood: [{ name: 'carrot', count: 3 }], inventory: [{ name: 'carrot', count: 3 }], affordances: lAff({ canDig: [] }) }));
  dreamCheck(lHurtFed.layer === 'survive' && lHurtFed.type === 'eat' && lHurtFull.type !== 'eat',
    'badly hurt with food in the pack, Survive eats to heal (until the food bar is high enough for health to come back)');
  const lWander = calm(lDrives(), lObs({ affordances: lAff({ canDig: [] }) }));
  dreamCheck(lWander.layer === 'wander' && lWander.type === 'explore', 'nothing else to do: Wander explores');
  const lFar = calm(lDrives({ fear: 80 }), lObs({ nearestHostile: { name: 'zombie', distance: 15 }, affordances: lAff({ canDig: [] }) }));
  const lNear = calm(lDrives({ fear: 80 }), lObs({ nearestHostile: { name: 'zombie', distance: 6 } }));
  dreamCheck(lFar.layer !== 'survive' && lNear.layer === 'survive' && lNear.type === 'flee', 'fear flees a hostile close by, not one far off');
  const salty = createLayerStack({ random: () => 0 });
  const lFiddle = salty(lDrives(), lObs({ affordances: lAff({ canDig: [] }) }));
  dreamCheck(lFiddle.layer === 'wander' && lFiddle.type !== 'explore', 'Wander keeps its salt: sometimes it fiddles instead');
  let lClock = 100000;
  const maker = createLayerStack({ random: () => 0.99, now: () => lClock });
  const lMake = maker(lDrives(), lObs({ inventory: [{ name: 'birch_log', count: 3 }] }));
  dreamCheck(lMake.layer === 'make' && lMake.type === 'craft' && lMake.item === 'birch_planks', 'carrying logs: Make turns them into planks');
  lClock += 1000;
  dreamCheck(createLayerStack({ random: () => 0.99 })(lDrives(), lObs({ inventory: [{ name: 'stripped_oak_log', count: 1 }] })).item === 'oak_planks', 'a stripped log still makes plain planks');
  dreamCheck(maker(lDrives(), lObs({ inventory: [{ name: 'birch_log', count: 3 }] })).layer !== 'make', 'Make rests between makings');
  const lSeen = [];
  const lPlans = { next: (o, { emergency }) => { lSeen.push(emergency); return emergency ? null : { type: 'move', at: 'ahead', plan: 'Walk Ahead' }; } };
  const planned = createLayerStack({ planRunner: lPlans, random: () => 0.99 });
  const lByDay = planned(lDrives(), lObs({ nearbyBlocks: [lLogBlock] }));
  const lByDusk = planned(lDrives(), lObs({ timeOfDay: 12500 }));
  dreamCheck(lByDay.layer === 'make' && lByDay.plan === 'Walk Ahead' && lByDay.source !== 'layer:make' && lByDay.voices.includes('gather') &&
    lByDusk.layer === 'shelter' && lSeen[0] === false && lSeen[1] === true,
    'a running plan is Make\'s by day; at dusk Shelter inhibits it and the plan pauses');
  const lStarvingPlan = planned(lDrives({ hunger: 90 }), lObs());
  dreamCheck(lStarvingPlan.layer === 'forage' && lSeen[lSeen.length - 1] === true, 'starving: Make gives way (the plan pauses) and Forage goes for food');
  const lBot = makeWorldBot();
  const lTick = await tick(lBot, new Drives(), vaultPath, { decide: createLayerStack({ random: () => 0.99 }) });
  dreamCheck(LAYER_ORDER.includes(lTick.action.layer) && Array.isArray(lTick.action.voices) && /^layer:/.test(lTick.action.source),
    'a full tick through the loop carries the controlling layer and the voices');
  // ---- Food (2026-11-17: it walked past cows, carrots and wheat, and starved)
  console.log('\n=== Food ===');
  const { scanCrops } = require('./loop');
  const fCow = { name: 'cow', distance: 6, position: { x: 6, y: 64, z: 0 } };
  const fSeen = [];
  const fPlans = { next: (o, { emergency }) => { fSeen.push(emergency); return emergency ? null : { type: 'explore', plan: 'Some Project' }; } };
  const fStack = createLayerStack({ planRunner: fPlans, random: () => 0.99 });
  const fFedCow = fStack(lDrives({ hunger: 10 }), lObs({ nearbyEntities: [fCow], nearbyBlocks: [lLogBlock] }));
  dreamCheck(fFedCow.layer === 'forage' && fFedCow.type === 'swingAt' && fSeen[fSeen.length - 1] === true,
    'fed but carrying no food, a cow in view: Forage hunts it, and the plan and Gather give way');
  const fStocked = calm(lDrives({ hunger: 10 }), lObs({ nearbyEntities: [fCow], inventoryFood: [{ name: 'bread', count: 5 }], inventory: [{ name: 'bread', count: 5 }], affordances: lAff({ canDig: [] }) }));
  dreamCheck(fStocked.layer !== 'forage', 'carrying enough food, a fed body leaves the cow alone');
  const fRipe = { name: 'carrots', age: 7, ripe: true, distance: 5, position: { x: 5, y: 64, z: 0 } };
  const fGreen = { name: 'wheat', age: 3, ripe: false, distance: 2, position: { x: 2, y: 64, z: 0 } };
  const fHarvest = calm(lDrives({ hunger: 60 }), lObs({ nearbyCrops: [fRipe, fGreen] }));
  dreamCheck(fHarvest.layer === 'forage' && fHarvest.type === 'dig' && fHarvest.target === fRipe && fHarvest.harvest === 'carrots',
    'hungry with ripe carrots in view: Forage harvests them (and leaves the green wheat to grow)');
  const fOnlyGreen = calm(lDrives({ hunger: 60 }), lObs({ nearbyCrops: [fGreen] }));
  dreamCheck(fOnlyGreen.type === 'seekFood', 'unripe crops are not food yet');
  const fDropped = calm(lDrives({ hunger: 10 }), lObs({ nearbyItems: [{ name: 'carrot', distance: 3, position: { x: 3, y: 64, z: 0 } }] }));
  dreamCheck(fDropped.layer === 'forage' && fDropped.type === 'pickup', 'food lying on the ground gets picked up');
  dreamCheck(calm(lDrives({ hunger: 10 }), lObs({ timeOfDay: 12500, nearbyEntities: [fCow] })).layer === 'shelter', 'at dusk, shelter comes before stocking up');
  let fClock = 500000;
  const fMaker = () => createLayerStack({ random: () => 0.99, now: () => (fClock += 60000) });
  const fWheat = { name: 'wheat', count: 3 };
  dreamCheck(fMaker()(lDrives(), lObs({ inventory: [fWheat], tableNear: true })).item === 'bread', 'three wheat and a crafting table in reach: Make bakes bread');
  const fPlace = fMaker()(lDrives(), lObs({ inventory: [fWheat, { name: 'crafting_table', count: 1 }] }));
  dreamCheck(fPlace.type === 'place' && fPlace.item === 'crafting_table', 'three wheat, carrying a table: Make sets it down first');
  dreamCheck(fMaker()(lDrives(), lObs({ inventory: [fWheat, { name: 'oak_planks', count: 4 }] })).item === 'crafting_table', 'three wheat, no table: Make makes one');
  const bSeen = [];
  const bPlans = { next: (o, { emergency }) => { bSeen.push(emergency); return emergency ? null : { type: 'explore', plan: 'Learn Where The Bed Is' }; } };
  let bClock = 900000;
  const bStack = createLayerStack({ planRunner: bPlans, random: () => 0.99, now: () => (bClock += 1000) });
  const bAct = bStack(lDrives({ hunger: 10 }), lObs({ inventory: [fWheat, { name: 'oak_log', count: 2 }], inventoryFood: [{ name: 'carrot', count: 5 }] }));
  const bLater = bStack(lDrives({ hunger: 10 }), lObs({ inventory: [{ name: 'dirt', count: 2 }], inventoryFood: [{ name: 'carrot', count: 5 }] }));
  dreamCheck(bAct.layer === 'make' && bAct.type === 'craft' && bAct.item === 'oak_planks' && bSeen[0] === true && bLater.plan === 'Learn Where The Bed Is',
    'carrying wheat, Make works toward bread before its running plan (the plan pauses), then the plan goes on');
  // Perception: crops are seen, with how ripe they are.
  const fBlocks = { '1,0': { name: 'wheat', getProperties: () => ({ age: 3 }) }, '4,0': { name: 'carrots', getProperties: () => ({ age: 7 }) }, '2,0': { name: 'crafting_table' } };
  const fP = (x) => ({ x, z: 0, distanceTo: () => x, key: `${x},0` });
  const fBot = { entity: { position: { x: 0, y: 64, z: 0 } }, findBlocks: () => [fP(1), fP(4)], blockAt: (p) => fBlocks[p.key],
    findBlock: ({ matching }) => (matching(fBlocks['2,0']) ? fBlocks['2,0'] : null) };
  const fScan = scanCrops(fBot);
  dreamCheck(fScan.crops.length === 2 && fScan.crops[0].name === 'carrots' && fScan.crops[0].ripe && !fScan.crops[1].ripe && fScan.tableNear,
    'the body sees crops and how ripe they are (ripe first), and whether a crafting table is in reach');

  // ---- Patterns across days (stage 3)
  const { splitDays: dSplit, measure: dMeasure } = require('./tools/days');
  const dT = (i, tod, extra = {}) => ({ ts: new Date(Date.parse('2026-11-20T00:00:00Z') + i * 1500).toISOString(), tod, isDay: tod < 13000,
    pos: { x: i, y: 64, z: 0 }, health: 20, food: 10, action: { type: 'explore', layer: 'wander', voices: ['wander'] }, ...extra });
  const dTicks = [dT(0, 22000), dT(1, 23500), dT(2, 100), dT(3, 5000), dT(4, 14000, { aff: { enclosed: true } }), dT(5, 200)];
  const dDays = dSplit(dTicks);
  const dM = dMeasure(dDays[1], 1);
  dreamCheck(dDays.length === 3 && dDays[1].length === 3 && dM.mind === 'layers' && dM.distance === 2 && dM.nightEnclosed === 100 && dM.inControl.wander === 100,
    'npm run days cuts the life into days at dawn and measures each (distance, nights enclosed, who was in control)');

  // ---- The narrator (Claude as the stream of thought in MIND=layers)
  const { createNarrator, narrationPrompt } = require('./brain/narrator');
  const nAsked = [];
  let nClock = 1000000;
  const nLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-mind-narration-'));
  const nNarr = createNarrator({ provider: { ask: async (p) => { nAsked.push(p); return { text: '{"thought": "I am hungry, so I go after the pig."}', by: 'test' }; } },
    everyMs: 20000, logDir: nLogDir, now: () => nClock });
  const nStack = nNarr.narrated(async () => ({ type: 'swingAt', target: { name: 'pig' }, layer: 'forage', voices: ['forage', 'wander'], source: 'layer:forage' }));
  const nA1 = await nStack(lDrives({ hunger: 60 }), lObs());
  await new Promise((r) => setTimeout(r, 10));
  nClock += 1500;
  const nA2 = await nStack(lDrives({ hunger: 60 }), lObs());
  nClock += 1500;
  const nA3 = await nStack(lDrives({ hunger: 60 }), lObs());
  dreamCheck(nA1.type === 'swingAt' && nA1.layer === 'forage' && !nA1.thought && nA2.thought === 'I am hungry, so I go after the pig.' && !nA3.thought,
    'the narrator never changes what the body does; each new thought rides on one tick');
  dreamCheck(nAsked.length === 1 && !/forage|layer/i.test(nAsked[0]) && /swingAt pig/.test(nAsked[0]),
    'Claude is asked at most every 20 s, shown what the body did but not which layer did it');
  const nLog = fs.readdirSync(nLogDir).find((f) => f.startsWith('narration-'));
  const nEntry = nLog && JSON.parse(fs.readFileSync(path.join(nLogDir, nLog), 'utf8').trim().split('\n')[0]);
  dreamCheck(!!nEntry && nEntry.layerNow === 'forage' && nEntry.thought.includes('pig'), 'every narration is logged next to the layer that really acted, for checking its stories');
  const nBroken = createNarrator({ provider: { ask: async () => { throw new Error('usage limit'); } }, now: () => nClock }).narrated(async () => ({ type: 'idle', layer: 'wander' }));
  dreamCheck((await nBroken(lDrives(), lObs())).type === 'idle', 'if Claude can\'t answer, the body carries on regardless');

  // ---- Learned layers (stage 4)
  console.log('\n=== Learned layers ===');
  const feat = require('./learn/features');
  const smx = require('./learn/softmax');
  const exm = require('./learn/examples');
  const { balanced } = require('./tools/trainLayers');
  const sObs = lObs({ health: 10, food: 8, nearbyEntities: [{ name: 'cow', distance: 4, position: { x: 4, y: 64, z: 0 } }],
    nearbyCrops: [{ name: 'carrots', ripe: true, distance: 8, position: { x: 8, y: 64, z: 0 } }], inventoryFood: [], borderDistance: 20 });
  const sDr = lDrives({ hunger: 30 });
  const sRec = { health: 10, food: 8, isDay: true, tod: 3000, near: [{ name: 'cow', d: 4 }], crops: [{ name: 'carrots', ripe: true, d: 8 }], items: [],
    foodCarried: 0, border: 20, aff: { roof: false, walls: 0, enclosed: false }, hostiles: [], drives: { hunger: 30, fear: 0, curiosity: 50 } };
  const sA = feat.vector(feat.recordFromObservation(sObs, sDr)); const sB = feat.vector(sRec);
  dreamCheck(sA.length === feat.FEATURES.length && sA.every((v, i) => Math.abs(v - sB[i]) < 1e-9),
    'a learned layer sees the same numbers live as it learned from the log');
  const sX = []; const sY = [];
  for (let i = 0; i < 60; i++) { const a = i % 2; sX.push([a, 1 - a, 0.5]); sY.push(a ? 'hunt' : 'none'); }
  const sM = smx.train(sX, sY, { classes: ['hunt', 'none'], features: ['animalClose', 'carriesNoFood', 'x'], epochs: 300 });
  const sT = smx.toTable(sM);
  dreamCheck(smx.predict(sM, [1, 0, 0.5]).pick === 'hunt' && smx.predict(sM, [0, 1, 0.5]).pick === 'none' && sT.hunt.animalClose > 0,
    'the classifier learns, and its weights read as a table ("animalClose -> hunt: +")');
  const sEdited = JSON.parse(JSON.stringify(sT)); sEdited.hunt.animalClose = -9;
  dreamCheck(smx.predict(smx.fromTable(sEdited, ['animalClose', 'carriesNoFood', 'x']), [1, 0, 0.5]).pick === 'none',
    'a weight edited by hand (stage 5b: by Opus) changes what the layer does, with no training');
  const sTk = (i, extra) => ({ ts: new Date(Date.parse('2026-11-20T10:00:00Z') + i * 1500).toISOString(), health: 20, food: 12, foodCarried: 0, isDay: true, tod: 3000,
    pos: { x: i, y: 64, z: 0 }, near: [], crops: [], items: [], hostiles: [], drives: { hunger: 20, fear: 0, curiosity: 50 },
    action: { type: 'explore', layer: 'wander', voices: ['wander'] }, ...extra });
  const sRun = [sTk(0, { action: { type: 'swingAt', layer: 'forage', voices: ['forage', 'wander'] } })];
  for (let i = 1; i < 50; i++) sRun.push(sTk(i, i > 10 ? { foodCarried: 3 } : {}));
  const sEx = exm.buildExamples('forage', sRun);
  dreamCheck(sEx[0] && sEx[0].y === 'hunt' && sEx[0].actual === 'hunt', 'a hunt that brought food within the minute is a "do this" example');
  const sHurt = [sTk(0, { action: { type: 'swingAt', layer: 'forage', voices: ['forage'] } })];
  for (let i = 1; i < 50; i++) sHurt.push(sTk(i, { health: i > 5 ? 12 : 20 }));
  dreamCheck(exm.buildExamples('forage', sHurt)[0].y === 'none', 'a hunt that got it hurt teaches the layer to stay quiet there');
  const sPast = [sTk(0, { near: [{ name: 'cow', d: 6 }], food: 14 })];
  for (let i = 1; i < 300; i++) sPast.push(sTk(i, { food: i > 250 ? 4 : 14 }));
  const sDelayed = exm.buildExamples('forage', sPast).find((e) => e.delayed);
  dreamCheck(!!sDelayed && sDelayed.y === 'hunt' && sDelayed.actual === 'none',
    'the delayed lesson: Forage stayed quiet beside a cow and the body went hungry later -> "hunt here"');
  const sBal = balanced([{ y: 'hunt', actual: 'none' }, { y: 'none', actual: 'none' }], (e) => e.actual);
  dreamCheck(Math.abs(sBal.score - 0.5) < 1e-9, 'the gate scores the hand-written layer by what it really did (here: right half the time)');
  const sHuntModel = { classes: ['eat', 'pickup', 'harvest', 'hunt', 'seekFood', 'none'], features: feat.FEATURES,
    W: ['eat', 'pickup', 'harvest', 'hunt', 'seekFood', 'none'].map((c) => feat.FEATURES.map(() => 0)), b: [0, 0, 1, 2, 0, -1] };
  const sShadow = createLayerStack({ random: () => 0.99, learned: () => ({ forage: { model: sHuntModel, served: false, version: 3 } }), learnedMode: 'on' });
  const sSh = sShadow(sDr, sObs);
  dreamCheck(sSh.layer === 'forage' && sSh.type === 'dig' && !sSh.learned && sSh.shadow.forage.pick === 'hunt' && sSh.shadow.forage.hand === 'harvest' && sSh.shadow.forage.v === 3,
    'a model that has not passed its gate only shadows: logged, not acted on');
  const sServed = createLayerStack({ random: () => 0.99, learned: () => ({ forage: { model: sHuntModel, served: true } }), learnedMode: 'on' });
  const sOnAct = sServed(sDr, sObs);
  dreamCheck(sOnAct.learned === 'forage' && sOnAct.type === 'swingAt' && sOnAct.target.name === 'cow',
    'a served model acts: it hunts the cow where the hand-written layer would harvest the carrots');
  const sOn = createLayerStack({ random: () => 0.99, learned: () => ({ forage: { model: { ...sHuntModel, b: [0, 0, 2, 1, 0, -1] }, served: true } }), learnedMode: 'on' });
  const sNoCrop = sOn(sDr, lObs({ nearbyEntities: [{ name: 'cow', distance: 4, position: { x: 4, y: 64, z: 0 } }] }));
  dreamCheck(sNoCrop.type === 'swingAt' && sNoCrop.learned === 'forage', 'if its top pick can\'t be done here, a learned layer takes its next one');

  // ---- Nightly learning (stage 5)
  const { nightlyLearning, readCorrections } = require('./learn/nightly');
  const { missedFood } = exm;
  const nDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-mind-layers-'));
  const nVault = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-mind-lab-'));
  const nTicks = [];
  for (let i = 0; i < 400; i++) {
    const hungry = i > 300;
    nTicks.push(sTk(i, { food: hungry ? 4 : 14, near: i === 20 ? [{ name: 'cow', d: 6 }] : [],
      action: i % 50 === 5 ? { type: 'swingAt', layer: 'forage', voices: ['forage', 'wander'] } : { type: 'explore', layer: 'wander', voices: ['wander'] } }));
  }
  let nPrompt = '';
  const nFits = [];
  const nSummary = await nightlyLearning({
    ticks: nTicks, since: null, dir: nDir, vaultPath: nVault, now: new Date('2026-11-21T00:00:00Z'),
    provider: { ask: async (p) => { nPrompt = p; return { by: 'test', text: JSON.stringify({ forage: { diagnosis: 'It walks past cows.', corrections: [{ id: 1, should: 'hunt', why: 'a cow was right there' }, { id: 2, should: 'dance', why: 'not an act' }] }, wander: { diagnosis: 'Fine.', corrections: [] } }) }; } },
    fitLayer: (layer, ticks, opts) => { nFits.push({ layer, extra: opts.extra.length }); return { layer, passed: false, reason: 'test' }; },
    save: () => 7,
  });
  const nCorr = readCorrections(nDir);
  dreamCheck(nSummary.reviewed && /## forage/.test(nPrompt) && /walked past|went hungry later/.test(nPrompt) && !/gate/i.test(nPrompt.replace('Whether a retrained layer is kept is decided by how the creature actually fares, not by you.', '')),
    'at night Opus is shown each layer\'s moments that matter (incl. food walked past before going hungry)');
  dreamCheck(nCorr.length === 1 && nCorr[0].layer === 'forage' && nCorr[0].should === 'hunt' && nCorr[0].x.length === feat.FEATURES.length,
    'Opus\'s corrections are kept as training examples (an act that isn\'t one of the layer\'s is dropped)');
  dreamCheck(nFits.length === 2 && nFits.find((f) => f.layer === 'forage').extra === 1, 'every night each layer is refitted with all corrections so far, then gated');
  const nLab = path.join(nVault, 'Lab', 'Night Reviews.md');
  dreamCheck(fs.existsSync(nLab) && /It walks past cows/.test(fs.readFileSync(nLab, 'utf8')), 'the review is written to the vault\'s Lab/Night Reviews for people to read');
  const nQuiet = await nightlyLearning({ ticks: nTicks.slice(0, 50), since: null, dir: nDir, provider: { ask: async () => { throw new Error('should not be asked'); } },
    fitLayer: (layer) => ({ layer, passed: false }), save: () => null });
  dreamCheck(!nQuiet.reviewed && !nQuiet.error, 'too little new to review: no Opus call, the layers are still refitted');
  const nZombie = [sTk(0, { near: [{ name: 'cow', d: 6 }], hostiles: [{ name: 'zombie', d: 7 }], action: { type: 'flee', layer: 'survive', voices: ['survive', 'wander'] } })];
  for (let i = 1; i < 300; i++) nZombie.push(sTk(i, { food: i > 250 ? 4 : 14 }));
  dreamCheck(missedFood(nZombie, 0) === null, 'staying quiet beside a cow while fleeing a zombie is not counted as a missed meal');
  const { fitLayer: realFit } = require('./tools/trainLayers');
  const fTicks = [];
  for (let d = 0; d < 3; d++) for (let i = 0; i < 320; i++) {
    const k = d * 320 + i;
    fTicks.push({ ...sTk(k, { tod: (i * 75) % 24000, action: { type: k % 7 ? 'explore' : 'swingAt', layer: k % 7 ? 'wander' : 'forage', voices: ['wander'] }, foodCarried: k % 7 === 1 ? 3 : 0 }) });
  }
  const fHeldStart = fTicks[640].ts;
  const fExtra = [{ x: feat.FEATURES.map(() => 0), y: 'hunt', ts: fTicks[10].ts, actual: 'none', weight: 2 }, { x: feat.FEATURES.map(() => 0), y: 'hunt', ts: fHeldStart, actual: 'none', weight: 2 }];
  const fRes = realFit('forage', fTicks, { extra: fExtra });
  dreamCheck(fRes.corrections === 1, 'a correction from the held-out day is never trained on that night (the gate stays the bot\'s own)');

  // ---- Route A: Opus edits weights directly (stage 5b)
  const edt = require('./learn/edit');
  const eBase = { classes: MENUS_F(), features: feat.FEATURES, W: MENUS_F().map(() => feat.FEATURES.map(() => 0)), b: [0, 0, 0, -1, 0, 1] };
  function MENUS_F() { return ['eat', 'pickup', 'harvest', 'hunt', 'seekFood', 'none']; }
  const eClean = edt.cleanEdits('forage', eBase, [{ act: 'hunt', feature: 'animalClose', to: 4, why: 'cows' }, { act: 'dance', feature: 'animalClose', to: 1 }, { act: 'hunt', feature: 'wings', to: 1 }, { act: 'hunt', feature: 'bias', to: 99 }]);
  dreamCheck(eClean.length === 2 && eClean[0].from === 0 && eClean[1].to === 10, 'edits must name a real act and feature; numbers are kept within +-10');
  const eEdited = edt.applyEdits(eBase, [eClean[0]]);
  const eCowX = feat.vector({ ...sRec, near: [{ name: 'cow', d: 2 }] });
  dreamCheck(smx.predict(eBase, eCowX).pick === 'none' && smx.predict(eEdited, eCowX).pick === 'hunt' && eEdited.classes.join() === eBase.classes.join(),
    'an edit is applied straight to the weights: no training, and the layer now hunts the cow');
  const eTicks = [];
  for (let i = 0; i < 60; i++) eTicks.push(sTk(i, { near: i % 3 === 0 ? [{ name: 'cow', d: 3 }] : [], action: { type: 'explore', layer: 'wander', voices: ['wander'] } }));
  const eEv = await edt.evidenceFor(eClean[0], eBase, eTicks, ['a cow was right there'], {});
  dreamCheck(eEv.changed === 20 && eEv.evidence.length === 8 && /would choose hunt instead of none/.test(eEv.evidence[0]),
    'each edit is checked against every past moment it would change (found by arithmetic), the most relevant shown with how it turned out');
  const eCalls = [];
  const eProvider = { ask: async (p) => { eCalls.push(p); return { by: 'test', text: eCalls.length === 1
    ? JSON.stringify({ edits: [{ act: 'hunt', feature: 'animalClose', to: 4, why: 'cows were close', moments: [1] }, { act: 'none', feature: 'bias', to: -5, why: 'speak more', moments: [1] }] })
    : JSON.stringify({ final: [{ act: 'hunt', feature: 'animalClose', to: 3, why: 'softened after the evidence' }] }) }; } };
  let eGated = null;
  const eRes = await edt.editLayer({ layer: 'forage', base: { model: eBase, version: 4 }, ticks: nTicks, day: nTicks, provider: eProvider, dir: nDir,
    gate: (layer, model, result) => { eGated = model; result.passed = false; result.reason = 'test gate'; result.model = model; return result; }, now: new Date('2026-11-22T00:00:00Z') });
  dreamCheck(eCalls.length === 2 && /FULL weight table/.test(eCalls[0]) && /past moments/.test(eCalls[1]) && eRes.proposed.length === 2 && eRes.edits.length === 1 && eRes.edits[0].to === 3,
    'Opus sees the full table, proposes, reads the evidence, then keeps, adjusts or withdraws (here: one softened, one withdrawn)');
  dreamCheck(!!eGated && smx.toTable(eGated).hunt.animalClose === 3 && smx.toTable(eGated).none.bias === 1 && eRes.base === 4,
    'only the kept edits reach the layer, and it still has to pass the gate');
  const eLabVault = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-mind-lab-'));
  let eRoutes = 0;
  const eNight = await nightlyLearning({ ticks: nTicks, since: null, dir: nDir, vaultPath: eLabVault, route: 'edit', provider: (() => { let k = 0; return { ask: async () => ({ by: 'test', text: (k++ % 2 === 0) ? JSON.stringify({ edits: [{ act: 'hunt', feature: 'animalClose', to: 2, why: 'w', moments: [1] }] }) : JSON.stringify({ final: [{ act: 'hunt', feature: 'animalClose', to: 2, why: 'kept' }] }) }) }; })(),
    learned: () => ({ forage: { model: eBase, version: 4 } }), gate: (l, m, r) => { r.model = m; r.passed = false; r.reason = 'test'; return r; },
    fitLayer: (layer) => { eRoutes += 1; return { layer, passed: false, reason: 'trained' }; }, save: () => 9, now: new Date('2026-11-22T00:00:00Z') });
  dreamCheck(eNight.route === 'edit' && eNight.results.find((r) => r.layer === 'forage').route === 'edit' && eNight.results.find((r) => r.layer === 'wander').route === 'train' && eRoutes === 1,
    'on an editing night a layer with a model is edited; one without a model yet is trained instead');
  dreamCheck(/kept after seeing the evidence/.test(fs.readFileSync(path.join(eLabVault, 'Lab', 'Night Reviews.md'), 'utf8')), 'the edits and their reasons are written to Lab/Night Reviews');

  // ---- Language-model layers (stage 6)
  console.log('\n=== Model layers ===');
  const { createModelLayers, menuFor } = require('./brain/modelLayers');
  const mDusk = lObs({ timeOfDay: 12500, affordances: lAff({ canDigBelow: true, roof: false, placeable: ['dirt'], canPlace: ['ahead', 'left'] }), inventory: [{ name: 'dirt', count: 5 }] });
  const mShelterMenu = menuFor('shelter', mDusk);
  dreamCheck(mShelterMenu.map((m) => m.key).join(',') === 'dig below,place above,place ahead,place left,stay,nothing',
    'a model layer\'s menu is what it could do right now, plus "nothing: not for me"');
  dreamCheck(menuFor('make', lObs({ inventory: [{ name: 'wheat', count: 3 }], tableNear: true })).some((m) => m.key === 'craft bread'), 'Make\'s menu offers bread when it carries wheat by a table');
  dreamCheck(!menuFor('shelter', lObs({ affordances: lAff({}) })).some((m) => m.key === 'stay'), 'by day, out in the open, staying put is not on Shelter\'s menu');
  const mAsked = [];
  const mFetch = async (url, opts) => { const body = JSON.parse(opts.body); mAsked.push(body); const i = Math.max(0, body.acts.findIndex((t) => /dig down/.test(t))); return { ok: true, json: async () => ({ pick: i, p: 0.8, probs: [0.8], ms: 40, model: 'test' }) }; };
  let mClock = 2000000;
  const mModels = createModelLayers({ mode: 'shadow', fetchImpl: mFetch, memory: { retrieve: async () => [{ title: 'Make A Safe Place Before Dark', text: 'dig in at dusk' }] }, now: () => mClock });
  const mStack = createLayerStack({ random: () => 0.99, modelLayers: mModels });
  const mFirst = mStack(lDrives(), mDusk);
  await new Promise((r) => setTimeout(r, 20));
  mClock += 1500;
  const mSecond = mStack(lDrives(), mDusk);
  const mShelterAsk = mAsked.find((b) => b.layer === 'shelter');
  dreamCheck(!!mShelterAsk && /keeps it safe at night/.test(mShelterAsk.job) && mShelterAsk.memories.length === 1 && mShelterAsk.acts.some((t) => /dig down/.test(t)),
    'each model layer is asked with its job, its own top memories (retrieval) and its menu');
  dreamCheck(!mFirst.shadow || !mFirst.shadow.shelter, 'the body never waits for a model: the first tick goes on without its answer');
  dreamCheck(mSecond.layer === 'shelter' && mSecond.type === 'dig' && mSecond.shadow.shelter.pick === 'dig below' && mSecond.shadow.shelter.hand === 'dig below' && !mSecond.learned,
    'in shadow mode a model layer\'s pick is logged next to the hand-written one, which acts');
  const mOnFetch = async (url, opts) => { const body = JSON.parse(opts.body); const i = body.acts.findIndex((a) => /set a block over my head/.test(a)); return { ok: true, json: async () => ({ pick: Math.max(0, i), p: 0.9, probs: [], ms: 30 }) }; };
  const mOn = createModelLayers({ mode: 'on', fetchImpl: mOnFetch, now: () => mClock });
  const mOnStack = createLayerStack({ random: () => 0.99, modelLayers: mOn });
  mOnStack(lDrives(), mDusk); await new Promise((r) => setTimeout(r, 20)); mClock += 1500;
  const mOnAct = mOnStack(lDrives(), mDusk);
  dreamCheck(mOnAct.layer === 'shelter' && mOnAct.type === 'place' && mOnAct.at === 'above' && mOnAct.learned === 'shelter',
    'in "on" mode the model\'s pick acts (here Shelter roofs over before digging)');
  const mDown = createModelLayers({ mode: 'on', fetchImpl: async () => { throw new Error('no service'); }, now: () => mClock });
  const mDownStack = createLayerStack({ random: () => 0.99, modelLayers: mDown });
  mDownStack(lDrives(), mDusk); await new Promise((r) => setTimeout(r, 20));
  dreamCheck(mDownStack(lDrives(), mDusk).type === 'dig', 'with the model service down, the hand-written layers simply carry on');
  // Gather's model chooses WHAT, never WHETHER it's safe (docs/results-7b-trial.md).
  const { gatherSafe } = require('./brain/modelLayers');
  const gDay = lObs({ nearbyItems: [{ name: 'oak_log', distance: 3.2 }] });
  const gNight = lObs({ isDay: false, timeOfDay: 18000, nearbyItems: [{ name: 'oak_log', distance: 3.2 }] });
  const gZombie = lObs({ nearbyItems: [{ name: 'oak_log', distance: 3.2 }], nearbyEntities: [{ name: 'zombie', distance: 6, hostile: true }] });
  dreamCheck(gatherSafe(gDay) && !gatherSafe(gNight) && !gatherSafe(gZombie), 'Gather\'s model is asked only by day with no hostile within 10 blocks');
  const gAsked = [];
  const gModels = createModelLayers({ mode: 'shadow', fetchImpl: async (url, opts) => { const b = JSON.parse(opts.body); gAsked.push(b); return { ok: true, json: async () => ({ pick: 0, p: 0.9, probs: [0.9], ms: 5 }) }; }, now: () => mClock });
  gModels.consider('gather', gDay, lDrives()); await new Promise((r) => setTimeout(r, 20));
  dreamCheck(gAsked.length >= 1 && /Lying on the ground near me: oak log 3 blocks away\./.test(gAsked[0].situation), 'Gather is told what lies on the ground in reach, not only offered it on the menu');
  const gNightModels = createModelLayers({ mode: 'shadow', fetchImpl: async (url, opts) => { gAsked.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ pick: 0, p: 0.9, probs: [0.9], ms: 5 }) }; }, now: () => mClock });
  const gBefore = gAsked.length;
  gNightModels.consider('gather', gNight, lDrives()); await new Promise((r) => setTimeout(r, 20));
  const gNightAns = gNightModels.consider('gather', gNight, lDrives());
  dreamCheck(gAsked.length === gBefore && gNightAns && gNightAns.key === 'nothing' && gNightAns.gated, 'at night Gather\'s model is not asked: its answer is "nothing" (gated)');

  // ---- Stage 2: one model layer acts on its own, learns when it's safe, explores
  {
    const sFetch = async (url, opts) => { const b = JSON.parse(opts.body); const i = b.acts.findIndex((a) => /pick up/.test(a)); const probs = b.acts.map((_, k) => (k === Math.max(0, i) ? 0.7 : 0.3 / (b.acts.length - 1))); return { ok: true, json: async () => ({ pick: Math.max(0, i), p: 0.7, probs, ms: 5 }) }; };
    const s2 = createModelLayers({ mode: 'shadow', modes: { gather: 'on' }, gatherRule: false, explore: 0, fetchImpl: sFetch, now: () => mClock });
    s2.consider('gather', gNight, lDrives()); await new Promise((r) => setTimeout(r, 20));
    const nightAns = s2.consider('gather', gNight, lDrives());
    dreamCheck(nightAns && !nightAns.gated && nightAns.key === 'pickup' && s2.actFor(nightAns, 'gather') && s2.actFor(nightAns, 'gather').type === 'pickup' && s2.actFor(nightAns, 'shelter') === undefined,
      'GATHER_MODE=on with GATHER_RULE=off: Gather alone acts, and decides about night itself');
    const s3 = createModelLayers({ mode: 'shadow', modes: { gather: 'on' }, explore: 0.5, random: () => 0, fetchImpl: sFetch, now: () => mClock });
    s3.consider('gather', gDay, lDrives()); await new Promise((r) => setTimeout(r, 20));
    const exAns = s3.consider('gather', gDay, lDrives());
    const exAct = s3.actFor(exAns, 'gather');
    dreamCheck(exAns && exAns.explored === true && exAns.ranked[1].key !== exAns.key && (exAct === null ? exAns.ranked[1].key === 'nothing' : true) && s3.actFor(exAns, 'gather') === exAct || JSON.stringify(s3.actFor(exAns, 'gather')) === JSON.stringify(exAct),
      'exploring, an acting layer sometimes takes its second choice, decided once per answer');
  }

  // ---- The dig-in instinct doesn't sink forever (2026-11-18: dug a dozen blocks into stone and water)
  {
    const { createReflexes: mkRx } = require('./decision/reflexes');
    const shaft = { isDay: true, timeOfDay: 12100, position: { y: 48 }, affordances: { roof: false, walls: 4, enclosed: false, canDigBelow: true, placeable: ['dirt'], canPlace: ['above'], bed: null } };
    const fresh = mkRx().shelter(shaft); // a fresh dig count (as when it was lost live)
    dreamCheck(fresh && fresh.type === 'place' && fresh.at === 'above', 'in a shaft with no roof, the dig-in instinct seals overhead instead of digging deeper');
    const rx2 = mkRx();
    const bare = (y) => ({ isDay: true, timeOfDay: 12100, position: { y }, affordances: { roof: false, walls: 2, enclosed: false, canDigBelow: true, placeable: [], canPlace: [], bed: null } });
    const acts = [60, 60, 59, 58, 57, 56, 55, 54].map((y) => rx2.shelter(bare(y)).type);
    dreamCheck(acts.filter((t) => t === 'dig').length <= 6 && acts[acts.length - 1] === 'idle', 'with nothing to seal with, it digs at most two blocks more for material, then waits');
    // ...and its other half: by day it climbs back out (2026-11-18: stuck 25 blocks down for days).
    const rx3 = mkRx();
    const morning = (over) => ({ isDay: true, timeOfDay: 1000, position: { y: 40 }, affordances: { roof: false, walls: 4, enclosed: false, canDigBelow: true, placeable: ['dirt'], canPlace: ['above'], bed: null, ...over } });
    const c1 = rx3.shelter(morning({ roof: true, enclosed: true }));
    const c2 = rx3.shelter(morning({}));
    dreamCheck(c1 && c1.type === 'climb' && c2 && c2.type === 'climb' && rx3.shelter(morning({ walls: 2 })) === null && rx3.shelter(morning({ placeable: [] })) === null,
      'by day, down a hole, the shelter instinct climbs out (roof first); not in the open, not with nothing to stand on');
    const rx4 = mkRx();
    let climbsSeen = 0;
    for (let k = 0; k < 80; k++) if ((rx4.shelter(morning({})) || {}).type === 'climb') climbsSeen += 1;
    dreamCheck(climbsSeen === 60, 'climbing out is bounded per day, so a narrow cave can\'t keep it pillaring');
  }

  // ---- Nightly weight writes for the model layers (learn/nightlyWrite.js, gatherLabels.js)
  const qLog = [];
  const qModels = createModelLayers({ mode: 'shadow', logQuestion: (q) => qLog.push(q), fetchImpl: async () => ({ ok: true, json: async () => ({ pick: 0, p: 0.9, probs: [0.9, 0.1], ms: 5, patch: 3 }) }), now: () => mClock });
  qModels.consider('gather', gDay, lDrives()); await new Promise((r) => setTimeout(r, 20));
  const qAns = qModels.consider('gather', gDay, lDrives());
  dreamCheck(qLog.length === 1 && qLog[0].layer === 'gather' && /Lying on the ground/.test(qLog[0].situation) && qLog[0].keys.includes('nothing') && qAns && qAns.patch === 3,
    'each model-layer question is logged as asked, with the patch version that answered');
  const { gatherKey, outcome: gOutcome } = require('./learn/gatherLabels');
  const gTick = (over) => ({ ts: '2026-11-20T10:00:00.000Z', health: 20, inv: 'dirt x2', action: { type: 'idle' }, ...over });
  const gGood = [gTick({ action: { type: 'pickup' } }), ...Array.from({ length: 21 }, (_, k) => gTick({ ts: `2026-11-20T10:00:${String(k + 1).padStart(2, '0')}.000Z`, inv: 'dirt x3' }))];
  const gBad = [gTick({ action: { type: 'pickup' } }), ...Array.from({ length: 21 }, (_, k) => gTick({ ts: `2026-11-20T10:00:${String(k + 1).padStart(2, '0')}.000Z`, health: 20 - Math.min(6, k) }))];
  dreamCheck(gatherKey({ type: 'pickup' }) === 'pickup' && gatherKey({ type: 'dig', at: 'ahead' }) === 'dig ahead' && gatherKey({ type: 'explore' }) === null
    && gOutcome(gGood, 0, true) === 'good' && gOutcome(gBad, 0, true) === 'bad',
    'Gather\'s outcome labels: gathering that filled the pack unharmed is good, gathering then hurt is bad');
  const { runNightlyWrite, due: writeDue } = require('./learn/nightlyWrite');
  {
    const dueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-mind-write-'));
    const first = writeDue('gather', 70, 3, dueDir);
    fs.writeFileSync(path.join(dueDir, 'gather-state.json'), JSON.stringify({ lastMcDay: 68 }));
    dreamCheck(first && !writeDue('gather', 70, 3, dueDir) && writeDue('gather', 71, 3, dueDir),
      'a weight write is due every 3 Minecraft days after the last one (and the first time)');
  }
  const EventEmitter = require('events');
  const spawned = [];
  const fakeSpawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.pid = 4242; p.unref = () => { p.unrefed = true; };
    if (!(opts && opts.detached)) setImmediate(() => { p.stdout.emit('data', '[labels] ok\n'); p.emit('close', 0); });
    spawned[spawned.length - 1].proc = p;
    return p;
  };
  const wRes = await runNightlyWrite({ layers: ['gather'], spawnImpl: fakeSpawn });
  const writeSpawn = spawned.find((x) => x.opts && x.opts.detached);
  dreamCheck(wRes[0].started && writeSpawn && writeSpawn.proc.unrefed && writeSpawn.args.includes('--reload') && /nightly_write\.py$/.test(writeSpawn.args[0]),
    'the nightly weight write runs as its own detached process (an agent restart cannot kill it) and applies its own patch if it passes');

  // ---- Weighted memory and forgetting (docs/design-subsumption.md, stage 2)
  console.log('\n=== Weighted memory ===');
  const memMod = require('./vault/memory');
  const fmM = require('./vault/frontmatter');
  const mVault = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-mind-memory-'));
  const mDir = (d) => { fs.mkdirSync(path.join(mVault, d), { recursive: true }); return path.join(mVault, d); };
  const mNow = new Date('2026-11-20T12:00:00Z');
  const mWrite = (dir, title, data, body) => fs.writeFileSync(path.join(mDir(dir), `${title}.md`), fmM.stringify(data, body));
  const mExp = (iso, title, valence, involves = []) => mWrite('Experiences', `${iso.slice(0, 13).replace(/-/g, '-')}${iso.slice(14, 16)} - ${title}`,
    { is_a: '[[Event]]', timestamp: iso, ...(involves.length ? { involves: involves.map((t) => `[[${t}]]`) } : {}), tags: [`valence/${valence}`] },
    `I ${title.toLowerCase()}.`);
  for (let i = 0; i < 6; i++) mExp(`2026-11-1${i < 3 ? 6 : 7}T0${i}:00:00Z`, 'Took Damage From Unknown Cause', 'negative');
  mExp('2026-11-16T09:00:00Z', 'Wandered Near The Pond', 'neutral');
  mExp('2026-11-16T10:00:00Z', 'Saw A Cow In The Field', 'neutral', ['Cow']);
  mExp('2026-11-20T11:00:00Z', 'Dug In At Dusk', 'positive');
  mWrite('Goals', 'Close Myself In At Dusk', { is_a: '[[Goal]]', status: 'active' }, 'At dusk I want walls and a roof around me before the zombies come.');
  mWrite('Goals', 'Old Finished Goal About Dusk Walls', { is_a: '[[Goal]]', status: 'done' }, 'At dusk walls and a roof around me.');
  mWrite('Concepts/Entity', 'Cow', { valence: 0.4, encounter_count: 200 }, 'A cow.');

  dreamCheck(memMod.initialWeight('experience', { tags: ['valence/negative'] }, 'Died By Day') > memMod.initialWeight('experience', { tags: ['valence/neutral'] }, 'Walked') &&
    memMod.initialWeight('goal', { status: 'active' }) > memMod.initialWeight('goal', { status: 'done' }) &&
    memMod.initialWeight('experience', { weight: 0.77 }) === 0.77,
    'notes without a weight start from what they say (felt and deadly moments, active goals weigh more); a written weight wins');
  const mem = createMemoryForSim();
  function createMemoryForSim() { return memMod.createMemory({ vaultPath: mVault, now: () => mNow.getTime() }); }
  mem.refresh();
  const mStats = mem.stats();
  dreamCheck(mStats.notes === 12 && mStats.byKind.experience === 9 && mStats.similarity === 'words', 'the index holds every kind of note, and falls back to word overlap with no embedding model');
  const mHits = await mem.retrieve('it is dusk and I have no walls', { layer: 'shelter', k: 3 });
  dreamCheck(mHits[0] && mHits[0].title === 'Close Myself In At Dusk', 'retrieval ranks the relevant AND important note first (the active goal beats the finished one with the same words)');
  const mCow = await mem.retrieve('hungry, a cow nearby', { layer: 'forage', k: 2 });
  dreamCheck(mCow.some((h) => h.title === 'Cow'), 'a layer\'s question finds the things it is about');

  const mForget = memMod.forget(mVault, { replay: new Set(['Cow']), now: mNow, budget: 5, maxArchive: 100 });
  const mLive = fs.readdirSync(path.join(mVault, 'Experiences'));
  const mArch = fs.existsSync(path.join(mVault, 'Archive', 'Experiences')) ? fs.readdirSync(path.join(mVault, 'Archive', 'Experiences')) : [];
  dreamCheck(mLive.length === 5 && mArch.length === 4 && mForget.archived === 4 && mForget.live === 5,
    'over budget, the weakest Experiences leave live memory: 9 become 5 live + 4 archived, nothing deleted');
  dreamCheck(mLive.some((f) => f.includes('Dug In At Dusk')), 'a fresh Experience (under a day old) is never forgotten that night');
  const mFind = (word) => { const live = mLive.find((f) => f.includes(word)); const arch = mArch.find((f) => f.includes(word));
    return fmM.parse(fs.readFileSync(live ? path.join(mVault, 'Experiences', live) : path.join(mVault, 'Archive', 'Experiences', arch), 'utf8')).data; };
  const mPond = mArch.find((f) => f.includes('Pond'));
  dreamCheck(mFind('Cow').weight > mFind('Pond').weight && !!mPond, 'what was met again (the cow) is pulled back above the unremarkable (the pond), which fades first');
  const mGistFiles = fs.readdirSync(path.join(mVault, 'Gists'));
  const mGist = mGistFiles.find((f) => f.startsWith('Wandered Near The Pond'));
  const mGistData = mGist && fmM.parse(fs.readFileSync(path.join(mVault, 'Gists', mGist), 'utf8')).data;
  dreamCheck(!!mGistData && mGistData.episodes === 1 && mGistData.tentative === true && /Pond/.test(String(mGistData.from_episodes)),
    'archived episodes fold into a gist note that links back to them; one episode makes a tentative gist');
  const mArchData = fmM.parse(fs.readFileSync(path.join(mVault, 'Archive', 'Experiences', mPond), 'utf8')).data;
  dreamCheck(!!mArchData.archived_on && !!mArchData.archived_why && /Pond/.test(mArchData.gist), 'an archived note says when and why it left, and which gist holds it');
  // Many of the same moment fold into one gist that is no longer tentative.
  const mForget2 = memMod.forget(mVault, { now: new Date('2026-11-25T12:00:00Z'), budget: 1, maxArchive: 100 });
  const mDamage = fmM.parse(fs.readFileSync(path.join(mVault, 'Gists', 'Took Damage From Unknown Cause.md'), 'utf8')).data;
  dreamCheck(mDamage.episodes >= 3 && mDamage.tentative === false && mDamage.negative === mDamage.episodes,
    'repeated moments become one gist with a tally ("went badly" N times), no longer tentative');
  dreamCheck(mForget2.archived <= 100 && memMod.forget(mVault, { now: new Date('2026-11-26T12:00:00Z'), budget: 0, maxArchive: 1 }).archived <= 1,
    'no sudden amnesia: at most maxArchive notes leave per sleep');
  const mBack = mPond.replace(/\.md$/, '');
  dreamCheck(memMod.restore(mVault, mBack) && fs.existsSync(path.join(mVault, 'Experiences', mPond)) && !fs.existsSync(path.join(mVault, 'Archive', 'Experiences', mPond)),
    'an archived memory can come back to live memory (reconsolidation)');
  mem.refresh();
  dreamCheck(mem.stats().byKind.gist >= 2, 'gists are part of live memory, and retrieval can find them');
  console.log('\n=== Sample notes ===');
  const sampleStrategy = rates.sort((a, b) => a.rate - b.rate)[0];
  for (const rel of [
    'Concepts/Entity/Mob/Hostile Mob/Zombie.md',
    ...(sampleStrategy ? [`Concepts/Abstract/Strategy/${sampleStrategy.note}`] : []),
    'State/Current State.md',
  ]) {
    console.log(`\n--- ${rel} ---`);
    console.log(fs.readFileSync(path.join(vaultPath, rel), 'utf8'));
  }
  const lastExp = experiences.sort()[experiences.length - 1];
  console.log(`\n--- Experiences/${lastExp} ---`);
  console.log(fs.readFileSync(path.join(vaultPath, 'Experiences', lastExp), 'utf8'));

  if (yamlErrors || missing || strategyFail || dreamFail) {
    console.error('\nSIMULATION FAILED — see errors above.');
    process.exit(1);
  }
  console.log('Simulation passed. Open the temp vault above in Obsidian to inspect it.');
}

main().catch((err) => {
  console.error('Simulation crashed:', err);
  process.exit(1);
});
