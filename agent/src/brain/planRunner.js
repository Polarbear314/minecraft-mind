// The plan runner (docs/design-plans-and-skills.md §3): carries one plan from
// the vault (Plans/) step by step across ticks, so a multi-step project
// outlives the cortex's ~30-second deliberations. It never decides WHAT to
// want — the dream wrote the plan — only keeps the body at it, then grades the
// run against the plan's own test and lets planStore promote, revise or drop.
//
// Priority (brain/arbiter.js): emergencies and the night-shelter reflex first,
// then the running plan, then Claude / the inner voice / instinct.
//
//   next(observation, { emergency })  -> the plan's action this tick, or null
//   afterTick({ action, result, observation })  -> step bookkeeping + grading
//   start(name, by) / stop(reason) / noteDeath() / status()
const { appendJsonLine } = require('../decision/decisionLog');
const { logExperience } = require('../vault/experienceLog');
const planStore = require('../vault/planStore');
const { isEvening } = require('../decision/reflexes');

const STEP_TICKS = 60; // ~90 s per step before it counts as not done
const RUN_TICKS = 200; // ~5 min for a whole run
const EXPLORE_TICKS = 10; // a bare "explore" step: walk a while
const RETRIES = 2; // a refused step is tried this many more times
const PAUSE_MAX_MS = 60000; // an emergency longer than this interrupts the run
const GRACE_TICKS = 4; // a "now" test may come true a moment after the last step
const NIGHTFALL_WAIT_MS = 25 * 60000; // a nightfall test older than this was lost track of
const COOLDOWN_MS = 10 * 60000; // a plan starts by itself at most once per ~half a day
const DUSK_END = 13500;
const LATE_DAY = 8000;
const DUSK = 11800;

const ONE_SHOT = new Set(['dig', 'place', 'move', 'jump', 'equip', 'craft', 'eat', 'use']);

/** Is it the plan's time of day? */
function inWindow(when, o) {
  if (when === 'any') return true;
  const t = o.timeOfDay;
  const evening = isEvening(o);
  if (t == null) return when === 'day' || when === 'late day' ? !evening : evening;
  switch (when) {
    case 'day': return !evening;
    case 'late day': return !evening && t >= LATE_DAY && t < DUSK;
    case 'dusk': return t >= DUSK && t < DUSK_END;
    case 'night': return evening && !(t >= DUSK && t < DUSK_END);
    default: return false;
  }
}

const matches = (name, thing) => {
  const n = String(name || '').toLowerCase();
  return n === thing || n.includes(thing) || (thing.endsWith('s') && n.includes(thing.slice(0, -1)));
};

/** The nearest perceived thing (creature, block, door/bed, item on the ground) by name. */
function findThing(thing, o) {
  const ent = (o.nearbyEntities || []).find((e) => matches(e.name, thing));
  if (ent) return { name: ent.name, distance: ent.distance, position: ent.position, entity: ent };
  const a = o.affordances || {};
  for (const kind of ['bed', 'door', 'trapdoor', 'gate']) {
    if (a[kind] && (thing === kind || matches(a[kind].name, thing))) return { ...a[kind] };
  }
  const block = (o.nearbyBlocks || []).find((b) => matches(b.name, thing));
  if (block) return { ...block };
  const item = (o.nearbyItems || []).find((i) => matches(i.name, thing));
  if (item) return { ...item };
  return null;
}

/** Does a condition hold in this observation? (dawn tests are graded elsewhere) */
function holds(c, o) {
  const inv = o.inventory || [];
  switch (c.kind) {
    case 'carrying': return inv.filter((i) => matches(i.name, c.thing)).reduce((n, i) => n + (i.count || 0), 0) >= (c.n || 1);
    case 'holding': return !!o.heldItem && matches(o.heldItem, c.thing);
    case 'near': {
      const t = findThing(c.thing, o);
      return !!t && t.distance != null && t.distance <= (c.n || 4);
    }
    case 'enclosed': return !!(o.affordances && o.affordances.enclosed);
    case 'roof': return !!(o.affordances && (o.affordances.roof || !o.affordances.skyOverhead));
    case 'fed': return o.food != null && o.food >= 18;
    case 'dusk': return isEvening(o);
    case 'day': return !isEvening(o);
    default: return false;
  }
}

function createPlanRunner({ vaultPath, logDir = null, blackboard = null, autoStart = true, cooldownMs = COOLDOWN_MS, now = () => Date.now() }) {
  let run = null; // the running plan
  let nextId = 1;
  const pending = []; // runs whose steps are done, waiting to be graded
  const lastStarted = new Map(); // plan name -> ms

  const fire = (text) => { try { if (blackboard) blackboard.fire('frontal', text); } catch (_) { /* never */ } };

  /** Does a test already hold right now? (Night tests can't be judged until dawn: never.) */
  function alreadySo(test, o) {
    if (!test || test.timing === 'dawn' || !o) return false;
    try { return holds(test, o); } catch (_) { return false; }
  }

  function begin(plan, by, o = null) {
    run = {
      id: nextId++, name: plan.name, version: plan.data.version || 1, status: plan.data.status,
      program: plan.program, by, startedAt: now(), step: 0, stepTicks: 0, ticks: 0,
      retries: 0, started: false, swung: false, pausedSince: null, trace: [],
      // Was the test already true before the plan did anything? Then a pass
      // proves nothing (2026-11-17: "near grass" passed every time).
      baseline: o ? alreadySo(plan.program.test, o) : null,
    };
    lastStarted.set(plan.name, now());
    fire(`plan "${plan.name}" begins (${by}): ${planStore.stepText(run.program.steps[0])}`);
    return run;
  }

  function finish(r, grade, reason, extra = {}) {
    // A pass counts only if the plan did its steps AND changed something: a
    // test that already held when it began proves nothing about the plan.
    if (grade === 'passed' && r.step < r.program.steps.length) { grade = 'broke'; reason = 'I never finished the steps'; }
    if (grade === 'passed' && r.baseline) { grade = 'moot'; reason = 'it was already so before I began'; }
    let events = null;
    try {
      events = planStore.recordRun(vaultPath, r.name, { grade, reason, timestamp: new Date(now()) });
    } catch (_) { /* a bad note must not break the body */ }
    if (logDir) {
      appendJsonLine(logDir, 'plans', {
        ts: new Date(now()).toISOString(), plan: r.name, version: r.version, by: r.by,
        startedAt: new Date(r.startedAt).toISOString(), grade, reason: reason || null,
        test: planStore.conditionText(r.program.test), stepsDone: r.step, steps: r.program.steps.length,
        trace: r.trace, events, ...extra,
      });
    }
    fire(`plan "${r.name}": ${grade}${reason ? ` — ${reason}` : ''}`);
    if (!events) return;
    const ts = new Date(now());
    const exp = (title, body, valenceBand) => {
      try { logExperience(vaultPath, { title, timestamp: ts, involves: [], locatedIn: [], deltas: {}, valenceBand, body }); } catch (_) { /* never */ }
    };
    if (events.promoted) exp(`Learned How To ${r.name}`, `"${r.name}" has worked again and again. It is something I know how to do now.`, 'positive');
    if (events.revise) exp(`${r.name} Keeps Failing`, `I have tried "${r.name}" several times and it has not worked yet. ${reason ? `Last time: ${reason}.` : ''} I need a better way.`, 'negative');
    if (events.dropped) exp(`Gave Up On ${r.name}`, `I tried every way I could think of to "${r.name}" and none worked. I have let it go.`, 'negative');
  }

  function end(grade, reason) {
    const r = run;
    run = null;
    if (r) finish(r, grade, reason);
  }

  /** Steps done: hand the run over to be graded by its test. */
  function toTest(r) {
    run = null;
    const t = r.program.test;
    if (t.timing === 'dawn') pending.push({ r, timing: 'dawn', sawNight: false, slept: false, deaths: 0, hurt: 0, lastHealth: null, since: now() });
    else if (t.timing === 'nightfall') pending.push({ r, timing: 'nightfall', since: now() });
    else pending.push({ r, timing: 'now', left: GRACE_TICKS, since: now() });
  }

  function start(name, by = 'cortex', o = null) {
    const p = planStore.findPlan(vaultPath, name);
    if (!p) return { ok: false, reason: `I know no plan called "${name}"` };
    if (p.data.status !== 'trying' && p.data.status !== 'skill') return { ok: false, reason: `"${p.name}" is ${p.data.status === 'dropped' ? 'given up' : 'waiting to be rethought'}` };
    const program = planStore.runnable(p.data);
    if (!program) return { ok: false, reason: `"${p.name}" is not something my body can carry out` };
    if (run && run.name === p.name) return { ok: true, already: true };
    if (pending.some((w) => w.r.name === p.name)) return { ok: false, reason: `I am still waiting to see whether "${p.name}" worked` };
    if (o) {
      // Only in its own time (2026-11-17: started before dusk, a dusk plan
      // skipped every step and was graded at nightfall anyway).
      if (!inWindow(program.when, o)) return { ok: false, reason: `it is not the time for "${p.name}" (${program.when})` };
      if (alreadySo(program.test, o)) return { ok: false, reason: `it is already so that I am ${planStore.conditionText({ ...program.test, timing: 'now' })}` };
    }
    if (run) end('interrupted', `I turned to "${p.name}" instead`);
    begin({ ...p, program }, by, o);
    return { ok: true };
  }

  function stop(reason = 'I let it go') {
    if (run) end('interrupted', reason);
  }

  function maybeAutoStart(o) {
    if (!autoStart || run) return;
    const t = now();
    const waiting = new Set(pending.map((p) => p.r.name));
    const candidates = planStore.runnablePlans(vaultPath)
      .filter((p) => !waiting.has(p.name))
      .filter((p) => !lastStarted.has(p.name) || t - lastStarted.get(p.name) >= cooldownMs)
      .filter((p) => inWindow(p.program.when, o) && p.program.needs.every((c) => holds(c, o)))
      .filter((p) => !alreadySo(p.program.test, o)) // nothing to do: it is already so
      // Skills first, then the plan tried least recently.
      .sort((a, b) => ((b.data.status === 'skill') - (a.data.status === 'skill')) ||
        String(a.data.last_run || '').localeCompare(String(b.data.last_run || '')));
    if (candidates.length) begin(candidates[0], 'habit', o);
  }

  /** The action for the current step: an action object, 'done', or { fail }. */
  function stepAction(st, o, r) {
    const tag = (a) => ({ ...a, source: 'plan', plan: r.name, planRun: r.id, planStep: r.step });
    const seek = () => tag({ type: 'explore', seeking: st.thing });
    switch (st.verb) {
      case 'dig':
        if (r.started) {
          if (o.digging) return tag({ type: 'idle', reason: 'breaking it' });
          return 'one-shot-done';
        }
        return tag({ type: 'dig', at: st.at });
      case 'place': return tag({ type: 'place', at: st.at, item: st.item });
      case 'move': return tag({ type: 'move', at: st.at });
      case 'jump': return tag({ type: 'jump' });
      case 'equip': return tag({ type: 'equip', item: st.item });
      case 'craft': return tag({ type: 'craft', item: st.item });
      case 'eat': {
        const item = st.item || ((o.inventoryFood || [])[0] || {}).name;
        if (!item) return { fail: 'I had nothing to eat' };
        return tag({ type: 'eat', item });
      }
      case 'use':
        if (st.at) return tag({ type: 'use', at: st.at });
        if (!findThing(st.thing, o)) return seek();
        return tag({ type: 'use', target: st.thing });
      case 'approach': {
        const t = findThing(st.thing, o);
        if (!t) return seek();
        if (!st.until && t.distance != null && t.distance <= 3) return 'done';
        return tag({ type: 'approach', target: t.entity || { name: t.name, position: t.position } });
      }
      case 'swingAt': {
        const t = findThing(st.thing, o);
        if (!t || !t.entity) return r.swung && !st.until ? 'done' : seek();
        return tag({ type: 'swingAt', target: t.entity });
      }
      case 'pickup': {
        const item = (o.nearbyItems || [])[0];
        if (!item) return st.until ? seek() : 'done';
        return tag({ type: 'pickup', target: item });
      }
      case 'explore':
        if (!st.until && r.stepTicks >= EXPLORE_TICKS) return 'done';
        return tag({ type: 'explore' });
      case 'wait':
        return tag({ type: 'idle', reason: 'waiting' });
      default:
        return { fail: `my body has no way to ${st.verb}` };
    }
  }

  function advance(r) {
    r.step += 1;
    r.stepTicks = 0;
    r.retries = 0;
    r.started = false;
    r.swung = false;
    r.eveningSeen = false;
    if (r.step < r.program.steps.length) fire(`plan "${r.name}" step ${r.step + 1}/${r.program.steps.length}: ${planStore.stepText(r.program.steps[r.step])}`);
  }

  /** What the running plan wants the body to do this tick, or null. */
  function next(o, { emergency = false } = {}) {
    if (!run && !emergency) {
      try { maybeAutoStart(o); } catch (_) { /* never */ }
    }
    const r = run;
    if (!r) return null;

    // The time for it has passed: a nightfall test is judged now; otherwise
    // the plan simply didn't get done in time. (Checked even in an emergency:
    // the night reflex taking over at dusk is exactly when nightfall is judged.)
    if (!inWindow(r.program.when, o)) {
      // Only waiting left ("wait until day"): waiting through its time IS
      // finishing. Anything else undone means the plan wasn't carried out.
      const rest = r.program.steps.slice(r.step);
      if (rest.length && !rest.every((s) => s.verb === 'wait')) {
        end('broke', 'the time for it passed before I finished');
        return null;
      }
      r.step = r.program.steps.length;
      const t = r.program.test;
      if (t.timing === 'nightfall' && isEvening(o)) {
        run = null;
        const ok = holds(t, o);
        finish(r, ok ? 'passed' : 'failed', ok ? null : `I was not ${planStore.conditionText({ ...t, timing: 'now' })} when night fell`);
        return null;
      }
      toTest(r);
      return null;
    }
    if (emergency) {
      if (!r.pausedSince) r.pausedSince = now();
      else if (now() - r.pausedSince > PAUSE_MAX_MS) end('interrupted', 'danger kept me from it too long');
      return null;
    }
    r.pausedSince = null;
    if (r.ticks >= RUN_TICKS) { end('broke', 'it took too long'); return null; }

    for (let guard = 0; guard < r.program.steps.length + 1; guard += 1) {
      if (r.step >= r.program.steps.length) { toTest(r); return null; }
      const st = r.program.steps[r.step];
      if (isEvening(o)) r.eveningSeen = true;
      // "until day" means the NEXT morning: by day it would be over before it began.
      const untilMet = st.until && (st.until.kind === 'day' ? r.eveningSeen && holds(st.until, o) : holds(st.until, o));
      if (untilMet) { advance(r); continue; }
      if (r.stepTicks >= STEP_TICKS) {
        end('broke', st.until ? `I could not get ${planStore.conditionText(st.until)} in time` : `"${planStore.stepText(st)}" never finished`);
        return null;
      }
      const act = stepAction(st, o, r);
      if (act === 'done') { advance(r); continue; }
      if (act === 'one-shot-done') {
        if (st.until) { r.started = false; continue; } // again, until the condition holds
        advance(r); continue;
      }
      if (act.fail) { end('broke', act.fail); return null; }
      return act;
    }
    return null;
  }

  function gradePending(o) {
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const p = pending[i];
      const t = p.r.program.test;
      let grade = null;
      let reason = null;
      if (p.timing === 'now') {
        if (holds(t, o)) grade = 'passed';
        else if ((p.left -= 1) <= 0) { grade = 'failed'; reason = `it did not come true that I was ${planStore.conditionText(t)}`; }
      } else if (p.timing === 'nightfall') {
        if (isEvening(o)) {
          const ok = holds(t, o);
          grade = ok ? 'passed' : 'failed';
          if (!ok) reason = `I was not ${planStore.conditionText({ ...t, timing: 'now' })} when night fell`;
        } else if (now() - p.since > NIGHTFALL_WAIT_MS) { grade = 'interrupted'; reason = 'I lost track of it before nightfall'; }
      } else if (p.timing === 'dawn') {
        const evening = isEvening(o);
        if (evening) {
          p.sawNight = true;
          if (o.sleeping) p.slept = true;
          if (p.lastHealth != null && o.health < p.lastHealth) p.hurt += p.lastHealth - o.health;
          p.lastHealth = o.health;
        } else if (p.sawNight) {
          const ok = t.kind === 'slept' ? p.slept && p.deaths === 0
            : t.kind === 'survived' ? p.deaths === 0
              : p.deaths === 0 && p.hurt === 0;
          grade = ok ? 'passed' : 'failed';
          if (!ok) reason = p.deaths ? 'I died in the night' : t.kind === 'slept' ? 'I did not sleep' : 'I was hurt in the night';
        }
      }
      if (grade) {
        pending.splice(i, 1);
        finish(p.r, grade, reason, { graded: p.timing });
      }
    }
  }

  /** After the body acted: advance or retry the step, grade waiting tests. */
  function afterTick({ action, result, observation: o }) {
    try { gradePending(o); } catch (_) { /* never */ }
    const r = run;
    if (!r || !action || action.source !== 'plan' || action.planRun !== r.id) return;
    r.ticks += 1;
    r.stepTicks += 1;
    if (r.trace.length < 60) {
      r.trace.push({ step: r.step, type: action.type, at: action.at || undefined, ok: result ? result.ok : undefined, said: result ? (result.did || result.reason) : undefined });
    }
    const st = r.program.steps[r.step];
    if (!st) return;
    if (result && result.ok === false) {
      if (action.type === 'explore') return;
      r.retries += 1;
      if (r.retries > RETRIES) end('broke', result.reason);
      return;
    }
    if (st.verb === 'swingAt' && action.type === 'swingAt' && result && /swung/.test(String(result.did))) r.swung = true;
    if (!ONE_SHOT.has(st.verb) || action.type !== st.verb) return;
    if (st.verb === 'dig') { r.started = true; return; }
    if (st.verb === 'use' && /^walking/.test(String(result && result.did))) return;
    if (st.until) return; // repeated until the condition holds (checked in next())
    advance(r);
  }

  function noteDeath() {
    if (run) end('interrupted', 'I died');
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const p = pending[i];
      if (p.timing === 'dawn') p.deaths += 1;
      else { pending.splice(i, 1); finish(p.r, 'interrupted', 'I died', { graded: p.timing }); }
    }
  }

  function status() {
    return {
      running: run ? {
        name: run.name, by: run.by, step: run.step + 1, of: run.program.steps.length,
        doing: run.program.steps[run.step] ? planStore.stepText(run.program.steps[run.step]) : 'checking whether it worked',
        test: planStore.conditionText(run.program.test), paused: !!run.pausedSince,
      } : null,
      waiting: pending.map((p) => ({ name: p.r.name, test: planStore.conditionText(p.r.program.test) })),
    };
  }

  return { next, afterTick, start, stop, noteDeath, status };
}

module.exports = { createPlanRunner, inWindow, holds, findThing };
