// Route A: Opus edits a learned layer's weights directly (stage 5b,
// docs/design-subsumption.md). No training step: the numbers Opus writes ARE
// the new layer. Alternates nightly with route B (corrections + retraining).
//
//   1. PROPOSE: Opus reads the layer's FULL weight table (about 120 numbers,
//      every one named: "animalClose -> hunt: +0.4") and today's moments that
//      matter, and proposes a few edits, each with a reason.
//   2. CHECK, the FreeLAB way: for each edit, the past moments it would change
//      (every tick of the bot's life where the edited layer would now choose
//      differently) are found by arithmetic, then ranked by how much they
//      resemble the moments behind the edit (nomic-embed-text embeddings,
//      cached) and how recent they are. Opus reads only the top few, with how
//      each turned out: its edit judged against the bot's whole life in about
//      a thousand words.
//   3. REVISE: Opus keeps, adjusts or withdraws each edit.
//   4. GATE: the edited layer is served only if it beats the hand-written one
//      on the held-out day by the bot's own outcomes, as a retrained one must.
// Logged to logs/layers/edits-*.jsonl and the vault's Lab/Night Reviews.
const fs = require('fs');
const path = require('path');
const { vector, FEATURES } = require('./features');
const { predict, toTable, fromTable } = require('./softmax');
const { MENUS } = require('./examples');
const { selectMoments, describe, afterwards, JOB } = require('./nightly');
const { appendJsonLine } = require('../decision/decisionLog');

const MAX_EDITS = 6;
const LIMIT = 10; // weights are kept within +-10
const EVIDENCE = 8; // past moments shown per edit
const CANDIDATES = 300; // at most this many changed moments are embedded per edit (the most recent)

const r3 = (v) => Math.round(v * 1000) / 1000;

function fullTable(model) {
  const t = toTable(model);
  const feats = ['bias', ...model.features];
  const head = `act        | ${feats.join(' | ')}`;
  return [head, ...Object.entries(t).map(([act, w]) => `${act.padEnd(10)} | ${feats.map((f) => (w[f] >= 0 ? '+' : '') + w[f]).join(' | ')}`)].join('\n');
}

function proposePrompt(layer, model, moments) {
  return [
    `You are editing one layer of MindBot, a creature in a small Minecraft world, directly: no training, the numbers you write become the layer. ${JOB[layer]}`,
    'The layer is a softmax classifier: for each act, score = bias + sum(weight x feature); the highest score wins ("none" = stay quiet and let other layers act). Features run 0-1:',
    '  health, food (the food bar), hunger/fear/curiosity (drives), day, evening, enclosed, roof, walls, hostileClose (1 = a hostile right here), hostiles (how many), animalClose (nearest food animal), ripeCropClose, foodOnGround, foodCarried, carriesNoFood (1 = carries none), personClose, edgeClose (the world border).',
    '',
    'Its FULL weight table now:',
    fullTable(model),
    '',
    'Moments from today that matter for this layer:',
    ...moments.map((m) => m.text),
    '',
    `Propose at most ${MAX_EDITS} edits that would make it choose better: stay alive, unhurt and fed. Each edit sets ONE number. Prefer few, clear edits. Cite the moments behind each. Each edit will then be checked against past moments it would change, before anything is kept.`,
    'Reply with JSON only: {"edits": [{"act": "hunt", "feature": "animalClose", "to": 2.5, "why": "...", "moments": [3, 7]}]}',
  ].join('\n');
}

function revisePrompt(layer, proposals) {
  const lines = [
    `You proposed these edits to MindBot's ${layer} layer. For each, here are past moments from the creature's life where the edit would CHANGE what the layer chooses, chosen as the ones most like the moments behind your edit (and recent), with how each actually turned out under the old choice.`,
    'Decide for each edit: keep it, adjust its number, or withdraw it. An edit that fixes today but would have done harm on those days should be adjusted or withdrawn.',
    '',
  ];
  proposals.forEach((p, n) => {
    lines.push(`### Edit ${n + 1}: ${p.act} / ${p.feature}: ${p.from} -> ${p.to} (${p.why})`);
    lines.push(`It changes the layer's choice at ${p.changed} past moments${p.changed > p.evidence.length ? ` (the ${p.evidence.length} most relevant below)` : ''}.`);
    for (const e of p.evidence) lines.push(`- ${e}`);
    lines.push('');
  });
  lines.push('Reply with JSON only: {"final": [{"act": "...", "feature": "...", "to": 1.5, "why": "..."}]} (only the edits you keep, with their final numbers; [] to keep none).');
  return lines.join('\n');
}

function parseJson(text) {
  const raw = String(text || '');
  const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(raw.slice(s, e + 1)); } catch (_) { return null; }
}

/** Valid edits only: a real act, a real feature (or bias), a finite number, clamped. */
function cleanEdits(layer, model, edits) {
  const table = toTable(model);
  const out = [];
  for (const e of Array.isArray(edits) ? edits : []) {
    if (!MENUS[layer].includes(e.act)) continue;
    if (e.feature !== 'bias' && !FEATURES.includes(e.feature)) continue;
    const to = Number(e.to);
    if (!Number.isFinite(to)) continue;
    out.push({ act: e.act, feature: e.feature, from: table[e.act][e.feature], to: r3(Math.max(-LIMIT, Math.min(LIMIT, to))), why: String(e.why || '').slice(0, 300), moments: Array.isArray(e.moments) ? e.moments.map(Number) : [] });
    if (out.length >= MAX_EDITS) break;
  }
  return out;
}

function applyEdits(model, edits) {
  const table = toTable(model);
  for (const e of edits) table[e.act][e.feature] = e.to;
  const m = fromTable(table, model.features);
  // Keep the class order the layer was built with.
  const order = model.classes;
  return { classes: order, features: model.features, W: order.map((c) => m.W[m.classes.indexOf(c)]), b: order.map((c) => m.b[m.classes.indexOf(c)]) };
}

const cosine = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};

/** Embeddings for moment texts, cached by tick time (logs/layers/moment-embeddings.json). */
function momentEmbedder(embed, cacheFile) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) { cache = {}; }
  return async function vectors(items, prefix) { // items: [{ key, text }]
    const need = items.filter((it) => !it.key || !cache[it.key]);
    for (let i = 0; i < need.length; i += 32) {
      const batch = need.slice(i, i + 32);
      const vecs = await embed(batch.map((it) => `${prefix}: ${it.text.slice(0, 1200)}`));
      batch.forEach((it, j) => { if (it.key) cache[it.key] = vecs[j]; else it.vec = vecs[j]; });
    }
    if (need.some((it) => it.key)) { try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch (_) { /* fine */ } }
    return items.map((it) => (it.key ? cache[it.key] : it.vec));
  };
}

/**
 * The past moments an edit would change, most relevant first (FreeLAB-style:
 * arithmetic finds the candidates, embeddings rank them against the moments
 * behind the edit).
 */
async function evidenceFor(edit, model, ticks, behind, { vectors = null, now = Date.now() } = {}) {
  const edited = applyEdits(model, [edit]);
  const changed = [];
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    if (!t.action || !t.action.layer) continue;
    const x = vector(t);
    const before = predict(model, x).pick; const after = predict(edited, x).pick;
    if (before !== after) changed.push({ i, before, after });
  }
  const recent = changed.slice(-CANDIDATES);
  let scored = recent.map((c) => ({ ...c, score: 0.5 + 0.5 * Math.pow(0.5, (now - Date.parse(ticks[c.i].ts)) / (3 * 86400000)) }));
  if (vectors && behind.length && recent.length) {
    try {
      const qs = await vectors(behind.map((text) => ({ text })), 'search_query');
      const ds = await vectors(recent.map((c) => ({ key: ticks[c.i].ts, text: describe(ticks[c.i]) })), 'search_document');
      scored = scored.map((c, k) => ({ ...c, score: c.score * Math.max(...qs.map((q) => Math.max(0, cosine(q, ds[k] || [])))) }));
    } catch (_) { /* no embeddings: recency only */ }
  }
  const top = scored.sort((a, b) => b.score - a.score).slice(0, EVIDENCE).sort((a, b) => a.i - b.i);
  return {
    changed: changed.length,
    evidence: top.map((c) => {
      const t = ticks[c.i];
      return `[${t.ts.slice(0, 16).replace('T', ' ')}] ${describe(t)} The layer would choose ${c.after} instead of ${c.before}. What the body actually did: ${t.action.type} (${t.action.layer}); over the next minute: ${afterwards(ticks, c.i)}.`;
    }),
  };
}

/**
 * One editing night for one layer. base: { model, version }. Returns a result
 * shaped like fitLayer's (route 'edit'), gated, for save().
 */
async function editLayer({ layer, base, ticks, day, provider, embed = null, dir, gate, now = new Date() }) {
  const result = { layer, route: 'edit', at: now.toISOString(), base: base.version || null, passed: false, edits: [], proposed: [] };
  const moments = selectMoments(layer, day);
  if (!moments.length) { result.reason = 'no moments worth editing for'; return result; }
  const first = parseJson((await provider.ask(proposePrompt(layer, base.model, moments))).text);
  const proposed = cleanEdits(layer, base.model, first && first.edits);
  result.proposed = proposed;
  if (!proposed.length) { result.reason = 'Opus proposed no edits'; return result; }
  const vectors = embed ? momentEmbedder(embed, path.join(dir, 'moment-embeddings.json')) : null;
  for (const p of proposed) {
    const behind = p.moments.map((id) => moments.find((m) => m.id === id)).filter(Boolean).map((m) => m.text);
    Object.assign(p, await evidenceFor(p, base.model, ticks, behind.length ? behind : [p.why], { vectors, now: now.getTime() }));
  }
  const second = parseJson((await provider.ask(revisePrompt(layer, proposed))).text);
  const final = cleanEdits(layer, base.model, second && second.final);
  result.edits = final.map((e) => ({ ...e, changed: (proposed.find((p) => p.act === e.act && p.feature === e.feature) || {}).changed ?? null }));
  if (!final.length) { result.reason = 'Opus withdrew every edit after seeing the evidence'; return result; }
  const edited = applyEdits(base.model, final);
  gate(layer, edited, result);
  appendJsonLine(dir, 'edits', { ts: now.toISOString(), layer, base: result.base, proposed: proposed.map(({ evidence, ...p }) => ({ ...p, evidenceShown: evidence.length })), final: result.edits, passed: result.passed, score: result.score ?? null, baseline: result.baseline ?? null });
  return result;
}

module.exports = { editLayer, applyEdits, cleanEdits, evidenceFor, fullTable, proposePrompt, revisePrompt };
