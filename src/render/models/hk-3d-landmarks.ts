/**
 * 《維港之城》— Round 9 / issue #20：CSDI 3D-BIT00 真實建築 landmark renderer。
 *
 * 資料來源：地政總署 CSDI「3D-BIT00」三維建築模型（由 `tools/build-3d-landmarks.py`
 * 離線抽取，Lead 生成 `src/world/hk-3d-landmarks.generated.ts`，每個模型係
 * `{ id, sheet, heightM, xTile, yTile, verts:number[], tris:number[] }`，
 * verts 已經轉做「相對建築中心、base y=0」的 world unit（1 unit≈56m）。
 *
 * 本模組只負責 render：
 *  - 由原始 verts/tris 建 custom BufferGeometry（positions/normals/colors +
 *    aWindowGlow attribute）；每棟 landmark 只 1 個 mesh／1 個 draw call。
 *  - 用 vertex colors 上色：低飽和混凝土／米灰外牆 + 深色玻璃窗帶；按高度、
 *    法線、樓層與窗柱比例程序化分辨「窗」「牆」「天台」，輸出日間外觀。
 *  - 夜間窗光：唔額外加 mesh，用 vertex attribute `aWindowGlow` ＋ onBeforeCompile
 *    注入 Lambert shader，夜間將部分窗戶加暖色 emissive（uniform 一次過更新）。
 *  - 面數控制：頂點聚類 decimation，確保每棟 ≤1500 tris（超出先由粗網格降面，
 *    最後才按面積截斷），避免 CSDI 原始模型爆三角形。
 *  - 幾何快取：同一 id 只建一次；多棟建築可共用 geometry/material（各自 mesh）。
 *  - generated 檔未存在時用內建 5 個假 landmark（IFC／中銀／匯豐／唐樓／會展）
 *    測試；檔案一出 now 用 `import.meta.glob` 自動載入，唔需要改 code。
 *
 * 對外 API（buildings.ts 使用）：
 *   createHk3dLandmarkMesh(id) -> { mesh, height, tris } | null
 *   hk3dLandmarkAvailable(id) / hk3dLandmarkSource() / hk3dLandmarkStats()
 *   setHk3dNightMode(night) / retainHk3dLandmarks() / releaseHk3dLandmarks()
 */

import * as THREE from 'three';
import type { Landmark3DModel } from '../../world/hk-3d-landmarks-types';

/** 每個 landmark 最多三角形（renderer 預算） */
export const MAX_LANDMARK_TRIS = 1500;

/** 太粗略／壞資料的模型直接 fallback 現有 prototype */
const MIN_TRIS = 4;
const MAX_SOURCE_TRIS = 20000;

// ─────────────────────────── 資料載入 ───────────────────────────

type LandmarkData = Landmark3DModel;

let models: readonly LandmarkData[] = [];
let dataSource: 'generated' | 'fake' | 'none' = 'none';

/**
 * 自動接入 Lead 生成的資料檔。檔案未存在時 Vite glob 回傳空物件（唔會 build 失敗）；
 * Lead 之後加入 `src/world/hk-3d-landmarks.generated.ts` 會自動被載入。
 */
const generatedModules = import.meta.glob<Record<string, unknown>>(
  '../../world/hk-3d-landmarks.generated.ts',
  { eager: true },
);

function extractGeneratedModels(): LandmarkData[] | null {
  for (const mod of Object.values(generatedModules)) {
    if (!mod || typeof mod !== 'object') continue;
    const m = mod as Record<string, unknown>;
    const candidates = [m.LANDMARK_3D_MODELS, m.HK_3D_LANDMARKS, m.LANDMARKS_3D, m.models, m.default];
    for (const c of candidates) {
      if (Array.isArray(c) && c.length > 0 && typeof (c[0] as { verts?: unknown })?.verts !== 'undefined') {
        return c as LandmarkData[];
      }
      // default export 可能係 { LANDMARK_3D_MODELS: [...] }
      if (c && typeof c === 'object' && !Array.isArray(c)) {
        const nested = (c as Record<string, unknown>).LANDMARK_3D_MODELS;
        if (Array.isArray(nested) && nested.length > 0) return nested as LandmarkData[];
      }
    }
  }
  return null;
}

// ─────────────────────────── 假模型（generated 未到時測試用） ───────────────────────────

interface FakeBox {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

/** 由一組 box 砌一個 landmark 的 verts/tris。 */
function boxesToModel(id: number, sheet: string, heightM: number, boxes: FakeBox[]): LandmarkData {
  const verts: number[] = [];
  const tris: number[] = [];
  for (const b of boxes) {
    const x0 = b.x - b.w / 2;
    const x1 = b.x + b.w / 2;
    const y0 = b.y;
    const y1 = b.y + b.h;
    const z0 = b.z - b.d / 2;
    const z1 = b.z + b.d / 2;
    const base = verts.length / 3;
    // 8 corners
    verts.push(
      x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1,
      x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1,
    );
    const q = (a: number, b2: number, c: number, d: number): void => {
      tris.push(base + a, base + b2, base + c, base + a, base + c, base + d);
    };
    // bottom / top / sides（winding 唔太重要，材質雙面）
    q(0, 3, 2, 1);
    q(4, 5, 6, 7);
    q(0, 1, 5, 4);
    q(1, 2, 6, 5);
    q(2, 3, 7, 6);
    q(3, 0, 4, 7);
  }
  return { id, sheet, heightM, xTile: 0, yTile: 0, verts, tris };
}

/**
 * 內建假 landmark（世界單位；1 unit≈56m）。
 * 只喺 `hk-3d-landmarks.generated.ts` 未存在時使用，用嚟測試 renderer／截圖。
 */
export function createFakeLandmarks(): LandmarkData[] {
  // 0) 國際金融中心 IFC（約 390m → 7.0 units，階梯式塔樓）
  const ifc = boxesToModel(0, 'fake-IFC', 390, [
    { x: 0, y: 0, z: 0, w: 2.4, h: 0.55, d: 2.1 },
    { x: 0, y: 0.55, z: 0, w: 1.65, h: 1.9, d: 1.5 },
    { x: 0, y: 2.45, z: 0, w: 1.45, h: 1.9, d: 1.3 },
    { x: 0, y: 4.35, z: 0, w: 1.2, h: 1.5, d: 1.1 },
    { x: 0, y: 5.85, z: 0, w: 0.85, h: 0.7, d: 0.8 },
    { x: 0.9, y: 0.55, z: 0.55, w: 0.35, h: 1.1, d: 0.35 },
    { x: 0, y: 6.55, z: 0, w: 0.4, h: 0.45, d: 0.4 },
  ]);
  // 1) 中銀大廈（約 315m → 5.6 units，節節收窄＋雙天線）
  const boc = boxesToModel(1, 'fake-BOC', 315, [
    { x: 0, y: 0, z: 0, w: 1.9, h: 0.6, d: 1.9 },
    { x: 0, y: 0.6, z: 0, w: 1.45, h: 1.5, d: 1.45 },
    { x: 0.12, y: 2.1, z: 0.12, w: 1.1, h: 1.4, d: 1.1 },
    { x: 0.24, y: 3.5, z: 0.24, w: 0.75, h: 1.2, d: 0.75 },
    { x: 0.3, y: 4.7, z: 0.3, w: 0.4, h: 0.9, d: 0.4 },
    { x: 0.05, y: 5.6, z: 0.05, w: 0.06, h: 0.75, d: 0.06 },
    { x: 0.45, y: 5.55, z: 0.45, w: 0.06, h: 0.6, d: 0.06 },
  ]);
  // 2) 匯豐總行大廈（約 180m → 3.2 units，三塊高低板樓）
  const hsb = boxesToModel(2, 'fake-HSB', 180, [
    { x: 0, y: 0, z: 0, w: 2.6, h: 0.35, d: 1.8 },
    { x: -0.75, y: 0.35, z: 0, w: 0.55, h: 2.5, d: 1.35 },
    { x: 0.05, y: 0.35, z: 0, w: 0.55, h: 2.9, d: 1.35 },
    { x: 0.85, y: 0.35, z: 0, w: 0.55, h: 1.85, d: 1.35 },
    { x: 0, y: 2.1, z: 0, w: 1.9, h: 0.18, d: 0.9 },
    { x: 0.05, y: 3.25, z: 0, w: 0.3, h: 0.35, d: 0.3 },
  ]);
  // 3) 唐樓群（舊區，約 25m → 0.45 units）
  const tongLau = boxesToModel(3, 'fake-TONGLau', 25, [
    { x: -0.9, y: 0, z: 0, w: 0.55, h: 0.44, d: 0.75 },
    { x: -0.3, y: 0, z: 0, w: 0.55, h: 0.5, d: 0.75 },
    { x: 0.3, y: 0, z: 0, w: 0.55, h: 0.41, d: 0.75 },
    { x: 0.9, y: 0, z: 0, w: 0.55, h: 0.47, d: 0.75 },
  ]);
  // 4) 會展中心（弧形屋頂用扁盒近似，約 50m → 0.9 units）
  const hkcec = boxesToModel(4, 'fake-HKCEC', 50, [
    { x: 0, y: 0, z: 0, w: 3.2, h: 0.4, d: 1.6 },
    { x: 0, y: 0.4, z: 0, w: 2.8, h: 0.22, d: 1.3 },
    { x: 0, y: 0.62, z: 0, w: 2.2, h: 0.12, d: 1.0 },
    { x: 0, y: 0.74, z: 0, w: 1.3, h: 0.1, d: 0.6 },
  ]);
  return [ifc, boc, hsb, tongLau, hkcec];
}

function initData(): void {
  const real = extractGeneratedModels();
  if (real && real.length > 0) {
    models = real;
    dataSource = 'generated';
    return;
  }
  models = createFakeLandmarks();
  dataSource = 'fake';
  // eslint-disable-next-line no-console
  console.info(
    `[hk-3d-landmarks] 未找到 src/world/hk-3d-landmarks.generated.ts，暫用 ${models.length} 個內建假 landmark 測試。`,
  );
}
initData();

// ─────────────────────────── 幾何建立（decimation＋vertex colors） ───────────────────────────

interface BuiltLandmark {
  geometry: THREE.BufferGeometry;
  /** 模型世界高度（用於 LOD box / info） */
  height: number;
  /** 最終三角形數 */
  tris: number;
  /** 原始三角形數（cap 前） */
  sourceTris: number;
  /** 佔地（世界單位） */
  footprintW: number;
  footprintD: number;
}

interface ClusterResult {
  positions: Float32Array;
  indices: Uint32Array;
}

function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** 讀 verts（支援 number[] / Float32Array）；只支援 xyz stride 3（CSDI 轉換格式）。 */
function readVerts(raw: readonly number[] | Float32Array): Float32Array | null {
  let arr: Float32Array;
  if (raw instanceof Float32Array) arr = raw;
  else if (Array.isArray(raw)) arr = Float32Array.from(raw);
  else return null;
  if (arr.length < 9 || arr.length % 3 !== 0) return null;
  return arr;
}

function readIndices(raw: readonly number[] | Uint32Array | Uint16Array, vertCount: number): Uint32Array | null {
  let arr: Uint32Array;
  if (raw instanceof Uint32Array) arr = raw;
  else if (raw instanceof Uint16Array) arr = Uint32Array.from(raw);
  else if (Array.isArray(raw)) arr = Uint32Array.from(raw);
  else return null;
  if (arr.length < 3) return null;
  const triCount = Math.floor(arr.length / 3);
  const out = new Uint32Array(triCount * 3);
  let n = 0;
  for (let i = 0; i < triCount; i++) {
    const a = arr[i * 3];
    const b = arr[i * 3 + 1];
    const c = arr[i * 3 + 2];
    if (a >= vertCount || b >= vertCount || c >= vertCount || a === b || b === c || a === c) continue;
    out[n++] = a;
    out[n++] = b;
    out[n++] = c;
  }
  return out.subarray(0, n) as Uint32Array;
}

/**
 * 頂點聚類 decimation：把空間切成 cell，同一個 cell 的頂點合併成其平均值。
 * 三角形退化（兩點同 cell）就丟棄。可重複用更大的 cell 直到面數達標。
 */
function clusterDecimate(positions: Float32Array, indices: Uint32Array, cell: number): ClusterResult {
  const vCount = positions.length / 3;
  const clusterOf = new Int32Array(vCount).fill(-1);
  const bucketKey = new Map<string, number>();
  const sums: number[] = [];
  const counts: number[] = [];
  for (let i = 0; i < vCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const key = `${Math.floor(x / cell)}|${Math.floor(y / cell)}|${Math.floor(z / cell)}`;
    let cid = bucketKey.get(key);
    if (cid === undefined) {
      cid = counts.length;
      bucketKey.set(key, cid);
      sums.push(0, 0, 0);
      counts.push(0);
    }
    clusterOf[i] = cid;
    sums[cid * 3] += x;
    sums[cid * 3 + 1] += y;
    sums[cid * 3 + 2] += z;
    counts[cid]++;
  }
  const newPos = new Float32Array(counts.length * 3);
  for (let c = 0; c < counts.length; c++) {
    newPos[c * 3] = sums[c * 3] / counts[c];
    newPos[c * 3 + 1] = sums[c * 3 + 1] / counts[c];
    newPos[c * 3 + 2] = sums[c * 3 + 2] / counts[c];
  }
  const seenTri = new Set<string>();
  const newIdx: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = clusterOf[indices[t]];
    const b = clusterOf[indices[t + 1]];
    const c = clusterOf[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    const sorted = [a, b, c].sort((p, q) => p - q);
    const key = `${sorted[0]}_${sorted[1]}_${sorted[2]}`;
    if (seenTri.has(key)) continue; // 合併後重複面
    seenTri.add(key);
    newIdx.push(a, b, c);
  }
  return { positions: newPos, indices: Uint32Array.from(newIdx) };
}

/** 按面積保留最大的一批三角形（最後防線）。 */
function areaCap(positions: Float32Array, indices: Uint32Array, maxTris: number): ClusterResult {
  const triCount = indices.length / 3;
  if (triCount <= maxTris) return { positions, indices };
  const areas = new Float32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const ia = indices[t * 3] * 3;
    const ib = indices[t * 3 + 1] * 3;
    const ic = indices[t * 3 + 2] * 3;
    const ax = positions[ib] - positions[ia];
    const ay = positions[ib + 1] - positions[ia + 1];
    const az = positions[ib + 2] - positions[ia + 2];
    const bx = positions[ic] - positions[ia];
    const by = positions[ic + 1] - positions[ia + 1];
    const bz = positions[ic + 2] - positions[ia + 2];
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    areas[t] = cx * cx + cy * cy + cz * cz;
  }
  const order = Array.from({ length: triCount }, (_, i) => i).sort((a, b) => areas[b] - areas[a]);
  const kept = new Set<number>(order.slice(0, maxTris));
  const newIdx: number[] = [];
  for (let t = 0; t < triCount; t++) {
    if (!kept.has(t)) continue;
    newIdx.push(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
  }
  return { positions, indices: Uint32Array.from(newIdx) };
}

const _c = new THREE.Color();

/** 低飽和建築色票（混凝土／米灰／淡藍灰／磚紅灰…） */
const WALL_TONES = [0xb6b2a6, 0xa49f93, 0xc9c3b3, 0x9aa0a2, 0xadb6bb, 0xc7b9a1, 0xa89a8c, 0x8f9597, 0xb8b0a0];
const WINDOW_TONES = [0x2c414c, 0x334c58, 0x273c46, 0x3b5560, 0x30424a];
const LIT_TONES = [0xffd089, 0xffe0a8, 0xffc06a, 0xfff0c8];
const ROOF_TONES = [0x6e6f6b, 0x7a7b74, 0x63645f, 0x8a8b83];

interface FaceStyleContext {
  id: number;
  heightM: number;
  wallTones: number[];
  roofTones: number[];
  estFloors: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
  spanX: number;
  spanZ: number;
}

/**
 * 由 decimated geometry 建非索引 BufferGeometry：flat normals + vertex colors。
 *
 * vertex colors 只負責「牆身色調／天台／樓層明暗」；窗帶圖案交由材質 shader
 * 用 local 座標程序化繪製（見 `getLandmarkMaterial`），所以就算 CSDI 模型面數
 * 好低（大三角形跨越好多層）都仍然有整齊嘅橫向窗帶＋夜間亮窗。
 *
 * 每個頂點額外加：
 *  - `aFloorH`：一層樓嘅 local 高度（由 heightM 推算）
 *  - `aWinSeed`：每棟樓固定 random seed（決定邊啲窗夜間亮）
 */
function buildShadedGeometry(
  ctx: FaceStyleContext,
  positions: Float32Array,
  indices: Uint32Array,
): THREE.BufferGeometry {
  const triCount = indices.length / 3;
  const pos = new Float32Array(triCount * 9);
  const colors = new Float32Array(triCount * 9);
  const floorScale = new Float32Array(triCount * 3);
  const winSeed = new Float32Array(triCount * 3);
  const floorH = Math.max(0.008, ctx.height / ctx.estFloors);
  const seed = hash01(ctx.id * 3.173 + ctx.height * 0.71);

  for (let t = 0; t < triCount; t++) {
    const ia = indices[t * 3] * 3;
    const ib = indices[t * 3 + 1] * 3;
    const ic = indices[t * 3 + 2] * 3;
    const ax = positions[ia];
    const ay = positions[ia + 1];
    const az = positions[ia + 2];
    const bx = positions[ib];
    const by = positions[ib + 1];
    const bz = positions[ib + 2];
    const cx = positions[ic];
    const cy = positions[ic + 1];
    const cz = positions[ic + 2];
    // face normal
    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    nx /= nlen;
    ny /= nlen;
    nz /= nlen;
    const my = (ay + by + cy) / 3;
    const h01 = Math.max(0, Math.min(1, my / Math.max(0.01, ctx.height)));

    const isRoof = ny > 0.55;
    let colorHex: number;
    if (isRoof) {
      colorHex = ctx.roofTones[Math.floor(hash01(ctx.id * 13.7 + t * 0.37) * ctx.roofTones.length) % ctx.roofTones.length];
    } else {
      const vertical = Math.abs(ny) < 0.6;
      const tone = ctx.wallTones[Math.floor(hash01(ctx.id * 9.1 + t * 1.37) * ctx.wallTones.length) % ctx.wallTones.length];
      if (!vertical) {
        // 斜面／裝飾面用較深色
        _c.setHex(tone).multiplyScalar(0.86);
        colorHex = _c.getHex();
      } else {
        // 越高越光；低座（podium）稍暗，做出香港樓宇上淺下深嘅感覺
        const light = 0.82 + h01 * 0.26;
        _c.setHex(tone).multiplyScalar(light);
        colorHex = _c.getHex();
      }
    }
    if (colorHex === 0) colorHex = 0x9a958b;
    _c.setHex(colorHex);
    const r = _c.r;
    const g = _c.g;
    const b = _c.b;
    const o = t * 9;
    pos[o] = ax; pos[o + 1] = ay; pos[o + 2] = az;
    pos[o + 3] = bx; pos[o + 4] = by; pos[o + 5] = bz;
    pos[o + 6] = cx; pos[o + 7] = cy; pos[o + 8] = cz;
    for (let k = 0; k < 3; k++) {
      colors[o + k * 3] = r;
      colors[o + k * 3 + 1] = g;
      colors[o + k * 3 + 2] = b;
      floorScale[t * 3 + k] = floorH;
      winSeed[t * 3 + k] = seed;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aFloorH', new THREE.BufferAttribute(floorScale, 1));
  geometry.setAttribute('aWinSeed', new THREE.BufferAttribute(winSeed, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

/** 建立並快取一個 landmark 的 geometry。 */
function buildLandmarkGeometry(model: LandmarkData): BuiltLandmark | null {
  const rawPos = readVerts(model.verts as number[]);
  if (!rawPos) return null;
  const rawIdx = readIndices(model.tris as number[], rawPos.length / 3);
  if (!rawIdx || rawIdx.length < MIN_TRIS * 3) return null;
  if (rawIdx.length / 3 > MAX_SOURCE_TRIS) return null; // 異常資料 → 交由 prototype fallback

  // bbox（原始）
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < rawPos.length; i += 3) {
    const x = rawPos[i], y = rawPos[i + 1], z = rawPos[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const rawHeight = Math.max(0.05, maxY - minY);
  const footprintW = Math.max(0.2, maxX - minX);
  const footprintD = Math.max(0.2, maxZ - minZ);

  // 平移：base y=0、水平置中（generated data 本身應該係咁，做一次保險）
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const shifted = new Float32Array(rawPos.length);
  for (let i = 0; i < rawPos.length; i += 3) {
    shifted[i] = rawPos[i] - cx;
    shifted[i + 1] = rawPos[i + 1] - minY;
    shifted[i + 2] = rawPos[i + 2] - cz;
  }
  minX -= cx; maxX -= cx; minZ -= cz; maxZ -= cz;

  const sourceTris = rawIdx.length / 3;

  // Decimation：逐步加大聚類 cell 直至 ≤ MAX_LANDMARK_TRIS
  let positions: Float32Array = shifted;
  let indices: Uint32Array = rawIdx;
  if (sourceTris > MAX_LANDMARK_TRIS) {
    const cells = [0.035, 0.06, 0.1, 0.16, 0.24, 0.36, 0.55, 0.8, 1.2];
    for (const cell of cells) {
      const r = clusterDecimate(positions, indices, cell);
      if (r.indices.length === 0) continue;
      positions = r.positions;
      indices = r.indices;
      if (indices.length / 3 <= MAX_LANDMARK_TRIS) break;
    }
    if (indices.length / 3 > MAX_LANDMARK_TRIS) {
      const r = areaCap(positions, indices, MAX_LANDMARK_TRIS);
      positions = r.positions;
      indices = r.indices;
    }
  }
  const tris = indices.length / 3;
  if (tris < MIN_TRIS) return null;

  // 重新計 bbox（decimated）
  const height = rawHeight;
  let dMinX = Infinity, dMaxX = -Infinity, dMinZ = Infinity, dMaxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const z = positions[i + 2];
    if (x < dMinX) dMinX = x;
    if (x > dMaxX) dMaxX = x;
    if (z < dMinZ) dMinZ = z;
    if (z > dMaxZ) dMaxZ = z;
  }
  const spanX = Math.max(0.2, dMaxX - dMinX);
  const spanZ = Math.max(0.2, dMaxZ - dMinZ);

  // 顏色／樓層參數：用 heightM 推樓層數（1 unit ≈ 56m，樓層 3.2m）
  const worldHeight = height;
  const meters = model.heightM && model.heightM > 5 ? model.heightM : worldHeight * 56;
  // 視覺樓層：真實 3.2m/層會令 6 units 高嘅塔有 100 層窗，遠景變摩爾紋；
  // 用 stylised ~10m/層（5–36 層），保持可辨識窗帶又不失真太多。
  const estFloors = Math.max(5, Math.min(36, Math.round(meters / 10)));
  const id = model.id ?? 0;
  const wallTones = WALL_TONES;
  const windowTones = WINDOW_TONES;
  const litTones = LIT_TONES;
  const roofTones = ROOF_TONES;

  const ctx: FaceStyleContext = {
    id,
    heightM: meters,
    wallTones,
    roofTones,
    estFloors,
    minX: dMinX,
    maxX: dMaxX,
    minZ: dMinZ,
    maxZ: dMaxZ,
    height: Math.max(0.05, worldHeight),
    spanX,
    spanZ,
  };
  const geometry = buildShadedGeometry(ctx, positions, indices);
  return { geometry, height: worldHeight, tris, sourceTris, footprintW, footprintD };
}

// ─────────────────────────── 材質（日／夜窗光） ───────────────────────────

const nightUniform = { value: 0 };
let landmarkMaterial: THREE.MeshLambertMaterial | null = null;

function getLandmarkMaterial(): THREE.MeshLambertMaterial {
  if (landmarkMaterial) return landmarkMaterial;
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  mat.name = 'hk3d-landmark';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = nightUniform;
    // ── vertex：傳 local position / local normal / 樓層高 / seed ──
    shader.vertexShader =
      'attribute float aFloorH;\nattribute float aWinSeed;\n' +
      'varying vec3 vLocalPos;\nvarying vec3 vLocalNormal;\nvarying float vFloorH;\nvarying float vWinSeed;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vLocalPos = transformed;\n  vLocalNormal = normal;\n  vFloorH = aFloorH;\n  vWinSeed = aWinSeed;',
      );
    // ── fragment：按 local 座標畫橫向窗帶（唔受三角剖分影響）＋夜間亮窗 ──
    shader.fragmentShader =
      'varying vec3 vLocalPos;\nvarying vec3 vLocalNormal;\nvarying float vFloorH;\nvarying float vWinSeed;\nuniform float uNight;\n' +
      shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  // 真實 CSDI 樓宇窗帶（程序化；用 local 座標，任何三角剖分都保持橫向）
  vec3 LN = normalize(vLocalNormal);
  float vert = 1.0 - smoothstep(0.42, 0.68, abs(LN.y));
  float floorH = max(vFloorH, 0.006);
  float fy = vLocalPos.y / floorH;
  float ff = fract(fy);
  float band = smoothstep(0.26, 0.33, ff) * (1.0 - smoothstep(0.71, 0.78, ff)) * vert;
  vec3 AN = abs(LN);
  float u = (AN.x > AN.z ? vLocalPos.z : vLocalPos.x) / floorH * 1.35;
  float cf = fract(u);
  float colMask = smoothstep(0.22, 0.30, cf) * (1.0 - smoothstep(0.68, 0.78, cf));
  float groundFloor = 1.0 - step(1.35, fy);          // 地下舖位
  // 畫面像素細過窗紋時淡出（避免遠處摩爾紋；fwidth 係 WebGL2 內建）
  float aaScale = max(fwidth(fy), fwidth(u));
  float aa = 1.0 - smoothstep(0.22, 0.62, aaScale);
  float winMask = band * colMask * (1.0 - groundFloor) * step(0.5, fy) * aa;
  // 窗玻璃色（低飽和深藍綠）；天台／牆身保留 vertex colors
  vec3 glass = mix(vec3(0.112, 0.16, 0.185), vec3(0.15, 0.205, 0.23), fract(vWinSeed * 7.13 + floor(fy) * 0.37));
  float windowMix = clamp(winMask, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, glass, windowMix);
  // 樓層線／窗台：每層底加一條深色橫線（遠景同樣淡出）
  float lineMask = smoothstep(0.12, 0.0, min(ff, 1.0 - ff)) * vert * aa;
  diffuseColor.rgb *= (1.0 - 0.18 * lineMask);
  // 地下舖位：日間深色玻璃、夜間暖光
  float shopMask = vert * groundFloor * step(0.25, fract(u * 0.62)) * aa;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.10, 0.13, 0.15), shopMask * 0.6);`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
  // 夜間窗光：部分窗戶亮燈（deterministic per floor/column），地下舖位暖光
  float litHash = fract(sin(floor(fy) * 12.9898 + floor(u) * 78.233 + vWinSeed * 37.719) * 43758.5453);
  float lit = winMask * step(litHash, 0.16);
  totalEmissiveRadiance += vec3(1.0, 0.80, 0.52) * lit * uNight * 1.35;
  totalEmissiveRadiance += vec3(1.0, 0.86, 0.60) * shopMask * uNight * 0.55;`,
        );
  };
  mat.customProgramCacheKey = () => 'hk3d-landmark-lambert-v3';
  landmarkMaterial = mat;
  return mat;
}

// ─────────────────────────── 快取／對外 API ───────────────────────────

const builtCache = new Map<number, BuiltLandmark | null>();
let retainCount = 0;
let disposed = false;

function ensureNotDisposed(): void {
  if (!disposed) return;
  disposed = false;
  builtCache.clear();
}

function modelById(id: number): LandmarkData | null {
  for (const m of models) if (m.id === id) return m;
  // 部分 generated 可能無 id 或有 gap：fallback 用 array index
  return id >= 0 && id < models.length ? models[id] : null;
}

function getBuilt(id: number): BuiltLandmark | null {
  ensureNotDisposed();
  const cached = builtCache.get(id);
  if (cached !== undefined) return cached;
  const model = modelById(id);
  let built: BuiltLandmark | null = null;
  if (model) {
    try {
      built = buildLandmarkGeometry(model);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[hk-3d-landmarks] 模型 #${id} 建立失敗，fallback prototype。`, err);
      built = null;
    }
  }
  builtCache.set(id, built);
  return built;
}

export interface Hk3dLandmarkMesh {
  mesh: THREE.Mesh;
  /** 模型世界高度（LOD box 用） */
  height: number;
  tris: number;
  footprintW: number;
  footprintD: number;
}

/**
 * 建立（或由快取取）一個 landmark mesh。
 * 同一 id 的 geometry／material 共用；每個建築實例各自一個 mesh。
 * 回傳 null 表示該 model3d index 無效 → caller 用現有 prototype fallback。
 */
export function createHk3dLandmarkMesh(id: number): Hk3dLandmarkMesh | null {
  const built = getBuilt(id);
  if (!built) return null;
  const mesh = new THREE.Mesh(built.geometry, getLandmarkMaterial());
  mesh.name = `hk3d-landmark-${id}`;
  mesh.userData.hk3dLandmark = id;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  return {
    mesh,
    height: built.height,
    tris: built.tris,
    footprintW: built.footprintW,
    footprintD: built.footprintD,
  };
}

/** 該 id 有無可用真實模型（無效 index 時 caller 用 prototype fallback）。 */
export function hk3dLandmarkAvailable(id: number): boolean {
  return getBuilt(id) != null;
}

/** 資料來源：'generated'（Lead 真實 CSDI 資料）／'fake'（內建測試模型）／'none'。 */
export function hk3dLandmarkSource(): 'generated' | 'fake' | 'none' {
  if (dataSource === 'none') return 'none';
  return dataSource;
}

/** 目前載入的模型數。 */
export function hk3dLandmarkModelCount(): number {
  return models.length;
}

/** 除錯／回報用統計。 */
export function hk3dLandmarkStats(): {
  source: 'generated' | 'fake' | 'none';
  models: number;
  built: number;
  failed: number;
  totalTris: number;
  maxTris: number;
  avgTris: number;
  capped: number;
} {
  let built = 0;
  let failed = 0;
  let totalTris = 0;
  let maxTris = 0;
  let capped = 0;
  for (const [id, b] of builtCache) {
    if (!b) {
      failed++;
      continue;
    }
    built++;
    totalTris += b.tris;
    if (b.tris > maxTris) maxTris = b.tris;
    if (b.sourceTris > b.tris) capped++;
    void id;
  }
  return {
    source: hk3dLandmarkSource(),
    models: models.length,
    built,
    failed,
    totalTris,
    maxTris,
    avgTris: built > 0 ? Math.round(totalTris / built) : 0,
    capped,
  };
}

/** 日／夜：更新共用 shader uniform（只係一個 float，零 draw call 成本）。 */
export function setHk3dNightMode(night: boolean): void {
  nightUniform.value = night ? 1 : 0;
}

/** 目前是否夜間（除錯用）。 */
export function hk3dLandmarkIsNight(): boolean {
  return nightUniform.value > 0.5;
}

/** BuildingsView 建立時 retain；最後一個 view dispose 時 release 並釋放幾何快取。 */
export function retainHk3dLandmarks(): void {
  retainCount++;
  disposed = false;
}

/** BuildingsView dispose 時呼叫；refcount 到 0 先釋放快取。 */
export function releaseHk3dLandmarks(): void {
  retainCount = Math.max(0, retainCount - 1);
  if (retainCount > 0) return;
  for (const b of builtCache.values()) {
    if (b) b.geometry.dispose();
  }
  builtCache.clear();
  if (landmarkMaterial) {
    landmarkMaterial.dispose();
    landmarkMaterial = null;
  }
  disposed = true;
}

/** 測試／手動注入資料（例如未生成檔案前由外部提供）。 */
export function registerHk3dLandmarks(list: readonly Landmark3DModel[], source: 'generated' | 'fake' = 'generated'): void {
  if (!Array.isArray(list) || list.length === 0) return;
  models = list;
  dataSource = source;
  for (const b of builtCache.values()) if (b) b.geometry.dispose();
  builtCache.clear();
  disposed = false;
}
