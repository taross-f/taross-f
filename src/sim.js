/**
 * Deterministic 2D rigid body simulation for the shared tower game.
 *
 * Scope is intentionally tiny: axis-agnostic rectangles (OBBs) only, one static
 * ground, gravity, and an impulse solver. The contact generation and solver
 * follow the classic box2d-lite formulation (SAT + reference/incident face
 * clipping + accumulated impulses with Baumgarte bias).
 *
 * Determinism rules observed throughout this file:
 *   - fixed timestep, fixed iteration count
 *   - every accumulation loop walks arrays by ascending index
 *   - no Set/Map iteration order is ever observable in the results
 *     (a Map is used for arbiter lookup only, never iterated)
 *   - no Math.random()
 */

import { createRng, seedFromIssue } from './rng.js';

export const WORLD = Object.freeze({
  WIDTH: 480,
  HEIGHT: 270,
  GROUND_Y: 250,
  GROUND_LEFT: 140,
  GROUND_RIGHT: 340,
  SPAWN_Y: -40,

  DT: 1 / 120,
  GRAVITY: 900,
  RESTITUTION: 0.05,
  FRICTION: 0.55,
  ITERATIONS: 8,

  MAX_STEPS: 3600,
  REST_STEPS: 30,
  REST_LINEAR: 0.5,
  REST_ANGULAR: 0.01,
  SLEEP_STEPS: 45,

  COLLAPSE_DROP: 20,

  // A stack of perfectly rigid boxes has no way to shed the energy in a sway
  // mode: static friction does no work and contacts are already inelastic, so
  // the tower rocks forever and never reaches the rest thresholds.
  //
  // Damping supplies the missing dissipation, but only for bodies that are
  // actually touching something - that is where a real material would lose the
  // energy. A block in free fall is left alone, so the drop keeps its full
  // gravitational speed and the game still feels like gravity.
  LINEAR_DAMPING: 1.6,
  ANGULAR_DAMPING: 3.0,

  BIAS_FACTOR: 0.1,
  ALLOWED_PENETRATION: 0.01,
  // Penetration recovery runs on a separate set of "bias" velocities that feed
  // position integration only, never the real velocities (split impulse). A
  // plain Baumgarte term would turn every 6px/step landing into a bounce and
  // the tower would never settle. The cap keeps recovery to ~1px per step.
  MAX_BIAS_VELOCITY: 120,
  RESTITUTION_THRESHOLD: 20,
  // Contact points are kept in the manifold while they are within this distance
  // rather than only while overlapping. A resting box tilts by a fraction of a
  // degree constantly; without this its manifold flickers between two points
  // and one, and the whole stack rocks itself apart. Points with a real gap are
  // held speculatively - they only ever resist closing the gap faster than one
  // step's worth of motion.
  SPECULATIVE_DISTANCE: 1.0,
});

export const X_MIN = WORLD.GROUND_LEFT;
export const X_MAX = WORLD.GROUND_RIGHT;

// ---------------------------------------------------------------------------
// block shape
// ---------------------------------------------------------------------------

/**
 * The block a given issue number produces. Players cannot choose their shape;
 * it falls out of the issue number, which makes it both fair and replayable.
 */
export function blockSpec(issueNumber) {
  const rng = createRng(seedFromIssue(issueNumber));
  // Draw order is part of the contract - never reorder these three lines.
  const w = rng.intRange(24, 56);
  const h = rng.intRange(14, 28);
  const angle = rng.range(-0.12, 0.12);
  return { w, h, angle };
}

// ---------------------------------------------------------------------------
// bodies
// ---------------------------------------------------------------------------

function makeBody(props) {
  const b = {
    x: 0,
    y: 0,
    angle: 0,
    vx: 0,
    vy: 0,
    omega: 0,
    // Pseudo velocities used only to push overlapping bodies apart. Reset every
    // step; they move positions but carry no momentum.
    bvx: 0,
    bvy: 0,
    bomega: 0,
    w: 1,
    h: 1,
    invMass: 0,
    invI: 0,
    static: false,
    asleep: false,
    sleepTimer: 0,
    issue: 0,
    user: '',
    turn: -1,
    ...props,
  };
  if (!b.static) {
    const mass = b.w * b.h; // density is a flat 1.0
    b.invMass = 1 / mass;
    b.invI = 1 / (mass * (b.w * b.w + b.h * b.h) / 12);
  }
  return b;
}

function cloneBody(b) {
  return { ...b };
}

/** Corner positions of a body, in local order (--, +-, ++, -+). */
export function corners(b) {
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  const hx = b.w / 2;
  const hy = b.h / 2;
  const out = [];
  const local = [
    [-hx, -hy],
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
  ];
  for (let i = 0; i < local.length; i++) {
    const lx = local[i][0];
    const ly = local[i][1];
    out.push({ x: b.x + c * lx - s * ly, y: b.y + s * lx + c * ly });
  }
  return out;
}

// ---------------------------------------------------------------------------
// world
// ---------------------------------------------------------------------------

export function createWorld() {
  const groundW = WORLD.GROUND_RIGHT - WORLD.GROUND_LEFT;
  const groundH = 40;
  const ground = makeBody({
    x: (WORLD.GROUND_LEFT + WORLD.GROUND_RIGHT) / 2,
    y: WORLD.GROUND_Y + groundH / 2,
    w: groundW,
    h: groundH,
    static: true,
    asleep: true,
  });
  return { bodies: [ground], arbiters: [], steps: 0 };
}

function cloneWorld(world) {
  return {
    bodies: world.bodies.map(cloneBody),
    // Arbiters hold warm-start impulses tied to the previous step only; a fresh
    // turn re-derives them, so they are deliberately not carried across clones.
    arbiters: [],
    steps: world.steps,
  };
}

/** Dynamic (player-dropped) bodies, ground excluded. */
export function blocks(world) {
  return world.bodies.filter((b) => !b.static);
}

/** Tower height: topmost corner of any block, measured up from the ground. */
export function towerHeight(world) {
  let minY = Infinity;
  for (let i = 0; i < world.bodies.length; i++) {
    const b = world.bodies[i];
    if (b.static) continue;
    const cs = corners(b);
    for (let k = 0; k < cs.length; k++) {
      if (cs[k].y < minY) minY = cs[k].y;
    }
  }
  if (minY === Infinity) return 0;
  const h = WORLD.GROUND_Y - minY;
  return h > 0 ? h : 0;
}

// ---------------------------------------------------------------------------
// collision: SAT for oriented boxes + face clipping
// ---------------------------------------------------------------------------

const FACE_A_X = 0;
const FACE_A_Y = 1;
const FACE_B_X = 2;
const FACE_B_Y = 3;

const NO_EDGE = 0;
const EDGE1 = 1;
const EDGE2 = 2;
const EDGE3 = 3;
const EDGE4 = 4;

function featureValue(inEdge1, outEdge1, inEdge2, outEdge2) {
  return inEdge1 | (outEdge1 << 8) | (inEdge2 << 16) | (outEdge2 << 24);
}

function flipFeature(f) {
  return { inEdge1: f.inEdge2, outEdge1: f.outEdge2, inEdge2: f.inEdge1, outEdge2: f.outEdge1 };
}

function computeIncidentEdge(hx, hy, px, py, cos, sin, nx, ny) {
  // Rotate the reference normal into the incident body's local frame.
  const lx = -(cos * nx + sin * ny);
  const ly = -(-sin * nx + cos * ny);
  const ax = Math.abs(lx);
  const ay = Math.abs(ly);

  let v0x;
  let v0y;
  let v1x;
  let v1y;
  let f0;
  let f1;

  if (ax > ay) {
    if (lx > 0) {
      v0x = hx; v0y = -hy; f0 = { inEdge1: NO_EDGE, outEdge1: NO_EDGE, inEdge2: EDGE3, outEdge2: EDGE4 };
      v1x = hx; v1y = hy; f1 = { inEdge1: NO_EDGE, outEdge1: NO_EDGE, inEdge2: EDGE4, outEdge2: EDGE1 };
    } else {
      v0x = -hx; v0y = hy; f0 = { inEdge1: NO_EDGE, outEdge1: NO_EDGE, inEdge2: EDGE1, outEdge2: EDGE2 };
      v1x = -hx; v1y = -hy; f1 = { inEdge1: NO_EDGE, outEdge1: NO_EDGE, inEdge2: EDGE2, outEdge2: EDGE3 };
    }
  } else {
    if (ly > 0) {
      v0x = hx; v0y = hy; f0 = { inEdge1: NO_EDGE, outEdge1: NO_EDGE, inEdge2: EDGE4, outEdge2: EDGE1 };
      v1x = -hx; v1y = hy; f1 = { inEdge1: NO_EDGE, outEdge1: NO_EDGE, inEdge2: EDGE1, outEdge2: EDGE2 };
    } else {
      v0x = -hx; v0y = -hy; f0 = { inEdge1: NO_EDGE, outEdge1: NO_EDGE, inEdge2: EDGE2, outEdge2: EDGE3 };
      v1x = hx; v1y = -hy; f1 = { inEdge1: NO_EDGE, outEdge1: NO_EDGE, inEdge2: EDGE3, outEdge2: EDGE4 };
    }
  }

  return [
    { x: px + cos * v0x - sin * v0y, y: py + sin * v0x + cos * v0y, f: f0 },
    { x: px + cos * v1x - sin * v1y, y: py + sin * v1x + cos * v1y, f: f1 },
  ];
}

function clipSegmentToLine(vIn, nx, ny, offset, clipEdge) {
  const out = [];
  const d0 = nx * vIn[0].x + ny * vIn[0].y - offset;
  const d1 = nx * vIn[1].x + ny * vIn[1].y - offset;

  if (d0 <= 0) out.push(vIn[0]);
  if (d1 <= 0) out.push(vIn[1]);

  if (d0 * d1 < 0) {
    const interp = d0 / (d0 - d1);
    const p = {
      x: vIn[0].x + interp * (vIn[1].x - vIn[0].x),
      y: vIn[0].y + interp * (vIn[1].y - vIn[0].y),
      f: null,
    };
    if (d0 > 0) {
      p.f = { ...vIn[0].f, inEdge1: clipEdge, inEdge2: NO_EDGE };
    } else {
      p.f = { ...vIn[1].f, outEdge1: clipEdge, outEdge2: NO_EDGE };
    }
    out.push(p);
  }
  return out;
}

/**
 * Contact manifold between two oriented boxes. Normal points from A to B.
 * @returns {Array<{x:number,y:number,nx:number,ny:number,separation:number,feature:number}>}
 */
export function collide(A, B) {
  const hAx = A.w / 2;
  const hAy = A.h / 2;
  const hBx = B.w / 2;
  const hBy = B.h / 2;

  const cA = Math.cos(A.angle);
  const sA = Math.sin(A.angle);
  const cB = Math.cos(B.angle);
  const sB = Math.sin(B.angle);

  const dpx = B.x - A.x;
  const dpy = B.y - A.y;

  // dp expressed in A's and B's frames.
  const dAx = cA * dpx + sA * dpy;
  const dAy = -sA * dpx + cA * dpy;
  const dBx = cB * dpx + sB * dpy;
  const dBy = -sB * dpx + cB * dpy;

  // C = Rot(A)^T * Rot(B)
  const c11 = cA * cB + sA * sB;
  const c12 = cA * -sB + sA * cB;
  const c21 = -sA * cB + cA * sB;
  const c22 = -sA * -sB + cA * cB;

  const a11 = Math.abs(c11);
  const a12 = Math.abs(c12);
  const a21 = Math.abs(c21);
  const a22 = Math.abs(c22);

  // Separation along A's face normals.
  const faceAx = Math.abs(dAx) - hAx - (a11 * hBx + a12 * hBy);
  const faceAy = Math.abs(dAy) - hAy - (a21 * hBx + a22 * hBy);
  if (faceAx > 0 || faceAy > 0) return [];

  // Separation along B's face normals (absC transposed).
  const faceBx = Math.abs(dBx) - (a11 * hAx + a21 * hAy) - hBx;
  const faceBy = Math.abs(dBy) - (a12 * hAx + a22 * hAy) - hBy;
  if (faceBx > 0 || faceBy > 0) return [];

  // Pick the axis of least penetration, biased towards keeping the previous
  // choice so the manifold does not flicker between faces frame to frame.
  const RELATIVE_TOL = 0.95;
  const ABSOLUTE_TOL = 0.01;

  let axis = FACE_A_X;
  let separation = faceAx;
  let nx = dAx > 0 ? cA : -cA;
  let ny = dAx > 0 ? sA : -sA;

  if (faceAy > RELATIVE_TOL * separation + ABSOLUTE_TOL * hAy) {
    axis = FACE_A_Y;
    separation = faceAy;
    nx = dAy > 0 ? -sA : sA;
    ny = dAy > 0 ? cA : -cA;
  }
  if (faceBx > RELATIVE_TOL * separation + ABSOLUTE_TOL * hBx) {
    axis = FACE_B_X;
    separation = faceBx;
    nx = dBx > 0 ? cB : -cB;
    ny = dBx > 0 ? sB : -sB;
  }
  if (faceBy > RELATIVE_TOL * separation + ABSOLUTE_TOL * hBy) {
    axis = FACE_B_Y;
    separation = faceBy;
    nx = dBy > 0 ? -sB : sB;
    ny = dBy > 0 ? cB : -cB;
  }

  let frontNx;
  let frontNy;
  let sideNx;
  let sideNy;
  let front;
  let negSide;
  let posSide;
  let negEdge;
  let posEdge;
  let incident;

  if (axis === FACE_A_X) {
    frontNx = nx; frontNy = ny;
    front = A.x * frontNx + A.y * frontNy + hAx;
    sideNx = -sA; sideNy = cA;
    const side = A.x * sideNx + A.y * sideNy;
    negSide = -side + hAy;
    posSide = side + hAy;
    negEdge = EDGE3; posEdge = EDGE1;
    incident = computeIncidentEdge(hBx, hBy, B.x, B.y, cB, sB, frontNx, frontNy);
  } else if (axis === FACE_A_Y) {
    frontNx = nx; frontNy = ny;
    front = A.x * frontNx + A.y * frontNy + hAy;
    sideNx = cA; sideNy = sA;
    const side = A.x * sideNx + A.y * sideNy;
    negSide = -side + hAx;
    posSide = side + hAx;
    negEdge = EDGE2; posEdge = EDGE4;
    incident = computeIncidentEdge(hBx, hBy, B.x, B.y, cB, sB, frontNx, frontNy);
  } else if (axis === FACE_B_X) {
    frontNx = -nx; frontNy = -ny;
    front = B.x * frontNx + B.y * frontNy + hBx;
    sideNx = -sB; sideNy = cB;
    const side = B.x * sideNx + B.y * sideNy;
    negSide = -side + hBy;
    posSide = side + hBy;
    negEdge = EDGE3; posEdge = EDGE1;
    incident = computeIncidentEdge(hAx, hAy, A.x, A.y, cA, sA, frontNx, frontNy);
  } else {
    frontNx = -nx; frontNy = -ny;
    front = B.x * frontNx + B.y * frontNy + hBy;
    sideNx = cB; sideNy = sB;
    const side = B.x * sideNx + B.y * sideNy;
    negSide = -side + hBx;
    posSide = side + hBx;
    negEdge = EDGE2; posEdge = EDGE4;
    incident = computeIncidentEdge(hAx, hAy, A.x, A.y, cA, sA, frontNx, frontNy);
  }

  const clip1 = clipSegmentToLine(incident, -sideNx, -sideNy, negSide, negEdge);
  if (clip1.length < 2) return [];
  const clip2 = clipSegmentToLine(clip1, sideNx, sideNy, posSide, posEdge);
  if (clip2.length < 2) return [];

  const flip = axis === FACE_B_X || axis === FACE_B_Y;
  const contacts = [];
  for (let i = 0; i < 2; i++) {
    const p = clip2[i];
    const sep = frontNx * p.x + frontNy * p.y - front;
    if (sep <= WORLD.SPECULATIVE_DISTANCE) {
      const f = flip ? flipFeature(p.f) : p.f;
      contacts.push({
        x: p.x - sep * frontNx,
        y: p.y - sep * frontNy,
        nx,
        ny,
        separation: sep,
        feature: featureValue(f.inEdge1, f.outEdge1, f.inEdge2, f.outEdge2),
      });
    }
  }
  return contacts;
}

// ---------------------------------------------------------------------------
// solver
// ---------------------------------------------------------------------------

function atRest(b) {
  return b.static || b.asleep;
}

function aabbOverlap(a, b) {
  // Conservative radius: half the diagonal, valid at any rotation.
  const ra = Math.sqrt(a.w * a.w + a.h * a.h) / 2;
  const rb = Math.sqrt(b.w * b.w + b.h * b.h) / 2;
  const r = ra + rb;
  return Math.abs(a.x - b.x) <= r && Math.abs(a.y - b.y) <= r;
}

function broadPhase(world) {
  const bodies = world.bodies;
  const previous = new Map();
  for (let i = 0; i < world.arbiters.length; i++) {
    const arb = world.arbiters[i];
    previous.set(arb.a * 1024 + arb.b, arb);
  }

  for (let i = 0; i < bodies.length; i++) bodies[i].inContact = false;

  const next = [];
  // Ascending index order, always. The solver consumes this array in order, so
  // its ordering is part of the deterministic contract.
  for (let i = 0; i < bodies.length; i++) {
    const A = bodies[i];
    for (let j = i + 1; j < bodies.length; j++) {
      const B = bodies[j];
      if (A.invMass === 0 && B.invMass === 0) continue;
      if (atRest(A) && atRest(B)) continue;
      if (!aabbOverlap(A, B)) continue;

      const contacts = collide(A, B);
      if (contacts.length === 0) continue;

      A.inContact = true;
      B.inContact = true;

      // A moving body wakes whatever it touches, but a body already at rest
      // must not have its own sleep timer reset just for being in contact -
      // otherwise nothing in a settled tower ever sleeps.
      if (!A.static && !A.asleep && !B.static && B.asleep) {
        B.asleep = false;
        B.sleepTimer = 0;
      }
      if (!B.static && !B.asleep && !A.static && A.asleep) {
        A.asleep = false;
        A.sleepTimer = 0;
      }

      const key = i * 1024 + j;
      const old = previous.get(key);
      if (old) {
        // Warm start: carry accumulated impulses across on matching features.
        for (let c = 0; c < contacts.length; c++) {
          const nc = contacts[c];
          nc.Pn = 0;
          nc.Pt = 0;
          for (let o = 0; o < old.contacts.length; o++) {
            if (old.contacts[o].feature === nc.feature) {
              nc.Pn = old.contacts[o].Pn;
              nc.Pt = old.contacts[o].Pt;
              break;
            }
          }
        }
      } else {
        for (let c = 0; c < contacts.length; c++) {
          contacts[c].Pn = 0;
          contacts[c].Pt = 0;
        }
      }

      next.push({ a: i, b: j, contacts });
    }
  }
  world.arbiters = next;
}

function preStep(world, invDt) {
  const bodies = world.bodies;

  // Pass 1: geometry, effective masses, and the restitution target.
  //
  // Restitution has to be captured from the approach velocities as they are at
  // the top of the step. Reading them after warm-start impulses have been
  // applied lets a resting contact latch onto a bogus bounce target and hold a
  // permanent residual velocity, which stops the tower ever settling.
  for (let i = 0; i < world.arbiters.length; i++) {
    const arb = world.arbiters[i];
    const A = bodies[arb.a];
    const B = bodies[arb.b];

    for (let k = 0; k < arb.contacts.length; k++) {
      const c = arb.contacts[k];
      c.Pnb = 0;

      const r1x = c.x - A.x;
      const r1y = c.y - A.y;
      const r2x = c.x - B.x;
      const r2y = c.y - B.y;
      c.r1x = r1x; c.r1y = r1y;
      c.r2x = r2x; c.r2y = r2y;

      const rn1 = r1x * c.nx + r1y * c.ny;
      const rn2 = r2x * c.nx + r2y * c.ny;
      let kNormal = A.invMass + B.invMass;
      kNormal += A.invI * (r1x * r1x + r1y * r1y - rn1 * rn1);
      kNormal += B.invI * (r2x * r2x + r2y * r2y - rn2 * rn2);
      c.massNormal = 1 / kNormal;

      const tx = c.ny;
      const ty = -c.nx;
      const rt1 = r1x * tx + r1y * ty;
      const rt2 = r2x * tx + r2y * ty;
      let kTangent = A.invMass + B.invMass;
      kTangent += A.invI * (r1x * r1x + r1y * r1y - rt1 * rt1);
      kTangent += B.invI * (r2x * r2x + r2y * r2y - rt2 * rt2);
      c.massTangent = 1 / kTangent;

      c.bias = Math.min(
        -WORLD.BIAS_FACTOR * invDt * Math.min(0, c.separation + WORLD.ALLOWED_PENETRATION),
        WORLD.MAX_BIAS_VELOCITY,
      );

      // At e=0.05 this only takes the edge off hard landings; nothing is bouncy.
      const dvx = B.vx - B.omega * r2y - (A.vx - A.omega * r1y);
      const dvy = B.vy + B.omega * r2x - (A.vy + A.omega * r1x);
      const vn = dvx * c.nx + dvy * c.ny;
      const restitution = vn < -WORLD.RESTITUTION_THRESHOLD ? -WORLD.RESTITUTION * vn : 0;

      // Relative normal velocity the solver aims for. A touching point should
      // stop approaching (or separate slightly, if restitution applies); a point
      // still holding a gap may close it, but no faster than one step's worth.
      c.target = c.separation > 0 ? -c.separation * invDt : restitution;
    }
  }

  // Pass 2: warm start from the impulses the previous step converged on.
  for (let i = 0; i < world.arbiters.length; i++) {
    const arb = world.arbiters[i];
    const A = bodies[arb.a];
    const B = bodies[arb.b];

    for (let k = 0; k < arb.contacts.length; k++) {
      const c = arb.contacts[k];
      const px = c.Pn * c.nx + c.Pt * c.ny;
      const py = c.Pn * c.ny + c.Pt * -c.nx;
      A.vx -= A.invMass * px;
      A.vy -= A.invMass * py;
      A.omega -= A.invI * (c.r1x * py - c.r1y * px);
      B.vx += B.invMass * px;
      B.vy += B.invMass * py;
      B.omega += B.invI * (c.r2x * py - c.r2y * px);
    }
  }
}

function applyImpulses(world) {
  const bodies = world.bodies;
  for (let i = 0; i < world.arbiters.length; i++) {
    const arb = world.arbiters[i];
    const A = bodies[arb.a];
    const B = bodies[arb.b];

    for (let k = 0; k < arb.contacts.length; k++) {
      const c = arb.contacts[k];

      // normal
      let dvx = B.vx - B.omega * c.r2y - (A.vx - A.omega * c.r1y);
      let dvy = B.vy + B.omega * c.r2x - (A.vy + A.omega * c.r1x);
      const vn = dvx * c.nx + dvy * c.ny;

      let dPn = c.massNormal * (c.target - vn);
      const pn0 = c.Pn;
      c.Pn = Math.max(pn0 + dPn, 0);
      dPn = c.Pn - pn0;

      const pnx = dPn * c.nx;
      const pny = dPn * c.ny;
      A.vx -= A.invMass * pnx;
      A.vy -= A.invMass * pny;
      A.omega -= A.invI * (c.r1x * pny - c.r1y * pnx);
      B.vx += B.invMass * pnx;
      B.vy += B.invMass * pny;
      B.omega += B.invI * (c.r2x * pny - c.r2y * pnx);

      // Penetration recovery, solved against the pseudo velocities so the
      // push-out never shows up as momentum.
      const dbvx = B.bvx - B.bomega * c.r2y - (A.bvx - A.bomega * c.r1y);
      const dbvy = B.bvy + B.bomega * c.r2x - (A.bvy + A.bomega * c.r1x);
      const vnb = dbvx * c.nx + dbvy * c.ny;

      let dPnb = c.massNormal * (-vnb + c.bias);
      const pnb0 = c.Pnb;
      c.Pnb = Math.max(pnb0 + dPnb, 0);
      dPnb = c.Pnb - pnb0;

      const pbx = dPnb * c.nx;
      const pby = dPnb * c.ny;
      A.bvx -= A.invMass * pbx;
      A.bvy -= A.invMass * pby;
      A.bomega -= A.invI * (c.r1x * pby - c.r1y * pbx);
      B.bvx += B.invMass * pbx;
      B.bvy += B.invMass * pby;
      B.bomega += B.invI * (c.r2x * pby - c.r2y * pbx);

      // friction
      dvx = B.vx - B.omega * c.r2y - (A.vx - A.omega * c.r1y);
      dvy = B.vy + B.omega * c.r2x - (A.vy + A.omega * c.r1x);
      const tx = c.ny;
      const ty = -c.nx;
      const vt = dvx * tx + dvy * ty;

      let dPt = c.massTangent * -vt;
      const maxPt = WORLD.FRICTION * c.Pn;
      const pt0 = c.Pt;
      c.Pt = Math.min(Math.max(pt0 + dPt, -maxPt), maxPt);
      dPt = c.Pt - pt0;

      const ptx = dPt * tx;
      const pty = dPt * ty;
      A.vx -= A.invMass * ptx;
      A.vy -= A.invMass * pty;
      A.omega -= A.invI * (c.r1x * pty - c.r1y * ptx);
      B.vx += B.invMass * ptx;
      B.vy += B.invMass * pty;
      B.omega += B.invI * (c.r2x * pty - c.r2y * ptx);
    }
  }
}

/** Advance the world by exactly one fixed timestep. */
export function step(world) {
  const dt = WORLD.DT;
  const invDt = 1 / dt;
  const bodies = world.bodies;

  broadPhase(world);

  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    b.bvx = 0;
    b.bvy = 0;
    b.bomega = 0;
    if (b.static || b.asleep) continue;
    b.vy += WORLD.GRAVITY * dt;
    if (b.inContact) {
      b.vx /= 1 + dt * WORLD.LINEAR_DAMPING;
      b.vy /= 1 + dt * WORLD.LINEAR_DAMPING;
      b.omega /= 1 + dt * WORLD.ANGULAR_DAMPING;
    }
  }

  preStep(world, invDt);

  for (let it = 0; it < WORLD.ITERATIONS; it++) {
    applyImpulses(world);
  }

  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (b.static) continue;
    if (b.asleep) {
      b.vx = 0; b.vy = 0; b.omega = 0;
      continue;
    }
    b.x += (b.vx + b.bvx) * dt;
    b.y += (b.vy + b.bvy) * dt;
    b.angle += (b.omega + b.bomega) * dt;

    // Per-body sleeping. This is what keeps a 100 block tower cheap: settled
    // bodies drop out of both the broad phase and the solver entirely.
    if (Math.abs(b.vx) < WORLD.REST_LINEAR && Math.abs(b.vy) < WORLD.REST_LINEAR
      && Math.abs(b.omega) < WORLD.REST_ANGULAR) {
      b.sleepTimer++;
      if (b.sleepTimer >= WORLD.SLEEP_STEPS) {
        b.asleep = true;
        b.vx = 0; b.vy = 0; b.omega = 0;
      }
    } else {
      b.sleepTimer = 0;
    }
  }

  world.steps++;
}

// ---------------------------------------------------------------------------
// turn resolution
// ---------------------------------------------------------------------------

function everythingSettled(world) {
  for (let i = 0; i < world.bodies.length; i++) {
    const b = world.bodies[i];
    if (b.static) continue;
    if (b.asleep) continue;
    if (Math.abs(b.vx) >= WORLD.REST_LINEAR) return false;
    if (Math.abs(b.vy) >= WORLD.REST_LINEAR) return false;
    if (Math.abs(b.omega) >= WORLD.REST_ANGULAR) return false;
  }
  return true;
}

/** A block below the ground plane is falling and will never come back. */
function anyBlockFellThrough(world) {
  for (let i = 0; i < world.bodies.length; i++) {
    const b = world.bodies[i];
    if (b.static) continue;
    if (b.y > WORLD.GROUND_Y) return true;
  }
  return false;
}

function collapseReason(world) {
  for (let i = 0; i < world.bodies.length; i++) {
    const b = world.bodies[i];
    if (b.static) continue;
    if (b.y > WORLD.GROUND_Y) return 'fell';
    if (b.x < WORLD.GROUND_LEFT || b.x > WORLD.GROUND_RIGHT) return 'offstage';
  }
  return null;
}

/**
 * Drop one block and run the turn to completion.
 *
 * Pure: `world` is not mutated. Returns the resulting world plus the turn
 * outcome.
 *
 * @param {object} world
 * @param {{issue:number,user:string,x:number}} action
 * @param {number} prevHeight tower height at the end of the previous turn
 */
export function dropBlock(world, action, prevHeight = 0) {
  const next = cloneWorld(world);
  const spec = blockSpec(action.issue);
  const x = Math.min(Math.max(Math.round(action.x), WORLD.GROUND_LEFT), WORLD.GROUND_RIGHT);

  next.bodies.push(makeBody({
    x,
    y: WORLD.SPAWN_Y,
    angle: spec.angle,
    w: spec.w,
    h: spec.h,
    issue: action.issue,
    user: action.user,
    turn: next.bodies.length - 1,
  }));

  let settledFor = 0;
  let steps = 0;
  let stopReason = 'timeout';

  for (; steps < WORLD.MAX_STEPS; steps++) {
    step(next);

    if (anyBlockFellThrough(next)) {
      stopReason = 'fell';
      steps++;
      break;
    }

    if (everythingSettled(next)) {
      settledFor++;
      if (settledFor >= WORLD.REST_STEPS) {
        stopReason = 'settled';
        steps++;
        break;
      }
    } else {
      settledFor = 0;
    }
  }

  const height = towerHeight(next);
  let reason = collapseReason(next);
  if (!reason && prevHeight - height >= WORLD.COLLAPSE_DROP) reason = 'shrank';

  return {
    world: next,
    height,
    collapsed: reason !== null,
    reason,
    steps,
    stopReason,
    block: next.bodies[next.bodies.length - 1],
  };
}

/**
 * Rebuild a board from an action log.
 *
 * The stored action log for a round never contains the collapsing move (the
 * round is reset at that point), so a healthy replay always ends with
 * `collapsed === false`. A `true` here means the simulator changed under a
 * previously recorded log - which is exactly the drift we want to detect.
 *
 * @param {Array<{issue:number,user:string,x:number}>} actions
 */
export function replay(actions) {
  let world = createWorld();
  let height = 0;
  const turns = [];

  for (let i = 0; i < actions.length; i++) {
    const r = dropBlock(world, actions[i], height);
    world = r.world;
    height = r.height;
    turns.push({
      issue: actions[i].issue,
      user: actions[i].user,
      x: actions[i].x,
      height: r.height,
      collapsed: r.collapsed,
      reason: r.reason,
      steps: r.steps,
    });
    if (r.collapsed) break;
  }

  return {
    world,
    height,
    turns,
    collapsed: turns.length > 0 && turns[turns.length - 1].collapsed,
  };
}
