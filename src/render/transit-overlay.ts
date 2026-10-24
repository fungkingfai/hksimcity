/**
 * 巴士／小巴路線 overlay（Round 5）：每條 `state.transitLines` 用其顏色沿道路畫半透明路線。
 *
 * 只在交通面板開啟（`ui.showTransit`）或建線模式（`ui.lineEditorActive`）時顯示，
 * 避免日常畫面太花。每條線一個 Mesh（draw calls = 路線數）。
 */
import * as THREE from 'three';
import type { GameState } from '../core/types';
import { TILE, tileWorld } from './coords';
import { tileTopY } from './world-utils';
import { lineRoadPath } from '../sim/transit';

export interface TransitOverlayView {
  group: THREE.Group;
  update(state: GameState, dt: number): void;
  dispose(): void;
}

export function createTransitOverlayView(_state: GameState): TransitOverlayView {
  const group = new THREE.Group();
  group.name = 'transit-lines';
  group.visible = false;
  const disposables: { dispose(): void }[] = [];
  let lastSignature = '';

  const clear = (): void => {
    for (const d of disposables) d.dispose();
    disposables.length = 0;
    group.clear();
  };

  const build = (s: GameState): void => {
    clear();
    const lines = s.transitLines ?? [];
    const T = TILE;
    for (const line of lines) {
      if (line.suspended) continue;
      let path: number[] | null = null;
      try {
        path = lineRoadPath(s, line);
      } catch {
        path = null;
      }
      if (!path || path.length < 2) continue;
      const width = line.mode === 'minibus' ? 0.85 : 1.1;
      const positions: number[] = [];
      const indices: number[] = [];
      const yOff = 0.34;
      let vi = 0;
      for (let k = 0; k < path.length - 1; k++) {
        const ia = path[k];
        const ib = path[k + 1];
        if (ia < 0 || ib < 0) continue;
        const ax = ia % s.width;
        const ay = (ia - ax) / s.width;
        const bx = ib % s.width;
        const by = (ib - bx) / s.width;
        const pa = tileWorld(ax, ay, s.width, s.height);
        const pb = tileWorld(bx, by, s.width, s.height);
        const ya = tileTopY(s.tiles[ia]) + yOff;
        const yb = tileTopY(s.tiles[ib]) + yOff;
        const dx = pb.x - pa.x;
        const dz = pb.z - pa.z;
        const len = Math.hypot(dx, dz) || 1;
        const nx = (-dz / len) * (width / 2);
        const nz = (dx / len) * (width / 2);
        positions.push(
          pa.x + nx, ya, pa.z + nz,
          pa.x - nx, ya, pa.z - nz,
          pb.x + nx, yb, pb.z + nz,
          pb.x - nx, yb, pb.z - nz,
        );
        indices.push(vi, vi + 2, vi + 1, vi + 1, vi + 2, vi + 3);
        vi += 4;
      }
      if (positions.length === 0) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      const mat = new THREE.MeshBasicMaterial({
        color: line.color,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
        side: THREE.DoubleSide,
        depthTest: false,
        fog: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `transit-line-${line.id}`;
      mesh.renderOrder = 26;
      mesh.frustumCulled = false;
      disposables.push(geo, mat, mesh as unknown as { dispose(): void });
      group.add(mesh);
      // 站點圓點：令路線兩端清楚可見
      for (const stopId of line.stopIds) {
        const stop = s.buildings.find((b) => b.id === stopId);
        if (!stop) continue;
        const p = tileWorld(stop.x + (stop.w - 1) / 2, stop.y + (stop.h - 1) / 2, s.width, s.height);
        const ringGeo = new THREE.RingGeometry(1.0, 1.7, 18);
        ringGeo.rotateX(-Math.PI / 2);
        const ringMat = new THREE.MeshBasicMaterial({ color: line.color, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false, side: THREE.DoubleSide, fog: false });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.set(p.x, tileTopY(s.tiles[stop.y * s.width + stop.x]) + 0.45, p.z);
        ring.renderOrder = 27;
        ring.frustumCulled = false;
        disposables.push(ringGeo, ringMat, ring as unknown as { dispose(): void });
        group.add(ring);
      }
    }
  };

  const signatureOf = (s: GameState): string => {
    const active = Boolean(s.ui.showTransit || s.ui.lineEditorActive);
    if (!active) return 'off';
    const lines = s.transitLines ?? [];
    return lines.map((l) => `${l.id}:${l.color}:${l.stopIds.join(',')}:${l.suspended ? 1 : 0}`).join('|');
  };

  return {
    group,
    update(s: GameState, _dt: number): void {
      const active = Boolean(s.ui.showTransit || s.ui.lineEditorActive);
      if (!active) {
        if (group.visible) group.visible = false;
        lastSignature = 'off';
        return;
      }
      group.visible = true;
      const signature = signatureOf(s);
      if (signature === lastSignature) return;
      lastSignature = signature;
      build(s);
    },
    dispose(): void {
      clear();
      group.clear();
    },
  };
}
