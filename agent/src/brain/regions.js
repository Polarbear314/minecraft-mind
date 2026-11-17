// Always-on brain regions, each its own loop, all running at once on the free
// local model (Gemma via Ollama) while the body moves and Claude deliberates.
// They read the latest percept from the blackboard and post back what they
// find; none of them ever waits for the body or for each other.
//
//   amygdala     — every ~3 s: a gut feeling about how threatening RIGHT NOW is.
//                  Feeds the fear drive and the cortex.
//   inner voice  — every ~4 s: a quick first-person thought and an urge (an
//                  action it feels like taking). The body may act on the urge
//                  between Claude's deliberations (see arbiter.js).
//   rumination   — every ~2 min: what the last few minutes of memories add up to.
//                  Feeds the cortex; the big dreams still happen at dawn.
const fs = require('fs');
const path = require('path');
const paths = require('../vault/paths');
const fm = require('../vault/frontmatter');
const { lookup } = require('../vault/ontologyMap');
const { currentIntention } = require('../vault/intentionStore');
const { describeAffordances } = require('../perception/affordances');
const { DIRECTION_NAMES } = require('../actions/bodyFrame');

const PERCEPT_FRESH_MS = 6000; // no fresh percept = the body isn't running; rest

/**
 * Run `step` over and over, at most once per everyMs, never overlapping, and
 * only while the body is alive (a fresh percept on the blackboard). Failures
 * back off (up to a minute) and are reported once, not every time.
 */
function createRegionLoop({ name, everyMs, step, blackboard, log = console }) {
  let timer = null;
  let running = false;
  let failures = 0;
  let warned = false;

  async function once() {
    if (!blackboard.get('percept', PERCEPT_FRESH_MS)) return schedule(everyMs);
    const started = Date.now();
    try {
      await step();
      failures = 0;
      if (warned) { log.log(`[brain] ${name} is firing again.`); warned = false; }
    } catch (err) {
      failures += 1;
      if (!warned) {
        warned = true;
        log.error(`[brain] ${name} misfired (${String(err && err.message || err).slice(0, 120)}); backing off.`);
      }
    }
    const backoff = failures ? Math.min(60000, everyMs * 2 ** Math.min(failures, 5)) : 0;
    schedule(Math.max(0, everyMs - (Date.now() - started)) + backoff);
  }
  function schedule(ms) {
    if (!running) return;
    timer = setTimeout(once, ms);
    if (timer.unref) timer.unref();
  }
  return {
    name,
    start() { if (!running) { running = true; schedule(0); } },
    stop() { running = false; if (timer) clearTimeout(timer); },
    once, // tests
  };
}

// ------------------------------------------------------------ shared bits

function feelingLine(vaultPath, kind, rawName, suffix) {
  const title = paths.titleCase(rawName);
  try {
    const { classPath } = lookup(kind, rawName);
    const { data } = fm.parse(fs.readFileSync(paths.conceptPath(vaultPath, classPath, title), 'utf8'));
    const v = Number(data.valence);
    const word = v <= -0.5 ? 'dangerous' : v <= -0.2 ? 'bad' : v >= 0.5 ? 'very good' : v >= 0.2 ? 'good' : 'neutral';
    return `- ${title}${suffix}: feels ${word}, met ${Number(data.encounter_count) >= 5 ? 'many times' : 'a few times'}`;
  } catch (_) {
    return `- ${title}${suffix}: never met before`;
  }
}

/** What's around, and how the vault says it feels about each. */
function situation(vaultPath, o) {
  const lines = [];
  for (const e of (o.nearbyEntities || []).slice(0, 6)) {
    lines.push(feelingLine(vaultPath, e.isPlayer ? 'player' : 'entity', e.name,
      `, ${Math.round(e.distance)} blocks away${e.isPlayer ? ' (a person)' : e.hostile ? ' (hostile)' : ''}`));
  }
  for (const b of (o.nearbyBlocks || []).slice(0, 3)) lines.push(feelingLine(vaultPath, 'block', b.name, ' (block nearby)'));
  return lines.length ? lines.join('\n') : '- nothing nearby';
}

function bodyLine(o, drives) {
  const d = drives || {};
  return `health ${Math.round(o.health)}/20, food ${o.food}/20, ${o.isDay ? 'daytime' : 'night'}; ` +
    `hunger ${Math.round(d.hunger || 0)}, fear ${Math.round(d.fear || 0)}, curiosity ${Math.round(d.curiosity || 0)} (0-100). ` +
    `${describeAffordances(o.affordances) || ''}`;
}

function parseJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('no JSON in reply');
  return JSON.parse(s.slice(a, b + 1));
}

// ------------------------------------------------------------ amygdala

const GUT_SCHEMA = {
  type: 'object',
  properties: {
    threat: { type: 'number' },
    feeling: { type: 'string' },
    why: { type: 'string' },
  },
  required: ['threat', 'feeling', 'why'],
};

function createAmygdala({ provider, blackboard, vaultPath, everyMs = 3000 }) {
  return createRegionLoop({
    name: 'amygdala',
    everyMs,
    blackboard,
    async step() {
      const p = blackboard.get('percept', PERCEPT_FRESH_MS);
      const o = p.data.observation;
      const prompt =
        'You are the amygdala of MindBot, a creature still learning what its world is. You do not plan or act: ' +
        'you only FEEL how threatened it should be right now, from its body and from how it has learned to feel ' +
        'about what is around it. Nothing else exists for you.\n\n' +
        `Body: ${bodyLine(o, p.data.drives)}\n` +
        `Around it, and how its memory feels about each:\n${situation(vaultPath, o)}\n\n` +
        'Reply with ONLY JSON: {"threat": <0 = perfectly safe ... 1 = in mortal danger>, ' +
        '"feeling": "<one word>", "why": "<a few words>"}';
      const { text, by } = await provider.ask(prompt, { schema: GUT_SCHEMA, temperature: 0.2 });
      const g = parseJson(text);
      const threat = Math.max(0, Math.min(1, Number(g.threat) || 0));
      const gut = { threat, feeling: String(g.feeling || '').slice(0, 24), why: String(g.why || '').slice(0, 90), by };
      blackboard.post('amygdala', 'gut', gut, `${gut.feeling} (${Math.round(threat * 100)}%) — ${gut.why}`);
      blackboard.fire('callosum', `amygdala → ${by}`);
    },
  });
}

// ------------------------------------------------------------ inner voice

const URGES = ['none', 'flee', 'eat', 'seekFood', 'explore', 'idle', 'swingAt', 'dig', 'place', 'pickup', 'approach', 'move', 'jump', 'use', 'equip', 'craft'];
const VOICE_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    urge: { type: 'string', enum: URGES },
    at: { type: 'string' },
    target: { type: 'string' },
    item: { type: 'string' },
  },
  required: ['thought', 'urge'],
};

function createInnerVoice({ provider, blackboard, vaultPath, everyMs = 4000 }) {
  return createRegionLoop({
    name: 'inner voice',
    everyMs,
    blackboard,
    async step() {
      const p = blackboard.get('percept', PERCEPT_FRESH_MS);
      const o = p.data.observation;
      const gut = blackboard.get('gut', 15000);
      const cortex = blackboard.get('cortex', 60000);
      const said = blackboard.history('voice').slice(-3).map((v) => `"${v.thought}"`).join(' ');
      const intention = currentIntention(vaultPath);
      const carried = (o.inventory || []).map((i) => `${i.name} x${i.count}`).join(', ') || 'nothing';
      const last = p.data.action ? `${p.data.action.type}${p.data.action.at ? ' ' + p.data.action.at : ''}` +
        (p.data.action.result ? (p.data.action.result.ok ? ' (it worked)' : ` (couldn't: ${p.data.action.result.reason})`) : '') : 'nothing';
      const prompt =
        'You are the quick inner voice of MindBot, a creature still learning its world. You think in fast, short ' +
        'flashes while the body keeps moving; a slower, deeper part of the mind decides the big things. ' +
        'Say ONE thought about this very moment: a full first-person sentence of 8 to 25 words about what you notice, ' +
        'feel or want (fresh — never repeat what you just thought). Then the urge you feel: one of the body\'s acts, ' +
        'or "none" if nothing pulls at you. No one has told you what any act is for.\n' +
        'Example of the style (not the content): "The light is going and I feel exposed out here; I want something solid around me."\n\n' +
        `Body: ${bodyLine(o, p.data.drives)}\nCarrying: ${carried}\nJust did: ${last}\n` +
        `${gut ? `Gut feeling: ${gut.data.feeling} — ${gut.data.why}\n` : ''}` +
        `${intention ? `Standing intention: "${intention}"\n` : ''}` +
        `${cortex ? `The deeper mind last thought: "${cortex.data.thought}"\n` : ''}` +
        `${said ? `You just thought: ${said}\n` : ''}` +
        `Around:\n${situation(vaultPath, o)}\n\n` +
        `Acts: ${URGES.join(', ')}. dig/place/move/use may take "at": ${DIRECTION_NAMES.join(', ')}. ` +
        'swingAt/approach may take "target" (a creature\'s name); eat/place/equip/craft may take "item".\n' +
        'Reply with ONLY JSON: {"thought": "...", "urge": "...", "at": "...", "target": "...", "item": "..."}';
      const { text, by } = await provider.ask(prompt, { schema: VOICE_SCHEMA, temperature: 0.7 });
      const v = parseJson(text);
      const thought = String(v.thought || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!thought || thought.split(/\s+/).length < 4) throw new Error(`too slight a thought: "${thought}"`);
      blackboard.remember('voice', { thought });
      blackboard.post('innerVoice', 'voice', { thought, by }, thought);
      // "idle" is not an urge but the absence of one; and small models fill
      // optional fields with "none" — treat that as absent.
      const real = (x) => (x && !/^(none|null|n\/a|-)?$/i.test(String(x).trim()) ? String(x).trim() : null);
      if (v.urge && !['none', 'idle'].includes(v.urge) && URGES.includes(v.urge)) {
        const urge = { action: v.urge, thought };
        if (real(v.at)) urge.at = real(v.at);
        if (real(v.target)) urge.target = real(v.target);
        if (real(v.item)) urge.item = real(v.item);
        blackboard.post('innerVoice', 'urge', urge);
      }
      blackboard.fire('callosum', `inner voice → ${by}`);
    },
  });
}

// ------------------------------------------------------------ rumination

const RUMINATION_SCHEMA = {
  type: 'object',
  properties: { reflection: { type: 'string' } },
  required: ['reflection'],
};

function recentMemories(vaultPath, n = 10) {
  try {
    const dir = paths.experiencesDir(vaultPath);
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').sort().slice(-n).map((f) => {
      let body = '';
      try { body = String(fm.parse(fs.readFileSync(path.join(dir, f), 'utf8')).body).trim().replace(/\s+/g, ' ').slice(0, 120); } catch (_) { /* skip */ }
      return `- ${f.slice(0, -3).replace(/^\d{4}-\d{2}-\d{2}T\d{4} - /, '')}${body ? `: ${body}` : ''}`;
    }).join('\n');
  } catch (_) {
    return '';
  }
}

function createRumination({ provider, blackboard, vaultPath, everyMs = 120000 }) {
  return createRegionLoop({
    name: 'rumination',
    everyMs,
    blackboard,
    async step() {
      const memories = recentMemories(vaultPath);
      if (!memories) return;
      const prompt =
        'You are MindBot, turning over your last few minutes while your body keeps going — not a dream, just ' +
        'the mind chewing on what just happened. From these memories alone, say in one or two first-person ' +
        'sentences what they add up to, or what they make you wonder. No numbers.\n\n' +
        `Your most recent memories (oldest first):\n${memories}\n\n` +
        'Reply with ONLY JSON: {"reflection": "..."}';
      const { text, by } = await provider.ask(prompt, { schema: RUMINATION_SCHEMA, temperature: 0.5 });
      const r = parseJson(text);
      const reflection = String(r.reflection || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!reflection) throw new Error('empty reflection');
      blackboard.post('hippocampus', 'rumination', { reflection, by }, reflection);
      blackboard.fire('callosum', `rumination → ${by}`);
    },
  });
}

/** What the thalamus passes up to the cortex from the rest of the mind. */
function workspaceDigest(blackboard) {
  const gut = blackboard.get('gut', 15000);
  const voices = blackboard.history('voice').slice(-3).map((v) => v.thought);
  const rum = blackboard.get('rumination', 300000);
  const lines = [];
  if (gut) lines.push(`- Your gut: ${gut.data.feeling} (${gut.data.why}).`);
  if (voices.length) lines.push(`- Your quick inner voice has been saying: ${voices.map((v) => `"${v}"`).join(' ')}`);
  if (rum) lines.push(`- Lately you have been turning over: ${rum.data.reflection}`);
  return lines.length ? lines.join('\n') : null;
}

module.exports = {
  createRegionLoop, createAmygdala, createInnerVoice, createRumination, workspaceDigest,
  GUT_SCHEMA, VOICE_SCHEMA, URGES,
};
