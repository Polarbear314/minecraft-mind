// Strategy notes: what the agent has learned about its own behavior.
// Mirrors conceptStore, but the "thing" being learned about is an
// action-in-context (e.g. "Exploring At Night") rather than an object in the
// world. recordStrategyOutcome() reads-or-creates the note, runs an EMA update
// on the success rate, recomputes the effectiveness band, and writes it back —
// every strategy the agent has ever tried is a readable markdown note under
// Concepts/Abstract/Strategy/.
const fs = require('fs');
const path = require('path');
const fm = require('./frontmatter');
const paths = require('./paths');

const ALPHA = 0.2; // same recency weighting as conceptStore's valence EMA
const MAX_RECENT_OUTCOMES = 5; // bullet list kept in the note body

// Note titles are "<verb> <context>": Exploring At Night, Eating By Day...
const ACTION_LABELS = {
  flee: 'Fleeing',
  avoid: 'Avoiding Danger',
  eat: 'Eating',
  seekFood: 'Seeking Food',
  explore: 'Exploring',
  idle: 'Idling',
  swingAt: 'Swinging',
  dig: 'Digging',
  place: 'Placing',
  pickup: 'Picking Up',
  approach: 'Approaching',
  craft: 'Crafting',
};

function strategyTitle(actionType, context) {
  const verb = ACTION_LABELS[actionType] || paths.titleCase(actionType);
  return `${verb} ${context === 'day' ? 'By Day' : 'At Night'}`;
}

/** Effectiveness band from the running success rate (0..1). */
function effectivenessBand(rate) {
  if (rate >= 0.6) return 'effective';
  if (rate <= 0.4) return 'ineffective';
  return 'mixed';
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/** The "Recent outcomes" bullets already in a note body, newest first. */
function existingOutcomeBullets(body) {
  return String(body || '')
    .split('\n')
    .filter((l) => l.startsWith('- '));
}

/**
 * Record the outcome of one attempt at a strategy.
 *
 * outcome: {
 *   actionType: 'explore' | 'flee' | ...,
 *   context: 'day' | 'night',
 *   score: 0..1,                       // how well it went (0.5 = neutral)
 *   label: 'success'|'failure'|'neutral',
 *   summary: 'Explored at night for 4 tick(s): took damage (health 20 -> 14).',
 *   timestamp: Date,
 * }
 *
 * Returns { title, file, isFirstAttempt, successRate, band, crossedBand,
 * attemptCount } so the caller can decide whether the outcome is striking
 * enough for an Experience note.
 */
function recordStrategyOutcome(vaultPath, outcome) {
  const title = strategyTitle(outcome.actionType, outcome.context);
  const file = paths.strategyPath(vaultPath, title);
  const now = (outcome.timestamp || new Date()).toISOString();
  const score = clamp01(Number(outcome.score) || 0);
  const isFirst = !fs.existsSync(file);

  let data = {};
  let body = '';
  let rate;
  let count;
  let first;
  let oldBand = null;

  if (isFirst) {
    // First attempt = the outcome itself, like a Concept's first impression.
    rate = score;
    count = 1;
    first = now;
  } else {
    ({ data, body } = fm.parse(fs.readFileSync(file, 'utf8')));
    const oldRate = Number.isFinite(Number(data.success_rate)) ? Number(data.success_rate) : 0.5;
    oldBand = effectivenessBand(oldRate);
    rate = oldRate * (1 - ALPHA) + score * ALPHA;
    count = (Number(data.attempt_count) || 0) + 1;
    first = data.first_tried || now;
  }

  rate = round3(rate);
  const band = effectivenessBand(rate);
  const crossedBand = !isFirst && oldBand !== band;

  const newData = {
    ...data,
    is_a: fm.link('Strategy'),
    action: outcome.actionType,
    context: outcome.context,
    success_rate: rate,
    attempt_count: count,
    last_outcome: outcome.label,
    first_tried: first,
    last_tried: now,
    tags: [`strategy/${band}`, 'type/strategy'],
  };

  const bullets = [
    `- ${now.slice(0, 16)} — ${outcome.label}: ${outcome.summary}`,
    ...existingOutcomeBullets(body),
  ].slice(0, MAX_RECENT_OUTCOMES);
  const intro = `The agent's learned sense of whether ${title.toLowerCase()} works, ` +
    'updated after every attempt.';
  const newBody = `${intro}\n\nRecent outcomes (newest first):\n\n${bullets.join('\n')}`;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fm.stringify(newData, newBody), 'utf8');

  return { title, file, isFirstAttempt: isFirst, successRate: rate, band, crossedBand, attemptCount: count };
}

/**
 * One qualitative phrase for a strategy's track record. Deliberately words,
 * not numbers: the prompt feeds Claude's inner voice, and numbers in the
 * prompt turn its thoughts into statistics recitals. The precise rates stay
 * in the notes' frontmatter for the graph and for humans.
 */
function describeRecord(rate, count, last) {
  const times = count === 1 ? 'tried once' : `tried ${count} times`;
  let verdict;
  if (count === 1) {
    verdict = last === 'success' ? 'it went well'
      : last === 'failure' ? 'it went badly'
        : 'nothing much came of it';
  } else if (rate >= 0.6) {
    verdict = 'it has usually gone well';
  } else if (rate <= 0.4) {
    verdict = 'it has usually gone badly';
  } else {
    verdict = 'the results have been mixed';
  }
  const lastNote = count > 1 && (last === 'success' || last === 'failure')
    ? `; last time it ${last === 'success' ? 'went well' : 'went badly'}`
    : '';
  return `${times} — ${verdict}${lastNote}`;
}

/**
 * Prompt lines summarizing every learned strategy, most-tried first —
 * this is how "exploring at night has gone badly" reaches Claude, phrased
 * as lived experience rather than success percentages.
 */
function strategyLines(vaultPath, max = 8) {
  const dir = paths.strategiesDir(vaultPath);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  } catch (_) {
    return null; // nothing learned yet
  }
  const rows = [];
  for (const f of files) {
    try {
      const { data } = fm.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      rows.push({
        title: f.slice(0, -3),
        rate: Number(data.success_rate) || 0,
        count: Number(data.attempt_count) || 0,
        last: data.last_outcome || 'unknown',
      });
    } catch (_) { /* one unreadable note shouldn't hide the rest */ }
  }
  if (!rows.length) return null;
  return rows
    .sort((a, b) => b.count - a.count)
    .slice(0, max)
    .map((r) => `- ${r.title}: ${describeRecord(r.rate, r.count, r.last)}.`)
    .join('\n');
}

module.exports = { recordStrategyOutcome, strategyLines, strategyTitle, effectivenessBand, describeRecord, ALPHA };
