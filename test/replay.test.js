import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { replay, createWorld } from '../src/sim.js';
import { renderBoard, renderShare, buildView, escapeXml } from '../src/render.js';
import { applyPlay, replaceBoardBlock, buildBoardBlock, defaultState, MARKER_START, MARKER_END } from '../src/main.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(HERE, 'fixtures', 'replay-golden.json'), 'utf8'));

/** Matches tools/make-fixture.js, including folding -0 onto 0. */
function round3(value) {
  const r = Math.round(value * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

// ---------------------------------------------------------------------------
// golden replays
// ---------------------------------------------------------------------------

for (const testCase of golden.cases) {
  test(`golden: ${testCase.name}`, () => {
    const result = replay(testCase.actions);
    const expected = testCase.expected;

    assert.equal(result.collapsed, expected.collapsed, 'collapse verdict changed');
    assert.equal(result.turns.length, expected.turnsPlayed, 'number of turns played changed');
    assert.equal(round3(result.height), expected.height, 'final height changed');

    result.turns.forEach((turn, i) => {
      const want = expected.turns[i];
      assert.equal(turn.issue, want.issue);
      assert.equal(round3(turn.height), want.height, `turn ${i + 1} height changed`);
      assert.equal(turn.collapsed, want.collapsed, `turn ${i + 1} collapse verdict changed`);
      assert.equal(turn.reason, want.reason, `turn ${i + 1} reason changed`);
    });

    const blocks = result.world.bodies.filter((b) => !b.static);
    assert.equal(blocks.length, expected.blocks.length, 'block count changed');
    blocks.forEach((b, i) => {
      const want = expected.blocks[i];
      assert.equal(b.issue, want.issue);
      assert.equal(round3(b.x), want.x, `block ${i} x changed`);
      assert.equal(round3(b.y), want.y, `block ${i} y changed`);
      assert.equal(round3(b.angle), want.angle, `block ${i} angle changed`);
    });
  });
}

test('golden fixture actually covers both outcomes', () => {
  const outcomes = new Set(golden.cases.map((c) => c.expected.collapsed));
  assert.ok(outcomes.has(true) && outcomes.has(false),
    'fixture should exercise a surviving tower and a collapsing one');
});

// ---------------------------------------------------------------------------
// appending a move must not disturb the history
// ---------------------------------------------------------------------------

test('adding an action leaves every earlier turn identical', () => {
  const base = golden.cases[0].actions;
  const before = replay(base);

  const extended = [...base, { issue: 199, user: 'newcomer', x: 238, at: '2026-08-12T02:00:00Z' }];
  const after = replay(extended);

  assert.ok(after.turns.length >= before.turns.length);
  for (let i = 0; i < before.turns.length; i++) {
    assert.deepEqual(after.turns[i], before.turns[i], `turn ${i + 1} changed when a move was appended`);
  }
});

test('every prefix of an action log replays to the same intermediate state', () => {
  const actions = golden.cases[0].actions;
  const full = replay(actions);

  for (let k = 1; k <= actions.length; k++) {
    const prefix = replay(actions.slice(0, k));
    for (let i = 0; i < prefix.turns.length; i++) {
      assert.deepEqual(prefix.turns[i], full.turns[i],
        `prefix of length ${k} disagrees at turn ${i + 1}`);
    }
  }
});

test('replaying an empty log gives an empty board rather than throwing', () => {
  const result = replay([]);
  assert.equal(result.height, 0);
  assert.equal(result.collapsed, false);
  assert.equal(result.turns.length, 0);
  assert.equal(result.world.bodies.length, createWorld().bodies.length);
});

// ---------------------------------------------------------------------------
// state transitions
// ---------------------------------------------------------------------------

test('a surviving drop appends to the log and leaves the round alone', () => {
  const state = defaultState();
  const applied = applyPlay(state, { issue: 101, user: 'alice', x: 240, at: '2026-08-12T00:00:00Z' });

  assert.equal(applied.collapseEntry, null);
  assert.equal(applied.state.round, 1);
  assert.equal(applied.state.actions.length, 1);
  assert.equal(applied.state.hallOfFame.length, 0);
  assert.equal(applied.state.lastPlayedBy.alice, '2026-08-12T00:00:00Z');
  assert.equal(state.actions.length, 0, 'applyPlay must not mutate the state it is given');
});

test('a collapsing drop records the round, clears the log, and bumps the round', () => {
  const collapsing = golden.cases.find((c) => c.expected.collapsed);
  const survivingActions = collapsing.actions.slice(0, collapsing.expected.turnsPlayed - 1);
  const finalAction = collapsing.actions[collapsing.expected.turnsPlayed - 1];

  const state = { ...defaultState(), actions: survivingActions };
  const applied = applyPlay(state, finalAction);

  assert.ok(applied.collapseEntry, 'the final move of a collapsing fixture should collapse');
  assert.equal(applied.state.round, 2);
  assert.equal(applied.state.actions.length, 0, 'a new round starts from an empty log');
  assert.equal(applied.state.hallOfFame.length, 1);
  assert.equal(applied.state.hallOfFame[0].collapsedBy, finalAction.user);
  assert.equal(applied.view.blocks.length, 0, 'the rendered board should be the fresh one');
  // The cooldown record has to survive the round reset.
  assert.equal(applied.state.lastPlayedBy[finalAction.user], finalAction.at);
});

test('the share card shows the board that scored, not the empty one replacing it', () => {
  const collapsing = golden.cases.find((c) => c.expected.collapsed);
  const state = {
    ...defaultState(),
    actions: collapsing.actions.slice(0, collapsing.expected.turnsPlayed - 1),
  };
  const applied = applyPlay(state, collapsing.actions[collapsing.expected.turnsPlayed - 1]);

  assert.ok(applied.collapseEntry);
  assert.equal(applied.view.blocks.length, 0, 'the README board is the fresh round');
  assert.equal(
    applied.shareView.blocks.length,
    applied.collapseEntry.blocks,
    'the share card must still show every block from the round that just ended',
  );
  assert.equal(applied.shareView.round, applied.collapseEntry.round,
    'the share card should use the finished round for its colour');
  assert.equal(Math.round(applied.shareView.shareHeight), applied.collapseEntry.height);
});

test('a surviving drop shares the live board', () => {
  const applied = applyPlay(defaultState(),
    { issue: 101, user: 'alice', x: 240, at: '2026-08-12T00:00:00Z' });
  assert.equal(applied.shareView, applied.view);
});

test('the hall of fame keeps the best five, highest first', () => {
  let state = defaultState();
  state.hallOfFame = [90, 40, 120, 70, 20, 150, 60].map((height, i) => ({
    round: i + 1, height, blocks: 3, collapsedBy: 'someone', at: '2026-01-01T00:00:00Z',
  }));

  const applied = applyPlay(state, { issue: 501, user: 'bob', x: 240, at: '2026-08-12T00:00:00Z' });
  // applyPlay only trims on a collapse; check the ordering helper via a collapse.
  const collapsing = applyPlay(
    { ...state, actions: [] },
    { issue: 502, user: 'bob', x: 340, at: '2026-08-12T00:00:00Z' },
  );

  const fame = collapsing.collapseEntry ? collapsing.state.hallOfFame : applied.state.hallOfFame;
  assert.ok(fame.length <= 5);
  for (let i = 1; i < fame.length; i++) {
    assert.ok(fame[i - 1].height >= fame[i].height, 'hall of fame must stay sorted');
  }
});

// ---------------------------------------------------------------------------
// README block
// ---------------------------------------------------------------------------

test('only the marked region of the README is rewritten', () => {
  const readme = [
    '# Title',
    'untouched intro',
    MARKER_START,
    'old board',
    MARKER_END,
    'untouched outro',
  ].join('\n');

  const updated = replaceBoardBlock(readme, 'new board');

  assert.match(updated, /# Title\nuntouched intro/);
  assert.match(updated, /untouched outro$/);
  assert.ok(updated.includes('new board'));
  assert.ok(!updated.includes('old board'));
  assert.ok(updated.includes(MARKER_START) && updated.includes(MARKER_END));
});

test('a README without markers is refused rather than guessed at', () => {
  assert.throws(() => replaceBoardBlock('# no markers here', 'block'), /markers/);
});

test('the board image reference carries a cache-busting query', () => {
  const state = { ...defaultState(), round: 3, actions: [{ issue: 1, user: 'a', x: 240 }] };
  const view = buildView(state, createWorld(), 0, null);
  const block = buildBoardBlock(state, view, 'taross-f/taross-f');
  assert.match(block, /assets\/board\.svg\?v=1-3/);
});

test('a hostile display name cannot break out of the README table', () => {
  const state = defaultState();
  state.hallOfFame = [{
    round: 1, height: 50, blocks: 2, collapsedBy: 'evil|user](javascript:alert(1))', at: 'x',
  }];
  const view = buildView(state, createWorld(), 0, null);
  const block = buildBoardBlock(state, view, 'taross-f/taross-f');
  assert.ok(!block.includes('evil|user](javascript:alert(1))'),
    'markdown metacharacters in a login must be escaped');
});

// ---------------------------------------------------------------------------
// SVG output
// ---------------------------------------------------------------------------

/**
 * A deliberately small structural check: enough to catch unbalanced tags and
 * unescaped markup without pulling in an XML parser.
 */
function checkWellFormed(svg) {
  const stack = [];
  const tagPattern = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

  let cursor = 0;
  let match;
  while ((match = tagPattern.exec(svg)) !== null) {
    const text = svg.slice(cursor, match.index);
    if (text.includes('<')) throw new Error(`unescaped "<" in text: ${text.slice(0, 40)}`);
    for (const amp of text.matchAll(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g)) {
      throw new Error(`unescaped "&" in text at ${amp.index}`);
    }
    cursor = match.index + match[0].length;

    const [, closing, name, attrs, selfClosing] = match;

    // Attribute values must be fully quoted.
    const quotes = (attrs.match(/"/g) || []).length;
    if (quotes % 2 !== 0) throw new Error(`unbalanced quotes on <${name}>`);

    if (closing) {
      const open = stack.pop();
      if (open !== name) throw new Error(`</${name}> closes <${open}>`);
    } else if (!selfClosing) {
      stack.push(name);
    }
  }

  const tail = svg.slice(cursor);
  if (tail.includes('<')) throw new Error('stray "<" after the last tag');
  if (stack.length > 0) throw new Error(`unclosed tags: ${stack.join(', ')}`);
}

function sampleViews() {
  const empty = buildView(defaultState(), createWorld(), 0, null);

  const played = replay(golden.cases[0].actions);
  const state = { ...defaultState(), round: 4, actions: golden.cases[0].actions };
  state.hallOfFame = [
    { round: 1, height: 133, blocks: 9, collapsedBy: 'alice', at: '2026-01-01T00:00:00Z' },
    { round: 2, height: 88, blocks: 6, collapsedBy: 'bob', at: '2026-01-01T00:00:00Z' },
  ];
  const stacked = buildView(state, played.world, played.height, null);

  const collapsed = buildView(state, createWorld(), 0, {
    round: 3, height: 120, blocks: 8, collapsedBy: 'carol', at: '2026-01-01T00:00:00Z',
  });

  return { empty, stacked, collapsed };
}

test('generated SVG is well formed', () => {
  for (const [name, view] of Object.entries(sampleViews())) {
    assert.doesNotThrow(() => checkWellFormed(renderBoard(view)), `board.svg (${name})`);
    assert.doesNotThrow(() => checkWellFormed(renderShare(view)), `share.svg (${name})`);
  }
});

test('the structural check would actually catch broken markup', () => {
  assert.throws(() => checkWellFormed('<svg><g></svg>'), /unclosed|closes/);
  assert.throws(() => checkWellFormed('<svg>a < b</svg>'), /unescaped/);
  assert.throws(() => checkWellFormed('<svg><text>a & b</text></svg>'), /unescaped/);
});

test('generated SVG contains nothing GitHub strips or fetches externally', () => {
  const forbidden = [
    [/<script/i, '<script> is removed by GitHub'],
    [/<foreignObject/i, '<foreignObject> is removed by GitHub'],
    [/xlink:href/i, 'xlink:href is removed by GitHub'],
    [/\bhref\s*=/i, 'no external or internal links belong in the board'],
    [/https?:\/\//i, 'no external resource references'],
    [/<image\b/i, 'no embedded images'],
    [/@import/i, 'no external stylesheets'],
    [/url\(\s*['"]?(?:https?:|\/\/)/i, 'no external url() references'],
    [/\bon[a-z]+\s*=/i, 'no event handler attributes'],
    [/<!ENTITY/i, 'no entity declarations'],
  ];

  const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

  for (const [name, view] of Object.entries(sampleViews())) {
    for (const svg of [renderBoard(view), renderShare(view)]) {
      // The SVG namespace declaration is the one required http(s) URL, and it is
      // never fetched. Everything else must be free of external references.
      assert.ok(svg.includes(SVG_NS), `${name}: missing the SVG namespace`);
      const body = svg.split(SVG_NS).join('');

      for (const [pattern, why] of forbidden) {
        assert.ok(!pattern.test(body), `${name}: ${why}`);
      }
    }
  }
});

test('the board declares an explicit background so it reads in either theme', () => {
  const svg = renderBoard(sampleViews().stacked);
  assert.match(svg, /<rect x="0" y="0" width="480" height="270" fill="#[0-9a-f]{6}"/i);
  assert.ok(!svg.includes('prefers-color-scheme'), 'must not rely on prefers-color-scheme');
});

test('fonts are generic only, never external families', () => {
  const svg = renderBoard(sampleViews().stacked);
  const families = [...svg.matchAll(/font-family="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(families.length > 0);
  for (const family of families) {
    assert.equal(family, 'monospace', `unexpected font-family: ${family}`);
  }
});

test('rendering is deterministic and free of NaN', () => {
  const view = sampleViews().stacked;
  assert.equal(renderBoard(view), renderBoard(view));
  assert.equal(renderShare(view), renderShare(view));
  assert.ok(!renderBoard(view).includes('NaN'));
  assert.ok(!renderShare(view).includes('NaN'));
});

test('the most recent block is the only one outlined', () => {
  const view = sampleViews().stacked;
  const svg = renderBoard(view);
  const highlighted = (svg.match(/stroke="#ffffff" stroke-width="2"/g) || []).length;
  assert.equal(highlighted, 1, 'exactly one block should carry the emphasis outline');
});

test('the best-ever record is drawn as a dashed line', () => {
  const svg = renderBoard(sampleViews().stacked);
  assert.match(svg, /stroke-dasharray="6 4"/);
  assert.match(svg, /BEST 133/);
});

test('an empty board still renders and invites the first drop', () => {
  const svg = renderBoard(sampleViews().empty);
  assert.match(svg, /open an issue to drop the first block/);
  assert.doesNotThrow(() => checkWellFormed(svg));
});

test('user supplied text is escaped into the SVG', () => {
  assert.equal(escapeXml('<&">\''), '&lt;&amp;&quot;&gt;&apos;');

  const state = { ...defaultState(), actions: [{ issue: 1, user: 'a<b>&"c', x: 240 }] };
  const played = replay([{ issue: 1, user: 'a<b>&"c', x: 240 }]);
  const view = buildView(state, played.world, played.height, null);
  const svg = renderBoard(view);

  assert.ok(!svg.includes('a<b>'), 'raw markup from a login must not reach the SVG');
  assert.ok(svg.includes('a&lt;b&gt;'));
  assert.doesNotThrow(() => checkWellFormed(svg));
});
