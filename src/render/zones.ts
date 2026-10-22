/**
 * 分區（Zoning）色塊 overlay 渲染。
 *
 * 對每個 `tile.zone`（住宅／商業／工業／農業）繪製半透明色塊，讓玩家一眼看到
 * 已劃分的土地。顏色取自 `core/config.ts` 的 `ZONES[zone].color`。
 *
 * 設計：
 *  - 每種分區一個 InstancedMesh（合共 4 個 draw call），幾何為 2×2 水平面片，
 *    貼圖為程序化「填色 + 邊框」canvas texture（共用同一張）。
 *  - 已建建築或道路覆蓋的格不畫（避免遮住樓宇與路面）；未發展的劃區格清楚顯示顏色。
 *  - 以 MeshBasicMaterial（不受光照影響）保持日夜、晴雨颱風下的可讀性；
 *    額外加 polygonOffset 防止與地形／馬路 z-fighting。
 *  - `state.ui.showZones === false` 時整組隱藏；只在分區／佔用有變更時重建（signature＋ui.revision）。
 *  - 最多 9216 格全部劃區亦可接受（Instanced）。
 *
 * 由 city-view 整合：
 *   const zones = createZonesView(state);
 *   scene.add(zones.group);
 *   // 每幀：zones.update(state, dt);
 *   // dispose()：zones.dispose();
 */

import * as THREE from 'three';
import { ZONES, ZONE_ORDER } from '../core/config';
import type { GameState, ZoneType } from '../core/types';
import { TILE, tileWorld } from './coords';
import { tileTopY } from './world-utils';

export interface ZonesView {
  group: THREE.Group;
  update(state: GameState, dt: number): void;
  dispose(): void;
}

// ─────────────────────────── 程序化分區貼圖 ───────────────────────────

function makeCanvas(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

/**
 * 分區格貼圖：整格淡色填充 + 內縮亮邊框（形成分區格線，方便讀取範圍）。
 * 白色（供 material.color 乘上分區色），alpha 由貼圖控制。
 */
function createZoneTileTexture(): THREE.Texture | null {
  const c = makeCanvas(128, 128);
  if (!c) return null;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, 128, 128);
  // 淡色填充（避免完全遮住草地紋理）
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.fillRect(0, 0, 128, 128);
  // 內縮亮邊框：形成每格的分區格線
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)';
  ctx.lineWidth = 5;
  ctx.strokeRect(3, 3, 122, 122);
  // 四角加粗，令分區邊界更易辨認
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.lineWidth = 9;
  const corner = 22;
  ctx.beginPath();
  ctx.moveTo(3, 3 + corner);
  ctx.lineTo(3, 3);
  ctx.lineTo(3 + corner, 3);
  ctx.moveTo(125 - corner, 3);
  ctx.lineTo(125, 3);
  ctx.lineTo(125, 3 + corner);
  ctx.moveTo(125, 125 - corner);
  ctx.lineTo(125, 125);
  ctx.lineTo(125 - corner, 125);
  ctx.moveTo(3 + corner, 125);
  ctx.lineTo(3, 125);
  ctx.lineTo(3, 125 - corner);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ─────────────────────────── 主體 ───────────────────────────

export function createZonesView(state: GameState): ZonesView {
  const group = new THREE.Group();
  group.name = 'zones';

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const geo = track(new THREE.PlaneGeometry(TILE * 0.97, TILE * 0.97));
  geo.rotateX(-Math.PI / 2);
  const tileTex = createZoneTileTexture();
  if (tileTex) track(tileTex);

  // 每種分區一個 InstancedMesh（4 draw calls；先建立空 mesh，重建時填內容）
  const meshes = new Map<ZoneType, THREE.InstancedMesh>();
  const lists = new Map<ZoneType, { x: number; y: number; z: number }[]>();
  for (const zone of ZONE_ORDER) {
    const def = ZONES[zone];
    const mat = track(
      new THREE.MeshBasicMaterial({
        color: def.color,
        map: tileTex ?? undefined,
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
        // 只用正面：透明 DoubleSide 會被 three.js 分兩 pass 繪製（draw call ×2）
        side: THREE.FrontSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      }),
    );
    const mesh = new THREE.InstancedMesh(geo, mat, 1);
    mesh.name = `zones-${zone}`;
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 8; // 在地形／道路之上，建築之下
    track(mesh);
    group.add(mesh);
    meshes.set(zone, mesh);
    lists.set(zone, []);
  }

  const dummy = new THREE.Object3D();

  /** 是否應顯示該格的分區色塊（建築／道路覆蓋的格不畫） */
  const isZoneTileVisible = (s: GameState, i: number): boolean => {
    const tile = s.tiles[i];
    if (!tile.zone) return false;
    if (tile.road) return false;
    if (tile.buildingId >= 0) return false;
    if (tile.terrain === 'water' || tile.terrain === 'mountain') return false;
    return true;
  };

  /** 分區／佔用變更簽章（計入 zone 種類與是否可見） */
  const computeSignature = (s: GameState): number => {
    let count = 0;
    let sum = 0;
    for (let i = 0; i < s.tiles.length; i++) {
      const zone = s.tiles[i].zone;
      if (!zone) continue;
      const visible = isZoneTileVisible(s, i) ? 1 : 0;
      count++;
      sum = (sum + i * (ZONE_ORDER.indexOf(zone) + 1 + visible * 5) + visible) % 2_000_000_000;
    }
    return count * 2_000_000_000 + sum;
  };

  const rebuild = (s: GameState): void => {
    for (const zone of ZONE_ORDER) lists.get(zone)!.length = 0;
    for (let i = 0; i < s.tiles.length; i++) {
      if (!isZoneTileVisible(s, i)) continue;
      const tile = s.tiles[i];
      const zone = tile.zone as ZoneType;
      const tx = i % s.width;
      const ty = (i - tx) / s.width;
      const { x: wx, z: wz } = tileWorld(tx, ty, s.width, s.height);
      lists.get(zone)!.push({ x: wx, y: tileTopY(tile) + 0.032, z: wz });
    }
    for (const zone of ZONE_ORDER) {
      const mesh = meshes.get(zone)!;
      const list = lists.get(zone)!;
      const n = list.length;
      mesh.count = n;
      mesh.visible = n > 0;
      if (n === 0) continue;
      if (mesh.instanceMatrix.count < n) {
        // InstancedMesh 容量固定，重建一個更大容量的 mesh
        const newMesh = new THREE.InstancedMesh(geo, mesh.material, Math.max(n, 64));
        newMesh.name = mesh.name;
        newMesh.frustumCulled = false;
        newMesh.renderOrder = mesh.renderOrder;
        group.remove(mesh);
        group.add(newMesh);
        mesh.dispose();
        meshes.set(zone, newMesh);
      }
      const target = meshes.get(zone)!;
      target.count = n;
      target.visible = true;
      for (let k = 0; k < n; k++) {
        dummy.position.set(list[k].x, list[k].y, list[k].z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        target.setMatrixAt(k, dummy.matrix);
      }
      target.instanceMatrix.needsUpdate = true;
    }
  };

  let signature = computeSignature(state);
  let lastRevision = state.ui.revision;
  let lastShow = state.ui.showZones;

  group.visible = state.ui.showZones;
  rebuild(state);

  return {
    group,
    update(s: GameState, _dt: number): void {
      // 顯示／隱藏切換（UI toggle 會更新 ui.showZones 並 bump revision）
      if (s.ui.showZones !== lastShow) {
        lastShow = s.ui.showZones;
        group.visible = s.ui.showZones;
        // 重新顯示時強制重建一次，確保內容最新
        if (s.ui.showZones) {
          signature = computeSignature(s);
          lastRevision = s.ui.revision;
          rebuild(s);
        }
        return;
      }
      if (!s.ui.showZones) {
        group.visible = false;
        return;
      }
      if (s.ui.revision === lastRevision) return;
      lastRevision = s.ui.revision;
      const sig = computeSignature(s);
      if (sig === signature) return;
      signature = sig;
      rebuild(s);
    },
    dispose(): void {
      for (const mesh of meshes.values()) mesh.dispose();
      meshes.clear();
      lists.clear();
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      group.clear();
    },
  };
}
