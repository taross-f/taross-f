/**
 * State -> SVG. Pure string building, no I/O.
 *
 * Everything here is constrained by what GitHub actually renders in a README:
 *   - <script> is stripped, so the board has to work as a single still frame
 *     (CSS animation is fine; it is decoration only)
 *   - no external fonts, no external images, no xlink:href
 *   - prefers-color-scheme is unreliable, so the background is painted
 *     explicitly and the palette is chosen to read on light and dark alike
 */

import { CAREER, GRID, NOW } from './dots.js';

export const BOARD_W = 960;
export const BOARD_H = 500;

// Future grid geometry. Column 0 is "now"; columns X_MIN..X_MAX are playable.
const COL0_X = 464;
const COL_STEP = 36;
const ROW1_Y = 410;
const ROW_STEP = 32;

/** Grid coordinates -> board pixels. */
export function toPx(point) {
  return {
    x: COL0_X + point.x * COL_STEP,
    y: ROW1_Y - (point.y - 1) * ROW_STEP,
  };
}

const NOW_PX = toPx(NOW);

/** The past runs at an even pace up to "now", climbing gently as it goes. */
const CAREER_PX = [
  { x: 64, y: 394 },
  { x: 144, y: 362 },
  { x: 224, y: 338 },
  { x: 304, y: 314 },
  { x: 384, y: 296 },
];

const PALETTE = {
  bg: '#0d1420',
  panel: '#131c2c',
  border: '#22304d',
  gridDot: '#2e3d5c',
  text: '#e8eef9',
  body: '#c5d1e6',
  muted: '#8fa2c4',
  accent: '#ffd166',
  teal: '#5fd4c4',
  blue: '#7cb8ff',
  coral: '#ff8a7a',
};

const STYLE = `<style>
    .sans { font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, 'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic', Meiryo, sans-serif; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; }
    .pulse { transform-box: fill-box; transform-origin: center; animation: pulse 2s ease-out infinite; }
    @keyframes pulse { from { opacity: .9; transform: scale(1); } to { opacity: 0; transform: scale(2.6); } }
    .ghost { animation: blink 2.4s ease-in-out infinite both; }
    @keyframes blink { 0%, 100% { opacity: .25; } 50% { opacity: .95; } }
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

/** Each chapter gets its own hue so the history reads as distinct lines. */
export function chapterColor(chapter) {
  return `hsl(${(chapter * 47 + 30) % 360}, 85%, 66%)`;
}

function text(x, y, cls, size, fill, content, extra = '') {
  return `<text class="${cls}" x="${x}" y="${y}" font-size="${size}" fill="${fill}"${extra}>`
    + `${escapeXml(content)}</text>`;
}

function points(list) {
  return list.map((p) => `${p.x},${p.y}`).join(' ');
}

// ---------------------------------------------------------------------------
// pieces
// ---------------------------------------------------------------------------

function header(view) {
  const parts = [];
  parts.push(text(32, 40, 'mono', 12, PALETTE.accent, 'CONNECTING THE DOTS',
    ' letter-spacing="2"'));
  parts.push(text(32, 68, 'sans', 19, PALETTE.text,
    'Looking back, the dots connect. Where does the next one go?', ' font-weight="700"'));
  parts.push(text(32, 92, 'sans', 14, PALETTE.muted,
    'これまでの点はつながった。これからは点を打っていく — 次は、どこに打つ？'));

  // HUD, top right.
  parts.push(`<rect x="736.5" y="20.5" width="191" height="56" rx="10" `
    + `fill="${PALETTE.panel}" stroke="${PALETTE.border}"/>`);
  const stats = [
    [752, 'CHAPTER', String(view.chapter), chapterColor(view.chapter)],
    [818, 'DOTS', String(view.dots.length), PALETTE.text],
    [872, 'BEST', String(view.best), PALETTE.accent],
  ];
  for (const [x, label, value, color] of stats) {
    parts.push(text(x, 40, 'mono', 10, PALETTE.muted, label, ' letter-spacing="1"'));
    parts.push(text(x, 63, 'mono', 19, color, value, ' font-weight="700"'));
  }
  return parts.join('\n  ');
}

function past() {
  const parts = [];
  const line = [...CAREER_PX, NOW_PX];

  parts.push(text(32, 146, 'mono', 11, PALETTE.muted, 'PAST · CONNECTED', ' letter-spacing="1.5"'));
  parts.push(`<polyline points="${points(line)}" fill="none" stroke="url(#past)" `
    + `stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`);

  CAREER.forEach((dot, i) => {
    const p = CAREER_PX[i];
    const below = dot.side === 'below';
    const [yearY, nameY, roleY] = below
      ? [p.y + 22, p.y + 38, p.y + 52]
      : [p.y - 44, p.y - 28, p.y - 14];
    const mid = ' text-anchor="middle"';

    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="6" fill="${PALETTE.bg}" `
      + `stroke="${PALETTE.teal}" stroke-width="3"><title>${escapeXml(
        `${dot.year} ${dot.name} — ${dot.role}`,
      )}</title></circle>`);
    parts.push(text(p.x, yearY, 'mono', 11, PALETTE.muted, dot.year, mid));
    parts.push(text(p.x, nameY, 'sans', 13, PALETTE.text, dot.name, `${mid} font-weight="600"`));
    parts.push(text(p.x, roleY, 'sans', 11, PALETTE.muted, dot.role, mid));
  });

  return parts.join('\n  ');
}

function futureGrid() {
  const parts = [];
  const top = toPx({ x: 0, y: GRID.Y_MAX }).y;
  const bottom = toPx({ x: 0, y: GRID.Y_MIN }).y;

  parts.push(text(toPx({ x: GRID.X_MIN, y: 0 }).x - 6, 146, 'mono', 11, PALETTE.accent,
    'FUTURE · YOUR MOVE', ' letter-spacing="1.5"'));

  // The line between what is done and what is not.
  parts.push(`<line x1="${NOW_PX.x}" y1="${top - 10}" x2="${NOW_PX.x}" y2="${bottom + 10}" `
    + `stroke="${PALETTE.border}" stroke-width="1.5" stroke-dasharray="3 5"/>`);

  for (let y = GRID.Y_MIN; y <= GRID.Y_MAX; y++) {
    for (let x = GRID.X_MIN; x <= GRID.X_MAX; x++) {
      const p = toPx({ x, y });
      parts.push(`<circle cx="${p.x}" cy="${p.y}" r="1.8" fill="${PALETTE.gridDot}"/>`);
    }
  }

  // Axis labels, so a player can read a coordinate straight off the board.
  for (let x = GRID.X_MIN; x <= GRID.X_MAX; x++) {
    const p = toPx({ x, y: GRID.Y_MIN });
    parts.push(text(p.x, bottom + 26, 'mono', 11, PALETTE.muted, String(x), ' text-anchor="middle"'));
  }
  const right = toPx({ x: GRID.X_MAX, y: 0 }).x;
  for (let y = GRID.Y_MIN; y <= GRID.Y_MAX; y++) {
    const p = toPx({ x: 0, y });
    parts.push(text(right + 22, p.y + 4, 'mono', 11, PALETTE.muted, String(y), ' text-anchor="middle"'));
  }
  parts.push(text(right + 22, bottom + 26, 'mono', 10, PALETTE.muted, 'x/y', ' text-anchor="middle"'));

  return parts.join('\n  ');
}

function futureLine(view) {
  const parts = [];
  const color = chapterColor(view.chapter);
  const line = [NOW_PX, ...view.dots.map(toPx)];

  if (view.dots.length === 0) {
    const mid = toPx({ x: (GRID.X_MIN + GRID.X_MAX) / 2, y: GRID.Y_MAX - 0.5 });
    parts.push(text(mid.x, mid.y, 'sans', 14, PALETTE.muted,
      'open an issue to place the first dot', ' text-anchor="middle"'));
  } else {
    parts.push(`<polyline points="${points(line)}" fill="none" stroke="${color}" `
      + `stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`);
  }

  view.dots.forEach((dot, i) => {
    const p = toPx(dot);
    const isLast = i === view.dots.length - 1;
    const title = `#${dot.issue} ${dot.user || 'unknown'} (${dot.x}, ${dot.y})`;
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="${isLast ? 6.5 : 5}" fill="${color}" `
      + `stroke="${isLast ? '#ffffff' : PALETTE.bg}" stroke-width="2">`
      + `<title>${escapeXml(title)}</title></circle>`);
  });

  if (view.connected) {
    // The dot that closed the chapter.
    const p = toPx(view.dots[view.dots.length - 1]);
    parts.push(`<circle class="pulse" cx="${p.x}" cy="${p.y}" r="9" fill="none" `
      + `stroke="${color}" stroke-width="2"/>`);
  } else if (view.dots.length > 0) {
    // An open end: the next dot is somebody else's to place.
    const p = toPx(view.dots[view.dots.length - 1]);
    parts.push(`<circle class="ghost" cx="${p.x}" cy="${p.y}" r="14" fill="none" `
      + `stroke="${PALETTE.text}" stroke-width="1.2" stroke-dasharray="3 4"/>`);
    parts.push(text(p.x + 18, p.y - 12, 'sans ghost', 13, PALETTE.text, '?', ' font-weight="700"'));
  }

  return parts.join('\n  ');
}

function now(view) {
  const parts = [];
  // "now" pulses until somebody draws the line onward from it.
  if (view.dots.length === 0) {
    parts.push(`<circle class="pulse" cx="${NOW_PX.x}" cy="${NOW_PX.y}" r="9" fill="none" `
      + `stroke="${PALETTE.accent}" stroke-width="2"/>`);
  }
  parts.push(`<circle cx="${NOW_PX.x}" cy="${NOW_PX.y}" r="8" fill="${PALETTE.accent}">`
    + `<title>now — PKSHA Technology, Engineering Manager · FDE</title></circle>`);
  // Labelled up and to the left, the one corner the future line never reaches.
  const end = ' text-anchor="end"';
  parts.push(text(NOW_PX.x - 12, NOW_PX.y - 44, 'mono', 11, PALETTE.accent, 'NOW', `${end} font-weight="700"`));
  parts.push(text(NOW_PX.x - 12, NOW_PX.y - 28, 'sans', 13, PALETTE.text, 'EM · FDE', `${end} font-weight="600"`));
  parts.push(text(NOW_PX.x - 12, NOW_PX.y - 14, 'sans', 11, PALETTE.muted, 'PKSHA', end));
  return parts.join('\n  ');
}

function footer(view) {
  if (view.connectedEntry) {
    const c = view.connectedEntry;
    return text(32, BOARD_H - 18, 'sans', 13, PALETTE.coral,
      `Chapter ${c.chapter} connected at ${c.dots} dots — closed by ${c.connectedBy}. `
      + 'The next dot starts a new line from now.');
  }
  if (view.lastUser) {
    return text(32, BOARD_H - 18, 'mono', 11, PALETTE.muted,
      `last dot: #${view.lastIssue} by ${view.lastUser}`);
  }
  return '';
}

// ---------------------------------------------------------------------------
// public
// ---------------------------------------------------------------------------

function ariaLabel(view) {
  const lead = 'Connecting the dots: a career line from 2009 to now, and a future grid. ';
  if (view.connectedEntry) {
    return `${lead}Chapter ${view.connectedEntry.chapter} just connected at `
      + `${view.connectedEntry.dots} dots. Best ever ${view.best} dots.`;
  }
  if (view.dots.length === 0) {
    return `${lead}Chapter ${view.chapter} is waiting for its first dot.`;
  }
  return `${lead}Chapter ${view.chapter}: ${view.dots.length} dots placed without the line `
    + `touching itself. Best ever ${view.best} dots.`;
}

/** Everything inside the board frame. Shared by the README board and the share card. */
function scene(view) {
  return [
    `<rect x="0" y="0" width="${BOARD_W}" height="${BOARD_H}" rx="18" fill="${PALETTE.bg}"/>`,
    `<rect x="0.5" y="0.5" width="${BOARD_W - 1}" height="${BOARD_H - 1}" rx="18" fill="none" `
      + `stroke="${PALETTE.border}"/>`,
    header(view),
    past(),
    futureGrid(),
    futureLine(view),
    now(view),
    footer(view),
  ].filter(Boolean).join('\n  ');
}

const DEFS = `<defs>
    <linearGradient id="past" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${PALETTE.blue}"/>
      <stop offset="0.5" stop-color="${PALETTE.teal}"/>
      <stop offset="1" stop-color="${PALETTE.accent}"/>
    </linearGradient>
  </defs>`;

/**
 * The board embedded in the README.
 * @param {object} view see buildView
 */
export function renderBoard(view) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOARD_W} ${BOARD_H}" `
      + `width="${BOARD_W}" height="${BOARD_H}" role="img" aria-label="${escapeXml(ariaLabel(view))}">`,
    `  ${STYLE}`,
    `  ${DEFS}`,
    `  ${scene(view)}`,
    '</svg>',
  ].join('\n');
}

/**
 * 1200x630 card for link previews, regenerated whenever the record moves or a
 * chapter connects.
 */
export function renderShare(view) {
  const W = 1200;
  const H = 630;
  const scale = 1.1;
  const offsetX = (W - BOARD_W * scale) / 2;
  const offsetY = 24;

  const headline = view.connectedEntry
    ? `chapter ${view.connectedEntry.chapter}: ${view.connectedEntry.dots} dots, connected`
    : `chapter ${view.chapter}: ${view.dots.length} dots and counting`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" `
      + `width="${W}" height="${H}" role="img" aria-label="${escapeXml(ariaLabel(view))}">`,
    `  ${STYLE}`,
    `  ${DEFS}`,
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
 * Assemble the drawing input from persisted state plus the replayed chapter.
 *
 * @param {object} state   state.json contents
 * @param {object[]} dots  the chapter to draw
 * @param {object|null} connectedEntry hall-of-fame entry to call out, if the
 *        last move closed a chapter
 */
export function buildView(state, dots, connectedEntry = null) {
  const best = state.hallOfFame.reduce((max, e) => (e.dots > max ? e.dots : max), 0);
  const last = dots.length > 0 ? dots[dots.length - 1] : null;

  return {
    chapter: connectedEntry ? connectedEntry.chapter : state.chapter,
    dots: dots.map(({ x, y, issue, user }) => ({ x, y, issue, user })),
    best: Math.max(best, connectedEntry ? 0 : dots.length),
    connected: Boolean(connectedEntry),
    connectedEntry,
    lastIssue: last ? last.issue : null,
    lastUser: last ? last.user : null,
  };
}
