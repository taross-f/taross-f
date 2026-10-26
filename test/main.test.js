import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { renderBoard, renderShare, buildView, escapeXml, BOARD_W, BOARD_H } from '../src/render.js';
import {
  applyPlay, replaceBoardBlock, buildBoardBlock, defaultState, readState,
  MARKER_START, MARKER_END, README_TARGETS, LANGUAGES, HALL_OF_FAME_SIZE,
} from '../src/main.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let issue = 100;
function act(x, y, user = 'alice') {
  issue += 1;
  return { issue, user, x, y, at: `2026-10-26T00:${String(issue % 60).padStart(2, '0')}:00.000Z` };
}

/** Play a list of moves from a fresh state, returning the last applyPlay result. */
function playAll(moves, state = defaultState()) {
  let applied = null;
  for (const [x, y, user] of moves) {
    applied = applyPlay(state, act(x, y, user));
    assert.ok(!applied.rejected, `(${x}, ${y}) was rejected: ${applied.rejected}`);
    state = applied.state;
  }
  return applied;
}

// Closes on the eighth dot by crossing the first stretch out of now.
const CONNECTING = [[2, 7], [5, 8], [8, 6], [11, 7], [10, 3], [6, 2], [3, 3], [1, 7, 'carol']];

// ---------------------------------------------------------------------------
// state transitions
// ---------------------------------------------------------------------------

test('an open dot appends to the log and leaves the chapter alone', () => {
  const state = defaultState();
  const applied = applyPlay(state, { issue: 1, user: 'alice', x: 3, y: 6, at: '2026-10-26T00:00:00Z' });

  assert.equal(applied.connectedEntry, null);
  assert.equal(applied.state.chapter, 1);
  assert.equal(applied.state.actions.length, 1);
  assert.equal(applied.state.hallOfFame.length, 0);
  assert.equal(applied.state.lastPlayedBy.alice, '2026-10-26T00:00:00Z');
  assert.equal(state.actions.length, 0, 'applyPlay must not mutate the state it is given');
});

test('a connecting dot records the chapter, clears the log, and opens the next one', () => {
  const applied = playAll(CONNECTING);

  assert.ok(applied.connectedEntry);
  assert.equal(applied.connectedEntry.dots, CONNECTING.length);
  assert.equal(applied.connectedEntry.connectedBy, 'carol');
  assert.equal(applied.state.chapter, 2);
  assert.equal(applied.state.actions.length, 0, 'a new chapter starts from an empty log');
  assert.equal(applied.state.hallOfFame.length, 1);
  // The cooldown record has to survive the chapter reset.
  assert.ok(applied.state.lastPlayedBy.carol);
});

test('the board keeps showing the closed chapter until the next dot', () => {
  const applied = playAll(CONNECTING);
  assert.equal(applied.view.connected, true);
  assert.equal(applied.view.chapter, 1);
  assert.equal(applied.view.dots.length, CONNECTING.length);

  const next = applyPlay(applied.state, act(4, 4));
  assert.equal(next.view.chapter, 2);
  assert.equal(next.view.dots.length, 1);
  assert.equal(next.view.connected, false);
});

test('a dot on the end of the line is refused without touching state', () => {
  const first = applyPlay(defaultState(), act(4, 4));
  const again = applyPlay(first.state, act(4, 4, 'bob'));
  assert.equal(again.rejected, 'same_dot');
  assert.equal(again.state, first.state);
});

test('a stored log that no longer replays is closed out, not silently rewritten', () => {
  const state = {
    ...defaultState(),
    actions: [act(3, 5), act(3, 5)],
  };
  const applied = applyPlay(state, act(6, 6, 'dave'));
  assert.equal(applied.drifted, true);
  assert.equal(applied.state.chapter, 2);
  assert.equal(applied.state.hallOfFame.length, 1);
  assert.equal(applied.state.actions.length, 1);
});

test('the hall of fame keeps the best five, longest first', () => {
  let state = defaultState();
  state.hallOfFame = [9, 4, 12, 7, 2].map((dots, i) => ({
    chapter: i + 1, dots, connectedBy: 'someone', at: '2026-01-01T00:00:00Z',
  }));
  state.chapter = 6;

  const fame = playAll(CONNECTING, state).state.hallOfFame;
  assert.equal(fame.length, HALL_OF_FAME_SIZE);
  assert.deepEqual(fame.map((e) => e.dots), [12, 9, 8, 7, 4]);
});

test('a state file from the old tower game starts the dots game fresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dots-'));
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify({
    version: 1, round: 3, actions: [{ issue: 1, user: 'a', x: 240 }], hallOfFame: [{ height: 90 }],
    lastPlayedBy: { a: '2026-10-01T00:00:00Z' },
  }));
  const state = readState(file);
  assert.equal(state.chapter, 1);
  assert.deepEqual(state.actions, []);
  assert.deepEqual(state.hallOfFame, []);
  assert.deepEqual(state.lastPlayedBy, { a: '2026-10-01T00:00:00Z' });
});

test('the shipped state.json is a valid, replayable dots state', () => {
  const state = readState(join(HERE, '..', 'state.json'));
  const applied = applyPlay(state, act(12, 1, 'probe'));
  assert.equal(applied.drifted, false);
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
  const state = { ...defaultState(), chapter: 3, actions: [{ issue: 1, user: 'a', x: 2, y: 2 }] };
  const view = buildView(state, state.actions);
  const block = buildBoardBlock(state, view, 'taross-f/taross-f');
  assert.match(block, /assets\/board\.svg\?v=1-3/);
});

test('every shipped README carries the markers and a language switcher', () => {
  const root = join(HERE, '..');
  for (const { path: file, lang } of README_TARGETS) {
    const name = file.slice(root.length + 1);
    assert.ok(existsSync(file), `${name} should exist`);

    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes(MARKER_START) && text.includes(MARKER_END),
      `${name} must keep the board markers or the workflow cannot update it`);

    // Each README links to the other, so a reader can always switch.
    const other = README_TARGETS.find((t) => t.lang !== lang);
    const otherName = other.path.slice(root.length + 1);
    assert.ok(text.includes(`(${otherName})`),
      `${name} must link to ${otherName}`);
  }
});

test('the board block is rendered in the language of each README', () => {
  const state = { ...defaultState(), chapter: 2, actions: [] };
  const entry = { chapter: 1, dots: 9, connectedBy: 'alice', at: '2026-01-01T00:00:00Z' };
  state.hallOfFame = [entry];
  const view = buildView(state, [], entry);

  const en = buildBoardBlock(state, view, 'taross-f/taross-f', 'en');
  const ja = buildBoardBlock(state, view, 'taross-f/taross-f', 'ja');

  assert.notEqual(en, ja, 'the two languages should not render identically');
  assert.match(en, /Place a dot/);
  assert.match(en, /Hall of fame/);
  assert.match(en, /\| Chapter \| Dots \| Best ever \|/);
  assert.ok(!/[ぁ-んァ-ン一-龯]/.test(en), 'the English block should carry no Japanese text');

  assert.match(ja, /点を打つ/);
  assert.match(ja, /殿堂入り/);

  // Both must stay factually identical: same numbers, same image, same links.
  for (const block of [en, ja]) {
    assert.match(block, /assets\/board\.svg\?v=0-2/);
    assert.match(block, /\| 2 \| 0 \| 9 \|/);
    assert.match(block, /@alice/);
  }
});

test('an unknown language is rejected rather than silently falling back', () => {
  const view = buildView(defaultState(), []);
  assert.throws(() => buildBoardBlock(defaultState(), view, 'o/r', 'fr'), /language/);
});

test('LANGUAGES matches the configured README targets', () => {
  assert.deepEqual([...LANGUAGES].sort(), README_TARGETS.map((t) => t.lang).sort());
});

test('a hostile display name cannot break out of the README table', () => {
  const state = defaultState();
  state.hallOfFame = [{
    chapter: 1, dots: 2, connectedBy: 'evil|user](javascript:alert(1))', at: 'x',
  }];
  const view = buildView(state, []);
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
  const empty = buildView(defaultState(), []);
  const open = playAll(CONNECTING.slice(0, -1)).view;
  const connected = playAll(CONNECTING).view;
  return { empty, open, connected };
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
  const svg = renderBoard(sampleViews().open);
  assert.match(svg, new RegExp(`<rect x="0" y="0" width="${BOARD_W}" height="${BOARD_H}" rx="18" fill="#[0-9a-f]{6}"`, 'i'));
  assert.ok(!svg.includes('prefers-color-scheme'), 'must not rely on prefers-color-scheme');
});

test('rendering is deterministic and free of NaN', () => {
  for (const view of Object.values(sampleViews())) {
    assert.equal(renderBoard(view), renderBoard(view));
    assert.equal(renderShare(view), renderShare(view));
    assert.ok(!renderBoard(view).includes('NaN'));
    assert.ok(!renderShare(view).includes('NaN'));
  }
});

test('the board carries the message and the whole career line', () => {
  const svg = renderBoard(sampleViews().empty);
  assert.match(svg, /CONNECTING THE DOTS/);
  assert.match(svg, /どこに打つ？/);
  for (const year of ['2009', '2012', '2018', '2021', '2024']) assert.ok(svg.includes(`>${year}<`), year);
  assert.match(svg, />NOW</);
});

test('every placed dot is drawn, and only the newest one is outlined', () => {
  const view = sampleViews().open;
  const svg = renderBoard(view);
  const dots = (svg.match(/<title>#\d+ /g) || []).length;
  assert.equal(dots, view.dots.length);
  assert.equal((svg.match(/stroke="#ffffff"/g) || []).length, 1);
});

test('an empty future invites the first dot', () => {
  const svg = renderBoard(sampleViews().empty);
  assert.match(svg, /open an issue to place the first dot/);
  assert.doesNotThrow(() => checkWellFormed(svg));
});

test('a connected chapter is called out on the board', () => {
  const svg = renderBoard(sampleViews().connected);
  assert.match(svg, /Chapter 1 connected at 8 dots/);
});

test('user supplied text is escaped into the SVG', () => {
  assert.equal(escapeXml('<&">\''), '&lt;&amp;&quot;&gt;&apos;');

  const state = { ...defaultState(), actions: [{ issue: 1, user: 'a<b>&"c', x: 2, y: 2 }] };
  const svg = renderBoard(buildView(state, state.actions));

  assert.ok(!svg.includes('a<b>'), 'raw markup from a login must not reach the SVG');
  assert.ok(svg.includes('a&lt;b&gt;'));
  assert.doesNotThrow(() => checkWellFormed(svg));
});
