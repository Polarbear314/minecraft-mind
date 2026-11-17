// Capability gaps: things the agent TRIED to do that its body could not.
// "I tried to set a block over my head, but I carried nothing that would stay
// put." These are not beliefs about the world ("the night hurts whatever I
// do") but facts about the body — the difference Haugeland's "understanding"
// asks a mind to keep track of (the world forbids X vs. I can't yet do X).
//
// One note per kind of failure (action + direction + reason), counted, under
// Gaps/. The first time a gap is hit it also becomes an Experience, so dreams
// can reason about it. Gaps are shown back to the cortex, closing the loop:
// a plan that can't be carried out is registered, not silently dropped.
const fs = require('fs');
const path = require('path');
const fm = require('./frontmatter');
const paths = require('./paths');

const GAPS_DIR = 'Gaps';

function gapsDir(vaultPath) {
  return path.join(vaultPath, GAPS_DIR);
}

const VERBS = {
  dig: 'Break', place: 'Set Down A Block', use: 'Work', equip: 'Hold', move: 'Move', jump: 'Jump', craft: 'Make',
};

function gapTitle(action, reason) {
  const verb = VERBS[action.type] || paths.titleCase(action.type);
  const where = action.at ? ` ${paths.titleCase(String(action.at).replace(/-/g, ' '))}` : '';
  // The reason's gist keeps distinct failures apart ("nothing to set down" vs "already there").
  const gist = String(reason || '').replace(/[^A-Za-z ]+/g, ' ').trim().split(/\s+/).slice(0, 6).join(' ');
  return paths.sanitize(`Could Not ${verb}${where} - ${paths.titleCase(gist)}`).slice(0, 90);
}

/**
 * Record one failed attempt. Returns { title, isFirst, count }.
 * Never throws — a failed write must not disturb the tick.
 */
function recordGap(vaultPath, action, reason, timestamp = new Date()) {
  try {
    const title = gapTitle(action, reason);
    const file = path.join(gapsDir(vaultPath), `${title}.md`);
    const iso = timestamp.toISOString();
    let data;
    let body;
    let isFirst = false;
    if (fs.existsSync(file)) {
      ({ data, body } = fm.parse(fs.readFileSync(file, 'utf8')));
      data.count = (Number(data.count) || 0) + 1;
      data.last_hit = iso;
    } else {
      isFirst = true;
      data = {
        is_a: fm.link('Capability Gap'),
        action: action.type,
        ...(action.at ? { at: action.at } : {}),
        count: 1,
        first_hit: iso,
        last_hit: iso,
        tags: ['type/gap'],
      };
      body = `I tried to ${String(VERBS[action.type] || action.type).toLowerCase()}` +
        `${action.at ? ` ${String(action.at).replace(/-/g, ' ')}` : ''}, but ${reason}.`;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fm.stringify(data, body), 'utf8');
    return { title, isFirst, count: data.count };
  } catch (_) {
    return null;
  }
}

/** The most recently hit gaps, newest first, for the cortex prompt (or null). */
function gapLines(vaultPath, max = 4) {
  let files;
  try {
    files = fs.readdirSync(gapsDir(vaultPath)).filter((f) => f.endsWith('.md'));
  } catch (_) {
    return null;
  }
  const rows = [];
  for (const f of files) {
    try {
      const { data, body } = fm.parse(fs.readFileSync(path.join(gapsDir(vaultPath), f), 'utf8'));
      rows.push({ last: String(data.last_hit || ''), count: Number(data.count) || 1, body: String(body).trim() });
    } catch (_) { /* skip */ }
  }
  if (!rows.length) return null;
  return rows
    .sort((a, b) => (a.last < b.last ? 1 : -1))
    .slice(0, max)
    .map((r) => `- ${r.body.replace(/\s+/g, ' ')}${r.count > 1 ? ' (more than once)' : ''}`)
    .join('\n');
}

module.exports = { recordGap, gapLines, gapTitle, GAPS_DIR };
