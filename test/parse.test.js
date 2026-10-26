import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAction,
  extractIntegers,
  hasPlayLabel,
  formatUtc,
  X_MIN,
  X_MAX,
  Y_MIN,
  Y_MAX,
  COOLDOWN_MS,
} from '../src/parse.js';

const NOW = '2026-08-12T12:00:00.000Z';

function play(body, extra = {}) {
  return parseAction({
    body,
    labels: ['play'],
    user: 'octocat',
    now: NOW,
    ...extra,
  });
}

test('the accepted range is exactly the future grid', async () => {
  const { GRID } = await import('../src/dots.js');
  assert.deepEqual({ X_MIN, X_MAX, Y_MIN, Y_MAX }, GRID);
});

test('valid input is accepted and carries the coordinates through', () => {
  const r = play('7 3');
  assert.equal(r.ok, true);
  assert.equal(r.x, 7);
  assert.equal(r.y, 3);
  assert.equal(r.user, 'octocat');
  assert.equal(r.at, NOW);
});

test('all four corners of the grid are valid', () => {
  for (const [x, y] of [[X_MIN, Y_MIN], [X_MIN, Y_MAX], [X_MAX, Y_MIN], [X_MAX, Y_MAX]]) {
    const r = play(`${x} ${y}`);
    assert.equal(r.ok, true, `(${x}, ${y}) should be accepted`);
  }
});

test('just outside the grid is rejected with both ranges spelled out', () => {
  for (const body of [`${X_MIN - 1} 3`, `${X_MAX + 1} 3`, `5 ${Y_MIN - 1}`, `5 ${Y_MAX + 1}`, '-2 4']) {
    const r = play(body);
    assert.equal(r.ok, false, `${body} should be rejected`);
    assert.equal(r.code, 'out_of_range');
    assert.match(r.reply, new RegExp(`${X_MIN} to ${X_MAX}`));
    assert.match(r.reply, new RegExp(`${Y_MIN} to ${Y_MAX}`));
  }
});

test('bodies without two integers are rejected with instructions', () => {
  for (const body of ['', '   ', '\n\n', 'hello', 'ここに書きます', '_No response_', '7', null, undefined]) {
    const r = play(body);
    assert.equal(r.ok, false, `${JSON.stringify(body)} should be rejected`);
    assert.equal(r.code, 'no_coordinates');
    assert.ok(r.reply.length > 0);
  }
});

test('common ways of writing a point are all understood', () => {
  for (const body of ['7 3', '7,3', '(7, 3)', 'x=7 y=3', '７，３', '７ ３']) {
    const r = play(body);
    assert.equal(r.ok, true, `${body} should parse`);
    assert.deepEqual([r.x, r.y], [7, 3], body);
  }
});

test('the first two integers win when more are present', () => {
  const r = play('7 3 11');
  assert.deepEqual([r.x, r.y], [7, 3]);
});

test('field labels rendered by the issue form do not shadow the answer', () => {
  // GitHub renders an issue form as "### <label>" followed by the value. A digit
  // in a heading must never be mistaken for the player's input.
  const body = '### x (1–12)\n\n7\n\n### y (1–9)\n\n3\n';
  const r = play(body);
  assert.deepEqual([r.x, r.y], [7, 3]);
});

test('HTML comments are ignored', () => {
  const r = play('<!-- 99 99 template hint -->\n4 6');
  assert.deepEqual([r.x, r.y], [4, 6]);
});

test('issues without the play label are left completely alone', () => {
  const r = parseAction({ body: '7 3', labels: ['bug'], user: 'octocat', now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_a_play');
  assert.equal(r.reply, null, 'a normal issue must not get a reply');

  assert.equal(parseAction({ body: '7 3', labels: [], user: 'o', now: NOW }).code, 'not_a_play');
  assert.equal(parseAction({ body: '7 3', labels: null, user: 'o', now: NOW }).code, 'not_a_play');
});

test('label matching tolerates casing, padding, and label objects', () => {
  assert.equal(hasPlayLabel(['play']), true);
  assert.equal(hasPlayLabel([' Play ']), true);
  assert.equal(hasPlayLabel([{ name: 'play' }]), true);
  assert.equal(hasPlayLabel(['playground']), false);
  assert.equal(hasPlayLabel(['bug', 'play']), true);
  assert.equal(hasPlayLabel([null, undefined, 42]), false);
});

test('a second play inside the cooldown is refused and told when to come back', () => {
  const lastPlayedAt = '2026-08-12T11:55:00.000Z';
  const r = play('7 3', { lastPlayedAt });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rate_limited');
  assert.equal(r.retryAt, new Date(lastPlayedAt).getTime() + COOLDOWN_MS);
  assert.match(r.reply, /2026-08-12 12:05 UTC/);
});

test('the cooldown boundary is inclusive of the moment it expires', () => {
  const lastMs = new Date(NOW).getTime() - COOLDOWN_MS;
  assert.equal(play('7 3', { lastPlayedAt: new Date(lastMs).toISOString() }).ok, true);

  const justInside = new Date(lastMs + 1).toISOString();
  assert.equal(play('7 3', { lastPlayedAt: justInside }).ok, false);
});

test('a first-time player and unparseable history are not rate limited', () => {
  assert.equal(play('7 3', { lastPlayedAt: null }).ok, true);
  assert.equal(play('7 3', { lastPlayedAt: undefined }).ok, true);
  assert.equal(play('7 3', { lastPlayedAt: 'not a date' }).ok, true);
});

test('a timestamp in the future does not lock a player out', () => {
  const future = new Date(new Date(NOW).getTime() + 60 * 60 * 1000).toISOString();
  assert.equal(play('7 3', { lastPlayedAt: future }).ok, true);
});

test('validation runs before the cooldown, so a bad coordinate reports the real problem', () => {
  const r = play('99 3', { lastPlayedAt: NOW });
  assert.equal(r.code, 'out_of_range');
});

test('extractIntegers is usable on its own', () => {
  assert.deepEqual(extractIntegers('7 3'), [7, 3]);
  assert.deepEqual(extractIntegers('just 7'), [7]);
  assert.deepEqual(extractIntegers('nothing here'), []);
  assert.deepEqual(extractIntegers(42), []);
});

test('formatUtc renders a stable, minute-precision UTC stamp', () => {
  assert.equal(formatUtc(Date.parse('2026-01-05T03:07:00Z')), '2026-01-05 03:07 UTC');
});

test('parseAction has no observable side effects on its input', () => {
  const input = { body: '7 3', labels: ['play'], user: 'octocat', now: NOW, lastPlayedAt: null };
  const snapshot = JSON.stringify(input);
  parseAction(input);
  parseAction(input);
  assert.equal(JSON.stringify(input), snapshot);
});
