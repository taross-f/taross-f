/**
 * State -> SVG. Pure string building, no I/O.
 *
 * Everything here is constrained by what GitHub actually renders in a README:
 *   - <script> is stripped, so the board has to work as a single still frame
 *   - no external fonts, no external images, no xlink:href
 *   - prefers-color-scheme is unreliable, so the background is painted
 *     explicitly and the palette is chosen to read on light and dark alike
 */

import { WORLD } from './sim.js';

const BOARD_W = WORLD.WIDTH;
const BOARD_H = WORLD.HEIGHT;
const GROUND_Y = WORLD.GROUND_Y;
const LEFT = WORLD.GROUND_LEFT;
const RIGHT = WORLD.GROUND_RIGHT;

const PALETTE = {
  bg: '#0d1420',
  bgAlt: '#131c2c',
  panel: '#1b2740',
  ground: '#31405f',
  groundTop: '#5a729e',
  text: '#e8eef9',
  muted: '#8fa2c4',
  accent: '#ffd166',
  danger: '#ff7b72',
  grid: '#1a2436',
};

/** Escape text destined for an XML text node or attribute value. */
export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Fixed precision keeps generated SVG stable across runs and small in diffs. */
function n(value) {
  const r = Math.round(value * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

/** Each round gets its own hue so the history reads as distinct runs. */
function roundHue(round) {
  return (round * 47) % 360;
}

function blockFill(round, index, total) {
  const hue = roundHue(round);
  // Gentle ramp from the base colour up as the tower grows.
  const t = total <= 1 ? 0 : index / (total - 1);
  const light = 46 + Math.round(t * 18);
  const sat = 62 - Math.round(t * 12);
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

function blockStroke(round) {
  return `hsl(${roundHue(round)}, 70%, 26%)`;
}

function renderBlock(block, index, total, round, isLast) {
  const deg = n((block.angle * 180) / Math.PI);
  const x = n(-block.w / 2);
  const y = n(-block.h / 2);
  const w = n(block.w);
  const h = n(block.h);

  const fill = blockFill(round, index, total);
  const stroke = isLast ? '#ffffff' : blockStroke(round);
  const strokeWidth = isLast ? 2 : 1;

  const title = `#${block.issue} ${block.user || 'unknown'}`;

  return `<g transform="translate(${n(block.x)} ${n(block.y)}) rotate(${deg})">`
    + `<title>${escapeXml(title)}</title>`
    + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" `
    + `fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`
    + `<rect x="${x}" y="${y}" width="${w}" height="${n(Math.min(3, block.h / 4))}" rx="1" `
    + `fill="#ffffff" opacity="0.16"/>`
    + `</g>`;
}

/**
 * The board scene itself: background, platform, blocks, record line.
 * Shared by the README board and the share card so the two never diverge.
 */
function scene(view) {
  const parts = [];

  parts.push(`<rect x="0" y="0" width="${BOARD_W}" height="${BOARD_H}" fill="${PALETTE.bg}"/>`);

  // Faint horizontal rules every 50px, purely to give height a sense of scale.
  for (let y = GROUND_Y - 50; y > 10; y -= 50) {
    parts.push(`<line x1="0" y1="${y}" x2="${BOARD_W}" y2="${y}" `
      + `stroke="${PALETTE.grid}" stroke-width="1"/>`);
    parts.push(`<text x="6" y="${y - 4}" font-family="monospace" font-size="8" `
      + `fill="${PALETTE.grid}">${GROUND_Y - y}</text>`);
  }

  // Ground: everything below the platform line.
  parts.push(`<rect x="0" y="${GROUND_Y}" width="${BOARD_W}" height="${BOARD_H - GROUND_Y}" `
    + `fill="${PALETTE.bgAlt}"/>`);

  // The platform. Anything whose centre leaves this span has fallen.
  parts.push(`<rect x="${LEFT}" y="${GROUND_Y}" width="${RIGHT - LEFT}" height="9" `
    + `fill="${PALETTE.ground}"/>`);
  parts.push(`<line x1="${LEFT}" y1="${GROUND_Y}" x2="${RIGHT}" y2="${GROUND_Y}" `
    + `stroke="${PALETTE.groundTop}" stroke-width="2"/>`);

  // Edge ticks showing the legal x range. These have to stay inside the 270px
  // viewBox or GitHub simply clips them away.
  for (const [x, label, anchor] of [[LEFT, String(LEFT), 'start'], [RIGHT, String(RIGHT), 'end']]) {
    parts.push(`<line x1="${x}" y1="${GROUND_Y}" x2="${x}" y2="${GROUND_Y + 9}" `
      + `stroke="${PALETTE.groundTop}" stroke-width="1"/>`);
    parts.push(`<text x="${anchor === 'start' ? x + 3 : x - 3}" y="${GROUND_Y + 18}" `
      + `text-anchor="${anchor}" font-family="monospace" font-size="9" `
      + `fill="${PALETTE.muted}">x=${label}</text>`);
  }

  // Best-ever height, drawn over the board as a target to beat.
  if (view.best > 0 && GROUND_Y - view.best > 4) {
    const y = n(GROUND_Y - view.best);
    parts.push(`<line x1="0" y1="${y}" x2="${BOARD_W}" y2="${y}" `
      + `stroke="${PALETTE.accent}" stroke-width="1" stroke-dasharray="6 4" opacity="0.85"/>`);
    parts.push(`<text x="${BOARD_W - 6}" y="${y - 5}" text-anchor="end" `
      + `font-family="monospace" font-size="10" fill="${PALETTE.accent}">`
      + `BEST ${Math.round(view.best)}</text>`);
  }

  const total = view.blocks.length;
  for (let i = 0; i < total; i++) {
    parts.push(renderBlock(view.blocks[i], i, total, view.round, i === total - 1));
  }

  if (total === 0) {
    parts.push(`<text x="${BOARD_W / 2}" y="${GROUND_Y - 40}" text-anchor="middle" `
      + `font-family="monospace" font-size="13" fill="${PALETTE.muted}">`
      + `open an issue to drop the first block</text>`);
  }

  return parts.join('');
}

function stat(x, y, label, value, valueColor) {
  return `<text x="${x}" y="${y}" font-family="monospace" font-size="9" `
    + `fill="${PALETTE.muted}">${escapeXml(label)}</text>`
    + `<text x="${x}" y="${y + 17}" font-family="monospace" font-size="17" `
    + `font-weight="bold" fill="${valueColor}">${escapeXml(value)}</text>`;
}

/**
 * The board embedded in the README.
 * @param {object} view see buildView
 */
export function renderBoard(view) {
  const parts = [];

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOARD_W} ${BOARD_H}" `
    + `width="${BOARD_W}" height="${BOARD_H}" role="img" `
    + `aria-label="${escapeXml(ariaLabel(view))}">`);

  parts.push(scene(view));

  // HUD panel, top left, over the empty sky.
  parts.push(`<rect x="10" y="10" width="164" height="46" rx="4" `
    + `fill="${PALETTE.panel}" opacity="0.92"/>`);
  parts.push(stat(20, 25, 'HEIGHT', String(Math.round(view.height)), PALETTE.text));
  parts.push(stat(86, 25, 'BLOCKS', String(view.blocks.length), PALETTE.text));
  parts.push(stat(134, 25, 'ROUND', String(view.round), PALETTE.accent));

  if (view.collapsedBy) {
    const c = view.collapsedBy;
    parts.push(`<rect x="10" y="62" width="${BOARD_W - 20}" height="22" rx="4" `
      + `fill="${PALETTE.panel}" opacity="0.92"/>`);
    parts.push(`<text x="20" y="77" font-family="monospace" font-size="10" `
      + `fill="${PALETTE.danger}">`
      + escapeXml(`round ${c.round} ended at ${Math.round(c.height)}px `
        + `(${c.blocks} blocks) - last drop by ${c.collapsedBy}`)
      + `</text>`);
  } else if (view.lastUser) {
    parts.push(`<text x="10" y="76" font-family="monospace" font-size="10" `
      + `fill="${PALETTE.muted}">`
      + escapeXml(`last drop: #${view.lastIssue} by ${view.lastUser}`)
      + `</text>`);
  }

  parts.push(`</svg>`);
  return parts.join('\n');
}

function ariaLabel(view) {
  if (view.blocks.length === 0) {
    return `Tower game round ${view.round}: the board is empty, waiting for the first block.`;
  }
  return `Tower game round ${view.round}: ${view.blocks.length} blocks stacked, `
    + `current height ${Math.round(view.height)} pixels, `
    + `best ever ${Math.round(view.bestOverall)} pixels.`;
}

/**
 * 1200x630 card for link previews, regenerated whenever the record moves.
 */
export function renderShare(view) {
  const W = 1200;
  const H = 630;
  // Headline block takes the top ~145px and the footer the bottom ~55px, so the
  // board has to be scaled to fit what is left or the tower falls off the card.
  const offsetY = 145;
  const footerRoom = 62;
  const scale = Math.min(W / BOARD_W, (H - offsetY - footerRoom) / BOARD_H);
  const boardW = BOARD_W * scale;
  const offsetX = (W - boardW) / 2;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" `
    + `width="${W}" height="${H}" role="img" `
    + `aria-label="${escapeXml(ariaLabel(view))}">`);

  // Slightly darker than the board so the playfield reads as its own panel.
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#070c14"/>`);

  parts.push(`<text x="${W / 2}" y="72" text-anchor="middle" font-family="monospace" `
    + `font-size="30" fill="${PALETTE.muted}">SHARED TOWER</text>`);
  parts.push(`<text x="${W / 2}" y="126" text-anchor="middle" font-family="monospace" `
    + `font-size="54" font-weight="bold" fill="${PALETTE.accent}">`
    + escapeXml(`${Math.round(view.shareHeight)} px / ${view.shareBlocks} blocks`)
    + `</text>`);

  // Clip so a toppling block cannot spill outside the card. The clip lives on an
  // untransformed wrapper: a clip-path on the same element as a transform is
  // resolved in that element's own (post-transform) space, which would put the
  // rectangle in board coordinates instead of card coordinates.
  parts.push(`<clipPath id="board"><rect x="${n(offsetX)}" y="${offsetY}" `
    + `width="${n(boardW)}" height="${n(BOARD_H * scale)}" rx="6"/></clipPath>`);
  parts.push(`<g clip-path="url(#board)">`);
  parts.push(`<g transform="translate(${n(offsetX)} ${offsetY}) scale(${n(scale)})">`);
  parts.push(scene(view));
  parts.push(`</g></g>`);

  parts.push(`<text x="${W / 2}" y="${H - 30}" text-anchor="middle" font-family="monospace" `
    + `font-size="26" fill="${PALETTE.text}">github.com/taross-f</text>`);

  parts.push(`</svg>`);
  return parts.join('\n');
}

/**
 * Assemble the drawing input from persisted state plus a replayed board.
 *
 * @param {object} state   state.json contents
 * @param {object} world   world returned by replay()
 * @param {number} height  replayed tower height
 * @param {object|null} collapsedBy hall-of-fame entry to call out, if the last
 *        move ended a round
 */
export function buildView(state, world, height, collapsedBy = null) {
  const placed = world.bodies
    .filter((b) => !b.static)
    .map((b) => ({
      x: b.x,
      y: b.y,
      angle: b.angle,
      w: b.w,
      h: b.h,
      issue: b.issue,
      user: b.user,
    }));

  const bestFromFame = state.hallOfFame.reduce((max, e) => (e.height > max ? e.height : max), 0);
  const last = state.actions.length > 0 ? state.actions[state.actions.length - 1] : null;

  return {
    round: state.round,
    height,
    // The record line marks a mark set by a *finished* round. Folding the live
    // tower into it would pin the line to the top of the current stack, where it
    // says nothing; kept separate, it is a target to beat.
    best: bestFromFame,
    bestOverall: Math.max(bestFromFame, height),
    blocks: placed,
    lastIssue: last ? last.issue : null,
    lastUser: last ? last.user : null,
    collapsedBy,
    // The share card headlines the run being celebrated, which after a collapse
    // is the round that just ended rather than the empty board that replaced it.
    shareHeight: collapsedBy ? collapsedBy.height : height,
    shareBlocks: collapsedBy ? collapsedBy.blocks : placed.length,
  };
}
