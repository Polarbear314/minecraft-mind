// Claude decision layer WITHOUT an API key: shells out to the Claude Code CLI
// (`claude -p`), which authenticates with a normal Claude account login — the
// user's existing subscription, no key required. Setup:
//
//   npm install -g @anthropic-ai/claude-code
//   claude          (once, to log in via browser)
//
// NON-BLOCKING BY DESIGN: the CLI takes seconds per call, and awaiting it
// used to freeze the whole tick loop — the bot literally stood still while
// thinking, which is how it once died mid-consultation. Now the consultation
// runs in the background: the tick that starts it acts on instinct rules
// immediately (the body keeps moving), and Claude's answer is applied on the
// next tick after it arrives — if it is still fresh. Consultations start at
// most once per minIntervalMs; every failure falls back to rules.
const { execFile } = require('child_process');
const { buildPrompt, toAction, SYSTEM_PROMPT } = require('./llmDecide');
const { decide: ruleDecide } = require('./decide');

const CLI_TIMEOUT_MS = 30000;
const ANSWER_FRESH_MS = 8000; // an answer older than this describes a world gone by
const HEALTH_CRITICAL = 8; // at/below this, survival overrides a held plan
const HOSTILE_CLOSE = 5; // blocks: a hostile this near is a real emergency

// A held plan (e.g. "approach GiantAxe619 to learn") should stand through a
// distant, non-threatening hostile — the old code let ANY nervous flee stomp
// it, so learning never survived a mob on the horizon. Only a genuine
// emergency breaks the hold: low health, or a hostile actually close.
function inDanger(observation) {
  if (observation.health != null && observation.health <= HEALTH_CRITICAL) return true;
  const h = observation.nearestHostile;
  return !!(h && h.distance != null && h.distance <= HOSTILE_CLOSE);
}

function askClaudeCli(prompt, model, timeoutMs = CLI_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      ['-p', prompt, '--model', model],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
    if (child.stdin) child.stdin.end(); // CLI otherwise waits ~3s for piped stdin
  });
}

/**
 * Factory: returns an async decide(drives, observation) that starts a Claude
 * consultation at most once per minIntervalMs and NEVER waits for it — rules
 * act in the meantime, and Claude's answer takes effect on the tick after it
 * lands (validated against that tick's fresh observation by toAction).
 *
 * HOLD: once applied, Claude's chosen action STANDS for holdMs (~4 ticks)
 * instead of being stomped by instinct 1.5s later — rules used to override
 * "explore toward the village" with a hungry seekFood on the very next tick,
 * so Claude's will lasted exactly one tick. Survival reflexes (flee/avoid)
 * always break through the hold; say/intention fire only on first application
 * (a held sentence must not be repeated into chat every tick).
 *
 * opts.ask: CLI replacement for the sim; opts.holdMs: hold duration override.
 */
function createClaudeCodeDecide({ model, vaultPath, minIntervalMs = 10000, holdMs = 6000, ask = askClaudeCli }) {
  let lastCall = 0;
  let busy = false;
  let pending = null; // { parsed, at } — an answer waiting to be applied
  let held = null; // { parsed, at } — the applied answer, standing for holdMs

  return async function claudeCodeDecide(drives, observation) {
    const instinct = ruleDecide(drives, observation);

    // 1. If an answer arrived since the last tick, apply it — unless the
    //    world has moved on since it was computed.
    if (pending) {
      const { parsed, at } = pending;
      pending = null;
      if (Date.now() - at <= ANSWER_FRESH_MS) {
        try {
          const action = toAction(parsed, observation);
          // Hold what Claude chose — but never its words or intention, which
          // must fire once, not once per tick.
          held = { parsed: { action: parsed.action, thought: parsed.thought, target: parsed.target }, at: Date.now() };
          return action;
        } catch (err) {
          console.error(`[claude-code] stale/invalid answer discarded: ${err.message}`);
        }
      }
    }

    // 2. Time for a new consultation? Start it in the background.
    const now = Date.now();
    if (!busy && now - lastCall >= minIntervalMs) {
      busy = true;
      lastCall = now;
      const prompt = `${SYSTEM_PROMPT}\n\n${buildPrompt(vaultPath, drives, observation)}`;
      ask(prompt, model)
        .then((text) => {
          const start = text.indexOf('{');
          const end = text.lastIndexOf('}');
          if (start === -1 || end === -1) throw new Error('no JSON in CLI output');
          pending = { parsed: JSON.parse(text.slice(start, end + 1)), at: Date.now() };
        })
        .catch((err) => {
          console.error(`[claude-code] consultation failed (rules carried on): ${err.message}`);
        })
        .finally(() => {
          busy = false;
        });
    }

    // 3. Claude's last word stands for a few ticks — unless there's a real
    //    emergency (low health / a close hostile) or a hazard block to step
    //    away from. A distant hostile no longer stomps a held learning plan.
    if (held && now - held.at <= holdMs && !inDanger(observation) && instinct.type !== 'avoid') {
      try {
        return toAction(held.parsed, observation); // re-validated against the fresh world
      } catch (_) {
        held = null; // the held choice no longer fits the world
      }
    }

    // 4. Never stand still waiting for a thought: instinct acts now.
    return instinct;
  };
}

module.exports = { createClaudeCodeDecide, askClaudeCli };
