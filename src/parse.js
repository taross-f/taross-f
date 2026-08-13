/**
 * Issue body -> action, or a rejection carrying the reply to post back.
 *
 * Everything here is a pure function of its arguments so the rules can be
 * exercised directly from tests without a GitHub event anywhere in sight.
 */

import { X_MIN as PLATFORM_MIN, X_MAX as PLATFORM_MAX } from './sim.js';

export const PLAY_LABEL = 'play';
// The accepted input range *is* the platform, so it is taken from the simulator
// rather than restated here. Restating it would let the two drift apart and
// start accepting coordinates with no ground under them.
export const X_MIN = PLATFORM_MIN;
export const X_MAX = PLATFORM_MAX;
export const COOLDOWN_MS = 10 * 60 * 1000;

/** UTC, minute precision - enough for a "come back at" hint. */
export function formatUtc(msOrDate) {
  const d = msOrDate instanceof Date ? msOrDate : new Date(msOrDate);
  const p = (v, len = 2) => String(v).padStart(len, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** Does this issue carry the label that opts it into the game? */
export function hasPlayLabel(labels) {
  if (!Array.isArray(labels)) return false;
  return labels.some((l) => {
    const name = typeof l === 'string' ? l : (l && l.name);
    return typeof name === 'string' && name.trim().toLowerCase() === PLAY_LABEL;
  });
}

/**
 * Pull the first integer out of an issue body.
 *
 * The issue form renders as `### <label>` followed by the value, so heading
 * lines are dropped first - otherwise any digit in a field label would be
 * picked up ahead of the player's actual answer.
 *
 * @returns {number|null}
 */
export function extractInteger(body) {
  if (typeof body !== 'string') return null;

  // NFKC folds full-width digits onto ASCII, so "２４０" is accepted.
  const text = body.normalize('NFKC')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join('\n');

  const match = text.match(/-?\d+/);
  if (!match) return null;

  const value = Number.parseInt(match[0], 10);
  return Number.isFinite(value) ? value : null;
}

const REPLY = {
  noInteger: [
    '座標を読み取れませんでした。',
    '',
    `本文に落としたい x 座標を **${X_MIN} から ${X_MAX} までの整数** で 1 つだけ書いてください。`,
    '',
    'Could not find a coordinate in this issue. Open a new one with a single '
      + `integer between ${X_MIN} and ${X_MAX}.`,
  ].join('\n'),
};

function outOfRangeReply(value) {
  return [
    `\`${value}\` は範囲外です。`,
    '',
    `有効な範囲は **${X_MIN} 〜 ${X_MAX}** です。土台はこの範囲にしかありません。`,
    '',
    `\`${value}\` is outside the platform. Valid range is ${X_MIN} to ${X_MAX}.`,
  ].join('\n');
}

function rateLimitedReply(retryAtMs) {
  const when = formatUtc(retryAtMs);
  return [
    '連投はできません。',
    '',
    `次に打てるのは **${when}** からです。`,
    '',
    `One drop per player every 10 minutes. You can play again at ${when}.`,
  ].join('\n');
}

/**
 * Validate one play.
 *
 * @param {object} input
 * @param {string} input.body        raw issue body
 * @param {Array}  input.labels      label names (or label objects)
 * @param {string} input.user        author login
 * @param {number|string|Date} input.now
 * @param {string|null} [input.lastPlayedAt] when this user last played
 * @returns {{ok:true,x:number}|{ok:false,code:string,reply:string|null}}
 */
export function parseAction(input) {
  const { body, labels, user, now, lastPlayedAt = null } = input;

  // Not a play issue at all: stay out of the way entirely.
  if (!hasPlayLabel(labels)) {
    return { ok: false, code: 'not_a_play', reply: null };
  }

  const value = extractInteger(body);
  if (value === null) {
    return { ok: false, code: 'no_integer', reply: REPLY.noInteger };
  }

  if (value < X_MIN || value > X_MAX) {
    return { ok: false, code: 'out_of_range', reply: outOfRangeReply(value), value };
  }

  const nowMs = new Date(now).getTime();
  if (lastPlayedAt) {
    const lastMs = new Date(lastPlayedAt).getTime();
    if (Number.isFinite(lastMs) && Number.isFinite(nowMs)) {
      const elapsed = nowMs - lastMs;
      // A clock that went backwards should not hand out free turns, but it also
      // should not lock anyone out forever; only a genuine recent play blocks.
      if (elapsed >= 0 && elapsed < COOLDOWN_MS) {
        const retryAt = lastMs + COOLDOWN_MS;
        return { ok: false, code: 'rate_limited', reply: rateLimitedReply(retryAt), retryAt };
      }
    }
  }

  return { ok: true, x: value, user, at: new Date(nowMs).toISOString() };
}
