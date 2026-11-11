// Experience notes: the episodic log. One timestamped Event instance per
// notable happening, automatically chained to its predecessor via `follows`.
const fs = require('fs');
const fm = require('./frontmatter');
const paths = require('./paths');

/** Most recent existing Experience note title (filename without .md), or null. */
function latestExperienceTitle(vaultPath) {
  const dir = paths.experiencesDir(vaultPath);
  if (!fs.existsSync(dir)) return null;
  const notes = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort(); // compact-timestamp prefixes sort chronologically
  return notes.length ? notes[notes.length - 1].slice(0, -3) : null;
}

/**
 * Write one Experience note.
 * event: {
 *   title: 'First Zombie Encounter',
 *   timestamp: Date,
 *   involves: [conceptTitle, ...],
 *   locatedIn: [locationTitle, ...],
 *   causes: [driveTitle, ...],          // e.g. ['Fear']
 *   deltas: { fear_delta: 0.8, ... },   // numeric drive deltas
 *   valenceBand: 'negative',
 *   body: 'prose description',
 * }
 */
function logExperience(vaultPath, event) {
  const iso = (event.timestamp || new Date()).toISOString();
  const file = paths.experiencePath(vaultPath, iso, event.title);
  const prev = latestExperienceTitle(vaultPath);

  const data = {
    is_a: fm.link('Event'),
    timestamp: iso,
  };
  if (event.involves && event.involves.length) data.involves = event.involves.map(fm.link);
  if (event.locatedIn && event.locatedIn.length) data.located_in = event.locatedIn.map(fm.link);
  if (event.causes && event.causes.length) data.causes = event.causes.map(fm.link);
  for (const [k, v] of Object.entries(event.deltas || {})) data[k] = v;
  if (prev) data.follows = fm.link(prev);
  data.tags = [`valence/${event.valenceBand || 'neutral'}`];

  fs.mkdirSync(paths.experiencesDir(vaultPath), { recursive: true });
  fs.writeFileSync(file, fm.stringify(data, event.body || event.title), 'utf8');
  return { file };
}

module.exports = { logExperience };
