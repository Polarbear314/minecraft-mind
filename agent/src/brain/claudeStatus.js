// Is Claude awake? When the Claude subscription hits its usage limit, every
// `claude -p` call fails until the limit resets. Rather than hammering a
// closed door, the brain marks Claude as RESTING and sends work elsewhere:
// dreams and watching go to the local model, decisions go to instinct.
//
// We don't know the CLI's exact limit wording (it is never guessed here):
// looksLikeUsageLimit() matches broadly, and the first time Claude goes to
// rest the raw message is printed so the real wording lands in the agent log.
// After REST_MS the next real call acts as the probe: success wakes Claude,
// another limit error sends it back to rest.
const REST_MS = 30 * 60 * 1000;

const LIMIT_PATTERNS = [
  /usage limit/i,
  /limit (?:reached|exceeded|hit)/i,
  /reached (?:your|the) (?:usage |session |weekly |daily )?limit/i,
  /rate[ -]?limit/i,
  /quota/i,
  /too many requests/i,
  /\b429\b/,
  /resets? (?:at|in|on)\b/i,
];

let restingUntil = 0;
let restCount = 0;
let lastReason = null;

/** Text of everything a failed CLI call left behind. */
function errorText(err) {
  if (!err) return '';
  return [err.message, err.stdout, err.stderr].filter(Boolean).map(String).join('\n');
}

function looksLikeUsageLimit(err) {
  const text = errorText(err);
  return LIMIT_PATTERNS.some((re) => re.test(text));
}

function isResting(now = Date.now()) {
  return now < restingUntil;
}

/** Put Claude to rest. Logs once per rest period, with the raw message. */
function markResting(err, now = Date.now()) {
  const wasResting = isResting(now);
  restingUntil = now + REST_MS;
  restCount += 1;
  lastReason = errorText(err).trim().slice(0, 500);
  if (!wasResting) {
    const until = new Date(restingUntil).toLocaleTimeString();
    console.log(`[brain] Claude is resting (usage limit) until ~${until}; background thinking goes local, decisions go to instinct.`);
    console.log(`[brain] Claude's message was: ${lastReason.replace(/\s+/g, ' ') || '(empty)'}`);
  }
}

/** A Claude call just succeeded: if it was resting, it's awake again. */
function markAwake() {
  if (restingUntil) {
    console.log('[brain] Claude is awake again.');
    restingUntil = 0;
  }
}

function status() {
  return { resting: isResting(), restingUntil, restCount, lastReason };
}

/** Sim/tests only. */
function _reset() {
  restingUntil = 0;
  restCount = 0;
  lastReason = null;
}

module.exports = { looksLikeUsageLimit, isResting, markResting, markAwake, status, errorText, _reset, REST_MS };
