// MindForge's contribution: don't just record WHAT another being did — infer
// WHY. A demonstration is only transferable if you read through the motion to
// the *intent*: Henry didn't wave his arms, he was making a crafting table,
// and wood is what it takes. This is theory of mind — modelling another mind's
// goal and knowledge from its behaviour (and its words, if it spoke). The
// output is a belief about that mind PLUS an imitable guess at the method,
// which becomes a goal the agent sets for ITSELF.
//
// Two paths, same shape out: a deterministic reading for offline/sim use, and
// an optional LLM (`ask`) that does the real inference. The agent's belief is
// always a *guess* — it never becomes certified know-how from watching alone
// (see observationStore / the design doc): only the agent's own repeated
// success promotes a guess into a Skill.
'use strict';

const { titleCase } = require('../vault/paths');

// Hand-read templates for the early-game acts the agent is most likely to see.
// Keyed by the outcome's raw name. Deliberately worded as the agent's own
// first-person guesses, never as game facts.
const READINGS = {
  crafting_table: {
    verb: 'make a crafting table',
    goal: 'to have a surface where other things can be made',
    belief: 'knows how to make a crafting table out of wood',
    method: ['gather wood', 'work the wood into flat pieces', 'arrange the pieces into a table for making things'],
  },
  torch: {
    verb: 'make light',
    goal: 'to push back the dark that harm comes in',
    belief: 'can make light to hold off the dark',
    method: ['gather something that burns and a stick', 'bind them into a torch', 'set the torch up so its light stays'],
  },
  furnace: {
    verb: 'make a furnace',
    goal: 'to change things with heat',
    belief: 'knows how to build a furnace from stone',
    method: ['gather stone', 'shape the stone into a hollow box', 'stand it up as a furnace'],
  },
};

function readingFor(episode) {
  const raw = String(episode.outcome.name || '').toLowerCase();
  if (READINGS[raw]) return READINGS[raw];
  const nice = titleCase(raw).toLowerCase();
  if (episode.outcome.type === 'gathered') {
    return {
      verb: `gather ${nice}`,
      goal: `to have ${nice} to use`,
      belief: `knows how to get ${nice} out of the world`,
      method: [`find where ${nice} sits`, `strike it loose`, `pick up what falls`],
    };
  }
  return {
    verb: `make ${nice}`,
    goal: `to have ${nice}`,
    belief: `knows how to make ${nice}`,
    method: episode.materials && episode.materials.length
      ? [`gather ${episode.materials.map((m) => titleCase(m).toLowerCase()).join(' and ')}`, `turn it into ${nice}`]
      : [`bring ${nice} into being somehow`],
  };
}

/** Fold anything the actor said (chatLines) into the belief, when it fits. */
function foldSpeech(reading, chatLines, actor) {
  if (!chatLines) return reading;
  const said = String(chatLines).toLowerCase();
  const cue = reading.verb.split(' ').pop(); // 'light', 'table', ...
  if (cue && said.includes(cue)) {
    return { ...reading, goal: `${reading.goal} — and ${actor} spoke of this, so it matters to them` };
  }
  return reading;
}

// Goals read as intentions — "Learn To Make A Crafting Table", never "…Made…".
// The LLM (and clumsy phrasing) often describe what happened in the past tense;
// this pulls the common Minecraft verbs back to their base form so the title
// is something the agent can set out to DO.
const PAST_TO_PRESENT = {
  made: 'make', placed: 'place', built: 'build', crafted: 'craft', gathered: 'gather',
  dug: 'dig', mined: 'mine', planted: 'plant', grew: 'grow', moved: 'move',
  converted: 'convert', broke: 'break', cooked: 'cook', smelted: 'smelt', brewed: 'brew',
  enchanted: 'enchant', tamed: 'tame', bred: 'breed', harvested: 'harvest', lit: 'light',
  threw: 'throw', grabbed: 'grab', picked: 'pick', dropped: 'drop', opened: 'open',
  closed: 'close', jumped: 'jump', swam: 'swim', climbed: 'climb', flew: 'fly',
  walked: 'walk', ran: 'run', turned: 'turn', changed: 'change', created: 'create',
};

function presentTense(phrase) {
  return String(phrase || '')
    .split(/\s+/)
    .map((w) => PAST_TO_PRESENT[w.toLowerCase()] || w)
    .join(' ');
}

function toTitle(phrase) {
  return titleCase(presentTense(phrase).replace(/[^a-z0-9 ]/gi, ' '));
}

/**
 * Infer the mind behind an episode. Returns:
 * {
 *   actorGoal, belief,               // theory-of-mind: what they wanted / know
 *   method: [...],                   // imitable guess at how
 *   insightTitle, insightBody,       // the belief, as a note about that mind
 *   subgoalTitle, subgoalBody,       // the agent's own goal to learn it
 *   verbPhrase                       // "Make A Crafting Table" for the experience title
 * }
 * ctx: { chatLines, ask }.  With `ask`, the LLM does the inference.
 */
async function inferIntent(episode, ctx = {}) {
  const actor = episode.actor;
  if (ctx.ask) {
    const llm = await inferWithLlm(episode, ctx).catch(() => null);
    if (llm) return llm;
  }

  const reading = foldSpeech(readingFor(episode), ctx.chatLines, actor);
  const verbPhrase = toTitle(reading.verb);
  const methodProse = reading.method.map((m, i) => `${i + 1}. ${m}`).join(' ');

  return {
    actorGoal: `${actor} wanted ${reading.goal}.`,
    belief: `${actor} ${reading.belief}.`,
    method: reading.method,
    verbPhrase,
    insightTitle: `${actor} Can ${toTitle(reading.verb)}`,
    insightBody:
      `I watched ${actor} ${reading.verb}. I believe ${actor} ${reading.belief} — it seemed done ` +
      `${reading.goal}. I do not know this for certain; it is only what I understood from watching.`,
    subgoalTitle: `Learn To ${toTitle(reading.verb)}`,
    subgoalBody:
      `I saw ${actor} ${reading.verb}, and I could not. If living well means being able to do more ` +
      `for myself, then this is worth learning. From watching, it looked like: ${methodProse} ` +
      `I will try this myself and let my own attempts teach me whether I understood.`,
  };
}

// ----------------------------------------------------------------- LLM path

const TOM_PROMPT =
  'You are the mind of MindBot, watching another being. From what you saw (and heard, if anything), ' +
  'infer what that being was TRYING to do and what it therefore must know — then guess, in your own ' +
  'words, how you might do the same. Speak first person, from watching alone; never state game facts ' +
  'as certainties — these are your guesses. Respond with ONLY JSON: ' +
  '{"belief":"<what that being seems to know>","goal":"<what it seemed to want>",' +
  '"verb":"<short PRESENT-TENSE action phrase you could set as a goal, e.g. \\"make a crafting table\\" ' +
  '(never past tense like \\"made\\")>","method":["step","step"]}.';

function buildTomPrompt(episode, ctx) {
  return [
    TOM_PROMPT,
    '',
    `Who: ${episode.actor}.`,
    `What you saw: ${episode.summary}. In the end there was a ${episode.outcome.name}.`,
    episode.materials && episode.materials.length ? `They seemed to use: ${episode.materials.join(', ')}.` : null,
    ctx.chatLines ? `What was said nearby:\n${ctx.chatLines}` : null,
    '',
    'What were they doing, and how might you learn it?',
  ].filter(Boolean).join('\n');
}

async function inferWithLlm(episode, ctx) {
  const raw = await ctx.ask(buildTomPrompt(episode, ctx));
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('no JSON in ToM output');
  const p = JSON.parse(raw.slice(s, e + 1));
  const actor = episode.actor;
  const verb = String(p.verb || `do what ${actor} did`).trim();
  const method = Array.isArray(p.method) ? p.method.map(String) : [];
  const methodProse = method.map((m, i) => `${i + 1}. ${m}`).join(' ');
  const belief = String(p.belief || '').trim().replace(/[.\s]+$/, '');
  const goal = String(p.goal || '').trim().replace(/[.\s]+$/, '');
  return {
    actorGoal: goal ? `${actor} seemed to want ${goal}.` : '',
    belief: belief ? `${belief}.` : '',
    method,
    verbPhrase: toTitle(verb),
    insightTitle: `${actor} Can ${toTitle(verb)}`,
    insightBody: `${belief ? `${belief}.` : ''}${goal ? ` ${actor} seemed to want ${goal}.` : ''} This is what I understood from watching — not something I know for certain.`.trim(),
    subgoalTitle: `Learn To ${toTitle(verb)}`,
    subgoalBody: `I watched ${actor} ${verb}, and I want to learn it myself.${methodProse ? ` It looked like: ${methodProse}` : ''} I will try, and let my own attempts correct me.`,
  };
}

module.exports = { inferIntent, buildTomPrompt, READINGS };
