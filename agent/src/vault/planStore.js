// Plans: goals the body can run (docs/design-plans-and-skills.md).
//
// A plan is a note in Plans/ written by a dream: a short program of the body's
// own primitives ("dig below", "explore until near bed"), the time of day it
// is for, and a TEST the body can check ("near bed at nightfall"). The same
// note is read as data by the dream and as instructions by the plan runner
// (Turing's stored program). Every run is graded against the test (Newell &
// Simon's generate-and-test; Lucken's specification / performance /
// registration); plans that keep passing are promoted to Skills, plans that
// keep failing are marked for revision and finally dropped — never deleted.
const fs = require('fs');
const path = require('path');
const fm = require('./frontmatter');
const paths = require('./paths');
const { DIRECTION_NAMES, MOVE_DIRECTIONS, normalizeDirection } = require('../actions/bodyFrame');

const MAX_STEPS = 12;
const PROMOTE_PASSES = 3; // passes needed to become a Skill...
const PROMOTE_SHARE = 2 / 3; // ...with at least this share of graded runs passing
const REVISE_AFTER = 3; // graded runs without a single pass -> revise
const MAX_VERSIONS = 3; // the original + 2 revisions, then dropped
const SKILL_RECENT = 6; // a Skill whose last 6 runs pass under half the time goes back to trying
const RECENT_KEEP = 10;

// ------------------------------------------------------------ the language

const WINDOWS = ['day', 'late day', 'dusk', 'night', 'any'];
const VERBS = ['dig', 'place', 'move', 'jump', 'use', 'equip', 'craft', 'approach', 'swingAt', 'pickup', 'eat', 'explore', 'wait'];
const NIGHT_TESTS = { slept: 'slept', 'slept through the night': 'slept', 'survived the night': 'survived', 'unhurt through the night': 'unhurt' };

/** "a Crafting Table" -> "crafting_table". */
function thingName(raw) {
  return String(raw || '').toLowerCase().trim()
    .replace(/^(a|an|the|some|my)\s+/, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

/**
 * Parse a condition phrase into { kind, thing, n, timing } or null.
 * timing: 'now' | 'nightfall' | 'dawn'.
 */
function parseCondition(raw) {
  let s = String(raw || '').toLowerCase().trim().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
  if (!s) return null;
  if (NIGHT_TESTS[s]) return { kind: NIGHT_TESTS[s], timing: 'dawn' };
  let timing = 'now';
  const nf = / (at|by) (nightfall|dusk)$/;
  if (nf.test(s)) { timing = 'nightfall'; s = s.replace(nf, ''); }
  let m;
  if ((m = /^(?:carrying|carry|have|having) (?:(\d+) )?(.+?)(?: x?(\d+))?$/.exec(s))) {
    const thing = thingName(m[2]);
    return thing ? { kind: 'carrying', thing, n: Number(m[1] || m[3] || 1), timing } : null;
  }
  if ((m = /^(?:holding|hold) (.+)$/.exec(s))) {
    const thing = thingName(m[1]);
    return thing ? { kind: 'holding', thing, timing } : null;
  }
  if ((m = /^(?:near|beside|next to|close to|at) (.+?)(?: (?:within )?(\d+)(?: blocks?)?)?$/.exec(s))) {
    const thing = thingName(m[1]);
    return thing ? { kind: 'near', thing, n: Number(m[2] || 4), timing } : null;
  }
  if (/^(enclosed|closed in|walled in)$/.test(s)) return { kind: 'enclosed', timing };
  if (/^(roof over me|under a roof|covered)$/.test(s)) return { kind: 'roof', timing };
  if (/^(fed|full|not hungry)$/.test(s)) return { kind: 'fed', timing };
  if (timing === 'now' && /^(dusk|nightfall|evening)$/.test(s)) return { kind: 'dusk', timing };
  if (timing === 'now' && /^(day|daylight|morning)$/.test(s)) return { kind: 'day', timing };
  return null;
}

/** A condition back to words (for notes and prompts). */
function conditionText(c) {
  if (!c) return '';
  const base = {
    carrying: () => `carrying ${c.n > 1 ? `${c.n} ` : ''}${c.thing}`,
    holding: () => `holding ${c.thing}`,
    near: () => `near ${c.thing}${c.n != null && c.n !== 4 ? ` ${c.n}` : ''}`,
    enclosed: () => 'enclosed',
    roof: () => 'roof over me',
    fed: () => 'fed',
    dusk: () => 'dusk',
    day: () => 'day',
    slept: () => 'slept through the night',
    survived: () => 'survived the night',
    unhurt: () => 'unhurt through the night',
  }[c.kind];
  const text = base ? base() : c.kind;
  return c.timing === 'nightfall' ? `${text} at nightfall` : text;
}

/** Parse one step ("dig below", "approach cow until near cow") -> step or { error }. */
function parseStep(raw) {
  let s = String(raw || '').trim().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
  if (!s) return { error: 'an empty step' };
  let until = null;
  const u = / until (.+)$/i.exec(s);
  if (u) {
    until = parseCondition(u[1]);
    if (!until) return { error: `I don't know how to tell "${u[1]}"` };
    if (until.timing !== 'now') return { error: `"until ${u[1]}" can't be checked while I act` };
    s = s.slice(0, u.index).trim();
  }
  s = s.replace(/^swing at /i, 'swingAt ').replace(/^pick up\b/i, 'pickup').replace(/^walk /i, 'move ');
  const [head, ...rest] = s.split(' ');
  const verb = VERBS.find((v) => v.toLowerCase() === head.toLowerCase());
  if (!verb) return { error: `my body has no way to "${head}"` };
  const arg = rest.join(' ').trim();
  const step = { verb, until };
  switch (verb) {
    case 'dig': {
      const at = normalizeDirection(arg || 'below');
      if (!at) return { error: `"${arg}" is not a direction I can dig` };
      step.at = at;
      break;
    }
    case 'place': {
      const parts = arg.split(' ');
      const at = normalizeDirection(parts[0] || 'ahead');
      if (!at) return { error: `"${parts[0]}" is not a direction I can place toward` };
      step.at = at;
      const item = thingName(parts.slice(1).join(' '));
      if (item) step.item = item;
      break;
    }
    case 'move': {
      const at = normalizeDirection(arg || 'ahead');
      if (!MOVE_DIRECTIONS.includes(at)) return { error: `"${arg}" is not a way I can walk` };
      step.at = at;
      break;
    }
    case 'use': {
      const at = normalizeDirection(arg);
      if (at) step.at = at;
      else if (thingName(arg)) step.thing = thingName(arg);
      else return { error: 'use what?' };
      break;
    }
    case 'equip':
    case 'craft': {
      const item = thingName(arg);
      if (!item) return { error: `${verb} what?` };
      step.item = item;
      break;
    }
    case 'eat':
      if (thingName(arg)) step.item = thingName(arg);
      break;
    case 'approach':
    case 'swingAt': {
      const thing = thingName(arg);
      if (!thing) return { error: `${verb} what?` };
      step.thing = thing;
      break;
    }
    default:
      break; // jump, pickup, explore, wait take no argument
  }
  if (verb === 'wait' && !until) return { error: '"wait" needs an "until"' };
  return step;
}

/** A step back to words. */
function stepText(st) {
  const arg = st.at ? `${st.at}${st.item ? ` ${st.item}` : ''}` : (st.thing || st.item || '');
  return `${st.verb}${arg ? ` ${arg}` : ''}${st.until ? ` until ${conditionText(st.until)}` : ''}`;
}

function normalizeWindow(raw) {
  const w = String(raw || 'any').toLowerCase().trim().replace(/[-_]/g, ' ');
  const alias = { daytime: 'day', 'by day': 'day', afternoon: 'late day', evening: 'dusk', 'before dusk': 'late day', 'before dark': 'late day', anytime: 'any', always: 'any' };
  const v = alias[w] || w;
  return WINDOWS.includes(v) ? v : null;
}

/**
 * The feasibility gate (design-learning-from-the-readings.md §2.3): does this
 * plan compile to what the body can do and sense? Returns
 * { ok: true, plan: { when, needs, steps, test } } or { ok: false, reason }.
 */
function compilePlan(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'there was no plan' };
  const when = normalizeWindow(raw.when);
  if (!when) return { ok: false, reason: `I can't tell when "${raw.when}" is` };
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  if (!rawSteps.length) return { ok: false, reason: 'the plan had no steps' };
  if (rawSteps.length > MAX_STEPS) return { ok: false, reason: `the plan had more than ${MAX_STEPS} steps` };
  const steps = [];
  for (const r of rawSteps) {
    const st = parseStep(r);
    if (st.error) return { ok: false, reason: st.error };
    steps.push(stepText(st));
  }
  const test = parseCondition(raw.test);
  if (!test) return { ok: false, reason: `I don't know how to tell whether "${raw.test}" came true` };
  const needs = [];
  for (const n of (Array.isArray(raw.needs) ? raw.needs : (raw.needs ? [raw.needs] : []))) {
    const c = parseCondition(n);
    if (!c || c.timing !== 'now') return { ok: false, reason: `I don't know how to tell "${n}"` };
    needs.push(conditionText(c));
  }
  return { ok: true, plan: { when, needs, steps, test: conditionText(test) } };
}

/** Parse a stored plan's frontmatter into runnable form (or null). */
function runnable(data) {
  try {
    const steps = (data.steps || []).map(parseStep);
    if (!steps.length || steps.some((s) => s.error)) return null;
    const test = parseCondition(data.test);
    if (!test) return null;
    const needs = (data.needs || []).map(parseCondition);
    if (needs.some((n) => !n)) return null;
    return { when: normalizeWindow(data.when) || 'any', steps, test, needs };
  } catch (_) {
    return null;
  }
}

// ------------------------------------------------------------ the notes

function plansDir(vaultPath) {
  return path.join(vaultPath, 'Plans');
}

function planPath(vaultPath, name) {
  return path.join(plansDir(vaultPath), `${paths.sanitize(name)}.md`);
}

function readPlan(vaultPath, name) {
  try {
    const { data, body } = fm.parse(fs.readFileSync(planPath(vaultPath, name), 'utf8'));
    return { name: paths.sanitize(name), data, body };
  } catch (_) {
    return null;
  }
}

function listPlans(vaultPath) {
  let files;
  try {
    files = fs.readdirSync(plansDir(vaultPath)).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
  } catch (_) {
    return [];
  }
  return files.map((f) => readPlan(vaultPath, f.slice(0, -3))).filter(Boolean);
}

/** Plans that may run: status trying or skill, and still parse. */
function runnablePlans(vaultPath) {
  return listPlans(vaultPath)
    .filter((p) => p.data.status === 'trying' || p.data.status === 'skill')
    .map((p) => ({ ...p, program: runnable(p.data) }))
    .filter((p) => p.program);
}

/** Find a plan by name, forgiving case and small differences. */
function findPlan(vaultPath, name) {
  const want = String(name || '').toLowerCase().trim();
  if (!want) return null;
  const all = listPlans(vaultPath);
  return all.find((p) => p.name.toLowerCase() === want)
    || all.find((p) => p.name.toLowerCase().includes(want) || want.includes(p.name.toLowerCase()))
    || null;
}

function planBody(name, goal, plan) {
  return [
    `My plan for [[${goal}]].`,
    '',
    `When: ${plan.when}${plan.needs.length ? `, once I am ${plan.needs.join(' and ')}` : ''}.`,
    '',
    ...plan.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    `It worked if: ${plan.test}.`,
  ].join('\n');
}

function writeNote(file, data, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fm.stringify(data, body), 'utf8');
}

/**
 * Write a new plan for a goal. `raw` must already have passed compilePlan.
 * Never overwrites: returns null if a plan with this name exists.
 */
function writePlan(vaultPath, { name, goal, plan, timestamp = new Date(), dreamedBy = null }) {
  const clean = paths.sanitize(name || goal);
  if (!clean) return null;
  const file = planPath(vaultPath, clean);
  if (fs.existsSync(file)) return null;
  const data = {
    is_a: fm.link('Plan'),
    serves: fm.link(goal),
    when: plan.when,
    needs: plan.needs,
    steps: plan.steps,
    test: plan.test,
    status: 'trying',
    version: 1,
    runs: 0, passed: 0, failed: 0, broke: 0,
    recent: [],
    written_on: timestamp.toISOString(),
    tags: ['type/plan'],
  };
  if (dreamedBy) data.dreamed_by = dreamedBy;
  writeNote(file, data, planBody(clean, goal, plan));
  return { title: clean, file };
}

/** Plans whose goal has none yet: which active subgoals lack a plan. */
function goalsWithPlans(vaultPath) {
  const out = new Set();
  for (const p of listPlans(vaultPath)) {
    const m = /\[\[(.+?)\]\]/.exec(String(p.data.serves || ''));
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * Replace a plan's program with a revised version (only plans marked
 * `revise`). The old version is kept in `history`, with why it was replaced.
 */
function revisePlan(vaultPath, name, plan, timestamp = new Date(), dreamedBy = null) {
  const p = readPlan(vaultPath, name);
  if (!p || p.data.status !== 'revise') return null;
  const d = p.data;
  const history = Array.isArray(d.history) ? d.history : [];
  history.push({
    version: d.version || 1, when: d.when, needs: d.needs || [], steps: d.steps, test: d.test,
    passed: d.passed || 0, failed: d.failed || 0, broke: d.broke || 0,
    why_replaced: d.last_reason || 'it kept failing',
  });
  const goal = (/\[\[(.+?)\]\]/.exec(String(d.serves || '')) || [])[1] || p.name;
  const data = {
    ...d, when: plan.when, needs: plan.needs, steps: plan.steps, test: plan.test,
    status: 'trying', version: (d.version || 1) + 1, passed: 0, failed: 0, broke: 0, recent: [],
    history, revised_on: timestamp.toISOString(),
  };
  if (dreamedBy) data.dreamed_by = dreamedBy;
  writeNote(planPath(vaultPath, p.name), data, planBody(p.name, goal, plan));
  return { title: p.name };
}

/** Write (or refresh) the Skill note a plan was promoted to. */
function writeSkillFromPlan(vaultPath, p, timestamp) {
  const file = paths.skillPath(vaultPath, p.name);
  let prev = null;
  try { prev = fm.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* new */ }
  if (prev && !prev.data.promoted_from) return null; // a dreamed prose skill of the same name: leave it be
  const data = {
    is_a: fm.link('Skill'),
    promoted_from: fm.link(`Plans/${p.name}`),
    serves: p.data.serves,
    when: p.data.when,
    needs: p.data.needs || [],
    steps: p.data.steps,
    test: p.data.test,
    promoted_on: prev ? prev.data.promoted_on : timestamp.toISOString(),
    record: { passed: p.data.passed, failed: p.data.failed, broke: p.data.broke },
    tags: ['type/skill', 'skill/callable'],
  };
  const body = [
    `Something I know how to do: I can call it by name ("${p.name}").`,
    '',
    ...p.data.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    `It works when: ${p.data.test}. Learned by trying it again and again until it kept working.`,
  ].join('\n');
  writeNote(file, data, body);
  return { title: p.name, isNew: !prev };
}

function commonest(reasons) {
  const counts = {};
  for (const r of reasons.filter(Boolean)) counts[r] = (counts[r] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

/**
 * Record one graded run: grade is 'passed' | 'failed' | 'broke' |
 * 'interrupted' (not counted). Applies the generate-and-test rules and
 * returns { status, promoted, revise, dropped, demoted } describing what changed.
 */
function recordRun(vaultPath, name, { grade, reason = null, timestamp = new Date() }) {
  const p = readPlan(vaultPath, name);
  if (!p) return null;
  const d = { ...p.data };
  const events = { status: d.status };
  d.runs = (d.runs || 0) + 1;
  d.last_run = timestamp.toISOString();
  // Not counted either way: the world interrupted it, or (moot) the test was
  // already true before the plan began, so a pass would prove nothing.
  if (grade === 'interrupted' || grade === 'moot') {
    d[grade] = (d[grade] || 0) + 1;
    writeNote(planPath(vaultPath, p.name), d, p.body);
    return events;
  }
  d[grade] = (d[grade] || 0) + 1;
  d.recent = [...(Array.isArray(d.recent) ? d.recent : []), grade === 'passed' ? 'pass' : `${grade}: ${reason || ''}`.trim()].slice(-RECENT_KEEP);
  if (grade !== 'passed') d.last_reason = reason || (grade === 'failed' ? `it did not come true that I was ${d.test}` : 'a step could not be done');
  const passed = d.passed || 0;
  const graded = passed + (d.failed || 0) + (d.broke || 0);

  if (d.status === 'trying' && passed >= PROMOTE_PASSES && passed / graded >= PROMOTE_SHARE) {
    d.status = 'skill';
    d.promoted_on = timestamp.toISOString();
    events.promoted = true;
  } else if (d.status === 'trying' && passed === 0 && graded >= REVISE_AFTER) {
    const reasons = d.recent.filter((r) => r !== 'pass').map((r) => r.replace(/^(failed|broke): /, ''));
    d.last_reason = commonest(reasons) || d.last_reason;
    if ((d.version || 1) >= MAX_VERSIONS) {
      d.status = 'dropped';
      d.dropped_on = timestamp.toISOString();
      events.dropped = true;
    } else {
      d.status = 'revise';
      events.revise = true;
    }
  } else if (d.status === 'skill') {
    const last = d.recent.slice(-SKILL_RECENT);
    if (last.length >= SKILL_RECENT && last.filter((r) => r === 'pass').length < SKILL_RECENT / 2) {
      d.status = 'trying';
      d.passed = 0; d.failed = 0; d.broke = 0;
      events.demoted = true;
    }
  }
  events.status = d.status;
  writeNote(planPath(vaultPath, p.name), d, p.body);
  if (events.promoted || d.status === 'skill') {
    const s = writeSkillFromPlan(vaultPath, { name: p.name, data: d }, timestamp);
    if (s && s.isNew) events.skillWritten = s.title;
  }
  return events;
}

// ------------------------------------------------------------ prompt lines

function recordWords(d) {
  const n = (k) => d[k] || 0;
  const times = (k, word) => (n(k) ? `${word} ${n(k) === 1 ? 'once' : n(k) === 2 ? 'twice' : 'many times'}` : null);
  return [times('passed', 'worked'), times('failed', 'did not work'), times('broke', 'could not be carried out')]
    .filter(Boolean).join(', ') || 'not tried yet';
}

/** For the cortex: plans and skills it can call by name. */
function callableLines(vaultPath, max = 8) {
  const lines = listPlans(vaultPath)
    .filter((p) => p.data.status === 'trying' || p.data.status === 'skill')
    .sort((a, b) => (a.data.status === 'skill' ? -1 : 0) - (b.data.status === 'skill' ? -1 : 0))
    .slice(0, max)
    .map((p) => `- "${p.name}"${p.data.status === 'skill' ? ' (a skill I have mastered)' : ' (a plan I am trying)'}: ` +
      `${(p.data.steps || []).join(', ')} — it worked if ${p.data.test}; so far ${recordWords(p.data)}.`);
  return lines.length ? lines.join('\n') : null;
}

/** For the dream: how its plans are going, and which need rethinking. */
function dreamPlanLines(vaultPath) {
  const plans = listPlans(vaultPath);
  const trying = plans.filter((p) => p.data.status === 'trying' || p.data.status === 'skill')
    .map((p) => `- ${p.name} (for ${String(p.data.serves || '').replace(/\[\[|\]\]/g, '')}): ${recordWords(p.data)}.`);
  const revise = plans.filter((p) => p.data.status === 'revise')
    .map((p) => `- ${p.name}: ${(p.data.steps || []).join(', ')}; test: ${p.data.test}. It keeps failing because ${p.data.last_reason || 'it does not come true'}.`);
  const dropped = plans.filter((p) => p.data.status === 'dropped')
    .map((p) => `- ${p.name}: given up, because ${p.data.last_reason || 'it never worked'}.`);
  return { trying: trying.join('\n') || null, revise: revise.join('\n') || null, dropped: dropped.join('\n') || null };
}

/** The words a dream needs to write a plan the body can run. */
const PLAN_LANGUAGE =
  'A plan is a few steps your body can do, one per line, each one of: ' +
  `dig <where>, place <where> [block], move <${MOVE_DIRECTIONS.join('|')}>, jump, use <bed|door|where>, ` +
  'equip <thing>, craft <thing>, approach <creature or block>, swingAt <creature>, pickup, eat [thing], explore, ' +
  'wait — and any step may end with "until <condition>" (wait always needs one). ' +
  `<where> is relative to your body: ${DIRECTION_NAMES.join(', ')}. ` +
  'Conditions your body can feel: carrying <thing> [count], holding <thing>, near <thing>, enclosed, roof over me, ' +
  'fed, dusk, day. A plan has "when" (day, late day, dusk, night, or any), optional "needs" (conditions that must ' +
  'hold to begin), the "steps", and a "test" — how you will know it worked: one condition, now or "at nightfall" ' +
  '(e.g. "near bed at nightfall", "enclosed at nightfall", "carrying crafting_table"), or one of "slept through the ' +
  'night", "survived the night", "unhurt through the night". Your night instincts still keep you safe after dusk, ' +
  'so a plan for the night is best done in the late day, to be ready when dark falls.';

module.exports = {
  parseCondition, conditionText, parseStep, stepText, compilePlan, runnable, normalizeWindow,
  plansDir, planPath, readPlan, listPlans, runnablePlans, findPlan, writePlan, revisePlan, goalsWithPlans,
  recordRun, writeSkillFromPlan, callableLines, dreamPlanLines, recordWords, PLAN_LANGUAGE,
  MAX_STEPS, PROMOTE_PASSES, REVISE_AFTER, MAX_VERSIONS,
};
