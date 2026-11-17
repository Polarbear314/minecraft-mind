// Brain view: a live, anatomical picture of MindBot's mind in the browser.
//
//   npm run brain        ->  http://localhost:3008
//
// Read-only and separate from the agent: it never touches the bot, it only
// reads what the mind leaves behind — the tick journal, the decision and dream
// logs, the agent log, and the vault — every couple of seconds. Each brain
// region in the page lights up with what that part of the mind is doing.
// Safe to start, stop or restart at any time.
const fs = require('fs');
const path = require('path');
const http = require('http');

const AGENT = path.resolve(__dirname, '..', '..');
const ROOT = path.resolve(AGENT, '..');
require('dotenv').config({ path: path.join(AGENT, '.env') });
const fm = require('../vault/frontmatter');

const PORT = Number(process.env.BRAIN_VIEW_PORT) || 3008;
const VAULT = (process.env.VAULT_PATH || '').trim();
const LOGS = (() => {
  const v = (process.env.DECISION_LOG_DIR || '').trim();
  return v && v.toLowerCase() !== 'off' ? v : path.join(ROOT, 'logs');
})();
const PAGE = path.join(__dirname, 'brainView.html');

// ------------------------------------------------------------ file helpers

/** The newest file in LOGS whose name starts with prefix. */
function newest(prefix) {
  try {
    const files = fs.readdirSync(LOGS).filter((f) => f.startsWith(prefix)).sort();
    return files.length ? path.join(LOGS, files[files.length - 1]) : null;
  } catch (_) {
    return null;
  }
}

/** The last lines of a file, reading at most maxBytes from its end. */
function tailLines(file, maxBytes = 262144) {
  if (!file) return [];
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
    if (start > 0) lines.shift(); // first line is probably cut
    return lines;
  } catch (_) {
    return [];
  }
}

function jsonLines(file, maxBytes) {
  const out = [];
  for (const l of tailLines(file, maxBytes)) {
    try { out.push(JSON.parse(l)); } catch (_) { /* skip partial lines */ }
  }
  return out;
}

function countLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch (_) {
    return 0;
  }
}

function note(rel) {
  try {
    return fm.parse(fs.readFileSync(path.join(VAULT, rel), 'utf8'));
  } catch (_) {
    return null;
  }
}

function listMd(rel) {
  try {
    return fs.readdirSync(path.join(VAULT, rel)).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
  } catch (_) {
    return [];
  }
}

const excerpt = (s, n = 220) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, n);

// ------------------------------------------------------------ vault (cached)

let vaultCache = { at: 0, data: null };

function walkConcepts() {
  const rows = [];
  (function walk(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.isDirectory()) { if (name !== 'Abstract') walk(full); continue; }
      if (!name.endsWith('.md')) continue;
      try {
        const { data } = fm.parse(fs.readFileSync(full, 'utf8'));
        const v = Number(data.valence);
        if (Number.isFinite(v)) rows.push({ title: name.slice(0, -3), valence: v, met: Number(data.encounter_count) || 0 });
      } catch (_) { /* skip */ }
    }
  })(path.join(VAULT, 'Concepts'));
  return rows;
}

function readVault() {
  if (Date.now() - vaultCache.at < 8000 && vaultCache.data) return vaultCache.data;
  const concepts = walkConcepts();
  const experiences = listMd('Experiences');
  const insights = listMd(path.join('Concepts', 'Abstract', 'Insight'));
  const skills = listMd(path.join('Concepts', 'Abstract', 'Skill'));
  const strategies = listMd(path.join('Concepts', 'Abstract', 'Strategy'));
  const goals = listMd('Goals');
  const gaps = listMd('Gaps');

  const insightNotes = insights.slice(-6).reverse().map((f) => {
    const n = note(path.join('Concepts', 'Abstract', 'Insight', f));
    return { title: f.slice(0, -3), body: excerpt(n && n.body, 200), by: n && n.data.dreamed_by };
  });
  const goalNotes = goals.map((f) => {
    const n = note(path.join('Goals', f));
    return { title: f.slice(0, -3), founding: !(n && n.data.serves), body: excerpt(n && n.body, 160) };
  });
  const gapNotes = gaps.map((f) => {
    const n = note(path.join('Gaps', f));
    return { body: excerpt(n && n.body, 160), count: n ? Number(n.data.count) || 1 : 1, last: n ? String(n.data.last_hit || '') : '' };
  }).sort((a, b) => (a.last < b.last ? 1 : -1)).slice(0, 6);
  const strategyNotes = strategies.map((f) => {
    const n = note(path.join('Concepts', 'Abstract', 'Strategy', f));
    return { title: f.slice(0, -3), rate: n ? Number(n.data.success_rate) : null, tries: n ? Number(n.data.attempt_count) || 0 : 0 };
  }).sort((a, b) => b.tries - a.tries).slice(0, 8);
  const body = note(path.join('State', 'What My Body Knows.md'));
  const intention = note(path.join('State', 'Current Intention.md'));
  const state = note(path.join('State', 'Current State.md'));

  vaultCache = {
    at: Date.now(),
    data: {
      counts: {
        concepts: concepts.length, experiences: experiences.length, insights: insights.length,
        skills: skills.length, strategies: strategies.length, goals: goals.length, gaps: gaps.length,
      },
      recentExperiences: experiences.slice(-7).reverse().map((f) => f.slice(0, -3).replace(/^\d{4}-\d{2}-\d{2}T\d{4} - /, '')),
      insights: insightNotes,
      skills: skills.map((f) => f.slice(0, -3)),
      goals: goalNotes,
      gaps: gapNotes,
      strategies: strategyNotes,
      feared: concepts.filter((c) => c.valence < 0).sort((a, b) => a.valence - b.valence).slice(0, 5),
      loved: concepts.filter((c) => c.valence > 0).sort((a, b) => b.valence - a.valence).slice(0, 5),
      edible: body && Array.isArray(body.data.edible) ? body.data.edible : [],
      inedible: body && Array.isArray(body.data.inedible) ? body.data.inedible : [],
      intention: intention && intention.data.status === 'active' ? excerpt(intention.body, 200) : null,
      mood: state ? state.data.mood || null : null,
      dominant: state ? String(state.data.dominant_drive || '').replace(/\[|\]/g, '') : null,
    },
  };
  return vaultCache.data;
}

// ------------------------------------------------------------ live state

function brainMap() {
  try {
    return JSON.parse(fs.readFileSync(path.join(AGENT, 'brain-map.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function readState() {
  const now = Date.now();
  const ticks = jsonLines(newest('ticks-'), 400000);
  const lastTick = [...ticks].reverse().find((t) => !t.event) || null;
  const recent = ticks.filter((t) => !t.event).slice(-200);
  const sources = {};
  const actions = {};
  let failures = 0;
  for (const t of recent) {
    const s = (t.action && t.action.source) || 'instinct';
    sources[s] = (sources[s] || 0) + 1;
    const a = t.action ? `${t.action.type}${t.action.at ? ` ${t.action.at}` : ''}` : '?';
    actions[a] = (actions[a] || 0) + 1;
    if (t.result && t.result.ok === false) failures += 1;
  }
  // The behaviour stack (MIND=layers, docs/design-subsumption.md): who has the
  // body now, who else spoke, and each layer's share of the last 200 ticks.
  const LAYER_ORDER = ['survive', 'make', 'shelter', 'gather', 'forage', 'wander'];
  const layerShare = {};
  let layerTicks = 0;
  for (const t of recent) if (t.action && t.action.layer) { layerShare[t.action.layer] = (layerShare[t.action.layer] || 0) + 1; layerTicks += 1; }
  const la = lastTick && lastTick.action;
  const layers = la && la.layer ? {
    order: LAYER_ORDER,
    current: la.layer,
    act: `${la.type}${la.at ? ` ${la.at}` : ''}${la.plan ? ` (plan "${la.plan}")` : ''}`,
    voices: la.voices || [],
    share: Object.fromEntries(LAYER_ORDER.map((k) => [k, layerTicks ? Math.round((100 * (layerShare[k] || 0)) / layerTicks) : 0])),
    ticks: layerTicks,
  } : null;
  const deathsToday = ticks.filter((t) => t.event === 'death').length;
  const lastDeath = [...ticks].reverse().find((t) => t.event === 'death') || null;

  const decFile = newest('decisions-');
  const decisions = jsonLines(decFile, 600000);
  const lastDec = decisions[decisions.length - 1] || null;
  const disagreements = decisions.filter((d) => d.parsed && d.instinct && d.parsed.action !== d.instinct.type).length;

  const dreams = jsonLines(newest('dreams-'), 400000);
  const lastDream = dreams[dreams.length - 1] || null;
  const nights = jsonLines(newest('nights-'), 50000);

  // Agent log: Claude's resting state, recent thoughts and speech.
  const logLines = tailLines(newest('agent-'), 120000);
  let resting = false;
  let restLine = null;
  for (const l of logLines) {
    if (l.startsWith('[brain] Claude is resting')) { resting = true; restLine = l; }
    if (l.startsWith('[brain] Claude is awake') || l.startsWith('[mind] Spawned')) { resting = false; }
  }
  const thoughts = [];
  const said = [];
  for (const l of logLines) {
    const m = l.match(/^\[tick\] (\S+).*?\| "([^"]+)"/);
    if (m && thoughts[thoughts.length - 1] !== m[2]) thoughts.push(m[2]);
    const s = l.match(/says: "([^"]+)"/);
    if (s && said[said.length - 1] !== s[1]) said.push(s[1]);
  }

  return {
    now,
    online: !!(lastTick && now - Date.parse(lastTick.ts) < 10000),
    tick: lastTick,
    tickAgeMs: lastTick ? now - Date.parse(lastTick.ts) : null,
    recent: { n: recent.length, sources, actions, failures },
    deathsToday,
    lastDeath: lastDeath ? lastDeath.ts : null,
    decision: lastDec ? {
      ts: lastDec.ts, outcome: lastDec.outcome, model: lastDec.model, latencyMs: lastDec.latencyMs,
      action: lastDec.parsed ? lastDec.parsed.action : null,
      at: lastDec.parsed ? lastDec.parsed.at || null : null,
      target: lastDec.parsed ? lastDec.parsed.target || null : null,
      item: lastDec.parsed ? lastDec.parsed.item || null : null,
      thought: lastDec.parsed ? lastDec.parsed.thought || null : null,
      say: lastDec.parsed ? lastDec.parsed.say || null : null,
      instinct: lastDec.instinct ? lastDec.instinct.type : null,
      error: lastDec.error || null,
    } : null,
    decisionsToday: countLines(decFile),
    disagreements,
    dream: lastDream ? {
      ts: lastDream.ts, by: lastDream.by, outcome: lastDream.outcome, latencyMs: lastDream.latencyMs,
      written: lastDream.written || [], error: lastDream.error || null,
    } : null,
    dreamsToday: dreams.length,
    night: nights[nights.length - 1] || null,
    claude: { resting, line: restLine },
    brainMap: brainMap(),
    layers,
    thoughts: thoughts.slice(-8).reverse(),
    said: said.slice(-4).reverse(),
    vault: VAULT ? readVault() : null,
    live: (() => {
      try {
        const l = JSON.parse(fs.readFileSync(path.join(LOGS, 'brain-live.json'), 'utf8'));
        return now - Date.parse(l.ts) < 10000 ? l : null; // stale = agent not running
      } catch (_) {
        return null;
      }
    })(),
  };
}

// ------------------------------------------------------------ server

const server = http.createServer((req, res) => {
  if (req.url === '/state') {
    let body;
    try {
      body = JSON.stringify(readState());
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(body);
  }
  if (req.url === '/' || req.url.startsWith('/?')) {
    try {
      const html = fs.readFileSync(PAGE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch (err) {
      res.writeHead(500);
      return res.end(`brainView.html missing: ${err.message}`);
    }
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[brain-view] MindBot's brain: http://localhost:${PORT}`);
  console.log(`[brain-view] reading logs from ${LOGS}`);
  console.log(`[brain-view] reading vault ${VAULT || '(VAULT_PATH not set)'}`);
});
