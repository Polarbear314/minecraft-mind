// Standalone, offline demonstration of observational learning — no Minecraft
// server, no LLM required. Copies the live vault to a temp dir (like
// simulate.js), scripts beings acting near the agent, runs the observer, and
// prints the notes it wrote plus a validation pass.
//
// It exercises BOTH halves of the signal-quality rules learned from the first
// live run: genuine player demonstrations are learned, while the noise that
// once fooled it (a bee "growing" grass, a player blamed for grass spreading
// on its own, an idle bystander near a change) is correctly ignored.
//
//   Run:  node src/observation/demo.js
//   (honours SIM_VAULT_SRC / VAULT_PATH for the source vault, like the sim)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
require('dotenv').config();

const { createObserver } = require('./observe');
const { recordEncounter } = require('../vault/conceptStore');
const { foundingGoalTitle } = require('../vault/goalStore');

// -------------------------------------------------------------- temp vault
const sourceVault = process.env.SIM_VAULT_SRC || process.env.VAULT_PATH || path.resolve(__dirname, '..', '..', 'vault');
if (!fs.existsSync(sourceVault)) {
  console.error(`Cannot find source vault at ${sourceVault} (set VAULT_PATH or SIM_VAULT_SRC).`);
  process.exit(1);
}
const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-observe-'));
fs.cpSync(sourceVault, vaultPath, { recursive: true });
console.log(`Watching-learning demo against a temp copy of the vault:\n  ${vaultPath}\n`);

const P = { x: 3, y: 64, z: 0 };            // where the teacher stands, near the agent
let t = 0;
const clock = () => new Date(Date.UTC(2026, 6, 20, 12, 0, t++)); // 1s / tick

const ga = (heldItem) => ({ name: 'GiantAxe619', isPlayer: true, position: P, heldItem });
const bee = () => ({ name: 'bee', isPlayer: false, position: P, heldItem: undefined });
const swing = { kind: 'swing', by: 'GiantAxe619', position: P };

async function run(observer, label, ticks) {
  console.log(`\n=== ${label} ===`);
  for (const [note, world] of ticks) {
    const res = await observer.observe({ now: clock(), ...world });
    const line = res
      .map((r) => r.skipped
        ? `  · ignored (${r.interest.source}${r.interest.reason ? `: ${r.interest.reason}` : ''}) — ${r.episode.outcome.name}`
        : r.written
          ? `  ★ LEARNED from ${r.episode.actor}: goal "${r.written.subgoal}" (saw ${r.episode.outcome.name})`
          : `  · (no episode)`)
      .join('\n');
    console.log(`  tick — ${note}${line ? `\n${line}` : ''}`);
  }
}

async function main() {
  recordEncounter(vaultPath, 'player', 'GiantAxe619', {});

  // ---- Phase 1: genuine demonstrations, heuristics only (held-change = acted)
  const offline = createObserver({ vaultPath });
  await run(offline, 'Phase 1 — genuine demonstrations (no LLM)', [
    ['GiantAxe619 holds planks', { others: [ga('oak_planks')] }],
    ['a crafting table appears, hands empty', {
      others: [ga(null)],
      worldEvents: [{ kind: 'block_placed', name: 'crafting_table', position: P }],
    }],
    ['GiantAxe619 holds a torch', { others: [ga('torch')] }],
    ['a torch appears, lighting the dark', {
      others: [ga(null)],
      worldEvents: [{ kind: 'block_placed', name: 'torch', position: P }],
      chatLines: '- just now, GiantAxe619 said: "Seek light before dark."',
    }],
  ]);

  // ---- Phase 1b: the noise that fooled the first live run — must be IGNORED
  await run(offline, 'Phase 1b — noise rejection (no LLM)', [
    ['a bee is near grass that spreads on its own', {
      others: [bee()],
      worldEvents: [{ kind: 'block_placed', name: 'grass_block', position: P }],
    }],
    ['GiantAxe619 stands idle while stone appears nearby', {
      others: [ga(null)],
      worldEvents: [{ kind: 'block_placed', name: 'stone', position: P }],
    }],
    ['GiantAxe619 swings, and grass spreads at that moment', {
      others: [ga(null)],
      worldEvents: [swing, { kind: 'block_placed', name: 'grass_block', position: P }],
    }],
    ['GiantAxe619 swings and breaks coal ore', {
      others: [ga(null)],
      worldEvents: [swing, { kind: 'block_broken', name: 'coal_ore', position: P }],
    }],
  ]);

  // ---- Phase 2: OMNI interestingness + MindForge ToM via LLM stubs
  const moiAsk = async (prompt) =>
    /stone/i.test(prompt)
      ? '{"interesting": false, "reason": "I break plain stone myself already"}'
      : '{"interesting": true, "reason": "fire-in-a-box — I have never made one"}';
  const tomAsk = async () => JSON.stringify({
    belief: 'GiantAxe619 knows how to build a furnace, a box of stone that changes things with heat',
    goal: 'to be able to cook and smelt what he gathers',
    verb: 'build a furnace',
    method: ['gather enough stone', 'hollow it into a box open at the front', 'set it down where it can be used'],
  });
  const online = createObserver({ vaultPath, moiAsk, tomAsk });
  await run(online, 'Phase 2 — OMNI interestingness + ToM (LLM stubs)', [
    ['GiantAxe619 swings and breaks stone (he judges it dull)', {
      others: [ga(null)],
      worldEvents: [swing, { kind: 'block_broken', name: 'stone', position: P }],
    }],
    ['GiantAxe619 holds cobblestone', { others: [ga('cobblestone')] }],
    ['a furnace appears, glowing', {
      others: [ga(null)],
      worldEvents: [{ kind: 'block_placed', name: 'furnace', position: P }],
    }],
  ]);

  // --------------------------------------------------------- verification
  // Scope to notes THIS demo created (dated 2026-07-20), so pre-existing junk
  // left in the real vault by earlier runs doesn't pollute the assertions.
  const DEMO_DAY = '2026-07-20';
  const list = (rel, match) => {
    const dir = path.join(vaultPath, rel);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => {
      if (!f.endsWith('.md') || !match(f)) return false;
      return fs.readFileSync(path.join(dir, f), 'utf8').includes(DEMO_DAY);
    });
  };
  const insights = list('Concepts/Abstract/Insight', (f) => /^GiantAxe619 Can /.test(f));
  const goals = list('Goals', (f) => /^Learn To /.test(f));

  console.log('\n=== Notes written by watching ===');
  console.log('  Beliefs:', insights.map((f) => f.slice(0, -3)));
  console.log('  Goals:  ', goals.map((f) => f.slice(0, -3)));

  console.log('\n=== Validation ===');
  let fail = false;
  const check = (ok, label) => { console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`); if (!ok) fail = true; };
  const anyGoal = (re) => goals.some((f) => re.test(f));
  const anyBelief = (re) => insights.some((f) => re.test(f));

  // Valid YAML everywhere.
  let yamlErrors = 0;
  (function walk(dir) {
    for (const n of fs.readdirSync(dir)) {
      const full = path.join(dir, n);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!n.endsWith('.md')) continue;
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(full, 'utf8'));
      if (!m) continue;
      try { yaml.load(m[1]); } catch (e) { yamlErrors++; console.error(`    bad YAML: ${path.relative(vaultPath, full)}`); }
    }
  })(vaultPath);
  check(yamlErrors === 0, 'all notes have valid YAML frontmatter');

  // Genuine demonstrations WERE learned.
  check(anyGoal(/Make A Crafting Table/), 'learned: Make A Crafting Table (held-change acted)');
  check(anyGoal(/Make Light/), 'learned: Make Light (torch)');
  check(anyGoal(/Gather Coal Ore/), 'learned: Gather Coal Ore (swing-gated)');
  check(anyBelief(/Build A Furnace/), 'learned via LLM ToM: Build A Furnace');

  // Noise was IGNORED.
  check(!anyGoal(/Grass/i) && !anyBelief(/Grass/i), 'IGNORED grass (bee + ambient + swing-on-ambient)');
  check(!anyBelief(/Stone/i) && !anyGoal(/Stone/i), 'IGNORED stone (idle bystander + MoI-rejected)');

  // Goals read as present-tense intentions, not past-tense descriptions.
  check(!anyGoal(/Made|Grew|Moved|Converted|Broke|Built|Placed|Gathered/), 'goal titles are present-tense (no "Made/Grew/Moved/…")');

  // Watching yields hypotheses, never certified Skills.
  const skillsDir = path.join(vaultPath, 'Concepts', 'Abstract', 'Skill');
  const newSkill = fs.existsSync(skillsDir)
    && fs.readdirSync(skillsDir).some((f) => /Crafting Table|Furnace|Coal Ore|Make Light/i.test(f));
  check(!newSkill, 'watching wrote NO Skill note (observed know-how stays a hypothesis)');

  // Structural invariants.
  const craftGoal = goals.find((f) => /Make A Crafting Table/.test(f));
  if (craftGoal) {
    const text = fs.readFileSync(path.join(vaultPath, 'Goals', craftGoal), 'utf8');
    check(text.includes('serves: "[[Live A Good Life]]"'), 'subgoal serves [[Live A Good Life]]');
  }
  check(foundingGoalTitle(vaultPath) === 'Live A Good Life', 'founding goal not shadowed');
  const craftBelief = insights.find((f) => /Make A Crafting Table/.test(f));
  if (craftBelief) {
    const text = fs.readFileSync(path.join(vaultPath, 'Concepts/Abstract/Insight', craftBelief), 'utf8');
    check(/learned_from:[\s\S]*Watched GiantAxe619/i.test(text), 'belief grounded (learned_from) in the watching Experience');
  }

  console.log('\n=== Sample: a learned goal ===');
  if (craftGoal) console.log(fs.readFileSync(path.join(vaultPath, 'Goals', craftGoal), 'utf8'));

  if (fail) { console.error('\nDEMO FAILED — see FAILs above.'); process.exit(1); }
  console.log('Demo passed. Genuine demonstrations learned; noise ignored.');
}

main().catch((e) => { console.error('Demo crashed:', e); process.exit(1); });
