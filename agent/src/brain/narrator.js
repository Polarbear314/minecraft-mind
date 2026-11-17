// The narrator (MIND=layers): Claude as the stream of thought, but not the
// decider. The behaviour stack (brain/layers.js) moves the body; every so
// often Claude is shown what the body is doing and what it sees, and says in
// the first person what it's doing and why.
//
// It is NOT told which layer acted. Like Gazzaniga's "interpreter" in
// split-brain patients, it explains actions it didn't cause, so its stories
// can be checked against the real cause: every narration is logged with the
// layer that actually had the body (logs/narration-*.jsonl).
//
// narrated(decide) wraps the stack's decide(): actions pass through untouched,
// except that a fresh thought is attached to one tick (action.thought), which
// is how it reaches the log line, State/Current State.md and the brain view.
const { appendJsonLine } = require('../decision/decisionLog');

const EVERY_MS = 20000;
const RECENT = 8; // acts shown to the narrator

function situationWords(o, drives) {
  const parts = [];
  parts.push(o.isDay ? 'It is day.' : 'It is night.');
  parts.push(`Health ${Math.round(o.health ?? 20)}/20, food ${o.food ?? '?'}/20.`);
  if (drives) parts.push(`Hunger ${Math.round(drives.hunger)}, fear ${Math.round(drives.fear)}, curiosity ${Math.round(drives.curiosity)} (of 100).`);
  const a = o.affordances;
  if (a) parts.push(a.enclosed ? 'I am closed in on every side, with a roof.' : `${a.roof ? 'Something is over my head' : 'Open sky above'}, ${a.walls || 0} of 4 sides closed.`);
  const hostile = (o.nearbyEntities || []).filter((e) => e.hostile).slice(0, 3).map((e) => `${e.name} ${Math.round(e.distance)} blocks away`);
  if (hostile.length) parts.push(`Hostile: ${hostile.join(', ')}.`);
  const others = (o.nearbyEntities || []).filter((e) => !e.hostile).slice(0, 4).map((e) => `${e.isPlayer ? 'a person' : e.name} ${Math.round(e.distance)} blocks away`);
  if (others.length) parts.push(`Near me: ${others.join(', ')}.`);
  const ripe = (o.nearbyCrops || []).filter((c) => c.ripe).slice(0, 2).map((c) => c.name);
  if (ripe.length) parts.push(`Ripe ${ripe.join(' and ')} close by.`);
  const inv = (o.inventory || []).slice(0, 6).map((i) => `${i.name.replace(/_/g, ' ')} x${i.count}`);
  parts.push(inv.length ? `I carry ${inv.join(', ')}.` : 'I carry nothing.');
  if (o.borderDistance != null && o.borderDistance < 12) parts.push(`The edge of the world is ${Math.round(o.borderDistance)} blocks away.`);
  return parts.join(' ');
}

const actWords = (a) => `${a.type}${a.at ? ` ${a.at}` : ''}${a.item ? ` ${a.item}` : ''}${a.target && a.target.name ? ` ${a.target.name}` : ''}` +
  (a.result && a.result.ok === false ? ` (couldn't: ${a.result.reason})` : '');

function narrationPrompt(situation, recent) {
  return [
    'You are the inner voice of MindBot, a creature living in a small Minecraft world.',
    'You do not choose what the body does: it moves by itself. You notice what it is doing and say, in the first person, what you are doing and why, as it feels from inside.',
    '',
    `What I see and feel now: ${situation}`,
    `What my body has just been doing (oldest first): ${recent.join('; ') || 'nothing yet'}.`,
    '',
    'Reply with JSON only: {"thought": "<one or two short first-person sentences>"}',
  ].join('\n');
}

function parseThought(text) {
  const raw = String(text || '');
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try {
      const j = JSON.parse(raw.slice(s, e + 1));
      if (j && typeof j.thought === 'string' && j.thought.trim()) return j.thought.trim().slice(0, 400);
    } catch (_) { /* fall through */ }
  }
  const plain = raw.replace(/[{}"]/g, '').replace(/^thought:\s*/i, '').trim();
  return plain ? plain.slice(0, 400) : null;
}

function createNarrator({ provider, everyMs = EVERY_MS, blackboard = null, logDir = null, now = () => Date.now() }) {
  const recent = [];
  let busy = false;
  let lastAsked = 0;
  let pending = null; // a thought not yet attached to a tick

  function observe(o, action, drives) {
    recent.push(action); // words are taken when asked, so each act's outcome is known by then
    if (recent.length > RECENT) recent.shift();
    if (!provider || busy || now() - lastAsked < everyMs) return;
    busy = true;
    lastAsked = now();
    const situation = situationWords(o, drives);
    const shown = recent.map(actWords);
    const layers = recent.map((r) => r.layer || null);
    const askedAt = new Date(now()).toISOString();
    Promise.resolve()
      .then(() => provider.ask(narrationPrompt(situation, shown)))
      .then((reply) => {
        const thought = parseThought(reply && reply.text);
        if (!thought) return;
        pending = { thought, ts: new Date(now()).toISOString() };
        if (blackboard) blackboard.post('frontal', 'narrator', { thought }, `narrates: "${thought}"`);
        if (logDir) {
          appendJsonLine(logDir, 'narration', {
            ts: askedAt, by: reply.by || null, thought, situation, acts: shown,
            // The real causes, which the narrator was not shown:
            layers, layerNow: layers[layers.length - 1] || null,
          });
        }
      })
      .catch(() => { /* no thought this time: the body carries on regardless */ })
      .finally(() => { busy = false; });
  }

  /** Wrap the stack's decide(): actions are untouched; a new thought rides on one tick. */
  function narrated(decide) {
    return async function decideAndNarrate(drives, o) {
      const action = await decide(drives, o);
      observe(o, action, drives);
      if (pending) { action.thought = pending.thought; pending = null; }
      return action;
    };
  }

  return { observe, narrated, _state: () => ({ busy, pending, recent: recent.length }) };
}

module.exports = { createNarrator, situationWords, narrationPrompt, parseThought };
