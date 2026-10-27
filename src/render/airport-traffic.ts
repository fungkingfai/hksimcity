/**
 * Round 9／issue #19：香港國際機場密集起降動畫（air traffic）。
 *
 * 由 `HK_REGIONS` 的 runway／airport region derive 兩條赤鱲角平行跑道方向，
 * 以 pooled InstancedMesh 畫：
 *  - 3 種航空塗裝（國泰綠白／HK Express 紫白／貨機橙灰）各 1 draw；
 *  - 飛機導航／閃燈 1 draw；
 *  - 跑道邊燈／中線燈／ILS 進場燈 1 draw；
 * 合共 ≤5 draws。飛機分 approach／takeoff／stand，pool 重用，唔會每架每幀建 geometry。
 *
 * 天氣：storm 或 typhoonSignal>=8 停飛（只留停機坪）；旅客量調整空中飛機數。
 */

import * as THREE from 'three';
import type { GameState } from '../core/types';
import { HK_REGIONS } from '../world/worldgen';
import { TILE, tileWorld } from './coords';
import { createAirplaneGeometry } from './world-geometry';
import { tileTopY } from './world-utils';

export interface AirportTrafficView {
  group: THREE.Group;
  update(state: GameState, dt: number): void;
  dispose(): void;
}

type LiveryId = 0 | 1 | 2; // 0 國泰、1 HK Express、2 貨機

interface Plane {
  livery: LiveryId;
  mode: 'approach' | 'takeoff' | 'stand';
  runway: 0 | 1;
  dir: 1 | -1;
  t: number;
  duration: number;
  standIndex: number;
}

interface RunwayInfo {
  /** 跑道中心世界座標 */
  x: number;
  z: number;
  /** 沿跑道方向（X 或 Z） */
  alongX: boolean;
  /** 跑道半長（世界單位） */
  halfLen: number;
  /** 兩條跑道嘅垂直 offset */
  offsets: number[];
  /** 地面高度 */
  groundY: number;
}

const LIVERIES: { body: number; accent: number; cargo: boolean }[] = [
  { body: 0x145a43, accent: 0xf2f5f3, cargo: false }, // 國泰綠白
  { body: 0x6a3fa0, accent: 0xf2e9ff, cargo: false }, // HK Express 紫白
  { body: 0xd6d9da, accent: 0xe08a3a, cargo: true }, // 貨機灰橙
];

function designToWorld(state: GameState, dx: number, dy: number): { x: number; z: number } {
  const kx = state.width / 96;
  const ky = state.height / 96;
  return {
    x: (dx * kx + 0.5) * TILE - (state.width * TILE) / 2,
    z: (dy * ky + 0.5) * TILE - (state.height * TILE) / 2,
  };
}

function buildRunwayInfo(state: GameState): RunwayInfo | null {
  const runway = HK_REGIONS.find((r) => r.kind === 'runway');
  if (!runway) return null;
  const p0 = designToWorld(state, runway.x0, runway.y0);
  const p1 = designToWorld(state, runway.x1, runway.y1);
  const dx = p1.x - p0.x;
  const dz = p1.z - p0.z;
  const alongX = Math.abs(dx) >= Math.abs(dz);
  const cx = (p0.x + p1.x) / 2;
  const cz = (p0.z + p1.z) / 2;
  const halfLen = Math.max(12, (alongX ? Math.abs(dx) : Math.abs(dz)) / 2);
  const tx = Math.max(0, Math.min(state.width - 1, Math.round((runway.x0 + runway.x1) / 2 * (state.width / 96))));
  const ty = Math.max(0, Math.min(state.height - 1, Math.round((runway.y0 + runway.y1) / 2 * (state.height / 96))));
  const groundY = tileTopY(state.tiles[ty * state.width + tx]) + 0.04;
  // 真實赤鱲角：兩條平行跑道，垂直方向各偏移約 4 世界單位
  const offsets = alongX ? [-4, 4] : [-4, 4];
  return { x: cx, z: cz, alongX, halfLen, offsets, groundY };
}

/** 由 base 幾何染成航空公司塗裝（白色部件用 body，紅色尾翼用 accent）。 */
function liveryGeometry(base: THREE.BufferGeometry, livery: (typeof LIVERIES)[number]): THREE.BufferGeometry {
  const geo = base.clone();
  const colorAttr = geo.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (colorAttr) {
    const body = new THREE.Color(livery.body);
    const accent = new THREE.Color(livery.accent);
    for (let i = 0; i < colorAttr.count; i++) {
      const r = colorAttr.getX(i);
      const g = colorAttr.getY(i);
      const b = colorAttr.getZ(i);
      // 近白＝機身；近紅＝尾翼
      if (r > 0.82 && g > 0.82 && b > 0.82) {
        colorAttr.setXYZ(i, body.r, body.g, body.b);
      } else if (r > 0.6 && g < 0.4 && b < 0.4) {
        colorAttr.setXYZ(i, accent.r, accent.g, accent.b);
      }
    }
    colorAttr.needsUpdate = true;
  }
  return geo;
}

export function createAirportTrafficView(state: GameState): AirportTrafficView {
  const group = new THREE.Group();
  group.name = 'airport-traffic';
  const runway = buildRunwayInfo(state);
  if (!runway) return { group, update: () => {}, dispose: () => { group.clear(); } };

  const baseGeo = createAirplaneGeometry();
  const geos = LIVERIES.map((l) => liveryGeometry(baseGeo, l));
  const mats = LIVERIES.map(
    () => new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x111111, emissiveIntensity: 0.05 }),
  );
  const MAX_PER_LIVERY = 8;
  const planeMeshes = geos.map((geo, i) => {
    const mesh = new THREE.InstancedMesh(geo, mats[i], MAX_PER_LIVERY);
    mesh.name = `airport-planes-livery-${i}`;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  });

  // 導航燈：每架 2 粒（左紅右綠）＋尾白閃燈
  const navGeo = new THREE.BoxGeometry(0.16, 0.08, 0.16);
  const navMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false, fog: false });
  const navMesh = new THREE.InstancedMesh(navGeo, navMat, (MAX_PER_LIVERY * LIVERIES.length) * 3);
  navMesh.name = 'airport-plane-lights';
  navMesh.frustumCulled = false;
  navMesh.count = 0;
  navMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(navMesh);

  // 跑道燈／ILS 燈（靜態，一次建好）
  interface LightDef { x: number; z: number; y: number; color: number; }
  const lightDefs: LightDef[] = [];
  for (let r = 0; r < runway.offsets.length; r++) {
    const off = runway.offsets[r];
    for (let side = -1; side <= 1; side += 2) {
      for (let k = -runway.halfLen; k <= runway.halfLen; k += 5) {
        const edge = runway.halfLen - Math.abs(k) < 3;
        const color = edge ? 0xff3326 : 0x8fff9a;
        lightDefs.push({
          x: runway.alongX ? runway.x + k : runway.x + off + side * 2.0,
          z: runway.alongX ? runway.z + off + side * 2.0 : runway.z + k,
          y: runway.groundY + 0.06,
          color,
        });
      }
    }
    for (let k = -runway.halfLen + 4; k <= runway.halfLen - 4; k += 7) {
      lightDefs.push({
        x: runway.alongX ? runway.x + k : runway.x + off,
        z: runway.alongX ? runway.z + off : runway.z + k,
        y: runway.groundY + 0.06,
        color: 0xfff4d6,
      });
    }
    // ILS 進場燈：由跑道兩端向外延伸
    for (const dir of [-1, 1]) {
      for (let k = 3; k <= 26; k += 4) {
        lightDefs.push({
          x: runway.alongX ? runway.x + dir * (runway.halfLen + k) : runway.x + off,
          z: runway.alongX ? runway.z + off : runway.z + dir * (runway.halfLen + k),
          y: runway.groundY + 0.5,
          color: 0xffe27a,
        });
      }
    }
  }
  const lightGeo = new THREE.BoxGeometry(0.28, 0.05, 0.28);
  const lightMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false, fog: false });
  const lightMesh = new THREE.InstancedMesh(lightGeo, lightMat, lightDefs.length);
  lightMesh.name = 'airport-runway-lights';
  lightMesh.frustumCulled = false;
  lightMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  {
    const dummy = new THREE.Object3D();
    const c = new THREE.Color();
    lightDefs.forEach((d, i) => {
      dummy.position.set(d.x, d.y, d.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      lightMesh.setMatrixAt(i, dummy.matrix);
      c.setHex(d.color);
      lightMesh.setColorAt(i, c);
    });
    lightMesh.instanceMatrix.needsUpdate = true;
    if (lightMesh.instanceColor) lightMesh.instanceColor.needsUpdate = true;
  }
  group.add(lightMesh);

  // ── 飛機 pool / 排班 ──
  const planes: Plane[] = [];
  const STANDS = 6;
  const buildPlanes = (): void => {
    planes.length = 0;
    // 6 架 ground/stand + 6 架 cycling（approach/takeoff 各半）
    for (let i = 0; i < STANDS; i++) {
      planes.push({
        livery: (i % 3) as LiveryId,
        mode: 'stand',
        runway: (i % 2) as 0 | 1,
        dir: i % 2 === 0 ? 1 : -1,
        t: i * 0.17,
        duration: 1,
        standIndex: i,
      });
    }
    for (let i = 0; i < 6; i++) {
      const takeoff = i % 2 === 0;
      planes.push({
        livery: ((i + 1) % 3) as LiveryId,
        mode: takeoff ? 'takeoff' : 'approach',
        runway: (i % 2) as 0 | 1,
        dir: takeoff ? (i % 4 === 0 ? 1 : -1) : i % 4 === 0 ? 1 : -1,
        t: (i * 0.19 + 0.13) % 1,
        duration: takeoff ? 13 : 16,
        standIndex: -1,
      });
    }
  };
  buildPlanes();

  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  let elapsed = 0;

  const poseOf = (plane: Plane): { x: number; y: number; z: number; yaw: number; ground: boolean; visible: boolean } => {
    const off = runway.offsets[plane.runway];
    const len = runway.halfLen;
    const altitude = 26;
    let along = 0;
    let y = runway.groundY;
    let ground = true;
    let visible = true;
    const x0 = runway.alongX ? runway.x : runway.x + off;
    const z0 = runway.alongX ? runway.z + off : runway.z;
    if (plane.mode === 'stand') {
      // 停機坪：沿 terminal 邊排列
      const sx = (plane.standIndex - (STANDS - 1) / 2) * 13;
      along = sx;
      y = runway.groundY;
      return {
        x: runway.alongX ? runway.x + sx : runway.x + off + 16,
        y: runway.groundY,
        z: runway.alongX ? runway.z + off + 16 : runway.z + sx,
        yaw: runway.alongX ? Math.PI / 2 : 0,
        ground: true,
        visible: true,
      };
    }
    const t = plane.t;
    if (plane.mode === 'approach') {
      const touchdown = 0.62;
      if (t < touchdown) {
        const p = t / touchdown;
        along = (plane.dir < 0 ? -1 : 1) * len * (2.0 - 1.0 * p);
        y += altitude * Math.pow(1 - p, 1.7);
        ground = false;
      } else {
        const p = (t - touchdown) / (1 - touchdown);
        along = (plane.dir < 0 ? -1 : 1) * len * (-1 + 1.5 * p);
        y = runway.groundY + 0.02;
      }
    } else {
      if (t < 0.32) {
        const p = t / 0.32;
        along = (plane.dir < 0 ? -1 : 1) * len * (-1 + 1.1 * p);
        y = runway.groundY + 0.02;
      } else {
        const p = (t - 0.32) / 0.68;
        along = (plane.dir < 0 ? -1 : 1) * len * (0.1 + 1.8 * p);
        y = runway.groundY + altitude * Math.pow(p, 1.4);
        ground = false;
      }
    }
    return {
      x: runway.alongX ? x0 + along : x0,
      y,
      z: runway.alongX ? z0 : z0 + along,
      yaw: runway.alongX ? (along >= 0 ? 0 : Math.PI) : along >= 0 ? Math.PI / 2 : -Math.PI / 2,
      ground,
      visible,
    };
  };

  const updatePlanes = (s: GameState, dt: number): void => {
    const stormy = s.clock.weather === 'storm' || (s.clock.typhoonSignal ?? 0) >= 8;
    const passengers = s.trade?.airport?.passengers ?? 0;
    const activeCount = stormy ? 0 : Math.max(4, Math.min(7, Math.round(4 + passengers / 2200)));
    // 空中飛機數依旅客量；storm 只留 stand
    let airborne = 0;
    const counts = [0, 0, 0];
    let navCount = 0;
    elapsed += dt;
    for (const plane of planes) {
      const isAir = plane.mode !== 'stand';
      if (isAir) {
        if (stormy || airborne >= activeCount) continue;
        plane.t += dt / plane.duration;
        if (plane.t >= 1) {
          plane.t = 0;
          // 轉 mode/跑道循環
          plane.mode = plane.mode === 'approach' ? 'takeoff' : 'approach';
          plane.runway = (1 - plane.runway) as 0 | 1;
          plane.dir = (1 - plane.dir) as 1 | -1;
        }
        airborne++;
      }
      if (counts[plane.livery] >= MAX_PER_LIVERY) continue;
      const pose = poseOf(plane);
      dummy.position.set(pose.x, pose.y, pose.z);
      dummy.rotation.set(0, pose.yaw, 0);
      const scale = plane.mode === 'stand' ? 1.8 : 2.1;
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      const idx = counts[plane.livery]++;
      planeMeshes[plane.livery].setMatrixAt(idx, dummy.matrix);
      // 導航燈：左右翼＋尾閃
      if (plane.mode !== 'stand') {
        const wx = Math.cos(pose.yaw) * 2.2;
        const wz = -Math.sin(pose.yaw) * 2.2;
        const nx = -Math.sin(pose.yaw) * 1.6;
        const nz = -Math.cos(pose.yaw) * 1.6;
        const nav: [number, number, number, number][] = [
          [pose.x + nx, pose.y + 0.3, pose.z + nz, 0xff3326],
          [pose.x - nx, pose.y + 0.3, pose.z - nz, 0x5cff9d],
          [pose.x - wx, pose.y + 0.4, pose.z - wz, plane.mode === 'approach' ? 0xfff0c0 : 0xffffff],
        ];
        for (const [lx, ly, lz, hex] of nav) {
          if (navCount >= navMesh.count + 3) {
            /* capacity handled below */
          }
          dummy.position.set(lx, ly, lz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.setScalar(1);
          dummy.updateMatrix();
          navMesh.setMatrixAt(navCount, dummy.matrix);
          tmpColor.setHex(hex);
          navMesh.setColorAt(navCount, tmpColor);
          navCount++;
        }
      }
    }
    for (let i = 0; i < 3; i++) {
      planeMeshes[i].count = counts[i];
      planeMeshes[i].instanceMatrix.needsUpdate = true;
    }
    navMesh.count = navCount;
    navMesh.instanceMatrix.needsUpdate = true;
    if (navMesh.instanceColor) navMesh.instanceColor.needsUpdate = true;
    // 夜間燈光更亮
    const hour = s.clock.hour + s.clock.minute / 60;
    const night = hour < 6.5 || hour > 18.5 || s.clock.weather === 'storm';
    navMat.opacity = night ? 1 : 0.35;
    lightMat.opacity = night ? 0.95 : 0.55;
    lightMesh.visible = true;
    // 貨運站若有 airCargoTerminal，加一架貨機 stand 的 livery 已包含
  };

  return {
    group,
    update(s: GameState, dt: number): void {
      updatePlanes(s, dt);
    },
    dispose(): void {
      for (const g of geos) g.dispose();
      baseGeo.dispose();
      for (const m of mats) m.dispose();
      navGeo.dispose();
      navMat.dispose();
      lightGeo.dispose();
      lightMat.dispose();
      group.clear();
    },
  };
}
