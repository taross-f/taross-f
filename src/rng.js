/**
 * Deterministic PRNG (xorshift32).
 *
 * Math.random() must never be used anywhere in this project: the whole game
 * state is rebuilt by replaying the action log, so every random draw has to be
 * reproducible from the issue number alone.
 */

/** Seed derived from an issue number, per the game spec. */
export function seedFromIssue(issueNumber) {
  return (issueNumber * 2654435761) >>> 0;
}

/**
 * @param {number} seed 32bit unsigned seed
 * @returns {{nextUint32():number, nextFloat():number, range(min:number,max:number):number, intRange(min:number,max:number):number}}
 */
export function createRng(seed) {
  // xorshift32 locks up on zero, so fold it onto a fixed non-zero constant.
  let s = (seed >>> 0) || 0x9e3779b9;

  const nextUint32 = () => {
    s ^= (s << 13) >>> 0;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= (s << 5) >>> 0;
    s >>>= 0;
    return s;
  };

  // [0, 1)
  const nextFloat = () => nextUint32() / 4294967296;

  return {
    nextUint32,
    nextFloat,
    /** float in [min, max) */
    range(min, max) {
      return min + (max - min) * nextFloat();
    },
    /** integer in [min, max] */
    intRange(min, max) {
      return min + Math.floor(nextFloat() * (max - min + 1));
    },
  };
}
