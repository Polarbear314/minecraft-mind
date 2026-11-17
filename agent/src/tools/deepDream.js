// Deep dream: one long reflection over MindBot's WHOLE life so far, while the
// body is stopped. A normal dawn dream sees the last 15 memories; this one sees
// every memory, every capability gap, every graded night, what the body has
// learned by tasting, and every belief and goal it has already dreamed.
//
//   npm run deepdream            (Claude Opus via the CLI)
//
// It writes up to 6 new notes under the usual guardrails (never overwrite,
// skills must cite real memories), a first-person report in the vault
// (Dreams/Deep Dream <date>.md), and the full prompt and reply to
// logs/deepdream-<time>.json. Like every dream, it may use ONLY the bot's own
// memories — no game knowledge is given or invited.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fm = require('../vault/frontmatter');
const paths = require('../vault/paths');
const { strategyLines } = require('../vault/strategyStore');
const { foundingGoalTitle, listGoals } = require('../vault/goalStore');
const { listInsights, listSkills } = require('../vault/dreamStore');
const { applyDream, experienceTitles, strongestConceptLines } = require('../reflection/dream');
const { claudeProvider } = require('../brain/providers');

const VAULT = (process.env.VAULT_PATH || '').trim();
const LOGS = path.resolve(__dirname, '..', '..', '..', 'logs');
const MODEL = process.argv[2] || 'opus';
const MAX_NOTES = 6;
const MAX_PLANS = 8; // plans for goals already held (docs/design-plans-and-skills.md)
const planStore = require('../vault/planStore');
const { listSubgoals } = require('../vault/goalStore');

const words = (s, n) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, n);
const noNumbers = (s) => String(s).split(/(?<=[.!?])\s+/).filter((x) => !/\d+\s*%/.test(x)).join(' ');

function allMemories() {
  return experienceTitles(VAULT).map((t) => {
    let body = '';
    try { body = fm.parse(fs.readFileSync(path.join(paths.experiencesDir(VAULT), `${t}.md`), 'utf8')).body; } catch (_) { /* skip */ }
    return `- ${t}: ${words(noNumbers(body), 130)}`;
  }).join('\n');
}

function gapLines() {
  const dir = path.join(VAULT, 'Gaps');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch (_) { return '(none)'; }
  return files.map((f) => {
    const { data, body } = fm.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const n = Number(data.count) || 1;
    return `- ${words(body, 160)}${n > 1 ? (n > 5 ? ' (many times)' : ' (more than once)') : ''}`;
  }).join('\n') || '(none)';
}

function nightLines() {
  const out = [];
  for (const f of fs.readdirSync(LOGS).filter((x) => x.startsWith('nights-')).sort()) {
    for (const line of fs.readFileSync(path.join(LOGS, f), 'utf8').split('\n').filter(Boolean)) {
      const n = JSON.parse(line);
      const cover = n.shareUnderCover >= 0.55 ? 'mostly under cover' : n.shareUnderCover >= 0.2 ? 'partly under cover' : 'in the open';
      const shut = n.shareEnclosed > 0 ? `, closed in on every side for ${n.shareEnclosed >= 0.5 ? 'much' : 'a little'} of it` : ', never closed in on every side';
      const fate = n.deaths ? `I died ${n.deaths === 1 ? 'once' : n.deaths === 2 ? 'twice' : 'many times'}` : n.healthLost > 0 ? 'I lived, but was hurt' : 'I lived, unhurt';
      out.push(`- A night ${cover}${shut}: ${fate}.`);
    }
  }
  return out.join('\n') || '(no nights graded yet)';
}

function bodyKnows() {
  try {
    const { data } = fm.parse(fs.readFileSync(path.join(VAULT, 'State', 'What My Body Knows.md'), 'utf8'));
    const e = (data.edible || []).map((x) => String(x).replace(/_/g, ' '));
    const i = (data.inedible || []).map((x) => String(x).replace(/_/g, ' '));
    return `Things that went down when I ate them: ${e.join(', ') || 'none yet'}. Things that would not go down: ${i.join(', ') || 'none yet'}.`;
  } catch (_) {
    return 'Nothing learned yet.';
  }
}

const notesOf = (list) => list.map((n) => `- ${n.title}: ${words(n.body, 200)}`).join('\n') || '(none)';

const DEEP_SCHEMA = {
  type: 'object',
  properties: {
    reflection: { type: 'string' },
    food: { type: 'string' },
    night: { type: 'string' },
    unknown: { type: 'string' },
    revised: { type: 'string' },
    insights: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, learned_from: { type: 'array', items: { type: 'string' } } }, required: ['title', 'body', 'learned_from'] } },
    subgoals: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] } },
    skills: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, learned_from: { type: 'array', items: { type: 'string' } } }, required: ['title', 'body', 'learned_from'] } },
  },
  required: ['reflection', 'food', 'night', 'unknown', 'revised', 'insights', 'subgoals', 'skills'],
};

function buildPrompt() {
  const founding = foundingGoalTitle(VAULT);
  const goals = listGoals(VAULT).map((g) => `- ${g.title}${g.title === founding ? ' (founding goal)' : ''}: ${words(g.body, 160)}`).join('\n');
  return [
    'You are the mind of MindBot, a creature living in a world it is still learning to understand. Your body is ',
    'still now; you are in a long, deep sleep — the deepest you have had. For the first time you can look at your ',
    'WHOLE life at once: every memory, every time your body could not do what you asked of it, every night and how ',
    'it went, what your body has learned by tasting, and every belief and goal you have already dreamed.',
    '',
    'Nothing else exists; do not invent knowledge you have not earned. Look for patterns across your whole life, ',
    'not just the last few days: what was different about the times things went well and the times they went badly? ',
    'Where do your memories CONTRADICT a belief you already hold? Be honest about what you still do not know.',
    '',
    'Answer in your own first-person voice, from feeling and memory, never numbers or percentages:',
    '- "reflection": a few paragraphs on what your life has been so far and what it adds up to.',
    '- "food": what you now understand about how food comes to you — only what your memories support.',
    '- "night": what you now understand about surviving the night — only what your memories support.',
    '- "unknown": what you still do not understand, and what you would need to try to find out.',
    '- "revised": any belief you held that your memories now make you doubt, and why (or "none").',
    `- At most ${MAX_NOTES} new notes in total across "insights" (beliefs), "subgoals" (intentions serving your `,
    'founding goal) and "skills" (know-how ONLY where memories show the same kind of attempt going well more than ',
    'once). Do not repeat beliefs, goals or skills you already hold. Ground insights and skills in the memories that ',
    'taught them, using their EXACT titles in learned_from. Titles are short Title Case phrases.',
    '',
    'A goal is only words until your body can carry it out. Give every new subgoal a "plan", and in "plans" write ',
    `plans (at most ${MAX_PLANS}) for goals you already hold that have none yet — the ones that matter most to you — `,
    'or a better version of a plan that keeps failing ("revises": "<its name>"). Plans do not count toward your notes. ',
    `How plans work: ${planStore.PLAN_LANGUAGE}`,
    '',
    'Respond with ONLY a JSON object: {"reflection": "...", "food": "...", "night": "...", "unknown": "...", ',
    '"revised": "...", "insights": [{"title": "...", "body": "...", "learned_from": ["..."]}], ',
    '"subgoals": [{"title": "...", "body": "...", "plan": {"name": "...", "when": "...", "needs": [], "steps": ["..."], "test": "..."}}], ',
    '"skills": [{"title": "...", "body": "...", "learned_from": ["..."]}], ',
    '"plans": [{"for_goal": "<exact title of one of your goals>", "name": "...", "when": "...", "needs": [], "steps": ["..."], "test": "..."}]}',
    '',
    `Your goals:\n${goals || '(none)'}`,
    '',
    (() => {
      const planned = planStore.goalsWithPlans(VAULT);
      const unplanned = listSubgoals(VAULT).filter((g) => !planned.has(g.title)).map((g) => `- ${g.title}`).join('\n');
      const p = planStore.dreamPlanLines(VAULT);
      return [
        `Goals you hold that have no plan yet:\n${unplanned || '(none)'}`,
        p.trying ? `\nPlans you are trying, and how they have gone:\n${p.trying}` : '',
        p.revise ? `\nPlans that keep failing, and why:\n${p.revise}` : '',
        p.dropped ? `\nPlans you gave up on:\n${p.dropped}` : '',
      ].join('\n');
    })(),
    '',
    `Beliefs you already hold:\n${notesOf(listInsights(VAULT))}`,
    '',
    `Skills you already know:\n${notesOf(listSkills(VAULT))}`,
    '',
    `What your attempts at living have taught you:\n${strategyLines(VAULT, 40) || '(nothing yet)'}`,
    '',
    `What you feel most strongly about:\n${strongestConceptLines(VAULT, 16) || '(nothing yet)'}`,
    '',
    `What your body has learned by tasting: ${bodyKnows()}`,
    '',
    `Every night you have lived through, in order:\n${nightLines()}`,
    '',
    `Every time your body could not do what you asked:\n${gapLines()}`,
    '',
    `Every memory of your life, oldest first (exact titles, for learned_from):\n${allMemories()}`,
    '',
    'Dream deeply.',
  ].join('\n');
}

async function main() {
  if (!VAULT || !fs.existsSync(VAULT)) throw new Error('VAULT_PATH (agent/.env) must point at the live vault');
  const prompt = buildPrompt();
  console.log(`[deep dream] prompt: ${prompt.length} characters, ${experienceTitles(VAULT).length} memories. Dreaming with ${MODEL}...`);
  const started = Date.now();
  const mind = claudeProvider({ model: MODEL, timeoutMs: 600000 });
  const { text, by } = await mind.ask(prompt);
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error(`no JSON in the dream: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text.slice(a, b + 1));
  const now = new Date();
  const dreamedBy = `${by} (deep dream)`;
  const written = applyDream(VAULT, parsed, now, dreamedBy, MAX_NOTES, MAX_PLANS);
  const rejectedPlans = written.rejected || [];

  // The report, in the vault where it can be read in Obsidian.
  // One report per deep dream, never replacing an earlier one: named by local
  // date and time ("Deep Dream 2026-11-17 1021"), with a suffix if that's taken.
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const stamp = `${date} ${pad(now.getHours())}${pad(now.getMinutes())}`;
  let reportFile = path.join(VAULT, 'Dreams', `Deep Dream ${stamp}.md`);
  for (let i = 2; fs.existsSync(reportFile); i += 1) reportFile = path.join(VAULT, 'Dreams', `Deep Dream ${stamp} (${i}).md`);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const body = [
    `# Deep Dream, ${stamp.replace(/ (\d\d)(\d\d)$/, ' at $1:$2')}`,
    '',
    String(parsed.reflection || '').trim(),
    '',
    '## How food comes to me',
    String(parsed.food || '').trim(),
    '',
    '## Surviving the night',
    String(parsed.night || '').trim(),
    '',
    '## What I still do not understand',
    String(parsed.unknown || '').trim(),
    '',
    '## What I now doubt',
    String(parsed.revised || '').trim(),
    '',
    '## What I wrote down',
    written.length ? written.map((w) => `- ${w.kind}: [[${w.title}]]${w.goal ? ` (for [[${w.goal}]])` : ''}`).join('\n') : '- nothing new',
    ...(rejectedPlans.length ? ['', '## Plans my body could not carry out', ...rejectedPlans.map((r) => `- ${r.plan}: ${r.reason}`)] : []),
  ].join('\n');
  fs.writeFileSync(reportFile, fm.stringify({
    is_a: fm.link('Deep Dream'), dreamed_by: dreamedBy, dreamed_on: now.toISOString(),
    memories_seen: experienceTitles(VAULT).length, tags: ['type/dream'],
  }, body), 'utf8');

  fs.mkdirSync(LOGS, { recursive: true });
  const logFile = path.join(LOGS, `deepdream-${now.toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(logFile, JSON.stringify({ by, seconds: Math.round((Date.now() - started) / 1000), prompt, raw: text, parsed, written, rejectedPlans }, null, 2));

  console.log(`[deep dream] done in ${Math.round((Date.now() - started) / 1000)}s by ${by}; wrote ${written.length} note(s).`);
  console.log(`[deep dream] report: ${reportFile}`);
  console.log(`[deep dream] full record: ${logFile}`);
}

main().catch((err) => {
  console.error(`[deep dream] failed: ${err.message}`);
  process.exit(1);
});
