// OMNI's idea, ported to MindBot: not everything learnable is worth learning.
// An agent that attends to every twitch drowns (the "noisy-TV" trap). OMNI
// uses a foundation model as a *model of interestingness* to keep only tasks
// that are BOTH learnable AND interesting, judged against what's already been
// done. Here that judgement has two layers:
//
//   1. A cheap, deterministic score computed from the agent's own vault —
//      novelty, capability-gap, curiosity, goal-relevance. Runs with no LLM,
//      so the pipeline works offline and in the sim.
//   2. An optional LLM "model of interestingness" (the OMNI hook), conditioned
//      on what the agent ALREADY knows, that makes the final call on borderline
//      episodes. Injected as `ask` exactly like dream.js / claudeCodeDecide.
'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('../vault/paths');
const { titleCase } = require('../vault/paths');
const { lookup } = require('../vault/ontologyMap');

const DEFAULT_THRESHOLD = 0.5;

function clamp01(v) { return Math.min(1, Math.max(0, v)); }

/** Every note title the agent already holds that could "cover" an outcome. */
function knownTitles(vaultPath) {
  const dirs = [paths.skillsDir(vaultPath), paths.insightsDir(vaultPath), paths.strategiesDir(vaultPath)];
  const titles = [];
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.md') && f !== 'README.md') titles.push(f.slice(0, -3));
      }
    } catch (_) { /* dir may not exist yet */ }
  }
  return titles;
}

/** Titles/bodies of the agent's active subgoals, lowercased, for relevance. */
function subgoalText(vaultPath) {
  try {
    const { listSubgoals } = require('../vault/goalStore');
    return listSubgoals(vaultPath).map((g) => `${g.title} ${g.body}`.toLowerCase());
  } catch (_) {
    return [];
  }
}

/**
 * Deterministic interestingness of one watched episode, 0..1, from the vault
 * alone. Returns { score, interesting, signals } — signals are kept so the
 * agent (and you, reading the notes) can see WHY something drew its eye.
 */
function scoreEpisode(vaultPath, episode, ctx = {}) {
  const threshold = ctx.threshold != null ? ctx.threshold : DEFAULT_THRESHOLD;
  const outName = titleCase(episode.outcome.name);
  const known = ctx.knownTitles || knownTitles(vaultPath);
  const subgoals = ctx.subgoalText || subgoalText(vaultPath);

  // Novelty: does anything the agent already knows mention this outcome?
  const alreadyKnown = known.some((t) => t.includes(outName));
  const novelty = alreadyKnown ? 0.15 : 1;

  // Capability-gap: making something is higher-leverage (more empowerment) to
  // learn than merely gathering; both are worth more than idle motion.
  const capabilityGap = episode.outcome.type === 'made' ? 1 : 0.6;

  // Curiosity pull: the ontology already encodes how intriguing a thing is.
  let curiosity = 0.3;
  try { curiosity = clamp01(lookup('block', episode.outcome.name).drives.curiosity || 0.3); } catch (_) { /* fallback */ }

  // Goal-relevance: does the outcome (or a material) touch an open subgoal?
  const needle = [episode.outcome.name, ...(episode.materials || [])].map((n) => String(n).toLowerCase());
  const goalRelevance = subgoals.some((s) => needle.some((n) => n && s.includes(n.replace(/_/g, ' ')))) ? 1 : 0.3;

  const signals = { novelty, capabilityGap, curiosity, goalRelevance };
  const score = clamp01(0.4 * novelty + 0.25 * capabilityGap + 0.15 * curiosity + 0.2 * goalRelevance);
  return { score, interesting: score >= threshold, signals };
}

// ------------------------------------------------------- OMNI model-of-interestingness

const MOI_PROMPT =
  'You are the sense of curiosity of MindBot, a being still learning its world. ' +
  'You just watched another being do something. Decide ONLY whether it is worth your ' +
  'attention to try to learn — interesting AND something you do not already know. ' +
  'You are given what you already know; do not deem interesting anything you already have. ' +
  'Answer with ONLY JSON: {"interesting": true|false, "reason": "a short phrase in your own voice"}.';

function buildMoiPrompt(episode, known) {
  return [
    MOI_PROMPT,
    '',
    `What you watched: ${episode.actor} — ${episode.summary} (a ${episode.outcome.name}).`,
    '',
    'What you already know how to do or believe:',
    known.length ? known.map((t) => `- ${t}`).join('\n') : '(almost nothing yet)',
    '',
    'Is this worth learning?',
  ].join('\n');
}

/**
 * The OMNI layer. If `ask` is provided, the LLM makes the interestingness call
 * conditioned on what the agent already knows; otherwise falls back to the
 * deterministic score. `ask`: async (prompt) -> raw text (may wrap JSON).
 */
async function judgeInteresting(vaultPath, episode, ctx = {}) {
  const det = scoreEpisode(vaultPath, episode, ctx);
  if (!ctx.ask) return { ...det, source: 'heuristic' };
  try {
    const known = ctx.knownTitles || knownTitles(vaultPath);
    const raw = await ctx.ask(buildMoiPrompt(episode, known));
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s === -1 || e === -1) throw new Error('no JSON');
    const parsed = JSON.parse(raw.slice(s, e + 1));
    return { ...det, interesting: !!parsed.interesting, reason: parsed.reason, source: 'llm' };
  } catch (_) {
    return { ...det, source: 'heuristic-fallback' };
  }
}

module.exports = { scoreEpisode, judgeInteresting, buildMoiPrompt, knownTitles, DEFAULT_THRESHOLD };
