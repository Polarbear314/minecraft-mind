// Plasticity across the whole vault (docs/design-plasticity-and-a-learning-cortex.md, Part A).
//
// Awake, links between Concepts strengthen each time two things are seen
// together (conceptStore.recordEncounter). Asleep, before each dream,
// consolidate() does what sleep is thought to do for synapses:
//
//   1. REPLAY: links among the things the day's Experiences involved get a
//      boost (the hippocampus replaying what mattered).
//   2. DOWNSCALE: every link weakens a little (Tononi & Cirelli's synaptic
//      homeostasis), so only what keeps being used stays strong.
//   3. PRUNE: links that fall below a threshold leave co_occurs_with and move
//      to faded_links (archived with the date, never deleted). Meeting the
//      two together again brings the link back.
//
// Awake again, callsToMind() is spreading activation: the strongest links of
// whatever is in view are what the cortex is reminded of.
const fs = require('fs');
const path = require('path');
const fm = require('./frontmatter');
const paths = require('./paths');

const REPLAY = 0.15; // boost toward 1 for links among replayed things
const DOWNSCALE = 0.9; // every link keeps this share of its strength each sleep
const PRUNE_BELOW = 0.03; // weaker than this, a link fades
const UNKNOWN_STRENGTH = 0.1; // links from before strengths existed start here
const RECALL_MIN = 0.15; // weaker links don't come to mind

const round3 = (v) => Math.round(v * 1000) / 1000;
const unlink = (s) => String(s || '').replace(/^\[\[|\]\]$/g, '');

/** Every world Concept note (not Abstract: strategies, insights, skills). */
function conceptFiles(vaultPath) {
  const out = [];
  (function walk(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.isDirectory()) { if (name !== 'Abstract') walk(full); } else if (name.endsWith('.md') && name !== 'README.md') out.push(full);
    }
  })(path.join(vaultPath, 'Concepts'));
  return out;
}

/** title -> { file, data } for every world Concept. */
function conceptIndex(vaultPath) {
  const index = new Map();
  for (const file of conceptFiles(vaultPath)) {
    try {
      index.set(path.basename(file, '.md'), { file, data: fm.parse(fs.readFileSync(file, 'utf8')).data });
    } catch (_) { /* skip unreadable */ }
  }
  return index;
}

/** The Concept titles involved in Experiences written since `since` (a Date). */
function replayedSince(vaultPath, since) {
  const out = new Set();
  const cutoff = since ? paths.compactTimestamp(since.toISOString()) : '';
  let files = [];
  try { files = fs.readdirSync(paths.experiencesDir(vaultPath)).filter((f) => f.endsWith('.md') && f !== 'README.md'); } catch (_) { return out; }
  for (const f of files) {
    if (cutoff && f.slice(0, cutoff.length) < cutoff) continue;
    try {
      const { data } = fm.parse(fs.readFileSync(path.join(paths.experiencesDir(vaultPath), f), 'utf8'));
      for (const t of [].concat(data.involves || [])) out.add(unlink(t));
    } catch (_) { /* skip */ }
  }
  return out;
}

/**
 * Sleep: replay, downscale, prune. `replay` is a Set of Concept titles that
 * the day's Experiences involved (see replayedSince). Returns a summary.
 */
function consolidate(vaultPath, { replay = new Set(), now = new Date() } = {}) {
  const stats = { concepts: 0, links: 0, replayed: 0, pruned: 0, prunedLinks: [] };
  const day = now.toISOString().slice(0, 10);
  for (const file of conceptFiles(vaultPath)) {
    let note;
    try { note = fm.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
    const { data, body } = note;
    const listed = [].concat(data.co_occurs_with || []).map(unlink).filter(Boolean);
    if (!listed.length && !data.link_strength) continue;
    const title = path.basename(file, '.md');
    const strength = { ...(data.link_strength || {}) };
    const faded = { ...(data.faded_links || {}) };
    for (const other of listed) if (!Number.isFinite(Number(strength[other]))) strength[other] = UNKNOWN_STRENGTH;
    const keep = [];
    for (const [other, w0] of Object.entries(strength)) {
      let w = Number(w0) || 0;
      if (replay.has(title) && replay.has(other)) { w = 1 - (1 - w) * (1 - REPLAY); stats.replayed += 1; }
      w *= DOWNSCALE;
      if (w < PRUNE_BELOW) {
        delete strength[other];
        faded[other] = day;
        stats.pruned += 1;
        if (stats.prunedLinks.length < 20) stats.prunedLinks.push(`${title} ~ ${other}`);
      } else {
        strength[other] = round3(w);
        keep.push(other);
        stats.links += 1;
      }
    }
    const newData = { ...data, link_strength: strength };
    if (keep.length) newData.co_occurs_with = keep.map(fm.link);
    else delete newData.co_occurs_with;
    if (Object.keys(faded).length) newData.faded_links = faded;
    try { fs.writeFileSync(file, fm.stringify(newData, body), 'utf8'); stats.concepts += 1; } catch (_) { /* skip */ }
  }
  return stats;
}

function feelingWord(valence) {
  const v = Number(valence);
  if (!Number.isFinite(v)) return 'something I know little about';
  if (v >= 0.5) return 'something I feel good about';
  if (v >= 0.2) return 'something that feels good';
  if (v <= -0.5) return 'something that feels dangerous';
  if (v <= -0.2) return 'something that feels bad';
  return 'something I feel neutral about';
}

function howStrongly(w) {
  if (w >= 0.6) return 'strongly';
  if (w >= 0.35) return 'often';
  return 'sometimes';
}

/**
 * Spreading activation: for the things in view (titles), their strongest
 * links, in words. Returns prompt lines or null.
 */
function callsToMind(vaultPath, titles, { perThing = 3, maxThings = 5, index = null } = {}) {
  const idx = index || conceptIndex(vaultPath);
  const seen = new Set(titles);
  const lines = [];
  for (const t of [...new Set(titles)].slice(0, maxThings)) {
    const c = idx.get(t);
    if (!c || !c.data.link_strength) continue;
    const top = Object.entries(c.data.link_strength)
      .map(([other, w]) => [other, Number(w) || 0])
      .filter(([other, w]) => w >= RECALL_MIN && !seen.has(other))
      .sort((a, b) => b[1] - a[1])
      .slice(0, perThing);
    if (!top.length) continue;
    lines.push(`- ${t} brings to mind ` + top.map(([other, w]) => {
      const o = idx.get(other);
      return `${other} (${howStrongly(w)} together; ${feelingWord(o && o.data.valence)})`;
    }).join(', '));
  }
  return lines.length ? lines.join('\n') : null;
}

/** For the dream: the strongest pairs in its whole memory, in words. */
function strongestLinkLines(vaultPath, n = 8) {
  const pairs = new Map();
  for (const [t, c] of conceptIndex(vaultPath)) {
    for (const [other, w] of Object.entries(c.data.link_strength || {})) {
      const key = [t, other].sort().join(' and ');
      pairs.set(key, Math.max(pairs.get(key) || 0, Number(w) || 0));
    }
  }
  const lines = [...pairs.entries()].filter(([, w]) => w >= RECALL_MIN).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, w]) => `- ${k} (${howStrongly(w)} together)`);
  return lines.length ? lines.join('\n') : null;
}

module.exports = {
  consolidate, replayedSince, callsToMind, strongestLinkLines, conceptIndex,
  REPLAY, DOWNSCALE, PRUNE_BELOW, UNKNOWN_STRENGTH, RECALL_MIN,
};
