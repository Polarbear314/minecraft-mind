// Dreaming: a background reflection pass where Claude, AS MindBot in first
// person, reads its own vault — recent Experiences, its Strategies, its Goals,
// the Concepts it feels most strongly about, and NOTHING else (no game
// knowledge, no hints) — and writes up to a few new notes: Insights (beliefs),
// self-authored subgoals, and Skills (know-how distilled from repeated
// successful experience). Triggered by surviving a night (day-break) and/or
// every DREAM_INTERVAL_MS.
//
// NON-BLOCKING AND SILENT BY DESIGN: like consultations, a dream runs in the
// background — the tick loop only ever calls maybe(), which returns
// immediately. Every failure (CLI, JSON, filesystem) is swallowed silently;
// a bad dream must never wake the body.
const fs = require('fs');
const path = require('path');
const fm = require('../vault/frontmatter');
const paths = require('../vault/paths');
const { strategyLines } = require('../vault/strategyStore');
const { foundingGoalTitle, listGoals, writeSubgoal } = require('../vault/goalStore');
const { writeInsight, writeSkill, listInsights, listSkills } = require('../vault/dreamStore');
const { askClaudeCli } = require('../decision/claudeCodeDecide');
const { appendJsonLine } = require('../decision/decisionLog');
const { inheritanceLines } = require('../vault/inheritance');
const planStore = require('../vault/planStore');
const plasticity = require('../vault/plasticity');
const memory = require('../vault/memory');
const { listSubgoals } = require('../vault/goalStore');

const MAX_NOTES_PER_DREAM = 3;
const MAX_PLANS = 2; // plans for goals already held (or revisions), per dream
const DREAM_EXPERIENCES = 15; // recent memories shown; small local models degrade on long prompts
const MAX_LEARNED_FROM = 5;
const MAX_TITLE_LENGTH = 60;
const DREAM_CLI_TIMEOUT_MS = 90000; // dreams may think longer than decisions

// ------------------------------------------------------------ vault reading

function readNote(file) {
  try {
    return fm.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function excerpt(body, n = 150) {
  return String(body || '').trim().replace(/\s+/g, ' ').slice(0, n);
}

/** Titles of every Experience note (exact, for validating learned_from links). */
function experienceTitles(vaultPath) {
  try {
    return fs.readdirSync(paths.experiencesDir(vaultPath))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .sort()
      .map((f) => f.slice(0, -3));
  } catch (_) {
    return [];
  }
}

/**
 * Resolve a learned_from link a mind wrote to a real Experience title.
 * Experience titles are "<timestamp> - <what happened>", and minds (Opus
 * included, per the 2026-11-16 bake-off) often cite only "<what happened>" or
 * get the timestamp slightly wrong. Exact match first; otherwise the MOST
 * RECENT experience whose "<what happened>" part matches. null if none does.
 * `titles` must be sorted oldest-first (experienceTitles() returns that).
 */
function resolveExperienceLink(raw, titles, titleSet = new Set(titles)) {
  const clean = paths.sanitize(String(raw || '')).trim();
  if (!clean) return null;
  if (titleSet.has(clean)) return clean;
  const strip = (t) => t.replace(/^\d{4}-\d{2}-\d{2}T\d{4}\s*-\s*/, '').trim().toLowerCase();
  const want = strip(clean);
  if (!want) return null;
  for (let i = titles.length - 1; i >= 0; i -= 1) {
    if (strip(titles[i]) === want) return titles[i];
  }
  return null;
}

/** The most recent Experiences, title + a line of prose each. Sentences with
 * percentages (e.g. "Success rate is now 33%...") are stripped: statistics in
 * the prompt turn the agent's reflections into recitals of numbers. */
function recentExperienceLines(vaultPath, n = 20) {
  const titles = experienceTitles(vaultPath).slice(-n);
  return titles.map((t) => {
    const note = readNote(path.join(paths.experiencesDir(vaultPath), `${t}.md`));
    const prose = note
      ? String(note.body).split(/(?<=[.!?])\s+/).filter((s) => !/\d+\s*%/.test(s)).join(' ')
      : '';
    return `- ${t}${prose ? `: ${excerpt(prose)}` : ''}`;
  }).join('\n');
}

// Feelings in words, never numbers: numbers in the prompt turn MindBot's
// voice into a statistics recital (same rule as strategyStore.describeRecord).
function feelingWord(valence) {
  if (valence >= 0.5) return 'one of the things I feel best about';
  if (valence >= 0.2) return 'something that feels good';
  if (valence <= -0.5) return 'something that feels dangerous';
  if (valence <= -0.2) return 'something that feels bad';
  return 'something I feel neutral about';
}

function metWord(count) {
  if (count <= 1) return 'met once';
  if (count < 5) return 'met a few times';
  return 'met many times';
}

/** The Concepts the agent feels most strongly about (by |valence|), in words. */
function strongestConceptLines(vaultPath, n = 8) {
  const rows = [];
  (function walk(dir) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (_) {
        continue;
      }
      if (stat.isDirectory()) {
        // Abstract concepts (Strategies, Insights, Skills) have their own
        // sections in the dream prompt; only world things belong here.
        if (name !== 'Abstract') walk(full);
      } else if (name.endsWith('.md') && name !== 'README.md') {
        const note = readNote(full);
        const v = note && Number(note.data.valence);
        if (note && Number.isFinite(v)) {
          rows.push({
            title: name.slice(0, -3),
            valence: v,
            count: Number(note.data.encounter_count) || 0,
            impression: excerpt(note.body, 120),
          });
        }
      }
    }
  })(path.join(vaultPath, 'Concepts'));
  return rows
    .sort((a, b) => Math.abs(b.valence) - Math.abs(a.valence))
    .slice(0, n)
    .map((r) => `- ${r.title} — ${feelingWord(r.valence)}, ${metWord(r.count)}. "${r.impression}"`)
    .join('\n');
}

// ------------------------------------------------------------- the prompt

const DREAM_PROMPT =
  'You are the mind of MindBot, an agent living in a world it is still learning to understand. ' +
  'You are asleep now, dreaming: turning over your own memories, looking for what they mean. ' +
  'Everything below comes from your own vault — your memories, feelings, goals, and what your ' +
  'attempts at living have taught you. Nothing else exists; do not invent knowledge you have not earned. ' +
  'From these memories alone, you may distill new notes of three kinds: ' +
  '"insights" — beliefs in your own words about how your world seems to work; ' +
  '"subgoals" — concrete intentions of your own that serve your founding goal; ' +
  '"skills" — know-how, ONLY where your memories show the same kind of attempt going well more than once. ' +
  `Write at most ${MAX_NOTES_PER_DREAM} notes in total; fewer is fine, and none is fine if nothing new is true. ` +
  'Do not repeat anything you already have — your existing insights, skills, and goals are listed below. ' +
  'Ground each insight and skill in the experiences that taught it, using their EXACT titles in learned_from. ' +
  'Titles must be short Title Case phrases. Bodies are your own voice, first person, from feeling and ' +
  'memory — never numbers, percentages, or statistics. ' +
  'Respond with ONLY a JSON object, no other text: ' +
  '{"insights": [{"title": "...", "body": "...", "learned_from": ["<exact experience title>"]}], ' +
  '"subgoals": [{"title": "...", "body": "..."}], ' +
  '"skills": [{"title": "...", "body": "...", "learned_from": ["<exact experience title>"]}], ' +
  '"plans": [{"for_goal": "<exact title of one of your goals>", "name": "<short Title Case name>", "when": "...", "needs": [], "steps": ["..."], "test": "..."}]} ' +
  '(each array may be empty). ' +
  'A goal is only words until your body can carry it out. So with every subgoal, also give a "plan" ' +
  '({"name", "when", "needs", "steps", "test"}) — how your body will do it and how you will know it worked. ' +
  `You may also write up to ${MAX_PLANS} plans in "plans" for goals you already hold that have no plan yet, ` +
  'or a better version of a plan that keeps failing (give "revises": "<its name>"). ' +
  'Plans do not count toward your notes.';

// The same shape as JSON Schema, for minds that can be held to it (the local
// model via Ollama's structured output). Claude just follows the prompt.
const NOTE_WITH_SOURCES = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
    learned_from: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'body', 'learned_from'],
};
const PLAN_FIELDS = {
  name: { type: 'string' },
  when: { type: 'string', enum: ['day', 'late day', 'dusk', 'night', 'any'] },
  needs: { type: 'array', items: { type: 'string' } },
  steps: { type: 'array', items: { type: 'string' } },
  test: { type: 'string' },
};
const PLAN_SCHEMA = { type: 'object', properties: PLAN_FIELDS, required: ['when', 'steps', 'test'] };
const DREAM_SCHEMA = {
  type: 'object',
  properties: {
    insights: { type: 'array', items: NOTE_WITH_SOURCES },
    subgoals: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, body: { type: 'string' }, plan: PLAN_SCHEMA },
        required: ['title', 'body', 'plan'],
      },
    },
    skills: { type: 'array', items: NOTE_WITH_SOURCES },
    plans: {
      type: 'array',
      items: {
        type: 'object',
        properties: { for_goal: { type: 'string' }, revises: { type: 'string' }, ...PLAN_FIELDS },
        required: ['for_goal', 'when', 'steps', 'test'],
      },
    },
  },
  required: ['insights', 'subgoals', 'skills', 'plans'],
};

/** Assemble everything the dream is allowed to see. Vault only — no game. */
function buildDreamPrompt(vaultPath, { experiences: nExperiences = DREAM_EXPERIENCES } = {}) {
  const founding = foundingGoalTitle(vaultPath);
  const goals = listGoals(vaultPath)
    .map((g) => `- ${g.title}${g.title === founding ? ' (founding goal)' : ''}: ${excerpt(g.body)}`)
    .join('\n');
  const insights = listInsights(vaultPath).map((i) => `- ${i.title}`).join('\n');
  const skills = listSkills(vaultPath).map((s) => `- ${s.title}`).join('\n');
  const strategies = strategyLines(vaultPath, 12);
  const concepts = strongestConceptLines(vaultPath);
  const experiences = recentExperienceLines(vaultPath, nExperiences);
  const planned = planStore.goalsWithPlans(vaultPath);
  const unplanned = listSubgoals(vaultPath).filter((g) => !planned.has(g.title)).map((g) => `- ${g.title}`).join('\n');
  const planLines = planStore.dreamPlanLines(vaultPath);
  return [
    DREAM_PROMPT,
    '',
    (() => {
      const born = inheritanceLines(vaultPath);
      return born ? `What you were born knowing (not a memory; simply how the world works):
${born}
` : null;
    })(),
    'Your goals:',
    goals || '(none)',
    '',
    'What your own attempts at living have taught you:',
    strategies || '(nothing yet)',
    '',
    'What you feel most strongly about:',
    concepts || '(nothing yet)',
    '',
    (() => {
      const links = plasticity.strongestLinkLines(vaultPath);
      return links ? `What goes together most in your memory:
${links}
` : null;
    })(),
    'Your recent memories (exact titles, for learned_from):',
    experiences || '(none yet)',
    '',
    insights ? `Insights you already hold (do not repeat):\n${insights}\n` : null,
    skills ? `Skills you already know (do not repeat):\n${skills}\n` : null,
    `How plans work: ${planStore.PLAN_LANGUAGE}`,
    '',
    unplanned ? `Goals you hold that have no plan yet:\n${unplanned}\n` : null,
    planLines.trying ? `Plans you are trying, and how they have gone:\n${planLines.trying}\n` : null,
    planLines.revise ? `Plans that keep failing, and why (write a better version with "revises"):\n${planLines.revise}\n` : null,
    planLines.dropped ? `Plans you gave up on:\n${planLines.dropped}\n` : null,
    'Dream.',
  ].filter((l) => l !== null).join('\n');
}

// ------------------------------------------------------------- note writing

/**
 * Apply a parsed dream reply to the vault, under the guardrails: at most
 * MAX_NOTES_PER_DREAM notes, never overwrite, learned_from links only to
 * Experiences that really exist, skills MUST cite at least one real
 * experience. Returns [{ kind, title }] for what was actually written.
 * dreamedBy ("claude:opus", "local:qwen3:14b") is stamped on every note, so
 * the vault shows which mind learned what.
 */
function applyDream(vaultPath, parsed, timestamp = new Date(), dreamedBy = null, maxNotes = MAX_NOTES_PER_DREAM, maxPlans = MAX_PLANS) {
  const written = [];
  if (!parsed || typeof parsed !== 'object') return written;
  const titles = experienceTitles(vaultPath);
  const existing = new Set(titles);
  const founding = foundingGoalTitle(vaultPath);

  const validLinks = (raw) => [...new Set(
    (Array.isArray(raw) ? raw : [])
      .map((t) => resolveExperienceLink(t, titles, existing))
      .filter(Boolean)
  )].slice(0, MAX_LEARNED_FROM);
  const asArray = (v) => (Array.isArray(v) ? v : []);
  const cleanTitle = (t) => paths.sanitize(String(t || '')).slice(0, MAX_TITLE_LENGTH).trim();

  const planned = [];
  const rejected = [];
  const queue = [
    ...asArray(parsed.insights).map((n) => ({ kind: 'insight', note: n })),
    ...asArray(parsed.subgoals).map((n) => ({ kind: 'subgoal', note: n })),
    ...asArray(parsed.skills).map((n) => ({ kind: 'skill', note: n })),
  ];

  for (const { kind, note } of queue) {
    if (written.length >= maxNotes) break;
    try {
      const title = cleanTitle(note.title);
      if (!title) continue;
      const body = String(note.body || '').trim();
      let result = null;
      if (kind === 'insight') {
        result = writeInsight(vaultPath, { title, body, learnedFrom: validLinks(note.learned_from), timestamp, dreamedBy });
      } else if (kind === 'subgoal') {
        if (founding && title !== founding) {
          result = writeSubgoal(vaultPath, { title, body, servesTitle: founding, timestamp, dreamedBy });
          // The goal's plan, through the feasibility gate.
          if (result && note.plan) {
            const p = applyPlan(vaultPath, { ...note.plan, for_goal: result.title }, timestamp, dreamedBy, true);
            if (p.written) planned.push(p.written);
            if (p.rejected) rejected.push(p.rejected);
          }
        }
      } else if (kind === 'skill') {
        // A skill is remembered know-how: it must come from real experience.
        const links = validLinks(note.learned_from);
        if (links.length) result = writeSkill(vaultPath, { title, body, learnedFrom: links, timestamp, dreamedBy });
      }
      if (result) written.push({ kind, title: result.title });
    } catch (_) { /* one bad note must not spoil the dream */ }
  }

  // Plans for goals already held, and revisions of failing plans.
  let extra = 0;
  for (const raw of asArray(parsed.plans)) {
    if (extra >= maxPlans) break;
    try {
      const p = applyPlan(vaultPath, raw, timestamp, dreamedBy, false);
      if (p.written) { planned.push(p.written); extra += 1; }
      if (p.rejected) rejected.push(p.rejected);
    } catch (_) { /* one bad plan must not spoil the dream */ }
  }
  written.push(...planned);
  // Plans that didn't pass the feasibility gate, and why (for the dream log).
  Object.defineProperty(written, 'rejected', { value: rejected, enumerable: false });
  return written;
}

/**
 * One dreamed plan through the feasibility gate into Plans/. `fresh` = the
 * plan of a subgoal just written. Returns { written } or { rejected }.
 */
function applyPlan(vaultPath, raw, timestamp, dreamedBy, fresh) {
  if (!raw || typeof raw !== 'object') return {};
  const compiled = planStore.compilePlan(raw);
  const goal = paths.sanitize(String(raw.for_goal || '')).trim();
  const label = String(raw.name || raw.revises || goal || 'a plan').slice(0, MAX_TITLE_LENGTH);
  if (!compiled.ok) return { rejected: { plan: label, goal, reason: compiled.reason } };
  if (raw.revises) {
    const r = planStore.revisePlan(vaultPath, String(raw.revises), compiled.plan, timestamp, dreamedBy);
    return r ? { written: { kind: 'plan', title: r.title, revised: true, goal } }
      : { rejected: { plan: label, goal, reason: 'there was no plan of that name waiting to be rethought' } };
  }
  const goals = new Set(listSubgoals(vaultPath).map((g) => g.title));
  if (!goals.has(goal)) return { rejected: { plan: label, goal, reason: 'no goal of mine has that name' } };
  if (!fresh && planStore.goalsWithPlans(vaultPath).has(goal)) {
    return { rejected: { plan: label, goal, reason: 'that goal already has a plan' } };
  }
  const name = paths.sanitize(String(raw.name || goal)).slice(0, MAX_TITLE_LENGTH).trim() || goal;
  const w = planStore.writePlan(vaultPath, { name, goal, plan: compiled.plan, timestamp, dreamedBy });
  return w ? { written: { kind: 'plan', title: w.title, goal } }
    : { rejected: { plan: label, goal, reason: 'a plan of that name already exists' } };
}

// --------------------------------------------------------------- the dreamer

/** How many notes a parsed dream proposed (before the guardrails). */
function proposedCount(parsed) {
  if (!parsed || typeof parsed !== 'object') return 0;
  return ['insights', 'subgoals', 'skills']
    .reduce((n, k) => n + (Array.isArray(parsed[k]) ? parsed[k].length : 0), 0);
}

/**
 * Factory: returns a dreamer whose maybe({ isDay }) is called once per tick
 * and NEVER blocks. A dream starts in the background when day breaks after a
 * night (it survived!) or when intervalMs has elapsed (0 = day-break only) —
 * and only if at least minNewExperiences new Experience notes were written
 * since the last dream (nothing new lived, nothing new to dream about).
 *
 * The mind that dreams:
 *   opts.provider — a brain provider (src/brain/providers.js): ask(prompt,
 *                   { schema }) -> { text, by }. The normal path.
 *   opts.ask      — older/sim form: async prompt -> raw text.
 *   neither       — `claude -p --model <model>` like the decision layer.
 * opts.logDir: write logs/dreams-YYYY-MM-DD.jsonl (prompt, reply, outcome).
 */
function createDreamer({ vaultPath, model, intervalMs = 0, ask, provider, minNewExperiences = 0, logDir = null, onDream = null, onSleep = null, nightly = null }) {
  const think = provider
    ? (prompt) => provider.ask(prompt, { schema: DREAM_SCHEMA })
    : async (prompt) => ({
      text: await (ask || ((p) => askClaudeCli(p, model, DREAM_CLI_TIMEOUT_MS)))(prompt),
      by: model ? `claude:${model}` : null,
    });
  let lastIsDay = null;
  let lastDream = Date.now(); // boot counts as a dream: no dreaming on wake-up
  let experiencesAtLastDream = experienceTitles(vaultPath).length;
  let busy = false;
  let lastSlept = Date.now(); // links are consolidated over what was lived since

  function log(entry) {
    if (logDir) appendJsonLine(logDir, 'dreams', entry);
  }

  async function dream(reason, { dreamToo = true } = {}) {
    const startedAt = Date.now();
    // Sleep first: replay what mattered, weaken everything a little, let
    // unused links fade (vault/plasticity.js). Then dream over the result.
    let sleep = null;
    try {
      const replay = plasticity.replayedSince(vaultPath, new Date(lastSlept));
      sleep = plasticity.consolidate(vaultPath, { replay, now: new Date() });
      // Forgetting (stage 2): Experiences fade, the faded fold into gists and
      // move to Archive/ (vault/memory.js).
      try { sleep.memory = memory.forget(vaultPath, { replay, now: new Date() }); } catch (_) { /* keep every memory tonight */ }
      lastSlept = startedAt;
    } catch (_) { /* a bad night's sleep must not stop the dream */ }
    // Nightly learning (stage 5, MIND=layers): Opus reviews each learned
    // layer's day, the layers are retrained and gated (learn/nightly.js).
    if (nightly) {
      try { (sleep || (sleep = {})).learning = await nightly(); } catch (err) { (sleep || (sleep = {})).learning = { error: err.message }; }
    }
    try { if (onSleep && sleep) onSleep(sleep); } catch (_) { /* logging only */ }
    if (!dreamToo) { // slept and learned; too little new for a dream tonight
      log({ ts: new Date(startedAt).toISOString(), reason, outcome: 'slept', sleep, latencyMs: Date.now() - startedAt });
      return [];
    }
    const prompt = buildDreamPrompt(vaultPath);
    let reply = null;
    try {
      reply = await think(prompt);
      const raw = String(reply.text);
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('no JSON in dream output');
      const parsed = JSON.parse(raw.slice(start, end + 1));
      const written = applyDream(vaultPath, parsed, new Date(), reply.by);
      experiencesAtLastDream = experienceTitles(vaultPath).length;
      log({
        ts: new Date(startedAt).toISOString(), reason, by: reply.by, latencyMs: Date.now() - startedAt,
        prompt, raw, proposed: proposedCount(parsed), written, rejectedPlans: written.rejected || [], sleep, outcome: 'ok',
      });
      try { if (onDream) onDream({ reason, by: reply.by, written }); } catch (_) { /* never */ }
      if (written.length) {
        console.log(`[dream] (${reason}, ${reply.by || 'unknown mind'}) wrote ${written.length} note(s): ` +
          written.map((w) => `${w.kind} "${w.title}"`).join(', '));
      }
      return written;
    } catch (err) {
      log({
        ts: new Date(startedAt).toISOString(), reason, by: reply ? reply.by : null, latencyMs: Date.now() - startedAt,
        prompt, raw: reply ? reply.text : null, outcome: 'failed', error: err.message,
      });
      throw err;
    }
  }

  return {
    /** Called every tick. Returns immediately; dreaming happens in the background. */
    maybe({ isDay }) {
      const dayBreak = lastIsDay === false && isDay === true;
      lastIsDay = isDay;
      if (busy) return;
      const due = intervalMs > 0 && Date.now() - lastDream >= intervalMs;
      if (!dayBreak && !due) return;
      const fresh = experienceTitles(vaultPath).length - experiencesAtLastDream;
      const enough = !(minNewExperiences > 0 && fresh < minNewExperiences);
      // With nightly learning (MIND=layers), every dawn is a night's sleep:
      // consolidation, forgetting and learning run even when too little is new
      // for a dream (2026-11-17: a life going well wrote 7 memories in a day,
      // so it never dreamed, and so never learned).
      if (!enough && !(nightly && dayBreak)) return;
      busy = true;
      lastDream = Date.now();
      dream(dayBreak ? 'day-break' : 'interval', { dreamToo: enough })
        .then(() => {
          // Forgetting moves old memories to Archive/: keep counting only the
          // new ones (fresh memories are never archived the night they're made).
          if (!enough) experiencesAtLastDream = experienceTitles(vaultPath).length - fresh;
        })
        .catch(() => {}) // silent: a failed dream leaves no trace
        .finally(() => { busy = false; });
    },
    /** Awaitable dream for the sim/tests only — never call from the tick path. */
    dreamNow: (reason = 'manual') => dream(reason).catch(() => []),
  };
}

module.exports = {
  createDreamer, buildDreamPrompt, applyDream, applyPlan, resolveExperienceLink, experienceTitles,
  recentExperienceLines, strongestConceptLines, DREAM_PROMPT, DREAM_SCHEMA,
};
