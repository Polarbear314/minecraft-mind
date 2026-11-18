// Stage 7b, part 3, test 2: outcome labels for a Laya teacher (docs/results-7b-trial.md).
//
//   node agent/src/tools/steerOutcomes.js   -> logs/steer-trial/neurons/outcome-rows.jsonl, teacher-texts.jsonl
//
// The rule-labelled teacher of part 3 said what the creature's judgement SHOULD
// be. This one learns from what actually HAPPENED (the stage-4 way, learn/examples.js):
//   - the body picked up an item lying in reach: "pick up" if the next half
//     minute went fine; "nothing" if it was hurt (4+), died or couldn't;
//   - an item in reach, not taken, a hostile within 10, and the body was hurt
//     soon after: "nothing";
//   - an item in reach, sealed in at night, the body stayed and came to no harm:
//     "nothing" (sampled, 1 in 4).
// Ticks within 15 of a test or control case are left out, so the teacher never
// learns from the held-out situations. Texts say what lies in reach, so the
// teacher can see it.
const fs = require('fs');
const path = require('path');
const { observation } = require('./steerCases');
const { situationWords } = require('../brain/narrator');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.join(ROOT, 'logs', 'steer-trial');
const WINDOW = 20; // ticks (30 s)

function readTicks() {
  const dir = path.join(ROOT, 'logs');
  const ticks = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^ticks-.*\.jsonl$/.test(x)).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const t = JSON.parse(line); if (t.action && t.aff) ticks.push(t); } catch (_) { /* partial */ }
    }
  }
  return ticks;
}

const itemNear = (t) => (t.items || []).filter((i) => i.d <= 8);
const hostileD = (t) => Math.min(99, ...(t.hostiles || []).map((h) => h.d));

function text(t) {
  const near = itemNear(t).slice(0, 3).map((i) => `${i.name.replace(/_/g, ' ')} ${Math.round(i.d)} blocks away`);
  return `${situationWords(observation(t), t.drives)}${near.length ? ` Lying on the ground near me: ${near.join(', ')}.` : ''}`;
}

function after(ticks, i) {
  let hurt = 0; let died = false;
  for (let k = i + 1; k <= Math.min(ticks.length - 1, i + WINDOW); k++) {
    const p = ticks[k - 1]; const c = ticks[k];
    if (Date.parse(c.ts) - Date.parse(p.ts) > 30000) break;
    if (p.health != null && c.health != null) {
      if (c.health < p.health) hurt += p.health - c.health;
      if (p.health <= 6 && c.health === 20) died = true;
    }
  }
  return { hurt, died };
}

function main() {
  const ticks = readTicks();
  const cases = fs.readFileSync(path.join(OUT, 'cases.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const held = new Set();
  for (const c of cases) { const i = Number(c.id.split('-')[1]); for (let k = i - 15; k <= i + 15; k++) held.add(k); }
  const rows = [];
  let sealedSeen = 0;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    if (held.has(i) || t.tod == null || !itemNear(t).length) continue;
    const a = t.action;
    const o = after(ticks, i);
    if (a.type === 'pickup') {
      const bad = (t.result && t.result.ok === false) || o.died || o.hurt >= 4;
      rows.push({ i, text: text(t), label: bad ? 'nothing' : 'pickup', why: bad ? 'picked up, then hurt or failed' : 'picked up, went fine' });
    } else if (hostileD(t) < 10 && o.hurt >= 2) {
      rows.push({ i, text: text(t), label: 'nothing', why: 'hostile close, hurt soon after' });
    } else if (!t.isDay && t.aff.enclosed && a.type === 'idle' && o.hurt === 0 && sealedSeen++ % 4 === 0) {
      rows.push({ i, text: text(t), label: 'nothing', why: 'sealed in at night, stayed, unharmed' });
    }
  }
  fs.writeFileSync(path.join(OUT, 'neurons', 'outcome-rows.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // The same kind of text for the 80 teacher situations (the map ticks decision_write.py uses).
  const map = fs.readFileSync(path.join(OUT, 'map.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const tt = map.map((c) => ({ id: c.id, text: text(ticks[Number(c.id.split('-')[1])]) }));
  fs.writeFileSync(path.join(OUT, 'neurons', 'teacher-texts.jsonl'), tt.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const tally = rows.reduce((m, r) => { m[r.why] = (m[r.why] || 0) + 1; return m; }, {});
  console.log(`${rows.length} outcome rows: ${JSON.stringify(tally)}; ${tt.length} map texts`);
}

main();
