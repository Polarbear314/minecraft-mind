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
const { createDecisionLog, summarizeAction, summarizeObservation, summarizeDrives } = require('./decisionLog');
const claudeStatus = require('../brain/claudeStatus');
const { isOverriding } = require('./reflexes');

const CLI_TIMEOUT_MS = 30000;
// Single acts that happen once, not courses of action to keep up for a while.
const ONE_SHOT = new Set(['dig', 'place', 'jump', 'use', 'equip', 'eat', 'craft', 'skill', 'stop']);
const ANSWER_FRESH_MS = 8000; // an answer older than this describes a world gone by
const HEALTH_CRITICAL = 8; // at/below this, survival overrides a held plan
const HOSTILE_CLOSE = 5; // blocks: a hostile this near is a real emergency

// A held plan (e.g. "approach GiantAxe619 to learn") should stand through a
// distant, non-threatening hostile — the old code let ANY nervous flee stomp
// it, so learning never survived a mob on the horizon. Only a genuine
// emergency breaks the hold: low health, or a hostile actually close.
function inDanger(observation) {
  const h = observation.nearestHostile;
  if (!h || h.distance == null) return false; // hurt and hungry with no foe near: the plan may be the cure
  if (h.distance <= HOSTILE_CLOSE) return true;
  // Weak, and a hostile is coming: survival first.
  return observation.health != null && observation.health <= HEALTH_CRITICAL && h.distance <= HOSTILE_CLOSE * 2;
}

// CLAUDE_BIN lets a machine point at a specific CLI binary (e.g. the full
// path to claude.exe on Windows) when `claude` isn't on PATH.
const CLAUDE_BIN = (process.env.CLAUDE_BIN || 'claude').trim();

function askClaudeCli(prompt, model, timeoutMs = CLI_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    // The prompt goes in on stdin, not as an argument: Windows caps a whole
    // command line at ~32K characters, and a vault-rich prompt can pass that.
    // `claude -p` with no prompt argument reads its prompt from stdin.
    const child = execFile(
      CLAUDE_BIN,
      ['-p', '--model', model],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        // Keep what the CLI said: a usage-limit message may be in either stream.
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
    );
    if (child.stdin) {
      child.stdin.on('error', () => {}); // CLI died early: the callback reports it
      child.stdin.end(prompt);
    }
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
 * opts.logDir: where to write the decision log (decisionLog.js); omit for none.
 */
function createClaudeCodeDecide({ model, vaultPath, minIntervalMs = 10000, holdMs = 6000, ask = askClaudeCli, logDir = null, onThink = null }) {
  const think = (stage, info) => { try { if (onThink) onThink(stage, info); } catch (_) { /* never */ } };
  let lastCall = 0;
  let busy = false;
  let pending = null; // { parsed, at, ctx } — an answer waiting to be applied
  let held = null; // { parsed, at } — the applied answer, standing for holdMs
  const log = createDecisionLog(logDir);

  // One line per consultation, written once its fate is known.
  function record(ctx, outcome, extra = {}) {
    log.record({
      ts: new Date(ctx.startedAt).toISOString(),
      model,
      latencyMs: ctx.latencyMs != null ? ctx.latencyMs : null,
      drives: ctx.drives,
      observation: ctx.observation,
      instinct: ctx.instinct, // what the rules would have done at the moment of asking
      prompt: ctx.prompt,
      raw: ctx.raw != null ? ctx.raw : null,
      parsed: ctx.parsed != null ? ctx.parsed : null,
      outcome, // applied | stale | invalid | failed | overridden
      ...extra,
    });
  }

  return async function claudeCodeDecide(drives, observation) {
    const instinct = ruleDecide(drives, observation);

    // 1. If an answer arrived since the last tick, apply it — unless the
    //    world has moved on since it was computed.
    if (pending) {
      const { parsed, at, ctx } = pending;
      pending = null;
      if (instinct.type === 'returnInside' || isOverriding(instinct, observation)) {
        record(ctx, 'overridden', { by: instinct.reflex || instinct.type }); // brainstem first
      } else if (Date.now() - at <= ANSWER_FRESH_MS) {
        try {
          const action = toAction(parsed, observation);
          action.source = 'claude';
          // Hold what Claude chose — but never its words or intention, which
          // must fire once, not once per tick. One-shot acts (dig below,
          // place above, jump...) are never held: repeating "dig below" every
          // tick would tunnel the body straight down.
          held = ONE_SHOT.has(action.type)
            ? null
            : { parsed: { action: parsed.action, thought: parsed.thought, target: parsed.target, at: parsed.at, item: parsed.item }, at: Date.now() };
          record(ctx, 'applied', { applied: summarizeAction(action) });
          return action;
        } catch (err) {
          console.error(`[claude-code] stale/invalid answer discarded: ${err.message}`);
          record(ctx, 'invalid', { error: err.message });
        }
      } else {
        record(ctx, 'stale');
      }
    }

    // 2. Time for a new consultation? Start it in the background.
    const now = Date.now();
    // While Claude is resting (usage limit), don't knock: instinct decides.
    if (!busy && now - lastCall >= minIntervalMs && !claudeStatus.isResting()) {
      busy = true;
      lastCall = now;
      const prompt = `${SYSTEM_PROMPT}\n\n${buildPrompt(vaultPath, drives, observation)}`;
      // Snapshot the moment of asking now: drives and the world keep changing.
      const ctx = {
        startedAt: now,
        prompt,
        drives: summarizeDrives(drives),
        observation: summarizeObservation(observation),
        instinct: summarizeAction(instinct),
      };
      think('asking', { model });
      ask(prompt, model)
        .then((text) => {
          ctx.latencyMs = Date.now() - now;
          ctx.raw = text;
          const start = text.indexOf('{');
          const end = text.lastIndexOf('}');
          if (start === -1 || end === -1) throw new Error('no JSON in CLI output');
          ctx.parsed = JSON.parse(text.slice(start, end + 1));
          claudeStatus.markAwake();
          pending = { parsed: ctx.parsed, at: Date.now(), ctx };
          think('answered', { model, latencyMs: ctx.latencyMs, action: ctx.parsed.action, thought: ctx.parsed.thought });
        })
        .catch((err) => {
          if (ctx.latencyMs == null) ctx.latencyMs = Date.now() - now;
          // The limit message may arrive as an error OR as a normal reply
          // with no JSON in it: check both.
          const seen = { message: err.message, stdout: ctx.raw || err.stdout, stderr: err.stderr };
          if (claudeStatus.looksLikeUsageLimit(seen)) claudeStatus.markResting(seen);
          console.error(`[claude-code] consultation failed (rules carried on): ${err.message}`);
          record(ctx, 'failed', { error: err.message });
        })
        .finally(() => {
          busy = false;
        });
    }

    // 3. Claude's last word stands for a few ticks — unless there's a real
    //    emergency (low health / a close hostile) or a hazard block to step
    //    away from. A distant hostile no longer stomps a held learning plan.
    if (held && now - held.at <= holdMs && !inDanger(observation) &&
      instinct.type !== 'avoid' && instinct.type !== 'returnInside' && !isOverriding(instinct, observation)) {
      try {
        const kept = toAction(held.parsed, observation); // re-validated against the fresh world
        kept.source = 'held';
        return kept;
      } catch (_) {
        held = null; // the held choice no longer fits the world
      }
    }

    // 4. Never stand still waiting for a thought: instinct acts now.
    instinct.source = 'instinct';
    return instinct;
  };
}

module.exports = { createClaudeCodeDecide, askClaudeCli, inDanger };
