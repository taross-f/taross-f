/**
 * The game itself: a line of dots that starts at "now" and runs into the future.
 *
 * The career up to today is fixed and already connected. Every play adds one
 * dot on the future grid and the line is drawn to it from the previous dot. The
 * moment the new stretch of line touches any earlier part of the chapter - an
 * old dot, an old segment, or the "now" dot - the dots have connected: the
 * chapter is closed and recorded, and the next play starts a fresh line from
 * "now" again.
 *
 * Coordinates are small integers, so every geometric test below is exact
 * integer arithmetic. Replaying the stored log always gives the same answer.
 */

/** The future grid. x runs left to right away from "now", y runs bottom to top. */
export const GRID = {
  X_MIN: 1,
  X_MAX: 12,
  Y_MIN: 1,
  Y_MAX: 9,
};

/** Where today sits on the grid: just left of column 1, half way up. */
export const NOW = { x: 0, y: 5 };

/**
 * The dots that are already connected. Fixed - only the future is playable.
 * `side` says which side of the line the label sits on so neighbours never
 * collide.
 */
export const CAREER = [
  { year: '2009', name: 'Sobal', role: 'SI', side: 'below' },
  { year: '2012', name: 'gloops', role: 'mobile games', side: 'above' },
  { year: '2018', name: 'REVISIO', role: 'IoT · edge AI', side: 'below' },
  { year: '2021', name: 'PKSHA', role: 'AI SaaS', side: 'above' },
  { year: '2024', name: 'Exec. Officer', role: 'AI SaaS org', side: 'below' },
];

export function inGrid(point) {
  return Number.isInteger(point.x) && Number.isInteger(point.y)
    && point.x >= GRID.X_MIN && point.x <= GRID.X_MAX
    && point.y >= GRID.Y_MIN && point.y <= GRID.Y_MAX;
}

function samePoint(a, b) {
  return a.x === b.x && a.y === b.y;
}

/** Sign of the turn a -> b -> c: 1 left, -1 right, 0 collinear. */
function orient(a, b, c) {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.sign(v);
}

/** c is collinear with a-b; is it within the segment's bounding box? */
function onSegment(a, b, c) {
  return Math.min(a.x, b.x) <= c.x && c.x <= Math.max(a.x, b.x)
    && Math.min(a.y, b.y) <= c.y && c.y <= Math.max(a.y, b.y);
}

/** Do the closed segments a-b and c-d share at least one point? */
export function segmentsTouch(a, b, c, d) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

/**
 * Would the stretch from the last dot to `next` touch the line drawn so far?
 *
 * `path` starts with NOW. The segment ending at the last dot shares that dot
 * with the new one by construction, so it only counts when the new stretch
 * doubles back along it.
 *
 * @param {{x:number,y:number}[]} path
 * @param {{x:number,y:number}} next
 * @returns {number} index of the earliest segment touched, or -1
 */
export function findConnection(path, next) {
  const last = path[path.length - 1];

  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];

    if (i === path.length - 2) {
      // Adjacent segment a -> last. Touching at `last` is just the joint;
      // folding back over it is a real connection.
      const doublesBack = orient(a, last, next) === 0
        && (a.x - last.x) * (next.x - last.x) + (a.y - last.y) * (next.y - last.y) > 0;
      if (doublesBack) return i;
    } else if (segmentsTouch(a, b, last, next)) {
      return i;
    }
  }
  return -1;
}

/**
 * Add one dot to a chapter.
 *
 * @param {{x:number,y:number}[]} dots the chapter's dots so far (NOW excluded)
 * @param {{x:number,y:number}} next
 * @returns {{ok:false,code:string}|{ok:true,connected:boolean,dots:object[]}}
 */
export function placeDot(dots, next) {
  if (!inGrid(next)) return { ok: false, code: 'off_grid' };

  const path = [NOW, ...dots];
  const last = path[path.length - 1];
  if (samePoint(last, next)) return { ok: false, code: 'same_dot' };

  const connected = findConnection(path, next) !== -1;
  return { ok: true, connected, dots: [...dots, next] };
}

/**
 * Replay a stored chapter. The stored log never contains a connecting move -
 * that move closes the chapter and clears the log - so a connection here means
 * the rules changed underneath the record.
 *
 * @param {{x:number,y:number}[]} actions
 */
export function replay(actions) {
  let dots = [];
  for (const action of actions) {
    const result = placeDot(dots, action);
    if (!result.ok || result.connected) {
      return { dots, consistent: false };
    }
    dots = result.dots;
  }
  return { dots, consistent: true };
}
