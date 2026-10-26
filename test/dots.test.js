import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRID, REACH, inGrid, linked, findPath, linksAmong, componentOf, placeDot, replay,
} from '../src/dots.js';

const p = (x, y) => ({ x, y });

/** Place moves one by one, stopping at the first that connects. */
function play(moves) {
  let dots = [];
  for (const [x, y] of moves) {
    const r = placeDot(dots, p(x, y));
    assert.equal(r.ok, true, `(${x}, ${y}) should be placeable`);
    dots = r.dots;
    if (r.path) return { path: r.path, dots };
  }
  return { path: null, dots };
}

/** A straight chain along row y, every REACH columns, ending on the right edge. */
function chain(y) {
  const moves = [];
  for (let x = GRID.X_MIN; x < GRID.X_MAX; x += REACH) moves.push([x, y]);
  moves.push([GRID.X_MAX, y]);
  return moves;
}

test('the grid bounds are inclusive and integer only', () => {
  assert.equal(inGrid(p(GRID.X_MIN, GRID.Y_MIN)), true);
  assert.equal(inGrid(p(GRID.X_MAX, GRID.Y_MAX)), true);
  assert.equal(inGrid(p(GRID.X_MAX + 1, 1)), false);
  assert.equal(inGrid(p(1, GRID.Y_MIN - 1)), false);
  assert.equal(inGrid(p(1.5, 2)), false);
});

test('dots link within REACH on both axes, diagonals included', () => {
  assert.equal(linked(p(5, 5), p(5 + REACH, 5 + REACH)), true);
  assert.equal(linked(p(5, 5), p(5 - REACH, 5)), true);
  assert.equal(linked(p(5, 5), p(5 + REACH + 1, 5)), false);
  assert.equal(linked(p(5, 5), p(5, 5 + REACH + 1)), false);
});

test('scattered dots do not connect', () => {
  const r = play([[1, 1], [16, 9], [8, 5], [4, 8], [12, 2]]);
  assert.equal(r.path, null);
});

test('a chain that reaches both edges connects on the dot that completes it', () => {
  const moves = chain(5);
  const r = play(moves);
  assert.ok(r.path);
  assert.equal(r.dots.length, moves.length, 'nothing should connect before the last dot');
  assert.equal(r.dots[r.path[0]].x, GRID.X_MIN);
  assert.equal(r.dots[r.path[r.path.length - 1]].x, GRID.X_MAX);
});

test('the dot that connects is always on the revealed path', () => {
  // The bridge goes in last, after both halves are already in place.
  const moves = chain(5);
  const bridge = moves.splice(3, 1)[0];
  const r = play([...moves, bridge]);
  assert.ok(r.path);
  assert.ok(r.path.includes(r.dots.length - 1), 'the newest dot must be on the path');
});

test('the path only steps between linked dots and is as short as it can be', () => {
  const r = play([...chain(3), [3, 5]]);
  assert.ok(r.path);
  for (let i = 1; i < r.path.length; i++) {
    assert.ok(linked(r.dots[r.path[i - 1]], r.dots[r.path[i]]));
  }
  assert.equal(r.path.length, chain(3).length);
});

test('a dot on an occupied point or off the grid is refused', () => {
  assert.deepEqual(placeDot([p(3, 3)], p(3, 3)), { ok: false, code: 'occupied' });
  assert.deepEqual(placeDot([], p(0, 5)), { ok: false, code: 'off_grid' });
  assert.deepEqual(placeDot([], p(GRID.X_MAX + 1, 5)), { ok: false, code: 'off_grid' });
});

test('placeDot does not mutate the chapter it is given', () => {
  const dots = [p(2, 5)];
  placeDot(dots, p(4, 6));
  assert.deepEqual(dots, [p(2, 5)]);
});

test('findPath on fewer dots than a crossing needs finds nothing', () => {
  assert.equal(findPath([]), null);
  assert.equal(findPath([p(GRID.X_MIN, 1)]), null);
});

test('componentOf and linksAmong describe the hidden web', () => {
  const dots = [p(1, 1), p(3, 2), p(5, 1), p(10, 9)];
  const component = componentOf(dots, 0);
  assert.deepEqual(component, [0, 1, 2]);
  assert.deepEqual(linksAmong(dots, component), [[0, 1], [1, 2]]);
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

  const duplicate = replay([...actions, { issue: 3, user: 'c', x: 5, y: 8 }]);
  assert.equal(duplicate.consistent, false);

  const connected = replay(chain(4).map(([x, y], i) => ({ issue: i + 1, user: 'a', x, y })));
  assert.equal(connected.consistent, false, 'a stored log can never hold a connection');

  assert.deepEqual(replay([]), { dots: [], consistent: true });
});
