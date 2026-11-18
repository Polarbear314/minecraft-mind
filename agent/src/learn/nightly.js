// Nightly learning (docs/design-subsumption.md, stage 5).
//
// At each sleep, after the vault's own consolidation:
//   1. REPLAY: the day's ticks since the last review.
//   2. OPUS REVIEWS each learned layer: shown the moments that matter for it
//      (chosen the FreeLAB way: not every tick, only the relevant ones: its
//      acts that went badly, food it walked past before going hungry, the
//      hungry stretches, a few that went well) and its current weights, it
//      writes a diagnosis and CORRECTIONS: "at #12 Forage should have hunted".
//      Opus never sees the gate and never decides what is kept.
//   3. TRAIN: each layer is refitted on its own outcomes plus every correction
//      so far (corrections count double; never ones from the held-out day).
//   4. GATE: the new model is served only if it beats the hand-written layer
//      on the latest day by the bot's own outcomes (tools/trainLayers.js).
// Corrections: logs/layers/corrections.jsonl. Reviews: the vault's
// Lab/Night Reviews.md and logs/layers/reviews.jsonl.
const fs = require('fs');
const path = require('path');
const { MENUS, actClass, outcome, missedFood } = require('./examples');
const { vector } = require('./features');
const { toTable } = require('./softmax');
const { situationText } = require('../tools/experienceExport');
const { appendJsonLine } = require('../decision/decisionLog');

const JOB = {
  forage: 'Forage: finding and taking food (eat what it carries, pick up food on the ground, harvest ripe crops, hunt animals, go looking). It sits low in the stack: Survive, Make, Shelter and Gather come first.',
  wander: 'Wander: the default when no other layer speaks (explore, fiddle with things, walk up to a person, stay put).',
};
const MAX_MOMENTS = { forage: 24, wander: 14 };
const MIN_TICKS = 150; // fewer new ticks than this: nothing worth reviewing
const CORRECTION_WEIGHT = 2;

/** What came of tick i over the next minute, in words. */
function afterwards(ticks, i, span = 40) {
  const t = ticks[i];
  const end = ticks[Math.min(ticks.length - 1, i + span)];
  const hurt = ticks.slice(i + 1, i + span + 1).reduce((h, c, k) => {
    const p = ticks[i + k];
    return h + (p && c.health != null && p.health != null && c.health < p.health ? p.health - c.health : 0);
  }, 0);
  const parts = [];
  if (end.food != null && t.food != null && end.food !== t.food) parts.push(`food ${t.food} -> ${end.food}`);
  if (end.foodCarried != null && t.foodCarried != null && end.foodCarried !== t.foodCarried) parts.push(`food carried ${t.foodCarried} -> ${end.foodCarried}`);
  if (hurt) parts.push(`lost ${Math.round(hurt)} health`);
  if (t.result && t.result.ok === false) parts.push(`the body couldn't: ${t.result.reason}`);
  return parts.join(', ') || 'nothing much changed';
}

function describe(t) {
  const extra = [];
  const ripe = (t.crops || []).filter((c) => c.ripe).map((c) => `${c.name} at ${c.d}`);
  if (ripe.length) extra.push(`Ripe: ${ripe.join(', ')}.`);
  const items = (t.items || []).map((x) => `${x.name} at ${x.d}`);
  if (items.length) extra.push(`On the ground: ${items.join(', ')}.`);
  if (t.foodCarried != null) extra.push(`Food carried: ${t.foodCarried}.`);
  return `${situationText(t)} ${extra.join(' ')}`.trim();
}

/** The moments that matter for a layer, from the day's ticks. */
function selectMoments(layer, ticks) {
  const picked = [];
  const seen = new Set();
  const add = (i, kind) => {
    if (seen.has(i) || picked.length >= MAX_MOMENTS[layer]) return;
    // Not two moments within 10 ticks of each other: one per episode.
    for (const p of picked) if (Math.abs(p.i - i) < 10) return;
    seen.add(i);
    picked.push({ i, kind });
  };
  const idx = ticks.map((t, i) => i);
  const inControl = idx.filter((i) => ticks[i].action && ticks[i].action.layer === layer);
  const bad = inControl.filter((i) => outcome(layer, ticks, i) === 'bad');
  const good = inControl.filter((i) => outcome(layer, ticks, i) === 'good');
  for (const i of bad) add(i, `${layer} acted and it went badly`);
  if (layer === 'forage') {
    const missed = idx.filter((i) => missedFood(ticks, i));
    for (const i of missed) add(i, 'forage stayed quiet with food in reach, and the body went hungry later');
    const starving = idx.filter((i) => (ticks[i].food ?? 20) <= 3);
    for (let k = 0; k < starving.length; k += Math.max(1, Math.floor(starving.length / 5))) add(starving[k], 'starving');
  } else {
    const hurt = idx.filter((i) => ticks[i].action && ticks[i].action.layer === 'wander' && ticks[i].tookDamage);
    for (const i of hurt) add(i, 'hurt while wandering');
  }
  for (let k = 0; k < good.length; k += Math.max(1, Math.floor(good.length / 4))) add(good[k], `${layer} acted and it went well`);
  return picked.sort((a, b) => a.i - b.i).map((m, n) => {
    const t = ticks[m.i];
    const a = t.action || {};
    return {
      id: n + 1, i: m.i, ts: t.ts, kind: m.kind,
      text: `#${n + 1} [${m.kind}] ${describe(t)} The body did: ${a.type}${a.at ? ` ${a.at}` : ''}${a.plan ? ` (plan "${a.plan}")` : ''}, chosen by ${a.layer || '?'}${(a.voices || []).length > 1 ? ` (also speaking: ${a.voices.filter((v) => v !== a.layer).join(', ')})` : ''}. Over the next minute: ${afterwards(ticks, m.i)}.`,
    };
  });
}

function topWeights(model) {
  if (!model) return '(no learned model yet: the hand-written layer acts)';
  const table = toTable(model);
  return Object.entries(table).map(([act, w]) => {
    const s = Object.entries(w).filter(([f]) => f !== 'bias').sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4);
    return `  ${act}: ${s.map(([f, v]) => `${f} ${v > 0 ? '+' : ''}${v}`).join(', ')}`;
  }).join('\n');
}

function reviewPrompt(sections) {
  const lines = [
    'You are reviewing a day in the life of MindBot, a creature in a small Minecraft world (a 128-block square). Its behaviour comes from a stack of layers; the first layer that speaks each tick (1.5 s) gets the body. Some layers are small learned classifiers, retrained every night from the creature\'s own days.',
    'For each layer below, read the moments from today and write:',
    '  - "diagnosis": two or three sentences on what this layer does well and badly, and why.',
    '  - "corrections": for moments where the layer should have done something else, which act it should have chosen there (one of its acts, or "none" to stay quiet and let the other layers act), and why. Only where you are fairly sure; skip moments that were fine. The goal: stay alive, unhurt and fed, and get on with living.',
    'Your corrections become training examples. Whether a retrained layer is kept is decided by how the creature actually fares, not by you.',
    '',
  ];
  for (const s of sections) {
    lines.push(`## ${s.layer}`, JOB[s.layer], `Acts: ${MENUS[s.layer].join(', ')}.`, 'Its current weights (strongest per act; features are 0-1, e.g. animalClose = how close the nearest food animal is):', topWeights(s.model), 'Moments:');
    for (const m of s.moments) lines.push(m.text);
    lines.push('');
  }
  lines.push('Reply with JSON only: {"forage": {"diagnosis": "...", "corrections": [{"id": 3, "should": "hunt", "why": "..."}]}, "wander": {...}} (only the layers above).');
  return lines.join('\n');
}

function parseReview(text) {
  const raw = String(text || '');
  const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(raw.slice(s, e + 1)); } catch (_) { return null; }
}

/** Every correction so far (appendJsonLine writes one file per day: corrections-YYYY-MM-DD.jsonl). */
function readCorrections(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith('corrections') && f.endsWith('.jsonl')).sort(); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const c = JSON.parse(l); if (c.layer && c.should && Array.isArray(c.x)) out.push(c); } catch (_) { /* skip */ }
    }
  }
  return out;
}

/**
 * One night's learning. ticks: all layer-mode ticks (sorted). since: Date of
 * the last review. provider: Opus (provider.ask). fit/save: from trainLayers.
 * Returns a summary for the dream log.
 */
async function nightlyLearning({ ticks, since, provider, dir, vaultPath = null, fitLayer, save, gate = null, learned = () => ({}), now = new Date(), route = 'train', embed = null }) {
  const day = ticks.filter((t) => !since || Date.parse(t.ts) > since.getTime());
  const summary = { route, reviewedTicks: day.length, reviewed: false, corrections: {}, diagnoses: {}, results: [], edits: {} };
  fs.mkdirSync(dir, { recursive: true });

  // Route A nights (stage 5b): Opus edits each learned layer's weights
  // directly (learn/edit.js). A layer with no model yet is trained instead.
  const editing = route === 'edit' && provider && gate && day.length >= MIN_TICKS;
  const editedLayers = new Set();
  if (editing) {
    const { editLayer } = require('./edit');
    const models = learned() || {};
    for (const layer of Object.keys(MENUS)) {
      const base = models[layer];
      if (!base || !base.model) continue;
      editedLayers.add(layer);
      let r;
      try {
        r = await editLayer({ layer, base, ticks, day, provider, embed, dir, gate, now });
      } catch (err) { r = { layer, route: 'edit', passed: false, reason: `editing failed (${err.message})`, edits: [], proposed: [] }; }
      summary.reviewed = true;
      summary.edits[layer] = { proposed: r.proposed || [], final: r.edits || [] };
      r.version = r.model ? save(r) : null;
      summary.results.push({ layer, route: 'edit', version: r.version || null, passed: r.passed, score: r.score ?? null, baseline: r.baseline ?? null, reason: r.reason || null, edits: (r.edits || []).length });
    }
  }

  if (provider && day.length >= MIN_TICKS && !editing) {
    const models = learned() || {};
    const sections = Object.keys(MENUS).map((layer) => ({ layer, model: models[layer] && models[layer].model, moments: selectMoments(layer, day) }))
      .filter((s) => s.moments.length);
    if (sections.length) {
      let review = null;
      try { const reply = await provider.ask(reviewPrompt(sections)); review = parseReview(reply && reply.text); summary.by = reply && reply.by; } catch (err) { summary.error = err.message; }
      if (review) {
        summary.reviewed = true;
        for (const s of sections) {
          const r = review[s.layer] || {};
          summary.diagnoses[s.layer] = String(r.diagnosis || '').slice(0, 800);
          let n = 0;
          for (const c of Array.isArray(r.corrections) ? r.corrections : []) {
            const m = s.moments.find((x) => x.id === Number(c.id));
            if (!m || !MENUS[s.layer].includes(c.should)) continue;
            const t = day[m.i];
            const a = t.action || {};
            const actual = a.layer === s.layer ? (actClass(s.layer, a) || 'none') : 'none';
            appendJsonLine(dir, 'corrections', {
              layer: s.layer, ts: t.ts, should: c.should, why: String(c.why || '').slice(0, 300), actual, x: vector(t), reviewedAt: now.toISOString(), by: summary.by || null,
            });
            n += 1;
          }
          summary.corrections[s.layer] = n;
        }
        appendJsonLine(dir, 'reviews', { ts: now.toISOString(), by: summary.by || null, sections: sections.map((s) => ({ layer: s.layer, moments: s.moments.length })), review });
      }
    }
  }

  // Train every layer on its own outcomes + all corrections so far, and gate.
  const corrections = readCorrections(dir).map((c) => ({ ...c, x: c.x, y: c.should }));
  for (const layer of Object.keys(MENUS)) {
    if (editedLayers.has(layer)) continue; // edited tonight instead
    const extra = corrections.filter((c) => c.layer === layer).map((c) => ({ x: c.x, y: c.y, ts: c.ts, actual: c.actual, weight: CORRECTION_WEIGHT }));
    const r = fitLayer(layer, ticks, { now, extra });
    r.version = save(r);
    summary.results.push({ layer, route: 'train', version: r.version || null, passed: r.passed, score: r.score ?? null, baseline: r.baseline ?? null, reason: r.reason || null, corrections: extra.length });
  }

  if (vaultPath) {
    try {
      const { appendLab } = require('../vault/labNotes');
      const how = editing ? 'Route A night: Opus edited the weights directly.' : 'Route B night: Opus reviewed, the layers retrained.';
      const lines = [`## ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`, '', `${how} ${day.length} ticks since the last review.${summary.reviewed ? ` By ${summary.by || 'Opus'}.` : summary.error ? ` No review (${summary.error}).` : ' No review (too little new to review).'}`, ''];
      for (const [layer, d] of Object.entries(summary.diagnoses)) lines.push(`**${layer}:** ${d} *(${summary.corrections[layer] || 0} corrections)*`, '');
      for (const [layer, e] of Object.entries(summary.edits)) {
        lines.push(`**${layer}, edits proposed:** ${e.proposed.map((p) => `${p.act}/${p.feature} ${p.from} → ${p.to} (changes ${p.changed ?? '?'} past moments): ${p.why}`).join('; ') || 'none'}`, '');
        lines.push(`**${layer}, kept after seeing the evidence:** ${e.final.map((p) => `${p.act}/${p.feature} → ${p.to}: ${p.why}`).join('; ') || 'none'}`, '');
      }
      for (const r of summary.results) lines.push(`- ${r.layer}${r.version ? ` v${r.version}` : ''} (${r.route === 'edit' ? 'edited' : 'retrained'}): ${r.passed ? '**passed the gate, now served**' : `not served (${r.reason})`}${r.score != null ? `; ${r.score} vs hand-written ${r.baseline}` : ''}${r.route === 'edit' ? `; ${r.edits} edits` : `; trained with ${r.corrections} corrections so far`}.`);
      appendLab(vaultPath, 'Night Reviews', lines.join('\n'));
    } catch (_) { /* the logs have it */ }
  }
  return summary;
}

module.exports = { nightlyLearning, selectMoments, reviewPrompt, parseReview, readCorrections, describe, afterwards, JOB, MIN_TICKS };
