/**
 * 華夏古城 — 建築模型幾何工具：基礎圖元、中式曲面屋頂、靜態幾何合併。
 *
 * 中式屋頂（曲面＋起翹）核心是 `buildCurvedRoof()`：以多層矩形環放樣出
 * 凹曲屋面（近脊陡、近簷緩），四角加「起翹」與外張，形成飛簷效果；
 * 另回傳屋脊／簷角資料，讓 chinese-parts 加脊獸、垂脊、簷口裝飾。
 *
 * 效能：
 *  - `mergeStaticMeshes()` 把原型內同材質的 mesh 合併為少數 BufferGeometry，
 *    使每棟建築實例只需 6~12 個 draw call（而非數十個）。
 *  - 所有原型幾何只建立一次，建築實例以 clone() 共用 geometry/material。
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MaterialLibrary } from './materials';

export type Mat = THREE.Material;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

// ─────────────────────────── 基礎圖元 ───────────────────────────

export function addBox(
  parent: THREE.Object3D,
  mat: Mat,
  w: number,
  h: number,
  d: number,
  x = 0,
  y = 0,
  z = 0,
  ry = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  if (ry) mesh.rotation.y = ry;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function addCylinder(
  parent: THREE.Object3D,
  mat: Mat,
  rTop: number,
  rBottom: number,
  h: number,
  x = 0,
  y = 0,
  z = 0,
  segments = 8,
  ry = 0,
  rz = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, segments), mat);
  mesh.position.set(x, y, z);
  if (ry) mesh.rotation.y = ry;
  if (rz) mesh.rotation.z = rz;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function addCone(
  parent: THREE.Object3D,
  mat: Mat,
  r: number,
  h: number,
  x = 0,
  y = 0,
  z = 0,
  segments = 8,
  ry = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.ConeGeometry(r, h, segments), mat);
  mesh.position.set(x, y, z);
  if (ry) mesh.rotation.y = ry;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function addSphere(
  parent: THREE.Object3D,
  mat: Mat,
  r: number,
  x = 0,
  y = 0,
  z = 0,
  segW = 8,
  segH = 6,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, segW, segH), mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** 平面（預設水平朝上；rx=-PI/2）。 */
export function addPlane(
  parent: THREE.Object3D,
  mat: Mat,
  w: number,
  h: number,
  x = 0,
  y = 0,
  z = 0,
  rx = -Math.PI / 2,
  ry = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, 0);
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** 車削體（酒罈、燈籠、花瓶、佛像）。points: [半徑, y] 由下而上。 */
export function addLathe(
  parent: THREE.Object3D,
  mat: Mat,
  points: [number, number][],
  x = 0,
  y = 0,
  z = 0,
  segments = 10,
): THREE.Mesh {
  const vecs = points.map(([r, py]) => new THREE.Vector2(Math.max(0.0001, r), py));
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(vecs, segments), mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** 兩點之間的樑（截面近似方形的圓柱）。 */
export function addBeamBetween(
  parent: THREE.Object3D,
  mat: Mat,
  a: THREE.Vector3,
  b: THREE.Vector3,
  thickness = 0.1,
  segments = 4,
): THREE.Mesh {
  const dir = _v1.copy(b).sub(a);
  const len = Math.max(0.001, dir.length());
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(thickness * 0.5, thickness * 0.5, len, segments), mat);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  _q.setFromUnitVectors(UP, _v2.copy(dir).normalize());
  mesh.quaternion.copy(_q);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** 不規則山石（低多邊形）。 */
export function addRock(parent: THREE.Object3D, mat: Mat, x: number, z: number, scale = 1, seed = 0): THREE.Mesh {
  const geo = new THREE.DodecahedronGeometry(Math.max(0.06, 0.28 * scale), 0);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const jitter = 0.82 + ((Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453) % 1 + 1) * 0.09;
    pos.setXYZ(i, pos.getX(i) * jitter, pos.getY(i) * jitter * 0.72, pos.getZ(i) * jitter);
  }
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, 0.2 * scale, z);
  mesh.rotation.y = seed * 1.7;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

// ─────────────────────────── 中式曲面屋頂 ───────────────────────────

export interface CurvedRoofOptions {
  /** 簷口寬（x 向） */
  width: number;
  /** 簷口深（z 向） */
  depth: number;
  /** 脊高（簷口至脊） */
  height?: number;
  /** 正脊長度；0 = 攢尖（四角錐） */
  ridge?: number;
  /** 坡度分段（越大越平滑） */
  slopeSegments?: number;
  /** 簷口每邊分段（越大起翹越平滑） */
  edgeSegments?: number;
  /** 凹曲指數：>1 近簷緩、近脊陡 */
  curve?: number;
  /** 四角起翹高度 */
  cornerLift?: number;
  /** 四角外張（飛簷） */
  cornerFlare?: number;
}

export interface RoofFrame {
  geometry: THREE.BufferGeometry;
  /** 四個簷角（已含起翹），順序：(-x,-z) (+x,-z) (+x,+z) (-x,+z) */
  corners: THREE.Vector3[];
  /** 正脊兩端（攢尖時同為頂點） */
  ridgeA: THREE.Vector3;
  ridgeB: THREE.Vector3;
  ridgeLength: number;
  height: number;
}

/** 取屋頂某一點（edge 0..3、u 0..1、t 0=簷 1=脊），含起翹。 */
function roofPoint(
  edge: number,
  u: number,
  t: number,
  hw0: number,
  hd0: number,
  ridgeHalf: number,
  hasRidge: boolean,
  height: number,
  curve: number,
  lift: number,
  flare: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const hx = hasRidge ? hw0 + (ridgeHalf - hw0) * t : hw0 * (1 - t);
  const hz = hd0 * (1 - t);
  const ax = edge === 0 || edge === 3 ? -hx : hx;
  const az = edge === 0 || edge === 1 ? -hz : hz;
  const bx = edge === 0 || edge === 1 ? hx : -hx;
  const bz = edge === 1 || edge === 2 ? hz : -hz;
  const px = ax + (bx - ax) * u;
  const pz = az + (bz - az) * u;
  const eaveFactor = Math.pow(1 - t, 2);
  const proxRaw = Math.min(u, 1 - u) / 0.34;
  const prox = proxRaw >= 1 ? 0 : Math.pow(1 - proxRaw, 2);
  let ox = 0;
  let oz = 0;
  let oy = 0;
  if (eaveFactor > 0.0001 && prox > 0) {
    const len = Math.hypot(px, pz) || 1;
    ox = (px / len) * flare * prox * eaveFactor;
    oz = (pz / len) * flare * prox * eaveFactor;
    oy = lift * prox * eaveFactor;
  }
  out.set(px + ox, height * Math.pow(t, curve) + oy, pz + oz);
  return out;
}

/**
 * 建立中式曲面屋頂幾何，並回傳屋脊／簷角資訊。
 * 屋頂原點在簷口平面中心（y=0），向上生長。
 */
export function buildCurvedRoof(options: CurvedRoofOptions): RoofFrame {
  const width = Math.max(0.2, options.width);
  const depth = Math.max(0.2, options.depth);
  const height = options.height ?? Math.min(width, depth) * 0.42;
  const hasRidge = (options.ridge ?? 0) > 0.02;
  const ridgeHalf = hasRidge ? Math.min(options.ridge! / 2, width * 0.42) : 0;
  const S = Math.max(3, Math.round(options.slopeSegments ?? 6));
  const E = Math.max(3, Math.round(options.edgeSegments ?? 6));
  const curve = options.curve ?? 1.62;
  const lift = options.cornerLift ?? height * 0.2;
  const flare = options.cornerFlare ?? Math.min(width, depth) * 0.075;
  const hw0 = width / 2;
  const hd0 = depth / 2;
  const N = E * 4;

  const rings: THREE.Vector3[][] = [];
  for (let r = 0; r <= S; r++) {
    const t = r / S;
    const ring: THREE.Vector3[] = [];
    for (let e = 0; e < 4; e++) {
      for (let i = 0; i < E; i++) {
        ring.push(roofPoint(e, i / E, t, hw0, hd0, ridgeHalf, hasRidge, height, curve, lift, flare, new THREE.Vector3()));
      }
    }
    rings.push(ring);
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const ring of rings) {
    for (const p of ring) {
      positions.push(p.x, p.y, p.z);
    }
  }
  for (let r = 0; r <= S; r++) {
    for (let j = 0; j < N; j++) {
      uvs.push(j / N, r / S);
    }
  }
  for (let r = 0; r < S; r++) {
    const base = r * N;
    const next = (r + 1) * N;
    for (let j = 0; j < N; j++) {
      const j2 = (j + 1) % N;
      const a = base + j;
      const b = base + j2;
      const c = next + j2;
      const d = next + j;
      indices.push(a, b, c, a, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  // 確保法線朝上／朝外：抽查第一圈非退化三角形
  const normalAttr = geometry.getAttribute('normal') as THREE.BufferAttribute;
  let upness = 0;
  for (let i = 0; i < Math.min(normalAttr.count, 12); i++) upness += normalAttr.getY(i);
  if (upness < 0) {
    const idx = geometry.getIndex()!;
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i);
      const b = idx.getX(i + 1);
      idx.setX(i, b);
      idx.setX(i + 1, a);
    }
    idx.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  const corners: THREE.Vector3[] = [];
  for (let e = 0; e < 4; e++) {
    corners.push(roofPoint(e, 0, 0, hw0, hd0, ridgeHalf, hasRidge, height, curve, lift, flare, new THREE.Vector3()));
  }
  const ridgeA = new THREE.Vector3(-ridgeHalf, height, 0);
  const ridgeB = new THREE.Vector3(ridgeHalf, height, 0);

  return { geometry, corners, ridgeA, ridgeB, ridgeLength: ridgeHalf * 2, height };
}

// ─────────────────────────── 合併與清理 ───────────────────────────

function isMesh(obj: THREE.Object3D): obj is THREE.Mesh {
  return (obj as THREE.Mesh).isMesh === true;
}

interface MergeBucket {
  material: THREE.Material;
  /** null = 保留原材質（貼圖／透明），不動頂點色 */
  color: THREE.Color | null;
  geos: THREE.BufferGeometry[];
}

const _inv = new THREE.Matrix4();

function transformedGeometry(mesh: THREE.Mesh, matrix: THREE.Matrix4, color: THREE.Color | null): THREE.BufferGeometry {
  const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  geo.applyMatrix4(matrix);
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
  }
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  if (!geo.getAttribute('uv')) {
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pos.count * 2), 2));
  }
  if (color) {
    const data = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      data[i * 3] = color.r;
      data[i * 3 + 1] = color.g;
      data[i * 3 + 2] = color.b;
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(data, 3));
  }
  return geo;
}

function hasGlowMaterial(mat: THREE.Material): boolean {
  const basic = mat as THREE.MeshBasicMaterial;
  if (basic.isMeshBasicMaterial) return true;
  const lam = mat as THREE.MeshLambertMaterial;
  const em = lam.emissive;
  return !!em && em.r + em.g + em.b > 0.02;
}

function classifyStatic(mat: THREE.Material, lib: MaterialLibrary): MergeBucket {
  const side = mat.side;
  const anyMat = mat as THREE.MeshLambertMaterial & THREE.MeshBasicMaterial;
  if (anyMat.map || mat.transparent) {
    return { material: mat, color: null, geos: [] };
  }
  // 香港版：霓虹光管（hk-parts.neonTube）合併為 vertexNeon，夜間才全亮
  if (mat.userData?.hkNeon) {
    return { material: lib.vertexNeon(side), color: anyMat.color.clone(), geos: [] };
  }
  if (anyMat.isMeshBasicMaterial) {
    return { material: lib.vertexBasic(side), color: anyMat.color.clone(), geos: [] };
  }
  if (hasGlowMaterial(mat)) {
    return { material: lib.vertexWarm(side), color: anyMat.color.clone(), geos: [] };
  }
  return { material: lib.vertexLit(side), color: anyMat.color.clone(), geos: [] };
}

interface MergeEntry {
  mesh: THREE.Mesh;
  matrix: THREE.Matrix4;
  material: THREE.Material;
}

/** 收集子樹中的 mesh（遇到動畫節點就停下，交給動畫合併處理）。 */
function collectSubtreeMeshes(node: THREE.Object3D, stopAtAnim: boolean, into: MergeEntry[], baseMatrix: THREE.Matrix4): void {
  node.updateMatrixWorld(true);
  const walk = (obj: THREE.Object3D): void => {
    for (const child of obj.children) {
      if (stopAtAnim && child.userData?.anim) continue;
      if (isMesh(child)) {
        const mat = Array.isArray(child.material) ? null : child.material;
        if (!mat) continue;
        const world = child.matrixWorld.clone();
        const rel = _inv.copy(baseMatrix).invert().multiply(world).clone();
        into.push({ mesh: child, matrix: rel, material: mat });
      } else {
        walk(child);
      }
    }
  };
  walk(node);
}

/**
 * 把原型內靜態、單材質的 mesh 依「頂點色桶」合併：
 *  - 不透明受光面 → 1 個頂點色 mesh（牆、木、瓦、石…色彩烘進頂點色）
 *  - 雙面受光面（屋頂殼）→ 1 個頂點色雙面 mesh
 *  - 微自發光面（窗紙、貼金）→ 1 個暖光頂點色 mesh
 *  - 自發光基本材質（火焰）→ 1 個不受光頂點色 mesh
 *  - 貼圖／透明材質（匾額、旗幡、炊煙）→ 依材質各 1 個 mesh
 * 動畫節點（燈籠、旗布、炊煙、船、爐火）另外做局部合併，保留節點變換。
 * 結果：每棟建築約 4~9 個 draw call（原本 25~35 個）。
 */
export function mergeStaticMeshes(root: THREE.Object3D, lib: MaterialLibrary): void {
  root.updateMatrixWorld(true);

  // ── 收集靜態 mesh 與動畫節點 ──
  const statics: MergeEntry[] = [];
  const animNodes: THREE.Object3D[] = [];
  const walkStatic = (obj: THREE.Object3D): void => {
    for (const child of obj.children) {
      if (child.userData?.anim) {
        animNodes.push(child);
        continue;
      }
      if (isMesh(child)) {
        const mat = Array.isArray(child.material) ? null : child.material;
        if (!mat) continue;
        statics.push({ mesh: child, matrix: child.matrixWorld.clone(), material: mat });
      } else {
        walkStatic(child);
      }
    }
  };
  walkStatic(root);

  const disposeSources = (entries: MergeEntry[]): void => {
    for (const entry of entries) entry.mesh.removeFromParent();
    const keep = new Set<THREE.BufferGeometry>();
    root.traverse((obj) => {
      if (isMesh(obj) && obj.geometry) keep.add(obj.geometry);
    });
    for (const entry of entries) {
      if (!keep.has(entry.mesh.geometry)) entry.mesh.geometry.dispose();
    }
  };

  // ── 靜態合併 ──
  if (statics.length) {
    const buckets = new Map<string, MergeBucket>();
    for (const entry of statics) {
      const bucket = classifyStatic(entry.material, lib);
      const key = `${bucket.material.uuid}|${bucket.color ? '' : entry.material.uuid}`;
      let target = buckets.get(key);
      if (!target) {
        target = { material: bucket.material, color: bucket.color, geos: [] };
        buckets.set(key, target);
      }
      target.geos.push(transformedGeometry(entry.mesh, entry.matrix, bucket.color));
    }
    disposeSources(statics);
    for (const bucket of buckets.values()) {
      const merged = mergeGeometries(bucket.geos, false);
      for (const g of bucket.geos) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, bucket.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      root.add(mesh);
    }
  }

  // ── 動畫節點局部合併（保留節點自身變換供每幀動畫） ──
  for (const node of animNodes) {
    node.updateMatrixWorld(true);
    const entries: MergeEntry[] = [];
    collectSubtreeMeshes(node, true, entries, node.matrixWorld);
    if (!entries.length) continue;
    const glow = entries.some((e) => hasGlowMaterial(e.material));
    const buckets = new Map<string, MergeBucket>();
    for (const entry of entries) {
      const anyMat = entry.material as THREE.MeshLambertMaterial & THREE.MeshBasicMaterial;
      let bucket: MergeBucket;
      if (anyMat.map || entry.material.transparent) {
        bucket = { material: entry.material, color: null, geos: [] };
      } else if (entry.material.userData?.hkNeon) {
        // 動畫節點內的霓虹光管：同樣走 vertexNeon（保留節點變換）
        bucket = { material: lib.vertexNeon(entry.material.side), color: anyMat.color.clone(), geos: [] };
      } else {
        const side = entry.material.side;
        bucket = {
          material: lib.vertexAnim(side, glow),
          color: anyMat.color.clone(),
          geos: [],
        };
      }
      const key = `${bucket.material.uuid}|${bucket.color ? '' : entry.material.uuid}`;
      let target = buckets.get(key);
      if (!target) {
        target = { material: bucket.material, color: bucket.color, geos: [] };
        buckets.set(key, target);
      }
      target.geos.push(transformedGeometry(entry.mesh, entry.matrix, bucket.color));
    }
    disposeSources(entries);
    for (const bucket of buckets.values()) {
      const merged = mergeGeometries(bucket.geos, false);
      for (const g of bucket.geos) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, bucket.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      node.add(mesh);
    }
  }
}

/** 遞迴釋放 geometry／material（貼圖交由 MaterialLibrary 統一釋放）。 */
export function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat) continue;
        const m = mat as THREE.MeshBasicMaterial;
        if (m.map) m.map = null;
        mat.dispose();
      }
    }
    const line = obj as THREE.Line;
    if ((line as THREE.Line).isLine || (line as THREE.LineSegments).isLineSegments) {
      line.geometry?.dispose();
      const mat = line.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    }
  });
}
