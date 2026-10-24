/**
 * 地下管網圖層（Round 5）：食水／污水／電力三色發光管道。
 *
 * 由 `state.tiles[i].waterPipe / sewerPipe / powerCable`（sim/utilities 鋪設）生成，
 * 只在 `state.ui.showUnderground === true` 時顯示；最多 3 個 InstancedMesh（≤3 draw calls）。
 * 管道畫在地表之上少少（半透明 additive 光管），令玩家即使有樓／樹都睇得清走線。
 */
import * as THREE from 'three';
import type { GameState } from '../core/types';
import { TILE, tileWorld } from './coords';
import { tileTopY } from './world-utils';

export interface UndergroundView {
  group: THREE.Group;
  update(state: GameState, dt: number): void;
  dispose(): void;
}

type PipeKind = 'water' | 'sewer' | 'power';

const PIPE_COLORS: Record<PipeKind, number> = {
  water: 0x5fb4d6,
  sewer: 0x8a9f66,
  power: 0xe6c35a,
};

interface PipeInstance {
  x: number;
  z: number;
  y: number;
  len: number;
  rot: number;
}

export function createUndergroundView(_state: GameState): UndergroundView {
  const group = new THREE.Group();
  group.name = 'underground-pipes';
  group.visible = false;

  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const materials: Record<PipeKind, THREE.MeshBasicMaterial> = {
    water: new THREE.MeshBasicMaterial({
      color: PIPE_COLORS.water,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      fog: false,
    }),
    sewer: new THREE.MeshBasicMaterial({
      color: PIPE_COLORS.sewer,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      fog: false,
    }),
    power: new THREE.MeshBasicMaterial({
      color: PIPE_COLORS.power,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      fog: false,
    }),
  };
  const meshes: Partial<Record<PipeKind, THREE.InstancedMesh>> = {};
  let lastSignature = '';

  const clearMeshes = (): void => {
    for (const kind of Object.keys(meshes) as PipeKind[]) {
      const mesh = meshes[kind];
      if (!mesh) continue;
      group.remove(mesh);
      mesh.dispose();
      delete meshes[kind];
    }
  };

  const build = (s: GameState): void => {
    clearMeshes();
    const { width, height, tiles } = s;
    const lists: Record<PipeKind, PipeInstance[]> = { water: [], sewer: [], power: [] };
    const flags: Record<PipeKind, (i: number) => boolean> = {
      water: (i) => Boolean(tiles[i].waterPipe),
      sewer: (i) => Boolean(tiles[i].sewerPipe),
      power: (i) => Boolean(tiles[i].powerCable),
    };
    const yOffsets: Record<PipeKind, number> = { water: 0.2, sewer: 0.24, power: 0.28 };
    for (const kind of ['water', 'sewer', 'power'] as const) {
      const has = flags[kind];
      for (let i = 0; i < tiles.length; i++) {
        if (!has(i)) continue;
        const x = i % width;
        const y = (i - x) / width;
        const { x: wx, z: wz } = tileWorld(x, y, width, height);
        const baseY = tileTopY(tiles[i]) + yOffsets[kind];
        const north = y > 0 && has(i - width);
        const south = y < height - 1 && has(i + width);
        const west = x > 0 && has(i - 1);
        const east = x < width - 1 && has(i + 1);
        const horiz = west || east;
        const vert = north || south;
        if (horiz || !vert) {
          lists[kind].push({ x: wx, z: wz, y: baseY, len: TILE * 0.96, rot: 0 });
        } else {
          lists[kind].push({ x: wx, z: wz, y: baseY, len: TILE * 0.96, rot: Math.PI / 2 });
        }
      }
    }
    const dummy = new THREE.Object3D();
    for (const kind of ['water', 'sewer', 'power'] as const) {
      const list = lists[kind];
      if (list.length === 0) continue;
      const mesh = new THREE.InstancedMesh(geo, materials[kind], list.length);
      mesh.name = `underground-${kind}`;
      mesh.frustumCulled = false;
      mesh.renderOrder = 21;
      list.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(p.len, 1, 0.34);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
      meshes[kind] = mesh;
    }
  };

  return {
    group,
    update(s: GameState, _dt: number): void {
      const show = Boolean(s.ui.showUnderground);
      if (!show) {
        if (group.visible) group.visible = false;
        lastSignature = '';
        return;
      }
      group.visible = true;
      const counts = s.utilities?.pipeCounts;
      const signature = `${s.ui.revision}|${s.utilities?.revision ?? -1}|${counts ? `${counts.water},${counts.sewer},${counts.power}` : ''}`;
      if (signature === lastSignature) return;
      lastSignature = signature;
      build(s);
    },
    dispose(): void {
      clearMeshes();
      geo.dispose();
      for (const kind of Object.keys(materials) as PipeKind[]) materials[kind].dispose();
      group.clear();
    },
  };
}
