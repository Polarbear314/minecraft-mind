// Insight and Skill notes — the output of dreaming (src/reflection/dream.js).
// Insights are beliefs the agent formed about its world; Skills are remembered
// know-how distilled from repeated successful experience. Both live under
// Concepts/Abstract/ and link back to the Experiences that taught them via
// `learned_from`. These notes are written ONLY by dreaming, never by the tick
// loop — and never overwritten: a dream may add to the mind, not erase it.
const fs = require('fs');
const path = require('path');
const fm = require('./frontmatter');
const paths = require('./paths');

function writeAbstractNote(file, className, tag, { title, body, learnedFrom, timestamp }) {
  const clean = paths.sanitize(title);
  if (!clean) return null;
  if (fs.existsSync(file)) return null; // never overwrite an existing note
  const data = {
    is_a: fm.link(className),
    dreamed_on: (timestamp || new Date()).toISOString(),
  };
  if (learnedFrom && learnedFrom.length) data.learned_from = learnedFrom.map(fm.link);
  data.tags = [tag];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fm.stringify(data, body || clean), 'utf8');
  return { title: clean, file };
}

/** Write one Insight note. Returns null (silently) if the title already exists. */
function writeInsight(vaultPath, note) {
  const clean = paths.sanitize(note.title);
  return writeAbstractNote(paths.insightPath(vaultPath, clean), 'Insight', 'type/insight', note);
}

/** Write one Skill note. Returns null (silently) if the title already exists. */
function writeSkill(vaultPath, note) {
  const clean = paths.sanitize(note.title);
  return writeAbstractNote(paths.skillPath(vaultPath, clean), 'Skill', 'type/skill', note);
}

function listNotes(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
  } catch (_) {
    return [];
  }
  const notes = [];
  for (const f of files) {
    try {
      const { data, body } = fm.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      notes.push({ title: f.slice(0, -3), data, body });
    } catch (_) { /* skip unreadable notes */ }
  }
  return notes;
}

function listInsights(vaultPath) {
  return listNotes(paths.insightsDir(vaultPath));
}

function listSkills(vaultPath) {
  return listNotes(paths.skillsDir(vaultPath));
}

/**
 * Prompt lines for "What you know how to do" — the agent's dreamed Skills,
 * or null if it hasn't earned any yet.
 */
function skillLines(vaultPath, max = 6) {
  const lines = listSkills(vaultPath)
    .slice(0, max)
    .map((s) => `- ${s.title}: ${String(s.body).trim().replace(/\s+/g, ' ').slice(0, 150)}`);
  return lines.length ? lines.join('\n') : null;
}

module.exports = { writeInsight, writeSkill, listInsights, listSkills, skillLines };
