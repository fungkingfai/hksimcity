/**
 * 《維港之城》— 建築渲染（buildings-dev）。
 *
 * 特點：
 *  - 32 種香港建築各由 `building-prototypes.ts` 程序化建立模型（可供多個外觀變體）。
 *  - 每種建築每個變體只建立一份原型；實例以 `clone()` 共用 geometry/material，
 *    同材質靜態面已合併，每棟約 3~12 個 draw call；上百棟仍可 60fps。
 *  - 霓虹招牌、晾衫竹、煙囪蒸氣、龍門吊機、挖掘機手臂、旗幟都用極廉價的
 *    transform 動畫（不改材質、不重建幾何）；颱風時招牌搖得更勁。
 *  - 夜間：共用材質切到夜燈版（玻璃幕牆窗光、亮窗暖光、霓虹全亮）＋每棟地面
 *    「萬家燈火」光暈（白天隱藏、不增加 draw call）。
 *  - 建築自動朝向：臨水建築（渡輪碼頭／貨櫃碼頭／海濱長廊）轉向水面；
 *    其餘建築面向最近的道路／行人路，令舖面招牌對正街道。
 *  - `setPreview()` 以快取的幽靈原型＋佔地格線顯示建築佔地與可否建造，
 *    只在 hover／valid 變化時更新。
 *  - 所有可點擊 mesh 都設定 userData.buildingId。
 *
 * 對外介面固定：
 *   createBuildingsView(state): BuildingsView
 *   BuildingsView.group / update(state, dt) / setPreview(state, tool, hover, valid) / dispose()
 */

import * as THREE from 'three';
import { BUILDINGS } from '../core/config';
import type { Building, GameState, TerrainType } from '../core/types';
import { buildingAnchor, buildingWorldCenter, TILE, tileWorld } from './coords';
import { MaterialLibrary } from './models/materials';
import { createPrototypeFactory, PROTOTYPE_KEYS, type PrototypeFactory } from './models/building-prototypes';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface BuildingsView {
  group: THREE.Group;
  update(state: GameState, dt: number): void;
  setPreview(state: GameState, tool: string | null, hover: number, valid: boolean): void;
  dispose(): void;
}

/** 建築底部（與 terrain／city-view 約定一致） */
const GROUND_Y = 0.28;
/** 幽靈佔地提示高度（略高於地面，避免 z-fighting） */
const PAD_Y = 0.34;

/** 臨水建築：模型「+x」方向預設面向水面（見 building-prototypes 註解）。 */
const WATER_FACING = new Set(['ferryPier', 'containerPort', 'promenade']);

// ─────────────────────────── 動畫部件 ───────────────────────────

type AnimKind = 'sign' | 'laundry' | 'smoke' | 'crane' | 'arm' | 'flag';

interface SmokeChild {
  mesh: THREE.Object3D;
  baseScale: number;
  baseY: number;
  baseX: number;
  offset: number;
}

interface AnimPart {
  obj: THREE.Object3D;
  kind: AnimKind;
  phase: number;
  baseX: number;
  baseY: number;
  baseZ: number;
  baseRotX: number;
  baseRotY: number;
  baseRotZ: number;
  baseScale: number;
  smokeChildren?: SmokeChild[];
}

interface BuildingInstance {
  id: number;
  key: string;
  group: THREE.Group;
  parts: AnimPart[];
  /** 夜間地面暖光暈（每棟 1 個 mesh，白天隱藏，不增加白天 draw call） */
  glow: THREE.Mesh | null;
  yaw: number;
}

interface GlowSpec {
  color: number;
  opacity: number;
  scale: number;
}

// ─────────────────────────── 方向判斷 ───────────────────────────

function terrainAt(s: GameState, x: number, y: number): TerrainType | null {
  if (x < 0 || y < 0 || x >= s.width || y >= s.height) return null;
  return s.tiles[y * s.width + x].terrain;
}

/** 檢查建築某一邊的外圍是否有水；dx/dz 是向外方向。 */
function sideHasWater(s: GameState, bx: number, by: number, w: number, h: number, dx: number, dz: number): boolean {
  if (dx !== 0) {
    const x = dx > 0 ? bx + w : bx - 1;
    for (let i = 0; i < h; i++) {
      if (terrainAt(s, x, by + i) === 'water') return true;
    }
    return false;
  }
  const y = dz > 0 ? by + h : by - 1;
  for (let i = 0; i < w; i++) {
    if (terrainAt(s, bx + i, y) === 'water') return true;
  }
  return false;
}

/** 檢查某一邊是否臨路／行人路（含地圖外）。 */
function sideHasRoad(s: GameState, bx: number, by: number, w: number, h: number, dx: number, dz: number): boolean {
  const check = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= s.width || y >= s.height) return false;
    const t = s.tiles[y * s.width + x];
    return t.road || t.sidewalk === true;
  };
  if (dx !== 0) {
    const x = dx > 0 ? bx + w : bx - 1;
    for (let i = 0; i < h; i++) {
      if (check(x, by + i)) return true;
    }
    return false;
  }
  const y = dz > 0 ? by + h : by - 1;
  for (let i = 0; i < w; i++) {
    if (check(bx + i, y)) return true;
  }
  return false;
}

/**
 * 臨水建築：把模型「+x」轉向水面（+x 對應 yaw 0）。
 * 回傳 yaw；無水時回 0。
 */
function waterYaw(s: GameState, bx: number, by: number, w: number, h: number): number {
  if (sideHasWater(s, bx, by, w, h, 1, 0)) return 0;
  if (sideHasWater(s, bx, by, w, h, -1, 0)) return Math.PI;
  if (sideHasWater(s, bx, by, w, h, 0, 1)) return -Math.PI / 2;
  if (sideHasWater(s, bx, by, w, h, 0, -1)) return Math.PI / 2;
  return 0;
}

/**
 * 一般建築：把模型「+z」轉向最近的道路／行人路（+z 對應 yaw 0）。
 * 優先次序：正面（南）→右（東）→左（西）→背面（北）。
 */
function roadYaw(s: GameState, bx: number, by: number, w: number, h: number): number {
  if (sideHasRoad(s, bx, by, w, h, 0, 1)) return 0;
  if (sideHasRoad(s, bx, by, w, h, 1, 0)) return Math.PI / 2;
  if (sideHasRoad(s, bx, by, w, h, -1, 0)) return -Math.PI / 2;
  if (sideHasRoad(s, bx, by, w, h, 0, -1)) return Math.PI;
  return 0;
}

function buildingYaw(s: GameState, key: string, bx: number, by: number, w: number, h: number): number {
  return WATER_FACING.has(key) ? waterYaw(s, bx, by, w, h) : roadYaw(s, bx, by, w, h);
}

// ─────────────────────────── 夜景燈火配色 ───────────────────────────

/** 建築類型的夜間燈火配色（香港：住宅暖黃、商業霓虹、工業偏暗、交通有主題色）。 */
function glowSpecFor(key: string, variant: number): GlowSpec {
  switch (key) {
    case 'tongLau':
    case 'subdividedFlat':
      return { color: 0xffb76a, opacity: 0.85, scale: 1.05 };
    case 'publicHousing':
    case 'hOSFlat':
      return { color: 0xffc888, opacity: 0.7, scale: 1.15 };
    case 'privateEstate':
    case 'luxuryTower':
      return { color: 0xffe0a8, opacity: 0.8, scale: 1.25 };
    case 'chaChaanTeng':
    case 'restaurant':
      return { color: 0xff5f8f, opacity: 0.95, scale: 1.1 };
    case 'convenienceStore':
      return { color: 0x5cffb0, opacity: 0.85, scale: 0.9 };
    case 'wetMarket':
      return { color: 0xff7a4a, opacity: 0.9, scale: 1.1 };
    case 'supermarket':
      return { color: 0xffd166, opacity: 0.85, scale: 1.1 };
    case 'shoppingMall':
      return { color: 0xa45bff, opacity: 1.0, scale: 1.35 };
    case 'officeTower':
      return { color: 0x24e0ff, opacity: 0.85, scale: 1.25 };
    case 'importFirm':
    case 'warehouse':
      return { color: 0xffc07a, opacity: 0.55, scale: 0.95 };
    case 'industrialBuilding':
    case 'foodFactory':
      return { color: 0xffb070, opacity: 0.5, scale: 1.0 };
    case 'farm':
      return { color: 0xffd68a, opacity: 0.35, scale: 0.8 };
    case 'quarry':
    case 'powerPlant':
    case 'waterworks':
      return { color: 0xff9a4a, opacity: 0.45, scale: 1.1 };
    case 'containerPort':
      return { color: 0x7fd6ff, opacity: 0.6, scale: 1.25 };
    case 'hospital':
      return { color: 0xffffff, opacity: 0.65, scale: 1.15 };
    case 'policeStation':
      return { color: 0x5f8fff, opacity: 0.6, scale: 1.0 };
    case 'fireStation':
      return { color: 0xff5a4a, opacity: 0.6, scale: 1.0 };
    case 'school':
      return { color: 0xbfe0ff, opacity: 0.5, scale: 1.1 };
    case 'mtrStation':
      return { color: 0xff5a5a, opacity: 0.95, scale: 1.15 };
    case 'busTerminus':
      return { color: 0xffd166, opacity: 0.7, scale: 1.1 };
    case 'tramStop':
      return { color: 0x5cff9d, opacity: 0.7, scale: 0.85 };
    case 'ferryPier':
      return { color: 0x5cffb0, opacity: 0.8, scale: 1.25 };
    case 'park':
    case 'promenade':
      return { color: 0x9fe08a, opacity: 0.55, scale: 1.15 };
    default:
      return { color: 0xffc07a, opacity: 0.5, scale: 1.0 };
  }
}

// ─────────────────────────── 視圖 ───────────────────────────

export function createBuildingsView(state: GameState): BuildingsView {
  const group = new THREE.Group();
  group.name = 'buildings';

  const lib = new MaterialLibrary();
  const factory: PrototypeFactory = createPrototypeFactory(lib);
  const instances = new Map<number, BuildingInstance>();
  let elapsed = 0;

  // 開發期核對：config 的每個建築 key 都要有原型（只警告，不阻塞）
  try {
    const missing = Object.keys(BUILDINGS).filter((key) => !PROTOTYPE_KEYS.includes(key));
    if (missing.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[buildings] 以下建築缺少原型，將用通用後備：${missing.join(', ')}`);
    }
  } catch {
    /* 測試環境可能無 console，略過 */
  }

  // ── 夜間「萬家燈火」：共用徑向漸層貼圖 + 共用材質快取 ──
  const glowTexture = lib.canvasTexture(128, 128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 3, 64, 64, 63);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.5)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.16)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
  const glowGroundQuad = new THREE.PlaneGeometry(1, 1);
  glowGroundQuad.rotateX(-Math.PI / 2);
  const glowVerticalQuad = new THREE.PlaneGeometry(0.95, 0.95);
  glowVerticalQuad.translate(0, 0.55, 0);
  const glowGeometry = mergeGeometries([glowGroundQuad, glowVerticalQuad], false) ?? glowGroundQuad;
  glowGroundQuad.dispose();
  glowVerticalQuad.dispose();
  const glowMaterials = new Map<string, THREE.MeshBasicMaterial>();
  const glowMaterialFor = (color: number, opacity: number): THREE.MeshBasicMaterial => {
    const key = `${color}|${opacity}`;
    const found = glowMaterials.get(key);
    if (found) return found;
    const mat = lib.own(
      new THREE.MeshBasicMaterial({
        map: glowTexture ?? undefined,
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
        forceSinglePass: true,
        fog: false,
      }),
    ) as THREE.MeshBasicMaterial;
    glowMaterials.set(key, mat);
    return mat;
  };

  const isNightClock = (clock: GameState['clock']): boolean => {
    const minutes = clock.hour * 60 + clock.minute;
    return minutes >= 18 * 60 + 30 || minutes < 6 * 60 + 30;
  };
  let nightMode = isNightClock(state.clock);
  lib.setNightMode(nightMode);

  /** 只在日／夜狀態切換時更新共用材質與所有光暈可見度。 */
  const applyNightMode = (night: boolean): void => {
    if (night === nightMode) return;
    nightMode = night;
    lib.setNightMode(night);
    for (const inst of instances.values()) {
      if (inst.glow) inst.glow.visible = night;
    }
  };

  // ── 幽靈／佔地預覽 ──
  const ghostLayer = new THREE.Group();
  ghostLayer.name = 'buildings-preview';
  ghostLayer.visible = false;
  group.add(ghostLayer);
  const ghostHolder = new THREE.Group();
  ghostLayer.add(ghostHolder);

  const ghostOkMat = new THREE.MeshBasicMaterial({
    color: 0x7fd6a0,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ghostBadMat = new THREE.MeshBasicMaterial({
    color: 0xd46060,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const padOkMat = new THREE.MeshBasicMaterial({
    color: 0x7fd6a0,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const padBadMat = new THREE.MeshBasicMaterial({
    color: 0xd46060,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const lineOkMat = new THREE.LineBasicMaterial({ color: 0xbff2cf, transparent: true, opacity: 0.9 });
  const lineBadMat = new THREE.LineBasicMaterial({ color: 0xffc9c9, transparent: true, opacity: 0.9 });

  const ghostCache = new Map<string, THREE.Group>();
  const padCache = new Map<string, { pad: THREE.BufferGeometry; lines: THREE.BufferGeometry }>();
  const padMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> = new THREE.Mesh(
    new THREE.BoxGeometry(1, 0.04, 1),
    padOkMat,
  );
  padMesh.visible = false;
  ghostLayer.add(padMesh);
  const padLines = new THREE.LineSegments(new THREE.BufferGeometry(), lineOkMat);
  padLines.visible = false;
  ghostLayer.add(padLines);
  let currentGhost: THREE.Group | null = null;
  let lastPreviewSig = '';

  // ─────────────────────── 建立／移除實例 ───────────────────────

  const collectAnimParts = (root: THREE.Object3D, building: Building): AnimPart[] => {
    const parts: AnimPart[] = [];
    const phaseBase = building.id * 0.73;
    root.traverse((obj) => {
      const kind = obj.userData?.anim as AnimKind | undefined;
      if (!kind) return;
      const part: AnimPart = {
        obj,
        kind,
        phase: phaseBase + parts.length * 1.7,
        baseX: obj.position.x,
        baseY: obj.position.y,
        baseZ: obj.position.z,
        baseRotX: obj.rotation.x,
        baseRotY: obj.rotation.y,
        baseRotZ: obj.rotation.z,
        baseScale: obj.scale.x,
      };
      if (kind === 'smoke') {
        part.smokeChildren = obj.children.map((child, i) => ({
          mesh: child,
          baseScale: child.scale.x,
          baseY: child.position.y,
          baseX: child.position.x,
          offset: i * 0.3,
        }));
      }
      parts.push(part);
    });
    return parts;
  };

  const addBuilding = (s: GameState, building: Building): void => {
    const proto = factory.get(building.key, building.id);
    const model = proto.root.clone(true);
    const center = buildingWorldCenter(s, building);
    model.position.set(center.x, GROUND_Y, center.z);
    const yaw = buildingYaw(s, building.key, building.x, building.y, building.w, building.h);
    model.rotation.y = yaw;
    model.userData.buildingId = building.id;
    model.traverse((obj) => {
      obj.userData.buildingId = building.id;
    });

    // 夜間地面暖光暈（不設 buildingId，raycast 停用，避免影響點選）
    let glow: THREE.Mesh | null = null;
    if (glowTexture) {
      const spec = glowSpecFor(building.key, building.id);
      const footprint = (proto.footprintW + proto.footprintD) / 2;
      const size = Math.min(6.2, Math.max(2.2, footprint + 1.0 * spec.scale));
      glow = new THREE.Mesh(glowGeometry, glowMaterialFor(spec.color, spec.opacity));
      // 放在建築正面少許（模型 +z 為正面），令暖光灑到臨街一方
      glow.position.set(0, 0.02, proto.footprintD / 2 + 0.25);
      glow.scale.setScalar(size);
      glow.renderOrder = 2;
      glow.visible = nightMode;
      glow.raycast = () => {
        /* 光暈不參與點選 */
      };
      model.add(glow);
    }

    group.add(model);
    instances.set(building.id, {
      id: building.id,
      key: building.key,
      group: model,
      parts: collectAnimParts(model, building),
      glow,
      yaw,
    });
  };

  const removeBuilding = (id: number): void => {
    const inst = instances.get(id);
    if (!inst) return;
    group.remove(inst.group);
    instances.delete(id);
  };

  const sync = (s: GameState): void => {
    const seen = new Set<number>();
    for (const b of s.buildings) {
      seen.add(b.id);
      if (!instances.has(b.id)) addBuilding(s, b);
    }
    for (const id of [...instances.keys()]) {
      if (!seen.has(id)) removeBuilding(id);
    }
  };

  sync(state);

  // ─────────────────────── 每幀動畫 ───────────────────────

  /** 風勢：颱風時招牌／晾衫大幅度擺動。 */
  const windFor = (s: GameState): number => {
    switch (s.clock.weather) {
      case 'storm':
        return 2.4;
      case 'rain':
        return 1.35;
      case 'fog':
        return 0.7;
      case 'snow':
        return 1.1;
      default:
        return 1;
    }
  };

  const animateParts = (inst: BuildingInstance, wind: number): void => {
    const t = elapsed;
    for (const part of inst.parts) {
      switch (part.kind) {
        case 'sign': {
          // 霓虹招牌隨風搖曳（輕微，不會轉到穿牆）
          const amp = 0.035 * wind;
          part.obj.rotation.z = part.baseRotZ + Math.sin(t * 1.6 + part.phase) * amp;
          part.obj.rotation.x = part.baseRotX + Math.sin(t * 1.05 + part.phase * 1.3) * amp * 0.5;
          break;
        }
        case 'laundry': {
          // 晾衫竹＋衫褲擺動
          part.obj.rotation.x = part.baseRotX + Math.sin(t * 2.9 + part.phase) * 0.12 * wind;
          part.obj.rotation.z = part.baseRotZ + Math.sin(t * 1.7 + part.phase * 0.8) * 0.05 * wind;
          break;
        }
        case 'smoke': {
          // 煙／蒸氣：煙團上升放大循環
          if (part.smokeChildren) {
            for (const child of part.smokeChildren) {
              const cycle = (t * 0.22 + part.phase * 0.12 + child.offset) % 1;
              const grow = 0.4 + cycle * 1.8;
              child.mesh.scale.setScalar(child.baseScale * grow);
              child.mesh.position.y = child.baseY + cycle * 1.0;
              child.mesh.position.x = child.baseX + Math.sin(cycle * 4 + part.phase) * 0.12 * wind;
            }
          }
          break;
        }
        case 'crane': {
          // 龍門吊機小車沿懸臂來回
          part.obj.position.x = part.baseX + Math.sin(t * 0.5 + part.phase) * 1.1;
          part.obj.position.z = part.baseZ + Math.cos(t * 0.34 + part.phase) * 0.3;
          break;
        }
        case 'arm': {
          // 挖掘機手臂擺動
          part.obj.rotation.z = part.baseRotZ + Math.sin(t * 0.6 + part.phase) * 0.28;
          part.obj.rotation.y = part.baseRotY + Math.sin(t * 0.35 + part.phase * 0.7) * 0.12;
          break;
        }
        case 'flag': {
          // 旗幟飄揚
          part.obj.rotation.y = part.baseRotY + Math.sin(t * 2.4 + part.phase) * 0.35 * wind;
          part.obj.rotation.z = part.baseRotZ + Math.sin(t * 1.6 + part.phase) * 0.06 * wind;
          break;
        }
      }
    }
  };

  // ─────────────────────── 預覽 ───────────────────────

  const getGhost = (key: string, valid: boolean): THREE.Group => {
    const cacheKey = `${key}|${valid ? 1 : 0}`;
    const found = ghostCache.get(cacheKey);
    if (found) return found;
    const proto = factory.get(key, 0);
    const ghost = proto.root.clone(true);
    const mat = valid ? ghostOkMat : ghostBadMat;
    ghost.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.material = mat;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      }
    });
    // 幽靈光暈／貼圖不要
    ghostCache.set(cacheKey, ghost);
    return ghost;
  };

  /** 佔地格線幾何（外框＋每格分隔線）。 */
  const getPadGeometry = (wTiles: number, hTiles: number): { pad: THREE.BufferGeometry; lines: THREE.BufferGeometry } => {
    const key = `${wTiles}x${hTiles}`;
    const found = padCache.get(key);
    if (found) return found;
    const w = wTiles * TILE;
    const h = hTiles * TILE;
    const pad = new THREE.BoxGeometry(w - 0.12, 0.04, h - 0.12);
    const pts: number[] = [];
    const y = 0.03;
    // 外框
    pts.push(-w / 2 + 0.06, y, -h / 2 + 0.06, w / 2 - 0.06, y, -h / 2 + 0.06);
    pts.push(w / 2 - 0.06, y, -h / 2 + 0.06, w / 2 - 0.06, y, h / 2 - 0.06);
    pts.push(w / 2 - 0.06, y, h / 2 - 0.06, -w / 2 + 0.06, y, h / 2 - 0.06);
    pts.push(-w / 2 + 0.06, y, h / 2 - 0.06, -w / 2 + 0.06, y, -h / 2 + 0.06);
    // 格線
    for (let i = 1; i < wTiles; i++) {
      const x = -w / 2 + i * TILE;
      pts.push(x, y, -h / 2 + 0.06, x, y, h / 2 - 0.06);
    }
    for (let j = 1; j < hTiles; j++) {
      const z = -h / 2 + j * TILE;
      pts.push(-w / 2 + 0.06, y, z, w / 2 - 0.06, y, z);
    }
    const lines = new THREE.BufferGeometry();
    lines.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const entry = { pad, lines };
    padCache.set(key, entry);
    return entry;
  };

  const showPad = (wTiles: number, hTiles: number, cx: number, cz: number, valid: boolean, y = PAD_Y): void => {
    const entry = getPadGeometry(wTiles, hTiles);
    padMesh.geometry = entry.pad;
    padMesh.position.set(cx, y, cz);
    padMesh.material = valid ? padOkMat : padBadMat;
    padMesh.visible = true;
    padLines.geometry = entry.lines;
    padLines.position.set(cx, y + 0.02, cz);
    padLines.material = valid ? lineOkMat : lineBadMat;
    padLines.visible = true;
  };

  const hidePad = (): void => {
    padMesh.visible = false;
    padLines.visible = false;
  };

  const clearGhost = (): void => {
    if (currentGhost) {
      ghostHolder.remove(currentGhost);
      currentGhost = null;
    }
  };

  const setPreview = (s: GameState, tool: string | null, hover: number, valid: boolean): void => {
    const sig = `${tool}|${hover}|${valid ? 1 : 0}|${s.buildings.length}|${s.ui.mode}`;
    if (sig === lastPreviewSig) return;
    lastPreviewSig = sig;

    if (!tool || hover < 0 || hover >= s.tiles.length || s.ui.mode !== 'city') {
      ghostLayer.visible = false;
      clearGhost();
      hidePad();
      return;
    }

    ghostLayer.visible = true;
    const tile = s.tiles[hover];
    const tx = hover % s.width;
    const ty = Math.floor(hover / s.width);

    // 道路／行人路／拆除：只顯示該格佔地
    if (tool === 'road' || tool === 'sidewalk' || tool === 'demolish') {
      clearGhost();
      const center = tileWorld(tx, ty, s.width, s.height);
      const ok = tool === 'road' || tool === 'sidewalk' ? valid : tile.buildingId >= 0 || tile.road;
      showPad(1, 1, center.x, center.z, ok, 0.42);
      return;
    }

    const def = BUILDINGS[tool];
    if (!def) {
      ghostLayer.visible = false;
      clearGhost();
      hidePad();
      return;
    }
    const [w, h] = def.size;
    const anchor = buildingAnchor(s, tool, w, h, tx, ty);
    const cx = (anchor.x + w / 2) * TILE - (s.width * TILE) / 2;
    const cz = (anchor.y + h / 2) * TILE - (s.height * TILE) / 2;
    const ghost = getGhost(tool, valid);
    if (currentGhost !== ghost) {
      clearGhost();
      ghostHolder.add(ghost);
      currentGhost = ghost;
    }
    // 幽靈模型本體（與正式建築相同朝向：臨水轉向水面、其餘面向道路）
    ghost.rotation.y = buildingYaw(s, tool, anchor.x, anchor.y, w, h);
    ghostHolder.position.set(cx, GROUND_Y, cz);
    ghostHolder.visible = true;
    showPad(w, h, cx, cz, valid, GROUND_Y + 0.02);
  };

  // ─────────────────────── 對外 ───────────────────────

  return {
    group,

    update(s: GameState, dt: number): void {
      elapsed += Math.min(0.1, dt);
      applyNightMode(isNightClock(s.clock));
      sync(s);
      const wind = windFor(s);
      for (const inst of instances.values()) animateParts(inst, wind);
    },

    setPreview,

    dispose(): void {
      for (const id of [...instances.keys()]) removeBuilding(id);
      factory.dispose();
      ghostCache.clear();
      for (const entry of padCache.values()) {
        entry.pad.dispose();
        entry.lines.dispose();
      }
      padCache.clear();
      glowGeometry.dispose();
      padMesh.geometry.dispose();
      padLines.geometry.dispose();
      ghostOkMat.dispose();
      ghostBadMat.dispose();
      padOkMat.dispose();
      padBadMat.dispose();
      lineOkMat.dispose();
      lineBadMat.dispose();
      lib.dispose();
    },
  };
}
