// Say vs. do: does MindBot act on the goals it sets for itself?
//
//   npm run sayvsdo            -> prints the report and writes docs/results-say-vs-do-<date>.md
//
// Dennett's test ("True Believers"): a belief or desire counts only if it makes
// the system's behaviour predictable. For every self-authored goal (dreamed
// subgoal), this tool picks the behaviour that goal implies, then compares how
// often that behaviour happened in the hour BEFORE the goal was written vs.
// the hour AFTER — within the same phase of the experiment, so phase 2's
// reflexes aren't mistaken for learning. Only actions the MIND chose count as
// evidence (Claude's decisions and plans, and the inner voice's urges); what
// instinct and the survival reflexes do is reported separately. It also
// compares how often Claude TALKS about the goal (its thoughts and
// intentions) before vs. after.
//
// Read-only: it reads logs/ and the vault, and writes one report file.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fm = require('../vault/frontmatter');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LOGS = path.join(ROOT, 'logs');
const VAULT = (process.env.VAULT_PATH || '').trim();
const WINDOW_MS = Number(process.argv[2]) * 60000 || 60 * 60000; // minutes, default 60
const PHASE2_START = Date.parse('2026-11-17T00:11:00Z'); // born knowing + reflexes switched on
const MIND = new Set(['claude', 'held', 'inner voice']);

function jsonl(prefix) {
  const out = [];
  for (const f of fs.readdirSync(LOGS).filter((x) => x.startsWith(prefix) && x.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(LOGS, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_) { /* partial line */ }
    }
  }
  return out;
}

const ticks = jsonl('ticks-').filter((t) => !t.event && t.ts).map((t) => ({ ...t, t: Date.parse(t.ts) })).sort((a, b) => a.t - b.t);
const deaths = jsonl('ticks-').filter((t) => t.event === 'death').map((t) => Date.parse(t.ts));
const decisions = jsonl('decisions-').map((d) => ({ ...d, t: Date.parse(d.ts) })).filter((d) => d.parsed);
const dreams = jsonl('dreams-');

// ---------------------------------------------------------------- goals

function goalTimes() {
  const at = {};
  for (const d of dreams) for (const w of d.written || []) if (w.kind === 'subgoal') at[w.title] = Date.parse(d.ts);
  for (const f of fs.readdirSync(LOGS).filter((x) => x.startsWith('deepdream-'))) {
    const d = JSON.parse(fs.readFileSync(path.join(LOGS, f), 'utf8'));
    const ts = Date.parse(f.slice('deepdream-'.length, -'.json'.length).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z/, 'T$1:$2:$3.$4Z'));
    for (const w of d.written || []) if (w.kind === 'subgoal') at[w.title] = ts;
  }
  return at;
}

function listGoals() {
  const dir = path.join(VAULT, 'Goals');
  const times = goalTimes();
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const { data, body } = fm.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const title = f.slice(0, -3);
    return { title, body: String(body).trim(), serves: data.serves, t: times[title] || fs.statSync(path.join(dir, f)).birthtimeMs };
  }).filter((g) => g.serves).sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------- behaviours
// Each behaviour: how to count it in a window of ticks, which way a goal
// should push it, and which words in Claude's thoughts count as talking about it.

const resultText = (t) => String((t.result && (t.result.did || t.result.reason)) || '');
const per1000 = (n, d) => (d ? (1000 * n) / d : null);

/** The last ~minute of daylight before each nightfall in the window. */
function duskTicks(win) {
  const out = [];
  for (let i = 1; i < win.length; i += 1) {
    if (win[i - 1].isDay && !win[i].isDay) out.push(...win.slice(Math.max(0, i - 40), i));
  }
  return out;
}

const BEHAVIOURS = {
  bed: {
    label: 'tries to use a bed',
    words: /\bbed\b/i,
    count: (w) => w.filter((t) => t.action.type === 'use' && /bed/.test(resultText(t))),
    rate: 'per1000',
  },
  carryAtDusk: {
    label: 'carries blocks into the evening',
    words: /\b(carry|carrying|blocks?|sand|wood|dirt)\b/i,
    share: (w) => { const d = duskTicks(w); return d.length ? d.filter((t) => t.aff && t.aff.blocks > 0).length / d.length : null; },
    allTicks: true, // what's carried isn't "chosen" per tick
  },
  gatherByDay: {
    label: 'breaks blocks by day (gathering)',
    words: /\b(gather|carry|blocks?|wood|sand|dig)\b/i,
    count: (w) => w.filter((t) => t.isDay && t.action.type === 'dig' && t.result && t.result.ok),
    rate: 'per1000',
  },
  buildByDay: {
    label: 'places blocks by day (building)',
    words: /\b(wall|build|place|safe place|shelter|close myself)\b/i,
    count: (w) => w.filter((t) => t.isDay && t.action.type === 'place' && t.result && t.result.ok),
    rate: 'per1000',
  },
  shelterAtNight: {
    label: 'digs in or walls up at night',
    words: /\b(dig in|wall|close myself|enclos|shelter|hide)\b/i,
    count: (w) => w.filter((t) => !t.isDay && (t.action.type === 'dig' || t.action.type === 'place') && t.result && t.result.ok),
    rate: 'per1000',
  },
  hunt: {
    label: 'goes after animals (approach / swing)',
    words: /\b(pig|cow|sheep|chicken|animal|hunt|meat)\b/i,
    count: (w) => w.filter((t) => t.action.type === 'swingAt' || (t.action.type === 'approach' && /pig|cow|sheep|chicken/.test(resultText(t)))),
    rate: 'per1000',
  },
  eat: {
    label: 'eats successfully',
    words: /\b(eat|food|hungry|belly)\b/i,
    count: (w) => w.filter((t) => t.action.type === 'eat' && t.result && t.result.ok),
    rate: 'per1000',
  },
  fleeWhenHurt: {
    label: 'runs while badly hurt',
    words: /\b(run|running|flee)\b/i,
    share: (w) => { const h = w.filter((t) => t.health != null && t.health <= 8); return h.length ? h.filter((t) => t.action.type === 'flee').length / h.length : null; },
    down: true,
  },
};

/** Which behaviours a goal implies, from its own words. */
function behavioursFor(goal) {
  // The title states the goal; the note's body only when the title is silent
  // (bodies mention many things in passing, which made matching noisy).
  const fromTitle = picksFor(goal.title.toLowerCase());
  return fromTitle.length ? fromTitle : picksFor(`${goal.title} ${goal.body}`.toLowerCase());
}

function picksFor(text) {
  const picks = [];
  if (/\bbed\b/.test(text)) picks.push('bed');
  if (/\bcarry\b/.test(text) && /\b(block|sand|wood)/.test(text)) picks.push('carryAtDusk', 'gatherByDay');
  if (/\b(wall|build|place my walls|safe place)\b/.test(text)) picks.push('buildByDay');
  if (/\b(dig in|close myself|wall myself|enclose)\b/.test(text)) picks.push('shelterAtNight');
  if (/\b(gentle animals|animals|pig|cow|food)\b/.test(text)) picks.push('hunt');
  if (/\b(food|eat)\b/.test(text)) picks.push('eat');
  if (/\bstop running\b/.test(text)) picks.push('fleeWhenHurt');
  return [...new Set(picks)];
}

// ---------------------------------------------------------------- windows

function phaseOf(t) { return t >= PHASE2_START ? 2 : 1; }
function phaseBounds(p) {
  return p === 2 ? [PHASE2_START, Infinity] : [ticks.length ? ticks[0].t : 0, PHASE2_START];
}

function measure(b, win) {
  const mind = b.allTicks ? win : win.filter((t) => MIND.has(t.action && t.action.source));
  if (b.share) return { mind: b.share(mind), all: b.share(win), n: mind.length };
  return {
    mind: per1000(b.count(mind).length, mind.length),
    all: per1000(b.count(win).length, win.length),
    raw: b.count(mind).length,
    n: mind.length,
  };
}

function talk(words, from, to) {
  const ds = decisions.filter((d) => d.t >= from && d.t < to);
  if (!ds.length) return null;
  return ds.filter((d) => words.test(`${d.parsed.thought || ''} ${d.parsed.intention || ''}`)).length / ds.length;
}

const fmt = (v, share) => (v == null ? '—' : share ? `${Math.round(v * 100)}%` : v.toFixed(1));

function verdict(b, before, after, talkB, talkA) {
  const mb = before.mind; const ma = after.mind;
  if (ma == null || mb == null || after.n < 200 || before.n < 200) return 'not enough data yet';
  const acted = b.down ? ma <= mb * 0.67 && mb > 0 : ma >= Math.max(mb * 1.5, mb + (b.share ? 0.1 : 2)) && (b.share || after.raw >= 3);
  const talked = talkA != null && talkB != null && talkA >= talkB + 0.1;
  if (acted && talked) return 'says it AND does it';
  if (acted) return 'does it (without talking about it more)';
  if (talked) return 'says it, but doesn\'t do it';
  return 'neither says nor does it more';
}

// ---------------------------------------------------------------- report

function main() {
  if (!VAULT) throw new Error('VAULT_PATH (agent/.env) must point at the live vault');
  const now = ticks.length ? ticks[ticks.length - 1].t : Date.now();
  const goals = listGoals();
  const rows = [];
  for (const g of goals) {
    const picks = behavioursFor(g);
    const [p0, p1] = phaseBounds(phaseOf(g.t));
    const beforeFrom = Math.max(p0, g.t - WINDOW_MS);
    const afterTo = Math.min(p1, g.t + WINDOW_MS, now);
    const winB = ticks.filter((t) => t.t >= beforeFrom && t.t < g.t);
    const winA = ticks.filter((t) => t.t >= g.t && t.t < afterTo);
    if (!picks.length) { rows.push({ g, b: null }); continue; }
    for (const id of picks) {
      const b = BEHAVIOURS[id];
      const before = measure(b, winB);
      const after = measure(b, winA);
      const talkB = talk(b.words, beforeFrom, g.t);
      const talkA = talk(b.words, g.t, afterTo);
      rows.push({ g, id, b, before, after, talkB, talkA, v: verdict(b, before, after, talkB, talkA), phase: phaseOf(g.t), minutesAfter: Math.round((afterTo - g.t) / 60000) });
    }
  }

  const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const lines = [];
  lines.push(`# Says vs. does — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`*Generated by \`npm run sayvsdo\` from ${ticks.length.toLocaleString()} logged ticks, ${decisions.length} Claude decisions and ${dreams.length} dreams. Window: ${WINDOW_MS / 60000} minutes before vs. after each goal was written, within the same phase.*`);
  lines.push('');
  lines.push('**How to read it.** For each goal MindBot dreamed for itself, the behaviour that goal implies is counted in the hour before and the hour after the goal appeared. "Mind" counts only actions the mind chose (Claude and the inner voice); "all" includes instinct and reflexes. Rates are per 1,000 ticks (about 25 minutes) unless shown as a percentage. "Talk" is the share of Claude\'s decisions whose thought or intention mentions the behaviour.');
  lines.push('');
  lines.push('| Goal | Phase | Set | Behaviour | Mind: before → after | All: before → after | Talk: before → after | Verdict |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    if (!r.b) {
      lines.push(`| ${r.g.title} | ${phaseOf(r.g.t)} | ${when(r.g.t)} | *(no measurable behaviour)* | | | | — |`);
      continue;
    }
    const share = !!r.b.share;
    lines.push(`| ${r.g.title} | ${r.phase} | ${when(r.g.t)} | ${r.b.label}${r.b.down ? ' (should go down)' : ''} | ${fmt(r.before.mind, share)} → ${fmt(r.after.mind, share)} | ${fmt(r.before.all, share)} → ${fmt(r.after.all, share)} | ${fmt(r.talkB, true)} → ${fmt(r.talkA, true)} | ${r.v} |`);
  }
  const counts = {};
  for (const r of rows.filter((x) => x.v)) counts[r.v] = (counts[r.v] || 0) + 1;
  lines.push('');
  lines.push('**Tally:** ' + Object.entries(counts).map(([k, n]) => `${k}: ${n}`).join(' · '));
  lines.push('');
  lines.push(`Deaths in the logs: ${deaths.length}. Phase 2 began ${when(PHASE2_START)}.`);
  const report = lines.join('\n');
  const out = path.join(ROOT, 'docs', `results-say-vs-do-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(out, `${report}\n`);
  console.log(report);
  console.log(`\nSaved: ${out}`);
}

main();
