// Maps raw Minecraft names (entity.name / block.name / item.name from mineflayer)
// to an Ontology class path and base drive weights (the agent's "priors").
//
// classPath mirrors the vault: a zombie Concept is written to
//   Concepts/Entity/Mob/Hostile Mob/Zombie.md
//
// Drive weights are 0..1. hunger means "satisfies hunger" and contributes
// POSITIVELY to valence (design decision: the agent learns to like what feeds it).
//
// FALLBACK BEHAVIOR: anything not listed here must NOT crash the agent. Unknown
// entities are treated as Neutral Mob (cautious: mildly feared, quite curious),
// unknown blocks as Terrain Block, unknown items as Material. To teach the agent
// about a new thing properly, just add a row to the right table below — nothing
// else needs to change.

const ENTITIES = {
  zombie:   { classPath: 'Entity/Mob/Hostile Mob', drives: { fear: 0.7, hunger: 0.0, curiosity: 0.1 } },
  skeleton: { classPath: 'Entity/Mob/Hostile Mob', drives: { fear: 0.7, hunger: 0.0, curiosity: 0.1 } },
  spider:   { classPath: 'Entity/Mob/Hostile Mob', drives: { fear: 0.5, hunger: 0.0, curiosity: 0.2 } },
  creeper:  { classPath: 'Entity/Mob/Hostile Mob', drives: { fear: 0.9, hunger: 0.0, curiosity: 0.1 } },
  enderman: { classPath: 'Entity/Mob/Hostile Mob', drives: { fear: 0.6, hunger: 0.0, curiosity: 0.4 } },
  drowned:  { classPath: 'Entity/Mob/Hostile Mob', drives: { fear: 0.6, hunger: 0.0, curiosity: 0.1 } },

  cow:      { classPath: 'Entity/Mob/Passive Mob', drives: { fear: 0.0, hunger: 0.5, curiosity: 0.2 } },
  pig:      { classPath: 'Entity/Mob/Passive Mob', drives: { fear: 0.0, hunger: 0.5, curiosity: 0.2 } },
  sheep:    { classPath: 'Entity/Mob/Passive Mob', drives: { fear: 0.0, hunger: 0.4, curiosity: 0.2 } },
  chicken:  { classPath: 'Entity/Mob/Passive Mob', drives: { fear: 0.0, hunger: 0.4, curiosity: 0.2 } },
  rabbit:   { classPath: 'Entity/Mob/Passive Mob', drives: { fear: 0.0, hunger: 0.3, curiosity: 0.3 } },
  villager: { classPath: 'Entity/Mob/Passive Mob', drives: { fear: 0.0, hunger: 0.0, curiosity: 0.6 } },

  wolf:     { classPath: 'Entity/Mob/Neutral Mob', drives: { fear: 0.3, hunger: 0.0, curiosity: 0.4 } },
  bee:      { classPath: 'Entity/Mob/Neutral Mob', drives: { fear: 0.2, hunger: 0.0, curiosity: 0.4 } },
};

const BLOCKS = {
  water:          { classPath: 'Object/Block/Terrain Block', drives: { fear: 0.1, hunger: 0.0, curiosity: 0.2 } },
  lava:           { classPath: 'Object/Block/Hazard Block',  drives: { fear: 0.9, hunger: 0.0, curiosity: 0.2 } },
  fire:           { classPath: 'Object/Block/Hazard Block',  drives: { fear: 0.8, hunger: 0.0, curiosity: 0.1 } },
  grass_block:    { classPath: 'Object/Block/Terrain Block', drives: { fear: 0.0, hunger: 0.0, curiosity: 0.05 } },
  dirt:           { classPath: 'Object/Block/Terrain Block', drives: { fear: 0.0, hunger: 0.0, curiosity: 0.05 } },
  stone:          { classPath: 'Object/Block/Terrain Block', drives: { fear: 0.0, hunger: 0.0, curiosity: 0.05 } },
  sand:           { classPath: 'Object/Block/Terrain Block', drives: { fear: 0.0, hunger: 0.0, curiosity: 0.1 } },
  oak_log:        { classPath: 'Object/Resource/Material',   drives: { fear: 0.0, hunger: 0.0, curiosity: 0.3 } },
  coal_ore:       { classPath: 'Object/Resource/Material',   drives: { fear: 0.0, hunger: 0.0, curiosity: 0.4 } },
  iron_ore:       { classPath: 'Object/Resource/Material',   drives: { fear: 0.0, hunger: 0.0, curiosity: 0.5 } },
  diamond_ore:    { classPath: 'Object/Resource/Material',   drives: { fear: 0.0, hunger: 0.0, curiosity: 0.9 } },
  crafting_table: { classPath: 'Object/Structure',           drives: { fear: 0.0, hunger: 0.0, curiosity: 0.6 } },
  furnace:        { classPath: 'Object/Structure',           drives: { fear: 0.0, hunger: 0.0, curiosity: 0.5 } },
  torch:          { classPath: 'Object/Structure',           drives: { fear: 0.0, hunger: 0.0, curiosity: 0.3 } },
};

const ITEMS = {
  apple:           { classPath: 'Object/Resource/Food', drives: { fear: 0.0, hunger: 0.6, curiosity: 0.1 } },
  bread:           { classPath: 'Object/Resource/Food', drives: { fear: 0.0, hunger: 0.7, curiosity: 0.1 } },
  cooked_beef:     { classPath: 'Object/Resource/Food', drives: { fear: 0.0, hunger: 0.8, curiosity: 0.1 } },
  cooked_porkchop: { classPath: 'Object/Resource/Food', drives: { fear: 0.0, hunger: 0.8, curiosity: 0.1 } },
  cooked_chicken:  { classPath: 'Object/Resource/Food', drives: { fear: 0.0, hunger: 0.7, curiosity: 0.1 } },
  carrot:          { classPath: 'Object/Resource/Food', drives: { fear: 0.0, hunger: 0.5, curiosity: 0.1 } },
};

// Cautious defaults for anything unknown (see FALLBACK BEHAVIOR note above).
// 'player': other people in the world (identified by username). Not feared,
// deeply curious — but like everything else, the relationship is EARNED:
// the prior is only a first impression, and encounters do the rest.
const FALLBACKS = {
  entity: { classPath: 'Entity/Mob/Neutral Mob',      drives: { fear: 0.3, hunger: 0.0, curiosity: 0.5 } },
  block:  { classPath: 'Object/Block/Terrain Block',  drives: { fear: 0.0, hunger: 0.0, curiosity: 0.2 } },
  item:   { classPath: 'Object/Resource/Material',    drives: { fear: 0.0, hunger: 0.0, curiosity: 0.3 } },
  player: { classPath: 'Entity/Person',               drives: { fear: 0.0, hunger: 0.0, curiosity: 0.7 } },
};

const TABLES = { entity: ENTITIES, block: BLOCKS, item: ITEMS, player: {} };

/** Look up a raw Minecraft name. kind is 'entity' | 'block' | 'item' | 'player'. Never throws. */
function lookup(kind, rawName) {
  const table = TABLES[kind] || {};
  return table[rawName] || FALLBACKS[kind] || FALLBACKS.entity;
}

/** True if this entity name is a known hostile mob. */
function isHostile(rawName) {
  const entry = ENTITIES[rawName];
  return !!entry && entry.classPath.endsWith('Hostile Mob');
}

/** Item names the agent recognizes as edible. */
const FOOD_ITEMS = new Set(Object.keys(ITEMS));

/** Block names worth noticing during the tick's block scan. */
const INTERESTING_BLOCKS = Object.keys(BLOCKS);

module.exports = { lookup, isHostile, FOOD_ITEMS, INTERESTING_BLOCKS };
