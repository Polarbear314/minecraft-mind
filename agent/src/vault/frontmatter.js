// Parse and reassemble markdown notes with YAML frontmatter.
const yaml = require('js-yaml');

/** Split a note into { data, body }. Notes without frontmatter get data = {}. */
function parse(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { data: {}, body: content };
  let data;
  try {
    data = yaml.load(match[1]) || {};
  } catch (err) {
    // A hand-edited note with broken YAML shouldn't kill the agent.
    console.error(`[frontmatter] Failed to parse YAML (${err.message}); treating as empty.`);
    data = {};
  }
  return { data, body: content.slice(match[0].length) };
}

/** Recursively convert Date objects (js-yaml parses ISO timestamps into Dates) back to ISO strings. */
function normalizeDates(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeDates);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalizeDates(v);
    return out;
  }
  return value;
}

/** Reassemble { data, body } into note text. */
function stringify(data, body) {
  const fm = yaml.dump(normalizeDates(data), { lineWidth: -1, noRefs: true, quotingType: '"' });
  return `---\n${fm}---\n\n${String(body || '').trim()}\n`;
}

/** Wrap a note title as an Obsidian wikilink. */
function link(title) {
  return `[[${title}]]`;
}

module.exports = { parse, stringify, link };
