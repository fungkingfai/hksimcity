/**
 * 香港道路與行人路渲染。
 *
 * - 瀝青馬路：程序化瀝青貼圖 + 逐格車道線（白虛線／路邊白線／部分路段雙黃線）、
 *   路口、斑馬線、停止線；跟隨地形高度（丘陵路段逐級抬升）。
 * - 行人路：玩家鋪設的 sidewalk 格（灰磚或紅白磚），以及馬路兩側自動生成的人行道
 *   視覺（含路緣石）；海旁路段自動加金屬欄杆。
 * - 街道家具：路燈（夜間發光＋地面光暈）、巴士站、電車軌（港島北岸走廊）。
 * - 過海隧道：維港水域上的道路格（worldgen 預置的西隧／紅隧／東隧）以
 *   半透明隧道管 + 海底隧道入口牌呈現，不會像普通馬路浮在水面。
 *
 * 效能：所有路面、標線、行人路、欄杆、路燈、電車軌、隧道管皆以 InstancedMesh 繪製，
 * 只在道路／行人路集合改變時重建（以 ui.revision + signature 偵測）。
 */

import * as THREE from 'three';
import { HK_TUNNELS } from '../world/worldgen';
import type { GameState } from '../core/types';
import { hash2d } from '../core/rng';
import { TILE, tileWorld } from './coords';
import {
  createAsphaltTexture,
  createBusStopGeometry,
  createMetalRailingGeometry,
  createPavementTexture,
  createStreetLampGeometry,
} from './world-geometry';
import { roadSurfaceY } from './world-utils';

export interface RoadsView {
  group: THREE.Group;
  update(state: GameState, dt: number): void;
  dispose(): void;
}

// ─────────────────────────── 小工具 ───────────────────────────

function makeCanvas(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

/** 海底隧道入口牌（綠底白字，香港快速公路指示牌風格） */
function createTunnelSignTexture(name: string): THREE.Texture | null {
  const canvas = makeCanvas(512, 128);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // 圓角綠底
  ctx.fillStyle = '#0f5a3a';
  ctx.beginPath();
  ctx.roundRect(4, 4, 504, 120, 14);
  ctx.fill();
  ctx.strokeStyle = '#f2f4f0';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.roundRect(12, 12, 488, 104, 10);
  ctx.stroke();
  ctx.fillStyle = '#f4f7f2';
  ctx.font = 'bold 64px "Noto Sans TC", "PingFang HK", "Microsoft JhengHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, 256, 70);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

const WHITE_MARK = 0xf2f2ea;
const YELLOW_MARK = 0xf0c53c;

export function createRoadsView(state: GameState): RoadsView {
  const group = new THREE.Group();
  group.name = 'roads';

  const seed = state.seed >>> 0;
  const width = state.width;
  const height = state.height;
  const kx = width / 96;
  const ky = height / 96;
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };
  const makeMesh = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    count: number,
    name: string,
    castShadow = false,
  ): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
    mesh.name = name;
    mesh.count = count;
    mesh.visible = count > 0;
    mesh.receiveShadow = true;
    mesh.castShadow = castShadow;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };

  // ─────────── 共用幾何／材質 ───────────

  const asphaltTex = createAsphaltTexture();
  const pavementGreyTex = createPavementTexture('grey', 5);
  const pavementRedTex = createPavementTexture('red', 9);
  if (asphaltTex) track(asphaltTex);
  if (pavementGreyTex) track(pavementGreyTex);
  if (pavementRedTex) track(pavementRedTex);

  /** 馬路石板：頂面在原點（y=0），厚度 0.1 */
  const slabGeo = track(new THREE.BoxGeometry(TILE * 0.995, 0.1, TILE * 0.995));
  slabGeo.translate(0, -0.05, 0);
  const asphaltMat = track(
    new THREE.MeshLambertMaterial({
      color: 0xffffff,
      map: asphaltTex ?? undefined,
    }),
  );

  /** #10：existing 窄街專用（0.52 tile 闊、深灰、無標線） */
  const localSlabGeo = track(new THREE.BoxGeometry(TILE * 0.52, 0.07, TILE * 0.52));
  localSlabGeo.translate(0, -0.035, 0);
  const localAsphaltMat = track(
    new THREE.MeshLambertMaterial({ color: 0x50565a, map: asphaltTex ?? undefined }),
  );

  /** #11：高架橋面＋柱 */
  const elevatedDeckGeo = track(new THREE.BoxGeometry(TILE * 0.96, 0.16, TILE * 0.96));
  elevatedDeckGeo.translate(0, -0.08, 0);
  const elevatedDeckMat = track(new THREE.MeshLambertMaterial({ color: 0x9aa1a4 }));
  const elevatedColumnGeo = track(new THREE.BoxGeometry(0.32, 2.3, 0.32));
  const elevatedColumnMat = track(new THREE.MeshLambertMaterial({ color: 0x7f8588 }));

  /** #11：隧道（地面標線＋入口龍門＋U 層隧道管） */
  const tunnelRouteGeo = track(new THREE.BoxGeometry(TILE * 0.5, 0.03, TILE * 0.5));
  tunnelRouteGeo.translate(0, 0.015, 0);
  const tunnelRouteMat = track(
    new THREE.MeshBasicMaterial({ color: 0x1f2a30, transparent: true, opacity: 0.72, depthWrite: false }),
  );
  const tunnelPortalGeo = track(new THREE.BoxGeometry(TILE * 0.92, 2.2, 0.28));
  const tunnelPortalMat = track(new THREE.MeshLambertMaterial({ color: 0x8b9094 }));
  const tunnelDashGeo = track(new THREE.BoxGeometry(0.42, 0.05, 0.42));
  const tunnelDashMat = track(
    new THREE.MeshBasicMaterial({ color: 0x8fe3ff, transparent: true, opacity: 0.85, depthWrite: false, fog: false }),
  );
  const tunnelTubeGeo = track(new THREE.BoxGeometry(TILE * 0.42, 0.06, TILE * 0.88));
  tunnelTubeGeo.translate(0, 0.03, 0);
  const tunnelTubeMat = track(
    new THREE.MeshBasicMaterial({
      color: 0x7fd6ff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      depthTest: false,
      fog: false,
    }),
  );

  /** 行人路整格板（玩家鋪設的 sidewalk） */
  const walkSlabGeo = track(new THREE.BoxGeometry(TILE * 0.995, 0.11, TILE * 0.995));
  walkSlabGeo.translate(0, -0.055, 0);
  const walkGreyMat = track(
    new THREE.MeshLambertMaterial({ color: 0xffffff, map: pavementGreyTex ?? undefined }),
  );
  const walkRedMat = track(
    new THREE.MeshLambertMaterial({ color: 0xffffff, map: pavementRedTex ?? undefined }),
  );

  /** 馬路兩側自動人行道：沿格邊的長條（闊 0.62） */
  const stripGeo = track(new THREE.BoxGeometry(TILE, 0.12, 0.62));
  stripGeo.translate(0, -0.06, 0);
  {
    // 沿長邊重複地磚貼圖，避免每格只有一塊巨大磚
    const uv = stripGeo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 3.2, uv.getY(i) * 1.2);
    uv.needsUpdate = true;
  }
  const stripGreyMat = track(
    new THREE.MeshLambertMaterial({ color: 0xffffff, map: pavementGreyTex ?? undefined }),
  );
  const stripRedMat = track(
    new THREE.MeshLambertMaterial({ color: 0xffffff, map: pavementRedTex ?? undefined }),
  );

  /** 路緣石 */
  const kerbGeo = track(new THREE.BoxGeometry(TILE * 0.99, 0.1, 0.14));
  kerbGeo.translate(0, 0.02, 0);
  const kerbMat = track(new THREE.MeshLambertMaterial({ color: 0xa4a7a2 }));

  /** 標線：單位方塊，逐實例縮放（長度用沿車道方向） */
  const markGeo = track(new THREE.BoxGeometry(1, 0.014, 1));
  markGeo.translate(0, 0.004, 0);
  const whiteMarkMat = track(new THREE.MeshLambertMaterial({ color: WHITE_MARK }));
  const yellowMarkMat = track(new THREE.MeshLambertMaterial({ color: YELLOW_MARK }));

  /** 電車軌 */
  const railGeo = track(new THREE.BoxGeometry(TILE * 0.99, 0.02, 0.07));
  const railMat = track(new THREE.MeshLambertMaterial({ color: 0x9aa3a8, emissive: 0x111111, emissiveIntensity: 0.2 }));

  /** 路燈 */
  const lampGeo = track(createStreetLampGeometry());
  const lampMat = track(
    new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0xffe6a8, emissiveIntensity: 0 }),
  );
  const lampGlowGeo = track(new THREE.PlaneGeometry(1.9, 1.9));
  lampGlowGeo.rotateX(-Math.PI / 2);
  const lampGlowMat = track(
    new THREE.MeshBasicMaterial({
      color: 0xffd98a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );

  /** 巴士站 */
  const busStopGeo = track(createBusStopGeometry());
  const busStopMat = track(new THREE.MeshLambertMaterial({ vertexColors: true }));

  /** 金屬欄杆（海旁） */
  const railingGeo = track(createMetalRailingGeometry());
  const railingMat = track(new THREE.MeshLambertMaterial({ vertexColors: true }));

  /** 隧道：管身 + 管壁 + 入口牌 */
  const tunnelDeckGeo = track(new THREE.BoxGeometry(TILE * 1.005, 0.08, TILE * 1.005));
  tunnelDeckGeo.translate(0, -0.04, 0);
  const tunnelMat = track(
    new THREE.MeshLambertMaterial({ color: 0x2a3f47, emissive: 0x1b3a44, emissiveIntensity: 0.25 }),
  );
  const tunnelWallGeo = track(new THREE.BoxGeometry(0.08, 0.42, TILE * 1.02));
  tunnelWallGeo.translate(0, 0.21, 0);
  const tunnelWallMat = track(
    new THREE.MeshLambertMaterial({
      color: 0x9fd2d8,
      transparent: true,
      opacity: 0.5,
      emissive: 0x1a4650,
      emissiveIntensity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const portalGeo = track(
    (() => {
      const parts: THREE.BufferGeometry[] = [];
      const pillarGeo = new THREE.BoxGeometry(0.18, 1.5, 0.24);
      pillarGeo.translate(-1.02, 0.75, 0);
      parts.push(pillarGeo);
      const pillar2 = new THREE.BoxGeometry(0.18, 1.5, 0.24);
      pillar2.translate(1.02, 0.75, 0);
      parts.push(pillar2);
      const lintel = new THREE.BoxGeometry(2.28, 0.22, 0.26);
      lintel.translate(0, 1.58, 0);
      parts.push(lintel);
      const band = new THREE.BoxGeometry(2.28, 0.1, 0.3);
      band.translate(0, 1.34, 0);
      parts.push(band);
      const p0 = parts[0].getAttribute('position') as THREE.BufferAttribute;
      const p1 = parts[1].getAttribute('position') as THREE.BufferAttribute;
      const p2 = parts[2].getAttribute('position') as THREE.BufferAttribute;
      const p3 = parts[3].getAttribute('position') as THREE.BufferAttribute;
      const total = p0.count + p1.count + p2.count + p3.count;
      const pos = new Float32Array(total * 3);
      const nor = new Float32Array(total * 3);
      const uv = new Float32Array(total * 2);
      let off = 0;
      for (const part of parts) {
        const pp = part.getAttribute('position') as THREE.BufferAttribute;
        const nn = part.getAttribute('normal') as THREE.BufferAttribute;
        const uu = part.getAttribute('uv') as THREE.BufferAttribute;
        pos.set(pp.array as Float32Array, off * 3);
        nor.set(nn.array as Float32Array, off * 3);
        if (uu) uv.set(uu.array as Float32Array, off * 2);
        off += pp.count;
        part.dispose();
      }
      const merged = new THREE.BufferGeometry();
      merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      return merged;
    })(),
  );
  const portalMat = track(new THREE.MeshLambertMaterial({ color: 0x9fa6a8 }));
  const signGeo = track(new THREE.PlaneGeometry(2.3, 0.58));
  const portalSigns: { mesh: THREE.Mesh; end: 'north' | 'south' }[] = [];
  const signMaterials: THREE.Material[] = [];
  for (const tunnel of HK_TUNNELS) {
    const tex = createTunnelSignTexture(tunnel.name);
    if (tex) track(tex);
    const mat = track(
      new THREE.MeshLambertMaterial({
        map: tex ?? undefined,
        color: tex ? 0xffffff : 0x1c6b3c,
        side: THREE.DoubleSide,
        emissive: 0x0a2a1a,
        emissiveIntensity: 0.25,
      }),
    );
    signMaterials.push(mat);
  }

  // ─────────── 重建 ───────────

  let meshes: THREE.InstancedMesh[] = [];
  let tunnelTubeMesh: THREE.InstancedMesh | null = null;
  const clearMeshes = (): void => {
    tunnelTubeMesh = null;
    for (const m of meshes) {
      group.remove(m);
      m.dispose();
    }
    meshes = [];
    for (const sign of portalSigns) {
      group.remove(sign.mesh);
    }
    portalSigns.length = 0;
  };

  const isRoadAt = (x: number, y: number, s: GameState): boolean =>
    x < 0 || y < 0 || x >= s.width || y >= s.height ? false : s.tiles[y * s.width + x].road;
  const isWaterAt = (x: number, y: number, s: GameState): boolean =>
    x < 0 || y < 0 || x >= s.width || y >= s.height ? false : s.tiles[y * s.width + x].terrain === 'water';
  const isSidewalkAt = (x: number, y: number, s: GameState): boolean =>
    x < 0 || y < 0 || x >= s.width || y >= s.height ? false : Boolean(s.tiles[y * s.width + x].sidewalk);

  /** 是否港島北岸電車走廊（真實 480 地圖 design 座標：北岸 y≈57.5–62.5、dx≈46–67） */
  const isTramCorridor = (x: number, y: number): boolean => {
    const dx = (x + 0.5) / kx - 0.5;
    const dy = (y + 0.5) / ky - 0.5;
    return dy >= 57.5 && dy <= 62.5 && dx >= 46 && dx <= 67;
  };

  /** 舊區紅白磚人行道（港島北岸中環／灣仔／銅鑼灣／鰂魚涌；九龍舊區 y≈50–58） */
  const isRedPavement = (x: number, y: number): boolean => {
    const dx = (x + 0.5) / kx - 0.5;
    const dy = (y + 0.5) / ky - 0.5;
    const hkNorth = dy >= 57.0 && dy <= 62.5 && dx >= 45 && dx <= 67;
    const kowloonOld = dy >= 50 && dy <= 58 && dx >= 47 && dx <= 63;
    return hkNorth || kowloonOld;
  };

  const rebuild = (s: GameState): void => {
    clearMeshes();
    const roadTiles: number[] = [];
    for (let i = 0; i < s.tiles.length; i++) if (s.tiles[i].road) roadTiles.push(i);
    if (roadTiles.length === 0) return;

    interface Slab {
      x: number;
      z: number;
      y: number;
      rot: number;
      shade: number;
    }
    interface Mark {
      x: number;
      z: number;
      y: number;
      rot: number;
      sx: number;
      sz: number;
    }
    interface Strip {
      x: number;
      z: number;
      y: number;
      rot: number;
      red: boolean;
    }
    interface Edge {
      x: number;
      z: number;
      y: number;
      rot: number;
    }

    const asphalt: Slab[] = [];
    const localAsphalt: Slab[] = [];
    const elevatedDecks: Slab[] = [];
    const elevatedColumns: Slab[] = [];
    const tunnelRoute: Slab[] = [];
    const tunnelDashes: Slab[] = [];
    const tunnelPortals: Slab[] = [];
    const tunnelTubes: Slab[] = [];
    const walkSlabsGrey: Slab[] = [];
    const walkSlabsRed: Slab[] = [];
    const stripsGrey: Strip[] = [];
    const stripsRed: Strip[] = [];
    const kerbs: Edge[] = [];
    const whiteMarks: Mark[] = [];
    const yellowMarks: Mark[] = [];
    const rails: Mark[] = [];
    const lamps: Edge[] = [];
    const lampGlows: Edge[] = [];
    const busStops: Edge[] = [];
    const railings: Edge[] = [];
    const tunnelDecks: Slab[] = [];
    const tunnelWalls: Mark[] = [];
    const portals: { x: number; z: number; y: number; rot: number; tunnel: number; end: 'north' | 'south' }[] = [];

    // 隧道分組（同一欄連續的水上道路格）
    const tunnelColumns = new Map<number, number[]>();
    for (const i of roadTiles) {
      const tx = i % s.width;
      const ty = (i - tx) / s.width;
      if (!isWaterAt(tx, ty, s)) continue;
      const arr = tunnelColumns.get(tx) ?? [];
      arr.push(ty);
      tunnelColumns.set(tx, arr);
    }
    const tunnelEnds: { x: number; z: number; y: number; rot: number; tunnel: number; end: 'north' | 'south' }[] = [];
    for (const [tx, rows] of tunnelColumns) {
      rows.sort((a, b) => a - b);
      const minY = rows[0];
      const maxY = rows[rows.length - 1];
      const designX = (tx + 0.5) / kx - 0.5;
      let tunnelIdx = 2;
      let best = Infinity;
      for (let k = 0; k < HK_TUNNELS.length; k++) {
        const d = Math.abs(HK_TUNNELS[k].x - designX);
        if (d < best) {
          best = d;
          tunnelIdx = k;
        }
      }
      for (const [ty, dir, end] of [
        [minY, -1, 'north'],
        [maxY, 1, 'south'],
      ] as [number, -1 | 1, 'north' | 'south'][]) {
        const { x: wx, z: wz } = tileWorld(tx, ty + dir, s.width, s.height);
        const landTile = s.tiles[(ty + dir) * s.width + tx];
        const gy = landTile ? roadSurfaceY(landTile) : 0.34;
        // 入口放在水陸交界：世界 z 由水格邊界退半格
        const edgeZ = wz + (dir < 0 ? TILE / 2 : -TILE / 2);
        tunnelEnds.push({
          x: wx,
          z: dir < 0 ? tileWorld(tx, ty, s.width, s.height).z - TILE / 2 : tileWorld(tx, ty, s.width, s.height).z + TILE / 2,
          y: gy,
          rot: dir < 0 ? Math.PI : 0,
          tunnel: tunnelIdx,
          end,
        });
        void edgeZ;
      }
    }

    // 每格處理
    for (const idx of roadTiles) {
      const tx = idx % s.width;
      const ty = (idx - tx) / s.width;
      const tile = s.tiles[idx];
      const { x: wx, z: wz } = tileWorld(tx, ty, s.width, s.height);
      const surfaceY = roadSurfaceY(tile);
      const water = tile.terrain === 'water';
      const nRoad = isRoadAt(tx, ty - 1, s);
      const sRoad = isRoadAt(tx, ty + 1, s);
      const eRoad = isRoadAt(tx + 1, ty, s);
      const wRoad = isRoadAt(tx - 1, ty, s);
      const nsRoad = nRoad || sRoad;
      const ewRoad = eRoad || wRoad;
      const intersection = nsRoad && ewRoad;
      const h = hash2d(tx, ty, seed + 9001);

      const roadGrade = (tile as { roadGrade?: 'surface' | 'elevated' | 'tunnel' }).roadGrade ?? 'surface';
      const isLocal = (tile as { localRoad?: boolean }).localRoad === true && roadGrade === 'surface';

      // 高架：橋面 + 柱（可跨水／山）
      if (roadGrade === 'elevated') {
        elevatedDecks.push({ x: wx, z: wz, y: surfaceY + 2.25, rot: 0, shade: 0.9 + h * 0.16 });
        if ((tx + ty) % 2 === 0) {
          elevatedColumns.push({ x: wx, z: wz, y: surfaceY + 1.14, rot: 0, shade: 0.82 });
        }
        continue;
      }

      // 隧道：地面深色路線 + 出入口龍門；U 層顯示隧道管
      if (roadGrade === 'tunnel') {
        tunnelRoute.push({ x: wx, z: wz, y: surfaceY + 0.02, rot: 0, shade: 0.8 });
        tunnelTubes.push({ x: wx, z: wz, y: surfaceY + 0.04, rot: 0, shade: 1 });
        tunnelDashes.push({ x: wx, z: wz, y: surfaceY + 0.07, rot: 0, shade: 1 });
        // 隧道口：任何鄰格唔係 tunnel（山／水／地面道路）就係入口/出口
        const gradeAt = (dx: number, dy: number): string | null => {
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx < 0 || ny < 0 || nx >= s.width || ny >= s.height) return null;
          const nt = s.tiles[ny * s.width + nx];
          return nt.road ? (nt.roadGrade ?? 'surface') : null;
        };
        const ne = gradeAt(1, 0);
        const nw = gradeAt(-1, 0);
        const nn = gradeAt(0, -1);
        const ns = gradeAt(0, 1);
        const endpoint = ne !== 'tunnel' || nw !== 'tunnel' || nn !== 'tunnel' || ns !== 'tunnel';
        if (endpoint) {
          const horizontal = ne !== 'tunnel' || nw !== 'tunnel';
          tunnelPortals.push({
            x: wx,
            z: wz,
            y: surfaceY + 1.05,
            rot: horizontal ? Math.PI / 2 : 0,
            shade: 0.95,
          });
        }
        continue;
      }

      if (water) {
        // 過海隧道：深色管頂 + 兩側半透明管壁 + 黃虛線
        tunnelDecks.push({ x: wx, z: wz, y: 0.26, rot: 0, shade: 0.9 + h * 0.2 });
        tunnelWalls.push(
          { x: wx - TILE / 2 + 0.05, z: wz, y: 0.26, rot: 0, sx: 1, sz: 1 },
          { x: wx + TILE / 2 - 0.05, z: wz, y: 0.26, rot: 0, sx: 1, sz: 1 },
        );
        // 管內的黃色導向線（以短虛線畫在管頂上）
        if ((ty - (nRoad ? 1 : 0)) % 2 === 0) {
          yellowMarks.push({ x: wx, z: wz, y: 0.35, rot: 0, sx: 0.36, sz: 0.08 });
        }
        continue;
      }

      if (isLocal) {
        localAsphalt.push({ x: wx, z: wz, y: surfaceY - 0.01, rot: 0, shade: 0.9 + h * 0.18 });
        continue;
      }
      asphalt.push({ x: wx, z: wz, y: surfaceY, rot: 0, shade: 0.92 + h * 0.16 });

      // ── 標線 ──
      const markY = surfaceY + 0.012;
      if (!intersection) {
        if (nsRoad) {
          // 南北向：中央白虛線（每格兩段）
          for (const t of [-0.26, 0.26]) {
            whiteMarks.push({ x: wx, z: wz + t, y: markY, rot: 0, sx: 0.055, sz: 0.3 });
          }
          // 兩側白邊線
          whiteMarks.push(
            { x: wx - TILE / 2 + 0.22, z: wz, y: markY, rot: 0, sx: 0.05, sz: TILE * 0.96 },
            { x: wx + TILE / 2 - 0.22, z: wz, y: markY, rot: 0, sx: 0.05, sz: TILE * 0.96 },
          );
          // 部分路段雙黃線（禁止停車）
          if (h < 0.2) {
            yellowMarks.push(
              { x: wx - TILE / 2 + 0.4, z: wz, y: markY, rot: 0, sx: 0.045, sz: TILE * 0.96 },
              { x: wx - TILE / 2 + 0.5, z: wz, y: markY, rot: 0, sx: 0.045, sz: TILE * 0.96 },
            );
          }
        } else if (ewRoad) {
          for (const t of [-0.26, 0.26]) {
            whiteMarks.push({ x: wx + t, z: wz, y: markY, rot: 0, sx: 0.3, sz: 0.055 });
          }
          whiteMarks.push(
            { x: wx, z: wz - TILE / 2 + 0.22, y: markY, rot: 0, sx: TILE * 0.96, sz: 0.05 },
            { x: wx, z: wz + TILE / 2 - 0.22, y: markY, rot: 0, sx: TILE * 0.96, sz: 0.05 },
          );
          if (h < 0.2) {
            yellowMarks.push(
              { x: wx, z: wz - TILE / 2 + 0.4, y: markY, rot: 0, sx: TILE * 0.96, sz: 0.045 },
              { x: wx, z: wz - TILE / 2 + 0.5, y: markY, rot: 0, sx: TILE * 0.96, sz: 0.045 },
            );
          }
        }

        // 斑馬線：若某一端緊接路口，於該端畫斑馬線
        const approach: [boolean, number, number][] = [
          [nRoad && isRoadAt(tx, ty - 1, s) && isRoadAt(tx - 1, ty - 1, s) && isRoadAt(tx + 1, ty - 1, s), 0, -1],
          [sRoad && isRoadAt(tx, ty + 1, s) && isRoadAt(tx - 1, ty + 1, s) && isRoadAt(tx + 1, ty + 1, s), 0, 1],
          [eRoad && isRoadAt(tx + 1, ty, s) && isRoadAt(tx + 1, ty - 1, s) && isRoadAt(tx + 1, ty + 1, s), 1, 0],
          [wRoad && isRoadAt(tx - 1, ty, s) && isRoadAt(tx - 1, ty - 1, s) && isRoadAt(tx - 1, ty + 1, s), -1, 0],
        ];
        for (const [cond, dx, dz] of approach) {
          if (!cond) continue;
          // 位於格邊的斑馬線：5 條白條橫跨車道
          for (let k = -2; k <= 2; k++) {
            if (dx !== 0) {
              whiteMarks.push({
                x: wx + dx * (TILE / 2 - 0.24),
                z: wz + k * 0.34,
                y: markY,
                rot: 0,
                sx: 0.34,
                sz: 0.2,
              });
            } else {
              whiteMarks.push({
                x: wx + k * 0.34,
                z: wz + dz * (TILE / 2 - 0.24),
                y: markY,
                rot: 0,
                sx: 0.2,
                sz: 0.34,
              });
            }
          }
          // 停止線
          whiteMarks.push({
            x: wx + dx * (TILE / 2 - 0.5),
            z: wz + dz * (TILE / 2 - 0.5),
            y: markY,
            rot: 0,
            sx: dx !== 0 ? 0.12 : TILE * 0.8,
            sz: dz !== 0 ? 0.12 : TILE * 0.8,
          });
        }
      } else {
        // 路口：中央不加線，於四個入口畫短虛線
        whiteMarks.push(
          { x: wx, z: wz - TILE / 2 + 0.28, y: markY, rot: 0, sx: 0.05, sz: 0.32 },
          { x: wx, z: wz + TILE / 2 - 0.28, y: markY, rot: 0, sx: 0.05, sz: 0.32 },
          { x: wx - TILE / 2 + 0.28, z: wz, y: markY, rot: 0, sx: 0.32, sz: 0.05 },
          { x: wx + TILE / 2 - 0.28, z: wz, y: markY, rot: 0, sx: 0.32, sz: 0.05 },
        );
      }

      // ── 路緣／自動人行道／欄杆 ──
      const edges: [number, number, number][] = [
        [0, -1, 0],
        [0, 1, Math.PI],
        [1, 0, Math.PI / 2],
        [-1, 0, -Math.PI / 2],
      ];
      for (const [dx, dz, rot] of edges) {
        const nx = tx + dx;
        const ny = ty + dz;
        if (nx < 0 || ny < 0 || nx >= s.width || ny >= s.height) continue;
        if (isRoadAt(nx, ny, s)) continue;
        if (isWaterAt(nx, ny, s)) {
          // 海旁欄杆
          railings.push({ x: wx + dx * (TILE / 2 - 0.06), z: wz + dz * (TILE / 2 - 0.06), y: surfaceY, rot });
          continue;
        }
        // 路緣石
        kerbs.push({ x: wx + dx * (TILE / 2 - 0.05), z: wz + dz * (TILE / 2 - 0.05), y: surfaceY, rot });
        // 自動人行道（若鄰格已是玩家鋪設的行人路，則不重複）
        if (!isSidewalkAt(nx, ny, s)) {
          const strip = {
            x: wx + dx * (TILE / 2 + 0.05),
            z: wz + dz * (TILE / 2 + 0.05),
            y: surfaceY + 0.01,
            rot,
            red: isRedPavement(nx, ny),
          };
          if (strip.red) stripsRed.push(strip);
          else stripsGrey.push(strip);
        }
      }
    }

    // ── 行人路整格（玩家鋪設） ──
    for (let i = 0; i < s.tiles.length; i++) {
      const tile = s.tiles[i];
      if (!tile.sidewalk || tile.road) continue;
      const tx = i % s.width;
      const ty = (i - tx) / s.width;
      const { x: wx, z: wz } = tileWorld(tx, ty, s.width, s.height);
      const slab = { x: wx, z: wz, y: roadSurfaceY(tile) + 0.005, rot: 0, shade: 0.92 + hash2d(tx, ty, seed + 9333) * 0.14 };
      // 大面積行人路以灰磚為主，約 1/4 用紅白磚作點綴（香港街頭常見）
      if (isRedPavement(tx, ty) && hash2d(tx, ty, seed + 9444) < 0.26) walkSlabsRed.push(slab);
      else walkSlabsGrey.push(slab);
    }

    // ── 路燈（每隔幾格、左右交替；優先放在有行人路的一側） ──
    {
      let lampCount = 0;
      for (const idx of roadTiles) {
        const tx = idx % s.width;
        const ty = (idx - tx) / s.width;
        const tile = s.tiles[idx];
        if (tile.terrain === 'water') continue;
        const hh = hash2d(tx, ty, seed + 9444);
        if (hh > 0.26) continue;
        const { x: wx, z: wz } = tileWorld(tx, ty, s.width, s.height);
        const surfaceY = roadSurfaceY(tile);
        // 選擇一側：優先在非道路方向
        const sides: [number, number, number][] = [
          [0, -1, 0],
          [0, 1, Math.PI],
          [1, 0, Math.PI / 2],
          [-1, 0, -Math.PI / 2],
        ];
        let placed = false;
        for (const [dx, dz, rot] of sides) {
          const nx = tx + dx;
          const ny = ty + dz;
          if (isRoadAt(nx, ny, s) || isWaterAt(nx, ny, s)) continue;
          lampCount++;
          const lx = wx + dx * (TILE / 2 - 0.28);
          const lz = wz + dz * (TILE / 2 - 0.28);
          lamps.push({ x: lx, z: lz, y: surfaceY + 0.02, rot: rot + Math.PI / 2 });
          lampGlows.push({ x: lx, z: lz, y: surfaceY + 0.03, rot: 0 });
          placed = true;
          break;
        }
        void placed;
        if (lampCount > 240) break;
      }
    }

    // ── 巴士站（沿主要道路每 ~18 格一個） ──
    {
      const stride = Math.max(3, Math.floor(roadTiles.length / 14));
      for (let k = 0; k < roadTiles.length; k += stride) {
        const idx = roadTiles[k];
        const tx = idx % s.width;
        const ty = (idx - tx) / s.width;
        const tile = s.tiles[idx];
        if (tile.terrain === 'water') continue;
        const { x: wx, z: wz } = tileWorld(tx, ty, s.width, s.height);
        const surfaceY = roadSurfaceY(tile);
        const sides: [number, number, number][] = [
          [0, -1, 0],
          [0, 1, Math.PI],
          [1, 0, Math.PI / 2],
          [-1, 0, -Math.PI / 2],
        ];
        for (const [dx, dz, rot] of sides) {
          if (isRoadAt(tx + dx, ty + dz, s) || isWaterAt(tx + dx, ty + dz, s)) continue;
          busStops.push({ x: wx + dx * (TILE / 2 - 0.35), z: wz + dz * (TILE / 2 - 0.35), y: surfaceY + 0.02, rot: rot + Math.PI / 2 });
          break;
        }
      }
    }

    // ── 電車軌（港島北岸走廊，東西向路段） ──
    for (const idx of roadTiles) {
      const tx = idx % s.width;
      const ty = (idx - tx) / s.width;
      const tile = s.tiles[idx];
      if (tile.terrain === 'water') continue;
      if (!isTramCorridor(tx, ty)) continue;
      const eRoad = isRoadAt(tx + 1, ty, s);
      const wRoad = isRoadAt(tx - 1, ty, s);
      if (!eRoad && !wRoad) continue;
      const { x: wx, z: wz } = tileWorld(tx, ty, s.width, s.height);
      const surfaceY = roadSurfaceY(tile) + 0.012;
      for (const off of [-0.52, 0.52]) {
        rails.push({ x: wx, z: wz + off, y: surfaceY, rot: 0, sx: 1, sz: 1 });
      }
    }

    // ── 建立 InstancedMesh ──
    const buildSlabs = (list: Slab[], mat: THREE.Material, name: string, geo: THREE.BufferGeometry, castShadow = false): void => {
      if (list.length === 0) return;
      const mesh = makeMesh(geo, mat, list.length, name, castShadow);
      list.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        color.setRGB(p.shade, p.shade, p.shade * 1.01);
        mesh.setColorAt(i, color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      meshes.push(mesh);
    };
    buildSlabs(asphalt, asphaltMat, 'road-asphalt', slabGeo);
    buildSlabs(localAsphalt, localAsphaltMat, 'road-asphalt-local', localSlabGeo);
    buildSlabs(elevatedDecks, elevatedDeckMat, 'road-elevated-decks', elevatedDeckGeo);
    buildSlabs(elevatedColumns, elevatedColumnMat, 'road-elevated-columns', elevatedColumnGeo);
    buildSlabs(tunnelRoute, tunnelRouteMat, 'road-tunnel-route', tunnelRouteGeo);
    if (tunnelPortals.length > 0) {
      const mesh = makeMesh(tunnelPortalGeo, tunnelPortalMat, tunnelPortals.length, 'road-tunnel-portals');
      tunnelPortals.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      meshes.push(mesh);
    }
    if (tunnelDashes.length > 0) {
      const mesh = makeMesh(tunnelDashGeo, tunnelDashMat, tunnelDashes.length, 'road-tunnel-dashes');
      tunnelDashes.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      meshes.push(mesh);
    }
    // U 層隧道管（只在 showUnderground 時顯示；update 控制）
    tunnelTubeMesh = null;
    if (tunnelTubes.length > 0) {
      tunnelTubeMesh = makeMesh(tunnelTubeGeo, tunnelTubeMat, tunnelTubes.length, 'road-tunnel-tubes');
      tunnelTubes.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        tunnelTubeMesh!.setMatrixAt(i, dummy.matrix);
      });
      tunnelTubeMesh.instanceMatrix.needsUpdate = true;
      tunnelTubeMesh.visible = s.ui.showUnderground === true;
      meshes.push(tunnelTubeMesh);
    }
    buildSlabs(walkSlabsGrey, walkGreyMat, 'sidewalk-grey', walkSlabGeo);
    buildSlabs(walkSlabsRed, walkRedMat, 'sidewalk-red', walkSlabGeo);

    const buildStrips = (list: Strip[], mat: THREE.Material, name: string): void => {
      if (list.length === 0) return;
      const mesh = makeMesh(stripGeo, mat, list.length, name);
      list.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        color.setRGB(0.94, 0.94, 0.94);
        mesh.setColorAt(i, color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      meshes.push(mesh);
    };
    buildStrips(stripsGrey, stripGreyMat, 'sidewalk-strip-grey');
    buildStrips(stripsRed, stripRedMat, 'sidewalk-strip-red');

    if (kerbs.length > 0) {
      const mesh = makeMesh(kerbGeo, kerbMat, kerbs.length, 'road-kerbs');
      kerbs.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      meshes.push(mesh);
    }

    const buildMarks = (list: Mark[], mat: THREE.Material, name: string): void => {
      if (list.length === 0) return;
      const mesh = makeMesh(markGeo, mat, list.length, name);
      list.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(p.sx, 1, p.sz);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      meshes.push(mesh);
    };
    buildMarks(whiteMarks, whiteMarkMat, 'road-markings-white');
    buildMarks(yellowMarks, yellowMarkMat, 'road-markings-yellow');

    if (rails.length > 0) {
      const mesh = makeMesh(railGeo, railMat, rails.length, 'tram-rails');
      rails.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(p.sx, 1, p.sz);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      meshes.push(mesh);
    }

    if (railings.length > 0) {
      const mesh = makeMesh(railingGeo, railingMat, railings.length, 'road-railings', true);
      railings.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.setScalar(0.95);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        color.setRGB(0.92, 0.94, 0.96);
        mesh.setColorAt(i, color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      meshes.push(mesh);
    }

    if (lamps.length > 0) {
      const mesh = makeMesh(lampGeo, lampMat, lamps.length, 'street-lamps', true);
      lamps.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        color.setRGB(0.95, 0.95, 0.95);
        mesh.setColorAt(i, color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      meshes.push(mesh);

      const glow = makeMesh(lampGlowGeo, lampGlowMat, lampGlows.length, 'street-lamp-glow');
      lampGlows.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        glow.setMatrixAt(i, dummy.matrix);
      });
      glow.instanceMatrix.needsUpdate = true;
      meshes.push(glow);
    }

    if (busStops.length > 0) {
      const mesh = makeMesh(busStopGeo, busStopMat, busStops.length, 'bus-stops', true);
      busStops.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        color.setRGB(0.96, 0.96, 0.96);
        mesh.setColorAt(i, color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      meshes.push(mesh);
    }

    // 隧道
    if (tunnelDecks.length > 0) {
      const mesh = makeMesh(tunnelDeckGeo, tunnelMat, tunnelDecks.length, 'tunnel-decks');
      tunnelDecks.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        color.setRGB(p.shade, p.shade, p.shade);
        mesh.setColorAt(i, color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      meshes.push(mesh);

      const walls = makeMesh(tunnelWallGeo, tunnelWallMat, tunnelWalls.length, 'tunnel-walls');
      tunnelWalls.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        walls.setMatrixAt(i, dummy.matrix);
      });
      walls.instanceMatrix.needsUpdate = true;
      meshes.push(walls);
    }
    if (tunnelEnds.length > 0) {
      const portalsMesh = makeMesh(portalGeo, portalMat, tunnelEnds.length, 'tunnel-portals', true);
      tunnelEnds.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        portalsMesh.setMatrixAt(i, dummy.matrix);
      });
      portalsMesh.instanceMatrix.needsUpdate = true;
      meshes.push(portalsMesh);

      // 入口名牌（每條隧道 2 個）
      for (const p of tunnelEnds) {
        const mat = signMaterials[p.tunnel];
        if (!mat) continue;
        const sign = new THREE.Mesh(signGeo, mat);
        sign.position.set(p.x, p.y + 2.0, p.z + (p.rot === 0 ? 0.16 : -0.16));
        sign.rotation.y = p.rot === 0 ? 0 : Math.PI;
        sign.castShadow = false;
        group.add(sign);
        portalSigns.push({ mesh: sign, end: p.end });
      }
    }
    void portals;
  };

  // ─────────── 變更偵測 ───────────

  let signature = -1;
  let lastRevision = -1;
  const computeSignature = (s: GameState): number => {
    let count = 0;
    let sum = 0;
    for (let i = 0; i < s.tiles.length; i++) {
      const t = s.tiles[i] as { road: boolean; sidewalk?: boolean; roadGrade?: string; localRoad?: boolean };
      if (t.road) {
        count++;
        sum += i;
        if (t.roadGrade === 'elevated') sum += 1_000_003;
        else if (t.roadGrade === 'tunnel') sum += 2_000_003;
        if (t.localRoad) sum += 3_000_001;
      } else if (t.sidewalk) {
        count += 7919;
        sum += i * 3;
      }
    }
    return count * 1000003 + sum;
  };

  rebuild(state);
  signature = computeSignature(state);

  return {
    group,
    update(s: GameState, dt: number): void {
      void dt;
      if (tunnelTubeMesh) tunnelTubeMesh.visible = s.ui.showUnderground === true;
      // 路網變更偵測
      if (s.ui.revision !== lastRevision) {
        lastRevision = s.ui.revision;
        const sig = computeSignature(s);
        if (sig !== signature) {
          signature = sig;
          rebuild(s);
        }
      }
      // 夜間路燈
      const hour = s.clock.hour + s.clock.minute / 60;
      const dark =
        s.clock.weather === 'storm' || s.clock.weather === 'fog'
          ? 1
          : hour < 6.6 || hour > 18.4
            ? 1
            : 0;
      const intensity = dark ? (s.clock.weather === 'storm' ? 0.85 : 1) : 0;
      lampMat.emissiveIntensity = intensity * 0.9;
      lampGlowMat.opacity = intensity * (s.clock.weather === 'fog' ? 0.18 : 0.3);
      portalMat.emissive = portalMat.emissive ?? new THREE.Color();
      (tunnelWallMat as THREE.MeshLambertMaterial).emissiveIntensity = 0.2 + intensity * 0.5;
      void hour;
    },
    dispose(): void {
      clearMeshes();
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      group.clear();
    },
  };
}
