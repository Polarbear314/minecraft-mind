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
  let craftRejected = false;
  try { toAction({ action: 'craft', thought: 't' }, motorObs); } catch (_) { craftRejected = true; }
  dreamCheck(craftRejected, 'craft is not exposed to Claude (deferred with Henry)');

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
