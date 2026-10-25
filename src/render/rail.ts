/**
 * 鐵路軌 render（Round 6／Issue #5）。
 *
 * 由 `Tile.rail` 三種 grade 畫軌道：
 *  - surface：貼地雙軌＋枕木（沿 rail tile 方向）；
 *  - elevated：高架橋面＋支柱（可跨水）；
 *  - underground：隧道發光管，只喺 `ui.showUnderground === true` 顯示。
 *
 * 全部用 InstancedMesh，總 draw calls ≤5（surface 2、elevated 2、underground 1）；
 * rail 圖層 revision（`railRevisionOf()`）改變先 rebuild，每幀只更新可見性。
 */

import * as THREE from 'three';
import type { GameState, RailGrade } from '../core/types';
import { railRevisionOf } from '../sim/rail';
import { TILE } from './coords';
import { tileTopY } from './world-utils';

export interface RailView {
  group: THREE.Group;
  update(state: GameState, dt: number): void;
  dispose(): void;
}

interface RailTileInfo {
  index: number;
  x: number;
  y: number;
  /** true = 橫向（東西向，軌道沿 X）；false = 直向（南北向，軌道沿 Z） */
  horizontal: boolean;
  baseY: number;
}

const RAIL_Y_OFFSET = 0.045;
const ELEVATED_DECK_Y = 2.9;
const ELEVATED_DECK_THICK = 0.28;
const UNDERGROUND_Y_OFFSET = 0.22;

function railTilesOf(state: GameState, grade: RailGrade): RailTileInfo[] {
  const out: RailTileInfo[] = [];
  const { width, height, tiles } = state;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (tiles[i].rail !== grade) continue;
      // 方向：同行／同列有同 grade 軌道；默認直向
      const east = x + 1 < width && tiles[i + 1].rail === grade;
      const west = x > 0 && tiles[i - 1].rail === grade;
      const south = y + 1 < height && tiles[i + width].rail === grade;
      const north = y > 0 && tiles[i - width].rail === grade;
      let horizontal = false;
      if ((east || west) && !(south || north)) horizontal = true;
      else if ((south || north) && !(east || west)) horizontal = false;
      else if (east || west) horizontal = true;
      out.push({ index: i, x, y, horizontal, baseY: tileTopY(tiles[i]) });
    }
  }
  return out;
}

function makeInstanced(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  count: number,
  name: string,
  renderOrder = 0,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
  mesh.name = name;
  mesh.count = count;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.renderOrder = renderOrder;
  return mesh;
}

/** world 座標（tile 中心） */
function tileCenter(state: GameState, x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(
    (x + 0.5) * TILE - (state.width * TILE) / 2,
    0,
    (y + 0.5) * TILE - (state.height * TILE) / 2,
  );
}

export function createRailView(state: GameState): RailView {
  const group = new THREE.Group();
  group.name = 'rail';
  let lastRevision = -1;
  let undergroundVisible = state.ui.showUnderground === true;

  // 幾何／材質（共用；dispose 一次）
  const sleeperGeo = new THREE.BoxGeometry(1.72, 0.055, 0.34);
  const railGeo = new THREE.BoxGeometry(0.075, 0.075, 1.94);
  const sleeperMat = new THREE.MeshLambertMaterial({ color: 0x6b5a48 });
  const railMat = new THREE.MeshLambertMaterial({ color: 0x8f9aa3, emissive: 0x0b0d0e });
  const deckGeo = new THREE.BoxGeometry(1.9, ELEVATED_DECK_THICK, 2.02);
  const columnGeo = new THREE.BoxGeometry(0.32, ELEVATED_DECK_Y, 0.32);
  const deckMat = new THREE.MeshLambertMaterial({ color: 0x9a9f9f });
  const columnMat = new THREE.MeshLambertMaterial({ color: 0x7d8282 });
  const ugGeo = new THREE.BoxGeometry(0.72, 0.09, 1.92);
  const ugMat = new THREE.MeshBasicMaterial({
    color: 0xffd76a,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });

  let surfaceMeshes: THREE.InstancedMesh[] = [];
  let elevatedMeshes: THREE.InstancedMesh[] = [];
  let undergroundMesh: THREE.InstancedMesh | null = null;

  const clearMeshes = (): void => {
    for (const mesh of [...surfaceMeshes, ...elevatedMeshes]) {
      group.remove(mesh);
      mesh.dispose();
    }
    surfaceMeshes = [];
    elevatedMeshes = [];
    if (undergroundMesh) {
      group.remove(undergroundMesh);
      undergroundMesh.dispose();
      undergroundMesh = null;
    }
  };

  const build = (s: GameState): void => {
    clearMeshes();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    const axisY = new THREE.Vector3(0, 1, 0);
    const setTile = (
      mesh: THREE.InstancedMesh,
      idx: number,
      info: RailTileInfo,
      localX: number,
      localY: number,
      localZ: number,
      yaw: number,
    ): void => {
      tileCenter(s, info.x, info.y, p);
      // 沿軌道方向的本地座標：horizontal（沿 X）時 x/z 對調
      const ox = info.horizontal ? localZ : localX;
      const oz = info.horizontal ? localX : localZ;
      p.x += ox;
      p.z += oz;
      p.y += localY;
      q.setFromAxisAngle(axisY, yaw);
      m.compose(p, q, scale);
      mesh.setMatrixAt(idx, m);
    };

    // ── surface：枕木 + 雙軌（2 draws） ──
    const surface = railTilesOf(s, 'surface');
    if (surface.length > 0) {
      const sleepers = makeInstanced(sleeperGeo, sleeperMat, surface.length, 'rail-surface-sleepers');
      const rails = makeInstanced(railGeo, railMat, surface.length * 2, 'rail-surface-rails');
      for (let i = 0; i < surface.length; i++) {
        const info = surface[i];
        const yaw = info.horizontal ? Math.PI / 2 : 0;
        // 枕木貼地（baseY + 少許）
        setTile(sleepers, i, info, 0, info.baseY + RAIL_Y_OFFSET, 0, yaw);
        // 兩條鋼軌 offset ±0.28（相對軌道方向）
        setTile(rails, i * 2, info, 0.28, info.baseY + RAIL_Y_OFFSET + 0.07, 0, yaw);
        setTile(rails, i * 2 + 1, info, -0.28, info.baseY + RAIL_Y_OFFSET + 0.07, 0, yaw);
      }
      sleepers.instanceMatrix.needsUpdate = true;
      rails.instanceMatrix.needsUpdate = true;
      group.add(sleepers, rails);
      surfaceMeshes = [sleepers, rails];
    }

    // ── elevated：橋面 + 支柱（2 draws） ──
    const elevated = railTilesOf(s, 'elevated');
    if (elevated.length > 0) {
      const decks = makeInstanced(deckGeo, deckMat, elevated.length, 'rail-elevated-decks');
      const columns = makeInstanced(columnGeo, columnMat, elevated.length, 'rail-elevated-columns');
      for (let i = 0; i < elevated.length; i++) {
        const info = elevated[i];
        const yaw = info.horizontal ? Math.PI / 2 : 0;
        setTile(decks, i, info, 0, info.baseY + ELEVATED_DECK_Y, 0, yaw);
        setTile(columns, i, info, 0, info.baseY + ELEVATED_DECK_Y / 2, 0, 0);
      }
      decks.instanceMatrix.needsUpdate = true;
      columns.instanceMatrix.needsUpdate = true;
      group.add(decks, columns);
      elevatedMeshes = [decks, columns];
    }

    // ── underground：隧道發光管（1 draw；只喺 U 層顯示） ──
    const underground = railTilesOf(s, 'underground');
    if (underground.length > 0) {
      const mesh = makeInstanced(ugGeo, ugMat, underground.length, 'rail-underground', 23);
      for (let i = 0; i < underground.length; i++) {
        const info = underground[i];
        const yaw = info.horizontal ? Math.PI / 2 : 0;
        setTile(mesh, i, info, 0, info.baseY + UNDERGROUND_Y_OFFSET, 0, yaw);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = undergroundVisible;
      group.add(mesh);
      undergroundMesh = mesh;
    }

    lastRevision = railRevisionOf();
  };

  build(state);

  return {
    group,
    update(s: GameState, _dt: number): void {
      const revision = railRevisionOf();
      if (revision !== lastRevision) build(s);
      const show = s.ui.showUnderground === true;
      if (show !== undergroundVisible) {
        undergroundVisible = show;
        if (undergroundMesh) undergroundMesh.visible = show;
      }
    },
    dispose(): void {
      clearMeshes();
      sleeperGeo.dispose();
      railGeo.dispose();
      deckGeo.dispose();
      columnGeo.dispose();
      ugGeo.dispose();
      sleeperMat.dispose();
      railMat.dispose();
      deckMat.dispose();
      columnMat.dispose();
      ugMat.dispose();
      group.clear();
    },
  };
}
