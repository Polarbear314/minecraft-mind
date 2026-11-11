// The observation loop, tying the three pieces together:
//
//   watchTracker  → segments other beings' world-state deltas into episodes
//   interestingness (OMNI) → keeps only what's worth learning
//   theoryOfMind (MindForge) → infers why, and how the agent might do it
//   observationStore → writes memory + belief + a goal to learn it
//
// Like the dreamer and the consultation layer, this is designed to sit beside
// the tick loop without ever blocking it: feed it the world each tick via
// observe(); it returns immediately with whatever notes it wrote (usually
// none — interesting acts are rare). The LLM hooks (`ask`) are optional; with
// none, it runs fully offline on heuristics, which is how the sim exercises it.
'use strict';

const { createWatchTracker } = require('./watchTracker');
const { judgeInteresting } = require('./interestingness');
const { inferIntent } = require('./theoryOfMind');
const { recordObservation } = require('../vault/observationStore');

/**
 * Factory.
 * opts: {
 *   vaultPath,
 *   moiAsk,   // optional async(prompt)->text : OMNI model-of-interestingness LLM
 *   tomAsk,   // optional async(prompt)->text : theory-of-mind inference LLM
 *   threshold // interestingness cutoff for the heuristic path (default 0.5)
 * }
 */
function createObserver({ vaultPath, moiAsk, tomAsk, threshold } = {}) {
  const tracker = createWatchTracker();

  return {
    /**
     * Called once per tick with the current world. Returns [{ episode,
     * interest, intent, written }] for episodes acted on this tick (often []).
     *
     * world: {
     *   now,                                   // Date, defaults to now
     *   others: [{name,isPlayer,position,heldItem}],
     *   worldEvents: [{kind,name,position,by?}],
     *   chatLines,                             // chatChannel.promptLines()
     *   locatedIn: [title,...],
     * }
     */
    async observe(world = {}) {
      const now = world.now || new Date();
      tracker.ingest(now.getTime ? now.getTime() : now, world.others || [], world.worldEvents || []);
      const episodes = tracker.takeEpisodes();
      const results = [];

      for (const episode of episodes) {
        const interest = await judgeInteresting(vaultPath, episode, { ask: moiAsk, threshold });
        if (!interest.interesting) {
          results.push({ episode, interest, skipped: true });
          continue;
        }
        const intent = await inferIntent(episode, { ask: tomAsk, chatLines: world.chatLines });
        const written = recordObservation(vaultPath, {
          episode,
          intent,
          locatedIn: world.locatedIn || [],
          timestamp: now instanceof Date ? now : new Date(now),
        });
        results.push({ episode, interest, intent, written });
      }
      return results;
    },
  };
}

module.exports = { createObserver };
