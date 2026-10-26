/**
 * State -> SVG. Pure string building, no I/O.
 *
 * Everything here is constrained by what GitHub actually renders in a README:
 *   - <script> is stripped, so the board has to work as a single still frame
 *     (CSS animation is fine, and with reduced motion every frame still reads)
 *   - no external fonts, no external images, no xlink:href
 *   - prefers-color-scheme is unreliable, so the background is painted
 *     explicitly and the palette is chosen to read on light and dark alike
 */

import { GRID } from './dots.js';

export const BOARD_W = 960;
export const BOARD_H = 500;

const COL1_X = 120;
const COL_STEP = 48;
const ROW1_Y = 426;
const ROW_STEP = 34;

/** Grid coordinates -> board pixels. */
export function toPx(point) {
  return {
    x: COL1_X + (point.x - GRID.X_MIN) * COL_STEP,
    y: ROW1_Y - (point.y - GRID.Y_MIN) * ROW_STEP,
  };
}

const PALETTE = {
  bg: '#0d1420',
  panel: '#131c2c',
  border: '#22304d',
  edge: '#16233a',
  gridDot: '#2e3d5c',
  text: '#e8eef9',
  muted: '#8fa2c4',
  dot: '#7cb8ff',
  accent: '#ffd166',
};

// How long the reveal takes to trace from one edge to the other.
const TRACE_S = 2.4;
const TRACE_DELAY_S = 0.4;

const STYLE = `<style>
    .sans { font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, 'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic', Meiryo, sans-serif; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; }
    .ghost { animation: blink 2.4s ease-in-out infinite both; }
    @keyframes blink { 0%, 100% { opacity: .25; } 50% { opacity: .95; } }
    .trace { animation: trace ${TRACE_S}s cubic-bezier(.45, 0, .2, 1) ${TRACE_DELAY_S}s both; }
    @keyframes trace { from { stroke-dasharray: 1; stroke-dashoffset: 1; } to { stroke-dasharray: 1; stroke-dashoffset: 0; } }
    .web { animation: fade 1.2s ease-out ${TRACE_DELAY_S + TRACE_S}s both; }
    @keyframes fade { from { opacity: 0; } }
    .lit { transform-box: fill-box; transform-origin: center; animation: lit .5s cubic-bezier(.34, 1.56, .64, 1) both; }
    @keyframes lit { from { fill: ${PALETTE.dot}; transform: scale(.6); } }
    .pulse { transform-box: fill-box; transform-origin: center; animation: pulse 2s ease-out ${TRACE_DELAY_S + TRACE_S}s infinite both; }
    @keyframes pulse { from { opacity: .9; transform: scale(1); } to { opacity: 0; transform: scale(2.6); } }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
  </style>`;

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

function text(x, y, cls, size, fill, content, extra = '') {
  return `<text class="${cls}" x="${x}" y="${y}" font-size="${size}" fill="${fill}"${extra}>`
    + `${escapeXml(content)}</text>`;
}

// ---------------------------------------------------------------------------
// pieces
// ---------------------------------------------------------------------------

function header(view) {
  const parts = [];
  parts.push(text(32, 40, 'mono', 12, PALETTE.accent, 'CONNECTING THE DOTS', ' letter-spacing="2"'));
  parts.push(text(32, 68, 'sans', 19, PALETTE.text,
    'You can’t connect the dots looking forward. Place one anyway — where?',
    ' font-weight="700"'));
  parts.push(text(32, 92, 'sans', 14, PALETTE.muted,
    '点は、打っているあいだはつながらない。それでも打つ。次は、どこに打つ？'));

  parts.push(`<rect x="782.5" y="20.5" width="145" height="56" rx="10" `
    + `fill="${PALETTE.panel}" stroke="${PALETTE.border}"/>`);
  const stats = [
    [798, 'CHAPTER', String(view.chapter), PALETTE.accent],
    [866, 'DOTS', String(view.dots.length), PALETTE.text],
  ];
  for (const [x, label, value, color] of stats) {
    parts.push(text(x, 40, 'mono', 10, PALETTE.muted, label, ' letter-spacing="1"'));
    parts.push(text(x, 63, 'mono', 19, color, value, ' font-weight="700"'));
  }
  return parts.join('\n  ');
}

function grid() {
  const parts = [];
  const top = toPx({ x: GRID.X_MIN, y: GRID.Y_MAX }).y;
  const bottom = toPx({ x: GRID.X_MIN, y: GRID.Y_MIN }).y;

  // The two edges a connection has to join.
  for (const x of [GRID.X_MIN, GRID.X_MAX]) {
    const p = toPx({ x, y: GRID.Y_MIN });
    parts.push(`<rect x="${p.x - 20}" y="${top - 18}" width="40" height="${bottom - top + 36}" `
      + `rx="12" fill="${PALETTE.edge}"/>`);
    parts.push(text(p.x, top - 26, 'mono', 10, PALETTE.muted, 'EDGE',
      ' text-anchor="middle" letter-spacing="1.5"'));
  }

  for (let y = GRID.Y_MIN; y <= GRID.Y_MAX; y++) {
    for (let x = GRID.X_MIN; x <= GRID.X_MAX; x++) {
      const p = toPx({ x, y });
      parts.push(`<circle cx="${p.x}" cy="${p.y}" r="1.8" fill="${PALETTE.gridDot}"/>`);
    }
  }

  // Axis labels, so a player can read a coordinate straight off the board.
  for (let x = GRID.X_MIN; x <= GRID.X_MAX; x++) {
    const p = toPx({ x, y: GRID.Y_MIN });
    parts.push(text(p.x, bottom + 34, 'mono', 11, PALETTE.muted, String(x), ' text-anchor="middle"'));
  }
  const left = toPx({ x: GRID.X_MIN, y: 0 }).x;
  for (let y = GRID.Y_MIN; y <= GRID.Y_MAX; y++) {
    const p = toPx({ x: GRID.X_MIN, y });
    parts.push(text(left - 40, p.y + 4, 'mono', 11, PALETTE.muted, String(y), ' text-anchor="middle"'));
  }
  parts.push(text(left - 40, bottom + 34, 'mono', 10, PALETTE.muted, 'y/x', ' text-anchor="middle"'));

  return parts.join('\n  ');
}

function dotTitle(dot) {
  return `<title>${escapeXml(`#${dot.issue} ${dot.user || 'unknown'} (${dot.x}, ${dot.y})`)}</title>`;
}

/** A chapter still in play: just the dots, no lines. */
function scattered(view) {
  const parts = [];

  if (view.dots.length === 0) {
    const mid = toPx({ x: (GRID.X_MIN + GRID.X_MAX) / 2, y: (GRID.Y_MIN + GRID.Y_MAX) / 2 });
    parts.push(text(mid.x, mid.y + 5, 'sans', 15, PALETTE.muted,
      'open an issue to place the first dot', ' text-anchor="middle"'));
    return parts.join('\n  ');
  }

  view.dots.forEach((dot, i) => {
    const p = toPx(dot);
    const isLast = i === view.dots.length - 1;
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="${isLast ? 6.5 : 5.5}" fill="${PALETTE.dot}" `
      + `stroke="${isLast ? '#ffffff' : PALETTE.bg}" stroke-width="2">${dotTitle(dot)}</circle>`);
  });

  // Where is the next one going?
  const p = toPx(view.dots[view.dots.length - 1]);
  parts.push(`<circle class="ghost" cx="${p.x}" cy="${p.y}" r="15" fill="none" `
    + `stroke="${PALETTE.text}" stroke-width="1.2" stroke-dasharray="3 4"/>`);
  return parts.join('\n  ');
}

/** A chapter that just connected: the path traces itself edge to edge. */
function revealed(view) {
  const parts = [];
  const { path, links } = view.reveal;
  const onPath = new Set(path);

  // The rest of the hidden web, faded in once the path has finished tracing.
  const web = links
    .filter(([a, b]) => !(onPath.has(a) && onPath.has(b) && Math.abs(path.indexOf(a) - path.indexOf(b)) === 1))
    .map(([a, b]) => {
      const p = toPx(view.dots[a]);
      const q = toPx(view.dots[b]);
      return `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}"/>`;
    });
  if (web.length > 0) {
    parts.push(`<g class="web" stroke="${PALETTE.muted}" stroke-width="1" opacity="0.35">`
      + `${web.join('')}</g>`);
  }

  const pts = path.map((i) => toPx(view.dots[i]));
  parts.push(`<polyline class="trace" pathLength="1" points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}" `
    + `fill="none" stroke="${PALETTE.accent}" stroke-width="3.5" stroke-linecap="round" `
    + `stroke-linejoin="round"/>`);

  // Dots off the path stay as they were.
  view.dots.forEach((dot, i) => {
    if (onPath.has(i)) return;
    const p = toPx(dot);
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="5" fill="${PALETTE.dot}" opacity="0.55">`
      + `${dotTitle(dot)}</circle>`);
  });

  // Dots on the path light up as the trace reaches them.
  const segment = path.length > 1 ? TRACE_S / (path.length - 1) : 0;
  const last = view.dots.length - 1;
  path.forEach((i, k) => {
    const dot = view.dots[i];
    const p = toPx(dot);
    const delay = n(TRACE_DELAY_S + k * segment);
    parts.push(`<circle class="lit" style="animation-delay:${delay}s" cx="${p.x}" cy="${p.y}" `
      + `r="${i === last ? 8 : 7}" fill="${PALETTE.accent}" stroke="${i === last ? '#ffffff' : PALETTE.bg}" `
      + `stroke-width="2">${dotTitle(dot)}</circle>`);
  });

  // The missing piece.
  const p = toPx(view.dots[last]);
  parts.push(`<circle class="pulse" cx="${p.x}" cy="${p.y}" r="10" fill="none" `
    + `stroke="${PALETTE.accent}" stroke-width="2"/>`);

  return parts.join('\n  ');
}

function footer(view) {
  const y = BOARD_H - 16;
  if (view.reveal) {
    const e = view.reveal.entry;
    return text(32, y, 'sans', 13, PALETTE.accent,
      `Chapter ${e.chapter} connected: ${e.pathDots} of ${e.dots} dots, `
      + `${e.people} ${e.people === 1 ? 'person' : 'people'}, back to #${e.oldestIssue}. `
      + `Last piece by ${e.connectedBy}.`);
  }
  if (view.lastUser) {
    return text(32, y, 'mono', 11, PALETTE.muted, `last dot: #${view.lastIssue} by ${view.lastUser}`);
  }
  return '';
}

// ---------------------------------------------------------------------------
// public
// ---------------------------------------------------------------------------

function ariaLabel(view) {
  const lead = 'Connecting the dots: ';
  if (view.reveal) {
    const e = view.reveal.entry;
    return `${lead}chapter ${e.chapter} just connected. ${e.pathDots} of ${e.dots} dots turned out `
      + 'to link from the left edge of the grid to the right.';
  }
  if (view.dots.length === 0) {
    return `${lead}chapter ${view.chapter} is an empty grid waiting for its first dot.`;
  }
  return `${lead}chapter ${view.chapter} has ${view.dots.length} scattered dots and no visible connection yet.`;
}

/** Everything inside the board frame. Shared by the README board and the share card. */
function scene(view) {
  return [
    `<rect x="0" y="0" width="${BOARD_W}" height="${BOARD_H}" rx="18" fill="${PALETTE.bg}"/>`,
    `<rect x="0.5" y="0.5" width="${BOARD_W - 1}" height="${BOARD_H - 1}" rx="18" fill="none" `
      + `stroke="${PALETTE.border}"/>`,
    header(view),
    grid(),
    view.reveal ? revealed(view) : scattered(view),
    footer(view),
  ].filter(Boolean).join('\n  ');
}

/**
 * The board embedded in the README.
 * @param {object} view see buildView
 */
export function renderBoard(view) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOARD_W} ${BOARD_H}" `
      + `width="${BOARD_W}" height="${BOARD_H}" role="img" aria-label="${escapeXml(ariaLabel(view))}">`,
    `  ${STYLE}`,
    `  ${scene(view)}`,
    '</svg>',
  ].join('\n');
}

/**
 * 1200x630 card for link previews, regenerated whenever a chapter connects.
 */
export function renderShare(view) {
  const W = 1200;
  const H = 630;
  const scale = 1.1;
  const offsetX = (W - BOARD_W * scale) / 2;
  const offsetY = 24;

  const headline = view.reveal
    ? `chapter ${view.reveal.entry.chapter}: ${view.reveal.entry.pathDots} dots, connected`
    : `chapter ${view.chapter}: ${view.dots.length} dots, waiting`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" `
      + `width="${W}" height="${H}" role="img" aria-label="${escapeXml(ariaLabel(view))}">`,
    `  ${STYLE}`,
    `  <rect x="0" y="0" width="${W}" height="${H}" fill="#070c14"/>`,
    `  <g transform="translate(${offsetX} ${offsetY}) scale(${scale})">`,
    `  ${scene(view)}`,
    '  </g>',
    `  ${text(offsetX, H - 22, 'mono', 22, PALETTE.accent, headline)}`,
    `  ${text(W - offsetX, H - 22, 'mono', 22, PALETTE.text, 'github.com/taross-f', ' text-anchor="end"')}`,
    '</svg>',
  ].join('\n');
}

/**
 * Assemble the drawing input from persisted state plus the chapter's dots.
 *
 * @param {object} state  state.json contents
 * @param {object[]} dots the chapter to draw, in placement order
 * @param {{entry:object,path:number[],links:[number,number][]}|null} reveal
 *        set when the last move connected the chapter
 */
export function buildView(state, dots, reveal = null) {
  const last = dots.length > 0 ? dots[dots.length - 1] : null;

  return {
    chapter: reveal ? reveal.entry.chapter : state.chapter,
    dots: dots.map(({ x, y, issue, user }) => ({ x, y, issue, user })),
    reveal,
    connectedEntry: reveal ? reveal.entry : null,
    lastIssue: last ? last.issue : null,
    lastUser: last ? last.user : null,
  };
}
