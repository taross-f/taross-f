/**
 * Issue body -> action, or a rejection carrying the reply to post back.
 *
 * Everything here is a pure function of its arguments so the rules can be
 * exercised directly from tests without a GitHub event anywhere in sight.
 */

import { GRID } from './dots.js';

export const PLAY_LABEL = 'play';
// The accepted input range *is* the future grid, so it is taken from the game
// rather than restated here. Restating it would let the two drift apart and
// start accepting dots that cannot be drawn.
export const { X_MIN, X_MAX, Y_MIN, Y_MAX } = GRID;
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
 * Pull the first two integers out of an issue body.
 *
 * The issue form renders as `### <label>` followed by the value, so heading
 * lines are dropped first - otherwise any digit in a field label would be
 * picked up ahead of the player's actual answer.
 *
 * @returns {number[]} zero, one or two integers
 */
export function extractIntegers(body) {
  if (typeof body !== 'string') return [];

  // NFKC folds full-width digits and commas onto ASCII, so "７，３" is accepted.
  const text = body.normalize('NFKC')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join('\n');

  return [...text.matchAll(/-?\d+/g)]
    .slice(0, 2)
    .map((m) => Number.parseInt(m[0], 10))
    .filter(Number.isFinite);
}

const REPLY = {
  noCoordinates: [
    'No dot found in this issue.',
    '',
    `Open a new one with **two integers**: x (${X_MIN}–${X_MAX}) and y (${Y_MIN}–${Y_MAX}), `
      + 'for example `7 3`.',
    '',
    `点の位置を読み取れませんでした。本文に **x (${X_MIN}〜${X_MAX}) と y (${Y_MIN}〜${Y_MAX}) の`
      + '整数 2 つ** を書いてください。例: `7 3`',
  ].join('\n'),
};

function offGridReply(x, y) {
  return [
    `\`(${x}, ${y})\` is off the grid.`,
    '',
    `x runs from **${X_MIN} to ${X_MAX}** and y from **${Y_MIN} to ${Y_MAX}**.`,
    '',
    `\`(${x}, ${y})\` は盤面の外です。x は ${X_MIN} 〜 ${X_MAX}、y は ${Y_MIN} 〜 ${Y_MAX} です。`,
  ].join('\n');
}

function rateLimitedReply(retryAtMs) {
  const when = formatUtc(retryAtMs);
  return [
    'One dot per player every 10 minutes.',
    '',
    `You can play again at **${when}**.`,
    '',
    `連投はできません。次に打てるのは ${when} からです。`,
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
 * @returns {{ok:true,x:number,y:number}|{ok:false,code:string,reply:string|null}}
 */
export function parseAction(input) {
  const { body, labels, user, now, lastPlayedAt = null } = input;

  // Not a play issue at all: stay out of the way entirely.
  if (!hasPlayLabel(labels)) {
    return { ok: false, code: 'not_a_play', reply: null };
  }

  const values = extractIntegers(body);
  if (values.length < 2) {
    return { ok: false, code: 'no_coordinates', reply: REPLY.noCoordinates };
  }

  const [x, y] = values;
  if (x < X_MIN || x > X_MAX || y < Y_MIN || y > Y_MAX) {
    return { ok: false, code: 'out_of_range', reply: offGridReply(x, y), x, y };
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

  return { ok: true, x, y, user, at: new Date(nowMs).toISOString() };
}
