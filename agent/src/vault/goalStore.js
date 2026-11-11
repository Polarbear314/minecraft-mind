// Goal notes. Two kinds live in Goals/: the founding goal (given by the user,
// no `serves` field) and self-authored subgoals written by dreaming, each
// carrying `serves: [[<founding goal>]]`. The founding goal must be found by
// its frontmatter, NOT by sort order — a dreamed subgoal like "Avoid The
// Dark.md" would otherwise alphabetically shadow "Live A Good Life.md".
const fs = require('fs');
const path = require('path');
const fm = require('./frontmatter');
const paths = require('./paths');

/** All goal notes: [{ title, data, body }], sorted by title. */
function listGoals(vaultPath) {
  const dir = paths.goalsDir(vaultPath);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
  } catch (_) {
    return [];
  }
  const goals = [];
  for (const f of files) {
    try {
      const { data, body } = fm.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      goals.push({ title: f.slice(0, -3), data, body });
    } catch (_) { /* one unreadable note shouldn't hide the rest */ }
  }
  return goals;
}

/** The founding goal's title: the first goal WITHOUT a `serves` link, or null. */
function foundingGoalTitle(vaultPath) {
  const goals = listGoals(vaultPath);
  const founding = goals.find((g) => !g.data.serves);
  return founding ? founding.title : (goals.length ? goals[0].title : null);
}

/** Self-authored subgoals (goals with `serves`), skipping abandoned ones. */
function listSubgoals(vaultPath) {
  return listGoals(vaultPath).filter(
    (g) => g.data.serves && (!g.data.status || g.data.status === 'active')
  );
}

/**
 * Write one self-authored subgoal note (from dreaming). Never overwrites:
 * returns null if a note with this title already exists.
 */
function writeSubgoal(vaultPath, { title, body, servesTitle, timestamp }) {
  const clean = paths.sanitize(title);
  if (!clean) return null;
  const file = paths.goalPath(vaultPath, clean);
  if (fs.existsSync(file)) return null;
  const data = {
    is_a: fm.link('Goal'),
    serves: fm.link(servesTitle),
    given_by: 'MindBot (dreaming)',
    given_on: (timestamp || new Date()).toISOString().slice(0, 10),
    status: 'active',
    tags: ['type/goal'],
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fm.stringify(data, body || clean), 'utf8');
  return { title: clean, file };
}

/** Prompt lines for the agent's own subgoals, or null if it has none yet. */
function subgoalLines(vaultPath, max = 6) {
  const lines = listSubgoals(vaultPath)
    .slice(0, max)
    .map((g) => `- ${g.title}: ${String(g.body).trim().replace(/\s+/g, ' ').slice(0, 150)}`);
  return lines.length ? lines.join('\n') : null;
}

module.exports = { listGoals, foundingGoalTitle, listSubgoals, writeSubgoal, subgoalLines };
