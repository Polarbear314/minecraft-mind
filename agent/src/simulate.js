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
  const growth = createWorldGrowth({ vaultPath, startSize: 128, log: quietLog, rcon: { command: async (c) => { cmds.push(c); return ''; } } });
  await growth.onNight({ survived: true });
  await growth.onNight({ survived: false });
  await growth.onNight({ survived: true });
  await growth.onNight({ survived: true });
  dreamCheck(cmds.length === 0 && growth.state().streak === 2, 'a death resets the streak; two good nights are not yet enough');
  await growth.onNight({ survived: true });
  dreamCheck(cmds[0] === 'worldborder set 256' && growth.state().size === 256 && growth.state().streak === 0,
    'three nights survived in a row: the world doubles (128 → 256)');
  dreamCheck(fs.readdirSync(path.join(vaultPath, 'Experiences')).some((f) => f.includes('The World Grew Wider')), 'and the mind remembers the world growing');
  const flaky = createWorldGrowth({ vaultPath, startSize: 128, log: quietLog, rcon: { command: async () => { throw new Error('down'); } } });
  for (let i = 0; i < 3; i += 1) await flaky.onNight({ survived: true });
  dreamCheck(flaky.state().size === 256 && flaky.state().streak === 3, 'if the server can\'t be reached, the streak is kept and the next dawn retries');
  const late = createWorldGrowth({ vaultPath, startSize: 128, log: quietLog, rcon: { command: async (c) => { cmds.push(c); return ''; } } });
  fs.writeFileSync(path.join(vaultPath, 'State', 'World.md'), '---\nborder_size: 1024\nstreak: 2\n---\nx');
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
