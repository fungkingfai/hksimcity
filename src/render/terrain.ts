/**
 * 香港地形渲染（低多邊形 + 程序化貼圖 + InstancedMesh）。
 *
 * 分層：
 *  1. 地基（土坡側面）＋ 地表（逐格顏色）：草地／市區地／填海地／農地／濕地／林地／
 *     丘陵／山地／沙灘／水域；季節轉色、冬季山頂積雪。
 *  2. 斷崖／海崖：相鄰地塊高差處自動生成岩壁（山地、海岸、填海邊緣）。
 *  3. 維港水面：合併幾何 + 自訂 ShaderMaterial（波紋、日光／月光／霓虹倒影、
 *     雨漣漪、颱風大浪、岸邊白沫），六種天氣與日夜同步。
 *  4. 植被／道具：榕樹、洋紫荊、棕櫚、松樹、竹、灌木、草叢、蘆葦、岩石、山岩；
 *     米埔濕地水窪與紅樹林；農地菜田；貨櫃碼頭貨櫃堆。
 *  5. 市區遠景樓群：中環／尖沙咀／觀塘天際線、各區住宅樓、夜間窗光（發光貼圖）。
 *  6. 地標與交通點綴：天星小輪、紅帆漁船、貨輪、避風塘漁船、山頂凌霄閣、
 *     天壇大佛、中環摩天輪、尖沙咀鐘樓、會展、青馬大橋、赤鱲角機場跑道與飛機。
 *  7. 外海與遠島剪影：令地圖邊緣不至於懸空。
 *
 * 效能：全部道具共用幾何／材質並以 InstancedMesh 繪製（約 45 draw call），
 * 每幀只更新 shader uniform／光影材質；季節、積雪、佔用（道路與建築）變更時
 * 才重寫實例顏色或矩陣。所有可被玩家建築／道路覆蓋的裝飾會自動隱藏。
 */

import { isShenzhenSideTile } from '../world/border';
import * as THREE from 'three';
import { hash2d } from '../core/rng';
import type { GameState, Season, TerrainType, Tile, Weather } from '../core/types';
import { HK_LANDMARKS, HK_REGIONS } from '../world/worldgen';
import { TILE, tileWorld } from './coords';
import { createAirportTrafficView, type AirportTrafficView } from './airport-traffic';
import {
  addInstancePhase,
  addSwayAttribute,
  createAirplaneGeometry,
  createBanyanGeometry,
  createBauhiniaGeometry,
  createBoatGeometry,
  createBridgeGeometry,
  createBroadleafGeometry,
  createBuddhaGeometry,
  createCargoShipGeometry,
  createClockTowerGeometry,
  createContainerGeometry,
  createConventionGeometry,
  createCragGeometry,
  createFacadeTexture,
  createFerrisWheelGeometry,
  createFishingBoatGeometry,
  createFlowerGeometry,
  createGrassTuftGeometry,
  createGroundSpeckleTexture,
  createJunkBoatGeometry,
  createMountainSilhouetteGeometry,
  createPalmGeometry,
  createPeakTowerGeometry,
  createPebblesGeometry,
  createPineGeometry,
  createReedGeometry,
  createRockGeometry,
  createShrubGeometry,
  createStarFerryGeometry,
  createWillowGeometry,
  createWindMaterial,
  createMetalRailingGeometry,
  mergePlainGeometries,
  type WindMaterial,
} from './world-geometry';
import {
  computeMoonDir,
  computeSun,
  createSeasonColors,
  createSkyPalette,
  createSunState,
  fogRange,
  mountainSnowAmount,
  sampleSkyPalette,
  seasonColors,
  snowCover,
  tileTopY,
  WATER_SURFACE_Y,
  windStrength,
  type SeasonColors,
  type SunState,
  mapViewScale,
} from './world-utils';

export interface TerrainView {
  group: THREE.Group;
  update(state: GameState, dt: number): void;
  dispose(): void;
}

// ─────────────────────────── 小工具 ───────────────────────────

const WHITE = new THREE.Color(0xffffff);
const SNOW_TINT = new THREE.Color(1.55, 1.6, 1.68);
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _sunDir = new THREE.Vector3();
const _moonDir = new THREE.Vector3();

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function hash(x: number, y: number, salt: number): number {
  return hash2d(x, y, salt);
}

/** 單一實例的擺放資料 */
interface Placement {
  tile: number;
  x: number;
  y: number;
  z: number;
  rot: number;
  sx: number;
  sy: number;
  sz: number;
  hash: number;
  tint?: number;
}

function place(
  tile: number,
  x: number,
  y: number,
  z: number,
  rot: number,
  s: number,
  hashValue: number,
  sy = s,
): Placement {
  return { tile, x, y, z, rot, sx: s, sy, sz: s, hash: hashValue };
}

type TintKind =
  | 'banyan'
  | 'broadleaf'
  | 'bauhinia'
  | 'palm'
  | 'pine'
  | 'willow'
  | 'shrub'
  | 'grass'
  | 'flower'
  | 'reed'
  | 'rock'
  | 'crag'
  | 'distant'
  | 'container'
  | 'crop';

interface TintableLayer {
  mesh: THREE.InstancedMesh;
  list: Placement[];
  kind: TintKind;
  occupancy: boolean;
  matrixBase: Float32Array | null;
}

interface BuildingLayer {
  kind: 'tower' | 'block' | 'office';
  mesh: THREE.InstancedMesh;
  list: { tile: number; x: number; y: number; z: number; h: number; w: number; rot: number; shade: number }[];
  matrixBase: Float32Array;
}

// ─────────────────────────── 水色 ───────────────────────────

const WATER_DEEP: Record<Season, number> = {
  spring: 0x1f5c70,
  summer: 0x1b5568,
  autumn: 0x225a6a,
  winter: 0x2c6070,
};
const WATER_SHALLOW: Record<Season, number> = {
  spring: 0x4fa79c,
  summer: 0x54ad9f,
  autumn: 0x5fa89b,
  winter: 0x74b0b2,
};

// ─────────────────────────── 主體 ───────────────────────────

export function createTerrainView(state: GameState): TerrainView {
  const group = new THREE.Group();
  group.name = 'terrain';

  const { width, height } = state;
  const count = state.tiles.length;
  const seed = state.seed >>> 0;
  /** 設計座標 (96×96) → 世界座標 */
  const kx = width / 96;
  const ky = height / 96;
  /**
   * 裝飾密度歸一：480² 面積係 96² 的 25 倍。真實香港地圖郊野仍然要夠樹，
   * 所以目標係「96 地圖的 3 倍」左右（比 1/(kx*ky) 稍密，但唔會 ×25 爆 tris）。
   */
  const deco = Math.min(1, 3 / (kx * ky));
  /** 只有「已有城鎮」模式才顯示市區遠景假樓群；empty 由零開始保留完全空地。 */
  const showcaseCity = state.gameMode === 'starter';
  const designToWorld = (dx: number, dy: number): { x: number; z: number } => ({
    x: (dx * kx + 0.5) * TILE - (width * TILE) / 2,
    z: (dy * ky + 0.5) * TILE - (height * TILE) / 2,
  });

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  // ───────────── 0. 前置：季節色、水深、臨水、地表高度 ─────────────

  const seasonC: SeasonColors = createSeasonColors();
  let paletteSeason: Season = state.clock.season;
  seasonColors(paletteSeason, seasonC);
  let appliedSnow = -1;

  const waterDepth = new Uint8Array(count);
  const waterNear = new Uint8Array(count);
  const isWaterArr = new Uint8Array(count);
  for (let i = 0; i < count; i++) if (state.tiles[i].terrain === 'water') isWaterArr[i] = 1;
  {
    const queue: number[] = [];
    for (let i = 0; i < count; i++) {
      if (isWaterArr[i]) continue;
      const x = i % width;
      const y = (i - x) / width;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (isWaterArr[ny * width + nx]) {
            near = true;
            break;
          }
        }
      }
      if (near) waterNear[i] = 1;
    }
    // 水深：由岸邊向水域內 BFS（深水 1..4）
    for (let i = 0; i < count; i++) {
      if (!isWaterArr[i]) continue;
      const x = i % width;
      const y = (i - x) / width;
      let shore = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      for (let dy = -1; dy <= 1 && !shore; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (!isWaterArr[ny * width + nx]) {
            shore = true;
            break;
          }
        }
      }
      if (shore) {
        waterDepth[i] = 1;
        queue.push(i);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      const d = waterDepth[i];
      // 注意：水深 clamp 到 4，但唔可以喺 d>=4 時停止擴散，否則大片深海會永遠
      // 停留 depth=0（被當成淺水/近岸），令深海渲染錯誤＋水面 tris 暴增。
      const nd = Math.min(4, d + 1);
      const x = i % width;
      const y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (!isWaterArr[ni] || waterDepth[ni] !== 0) continue;
          waterDepth[ni] = nd;
          queue.push(ni);
        }
      }
    }
  }

  // 渲染用水深（3×3 平滑）：避免相鄰格 aDeep 差異造成水面「格仔紋」。
  const renderDeep = new Float32Array(count);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!isWaterArr[i]) continue;
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (!isWaterArr[ni]) continue;
          sum += Math.min(4, waterDepth[ni]);
          n++;
        }
      }
      renderDeep[i] = clamp01((sum / Math.max(1, n)) / 3);
    }
  }

  const topY = new Float32Array(count);
  for (let i = 0; i < count; i++) topY[i] = tileTopY(state.tiles[i]);

  const isWater = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= width || y >= height ? false : state.tiles[y * width + x].terrain === 'water';
  const isLand = (x: number, y: number): boolean => !isWater(x, y);

  // ───────────── 1. 地基與地表 ─────────────

  const groundTexture = createGroundSpeckleTexture();
  if (groundTexture) track(groundTexture);

  // 精簡：水面格完全隱藏（水面不透明），平地內陸格沒有可見側面亦不畫地基，
  // 大幅減少三角形與頂點處理成本。
  const topIndex = new Int32Array(count).fill(-1);
  const foundationIndex = new Int32Array(count).fill(-1);
  let topCount = 0;
  let foundationCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!isWaterArr[i]) topIndex[i] = topCount++;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (isWaterArr[i]) continue;
      const myTop = topY[i];
      let needs = false;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dz;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          needs = true;
          break;
        }
        const ni = ny * width + nx;
        if (isWaterArr[ni] || topY[ni] < myTop - 0.045) {
          needs = true;
          break;
        }
      }
      if (needs) foundationIndex[i] = foundationCount++;
    }
  }

  const foundationGeo = (() => {
    // 只保留四面側牆（8 tris）；框體頂／底永遠被地表遮住。304 大地圖地基實例多，
    // 減少三角形對 tris 預算有明顯幫助。
    const box = new THREE.BoxGeometry(TILE * 0.995, 1, TILE * 0.995);
    const nonIndexed = box.toNonIndexed();
    box.dispose();
    const srcPos = nonIndexed.getAttribute('position') as THREE.BufferAttribute;
    const srcNor = nonIndexed.getAttribute('normal') as THREE.BufferAttribute;
    const keep: number[] = [];
    for (let t = 0; t < srcPos.count / 3; t++) {
      const ny = srcNor.getY(t * 3);
      if (Math.abs(ny) > 0.5) continue; // 跳過頂／底面
      for (let k = 0; k < 3; k++) keep.push(t * 3 + k);
    }
    const pos = new Float32Array(keep.length * 3);
    const nor = new Float32Array(keep.length * 3);
    keep.forEach((vi, k) => {
      pos[k * 3] = srcPos.getX(vi);
      pos[k * 3 + 1] = srcPos.getY(vi) + 0.5;
      pos[k * 3 + 2] = srcPos.getZ(vi);
      nor[k * 3] = srcNor.getX(vi);
      nor[k * 3 + 1] = srcNor.getY(vi);
      nor[k * 3 + 2] = srcNor.getZ(vi);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    nonIndexed.dispose();
    return geo;
  })();
  const foundationMat = track(new THREE.MeshLambertMaterial({ color: 0xffffff }));
  const foundationMesh = new THREE.InstancedMesh(foundationGeo, foundationMat, Math.max(1, foundationCount));
  foundationMesh.count = foundationCount;
  foundationMesh.name = 'terrain-foundation';
  foundationMesh.receiveShadow = true;
  foundationMesh.frustumCulled = false;
  track(foundationMesh);
  group.add(foundationMesh);

  const topGeo = track(new THREE.PlaneGeometry(TILE * 1.001, TILE * 1.001));
  topGeo.rotateX(-Math.PI / 2);
  const topMat = track(new THREE.MeshLambertMaterial({ color: 0xffffff, map: groundTexture ?? undefined }));
  const topMesh = new THREE.InstancedMesh(topGeo, topMat, Math.max(1, topCount));
  topMesh.count = topCount;
  topMesh.name = 'terrain-top';
  topMesh.receiveShadow = true;
  topMesh.frustumCulled = false;
  track(topMesh);
  group.add(topMesh);

  // ───────────── 2. 斷崖／海崖 ─────────────

  const cliffGeo = (() => {
    // 薄牆（2 tris）：沿 z 方向、高 1，instance 靠 sx/sy/sz 縮放。
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateY(Math.PI / 2); // 平面法線朝 +x，闊度沿 z
    g.translate(0, 0.5, 0);
    return g;
  })();
  track(cliffGeo);
  const cliffMat = track(new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  const cliffPlacements: Placement[] = [];
  const dirs: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const tile = state.tiles[i];
      const myTop = topY[i];
      const { x: wx, z: wz } = tileWorld(x, y, width, height);
      for (const [dx, dz] of dirs) {
        const nx = x + dx;
        const ny = y + dz;
        const oob = nx < 0 || ny < 0 || nx >= width || ny >= height;
        const neighborTop = oob ? -0.4 : topY[ny * width + nx];
        const neighborWater = oob ? false : state.tiles[ny * width + nx].terrain === 'water';
        const minTop = neighborWater ? WATER_SURFACE_Y - 0.07 : neighborTop;
        const diff = myTop - minTop;
        if (diff < 0.045) continue;
        if (neighborWater && diff < 0.3) continue; // 平坦海岸交由地基側面收邊

        const alongX = dz === 0;
        const wallTint = neighborWater
          ? tile.terrain === 'sand'
            ? 0xa89364
            : tile.terrain === 'mountain'
              ? 0x726c62
              : 0x77736a
          : tile.terrain === 'mountain'
            ? 0x77726a
            : tile.terrain === 'hill'
              ? 0x847450
              : tile.terrain === 'urban' || tile.terrain === 'reclaimed'
                ? 0x77746e
                : tile.terrain === 'sand'
                  ? 0xa89364
                  : 0x6b5b3e;
        cliffPlacements.push({
          tile: i,
          x: wx + dx * (TILE / 2 - 0.02),
          y: minTop,
          z: wz + dz * (TILE / 2 - 0.02),
          rot: alongX ? Math.PI / 2 : 0,
          sx: 0.2,
          sy: diff + 0.02,
          sz: TILE,
          hash: hash(x, y, seed + 411 + (dx + 2) * 7 + (dz + 2) * 13),
          tint: wallTint,
        });
      }
    }
  }
  const cliffMesh = new THREE.InstancedMesh(cliffGeo, cliffMat, Math.max(1, cliffPlacements.length));
  cliffMesh.name = 'terrain-cliffs';
  cliffMesh.receiveShadow = true;
  cliffMesh.frustumCulled = false;
  cliffMesh.count = cliffPlacements.length;
  cliffMesh.visible = cliffPlacements.length > 0;
  track(cliffMesh);
  group.add(cliffMesh);
  {
    const dummy = new THREE.Object3D();
    const c = new THREE.Color();
    cliffPlacements.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.set(p.sx, p.sy, p.sz);
      dummy.updateMatrix();
      cliffMesh.setMatrixAt(i, dummy.matrix);
      c.setHex(p.tint ?? 0x6e6252).multiplyScalar(0.82 + p.hash * 0.16);
      cliffMesh.setColorAt(i, c);
    });
    cliffMesh.instanceMatrix.needsUpdate = true;
    if (cliffMesh.instanceColor) cliffMesh.instanceColor.needsUpdate = true;
  }

  // ───────────── 3. 水面 ─────────────

  const waterPositions: number[] = [];
  const waterDeepAttr: number[] = [];
  const waterFlatAttr: number[] = [];
  const waterIndices: number[] = [];
  const waterTiles: number[] = [];
  const WATER_SUB = width * height > 96 * 96 * 3 ? 1 : 2;
  const depthAt = (tx: number, ty: number): number => {
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return 0;
    const ti = ty * width + tx;
    return isWaterArr[ti] ? clamp01(waterDepth[ti] / 3) : 0;
  };
  const deepAtCenter = (tx: number, ty: number): number => {
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return 0;
    const ti = ty * width + tx;
    return isWaterArr[ti] ? renderDeep[ti] : 0;
  };
  // fx/fy 為 tile 座標（浮點）；以 tile 中心雙線性 interpolate，令水面顏色平滑過渡。
  const sampleDepth = (fx: number, fy: number): number => {
    const cx = fx - 0.5;
    const cy = fy - 0.5;
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const u = clamp01(cx - x0);
    const v = clamp01(cy - y0);
    const d00 = deepAtCenter(x0, y0);
    const d10 = deepAtCenter(x0 + 1, y0);
    const d01 = deepAtCenter(x0, y0 + 1);
    const d11 = deepAtCenter(x0 + 1, y0 + 1);
    return clamp01((d00 * (1 - u) + d10 * u) * (1 - v) + (d01 * (1 - u) + d11 * u) * v);
  };
  // 600 地圖水面：近岸（水深 < 3）逐格細分；深海按「每行連續水面」合併成長 quad，
  // 大幅減少水面頂點／三角形（542k → ~30k tris），減低軟件 WebGL 記憶體同頂點負荷。
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const i = y * width + x;
      if (!isWaterArr[i]) {
        x++;
        continue;
      }
      const depth = waterDepth[i];
      if (depth < 3) {
        // 近岸：逐格（WATER_SUB=1 → 2 tris）
        waterTiles.push(i);
        const { x: wx, z: wz } = tileWorld(x, y, width, height);
        const base = waterPositions.length / 3;
        for (let gy = 0; gy <= WATER_SUB; gy++) {
          for (let gx = 0; gx <= WATER_SUB; gx++) {
            waterPositions.push(
              wx - TILE / 2 + (gx / WATER_SUB) * TILE,
              WATER_SURFACE_Y,
              wz - TILE / 2 + (gy / WATER_SUB) * TILE,
            );
            waterDeepAttr.push(sampleDepth(x + gx / WATER_SUB, y + gy / WATER_SUB));
            waterFlatAttr.push(0);
          }
        }
        const row = WATER_SUB + 1;
        for (let gy = 0; gy < WATER_SUB; gy++) {
          for (let gx = 0; gx < WATER_SUB; gx++) {
            const a = base + gy * row + gx;
            const b = a + 1;
            const c = a + row;
            const d = c + 1;
            waterIndices.push(a, c, b, b, c, d);
          }
        }
        x++;
        continue;
      }
      // 深海（depth>=3）：唔建 geometry，交由下面單一大平面（避免巨大三角形造成
      // overview 摩爾紋／放射條紋），同時大幅減 tris。
      waterTiles.push(i);
      x++;
    }
  }

  const waterGeo = track(new THREE.BufferGeometry());
  waterGeo.setAttribute('position', new THREE.Float32BufferAttribute(waterPositions, 3));
  waterGeo.setAttribute('aDeep', new THREE.Float32BufferAttribute(waterDeepAttr, 1));
  waterGeo.setAttribute('aOuter', new THREE.Float32BufferAttribute(waterFlatAttr, 1));
  waterGeo.setIndex(waterIndices);
  waterGeo.computeBoundingSphere();

  const waterUniforms = {
    uTime: { value: 0 },
    uWave: { value: 0.02 },
    uDetailScale: { value: 1 },
    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
    uSunColor: { value: new THREE.Color(0xfff0cf) },
    uSkyColor: { value: new THREE.Color(0x9ec8e8) },
    uHorizonColor: { value: new THREE.Color(0xd6e6dc) },
    uDeepColor: { value: new THREE.Color(WATER_DEEP.spring) },
    uShallowColor: { value: new THREE.Color(WATER_SHALLOW.spring) },
    uDaylight: { value: 1 },
    uIce: { value: 0 },
    uRain: { value: 0 },
    uStorm: { value: 0 },
    uCityGlow: { value: 0 },
    uNeon: { value: new THREE.Color(0xff8a4a) },
    uFogColor: { value: new THREE.Color(0xc8dce8) },
    uFogNear: { value: 90 },
    uFogFar: { value: 340 },
  };

  const waterMat = track(
    new THREE.ShaderMaterial({
      uniforms: waterUniforms,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uWave;
        uniform float uDetailScale;
        uniform float uStorm;
        attribute float aDeep;
        attribute float aOuter;
        varying float vDeep;
        varying vec3 vWorldPos;
        varying vec3 vNormalW;
        void main() {
          vec3 p = position;
          float t = uTime;
          // 遠景淡出波形：overview 時避免大量小 quad 的波形產生摩爾紋／放射條紋
          float camDist = length(cameraPosition - (modelMatrix * vec4(p, 1.0)).xyz);
          float waveK = (1.0 - smoothstep(90.0, 260.0, camDist)) * (1.0 - aOuter);
          // 近岸細浪 + 颱風大浪
          float w1 = sin(p.x * 1.6 + t * 1.3) * cos(p.z * 1.2 - t * 0.9);
          float w2 = sin((p.x + p.z) * 2.9 + t * 2.1);
          float w3 = sin(p.z * 0.7 - t * 0.55) * 0.6;
          float h = (w1 * 0.6 + w2 * 0.3 + w3 * 0.25) * uWave * (1.0 + uStorm * 2.4) * waveK;
          p.y += h;
          float dx1 = 1.6 * cos(p.x * 1.6 + t * 1.3) * cos(p.z * 1.2 - t * 0.9);
          float dz1 = -1.2 * sin(p.x * 1.6 + t * 1.3) * sin(p.z * 1.2 - t * 0.9);
          float dx2 = 2.9 * cos((p.x + p.z) * 2.9 + t * 2.1);
          float dhx = (dx1 * 0.6 + dx2 * 0.3) * uWave * (1.0 + uStorm * 2.4) * waveK;
          float dhz = (dz1 * 0.6 + dx2 * 0.3) * uWave * (1.0 + uStorm * 2.4) * waveK;
          vNormalW = normalize(vec3(-dhx, 1.0, -dhz));
          vec4 wp = modelMatrix * vec4(p, 1.0);
          vWorldPos = wp.xyz;
          vDeep = aDeep;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uDetailScale;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uSkyColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uDeepColor;
        uniform vec3 uShallowColor;
        uniform float uDaylight;
        uniform float uIce;
        uniform float uRain;
        uniform float uStorm;
        uniform float uCityGlow;
        uniform vec3 uNeon;
        uniform vec3 uFogColor;
        uniform float uFogNear;
        uniform float uFogFar;
        varying float vDeep;
        varying vec3 vWorldPos;
        varying vec3 vNormalW;
        void main() {
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 N = normalize(vNormalW);
          float camDist = length(cameraPosition - vWorldPos);
          // 遠景淡出細節，避免水波在遠處產生摩爾紋
          float detail = 1.0 - smoothstep(35.0 * uDetailScale, 130.0 * uDetailScale, camDist);
          float rip = sin(vWorldPos.x * 9.0 + uTime * 6.0) * sin(vWorldPos.z * 8.0 - uTime * 5.0);
          N = normalize(N + vec3(rip * 0.07 * uRain, 0.0, rip * 0.06 * uRain) * detail);
          float fres = pow(clamp(1.0 - max(dot(N, V), 0.0), 0.0, 1.0), 3.0);
          float lightK = 0.16 + 0.84 * clamp(uDaylight, 0.0, 1.0);
          vec3 base = mix(uShallowColor, uDeepColor, clamp(vDeep, 0.0, 1.0)) * lightK;
          // 天空倒影：限制強度，否則遠景水面被洗白
          float skyRefl = fres * (0.3 * detail + 0.08);
          vec3 col = mix(base, uHorizonColor * (0.32 + 0.4 * uDaylight), clamp(skyRefl, 0.0, 0.4));
          col += uSkyColor * 0.04 * fres * lightK * detail;
          vec3 H = normalize(normalize(uSunDir) + V);
          float spec = pow(max(dot(N, H), 0.0), 120.0) * (0.25 + 0.75 * detail);
          col += uSunColor * spec * (0.4 + uDaylight * 1.1) * (1.0 + uStorm * 0.5);
          float glint = pow(max(dot(N, H), 0.0), 16.0) * 0.07 * uDaylight * detail;
          col += uSunColor * glint;
          // 岸邊白沫（近岸淺水 + 雨天／颱風）
          float foam = smoothstep(0.62, 0.98, 1.0 - vDeep) * (0.1 + uRain * 0.4 + uStorm * 0.4);
          foam *= 0.55 + 0.45 * sin(vWorldPos.x * 0.9 + vWorldPos.z * 0.7 + uTime * 1.6);
          // 遠處 damp foam，避免近岸白沫在 overview 變成摩爾紋
          foam *= detail * detail;
          col += vec3(0.82, 0.9, 0.92) * foam * (0.25 + uDaylight * 0.5);
          // 雨天的水面灰暗
          col *= 1.0 - uRain * 0.1 - uStorm * 0.12;
          // 夜間霓虹倒影：近岸暖色光帶（模擬維港兩岸燈火）
          float shoreGlow = smoothstep(0.35, 1.0, 1.0 - vDeep);
          col += uNeon * shoreGlow * uCityGlow * (0.22 + 0.4 * fres);
          // 結冰（寒潮）
          col = mix(col, vec3(0.78, 0.85, 0.9), uIce * (0.4 + 0.28 * clamp(vDeep, 0.0, 1.0)));
          float fogF = smoothstep(uFogNear, uFogFar, length(cameraPosition - vWorldPos));
          col = mix(col, uFogColor, fogF);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    }),
  );
  const waterMesh = new THREE.Mesh(waterGeo, waterMat);
  waterMesh.name = 'terrain-water';
  waterMesh.frustumCulled = false;
  track(waterMesh);
  group.add(waterMesh);

  // ───────────── 3b. 深海大平面（地圖內深海 + 地圖外無邊海面） ─────────────
  // 深海用一塊純色大平面（Basic + 霧）避免巨大 shader 三角形喺 overview 出摩爾紋；
  // 淺水／近岸仍有 per-tile 水 shader mesh（見上），顏色於邊界自然過渡。
  const outerSeaMat = track(
    new THREE.MeshBasicMaterial({
      color: WATER_DEEP[state.clock.season],
      fog: true,
      // 當成背景海面：最先畫、唔寫 depth，之後所有地形／道路／建築都一定覆蓋佢。
      // 修正近岸／深圳河一帶深海平面喺近鏡時遮住陸地嘅問題。
      depthWrite: false,
      depthTest: false,
    }),
  );
  const outerSeaGeo = track(new THREE.PlaneGeometry(1, 1));
  outerSeaGeo.rotateX(-Math.PI / 2);
  const outerSea = new THREE.Mesh(outerSeaGeo, outerSeaMat);
  outerSea.name = 'terrain-outer-sea';
  outerSea.position.y = WATER_SURFACE_Y - 0.02;
  const deepSpan = Math.max(width, height) * TILE + 8400;
  outerSea.scale.set(deepSpan, 1, deepSpan);
  outerSea.frustumCulled = false;
  outerSea.renderOrder = -100; // 背景海面最先畫，淺水 mesh／陸地之後覆蓋
  track(outerSea);
  group.add(outerSea);

  // ───────────── 4. 植被／道具擺放 ─────────────

  const windMat: WindMaterial = createWindMaterial(true);
  track(windMat.material);
  const stoneMat = track(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  const plainMat = track(new THREE.MeshLambertMaterial({ vertexColors: true }));

  interface Layers {
    banyan: Placement[];
    broadleaf: Placement[];
    bauhinia: Placement[];
    palm: Placement[];
    pine: Placement[];
    willow: Placement[];
    shrub: Placement[];
    grass: Placement[];
    flower: Placement[];
    reed: Placement[];
    rock: Placement[];
    crag: Placement[];
    distant: Placement[];
    container: Placement[];
    crop: Placement[];
  }
  const L: Layers = {
    banyan: [],
    broadleaf: [],
    bauhinia: [],
    palm: [],
    pine: [],
    willow: [],
    shrub: [],
    grass: [],
    flower: [],
    reed: [],
    rock: [],
    crag: [],
    distant: [],
    container: [],
    crop: [],
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const tile = state.tiles[i];
      const terrain = tile.terrain;
      const { x: wx, z: wz } = tileWorld(x, y, width, height);
      const top = topY[i];
      const nearWater = waterNear[i] === 1;
      const h = (salt: number): number => hash(x, y, seed + salt);
      const jx = (salt: number): number => (h(salt) - 0.5) * 1.1;
      const jz = (salt: number): number => (h(salt) - 0.5) * 1.1;
      const scl = (salt: number): number => 0.82 + h(salt) * 0.42;
      const designX = (x + 0.5) / kx - 0.5;
      const designY = (y + 0.5) / ky - 0.5;

      switch (terrain) {
        case 'forest': {
          // 香港郊野公園：榕樹、闊葉樹、松樹、竹叢混合
          // 304 地圖：每棵樹以 deco 機率生成，樹木總數同 96 地圖相若
          for (let k = 0; k < 3; k++) {
            if (h(3000 + k) > deco) continue;
            const roll = h(20 + k);
            const px = wx + jx(30 + k);
            const pz = wz + jz(40 + k);
            const rot = h(50 + k) * Math.PI * 2;
            const s = 0.9 + h(60 + k) * 0.55;
            const hv = h(70 + k);
            if (nearWater && roll > 0.82) L.willow.push(place(i, px, top - 0.04, pz, rot, s, hv));
            else if (roll > 0.72) L.banyan.push(place(i, px, top - 0.05, pz, rot, s * 1.05, hv));
            else if (roll > 0.55) L.pine.push(place(i, px, top - 0.05, pz, rot, s, hv));
            else if (roll > 0.3) L.broadleaf.push(place(i, px, top - 0.05, pz, rot, s, hv));
            else L.broadleaf.push(place(i, px, top - 0.05, pz, rot, s * 1.15, hv));
          }
          if (h(80) < 0.5 * deco) L.shrub.push(place(i, wx + jx(81), top + 0.02, wz + jz(82), h(83) * 6.28, scl(84), h(85)));
          if (h(86) < 0.42 * deco) L.grass.push(place(i, wx + jx(87), top + 0.01, wz + jz(88), h(89) * 6.28, scl(90), h(91)));
          break;
        }
        case 'grass': {
          // 鄉郊草地：零星大樹、草叢、野花；靠岸多棕櫚
          if (h(100) < 0.075 * deco) {
            const roll = h(101);
            if (roll < 0.22) L.bauhinia.push(place(i, wx + jx(102), top - 0.04, wz + jz(103), h(104) * 6.28, scl(105), h(106)));
            else if (roll < 0.46) L.banyan.push(place(i, wx + jx(102), top - 0.04, wz + jz(103), h(104) * 6.28, scl(105) * 1.1, h(106)));
            else if (roll < 0.7) L.broadleaf.push(place(i, wx + jx(102), top - 0.04, wz + jz(103), h(104) * 6.28, scl(105) * 1.05, h(106)));
            else L.pine.push(place(i, wx + jx(102), top - 0.04, wz + jz(103), h(104) * 6.28, scl(105), h(106)));
          }
          if (h(110) < 0.2 * deco) L.grass.push(place(i, wx + jx(111), top + 0.01, wz + jz(112), h(113) * 6.28, scl(114), h(115)));
          if (h(120) < 0.12 * deco) L.grass.push(place(i, wx + jx(121), top + 0.01, wz + jz(122), h(123) * 6.28, scl(124) * 0.8, h(125)));
          if (h(130) < 0.07 * deco) L.flower.push(place(i, wx + jx(131), top, wz + jz(132), h(133) * 6.28, scl(134) * 0.8, h(135)));
          if (h(140) < 0.05 * deco) L.shrub.push(place(i, wx + jx(141), top + 0.02, wz + jz(142), h(143) * 6.28, scl(144) * 0.9, h(145)));
          if (h(150) < 0.03 * deco) L.rock.push(place(i, wx + jx(151), top + 0.02, wz + jz(152), h(153) * 6.28, scl(154) * 0.7, h(155)));
          // 新界鄉村的大樹（風水林）
          if (h(160) < 0.012 * deco && !nearWater) L.banyan.push(place(i, wx, top - 0.05, wz, h(161) * 6.28, 1.15 + h(162) * 0.4, h(163)));
          break;
        }
        case 'fertile': {
          // 農地：整齊菜田列 + 零星野草
          if (h(180) < 0.06 * deco) L.grass.push(place(i, wx + jx(181), top + 0.01, wz + jz(182), h(183) * 6.28, scl(184) * 0.7, h(185)));
          if (h(186) < 0.05 * deco) L.flower.push(place(i, wx + jx(187), top, wz + jz(188), h(189) * 6.28, scl(190) * 0.7, h(191)));
          // 菜田：2×2 小苗，逐格略有方向（304 地圖按 deco 減列數）
          const rows = 3;
          for (let r = 0; r < rows; r++) {
            if (!showcaseCity) continue; // empty 由零開始：冇人造農田
            if (h(3200 + r) > deco * (h(200) > 0.5 ? 0.67 : 1)) continue;
            const t = (r + 0.5) / rows - 0.5;
            L.crop.push({
              tile: i,
              x: wx + t * 1.5,
              y: top + 0.02,
              z: wz + (h(201 + r) - 0.5) * 0.5,
              rot: 0,
              sx: 1.3,
              sy: 0.6 + h(202 + r) * 0.5,
              sz: 0.5,
              hash: h(203 + r),
            });
          }
          if (h(210) < 0.05 * deco) L.broadleaf.push(place(i, wx + jx(211), top - 0.04, wz + jz(212), h(213) * 6.28, scl(214) * 1.05, h(215)));
          break;
        }
        case 'hill': {
          if (h(230) < 0.3 * deco) L.pine.push(place(i, wx + jx(231), top - 0.04, wz + jz(232), h(233) * 6.28, 0.85 + h(234) * 0.55, h(235)));
          if (h(240) < 0.26 * deco) L.shrub.push(place(i, wx + jx(241), top + 0.02, wz + jz(242), h(243) * 6.28, scl(244), h(245)));
          if (h(250) < 0.22 * deco) L.rock.push(place(i, wx + jx(251), top + 0.02, wz + jz(252), h(253) * 6.28, scl(254) * 0.9, h(255)));
          if (h(260) < 0.14 * deco) L.grass.push(place(i, wx + jx(261), top + 0.01, wz + jz(262), h(263) * 6.28, scl(264) * 0.8, h(265)));
          break;
        }
        case 'mountain': {
          // 山地：岩峰、碎石、低處少量松樹
          if (tile.elevation > 0.62 && h(280) < 0.75 * deco) {
            L.crag.push(
              place(
                i,
                wx + jx(281) * 0.5,
                top - 0.25,
                wz + jz(282) * 0.5,
                h(283) * 6.28,
                1.2 + h(284) * 1.8,
                h(285),
                1.1 + h(286) * 1.6,
              ),
            );
          }
          if (h(287) < 0.4 * deco) {
            L.crag.push(
              place(
                i,
                wx + jx(288) * 0.75,
                top - 0.3,
                wz + jz(289) * 0.75,
                h(290) * 6.28,
                0.55 + h(291) * 0.7,
                h(292),
                0.5 + h(293) * 0.55,
              ),
            );
          }
          if (tile.elevation < 0.72 && h(294) < 0.14 * deco) {
            L.pine.push(place(i, wx + jx(295), top - 0.1, wz + jz(296), h(297) * 6.28, 0.75 + h(298) * 0.5, h(299)));
          }
          if (h(300) < 0.1 * deco) L.rock.push(place(i, wx + jx(301), top + 0.02, wz + jz(302), h(303) * 6.28, scl(304) * 0.9, h(305)));
          break;
        }
        case 'sand': {
          if (nearWater && h(310) < 0.2 * deco) L.reed.push(place(i, wx + jx(311), top + 0.01, wz + jz(312), h(313) * 6.28, scl(314), h(315)));
          if (h(320) < 0.12 * deco) L.rock.push(place(i, wx + jx(321), top + 0.01, wz + jz(322), h(323) * 6.28, scl(324) * 0.7, h(325)));
          if (h(326) < 0.14 * deco) L.palm.push(place(i, wx + jx(327), top - 0.02, wz + jz(328), h(329) * 6.28, 0.85 + h(330) * 0.35, h(331)));
          if (h(332) < 0.05 * deco) L.grass.push(place(i, wx + jx(333), top + 0.01, wz + jz(334), h(335) * 6.28, scl(336) * 0.7, h(337)));
          break;
        }
        case 'wetland': {
          // 米埔：紅樹林、蘆葦、水窪（水窪由另一層繪製）
          if (h(340) < 0.55 * deco) L.reed.push(place(i, wx + jx(341), top + 0.01, wz + jz(342), h(343) * 6.28, scl(344) * 1.2, h(345)));
          if (h(346) < 0.2 * deco) L.willow.push(place(i, wx + jx(347), top - 0.04, wz + jz(348), h(349) * 6.28, 0.7 + h(350) * 0.3, h(351)));
          if (h(352) < 0.16 * deco) L.grass.push(place(i, wx + jx(353), top + 0.01, wz + jz(354), h(355) * 6.28, scl(356) * 0.8, h(357)));
          break;
        }
        case 'urban':
        case 'reclaimed': {
          // 市區路邊樹（棕櫚／洋紫荊）——樓群由 backdrop 層繪製
          if (h(360) < 0.06 * deco) L.palm.push(place(i, wx + jx(361), top - 0.02, wz + jz(362), h(363) * 6.28, 0.8 + h(364) * 0.25, h(365)));
          else if (h(366) < 0.05 * deco) L.bauhinia.push(place(i, wx + jx(367), top - 0.03, wz + jz(368), h(369) * 6.28, 0.8 + h(370) * 0.2, h(371)));
          break;
        }
        case 'water':
        default:
          break;
      }

      // 貨櫃碼頭：貨櫃堆（根據 HK_REGIONS；empty 由 update 按港口建築動態顯示）
      if (terrain !== 'water') {
        for (const region of HK_REGIONS) {
          if (region.kind !== 'containerPort') continue;
          if (designX < region.x0 || designX > region.x1 || designY < region.y0 || designY > region.y1) continue;
          const stacks = 3;
          for (let s = 0; s < stacks; s++) {
            // 真實葵涌碼頭區塊（480 地圖約 24×19 格）；每格約 0.6 疊貨櫃
            if (h(3400 + s) > 0.2) continue;
            L.container.push({
              tile: i,
              x: wx + jx(401 + s) * 0.5,
              y: top + 0.28 + s * 0.56,
              z: wz + jz(402 + s) * 0.5,
              rot: h(403 + s) > 0.5 ? 0 : Math.PI / 2,
              sx: 1,
              sy: 1,
              sz: 1,
              hash: h(404 + s),
            });
          }
          break;
        }
      }
    }
  }

  // 濕地水窪（獨立一層，半透明水面）
  const wetlandPools: Placement[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (state.tiles[i].terrain !== 'wetland') continue;
      const h = hash(x, y, seed + 501);
      if (h > 0.55 * deco) continue;
      const { x: wx, z: wz } = tileWorld(x, y, width, height);
      wetlandPools.push(place(i, wx + (hash(x, y, seed + 502) - 0.5) * 0.8, topY[i] + 0.012, wz + (hash(x, y, seed + 503) - 0.5) * 0.8, hash(x, y, seed + 504) * 6.28, 0.7 + hash(x, y, seed + 505) * 0.7, hash(x, y, seed + 506)));
    }
  }

  // 地圖以外的遠海由環境天空的下半球（深海色）呈現，避免大平面在俯瞰時
  // 出現霧帶／條紋；此處只保留遠島剪影，地平線自然融入天空霧氣。

  // 不再繪製地圖以外的遠島剪影：天空下半球的深海色已足夠交代地平線，
  // 避免大型低多邊形山影在俯瞰時蓋住地圖外的天空（見 update 的 sky 設定）。

  // ───────────── 5. 建立 InstancedMesh 圖層 ─────────────

  const layers: TintableLayer[] = [];

  interface LayerOpts {
    geometry: THREE.BufferGeometry;
    material: THREE.Material;
    list: Placement[];
    kind: TintKind;
    occupancy?: boolean;
    windPhase?: boolean;
    castShadow?: boolean;
    receiveShadow?: boolean;
    sway?: boolean;
  }

  const buildLayer = (opts: LayerOpts): TintableLayer => {
    const geo = track(opts.geometry);
    if (opts.sway) addSwayAttribute(geo);
    const n = opts.list.length;
    const mesh = new THREE.InstancedMesh(geo, opts.material, Math.max(1, n));
    mesh.name = `terrain-${opts.kind}`;
    mesh.castShadow = opts.castShadow ?? true;
    mesh.receiveShadow = opts.receiveShadow ?? false;
    mesh.frustumCulled = false;
    mesh.count = n;
    mesh.visible = n > 0;
    if (opts.windPhase) addInstancePhase(geo, Math.max(1, n), seed + opts.kind.length * 977);
    track(mesh);
    group.add(mesh);
    const layer: TintableLayer = {
      mesh,
      list: opts.list,
      kind: opts.kind,
      occupancy: opts.occupancy ?? false,
      matrixBase: null,
    };
    const dummy = new THREE.Object3D();
    if (layer.occupancy && n > 0) {
      const base = new Float32Array(n * 16);
      opts.list.forEach((p, idx) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(p.sx, p.sy, p.sz);
        dummy.updateMatrix();
        dummy.matrix.toArray(base, idx * 16);
        mesh.setMatrixAt(idx, dummy.matrix);
      });
      layer.matrixBase = base;
      mesh.instanceMatrix.needsUpdate = true;
    } else {
      opts.list.forEach((p, idx) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(p.sx, p.sy, p.sz);
        dummy.updateMatrix();
        mesh.setMatrixAt(idx, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
    layers.push(layer);
    return layer;
  };

  const nearGeo = (fn: () => THREE.BufferGeometry): THREE.BufferGeometry => {
    const g = fn();
    return g;
  };

  buildLayer({ geometry: nearGeo(createBanyanGeometry), material: windMat.material, list: L.banyan, kind: 'banyan', occupancy: true, windPhase: true, sway: true });
  buildLayer({ geometry: nearGeo(createBroadleafGeometry), material: windMat.material, list: L.broadleaf, kind: 'broadleaf', occupancy: true, windPhase: true, sway: true });
  buildLayer({ geometry: nearGeo(createBauhiniaGeometry), material: windMat.material, list: L.bauhinia, kind: 'bauhinia', occupancy: true, windPhase: true, sway: true });
  buildLayer({ geometry: nearGeo(createPalmGeometry), material: windMat.material, list: L.palm, kind: 'palm', occupancy: true, windPhase: true, sway: true });
  buildLayer({ geometry: nearGeo(createPineGeometry), material: windMat.material, list: L.pine, kind: 'pine', occupancy: true, windPhase: true, sway: true });
  buildLayer({ geometry: nearGeo(createWillowGeometry), material: windMat.material, list: L.willow, kind: 'willow', occupancy: true, windPhase: true, sway: true });
  buildLayer({ geometry: nearGeo(createShrubGeometry), material: windMat.material, list: L.shrub, kind: 'shrub', occupancy: true, windPhase: true, sway: true, castShadow: false });
  buildLayer({ geometry: nearGeo(createGrassTuftGeometry), material: windMat.material, list: L.grass, kind: 'grass', occupancy: true, windPhase: true, sway: true, castShadow: false });
  buildLayer({ geometry: nearGeo(createFlowerGeometry), material: windMat.material, list: L.flower, kind: 'flower', occupancy: true, windPhase: true, sway: true, castShadow: false });
  buildLayer({ geometry: nearGeo(createReedGeometry), material: windMat.material, list: L.reed, kind: 'reed', occupancy: true, windPhase: true, sway: true, castShadow: false });
  buildLayer({ geometry: nearGeo(() => createRockGeometry(seed + 5)), material: stoneMat, list: L.rock, kind: 'rock', occupancy: true });
  buildLayer({ geometry: nearGeo(() => createCragGeometry(seed + 9)), material: stoneMat, list: L.crag, kind: 'crag', occupancy: true, castShadow: false });
  buildLayer({ geometry: nearGeo(() => createMountainSilhouetteGeometry(seed + 13)), material: stoneMat, list: L.distant, kind: 'distant', occupancy: false, castShadow: false, receiveShadow: false });
  buildLayer({ geometry: nearGeo(createContainerGeometry), material: plainMat, list: L.container, kind: 'container', occupancy: true, castShadow: true });
  {
    // 菜田（以細長綠條表示）
    const cropGeo = new THREE.BoxGeometry(1, 0.16, 0.34);
    cropGeo.translate(0, 0.08, 0);
    const cropMat = track(new THREE.MeshLambertMaterial({ vertexColors: false, color: 0xffffff }));
    buildLayer({ geometry: cropGeo, material: cropMat, list: L.crop, kind: 'crop', occupancy: true, castShadow: false });
    // 逐實例綠色深淺
    const c = new THREE.Color();
    L.crop.forEach((p, i) => {
      c.setRGB(0.42 + p.hash * 0.25, 0.62 + p.hash * 0.25, 0.28 + p.hash * 0.12);
      // 農作物顏色僅影響 instanceColor（material 為白）
      const layer = layers[layers.length - 1];
      layer.mesh.setColorAt(i, c);
    });
    const cropLayer = layers[layers.length - 1];
    if (cropLayer.mesh.instanceColor) cropLayer.mesh.instanceColor.needsUpdate = true;
  }

  // 濕地水窪
  let poolMesh: THREE.InstancedMesh | null = null;
  {
    const poolGeo = track(new THREE.PlaneGeometry(1.6, 1.6));
    poolGeo.rotateX(-Math.PI / 2);
    const poolMat = track(
      new THREE.MeshLambertMaterial({
        color: 0x5f8d84,
        transparent: true,
        opacity: 0.72,
        emissive: 0x122a30,
        emissiveIntensity: 0.2,
      }),
    );
    const n = wetlandPools.length;
    poolMesh = new THREE.InstancedMesh(poolGeo, poolMat, Math.max(1, n));
    poolMesh.name = 'terrain-wetland-pools';
    poolMesh.count = n;
    poolMesh.visible = n > 0;
    poolMesh.frustumCulled = false;
    track(poolMesh);
    const dummy = new THREE.Object3D();
    wetlandPools.forEach((p, idx) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.set(p.sx, 1, p.sz);
      dummy.updateMatrix();
      poolMesh!.setMatrixAt(idx, dummy.matrix);
    });
    poolMesh.instanceMatrix.needsUpdate = true;
    group.add(poolMesh);
  }

  // ───────────── 6. 市區遠景樓群（中環／尖沙咀／觀塘天際線） ─────────────

  const facadeMat: Record<'tower' | 'block' | 'office', THREE.Material[]> = {} as never;
  const buildingLayers: BuildingLayer[] = [];
  {
    const facadeKinds: ('tower' | 'block' | 'office')[] = ['tower', 'block', 'office'];
    const facadeTextureSeed: Record<string, number> = { tower: 11, block: 27, office: 43 };
    const buildingPlacements: Record<'tower' | 'block' | 'office', { tile: number; x: number; y: number; z: number; h: number; w: number; rot: number; shade: number }[]> = {
      tower: [],
      block: [],
      office: [],
    };

    // ── 真實建築密度樓群（starter 模式；empty 由零開始完全冇） ──
    //  用 CSDI／地政總署真實數據：tile.density（0..255 建築覆蓋率）、
    //  tile.buildingHeight（米，平均建築高度）決定每格樓宇數量／高度／種類。
    //  - density 高（市區）→ 每格 1–2 座；郊區 density 低 → 稀疏或冇樓
    //  - 杏花邨／柴灣／小西灣等真實高層住宅：density 高 + buildingHeight 高 → 住宅塔樓
    //  - 中環／尖沙咀／觀塘 skyline 區 + 高樓 → 玻璃商廈（office）
    //  - 全部 InstancedMesh，額外 3 draw calls
    // Issue #7：starter 已有真實 existing 樓群（會經 buildings renderer 顯示），
    // 唔再生成裝飾用 faux skyline，避免玩家見到無法運作嘅假樓。
    if (showcaseCity && false) {
      const skylineRegions = HK_REGIONS.filter((r) => r.kind === 'skyline' || r.kind === 'newTown');
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          const tile = state.tiles[i];
          if (tile.terrain === 'water') continue;
          const density = tile.density ?? 0;
          const bh = tile.buildingHeight ?? 0;
          if (density < 28 || bh < 4) continue;
          if (tile.road || tile.buildingId >= 0) continue;
          const designX = (x + 0.5) / kx - 0.5;
          const designY = (y + 0.5) / ky - 0.5;
          const r1 = hash(x, y, seed + 601);
          const p = Math.min(1, (density - 28) / 180);
          // 覆蓋率／樓高越高，出現機會越大（仍保留公園、空地、後巷）
          const gate = 0.1 + p * 0.38 + Math.min(1, bh / 180) * 0.12;
          if (r1 > gate) continue;
          const { x: wx, z: wz } = tileWorld(x, y, width, height);
          const top = topY[i];
          const inSkyline = skylineRegions.some(
            (r) => designX >= r.x0 && designX <= r.x1 && designY >= r.y0 && designY <= r.y1,
          );
          const hUnits = Math.min(27, Math.max(1.1, 1.1 + bh * 0.072)) * (0.9 + hash(x, y, seed + 607) * 0.22);
          let kind: 'tower' | 'block' | 'office';
          if ((inSkyline && bh >= 95 && density >= 140) || bh >= 190) kind = 'office';
          else if (bh >= 42 || density >= 110) kind = 'tower';
          else kind = 'block';
          const wBase = 0.85 + (density / 255) * 1.0;
          const rot = Math.floor(hash(x, y, seed + 604) * 4) * (Math.PI / 2);
          buildingPlacements[kind].push({
            tile: i,
            x: wx + (hash(x, y, seed + 602) - 0.5) * 0.42,
            y: top + 0.006,
            z: wz + (hash(x, y, seed + 603) - 0.5) * 0.42,
            h: hUnits,
            w: wBase * (0.9 + hash(x, y, seed + 606) * 0.3),
            rot,
            shade: 0.86 + hash(x, y, seed + 605) * 0.3,
          });
          // 高密度市區：再加一幢矮一些的鄰樓，令街區更有質感
          if (density >= 190 && hash(x, y, seed + 608) < 0.42) {
            const kind2: 'block' | 'tower' = bh >= 55 ? 'tower' : 'block';
            buildingPlacements[kind2].push({
              tile: i,
              x: wx + 0.58 + (hash(x, y, seed + 610) - 0.5) * 0.3,
              y: top + 0.006,
              z: wz - 0.6 + (hash(x, y, seed + 611) - 0.5) * 0.3,
              h: Math.max(1.4, hUnits * (0.45 + hash(x, y, seed + 612) * 0.2)),
              w: Math.max(0.8, wBase * 0.65),
              rot: (rot + Math.PI / 2) % (Math.PI * 2),
              shade: 0.84 + hash(x, y, seed + 613) * 0.28,
            });
          }
        }
      }
    }

    // 立面幾何：四面牆（無頂）
    const makeSidesGeometry = (): THREE.BufferGeometry => {
      const w = 1;
      const d = 1;
      const h = 1;
      const parts: THREE.BufferGeometry[] = [];
      const front = new THREE.PlaneGeometry(w, h);
      front.translate(0, h / 2, d / 2);
      const back = new THREE.PlaneGeometry(w, h);
      back.rotateY(Math.PI);
      back.translate(0, h / 2, -d / 2);
      const right = new THREE.PlaneGeometry(d, h);
      right.rotateY(Math.PI / 2);
      right.translate(w / 2, h / 2, 0);
      const left = new THREE.PlaneGeometry(d, h);
      left.rotateY(-Math.PI / 2);
      left.translate(-w / 2, h / 2, 0);
      // 屋頂（封閉盒體最頂面）：UV 指向貼圖的屋頂素色小區
      const top = new THREE.PlaneGeometry(w, d);
      top.rotateX(-Math.PI / 2);
      top.translate(0, h, 0);
      parts.push(front, back, right, left, top);
      const merged = mergePlainGeometries(parts);
      const uv = merged.getAttribute('uv') as THREE.BufferAttribute;
      const pos = merged.getAttribute('position') as THREE.BufferAttribute;
      const nor = merged.getAttribute('normal') as THREE.BufferAttribute;
      for (let k = 0; k < uv.count; k++) {
        if (nor.getY(k) > 0.5 && pos.getY(k) > 0.9) {
          // 屋頂面：取貼圖角落的屋頂灰
          uv.setXY(k, 0.03, 0.03);
        } else {
          uv.setXY(k, uv.getX(k) * 1.25, uv.getY(k) * 3.2);
        }
      }
      uv.needsUpdate = true;
      return merged;
    };
    const sidesGeo = track(makeSidesGeometry());

    for (const kind of facadeKinds) {
      const list = buildingPlacements[kind];
      if (list.length === 0) continue;
      const fac = createFacadeTexture(kind, facadeTextureSeed[kind]);
      if (!fac) continue;
      track(fac.map);
      track(fac.emissive);
      const sideMat = track(
        new THREE.MeshLambertMaterial({
          map: fac.map,
          emissiveMap: fac.emissive,
          emissive: 0xffffff,
          emissiveIntensity: 0,
        }),
      );
      facadeMat[kind] = [sideMat];
      const mesh = new THREE.InstancedMesh(sidesGeo, sideMat, list.length);
      mesh.name = `terrain-buildings-${kind}`;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      track(mesh);
      group.add(mesh);
      const dummy = new THREE.Object3D();
      const c = new THREE.Color();
      const base = new Float32Array(list.length * 16);
      list.forEach((p, idx) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(p.w, p.h, p.w);
        dummy.updateMatrix();
        dummy.matrix.toArray(base, idx * 16);
        mesh.setMatrixAt(idx, dummy.matrix);
        c.setRGB(p.shade, p.shade, p.shade);
        mesh.setColorAt(idx, c);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      buildingLayers.push({ kind, mesh, list, matrixBase: base });
    }
  }

  // ── 天台雜物（水塔、太陽能板、天線）：香港樓頂的標誌性細節 ──
  const roofTanks: { x: number; y: number; z: number; s: number; rot: number; tile: number }[] = [];
  const roofAntennas: { x: number; y: number; z: number; s: number; rot: number; tile: number }[] = [];
  for (const bl of buildingLayers) {
    for (const p of bl.list) {
      const hh = hash(p.tile % width, Math.floor(p.tile / width), seed + 707);
      if (p.h < 1.4 || hh > 0.72) continue;
      if (hh < 0.42) {
        roofTanks.push({ x: p.x + (hh - 0.5) * 0.5, y: p.y + p.h, z: p.z + (hash(p.tile, 5, seed + 708) - 0.5) * 0.5, s: 0.7 + hash(p.tile, 6, seed + 709) * 0.7, rot: hh * 3.1, tile: p.tile });
      } else if (hh < 0.58) {
        roofAntennas.push({ x: p.x, y: p.y + p.h, z: p.z, s: 0.8 + hash(p.tile, 7, seed + 711) * 0.9, rot: hh * 2, tile: p.tile });
      }
    }
  }
  let roofTankMesh: THREE.InstancedMesh | null = null;
  let roofAntennaMesh: THREE.InstancedMesh | null = null;
  let roofTankBase: Float32Array | null = null;
  let roofAntennaBase: Float32Array | null = null;
  if (roofTanks.length > 0) {
    const tankGeo = track(new THREE.CylinderGeometry(0.16, 0.16, 0.3, 6));
    tankGeo.translate(0, 0.15, 0);
    const tankMat = track(new THREE.MeshLambertMaterial({ color: 0xb8bcbc }));
    roofTankMesh = new THREE.InstancedMesh(tankGeo, tankMat, roofTanks.length);
    roofTankMesh.name = 'terrain-roof-tanks';
    roofTankMesh.castShadow = true;
    roofTankMesh.frustumCulled = false;
    track(roofTankMesh);
    group.add(roofTankMesh);
    roofTankBase = new Float32Array(roofTanks.length * 16);
    const dummy = new THREE.Object3D();
    roofTanks.forEach((t, i) => {
      dummy.position.set(t.x, t.y, t.z);
      dummy.rotation.set(0, t.rot, 0);
      dummy.scale.setScalar(t.s);
      dummy.updateMatrix();
      dummy.matrix.toArray(roofTankBase!, i * 16);
      roofTankMesh!.setMatrixAt(i, dummy.matrix);
    });
    roofTankMesh.instanceMatrix.needsUpdate = true;
  }
  if (roofAntennas.length > 0) {
    const antGeo = track(new THREE.BoxGeometry(0.035, 0.7, 0.035));
    antGeo.translate(0, 0.35, 0);
    const antMat = track(new THREE.MeshLambertMaterial({ color: 0x8a8f92 }));
    roofAntennaMesh = new THREE.InstancedMesh(antGeo, antMat, roofAntennas.length);
    roofAntennaMesh.name = 'terrain-roof-antennas';
    roofAntennaMesh.frustumCulled = false;
    track(roofAntennaMesh);
    group.add(roofAntennaMesh);
    roofAntennaBase = new Float32Array(roofAntennas.length * 16);
    const dummy = new THREE.Object3D();
    roofAntennas.forEach((t, i) => {
      dummy.position.set(t.x, t.y, t.z);
      dummy.rotation.set(0, t.rot, 0);
      dummy.scale.setScalar(t.s);
      dummy.updateMatrix();
      dummy.matrix.toArray(roofAntennaBase!, i * 16);
      roofAntennaMesh!.setMatrixAt(i, dummy.matrix);
    });
    roofAntennaMesh.instanceMatrix.needsUpdate = true;
  }

  // ───────────── 7. 地標 ─────────────

  // 「由零開始」empty 模式：完全唔生成人造地標（大佛／摩天輪／鐘樓／會展／青馬大橋等），
  // 只保留自然地形；starter 模式照舊保留。
  const landmarks: { mesh: THREE.Mesh; spin?: number }[] = [];
  // 真實地理 480 地圖：地標圖示只需略為放大（貼合 tiles／玩家建築尺度），
  // 唔可以照 design 倍率 ×5，否則凌霄閣／摩天輪會變巨人。
  const landmarkScale = Math.min(1.9, 1 + (Math.sqrt(kx * ky) - 1) * 0.18);
  const addLandmark = (geo: THREE.BufferGeometry, mat: THREE.Material, dx: number, dy: number, yOff: number, rotY = 0, scale = 1, castShadow = true): THREE.Mesh => {
    const mesh = new THREE.Mesh(track(geo), mat);
    const { x: wx, z: wz } = designToWorld(dx, dy);
    // 找該格地形高度（夾在地圖內）
    const tx = Math.max(0, Math.min(width - 1, Math.round(dx * kx)));
    const ty = Math.max(0, Math.min(height - 1, Math.round(dy * ky)));
    const gy = topY[ty * width + tx];
    mesh.position.set(wx, gy + yOff * landmarkScale, wz);
    mesh.rotation.y = rotY;
    mesh.scale.setScalar(scale * landmarkScale);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = false;
    track(mesh);
    group.add(mesh);
    landmarks.push({ mesh });
    return mesh;
  };
  if (showcaseCity) {
    const landmarkMat = track(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const metalMat = track(new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x223344, emissiveIntensity: 0.1 }));
    for (const lm of HK_LANDMARKS) {
      switch (lm.kind) {
        case 'peakTower':
          addLandmark(createPeakTowerGeometry(), landmarkMat, lm.x, lm.y, 0.02, -0.5, 1.4);
          break;
        case 'buddha':
          addLandmark(createBuddhaGeometry(), landmarkMat, lm.x, lm.y, 0.02, 0.4, 1.6);
          break;
        case 'ferrisWheel': {
          const mesh = addLandmark(createFerrisWheelGeometry(), metalMat, lm.x, lm.y, 0.02, 0, 1.25);
          landmarks[landmarks.length - 1].spin = 0.12;
          void mesh;
          break;
        }
        case 'clockTower':
          addLandmark(createClockTowerGeometry(), landmarkMat, lm.x, lm.y, 0.02, 0.3, 1.5);
          break;
        case 'convention':
          addLandmark(createConventionGeometry(), landmarkMat, lm.x, lm.y, 0.02, -0.25, 1.15);
          break;
        case 'bigBridge': {
          // 青馬大橋：橫跨汲水門（青衣—大嶼山）
          const bridge = addLandmark(createBridgeGeometry(), track(new THREE.MeshLambertMaterial({ vertexColors: true })), lm.x + 1, lm.y, 0.3, 0.12, 1.5, false);
          // 鋼纜
          const cablePts: number[] = [];
          const span = 5.2 * 1.5;
          const towerX = 1.2 * 1.5;
          for (const side of [-1, 1]) {
            const zOff = side * 0.22 * 1.5;
            const p0 = new THREE.Vector3(-span / 2, 0.95, zOff);
            const p1 = new THREE.Vector3(-towerX, 3.4, zOff);
            const p2 = new THREE.Vector3(0, 2.0, zOff);
            const p3 = new THREE.Vector3(towerX, 3.4, zOff);
            const p4 = new THREE.Vector3(span / 2, 0.95, zOff);
            const curve = new THREE.CatmullRomCurve3([p0, p1, p2, p3, p4]);
            const pts = curve.getPoints(24);
            for (let k = 1; k < pts.length; k++) {
              cablePts.push(pts[k - 1].x, pts[k - 1].y, pts[k - 1].z, pts[k].x, pts[k].y, pts[k].z);
            }
          }
          const cableGeo = track(new THREE.BufferGeometry());
          cableGeo.setAttribute('position', new THREE.Float32BufferAttribute(cablePts, 3));
          const cableMat = track(new THREE.LineBasicMaterial({ color: 0xb8c2c8, transparent: true, opacity: 0.75 }));
          const cables = new THREE.LineSegments(cableGeo, cableMat);
          cables.position.copy(bridge.position);
          cables.rotation.copy(bridge.rotation);
          cables.scale.setScalar(landmarkScale);
          track(cables);
          group.add(cables);
          break;
        }
        default:
          break;
      }
    }
  }

  // ───────────── 8. 機場跑道與飛機（世界尺度；empty 模式完全唔生成人造構築物） ─────────────

  // 機場裝飾：starter 或有機場建築（airportTerminal／airCargoTerminal）時才顯示；
  // empty 模式玩家建成機場後會即時出現（由 update 設定 group.visible）。
  const airportDecor = new THREE.Group();
  airportDecor.name = 'terrain-airport-decor';
  airportDecor.visible = false;
  group.add(airportDecor);
  {
    const runwayMat = track(new THREE.MeshLambertMaterial({ color: 0x53585c }));
    const slabGeo = track(new THREE.BoxGeometry(1, 0.02, 1));
    const slabList: { x: number; z: number; y: number; w: number; d: number }[] = [];
    const dashMat = track(new THREE.MeshBasicMaterial({ color: 0xe8e8e0 }));
    const dashGeo = track(new THREE.BoxGeometry(1.7, 0.02, 0.26));
    const dashList: { x: number; z: number; y: number; rot: number }[] = [];
    const terminalBlocks: { x: number; z: number; y: number; w: number; h: number; d: number; rot: number }[] = [];
    const planes: { x: number; z: number; y: number; rot: number }[] = [];

    for (const region of HK_REGIONS) {
      if (region.kind !== 'runway' && region.kind !== 'airport') continue;
      const p0 = designToWorld(region.x0, region.y0);
      const p1 = designToWorld(region.x1, region.y1);
      const x0 = Math.min(p0.x, p1.x) - TILE / 2;
      const x1 = Math.max(p0.x, p1.x) + TILE / 2;
      const z0 = Math.min(p0.z, p1.z) - TILE / 2;
      const z1 = Math.max(p0.z, p1.z) + TILE / 2;
      const cxm = (x0 + x1) / 2;
      const czm = (z0 + z1) / 2;
      const wWorld = x1 - x0;
      const dWorld = z1 - z0;
      const tx = Math.max(0, Math.min(width - 1, Math.round(((region.x0 + region.x1) / 2) * kx)));
      const ty = Math.max(0, Math.min(height - 1, Math.round(((region.y0 + region.y1) / 2) * ky)));
      const gy = topY[ty * width + tx];

      if (region.kind === 'runway') {
        // 跑道：只鋪在「填海陸地」上，並只取中央約 3 格闊（避免 304 地圖下
        // 整個啟德／赤鱲角片區變成一大塊黑色停機坪）。
        const tx0 = Math.max(0, Math.floor(region.x0 * kx));
        const tx1 = Math.min(width - 1, Math.ceil(region.x1 * kx));
        const ty0 = Math.max(0, Math.floor(region.y0 * ky));
        const ty1 = Math.min(height - 1, Math.ceil(region.y1 * ky));
        const alongX = tx1 - tx0 >= ty1 - ty0;
        const centerX = Math.round((tx0 + tx1) / 2);
        const centerY = Math.round((ty0 + ty1) / 2);
        // 真實赤鱲角機場有兩條平行跑道；沿垂直方向各偏移約 4 格
        const halfW = 1; // 每條跑道 3 格闊
        const strips = [-2, 2];
        for (const strip of strips) {
        for (let ty = ty0; ty <= ty1; ty++) {
          for (let tx = tx0; tx <= tx1; tx++) {
            if (alongX) {
              if (Math.abs(ty - centerY - strip) > halfW) continue;
            } else if (Math.abs(tx - centerX - strip) > halfW) continue;
            const i = ty * width + tx;
            if (state.tiles[i].terrain === 'water') continue;
            const { x: wx, z: wz } = tileWorld(tx, ty, width, height);
            slabList.push({ x: wx, z: wz, y: topY[i] + 0.02, w: TILE * 0.99, d: TILE * 0.99 });
            // 沿長軸每 3 格加一段中央白虛線
            const along = alongX ? tx - tx0 : ty - ty0;
            if (along % 3 === 0) {
              dashList.push({
                x: wx,
                z: wz,
                y: topY[i] + 0.045,
                rot: alongX ? 0 : Math.PI / 2,
              });
            }
          }
        }
        }
      } else {
        // 機場客運大樓（世界尺度，跟隨地圖放大）
        // 客運大樓：真實約 1.8km 長、60m 高（1 世界單位 ≈ 50m）→ 唔好按 design 倍率 ×5
        const termH = 1.15;
        terminalBlocks.push({ x: cxm, z: czm, y: gy + termH / 2, w: 1.9 * kx, h: termH, d: 1.1 * ky, rot: 0.1 });
        terminalBlocks.push({ x: cxm + 2.2 * kx, z: czm - 1.1 * ky, y: gy + 0.4, w: 1.1 * kx, h: 0.8, d: 0.8 * ky, rot: -0.2 });
        for (let k = 0; k < 2; k++) {
          const pp = designToWorld(region.x0 + 2.5 + k * 2.4, region.y0 + 2.1 + (k % 2) * 1.2);
          planes.push({ x: pp.x, z: pp.z, y: gy + 0.12, rot: 0.4 + k * 0.6 });
        }
      }
    }

    if (slabList.length > 0) {
      const slabs = new THREE.InstancedMesh(slabGeo, runwayMat, slabList.length);
      slabs.name = 'airport-runway';
      slabs.frustumCulled = false;
      slabs.receiveShadow = true;
      const dummy = new THREE.Object3D();
      slabList.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(p.w, 1, p.d);
        dummy.updateMatrix();
        slabs.setMatrixAt(i, dummy.matrix);
      });
      slabs.instanceMatrix.needsUpdate = true;
      track(slabs);
      airportDecor.add(slabs);
    }
    if (dashList.length > 0) {
      const dashes = new THREE.InstancedMesh(dashGeo, dashMat, dashList.length);
      dashes.name = 'airport-runway-dashes';
      dashes.frustumCulled = false;
      const dummy = new THREE.Object3D();
      dashList.forEach((d, i) => {
        dummy.position.set(d.x, d.y, d.z);
        dummy.rotation.set(0, d.rot, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        dashes.setMatrixAt(i, dummy.matrix);
      });
      dashes.instanceMatrix.needsUpdate = true;
      track(dashes);
      airportDecor.add(dashes);
    }
    if (terminalBlocks.length > 0) {
      const termGeo = track(new THREE.BoxGeometry(1, 1, 1));
      const termMat = track(new THREE.MeshLambertMaterial({ color: 0xc8ccd0 }));
      const term = new THREE.InstancedMesh(termGeo, termMat, terminalBlocks.length);
      term.name = 'airport-terminal';
      term.castShadow = true;
      term.frustumCulled = false;
      term.receiveShadow = true;
      const dummy = new THREE.Object3D();
      terminalBlocks.forEach((t, i) => {
        dummy.position.set(t.x, t.y, t.z);
        dummy.rotation.set(0, t.rot, 0);
        dummy.scale.set(t.w, t.h, t.d);
        dummy.updateMatrix();
        term.setMatrixAt(i, dummy.matrix);
      });
      term.instanceMatrix.needsUpdate = true;
      track(term);
      airportDecor.add(term);
    }
    if (planes.length > 0) {
      const planeGeo = track(createAirplaneGeometry());
      const planeMat = track(new THREE.MeshLambertMaterial({ vertexColors: true }));
      const planeMesh = new THREE.InstancedMesh(planeGeo, planeMat, planes.length);
      planeMesh.name = 'airport-planes';
      planeMesh.castShadow = true;
      planeMesh.frustumCulled = false;
      const dummy = new THREE.Object3D();
      planes.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.setScalar(1.0);
        dummy.updateMatrix();
        planeMesh.setMatrixAt(i, dummy.matrix);
      });
      planeMesh.instanceMatrix.needsUpdate = true;
      track(planeMesh);
      airportDecor.add(planeMesh);
    }
  }

  // Round 9／#19：機場密集起降（只在 airportDecor 顯示時一齊顯示；parent visibility 控制）
  let airportTraffic: AirportTrafficView | null = null;
  {
    airportTraffic = createAirportTrafficView(state);
    airportDecor.add(airportTraffic.group);
  }

  // ───────────── 9. 維港船隻 ─────────────

  interface Boat {
    mesh: THREE.Mesh;
    kind: 'ferry' | 'junk' | 'cargo' | 'fishing';
    // 航線（設計座標）
    from?: { x: number; z: number };
    to?: { x: number; z: number };
    t: number;
    speed: number;
    bobPhase: number;
    baseRot: number;
    anchored: boolean;
  }
  const boats: Boat[] = [];
  const boatMat = track(new THREE.MeshLambertMaterial({ vertexColors: true }));
  const addBoat = (
    geo: THREE.BufferGeometry,
    kind: Boat['kind'],
    dx: number,
    dy: number,
    rot: number,
    scale: number,
    opts: { from?: { x: number; y: number }; to?: { x: number; y: number }; t?: number; speed?: number; anchored?: boolean } = {},
  ): void => {
    const mesh = new THREE.Mesh(track(geo), boatMat);
    const p = designToWorld(dx, dy);
    mesh.position.set(p.x, WATER_SURFACE_Y + 0.02, p.z);
    mesh.rotation.y = rot;
    mesh.scale.setScalar(scale * landmarkScale);
    mesh.castShadow = true;
    track(mesh);
    group.add(mesh);
    boats.push({
      mesh,
      kind,
      t: opts.t ?? 0,
      speed: opts.speed ?? 0.05,
      bobPhase: hash(kind.length + boats.length, 3, seed + 701) * 6.28,
      baseRot: rot,
      anchored: opts.anchored ?? false,
      from: opts.from ? designToWorld(opts.from.x, opts.from.y) : undefined,
      to: opts.to ? designToWorld(opts.to.x, opts.to.y) : undefined,
    });
  };
  const ferryGeo = track(createStarFerryGeometry());
  addBoat(ferryGeo, 'ferry', 43, 54.5, -Math.PI / 2 + 0.3, 1.1, {
    from: { x: 41.5, y: 55.6 },
    to: { x: 45.5, y: 52.0 },
    t: 0.1,
    speed: 0.035,
  });
  addBoat(ferryGeo, 'ferry', 48, 54.5, -Math.PI / 2 - 0.4, 1.05, {
    from: { x: 48.5, y: 55.6 },
    to: { x: 51.5, y: 52.4 },
    t: 0.62,
    speed: 0.03,
  });
  const junkGeo = track(createJunkBoatGeometry());
  addBoat(junkGeo, 'junk', 31, 80, 0.8, 1.1, { from: { x: 30, y: 79.5 }, to: { x: 37, y: 78.5 }, t: 0.2, speed: 0.025 });
  addBoat(junkGeo, 'junk', 63, 57, 2.2, 1.0, { anchored: true });
  addBoat(junkGeo, 'junk', 22, 75, 1.4, 0.95, { anchored: true });
  const cargoGeo = track(createCargoShipGeometry());
  addBoat(cargoGeo, 'cargo', 30, 55.5, 0.1, 1.0, { from: { x: 12, y: 52 }, to: { x: 34, y: 55.5 }, t: 0.45, speed: 0.012 });
  const fishingGeo = track(createFishingBoatGeometry());
  const fishingSpots: [number, number, number][] = [
    [33, 78.5, 0.4],
    [34.5, 79.5, 1.8],
    [20, 77.5, 2.4],
    [21.5, 78.6, 0.9],
    [69.5, 63.5, 1.2],
    [70.5, 64.6, 2.7],
    [38, 57.8, 0.3],
  ];
  for (const [dx, dy, rot] of fishingSpots) {
    addBoat(fishingGeo, 'fishing', dx, dy, rot, 1.0, { anchored: true });
  }

  // ───────────── 10. 逐格顏色（季節、積雪、地貌） ─────────────

  const applyTerrainColors = (): void => {
    const c = new THREE.Color();
    const f = new THREE.Color();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const tile = state.tiles[i];
        const ti = topIndex[i];
        if (ti >= 0) {
          computeTopColor(tile, x, y, c);
          topMesh.setColorAt(ti, c);
        }
        switch (tile.terrain) {
          case 'water':
            f.setHex(0x2a3f45);
            break;
          case 'sand':
            f.setHex(0xad9a6e);
            break;
          case 'wetland':
            f.setHex(0x4a5a44);
            break;
          case 'fertile':
            f.setHex(0x5b4c34);
            break;
          case 'forest':
            f.setHex(0x3f4530);
            break;
          case 'urban':
          case 'reclaimed':
            f.setHex(0x66645f);
            break;
          case 'hill':
            f.setHex(0x6b6149);
            break;
          case 'mountain':
            f.setHex(0x635f59);
            break;
          default:
            f.setHex(0x5f5138);
            break;
        }
        f.multiplyScalar(0.85 + tile.variant * 0.25);
        if (appliedSnow > 0.001) f.lerp(WHITE, clamp01(appliedSnow * 0.3));
        const fi = foundationIndex[i];
        if (fi >= 0) foundationMesh.setColorAt(fi, f);
      }
    }
    if (topMesh.instanceColor) topMesh.instanceColor.needsUpdate = true;
    if (foundationMesh.instanceColor) foundationMesh.instanceColor.needsUpdate = true;
  };

  /** 單格地表色（含季節與山頂積雪） */
  let currentWeather: Weather = state.clock.weather;
  let currentTemp = state.clock.tempC;
  const computeTopColor = (tile: Tile, x: number, y: number, out: THREE.Color): THREE.Color => {
    const snow = clamp01(appliedSnow);
    const e = tile.elevation;
    switch (tile.terrain) {
      case 'grass':
        out.copy(seasonC.grass);
        out.lerp(_c1.setHex(hash(x >> 2, y >> 2, seed + 271) > 0.5 ? 0x9fb264 : 0x7fa452), 0.2);
        break;
      case 'fertile': {
        out.copy(seasonC.fertile);
        const p = hash(x >> 1, y >> 1, seed + 1777);
        out.lerp(_c1.setHex(p > 0.62 ? 0xc2b566 : p < 0.3 ? 0x8fae55 : 0xa9c065), 0.38);
        // 部分田塊蓄水（水田）
        if (hash(Math.floor(x / 3), Math.floor(y / 3), seed + 1891) < 0.4) {
          out.lerp(_c1.setHex(0x7fa8a0), 0.26);
        }
        break;
      }
      case 'wetland':
        out.copy(seasonC.wetland);
        out.lerp(_c1.setHex(0x47624a), hash(x, y, seed + 1789) * 0.4);
        break;
      case 'forest':
        out.copy(seasonC.forest);
        out.lerp(_c1.setHex(0x35502f), hash(x, y, seed + 1791) * 0.35);
        break;
      case 'hill':
        out.copy(seasonC.hill);
        out.lerp(_c1.setHex(0x968f68), hash(x, y, seed + 55) * 0.3);
        break;
      case 'mountain':
        out.copy(seasonC.mountain);
        out.lerp(_c1.setHex(0x8a8880), hash(x, y, seed + 56) * 0.3);
        break;
      case 'urban':
        out.copy(seasonC.urban);
        // 市區：地磚／樓宇陰影分佈
        out.lerp(_c1.setHex(hash(x >> 1, y >> 1, seed + 1793) > 0.5 ? 0xa9a9a2 : 0x7f807a), 0.3);
        break;
      case 'reclaimed':
        out.copy(seasonC.reclaimed);
        out.lerp(_c1.setHex(0xa2a296), hash(x, y, seed + 1795) * 0.25);
        break;
      case 'sand':
        out.copy(seasonC.sand);
        break;
      case 'water':
      default:
        out.setHex(0x3d5a5e);
        break;
    }
    // ── 深圳河北岸合成區（Issue #4）：降低 flat urban 灰、加森林／海岸過渡 ──
    // 資料上北岸係人工合成矩形；render 側用 noise 把市區色混入草地／林地，
    // 海邊格混沙岩色，並喺地圖最北邊緣淡入海色，避免 overview 見到直線灰色大塊。
    if (isShenzhenSideTile(x, y, width, height)) {
      const n1 = hash(x >> 1, y >> 1, seed + 9001);
      if (tile.terrain === 'urban' || tile.terrain === 'reclaimed') {
        const density = tile.density ?? 0;
        const urbanMix = clamp01(density / 160);
        _c1.copy(seasonC.grass).lerp(seasonC.forest, n1 * 0.55);
        _c1.multiplyScalar(0.84 + n1 * 0.22);
        out.lerp(_c1, 0.26 + (1 - urbanMix) * 0.4);
        out.multiplyScalar(0.8 + n1 * 0.14);
        // 海岸過渡：貼住水嘅格混深沙岩／灘色
        if (isWater(x + 1, y) || isWater(x - 1, y) || isWater(x, y + 1) || isWater(x, y - 1)) {
          out.lerp(_c1.setHex(0x7d7f6e), 0.45 + n1 * 0.15);
        }
      } else if (tile.terrain === 'grass' || tile.terrain === 'forest') {
        out.multiplyScalar(0.9 + n1 * 0.12);
      }
      // 地圖最北邊緣淡入海色（只影響深圳側，唔郁香港島海岸）
      if (y < 7) {
        out.lerp(_c1.setHex(0x334a52), ((7 - y) / 7) * 0.42);
      }
    }

    // 每格微差異
    const shade = 0.92 + tile.variant * 0.16;
    out.multiplyScalar(shade * seasonC.vivid);
    // 平地薄雪（寒潮）與山頂積雪
    if (tile.terrain !== 'water') {
      const mountainSnow = mountainSnowAmount(paletteSeason, currentWeather, currentTemp, e);
      const flatSnow = snow * (tile.terrain === 'urban' || tile.terrain === 'reclaimed' ? 0.25 : 0.45);
      const amount = clamp01(mountainSnow * (tile.terrain === 'mountain' ? 1 : tile.terrain === 'hill' ? 0.6 : 0.25) + flatSnow);
      if (amount > 0.001) out.lerp(WHITE, amount);
    }
    return out;
  };

  // 設定地基與地表矩陣
  {
    const dummy = new THREE.Object3D();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const tile = state.tiles[i];
        const { x: wx, z: wz } = tileWorld(x, y, width, height);
        const top = topY[i];
        const fi = foundationIndex[i];
        if (fi >= 0) {
          dummy.position.set(wx, 0, wz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, top, 1);
          dummy.updateMatrix();
          foundationMesh.setMatrixAt(fi, dummy.matrix);
        }
        const ti = topIndex[i];
        if (ti >= 0) {
          dummy.position.set(wx, top + 0.006, wz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          topMesh.setMatrixAt(ti, dummy.matrix);
        }
      }
    }
    foundationMesh.instanceMatrix.needsUpdate = true;
    topMesh.instanceMatrix.needsUpdate = true;
  }

  // ───────────── 11. 季節色調 ─────────────

  interface TintSet {
    banyan: THREE.Color;
    broadleaf: THREE.Color;
    bauhinia: THREE.Color;
    palm: THREE.Color;
    pine: THREE.Color;
    willow: THREE.Color;
    shrub: THREE.Color;
    grass: THREE.Color;
    flower: THREE.Color;
    reed: THREE.Color;
    rock: THREE.Color;
    crag: THREE.Color;
    distant: THREE.Color;
    container: THREE.Color;
    crop: THREE.Color;
  }
  const tints: TintSet = {
    banyan: new THREE.Color(1, 1, 1),
    broadleaf: new THREE.Color(1, 1, 1),
    bauhinia: new THREE.Color(1, 1, 1),
    palm: new THREE.Color(1, 1, 1),
    pine: new THREE.Color(1, 1, 1),
    willow: new THREE.Color(1, 1, 1),
    shrub: new THREE.Color(1, 1, 1),
    grass: new THREE.Color(1, 1, 1),
    flower: new THREE.Color(1, 1, 1),
    reed: new THREE.Color(1, 1, 1),
    rock: new THREE.Color(1, 1, 1),
    crag: new THREE.Color(1, 1, 1),
    distant: new THREE.Color(1, 1, 1),
    container: new THREE.Color(1, 1, 1),
    crop: new THREE.Color(1, 1, 1),
  };

  const computeTints = (snow: number): void => {
    switch (paletteSeason) {
      case 'spring':
        tints.banyan.setRGB(0.95, 1.1, 0.93);
        tints.broadleaf.setRGB(1.0, 1.12, 0.9);
        tints.bauhinia.setRGB(1.4, 0.92, 1.0);
        tints.palm.setRGB(1.0, 1.08, 0.9);
        tints.pine.setRGB(0.92, 1.06, 0.92);
        tints.willow.setRGB(1.05, 1.14, 0.85);
        tints.shrub.setRGB(0.98, 1.12, 0.9);
        tints.grass.setRGB(1.02, 1.1, 0.9);
        tints.flower.setRGB(1.3, 1.15, 1.2);
        tints.reed.setRGB(1.0, 1.08, 0.86);
        tints.crop.setRGB(1.05, 1.15, 0.9);
        break;
      case 'summer':
        tints.banyan.setRGB(0.96, 1.02, 0.95);
        tints.broadleaf.setRGB(0.98, 1.04, 0.95);
        tints.bauhinia.setRGB(1.02, 1.02, 0.98);
        tints.palm.setRGB(0.96, 1.02, 0.94);
        tints.pine.setRGB(0.94, 1.0, 0.94);
        tints.willow.setRGB(0.98, 1.04, 0.92);
        tints.shrub.setRGB(0.94, 1.0, 0.92);
        tints.grass.setRGB(0.82, 0.98, 0.78);
        tints.flower.setRGB(1.2, 1.12, 1.15);
        tints.reed.setRGB(0.94, 1.0, 0.82);
        tints.crop.setRGB(0.86, 1.0, 0.78);
        break;
      case 'autumn':
        tints.banyan.setRGB(1.05, 0.98, 0.82);
        tints.broadleaf.setRGB(1.35, 0.95, 0.6);
        tints.bauhinia.setRGB(1.15, 0.9, 0.75);
        tints.palm.setRGB(1.08, 0.98, 0.78);
        tints.pine.setRGB(0.92, 0.94, 0.8);
        tints.willow.setRGB(1.25, 1.0, 0.7);
        tints.shrub.setRGB(1.2, 1.0, 0.7);
        tints.grass.setRGB(1.28, 1.02, 0.68);
        tints.flower.setRGB(1.2, 1.0, 0.85);
        tints.reed.setRGB(1.28, 1.05, 0.68);
        tints.crop.setRGB(1.22, 1.0, 0.72);
        break;
      case 'winter':
        tints.banyan.setRGB(0.8, 0.88, 0.84);
        tints.broadleaf.setRGB(0.78, 0.72, 0.62);
        tints.bauhinia.setRGB(0.8, 0.72, 0.68);
        tints.palm.setRGB(0.78, 0.82, 0.78);
        tints.pine.setRGB(0.78, 0.86, 0.88);
        tints.willow.setRGB(0.82, 0.78, 0.68);
        tints.shrub.setRGB(0.8, 0.82, 0.74);
        tints.grass.setRGB(1.1, 1.06, 0.92);
        tints.flower.setRGB(0.7, 0.7, 0.7);
        tints.reed.setRGB(1.05, 1.0, 0.84);
        tints.crop.setRGB(0.92, 0.92, 0.82);
        break;
    }
    tints.rock.setRGB(0.98 + snow * 0.3, 0.98 + snow * 0.31, 0.98 + snow * 0.33);
    tints.crag.setRGB(1.0 + snow * 0.45, 1.0 + snow * 0.47, 1.0 + snow * 0.5);
    tints.distant.setRGB(0.36 + snow * 0.3, 0.42 + snow * 0.3, 0.5 + snow * 0.3);
    tints.container.setRGB(1, 1, 1);
    if (snow > 0.001) {
      const blend = (c: THREE.Color, amount: number): void => {
        c.lerp(SNOW_TINT, clamp01(snow * amount));
      };
      blend(tints.banyan, 0.5);
      blend(tints.broadleaf, 0.5);
      blend(tints.bauhinia, 0.45);
      blend(tints.shrub, 0.55);
      blend(tints.grass, 0.5);
      blend(tints.reed, 0.5);
      blend(tints.crop, 0.4);
    }
  };

  const applyLayerTints = (): void => {
    const c = new THREE.Color();
    for (const layer of layers) {
      if (layer.mesh.count === 0) continue;
      const tint = tints[layer.kind];
      for (let i = 0; i < layer.list.length; i++) {
        const h = layer.list[i].hash;
        const f = 0.84 + h * 0.32;
        if (layer.kind === 'container') {
          // 貨櫃：紅、藍、綠、黃、橙等繽紛顏色（香港貨櫃碼頭）
          const palette = [0xb03a32, 0x2f6f9f, 0x3f8f5f, 0xd9a63f, 0x8a8f96, 0xc4703a];
          c.setHex(palette[Math.floor(h * palette.length) % palette.length]);
          c.multiplyScalar(0.85 + h * 0.25);
        } else if (layer.kind === 'crop') {
          c.setRGB(tint.r * f, tint.g * f, tint.b * f);
        } else {
          c.setRGB(tint.r * f, tint.g * f, tint.b * f);
        }
        layer.mesh.setColorAt(i, c);
      }
      if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true;
    }
  };

  // ───────────── 12. 佔用隱藏（道路／建築覆蓋處） ─────────────

  const occupancy = new Uint8Array(count);
  let occupancyBuildings = -1;
  let occupancyRoads = -1;
  let lastRevision = -1;

  const rebuildOccupancy = (s: GameState): void => {
    occupancy.fill(0);
    let roads = 0;
    for (let i = 0; i < count; i++) {
      const t = s.tiles[i];
      if (t.buildingId >= 0) occupancy[i] = 1;
      else if (t.road) {
        occupancy[i] = 1;
        roads++;
      } else if (t.sidewalk) {
        // 行人路上的樹木隱藏，避免穿模
        occupancy[i] = 1;
      }
    }
    occupancyBuildings = s.buildings.length;
    occupancyRoads = roads;
    lastRevision = s.ui.revision;
    const dummy = new THREE.Object3D();
    for (const layer of layers) {
      if (!layer.occupancy || !layer.matrixBase) continue;
      const base = layer.matrixBase;
      const n = layer.list.length;
      let dirty = false;
      for (let i = 0; i < n; i++) {
        const ti = layer.list[i].tile;
        if (ti >= 0 && occupancy[ti]) {
          dummy.position.set(0, -50, 0);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(0.001, 0.001, 0.001);
          dummy.updateMatrix();
          layer.mesh.setMatrixAt(i, dummy.matrix);
          dirty = true;
        } else {
          const o = i * 16;
          for (let k = 0; k < 16; k++) dummy.matrix.elements[k] = base[o + k];
          layer.mesh.setMatrixAt(i, dummy.matrix);
        }
      }
      if (dirty || layer.matrixBase) layer.mesh.instanceMatrix.needsUpdate = true;
    }
    // 濕地水窪
    if (poolMesh) {
      let dirty = false;
      for (let i = 0; i < wetlandPools.length; i++) {
        const ti = wetlandPools[i].tile;
        if (ti >= 0 && occupancy[ti]) {
          dummy.position.set(0, -50, 0);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(0.001, 0.001, 0.001);
          dummy.updateMatrix();
          poolMesh.setMatrixAt(i, dummy.matrix);
          dirty = true;
        }
      }
      if (dirty) poolMesh.instanceMatrix.needsUpdate = true;
    }
    // 遠景樓群：只在「道路／建築」格隱藏；行人路旁可以繼續有樓景（更似香港街景）
    const dummy2 = new THREE.Object3D();
    for (const bl of buildingLayers) {
      for (let i = 0; i < bl.list.length; i++) {
        const ti = bl.list[i].tile;
        const t = ti >= 0 ? s.tiles[ti] : null;
        const hidden = !!t && (t.buildingId >= 0 || t.road);
        if (hidden) {
          dummy2.position.set(0, -60, 0);
          dummy2.scale.set(0.001, 0.001, 0.001);
          dummy2.updateMatrix();
          bl.mesh.setMatrixAt(i, dummy2.matrix);
        } else {
          const o = i * 16;
          for (let k = 0; k < 16; k++) dummy2.matrix.elements[k] = bl.matrixBase[o + k];
          bl.mesh.setMatrixAt(i, dummy2.matrix);
        }
      }
      bl.mesh.instanceMatrix.needsUpdate = true;
    }
    // 天台雜物
    const hideOrRestore = (mesh: THREE.InstancedMesh | null, list: { tile: number }[], base: Float32Array | null): void => {
      if (!mesh || !base) return;
      for (let i = 0; i < list.length; i++) {
        const ti = list[i].tile;
        if (ti >= 0 && occupancy[ti]) {
          dummy2.position.set(0, -60, 0);
          dummy2.rotation.set(0, 0, 0);
          dummy2.scale.set(0.001, 0.001, 0.001);
          dummy2.updateMatrix();
          mesh.setMatrixAt(i, dummy2.matrix);
        } else {
          const o = i * 16;
          for (let k = 0; k < 16; k++) dummy2.matrix.elements[k] = base[o + k];
          mesh.setMatrixAt(i, dummy2.matrix);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
    };
    hideOrRestore(roofTankMesh, roofTanks, roofTankBase);
    hideOrRestore(roofAntennaMesh, roofAntennas, roofAntennaBase);
  };

  const checkOccupancy = (s: GameState): void => {
    if (s.ui.revision === lastRevision && s.buildings.length === occupancyBuildings) return;
    let roads = 0;
    for (let i = 0; i < count; i++) if (s.tiles[i].road || s.tiles[i].sidewalk) roads++;
    if (s.buildings.length === occupancyBuildings && roads === occupancyRoads) {
      lastRevision = s.ui.revision;
      return;
    }
    rebuildOccupancy(s);
  };

  // ───────────── 13. 初始化 ─────────────

  computeTints(0);
  applyTerrainColors();
  applyLayerTints();
  rebuildOccupancy(state);

  // ───────────── 14. 每幀更新 ─────────────

  const sun: SunState = createSunState();
  const skyPalette = createSkyPalette();
  const moonDir = new THREE.Vector3();
  let time = 0;
  let lastSeason: Season = state.clock.season;
  let lastSnow = -1;
  let lastWeather: string = state.clock.weather;
  let nightFactor = 0;

  const applyPalette = (s: GameState): void => {
    const snow = snowCover(s.clock.season, s.clock.weather, s.clock.tempC);
    seasonColors(s.clock.season, seasonC);
    currentWeather = s.clock.weather;
    currentTemp = s.clock.tempC;
    paletteSeason = s.clock.season;
    appliedSnow = snow;
    computeTints(snow);
    applyTerrainColors();
    applyLayerTints();
    const deep = waterUniforms.uDeepColor.value as THREE.Color;
    const shallow = waterUniforms.uShallowColor.value as THREE.Color;
    deep.setHex(WATER_DEEP[s.clock.season]);
    shallow.setHex(WATER_SHALLOW[s.clock.season]);
    outerSeaMat.color.copy(deep);
    lastSeason = s.clock.season;
    lastSnow = snow;
    lastWeather = s.clock.weather;
  };
  applyPalette(state);

  return {
    group,
    update(s: GameState, dt: number): void {
      time += dt;
      windMat.time.value = time;
      const wind = windStrength(s.clock.weather, s.clock.weatherIntensity);
      windMat.wind.value = wind * 0.6;
      const { clock } = s;
      computeSun(clock.hour, clock.minute, clock.season, sun);
      computeMoonDir(clock.hour, clock.minute, clock.season, moonDir);
      sampleSkyPalette(clock.season, clock.weather, sun.daylight, skyPalette);
      const fog = fogRange(clock.weather, sun.daylight, mapViewScale(width, height));
      const storm = clock.weather === 'storm' ? clamp01(0.35 + clock.weatherIntensity * 0.65) : 0;
      const rain = clock.weather === 'rain' ? 0.4 + clock.weatherIntensity * 0.6 : storm;

      waterUniforms.uDetailScale.value = mapViewScale(width, height);
      waterUniforms.uTime.value = time;
      waterUniforms.uWave.value = 0.008 + wind * 0.008;
      waterUniforms.uStorm.value = storm;
      waterUniforms.uRain.value = rain;
      (waterUniforms.uSunDir.value as THREE.Vector3).copy(sun.elevation > -0.02 ? sun.dir : moonDir);
      (waterUniforms.uSunColor.value as THREE.Color)
        .copy(sun.elevation > -0.02 ? skyPalette.sun : skyPalette.moon)
        .multiplyScalar(sun.daylight > 0.02 ? 1 : 0.45);
      (waterUniforms.uSkyColor.value as THREE.Color).copy(skyPalette.zenith);
      (waterUniforms.uHorizonColor.value as THREE.Color).copy(skyPalette.horizon);
      (waterUniforms.uFogColor.value as THREE.Color).copy(skyPalette.fog);
      waterUniforms.uFogNear.value = fog.near;
      waterUniforms.uFogFar.value = fog.far;
      waterUniforms.uDaylight.value = 0.12 + sun.daylight * 0.9;
      const ice = clamp01((3 - clock.tempC) / 9) * (clock.season === 'winter' ? 1 : 0.25);
      waterUniforms.uIce.value = ice;
      nightFactor = clamp01(1 - sun.daylight * 1.3);
      waterUniforms.uCityGlow.value = nightFactor * clamp01(0.25 + s.buildings.length * 0.012) * (clock.weather === 'storm' ? 0.6 : 1);
      (waterUniforms.uNeon.value as THREE.Color).setHex(clock.season === 'winter' ? 0xffb060 : 0xff8a4a);

      // 季節／積雪／天氣變化 → 重新上色
      const snow = snowCover(clock.season, clock.weather, clock.tempC);
      if (clock.season !== lastSeason || Math.abs(snow - lastSnow) > 0.12 || clock.weather !== lastWeather) {
        applyPalette(s);
      }

      // 夜間樓群窗光
      const night = clamp01(1 - sun.daylight * 1.25);
      const emissive = night * (clock.weather === 'storm' ? 0.75 : 1);
      for (const kind of ['tower', 'block', 'office'] as const) {
        const mats = facadeMat[kind];
        if (!mats) continue;
        for (const m of mats) {
          const lm = m as THREE.MeshLambertMaterial;
          if (lm.emissiveIntensity !== undefined) lm.emissiveIntensity = emissive * (kind === 'tower' ? 1.45 : kind === 'block' ? 1.0 : 0.85);
        }
      }
      // 地標摩天輪轉動
      for (const lm of landmarks) {
        if (lm.spin) lm.mesh.rotation.z += dt * lm.spin;
      }

      // 船隻
      for (const b of boats) {
        if (!b.anchored && b.from && b.to) {
          b.t += dt * b.speed;
          if (b.t > 1) {
            b.t = 0;
            // 來回：交換起訖
            const tmp = b.from;
            b.from = b.to;
            b.to = tmp;
          }
          const x = b.from.x + (b.to.x - b.from.x) * b.t;
          const z = b.from.z + (b.to.z - b.from.z) * b.t;
          b.mesh.position.x = x;
          b.mesh.position.z = z;
          const dx = b.to.x - b.from.x;
          const dz = b.to.z - b.from.z;
          b.mesh.rotation.y = Math.atan2(dx, dz) + Math.PI / 2;
        }
        b.mesh.position.y = WATER_SURFACE_Y + 0.02 + Math.sin(time * 0.9 + b.bobPhase) * (0.015 + storm * 0.06);
        const roll = Math.sin(time * 0.7 + b.bobPhase) * (0.02 + storm * 0.08);
        b.mesh.rotation.z = b.anchored ? roll : Math.sin(time * 0.5 + b.bobPhase) * 0.02;
        if (!b.anchored) b.mesh.rotation.x = Math.sin(time * 0.8 + b.bobPhase) * (0.008 + storm * 0.03);
      }

      checkOccupancy(s);

      // ── 機場／貨櫃碼頭裝飾視覺 gate（Round 5）──
      // starter 照舊顯示；empty 由玩家建成相關建築後才出現。
      const hasKeys = (keys: readonly string[]): boolean => s.buildings.some((b) => keys.includes(b.key));
      airportDecor.visible = s.gameMode === 'starter' || hasKeys(['airportTerminal', 'airCargoTerminal']);
      airportTraffic?.update(s, dt);
      const showPortDecor = s.gameMode === 'starter' || hasKeys(['containerPort', 'portGate', 'portYard']);
      for (const layer of layers) {
        if (layer.kind === 'container') layer.mesh.visible = showPortDecor && layer.list.length > 0;
      }
    },
    dispose(): void {
      airportTraffic?.dispose();
      airportTraffic = null;
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      group.clear();
    },
  };
}
