// Weighted memory (docs/design-subsumption.md, stage 2).
//
//   WEIGHT     every note has one number from 0 to 1 for how much it matters
//              (the `weight` property in Obsidian). Notes written before
//              weights existed get a starting weight from what they already
//              say (feelings, familiarity, status), until sleep writes one.
//   INDEX      createMemory() keeps every note's weight and words in memory,
//              refreshed from the files when they change, so finding the top
//              notes doesn't mean reading 900 files every tick.
//   RETRIEVAL  the FreeLAB way: rank notes against a question (the situation
//              plus a layer's job) by similarity x weight x recency, and hand
//              a small model only the top few. Similarity is word overlap
//              (TF-IDF) by default, or embeddings from a local Ollama model
//              (EMBED_MODEL, e.g. nomic-embed-text) when one is available.
//   FORGETTING at sleep (forget()): Experiences fade unless what they
//              involved was met again; faded ones, and the weakest when live
//              memory is over budget, are folded into GIST notes ("Died By Day:
//              9 times, ...") and moved to Archive/. Archived, never deleted;
//              restore() brings one back.
const fs = require('fs');
const path = require('path');
const fm = require('./frontmatter');
const paths = require('./paths');

const DAY_MS = 24 * 3600 * 1000;
const BUDGET = 300; // live Experiences kept after a sleep
const MAX_ARCHIVE = 100; // at most this many archived per sleep (no sudden amnesia)
const FADE_BELOW = 0.08; // an Experience this weak leaves live memory
const DECAY = 0.85; // a neutral Experience keeps this share of its weight per sleep
const DECAY_FELT = 0.92; // one that felt good or bad fades more slowly
const DECAY_GIST = 0.97;
const REPLAY = 0.15; // met again since the last sleep: pulled back toward 1
const FRESH_MS = DAY_MS; // Experiences younger than this don't fade yet
const TENTATIVE_BELOW = 3; // a gist from fewer episodes than this is tentative
const HALF_LIFE_MS = 3 * DAY_MS; // recency for Experiences
const ARCHIVE = 'Archive';
const GISTS = 'Gists';

// What each layer's question adds to the situation (its job, in words).
const LAYER_FOCUS = {
  survive: 'hostile damage hurt died flee creeper lava border danger',
  make: 'craft make planks crafting table plan skill recipe tool',
  shelter: 'night dusk dark evening wall roof hole dig place block bed shelter closed zombie skeleton spider',
  gather: 'log wood dig break pick up carry block stone dirt',
  forage: 'food hungry eat meat cow pig chicken sheep hunt bread',
  wander: 'explore walk new place curious',
};

const round3 = (v) => Math.round(v * 1000) / 1000;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const unlink = (s) => String(s || '').replace(/^\[\[|\]\]$/g, '');
const stripStamp = (title) => title.replace(/^\d{4}-\d{2}-\d{2}T\d{4} - /, '');

const STOP = new Set('a an the and or of to in on at by for with from is was were be been i my me it its this that as not no but so up out into over under than then there here have has had do did what when where which who will would could should can just only very more most some any all each one two'.split(' '));
function words(text) {
  return String(text || '').toLowerCase().replace(/_/g, ' ').match(/[a-z]+/g)?.filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)) || [];
}

/** Where each kind of note lives. Concepts (world things) are walked recursively, minus Abstract. */
function sources(vaultPath) {
  return [
    { kind: 'experience', dir: paths.experiencesDir(vaultPath) },
    { kind: 'gist', dir: path.join(vaultPath, GISTS) },
    { kind: 'goal', dir: paths.goalsDir(vaultPath) },
    { kind: 'plan', dir: path.join(vaultPath, 'Plans') },
    { kind: 'skill', dir: paths.skillsDir(vaultPath) },
    { kind: 'strategy', dir: paths.strategiesDir(vaultPath) },
    { kind: 'insight', dir: paths.insightsDir(vaultPath) },
    { kind: 'concept', dir: path.join(vaultPath, 'Concepts'), recursive: true },
  ];
}

function listMd(dir, recursive) {
  const out = [];
  (function walk(d) {
    let names;
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of names) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (recursive && e.name !== 'Abstract') walk(full); } else if (e.name.endsWith('.md') && e.name !== 'README.md') out.push(full);
    }
  })(dir);
  return out;
}

/** A note's weight: its own `weight`, or a starting one from what it already says. */
function initialWeight(kind, data, title = '') {
  const w = Number(data.weight);
  if (data.weight != null && Number.isFinite(w)) return clamp01(w);
  const tags = [].concat(data.tags || []).join(' ');
  switch (kind) {
    case 'experience': {
      let v = /valence\/(positive|negative)/.test(tags) ? 0.5 : 0.3;
      if (/Died|Damage|First Time|For The First|Ate |Survived/i.test(title)) v += 0.2;
      return clamp01(v);
    }
    case 'concept':
      return clamp01(0.15 + Math.abs(Number(data.valence) || 0) * 0.5 + Math.log10(1 + (Number(data.encounter_count) || 0)) / 8);
    case 'goal': return data.status === 'active' || !data.status ? 0.6 : 0.25;
    case 'plan': return data.status === 'trying' ? 0.5 : data.status === 'dropped' ? 0.1 : 0.3;
    case 'skill': return data.status === 'withdrawn' ? 0.1 : 0.7;
    case 'gist': return 0.5;
    default: return 0.5;
  }
}

function noteTime(kind, data, file, mtimeMs) {
  const t = Date.parse(data.timestamp || data.last_seen || data.last_encountered || data.written_on || data.given_on || '');
  return Number.isFinite(t) ? t : mtimeMs;
}

function readEntry(kind, file, st) {
  const title = path.basename(file, '.md');
  const { data, body } = fm.parse(fs.readFileSync(file, 'utf8'));
  const text = [stripStamp(title), [].concat(data.tags || []).join(' '), [].concat(data.involves || []).map(unlink).join(' '),
    data.serves ? unlink(data.serves) : '', String(body || '').slice(0, 500)].join(' ');
  return { title, kind, file, mtimeMs: st.mtimeMs, weight: initialWeight(kind, data, title), time: noteTime(kind, data, file, st.mtimeMs),
    text, words: words(text), data };
}

/** Ollama embeddings (POST /api/embed). Returns embed(texts) -> vectors, or null on failure. */
function ollamaEmbedder({ model, host = 'http://127.0.0.1:11434', timeoutMs = 20000 } = {}) {
  if (!model) return null;
  return async function embed(texts) {
    const res = await fetch(`${host.replace(/\/$/, '')}/api/embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`embed ${res.status}`);
    const j = await res.json();
    return j.embeddings;
  };
}

const cosine = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};

/**
 * The in-memory index. createMemory({ vaultPath, embed?, cacheFile?, now? })
 *   .refresh()                         re-reads only notes that changed
 *   .retrieve(question, { layer, k, kinds }) -> [{ title, kind, score, sim, weight, recency, text }]
 *   .stats()                           counts by kind
 */
function createMemory({ vaultPath, embed = null, cacheFile = null, now = () => Date.now() } = {}) {
  let entries = new Map(); // file -> entry
  let df = new Map();
  let vecCache = {};
  if (cacheFile) { try { vecCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) { vecCache = {}; } }
  let embedOk = !!embed;

  function refresh() {
    const seen = new Set();
    for (const { kind, dir, recursive } of sources(vaultPath)) {
      for (const file of listMd(dir, recursive)) {
        seen.add(file);
        let st;
        try { st = fs.statSync(file); } catch (_) { continue; }
        const old = entries.get(file);
        if (old && old.mtimeMs === st.mtimeMs) continue;
        try { entries.set(file, readEntry(kind, file, st)); } catch (_) { /* unreadable: skip */ }
      }
    }
    for (const file of [...entries.keys()]) if (!seen.has(file)) entries.delete(file);
    df = new Map();
    for (const e of entries.values()) for (const w of new Set(e.words)) df.set(w, (df.get(w) || 0) + 1);
    return entries.size;
  }

  function tfidf(ws) {
    const n = entries.size || 1;
    const v = new Map();
    for (const w of ws) v.set(w, (v.get(w) || 0) + 1);
    for (const [w, c] of v) v.set(w, c * Math.log(1 + n / (1 + (df.get(w) || 0))));
    return v;
  }
  function lexSim(q, e) {
    if (!e._v) e._v = tfidf(e.words);
    let d = 0, nq = 0, ne = 0;
    for (const [w, x] of q) { nq += x * x; const y = e._v.get(w); if (y) d += x * y; }
    for (const y of e._v.values()) ne += y * y;
    return nq && ne ? d / Math.sqrt(nq * ne) : 0;
  }

  async function vectorsFor(list) {
    const need = list.filter((e) => !vecCache[`${e.file}|${e.mtimeMs}`]);
    for (let i = 0; i < need.length; i += 64) {
      const batch = need.slice(i, i + 64);
      const vecs = await embed(batch.map((e) => e.text.slice(0, 1500)));
      batch.forEach((e, j) => { vecCache[`${e.file}|${e.mtimeMs}`] = vecs[j]; });
    }
    if (need.length && cacheFile) { try { fs.writeFileSync(cacheFile, JSON.stringify(vecCache)); } catch (_) { /* fine */ } }
    return list.map((e) => vecCache[`${e.file}|${e.mtimeMs}`]);
  }

  function recencyOf(e) {
    if (e.kind !== 'experience') return 1;
    const age = Math.max(0, now() - e.time);
    return 0.25 + 0.75 * Math.pow(0.5, age / HALF_LIFE_MS);
  }

  async function retrieve(question, { layer = null, k = 5, kinds = null } = {}) {
    if (!entries.size) refresh();
    const q = `${question} ${layer && LAYER_FOCUS[layer] ? LAYER_FOCUS[layer] : ''}`;
    const pool = [...entries.values()].filter((e) => !kinds || kinds.includes(e.kind));
    let sims = null;
    if (embedOk) {
      try {
        const [qv] = await embed([q]);
        const vs = await vectorsFor(pool);
        sims = vs.map((v) => (v ? Math.max(0, cosine(qv, v)) : 0));
      } catch (_) { embedOk = false; sims = null; } // no model: fall back to words, for good
    }
    const qv = sims ? null : tfidf(words(q));
    return pool.map((e, i) => {
      const sim = sims ? sims[i] : lexSim(qv, e);
      const recency = recencyOf(e);
      return { title: e.title, kind: e.kind, sim: round3(sim), weight: round3(e.weight), recency: round3(recency),
        score: round3(sim * e.weight * recency), text: e.text.slice(0, 300) };
    }).filter((r) => r.sim > 0).sort((a, b) => b.score - a.score).slice(0, k);
  }

  function stats() {
    const byKind = {};
    for (const e of entries.values()) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    return { notes: entries.size, byKind, similarity: embedOk ? 'embeddings' : 'words' };
  }

  return { refresh, retrieve, stats, usingEmbeddings: () => embedOk };
}

// ------------------------------------------------------------ forgetting

function writeNote(file, data, body) {
  fs.writeFileSync(file, fm.stringify(data, body));
}

/** Fold archived episodes into the gist note for their kind of moment. */
function addToGist(vaultPath, key, episodes, nowIso) {
  const dir = path.join(vaultPath, GISTS);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${paths.sanitize(key)}.md`);
  let data = {}; let body = '';
  if (fs.existsSync(file)) ({ data, body } = fm.parse(fs.readFileSync(file, 'utf8')));
  const count = (Number(data.episodes) || 0) + episodes.length;
  const tally = { positive: Number(data.positive) || 0, negative: Number(data.negative) || 0, neutral: Number(data.neutral) || 0 };
  for (const e of episodes) {
    const tags = [].concat(e.data.tags || []).join(' ');
    const v = /valence\/positive/.test(tags) ? 'positive' : /valence\/negative/.test(tags) ? 'negative' : 'neutral';
    tally[v] += 1;
  }
  const times = episodes.map((e) => new Date(e.time).toISOString()).sort();
  const involves = new Set([].concat(data.involves || []).map(unlink));
  for (const e of episodes) for (const t of [].concat(e.data.involves || [])) involves.add(unlink(t));
  const list = [...new Set([...[].concat(data.from_episodes || []).map(unlink), ...episodes.map((e) => e.title)])];
  const latest = episodes.slice().sort((a, b) => b.time - a.time)[0];
  const sumW = episodes.reduce((s, e) => s + e.weight, 0);
  const newData = {
    is_a: '[[Gist]]',
    episodes: count,
    ...tally,
    first_seen: data.first_seen && data.first_seen < times[0] ? data.first_seen : times[0],
    last_seen: data.last_seen && data.last_seen > times[times.length - 1] ? data.last_seen : times[times.length - 1],
    weight: round3(clamp01(Math.max(Number(data.weight) || 0, 0.2 + sumW))),
    tentative: count < TENTATIVE_BELOW,
    ...(involves.size ? { involves: [...involves].slice(0, 12).map(fm.link) } : {}),
    from_episodes: list.slice(-50).map(fm.link),
    updated_on: nowIso,
    tags: ['type/gist'],
  };
  const parts = [];
  if (tally.positive) parts.push(`${tally.positive} went well`);
  if (tally.negative) parts.push(`${tally.negative} went badly`);
  if (tally.neutral) parts.push(`${tally.neutral} were neither`);
  const latestLine = latest ? String(fm.parse(fs.readFileSync(latest.file, 'utf8')).body || '').trim().split('\n')[0].slice(0, 300) : '';
  const newBody = `${key}: this has happened to me ${count} time${count === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}.` +
    `${newData.tentative ? ' Too few times to be sure what it means.' : ''}\n\nThe last time: ${latestLine}\n\n` +
    `*The single memories have faded into this one (kept in ${ARCHIVE}/).*`;
  writeNote(file, newData, newBody);
  return key;
}

/**
 * Sleep-time forgetting. `replay`: Concept titles met since the last sleep.
 * Returns { live, decayed, archived, gists, overBudget }.
 */
function forget(vaultPath, { replay = new Set(), now = new Date(), budget = BUDGET, maxArchive = MAX_ARCHIVE } = {}) {
  const t = now.getTime();
  const nowIso = now.toISOString();
  const stats = { live: 0, decayed: 0, archived: 0, gists: [], overBudget: 0 };
  const exps = [];
  for (const file of listMd(paths.experiencesDir(vaultPath), false)) {
    let st; let e;
    try { st = fs.statSync(file); e = readEntry('experience', file, st); } catch (_) { continue; }
    const { data, body } = fm.parse(fs.readFileSync(file, 'utf8'));
    let w = e.weight;
    if (t - e.time >= FRESH_MS) {
      const felt = /valence\/(positive|negative)/.test([].concat(data.tags || []).join(' '));
      w *= felt ? DECAY_FELT : DECAY;
      if ([].concat(data.involves || []).some((x) => replay.has(unlink(x)))) w = 1 - (1 - w) * (1 - REPLAY);
      stats.decayed += 1;
    }
    w = round3(w);
    if (Number(data.weight) !== w) writeNote(file, { ...data, weight: w }, body);
    exps.push({ ...e, weight: w, data, fresh: t - e.time < FRESH_MS });
  }
  // Gists fade slowly too (never archived here).
  for (const file of listMd(path.join(vaultPath, GISTS), false)) {
    try {
      const { data, body } = fm.parse(fs.readFileSync(file, 'utf8'));
      const w = round3((Number(data.weight) || 0.5) * DECAY_GIST);
      writeNote(file, { ...data, weight: w }, body);
    } catch (_) { /* skip */ }
  }
  const old = exps.filter((e) => !e.fresh).sort((a, b) => a.weight - b.weight);
  const leaving = new Set(old.filter((e) => e.weight < FADE_BELOW));
  stats.overBudget = Math.max(0, exps.length - budget);
  for (const e of old) { if (exps.length - leaving.size <= budget) break; leaving.add(e); }
  const going = [...leaving].sort((a, b) => a.weight - b.weight).slice(0, maxArchive);

  const groups = new Map();
  for (const e of going) {
    const key = stripStamp(e.title);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const archDir = path.join(vaultPath, ARCHIVE, 'Experiences');
  for (const [key, eps] of groups) {
    try {
      addToGist(vaultPath, key, eps, nowIso);
      stats.gists.push(key);
    } catch (_) { continue; } // without its gist, nothing is archived
    fs.mkdirSync(archDir, { recursive: true });
    for (const e of eps) {
      try {
        const { data, body } = fm.parse(fs.readFileSync(e.file, 'utf8'));
        const why = e.weight < FADE_BELOW ? 'faded' : 'live memory was full';
        writeNote(path.join(archDir, path.basename(e.file)), { ...data, archived_on: nowIso, archived_why: why, gist: fm.link(key) }, body);
        fs.unlinkSync(e.file); // moved: the copy in Archive/ is the note now
        stats.archived += 1;
      } catch (_) { /* leave it live */ }
    }
  }
  stats.live = exps.length - stats.archived;
  return stats;
}

/** Bring an archived Experience back into live memory (reconsolidation). */
function restore(vaultPath, title, { weight = 0.3 } = {}) {
  const from = path.join(vaultPath, ARCHIVE, 'Experiences', `${title}.md`);
  if (!fs.existsSync(from)) return false;
  const { data, body } = fm.parse(fs.readFileSync(from, 'utf8'));
  delete data.archived_on; delete data.archived_why;
  writeNote(path.join(paths.experiencesDir(vaultPath), `${title}.md`), { ...data, weight, restored_on: new Date().toISOString() }, body);
  fs.unlinkSync(from);
  return true;
}

module.exports = {
  createMemory, ollamaEmbedder, forget, restore, initialWeight, words, LAYER_FOCUS,
  BUDGET, FADE_BELOW, ARCHIVE, GISTS,
};
