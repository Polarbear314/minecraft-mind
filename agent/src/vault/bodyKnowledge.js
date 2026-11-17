// What the body has learned about itself by trying: which things go down when
// eaten, and which don't. Before this, edibility was a hand-written list of six
// cooked or farmed foods — so a starving bot carrying rotten flesh was told
// "your body knows it can eat: none", and when the cortex chose to eat anyway
// the choice was silently swapped for wandering (2026-11-16). Now the body may
// put anything it carries in its mouth; what happens is remembered here, in
// State/What My Body Knows.md, and instinct eats only what has gone down before.
//
// Learning is asymmetric, like a real body's: one success is proof (food that
// went down IS food, and stays food), but one failure is not — a bite can be
// cut short. A thing is marked "won't go down" only after MISSES_TO_REJECT
// failed tries and no success.
const fs = require('fs');
const path = require('path');
const fm = require('./frontmatter');

const FILE = path.join('State', 'What My Body Knows.md');
const MISSES_TO_REJECT = 2;

function read(vaultPath) {
  try {
    const { data } = fm.parse(fs.readFileSync(path.join(vaultPath, FILE), 'utf8'));
    return {
      edible: Array.isArray(data.edible) ? data.edible.map(String) : [],
      inedible: Array.isArray(data.inedible) ? data.inedible.map(String) : [],
      misses: data.misses && typeof data.misses === 'object' ? { ...data.misses } : {},
    };
  } catch (_) {
    return { edible: [], inedible: [], misses: {} };
  }
}

/** Things the body has eaten successfully (a Set of item names). */
function knownEdible(vaultPath) {
  return new Set(read(vaultPath).edible);
}

/** Things that would not go down, after repeated tries (a Set of item names). */
function knownInedible(vaultPath) {
  return new Set(read(vaultPath).inedible);
}

function write(vaultPath, k, timestamp) {
  const file = path.join(vaultPath, FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = { edible: k.edible.sort(), inedible: k.inedible.sort(), updated: timestamp.toISOString(), tags: ['type/state'] };
  if (Object.keys(k.misses).length) data.misses = k.misses;
  const body = 'What my body has learned by trying.\n\n' +
    `Things that went down when I ate them: ${k.edible.length ? k.edible.join(', ').replace(/_/g, ' ') : 'none yet'}.\n\n` +
    `Things that would not go down, however I tried: ${k.inedible.length ? k.inedible.join(', ').replace(/_/g, ' ') : 'none yet'}.`;
  fs.writeFileSync(file, fm.stringify(data, body), 'utf8');
}

/**
 * Remember how an attempt to eat `name` went. Returns true if this changed
 * what the body knows. Never throws — a failed write must not disturb the tick.
 */
function learnEdible(vaultPath, name, edible, timestamp = new Date()) {
  try {
    const k = read(vaultPath);
    let changed = false;
    if (edible) {
      if (!k.edible.includes(name)) { k.edible.push(name); changed = true; }
      const i = k.inedible.indexOf(name);
      if (i !== -1) { k.inedible.splice(i, 1); changed = true; } // proof beats doubt
      if (k.misses[name]) { delete k.misses[name]; changed = true; }
    } else {
      if (k.edible.includes(name)) return false; // it has gone down before: a miss proves nothing
      k.misses[name] = (Number(k.misses[name]) || 0) + 1;
      changed = true;
      if (k.misses[name] >= MISSES_TO_REJECT && !k.inedible.includes(name)) {
        k.inedible.push(name);
        delete k.misses[name];
      }
    }
    if (changed) write(vaultPath, k, timestamp);
    return changed;
  } catch (_) {
    return false;
  }
}

module.exports = { knownEdible, knownInedible, learnEdible, MISSES_TO_REJECT };
