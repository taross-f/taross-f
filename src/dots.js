/**
 * The game itself: dots go down one at a time, and nobody sees them connect
 * until they do.
 *
 * Any two dots within REACH of each other (counting diagonals) are linked, but
 * the links are never drawn while a chapter is being played. The moment the
 * linked dots run all the way from the left edge of the grid to the right edge,
 * the dots have connected: the path is revealed, the chapter is recorded, and
 * the next dot starts a fresh, empty grid.
 *
 * Before the newest dot there was no such path, so every path the reveal can
 * find runs through it - the newest dot is always the missing piece.
 *
 * Coordinates are small integers and the search is a plain BFS in placement
 * order, so replaying the stored log always gives the same answer.
 */

/** The grid. x runs left to right, y runs bottom to top. */
export const GRID = {
  X_MIN: 1,
  X_MAX: 16,
  Y_MIN: 1,
  Y_MAX: 9,
};

/** How far apart two dots can be and still be linked, in grid steps. */
export const REACH = 2;

export function inGrid(point) {
  return Number.isInteger(point.x) && Number.isInteger(point.y)
    && point.x >= GRID.X_MIN && point.x <= GRID.X_MAX
    && point.y >= GRID.Y_MIN && point.y <= GRID.Y_MAX;
}

/** Linked when both axes are within REACH - a square, not a circle. */
export function linked(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= REACH;
}

/**
 * Shortest chain of linked dots from the left edge to the right edge.
 *
 * @param {{x:number,y:number}[]} dots in placement order
 * @returns {number[]|null} indices into `dots`, left edge first, or null
 */
export function findPath(dots) {
  const parent = new Map();
  const queue = [];

  dots.forEach((d, i) => {
    if (d.x === GRID.X_MIN) {
      parent.set(i, -1);
      queue.push(i);
    }
  });

  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    if (dots[i].x === GRID.X_MAX) {
      const path = [];
      for (let at = i; at !== -1; at = parent.get(at)) path.unshift(at);
      return path;
    }
    dots.forEach((d, j) => {
      if (!parent.has(j) && linked(dots[i], d)) {
        parent.set(j, i);
        queue.push(j);
      }
    });
  }
  return null;
}

/**
 * Every pair of linked dots among `indices`, so the reveal can show how much
 * was quietly connected all along.
 *
 * @returns {[number, number][]}
 */
export function linksAmong(dots, indices) {
  const links = [];
  for (let a = 0; a < indices.length; a++) {
    for (let b = a + 1; b < indices.length; b++) {
      if (linked(dots[indices[a]], dots[indices[b]])) links.push([indices[a], indices[b]]);
    }
  }
  return links;
}

/** Indices of every dot linked, directly or not, to dot `start`. */
export function componentOf(dots, start) {
  const seen = new Set([start]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    dots.forEach((d, j) => {
      if (!seen.has(j) && linked(dots[i], d)) {
        seen.add(j);
        queue.push(j);
      }
    });
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Add one dot to a chapter.
 *
 * @param {{x:number,y:number}[]} dots the chapter's dots so far
 * @param {{x:number,y:number}} next
 * @returns {{ok:false,code:string}|{ok:true,dots:object[],path:number[]|null}}
 */
export function placeDot(dots, next) {
  if (!inGrid(next)) return { ok: false, code: 'off_grid' };
  if (dots.some((d) => d.x === next.x && d.y === next.y)) return { ok: false, code: 'occupied' };

  const placed = [...dots, next];
  return { ok: true, dots: placed, path: findPath(placed) };
}

/**
 * Replay a stored chapter. The stored log never contains a connecting move -
 * that move closes the chapter and clears the log - so a path here means the
 * rules changed underneath the record.
 *
 * @param {{x:number,y:number}[]} actions
 */
export function replay(actions) {
  let dots = [];
  for (const action of actions) {
    const result = placeDot(dots, action);
    if (!result.ok || result.path) {
      return { dots, consistent: false };
    }
    dots = result.dots;
  }
  return { dots, consistent: true };
}
