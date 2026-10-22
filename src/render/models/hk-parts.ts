/**
 * 《維港之城》— 香港建築零件庫（hk-parts）。
 *
 * 這裡放全香港建築共用的「港味」零件：玻璃幕牆（帶窗格貼圖）、鋁窗、冷氣機、
 * 天台水塔／天線、晾衫竹、霓虹招牌（NEON_SIGNS 文字用 canvas texture 發光）、
 * 唐樓騎樓底＋鐵閘、竹棚、港鐵站出口（MTR 標誌／出口牌）、巴士站牌、街市簷篷
 * 與紅膠燈罩、天橋、路牌、垃圾房、消防喉、的士站牌、天橋、樹木、欄杆、長椅等。
 *
 * 設計原則：
 *  - 所有零件直接加入傳入的 parent（原型 group），由 building-prototypes 建立原型、
 *    geometry-utils.mergeStaticMeshes() 合併靜態幾何 → 每棟樓只數個 draw call。
 *  - 需要每幀微動的零件（霓虹招牌、晾衫、煙囪蒸氣、吊機、旗幟）以
 *    `group.userData.anim = '...'` 標記，buildings.ts 收集後做 transform 動畫。
 *  - 材質一律經 MaterialLibrary 快取（霓虹招牌／玻璃幕牆貼圖跨建築共用）。
 *  - 座標單位＝世界單位（TILE=2）。建築模型原點在佔地中心、地面 y=0。
 */

import * as THREE from 'three';
import { FACADE_TILES, MaterialLibrary, PAL, type FacadeStyle } from './materials';
import { addBeamBetween, addBox, addCone, addCylinder, addRock, addSphere } from './geometry-utils';

const EPS = 0.012;
const HK_FONT =
  '"Noto Sans TC", "PingFang HK", "Microsoft JhengHei", "Heiti TC", "Source Han Sans TC", sans-serif';

/** 穩定偽隨機 0..1（同一個 seed 每次都一樣，令原型可重現）。 */
export function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function pick<T>(arr: readonly T[], n: number): T {
  return arr[Math.abs(Math.floor(hash01(n) * arr.length)) % arr.length];
}

// ─────────────────────────── 外牆／幕牆 ───────────────────────────

/**
 * 加一塊貼圖外牆（UV 會依 FACADE_TILES 世界尺寸重複，令窗格比例正確）。
 * 平面預設面向 +z；ry 旋轉。
 */
export function addFacade(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  style: FacadeStyle,
  w: number,
  h: number,
  x: number,
  y: number,
  z: number,
  ry = 0,
  repeatMul = 1,
): THREE.Mesh {
  const tile = FACADE_TILES[style];
  const uRep = Math.max(0.2, (w / tile.w) * repeatMul);
  const vRep = Math.max(0.2, (h / tile.h) * repeatMul);
  const geo = new THREE.PlaneGeometry(w, h);
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * uRep, uv.getY(i) * vRep);
  }
  uv.needsUpdate = true;
  const mesh = new THREE.Mesh(geo, lib.facade(style));
  mesh.position.set(x, y, z);
  mesh.rotation.y = ry;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export interface FacadeRingOptions {
  x?: number;
  z?: number;
  y0?: number;
  front?: boolean;
  back?: boolean;
  left?: boolean;
  right?: boolean;
}

/** 四面外牆貼圖（窗格）。 */
export function addFacadeRing(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  style: FacadeStyle,
  w: number,
  d: number,
  h: number,
  opts: FacadeRingOptions = {},
): void {
  const x = opts.x ?? 0;
  const z = opts.z ?? 0;
  const y0 = opts.y0 ?? 0;
  const cy = y0 + h / 2;
  if (opts.front !== false) addFacade(parent, lib, style, w, h, x, cy, z + d / 2 + EPS, 0);
  if (opts.back !== false) addFacade(parent, lib, style, w, h, x, cy, z - d / 2 - EPS, Math.PI);
  if (opts.left !== false) addFacade(parent, lib, style, d, h, x - w / 2 - EPS, cy, z, -Math.PI / 2);
  if (opts.right !== false) addFacade(parent, lib, style, d, h, x + w / 2 + EPS, cy, z, Math.PI / 2);
}

export interface TowerSpec {
  x?: number;
  z?: number;
  w: number;
  d: number;
  h: number;
  /** 底部 y（例如建在平台之上） */
  y0?: number;
  /** 外牆貼圖款式；null = 純色牆 */
  style?: FacadeStyle | null;
  wallColor?: number;
  roofColor?: number;
  facades?: 'all' | 'frontBack' | 'none';
  /** 加屋頂板 */
  roof?: boolean;
  /** 加女兒牆 */
  parapet?: boolean;
  /** 屋頂機房／水箱層 */
  cap?: { w: number; d: number; h: number; color?: number; x?: number; z?: number } | null;
  /** 樓頂霓虹燈帶（商廈／豪宅頂） */
  roofBand?: number | null;
  /** 外牆貼圖 UV 重複倍率（越大窗越密） */
  repeatMul?: number;
}

/** 標準樓宇：牆體 + 四面窗格 + 屋頂板（+可選女兒牆／機房／樓頂燈帶）。 */
export function addTower(parent: THREE.Object3D, lib: MaterialLibrary, spec: TowerSpec): THREE.Group {
  const g = new THREE.Group();
  g.position.set(spec.x ?? 0, 0, spec.z ?? 0);
  parent.add(g);
  const y0 = spec.y0 ?? 0;
  const wallColor = spec.wallColor ?? PAL.concreteDark;
  addBox(g, lib.lambert(wallColor), spec.w, spec.h, spec.d, 0, y0 + spec.h / 2, 0);
  const mode = spec.facades ?? 'all';
  if (spec.style && mode !== 'none') {
    addFacadeRing(g, lib, spec.style, spec.w, spec.d, spec.h, {
      y0,
      front: true,
      back: mode === 'all',
      left: mode === 'all',
      right: mode === 'all',
    });
  }
  if (spec.roof !== false) {
    addBox(
      g,
      lib.lambert(spec.roofColor ?? PAL.concrete),
      spec.w + 0.06,
      0.07,
      spec.d + 0.06,
      0,
      y0 + spec.h + 0.035,
      0,
    );
  }
  if (spec.parapet) {
    const pm = lib.lambert(spec.roofColor ?? PAL.concreteLight);
    const ty = y0 + spec.h + 0.14;
    addBox(g, pm, spec.w + 0.1, 0.16, 0.06, 0, ty, spec.d / 2);
    addBox(g, pm, spec.w + 0.1, 0.16, 0.06, 0, ty, -spec.d / 2);
    addBox(g, pm, 0.06, 0.16, spec.d, spec.w / 2, ty, 0);
    addBox(g, pm, 0.06, 0.16, spec.d, -spec.w / 2, ty, 0);
  }
  if (spec.cap) {
    const c = spec.cap;
    const cx = c.x ?? 0;
    const cz = c.z ?? 0;
    addBox(g, lib.lambert(c.color ?? PAL.concreteLight), c.w, c.h, c.d, cx, y0 + spec.h + c.h / 2 + 0.03, cz);
  }
  if (spec.roofBand != null) {
    const by = y0 + spec.h - 0.08;
    const bm = lib.neonTube(spec.roofBand);
    addBox(g, bm, spec.w + 0.1, 0.045, 0.045, 0, by, spec.d / 2 + 0.04);
    addBox(g, bm, spec.w + 0.1, 0.045, 0.045, 0, by, -spec.d / 2 - 0.04);
    addBox(g, bm, 0.045, 0.045, spec.d, spec.w / 2 + 0.04, by, 0);
    addBox(g, bm, 0.045, 0.045, spec.d, -spec.w / 2 - 0.04, by, 0);
  }
  return g;
}

/** 平台／基座（商場、屋苑、車站）。 */
export function addPodium(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  w: number,
  d: number,
  h = 0.22,
  opts: { x?: number; z?: number; y?: number; color?: number; trim?: number | null } = {},
): THREE.Mesh {
  const color = opts.color ?? PAL.concreteLight;
  const mesh = addBox(parent, lib.lambert(color), w, h, d, opts.x ?? 0, (opts.y ?? 0) + h / 2, opts.z ?? 0);
  if (opts.trim != null) {
    addBox(parent, lib.lambert(opts.trim), w + 0.04, 0.05, d + 0.04, opts.x ?? 0, (opts.y ?? 0) + h + 0.02, opts.z ?? 0);
  }
  return mesh;
}

/** 樓梯（正面 +z 方向）。 */
export function addStairs(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  w: number,
  steps: number,
  stepH: number,
  stepD: number,
  x: number,
  y: number,
  z: number,
  ry = 0,
  color: number = PAL.stoneLight,
): void {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  const mat = lib.lambert(color);
  for (let i = 0; i < steps; i++) {
    addBox(g, mat, w, stepH * (i + 1), stepD, 0, (stepH * (i + 1)) / 2, -i * stepD);
  }
}

/** 欄杆（兩點之間，含立柱）。 */
export function addRailing(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  h = 0.5,
  opts: { y?: number; color?: number; posts?: number } = {},
): void {
  const y = (opts.y ?? 0) + h;
  const mat = lib.lambert(opts.color ?? PAL.aluminium);
  const len = Math.hypot(x2 - x1, z2 - z1);
  if (len < 0.05) return;
  addBeamBetween(parent, mat, new THREE.Vector3(x1, y, z1), new THREE.Vector3(x2, y, z2), 0.035, 4);
  addBeamBetween(parent, mat, new THREE.Vector3(x1, y - h * 0.5, z1), new THREE.Vector3(x2, y - h * 0.5, z2), 0.03, 4);
  const posts = opts.posts ?? Math.max(2, Math.round(len / 0.5) + 1);
  for (let i = 0; i < posts; i++) {
    const t = posts === 1 ? 0 : i / (posts - 1);
    const px = x1 + (x2 - x1) * t;
    const pz = z1 + (z2 - z1) * t;
    addCylinder(parent, mat, 0.025, 0.025, h, px, y - h / 2, pz, 5);
  }
}

/** 圍欄（地盤／碼頭鐵絲網：立柱＋橫杆＋半透明網）。 */
export function addFence(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  h = 1.0,
  opts: { y?: number; color?: number; mesh?: boolean } = {},
): void {
  const y0 = opts.y ?? 0;
  const mat = lib.lambert(opts.color ?? PAL.steelGrey);
  const len = Math.hypot(x2 - x1, z2 - z1);
  if (len < 0.05) return;
  const posts = Math.max(2, Math.round(len / 0.7) + 1);
  for (let i = 0; i < posts; i++) {
    const t = posts === 1 ? 0 : i / (posts - 1);
    addBox(parent, mat, 0.035, h, 0.035, x1 + (x2 - x1) * t, y0 + h / 2, z1 + (z2 - z1) * t);
  }
  addBeamBetween(parent, mat, new THREE.Vector3(x1, y0 + h, z1), new THREE.Vector3(x2, y0 + h, z2), 0.03, 4);
  if (opts.mesh) {
    const netMat = lib.basic(PAL.steelGrey, { transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
    const geo = new THREE.PlaneGeometry(len, h * 0.9);
    const mesh = new THREE.Mesh(geo, netMat);
    mesh.position.set((x1 + x2) / 2, y0 + h * 0.48, (z1 + z2) / 2);
    mesh.rotation.y = Math.atan2(x2 - x1, z2 - z1) + Math.PI / 2;
    parent.add(mesh);
  }
}

// ─────────────────────────── 3D 鋁窗／冷氣機 ───────────────────────────

/** 立體鋁窗（窗框＋玻璃）；lit=true 時夜間發暖光。 */
export function addAluminiumWindow(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  ry = 0,
  opts: { lit?: boolean; frame?: number; bars?: boolean } = {},
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  const frameColor = opts.frame ?? PAL.aluminium;
  addBox(g, lib.lambert(frameColor), w, h, 0.05, 0, 0, 0);
  const glassColor = opts.lit ? PAL.glassLit : PAL.glassDark;
  const glassMat = opts.lit
    ? lib.lambert(glassColor, { emissive: 0x8a6a3a, emissiveIntensity: 0.35 })
    : lib.lambert(glassColor);
  addBox(g, glassMat, w - 0.05, h - 0.05, 0.03, 0, 0, 0.035);
  // 窗框十字
  addBox(g, lib.lambert(frameColor), 0.022, h - 0.04, 0.012, 0, 0, 0.058);
  addBox(g, lib.lambert(frameColor), w - 0.04, 0.022, 0.012, 0, 0, 0.058);
  if (opts.bars) {
    // 窗花（舊樓鐵窗花）
    const barMat = lib.lambert(PAL.rust);
    for (let i = 1; i < 4; i++) {
      addBox(g, barMat, 0.014, h - 0.06, 0.012, -w / 2 + (w / 4) * i, 0, 0.075);
    }
  }
  return g;
}

/** 窗口式冷氣機（連支架）。 */
export function addACUnit(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  ry = 0,
  scale = 1,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  const s = scale;
  addBox(g, lib.lambert(PAL.wallWhite), 0.34 * s, 0.24 * s, 0.28 * s, 0, 0, 0.14 * s);
  addBox(g, lib.lambert(PAL.aluminiumDark), 0.36 * s, 0.03 * s, 0.3 * s, 0, 0.13 * s, 0.14 * s);
  // 風扇圓面
  const fan = addCylinder(g, lib.lambert(PAL.ironDark), 0.09 * s, 0.09 * s, 0.02 * s, 0, 0, 0.29 * s, 8, 0, Math.PI / 2);
  fan.rotation.x = Math.PI / 2;
  // 支架
  addBox(g, lib.lambert(PAL.rust), 0.02 * s, 0.02 * s, 0.2 * s, -0.12 * s, -0.14 * s, 0.08 * s);
  addBox(g, lib.lambert(PAL.rust), 0.02 * s, 0.02 * s, 0.2 * s, 0.12 * s, -0.14 * s, 0.08 * s);
  return g;
}

/** 一排冷氣機（唐樓／工廈外牆）。 */
export function addACUnitsRow(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x1: number,
  x2: number,
  y: number,
  z: number,
  ry: number,
  count: number,
  seed = 0,
): void {
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const x = x1 + (x2 - x1) * t;
    const jitter = (hash01(seed + i * 3.1) - 0.5) * 0.12;
    addACUnit(parent, lib, x, y + jitter, z, ry, 0.85 + hash01(seed + i) * 0.3);
  }
}

/** 晾衫竹（伸出窗外，衫褲隨風擺動 → anim 'laundry'）。 */
export function addLaundryPole(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  length = 1.2,
  ry = 0,
  seed = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  g.userData.anim = 'laundry';
  parent.add(g);
  // 兩支竹
  addCylinder(g, lib.lambert(PAL.bamboo), 0.022, 0.025, length, 0, 0, length / 2, 5, Math.PI / 2, 0);
  addCylinder(g, lib.lambert(PAL.bamboo), 0.02, 0.02, length * 0.9, 0, -0.16, length * 0.45, 5, Math.PI / 2, 0);
  // 衫褲
  const cloth = [PAL.clothWhite, PAL.clothBlue, PAL.clothPink, PAL.clothYellow, PAL.clothGreen, PAL.clothRed];
  const n = 3 + Math.floor(hash01(seed * 1.7) * 3);
  for (let i = 0; i < n; i++) {
    const t = 0.18 + (0.7 * (i + 0.5)) / n;
    const c = pick(cloth, seed + i * 5.3);
    const w = 0.16 + hash01(seed + i * 2.1) * 0.12;
    const h = 0.2 + hash01(seed + i * 4.7) * 0.18;
    addBox(g, lib.lambert(c), w, h, 0.03, (t - 0.5) * 0.5, -h / 2 - 0.03, length * 0.42 + hash01(seed + i) * 0.1);
    // 衣夾
    addBox(g, lib.lambert(PAL.clothWhite), 0.03, 0.03, 0.03, (t - 0.5) * 0.5 - w / 2 + 0.03, 0.01, length * 0.42);
    addBox(g, lib.lambert(PAL.clothWhite), 0.03, 0.03, 0.03, (t - 0.5) * 0.5 + w / 2 - 0.03, 0.01, length * 0.42);
  }
  return g;
}

// ─────────────────────────── 天台：水塔／天線／雜物 ───────────────────────────

/** 天台水塔（不鏽鋼圓桶＋支架）。 */
export function addRooftopTank(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  scale = 1,
  color: number = PAL.aluminium,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  const s = scale;
  const mat = lib.lambert(color);
  const tank = addCylinder(g, mat, 0.28 * s, 0.28 * s, 0.5 * s, 0, 0.5 * s + 0.12 * s, 0, 10);
  tank.castShadow = true;
  addCylinder(g, lib.lambert(PAL.steelGrey), 0.3 * s, 0.3 * s, 0.04 * s, 0, 0.75 * s + 0.12 * s, 0, 10);
  // 支架
  for (const [dx, dz] of [
    [-0.18, -0.18],
    [0.18, -0.18],
    [-0.18, 0.18],
    [0.18, 0.18],
  ]) {
    addBox(g, lib.lambert(PAL.ironDark), 0.035 * s, 0.16 * s, 0.035 * s, dx * s, 0.08 * s, dz * s);
  }
  // 水管
  addCylinder(g, lib.lambert(PAL.steelGrey), 0.03 * s, 0.03 * s, 0.4 * s, 0.22 * s, 0.2 * s, 0.16 * s, 5);
  return g;
}

/** 天台天線（電視天線／基站天線）。 */
export function addAntenna(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  h = 1.4,
  opts: { dish?: boolean; signal?: boolean; thin?: boolean } = {},
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  const mat = lib.lambert(PAL.ironDark);
  addCylinder(g, mat, 0.02, 0.03, h, 0, h / 2, 0, 5);
  // 橫杆（魚骨天線）
  const arms = opts.thin ? 2 : 4;
  for (let i = 0; i < arms; i++) {
    const ay = h * (0.45 + i * 0.14);
    const len = 0.34 - i * 0.04;
    addBox(g, mat, len, 0.018, 0.018, 0, ay, 0);
  }
  if (opts.dish) {
    const dish = addCylinder(g, lib.lambert(PAL.wallWhite), 0.2, 0.2, 0.04, 0.18, h * 0.72, 0, 10, 0, Math.PI / 2);
    dish.rotation.x = -0.5;
  }
  if (opts.signal) {
    // 天台基站（紅燈閃爍）
    addBox(g, lib.lambert(PAL.wallWhite), 0.16, 0.3, 0.16, 0, h + 0.15, 0);
    addSphere(g, lib.neonTube(PAL.neonRed), 0.035, 0, h + 0.34, 0, 6, 4);
  }
  return g;
}

/** 天台雜物：水塔＋天線＋冷氣散熱器＋通風管＋太陽能板，一次過加。 */
export function addRooftopClutter(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  w: number,
  d: number,
  y: number,
  seed = 0,
  opts: { tanks?: number; antennas?: number; ac?: number; vents?: boolean; solar?: boolean } = {},
): void {
  const tanks = opts.tanks ?? 1;
  for (let i = 0; i < tanks; i++) {
    const x = (hash01(seed + i * 7.1) - 0.5) * (w * 0.55);
    const z = (hash01(seed + i * 3.7) - 0.5) * (d * 0.55);
    addRooftopTank(parent, lib, x, y, z, 0.8 + hash01(seed + i * 2.3) * 0.5);
  }
  const antennas = opts.antennas ?? 1;
  for (let i = 0; i < antennas; i++) {
    const x = (hash01(seed + 11 + i * 5.3) - 0.5) * w * 0.7;
    const z = (hash01(seed + 17 + i * 2.9) - 0.5) * d * 0.7;
    addAntenna(parent, lib, x, y, z, 1.0 + hash01(seed + i) * 0.8, { dish: i % 2 === 0 });
  }
  const ac = opts.ac ?? 2;
  for (let i = 0; i < ac; i++) {
    const x = (hash01(seed + 23 + i * 4.1) - 0.5) * w * 0.7;
    const z = (hash01(seed + 29 + i * 6.7) - 0.5) * d * 0.7;
    addBox(parent, lib.lambert(PAL.aluminium), 0.5, 0.32, 0.5, x, y + 0.16, z);
    addCylinder(parent, lib.lambert(PAL.ironDark), 0.16, 0.16, 0.03, x, y + 0.33, z, 8);
  }
  if (opts.vents) {
    addCylinder(parent, lib.lambert(PAL.steelGrey), 0.12, 0.14, 0.7, w * 0.2, y + 0.35, -d * 0.2, 8);
  }
  if (opts.solar) {
    for (let i = 0; i < 3; i++) {
      const panel = addBox(parent, lib.lambert(0x2a3f5f), 0.7, 0.03, 0.45, -w * 0.22 + i * 0.75, y + 0.18, d * 0.18);
      panel.rotation.x = -0.35;
    }
  }
}

// ─────────────────────────── 霓虹招牌 / 標籤 / 圖示 ───────────────────────────

export interface NeonSignSpec {
  text: string;
  /** 世界座標（招牌中心） */
  x: number;
  y: number;
  z: number;
  ry?: number;
  vertical?: boolean;
  color?: number;
  /** 招牌面寬（世界單位）；預設直式 0.34、橫式 1.5 */
  w?: number;
  /** 招牌面高；預設直式 0.95、橫式 0.42 */
  h?: number;
  /** 是否加微動動畫（招牌隨風擺） */
  anim?: boolean;
  board?: string;
  doubleSide?: boolean;
}

/**
 * 霓虹招牌：深色底板＋發光中文字（直式伸出／橫式舖面）。
 * anim=true 時 group.userData.anim='sign'，buildings.ts 會做擺動動畫。
 */
export function addNeonSign(parent: THREE.Object3D, lib: MaterialLibrary, spec: NeonSignSpec): THREE.Group {
  const vertical = spec.vertical ?? true;
  const w = spec.w ?? (vertical ? 0.34 : 1.5);
  const h = spec.h ?? (vertical ? 0.95 : 0.42);
  const g = new THREE.Group();
  g.position.set(spec.x, spec.y, spec.z);
  if (spec.ry) g.rotation.y = spec.ry;
  if (spec.anim) g.userData.anim = 'sign';
  parent.add(g);

  const boardMat = lib.lambert(0x171018);
  addBox(g, boardMat, w + 0.04, h + 0.04, 0.07, 0, 0, -0.045);
  // 金屬支架（伸出招牌）
  if (vertical) {
    const br = lib.lambert(PAL.ironDark);
    addCylinder(g, br, 0.022, 0.022, 0.38, 0, h * 0.36, -0.22, 5, Math.PI / 2, 0);
    addCylinder(g, br, 0.022, 0.022, 0.38, 0, -h * 0.36, -0.22, 5, Math.PI / 2, 0);
  }
  const signMat = lib.neonSign(spec.text, {
    vertical,
    color: spec.color ?? PAL.neonPink,
    board: spec.board,
    doubleSide: spec.doubleSide ?? true,
  });
  const geo = new THREE.PlaneGeometry(w, h);
  const face = new THREE.Mesh(geo, signMat);
  face.position.z = 0.0;
  g.add(face);
  return g;
}

export interface LabelSignSpec {
  text: string;
  sub?: string;
  x: number;
  y: number;
  z: number;
  w?: number;
  h?: number;
  ry?: number;
  bg?: string;
  fg?: string;
  border?: string;
  vertical?: boolean;
  backing?: boolean;
  anim?: boolean;
}

/** 平面標籤（港鐵站名、出口牌、路牌、巴士路線牌）。 */
export function addLabelSign(parent: THREE.Object3D, lib: MaterialLibrary, spec: LabelSignSpec): THREE.Group {
  const w = spec.w ?? 1.0;
  const h = spec.h ?? 0.32;
  const g = new THREE.Group();
  g.position.set(spec.x, spec.y, spec.z);
  if (spec.ry) g.rotation.y = spec.ry;
  if (spec.anim) g.userData.anim = 'sign';
  parent.add(g);
  if (spec.backing !== false) {
    addBox(g, lib.lambert(PAL.ironDark), w + 0.04, h + 0.04, 0.05, 0, 0, -0.035);
  }
  const mat = lib.label(spec.text, {
    w: spec.vertical ? 96 : 320,
    h: spec.vertical ? 320 : 96,
    bg: spec.bg ?? '#e8ece8',
    fg: spec.fg ?? '#1b2b33',
    border: spec.border ?? '#7a8288',
    vertical: spec.vertical,
    sub: spec.sub,
  });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  face.position.z = 0.01;
  g.add(face);
  return g;
}

/** 港鐵標誌（紅底白字）貼片。 */
export function addMtrLogo(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  ry = 0,
  size = 0.42,
): THREE.Mesh {
  const mat = lib.symbol('mtrLogo', 128, 128, (ctx) => {
    ctx.fillStyle = '#b02a2a';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(14, 14, 100, 8);
    ctx.font = `900 54px ${HK_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('MTR', 64, 70);
    ctx.fillRect(14, 103, 100, 8);
    // 港鐵白色「M」形意符
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(30, 94);
    ctx.lineTo(44, 32);
    ctx.lineTo(64, 72);
    ctx.lineTo(84, 32);
    ctx.lineTo(98, 94);
    ctx.stroke();
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  mesh.position.set(x, y, z);
  mesh.rotation.y = ry;
  parent.add(mesh);
  return mesh;
}

/** 紅十字標誌（醫院）。 */
export function addCrossSign(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  ry = 0,
  size = 1.2,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  const mat = lib.symbol('redCross', 128, 128, (ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#c62828';
    ctx.fillRect(48, 16, 32, 96);
    ctx.fillRect(16, 48, 96, 32);
    ctx.strokeStyle = '#9aa0a6';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, 122, 122);
  });
  addBox(g, lib.lambert(PAL.wallWhite), size + 0.08, size + 0.08, 0.08, 0, 0, -0.04);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  face.position.z = 0.012;
  g.add(face);
  // 支架
  addBox(g, lib.lambert(PAL.ironDark), 0.05, size * 0.8, 0.05, 0, -size * 0.6, -0.05);
  return g;
}

/** LED 大屏幕（商場／商廈外牆，夜間彩色）。 */
export function addLedScreen(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  ry = 0,
  seed = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  addBox(g, lib.lambert(PAL.ironDark), w + 0.08, h + 0.08, 0.08, 0, 0, -0.04);
  const mat = lib.symbol(`led${seed % 3}`, 256, 128, (ctx) => {
    const cols = ['#ff3d7f', '#24e0ff', '#ffd166', '#a45bff', '#5cff9d', '#ff7a3d'];
    ctx.fillStyle = '#0b0f18';
    ctx.fillRect(0, 0, 256, 128);
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = cols[(i + seed) % cols.length];
      ctx.globalAlpha = 0.55 + 0.4 * hash01(i + seed * 3.1);
      ctx.fillRect(4 + i * 31, 8 + (i % 3) * 36, 26, 28);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 34px ${HK_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('維港', 96, 64);
    ctx.font = `700 26px ${HK_FONT}`;
    ctx.fillText('購物', 200, 64);
  });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  face.position.z = 0.015;
  g.add(face);
  return g;
}

// ─────────────────────────── 地舖 / 騎樓 / 鐵閘 / 竹棚 ───────────────────────────

/** 地舖玻璃門面（便利店／茶餐廳／街舖）：貼圖舖面＋門框＋招牌位。 */
export function addShopFront(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  ry = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  addBox(g, lib.lambert(PAL.concreteDark), w, h, 0.12, 0, h / 2, -0.06);
  addFacade(g, lib, 'shop', w - 0.08, h - 0.1, 0, h / 2 + 0.02, 0.015, 0);
  // 門框
  const frameMat = lib.lambert(PAL.aluminiumDark);
  addBox(g, frameMat, w, 0.05, 0.06, 0, h - 0.03, 0.02);
  addBox(g, frameMat, 0.05, h, 0.06, -w / 2 + 0.03, h / 2, 0.02);
  addBox(g, frameMat, 0.05, h, 0.06, w / 2 - 0.03, h / 2, 0.02);
  return g;
}

/** 唐樓／舊樓騎樓底：柱＋天花＋後縮地舖。回傳 group（局部座標）。 */
export function addArcade(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  w: number,
  d: number,
  opts: { y0?: number; height?: number; depth?: number; columnColor?: number; seed?: number } = {},
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(0, opts.y0 ?? 0, 0);
  parent.add(g);
  const h = opts.height ?? 1.0;
  const depth = opts.depth ?? 0.5;
  const colMat = lib.lambert(opts.columnColor ?? PAL.concreteLight);
  // 地台（騎樓底行人路面，深色水磨石）
  addBox(g, lib.lambert(PAL.concreteDark), w, 0.06, depth, 0, 0.03, d / 2 - depth / 2);
  // 柱（騎樓柱）
  const cols = Math.max(2, Math.round(w / 1.0) + 1);
  for (let i = 0; i < cols; i++) {
    const t = cols === 1 ? 0.5 : i / (cols - 1);
    const px = -w / 2 + 0.12 + (w - 0.24) * t;
    addBox(g, colMat, 0.16, h, 0.16, px, h / 2, d / 2 - 0.1);
    // 柱頭裝飾
    addBox(g, lib.lambert(PAL.wallGrey), 0.2, 0.06, 0.2, px, h - 0.05, d / 2 - 0.1);
  }
  // 天花
  addBox(g, lib.lambert(PAL.concreteLight), w, 0.09, depth + 0.1, 0, h - 0.04, d / 2 - (depth + 0.1) / 2 + 0.05);
  // 後牆地舖
  const backZ = d / 2 - depth - 0.04;
  addShopFront(g, lib, 0, 0.02, backZ, w - 0.16, h - 0.12, 0);
  // 天花光管（騎樓底街燈）
  const tube = lib.neonTube(PAL.wallWhite);
  addBox(g, tube, w * 0.45, 0.03, 0.05, 0, h - 0.12, d / 2 - depth * 0.55);
  return g;
}

/** 鐵閘（舊樓／地舖拉閘），open 0=關 1=半開。 */
export function addIronGate(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  ry = 0,
  open = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  const gate = new THREE.Group();
  gate.position.set(w / 2, 0, 0);
  gate.rotation.y = -open * 0.5;
  gate.position.x = w / 2 - (w / 2) * Math.cos(open * 0.5);
  g.add(gate);
  const mat = lib.lambert(PAL.ironDark);
  // 外框
  addBox(gate, mat, w, 0.05, 0.04, -w / 2, h - 0.03, 0);
  addBox(gate, mat, w, 0.05, 0.04, -w / 2, 0.03, 0);
  addBox(gate, mat, 0.05, h, 0.04, -w + 0.02, h / 2, 0);
  addBox(gate, mat, 0.05, h, 0.04, -0.02, h / 2, 0);
  // 直鐵枝
  const bars = Math.max(4, Math.round(w / 0.12));
  for (let i = 1; i < bars; i++) {
    const bx = -w + (w / bars) * i;
    addBox(gate, mat, 0.022, h - 0.08, 0.022, bx, h / 2, 0);
  }
  // 斜撐
  addBeamBetween(gate, mat, new THREE.Vector3(-w, 0.05, 0), new THREE.Vector3(-0.02, h - 0.05, 0), 0.025, 3);
  return g;
}

/** 竹棚（維修中的唐樓／工廈外牆）。 */
export function addBambooScaffold(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  ry = 0,
  seed = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  const bamboo = lib.lambert(PAL.bamboo);
  const tie = lib.lambert(PAL.bambooDark);
  const cols = Math.max(3, Math.round(w / 0.5));
  const rows = Math.max(2, Math.round(h / 0.5));
  // 直竹
  for (let i = 0; i < cols; i++) {
    const px = -w / 2 + (w / (cols - 1)) * i;
    addCylinder(g, bamboo, 0.024, 0.026, h, px, h / 2, 0.18, 5);
    addCylinder(g, bamboo, 0.022, 0.024, h, px, h / 2, 0.42, 5);
  }
  // 橫竹（每層）
  for (let r = 0; r < rows; r++) {
    const py = 0.22 + (h - 0.44) * (r / Math.max(1, rows - 1));
    addCylinder(g, bamboo, 0.02, 0.02, w, 0, py, 0.18, 5, 0, Math.PI / 2);
    addCylinder(g, tie, 0.018, 0.018, w, 0, py, 0.42, 5, 0, Math.PI / 2);
    // 斜撐
    const dir = r % 2 === 0 ? 1 : -1;
    addBeamBetween(
      g,
      bamboo,
      new THREE.Vector3(-w / 2, py, 0.18),
      new THREE.Vector3(w / 2, py + 0.42, 0.18),
      0.02,
      3,
    );
    void dir;
  }
  // 工作平台木板
  for (let r = 1; r < rows; r += 2) {
    const py = 0.22 + (h - 0.44) * (r / Math.max(1, rows - 1));
    addBox(g, lib.lambert(PAL.woodLight), w, 0.03, 0.3, 0, py + 0.03, 0.3);
  }
  // 綠色安全網
  const netMat = lib.basic(PAL.bambooNet, { transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide });
  const net = new THREE.Mesh(new THREE.PlaneGeometry(w, h), netMat);
  net.position.set(0, h / 2, 0.46);
  g.add(net);
  // 竹棚招牌（「維修」）
  const signMat = lib.label('維修工程', { w: 256, h: 80, bg: '#d9b23f', fg: '#2a2a2a', border: '#2a2a2a' });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(w, 1.2), 0.3), signMat);
  sign.position.set(0, h * 0.62, 0.47);
  g.add(sign);
  void seed;
  return g;
}

// ─────────────────────────── 街道家具 ───────────────────────────

/** 長椅（公園／海濱）。 */
export function addBench(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  ry = 0,
  y = 0,
  color: number = PAL.woodLight,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  const wood = lib.lambert(color);
  const metal = lib.lambert(PAL.ironDark);
  addBox(g, wood, 0.7, 0.06, 0.22, 0, 0.24, 0);
  addBox(g, wood, 0.7, 0.06, 0.22, 0, 0.4, -0.16);
  addBox(g, metal, 0.04, 0.24, 0.2, -0.28, 0.12, 0);
  addBox(g, metal, 0.04, 0.24, 0.2, 0.28, 0.12, 0);
  return g;
}

/** 街燈（彎臂式）。 */
export function addLampPost(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  h = 1.6,
  opts: { y?: number; ry?: number; color?: number; arm?: number } = {},
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, opts.y ?? 0, z);
  g.rotation.y = opts.ry ?? 0;
  parent.add(g);
  const mat = lib.lambert(opts.color ?? PAL.aluminium);
  addCylinder(g, mat, 0.032, 0.045, h, 0, h / 2, 0, 6);
  const arm = opts.arm ?? 0.32;
  addBeamBetween(g, mat, new THREE.Vector3(0, h, 0), new THREE.Vector3(arm, h + 0.06, 0), 0.035, 4);
  const headMat = lib.lambert(PAL.wallWhite);
  addBox(g, headMat, 0.2, 0.07, 0.12, arm + 0.06, h + 0.04, 0);
  addBox(g, lib.neonTube(PAL.wallWhite), 0.16, 0.03, 0.09, arm + 0.06, h - 0.005, 0);
  return g;
}

/** 香港綠色街道路牌（白字）。 */
export function addStreetSign(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  text: string,
  sub = '',
  ry = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  addCylinder(g, lib.lambert(PAL.ironDark), 0.03, 0.035, y, 0, -y / 2 + 0.02, 0, 6);
  const mat = lib.label(text, {
    w: 512,
    h: 128,
    bg: '#1f6b45',
    fg: '#f2f5ee',
    border: '#f2f5ee',
    sub: sub || undefined,
    fontScale: 0.5,
  });
  const plate = addBox(g, lib.lambert(PAL.streetSignGreen), 1.1, 0.32, 0.04, 0, 0, 0);
  plate.castShadow = false;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(1.06, 0.29), mat);
  face.position.set(0, 0, 0.025);
  g.add(face);
  return g;
}

/** 巴士站牌（柱＋路線牌）。 */
export function addBusStopFlag(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  routes: string,
  opts: { y?: number; ry?: number; anim?: boolean } = {},
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, opts.y ?? 0, z);
  g.rotation.y = opts.ry ?? 0;
  if (opts.anim) g.userData.anim = 'sign';
  parent.add(g);
  addCylinder(g, lib.lambert(PAL.steelGrey), 0.026, 0.03, 1.5, 0, 0.75, 0, 6);
  const boardMat = lib.label(routes, {
    w: 512,
    h: 160,
    bg: '#2a5f9f',
    fg: '#ffffff',
    border: '#e8ece8',
    fontScale: 0.42,
    sub: '巴士站 BUS STOP',
  });
  addBox(g, lib.lambert(PAL.busStopBlue), 1.05, 0.34, 0.05, 0, 1.42, 0);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.3), boardMat);
  face.position.set(0, 1.42, 0.028);
  g.add(face);
  return g;
}

/** 的士站牌。 */
export function addTaxiStand(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  ry = 0,
  y = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  addCylinder(g, lib.lambert(PAL.steelGrey), 0.025, 0.03, 1.3, 0, 0.65, 0, 6);
  const mat = lib.label('的士站', {
    w: 384,
    h: 128,
    bg: '#b02a2a',
    fg: '#ffffff',
    border: '#ffffff',
    sub: 'TAXI STAND',
  });
  addBox(g, lib.lambert(PAL.taxiRed), 0.7, 0.26, 0.04, 0, 1.24, 0);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.23), mat);
  face.position.set(0, 1.24, 0.025);
  g.add(face);
  return g;
}

/** 垃圾房（屋邨／街市後面）。 */
export function addRefuseRoom(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  w = 1.4,
  d = 1.0,
  ry = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  parent.add(g);
  const wall = lib.lambert(PAL.refuseGrey);
  addBox(g, wall, w, 0.9, d, 0, 0.45, 0);
  addBox(g, lib.lambert(PAL.concreteDark), w + 0.08, 0.1, d + 0.08, 0, 0.95, 0);
  // 門洞
  addBox(g, lib.lambert(0x3a3f3a), w * 0.4, 0.6, 0.05, 0, 0.3, d / 2 + 0.02);
  addBox(g, lib.lambert(0x3a3f3a), w * 0.4, 0.05, 0.05, -w * 0.2, 0.05, d / 2 + 0.02);
  // 垃圾桶（香港橙色／綠色）
  for (let i = 0; i < 3; i++) {
    const bx = -w * 0.3 + i * 0.34;
    addCylinder(g, lib.lambert(i % 2 === 0 ? 0xd97a2a : 0x3f7a4a), 0.11, 0.09, 0.36, bx, 0.18, d / 2 + 0.22, 8);
    addCylinder(g, lib.lambert(PAL.ironDark), 0.12, 0.12, 0.05, bx, 0.4, d / 2 + 0.22, 8);
  }
  // 牌
  const mat = lib.label('垃圾房', { w: 256, h: 96, bg: '#e8ece8', fg: '#1b2b33', border: '#1b2b33' });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.22), mat);
  face.position.set(0, 0.72, d / 2 + 0.03);
  g.add(face);
  return g;
}

/** 消防喉（紅箱＋喉轆）掛牆。 */
export function addFireHoseReel(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  ry = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  addBox(g, lib.lambert(PAL.fireRed), 0.26, 0.34, 0.12, 0, 0, 0);
  addBox(g, lib.lambert(PAL.fireRedDark), 0.28, 0.04, 0.14, 0, 0.18, 0);
  const coil = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.025, 6, 10), lib.lambert(PAL.wallWhite));
  coil.position.set(0, 0, 0.07);
  g.add(coil);
  const mat = lib.label('消防喉', { w: 256, h: 96, bg: '#b0443f', fg: '#ffffff', border: '#ffffff' });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.09), mat);
  face.position.set(0, -0.22, 0.05);
  g.add(face);
  return g;
}

/** 黃黑地盤警示條（地盤／消防局／巴士站邊）。 */
export function addHazardStripe(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  w: number,
  d: number,
  ry = 0,
  y = 0.1,
): void {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  const yellow = lib.lambert(PAL.hazardYellow);
  const black = lib.lambert(PAL.hazardBlack);
  const n = Math.max(2, Math.round(w / 0.25));
  for (let i = 0; i < n; i++) {
    const px = -w / 2 + (w / n) * (i + 0.5);
    addBox(g, i % 2 === 0 ? yellow : black, w / n, 0.14, d, px, 0, 0);
  }
}

/** 垃圾桶（香港橙色街邊垃圾桶）。 */
export function addLitterBin(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  y = 0,
): void {
  addCylinder(parent, lib.lambert(0xd97a2a), 0.1, 0.09, 0.34, x, y + 0.17, z, 8);
  addCylinder(parent, lib.lambert(PAL.ironDark), 0.11, 0.11, 0.05, x, y + 0.37, z, 8);
}

/** 旗杆＋旗（旗幟 anim 'flag'）。 */
export function addFlagpole(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  h = 2.2,
  flagColor: number = PAL.mtrRed,
  y = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  addCylinder(g, lib.lambert(PAL.aluminium), 0.022, 0.035, h, 0, h / 2, 0, 6);
  const flag = new THREE.Group();
  flag.position.set(0.02, h - 0.3, 0);
  flag.userData.anim = 'flag';
  g.add(flag);
  addBox(flag, lib.lambert(flagColor), 0.5, 0.3, 0.02, 0.28, -0.15, 0);
  addBox(flag, lib.lambert(PAL.clothWhite), 0.1, 0.1, 0.025, 0.28, -0.15, 0);
  return g;
}

// ─────────────────────────── 樹木／公園 ───────────────────────────

export type TreeKind = 'banyan' | 'palm' | 'pine' | 'flower' | 'shrub';

/** 香港常見樹木（榕樹／棕櫚／松樹／洋紫荊／灌木）。 */
export function addTree(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  scale = 1,
  kind: TreeKind = 'banyan',
  seed = 0,
  y = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  const s = scale;
  const trunkMat = lib.lambert(PAL.woodDark);
  if (kind === 'palm') {
    // 棕櫚：彎曲樹幹＋放射葉
    let px = 0;
    let pz = 0;
    const segs = 4;
    for (let i = 0; i < segs; i++) {
      const lean = (i / segs) * 0.16 * s;
      addCylinder(g, lib.lambert(0x8a7a5a), 0.055 * s, 0.075 * s, 0.42 * s, px + lean, 0.2 * s + i * 0.4 * s, pz, 6);
      px += lean * 0.5;
      pz += lean * 0.3;
    }
    const topY = segs * 0.4 * s;
    for (let i = 0; i < 7; i++) {
      const frond = addCone(g, lib.lambert(PAL.leafPalm), 0.16 * s, 0.85 * s, px, topY, pz, 4);
      frond.rotation.z = 1.15;
      frond.rotation.y = (i / 7) * Math.PI * 2;
      frond.position.x = px + Math.cos((i / 7) * Math.PI * 2) * 0.34 * s;
      frond.position.z = pz + Math.sin((i / 7) * Math.PI * 2) * 0.34 * s;
    }
    addSphere(g, lib.lambert(PAL.leafDark), 0.18 * s, px, topY + 0.1 * s, pz, 6, 4);
    return g;
  }
  if (kind === 'shrub') {
    addSphere(g, lib.lambert(PAL.leafBanyan), 0.28 * s + 0.1, 0, 0.22 * s, 0, 7, 5);
    addSphere(g, lib.lambert(PAL.leaf), 0.2 * s, 0.22 * s, 0.16 * s, 0.1, 6, 4);
    return g;
  }
  if (kind === 'pine') {
    addCylinder(g, trunkMat, 0.06 * s, 0.09 * s, 0.6 * s, 0, 0.3 * s, 0, 6);
    addCone(g, lib.lambert(PAL.leafDark), 0.46 * s, 0.8 * s, 0, 0.45 * s, 0, 7);
    addCone(g, lib.lambert(PAL.leaf), 0.34 * s, 0.65 * s, 0, 0.85 * s, 0, 7);
    return g;
  }
  // banyan / flower
  addCylinder(g, trunkMat, 0.09 * s, 0.15 * s, 0.9 * s, 0, 0.45 * s, 0, 6);
  // 氣根
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + seed;
    addCylinder(g, lib.lambert(0x6a5a3f), 0.012 * s, 0.018 * s, 0.7 * s, Math.cos(a) * 0.34 * s, 0.35 * s, Math.sin(a) * 0.34 * s, 4);
  }
  const canopy = kind === 'flower' ? PAL.leafFlower : PAL.leafBanyan;
  const canopy2 = kind === 'flower' ? 0xd98fa0 : PAL.leaf;
  const blobs = 4;
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * Math.PI * 2 + seed * 1.7;
    const r = 0.42 * s;
    const ball = addSphere(
      g,
      lib.lambert(i % 2 === 0 ? canopy : canopy2),
      (0.34 + hash01(seed + i) * 0.14) * s,
      Math.cos(a) * r * 0.8,
      0.95 * s + hash01(seed + i * 2.3) * 0.2 * s,
      Math.sin(a) * r * 0.8,
      7,
      5,
    );
    ball.scale.y = 0.75;
  }
  addSphere(g, lib.lambert(canopy2), 0.4 * s, 0, 1.12 * s, 0, 7, 5).scale.y = 0.7;
  return g;
}

/** 種植箱（街道／公園花槽）。 */
export function addPlanter(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  w = 0.9,
  d = 0.5,
  y = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  addBox(g, lib.lambert(PAL.concreteLight), w, 0.3, d, 0, 0.15, 0);
  addBox(g, lib.lambert(PAL.soil), w - 0.1, 0.04, d - 0.1, 0, 0.31, 0);
  addSphere(g, lib.lambert(PAL.leaf), 0.2, -w * 0.25, 0.42, 0, 6, 4);
  addSphere(g, lib.lambert(PAL.leafBanyan), 0.24, w * 0.2, 0.4, 0.04, 6, 4);
  return g;
}

/** 公園涼亭（八角亭，中式綠瓦頂）。 */
export function addParkPavilion(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  scale = 1,
  y = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  const s = scale;
  addCylinder(g, lib.lambert(PAL.stoneLight), 0.85 * s, 0.9 * s, 0.14 * s, 0, 0.07 * s, 0, 8);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    addCylinder(
      g,
      lib.lambert(PAL.pillarRed),
      0.045 * s,
      0.055 * s,
      0.95 * s,
      Math.cos(a) * 0.78 * s,
      0.6 * s,
      Math.sin(a) * 0.78 * s,
      6,
    );
  }
  addCone(g, lib.lambert(PAL.tileGreen), 1.0 * s, 0.42 * s, 0, 1.28 * s, 0, 8);
  addSphere(g, lib.lambert(PAL.gold), 0.06 * s, 0, 1.52 * s, 0, 6, 4);
  addBox(g, lib.lambert(PAL.stone), 1.2 * s, 0.05 * s, 1.2 * s, 0, 0.16 * s, 0);
  return g;
}

/** 公園池塘。 */
export function addPond(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  w = 1.4,
  d = 1.0,
  y = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  addBox(g, lib.lambert(PAL.concreteLight), w + 0.14, 0.12, d + 0.14, 0, 0.06, 0);
  addBox(g, lib.lambert(PAL.poolWater, { emissive: 0x0f2a38, emissiveIntensity: 0.3 }), w, 0.03, d, 0, 0.11, 0);
  // 石邊
  for (let i = 0; i < 5; i++) {
    addRock(g, lib.lambert(PAL.rock), -w / 2 + (i / 4) * w, d / 2 + 0.04, 0.5, i);
  }
  // 荷葉
  addCylinder(g, lib.lambert(PAL.leaf), 0.12, 0.12, 0.015, -w * 0.2, 0.13, 0, 7);
  addCylinder(g, lib.lambert(PAL.leafDark), 0.09, 0.09, 0.015, w * 0.22, 0.13, -d * 0.2, 7);
  return g;
}

/** 兒童遊樂場（軟墊＋滑梯＋鞦韆）。 */
export function addPlayground(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  scale = 1,
  y = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  const s = scale;
  addBox(g, lib.lambert(PAL.neonOrange), 1.6 * s, 0.04, 1.2 * s, 0, 0.02, 0);
  // 滑梯
  const slideMat = lib.lambert(PAL.neonCyan);
  addBox(g, slideMat, 0.3, 0.06, 0.9 * s, -0.45 * s, 0.55 * s, 0.1 * s).rotation.x = 0.55;
  addBox(g, lib.lambert(PAL.neonGold), 0.06, 0.6 * s, 0.06, -0.45 * s, 0.3 * s, -0.28 * s);
  addBox(g, lib.lambert(PAL.neonGold), 0.06, 0.6 * s, 0.06, -0.45 * s, 0.3 * s, 0.46 * s);
  // 鞦韆
  const swingMat = lib.lambert(PAL.aluminium);
  addBox(g, swingMat, 0.7 * s, 0.04, 0.04, 0.45 * s, 0.7 * s, 0);
  addBox(g, swingMat, 0.04, 0.7 * s, 0.04, 0.12 * s, 0.35 * s, 0);
  addBox(g, swingMat, 0.04, 0.7 * s, 0.04, 0.78 * s, 0.35 * s, 0);
  addBox(g, lib.lambert(PAL.clothRed), 0.18, 0.04, 0.1, 0.45 * s, 0.3 * s, 0);
  return g;
}

/** 長者健體園地（簡單器械）。 */
export function addFitnessCorner(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  y = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  const post = lib.lambert(PAL.neonGreen);
  const metal = lib.lambert(PAL.steelGrey);
  for (let i = 0; i < 3; i++) {
    const px = -0.4 + i * 0.4;
    addCylinder(g, post, 0.035, 0.045, 0.7, px, 0.35, 0, 6);
    addBox(g, metal, 0.3, 0.03, 0.03, px + 0.12, 0.5 + (i % 2) * 0.1, 0);
    addBox(g, lib.lambert(PAL.neonGold), 0.12, 0.03, 0.12, px, 0.06, 0);
  }
  return g;
}

// ═══════════════════════════ 第二部分：交通／工業／碼頭／公共設施 ═══════════════════════════

// ─────────────────────────── 港鐵站 ───────────────────────────

/** 港鐵站名牌（紅底白字橫額）。 */
export function addStationNameBand(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  nameZh: string,
  nameEn: string,
  ry = 0,
  w = 1.7,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  addBox(g, lib.lambert(PAL.mtrRed), w, 0.34, 0.06, 0, 0, 0);
  const mat = lib.label(nameZh, {
    w: 768,
    h: 160,
    bg: '#b02a2a',
    fg: '#ffffff',
    border: '#ffffff',
    sub: nameEn,
    fontScale: 0.52,
  });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.04, 0.3), mat);
  face.position.z = 0.035;
  g.add(face);
  return g;
}

/** 港鐵時鐘（站內／出口）。 */
export function addMtrClock(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  ry = 0,
  size = 0.3,
): THREE.Mesh {
  const mat = lib.symbol('mtrClock', 128, 128, (ctx) => {
    ctx.fillStyle = '#10151c';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#f2f5f8';
    ctx.beginPath();
    ctx.arc(64, 64, 54, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#10151c';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.lineWidth = 4;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(64 + Math.cos(a) * 44, 64 + Math.sin(a) * 44);
      ctx.lineTo(64 + Math.cos(a) * 50, 64 + Math.sin(a) * 50);
      ctx.stroke();
    }
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(64, 64);
    ctx.lineTo(64 + Math.cos(-1.1) * 32, 64 + Math.sin(-1.1) * 32);
    ctx.moveTo(64, 64);
    ctx.lineTo(64 + Math.cos(0.6) * 22, 64 + Math.sin(0.6) * 22);
    ctx.stroke();
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  mesh.position.set(x, y, z);
  mesh.rotation.y = ry;
  parent.add(mesh);
  return mesh;
}

export interface MtrEntranceSpec {
  x?: number;
  z?: number;
  y?: number;
  ry?: number;
  nameZh?: string;
  nameEn?: string;
  exit?: string;
  /** 有蓋出口（有玻璃頂）或露天樓梯 */
  canopy?: boolean;
  /** 加一條行人天橋（連去旁邊） */
  footbridge?: boolean;
}

/**
 * 港鐵站出入口：往地下的樓梯＋玻璃上蓋＋MTR 標誌＋站名牌＋出口牌。
 * 模型「出口朝 +z」，可用 ry 轉向道路。
 */
export function addMtrEntrance(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  spec: MtrEntranceSpec = {},
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(spec.x ?? 0, spec.y ?? 0, spec.z ?? 0);
  g.rotation.y = spec.ry ?? 0;
  parent.add(g);
  const exitCode = spec.exit ?? 'A1';
  const nameZh = spec.nameZh ?? '香港站';
  const nameEn = spec.nameEn ?? 'Hong Kong Station';
  const canopy = spec.canopy ?? true;

  // 樓梯口：深色豎井＋下行梯級
  addBox(g, lib.lambert(PAL.concreteDark), 1.5, 0.22, 1.2, 0, 0.11, 0);
  const pitMat = lib.lambert(0x14181e);
  addBox(g, pitMat, 1.3, 0.08, 0.9, 0, 0.23, 0.1);
  for (let i = 0; i < 4; i++) {
    addBox(g, lib.lambert(PAL.concreteLight), 1.1, 0.06, 0.1, 0, 0.24 - i * 0.02, 0.28 - i * 0.09);
  }
  // 下行扶手／欄杆
  addRailing(g, lib, -0.72, 0.62, -0.72, -0.42, 0.55, { y: 0.22, color: PAL.aluminium });
  addRailing(g, lib, 0.72, 0.62, 0.72, -0.42, 0.55, { y: 0.22, color: PAL.aluminium });
  // 出口牌
  addLabelSign(g, lib, {
    text: `出口 ${exitCode} EXIT`,
    x: 0,
    y: 0.62,
    z: 0.68,
    w: 0.9,
    h: 0.2,
    bg: '#101820',
    fg: '#ffffff',
    border: '#e8ece8',
  });

  if (canopy) {
    // 玻璃上蓋（懸臂）
    const glassMat = lib.lambert(PAL.glassBlue, { transparent: true, opacity: 0.42 });
    const roof = addBox(g, lib.lambert(PAL.aluminium), 1.7, 0.07, 1.5, 0, 1.62, 0.1);
    roof.castShadow = true;
    addBox(g, glassMat, 1.55, 0.03, 1.35, 0, 1.56, 0.1);
    // 支柱
    addCylinder(g, lib.lambert(PAL.steelGrey), 0.045, 0.055, 1.6, -0.72, 0.8, 0.62, 6);
    addCylinder(g, lib.lambert(PAL.steelGrey), 0.045, 0.055, 1.6, 0.72, 0.8, 0.62, 6);
    // MTR 標誌（上蓋正面）
    addMtrLogo(g, lib, 0, 1.42, 0.78, 0, 0.34);
    // 站名牌
    addStationNameBand(g, lib, 0, 1.88, 0.5, nameZh, nameEn, 0, 1.5);
    // 時鐘
    addMtrClock(g, lib, 0.66, 1.4, 0.79, 0, 0.24);
    // 後方機房／通風井
    addBox(g, lib.lambert(PAL.tileWhite), 1.2, 1.1, 0.5, 0, 0.55, -0.5);
    addBox(g, lib.lambert(PAL.steelGrey), 0.6, 0.3, 0.04, 0, 1.28, -0.24);
  } else {
    addMtrLogo(g, lib, 0, 0.75, 0.68, 0, 0.3);
    addStationNameBand(g, lib, 0, 1.05, 0.55, nameZh, nameEn, 0, 1.3);
  }

  if (spec.footbridge) {
    addFootbridge(g, lib, { x: 0, y: 2.1, z: -0.9, len: 3.2, width: 1.0, ry: Math.PI / 2, support: true });
  }
  return g;
}

/** 行人天橋（玻璃上蓋＋兩端樓梯）。 */
export function addFootbridge(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  spec: { x?: number; y?: number; z?: number; len?: number; width?: number; ry?: number; support?: boolean },
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(spec.x ?? 0, spec.y ?? 1.3, spec.z ?? 0);
  g.rotation.y = spec.ry ?? 0;
  parent.add(g);
  const len = spec.len ?? 3;
  const width = spec.width ?? 1;
  // 橋身
  addBox(g, lib.lambert(PAL.concreteLight), len, 0.14, width, 0, 0, 0);
  // 玻璃側板
  const glassMat = lib.lambert(PAL.glassBlue, { transparent: true, opacity: 0.4 });
  addBox(g, glassMat, len, 0.75, 0.04, 0, 0.45, width / 2 - 0.03);
  addBox(g, glassMat, len, 0.75, 0.04, 0, 0.45, -width / 2 + 0.03);
  // 上蓋
  addBox(g, lib.lambert(PAL.aluminium), len + 0.1, 0.08, width + 0.1, 0, 0.9, 0);
  // 欄杆
  addRailing(g, lib, -len / 2, width / 2, len / 2, width / 2, 0.4, { y: 0.08, color: PAL.steelGrey });
  addRailing(g, lib, -len / 2, -width / 2, len / 2, -width / 2, 0.4, { y: 0.08, color: PAL.steelGrey });
  if (spec.support) {
    const colMat = lib.lambert(PAL.concrete);
    addCylinder(g, colMat, 0.1, 0.12, 1.3, -len / 2 + 0.3, -0.72, 0, 8);
    addCylinder(g, colMat, 0.1, 0.12, 1.3, len / 2 - 0.3, -0.72, 0, 8);
  }
  // 橋上光管
  addBox(g, lib.neonTube(PAL.wallWhite), len * 0.9, 0.03, 0.05, 0, 0.82, 0);
  return g;
}

// ─────────────────────────── 巴士／電車 ───────────────────────────

/** 巴士總站月台上蓋（懸臂式）。 */
export function addBusCanopy(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  spec: { x?: number; z?: number; y?: number; w?: number; d?: number; ry?: number; height?: number },
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(spec.x ?? 0, spec.y ?? 0, spec.z ?? 0);
  g.rotation.y = spec.ry ?? 0;
  parent.add(g);
  const w = spec.w ?? 2.4;
  const d = spec.d ?? 1.1;
  const h = spec.height ?? 1.5;
  // 柱
  const colMat = lib.lambert(PAL.steelGrey);
  const cols = Math.max(2, Math.round(w / 0.9) + 1);
  for (let i = 0; i < cols; i++) {
    const px = -w / 2 + (w / (cols - 1)) * i;
    addCylinder(g, colMat, 0.055, 0.07, h, px, h / 2, -d / 2 + 0.08, 6);
  }
  // 上蓋（微微傾斜）
  const roof = addBox(g, lib.lambert(PAL.aluminium), w, 0.08, d, 0, h + 0.06, 0);
  roof.rotation.x = -0.04;
  addBox(g, lib.lambert(PAL.concreteLight), w, 0.05, d, 0, h + 0.12, 0).rotation.x = -0.04;
  // 邊緣燈帶（夜間亮）
  addBox(g, lib.neonTube(PAL.wallWhite), w, 0.035, 0.05, 0, h + 0.01, d / 2 - 0.02);
  return g;
}

/** 電車站（綠色叮叮站亭＋站牌）。 */
export function addTramShelter(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  ry = 0,
  y = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  const green = lib.lambert(PAL.tramGreen);
  // 上蓋
  addBox(g, green, 1.9, 0.07, 0.72, 0, 1.5, 0);
  addBox(g, lib.lambert(PAL.wallWhite), 1.94, 0.06, 0.76, 0, 1.56, 0);
  // 柱
  for (const px of [-0.85, 0.85]) {
    addCylinder(g, green, 0.035, 0.04, 1.5, px, 0.75, 0.3, 6);
    addCylinder(g, green, 0.035, 0.04, 1.5, px, 0.75, -0.3, 6);
  }
  // 背板（玻璃）
  addBox(g, lib.lambert(PAL.glassDark, { transparent: true, opacity: 0.5 }), 1.8, 1.2, 0.03, 0, 0.7, -0.33);
  // 長椅
  addBench(g, lib, 0.2, -0.1, 0, 0, PAL.woodLight);
  // 站牌
  addCylinder(g, lib.lambert(PAL.steelGrey), 0.025, 0.03, 1.9, -0.98, 0.95, 0.42, 6);
  const signMat = lib.label('電車站', {
    w: 384,
    h: 160,
    bg: '#2f8f5f',
    fg: '#ffffff',
    border: '#ffffff',
    sub: 'TRAM STOP 1 2 3',
  });
  addBox(g, green, 0.44, 0.3, 0.05, -0.98, 1.78, 0.42);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.26), signMat);
  face.position.set(-0.98, 1.78, 0.45);
  g.add(face);
  // 電車軌
  addTramRails(g, lib, 0, 0.5, 2.0, 0, 0.02);
  return g;
}

/** 電車路軌（兩條鋼軌＋枕木）。 */
export function addTramRails(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  len: number,
  ry = 0,
  y = 0.02,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  const railMat = lib.lambert(0x9aa0a4);
  addBox(g, railMat, len, 0.025, 0.05, 0, 0, -0.36);
  addBox(g, railMat, len, 0.025, 0.05, 0, 0, 0.36);
  // 枕木
  for (let i = 0; i < 7; i++) {
    addBox(g, lib.lambert(PAL.concreteDark), 0.12, 0.02, 0.9, -len / 2 + (len / 6) * i, -0.005, 0);
  }
  return g;
}

/** 電車架空電纜柱＋電線。 */
export function addTramWires(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  h = 2.1,
  y = 0,
): void {
  const mat = lib.lambert(PAL.steelGrey);
  addCylinder(parent, mat, 0.03, 0.04, h, x1, y + h / 2, z1, 6);
  addCylinder(parent, mat, 0.03, 0.04, h, x2, y + h / 2, z2, 6);
  addBeamBetween(
    parent,
    lib.lambert(0x3a3a3a),
    new THREE.Vector3(x1, y + h - 0.04, z1),
    new THREE.Vector3(x2, y + h - 0.04, z2),
    0.012,
    3,
  );
  addBeamBetween(parent, mat, new THREE.Vector3(x1, y + h - 0.2, z1), new THREE.Vector3(x2, y + h - 0.2, z2), 0.02, 3);
}

// ─────────────────────────── 渡輪碼頭 ───────────────────────────

/** 鐘樓（天星碼頭）。 */
export function addClockTower(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  baseH = 1.8,
  size = 0.7,
  y = 0,
  color: number = PAL.wallWhite,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  addBox(g, lib.lambert(color), size, baseH, size, 0, baseH / 2, 0);
  addBox(g, lib.lambert(PAL.concreteLight), size + 0.06, 0.08, size + 0.06, 0, baseH - 0.02, 0);
  addBox(g, lib.lambert(color), size * 0.72, 0.5, size * 0.72, 0, baseH + 0.25, 0);
  // 四面鐘
  const cy = baseH - 0.24;
  for (const [dx, dz, ry] of [
    [0, size / 2 + 0.01, 0],
    [0, -size / 2 - 0.01, Math.PI],
    [size / 2 + 0.01, 0, Math.PI / 2],
    [-size / 2 - 0.01, 0, -Math.PI / 2],
  ] as [number, number, number][]) {
    const face = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.34, size * 0.34), clockFaceMaterial(lib));
    face.position.set(dx, cy, dz);
    face.rotation.y = ry;
    g.add(face);
  }
  // 尖頂
  addCone(g, lib.lambert(PAL.tramGreen), 0.46, 0.6, 0, baseH + 0.8, 0, 4, Math.PI / 4);
  addCylinder(g, lib.lambert(PAL.gold), 0.015, 0.02, 0.4, 0, baseH + 1.28, 0, 4);
  addSphere(g, lib.lambert(PAL.gold), 0.05, 0, baseH + 1.5, 0, 6, 4);
  return g;
}

function clockFaceMaterial(lib: MaterialLibrary): THREE.Material {
  return lib.symbol('clockFace', 128, 128, (ctx) => {
    ctx.fillStyle = '#f4f1e8';
    ctx.beginPath();
    ctx.arc(64, 64, 60, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.lineWidth = 4;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(64 + Math.cos(a) * 46, 64 + Math.sin(a) * 46);
      ctx.lineTo(64 + Math.cos(a) * 54, 64 + Math.sin(a) * 54);
      ctx.stroke();
    }
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(64, 64);
    ctx.lineTo(64, 30);
    ctx.moveTo(64, 64);
    ctx.lineTo(88, 72);
    ctx.stroke();
  });
}

/** 碼頭跳板／登船橋。 */
export function addGangway(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  len = 1.6,
  ry = 0,
  tilt = -0.1,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  addBox(g, lib.lambert(PAL.woodLight), len, 0.07, 0.8, len / 2, 0, 0).rotation.z = tilt;
  addRailing(g, lib, 0, 0.4, len * 0.95, 0.4, 0.4, { y: 0.05, color: PAL.wallWhite });
  addRailing(g, lib, 0, -0.4, len * 0.95, -0.4, 0.4, { y: 0.05, color: PAL.wallWhite });
  return g;
}

/** 救生圈。 */
export function addLifeRing(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  ry = 0,
): THREE.Mesh {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.035, 6, 10), lib.lambert(PAL.neonOrange));
  ring.position.set(x, y, z);
  ring.rotation.y = ry;
  parent.add(ring);
  return ring;
}

/** 碼頭樁柱。 */
export function addPilings(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  w: number,
  d: number,
  y = -0.4,
): void {
  const mat = lib.lambert(PAL.woodDark);
  for (let i = 0; i < 4; i++) {
    const px = x - w / 2 + (w / 3) * (i % 2 === 0 ? 0 : 2);
    const pz = z - d / 2 + (d / 3) * (i < 2 ? 0 : 2);
    addCylinder(parent, mat, 0.07, 0.08, 0.8, px, y + 0.4, pz, 6);
  }
}

/** 售票處／候船室小亭。 */
export function addTicketBooth(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  ry = 0,
  y = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  addBox(g, lib.lambert(PAL.wallWhite), 0.9, 1.0, 0.7, 0, 0.5, 0);
  addBox(g, lib.lambert(PAL.tramGreen), 1.0, 0.1, 0.8, 0, 1.05, 0);
  addBox(g, lib.lambert(PAL.glassDark), 0.5, 0.4, 0.03, 0, 0.75, 0.36);
  const mat = lib.label('售票處', { w: 256, h: 96, bg: '#e8ece8', fg: '#1b2b33', border: '#2f7f6a' });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.18), mat);
  face.position.set(0, 0.36, 0.37);
  g.add(face);
  return g;
}

// ─────────────────────────── 工業／發電廠／水務 ───────────────────────────

/** 煙囪（紅白間條＋煙霧動畫）。 */
export function addChimney(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  radius = 0.36,
  h = 3.2,
  y = 0,
  opts: { smoke?: boolean; bandColor?: number } = {},
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  const concrete = lib.lambert(PAL.concreteLight);
  addCylinder(g, concrete, radius * 0.72, radius, h, 0, h / 2, 0, 12);
  // 紅白間條
  const bandColor = opts.bandColor ?? PAL.fireRed;
  const bands = Math.max(3, Math.round(h / 0.55));
  for (let i = 1; i < bands; i += 2) {
    const by = (h / bands) * i + h / bands / 2;
    const r = radius * (1 - 0.28 * (by / h)) + 0.015;
    addCylinder(g, lib.lambert(bandColor), r, r, h / bands, 0, by, 0, 12);
  }
  addCylinder(g, lib.lambert(PAL.concreteDark), radius * 0.75, radius * 0.75, 0.12, 0, h - 0.05, 0, 12);
  // 爬梯
  addBox(g, lib.lambert(PAL.ironDark), 0.03, h * 0.9, 0.03, radius + 0.02, h * 0.45, 0);
  if (opts.smoke !== false) addSmokePlume(g, lib, 0, h + 0.1, 0, 0.9, PAL.smoke);
  return g;
}

/** 煙／蒸氣（anim 'smoke'：buildings.ts 會令煙團上升放大）。 */
export function addSmokePlume(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  scale = 1,
  color: number = PAL.smoke,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.userData.anim = 'smoke';
  parent.add(g);
  const mat = lib.lambert(color);
  for (let i = 0; i < 4; i++) {
    const ball = addSphere(g, mat, 0.22 * scale, 0, i * 0.22 * scale, 0, 6, 4);
    ball.scale.setScalar(1 - i * 0.12);
  }
  return g;
}

/** 冷卻塔（雙曲線塔身＋蒸氣）。 */
export function addCoolingTower(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  radius = 0.9,
  h = 2.6,
  y = 0,
  steam = true,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  // 雙曲線剖面
  const points: THREE.Vector2[] = [];
  const profile: [number, number][] = [
    [1.0, 0],
    [0.86, 0.12],
    [0.62, 0.32],
    [0.46, 0.55],
    [0.42, 0.74],
    [0.5, 0.92],
    [0.56, 1.0],
  ];
  for (const [r, t] of profile) points.push(new THREE.Vector2(radius * r, h * t));
  const geo = new THREE.LatheGeometry(points, 14);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, lib.lambert(PAL.concreteLight));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);
  // 塔底支柱
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    addCylinder(g, lib.lambert(PAL.concreteDark), 0.035, 0.04, 0.16, Math.cos(a) * radius * 0.82, 0.08, Math.sin(a) * radius * 0.82, 4);
  }
  addCylinder(g, lib.lambert(PAL.concrete), radius * 0.58, radius * 0.6, 0.06, 0, h - 0.02, 0, 14);
  if (steam) addSmokePlume(g, lib, 0, h + 0.05, 0, 1.4, PAL.steam);
  return g;
}

/** 儲存倉／水泥筒倉。 */
export function addSilo(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  radius = 0.5,
  h = 1.6,
  y = 0,
  color: number = PAL.concreteLight,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  addCylinder(g, lib.lambert(color), radius, radius, h, 0, h / 2, 0, 12);
  addCone(g, lib.lambert(PAL.aluminiumDark), radius, radius * 0.55, 0, h + radius * 0.27, 0, 12);
  // 支腳
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    addCylinder(g, lib.lambert(PAL.steelGrey), 0.04, 0.045, 0.4, Math.cos(a) * radius * 0.7, 0.2, Math.sin(a) * radius * 0.7, 4);
  }
  // 輸送管
  addBeamBetween(
    g,
    lib.lambert(PAL.steelGrey),
    new THREE.Vector3(radius, 0.4, 0),
    new THREE.Vector3(radius + 0.5, h * 0.8, 0),
    0.06,
    5,
  );
  return g;
}

/** 工業管道。 */
export function addPipeRun(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  a: THREE.Vector3,
  b: THREE.Vector3,
  thickness = 0.08,
  color: number = PAL.steelGrey,
): void {
  addBeamBetween(parent, lib.lambert(color), a, b, thickness, 6);
}

/** 發電廠變壓器／開關站設備。 */
export function addTransformer(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  y = 0,
  scale = 1,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  const s = scale;
  addBox(g, lib.lambert(PAL.steelGrey), 0.5 * s, 0.42 * s, 0.36 * s, 0, 0.21 * s, 0);
  for (let i = 0; i < 3; i++) {
    addCylinder(g, lib.lambert(PAL.concreteLight), 0.035 * s, 0.045 * s, 0.34 * s, -0.14 * s + i * 0.14 * s, 0.56 * s, 0, 6);
  }
  addBox(g, lib.lambert(PAL.ironDark), 0.55 * s, 0.04 * s, 0.4 * s, 0, 0.02 * s, 0);
  return g;
}

/** 高壓電塔（簡化桁架）＋電線。 */
export function addPylon(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  h = 3.0,
  y = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  const mat = lib.lambert(PAL.steelGrey);
  // 四柱微微收窄
  for (const [dx, dz] of [
    [-0.32, -0.32],
    [0.32, -0.32],
    [-0.32, 0.32],
    [0.32, 0.32],
  ]) {
    addBeamBetween(
      g,
      mat,
      new THREE.Vector3(dx, 0, dz),
      new THREE.Vector3(dx * 0.35, h, dz * 0.35),
      0.045,
      4,
    );
  }
  // 橫担
  for (let i = 0; i < 3; i++) {
    const hy = h * (0.62 + i * 0.16);
    const hw = 0.85 - i * 0.18;
    addBox(g, mat, hw * 2, 0.05, 0.05, 0, hy, 0);
  }
  // 斜撐
  addBeamBetween(g, mat, new THREE.Vector3(-0.32, 0.4, -0.32), new THREE.Vector3(0.32, h * 0.6, 0.32), 0.025, 3);
  return g;
}

// ─────────────────────────── 貨櫃碼頭 ───────────────────────────

/** 貨櫃（顏色由 caller 決定）。 */
export function addContainer(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  color: number,
  ry = 0,
): THREE.Mesh {
  const mesh = addBox(parent, lib.lambert(color), w, h, d, x, y + h / 2, z, ry);
  // 櫃門框（深色邊）
  const dark = lib.lambert(0x3a3a3a);
  addBox(parent, dark, w * 0.98, 0.035, d + 0.02, x, y + h - 0.02, z, ry);
  addBox(parent, dark, w * 0.98, 0.035, d + 0.02, x, y + 0.02, z, ry);
  return mesh;
}

/** 貨櫃堆（cols × rows × layers）。 */
export function addContainerStack(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  cols: number,
  rows: number,
  layers: number,
  seed = 0,
  y = 0,
  containerW = 1.15,
  containerD = 0.55,
  containerH = 0.5,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  const colors = [PAL.cargoRed, PAL.cargoBlue, PAL.cargoYellow, PAL.cargoGreen, PAL.cargoGrey, PAL.cargoOrange];
  for (let layer = 0; layer < layers; layer++) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (hash01(seed + layer * 7.1 + row * 3.3 + col * 1.7) > 0.88) continue;
        const c = pick(colors, seed + layer * 5 + row * 11 + col * 3);
        addContainer(
          g,
          lib,
          (col - (cols - 1) / 2) * (containerW + 0.04),
          layer * (containerH + 0.015),
          (row - (rows - 1) / 2) * (containerD + 0.06),
          containerW,
          containerH,
          containerD,
          c,
        );
      }
    }
  }
  return g;
}

/** 龍門吊機（貨櫃碼頭；吊機小車 anim 'crane'）。 */
export function addGantryCrane(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  ry = 0,
  y = 0,
  scale = 1,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  const s = scale;
  const steel = lib.lambert(PAL.steelGrey);
  const white = lib.lambert(PAL.wallWhite);
  const legH = 3.4 * s;
  const span = 2.6 * s;
  const railSpan = 1.8 * s;
  // 四條腿（A 字架）
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      addBeamBetween(
        g,
        steel,
        new THREE.Vector3(sx * span * 0.5, 0, sz * railSpan * 0.5),
        new THREE.Vector3(sx * span * 0.42, legH, sz * railSpan * 0.36),
        0.1 * s,
        6,
      );
      addCylinder(g, lib.lambert(PAL.ironDark), 0.16 * s, 0.16 * s, 0.16 * s, sx * span * 0.5, 0.08 * s, sz * railSpan * 0.5, 8);
    }
  }
  // 橫樑（兩條）
  for (const sz of [-1, 1]) {
    addBox(g, white, span * 0.95, 0.16 * s, 0.12 * s, 0, legH + 0.1 * s, sz * railSpan * 0.36);
  }
  addBox(g, white, 0.12 * s, 0.16 * s, railSpan * 0.8, -span * 0.42, legH + 0.1 * s, 0);
  addBox(g, white, 0.12 * s, 0.16 * s, railSpan * 0.8, span * 0.42, legH + 0.1 * s, 0);
  // 懸臂（伸出碼頭方向 +x）
  addBox(g, white, 3.2 * s, 0.14 * s, 0.14 * s, 1.1 * s, legH + 0.1 * s, 0);
  addBox(g, white, 3.2 * s, 0.1 * s, 0.08 * s, 1.1 * s, legH + 0.26 * s, 0);
  // 斜拉杆
  addBeamBetween(g, steel, new THREE.Vector3(-span * 0.4, legH + 0.2 * s, 0), new THREE.Vector3(1.4 * s, legH + 0.2 * s, 0), 0.05 * s, 4);
  addBeamBetween(g, steel, new THREE.Vector3(0, legH * 0.55, 0), new THREE.Vector3(2.2 * s, legH + 0.24 * s, 0), 0.05 * s, 4);
  // 吊機小車（anim）
  const trolley = new THREE.Group();
  trolley.position.set(1.2 * s, legH + 0.02 * s, 0);
  trolley.userData.anim = 'crane';
  g.add(trolley);
  addBox(trolley, lib.lambert(PAL.busYellow), 0.34 * s, 0.2 * s, 0.5 * s, 0, 0, 0);
  addBox(trolley, lib.lambert(PAL.ironDark), 0.06 * s, 0.5 * s, 0.06 * s, 0, -0.3 * s, 0);
  addBox(trolley, lib.lambert(PAL.busYellow), 0.5 * s, 0.08 * s, 0.3 * s, 0, -0.55 * s, 0);
  // 駕駛室
  addBox(g, lib.lambert(PAL.wallWhite), 0.3 * s, 0.3 * s, 0.35 * s, -0.4 * s, legH - 0.1 * s, 0.3 * s);
  addBox(g, lib.lambert(PAL.glassDark), 0.26 * s, 0.16 * s, 0.02 * s, -0.4 * s, legH - 0.06 * s, 0.48 * s);
  // 吊機紅燈
  addSphere(g, lib.neonTube(PAL.neonRed), 0.04 * s, 0, legH + 0.35 * s, 0, 5, 4);
  // 大樑上的「葵涌」字牌
  const signMat = lib.label('葵涌貨櫃碼頭', {
    w: 640,
    h: 128,
    bg: '#1b2b33',
    fg: '#ffd166',
    border: '#ffd166',
    fontScale: 0.5,
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.6 * s, 0.5 * s), signMat);
  sign.position.set(0.2 * s, legH + 0.42 * s, 0.08 * s);
  g.add(sign);
  return g;
}

/** 碼頭岸邊（混凝土邊＋纜樁＋護舷）。 */
export function addQuay(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  w: number,
  d: number,
  y = 0,
  opts: { bollards?: number; fenders?: boolean } = {},
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  addBox(g, lib.lambert(PAL.concreteLight), w, 0.22, d, 0, 0.11, 0);
  addBox(g, lib.lambert(PAL.concreteDark), w, 0.08, d + 0.06, 0, -0.02, 0);
  const n = opts.bollards ?? Math.max(2, Math.round(w / 1.2));
  for (let i = 0; i < n; i++) {
    addCylinder(g, lib.lambert(PAL.ironDark), 0.08, 0.1, 0.22, -w / 2 + 0.3 + ((w - 0.6) / Math.max(1, n - 1)) * i, 0.3, d / 2 - 0.16, 8);
  }
  if (opts.fenders !== false) {
    for (let i = 0; i < Math.max(1, Math.round(w / 1.4)); i++) {
      addCylinder(g, lib.lambert(PAL.hazardBlack), 0.12, 0.12, 0.3, -w / 2 + 0.7 + i * 1.4, 0.02, -d / 2 - 0.14, 8, 0, Math.PI / 2);
    }
  }
  addLitterBin(g, lib, -w / 2 + 0.35, -d / 2 + 0.25, 0.02);
  return g;
}

/** 輸送帶（石礦場／碼頭）。 */
export function addConveyor(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number,
): THREE.Group {
  const g = new THREE.Group();
  parent.add(g);
  const belt = addBeamBetween(
    g,
    lib.lambert(PAL.ironDark),
    new THREE.Vector3(x1, y1, z1),
    new THREE.Vector3(x2, y2, z2),
    0.16,
    4,
  );
  belt.castShadow = true;
  // 支撐
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const midZ = (z1 + z2) / 2;
  addBeamBetween(g, lib.lambert(PAL.steelGrey), new THREE.Vector3(midX, 0, midZ), new THREE.Vector3(midX, midY, midZ), 0.06, 4);
  addBeamBetween(g, lib.lambert(PAL.steelGrey), new THREE.Vector3(x2, 0, z2), new THREE.Vector3(x2, y2, z2), 0.06, 4);
  return g;
}

/** 挖掘機（石礦場；手臂 anim 'arm'）。 */
export function addExcavator(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  ry = 0,
  y = 0,
  color: number = PAL.busYellow,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  // 履帶
  addBox(g, lib.lambert(PAL.hazardBlack), 0.9, 0.16, 0.5, 0, 0.1, 0);
  addCylinder(g, lib.lambert(PAL.ironDark), 0.1, 0.1, 0.5, -0.36, 0.1, 0, 8, 0, Math.PI / 2);
  addCylinder(g, lib.lambert(PAL.ironDark), 0.1, 0.1, 0.5, 0.36, 0.1, 0, 8, 0, Math.PI / 2);
  // 車身
  addBox(g, lib.lambert(color), 0.72, 0.3, 0.5, 0, 0.34, 0);
  // 駕駛室
  addBox(g, lib.lambert(PAL.wallWhite), 0.34, 0.32, 0.4, -0.22, 0.62, 0.02);
  addBox(g, lib.lambert(PAL.glassDark), 0.3, 0.2, 0.02, -0.22, 0.66, 0.23);
  // 手臂（anim）
  const arm = new THREE.Group();
  arm.position.set(0.18, 0.5, 0);
  arm.userData.anim = 'arm';
  g.add(arm);
  addBeamBetween(arm, lib.lambert(color), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.4, 0.5, 0), 0.11, 5);
  const fore = addBeamBetween(arm, lib.lambert(PAL.steelGrey), new THREE.Vector3(0.4, 0.5, 0), new THREE.Vector3(0.95, 0.12, 0), 0.09, 5);
  fore.castShadow = true;
  // 挖斗
  addBox(arm, lib.lambert(PAL.ironDark), 0.3, 0.24, 0.34, 1.0, 0.02, 0);
  return g;
}

/** 石礦場岩面（一層層開採台階）。 */
export function addRockFace(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  ry = 0,
  seed = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  const levels = 3;
  for (let i = 0; i < levels; i++) {
    const ly = (h / levels) * i;
    const lw = w * (1 - i * 0.12);
    const depth = 0.22 + i * 0.16;
    addBox(g, lib.lambert(i % 2 === 0 ? PAL.rock : PAL.rockDark), lw, h / levels, depth, 0, ly + h / levels / 2, -depth / 2 + 0.11);
    addBox(g, lib.lambert(PAL.rockLight), lw, 0.04, depth + 0.08, 0, ly + h / levels, -depth / 2 + 0.11);
    // 碎石
    for (let j = 0; j < 3; j++) {
      const rock = addRock(g, lib.lambert(PAL.rockDark), -lw / 2 + hash01(seed + i * 5 + j) * lw, 0.2, 0.5, seed + i + j);
      rock.position.y += 0.18 + ly;
    }
  }
  return g;
}

/** 工地／石礦場碎石堆。 */
export function addSpoilPile(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  scale = 1,
  y = 0,
  color: number = PAL.gravel,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  addCone(g, lib.lambert(color), 0.5 * scale, 0.5 * scale, 0, 0.25 * scale, 0, 7);
  addCone(g, lib.lambert(PAL.rockDark), 0.32 * scale, 0.32 * scale, 0.28 * scale, 0.16 * scale, 0.2 * scale, 6);
  return g;
}

// ─────────────────────────── 商業／街市／公園細節 ───────────────────────────

/** 街市／熟食檔簷篷（彩色間條）。 */
export function addMarketCanopy(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  spec: { x?: number; z?: number; w?: number; d?: number; h?: number; ry?: number; y?: number; colors?: number[] },
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(spec.x ?? 0, spec.y ?? 0, spec.z ?? 0);
  g.rotation.y = spec.ry ?? 0;
  parent.add(g);
  const w = spec.w ?? 2.6;
  const d = spec.d ?? 1.6;
  const h = spec.h ?? 1.4;
  const colors = spec.colors ?? [PAL.clothRed, PAL.clothWhite, PAL.clothYellow];
  // 柱
  for (const [px, pz] of [
    [-w / 2 + 0.08, d / 2 - 0.08],
    [w / 2 - 0.08, d / 2 - 0.08],
    [-w / 2 + 0.08, -d / 2 + 0.08],
    [w / 2 - 0.08, -d / 2 + 0.08],
  ]) {
    addCylinder(g, lib.lambert(PAL.steelGrey), 0.035, 0.04, h, px, h / 2, pz, 5);
  }
  // 雙坡屋頂＋間條
  const stripes = Math.max(4, Math.round(w / 0.3));
  for (let i = 0; i < stripes; i++) {
    const c = colors[i % colors.length];
    const px = -w / 2 + (w / stripes) * (i + 0.5);
    const left = addBox(g, lib.lambert(c), w / stripes + 0.005, 0.04, d / 2 + 0.16, px, h + 0.16, d / 4);
    left.rotation.x = -0.24;
    const right = addBox(g, lib.lambert(c), w / stripes + 0.005, 0.04, d / 2 + 0.16, px, h + 0.16, -d / 4);
    right.rotation.x = 0.24;
  }
  // 橫樑
  addBox(g, lib.lambert(PAL.steelGrey), w, 0.05, 0.05, 0, h + 0.02, 0);
  return g;
}

/** 街市檔口（枱＋貨＋小簷篷）。 */
export function addStall(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  ry = 0,
  seed = 0,
  y = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  // 枱
  addBox(g, lib.lambert(PAL.woodLight), 0.9, 0.06, 0.6, 0, 0.62, 0);
  for (const [px, pz] of [
    [-0.38, -0.24],
    [0.38, -0.24],
    [-0.38, 0.24],
    [0.38, 0.24],
  ]) {
    addBox(g, lib.lambert(PAL.woodDark), 0.05, 0.6, 0.05, px, 0.3, pz);
  }
  // 貨：菜／魚／肉（用顏色球／盒代替）
  const goods = [PAL.leaf, PAL.leafDark, PAL.crop, PAL.wallWhite, PAL.clothPink, PAL.neonOrange];
  for (let i = 0; i < 6; i++) {
    const c = pick(goods, seed + i * 3);
    const bx = -0.34 + (i % 3) * 0.32;
    const bz = -0.14 + Math.floor(i / 3) * 0.26;
    if (i % 2 === 0) {
      addBox(g, lib.lambert(c), 0.2, 0.1, 0.16, bx, 0.7, bz);
    } else {
      addSphere(g, lib.lambert(c), 0.08, bx, 0.72, bz, 6, 4);
    }
  }
  // 小簷篷
  const canopy = addBox(g, lib.lambert(seed % 2 === 0 ? PAL.clothRed : PAL.clothBlue), 1.0, 0.04, 0.8, 0, 1.35, 0);
  canopy.rotation.x = 0.12;
  addCylinder(g, lib.lambert(PAL.steelGrey), 0.025, 0.025, 1.3, -0.46, 0.65, -0.3, 5);
  addCylinder(g, lib.lambert(PAL.steelGrey), 0.025, 0.025, 1.3, 0.46, 0.65, -0.3, 5);
  // 紅膠燈罩
  addRedLamp(g, lib, 0, 1.28, 0.1);
  return g;
}

/** 紅色膠燈罩（街市經典；暖黃燈膽）。 */
export function addRedLamp(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  scale = 1,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  const s = scale;
  addCylinder(g, lib.lambert(PAL.ironDark), 0.008 * s, 0.008 * s, 0.18 * s, 0, 0.09 * s, 0, 4);
  const shade = addCone(g, lib.lambert(PAL.fireRed), 0.15 * s, 0.13 * s, 0, 0, 0, 10);
  shade.rotation.x = Math.PI;
  addSphere(g, lib.basic(PAL.neonGold), 0.045 * s, 0, -0.04 * s, 0, 6, 4);
  return g;
}

/** 入口簷篷（學校／醫院／商廈）。 */
export function addCanopy(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  spec: { x: number; y: number; z: number; w: number; d: number; ry?: number; color?: number; glass?: boolean },
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(spec.x, spec.y, spec.z);
  g.rotation.y = spec.ry ?? 0;
  parent.add(g);
  const roofMat = spec.glass
    ? lib.lambert(PAL.glassBlue, { transparent: true, opacity: 0.45 })
    : lib.lambert(spec.color ?? PAL.aluminium);
  addBox(g, roofMat, spec.w, 0.06, spec.d, 0, 0, 0);
  addBox(g, lib.lambert(PAL.steelGrey), spec.w, 0.04, 0.05, 0, -0.06, spec.d / 2 - 0.02);
  // 支柱
  const cols = Math.max(2, Math.round(spec.w / 1.1) + 1);
  for (let i = 0; i < cols; i++) {
    const px = -spec.w / 2 + (spec.w / (cols - 1)) * i;
    addCylinder(g, lib.lambert(PAL.steelGrey), 0.03, 0.035, 0.9, px, -0.5, spec.d / 2 - 0.08, 5);
  }
  return g;
}

/** 停車場／巴士站排隊欄。 */
export function addQueueRail(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  len: number,
  ry = 0,
  y = 0,
): void {
  addRailing(parent, lib, x, z, x + Math.cos(ry) * len, z - Math.sin(ry) * len, 0.75, {
    y,
    color: PAL.steelGrey,
  });
}

/** 籃球架（學校／公園）。 */
export function addBasketballHoop(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  ry = 0,
  y = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  addCylinder(g, lib.lambert(PAL.steelGrey), 0.05, 0.06, 1.3, 0, 0.65, 0, 6);
  addBox(g, lib.lambert(PAL.wallWhite), 0.5, 0.34, 0.04, 0.22, 1.2, 0);
  addBox(g, lib.lambert(PAL.ironDark), 0.16, 0.1, 0.02, 0.22, 1.16, 0.03);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.015, 4, 8), lib.lambert(PAL.neonOrange));
  rim.rotation.x = Math.PI / 2;
  rim.position.set(0.22, 1.06, 0.16);
  g.add(rim);
  return g;
}

/** 直升機坪（醫院天台）。 */
export function addHelipad(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  r = 1.2,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  addCylinder(g, lib.lambert(PAL.concreteDark), r, r, 0.06, 0, 0.03, 0, 16);
  addCylinder(g, lib.lambert(PAL.concreteLight), r * 0.92, r * 0.92, 0.02, 0, 0.07, 0, 16);
  const yellow = lib.lambert(PAL.hazardYellow);
  // H 字
  addBox(g, yellow, 0.1, 0.02, r * 0.9, -r * 0.3, 0.09, 0);
  addBox(g, yellow, 0.1, 0.02, r * 0.9, r * 0.3, 0.09, 0);
  addBox(g, yellow, r * 0.6, 0.02, 0.1, 0, 0.09, 0);
  // 邊圈
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.82, 0.03, 4, 20), lib.lambert(PAL.wallWhite));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.09;
  g.add(ring);
  return g;
}

/** 消防局紅色捲閘。 */
export function addRollerDoor(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  ry = 0,
  color: number = PAL.fireRed,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  addBox(g, lib.lambert(color), w, h, 0.1, 0, h / 2, 0);
  // 橫紋
  const slats = Math.max(4, Math.round(h / 0.18));
  for (let i = 1; i < slats; i++) {
    addBox(g, lib.lambert(PAL.fireRedDark), w, 0.02, 0.12, 0, (h / slats) * i, 0);
  }
  // 門框
  addBox(g, lib.lambert(PAL.concreteLight), 0.1, h + 0.12, 0.16, -w / 2 - 0.05, (h + 0.12) / 2, 0);
  addBox(g, lib.lambert(PAL.concreteLight), 0.1, h + 0.12, 0.16, w / 2 + 0.05, (h + 0.12) / 2, 0);
  addBox(g, lib.lambert(PAL.concreteLight), w + 0.2, 0.12, 0.16, 0, h + 0.06, 0);
  return g;
}

/** 雪糕車（富豪雪糕／雪糕電單車；靜態裝飾）。 */
export function addIceCreamVan(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  ry = 0,
  y = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  const cream = lib.lambert(0xf2ead6);
  // 車身
  addBox(g, cream, 1.15, 0.5, 0.55, 0, 0.48, 0);
  // 車頭
  addBox(g, lib.lambert(PAL.wallWhite), 0.36, 0.36, 0.52, 0.68, 0.38, 0);
  addBox(g, lib.lambert(PAL.glassDark), 0.02, 0.2, 0.4, 0.86, 0.46, 0);
  // 藍色腰線
  addBox(g, lib.lambert(PAL.busYellow), 1.2, 0.07, 0.57, 0.05, 0.55, 0);
  // 車輪
  for (const [wx, wz] of [
    [-0.32, 0.28],
    [0.4, 0.28],
    [-0.32, -0.28],
    [0.4, -0.28],
  ]) {
    addCylinder(g, lib.lambert(PAL.ironDark), 0.13, 0.13, 0.1, wx, 0.13, wz, 8, 0, Math.PI / 2);
  }
  // 雪糕櫃窗
  addBox(g, lib.lambert(PAL.glassDark), 0.5, 0.26, 0.02, -0.18, 0.48, 0.28);
  // 招牌
  const signMat = lib.label('富豪雪糕', {
    w: 512,
    h: 128,
    bg: '#e8ece8',
    fg: '#b02a2a',
    border: '#2a5f9f',
    sub: 'MOBILE SOFT ICE CREAM',
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.24), signMat);
  sign.position.set(-0.18, 0.72, 0.29);
  g.add(sign);
  // 太陽傘
  addCylinder(g, lib.lambert(PAL.steelGrey), 0.02, 0.02, 1.4, -0.5, 0.7, 0.4, 5);
  addCone(g, lib.lambert(PAL.clothYellow), 0.45, 0.22, -0.5, 1.4, 0.4, 8);
  addCylinder(g, lib.lambert(PAL.clothRed), 0.44, 0.44, 0.02, -0.5, 1.3, 0.4, 8);
  return g;
}

/** 公共洗手間／更衣室小屋（公園／海濱）。 */
export function addPublicToilet(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  ry = 0,
  y = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  addBox(g, lib.lambert(PAL.tileWhite), 1.1, 0.9, 0.8, 0, 0.45, 0);
  addBox(g, lib.lambert(PAL.concreteLight), 1.2, 0.08, 0.9, 0, 0.94, 0);
  addBox(g, lib.lambert(PAL.ironDark), 0.34, 0.6, 0.04, -0.22, 0.3, 0.42);
  addBox(g, lib.lambert(PAL.ironDark), 0.34, 0.6, 0.04, 0.22, 0.3, 0.42);
  const mat = lib.label('洗手間', { w: 256, h: 96, bg: '#2a5f9f', fg: '#ffffff', border: '#ffffff' });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.18), mat);
  face.position.set(0, 0.8, 0.43);
  g.add(face);
  return g;
}

/** 單車停放處（海濱／港鐵站外）。 */
export function addBikeRack(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  ry = 0,
  y = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  const metal = lib.lambert(PAL.steelGrey);
  for (let i = 0; i < 4; i++) {
    const px = -0.45 + i * 0.3;
    addBox(g, metal, 0.03, 0.34, 0.03, px, 0.17, 0);
    addBox(g, metal, 0.03, 0.03, 0.6, px, 0.34, 0);
  }
  return g;
}
