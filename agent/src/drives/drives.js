// The agent's three drives on a 0-100 scale.
function clamp(v) {
  return Math.min(100, Math.max(0, v));
}

class Drives {
  constructor() {
    this.hunger = 0;
    this.fear = 10;
    this.curiosity = 50;
  }

  /**
   * signals: {
   *   food: bot.food (0-20),
   *   tookDamage: boolean,
   *   hostilesNearby: number,
   *   isDark: boolean,
   *   newConceptCount: number,  // concepts first-encountered this tick
   * }
   */
  update(signals = {}) {
    // Hunger tracks Minecraft's own food stat directly.
    const food = Number.isFinite(signals.food) ? signals.food : 20;
    this.hunger = clamp((20 - food) * 5);

    // Fear spikes on damage / hostiles / darkness, decays when safe.
    let fear = this.fear;
    if (signals.tookDamage) fear += 30;
    fear += Math.min(signals.hostilesNearby || 0, 3) * 10;
    if (signals.isDark) fear += 5;
    if (!signals.tookDamage && !(signals.hostilesNearby > 0)) fear *= 0.85;
    this.fear = clamp(fear);

    // Curiosity builds during familiarity, is satisfied (drops) by novelty.
    let curiosity = this.curiosity;
    const novelty = signals.newConceptCount || 0;
    if (novelty > 0) curiosity -= 15 * novelty;
    else curiosity += 3;
    this.curiosity = clamp(curiosity);
  }

  /** Name of the currently strongest drive. */
  dominant() {
    const levels = this.levels();
    return Object.keys(levels).reduce((a, b) => (levels[b] > levels[a] ? b : a));
  }

  levels() {
    return { hunger: this.hunger, fear: this.fear, curiosity: this.curiosity };
  }
}

module.exports = Drives;
