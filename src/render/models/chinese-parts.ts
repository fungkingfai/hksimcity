/**
 * 華夏古城 — 中式建築常用「零件」：曲面屋簷、燈籠、匾額、旗幡、窗櫺、
 * 石獅、樹木、酒罈、貨箱……由 building-prototypes 組合出 22 種建築。
 *
 * 動畫：需要每幀微動的節點以 `markAnim()` 標記 `userData.anim`，
 * BuildingsView 會在建立實例時收集並做極廉價的 transform 動畫
 * （不重建幾何、不改共用材質）。
 */

import * as THREE from 'three';
import { MaterialLibrary, PAL } from './materials';
import {
  addBeamBetween,
  addBox,
  addCone,
  addCylinder,
  addLathe,
  addPlane,
  addSphere,
  buildCurvedRoof,
  type CurvedRoofOptions,
} from './geometry-utils';

export type AnimKind = 'lantern' | 'banner' | 'smoke' | 'bob' | 'glow' | 'wheel' | 'flame' | 'person';

/** 標記動畫節點（會被 BuildingsView 收集）。 */
export function markAnim(obj: THREE.Object3D, kind: AnimKind): THREE.Object3D {
  obj.userData.anim = kind;
  return obj;
}

// ─────────────────────────── 屋頂 ───────────────────────────

export interface ChineseRoofOptions extends CurvedRoofOptions {
  x?: number;
  y?: number;
  z?: number;
  /** 瓦色；預設青瓦 */
  tileColor?: number;
  /** 脊飾：none / simple（脊獸） / gold（貼金寶頂） */
  ornaments?: 'none' | 'simple' | 'gold';
  /** 是否加垂脊與簷口木 */
  details?: boolean;
}

/** 中式曲面屋頂（含垂脊、正脊、簷口起翹木、脊飾）。原點在簷口中心。 */
export function addChineseRoof(parent: THREE.Object3D, lib: MaterialLibrary, opts: ChineseRoofOptions): THREE.Group {
  const group = new THREE.Group();
  group.position.set(opts.x ?? 0, opts.y ?? 0, opts.z ?? 0);
  const frame = buildCurvedRoof(opts);
  const tileMat = lib.lambert(opts.tileColor ?? PAL.tile, { side: THREE.DoubleSide });
  const darkMat = lib.lambert(PAL.tileDark, { side: THREE.DoubleSide });
  const trimMat = lib.lambert(PAL.woodDark);

  const roof = new THREE.Mesh(frame.geometry, tileMat);
  roof.castShadow = true;
  roof.receiveShadow = true;
  group.add(roof);

  if (opts.details !== false) {
    // 垂脊：四角 → 正脊兩端
    const ridgeTargetA = frame.ridgeA;
    const ridgeTargetB = frame.ridgeB;
    const targets = [ridgeTargetA, ridgeTargetB, ridgeTargetB, ridgeTargetA];
    for (let i = 0; i < 4; i++) {
      addBeamBetween(group, darkMat, frame.corners[i], targets[i], 0.11, 4);
    }
    // 正脊
    if (frame.ridgeLength > 0.04) {
      addBeamBetween(group, darkMat, frame.ridgeA, frame.ridgeB, 0.16, 4);
      if (opts.ornaments === 'gold' || opts.ornaments === 'simple') {
        const goldMat = lib.lambert(PAL.gold);
        for (const end of [frame.ridgeA, frame.ridgeB]) {
          const dir = end.x < 0 ? -1 : 1;
          const tail = addBox(group, goldMat, 0.22, 0.26, 0.1, end.x + dir * 0.03, end.y + 0.14, 0);
          tail.rotation.z = dir * 0.35;
        }
      }
    } else {
      // 攢尖寶頂
      addCylinder(group, darkMat, 0.1, 0.13, 0.16, 0, frame.height + 0.06, 0, 6);
      addSphere(group, lib.lambert(opts.ornaments === 'gold' ? PAL.gold : PAL.tileLight), 0.13, 0, frame.height + 0.2, 0, 8, 6);
      addCone(group, lib.lambert(opts.ornaments === 'gold' ? PAL.gold : PAL.tileLight), 0.07, 0.3, 0, frame.height + 0.36, 0, 6);
    }
    // 簷口木：沿四邊由角（起翹）到邊中（低點）的折線
    for (let i = 0; i < 4; i++) {
      const a = frame.corners[i];
      const b = frame.corners[(i + 1) % 4];
      const mid = new THREE.Vector3((a.x + b.x) / 2, 0.0, (a.z + b.z) / 2);
      addBeamBetween(group, trimMat, a, mid, 0.09, 4);
      addBeamBetween(group, trimMat, mid, b, 0.09, 4);
    }
  }
  parent.add(group);
  return group;
}

/** 寶頂／塔剎。 */
export function addFinial(parent: THREE.Object3D, lib: MaterialLibrary, x: number, y: number, z: number, scale = 1): THREE.Group {
  const g = new THREE.Group();
  const gold = lib.lambert(PAL.gold);
  addCylinder(g, gold, 0.06 * scale, 0.09 * scale, 0.18 * scale, 0, 0.09 * scale, 0, 6);
  addSphere(g, gold, 0.12 * scale, 0, 0.26 * scale, 0, 8, 6);
  addCone(g, gold, 0.055 * scale, 0.22 * scale, 0, 0.44 * scale, 0, 6);
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

// ─────────────────────────── 燈籠 ───────────────────────────

export interface LanternOptions {
  /** 吊繩長度 */
  rope?: number;
  scale?: number;
  /** 是否加一盞暖光小燈（僅室內建議使用） */
  glow?: boolean;
}

/** 吊掛紅燈籠（會輕輕搖曳）。原點為吊掛點。 */
export function addHangingLantern(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  opts: LanternOptions = {},
): THREE.Group {
  const s = opts.scale ?? 1;
  const rope = opts.rope ?? 0.3;
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  markAnim(pivot, 'lantern');

  addCylinder(pivot, lib.lambert(PAL.woodBlack), 0.012, 0.012, Math.max(0.04, rope), 0, -Math.max(0.04, rope) / 2, 0, 4);

  const bodyY = -rope - 0.17 * s;
  const profile: [number, number][] = [
    [0.001, -0.17],
    [0.1, -0.155],
    [0.15, -0.08],
    [0.162, 0.0],
    [0.14, 0.08],
    [0.08, 0.14],
    [0.001, 0.17],
  ];
  const body = addLathe(pivot, lib.lantern(), profile, 0, bodyY, 0, 10);
  body.scale.setScalar(s);
  const capMat = lib.lambert(PAL.goldDark);
  const topCap = addCylinder(pivot, capMat, 0.055 * s, 0.07 * s, 0.03 * s, 0, bodyY + 0.17 * s, 0, 8);
  topCap.receiveShadow = false;
  addCylinder(pivot, capMat, 0.07 * s, 0.055 * s, 0.03 * s, 0, bodyY - 0.17 * s, 0, 8);
  addCylinder(pivot, lib.lambert(PAL.lanternDark), 0.018 * s, 0.018 * s, 0.22 * s, 0, bodyY - 0.29 * s, 0, 4);
  addCone(pivot, lib.lambert(PAL.clothRed), 0.05 * s, 0.12 * s, 0, bodyY - 0.24 * s, 0, 6);
  if (opts.glow) {
    const glowMat = lib.basic(PAL.lanternGlow, { transparent: true, opacity: 0.35, depthWrite: false });
    addSphere(pivot, glowMat, 0.3 * s, 0, bodyY, 0, 8, 6);
  }
  parent.add(pivot);
  return pivot;
}

// ─────────────────────────── 旗幡與匾額 ───────────────────────────

export interface BannerOptions {
  height?: number;
  text: string;
  bg?: number;
  /** 面向（繞 y），預設 0 = 面向 +z */
  ry?: number;
  /** 是否加橫桿與銅頂 */
  pole?: boolean;
}

/** 直幡／酒旗：木桿 + 布面大字，布面會微微飄動。原點為桿底。 */
export function addBanner(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  opts: BannerOptions,
): THREE.Group {
  const height = opts.height ?? 3.4;
  const root = new THREE.Group();
  root.position.set(x, y, z);
  root.rotation.y = opts.ry ?? 0;

  addCylinder(root, lib.lambert(PAL.woodDark), 0.035, 0.05, height, 0, height / 2, 0, 6);
  addSphere(root, lib.lambert(PAL.gold), 0.07, 0, height + 0.03, 0, 6, 5);
  addBox(root, lib.lambert(PAL.woodDark), 0.62, 0.05, 0.05, 0.26, height - 0.06, 0);

  const clothH = height * 0.6;
  const clothW = Math.min(0.62, height * 0.18);
  const clothPivot = new THREE.Group();
  clothPivot.position.set(0.24, height - 0.1, 0);
  markAnim(clothPivot, 'banner');
  const geo = new THREE.PlaneGeometry(clothW, clothH, 1, 5);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const py = pos.getY(i);
    const wave = Math.sin((py / clothH + 0.5) * Math.PI * 1.2) * 0.045;
    pos.setZ(i, wave);
  }
  geo.computeVertexNormals();
  const cloth = new THREE.Mesh(geo, lib.banner(opts.text, opts.bg ?? PAL.clothRed));
  cloth.position.y = -clothH / 2;
  cloth.castShadow = true;
  clothPivot.add(cloth);
  root.add(clothPivot);

  parent.add(root);
  return root;
}

export interface PlaqueOptions {
  w?: number;
  h?: number;
  ry?: number;
}

/** 匾額：木框金字，掛在門楣上方。原點為匾額中心。 */
export function addPlaque(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  text: string,
  opts: PlaqueOptions = {},
): THREE.Group {
  const w = opts.w ?? 1.1;
  const h = opts.h ?? 0.38;
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = opts.ry ?? 0;
  addBox(g, lib.lambert(PAL.goldDark), w + 0.08, h + 0.08, 0.06, 0, 0, 0);
  addBox(g, lib.lambert(PAL.woodDark), w, h, 0.05, 0, 0, 0.02);
  const textPlane = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.94, h * 0.78), lib.plaque(text));
  textPlane.position.set(0, 0, 0.055);
  g.add(textPlane);
  parent.add(g);
  return g;
}

// ─────────────────────────── 門窗 ───────────────────────────

export interface LatticeWindowOptions {
  w?: number;
  h?: number;
  cols?: number;
  rows?: number;
  ry?: number;
  /** 亮紙（夜晚透光） */
  paper?: boolean;
}

/** 格子窗：木框 + 窗紙 + 窗櫺。面向 +z（可用 ry 轉向）。 */
export function addLatticeWindow(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  opts: LatticeWindowOptions = {},
): THREE.Group {
  const w = opts.w ?? 0.7;
  const h = opts.h ?? 0.6;
  const cols = opts.cols ?? 3;
  const rows = opts.rows ?? 2;
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = opts.ry ?? 0;
  const frameMat = lib.lambert(PAL.woodDark);
  const latticeMat = lib.lambert(PAL.wood);
  // 窗紙（略帶暖色自發光，像透入屋內的光）
  const paperMat = lib.lambert(opts.paper === false ? PAL.wallGrey : PAL.paper, {
    emissive: opts.paper === false ? 0x000000 : 0x5a4322,
    emissiveIntensity: 0.3,
  });
  addBox(g, paperMat, w - 0.08, h - 0.08, 0.03, 0, 0, 0);
  addBox(g, frameMat, w, 0.07, 0.07, 0, h / 2, 0.02);
  addBox(g, frameMat, w, 0.07, 0.07, 0, -h / 2, 0.02);
  addBox(g, frameMat, 0.07, h, 0.07, -w / 2, 0, 0.02);
  addBox(g, frameMat, 0.07, h, 0.07, w / 2, 0, 0.02);
  for (let i = 1; i < cols; i++) {
    addBox(g, latticeMat, 0.028, h - 0.06, 0.05, -w / 2 + (w / cols) * i, 0, 0.04);
  }
  for (let j = 1; j < rows; j++) {
    addBox(g, latticeMat, w - 0.06, 0.028, 0.05, 0, -h / 2 + (h / rows) * j, 0.04);
  }
  addBox(g, frameMat, w + 0.14, 0.06, 0.14, 0, -h / 2 - 0.04, 0.03);
  parent.add(g);
  return g;
}

export interface DoorOptions {
  w?: number;
  h?: number;
  /** 1 或 2 扇 */
  panels?: 1 | 2;
  color?: number;
  /** 銅釘門（官府） */
  studs?: boolean;
  ry?: number;
}

/** 中式門：門框 + 門板 + 門釘 + 門檻。面向 +z。 */
export function addDoor(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  opts: DoorOptions = {},
): THREE.Group {
  const w = opts.w ?? 0.66;
  const h = opts.h ?? 1.05;
  const panels = opts.panels ?? 2;
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = opts.ry ?? 0;
  const frameMat = lib.lambert(PAL.woodDark);
  const doorMat = lib.lambert(opts.color ?? PAL.pillarRedDark);
  addBox(g, frameMat, w + 0.16, h + 0.12, 0.08, 0, 0, 0);
  addBox(g, doorMat, w, h, 0.09, 0, 0, 0.04);
  addBox(g, frameMat, 0.05, h, 0.12, 0, 0, 0.06);
  if (panels === 2) {
    addBox(g, frameMat, 0.04, h, 0.12, 0, 0, 0.07);
  }
  if (opts.studs) {
    const gold = lib.lambert(PAL.gold, { emissive: 0x3a2a0c, emissiveIntensity: 0.3 });
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const px = panels === 2 ? (c < 2 ? -w * 0.29 + c * w * 0.16 : w * 0.29) : -w * 0.3 + c * w * 0.3;
        addSphere(g, gold, 0.035, px + (panels === 2 && c === 2 ? 0 : 0), h * 0.22 - r * h * 0.22, 0.1, 5, 4);
      }
    }
  }
  // 門檻
  addBox(g, lib.lambert(PAL.stoneDark), w + 0.28, 0.1, 0.2, 0, -h / 2 - 0.05, 0.06);
  parent.add(g);
  return g;
}

/** 石階（往 +z 方向逐級下降）。 */
export function addSteps(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  w: number,
  steps = 3,
  rise = 0.1,
  depth = 0.22,
): void {
  const mat = lib.lambert(PAL.stone);
  for (let i = 0; i < steps; i++) {
    addBox(parent, mat, w, rise, depth, x, y - rise / 2 - i * rise, z + i * depth);
  }
}

// ─────────────────────────── 庭院景物 ───────────────────────────

export type TreeKind = 'pine' | 'cypress' | 'willow';

/** 低多邊形庭院樹。 */
export function addTree(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  scale = 1,
  kind: TreeKind = 'pine',
  seed = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = seed * 1.3;
  g.scale.setScalar(scale);
  const trunkMat = lib.lambert(PAL.wood);
  const leafMat = lib.lambert(kind === 'cypress' ? PAL.leafDark : PAL.leaf);
  const leaf2Mat = lib.lambert(kind === 'cypress' ? PAL.leaf : PAL.leafDark);
  addCylinder(g, trunkMat, 0.07, 0.11, 0.9, 0, 0.45, 0, 6);
  if (kind === 'pine') {
    for (let i = 0; i < 3; i++) {
      addCone(g, i % 2 ? leaf2Mat : leafMat, 0.62 - i * 0.15, 0.75, 0, 0.95 + i * 0.42, 0, 7, i * 0.5);
    }
  } else if (kind === 'cypress') {
    const body = addSphere(g, leafMat, 0.5, 0, 1.35, 0, 7, 6);
    body.scale.set(0.75, 1.7, 0.75);
    const top = addSphere(g, leaf2Mat, 0.26, 0.08, 2.25, 0.04, 6, 5);
    top.scale.set(0.8, 1.3, 0.8);
  } else {
    const canopy = addSphere(g, leafMat, 0.6, 0, 1.55, 0, 7, 5);
    canopy.scale.set(1.15, 0.75, 1.15);
    addCylinder(g, trunkMat, 0.05, 0.08, 1.2, 0.1, 0.75, 0, 5);
  }
  parent.add(g);
  return g;
}

/** 石獅（一對擺在門口）。 */
export function addStoneLion(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  scale = 1,
  yaw = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  g.scale.setScalar(scale);
  const mat = lib.lambert(PAL.stoneLight);
  const dark = lib.lambert(PAL.stone);
  addBox(g, dark, 0.5, 0.16, 0.42, 0, 0.08, 0);
  addBox(g, mat, 0.4, 0.12, 0.32, 0, 0.21, 0);
  // 身體
  addBox(g, mat, 0.3, 0.34, 0.24, 0, 0.44, -0.02);
  // 前腿
  addBox(g, mat, 0.09, 0.26, 0.1, -0.1, 0.4, 0.11);
  addBox(g, mat, 0.09, 0.26, 0.1, 0.1, 0.4, 0.11);
  // 頭
  addSphere(g, mat, 0.16, 0, 0.7, 0.05, 7, 6);
  // 鬃毛
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    addSphere(g, dark, 0.055, Math.cos(a) * 0.13, 0.72 + Math.sin(a) * 0.11, 0.0, 5, 4);
  }
  addSphere(g, mat, 0.025, -0.06, 0.71, 0.19, 4, 3);
  addSphere(g, mat, 0.025, 0.06, 0.71, 0.19, 4, 3);
  parent.add(g);
  return g;
}

/** 木柵欄（兩點之間，含立柱與雙橫桿）。 */
export function addFence(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  height = 0.9,
  y = 0,
): void {
  const mat = lib.lambert(PAL.wood);
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  if (len < 0.05) return;
  const yaw = Math.atan2(dx, dz);
  const cx = (x1 + x2) / 2;
  const cz = (z1 + z2) / 2;
  const posts = Math.max(2, Math.round(len / 0.55) + 1);
  for (let i = 0; i < posts; i++) {
    const t = i / (posts - 1);
    addBox(parent, mat, 0.07, height, 0.07, x1 + dx * t, y + height / 2, z1 + dz * t, yaw);
  }
  addBox(parent, mat, 0.05, 0.07, len, cx, y + height * 0.62, cz, yaw + Math.PI / 2);
  addBox(parent, mat, 0.05, 0.07, len, cx, y + height * 0.3, cz, yaw + Math.PI / 2);
}

/** 鋪地：石板＋格線（庭院、碼頭、市集）。 */
export function addPavedGround(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  w: number,
  d: number,
  x = 0,
  z = 0,
  opts: { y?: number; color?: number; tile?: number; thickness?: number } = {},
): void {
  const tile = opts.tile ?? 0.9;
  const baseMat = lib.lambert(opts.color ?? PAL.stone);
  const lineMat = lib.lambert(PAL.stoneDark);
  addBox(parent, baseMat, w, opts.thickness ?? 0.08, d, x, (opts.y ?? 0.04) - (opts.thickness ?? 0.08) / 2, z);
  const cols = Math.floor(w / tile);
  const rows = Math.floor(d / tile);
  for (let i = 1; i < cols; i++) {
    addBox(parent, lineMat, 0.035, 0.012, d, x - w / 2 + i * (w / cols), opts.y ?? 0.04, z);
  }
  for (let j = 1; j < rows; j++) {
    addBox(parent, lineMat, w, 0.012, 0.035, x, opts.y ?? 0.04, z - d / 2 + j * (d / rows));
  }
}

// ─────────────────────────── 雜項道具 ───────────────────────────

/** 陶水缸。 */
export function addWaterJar(parent: THREE.Object3D, lib: MaterialLibrary, x: number, y: number, z: number, scale = 1): THREE.Mesh {
  const profile: [number, number][] = [
    [0.001, 0],
    [0.16, 0.02],
    [0.22, 0.14],
    [0.2, 0.3],
    [0.13, 0.38],
    [0.14, 0.42],
    [0.12, 0.44],
  ];
  const jar = addLathe(parent, lib.lambert(PAL.stoneDark), profile, x, y, z, 10);
  jar.scale.setScalar(scale);
  addCylinder(parent, lib.basic(PAL.water), 0.115, 0.115, 0.015, x, y + 0.36 * scale, z, 10);
  return jar;
}

/** 木貨箱。 */
export function addCrate(parent: THREE.Object3D, lib: MaterialLibrary, x: number, y: number, z: number, s = 0.5, ry = 0): void {
  const wood = lib.lambert(PAL.woodLight);
  const dark = lib.lambert(PAL.wood);
  addBox(parent, wood, s, s * 0.86, s, x, y + s * 0.43, z, ry);
  addBox(parent, dark, s * 1.02, 0.045, s * 1.02, x, y + s * 0.14, z, ry);
  addBox(parent, dark, s * 1.02, 0.045, s * 1.02, x, y + s * 0.7, z, ry);
}

/** 麻布袋（糧食）。 */
export function addSack(parent: THREE.Object3D, lib: MaterialLibrary, x: number, y: number, z: number, s = 1, ry = 0): void {
  const mat = lib.lambert(PAL.clothWhite);
  const sack = addSphere(parent, mat, 0.22 * s, x, y + 0.2 * s, z, 7, 5);
  sack.scale.set(1, 1.25, 0.9);
  sack.rotation.y = ry;
  addCylinder(parent, lib.lambert(PAL.woodDark), 0.06 * s, 0.08 * s, 0.08 * s, x, y + 0.47 * s, z, 6);
}

/** 木桶。 */
export function addBarrel(parent: THREE.Object3D, lib: MaterialLibrary, x: number, y: number, z: number, s = 0.5, ry = 0): void {
  const wood = lib.lambert(PAL.wood);
  const hoop = lib.lambert(PAL.ironDark);
  const body = addCylinder(parent, wood, s * 0.5, s * 0.55, s * 1.2, x, y + s * 0.6, z, 10, ry);
  body.castShadow = true;
  addCylinder(parent, hoop, s * 0.51, s * 0.56, s * 0.09, x, y + s * 0.2, z, 10, ry);
  addCylinder(parent, hoop, s * 0.5, s * 0.54, s * 0.09, x, y + s * 1.0, z, 10, ry);
}

/** 竹籃／貨籃（可放圓形貨物）。 */
export function addBasket(parent: THREE.Object3D, lib: MaterialLibrary, x: number, y: number, z: number, s = 0.3, goodsColor?: number): void {
  const mat = lib.lambert(PAL.woodLight);
  addCylinder(parent, mat, s, s * 0.7, s * 0.75, x, y + s * 0.38, z, 8);
  if (goodsColor !== undefined) {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      addSphere(parent, lib.lambert(goodsColor), s * 0.42, x + Math.cos(a) * s * 0.28, y + s * 0.78, z + Math.sin(a) * s * 0.28, 6, 4);
    }
  }
}

export interface WineJarOptions {
  scale?: number;
  cloth?: number;
}

/** 酒罈（大陶罈＋紅布封口）。 */
export function addWineJar(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  opts: WineJarOptions = {},
): THREE.Group {
  const s = opts.scale ?? 1;
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const profile: [number, number][] = [
    [0.001, 0],
    [0.24, 0.02],
    [0.36, 0.24],
    [0.38, 0.46],
    [0.3, 0.7],
    [0.16, 0.8],
    [0.17, 0.86],
    [0.15, 0.9],
  ];
  const body = addLathe(g, lib.lambert(PAL.bronze), profile, 0, 0, 0, 12);
  body.scale.setScalar(s);
  // 紅布封口
  addCylinder(g, lib.lambert(opts.cloth ?? PAL.clothRed), 0.32 * s, 0.18 * s, 0.12 * s, 0, 0.95 * s, 0, 10);
  addCylinder(g, lib.lambert(PAL.clothRed), 0.16 * s, 0.2 * s, 0.08 * s, 0, 0.88 * s, 0, 10);
  // 繩
  addCylinder(g, lib.lambert(PAL.woodDark), 0.19 * s, 0.19 * s, 0.03 * s, 0, 0.86 * s, 0, 10);
  parent.add(g);
  return g;
}

/** 方桌。 */
export function addTable(parent: THREE.Object3D, lib: MaterialLibrary, x: number, y: number, z: number, w = 0.9, d = 0.6, h = 0.62, ry = 0): void {
  const top = lib.lambert(PAL.wood);
  const leg = lib.lambert(PAL.woodDark);
  addBox(parent, top, w, 0.07, d, x, y + h - 0.035, z, ry);
  const cos = Math.cos(ry);
  const sin = Math.sin(ry);
  for (const [lx, lz] of [
    [-w / 2 + 0.07, -d / 2 + 0.07],
    [w / 2 - 0.07, -d / 2 + 0.07],
    [-w / 2 + 0.07, d / 2 - 0.07],
    [w / 2 - 0.07, d / 2 - 0.07],
  ]) {
    addBox(parent, leg, 0.07, h, 0.07, x + lx * cos + lz * sin, y + h / 2, z - lx * sin + lz * cos, ry);
  }
}

/** 鼓凳／圓凳。 */
export function addStool(parent: THREE.Object3D, lib: MaterialLibrary, x: number, y: number, z: number, r = 0.18, h = 0.42): void {
  const mat = lib.lambert(PAL.woodLight);
  addCylinder(parent, mat, r, r * 0.82, h, x, y + h / 2, z, 8);
  addCylinder(parent, lib.lambert(PAL.woodDark), r * 1.05, r * 1.05, 0.04, x, y + h, z, 8);
}

/** 冒煙的煙囪／爐口（會上升淡出）。原點為出煙口。 */
export function addSmoke(parent: THREE.Object3D, lib: MaterialLibrary, x: number, y: number, z: number, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  markAnim(g, 'smoke');
  const mat = lib.lambert(PAL.smoke, { transparent: true, opacity: 0.5, depthWrite: false });
  for (let i = 0; i < 3; i++) {
    const puff = addSphere(g, mat, 0.16 * scale * (1 - i * 0.16), i * 0.06, i * 0.3, i * 0.03, 6, 4);
    puff.castShadow = false;
    puff.receiveShadow = false;
  }
  parent.add(g);
  return g;
}

/** 市集攤位：四柱布棚＋攤桌＋貨物。 */
export function addMarketStall(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  w: number,
  d: number,
  clothColor: number,
  goodsColor: number,
  ry = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const pole = lib.lambert(PAL.woodDark);
  const h = 1.5;
  for (const [px, pz] of [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [-w / 2, d / 2],
    [w / 2, d / 2],
  ]) {
    addCylinder(g, pole, 0.035, 0.045, h, px, h / 2, pz, 5);
  }
  // 微斜布棚（前低後高）
  const canopy = addBox(g, lib.lambert(clothColor, { side: THREE.DoubleSide }), w + 0.3, 0.05, d + 0.36, 0, h, 0);
  canopy.rotation.x = -0.12;
  // 棚緣波浪
  const trim = lib.lambert(darken(clothColor, 0.82), { side: THREE.DoubleSide });
  addBox(g, trim, w + 0.3, 0.16, 0.04, 0, h - 0.16, (d + 0.36) / 2);
  // 攤桌
  addTable(g, lib, 0, 0, 0.06, w * 0.82, d * 0.55, 0.68);
  addBasket(g, lib, -w * 0.24, 0.7, 0.04, 0.2, goodsColor);
  addBasket(g, lib, w * 0.2, 0.7, 0.08, 0.17, goodsColor);
  addBasket(g, lib, 0, 0.7, -0.06, 0.15, darken(goodsColor, 0.9));
  parent.add(g);
  return g;
}

/** 簡易的顏色加深／變亮。 */
export function darken(color: number, factor: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((color >> 16) & 255) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((color >> 8) & 255) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((color & 255) * factor)));
  return (r << 16) | (g << 8) | b;
}

/** 斜撐木架（例如井架、吊臂）。 */
export function addFramePost(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  height: number,
  y = 0,
  ry = 0,
): THREE.Mesh {
  return addCylinder(parent, lib.lambert(PAL.wood), 0.05, 0.06, height, x, y + height / 2, z, 6, ry);
}

/** 小歇山／兩坡瓦頂（給棚子、門樓、井亭）。 */
export function addSmallGableRoof(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  w: number,
  d: number,
  h = 0.32,
  ry = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  const mat = lib.lambert(PAL.tile, { side: THREE.DoubleSide });
  const dark = lib.lambert(PAL.tileDark);
  const angle = Math.atan2(h, d / 2);
  const slabLen = Math.hypot(h, d / 2) + 0.1;
  for (const side of [-1, 1]) {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, 0.07, slabLen), mat);
    slab.position.set(0, h / 2, side * d / 4);
    slab.rotation.x = side * angle;
    slab.castShadow = true;
    slab.receiveShadow = true;
    g.add(slab);
  }
  // 正脊與兩端
  addBox(g, dark, w + 0.16, 0.09, 0.12, 0, h + 0.02, 0);
  for (const side of [-1, 1]) {
    const tip = addBox(g, dark, 0.16, 0.14, 0.1, side * (w / 2 + 0.03), h + 0.06, 0);
    tip.rotation.z = side * 0.3;
  }
  // 簷口
  for (const side of [-1, 1]) {
    addBox(g, lib.lambert(PAL.woodDark), w + 0.16, 0.07, 0.06, 0, 0.02, side * (d / 2 + 0.02));
  }
  parent.add(g);
  return g;
}

/** 市集／茶館的布篷（單片斜布）。 */
export function addAwning(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  w: number,
  d: number,
  color: number,
  ry = 0,
): THREE.Mesh {
  const mat = lib.lambert(color, { side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d, 4, 1), mat);
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setZ(i, Math.sin((pos.getX(i) / w + 0.5) * Math.PI) * 0.06);
  }
  mesh.geometry.computeVertexNormals();
  mesh.position.set(x, y, z);
  mesh.rotation.set(-Math.PI / 2 + 0.16, 0, 0);
  mesh.rotateY(ry);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

/** 旗杆＋三角小旗。 */
export function addPennant(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  h: number,
  color: number,
  ry = 0,
): void {
  addCylinder(parent, lib.lambert(PAL.woodDark), 0.025, 0.03, h, x, h / 2, z, 5);
  const cloth = addBox(parent, lib.lambert(color, { side: THREE.DoubleSide }), 0.46, 0.22, 0.02, x + 0.24, h - 0.18, z, ry);
  cloth.castShadow = false;
}

/** 銅香爐（寺廟）：三足鼎＋香煙。 */
export function addIncenseBurner(parent: THREE.Object3D, lib: MaterialLibrary, x: number, y: number, z: number, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.scale.setScalar(scale);
  const bronze = lib.lambert(PAL.bronze);
  const dark = lib.lambert(PAL.ironDark);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    addCylinder(g, dark, 0.035, 0.05, 0.22, Math.cos(a) * 0.17, 0.11, Math.sin(a) * 0.17, 5);
  }
  addCylinder(g, bronze, 0.3, 0.24, 0.28, 0, 0.34, 0, 10);
  addCylinder(g, bronze, 0.32, 0.32, 0.05, 0, 0.5, 0, 10);
  for (const [sx, sz] of [
    [-0.2, 0.12],
    [0.2, 0.12],
  ]) {
    addCylinder(g, lib.lambert(PAL.gold), 0.02, 0.02, 0.16, sx, 0.38, sz, 5);
  }
  addSmoke(g, lib, 0, 0.55, 0, 0.7);
  parent.add(g);
  return g;
}

/** 大鼓（衙門鳴冤鼓）。 */
export function addDrum(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, scale = 1, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  g.scale.setScalar(scale);
  const wood = lib.lambert(PAL.wood);
  const skin = lib.lambert(PAL.clothWhite);
  const drum = addCylinder(g, wood, 0.42, 0.42, 0.5, 0, 0.85, 0, 12);
  drum.rotation.z = Math.PI / 2;
  const face1 = addCylinder(g, skin, 0.38, 0.38, 0.04, -0.27, 0.85, 0, 12);
  face1.rotation.z = Math.PI / 2;
  const face2 = addCylinder(g, skin, 0.38, 0.38, 0.04, 0.27, 0.85, 0, 12);
  face2.rotation.z = Math.PI / 2;
  for (const px of [-0.34, 0.34]) {
    addCylinder(g, lib.lambert(PAL.woodDark), 0.05, 0.06, 0.7, px, 0.35, 0, 5);
  }
  parent.add(g);
  return g;
}
