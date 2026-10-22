/**
 * 香港行人與物流貨車渲染（citizens-dev）。
 *
 * 行人（低多邊形、InstancedMesh 共用幾何，目標 60fps）：
 *   - 香港人物類型：西裝上班族、校服學生（書包）、師奶買餸（紅白藍膠袋）、
 *     長者（灰髮、駝背）、情侶（成對色系）、遊客（鮮色衫＋相機袋）、工友（反光衣）。
 *   - 動畫：手腳擺動、身體微晃、朝向移動方向；同格內以 look 種子錯開。
 *   - 天氣：雨天／颱風撐傘；颱風時行人數目減少；夜晚行人稀少、城市燈光下仍有夜歸人。
 *   - 在家（state === 'home'）的市民不畫；港鐵／渡輪乘車中的市民隱藏（人在車廂／船上）。
 *
 * 物流貨車（state.carts）：
 *   - 依 cart.vehicleKind 畫白色貨車（truck）或白色／銀色客貨車（van）；
 *   - 沿 cart.path 插值移動、朝向行车方向；夜晚亮車頭燈（暖白）與尾燈（紅）；
 *   - 貨種顏色只作輕微點綴（車身主要為白／藍，符合香港貨車外觀）。
 *
 * 對外介面（不可破壞）：createCitizensView(state): CitizensView
 *   CitizensView.group / update(state, dt) / dispose()
 *
 * 座標：citizen.x/y 為格中心座標（tx+0.5）→ 世界 x = x*TILE - width*TILE/2。
 * cart.path 為 tile index；cart.x/y 為格索引浮點（fallback 用）。
 */

import * as THREE from 'three';
import type { Building, Cart, Citizen, GameState } from '../core/types';
import { TILE } from './coords';

export interface CitizensView {
  group: THREE.Group;
  update(state: GameState, dt: number): void;
  dispose(): void;
}

// ─────────────────────────── 設定 ───────────────────────────

/** 同屏最多行人（人口 1600 時以 id 抽樣保持穩定；效能考量） */
const MAX_VISIBLE = 800;
/** 同屏最多物流車 */
const MAX_CARTS = 120;

/** 行人種類 */
type PedKind = 'office' | 'student' | 'housewife' | 'elder' | 'tourist' | 'worker' | 'couple' | 'casual';

/** 行人外觀（每幀重用同一物件，避免 GC） */
const _look = {
  kind: 'casual' as PedKind,
  top: 0xf0f0f0,
  bottom: 0x3a3f4a,
  hair: 0x1c1712,
  skin: 0xdcb18a,
  scale: 1,
  /** 0 = 無袋、1 = 手挽袋（師奶／購物）、2 = 書包（學生）、3 = 相機袋（遊客） */
  bag: 0 as 0 | 1 | 2 | 3,
  /** 雨傘顏色（0 = 不撐傘） */
  umbrella: 0,
};

const SKIN_TONES = [0xe8c4a0, 0xdcb18a, 0xcf9f78, 0xc09468, 0xb9895f];
const HAIR_DARK = [0x1a1410, 0x241a12, 0x2e2118, 0x1c1a18];
const HAIR_BROWN = [0x4a3421, 0x5c3f26, 0x6b4a2c];
const HAIR_GREY = [0xbdbdb8, 0xa9a9a2, 0xd4d4cc];

/** 上班族西裝色 */
const OFFICE_TOP = [0x27313f, 0x3b3f45, 0x2b3a4a, 0x455060, 0x2f2f38, 0xe8e8e8];
const OFFICE_BOTTOM = [0x232a33, 0x2f3540, 0x1f242b, 0x3a3f48];
/** 師奶上衣（鮮色花衫） */
const HOUSEWIFE_TOP = [0xd97a93, 0xcf6b5a, 0x5fa89a, 0xe0b04a, 0xb06fa0, 0xe08a5f];
/** 長者上衣 */
const ELDER_TOP = [0x9a8a74, 0x7a8a7a, 0x8f7a6a, 0x87837a, 0x6f7b8a];
/** 遊客上衣 */
const TOURIST_TOP = [0xf0c93f, 0xef7a3d, 0x5fb0e0, 0xf0f0f0, 0x6fcf8f];
/** 一般便服 */
const CASUAL_TOP = [0xdfe3e8, 0x4f6b8a, 0x8a5a5a, 0x5a7a5f, 0x2f3540, 0xc9b98c, 0x7a6f9a];
const JEANS = [0x3a5068, 0x2f4058, 0x46586b];
const CASUAL_BOTTOM = [0x2f3540, 0x3a3a42, 0x4a4a52, 0x6b5a4a];
/** 雨傘色（香港街上常見紅／藍／黑／透明邊） */
const UMBRELLA_COLORS = [0xb02a2a, 0x2f4f8f, 0x2b2b2b, 0x2f7f6a, 0xd9a83f, 0x8f5fa8];
/** 貨車車身色（白／藍為主，少量紅色） */
const TRUCK_COLORS = [0xf2f2f2, 0xececec, 0xf2f2f2, 0x3f6f9f, 0x35608f];
const VAN_COLORS = [0xf2f2f2, 0xe8e8e8, 0xcfd6dd, 0xf2f2f2, 0x9fb0c0];

/** 地面高度（與 terrain / roads 視覺對齊；行人站在路面／行人路上） */
const ROAD_SURFACE_Y = 0.375;
const SIDEWALK_SURFACE_Y = 0.355;
const LAND_SURFACE_Y = 0.315;

function groundYForTile(state: GameState, tx: number, ty: number): number {
  const x = Math.min(state.width - 1, Math.max(0, tx));
  const y = Math.min(state.height - 1, Math.max(0, ty));
  const tile = state.tiles[y * state.width + x];
  if (!tile) return LAND_SURFACE_Y;
  if (tile.road) return ROAD_SURFACE_Y;
  if (tile.sidewalk) return SIDEWALK_SURFACE_Y;
  const terrain = tile.terrain;
  if (terrain === 'water') return 0.16;
  if (terrain === 'mountain') return 1.4;
  if (terrain === 'hill') return LAND_SURFACE_Y + 0.03 + tile.elevation * 0.05;
  return LAND_SURFACE_Y + tile.elevation * 0.04;
}

function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  let delta = (b - a) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta < -Math.PI) delta += twoPi;
  return a + delta * t;
}

function isNightHour(hour: number): boolean {
  return hour < 6 || hour >= 19;
}

interface FacingState {
  x: number;
  y: number;
  yaw: number;
  touch: number;
}

/** 市民外觀快取（種類、衣色、髮色、膚色、袋、雨傘色；變動少，唔需要每幀重算） */
interface CachedLook {
  age: number;
  workId: number;
  night: boolean;
  kind: PedKind;
  top: number;
  bottom: number;
  hair: number;
  skin: number;
  scale: number;
  bag: 0 | 1 | 2 | 3;
  umbrella: number;
}

interface InstancedSet {
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

function makeInstanced(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  count: number,
  colored: boolean,
  castShadow: boolean,
): InstancedSet {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  if (colored) {
    const white = new THREE.Color(0xffffff);
    for (let i = 0; i < count; i++) mesh.setColorAt(i, white);
    if (mesh.instanceColor) {
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor.clearUpdateRanges();
    }
  }
  group.add(mesh);
  return { mesh, geometry, material };
}

/** 只上傳實際使用的實例資料（避免每幀上傳整個 MAX_VISIBLE 緩衝，1600 人口時慳大量頻寬） */
function uploadInstances(set: InstancedSet, count: number, includeColor: boolean): void {
  const matrix = set.mesh.instanceMatrix;
  matrix.clearUpdateRanges();
  matrix.addUpdateRange(0, Math.max(0, count) * 16);
  matrix.needsUpdate = true;
  const colors = set.mesh.instanceColor;
  if (colors && includeColor) {
    colors.clearUpdateRanges();
    colors.addUpdateRange(0, Math.max(0, count) * 3);
    colors.needsUpdate = true;
  }
}

// ─────────────────────────── 建立視圖 ───────────────────────────

export function createCitizensView(state: GameState): CitizensView {
  const group = new THREE.Group();
  group.name = 'citizens';

  // ── 共用幾何（低多邊形）──
  // 手腳幾何把樞軸放喺頂端，方便擺動
  const legGeo = new THREE.BoxGeometry(0.115, 0.46, 0.15);
  legGeo.translate(0, -0.23, 0);
  const armGeo = new THREE.BoxGeometry(0.075, 0.44, 0.08);
  armGeo.translate(0, -0.22, 0);
  const torsoGeo = new THREE.BoxGeometry(0.34, 0.5, 0.235);
  const headGeo = new THREE.SphereGeometry(0.125, 7, 5);
  const hairGeo = new THREE.SphereGeometry(0.132, 7, 4, 0, Math.PI * 2, 0, Math.PI * 0.62);
  const bagGeo = new THREE.BoxGeometry(0.16, 0.19, 0.09);
  const backpackGeo = new THREE.BoxGeometry(0.24, 0.28, 0.13);
  const umbrellaGeo = new THREE.ConeGeometry(0.46, 0.2, 8);
  const umbrellaStickGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.62, 4);

  const torsoMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const limbMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const skinMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const hairMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const bagMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const umbrellaMat = new THREE.MeshLambertMaterial({ color: 0xffffff });

  const torso = makeInstanced(group, torsoGeo, torsoMat, MAX_VISIBLE, true, true);
  const head = makeInstanced(group, headGeo, skinMat, MAX_VISIBLE, true, false);
  const hair = makeInstanced(group, hairGeo, hairMat, MAX_VISIBLE, true, false);
  const armL = makeInstanced(group, armGeo, limbMat, MAX_VISIBLE, true, false);
  const armR = makeInstanced(group, armGeo, limbMat, MAX_VISIBLE, true, false);
  const legL = makeInstanced(group, legGeo, limbMat, MAX_VISIBLE, true, false);
  const legR = makeInstanced(group, legGeo, limbMat, MAX_VISIBLE, true, false);
  const bag = makeInstanced(group, bagGeo, bagMat, MAX_VISIBLE, true, false);
  const backpack = makeInstanced(group, backpackGeo, bagMat, MAX_VISIBLE, true, false);
  const umbrella = makeInstanced(group, umbrellaGeo, umbrellaMat, MAX_VISIBLE, true, false);
  const umbrellaStick = makeInstanced(group, umbrellaStickGeo, umbrellaMat, MAX_VISIBLE, true, false);

  // ── 物流貨車／客貨車 ──
  // 單位立方體，原點在底部中央，方便按車種縮放
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  boxGeo.translate(0, 0.5, 0);
  const wheelGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.12, 8);
  wheelGeo.rotateZ(Math.PI / 2); // 輪軸沿 X
  const lightGeo = new THREE.BoxGeometry(0.13, 0.09, 0.05);

  const truckBodyMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const truckCabMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x24242a });
  const headLightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const tailLightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  const truckCargo = makeInstanced(group, boxGeo, truckBodyMat, MAX_CARTS, true, true);
  const truckCab = makeInstanced(group, boxGeo, truckCabMat, MAX_CARTS, true, true);
  const truckWheels = makeInstanced(group, wheelGeo, wheelMat, MAX_CARTS * 4, false, false);
  const headLights = makeInstanced(group, lightGeo, headLightMat, MAX_CARTS * 2, true, false);
  const tailLights = makeInstanced(group, lightGeo, tailLightMat, MAX_CARTS * 2, true, false);

  // ── 狀態 ──
  const visible: Citizen[] = new Array(MAX_VISIBLE);
  const lastIds = new Int32Array(MAX_VISIBLE).fill(-1);
  const facing = new Map<number, FacingState>();
  const buildingById = new Map<number, Building>();
  let frame = 0;
  let elapsed = 0;

  const color = new THREE.Color();

  /** 顏色快取：hex → linear RGB（避免每幀 sRGB→linear 轉換的開銷） */
  const linearColors = new Map<number, THREE.Color>();
  const linearColor = (hex: number): THREE.Color => {
    let c = linearColors.get(hex);
    if (!c) {
      c = new THREE.Color(hex);
      linearColors.set(hex, c);
    }
    return c;
  };
  /** 直接寫 instanceColor（唔經 THREE.Color 每幀轉換） */
  const paintColor = (mesh: THREE.InstancedMesh, index: number, hex: number): void => {
    const colors = mesh.instanceColor;
    if (!colors) return;
    const c = linearColor(hex);
    const o = index * 3;
    colors.array[o] = c.r;
    colors.array[o + 1] = c.g;
    colors.array[o + 2] = c.b;
  };

  /**
   * 寫入實例矩陣（只支援 Y 軸旋轉，直接寫 Float32Array）：
   * 人口 1600 時，每幀數千次 Euler→Quaternion→Matrix4 合成係最大熱點，這裡省掉。
   * rx 用作「前後擺動」位移（手腳動畫），rz 忽略（低多邊形風格）。
   */
  let lastYaw = Number.NaN;
  let lastCos = 1;
  let lastSin = 0;
  const setMatrix = (
    target: InstancedSet,
    index: number,
    px: number,
    py: number,
    pz: number,
    rx: number,
    ry: number,
    rz: number,
    scale: number,
    scaleY = scale,
  ): void => {
    if (index >= target.mesh.instanceMatrix.count) return;
    if (ry !== lastYaw) {
      lastYaw = ry;
      lastCos = Math.cos(ry);
      lastSin = Math.sin(ry);
    }
    const array = target.mesh.instanceMatrix.array as Float32Array;
    const o = index * 16;
    const off = rx * 0.22 * scale;
    array[o] = lastCos * scale;
    array[o + 1] = 0;
    array[o + 2] = -lastSin * scale;
    array[o + 3] = 0;
    array[o + 4] = 0;
    array[o + 5] = scaleY;
    array[o + 6] = 0;
    array[o + 7] = 0;
    array[o + 8] = lastSin * scale;
    array[o + 9] = 0;
    array[o + 10] = lastCos * scale;
    array[o + 11] = 0;
    array[o + 12] = px + lastSin * off;
    array[o + 13] = py;
    array[o + 14] = pz + lastCos * off;
    array[o + 15] = 1;
    void rz;
  };

  /** 依實際移動量決定朝向（靜止者沿用上次朝向） */
  const computeYaw = (citizen: Citizen, wx: number, wz: number, fallback: number): number => {
    let f = facing.get(citizen.id);
    if (!f) {
      f = { x: wx, y: wz, yaw: fallback, touch: frame };
      facing.set(citizen.id, f);
      return f.yaw;
    }
    const dx = wx - f.x;
    const dz = wz - f.y;
    if (dx * dx + dz * dz > 1e-5) {
      const target = Math.atan2(dx, dz);
      f.yaw = lerpAngle(f.yaw, target, 0.35);
    }
    f.x = wx;
    f.y = wz;
    f.touch = frame;
    return f.yaw;
  };

  /** 由 look／id 決定香港行人外觀（重用 _look，避免每幀配置物件） */
  const lookCache = new Map<number, CachedLook>();
  const computeLook = (citizen: Citizen, wet: boolean, night: boolean): void => {
    const h = hash01(citizen.look * 97.3 + citizen.id * 0.618);
    const h2 = hash01(citizen.look * 41.7 + citizen.id * 1.37 + 3.1);
    const look = citizen.look;
    _look.scale = citizen.age < 14 ? 0.68 : citizen.age < 18 ? 0.86 : 0.94 + look * 0.1;
    _look.skin = SKIN_TONES[Math.floor(h * SKIN_TONES.length) % SKIN_TONES.length];
    _look.bag = 0;
    _look.umbrella = 0;

    const work = buildingById.get(citizen.workId);
    const workKey = work?.key ?? '';

    // 種類判斷
    if (citizen.age >= 65) {
      _look.kind = 'elder';
    } else if (citizen.age >= 6 && citizen.age < 18) {
      _look.kind = 'student';
    } else if (workKey === 'officeTower' || workKey === 'shoppingMall' || workKey === 'mtrStation') {
      _look.kind = 'office';
    } else if (workKey === 'industrialBuilding' || workKey === 'quarry' || workKey === 'containerPort') {
      _look.kind = 'worker';
    } else if (look > 0.62 && look < 0.68 && citizen.age >= 18 && citizen.age < 40) {
      _look.kind = 'couple';
    } else if (h2 < 0.055) {
      _look.kind = 'tourist';
    } else if (citizen.gender === 'female' && citizen.age >= 25 && citizen.age <= 62) {
      _look.kind = 'housewife';
    } else if (citizen.gender === 'female' && look > 0.35 && look < 0.42) {
      _look.kind = 'couple';
    } else {
      _look.kind = 'casual';
    }

    switch (_look.kind) {
      case 'office': {
        _look.top = OFFICE_TOP[Math.floor(h * OFFICE_TOP.length) % OFFICE_TOP.length];
        _look.bottom = OFFICE_BOTTOM[Math.floor(h2 * OFFICE_BOTTOM.length) % OFFICE_BOTTOM.length];
        _look.hair = HAIR_DARK[Math.floor(h * HAIR_DARK.length) % HAIR_DARK.length];
        break;
      }
      case 'student': {
        // 校服：白恤衫＋深藍褲／裙；冬天加冷外套色
        _look.top = 0xf2f2f2;
        _look.bottom = 0x2b3f6b;
        _look.hair = HAIR_DARK[Math.floor(h * HAIR_DARK.length) % HAIR_DARK.length];
        _look.bag = 2;
        break;
      }
      case 'housewife': {
        _look.top = HOUSEWIFE_TOP[Math.floor(h * HOUSEWIFE_TOP.length) % HOUSEWIFE_TOP.length];
        const bottomPool = citizen.gender === 'female' ? [0x3a3a44, 0x4a4a52, 0x5a5a62] : CASUAL_BOTTOM;
        _look.bottom = bottomPool[Math.floor(h2 * bottomPool.length) % bottomPool.length];
        _look.hair = HAIR_DARK[Math.floor(h * HAIR_DARK.length) % HAIR_DARK.length];
        _look.bag = 1; // 買餸袋
        break;
      }
      case 'elder': {
        _look.top = ELDER_TOP[Math.floor(h * ELDER_TOP.length) % ELDER_TOP.length];
        _look.bottom = CASUAL_BOTTOM[Math.floor(h2 * CASUAL_BOTTOM.length) % CASUAL_BOTTOM.length];
        _look.hair = HAIR_GREY[Math.floor(h * HAIR_GREY.length) % HAIR_GREY.length];
        break;
      }
      case 'tourist': {
        _look.top = TOURIST_TOP[Math.floor(h * TOURIST_TOP.length) % TOURIST_TOP.length];
        _look.bottom = JEANS[Math.floor(h2 * JEANS.length) % JEANS.length];
        _look.hair = HAIR_BROWN[Math.floor(h * HAIR_BROWN.length) % HAIR_BROWN.length];
        _look.bag = 3; // 相機袋
        break;
      }
      case 'worker': {
        _look.top = h < 0.5 ? 0xf07a2a : 0xd9b23f; // 地盤反光衣／制服
        _look.bottom = JEANS[Math.floor(h2 * JEANS.length) % JEANS.length];
        _look.hair = HAIR_DARK[Math.floor(h * HAIR_DARK.length) % HAIR_DARK.length];
        break;
      }
      case 'couple': {
        // 情侶：成對色系（粉紅／粉藍）與較淺的髮色
        _look.top = h < 0.5 ? 0xe87a9a : 0x5f8fd0;
        _look.bottom = h2 < 0.5 ? JEANS[0] : CASUAL_BOTTOM[1];
        _look.hair = HAIR_BROWN[Math.floor(h * HAIR_BROWN.length) % HAIR_BROWN.length];
        break;
      }
      default: {
        _look.top = CASUAL_TOP[Math.floor(h * CASUAL_TOP.length) % CASUAL_TOP.length];
        _look.bottom = h2 < 0.5 ? JEANS[Math.floor(h * JEANS.length) % JEANS.length] : CASUAL_BOTTOM[Math.floor(h2 * CASUAL_BOTTOM.length) % CASUAL_BOTTOM.length];
        _look.hair = h2 < 0.72 ? HAIR_DARK[Math.floor(h * HAIR_DARK.length) % HAIR_DARK.length] : HAIR_BROWN[Math.floor(h * HAIR_BROWN.length) % HAIR_BROWN.length];
        break;
      }
    }

    // 夜晚衣服看起來暗一點
    if (night) {
      color.setHex(_look.top).multiplyScalar(0.82);
      _look.top = color.getHex();
      color.setHex(_look.bottom).multiplyScalar(0.82);
      _look.bottom = color.getHex();
    }

    // 雨天／颱風撐傘（戶外行人才撐；已在建築內的不撐）
    _look.umbrella =
      wet && citizen.state !== 'working' && citizen.state !== 'shopping'
        ? UMBRELLA_COLORS[Math.floor(h * UMBRELLA_COLORS.length) % UMBRELLA_COLORS.length]
        : 0;
  };

  /** 外觀快取：同一市民年齡／工作／晝夜不變時，唔使每幀重算種類與配色（人口 1600 慳好多） */
  const assignLook = (citizen: Citizen, wet: boolean, night: boolean): void => {
    const cached = lookCache.get(citizen.id);
    if (cached && cached.age === citizen.age && cached.workId === citizen.workId && cached.night === night) {
      _look.kind = cached.kind;
      _look.top = cached.top;
      _look.bottom = cached.bottom;
      _look.hair = cached.hair;
      _look.skin = cached.skin;
      _look.scale = cached.scale;
      _look.bag = cached.bag;
      _look.umbrella =
        wet && citizen.state !== 'working' && citizen.state !== 'shopping' ? cached.umbrella : 0;
      return;
    }
    computeLook(citizen, wet, night);
    lookCache.set(citizen.id, {
      age: citizen.age,
      workId: citizen.workId,
      night,
      kind: _look.kind,
      top: _look.top,
      bottom: _look.bottom,
      hair: _look.hair,
      skin: _look.skin,
      scale: _look.scale,
      bag: _look.bag,
      umbrella: _look.umbrella,
    });
  };

  const update = (s: GameState, dt: number): void => {
    elapsed += dt;
    frame++;

    const halfW = (s.width * TILE) / 2;
    const halfH = (s.height * TILE) / 2;
    const clock = s.clock;
    const night = isNightHour(clock.hour);
    const weather = clock.weather;
    const wet = weather === 'rain' || weather === 'snow' || weather === 'storm';
    const storm = weather === 'storm';

    buildingById.clear();
    for (const b of s.buildings) buildingById.set(b.id, b);

    // ── 收集可見市民（在家者、乘港鐵／渡輪途中者不畫）──
    let candidateTotal = 0;
    for (const citizen of s.citizens) {
      if (citizen.state === 'home') continue;
      if (
        citizen.state === 'walking' &&
        citizen.commuteMode !== 'walk' &&
        (citizen.commuteMode === 'mtr' || citizen.commuteMode === 'ferry')
      ) {
        continue; // 港鐵／渡輪乘客：人在車廂／船上
      }
      if (storm && citizen.id % 2 === 1) continue; // 颱風：街上人更少
      candidateTotal++;
    }
    const stride = candidateTotal > MAX_VISIBLE ? Math.ceil(candidateTotal / MAX_VISIBLE) : 1;
    let count = 0;
    let sampleIndex = 0;
    for (const citizen of s.citizens) {
      if (count >= MAX_VISIBLE) break;
      if (citizen.state === 'home') continue;
      if (
        citizen.state === 'walking' &&
        citizen.commuteMode !== 'walk' &&
        (citizen.commuteMode === 'mtr' || citizen.commuteMode === 'ferry')
      ) {
        continue;
      }
      if (storm && citizen.id % 2 === 1) continue;
      if (stride > 1 && sampleIndex++ % stride !== 0) continue;
      visible[count++] = citizen;
    }

    let colorsDirty = false;
    let bagCount = 0;
    let backpackCount = 0;
    let umbrellaCount = 0;

    for (let i = 0; i < count; i++) {
      const citizen = visible[i];
      const walking = citizen.state === 'walking';
      const atBuilding =
        citizen.state === 'working' || citizen.state === 'shopping' ? buildingById.get(citizen.targetId) : undefined;

      let wx: number;
      let wz: number;
      let ground: number;
      let yawBase: number;
      if (atBuilding) {
        // 工作／購物：在建築物外圍活動（午飯、放工人流）
        const centerX = (atBuilding.x + atBuilding.w / 2) * TILE - halfW;
        const centerZ = (atBuilding.y + atBuilding.h / 2) * TILE - halfH;
        const angle = citizen.look * Math.PI * 2 + citizen.id * 0.37 + elapsed * 0.04;
        const radius = TILE * (0.18 + 0.2 * Math.min(atBuilding.w, atBuilding.h));
        wx = centerX + Math.cos(angle) * radius;
        wz = centerZ + Math.sin(angle) * radius;
        ground = groundYForTile(
          s,
          Math.floor(atBuilding.x + atBuilding.w / 2),
          Math.floor(atBuilding.y + atBuilding.h / 2),
        );
        yawBase = angle + Math.PI / 2;
      } else {
        wx = citizen.x * TILE - halfW;
        wz = citizen.y * TILE - halfH;
        ground = groundYForTile(s, Math.floor(citizen.x), Math.floor(citizen.y));
        // 行人靠邊行：往畫面右側偏少許（香港靠左行車，行人貼路邊）
        const dirX = citizen.path.length > 1 ? Math.sin(citizen.pathProgress * 0.7 + citizen.look * 3) : 0;
        wx += (citizen.look - 0.5) * 0.34;
        wz += (hash01(citizen.look * 313 + citizen.id) - 0.5) * 0.34;
        // 同格錯開（避免完全重疊）
        wx += dirX * 0.05;
        yawBase = citizen.look * Math.PI * 2;
      }

      // 種類與外觀（在同一格的人之間有變化）
      assignLook(citizen, wet, night);
      const kind = _look.kind;

      // 長者駝背、學生輕快
      const hunch = kind === 'elder' ? 0.16 : 0;
      const phase = elapsed * (walking ? 8.2 : 1.7) + citizen.look * 6.283;
      const strideMotion = walking ? Math.sin(phase) : 0;
      const sway = walking ? strideMotion * 0.05 : Math.sin(elapsed * 1.6 + citizen.look * 5) * 0.012;
      const bob = walking ? Math.abs(Math.sin(phase)) * 0.05 : Math.sin(elapsed * 1.8 + citizen.look * 5) * 0.01;
      const scale = _look.scale;
      const baseY = ground + bob;
      const yaw = computeYaw(citizen, wx, wz, yawBase);
      const forwardX = Math.sin(yaw);
      const forwardZ = Math.cos(yaw);
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const phaseLift = walking ? 1 : 0;

      const torsoY = baseY + (0.46 + 0.25) * scale - hunch * 0.3;
      const shoulderY = baseY + (0.46 + 0.44) * scale - hunch * 0.45;
      const headY = baseY + 1.02 * scale - hunch * 0.55;
      const hipY = baseY + 0.46 * scale;

      // 身體（上衣）＋輕微前傾
      setMatrix(torso, i, wx, torsoY, wz, hunch + (walking ? 0.06 : 0), yaw, sway, scale);
      // 頭＋頭髮
      setMatrix(head, i, wx, headY, wz, hunch * 0.6, yaw, 0, scale);
      setMatrix(hair, i, wx - forwardX * 0.01, headY + 0.045 * scale, wz - forwardZ * 0.01, 0, yaw, 0, scale);

      // 手臂（走路擺動；師奶／遊客挽袋的手較貼身）
      const armSwing = walking ? strideMotion * (kind === 'elder' ? 0.35 : 0.6) : 0;
      const armDrop = 0.02 * scale;
      const shoulderX = rightX * 0.21 * scale;
      const shoulderZ = rightZ * 0.21 * scale;
      setMatrix(
        armL,
        i,
        wx + shoulderX - forwardX * armSwing * 0.1,
        shoulderY - armDrop,
        wz + shoulderZ - forwardZ * armSwing * 0.1,
        armSwing + hunch,
        yaw,
        -0.12,
        scale,
      );
      setMatrix(
        armR,
        i,
        wx - shoulderX + forwardX * armSwing * 0.1,
        shoulderY - armDrop,
        wz - shoulderZ + forwardZ * armSwing * 0.1,
        -armSwing + hunch,
        yaw,
        0.12,
        scale,
      );

      // 雙腳（走路時前後擺）
      const legSwing = walking ? strideMotion * 0.5 : 0;
      const hipX = rightX * 0.085 * scale;
      const hipZ = rightZ * 0.085 * scale;
      setMatrix(legL, i, wx + hipX, hipY, wz + hipZ, legSwing, yaw, 0, scale);
      setMatrix(legR, i, wx - hipX, hipY, wz - hipZ, -legSwing, yaw, 0, scale);

      // 顏色（只在對應的市民改變時更新 instanceColor）
      if (lastIds[i] !== citizen.id) {
        lastIds[i] = citizen.id;
        colorsDirty = true;
        paintColor(torso.mesh, i, _look.top);
        paintColor(armL.mesh, i, _look.bottom);
        paintColor(armR.mesh, i, _look.bottom);
        paintColor(legL.mesh, i, _look.bottom);
        paintColor(legR.mesh, i, _look.bottom);
        paintColor(head.mesh, i, _look.skin);
        paintColor(hair.mesh, i, _look.hair);
      }

      // 手挽袋（師奶買餸：紅白藍膠袋色系）
      if (_look.bag === 1) {
        const bagColor = hash01(citizen.id * 7.7) < 0.5 ? 0xd94f4f : 0x3f6fbf;
        setMatrix(bag, bagCount, wx - shoulderX * 1.15, hipY + 0.28 * scale, wz - shoulderZ * 1.15, 0.1, yaw, 0, scale);
        paintColor(bag.mesh, bagCount, bagColor);
        bagCount++;
      }
      // 書包（學生）
      if (_look.bag === 2) {
        setMatrix(backpack, backpackCount, wx - forwardX * 0.16, torsoY + 0.02, wz - forwardZ * 0.16, hunch, yaw, 0, scale);
        paintColor(backpack.mesh, backpackCount, 0x2b3f6b);
        backpackCount++;
      }
      // 相機袋（遊客）
      if (_look.bag === 3) {
        setMatrix(bag, bagCount, wx + shoulderX * 1.35, hipY + 0.3 * scale, wz + shoulderZ * 1.35, 0.15, yaw, 0, scale * 0.9);
        paintColor(bag.mesh, bagCount, 0x33333a);
        bagCount++;
      }

      // 雨傘（雨天／颱風時戶外行人撐傘；風大時斜向）
      if (_look.umbrella !== 0) {
        const tilt = storm ? 0.35 : 0.12;
        const umbrellaY = baseY + 1.62 * scale;
        setMatrix(umbrella, umbrellaCount, wx, umbrellaY, wz, tilt, yaw + 0.15, 0, scale);
        setMatrix(
          umbrellaStick,
          umbrellaCount,
          wx + rightX * 0.12 * scale,
          baseY + 1.3 * scale,
          wz + rightZ * 0.12 * scale,
          tilt,
          yaw + 0.15,
          0,
          scale,
        );
        paintColor(umbrella.mesh, umbrellaCount, _look.umbrella);
        paintColor(umbrellaStick.mesh, umbrellaCount, _look.umbrella);
        umbrellaCount++;
      }
      void phaseLift;
      void kind;
    }

    // 行人實例數
    torso.mesh.count = count;
    head.mesh.count = count;
    hair.mesh.count = count;
    armL.mesh.count = count;
    armR.mesh.count = count;
    legL.mesh.count = count;
    legR.mesh.count = count;
    bag.mesh.count = bagCount;
    backpack.mesh.count = backpackCount;
    umbrella.mesh.count = umbrellaCount;
    umbrellaStick.mesh.count = umbrellaCount;

    // 只上傳實際使用範圍：身體顏色（有變才上傳）＋袋／雨傘（每幀重排，必須上傳）
    const bodySets: [InstancedSet, number][] = [
      [torso, count],
      [head, count],
      [hair, count],
      [armL, count],
      [armR, count],
      [legL, count],
      [legR, count],
    ];
    for (const [set, n] of bodySets) uploadInstances(set, n, colorsDirty);
    uploadInstances(bag, bagCount, true);
    uploadInstances(backpack, backpackCount, true);
    uploadInstances(umbrella, umbrellaCount, true);
    uploadInstances(umbrellaStick, umbrellaCount, true);

    // ── 物流貨車／客貨車 ──
    const carts = s.carts;
    const cartCount = Math.min(carts.length, MAX_CARTS);
    truckCargo.mesh.count = cartCount;
    truckCab.mesh.count = cartCount;
    truckWheels.mesh.count = cartCount * 4;
    headLights.mesh.count = cartCount * 2;
    tailLights.mesh.count = cartCount * 2;

    // 夜間車燈較亮；日間只微微亮
    const headHex = night ? 0xfff2c0 : 0xd8d8c8;
    const tailHex = night ? 0xff3a2a : 0x7a2a22;
    const lightIntensity = night ? 1 : 0.55;

    for (let i = 0; i < cartCount; i++) {
      const cart = carts[i];
      const pose = cartPose(s, cart);
      const wxC = pose.x;
      const wzC = pose.z;
      const yaw = pose.yaw;
      const ground = pose.ground;
      const isVan = cart.vehicleKind === 'van';
      const forwardX = Math.sin(yaw);
      const forwardZ = Math.cos(yaw);
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const colorPool = isVan ? VAN_COLORS : TRUCK_COLORS;
      const bodyHex = colorPool[Math.abs(cart.id * 31) % colorPool.length];

      // 車身尺寸（truck 較大、van 較細）
      const cargoH = isVan ? 0.95 : 1.18;
      const cargoL = isVan ? 1.15 : 1.52;
      const cargoW = isVan ? 0.92 : 0.98;
      const cabH = isVan ? 0.72 : 0.86;
      const cabL = isVan ? 0.78 : 0.82;
      const cargoZ = isVan ? -0.18 : -0.3;
      const cabZ = isVan ? 0.72 : 0.9;

      const cosYaw = Math.cos(yaw);
      const sinYaw = Math.sin(yaw);
      const writeBox = (
        set: InstancedSet,
        index: number,
        ox: number,
        oy: number,
        oz: number,
        sx: number,
        sy: number,
        sz: number,
      ): void => {
        const array = set.mesh.instanceMatrix.array as Float32Array;
        const o = index * 16;
        array[o] = cosYaw * sx;
        array[o + 1] = 0;
        array[o + 2] = -sinYaw * sx;
        array[o + 3] = 0;
        array[o + 4] = 0;
        array[o + 5] = sy;
        array[o + 6] = 0;
        array[o + 7] = 0;
        array[o + 8] = sinYaw * sz;
        array[o + 9] = 0;
        array[o + 10] = cosYaw * sz;
        array[o + 11] = 0;
        array[o + 12] = ox;
        array[o + 13] = oy;
        array[o + 14] = oz;
        array[o + 15] = 1;
      };

      // 貨箱
      writeBox(
        truckCargo,
        i,
        wxC + forwardX * cargoZ,
        ground + 0.18,
        wzC + forwardZ * cargoZ,
        cargoW,
        cargoH,
        cargoL,
      );
      paintColor(truckCargo.mesh, i, bodyHex);

      // 車頭（略深色）
      writeBox(
        truckCab,
        i,
        wxC + forwardX * cabZ,
        ground + 0.18,
        wzC + forwardZ * cabZ,
        cargoW * 0.98,
        cabH,
        cabL,
      );
      const cabHex = linearColor(bodyHex).clone().multiplyScalar(0.9).getHex();
      paintColor(truckCab.mesh, i, cabHex);

      // 四個車輪
      const wheelR = isVan ? 0.15 : 0.17;
      const wheelBase = isVan ? 0.62 : 0.82;
      const wheelX = cargoW * 0.5 - 0.02;
      const wheelPositions: [number, number][] = [
        [wheelBase, wheelX],
        [wheelBase, -wheelX],
        [-wheelBase, wheelX],
        [-wheelBase, -wheelX],
      ];
      for (let w = 0; w < 4; w++) {
        const [fz, rx] = wheelPositions[w];
        writeBox(
          truckWheels,
          i * 4 + w,
          wxC + forwardX * fz + rightX * rx,
          ground + wheelR,
          wzC + forwardZ * fz + rightZ * rx,
          wheelR / 0.17,
          wheelR / 0.17,
          wheelR / 0.17,
        );
      }

      // 車頭燈（前）＋尾燈（後）
      const frontZ = cabZ + cabL * 0.5;
      const rearZ = cargoZ - cargoL * 0.5;
      for (let l = 0; l < 2; l++) {
        const side = l === 0 ? 1 : -1;
        writeBox(
          headLights,
          i * 2 + l,
          wxC + forwardX * frontZ + rightX * cargoW * 0.32 * side,
          ground + 0.46,
          wzC + forwardZ * frontZ + rightZ * cargoW * 0.32 * side,
          lightIntensity,
          lightIntensity,
          lightIntensity,
        );
        paintColor(headLights.mesh, i * 2 + l, headHex);
        writeBox(
          tailLights,
          i * 2 + l,
          wxC + forwardX * rearZ + rightX * cargoW * 0.3 * side,
          ground + 0.42,
          wzC + forwardZ * rearZ + rightZ * cargoW * 0.3 * side,
          lightIntensity,
          lightIntensity,
          lightIntensity,
        );
        paintColor(tailLights.mesh, i * 2 + l, tailHex);
      }
    }

    // 貨車：矩陣與顏色每幀更新（數量少，成本低）
    uploadInstances(truckCargo, cartCount, true);
    uploadInstances(truckCab, cartCount, true);
    uploadInstances(truckWheels, cartCount * 4, false);
    uploadInstances(headLights, cartCount * 2, true);
    uploadInstances(tailLights, cartCount * 2, true);

    // 偶爾清理暫存（朝向／外觀快取／顏色快取）
    if (frame % 300 === 0) {
      for (const [id, f] of facing) {
        if (frame - f.touch > 180) facing.delete(id);
      }
      if (lookCache.size > 2400) lookCache.clear();
      if (linearColors.size > 512) linearColors.clear();
    }
  };

  update(state, 0);

  return {
    group,
    update,
    dispose(): void {
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      for (const set of [
        torso,
        head,
        hair,
        armL,
        armR,
        legL,
        legR,
        bag,
        backpack,
        umbrella,
        umbrellaStick,
        truckCargo,
        truckCab,
        truckWheels,
        headLights,
        tailLights,
      ]) {
        geometries.add(set.geometry);
        materials.add(set.material);
        set.mesh.dispose();
      }
      for (const geo of geometries) geo.dispose();
      for (const mat of materials) mat.dispose();
      facing.clear();
      buildingById.clear();
      lookCache.clear();
      linearColors.clear();
      group.clear();
    },
  };
}

// ─────────────────────────── 貨車位置 ───────────────────────────

/**
 * 貨車位置／朝向：優先用 cart.path（tile index）＋pathProgress 插值；
 * path 為空時退回 cart.x / cart.y（格索引浮點，格中心 +0.5）。
 */
function cartPose(state: GameState, cart: Cart): { x: number; z: number; yaw: number; ground: number } {
  const halfW = (state.width * TILE) / 2;
  const halfH = (state.height * TILE) / 2;
  const width = state.width;
  const path = cart.path;

  if (path && path.length >= 2) {
    const last = path.length - 1;
    const t = Math.max(0, Math.min(last, cart.pathProgress || 0));
    const index = Math.min(last - 1, Math.floor(t));
    const frac = t - index;
    const a = path[index];
    const b = path[index + 1];
    const ax = (a % width) + 0.5;
    const ay = Math.floor(a / width) + 0.5;
    const bx = (b % width) + 0.5;
    const by = Math.floor(b / width) + 0.5;
    const tx = ax + (bx - ax) * frac;
    const ty = ay + (by - ay) * frac;
    const ground = groundYForTile(state, Math.floor(tx), Math.floor(ty));
    return {
      x: tx * TILE - halfW,
      z: ty * TILE - halfH,
      yaw: Math.atan2(bx - ax, by - ay),
      ground,
    };
  }
  if (path && path.length === 1) {
    const a = path[0];
    const tx = (a % width) + 0.5;
    const ty = Math.floor(a / width) + 0.5;
    return {
      x: tx * TILE - halfW,
      z: ty * TILE - halfH,
      yaw: 0,
      ground: groundYForTile(state, Math.floor(tx), Math.floor(ty)),
    };
  }
  // fallback：cart.x/y 為格索引浮點
  const gx = (cart.x ?? 0) + 0.5;
  const gy = (cart.y ?? 0) + 0.5;
  return {
    x: gx * TILE - halfW,
    z: gy * TILE - halfH,
    yaw: 0,
    ground: groundYForTile(state, Math.floor(gx), Math.floor(gy)),
  };
}
