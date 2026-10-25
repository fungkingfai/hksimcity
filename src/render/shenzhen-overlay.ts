/**
 * #14：深圳市「參考區」視覺（不可建設）。
 *
 * - 喺 `isShenzhenSideTile` 範圍嘅陸地鋪半透明斜線 overlay（1 InstancedMesh）。
 * - 同香港交界／海岸畫一條低調琥珀色邊界光線（1 InstancedMesh）。
 * - 北岸放「深圳市（參考）· 不可建設」label sprite。
 * 只喺 city 模式顯示；hover 深圳範圍時 overlay 稍為加強；唔會遮住香港側 border gates。
 */

import * as THREE from 'three';
import type { GameState } from '../core/types';
import { isShenzhenSideTile } from '../world/border';
import { TILE, tileWorld } from './coords';
import { tileTopY } from './world-utils';

export interface ShenzhenOverlayView {
  group: THREE.Group;
  update(state: GameState, dt: number, hover?: number): void;
  dispose(): void;
}

function hatchTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, 64, 64);
  ctx.strokeStyle = 'rgba(255, 214, 120, 0.55)';
  ctx.lineWidth = 3;
  for (let k = -64; k < 128; k += 16) {
    ctx.beginPath();
    ctx.moveTo(k, 64);
    ctx.lineTo(k + 64, 0);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function labelTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 208;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = 'rgba(14, 26, 34, 0.82)';
  ctx.strokeStyle = 'rgba(255, 210, 110, 0.9)';
  ctx.lineWidth = 5;
  const r = 26;
  ctx.beginPath();
  ctx.roundRect(6, 6, c.width - 12, c.height - 12, r);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffd76a';
  ctx.font = 'bold 76px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('深圳市（參考）· 不可建設', c.width / 2, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

export function createShenzhenOverlayView(state: GameState): ShenzhenOverlayView {
  const group = new THREE.Group();
  group.name = 'shenzhen-overlay';
  const { width, height } = state;

  const hatchTex = hatchTexture();
  const overlayMat = new THREE.MeshBasicMaterial({
    color: 0x3f6f8f,
    map: hatchTex ?? undefined,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  const planeGeo = new THREE.PlaneGeometry(TILE * 0.98, TILE * 0.98);
  planeGeo.rotateX(-Math.PI / 2);

  // 收集深圳側陸地格
  const landTiles: { x: number; y: number }[] = [];
  const boundary: { x: number; y: number; rot: number }[] = [];
  let sumX = 0;
  let sumZ = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isShenzhenSideTile(x, y, width, height)) continue;
      const tile = state.tiles[y * width + x];
      if (tile.terrain === 'water') continue;
      landTiles.push({ x, y });
      if (count === 0 || x < sumX / count) {
        /* keep centroid later */
      }
      const d = tileWorld(x, y, width, height);
      sumX += d.x;
      sumZ += d.z;
      count++;
      // 邊界：南／東／西鄰格非深圳側（即香港側或海）→ 畫光線
      const neighbors: [number, number, number][] = [
        [0, 1, 0],
        [0, -1, 0],
        [1, 0, Math.PI / 2],
        [-1, 0, Math.PI / 2],
      ];
      for (const [dx, dy, rot] of neighbors) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (isShenzhenSideTile(nx, ny, width, height)) continue;
        boundary.push({ x, y, rot });
        break;
      }
    }
  }

  const overlay =
    landTiles.length > 0 ? new THREE.InstancedMesh(planeGeo, overlayMat, landTiles.length) : null;
  if (overlay) {
    overlay.name = 'shenzhen-reference-overlay';
    overlay.frustumCulled = false;
    overlay.renderOrder = 1;
    const dummy = new THREE.Object3D();
    landTiles.forEach((p, i) => {
      const w = tileWorld(p.x, p.y, width, height);
      dummy.position.set(w.x, tileTopY(state.tiles[p.y * width + p.x]) + 0.05, w.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      overlay.setMatrixAt(i, dummy.matrix);
    });
    overlay.instanceMatrix.needsUpdate = true;
    group.add(overlay);
  }

  // 邊界光線（疏化：每 2 格一條）
  const boundaryLines = boundary.filter((_, i) => i % 2 === 0);
  const boundaryGeo = new THREE.BoxGeometry(TILE * 0.92, 0.05, 0.1);
  const boundaryMat = new THREE.MeshBasicMaterial({
    color: 0xffca66,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    fog: false,
  });
  const boundaryMesh =
    boundaryLines.length > 0
      ? new THREE.InstancedMesh(boundaryGeo, boundaryMat, boundaryLines.length)
      : null;
  if (boundaryMesh) {
    boundaryMesh.name = 'shenzhen-reference-boundary';
    boundaryMesh.frustumCulled = false;
    boundaryMesh.renderOrder = 1;
    const dummy = new THREE.Object3D();
    boundaryLines.forEach((p, i) => {
      const w = tileWorld(p.x, p.y, width, height);
      dummy.position.set(w.x, tileTopY(state.tiles[p.y * width + p.x]) + 0.09, w.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      boundaryMesh.setMatrixAt(i, dummy.matrix);
    });
    boundaryMesh.instanceMatrix.needsUpdate = true;
    group.add(boundaryMesh);
  }

  // 標籤
  let sprite: THREE.Sprite | null = null;
  const tex = labelTexture();
  if (tex && count > 0) {
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    sprite = new THREE.Sprite(mat);
    sprite.name = 'shenzhen-reference-label';
    const cx = sumX / count;
    const cz = sumZ / count;
    // 放喺深圳市中心較北位置（避免 label 蓋住香港邊界）
    sprite.position.set(cx, 16, cz - 40);
    sprite.scale.set(460, 94, 1);
    sprite.renderOrder = 30;
    group.add(sprite);
  }

  return {
    group,
    update(s: GameState, _dt: number, hover = -1): void {
      group.visible = s.ui.mode === 'city';
      if (!group.visible) return;
      const hoverShenzhen =
        hover >= 0 &&
        hover < s.tiles.length &&
        isShenzhenSideTile(hover % s.width, Math.floor(hover / s.width), s.width, s.height);
      overlayMat.opacity = hoverShenzhen ? 0.26 : 0.13;
      if (sprite) {
        const mat = sprite.material as THREE.SpriteMaterial;
        mat.opacity = hoverShenzhen ? 1 : 0.82;
      }
    },
    dispose(): void {
      overlay?.dispose();
      boundaryMesh?.dispose();
      planeGeo.dispose();
      overlayMat.dispose();
      boundaryGeo.dispose();
      boundaryMat.dispose();
      hatchTex?.dispose();
      if (sprite) {
        (sprite.material as THREE.SpriteMaterial).map?.dispose();
        (sprite.material as THREE.SpriteMaterial).dispose();
      }
      group.clear();
    },
  };
}
