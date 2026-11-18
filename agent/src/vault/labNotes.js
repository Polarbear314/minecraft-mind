// Lab notes: results for the people studying MindBot, kept in its vault so
// they open in Obsidian next to its mind (Lab/), but NOT part of its mind.
// Nothing MindBot reads (memory, dreams, plans, plasticity) looks in Lab/.
// The same text is also kept in docs/ for git.
const fs = require('fs');
const path = require('path');
const fm = require('./frontmatter');

const LAB = 'Lab';

/** Write (replace) a lab note. Returns its path, or null without a vault. */
function writeLab(vaultPath, title, markdown, extra = {}) {
  if (!vaultPath || !fs.existsSync(vaultPath)) return null;
  const dir = path.join(vaultPath, LAB);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${title}.md`);
  const body = String(markdown).replace(/^# .*\n+/, ''); // the note's title is its heading
  fs.writeFileSync(file, fm.stringify({
    is_a: '[[Lab Note]]',
    for: 'the people studying MindBot, not MindBot (it never reads Lab/)',
    updated: new Date().toISOString(),
    tags: ['type/lab'],
    ...extra,
  }, body));
  return file;
}

/** Append a dated section to a lab note (created if missing). */
function appendLab(vaultPath, title, markdown, extra = {}) {
  if (!vaultPath || !fs.existsSync(vaultPath)) return null;
  const file = path.join(vaultPath, LAB, `${title}.md`);
  let body = '';
  if (fs.existsSync(file)) body = fm.parse(fs.readFileSync(file, 'utf8')).body;
  return writeLab(vaultPath, title, `${String(body).trim()}\n\n${markdown.trim()}\n`, extra);
}

module.exports = { writeLab, appendLab, LAB };
