// Action-outcome learning (credit assignment): the bot learns feelings about
// *objects* via conceptStore; this module learns which of its own *strategies*
// work. Each tick attributes that tick's signals (damage, food change, fear
// change, discoveries) to the strategy currently in progress. The window
// around an attempt closes when the action type changes, day flips to night
// (or back), or WINDOW_TICKS elapse — then the window is scored and handed to
// strategyStore as one outcome.
//
// Scoring is deliberately blunt: taking damage during a window makes it a
// failure no matter what else happened; otherwise food gained, fear eased,
// and new discoveries push the score up from a neutral 0.5. Imperfect credit
// assignment ("fleeing still got me hurt") is accepted — the EMA smooths it.
const WINDOW_TICKS = 6;

const VERB_PAST = {
  flee: 'Fled',
  avoid: 'Avoided danger',
  eat: 'Ate',
  seekFood: 'Sought food',
  explore: 'Explored',
  idle: 'Idled',
  swingAt: 'Swung',
  dig: 'Dug',
  place: 'Placed something',
  pickup: 'Picked up',
  craft: 'Crafted',
};

function scoreLabel(score) {
  if (score >= 0.65) return 'success';
  if (score <= 0.35) return 'failure';
  return 'neutral';
}

/**
 * One tracker per bot. track() is called once per tick, after the action is
 * chosen; it returns an outcome object (ready for recordStrategyOutcome) when
 * a window closes, else null.
 */
function createOutcomeTracker(windowTicks = WINDOW_TICKS) {
  let pending = null;

  function begin(actionType, context, observation, fear, now) {
    pending = {
      actionType,
      context,
      startHealth: observation.health,
      startFood: observation.food,
      startFear: fear,
      damage: false,
      discoveries: 0,
      ticks: 0,
      startedAt: now,
    };
  }

  function evaluate(observation, fear) {
    const p = pending;
    const healthDelta = observation.health - p.startHealth;
    const foodDelta = observation.food - p.startFood;
    const fearDelta = fear - p.startFear;

    let score;
    const parts = [];
    if (p.damage || healthDelta < 0) {
      score = 0;
      parts.push(`took damage (health ${p.startHealth} -> ${observation.health})`);
    } else {
      score = 0.5;
      if (foodDelta > 0) {
        score += 0.2;
        parts.push(`food +${foodDelta}`);
      }
      if (fearDelta <= -10) {
        score += 0.2;
        parts.push(`fear eased (${Math.round(p.startFear)} -> ${Math.round(fear)})`);
      }
      if (p.discoveries > 0) {
        score += Math.min(p.discoveries, 2) * 0.15;
        parts.push(`${p.discoveries} new discover${p.discoveries === 1 ? 'y' : 'ies'}`);
      }
      score = Math.min(1, score);
    }
    if (!parts.length) parts.push('nothing notable happened');

    const verb = VERB_PAST[p.actionType] || p.actionType;
    const when = p.context === 'day' ? 'by day' : 'at night';
    return {
      actionType: p.actionType,
      context: p.context,
      score,
      label: scoreLabel(score),
      summary: `${verb} ${when} for ${p.ticks} tick(s): ${parts.join('; ')}.`,
    };
  }

  return {
    /**
     * args: { actionType, context ('day'|'night'), observation, fear,
     *         tookDamage, newConceptCount, now }
     */
    track({ actionType, context, observation, fear, tookDamage, newConceptCount, now }) {
      if (!pending) {
        begin(actionType, context, observation, fear, now);
        return null;
      }
      // This tick's signals happened while the pending strategy was in effect.
      pending.ticks += 1;
      if (tookDamage) pending.damage = true;
      pending.discoveries += newConceptCount || 0;

      const windowClosed =
        actionType !== pending.actionType ||
        context !== pending.context ||
        pending.ticks >= windowTicks;
      if (!windowClosed) return null;

      const outcome = evaluate(observation, fear);
      begin(actionType, context, observation, fear, now);
      return outcome;
    },
  };
}

module.exports = { createOutcomeTracker, WINDOW_TICKS };
