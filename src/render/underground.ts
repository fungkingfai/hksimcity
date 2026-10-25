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
  // #12：流動光點（每 2 格一點；1 draw）
  const flowGeo = new THREE.BoxGeometry(0.26, 0.04, 0.26);
  const flowMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
  });
  let flowMesh: THREE.InstancedMesh | null = null;
  let flowData: { kind: PipeKind; x: number; z: number; y: number; rot: number; phase: number }[] = [];
  let elapsed = 0;
  const PIPES: PipeKind[] = ['water', 'sewer', 'power'];

  const clearMeshes = (): void => {
    if (flowMesh) {
      group.remove(flowMesh);
      flowMesh.dispose();
      flowMesh = null;
    }
    flowData = [];
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
        // 每 2 格一個流動光點（phase 用格座標 hash，令同管連續流動）
        if ((x + y) % 2 === 0) {
          flowData.push({ kind, x: wx, z: wz, y: baseY + 0.03, rot: horiz || !vert ? 0 : Math.PI / 2, phase: ((x * 7 + y * 13) % 16) / 16 });
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
    if (flowData.length > 0) {
      flowMesh = new THREE.InstancedMesh(flowGeo, flowMat, flowData.length);
      flowMesh.name = 'underground-flow';
      flowMesh.frustumCulled = false;
      flowMesh.renderOrder = 22;
      const c = new THREE.Color();
      const kindColor: Record<PipeKind, number> = { water: 0x9fe4ff, sewer: 0xd8f0a0, power: 0xffe58a };
      const dummy = new THREE.Object3D();
      flowData.forEach((p, i) => {
        c.setHex(kindColor[p.kind]);
        flowMesh!.setColorAt(i, c);
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.setScalar(1.25);
        dummy.updateMatrix();
        flowMesh!.setMatrixAt(i, dummy.matrix);
      });
      flowMesh.instanceMatrix.needsUpdate = true;
      if (flowMesh.instanceColor) flowMesh.instanceColor.needsUpdate = true;
      group.add(flowMesh);
    }
  };

  return {
    group,
    update(s: GameState, dt: number): void {
      const show = Boolean(s.ui.showUnderground);
      if (!show) {
        if (group.visible) group.visible = false;
        lastSignature = '';
        return;
      }
      group.visible = true;
      // #12：三種管網可獨立開關（ui.pipeLayers；default 全開）
      const layers = s.ui.pipeLayers ?? { water: true, sewage: true, power: true };
      const visible: Record<PipeKind, boolean> = {
        water: layers.water !== false,
        sewer: layers.sewage !== false,
        power: layers.power !== false,
      };
      for (const kind of PIPES) {
        const mesh = meshes[kind];
        if (mesh) mesh.visible = visible[kind];
      }
      const counts = s.utilities?.pipeCounts;
      const signature = `${s.utilities?.revision ?? -1}|${counts ? `${counts.water},${counts.sewer},${counts.power}` : ''}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        build(s);
        for (const kind of PIPES) {
          const mesh = meshes[kind];
          if (mesh) mesh.visible = visible[kind];
        }
      }
      // #12：沿管流動光點（任何時間 ≤1 draw）
      elapsed += dt;
      const flowOn = s.ui.pipeFlow !== false && (visible.water || visible.sewer || visible.power);
      if (flowMesh) {
        flowMesh.visible = flowOn;
        if (flowOn) {
          const dummy = new THREE.Object3D();
          flowData.forEach((p, i) => {
            if (!visible[p.kind]) {
              dummy.scale.setScalar(0);
            } else {
              const t = (elapsed * 0.55 + p.phase) % 1;
              const along = (t - 0.5) * TILE * 0.9;
              const dx = p.rot === 0 ? along : 0;
              const dz = p.rot === 0 ? 0 : along;
              dummy.position.set(p.x + dx, p.y, p.z + dz);
              dummy.rotation.set(0, p.rot, 0);
              dummy.scale.setScalar(0.9 + Math.sin(elapsed * 4 + p.phase * 6.28) * 0.25);
            }
            dummy.updateMatrix();
            flowMesh!.setMatrixAt(i, dummy.matrix);
          });
          flowMesh.instanceMatrix.needsUpdate = true;
        }
      }
    },
    dispose(): void {
      clearMeshes();
      geo.dispose();
      flowGeo.dispose();
      flowMat.dispose();
      for (const kind of Object.keys(materials) as PipeKind[]) materials[kind].dispose();
      group.clear();
    },
  };
}
