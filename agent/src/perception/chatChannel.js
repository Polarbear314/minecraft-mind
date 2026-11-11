// The ears (and the door to the voice): buffers words spoken in the world's
// chat so the tick loop can treat them as perception. Words from Henry (or
// anyone) are GUIDANCE, not commands — they reach the agent's mind the same
// way everything else does: as experiences it must weigh for itself.
//
// Two views of the same stream:
//   drain()      -> messages new since the last tick (for vault bookkeeping)
//   promptLines() -> the last few messages, however old, formatted for the
//                    decision prompt (standing words linger until newer ones
//                    push them out — wisdom shouldn't evaporate in 10 seconds)
const MAX_MESSAGE_LENGTH = 300;
const MAX_REMEMBERED = 6;

/** '3 minutes ago' / 'just now' — coarse on purpose; the mind doesn't wear a watch. */
function agoLabel(at, now) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 30) return 'just now';
  if (s < 90) return 'a minute ago';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  const h = Math.round(s / 3600);
  return h === 1 ? 'an hour ago' : `${h} hours ago`;
}

/**
 * Factory. selfName: the bot's own username (its own speech must not echo
 * back into its ears as someone else's words).
 */
function createChatChannel({ selfName, maxRemembered = MAX_REMEMBERED } = {}) {
  const remembered = []; // [{ username, message, at }] — rolling window
  let fresh = [];        // new since the last drain()

  function hear(username, message, at = Date.now()) {
    if (!username || username === selfName) return;
    const clean = String(message || '').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!clean) return;
    const entry = { username: String(username), message: clean, at };
    fresh.push(entry);
    remembered.push(entry);
    while (remembered.length > maxRemembered) remembered.shift();
  }

  /** Messages heard since the last drain (the tick's bookkeeping reads these once). */
  function drain() {
    const out = fresh;
    fresh = [];
    return out;
  }

  /** Prompt-ready lines for the last few things said, or null if silence so far. */
  function promptLines(now = Date.now()) {
    if (!remembered.length) return null;
    return remembered
      .map((m) => `- ${agoLabel(m.at, now)}, ${m.username} said: "${m.message}"`)
      .join('\n');
  }

  return { hear, drain, promptLines };
}

module.exports = { createChatChannel, MAX_MESSAGE_LENGTH };
