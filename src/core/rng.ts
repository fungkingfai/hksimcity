/**
 * 可重現亂數工具（世界生成、市民姓名、天氣皆使用）。
 */

export type Rng = () => number;

/** mulberry32 — 快速、品質足夠的可播種 PRNG */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 由座標與種子取得穩定 0..1 值 */
export function hash2d(x: number, y: number, seed: number): number {
  let h = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 平滑插值 */
export function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

export function randInt(rng: Rng, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

/** 二維 value noise（含平滑） */
export class ValueNoise {
  private seed: number;
  constructor(seed: number) {
    this.seed = seed >>> 0;
  }
  at(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = smooth(x - xi);
    const yf = smooth(y - yi);
    const a = hash2d(xi, yi, this.seed);
    const b = hash2d(xi + 1, yi, this.seed);
    const c = hash2d(xi, yi + 1, this.seed);
    const d = hash2d(xi + 1, yi + 1, this.seed);
    return lerp(lerp(a, b, xf), lerp(c, d, xf), yf);
  }
  /** 多層 fBm */
  fbm(x: number, y: number, octaves = 4, gain = 0.5, lacunarity = 2): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.at(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}
