// What MindBot is born knowing (phase 2, docs/design-born-knowing.md).
//
// Phase 1 showed it could reason its way to the right ideas but not turn them
// into skills from a few bits per death. No animal learns survival from
// scratch in one lifetime: instincts carry what earlier generations learned.
// These notes are that inheritance — FACTS about how the world works, never
// instructions about what to do with a life. They live in Inheritance/ in the
// vault, marked `given_by: nature`, so what it was born knowing always stays
// distinguishable from what it learned.
const fs = require('fs');
const path = require('path');
const fm = require('./frontmatter');

const DIR = 'Inheritance';

const NOTES = [
  {
    title: 'Food',
    body: 'Cows, pigs, sheep and chickens give meat when they are struck down; I have to gather what they drop. ' +
      'Raw meat can be eaten, and meat cooked over fire feeds far more. The village fields give wheat, which ' +
      'becomes bread, and carrots and potatoes. Apples sometimes fall from trees. Rotten flesh fills a little but ' +
      'can sicken me. Bones, sticks, string, seeds and arrows are not food.',
  },
  {
    title: 'Night',
    body: 'Monsters come out in the dark. Being closed in on every side with a roof over my head keeps them out, and ' +
      'so does a house with its door shut. Lying in a bed at night lets the night pass. Light keeps monsters from ' +
      'appearing close by. Zombies and skeletons burn in the morning sun.',
  },
  {
    title: 'Danger',
    body: 'Lava burns. Creepers hiss and then explode; when one comes close I should move away. Skeletons shoot from ' +
      'a distance; something solid between us stops their arrows. Long falls hurt. Water can drown me if I stay ' +
      'under too long.',
  },
  {
    title: 'Making',
    body: 'Striking a tree gives logs. Logs become planks. Planks make a crafting table and sticks. Planks and sticks ' +
      'make wooden tools, and a wooden pickaxe can break stone. Stone makes better tools and a furnace, and a ' +
      'furnace cooks food. Coal and sticks make torches. Some things can only be made beside a crafting table.',
  },
  {
    title: 'The Village',
    body: 'Villagers are peaceful. The iron golem guards the village and fights monsters. Village houses have beds ' +
      'and doors.',
  },
];

/** Everything the body knows is food by nature (Food note), as item names. */
const EDIBLE_BY_NATURE = [
  'apple', 'bread', 'carrot', 'potato', 'baked_potato', 'beetroot', 'melon_slice', 'sweet_berries', 'cookie',
  'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon',
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
];

/** Animals that give meat (the hunting reflex's prey). */
const FOOD_ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];

/** Drops of those animals worth gathering. */
const MEAT_DROPS = ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit'];

/** Crops, as blocks, with the age at which they are ripe (2026-11-17: the bot
 * walked past carrots and wheat because crops weren't something it could see). */
const CROPS = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };

/** What crops (and animals) leave on the ground that is worth picking up. */
const FOOD_DROPS = [...MEAT_DROPS, 'wheat', 'carrot', 'potato', 'beetroot', 'apple', 'sweet_berries'];

/** Write any inheritance note that is missing. Never overwrites. Returns titles written. */
function ensureInheritance(vaultPath, timestamp = new Date()) {
  const written = [];
  const dir = path.join(vaultPath, DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const n of NOTES) {
    const file = path.join(dir, `${n.title}.md`);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, fm.stringify({
      is_a: fm.link('Inherited Knowledge'),
      given_by: 'nature',
      given_on: timestamp.toISOString().slice(0, 10),
      tags: ['type/inheritance'],
    }, n.body), 'utf8');
    written.push(n.title);
  }
  return written;
}

/** Prompt lines for "What you were born knowing", read from the vault (or null). */
function inheritanceLines(vaultPath) {
  let files;
  try {
    files = fs.readdirSync(path.join(vaultPath, DIR)).filter((f) => f.endsWith('.md')).sort();
  } catch (_) {
    return null;
  }
  const lines = [];
  for (const f of files) {
    try {
      const { body } = fm.parse(fs.readFileSync(path.join(vaultPath, DIR, f), 'utf8'));
      lines.push(`- ${f.slice(0, -3)}: ${String(body).trim().replace(/\s+/g, ' ')}`);
    } catch (_) { /* skip */ }
  }
  return lines.length ? lines.join('\n') : null;
}

module.exports = { ensureInheritance, inheritanceLines, EDIBLE_BY_NATURE, FOOD_ANIMALS, MEAT_DROPS, CROPS, FOOD_DROPS, NOTES, DIR };
