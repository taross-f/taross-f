import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAction,
  extractInteger,
  hasPlayLabel,
  formatUtc,
  X_MIN,
  X_MAX,
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

test('the accepted range is exactly the simulated platform', async () => {
  const { WORLD } = await import('../src/sim.js');
  assert.equal(X_MIN, WORLD.GROUND_LEFT);
  assert.equal(X_MAX, WORLD.GROUND_RIGHT);
});

test('valid input is accepted and carries the coordinate through', () => {
  const r = play('240');
  assert.equal(r.ok, true);
  assert.equal(r.x, 240);
  assert.equal(r.user, 'octocat');
  assert.equal(r.at, NOW);
});

test('both ends of the platform are valid', () => {
  assert.equal(play(String(X_MIN)).x, X_MIN);
  assert.equal(play(String(X_MAX)).x, X_MAX);
});

test('just outside either end is rejected with the range spelled out', () => {
  for (const value of [X_MIN - 1, X_MAX + 1, 0, 1000, -50]) {
    const r = play(String(value));
    assert.equal(r.ok, false, `${value} should be rejected`);
    assert.equal(r.code, 'out_of_range');
    assert.match(r.reply, new RegExp(String(X_MIN)));
    assert.match(r.reply, new RegExp(String(X_MAX)));
  }
});

test('non-numeric, empty, and whitespace bodies are rejected with instructions', () => {
  for (const body of ['', '   ', '\n\n', 'hello', 'ここに書きます', '_No response_', null, undefined]) {
    const r = play(body);
    assert.equal(r.ok, false, `${JSON.stringify(body)} should be rejected`);
    assert.equal(r.code, 'no_integer');
    assert.ok(r.reply.length > 0);
  }
});

test('full-width digits are normalised', () => {
  assert.equal(play('２４０').x, 240);
  assert.equal(play('ｘ＝２００').x, 200);
});

test('the first integer wins when several are present', () => {
  assert.equal(play('240 300 180').x, 240);
  assert.equal(play('x=190, or maybe 300').x, 190);
  // A decimal contributes its integer part first.
  assert.equal(play('240.75').x, 240);
});

test('field labels rendered by the issue form do not shadow the answer', () => {
  // GitHub renders an issue form as "### <label>" followed by the value. A digit
  // in a heading must never be mistaken for the player's input.
  const body = '### 投下する x 座標\n\n240\n';
  assert.equal(play(body).x, 240);

  const withRangeInHeading = '### x (140-340)\n\n300\n';
  assert.equal(play(withRangeInHeading).x, 300);
});

test('HTML comments are ignored', () => {
  assert.equal(play('<!-- 999 template hint -->\n220').x, 220);
});

test('a negative number is reported as out of range rather than silently signed away', () => {
  const r = play('-200');
  assert.equal(r.code, 'out_of_range');
  assert.equal(r.value, -200);
});

test('issues without the play label are left completely alone', () => {
  const r = parseAction({ body: '240', labels: ['bug'], user: 'octocat', now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_a_play');
  assert.equal(r.reply, null, 'a normal issue must not get a reply');

  assert.equal(parseAction({ body: '240', labels: [], user: 'o', now: NOW }).code, 'not_a_play');
  assert.equal(parseAction({ body: '240', labels: null, user: 'o', now: NOW }).code, 'not_a_play');
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
  const r = play('240', { lastPlayedAt });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rate_limited');
  assert.equal(r.retryAt, new Date(lastPlayedAt).getTime() + COOLDOWN_MS);
  assert.match(r.reply, /2026-08-12 12:05 UTC/);
});

test('the cooldown boundary is inclusive of the moment it expires', () => {
  const lastMs = new Date(NOW).getTime() - COOLDOWN_MS;
  assert.equal(play('240', { lastPlayedAt: new Date(lastMs).toISOString() }).ok, true);

  const justInside = new Date(lastMs + 1).toISOString();
  assert.equal(play('240', { lastPlayedAt: justInside }).ok, false);
});

test('a first-time player and unparseable history are not rate limited', () => {
  assert.equal(play('240', { lastPlayedAt: null }).ok, true);
  assert.equal(play('240', { lastPlayedAt: undefined }).ok, true);
  assert.equal(play('240', { lastPlayedAt: 'not a date' }).ok, true);
});

test('a timestamp in the future does not lock a player out', () => {
  const future = new Date(new Date(NOW).getTime() + 60 * 60 * 1000).toISOString();
  assert.equal(play('240', { lastPlayedAt: future }).ok, true);
});

test('validation runs before the cooldown, so a bad coordinate reports the real problem', () => {
  const r = play('9999', { lastPlayedAt: NOW });
  assert.equal(r.code, 'out_of_range');
});

test('extractInteger is usable on its own', () => {
  assert.equal(extractInteger('240'), 240);
  assert.equal(extractInteger('nothing here'), null);
  assert.equal(extractInteger(''), null);
  assert.equal(extractInteger(42), null);
});

test('formatUtc renders a stable, minute-precision UTC stamp', () => {
  assert.equal(formatUtc(Date.parse('2026-01-05T03:07:00Z')), '2026-01-05 03:07 UTC');
});

test('parseAction has no observable side effects on its input', () => {
  const input = { body: '240', labels: ['play'], user: 'octocat', now: NOW, lastPlayedAt: null };
  const snapshot = JSON.stringify(input);
  parseAction(input);
  parseAction(input);
  assert.equal(JSON.stringify(input), snapshot);
});
