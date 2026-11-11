// Writes what the agent learned by WATCHING into its vault — staying strictly
// inside the existing ontology, so the graph view shows observed learning the
// same way it shows everything else. One watched, interesting act produces up
// to three notes:
//
//   1. an Experience  — the episodic memory of having watched (like any event);
//   2. an Insight     — a belief about the OTHER mind (theory of mind), linked
//                        back to that Experience via learned_from;
//   3. a subgoal      — the agent's OWN intention to learn the thing, serving
//                        the founding goal [[Live A Good Life]].
//
// Deliberately, watching NEVER writes a Skill. A Skill in this vault is
// certified know-how, earned by the agent's own repeated success (see
// dream.js). What you learn by watching is a hypothesis: a belief plus a goal
// to try it. The existing awake loop + dreaming promote it to a real Skill
// only once the agent has actually done it. That keeps "what I know" honest.
'use strict';

const path = require('path');
const paths = require('./paths');
const { titleCase, compactTimestamp, sanitize } = require('./paths');
const { logExperience } = require('./experienceLog');
const { writeInsight } = require('./dreamStore');
const { writeSubgoal, foundingGoalTitle } = require('./goalStore');

/** The exact note-title (with timestamp prefix) logExperience will produce. */
function experienceTitle(vaultPath, iso, title) {
  return path.basename(paths.experiencePath(vaultPath, iso, title), '.md');
}

/**
 * Record one interesting watched episode.
 *
 * args: {
 *   episode,               // from watchTracker
 *   intent,                // from theoryOfMind.inferIntent
 *   locatedIn: [title,...], // where it happened (optional)
 *   timestamp: Date,
 * }
 * Returns { experience, insight, subgoal } — titles actually written (or null
 * where a note already existed; Insight/subgoal never overwrite).
 */
function recordObservation(vaultPath, { episode, intent, locatedIn = [], timestamp = new Date() } = {}) {
  const iso = timestamp.toISOString();
  const actor = episode.actor;
  const outcomeTitle = titleCase(episode.outcome.name);

  // 1. The memory of watching.
  const expTitle = `Watched ${actor} ${intent.verbPhrase}`;
  const involves = [actor, outcomeTitle, ...(episode.materials || []).map(titleCase)];
  const materialsProse = (episode.materials || []).length
    ? ` It looked like ${episode.materials.map((m) => titleCase(m).toLowerCase()).join(' and ')} went into it.`
    : '';
  const body =
    `${actor} was near me and I watched: ${episode.summary}.${materialsProse} ` +
    `I could not have done this. ${intent.actorGoal} It made me want to understand.`;

  logExperience(vaultPath, {
    title: expTitle,
    timestamp,
    involves: [...new Set(involves)],
    locatedIn,
    causes: ['Curiosity'],
    deltas: { curiosity_delta: 0.6 },
    valenceBand: 'positive',
    body,
  });
  const learnedFrom = [experienceTitle(vaultPath, iso, expTitle)];

  // 2. The belief about the other mind (theory of mind).
  const insight = writeInsight(vaultPath, {
    title: intent.insightTitle,
    body: intent.insightBody,
    learnedFrom,
    timestamp,
  });

  // 3. The agent's own goal to learn it.
  const founding = foundingGoalTitle(vaultPath);
  const subgoal = founding
    ? writeSubgoal(vaultPath, { title: intent.subgoalTitle, body: intent.subgoalBody, servesTitle: founding, timestamp })
    : null;

  return {
    experience: sanitize(expTitle),
    insight: insight ? insight.title : null,
    subgoal: subgoal ? subgoal.title : null,
  };
}

module.exports = { recordObservation, experienceTitle };
