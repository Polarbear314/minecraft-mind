// The body's journal: what actually happened, tick by tick, and how each night
// went. Two jobs (design-learning-from-the-readings.md, Phase 1):
//
// 1. PERFORMANCE TRACE (Lucken): one JSON line per tick in logs/ticks-*.jsonl
//    — where the body was, what it sensed around it, what it did, who chose
//    it (Claude, a held plan, or instinct), and whether the body managed it.
//    This is also the raw material for a learned threat model later (Buckner:
//    every tick is an example, not just the notable ones).
//
// 2. GRADED OUTCOMES (Newell & Simon's "clicks"): death is all-or-nothing and
//    teaches little. At every dawn the night is graded — survived or not, how
//    hurt, and how much of it was spent under cover vs. in the open — and
//    written as an Experience. That conjunction (night AND exposed vs. night
//    AND sheltered) is exactly what "The Night Hurts Whatever I Do" couldn't
//    see (Rumelhart's XOR lesson). Deaths become Experiences too.
const { appendJsonLine } = require('../decision/decisionLog');
const { logExperience } = require('../vault/experienceLog');

const r1 = (n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : null);

function share(part, whole) {
  return whole > 0 ? part / whole : 0;
}

function howOften(fraction) {
  if (fraction >= 0.8) return 'nearly all of it';
  if (fraction >= 0.55) return 'most of it';
  if (fraction >= 0.3) return 'some of it';
  if (fraction > 0) return 'a little of it';
  return 'none of it';
}

function timesWord(n) {
  return n === 1 ? 'once' : n === 2 ? 'twice' : 'again and again';
}

/** Grade one night into { title, body, valenceBand, report }. */
function gradeNight(n, endedAt) {
  const coverShare = share(n.coveredTicks, n.ticks);
  const enclosedShare = share(n.enclosedTicks, n.ticks);
  const report = {
    started: n.startedAt.toISOString(),
    ended: endedAt.toISOString(),
    minutes: r1((endedAt - n.startedAt) / 60000),
    ticks: n.ticks,
    deaths: n.deaths,
    survived: n.deaths === 0,
    healthLost: r1(n.healthLost),
    hurtTicks: n.hurtTicks,
    shareUnderCover: r1(coverShare),
    shareEnclosed: r1(enclosedShare),
    shareHostileNear: r1(share(n.hostileNearTicks, n.ticks)),
  };
  const where = enclosedShare >= 0.55 ? ' Enclosed' : coverShare >= 0.55 ? ' Under Cover' : coverShare < 0.2 ? ' In The Open' : '';
  let title;
  let valenceBand;
  let hurt;
  if (n.deaths > 0) {
    title = `Died In The Night${where}`;
    valenceBand = 'negative';
    hurt = `I died ${timesWord(n.deaths)}.`;
  } else if (n.healthLost <= 0) {
    title = `Came Through The Night Unhurt${where}`;
    valenceBand = 'positive';
    hurt = 'Nothing hurt me.';
  } else {
    title = `Came Through The Night Hurt${where}`;
    valenceBand = n.healthLost >= 10 ? 'negative' : 'neutral';
    hurt = n.healthLost >= 10 ? 'I was badly hurt, but I lived to see the light.' : 'I was hurt a little, but I lived to see the light.';
  }
  const body = `The night came and went. I spent ${howOften(coverShare)} with something over my head ` +
    `and ${howOften(enclosedShare)} closed in on every side. ` +
    `${n.hostileNearTicks ? `Hostile things were near for ${howOften(share(n.hostileNearTicks, n.ticks))}. ` : ''}${hurt}`;
  return { title, body, valenceBand, report };
}

/**
 * createBodyJournal({ vaultPath, logDir }) -> { observe(...), noteDeath(now) }.
 * observe() is called once per tick by the loop (after acting); noteDeath()
 * by the bot's 'death' event. Neither ever throws into its caller.
 */
function createBodyJournal({ vaultPath, logDir = null, hostileRange = 10, onNight = null } = {}) {
  let night = null;
  let lastHealth = null;
  let lastLocated = [];

  function freshNight(now) {
    return {
      startedAt: now, ticks: 0, deaths: 0, healthLost: 0, hurtTicks: 0,
      coveredTicks: 0, enclosedTicks: 0, hostileNearTicks: 0,
    };
  }

  function observe({ observation: o, action, tookDamage, drives, now = new Date(), locatedIn = [] }) {
    lastLocated = locatedIn;
    const a = o.affordances || null;
    const hostiles = (o.nearbyEntities || []).filter((e) => e.hostile).slice(0, 5)
      .map((e) => ({ name: e.name, d: e.distance }));
    if (logDir) {
      appendJsonLine(logDir, 'ticks', {
        ts: now.toISOString(),
        pos: o.position ? { x: r1(o.position.x), y: r1(o.position.y), z: r1(o.position.z) } : null,
        health: r1(o.health),
        food: o.food,
        isDay: o.isDay,
        // For a learning cortex (design-plasticity-and-a-learning-cortex.md, B1):
        // the hour, the non-hostile company, and what is carried.
        tod: o.timeOfDay != null ? Math.round(o.timeOfDay) : null,
        near: (o.nearbyEntities || []).filter((e) => !e.hostile).slice(0, 4).map((e) => ({ name: e.name, d: e.distance })),
        inv: (o.inventory || []).slice(0, 8).map((i) => `${i.name} x${i.count}`).join(', ') || null,
        border: o.borderDistance,
        aff: a ? {
          sky: a.skyOverhead, roof: a.roof, walls: a.walls, enclosed: a.enclosed,
          door: a.door ? a.door.distance : null, bed: a.bed ? a.bed.distance : null, blocks: a.placeable.length,
        } : null,
        hostiles,
        action: { type: action.type, at: action.at || null, source: action.source || null, ...(action.plan ? { plan: action.plan } : {}) },
        result: action.result || null,
        tookDamage: !!tookDamage,
        drives: drives || null,
      });
    }

    // Night grading.
    const healthDrop = lastHealth != null && o.health < lastHealth ? lastHealth - o.health : 0;
    lastHealth = o.health;
    if (!o.isDay) {
      if (!night) night = freshNight(now);
      night.ticks += 1;
      night.healthLost += healthDrop;
      if (tookDamage) night.hurtTicks += 1;
      if (a && !a.skyOverhead) night.coveredTicks += 1;
      if (a && a.enclosed) night.enclosedTicks += 1;
      if (hostiles.some((h) => h.d != null && h.d <= hostileRange)) night.hostileNearTicks += 1;
    } else if (night) {
      const done = night;
      night = null;
      if (done.ticks >= 10) { // a flicker of dark is not a night
        const g = gradeNight(done, now);
        if (logDir) appendJsonLine(logDir, 'nights', g.report);
        logExperience(vaultPath, {
          title: g.title, timestamp: now, involves: [], locatedIn, deltas: {}, valenceBand: g.valenceBand, body: g.body,
        });
        if (onNight) Promise.resolve().then(() => onNight(g.report, now)).catch(() => {});
      }
    }
  }

  function noteDeath(now = new Date()) {
    try {
      if (night) night.deaths += 1;
      lastHealth = null; // respawn resets the body
      if (logDir) appendJsonLine(logDir, 'ticks', { ts: now.toISOString(), event: 'death', night: !!night });
      logExperience(vaultPath, {
        title: night ? 'Died At Night' : 'Died By Day',
        timestamp: now,
        involves: [],
        locatedIn: lastLocated,
        causes: ['Fear'],
        deltas: { fear_delta: 1.0 },
        valenceBand: 'negative',
        body: night
          ? 'Everything went dark. I died in the night, and woke again where I began.'
          : 'Everything went dark in daylight. I died, and woke again where I began.',
      });
    } catch (_) { /* a death must not crash the mind */ }
  }

  return { observe, noteDeath };
}

module.exports = { createBodyJournal, gradeNight };
