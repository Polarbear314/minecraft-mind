// The tick orchestrator: perceive -> scan blocks -> update drives -> decide ->
// ACT -> then journal (encounters, experiences, strategies, state) while the
// body is already moving. Acting before writing matters: the bot once stood
// still doing bookkeeping and consulting Claude, which is dangerous at night.
const fs = require('fs');
const { perceive } = require('./perception/perceive');
const { decide } = require('./decision/decide');
const { execute } = require('./actions/actions');
const { recordEncounter, ensureLocation } = require('./vault/conceptStore');
const { recordStrategyOutcome } = require('./vault/strategyStore');
const { createOutcomeTracker } = require('./decision/outcomeTracker');
const { logExperience } = require('./vault/experienceLog');
const { updateDrive } = require('./vault/driveStore');
const { updateCurrentState } = require('./vault/stateStore');
const { INTERESTING_BLOCKS, lookup } = require('./vault/ontologyMap');
const { titleCase, conceptPath } = require('./vault/paths');
const { foundingGoalTitle } = require('./vault/goalStore');
const { setIntention } = require('./vault/intentionStore');

const DAMAGE_ATTRIBUTION_RANGE = 4; // blocks: a hostile this close gets blamed for damage
const THREAT_RANGE = 10; // blocks: only hostiles this close raise the Fear drive
const MAX_BLOCKS_PER_TICK = 5;

// Previous health per bot, for damage detection across ticks.
const lastHealth = new WeakMap();

// Previous inventory per bot (name -> count): gained items — dug out, picked
// up, crafted into being — are encounters like anything else. The agent isn't
// told where they came from; it just finds itself holding something new.
const lastInventories = new WeakMap();

// One outcome tracker per bot, for action-outcome learning across ticks.
const trackers = new WeakMap();

// The founding goal ("Live A Good Life"), given by the user before first
// spawn. Identified by its frontmatter (the one goal without a `serves` link),
// NOT by sort order — dreaming writes self-authored subgoals into Goals/ and
// an alphabetically-early subgoal must never shadow the founding goal.
let foundingGoal; // cached; undefined = not looked up yet
function getFoundingGoal(vaultPath) {
  if (foundingGoal !== undefined) return foundingGoal;
  foundingGoal = foundingGoalTitle(vaultPath);
  return foundingGoal;
}

/**
 * Scan for interesting nearby blocks. Returns [{ name, distance, position }],
 * one entry per block type (the nearest instance), so the decision layer can
 * both know a hazard exists and know where it is — this is what lets learned
 * block fear (e.g. Lava at valence -0.84) actually reach behavior.
 */
function scanBlocks(bot) {
  if (typeof bot.findBlocks !== 'function') return [];
  let matching;
  if (bot.registry && bot.registry.blocksByName) {
    // Real mineflayer: match by numeric block ids.
    matching = INTERESTING_BLOCKS.map((n) => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id)
      .filter((id) => id != null);
  } else {
    // Mock bot: match by predicate on the block object.
    matching = (block) => !!block && INTERESTING_BLOCKS.includes(block.name);
  }
  let positions = [];
  try {
    positions = bot.findBlocks({ matching, maxDistance: 8, count: 32 }) || [];
  } catch (_) {
    return [];
  }
  const me = bot.entity && bot.entity.position;
  const byName = new Map();
  for (const p of positions) {
    const block = bot.blockAt && bot.blockAt(p);
    if (!block || !block.name || !INTERESTING_BLOCKS.includes(block.name)) continue;
    const distance = me && typeof p.distanceTo === 'function'
      ? Math.round(p.distanceTo(me) * 10) / 10
      : null;
    const existing = byName.get(block.name);
    if (!existing || (distance != null && (existing.distance == null || distance < existing.distance))) {
      byName.set(block.name, { name: block.name, distance, position: p });
    }
  }
  return [...byName.values()].slice(0, MAX_BLOCKS_PER_TICK);
}

/** Current biome name via the block under the agent, or null. */
function currentBiome(bot) {
  try {
    const block = bot.blockAt && bot.entity && bot.blockAt(bot.entity.position);
    if (block && block.biome && block.biome.name) return block.biome.name;
  } catch (_) { /* biome data unavailable — fine */ }
  return null;
}

/**
 * One full think-act cycle. Returns a summary object (used by simulate.js).
 * opts.decide: optional replacement decision function (sync or async) with the
 * same signature as the rule-based decide() — this is how the LLM layer plugs in.
 */
async function tick(bot, drives, vaultPath, opts = {}) {
  const now = new Date();
  const observation = perceive(bot);

  // Damage detection: compare health against last tick.
  const prev = lastHealth.has(bot) ? lastHealth.get(bot) : observation.health;
  const tookDamage = observation.health < prev;
  lastHealth.set(bot, observation.health);

  const biome = currentBiome(bot);

  // Gather everything noticed this tick, for co_occurs_with cross-links.
  // Blocks are also attached to the observation so the decision layer
  // (rules and Claude alike) can see and react to them.
  const nearbyBlocks = scanBlocks(bot);
  observation.nearbyBlocks = nearbyBlocks;

  // Words heard since the last tick (the world's chat): guidance is perception
  // too. The recent lines ride on the observation so the decision layer —
  // Claude via buildPrompt — can weigh them; rules are deaf and stay that way.
  const heard = opts.chat ? opts.chat.drain() : [];
  observation.chatLines = opts.chat ? opts.chat.promptLines(now.getTime()) : null;

  const noticed = [
    ...observation.nearbyEntities.map((e) => ({ kind: e.isPlayer ? 'player' : 'entity', name: e.name, entity: e })),
    ...nearbyBlocks.map((b) => ({ kind: 'block', name: b.name })),
  ];
  const allTitles = noticed.map((n) => titleCase(n.name));

  // Inventory diff: what appeared among the agent's things since last tick
  // (the fruit of last tick's digging/pickup/crafting, or nothing). The first
  // tick only takes a baseline — spawn inventory isn't a discovery.
  const prevInv = lastInventories.get(bot);
  const invNow = new Map((observation.inventory || []).map((i) => [i.name, i.count]));
  const gainedItems = [];
  if (prevInv) {
    for (const [name, count] of invNow) {
      if (count > (prevInv.get(name) || 0)) gainedItems.push(name);
    }
  }
  lastInventories.set(bot, invNow);

  // Novelty count WITHOUT writing anything yet: cheap existence probes so
  // drives can update before the decision. Newly gained item kinds count as
  // discoveries too — holding a thing for the first time is meeting it.
  const newConceptCount = noticed.filter((thing) => {
    const { classPath } = lookup(thing.kind, thing.name);
    return !fs.existsSync(conceptPath(vaultPath, classPath, titleCase(thing.name)));
  }).length + gainedItems.filter((name) => {
    const { classPath } = lookup('item', name);
    return !fs.existsSync(conceptPath(vaultPath, classPath, titleCase(name)));
  }).length;

  // Update drives, decide, and ACT — before any vault writes. The action is
  // a pathfinder goal, so the body is already moving while everything below
  // journals what happened. The bot must never stand still to write its diary.
  drives.update({
    food: observation.food,
    tookDamage,
    hostilesNearby: observation.nearbyEntities.filter((e) => e.hostile && e.distance <= THREAT_RANGE).length,
    isDark: !observation.isDay,
    newConceptCount,
  });
  const action = await (opts.decide || decide)(drives, observation);
  await execute(bot, action);

  // Speaking: if the decision carried words, say them aloud in chat for
  // whoever is present. Fire-and-forget — a lost word must not break the tick.
  if (action.say && typeof bot.chat === 'function') {
    try {
      bot.chat(String(action.say).slice(0, 256));
    } catch (_) { /* the world swallowed the words — fine */ }
  }

  // ---------- Bookkeeping: the vault catches up while the body moves ----------

  const locationTitle = biome ? ensureLocation(vaultPath, biome, 'Biome') : null;
  const locatedIn = locationTitle ? [locationTitle] : [];

  // Learning by watching: an observer turns other beings' world-state deltas
  // into beliefs + self-authored goals. Runs beside the body (fire-and-forget,
  // like dreaming) — it never blocks the tick and never throws.
  if (opts.observer) {
    try {
      opts.observer.observe(observation, { now, locatedIn, chatLines: observation.chatLines });
    } catch (_) { /* watching must never break the tick */ }
  }

  // Record encounters. Damage is attributed to hostile entities close enough
  // to plausibly have caused it.
  const results = [];
  for (const thing of noticed) {
    const title = titleCase(thing.name);
    const blamed = tookDamage && thing.entity && thing.entity.hostile &&
      thing.entity.distance <= DAMAGE_ATTRIBUTION_RANGE;
    const result = recordEncounter(vaultPath, thing.kind, thing.name, {
      timestamp: now,
      tookDamage: blamed,
      locatedIn,
      coOccursWith: allTitles.filter((t) => t !== title),
    });
    results.push({ ...result, blamed });
  }

  // Experiences: only notable events — first encounters, valence-band
  // crossings, damage. Never routine ticks.
  for (const r of results) {
    if (r.isFirstEncounter) {
      logExperience(vaultPath, {
        title: `First ${r.title} Encounter`,
        timestamp: now,
        involves: [r.title],
        locatedIn,
        causes: r.blamed ? ['Fear'] : [],
        deltas: r.blamed ? { fear_delta: 1.0 } : {},
        valenceBand: r.band,
        body: `First encounter with ${r.title}${locationTitle ? ` in ${locationTitle}` : ''}.` +
          (r.blamed ? ' It attacked immediately.' : ''),
      });
    } else if (r.blamed) {
      logExperience(vaultPath, {
        title: `Hurt By ${r.title}`,
        timestamp: now,
        involves: [r.title],
        locatedIn,
        causes: ['Fear'],
        deltas: { fear_delta: 1.0 },
        valenceBand: 'negative',
        body: `Took damage from ${r.title} (health ${observation.health}).`,
      });
    } else if (r.crossedBand) {
      logExperience(vaultPath, {
        title: `${r.title} Now Feels ${r.band.charAt(0).toUpperCase() + r.band.slice(1)}`,
        timestamp: now,
        involves: [r.title],
        locatedIn,
        deltas: {},
        valenceBand: r.band,
        body: `After repeated encounters, valence toward ${r.title} crossed into the ${r.band} band (${r.valence}).`,
      });
    }
  }

  // Damage with no attributable hostile still matters (fall, drowning, lava...).
  if (tookDamage && !results.some((r) => r.blamed)) {
    logExperience(vaultPath, {
      title: 'Took Damage From Unknown Cause',
      timestamp: now,
      locatedIn,
      causes: ['Fear'],
      deltas: { fear_delta: 0.5 },
      valenceBand: 'negative',
      body: `Health dropped to ${observation.health} with no obvious attacker nearby.`,
    });
  }

  // Words spoken to the agent become encounters with the speaker (a Person
  // concept) and an Experience carrying exactly what was said — guidance
  // enters the vault as memory, never as configuration. Dreams can chew on it.
  for (const msg of heard) {
    const speaker = recordEncounter(vaultPath, 'player', msg.username, { timestamp: now, locatedIn });
    const snippet = msg.message.length > 60 ? `${msg.message.slice(0, 57)}...` : msg.message;
    logExperience(vaultPath, {
      title: `${speaker.title} Said ${snippet}`,
      timestamp: now,
      involves: [speaker.title],
      locatedIn,
      causes: speaker.isFirstEncounter ? ['Curiosity'] : [],
      deltas: {},
      valenceBand: speaker.band,
      body: `${speaker.title} said: "${msg.message}"`,
    });
  }

  // Things gained since last tick become item encounters. First-time holdings
  // get an Experience — the moment the world put something new in its hands,
  // whether dug free, picked up, or crafted into being.
  for (const name of gainedItems) {
    const got = recordEncounter(vaultPath, 'item', name, { timestamp: now, locatedIn });
    if (got.isFirstEncounter) {
      logExperience(vaultPath, {
        title: `Now Carrying ${got.title}`,
        timestamp: now,
        involves: [got.title],
        locatedIn,
        deltas: {},
        valenceBand: got.band,
        body: `Found myself carrying ${got.title} for the first time.`,
      });
    }
  }

  // Eating is itself an encounter with a Food concept (positive valence).
  if (action.type === 'eat') {
    const eaten = recordEncounter(vaultPath, 'item', action.item, { timestamp: now, locatedIn });
    if (eaten.isFirstEncounter) {
      logExperience(vaultPath, {
        title: `First Taste Of ${eaten.title}`,
        timestamp: now,
        involves: [eaten.title],
        locatedIn,
        causes: ['Hunger'],
        deltas: { hunger_delta: -0.5 },
        valenceBand: eaten.band,
        body: `Ate ${eaten.title} for the first time.`,
      });
    }
  }

  // Action-outcome learning: attribute this tick's signals to the strategy in
  // progress; when the window closes (action change, day/night flip, or the
  // tick window elapsing), score it and write the Strategy note. Striking
  // outcomes — a decisive first attempt or an effectiveness-band crossing —
  // also get an Experience note.
  let strategy = null;
  let tracker = trackers.get(bot);
  if (!tracker) {
    tracker = createOutcomeTracker();
    trackers.set(bot, tracker);
  }
  const outcome = tracker.track({
    actionType: action.type,
    context: observation.isDay ? 'day' : 'night',
    observation,
    fear: drives.fear,
    tookDamage,
    newConceptCount,
    now,
  });
  if (outcome) {
    strategy = recordStrategyOutcome(vaultPath, { ...outcome, timestamp: now });
    const striking = outcome.label !== 'neutral' && (strategy.isFirstAttempt || strategy.crossedBand);
    if (striking) {
      const title = strategy.crossedBand && !strategy.isFirstAttempt
        ? `${strategy.title} Now Seems ${strategy.band.charAt(0).toUpperCase() + strategy.band.slice(1)}`
        : `${strategy.title} ${outcome.label === 'success' ? 'Worked Well' : 'Went Badly'}`;
      logExperience(vaultPath, {
        title,
        timestamp: now,
        involves: [strategy.title],
        locatedIn,
        deltas: {},
        valenceBand: outcome.label === 'success' ? 'positive' : 'negative',
        body: `${outcome.summary} Success rate for ${strategy.title} is now ` +
          `${Math.round(strategy.successRate * 100)}% over ${strategy.attemptCount} attempt(s).`,
      });
    }
  }

  // Persist working memory.
  updateDrive(vaultPath, 'Hunger', drives.hunger);
  updateDrive(vaultPath, 'Fear', drives.fear, 0.85);
  updateDrive(vaultPath, 'Curiosity', drives.curiosity);
  updateCurrentState(vaultPath, {
    drives: drives.levels(),
    dominant: drives.dominant(),
    position: observation.position,
    action,
    location: locationTitle,
    health: observation.health,
    food: observation.food,
    isDay: observation.isDay,
    goal: getFoundingGoal(vaultPath),
    thought: action.thought || null,
  });

  // Intention (Phase C): if the decision carried one — set, changed, or
  // abandoned (empty string) — persist it. Absent field = keep holding it.
  if (action.intention !== undefined) {
    setIntention(vaultPath, action.intention, now);
  }

  // Dreaming: give the background reflection pass a chance to start. maybe()
  // returns immediately — the dream (if any) runs while the body keeps living.
  // Never await anything dream-related in the tick path.
  if (opts.dreamer) {
    try {
      opts.dreamer.maybe({ isDay: observation.isDay });
    } catch (_) { /* dreams fail silently */ }
  }

  return {
    action,
    results,
    tookDamage,
    newConceptCount,
    drives: drives.levels(),
    strategy: strategy ? { title: strategy.title, label: outcome.label, successRate: strategy.successRate } : null,
  };
}

module.exports = { tick, getFoundingGoal };
