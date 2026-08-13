/**
 * Local dry run: play a scripted game and write the SVGs somewhere you can look
 * at them, without touching state.json or the README.
 *
 *   node tools/demo.js [turns] [outDir]
 *
 * The x choices come from the deterministic PRNG, so the demo board is the same
 * every time and a rendering change shows up as a real diff.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createRng } from '../src/rng.js';
import { createWorld, dropBlock, WORLD } from '../src/sim.js';
import { buildView, renderBoard, renderShare } from '../src/render.js';

const turns = Number(process.argv[2] || 30);
const outDir = process.argv[3] || join(process.cwd(), 'assets', 'demo');

mkdirSync(outDir, { recursive: true });

const rng = createRng(20260812);
const state = { version: 1, round: 1, actions: [], hallOfFame: [], lastPlayedBy: {} };

let world = createWorld();
let height = 0;
let collapsedBy = null;

for (let i = 1; i <= turns; i++) {
  // Aim near the middle most of the time, with the occasional risky edge drop.
  const spread = rng.nextFloat() < 0.2 ? 95 : 40;
  const x = Math.round(240 + (rng.nextFloat() * 2 - 1) * spread);
  const clamped = Math.min(Math.max(x, WORLD.GROUND_LEFT), WORLD.GROUND_RIGHT);
  const action = { issue: i, user: `player${(i % 5) + 1}`, x: clamped, at: new Date().toISOString() };

  const result = dropBlock(world, action, height);
  const label = result.collapsed ? `COLLAPSE (${result.reason})` : '';
  process.stdout.write(
    `turn ${String(i).padStart(3)}  x=${String(clamped).padStart(3)}  `
    + `height=${result.height.toFixed(1).padStart(6)}  steps=${String(result.steps).padStart(4)}  ${label}\n`,
  );

  if (result.collapsed) {
    collapsedBy = {
      round: state.round,
      height: Math.round(result.height),
      blocks: result.world.bodies.length - 1,
      collapsedBy: action.user,
      at: action.at,
    };
    state.hallOfFame.push(collapsedBy);
    state.hallOfFame.sort((a, b) => b.height - a.height);
    state.hallOfFame = state.hallOfFame.slice(0, 5);
    state.round += 1;
    state.actions = [];
    world = createWorld();
    height = 0;
  } else {
    collapsedBy = null;
    state.actions.push(action);
    world = result.world;
    height = result.height;
  }
}

const view = buildView(state, world, height, collapsedBy);
const boardPath = join(outDir, 'board.svg');
const sharePath = join(outDir, 'share.svg');
writeFileSync(boardPath, renderBoard(view));
writeFileSync(sharePath, renderShare(view));

process.stdout.write(`\nround ${state.round}, ${state.actions.length} blocks up, `
  + `height ${Math.round(height)}\n`);
process.stdout.write(`hall of fame: ${JSON.stringify(state.hallOfFame)}\n`);
process.stdout.write(`wrote ${boardPath}\n`);
process.stdout.write(`wrote ${sharePath}\n`);
