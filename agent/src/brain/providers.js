// Minds the brain can think with. Every provider has the same shape:
//
//   provider.ask(prompt, opts?) -> Promise<{ text, by }>
//
// where `by` says which mind actually answered ("claude:opus",
// "local:qwen3:14b"), so dreams can carry provenance and logs can compare.
//
//   claude — the `claude -p` CLI on the user's subscription.
//   local  — an open-source model served by Ollama on this PC (free).
//   auto   — Claude first; if Claude is resting (usage limit), or this call
//            hits the limit, the fallback answers instead.
const claudeStatus = require('./claudeStatus');

/** Lazily required: claudeCodeDecide requires this module's siblings. */
function cli() {
  return require('../decision/claudeCodeDecide').askClaudeCli;
}

function claudeProvider({ model, timeoutMs = 60000, ask } = {}) {
  const by = `claude:${model}`;
  return {
    by,
    async ask(prompt) {
      if (claudeStatus.isResting()) {
        const err = new Error('Claude is resting (usage limit)');
        err.resting = true;
        throw err;
      }
      try {
        const text = await (ask || cli())(prompt, model, timeoutMs);
        // A limit message can come back as a normal reply (no JSON in it).
        if (!String(text).includes('{') && claudeStatus.looksLikeUsageLimit({ stdout: text })) {
          const err = new Error('Claude replied with a usage-limit message');
          err.stdout = text;
          throw err;
        }
        claudeStatus.markAwake();
        return { text, by };
      } catch (err) {
        if (claudeStatus.looksLikeUsageLimit(err)) {
          claudeStatus.markResting(err);
          err.resting = true;
        }
        throw err;
      }
    },
  };
}

/**
 * Ollama chat call. opts.schema (a JSON Schema object) constrains the reply to
 * valid JSON of that shape — the single biggest help for a small model.
 */
function localProvider({
  model, host = 'http://127.0.0.1:11434', timeoutMs = 180000, temperature = 0.4,
  numCtx = 8192, think, fetchImpl, keepAlive = '30m',
} = {}) {
  const by = `local:${model}`;
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  return {
    by,
    async ask(prompt, opts = {}) {
      const body = {
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        keep_alive: keepAlive, // always-on regions call every few seconds: stay loaded
        options: { temperature: opts.temperature != null ? opts.temperature : temperature, num_ctx: numCtx },
      };
      if (opts.schema) body.format = opts.schema;
      else if (opts.json) body.format = 'json';
      if (think !== undefined) body.think = think;
      const res = await doFetch(`${host.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`local model ${model}: HTTP ${res.status} ${detail.slice(0, 200)}`);
      }
      const data = await res.json();
      const text = data && data.message && typeof data.message.content === 'string' ? data.message.content : '';
      if (!text.trim()) throw new Error(`local model ${model}: empty reply`);
      return { text, by };
    },
  };
}

/**
 * Claude first, fallback second. Any Claude failure falls through to the
 * fallback (a timeout is no reason to lose a dream); only usage-limit errors
 * put Claude to rest (claudeProvider handles that).
 */
function autoProvider({ primary, fallback }) {
  if (!fallback) return primary;
  return {
    by: `${primary.by}|${fallback.by}`,
    async ask(prompt, opts = {}) {
      if (!claudeStatus.isResting()) {
        try {
          return await primary.ask(prompt, opts);
        } catch (err) {
          if (!err.resting) console.error(`[brain] ${primary.by} failed, using ${fallback.by}: ${err.message}`);
        }
      }
      return fallback.ask(prompt, opts);
    },
  };
}

/** Adapter for older code that wants ask(prompt) -> text. */
function textAsk(provider, opts) {
  return async (prompt) => (await provider.ask(prompt, opts)).text;
}

module.exports = { claudeProvider, localProvider, autoProvider, textAsk };
