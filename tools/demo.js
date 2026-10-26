/**
 * Local dry run: play a scripted game and write the SVGs somewhere you can look
 * at them, without touching state.json or the README.
 *
 *   node tools/demo.js [outDir]
 *
 * The moves are fixed, so the demo boards are the same every time and a
 * rendering change shows up as a real diff. Three boards come out: an empty
 * chapter, a chapter of scattered dots, and one that has just connected.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyPlay, defaultState } from '../src/main.js';
import { buildView, renderBoard, renderShare } from '../src/render.js';

const outDir = process.argv[2] || join(process.cwd(), 'assets', 'demo');
mkdirSync(outDir, { recursive: true });

// Scattered on purpose: the last dot bridges the one gap left in a chain that
// was already most of the way across, and the whole thing connects at once.
const MOVES = [
  [1, 3], [12, 8], [13, 4], [3, 5], [4, 1], [15, 5], [7, 6],
  [2, 8], [16, 4], [5, 4], [11, 6], [10, 1], [14, 8], [9, 5],
];

let state = defaultState();
let open = null;
let connected = null;

MOVES.forEach(([x, y], i) => {
  const action = { issue: i + 1, user: `player${(i % 5) + 1}`, x, y, at: new Date(i * 6e5).toISOString() };
  const applied = applyPlay(state, action);
  if (applied.rejected) throw new Error(`move ${i + 1} rejected: ${applied.rejected}`);

  const label = applied.connectedEntry ? `CONNECTED (${applied.connectedEntry.pathDots} on the path)` : '';
  process.stdout.write(`dot ${String(i + 1).padStart(2)}  (${x}, ${y})  ${label}\n`);

  state = applied.state;
  if (applied.connectedEntry) connected = applied.view;
  else open = applied.view;
});

const boards = {
  empty: buildView(defaultState(), []),
  open,
  connected,
};

for (const [name, view] of Object.entries(boards)) {
  const boardPath = join(outDir, `board-${name}.svg`);
  writeFileSync(boardPath, renderBoard(view));
  process.stdout.write(`wrote ${boardPath}\n`);
}
const sharePath = join(outDir, 'share.svg');
writeFileSync(sharePath, renderShare(connected));
process.stdout.write(`wrote ${sharePath}\n`);
