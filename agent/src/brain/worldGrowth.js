// A world that grows as MindBot thrives (phase 2, docs/design-born-knowing.md).
// At each graded dawn: a survived night (no death) extends the streak, a death
// resets it. After NIGHTS_NEEDED in a row, the border doubles — 128, 256, 512,
// 1024 — and then is lifted (the full world). It never shrinks. The code asks
// the server through RCON; the mind only experiences the result, as a memory:
// "The World Grew Wider". State lives in State/World.md in the vault.
const fs = require('fs');
const path = require('path');
const fm = require('../vault/frontmatter');
const { logExperience } = require('../vault/experienceLog');

const FILE = path.join('State', 'World.md');
const FULL = 59999968; // vanilla's "no border"
const NIGHTS_NEEDED = 3;
const MAX_STEP = 1024; // after this size, the next growth lifts the border

function readState(vaultPath, startSize) {
  try {
    const { data } = fm.parse(fs.readFileSync(path.join(vaultPath, FILE), 'utf8'));
    return {
      size: Number(data.border_size) || startSize,
      streak: Number(data.streak) || 0,
      grown: Array.isArray(data.grown) ? data.grown : [],
    };
  } catch (_) {
    return { size: startSize, streak: 0, grown: [] };
  }
}

function writeState(vaultPath, s, now) {
  const file = path.join(vaultPath, FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = s.size >= FULL
    ? 'My world has no edge any more.'
    : `My world is a square ${s.size} blocks across. ${s.streak ? `I have come through ${s.streak} night${s.streak === 1 ? '' : 's'} in a row.` : 'I have not yet strung nights together.'}`;
  fs.writeFileSync(file, fm.stringify({
    border_size: s.size, streak: s.streak, nights_needed: NIGHTS_NEEDED, grown: s.grown,
    updated: now.toISOString(), tags: ['type/state'],
  }, body), 'utf8');
}

/**
 * createWorldGrowth({ vaultPath, rcon, startSize }) -> { onNight(report, now), state() }.
 * onNight never throws; a failed RCON call keeps the streak so the next dawn retries.
 */
function createWorldGrowth({ vaultPath, rcon, startSize = 128, log = console }) {
  async function onNight(report, now = new Date()) {
    try {
      const s = readState(vaultPath, startSize);
      s.streak = report && report.survived ? s.streak + 1 : 0;
      if (s.streak >= NIGHTS_NEEDED && s.size < FULL) {
        const next = s.size >= MAX_STEP ? FULL : s.size * 2;
        try {
          await rcon.command(`worldborder set ${next}`);
          const from = s.size;
          s.size = next;
          s.streak = 0;
          s.grown.push({ on: now.toISOString(), from, to: next });
          log.log(`[world] MindBot lived ${NIGHTS_NEEDED} nights in a row: the border grew from ${from} to ${next >= FULL ? 'the whole world' : next}.`);
          logExperience(vaultPath, {
            title: next >= FULL ? 'The Edge Of The World Is Gone' : 'The World Grew Wider',
            timestamp: now,
            involves: [],
            locatedIn: [],
            deltas: {},
            valenceBand: 'positive',
            body: next >= FULL
              ? 'After night upon night survived, the edge that always held me in is gone. The world goes on as far as I can walk.'
              : 'After coming through night after night, the edge of my world moved outward. There is more of it now than there was.',
          });
        } catch (err) {
          log.error(`[world] could not grow the border yet (${err.message}); will try again next dawn.`);
        }
      }
      writeState(vaultPath, s, now);
    } catch (_) { /* never */ }
  }
  return { onNight, state: () => readState(vaultPath, startSize) };
}

module.exports = { createWorldGrowth, NIGHTS_NEEDED, FULL };
