// A world that grows when MindBot makes REAL advancements (docs/design-born-knowing.md §3).
//
// Until 2026-11-16 the border doubled after 3 nights survived in a row. That
// rewarded hiding in a hole, which phase 2's reflexes already do on their own.
// Now the world grows only for something new: a Minecraft advancement the bot
// has earned since the last growth (the game's own record of milestones such
// as making a crafting table, mining stone or sleeping in a bed). Recipe
// unlocks don't count, since picking things up unlocks them. Surviving the
// night is neither needed nor enough.
//
// At each graded dawn the code asks the server to save (RCON `save-all`),
// reads the bot's advancements file (<server>/<level>/advancements/<uuid>.json)
// and, if anything new is done, doubles the border: 128 → 256 → 512 → 1024 →
// the whole world. It never shrinks. The mind only experiences the result, as a
// memory ("The World Grew Wider"). State lives in State/World.md in the vault.
const fs = require('fs');
const path = require('path');
const fm = require('../vault/frontmatter');
const { logExperience } = require('../vault/experienceLog');

const FILE = path.join('State', 'World.md');
const FULL = 59999968; // vanilla's "no border"
const MAX_STEP = 1024; // after this size, the next growth lifts the border
const SAVE_WAIT_MS = 1500; // let the server finish writing after save-all

function readState(vaultPath, startSize) {
  try {
    const { data } = fm.parse(fs.readFileSync(path.join(vaultPath, FILE), 'utf8'));
    return {
      size: Number(data.border_size) || startSize,
      credited: Array.isArray(data.credited) ? data.credited : null, // null = no baseline yet
      grown: Array.isArray(data.grown) ? data.grown : [],
    };
  } catch (_) {
    return { size: startSize, credited: null, grown: [] };
  }
}

function writeState(vaultPath, s, now) {
  const file = path.join(vaultPath, FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = s.size >= FULL
    ? 'My world has no edge any more.'
    : `My world is a square ${s.size} blocks across. It has grown when I did something I had never done before.`;
  fs.writeFileSync(file, fm.stringify({
    border_size: s.size, grows_on: 'new advancements', credited: s.credited || [], grown: s.grown,
    updated: now.toISOString(), tags: ['type/state'],
  }, body), 'utf8');
}

/** Earned advancements in a server advancements file: ids with done: true, recipes excluded. */
function earnedAdvancements(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.entries(data)
      .filter(([id, v]) => id !== 'DataVersion' && !id.includes(':recipes/') && v && v.done === true)
      .map(([id]) => id)
      .sort();
  } catch (_) {
    return null; // no file yet (or unreadable): nothing can be judged
  }
}

/**
 * Where the server keeps a player's advancements: <serverDir>/<level-name>/advancements/<uuid>.json,
 * with the uuid looked up by name in usercache.json. null when it can't be found.
 */
function advancementsFile(serverDir, username) {
  try {
    const props = fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8');
    const level = ((/^level-name=(.*)$/m.exec(props) || [])[1] || 'world').trim();
    const cache = JSON.parse(fs.readFileSync(path.join(serverDir, 'usercache.json'), 'utf8'));
    const me = cache.find((u) => String(u.name).toLowerCase() === String(username).toLowerCase());
    return me ? path.join(serverDir, level, 'advancements', `${me.uuid}.json`) : null;
  } catch (_) {
    return null;
  }
}

/** "minecraft:story/mine_stone" -> "mine stone" (plain words for the memory). */
function words(id) {
  return String(id).replace(/^.*\//, '').replace(/_/g, ' ');
}

/**
 * createWorldGrowth({ vaultPath, rcon, startSize, readEarned }) -> { onNight(report, now), state() }.
 * readEarned(): the earned advancement ids (or null if unknown). onNight never
 * throws; a failed RCON call keeps the new advancements uncredited so the next dawn retries.
 */
function createWorldGrowth({ vaultPath, rcon, startSize = 128, readEarned, log = console, saveWaitMs = SAVE_WAIT_MS }) {
  async function onNight(report, now = new Date()) {
    try {
      const s = readState(vaultPath, startSize);
      try { await rcon.command('save-all'); } catch (_) { /* read what is on disk */ }
      if (saveWaitMs) await new Promise((r) => setTimeout(r, saveWaitMs));
      const earned = readEarned ? readEarned() : null;
      if (!earned) { writeState(vaultPath, s, now); return; }
      // The first dawn under this rule: what it had already done is the baseline, not news.
      if (!s.credited) {
        s.credited = earned;
        log.log(`[world] Growth now follows advancements; already earned: ${earned.map(words).join(', ') || 'none'}.`);
        writeState(vaultPath, s, now);
        return;
      }
      const fresh = earned.filter((id) => !s.credited.includes(id));
      if (fresh.length && s.size < FULL) {
        const next = s.size >= MAX_STEP ? FULL : s.size * 2;
        try {
          await rcon.command(`worldborder set ${next}`);
          const from = s.size;
          s.size = next;
          s.credited = [...new Set([...s.credited, ...fresh])].sort();
          s.grown.push({ on: now.toISOString(), from, to: next, for: fresh });
          const did = fresh.map(words).join(', ');
          log.log(`[world] MindBot made an advancement (${did}): the border grew from ${from} to ${next >= FULL ? 'the whole world' : next}.`);
          logExperience(vaultPath, {
            title: next >= FULL ? 'The Edge Of The World Is Gone' : 'The World Grew Wider',
            timestamp: now,
            involves: [],
            locatedIn: [],
            deltas: {},
            valenceBand: 'positive',
            body: next >= FULL
              ? `I did something I had never done before (${did}), and the edge that always held me in is gone. The world goes on as far as I can walk.`
              : `I did something I had never done before (${did}), and the edge of my world moved outward. There is more of it now than there was.`,
          });
        } catch (err) {
          log.error(`[world] could not grow the border yet (${err.message}); will try again next dawn.`);
        }
      } else if (fresh.length) {
        s.credited = [...new Set([...s.credited, ...fresh])].sort(); // the world is already whole
      }
      writeState(vaultPath, s, now);
    } catch (_) { /* never */ }
  }
  return { onNight, state: () => readState(vaultPath, startSize) };
}

module.exports = { createWorldGrowth, earnedAdvancements, advancementsFile, FULL };
