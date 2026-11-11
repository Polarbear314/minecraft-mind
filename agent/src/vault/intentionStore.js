// The agent's standing intention (Phase C): a short undertaking it set for
// itself, persisted to State/Current Intention.md and fed back into every
// consultation until it replaces or abandons it. This is what makes
// multi-step projects possible at all — without it, only one-swing behaviors
// can exist. Like everything in State/, the note is working memory and may be
// overwritten; unlike Goals, it is prose the agent holds, not a note it cites.
const fs = require('fs');
const path = require('path');
const fm = require('./frontmatter');
const paths = require('./paths');

const MAX_INTENTION_LENGTH = 200;

/** The active intention's prose, or null if none is held. */
function currentIntention(vaultPath) {
  try {
    const { data, body } = fm.parse(fs.readFileSync(paths.intentionPath(vaultPath), 'utf8'));
    if (data.status !== 'active') return null;
    const text = String(body).trim();
    return text || null;
  } catch (_) {
    return null; // no note yet — no intention
  }
}

/**
 * Set, replace, or abandon the intention. Empty/blank text = abandon.
 * Never throws — a failed write must not disturb the tick.
 */
function setIntention(vaultPath, text, timestamp = new Date()) {
  try {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_INTENTION_LENGTH);
    const file = paths.intentionPath(vaultPath);
    const iso = timestamp.toISOString();
    const data = clean
      ? { status: 'active', set_on: iso, tags: ['type/intention'] }
      : { status: 'none', cleared_on: iso, tags: ['type/intention'] };
    const body = clean || '(no standing intention)';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fm.stringify(data, body), 'utf8');
    return clean || null;
  } catch (_) {
    return null;
  }
}

module.exports = { currentIntention, setIntention, MAX_INTENTION_LENGTH };
