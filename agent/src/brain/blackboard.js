// The blackboard: a shared workspace every brain region reads from and writes
// to, all at once (Newell & Simon's HEARSAY "blackboard"; Churchland &
// Sejnowski's "Athenian democracy" rather than a Ford assembly line). Regions
// run as independent loops at their own speeds — the brainstem every tick,
// the amygdala and the inner voice every few seconds on the local model,
// Claude every 30 seconds, rumination every couple of minutes — and none of
// them waits for another. The body reads the freshest posts every tick.
//
// The blackboard also counts every firing of every region and writes a small
// live file (logs/brain-live.json, rewritten once a second) that the brain
// view animates. Nothing here ever throws into a caller.
const fs = require('fs');
const path = require('path');

const REGIONS = [
  'brainstem', 'occipital', 'parietal', 'hypothalamus', 'motor', 'temporal',
  'amygdala', 'frontal', 'innerVoice', 'thalamus', 'hippocampus', 'cerebellum', 'callosum',
];
const RATE_WINDOW_MS = 60000; // fires per minute, over the last minute
const MAX_EVENTS = 60;

function createBlackboard({ logDir = null, writeEveryMs = 1000, now = () => Date.now() } = {}) {
  const posts = new Map(); // kind -> { region, data, summary, ts }
  const regions = {};
  for (const r of REGIONS) regions[r] = { fires: 0, lastFire: null, last: null, recent: [] };
  const events = [];
  let timer = null;

  function region(name) {
    if (!regions[name]) regions[name] = { fires: 0, lastFire: null, last: null, recent: [] };
    return regions[name];
  }

  /** A region did something. summary is a short human-readable line. */
  function fire(name, summary = null) {
    try {
      const t = now();
      const r = region(name);
      r.fires += 1;
      r.lastFire = t;
      if (summary) r.last = String(summary).slice(0, 160);
      r.recent.push(t);
      while (r.recent.length && t - r.recent[0] > RATE_WINDOW_MS) r.recent.shift();
      if (summary) {
        events.push({ ts: t, region: name, text: String(summary).slice(0, 160) });
        if (events.length > MAX_EVENTS) events.shift();
      }
    } catch (_) { /* never */ }
  }

  /** Post a finding under a kind ("percept", "gut", "voice", "rumination"...). */
  function post(name, kind, data, summary = null) {
    posts.set(kind, { region: name, data, summary, ts: now() });
    fire(name, summary);
  }

  /** The freshest post of a kind, or null if none or older than maxAgeMs. */
  function get(kind, maxAgeMs = Infinity) {
    const p = posts.get(kind);
    if (!p) return null;
    if (now() - p.ts > maxAgeMs) return null;
    return p;
  }

  /** Recent posts of a kind kept as a short history (for the inner voice stream). */
  const histories = new Map();
  function remember(kind, item, keep = 6) {
    const h = histories.get(kind) || [];
    h.push({ ...item, ts: now() });
    while (h.length > keep) h.shift();
    histories.set(kind, h);
  }
  function history(kind) {
    return histories.get(kind) || [];
  }

  function snapshot() {
    const t = now();
    const out = { ts: new Date(t).toISOString(), regions: {}, events: events.slice(-40).map((e) => ({ ...e, ts: new Date(e.ts).toISOString() })) };
    for (const [name, r] of Object.entries(regions)) {
      while (r.recent.length && t - r.recent[0] > RATE_WINDOW_MS) r.recent.shift();
      out.regions[name] = {
        fires: r.fires,
        perMin: r.recent.length,
        lastFire: r.lastFire ? new Date(r.lastFire).toISOString() : null,
        last: r.last,
        times: r.recent.slice(-80), // epoch ms of each fire in the last minute
      };
    }
    return out;
  }

  function writeLive() {
    if (!logDir) return;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const file = path.join(logDir, 'brain-live.json');
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot()), 'utf8');
      fs.renameSync(tmp, file);
    } catch (_) { /* the view can miss a frame */ }
  }

  return {
    fire, post, get, remember, history, snapshot, writeLive,
    start() {
      if (!timer && logDir) timer = setInterval(writeLive, writeEveryMs);
      if (timer && timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createBlackboard, REGIONS };
