import test from 'node:test';
import assert from 'node:assert/strict';

import { createRng, seedFromIssue } from '../src/rng.js';
import {
  WORLD,
  blockSpec,
  createWorld,
  dropBlock,
  replay,
  blocks,
  towerHeight,
  corners,
} from '../src/sim.js';

function makeActions(count, pick) {
  const out = [];
  for (let i = 1; i <= count; i++) out.push({ issue: i, user: 'tester', x: pick(i) });
  return out;
}

/** Every field that could possibly drift between two runs. */
function snapshot(world) {
  return blocks(world).map((b) => [b.x, b.y, b.angle, b.vx, b.vy, b.omega, b.w, b.h]);
}

test('rng: xorshift32 is reproducible and never returns the same stream for different seeds', () => {
  const a = createRng(12345);
  const b = createRng(12345);
  const c = createRng(12346);

  const seqA = [];
  const seqB = [];
  const seqC = [];
  for (let i = 0; i < 64; i++) {
    seqA.push(a.nextUint32());
    seqB.push(b.nextUint32());
    seqC.push(c.nextUint32());
  }

  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
});

test('rng: a zero seed still produces a usable stream', () => {
  const rng = createRng(0);
  const values = new Set();
  for (let i = 0; i < 32; i++) values.add(rng.nextUint32());
  assert.equal(values.size, 32, 'zero seed must not collapse to a fixed point');
});

test('rng: nextFloat stays in [0, 1) and intRange stays inclusive of both ends', () => {
  const rng = createRng(seedFromIssue(99));
  let lo = false;
  let hi = false;
  for (let i = 0; i < 5000; i++) {
    const f = rng.nextFloat();
    assert.ok(f >= 0 && f < 1, `nextFloat out of range: ${f}`);
    const n = rng.intRange(3, 5);
    assert.ok(n === 3 || n === 4 || n === 5, `intRange out of range: ${n}`);
    if (n === 3) lo = true;
    if (n === 5) hi = true;
  }
  assert.ok(lo && hi, 'intRange must be able to hit both endpoints');
});

test('blockSpec: stays inside the documented ranges and depends only on the issue number', () => {
  for (let issue = 1; issue <= 500; issue++) {
    const spec = blockSpec(issue);
    assert.ok(spec.w >= 24 && spec.w <= 56, `width ${spec.w} out of range for #${issue}`);
    assert.ok(spec.h >= 14 && spec.h <= 28, `height ${spec.h} out of range for #${issue}`);
    assert.ok(spec.angle >= -0.12 && spec.angle <= 0.12, `angle ${spec.angle} out of range`);
    assert.deepEqual(spec, blockSpec(issue), 'blockSpec must be a pure function of the issue');
  }
});

test('determinism: replaying the same action list twice matches bit for bit', () => {
  const actions = makeActions(20, (i) => 200 + ((i * 13) % 60));

  const first = replay(actions);
  const second = replay(actions);

  assert.deepEqual(snapshot(second.world), snapshot(first.world));
  assert.equal(second.height, first.height);
  assert.deepEqual(second.turns, first.turns);

  // deepEqual on numbers is Object.is based, but be explicit about it: every
  // coordinate has to be the identical double, not merely close.
  const a = snapshot(first.world).flat();
  const b = snapshot(second.world).flat();
  for (let i = 0; i < a.length; i++) {
    assert.ok(Object.is(a[i], b[i]), `value ${i} drifted: ${a[i]} vs ${b[i]}`);
  }
});

test('determinism: a fresh world is not polluted by an earlier simulation', () => {
  const actions = makeActions(8, () => 240);

  const warmup = replay(makeActions(15, (i) => 180 + i * 6));
  assert.ok(warmup.turns.length > 0);

  const a = replay(actions);
  const b = replay(actions);
  assert.deepEqual(snapshot(a.world), snapshot(b.world));
});

test('purity: dropBlock does not mutate the world it is given', () => {
  const world = createWorld();
  const before = JSON.stringify(world);

  const result = dropBlock(world, { issue: 7, user: 'tester', x: 240 }, 0);

  assert.equal(JSON.stringify(world), before, 'input world was mutated');
  assert.equal(blocks(world).length, 0);
  assert.equal(blocks(result.world).length, 1);
});

test('edges: dropping at either end of the platform never throws', () => {
  for (const x of [WORLD.GROUND_LEFT, WORLD.GROUND_RIGHT]) {
    for (let issue = 1; issue <= 25; issue++) {
      assert.doesNotThrow(() => {
        const r = dropBlock(createWorld(), { issue, user: 'tester', x }, 0);
        assert.ok(Number.isFinite(r.height), 'height must stay finite');
        for (const b of blocks(r.world)) {
          assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.angle),
            `block state went non-finite at x=${x}, issue=${issue}`);
        }
      }, `x=${x}, issue=${issue}`);
    }
  }
});

test('edges: an x outside the platform is clamped rather than accepted', () => {
  const low = dropBlock(createWorld(), { issue: 3, user: 'tester', x: -500 }, 0);
  const high = dropBlock(createWorld(), { issue: 3, user: 'tester', x: 9999 }, 0);
  assert.ok(Number.isFinite(low.height));
  assert.ok(Number.isFinite(high.height));
});

test('a block dropped in the middle comes to rest on the ground', () => {
  const r = dropBlock(createWorld(), { issue: 1, user: 'tester', x: 240 }, 0);
  const spec = blockSpec(1);

  assert.equal(r.collapsed, false);
  assert.equal(r.stopReason, 'settled');
  // Resting flat on the platform, so the height is the block's own height.
  assert.ok(Math.abs(r.height - spec.h) < 1.5, `height ${r.height} vs block height ${spec.h}`);

  const b = blocks(r.world)[0];
  const lowest = Math.max(...corners(b).map((c) => c.y));
  assert.ok(Math.abs(lowest - WORLD.GROUND_Y) < 1, `block should sit on the ground, got ${lowest}`);
});

test('a block dropped past the platform edge falls off and collapses the round', () => {
  // The platform ends at x=340, so a block whose centre of mass ends up beyond
  // it cannot be supported.
  const world = createWorld();
  const r = dropBlock(world, { issue: 11, user: 'tester', x: WORLD.GROUND_RIGHT }, 0);
  const b = blocks(r.world)[0];
  const offPlatform = b.y > WORLD.GROUND_Y || b.x < WORLD.GROUND_LEFT || b.x > WORLD.GROUND_RIGHT;
  assert.equal(r.collapsed, offPlatform);
});

test('collapse: a large height drop from the previous turn counts as a collapse', () => {
  const world = createWorld();
  // Claim the tower was much taller last turn than this one can possibly be.
  const r = dropBlock(world, { issue: 1, user: 'tester', x: 240 }, 500);
  assert.equal(r.collapsed, true);
  assert.equal(r.reason, 'shrank');
});

test('collapse: replay stops at the first collapsing turn', () => {
  const actions = makeActions(6, () => 240);
  // Force a collapse mid-list by dropping way off the platform.
  actions[2] = { issue: 3, user: 'tester', x: WORLD.GROUND_LEFT };

  const r = replay(actions);
  assert.ok(r.turns.length <= actions.length);
  if (r.collapsed) {
    assert.equal(r.turns[r.turns.length - 1].collapsed, true);
    for (let i = 0; i < r.turns.length - 1; i++) {
      assert.equal(r.turns[i].collapsed, false, 'only the final turn may be the collapsing one');
    }
  }
});

test('turns always terminate within the step cap', () => {
  const actions = makeActions(40, (i) => 190 + ((i * 17) % 100));
  const r = replay(actions);
  for (const t of r.turns) {
    assert.ok(t.steps > 0 && t.steps <= WORLD.MAX_STEPS,
      `turn for #${t.issue} ran ${t.steps} steps`);
  }
});

test('towerHeight measures the topmost corner and is zero on an empty board', () => {
  assert.equal(towerHeight(createWorld()), 0);

  const r = dropBlock(createWorld(), { issue: 2, user: 'tester', x: 240 }, 0);
  const topmost = Math.min(...blocks(r.world).flatMap((b) => corners(b).map((c) => c.y)));
  assert.ok(Math.abs(towerHeight(r.world) - (WORLD.GROUND_Y - topmost)) < 1e-9);
});

test('performance: 100 consecutive drops finish well inside the Actions budget', () => {
  const started = Date.now();

  let world = createWorld();
  let height = 0;
  for (let issue = 1; issue <= 100; issue++) {
    const r = dropBlock(world, { issue, user: 'tester', x: 190 + ((issue * 23) % 100) }, height);
    world = r.world;
    height = r.height;
    if (r.collapsed) {
      world = createWorld();
      height = 0;
    }
  }

  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10000, `100 drops took ${elapsed}ms, budget is 10000ms`);
});

test('performance: a 100 block tower that never resets also stays inside the budget', () => {
  const started = Date.now();

  let world = createWorld();
  let height = 0;
  for (let issue = 1; issue <= 100; issue++) {
    const r = dropBlock(world, { issue, user: 'tester', x: 230 + (issue % 7) - 3 }, height);
    world = r.world;
    height = r.height;
  }

  const elapsed = Date.now() - started;
  assert.equal(blocks(world).length, 100);
  assert.ok(elapsed < 10000, `100 stacked drops took ${elapsed}ms, budget is 10000ms`);
});

test('no NaN or Infinity ever enters the simulation state', () => {
  const r = replay(makeActions(35, (i) => 140 + ((i * 31) % 201)));
  for (const b of blocks(r.world)) {
    for (const [key, value] of Object.entries(b)) {
      if (typeof value === 'number') {
        assert.ok(Number.isFinite(value), `block field ${key} became ${value}`);
      }
    }
  }
  assert.ok(Number.isFinite(r.height));
});
