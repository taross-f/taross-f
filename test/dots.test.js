import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRID, NOW, inGrid, segmentsTouch, findConnection, placeDot, replay,
} from '../src/dots.js';

const p = (x, y) => ({ x, y });

function play(moves) {
  let dots = [];
  for (const [x, y] of moves) {
    const r = placeDot(dots, p(x, y));
    assert.equal(r.ok, true, `(${x}, ${y}) should be placeable`);
    if (r.connected) return { connected: true, dots: r.dots };
    dots = r.dots;
  }
  return { connected: false, dots };
}

test('now sits just outside the playable grid, so nobody can place a dot on it', () => {
  assert.equal(inGrid(NOW), false);
  assert.ok(NOW.y >= GRID.Y_MIN && NOW.y <= GRID.Y_MAX);
});

test('the grid bounds are inclusive and integer only', () => {
  assert.equal(inGrid(p(GRID.X_MIN, GRID.Y_MIN)), true);
  assert.equal(inGrid(p(GRID.X_MAX, GRID.Y_MAX)), true);
  assert.equal(inGrid(p(GRID.X_MAX + 1, 1)), false);
  assert.equal(inGrid(p(1, GRID.Y_MIN - 1)), false);
  assert.equal(inGrid(p(1.5, 2)), false);
});

test('segmentsTouch covers crossing, touching, collinear overlap and misses', () => {
  assert.equal(segmentsTouch(p(0, 0), p(4, 4), p(0, 4), p(4, 0)), true, 'X crossing');
  assert.equal(segmentsTouch(p(0, 0), p(4, 0), p(2, 0), p(2, 3)), true, 'T touching');
  assert.equal(segmentsTouch(p(0, 0), p(4, 0), p(2, 0), p(6, 0)), true, 'collinear overlap');
  assert.equal(segmentsTouch(p(0, 0), p(2, 0), p(3, 0), p(6, 0)), false, 'collinear gap');
  assert.equal(segmentsTouch(p(0, 0), p(4, 0), p(0, 1), p(4, 1)), false, 'parallel');
  assert.equal(segmentsTouch(p(0, 0), p(4, 4), p(3, 0), p(5, 1)), false, 'near miss');
});

test('a line that never touches itself stays open', () => {
  const r = play([[1, 5], [3, 7], [6, 7], [9, 4]]);
  assert.equal(r.connected, false);
  assert.equal(r.dots.length, 4);
});

test('the shared joint with the previous segment is not a connection', () => {
  // A sharp turn back toward where the line came from, without overlapping it.
  const r = play([[4, 5], [1, 6]]);
  assert.equal(r.connected, false);
});

test('crossing an earlier segment connects the chapter', () => {
  const r = play([[3, 8], [6, 8], [6, 5], [2, 9]]);
  assert.equal(r.connected, true);
  assert.equal(r.dots.length, 4);
});

test('crossing the very first stretch out of now connects too', () => {
  const r = play([[2, 7], [3, 3], [1, 7]]);
  assert.equal(r.connected, true);
});

test('landing on an earlier dot connects', () => {
  const r = play([[2, 5], [4, 7], [6, 5], [4, 3], [2, 5]]);
  assert.equal(r.connected, true);
});

test('doubling back along the previous segment connects', () => {
  const r = play([[2, 5], [6, 5], [4, 5]]);
  assert.equal(r.connected, true);

  // Continuing straight on along the same line is not doubling back.
  assert.equal(play([[2, 5], [4, 5], [6, 5]]).connected, false);
});

test('a dot on the current end of the line is refused, not counted', () => {
  assert.deepEqual(placeDot([p(3, 3)], p(3, 3)), { ok: false, code: 'same_dot' });
  assert.deepEqual(placeDot([], p(0, 5)), { ok: false, code: 'off_grid' });
  assert.deepEqual(placeDot([], p(13, 5)), { ok: false, code: 'off_grid' });
});

test('placeDot does not mutate the chapter it is given', () => {
  const dots = [p(2, 5)];
  placeDot(dots, p(4, 6));
  assert.deepEqual(dots, [p(2, 5)]);
});

test('findConnection reports the earliest segment touched', () => {
  const path = [NOW, p(3, 5), p(3, 8), p(6, 8), p(6, 2)];
  // From (6, 2) to (1, 5) runs through the first segment, NOW -> (3, 5).
  assert.equal(findConnection(path, p(1, 5)), 0);
  assert.equal(findConnection(path, p(9, 2)), -1);
});

test('replay rebuilds the chapter and flags a log that no longer holds up', () => {
  const actions = [
    { issue: 1, user: 'a', x: 2, y: 7 },
    { issue: 2, user: 'b', x: 5, y: 8 },
  ];
  const ok = replay(actions);
  assert.equal(ok.consistent, true);
  assert.equal(ok.dots.length, 2);
  assert.equal(ok.dots[1].user, 'b');

  const broken = replay([...actions, { issue: 3, user: 'c', x: 5, y: 8 }]);
  assert.equal(broken.consistent, false);
  assert.equal(broken.dots.length, 2);

  assert.deepEqual(replay([]), { dots: [], consistent: true });
});
