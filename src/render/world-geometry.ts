/**
 * 低多邊形世界道具幾何與程序化貼圖（world-renderer 私有模組）。
 *
 * 所有幾何皆為共用（每種道具僅建立一次，交給 InstancedMesh 重複使用），
 * 貼圖以 canvas 程序化生成（不依賴外部資源、離線可用）。
 * 幾何使用頂點色 + instanceColor 相乘，可在 InstancedMesh 中做出色彩變化。
 */

import * as THREE from 'three';
import { mulberry32 } from '../core/rng';

// ─────────────────────────── 幾何工具 ───────────────────────────

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

function trs(
  px: number,
  py: number,
  pz: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): THREE.Matrix4 {
  _v.set(px, py, pz);
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_v, _q, _s);
}

/** 把幾何轉為非索引、寫入頂點色，並套用變換 */
function paint(
  geo: THREE.BufferGeometry,
  color: number,
  matrix?: THREE.Matrix4,
  jitter = 0.07,
): THREE.BufferGeometry {
  if (matrix) geo.applyMatrix4(matrix);
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const pos = g.getAttribute('position');
  const count = pos.count;
  const base = new THREE.Color(color);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // 以頂點序號做穩定的細微明暗抖動，避免死板色塊
    const n = Math.sin((i + 1) * 12.9898 + color * 0.000013) * 43758.5453;
    const f = 1 + ((n - Math.floor(n)) * 2 - 1) * jitter;
    colors[i * 3] = base.r * f;
    colors[i * 3 + 1] = base.g * f;
    colors[i * 3 + 2] = base.b * f;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** 合併多個（已含 position/normal/color 的）幾何 */
export function mergeColoredGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0;
  for (const p of parts) total += p.getAttribute('position').count;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  let offset = 0;
  for (const p of parts) {
    const pPos = p.getAttribute('position') as THREE.BufferAttribute;
    const pNor = p.getAttribute('normal') as THREE.BufferAttribute;
    const pCol = p.getAttribute('color') as THREE.BufferAttribute;
    position.set(pPos.array as Float32Array, offset * 3);
    normal.set(pNor.array as Float32Array, offset * 3);
    color.set(pCol.array as Float32Array, offset * 3);
    offset += pPos.count;
    p.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/** 依幾何高度寫入 aSway（0=根部不動、1=頂端最大），供風吹頂點動畫 */
export function addSwayAttribute(geo: THREE.BufferGeometry, power = 1.6): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  let maxY = 0.0001;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) > maxY) maxY = pos.getY(i);
  const sway = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const v = Math.min(1, Math.max(0, pos.getY(i) / maxY));
    sway[i] = Math.pow(v, power);
  }
  geo.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));
  return geo;
}

// ─────────────────────────── 風吹葉動材質 ───────────────────────────

export interface WindMaterial {
  material: THREE.MeshLambertMaterial;
  time: { value: number };
  wind: { value: number };
}

/** 樹木花草共用材質：頂點色 + 逐實例色 + 風吹擺動（頂點 shader 注入）。 */
export function createWindMaterial(flatShading = true): WindMaterial {
  const time = { value: 0 };
  const wind = { value: 0.5 };
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.uniforms.uWind = wind;
    shader.vertexShader =
      'attribute float aSway;\nattribute float aPhase;\nuniform float uTime;\nuniform float uWind;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float swayK = aSway * aSway;
        float ph = aPhase * 6.2831853;
        transformed.x += sin(uTime * 1.6 + ph) * swayK * uWind * 0.13;
        transformed.z += cos(uTime * 1.25 + ph * 1.37) * swayK * uWind * 0.1;`,
      );
  };
  material.customProgramCacheKey = () => 'huaxia-wind-v1';
  return { material, time, wind };
}

/** 給 InstancedMesh 幾何加上逐實例的相位屬性（配合風吹材質） */
export function addInstancePhase(geo: THREE.BufferGeometry, count: number, seed = 1): void {
  const rng = mulberry32(seed);
  const phases = new Float32Array(count);
  for (let i = 0; i < count; i++) phases[i] = rng() * 6.283;
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
}

// ─────────────────────────── 樹木幾何 ───────────────────────────

const TRUNK_DARK = 0x5a452f;
const TRUNK_LIGHT = 0x6d5538;

/** 松樹：圓錐塔狀，適合丘陵與山地 */
export function createPineGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.07, 0.13, 1.1, 5), TRUNK_DARK, trs(0, 0.55, 0)));
  const cones: [number, number, number, number][] = [
    [0.98, 1.2, 0.95, 0x37603c],
    [0.68, 0.95, 1.7, 0x3f6b42],
    [0.38, 0.7, 2.3, 0x4a7a49],
  ];
  for (const [r, h, y, c] of cones) {
    parts.push(paint(new THREE.ConeGeometry(r, h, 7), c, trs(0, y, 0, 0, 0.4, 0), 0.09));
  }
  return mergeColoredGeometries(parts);
}

/** 闊葉樹：樹冠由數個低多邊形球體組成 */
export function createBroadleafGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.09, 0.17, 1.2, 5), TRUNK_LIGHT, trs(0, 0.6, 0, 0, 0.3, 0.04)));
  const blobs: [number, number, number, number, number][] = [
    [0, 1.65, 0, 0.72, 0x4d7a42],
    [0.42, 1.42, 0.12, 0.52, 0x5d8a4a],
    [-0.38, 1.5, -0.18, 0.5, 0x3f6b3c],
  ];
  for (const [x, y, z, r, c] of blobs) {
    const g = new THREE.IcosahedronGeometry(r, 0);
    parts.push(paint(g, c, trs(x, y, z, x, y * 3, z, 1, 0.86, 1), 0.1));
  }
  return mergeColoredGeometries(parts);
}

/** 花樹（春櫻／桃李）：樹冠偏粉白，春天最醒目 */
export function createBlossomGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.08, 0.15, 1.15, 5), 0x6a5140, trs(0, 0.58, 0, 0, 0.5, 0.05)));
  const blobs: [number, number, number, number, number][] = [
    [0, 1.55, 0, 0.66, 0xf2d8dc],
    [0.4, 1.34, 0.1, 0.46, 0xe8c2cc],
    [-0.34, 1.42, -0.14, 0.44, 0xf6e2e2],
    [0.04, 1.82, -0.04, 0.4, 0xfaeaea],
  ];
  for (const [x, y, z, r, c] of blobs) {
    const g = new THREE.IcosahedronGeometry(r, 0);
    parts.push(paint(g, c, trs(x, y, z, x, y * 3, z, 1, 0.8, 1), 0.08));
  }
  return mergeColoredGeometries(parts);
}

/** 柳樹：垂枝，適合水岸 */
export function createWillowGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.085, 0.15, 1.0, 5), 0x6a563c, trs(0, 0.5, 0, 0, 0.2, 0.06)));
  parts.push(paint(new THREE.IcosahedronGeometry(0.55, 0), 0x7fa653, trs(0, 1.35, 0, 0.1, 0.4, 0), 0.09));
  parts.push(paint(new THREE.IcosahedronGeometry(0.36, 0), 0x8fb45c, trs(0.3, 1.6, 0.08, 0.2, 1.1, 0), 0.09));
  parts.push(paint(new THREE.IcosahedronGeometry(0.32, 0), 0x76a04c, trs(-0.28, 1.55, -0.1, 0, 2.3, 0.1), 0.09));
  const fronds = 9;
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2;
    const r = 0.42 + (i % 3) * 0.1;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const len = 0.6 + (i % 4) * 0.12;
    // 細而下垂的枝條
    parts.push(
      paint(
        new THREE.ConeGeometry(0.075, len, 4),
        i % 2 === 0 ? 0x94b45a : 0x86a64e,
        trs(x, 1.42 - len * 0.42, z, Math.PI, a, 0),
        0.1,
      ),
    );
  }
  return mergeColoredGeometries(parts);
}

/** 竹叢 */
export function createBambooGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const stalks = 5;
  for (let i = 0; i < stalks; i++) {
    const a = (i / stalks) * Math.PI * 2 + 0.4;
    const r = 0.16 + (i % 2) * 0.14;
    const h = 2.1 + (i % 3) * 0.42;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    parts.push(
      paint(
        new THREE.CylinderGeometry(0.035, 0.05, h, 4),
        i % 2 === 0 ? 0x7d9848 : 0x8fa458,
        trs(x, h / 2, z, Math.sin(a) * 0.06, a, Math.cos(a) * 0.05),
        0.08,
      ),
    );
    // 竹葉：頂端小錐體
    parts.push(paint(new THREE.ConeGeometry(0.3, 0.5, 4), 0x6f8f3f, trs(x * 1.1, h - 0.1, z * 1.1, 0.2, a, 0)));
  }
  return mergeColoredGeometries(parts);
}

/** 低矮灌木 */
export function createShrubGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const blobs: [number, number, number, number, number][] = [
    [0, 0.22, 0, 0.3, 0x547a42],
    [0.2, 0.17, 0.1, 0.22, 0x628a4a],
  ];
  for (const [x, y, z, r, c] of blobs) {
    parts.push(paint(new THREE.IcosahedronGeometry(r, 0), c, trs(x, y, z, x * 3, y * 5, z * 3, 1, 0.72, 1), 0.1));
  }
  return mergeColoredGeometries(parts);
}

// ─────────────────────────── 岩石／花草 ───────────────────────────

/** 山石：不規則多面體 */
export function createRockGeometry(seed = 7): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const geo = new THREE.IcosahedronGeometry(0.6, 0);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const f = 0.72 + rng() * 0.5;
    pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f * 0.72, pos.getZ(i) * f);
  }
  geo.computeVertexNormals();
  const g = paint(geo, 0x7d7d74, trs(0, 0.22, 0, 0, 0.6, 0), 0.12);
  return g;
}

/** 小石堆 */
export function createPebblesGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.IcosahedronGeometry(0.2, 0), 0x8a8a80, trs(0, 0.08, 0, 0, 0.3, 0), 0.1));
  parts.push(paint(new THREE.IcosahedronGeometry(0.14, 0), 0x77776e, trs(0.26, 0.06, 0.1, 0, 1.3, 0), 0.1));
  parts.push(paint(new THREE.IcosahedronGeometry(0.11, 0), 0x9a988c, trs(-0.2, 0.05, 0.16, 0, 2.1, 0), 0.1));
  return mergeColoredGeometries(parts);
}

/** 草叢 */
export function createGrassTuftGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const blades = 4;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + 0.7;
    const tilt = 0.22 + (i % 2) * 0.14;
    parts.push(
      paint(
        new THREE.ConeGeometry(0.05, 0.42 + (i % 3) * 0.1, 3),
        i % 2 === 0 ? 0x6f9548 : 0x7fa452,
        trs(Math.cos(a) * 0.09, 0.2, Math.sin(a) * 0.09, Math.cos(a) * tilt, a, Math.sin(a) * tilt),
        0.1,
      ),
    );
  }
  return mergeColoredGeometries(parts);
}

/** 野花（花頭接近白色，交給 instanceColor 上色） */
export function createFlowerGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.014, 0.02, 0.28, 3), 0x5f8640, trs(0, 0.14, 0), 0.06));
  parts.push(paint(new THREE.IcosahedronGeometry(0.07, 0), 0xf0e6d0, trs(0, 0.31, 0), 0.12));
  parts.push(paint(new THREE.ConeGeometry(0.045, 0.09, 4), 0xd8c8a0, trs(0, 0.24, 0, 0.3, 0.6, 0), 0.1));
  return mergeColoredGeometries(parts);
}

/** 水邊蘆葦 */
export function createReedGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const h = 0.85 + (i % 3) * 0.22;
    parts.push(
      paint(
        new THREE.ConeGeometry(0.028, h, 3),
        i % 2 === 0 ? 0x9aa05a : 0x868f4a,
        trs(Math.cos(a) * 0.1, h / 2, Math.sin(a) * 0.1, Math.cos(a) * 0.16, a, Math.sin(a) * 0.16),
        0.08,
      ),
    );
  }
  return mergeColoredGeometries(parts);
}

/** 荷葉（水面裝飾） */
export function createLotusPadGeometry(): THREE.BufferGeometry {
  const geo = new THREE.CircleGeometry(0.3, 6);
  const g = paint(geo, 0x5f8a4a, trs(0, 0.02, 0, -Math.PI / 2, 0.3, 0), 0.12);
  return g;
}

/** 田埂（梯田／水田邊界） */
export function createPaddyRidgeGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.BoxGeometry(1, 0.06, 0.1), 0xa08c62, trs(0, 0.03, 0), 0.08));
  parts.push(paint(new THREE.BoxGeometry(1, 0.022, 0.14), 0x8a9a58, trs(0, 0.066, 0), 0.1));
  return mergeColoredGeometries(parts);
}

/** 稻草堆 */
export function createHaystackGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.34, 0.42, 0.3, 6), 0x9c8044, trs(0, 0.15, 0), 0.08));
  parts.push(paint(new THREE.ConeGeometry(0.42, 0.55, 6), 0xb5924e, trs(0, 0.55, 0, 0, 0.3, 0), 0.1));
  return mergeColoredGeometries(parts);
}

/** 烏篷船 */
export function createBoatGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // 船身
  parts.push(paint(new THREE.CylinderGeometry(0.16, 0.22, 1.9, 4), 0x5f4a33, trs(0, 0.1, 0, 0, Math.PI / 4, Math.PI / 2), 0.08));
  // 船篷
  parts.push(paint(new THREE.CylinderGeometry(0.24, 0.24, 0.8, 6, 1, false, 0, Math.PI), 0x2e2e2c, trs(0, 0.24, 0, 0, 0, Math.PI / 2), 0.06));
  // 艙板
  parts.push(paint(new THREE.BoxGeometry(1.5, 0.05, 0.3), 0x7a6244, trs(0, 0.16, 0), 0.05));
  return mergeColoredGeometries(parts);
}

// ─────────────────────────── 道路配件 ───────────────────────────

/** 河岸／橋樑欄杆（沿格邊的整段欄杆，木質） */
export function createRailingGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const wood = 0x5c4530;
  const woodLight = 0x74583c;
  // 立柱
  parts.push(paint(new THREE.BoxGeometry(0.1, 0.42, 0.1), wood, trs(-0.88, 0.21, 0), 0.06));
  parts.push(paint(new THREE.BoxGeometry(0.1, 0.42, 0.1), wood, trs(0.88, 0.21, 0), 0.06));
  parts.push(paint(new THREE.BoxGeometry(0.08, 0.3, 0.08), woodLight, trs(0, 0.15, 0), 0.06));
  // 橫杆
  parts.push(paint(new THREE.BoxGeometry(1.9, 0.07, 0.09), woodLight, trs(0, 0.4, 0), 0.05));
  parts.push(paint(new THREE.BoxGeometry(1.86, 0.05, 0.06), wood, trs(0, 0.24, 0), 0.05));
  return mergeColoredGeometries(parts);
}

/** 交叉口中央的鋪石（八角石板） */
export function createIntersectionStoneGeometry(): THREE.BufferGeometry {
  return paint(new THREE.CylinderGeometry(0.36, 0.4, 0.03, 8), 0x767e84, trs(0, 0.016, 0, 0, Math.PI / 8, 0), 0.1);
}

/** 路緣石（一小段，由 InstancedMesh 沿邊排） */
export function createCurbGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.BoxGeometry(2.02, 0.07, 0.15), 0x8f948f, trs(0, 0.035, 0), 0.07));
  parts.push(paint(new THREE.BoxGeometry(2.02, 0.02, 0.17), 0xa4a8a2, trs(0, 0.075, 0), 0.05));
  return mergeColoredGeometries(parts);
}

/** 橋頭石墩 */
export function createBridgePostGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.BoxGeometry(0.22, 0.34, 0.22), 0x8a8f92, trs(0, 0.17, 0), 0.08));
  parts.push(paint(new THREE.BoxGeometry(0.3, 0.07, 0.3), 0x9aa0a2, trs(0, 0.36, 0), 0.06));
  return mergeColoredGeometries(parts);
}

// ─────────────────────────── 遠山剪影 ───────────────────────────

/** 近景岩峰：低矮不規則岩塊群（山地用，無雪冠；冬季由 instanceColor 提亮） */
export function createCragGeometry(seed = 21): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const rocks = 3;
  const colors = [0x8b887c, 0x817e72, 0x959287, 0x7d8169];
  for (let p = 0; p < rocks; p++) {
    const h = 0.75 + rng() * 0.55;
    const r = 0.85 + rng() * 0.45;
    const cone = new THREE.ConeGeometry(r, h, 6);
    const pos = cone.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const f = 0.72 + rng() * 0.52;
      pos.setXYZ(i, pos.getX(i) * f, pos.getY(i), pos.getZ(i) * f);
    }
    cone.computeVertexNormals();
    const ang = (p / rocks) * Math.PI * 2 + rng() * 0.8;
    const off = p === 0 ? 0 : 0.55 + rng() * 0.5;
    parts.push(
      paint(
        cone,
        colors[p % colors.length],
        trs(Math.cos(ang) * off, h * 0.5 - 0.05, Math.sin(ang) * off * 0.7, 0, rng() * Math.PI, 0, 1, 0.85 + rng() * 0.35, 1),
        0.1,
      ),
    );
  }
  return mergeColoredGeometries(parts);
}

/** 遠山／岩峰剪影：多個不規則錐體，山頂帶淡色雪冠 */
export function createMountainSilhouetteGeometry(seed = 3): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const peaks = 3;
  for (let p = 0; p < peaks; p++) {
    const h = 0.8 + rng() * 0.5;
    const cone = new THREE.ConeGeometry(1, h, 7);
    const pos = cone.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const f = 0.76 + rng() * 0.46;
      pos.setXYZ(i, pos.getX(i) * f, pos.getY(i), pos.getZ(i) * f);
    }
    cone.computeVertexNormals();
    const ang = rng() * Math.PI * 2;
    const off = p === 0 ? 0 : 0.75 + rng() * 0.5;
    const rock = p === 0 ? 0x93948a : p % 2 === 0 ? 0x888a80 : 0x9c9d92;
    const baseY = 0.5 + rng() * 0.1;
    const px = Math.cos(ang) * off;
    const pz = Math.sin(ang) * off * 0.4;
    parts.push(paint(cone, rock, trs(px, baseY, pz, 0, rng() * Math.PI, 0, 1, 0.95 + rng() * 0.25, 1), 0.1));
    // 雪冠：疊在山頂的小錐
    const cap = new THREE.ConeGeometry(0.42 * (0.9 + rng() * 0.2), h * 0.34, 7);
    parts.push(
      paint(cap, 0xdfe4e2, trs(px, baseY + h * 0.33, pz, 0, rng() * Math.PI, 0, 1, 0.9, 1), 0.06),
    );
  }
  return mergeColoredGeometries(parts);
}

// ─────────────────────────── 程序化貼圖 ───────────────────────────

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return { canvas, ctx };
}

function toTexture(canvas: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  if (repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** 青石板路面貼圖（一張 = 一格，3x3 大塊不規則青石板） */
export function createStoneTexture(): THREE.Texture | null {
  const c = makeCanvas(192, 192);
  if (!c) return null;
  const { ctx } = c;
  const rng = mulberry32(20261018);
  ctx.fillStyle = '#5c666e';
  ctx.fillRect(0, 0, 192, 192);
  const n = 3;
  const cell = 192 / n;
  const shades = ['#8e99a2', '#848f98', '#98a3ab', '#8a959e', '#7f8a93', '#929da5'];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const pad = 3 + rng() * 2;
      const bx = x * cell + pad + (rng() - 0.5) * 2;
      const by = y * cell + pad + (rng() - 0.5) * 2;
      const bw = cell - pad * 2 - 1;
      const bh = cell - pad * 2 - 1;
      ctx.fillStyle = shades[Math.floor(rng() * shades.length)];
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 4 + rng() * 3);
      ctx.fill();
      // 石面亮邊（左上）與暗邊（右下）製造淺浮雕感
      ctx.strokeStyle = 'rgba(228,236,240,0.4)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(bx + 3, by + bh - 3);
      ctx.lineTo(bx + 3, by + 3);
      ctx.lineTo(bx + bw - 3, by + 3);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(52,60,66,0.35)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(bx + bw - 3, by + 3);
      ctx.lineTo(bx + bw - 3, by + bh - 3);
      ctx.lineTo(bx + 3, by + bh - 3);
      ctx.stroke();
      // 斑點與風化
      for (let sd = 0; sd < 6; sd++) {
        ctx.fillStyle = rng() < 0.5 ? 'rgba(58,66,72,0.2)' : 'rgba(232,238,240,0.16)';
        ctx.fillRect(bx + 4 + rng() * (bw - 8), by + 4 + rng() * (bh - 8), 1.5 + rng() * 2.5, 1.5 + rng() * 2.5);
      }
      if (rng() < 0.18) {
        ctx.fillStyle = 'rgba(118,138,100,0.14)';
        ctx.beginPath();
        ctx.arc(bx + rng() * bw, by + rng() * bh, 3 + rng() * 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  return toTexture(c.canvas);
}

/** 木板橋面貼圖 */
export function createPlankTexture(): THREE.Texture | null {
  const c = makeCanvas(128, 128);
  if (!c) return null;
  const { ctx } = c;
  const rng = mulberry32(7788);
  const planks = 6;
  const ph = 128 / planks;
  ctx.fillStyle = '#4a3826';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < planks; i++) {
    // 以褐色為基底，逐塊微調明暗（分量各自抖動，避免色相跳動）
    const base = 0.82 + rng() * 0.26;
    const r = Math.min(255, Math.round(0x8a * base));
    const g = Math.min(255, Math.round(0x66 * base));
    const b = Math.min(255, Math.round(0x42 * base));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, i * ph + 1, 128, ph - 2);
    // 板縫亮邊
    ctx.fillStyle = 'rgba(210,190,160,0.12)';
    ctx.fillRect(0, i * ph + 1, 128, 1);
    ctx.strokeStyle = 'rgba(30,22,14,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, i * ph);
    ctx.lineTo(128, i * ph);
    ctx.stroke();
    // 木紋
    for (let k = 0; k < 3; k++) {
      ctx.strokeStyle = 'rgba(40,30,18,0.22)';
      ctx.lineWidth = 1;
      const yy = i * ph + 3 + rng() * (ph - 6);
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.bezierCurveTo(40, yy + (rng() - 0.5) * 4, 80, yy + (rng() - 0.5) * 4, 128, yy);
      ctx.stroke();
    }
  }
  return toTexture(c.canvas);
}

/** 地面細碎噪點（乘在 instanceColor 上，增加草地細節） */
export function createGroundSpeckleTexture(): THREE.Texture | null {
  const c = makeCanvas(64, 64);
  if (!c) return null;
  const { ctx } = c;
  const rng = mulberry32(4242);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 520; i++) {
    const v = 200 + Math.floor(rng() * 45);
    ctx.fillStyle = `rgba(${v},${v + 6},${v - 6},${0.25 + rng() * 0.5})`;
    ctx.fillRect(Math.floor(rng() * 64), Math.floor(rng() * 64), 1 + rng() * 2, 1 + rng() * 2);
  }
  return toTexture(c.canvas);
}

/** 雲朵貼圖（用於遠景 Sprite） */
export function createCloudTexture(seed = 5): THREE.Texture | null {
  const c = makeCanvas(256, 128);
  if (!c) return null;
  const { ctx } = c;
  const rng = mulberry32(seed);
  ctx.clearRect(0, 0, 256, 128);
  for (let i = 0; i < 16; i++) {
    const x = 40 + rng() * 176;
    const y = 48 + (rng() - 0.5) * 34;
    const r = 18 + rng() * 34;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${0.22 + rng() * 0.2})`);
    grad.addColorStop(0.6, `rgba(250,252,255,${0.12 + rng() * 0.1})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ═══════════════════════════════════════════════════════════════════
// 香港版新增：維港船隻、市區樓群貼圖、街道家具、地標、地名標籤貼圖
// ═══════════════════════════════════════════════════════════════════

/** 合併多個純幾何（position/normal/uv），供無頂點色的建築／地標使用 */
export function mergePlainGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // 先轉為非索引幾何（PlaneGeometry 等預設為索引，直接合併會損壞三角形）
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  let total = 0;
  for (const p of flat) total += p.getAttribute('position').count;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let offset = 0;
  for (const p of flat) {
    const pPos = p.getAttribute('position') as THREE.BufferAttribute;
    const pNor = p.getAttribute('normal') as THREE.BufferAttribute;
    const pUv = p.getAttribute('uv') as THREE.BufferAttribute;
    position.set(pPos.array as Float32Array, offset * 3);
    normal.set(pNor.array as Float32Array, offset * 3);
    if (pUv) uv.set(pUv.array as Float32Array, offset * 2);
    offset += pPos.count;
  }
  for (let i = 0; i < parts.length; i++) {
    if (flat[i] !== parts[i]) flat[i].dispose();
    parts[i].dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

// ─────────────────────────── 市區樓群貼圖 ───────────────────────────

export type FacadeKind = 'tower' | 'block' | 'office' | 'tenement';

export interface FacadeTexture {
  /** 日間立面（窗、外牆） */
  map: THREE.Texture;
  /** 夜間發光窗（黑底、亮窗；乘以 emissive 使用） */
  emissive: THREE.Texture;
}

/**
 * 程序化立面貼圖：香港常見樓宇——
 *  tower：玻璃幕牆商廈（藍綠玻璃＋垂直豎框）
 *  block：住宅大廈（米白／灰色外牆、小窗、冷氣機、晾衫）
 *  office：舊式寫字樓（橫向長窗、霓虹色反光）
 *  tenement：唐樓（騎樓、鐵窗、外牆水管）
 */
export function createFacadeTexture(kind: FacadeKind, seed = 7): FacadeTexture | null {
  const c = makeCanvas(128, 128);
  if (!c || !makeCanvas(8, 8)) return null;
  const { ctx } = c;
  const rng = mulberry32(seed + kind.length * 31);
  const glow = makeCanvas(128, 128);
  if (!glow) return null;
  const g = glow.ctx;
  g.fillStyle = '#000000';
  g.fillRect(0, 0, 128, 128);

  const base =
    kind === 'tower' ? '#7fa3b8' : kind === 'block' ? '#d6d0c2' : kind === 'office' ? '#a8adb2' : '#b98a68';
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 128, 128);
  // 外牆污漬與縱向水痕
  for (let i = 0; i < 22; i++) {
    ctx.fillStyle = `rgba(30,30,32,${0.04 + rng() * 0.08})`;
    ctx.fillRect(rng() * 128, rng() * 128, 1 + rng() * 3, 6 + rng() * 40);
  }

  const cols = kind === 'tenement' ? 3 : kind === 'tower' ? 4 : 4;
  const rows = kind === 'tenement' ? 5 : kind === 'tower' ? 7 : 5;
  const cw = 128 / cols;
  const ch = 128 / rows;

  const litColor =
    kind === 'tower' ? '#ffe9b0' : kind === 'block' ? '#ffd98a' : kind === 'office' ? '#cfe8ff' : '#ffcf8a';

  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const x = col * cw + cw * 0.18;
      const y = r * ch + ch * 0.22;
      const w = cw * 0.64;
      const h = ch * 0.5;
      // 窗框
      ctx.fillStyle = kind === 'tower' ? 'rgba(48,68,80,0.7)' : 'rgba(84,82,78,0.65)';
      ctx.fillRect(x - 1.5, y - 1.5, w + 3, h + 3);
      // 玻璃／窗
      const glass = kind === 'tower' ? (rng() < 0.5 ? '#517187' : '#628ea3') : rng() < 0.5 ? '#3a4148' : '#4a545c';
      ctx.fillStyle = glass;
      ctx.fillRect(x, y, w, h);
      // 玻璃反光
      ctx.fillStyle = 'rgba(190,220,235,0.28)';
      ctx.fillRect(x, y, w, h * 0.28);
      // 亮窗（夜晚）
      if (rng() < 0.42) {
        const warm = rng() < 0.7;
        g.fillStyle = warm ? litColor : '#bfe3ff';
        g.globalAlpha = 0.5 + rng() * 0.5;
        g.fillRect(x, y, w, h);
        g.globalAlpha = 1;
      }
      // 冷氣機／晾衫（住宅）
      if (kind === 'block' && rng() < 0.7) {
        ctx.fillStyle = 'rgba(200,200,195,0.9)';
        ctx.fillRect(x + w - 5, y + h + 1, 7, 5);
        ctx.fillStyle = 'rgba(70,72,70,0.7)';
        ctx.fillRect(x + w - 4, y + h + 2, 5, 3);
      }
      if (kind === 'tenement' && rng() < 0.5) {
        // 晾衫竹
        ctx.strokeStyle = 'rgba(120,110,90,0.8)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x - 2, y + h + 3);
        ctx.lineTo(x + w + 4, y + h + 3);
        ctx.stroke();
        for (let k = 0; k < 3; k++) {
          ctx.fillStyle = ['#d96b6b', '#6b9fd9', '#e0d6a8'][Math.floor(rng() * 3)];
          ctx.fillRect(x + k * (w / 3) + 1, y + h + 3, 3, 4);
        }
      }
      if (kind === 'tower') {
        // 玻璃幕牆的豎框
        ctx.fillStyle = 'rgba(230,240,246,0.22)';
        ctx.fillRect(x + w * 0.5, y - 2, 1, h + 4);
      }
      if (kind === 'office') {
        // 舊式寫字樓的橫向長窗
        ctx.fillStyle = 'rgba(220,230,238,0.16)';
        ctx.fillRect(0, y + h + 2, 128, 1);
      }
    }
  }
  // 天台／基座（左上角小區亦作為屋頂素色取樣區）
  ctx.fillStyle = '#6d7073';
  ctx.fillRect(0, 0, 8, 8);
  ctx.fillStyle = 'rgba(40,42,44,0.55)';
  ctx.fillRect(0, 0, 128, 4);
  ctx.fillStyle = 'rgba(90,92,94,0.5)';
  ctx.fillRect(0, 0, 128, 2);
  g.fillStyle = '#000000';
  g.fillRect(0, 0, 128, 4);

  return { map: toTexture(c.canvas), emissive: toTexture(glow.canvas) };
}

/** 天台／平台／地盤等素色貼圖（乘色用） */
export function createConcreteTexture(): THREE.Texture | null {
  const c = makeCanvas(64, 64);
  if (!c) return null;
  const { ctx } = c;
  const rng = mulberry32(631);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 700; i++) {
    const v = 175 + Math.floor(rng() * 70);
    ctx.fillStyle = `rgba(${v},${v},${v},${0.25 + rng() * 0.45})`;
    ctx.fillRect(Math.floor(rng() * 64), Math.floor(rng() * 64), 1 + rng() * 2, 1 + rng() * 2);
  }
  return toTexture(c.canvas);
}

// ─────────────────────────── 路面／行人路貼圖 ───────────────────────────

/** 香港瀝青馬路貼圖（細碎骨料、修補裂縫、油漬） */
export function createAsphaltTexture(): THREE.Texture | null {
  const c = makeCanvas(128, 128);
  if (!c) return null;
  const { ctx } = c;
  const rng = mulberry32(8801);
  ctx.fillStyle = '#3d4044';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 2600; i++) {
    const v = 45 + Math.floor(rng() * 70);
    ctx.fillStyle = `rgba(${v},${v + 2},${v + 5},${0.3 + rng() * 0.5})`;
    ctx.fillRect(Math.floor(rng() * 128), Math.floor(rng() * 128), 1 + rng() * 1.6, 1 + rng() * 1.6);
  }
  // 修補裂縫
  for (let k = 0; k < 4; k++) {
    ctx.strokeStyle = 'rgba(24,25,27,0.6)';
    ctx.lineWidth = 1 + rng() * 1.4;
    ctx.beginPath();
    let x = rng() * 128;
    let y = rng() * 128;
    ctx.moveTo(x, y);
    for (let s = 0; s < 4; s++) {
      x += (rng() - 0.5) * 36;
      y += (rng() - 0.5) * 36;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // 油漬
  for (let k = 0; k < 3; k++) {
    ctx.fillStyle = 'rgba(18,18,20,0.28)';
    ctx.beginPath();
    ctx.ellipse(rng() * 128, rng() * 128, 6 + rng() * 12, 4 + rng() * 8, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  return toTexture(c.canvas);
}

/** 行人路貼圖：香港常見的灰磚／紅白磚（配紅色安全島邊） */
export function createPavementTexture(kind: 'grey' | 'red', seed = 3): THREE.Texture | null {
  const c = makeCanvas(128, 128);
  if (!c) return null;
  const { ctx } = c;
  const rng = mulberry32(seed + (kind === 'red' ? 77 : 0));
  const n = 8;
  const cell = 128 / n;
  // 底色：英泥／碎石底
  ctx.fillStyle = kind === 'red' ? '#b9b3a6' : '#8d908a';
  ctx.fillRect(0, 0, 128, 128);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const bx = x * cell + 1;
      const by = y * cell + 1;
      if (kind === 'red') {
        // 紅白階磚：一行行紅磚與淺色磚交錯（香港行人路常見）
        const isRed = y % 4 < 2;
        const v = 190 + Math.floor(rng() * 22);
        ctx.fillStyle = isRed
          ? `rgb(${152 + Math.floor(rng() * 14)},${102 + Math.floor(rng() * 10)},${94 + Math.floor(rng() * 8)})`
          : `rgb(${v},${v - 4},${v - 12})`;
      } else {
        const v = 128 + Math.floor(rng() * 24);
        ctx.fillStyle = `rgb(${v},${v + 1},${v - 3})`;
      }
      ctx.fillRect(bx, by, cell - 2, cell - 2);
      // 磚面高光／接縫陰影
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(bx, by, cell - 2, 1);
      ctx.fillStyle = 'rgba(20,20,22,0.2)';
      ctx.fillRect(bx, by + cell - 3, cell - 2, 1);
      ctx.fillRect(bx + cell - 3, by, 1, cell - 2);
    }
  }
  // 污漬與青苔
  for (let i = 0; i < 150; i++) {
    ctx.fillStyle = rng() < 0.5 ? 'rgba(40,40,42,0.1)' : 'rgba(230,230,225,0.08)';
    ctx.fillRect(rng() * 128, rng() * 128, 1 + rng() * 2, 1 + rng() * 2);
  }
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = 'rgba(96,120,84,0.12)';
    ctx.fillRect(rng() * 128, rng() * 128, 2 + rng() * 4, 1 + rng() * 3);
  }
  return toTexture(c.canvas);
}

/** 霓虹／街燈光暈貼圖（加色混合用） */
export function createGlowTexture(): THREE.Texture | null {
  const c = makeCanvas(64, 64);
  if (!c) return null;
  const { ctx } = c;
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ─────────────────────────── 維港船隻 ───────────────────────────

/** 天星小輪：白綠雙層渡輪 */
export function createStarFerryGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // 船身（白色，綠色水線）
  parts.push(paint(new THREE.BoxGeometry(2.3, 0.34, 0.78), 0xf2f4f2, trs(0, 0.14, 0), 0.03));
  parts.push(paint(new THREE.BoxGeometry(2.36, 0.08, 0.8), 0x2f7f5f, trs(0, 0.02, 0), 0.03));
  // 下層客艙
  parts.push(paint(new THREE.BoxGeometry(1.9, 0.3, 0.68), 0xeef1ee, trs(0, 0.45, 0), 0.03));
  parts.push(paint(new THREE.BoxGeometry(1.5, 0.16, 0.7), 0x2b3a3c, trs(0, 0.46, 0), 0.03));
  // 上層客艙
  parts.push(paint(new THREE.BoxGeometry(1.55, 0.28, 0.6), 0xf4f6f3, trs(0, 0.74, 0), 0.03));
  parts.push(paint(new THREE.BoxGeometry(1.2, 0.14, 0.62), 0x2b3a3c, trs(0, 0.75, 0), 0.03));
  // 綠色頂篷
  parts.push(paint(new THREE.BoxGeometry(1.6, 0.06, 0.64), 0x2f7f5f, trs(0, 0.9, 0), 0.03));
  // 煙囪
  parts.push(paint(new THREE.CylinderGeometry(0.07, 0.09, 0.24, 6), 0xf0f2f0, trs(-0.6, 0.62, 0), 0.03));
  // 船頭旗桿
  parts.push(paint(new THREE.CylinderGeometry(0.015, 0.015, 0.36, 4), 0xd8d8d2, trs(1.05, 0.55, 0), 0.02));
  return mergeColoredGeometries(parts);
}

/** 紅帆漁船（香港仔／避風塘的傳統帆船剪影） */
export function createJunkBoatGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // 木船身
  parts.push(paint(new THREE.BoxGeometry(2.0, 0.3, 0.66), 0x6b4a33, trs(0, 0.14, 0), 0.06));
  parts.push(paint(new THREE.BoxGeometry(2.06, 0.07, 0.7), 0x8a5a3c, trs(0, 0.04, 0), 0.05));
  // 船艙
  parts.push(paint(new THREE.BoxGeometry(0.7, 0.22, 0.48), 0xb08d63, trs(-0.25, 0.35, 0), 0.05));
  // 桅杆
  parts.push(paint(new THREE.CylinderGeometry(0.025, 0.035, 2.3, 5), 0x5a4430, trs(0.15, 1.2, 0), 0.03));
  // 紅帆（三片，程序化面片）
  const sailColors = [0xc0392b, 0xa93226, 0xd04a35];
  const sails: [number, number, number, number][] = [
    [0.15, 1.55, 0.5, 0.9],
    [0.15, 0.95, 0.62, 0.62],
    [0.15, 0.45, 0.5, 0.4],
  ];
  for (let i = 0; i < sails.length; i++) {
    const [x, y, w, h] = sails[i];
    const geo = new THREE.PlaneGeometry(w, h);
    parts.push(paint(geo, sailColors[i], trs(x + w * 0.35, y, 0, 0, Math.PI / 2, 0.06), 0.05));
  }
  return mergeColoredGeometries(parts);
}

/** 貨輪（葵青貨櫃碼頭／維港西的遠洋船） */
export function createCargoShipGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // 船身
  parts.push(paint(new THREE.BoxGeometry(4.4, 0.5, 1.2), 0x2b3a44, trs(0, 0.24, 0), 0.04));
  parts.push(paint(new THREE.BoxGeometry(4.5, 0.1, 1.24), 0x8a2f2a, trs(0, 0.03, 0), 0.03));
  // 船尾艙樓
  parts.push(paint(new THREE.BoxGeometry(0.8, 0.6, 1.0), 0xe8e6de, trs(-1.7, 0.72, 0), 0.03));
  parts.push(paint(new THREE.BoxGeometry(0.5, 0.22, 0.7), 0x2b3a44, trs(-1.7, 0.95, 0), 0.03));
  // 甲板貨櫃（彩色）
  const colors = [0xb03a32, 0x2f6f9f, 0x3f8f5f, 0xd9a63f, 0x8a8f96];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 2; j++) {
      parts.push(
        paint(
          new THREE.BoxGeometry(0.62, 0.24, 0.5),
          colors[(i + j * 2) % colors.length],
          trs(-1.0 + i * 0.66, 0.62 + j * 0.26, 0),
          0.05,
        ),
      );
    }
  }
  return mergeColoredGeometries(parts);
}

/** 小漁船／舢舨 */
export function createFishingBoatGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.BoxGeometry(0.9, 0.16, 0.4), 0xd8d4c6, trs(0, 0.08, 0), 0.05));
  parts.push(paint(new THREE.BoxGeometry(0.5, 0.2, 0.32), 0x9fb4bd, trs(-0.1, 0.24, 0), 0.05));
  parts.push(paint(new THREE.CylinderGeometry(0.012, 0.012, 0.5, 4), 0x6a5a44, trs(0.2, 0.4, 0), 0.02));
  return mergeColoredGeometries(parts);
}

// ─────────────────────────── 樹木（香港植物） ───────────────────────────

/** 榕樹（香港常見大樹，樹冠寬闊、有氣根） */
export function createBanyanGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.14, 0.24, 1.0, 6), 0x5c4a34, trs(0, 0.5, 0), 0.06));
  // 粗壯氣根
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const x = Math.cos(a) * 0.55;
    const z = Math.sin(a) * 0.55;
    parts.push(paint(new THREE.CylinderGeometry(0.025, 0.04, 0.7 + (i % 2) * 0.3, 4), 0x6a563e, trs(x, 0.35, z, 0, a, 0.18), 0.05));
  }
  const blobs: [number, number, number, number, number][] = [
    [0, 1.55, 0, 0.95, 0x3f6e35],
    [0.7, 1.35, 0.15, 0.62, 0x4a7a3c],
    [-0.65, 1.4, -0.2, 0.6, 0x386230],
    [0.1, 1.9, -0.1, 0.6, 0x527f40],
  ];
  for (const [x, y, z, r, col] of blobs) {
    parts.push(paint(new THREE.IcosahedronGeometry(r, 0), col, trs(x, y, z, x, y * 2, z, 1, 0.72, 1), 0.09));
  }
  return mergeColoredGeometries(parts);
}

/** 棕櫚樹（海濱長廊、市區公園） */
export function createPalmGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.06, 0.1, 1.9, 5), 0x8a7a5a, trs(0, 0.95, 0, 0, 0, 0.05), 0.06));
  const fronds = 7;
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2;
    const len = 0.8 + (i % 3) * 0.12;
    parts.push(
      paint(
        new THREE.ConeGeometry(0.14, len, 4),
        i % 2 === 0 ? 0x3f7a35 : 0x4e8c3e,
        trs(Math.cos(a) * len * 0.32, 1.9 - len * 0.1, Math.sin(a) * len * 0.32, Math.PI * 0.5 - 0.35, a, Math.cos(a) * 0.2),
        0.08,
      ),
    );
  }
  parts.push(paint(new THREE.IcosahedronGeometry(0.16, 0), 0x5d8a3a, trs(0, 1.9, 0), 0.06));
  return mergeColoredGeometries(parts);
}

/** 洋紫荊（香港市花，花期粉紫） */
export function createBauhiniaGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.07, 0.12, 1.0, 5), 0x6a5540, trs(0, 0.5, 0, 0, 0.4, 0.04), 0.05));
  const blobs: [number, number, number, number, number][] = [
    [0, 1.35, 0, 0.62, 0x5d8a4a],
    [0.4, 1.15, 0.1, 0.42, 0x6d9a52],
    [-0.36, 1.2, -0.1, 0.4, 0x527f42],
    [0.05, 1.62, -0.05, 0.4, 0xd884b3],
  ];
  for (const [x, y, z, r, col] of blobs) {
    parts.push(paint(new THREE.IcosahedronGeometry(r, 0), col, trs(x, y, z, x, y * 2, z, 1, 0.85, 1), 0.08));
  }
  // 洋紫荊花
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    parts.push(paint(new THREE.IcosahedronGeometry(0.09, 0), 0xe58cc0, trs(Math.cos(a) * 0.5, 1.45 + Math.sin(a * 2) * 0.2, Math.sin(a) * 0.5), 0.1));
  }
  return mergeColoredGeometries(parts);
}

// ─────────────────────────── 街道家具 ───────────────────────────

/** 香港街燈（灰色燈柱＋單臂燈頭） */
export function createStreetLampGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.035, 0.05, 1.55, 6), 0x8f9496, trs(0, 0.78, 0), 0.03));
  parts.push(paint(new THREE.BoxGeometry(0.05, 0.05, 0.36), 0x8f9496, trs(0, 1.55, 0.16), 0.02));
  parts.push(paint(new THREE.BoxGeometry(0.16, 0.06, 0.22), 0x5a5f62, trs(0, 1.53, 0.34), 0.02));
  // 燈頭（發光面，材質用 emissive 控制）
  parts.push(paint(new THREE.BoxGeometry(0.12, 0.03, 0.16), 0xfff3c8, trs(0, 1.49, 0.34), 0.01));
  parts.push(paint(new THREE.BoxGeometry(0.1, 0.03, 0.14), 0x44484a, trs(0, 1.55, 0.34), 0.02));
  return mergeColoredGeometries(parts);
}

/** 香港巴士站（站牌＋候車亭頂） */
export function createBusStopGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // 站牌柱
  parts.push(paint(new THREE.CylinderGeometry(0.025, 0.03, 1.2, 5), 0x9aa0a4, trs(-0.42, 0.6, 0.22), 0.03));
  // 站牌（黃底紅字抽象色塊）
  parts.push(paint(new THREE.BoxGeometry(0.34, 0.5, 0.03), 0xf2c53f, trs(-0.42, 1.05, 0.22), 0.02));
  parts.push(paint(new THREE.BoxGeometry(0.28, 0.08, 0.035), 0xd93f3f, trs(-0.42, 1.16, 0.22), 0.02));
  parts.push(paint(new THREE.BoxGeometry(0.28, 0.06, 0.035), 0x2f2f2f, trs(-0.42, 1.0, 0.22), 0.02));
  // 候車亭：兩支柱＋頂
  parts.push(paint(new THREE.CylinderGeometry(0.03, 0.03, 1.3, 5), 0x9aa0a4, trs(0.15, 0.65, 0), 0.03));
  parts.push(paint(new THREE.CylinderGeometry(0.03, 0.03, 1.3, 5), 0x9aa0a4, trs(0.15, 0.65, 0.62), 0.03));
  parts.push(paint(new THREE.BoxGeometry(0.7, 0.06, 0.74), 0x8fb0b8, trs(0.15, 1.34, 0.31), 0.03));
  parts.push(paint(new THREE.BoxGeometry(0.04, 0.34, 0.66), 0xb8d0d4, trs(0.47, 1.08, 0.31), 0.02));
  return mergeColoredGeometries(parts);
}

/** 香港金屬欄杆（行人路邊、海濱） */
export function createMetalRailingGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const metal = 0xa8b0b4;
  parts.push(paint(new THREE.BoxGeometry(0.05, 0.55, 0.05), metal, trs(-0.92, 0.28, 0), 0.03));
  parts.push(paint(new THREE.BoxGeometry(0.05, 0.55, 0.05), metal, trs(0.92, 0.28, 0), 0.03));
  parts.push(paint(new THREE.BoxGeometry(1.95, 0.05, 0.06), metal, trs(0, 0.5, 0), 0.02));
  parts.push(paint(new THREE.BoxGeometry(1.95, 0.04, 0.05), 0xc4ccd0, trs(0, 0.34, 0), 0.02));
  // 直杆
  for (let i = -2; i <= 2; i++) {
    parts.push(paint(new THREE.BoxGeometry(0.025, 0.36, 0.025), 0xb8c0c4, trs(i * 0.34, 0.3, 0), 0.02));
  }
  return mergeColoredGeometries(parts);
}

/** 貨櫃（貨櫃碼頭堆場用；逐實例上色） */
export function createContainerGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.BoxGeometry(1.2, 0.55, 0.5), 0xffffff, trs(0, 0.28, 0), 0.035));
  // 波紋（以深色細條模擬）
  for (let i = 0; i < 6; i++) {
    parts.push(paint(new THREE.BoxGeometry(0.03, 0.5, 0.52), 0xd8d8d8, trs(-0.45 + i * 0.18, 0.28, 0), 0.02));
  }
  return mergeColoredGeometries(parts);
}

// ─────────────────────────── 香港地標 ───────────────────────────

/** 山頂凌霄閣（太平山頂） */
export function createPeakTowerGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.BoxGeometry(1.5, 0.5, 1.1), 0x6d757a, trs(0, 0.25, 0), 0.03));
  parts.push(paint(new THREE.BoxGeometry(1.2, 0.7, 0.9), 0x9aa4a8, trs(0, 0.85, 0), 0.03));
  // 弧形觀景層
  parts.push(paint(new THREE.CylinderGeometry(0.75, 0.85, 0.32, 8, 1, false, 0, Math.PI), 0xcfd8dc, trs(0, 1.36, 0, 0, 0, 0, 1, 1, 1), 0.03));
  parts.push(paint(new THREE.BoxGeometry(1.7, 0.08, 1.0), 0x3f4a50, trs(0, 1.28, 0), 0.02));
  // 天線
  parts.push(paint(new THREE.CylinderGeometry(0.02, 0.04, 0.7, 4), 0xb0b8bc, trs(0.2, 1.8, 0), 0.02));
  return mergeColoredGeometries(parts);
}

/** 天壇大佛（大嶼山昂坪） */
export function createBuddhaGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const bronze = 0x8a7a5a;
  const bronzeLight = 0x9e8f6c;
  // 蓮花座
  parts.push(paint(new THREE.CylinderGeometry(0.55, 0.65, 0.18, 10), 0x6b6f66, trs(0, 0.09, 0), 0.03));
  parts.push(paint(new THREE.CylinderGeometry(0.42, 0.5, 0.12, 10), 0x8f9488, trs(0, 0.24, 0), 0.03));
  // 身體（盤坐）
  parts.push(paint(new THREE.CylinderGeometry(0.32, 0.52, 0.55, 8), bronze, trs(0, 0.56, 0), 0.03));
  // 肩膀與手
  parts.push(paint(new THREE.BoxGeometry(0.9, 0.16, 0.24), bronzeLight, trs(0, 0.8, 0), 0.03));
  // 頭
  parts.push(paint(new THREE.SphereGeometry(0.2, 8, 6), bronze, trs(0, 1.05, 0), 0.03));
  parts.push(paint(new THREE.SphereGeometry(0.23, 8, 5), bronzeLight, trs(0, 1.14, 0), 0.03));
  // 頭光
  parts.push(paint(new THREE.CylinderGeometry(0.26, 0.26, 0.05, 10), 0xd9b23f, trs(0, 1.3, 0), 0.02));
  return mergeColoredGeometries(parts);
}

/** 中環摩天輪（香港摩天輪） */
export function createFerrisWheelGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const wheelR = 1.15;
  // 支架
  parts.push(paint(new THREE.CylinderGeometry(0.05, 0.08, 1.1, 5), 0xb8bcc0, trs(0, 0.55, 0), 0.02));
  // 輪圈
  parts.push(paint(new THREE.TorusGeometry(wheelR, 0.035, 4, 22), 0xd8dde0, trs(0, 1.6, 0, 0, 0, 0), 0.02));
  parts.push(paint(new THREE.TorusGeometry(wheelR * 0.82, 0.025, 4, 20), 0xc4cacd, trs(0, 1.6, 0, 0, 0, 0), 0.02));
  // 輻條
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    parts.push(
      paint(
        new THREE.BoxGeometry(0.025, wheelR * 2, 0.025),
        0xcfd5d8,
        trs(0, 1.6, 0, 0, 0, a),
        0.02,
      ),
    );
  }
  // 車廂
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    parts.push(
      paint(
        new THREE.BoxGeometry(0.16, 0.14, 0.14),
        i % 2 === 0 ? 0xd93f3f : 0x2f6f9f,
        trs(Math.cos(a) * wheelR, 1.6 + Math.sin(a) * wheelR, 0, 0, 0, 0),
        0.03,
      ),
    );
  }
  return mergeColoredGeometries(parts);
}

/** 尖沙咀鐘樓（前九廣鐵路鐘樓） */
export function createClockTowerGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // 紅磚塔身
  parts.push(paint(new THREE.BoxGeometry(0.5, 0.9, 0.5), 0x9a4a38, trs(0, 0.45, 0), 0.04));
  // 白色飾帶
  parts.push(paint(new THREE.BoxGeometry(0.54, 0.1, 0.54), 0xd8cfc0, trs(0, 0.94, 0), 0.03));
  // 上層
  parts.push(paint(new THREE.BoxGeometry(0.42, 0.55, 0.42), 0x8f4130, trs(0, 1.24, 0), 0.04));
  parts.push(paint(new THREE.BoxGeometry(0.46, 0.08, 0.46), 0xd8cfc0, trs(0, 1.54, 0), 0.03));
  // 時鐘（四面）
  for (const [dx, dz, rot] of [
    [0, 0.23, 0],
    [0, -0.23, Math.PI],
    [0.23, 0, Math.PI / 2],
    [-0.23, 0, -Math.PI / 2],
  ]) {
    parts.push(paint(new THREE.BoxGeometry(0.24, 0.24, 0.03), 0x2f2a24, trs(dx, 1.22, dz, 0, rot, 0), 0.02));
    parts.push(paint(new THREE.BoxGeometry(0.19, 0.19, 0.04), 0xf2e6c8, trs(dx, 1.22, dz, 0, rot, 0), 0.02));
    parts.push(paint(new THREE.BoxGeometry(0.02, 0.1, 0.05), 0x2f2a24, trs(dx, 1.26, dz, 0, rot, 0), 0.02));
  }
  // 圓頂
  parts.push(paint(new THREE.SphereGeometry(0.24, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), 0x5f7a72, trs(0, 1.6, 0), 0.03));
  parts.push(paint(new THREE.CylinderGeometry(0.015, 0.03, 0.3, 4), 0xb0b8b4, trs(0, 1.9, 0), 0.02));
  return mergeColoredGeometries(parts);
}

/** 會展新翼（灣仔海旁，弧形屋頂） */
export function createConventionGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.BoxGeometry(2.6, 0.4, 1.4), 0xc8ccd0, trs(0, 0.2, 0), 0.02));
  parts.push(paint(new THREE.BoxGeometry(2.2, 0.35, 1.0), 0x5f7f8f, trs(0, 0.55, 0), 0.03));
  // 弧形屋頂（半圓柱）
  const roof = new THREE.CylinderGeometry(0.9, 0.9, 2.4, 10, 1, false, 0, Math.PI);
  parts.push(paint(roof, 0xdfe4e6, trs(0, 0.72, 0, 0, 0, Math.PI / 2, 1, 1, 1), 0.02));
  return mergeColoredGeometries(parts);
}

/** 青馬大橋（汲水門上，塔＋橋面；鋼纜另以線段繪畫） */
export function createBridgeGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const span = 5.2;
  // 橋面
  parts.push(paint(new THREE.BoxGeometry(span, 0.12, 0.7), 0x8f9598, trs(0, 0.95, 0), 0.02));
  // 橋塔
  for (const x of [-1.2, 1.2]) {
    parts.push(paint(new THREE.BoxGeometry(0.16, 2.2, 0.18), 0xcfd4d6, trs(x, 1.1, 0.22), 0.02));
    parts.push(paint(new THREE.BoxGeometry(0.16, 2.2, 0.18), 0xcfd4d6, trs(x, 1.1, -0.22), 0.02));
    parts.push(paint(new THREE.BoxGeometry(0.16, 0.12, 0.62), 0xcfd4d6, trs(x, 2.15, 0), 0.02));
    parts.push(paint(new THREE.BoxGeometry(0.16, 0.12, 0.62), 0xcfd4d6, trs(x, 1.55, 0), 0.02));
  }
  // 引橋
  parts.push(paint(new THREE.BoxGeometry(span * 0.5, 0.1, 0.66), 0x8f9598, trs(-span * 0.72, 0.75, 0), 0.02));
  parts.push(paint(new THREE.BoxGeometry(span * 0.5, 0.1, 0.66), 0x8f9598, trs(span * 0.72, 0.75, 0), 0.02));
  return mergeColoredGeometries(parts);
}

/** 飛機（赤鱲角機場停機坪／跑道） */
export function createAirplaneGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.BoxGeometry(1.5, 0.18, 0.18), 0xeef2f4, trs(0, 0.16, 0), 0.02));
  parts.push(paint(new THREE.BoxGeometry(0.45, 0.3, 0.16), 0x2f6f9f, trs(0.1, 0.18, 0), 0.02));
  // 主翼
  parts.push(paint(new THREE.BoxGeometry(0.32, 0.05, 1.5), 0xe4eaec, trs(0.05, 0.14, 0), 0.02));
  // 尾翼
  parts.push(paint(new THREE.BoxGeometry(0.06, 0.34, 0.44), 0xd93f3f, trs(-0.66, 0.32, 0), 0.02));
  parts.push(paint(new THREE.BoxGeometry(0.3, 0.04, 0.4), 0xe4eaec, trs(-0.62, 0.2, 0), 0.02));
  return mergeColoredGeometries(parts);
}

// ─────────────────────────── 地名標籤貼圖 ───────────────────────────

export interface LabelAtlas {
  texture: THREE.Texture;
  /** 每個標籤在圖集中的 UV 範圍（0..1） */
  rects: { u0: number; v0: number; u1: number; v1: number; aspect: number }[];
}

/**
 * 產生地名標籤圖集（繁體中文）；全部標籤共用一張貼圖，
 * environment.ts 以單一 billboard mesh 繪製（1 draw call）。
 * rects 只框住實際文字範圍，aspect = 文字寬／字高，令 billboard 不被拉闊。
 */
export function createLabelAtlas(names: string[]): LabelAtlas | null {
  const cellW = 480;
  const cellH = 88;
  const padX = 16;
  const cols = 2;
  const rows = Math.ceil(names.length / cols);
  const c = makeCanvas(cellW * cols, cellH * rows);
  if (!c) return null;
  const { ctx } = c;
  ctx.clearRect(0, 0, c.canvas.width, c.canvas.height);
  const font = (size: number): string =>
    'bold ' + size + 'px "Noto Sans CJK HK", "Noto Sans CJK TC", "Noto Sans TC", "PingFang HK", "Microsoft JhengHei", "Heiti TC", sans-serif';
  const fontSize = 48;
  ctx.font = font(fontSize);
  const rects: LabelAtlas['rects'] = [];
  for (let i = 0; i < names.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cellW;
    const y = row * cellH;
    const name = names[i];
    const textW = Math.max(2, ctx.measureText(name).width);
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const cx = x + padX + (cellW - padX * 2 - textW) / 2;
    const cy = y + cellH / 2;
    // 柔和描邊，令地名在淺色海水／山景上都可讀
    ctx.lineWidth = 9;
    ctx.strokeStyle = 'rgba(8, 16, 26, 0.72)';
    ctx.strokeText(name, cx, cy);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.strokeText(name, cx, cy);
    ctx.fillStyle = 'rgba(240, 248, 255, 0.97)';
    ctx.fillText(name, cx, cy);
    ctx.restore();
    const textH = fontSize * 1.34;
    rects.push({
      u0: (cx - 4) / c.canvas.width,
      v0: 1 - (cy + textH / 2) / c.canvas.height,
      u1: (cx + textW + 4) / c.canvas.width,
      v1: 1 - (cy - textH / 2) / c.canvas.height,
      aspect: (textW + 8) / textH,
    });
  }
  const tex = new THREE.CanvasTexture(c.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return { texture: tex, rects };
}
