// Dream bake-off: give several minds the SAME dream prompt, built from the
// live vault, and score what each would have written. Read-only: nothing is
// written to the vault (applyDream is never called). Results go to
// logs/bakeoff-<timestamp>.json, and every proposed note is printed so a
// human can judge voice and whether the mind invented knowledge it never earned.
//
//   npm run bakeoff -- qwen3:14b gemma3:12b            (local models via Ollama)
//   npm run bakeoff -- --runs 3 --claude opus qwen3:14b   (adds one Claude baseline)
//   npm run bakeoff -- --rescore ../logs/bakeoff-<...>.json  (re-score a saved run, no model calls)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { buildDreamPrompt, DREAM_SCHEMA, resolveExperienceLink, experienceTitles: titlesOf } = require('../reflection/dream');
const { listInsights, listSkills } = require('../vault/dreamStore');
const { listGoals } = require('../vault/goalStore');
const paths = require('../vault/paths');
const { localProvider, claudeProvider } = require('../brain/providers');

function parseArgs(argv) {
  const out = { runs: 3, claude: null, models: [], rescore: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--runs') out.runs = Number(argv[++i]) || 3;
    else if (argv[i] === '--claude') out.claude = argv[++i];
    else if (argv[i] === '--rescore') out.rescore = argv[++i];
    else out.models.push(argv[i]);
  }
  return out;
}

function experienceTitles(vaultPath) {
  return titlesOf(vaultPath); // sorted oldest-first, as resolveExperienceLink expects
}

/** Score one reply against the same guardrails applyDream enforces, and more. */
function score(text, ctx) {
  const s = { json: false, notes: 0, links: 0, badLinks: 0, numbers: 0, repeats: 0, skillsWithoutSource: 0, parsed: null };
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a === -1 || b === -1) return s;
  let parsed;
  try { parsed = JSON.parse(text.slice(a, b + 1)); } catch (_) { return s; }
  s.json = true;
  s.parsed = parsed;
  for (const kind of ['insights', 'subgoals', 'skills']) {
    for (const n of Array.isArray(parsed[kind]) ? parsed[kind] : []) {
      s.notes += 1;
      if (/\d/.test(String(n.body || ''))) s.numbers += 1;
      if (ctx.known.has(paths.sanitize(String(n.title || '')).toLowerCase())) s.repeats += 1;
      const links = Array.isArray(n.learned_from) ? n.learned_from : [];
      for (const l of links) {
        if (resolveExperienceLink(l, ctx.experiences)) s.links += 1;
        else s.badLinks += 1;
      }
      if (kind === 'skills' && !links.some((l) => resolveExperienceLink(l, ctx.experiences))) s.skillsWithoutSource += 1;
    }
  }
  return s;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const vaultPath = process.env.VAULT_PATH;
  if (!vaultPath || !fs.existsSync(vaultPath)) throw new Error('VAULT_PATH (agent/.env) must point at the live vault');
  if (args.rescore) return rescore(args.rescore, vaultPath);
  if (!args.models.length && !args.claude) throw new Error('name at least one local model, e.g. npm run bakeoff -- qwen3:14b');

  const prompt = buildDreamPrompt(vaultPath);
  const ctx = {
    experiences: experienceTitles(vaultPath),
    known: new Set([...listInsights(vaultPath), ...listSkills(vaultPath), ...listGoals(vaultPath)]
      .map((n) => n.title.toLowerCase())),
  };
  console.log(`Dream prompt: ${prompt.length} chars, ${ctx.experiences.length} experiences in the vault.\n`);

  const minds = args.models.map((m) => localProvider({ model: m, host: process.env.OLLAMA_HOST || undefined, timeoutMs: 600000 }));
  if (args.claude) minds.push(claudeProvider({ model: args.claude, timeoutMs: 180000 }));

  const results = [];
  for (const mind of minds) {
    const runs = mind.by.startsWith('claude:') ? 1 : args.runs; // Claude costs plan usage: one baseline run
    for (let r = 0; r < runs; r += 1) {
      const t0 = Date.now();
      let text = '';
      let error = null;
      try {
        ({ text } = await mind.ask(prompt, { schema: DREAM_SCHEMA }));
      } catch (err) {
        error = err.message;
      }
      const s = score(text, ctx);
      const row = { by: mind.by, run: r + 1, seconds: Math.round((Date.now() - t0) / 100) / 10, error, ...s };
      results.push(row);
      console.log(`== ${mind.by} run ${r + 1}: ${row.seconds}s ` +
        (error ? `ERROR ${error}` : `json=${s.json} notes=${s.notes} links ok/bad=${s.links}/${s.badLinks} ` +
          `numbers=${s.numbers} repeats=${s.repeats} unsourced-skills=${s.skillsWithoutSource}`));
      if (s.parsed) {
        for (const kind of ['insights', 'subgoals', 'skills']) {
          for (const n of Array.isArray(s.parsed[kind]) ? s.parsed[kind] : []) {
            console.log(`   [${kind.slice(0, -1)}] ${n.title}: ${String(n.body || '').replace(/\s+/g, ' ')}`);
          }
        }
      }
    }
  }

  // Summary per mind (lower is better for every column except notes/json).
  console.log('\n=== Summary (per mind, totals over its runs) ===');
  const byMind = {};
  for (const r of results) {
    const m = byMind[r.by] || (byMind[r.by] = { runs: 0, json: 0, notes: 0, badLinks: 0, numbers: 0, repeats: 0, unsourced: 0, seconds: 0, errors: 0 });
    m.runs += 1; m.json += r.json ? 1 : 0; m.notes += r.notes; m.badLinks += r.badLinks; m.numbers += r.numbers;
    m.repeats += r.repeats; m.unsourced += r.skillsWithoutSource; m.seconds += r.seconds; m.errors += r.error ? 1 : 0;
  }
  for (const [by, m] of Object.entries(byMind)) {
    console.log(`${by.padEnd(28)} valid ${m.json}/${m.runs}  notes ${m.notes}  bad-links ${m.badLinks}  numbers ${m.numbers}  ` +
      `repeats ${m.repeats}  unsourced-skills ${m.unsourced}  avg ${Math.round(m.seconds / m.runs)}s  errors ${m.errors}`);
  }
  const outDir = path.resolve(__dirname, '..', '..', '..', 'logs');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `bakeoff-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({ prompt, results: results.map(({ parsed, ...r }) => ({ ...r, notes_proposed: parsed })) }, null, 2));
  console.log(`\nSaved: ${out}`);
}

/** Re-score a saved bake-off against the current scoring rules. */
function rescore(file, vaultPath) {
  const saved = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const ctx = {
    experiences: experienceTitles(vaultPath),
    known: new Set([...listInsights(vaultPath), ...listSkills(vaultPath), ...listGoals(vaultPath)].map((n) => n.title.toLowerCase())),
  };
  const byMind = {};
  for (const r of saved.results) {
    const s = score(r.notes_proposed ? JSON.stringify(r.notes_proposed) : '', ctx);
    const m = byMind[r.by] || (byMind[r.by] = { runs: 0, json: 0, notes: 0, links: 0, badLinks: 0, numbers: 0, unsourced: 0, seconds: 0 });
    m.runs += 1; m.json += s.json ? 1 : 0; m.notes += s.notes; m.links += s.links; m.badLinks += s.badLinks;
    m.numbers += s.numbers; m.unsourced += s.skillsWithoutSource; m.seconds += r.seconds;
  }
  console.log('=== Re-scored ===');
  for (const [by, m] of Object.entries(byMind)) {
    console.log(`${by.padEnd(28)} valid ${m.json}/${m.runs}  notes ${m.notes}  links ok/bad ${m.links}/${m.badLinks}  numbers ${m.numbers}  ` +
      `unsourced-skills ${m.unsourced}  avg ${Math.round(m.seconds / m.runs)}s`);
  }
}

main().catch((err) => {
  console.error(`bake-off failed: ${err.message}`);
  process.exit(1);
});
