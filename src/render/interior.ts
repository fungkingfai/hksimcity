/**
 * 《維港之城》— 可進入的香港建築室內場景（interiors-dev）
 *
 * 依 `BUILDINGS[key].interior` 生成 41 種香港室內／半室外／戶外場景
 * （32 種原有＋9 種 Round 5 新增；busStop／minibusStop 等細站以交通類 fallback 進入）：
 *   唐樓單位、劏房、公屋單位、居屋、私人屋苑、豪宅、農田、茶餐廳、便利店、
 *   街市、超市、商場、酒樓、商廈、工廈、食品廠、石礦場、發電廠、水務設施、
 *   進口商行、貨櫃碼頭、貨倉、學校、醫院、警署、消防局、港鐵站、巴士總站、
 *   電車站、渡輪碼頭、公園、海濱長廊；
 *   水塔泵房、海水化淡廠、污水處理廠、排污口泵房、小巴車廠、
 *   機場客運大樓（離境大堂）、空運貨運站、碼頭閘口、貨櫃堆場控制室。
 *
 * 每個室內都有：香港主題陳設、日夜窗光（街景／維港景交叉淡入）、
 * 天氣視覺（雨痕、颱風閃電、陰天光暗）、霓虹招牌閃爍、人物象徵、
 * 吊扇／電視／扶手電梯／列車門／渡輪／雀鳥等微動畫。
 *
 * 效能：
 *  - 房間外殼與陳設分別合併（靜態陳設全部併入 2~4 個 draw call），
 *    每間室內目標 < 30 draw call。
 *  - 材質／貼圖由 interior-parts 全域快取；進出場只建立／釋放逐場幾何。
 *  - 燈光：環境光＋半球光＋窗光＋≤3 點光源，室內不開陰影貼圖（戶外開）。
 *
 * 對外介面固定：
 *   createInteriorView(state, buildingId): InteriorView | null
 *   InteriorView.scene / camera / update(state, dt) / dispose()
 */

import * as THREE from 'three';
import { BUILDINGS } from '../core/config';
import type { Building, BuildingDef, GameState } from '../core/types';
import {
  IPAL,
  addACUnit,
  addAltar,
  addBarrelDrum,
  addBeam,
  addBench,
  addBird,
  addBoardPartition,
  addBoardwalk,
  addBooth,
  addBox,
  addBunkBed,
  addBusShelter,
  addBusStopFlag,
  addCardboardBoxes,
  addCashierCounter,
  addCeilingFan,
  addCeilingLamp,
  addClassroomDesk,
  addClothesRack,
  addCoffeeTable,
  addCone,
  addContainerShip,
  addContainerStack,
  addControlPanel,
  addConveyor,
  addCrusher,
  addCyl,
  addDetentionCell,
  addDimSumCart,
  addDiningSet,
  addDocumentDesk,
  addDoubleDeckerBus,
  addDrinkFridge,
  addDumpTruck,
  addEscalator,
  addExitSign,
  addFarmTools,
  addFerryGate,
  addFilingCabinet,
  addFilterTank,
  addFireHose,
  addFirePole,
  addFireTruck,
  addFlowerBed,
  addFridge,
  addGantryCrane,
  addGreenhouse,
  addHandTruck,
  addHarbourRail,
  addHospitalBed,
  addIronGate,
  addJunkBoat,
  addKitchenCounter,
  addLampPost,
  addMachine,
  addMahjongTable,
  addMenuBoard,
  addMilkTea,
  addMTRGate,
  addMTRPillar,
  addMTRTrain,
  addNoticeBoard,
  addNurseStation,
  addOfficeDesk,
  addOfficePartition,
  addPallet,
  addPalletRack,
  addPavilion,
  addPerson,
  addPipeRun,
  addPlatformEdge,
  addPlatformSign,
  addPoliceCounter,
  addPottedPlant,
  addPrinter,
  addRedLantern,
  addRockPile,
  addRouteMap,
  addRoundDiningTable,
  addSampleShelf,
  addShelfUnit,
  addShopFront,
  addShoppingCart,
  addSkylineBackdrop,
  addSofa,
  addSphere,
  addStarFerry,
  addSteelLadder,
  addTeacherDesk,
  addTelephone,
  addTicketMachine,
  addTramCar,
  addTramTrack,
  addTree,
  addTrashBin,
  addTurbine,
  addTVUnit,
  addValveWheel,
  addVegCrate,
  addVentDuct,
  addWardrobe,
  addWaterCooler,
  addWaterPlane,
  addWetStall,
  addWhiteboard,
  addWindowView,
  basic,
  blackboardMat,
  busRouteMat,
  ceilingMat,
  dragonPhoenixMat,
  exitSignMat,
  finalizeInteriorScene,
  floorMat,
  glass,
  lam,
  markAnim,
  neonSignMat,
  posterMat,
  rainMat,
  shade,
  signBoardMat,
  skylineMat,
  starFerryMat,
  steamMat,
  tvScreenMat,
  wallMat,
} from './models/interior-parts';

export interface InteriorView {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  update(state: GameState, dt: number): void;
  dispose(): void;
}

interface Dims {
  w: number;
  d: number;
  h: number;
}

interface RoomRefs {
  windowLight: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  ambient: THREE.AmbientLight;
  lamps: THREE.PointLight[];
  windows: { day: THREE.MeshBasicMaterial; night: THREE.MeshBasicMaterial }[];
  outdoor: boolean;
  skyColors: { day: THREE.Color; night: THREE.Color } | null;
}

interface FillCtx {
  scene: THREE.Scene;
  root: THREE.Group;
  dims: Dims;
  def: BuildingDef;
  building: Building;
  state: GameState;
  neon: THREE.MeshBasicMaterial[];
  room: RoomRefs;
}

interface AnimPart {
  obj: THREE.Object3D;
  kind: string;
  phase: number;
  baseX: number;
  baseY: number;
  baseRotX: number;
  baseRotY: number;
  baseRotZ: number;
  baseScale: number;
}

const ROOM_BG = 0x161219;
const SKY_DAY = new THREE.Color(0x9fc2dc);
const SKY_NIGHT = new THREE.Color(0x0a1220);

// ─────────────────────────── 房間外殼 ───────────────────────────

interface RoomSpec {
  /** 戶外：無牆無天花，有天際線背景 */
  outdoor?: boolean;
  /** 半開放：後牆＋側牆＋天花，前面敞開（街市／貨倉） */
  semi?: boolean;
  floor: Parameters<typeof floorMat>[0];
  wall?: Parameters<typeof wallMat>[0];
  ceiling?: Parameters<typeof ceilingMat>[0] | null;
  /** 窗外景色 */
  window?: 'street' | 'harbour' | null;
  windowCount?: number;
  /** 落地玻璃（豪宅／商廈） */
  floorToCeiling?: boolean;
  /** 戶外天際線板 */
  skyline?: boolean;
  /** 戶外維港水面 */
  water?: boolean;
  lampCount?: number;
  /** 建築物內部主色（牆腳線／天花線） */
  accent?: number;
  /** 戶外地面加大倍率 */
  groundScale?: number;
}

function buildRoom(scene: THREE.Scene, shell: THREE.Group, dims: Dims, spec: RoomSpec): RoomRefs {
  const { w, d, h } = dims;
  const outdoor = !!spec.outdoor;
  const semi = !!spec.semi;

  // 室內向鏡頭方向延伸地板／天花／側牆（相機位於房間前方，避免看見「室外」黑色背景）
  const ext = outdoor ? 0 : 7.0;
  const zMid = ext / 2;

  // ── 地板 ──
  const floor = addBox(shell, floorMat(spec.floor), w, 0.2, d + ext, 0, -0.1, zMid);
  floor.receiveShadow = true;
  if (outdoor) {
    const gs = spec.groundScale ?? 2.6;
    const ground = addBox(shell, floorMat(spec.floor), w * gs, 0.16, d * gs, 0, -0.12, -d * 0.3);
    ground.receiveShadow = true;
  }

  // ── 牆身／天花 ──
  if (!outdoor) {
    const wallMeshMat = wallMat(spec.wall ?? 'old');
    const accent = spec.accent ?? IPAL.woodDark;
    addBox(shell, wallMeshMat, w, h, 0.2, 0, h / 2, -d / 2 + 0.1);
    addBox(shell, wallMeshMat, 0.2, h, d + ext, -w / 2 + 0.1, h / 2, zMid);
    addBox(shell, wallMeshMat, 0.2, h, d + ext, w / 2 - 0.1, h / 2, zMid);
    if (!semi) {
      // 前牆兩側留短牆，中間敞開讓相機看進室內
      addBox(shell, wallMeshMat, w * 0.12, h, 0.2, -w / 2 + w * 0.06, h / 2, d / 2 - 0.1);
      addBox(shell, wallMeshMat, w * 0.12, h, 0.2, w / 2 - w * 0.06, h / 2, d / 2 - 0.1);
    }
    // 踢腳線
    addBox(shell, lam(accent), w, 0.22, 0.08, 0, 0.11, -d / 2 + 0.22);
    addBox(shell, lam(accent), 0.08, 0.22, d + ext, -w / 2 + 0.22, 0.11, zMid);
    addBox(shell, lam(accent), 0.08, 0.22, d + ext, w / 2 - 0.22, 0.11, zMid);
    // 天花
    const ceilStyle = spec.ceiling === null ? null : spec.ceiling ?? 'white';
    if (ceilStyle) {
      addBox(shell, ceilingMat(ceilStyle), w, 0.18, d + ext, 0, h + 0.09, zMid);
      addBox(shell, lam(shade(accent, 1.15)), w, 0.08, 0.08, 0, h - 0.05, -d / 2 + 0.24);
    }
    // 角柱
    for (const sx of [-1, 1]) {
      addBox(shell, wallMeshMat, 0.34, h, 0.34, sx * (w / 2 - 0.18), h / 2, -d / 2 + 0.18);
    }
    if (w > 9.5) {
      for (const sx of [-0.28, 0.28]) {
        addBox(shell, lam(shade(accent, 0.95)), 0.3, h, 0.3, sx * w, h / 2, 0);
      }
    }
  }

  // ── 窗外景色 ──
  const windows: RoomRefs['windows'] = [];
  if (!outdoor && spec.window) {
    const count = spec.windowCount ?? (w > 9 ? 2 : 1);
    const f2c = !!spec.floorToCeiling;
    const winH = f2c ? h * 0.82 : Math.min(1.6, h * 0.5);
    const winW = f2c ? Math.min(2.6, (w * 0.72) / Math.max(1, count)) : Math.min(2.1, (w * 0.4) / Math.max(1, count));
    const baseY = f2c ? h * 0.5 : h * 0.56;
    for (let i = 0; i < count; i++) {
      const x = count === 1 ? 0 : -w * 0.22 + (i * w * 0.44) / (count - 1);
      windows.push(addWindowView(shell, x, baseY, -d / 2 + 0.24, winW, winH, 0, spec.window));
      if (!f2c) {
        addBox(shell, lam(0xd8cdb2), winW * 0.18, winH * 1.06, 0.08, x - winW * 0.58, baseY, -d / 2 + 0.32);
        addBox(shell, lam(0xd8cdb2), winW * 0.18, winH * 1.06, 0.08, x + winW * 0.58, baseY, -d / 2 + 0.32);
      }
    }
    addACUnit(shell, -w * 0.36, h * 0.78, -d / 2 + 0.28, 0, 0.9);
  }

  // ── 天花光管 ──
  const lampCount = spec.lampCount ?? (outdoor ? 0 : w > 8 ? 3 : 2);
  for (let i = 0; i < lampCount; i++) {
    const lx = lampCount === 1 ? 0 : -w * 0.28 + (i * w * 0.56) / Math.max(1, lampCount - 1);
    addCeilingLamp(shell, lx, h - 0.12, -d * 0.12, w > 8 ? 2.0 : 1.5);
  }

  // ── 戶外背景 ──
  if (outdoor) {
    if (spec.skyline !== false) addSkylineBackdrop(shell, 0, h * 0.9, -d * 1.05, 0, w * 4.2, h * 1.9);
    if (spec.water) addWaterPlane(shell, 0, -d * 0.62, w * 3.4, d * 1.1);
    addBox(shell, lam(0x8a8f92), w * 1.5, 0.04, 0.18, 0, 0.02, -d * 0.32);
    // 戶外雨幕（雨／颱風時可見；update 滾動貼圖）
    const rainCurtain = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.max(w * 2.2, 18), Math.max(h * 2.6, 11)),
      rainMat(),
    );
    rainCurtain.position.set(0, h * 0.95, d * 0.22);
    rainCurtain.visible = false;
    markAnim(rainCurtain, 'rain-far');
    shell.add(rainCurtain);
  } else if (semi) {
    for (const sx of [-1, 1]) {
      addBox(shell, lam(spec.accent ?? IPAL.steelDark), 0.3, h, 0.3, sx * (w / 2 - 0.2), h / 2, d / 2 - 0.2);
    }
    addBox(shell, lam(spec.accent ?? IPAL.steelDark), w + 0.4, 0.24, 0.4, 0, h - 0.1, d / 2 - 0.2);
  }

  // ── 燈光 ──
  const ambient = new THREE.AmbientLight(0xfff2e0, outdoor ? 0.42 : 0.52);
  scene.add(ambient);
  const hemi = new THREE.HemisphereLight(outdoor ? 0xbcd6ee : 0xfff0d8, outdoor ? 0x5f6a52 : 0x3a2f28, outdoor ? 0.55 : 0.42);
  scene.add(hemi);
  const windowLight = new THREE.DirectionalLight(0xfff0d0, outdoor ? 2.4 : 1.8);
  windowLight.position.set(w * 0.35, h + 2.6, d * 0.7 + 3);
  windowLight.target.position.set(0, h * 0.3, -d * 0.2);
  scene.add(windowLight);
  scene.add(windowLight.target);
  if (outdoor) {
    windowLight.castShadow = true;
    windowLight.shadow.mapSize.set(1024, 1024);
    const sc = windowLight.shadow.camera;
    sc.left = -w * 1.1;
    sc.right = w * 1.1;
    sc.top = h * 2.2;
    sc.bottom = -h * 2.2;
    sc.near = 0.5;
    sc.far = d * 4 + h * 3;
    windowLight.shadow.bias = -0.0012;
  }

  const lamps: THREE.PointLight[] = [];
  if (!outdoor) {
    const lampCountP = w > 8.5 ? 3 : 2;
    for (let i = 0; i < lampCountP; i++) {
      const lx = -w * 0.26 + (i * w * 0.52) / (lampCountP - 1);
      const pl = new THREE.PointLight(0xffdcae, 6, Math.max(w, d) * 1.1, 1.8);
      pl.position.set(lx, h - 0.55, -d * 0.1);
      scene.add(pl);
      lamps.push(pl);
    }
  } else {
    const pl = new THREE.PointLight(0xffe0b0, 3, Math.max(w, d) * 1.4, 1.8);
    pl.position.set(0, h * 0.72, -d * 0.1);
    scene.add(pl);
    lamps.push(pl);
  }

  return {
    windowLight,
    hemi,
    ambient,
    lamps,
    windows,
    outdoor,
    skyColors: outdoor ? { day: SKY_DAY.clone(), night: SKY_NIGHT.clone() } : null,
  };
}

// ─────────────────────────── 小工具 ───────────────────────────

let neonSeed = 3.1;
function neonFlickerPhase(): number {
  neonSeed += 1.73;
  return neonSeed;
}

/** 掛牆招牌（實色底）。 */
function addBoard(
  ctx: FillCtx,
  key: string,
  lines: string[],
  x: number,
  y: number,
  z: number,
  ry: number,
  w: number,
  h: number,
  opts: { bg?: number; fg?: string; border?: string; font?: string; texW?: number; texH?: number } = {},
): THREE.Mesh {
  const mat = signBoardMat(key, lines, {
    w: opts.texW ?? 256,
    h: opts.texH ?? 128,
    bg: opts.bg,
    fg: opts.fg,
    border: opts.border,
    font: opts.font,
  });
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  addBox(g, lam(0x1a1c1f), w + 0.08, h + 0.08, 0.06, 0, 0, -0.03);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  plane.position.z = 0.012;
  g.add(plane);
  ctx.root.add(g);
  return plane;
}

/** 霓虹招牌（發光、會閃）。 */
function addNeon(
  ctx: FillCtx,
  text: string,
  color: number,
  x: number,
  y: number,
  z: number,
  ry: number,
  w: number,
  h: number,
  vertical = false,
): THREE.Mesh {
  const mat = neonSignMat(text, color, vertical);
  ctx.neon.push(mat);
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  addBox(g, lam(0x171219), w + 0.1, h + 0.1, 0.08, 0, 0, -0.04);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  plane.position.z = 0.012;
  g.add(plane);
  ctx.root.add(g);
  return plane;
}

/** 招牌／海報貼牆。 */
function addPoster(ctx: FillCtx, text: string, x: number, y: number, z: number, ry: number, w = 0.45, h = 0.64): void {
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), posterMat(text));
  plane.position.set(x, y, z);
  plane.rotation.y = ry;
  ctx.root.add(plane);
}

/** 人物數量（依居民／工人數，最多 5 個）。 */
function peopleCount(room: 'resident' | 'worker', n: number): number {
  if (room === 'resident') return Math.max(1, Math.min(4, Math.ceil(n / 4)));
  return Math.max(1, Math.min(5, Math.ceil(n / 5)));
}

// ─────────────────────────── 32 種原有室內陳設 ───────────────────────────

/** 1. 唐樓單位：鐵閘、碌架床、舊電視、吊扇、神枱。 */
function fillTongLau(ctx: FillCtx): void {
  const { root, dims } = ctx;
  const { w, d, h } = dims;
  const building = ctx.building;
  addIronGate(root, w * 0.44, d * 0.24, -1.42, 1.1, 2.0);
  addBox(root, lam(IPAL.wallOldDark), 0.16, 2.15, 0.3, w * 0.44 - 0.03, 1.07, d * 0.24 - 0.2);
  addAltar(root, -w * 0.4, -d * 0.4, 0.4);
  addTVUnit(root, -w * 0.06, -d * 0.34, 0, true);
  addSofa(root, -w * 0.3, d * 0.08, Math.PI * 0.5, 0x7a6a52, 2.0);
  addCoffeeTable(root, -w * 0.05, d * 0.1, 0);
  addDiningSet(root, w * 0.26, d * 0.14, 0.3, 3);
  addBunkBed(root, w * 0.34, -d * 0.22, -Math.PI / 2, true);
  addWardrobe(root, -w * 0.42, -d * 0.05, Math.PI / 2, 0.85);
  addCeilingFan(root, 0, h - 0.28, 0, 0.85);
  addCeilingFan(root, -w * 0.26, h - 0.28, -d * 0.2, 0.6);
  addClothesRack(root, w * 0.08, -d * 0.42, 0, 1.6);
  addKitchenCounter(root, w * 0.44, d * 0.1, -Math.PI / 2, 1.7);
  addFridge(root, w * 0.44, d * 0.32, -Math.PI / 2, 0.8);
  addMahjongTable(root, -w * 0.36, d * 0.4, 0.2);
  addPoster(ctx, '招租', -w * 0.1, h * 0.6, -d / 2 + 0.24, 0);
  addPoster(ctx, '麻雀', -w * 0.3, h * 0.55, -d / 2 + 0.24, 0);
  const n = peopleCount('resident', building.residents.length);
  const kinds: ('elder' | 'office' | 'shopper' | 'kid')[] = ['elder', 'office', 'shopper', 'kid'];
  for (let i = 0; i < n; i++) {
    addPerson(root, {
      x: -w * 0.16 + i * 0.85,
      z: d * 0.3 - (i % 2) * 0.3,
      ry: Math.PI * (0.7 + i * 0.15),
      kind: kinds[i % kinds.length],
    });
  }
}

/** 2. 劏房：板間房、上下格床、電飯煲、共用電錶。 */
function fillSubdividedFlat(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addBoardPartition(root, -w * 0.18, d * 0.05, Math.PI / 2, d * 0.7, 2.3);
  addBoardPartition(root, w * 0.2, d * 0.18, 0, w * 0.42, 2.3);
  addBox(root, lam(IPAL.wallOldDark), 0.12, 2.3, 0.12, -w * 0.18, 1.15, d * 0.05);
  addBunkBed(root, -w * 0.34, -d * 0.26, -Math.PI / 2, false);
  addBox(root, lam(0xd94a3f), 0.5, 0.4, 0.5, w * 0.3, 0.2, -d * 0.3);
  const tv = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.34), tvScreenMat());
  tv.position.set(w * 0.3, 0.62, -d * 0.28);
  tv.rotation.y = -0.35;
  root.add(tv);
  addBox(root, lam(0x8a6038), 0.8, 0.05, 0.5, w * 0.22, 0.7, d * 0.16);
  for (const [sx, sz] of [
    [-0.32, -0.18],
    [0.32, -0.18],
    [-0.32, 0.18],
    [0.32, 0.18],
  ]) {
    addBox(root, lam(0x5c3f24), 0.06, 0.7, 0.06, w * 0.22 + sx, 0.35, d * 0.16 + sz);
  }
  addBox(root, lam(0xd9d4c8), 0.2, 0.05, 0.2, w * 0.22, 0.76, d * 0.16);
  addCyl(root, lam(0xbfe0ea), 0.045, 0.04, 0.14, w * 0.34, 0.8, d * 0.14, 8);
  // 電飯煲
  addCyl(root, lam(0xd94a3f), 0.16, 0.15, 0.35, -w * 0.06, 0.18, d * 0.26, 10);
  addBox(root, lam(0xe4e0d4), 0.24, 0.18, 0.24, -w * 0.06, 0.44, d * 0.26);
  addBox(root, lam(0x2f3337), 0.2, 0.03, 0.2, -w * 0.06, 0.54, d * 0.26);
  addBox(root, lam(IPAL.plasticRed), 0.5, 0.32, 0.4, -w * 0.36, 0.16, d * 0.3);
  addBox(root, lam(IPAL.plasticBlue), 0.46, 0.28, 0.36, -w * 0.36, 0.46, d * 0.3);
  // 晾衫繩
  for (let i = 0; i < 2; i++) {
    addCyl(root, lam(0x9a9a8a), 0.008, 0.008, w * 0.9, 0, h - 0.35 - i * 0.2, -d * 0.1 + i * 0.2, 3, 0, Math.PI / 2);
    for (let j = 0; j < 3; j++) {
      addBox(root, lam([0x8fb0c0, 0xd9c9a0, 0xcf8f8a][j]), 0.22, 0.3, 0.02, -w * 0.3 + j * 0.5, h - 0.68 - i * 0.2, -d * 0.1 + i * 0.2);
    }
  }
  // 電錶
  for (let i = 0; i < 4; i++) {
    addBox(root, lam(0x9aa0a6), 0.18, 0.24, 0.1, -w * 0.14 + i * 0.24, 1.7, d * 0.46);
    addBox(root, lam(0x2f3337), 0.02, 0.1, 0.12, -w * 0.14 + i * 0.24, 1.7, d * 0.48);
  }
  addCeilingFan(root, 0, h - 0.28, 0, 0.62);
  for (let i = 0; i < Math.min(3, peopleCount('resident', building.residents.length) + 1); i++) {
    addPerson(root, {
      x: -w * 0.04 + i * 0.7,
      z: d * 0.32,
      ry: Math.PI * 0.9,
      pose: i === 1 ? 'sit' : 'stand',
      kind: i === 0 ? 'elder' : 'kid',
    });
  }
}

/** 3. 公共屋邨：客廳、晾衫、電視、神枱。 */
function fillPublicHousing(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addIronGate(root, -w * 0.38, d * 0.44, 0.4, 1.2, 2.1);
  addTVUnit(root, 0, -d * 0.34, 0, false);
  addSofa(root, -w * 0.14, d * 0.02, Math.PI, 0x6f8a7a, 2.6);
  addCoffeeTable(root, -w * 0.1, d * 0.1, 0.1);
  addDiningSet(root, w * 0.28, d * 0.06, 0.2, 4);
  addClothesRack(root, w * 0.16, -d * 0.4, 0, 2.0);
  addKitchenCounter(root, w * 0.44, d * 0.22, -Math.PI / 2, 2.0);
  addFridge(root, w * 0.42, d * 0.05, -Math.PI / 2, 0.85);
  addAltar(root, -w * 0.42, -d * 0.28, 0.3);
  addMahjongTable(root, -w * 0.34, d * 0.34, 0.3);
  addPoster(ctx, '屋邨', w * 0.1, h * 0.62, -d / 2 + 0.24, 0);
  addCeilingFan(root, 0, h - 0.3, 0, 0.8);
  const n = peopleCount('resident', building.residents.length);
  const kinds: ('elder' | 'shopper' | 'student' | 'office')[] = ['shopper', 'student', 'elder', 'office'];
  for (let i = 0; i < n; i++) {
    addPerson(root, {
      x: -w * 0.24 + i * 0.8,
      z: d * 0.24 + (i % 2) * 0.2,
      ry: Math.PI * (0.8 + i * 0.12),
      kind: kinds[i % kinds.length],
    });
  }
}

/** 4. 居屋苑：客廳、飯廳、兒童書桌。 */
function fillHOSFlat(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addSofa(root, -w * 0.16, d * 0.04, Math.PI, 0x8a7a9a, 2.8);
  addCoffeeTable(root, -w * 0.1, d * 0.14, 0);
  addTVUnit(root, 0, -d * 0.34, 0, false);
  addDiningSet(root, w * 0.3, d * 0.1, 0.2, 4);
  addKitchenCounter(root, -w * 0.44, d * 0.18, Math.PI / 2, 2.2);
  addFridge(root, -w * 0.44, -d * 0.06, Math.PI / 2, 0.9);
  addBox(root, lam(0xe4ded0), 1.2, 0.05, 0.55, w * 0.22, 0.72, -d * 0.3);
  addBox(root, lam(0x9aa0a6), 0.05, 0.72, 0.05, w * 0.22 - 0.52, 0.36, -d * 0.3);
  addBox(root, lam(0x9aa0a6), 0.05, 0.72, 0.05, w * 0.22 + 0.52, 0.36, -d * 0.3);
  addBox(root, lam(0x3f7fb0), 0.3, 0.03, 0.24, w * 0.22, 0.76, -d * 0.3);
  addBox(root, lam(0xd94a3f), 0.22, 0.26, 0.06, w * 0.05, 0.86, -d * 0.32);
  addShelfUnit(root, w * 0.42, d * 0.05, -Math.PI / 2, { w: 1.2, h: 1.7, levels: 3, goods: [0x8a3a2a, 0x3f6f9f, 0x4f7a44, 0xd9c25a] });
  addPottedPlant(root, w * 0.4, d * 0.36, 1.1, true);
  addClothesRack(root, -w * 0.2, -d * 0.42, 0, 1.6);
  addCeilingFan(root, 0, h - 0.3, 0, 0.8);
  const n = peopleCount('resident', building.residents.length);
  for (let i = 0; i < n; i++) {
    addPerson(root, {
      x: -w * 0.2 + i * 0.9,
      z: d * 0.3,
      ry: Math.PI * (0.8 + i * 0.1),
      kind: i === 2 ? 'student' : i === 0 ? 'shopper' : 'office',
    });
  }
}

/** 5. 私人屋苑：會所式客廳＋落地窗。 */
function fillPrivateEstate(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addSofa(root, -w * 0.1, d * 0.1, Math.PI, 0xc9c3d4, 3.0);
  addCoffeeTable(root, -w * 0.06, d * 0.22, 0);
  // 開放式廚房島
  addBox(root, lam(0xe8e4dc), 2.4, 0.06, 0.9, w * 0.3, 0.88, d * 0.02);
  addBox(root, lam(0x9aa0a6), 2.3, 0.86, 0.84, w * 0.3, 0.43, d * 0.02);
  addCyl(root, lam(0xbfe0ea), 0.045, 0.04, 0.14, w * 0.3, 0.98, d * 0.02, 8);
  addBox(root, lam(0x2f3337), 0.3, 0.06, 0.3, w * 0.2, 0.96, d * 0.02);
  addTVUnit(root, w * 0.34, -d * 0.32, 0.3, false);
  addDiningSet(root, -w * 0.3, -d * 0.06, 0.3, 4);
  addPottedPlant(root, -w * 0.42, d * 0.36, 1.3, false);
  addPottedPlant(root, w * 0.42, -d * 0.34, 1.0, false);
  addBox(root, lam(0x2f3a4a), 1.2, 0.9, 0.05, 0, h * 0.62, -d / 2 + 0.24);
  addBox(root, lam(0xd9c25a), 0.7, 0.6, 0.02, 0, h * 0.62, -d / 2 + 0.26, 0.1);
  addCeilingLamp(root, 0, h - 0.14, -d * 0.05, 2.2);
  const n = peopleCount('resident', building.residents.length);
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.2 + i * 0.9, z: d * 0.32, ry: Math.PI * 0.85, kind: i % 2 ? 'office' : 'shopper' });
  }
}

/** 6. 豪宅：維港落地玻璃、雲石、鋼琴。 */
function fillLuxuryTower(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addBox(root, lam(0x3a2f2a), w * 0.6, 0.02, d * 0.5, 0, 0.02, d * 0.1);
  addSofa(root, -w * 0.06, d * 0.02, Math.PI, 0xcfd8e3, 3.2);
  addCoffeeTable(root, 0, d * 0.16, 0);
  // 三角鋼琴
  const piano = new THREE.Group();
  piano.position.set(w * 0.32, 0, -d * 0.22);
  piano.rotation.y = -0.6;
  addBox(piano, lam(0x14161a), 1.9, 0.12, 1.3, 0, 0.72, 0);
  addBox(piano, lam(0x14161a), 1.9, 0.68, 0.1, 0, 0.36, -0.6);
  addBox(piano, lam(0x14161a), 0.8, 0.68, 0.4, -0.5, 0.36, 0.35);
  addBox(piano, lam(0xf2f0e6), 1.3, 0.03, 0.2, 0, 0.8, 0.4);
  for (let i = 0; i < 8; i++) addBox(piano, lam(0x14161a), 0.12, 0.03, 0.12, -0.55 + i * 0.16, 0.8, 0.42);
  addBox(piano, lam(0x8a8f96), 0.06, 0.72, 0.06, 0.8, 0.36, 0.3);
  root.add(piano);
  // 酒吧櫃
  addBox(root, lam(0x2f2622), 2.2, 1.1, 0.5, -w * 0.3, 0.55, -d * 0.4);
  for (let i = 0; i < 6; i++) {
    addCyl(root, lam([0x8a3a2a, 0x3f6f9f, 0xd9c25a][i % 3]), 0.05, 0.05, 0.28, -w * 0.3 - 0.85 + i * 0.3, 1.2, -d * 0.4, 8);
  }
  // 藝術品
  addCyl(root, lam(0xd9c25a), 0.3, 0.3, 0.05, w * 0.3, 1.2, d * 0.3, 16);
  addBox(root, lam(0x8a8f96), 0.06, 1.2, 0.06, w * 0.3, 0.6, d * 0.3);
  // 水晶吊燈
  for (let i = 0; i < 3; i++) addSphere(root, basic(0xfff4d0), 0.09, (i - 1) * 0.4, h - 0.6 - (i % 2) * 0.2, -d * 0.05, 8, 6);
  addCyl(root, lam(0xc9a24c), 0.02, 0.02, 0.6, 0, h - 0.3, -d * 0.05, 5);
  addPottedPlant(root, -w * 0.42, d * 0.4, 1.5, false);
  const n = peopleCount('resident', building.residents.length);
  for (let i = 0; i < Math.max(1, Math.min(2, n)); i++) {
    addPerson(root, { x: -w * 0.06 + i * 1.1, z: d * 0.3, ry: Math.PI * 0.9, kind: 'tourist' });
  }
}

/** 7. 農田：田間小屋、農具、菜籮、溫室。 */
function fillFarm(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addBox(root, lam(0x9a7a52), w * 0.4, 0.12, d * 0.3, -w * 0.24, h * 0.42, -d * 0.28);
  addBox(root, lam(0x8a6038), 0.12, h * 0.42, 0.12, -w * 0.4, h * 0.21, -d * 0.28);
  addBox(root, lam(0x8a6038), 0.12, h * 0.42, 0.12, -w * 0.08, h * 0.21, -d * 0.28);
  addBox(root, lam(0xc9b070), w * 0.46, 0.08, d * 0.34, -w * 0.24, h * 0.46, -d * 0.28);
  addGreenhouse(root, w * 0.26, -d * 0.16, 0.2, 2.8, 1.8, 1.9);
  addVegCrate(root, -w * 0.3, d * 0.04, 0.2, 4);
  addVegCrate(root, -w * 0.08, d * 0.24, -0.3, 3);
  addFarmTools(root, w * 0.02, -d * 0.32, 0.3);
  addCyl(root, lam(0x6f8f9a), 0.34, 0.3, 0.7, w * 0.36, 0.35, d * 0.1, 12);
  addCyl(root, lam(0x9fd0e0), 0.31, 0.31, 0.03, w * 0.36, 0.65, d * 0.1, 12);
  addCyl(root, lam(0x3f7fb0), 0.2, 0.16, 0.3, w * 0.3, 0.15, d * 0.32, 10);
  addCyl(root, lam(0xc9b070), 0.4, 0.44, 0.5, -w * 0.42, 0.25, d * 0.3, 12);
  addCone(root, lam(0xd9c25a), 0.42, 0.5, -w * 0.42, 0.75, d * 0.3, 12);
  addCone(root, lam(0xc9a46a), 0.3, 0.16, -w * 0.14, h * 0.4, -d * 0.3, 12);
  const n = peopleCount('worker', building.workers.length);
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.16 + i * 0.9, z: d * 0.18, ry: Math.PI * (0.8 + i * 0.1), kind: 'worker' });
  }
  addTree(root, w * 0.42, -d * 0.34, 0.9, true);
  addBird(root, -w * 0.2, 0.4, d * 0.3);
  addBird(root, -w * 0.12, 0.3, d * 0.34, 0x6f6560);
}

/** 8. 茶餐廳：卡位、餐牌、奶茶、吊扇。 */
function fillChaChaanTeng(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addBooth(root, -w * 0.26, d * 0.02, 0);
  addBooth(root, w * 0.02, d * 0.02, 0);
  addBooth(root, w * 0.3, d * 0.02, 0);
  for (const x of [-w * 0.26, w * 0.02, w * 0.3]) {
    addMilkTea(root, x - 0.25, 0.75, -d * 0.04);
    addMilkTea(root, x + 0.25, 0.75, d * 0.04);
  }
  addCashierCounter(root, -w * 0.12, -d * 0.34, 0, 2.6);
  addBox(root, lam(0x8a6038), 2.4, 0.7, 0.5, w * 0.26, 1.4, -d * 0.36);
  for (let i = 0; i < 5; i++) addCyl(root, lam(0xf2eee4), 0.04, 0.035, 0.1, w * 0.16 + i * 0.14, 1.8, -d * 0.35, 8);
  addMenuBoard(root, -w * 0.1, h * 0.58, -d / 2 + 0.26, 0, 1.1, 1.5);
  addMenuBoard(root, w * 0.3, h * 0.5, -d / 2 + 0.26, 0, 0.9, 1.2);
  addCeilingFan(root, -w * 0.2, h - 0.3, -d * 0.02, 0.75);
  addCeilingFan(root, w * 0.22, h - 0.3, -d * 0.02, 0.75);
  addNeon(ctx, '茶餐廳', IPAL.neonPink, -w * 0.3, h * 0.68, -d / 2 + 0.3, 0, 1.5, 0.5);
  addNeon(ctx, '凍奶茶', IPAL.neonCyan, w * 0.06, h * 0.68, -d / 2 + 0.3, 0, 1.4, 0.46);
  addBox(root, lam(0x4a3a2a), 2.0, 0.12, 0.6, -w * 0.06, 1.55, -d * 0.18);
  addBox(root, lam(0x8a9096), 2.0, 0.06, 0.4, -w * 0.06, 1.62, -d * 0.18);
  for (let i = 0; i < 3; i++) addCyl(root, lam(0xf2eee4), 0.13, 0.11, 0.1, -w * 0.24 + i * 0.45, 1.72, -d * 0.18, 10);
  const staff = peopleCount('worker', building.workers.length);
  for (let i = 0; i < Math.min(3, staff); i++) {
    addPerson(root, { x: -w * 0.3 + i * 0.8, z: -d * 0.26, ry: Math.PI * 0.2, kind: 'chef' });
  }
  addPerson(root, { x: -w * 0.26, z: d * 0.1, ry: Math.PI / 2, pose: 'sit', kind: 'office' });
  addPerson(root, { x: w * 0.02, z: d * 0.1, ry: -Math.PI / 2, pose: 'sit', kind: 'shopper' });
  addPerson(root, { x: w * 0.3, z: d * 0.1, ry: Math.PI, kind: 'elder' });
  addCyl(root, lam(0xf2f0e6), 0.22, 0.22, 0.04, -w * 0.42, h * 0.62, -d * 0.05, 14, Math.PI / 2, 0);
  addPoster(ctx, '茶餐廳', w * 0.42, h * 0.6, -d / 2 + 0.26, 0, 0.5, 0.7);
  addPottedPlant(root, w * 0.42, d * 0.38, 1.0, true);
}

/** 9. 便利店：貨架、雪櫃、收銀。 */
function fillConvenienceStore(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addShelfUnit(root, -w * 0.2, -d * 0.24, 0, { w: 2.2, h: 1.9, levels: 4, goods: [0xd94a3f, 0x4fa3c9, 0xe0b33a, 0x5f9a4a, 0xc76bd1] });
  addShelfUnit(root, w * 0.14, -d * 0.24, 0, { w: 2.0, h: 1.9, levels: 4 });
  addShelfUnit(root, -w * 0.36, -d * 0.02, Math.PI / 2, { w: 1.6, h: 1.8, levels: 3 });
  addDrinkFridge(root, w * 0.34, -d * 0.28, 0, 1.2);
  addDrinkFridge(root, w * 0.42, d * 0.02, -Math.PI / 2, 1.2);
  addCashierCounter(root, -w * 0.06, d * 0.28, Math.PI, 2.4);
  addBox(root, lam(0xc9ced2), 1.4, 0.7, 0.5, w * 0.22, 0.35, d * 0.3);
  addBox(root, lam(0xd94a3f), 1.2, 0.06, 0.4, w * 0.22, 0.73, d * 0.3);
  for (let i = 0; i < 6; i++) addSphere(root, lam(0xd9a04a), 0.05, w * 0.12 + (i % 3) * 0.12, 0.8, d * 0.26 + Math.floor(i / 3) * 0.08, 6, 5);
  // 雪糕櫃
  addBox(root, lam(0xdfeef2), 1.0, 0.8, 0.6, -w * 0.34, 0.4, d * 0.18);
  addBox(root, glass(0xbfe0ea, 0.3), 0.96, 0.1, 0.56, -w * 0.34, 0.85, d * 0.18);
  addNeon(ctx, '便利店', IPAL.neonCyan, -w * 0.26, h * 0.68, -d / 2 + 0.3, 0, 1.7, 0.5);
  addNeon(ctx, '24小時', IPAL.neonPink, w * 0.14, h * 0.68, -d / 2 + 0.3, 0, 1.6, 0.5);
  addBoard(ctx, 'promo', ['買一送一', '今日優惠'], w * 0.4, 1.35, -d / 2 + 0.26, 0, 0.8, 0.6, { bg: 0xffd166 });
  addCeilingLamp(root, 0, h - 0.14, -d * 0.1, 2.4);
  addCeilingLamp(root, -w * 0.3, h - 0.14, d * 0.1, 1.6);
  const staff = peopleCount('worker', building.workers.length);
  addPerson(root, { x: -w * 0.06, z: d * 0.16, ry: 0, kind: 'worker' });
  for (let i = 0; i < Math.min(2, staff); i++) addPerson(root, { x: w * 0.06 + i * 0.4, z: d * 0.16, ry: 0, kind: 'worker' });
  addPerson(root, { x: -w * 0.2, z: d * 0.02, ry: Math.PI, kind: 'shopper' });
  addPerson(root, { x: w * 0.4, z: d * 0.28, ry: -0.6, kind: 'student' });
  addPottedPlant(root, -w * 0.42, d * 0.38, 0.9, false);
}

/** 10. 街市：菜檔、肉檔、魚檔、紅膠燈罩。 */
function fillWetMarket(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  for (let i = 0; i < 4; i++) addRedLampRow(root, -w * 0.3 + i * (w * 0.2), h - 0.2, -d * 0.1);
  addWetStall(root, -w * 0.26, -d * 0.2, 0, 'veg');
  addWetStall(root, w * 0.1, -d * 0.2, 0, 'meat');
  addWetStall(root, w * 0.34, d * 0.12, 0, 'fish');
  addBox(root, lam(0x8fb0bf), w * 0.7, 0.02, d * 0.22, 0, 0.02, d * 0.02);
  addCyl(root, lam(0xd94a3f), 0.22, 0.19, 0.4, -w * 0.4, 0.2, d * 0.3, 12);
  addCyl(root, lam(0x3f7fb0), 0.2, 0.17, 0.36, -w * 0.3, 0.18, d * 0.36, 12);
  addBox(root, lam(0xe4e0d4), 0.5, 0.3, 0.3, w * 0.32, 0.15, d * 0.36);
  addBoard(ctx, 'fresh', ['新 鮮 街 市', 'FRESH MARKET'], 0, h - 0.5, -d / 2 + 0.26, 0, 1.8, 0.5, { bg: 0x2f7f6a, fg: '#ffffff' });
  const staff = peopleCount('worker', building.workers.length);
  for (let i = 0; i < Math.min(3, staff); i++) addPerson(root, { x: -w * 0.16 + i * 0.6, z: -d * 0.06, ry: Math.PI, kind: 'chef' });
  addPerson(root, { x: -w * 0.05, z: d * 0.16, ry: Math.PI * 0.6, kind: 'shopper' });
  addPerson(root, { x: w * 0.2, z: d * 0.2, ry: -Math.PI * 0.4, kind: 'shopper' });
  addPerson(root, { x: w * 0.36, z: d * 0.3, ry: -Math.PI * 0.7, kind: 'elder' });
  addBox(root, lam(0xd9d4c8), 0.16, 0.22, 0.1, -w * 0.1, 0.13, d * 0.2);
}

/** 10b. 街市紅膠燈罩（直接引用 parts 的 addRedPlasticLamp 會多 import；此處薄封裝）。 */
function addRedLampRow(parent: THREE.Object3D, x: number, y: number, z: number): void {
  addCyl(parent, lam(0x2a2f36), 0.012, 0.012, 0.5, x, y + 0.25, z, 4);
  const shade = addCyl(parent, basic(0xff3a2a), 0.24, 0.1, 0.14, x, y - 0.02, z, 14);
  markAnim(shade, 'glow');
  addSphere(parent, basic(0xffe0b0), 0.07, x, y - 0.1, z, 8, 6);
}

/** 11. 超市：貨架通道、生果、收銀、購物車。 */
function fillSupermarket(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  for (let i = 0; i < 3; i++) {
    addShelfUnit(root, -w * 0.3 + i * w * 0.3, -d * 0.06, 0, { w: 2.2, h: 2.0, levels: 4 });
    addShelfUnit(root, -w * 0.3 + i * w * 0.3, d * 0.2, 0, { w: 2.2, h: 1.7, levels: 3 });
  }
  addBox(root, lam(0x8a6038), 2.4, 0.7, 0.8, -w * 0.28, 0.35, -d * 0.32);
  const fruitColors = [0xd94a3f, 0xe0b33a, 0x5f9a4a, 0xd97a3f, 0x9a5fa0];
  for (let i = 0; i < 10; i++) {
    addSphere(root, lam(fruitColors[i % fruitColors.length]), 0.09, -w * 0.4 + (i % 5) * 0.22, 0.78, -d * 0.32 + Math.floor(i / 5) * 0.2, 7, 5);
  }
  addBox(root, lam(0xdfeef2), 1.2, 0.9, 1.8, w * 0.4, 0.45, d * 0.2);
  addBox(root, glass(0xbfe0ea, 0.28), 1.16, 0.1, 1.76, w * 0.4, 0.9, d * 0.2);
  addCashierCounter(root, -w * 0.06, d * 0.38, Math.PI, 2.8);
  addCashierCounter(root, w * 0.36, d * 0.38, Math.PI, 2.2);
  addShoppingCart(root, -w * 0.34, d * 0.32, 0.4);
  addShoppingCart(root, w * 0.06, d * 0.32, -0.3);
  for (let i = 0; i < 3; i++) addCeilingLamp(root, -w * 0.3 + i * w * 0.3, h - 0.12, -d * 0.16, 2.2);
  addNeon(ctx, '超級市場', IPAL.neonGreen, 0, h * 0.68, -d / 2 + 0.3, 0, 2.0, 0.52);
  const staff = peopleCount('worker', building.workers.length);
  for (let i = 0; i < Math.min(3, staff); i++) addPerson(root, { x: -w * 0.06 + i * 1.2, z: d * 0.24, ry: 0, kind: 'worker' });
  addPerson(root, { x: -w * 0.28, z: d * 0.1, ry: Math.PI * 0.4, kind: 'shopper' });
  addPerson(root, { x: w * 0.18, z: d * 0.08, ry: -Math.PI * 0.3, kind: 'shopper' });
  addPerson(root, { x: w * 0.1, z: -d * 0.36, ry: Math.PI, kind: 'elder' });
  addPottedPlant(root, w * 0.44, -d * 0.4, 1.0, false);
}

/** 12. 商場：中庭、店舖、扶手電梯、天幕。 */
function fillShoppingMall(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addBox(root, lam(0xe8e3d6), w, 0.06, d * 0.4, 0, 0.02, -d * 0.28);
  addHarbourRail(root, 0, -d * 0.12, w * 0.9);
  addEscalator(root, -w * 0.22, -d * 0.02, 0, 4.4, 2.2);
  addEscalator(root, w * 0.22, -d * 0.02, Math.PI, 4.4, 2.2);
  addShopFront(root, -w * 0.3, -d * 0.42, 0, { w: 2.6, h: 2.8, name: '珠寶金行', color: IPAL.neonGold });
  addShopFront(root, 0, -d * 0.42, 0, { w: 2.4, h: 2.8, name: '名店', color: IPAL.neonPink });
  addShopFront(root, w * 0.3, -d * 0.42, 0, { w: 2.6, h: 2.8, name: '電器', color: IPAL.neonCyan });
  addShopFront(root, w * 0.44, d * 0.1, -Math.PI / 2, { w: 2.4, h: 2.8, name: '髮廊', color: IPAL.neonPurple });
  for (let i = 0; i < 5; i++) {
    addSphere(root, basic([0xff3d7f, 0x24e0ff, 0xffd166, 0x5cff9d, 0xa45bff][i]), 0.16, (i - 2) * 0.7, h * 0.55 + (i % 2) * 0.25, -d * 0.05, 10, 8);
    addCyl(root, lam(0x8a9096), 0.006, 0.006, h * 0.3, (i - 2) * 0.7, h * 0.78, -d * 0.05, 3);
  }
  addBox(root, basic(0xdff2ff), w * 0.7, 0.04, d * 0.5, 0, h - 0.2, 0);
  for (let i = 0; i < 4; i++) addBox(root, lam(0x8a9096), 0.06, h * 0.6, 0.06, -w * 0.3 + i * (w * 0.2), h - 0.5, -d * 0.2);
  addBoard(ctx, 'mall-dir', ['商場指南', '1/F 時裝 · 2/F 食肆', '3/F 戲院 · B1 超市'], w * 0.42, h * 0.5, -d * 0.12, 0, 1.2, 0.8, { bg: 0x2f3a4a, fg: '#ffffff' });
  addNeon(ctx, '商場', IPAL.neonPink, 0, h * 0.82, -d / 2 + 0.34, 0, 2.4, 0.6);
  addBench(root, -w * 0.1, d * 0.22, Math.PI);
  addBench(root, w * 0.16, d * 0.22, Math.PI);
  addPottedPlant(root, -w * 0.42, d * 0.3, 1.4, false);
  addPottedPlant(root, w * 0.42, d * 0.3, 1.4, false);
  addTrashBin(root, w * 0.04, d * 0.3);
  const n = Math.max(2, peopleCount('worker', building.workers.length));
  const kinds: ('shopper' | 'tourist' | 'office' | 'kid')[] = ['shopper', 'tourist', 'office', 'kid'];
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.3 + i * 1.0, z: d * 0.16, ry: Math.PI * (0.7 + i * 0.1), kind: kinds[i % kinds.length] });
  }
  addPerson(root, { x: -w * 0.12, z: -d * 0.1, ry: 0, kind: 'tourist', mask: false });
}

/** 13. 酒樓：圓桌、點心車、龍鳳牆。 */
function fillRestaurant(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addBox(root, lam(0x8f1f18), 3.1, 1.8, 0.04, 0, h * 0.58, -d / 2 + 0.24);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.7), dragonPhoenixMat());
  wall.position.set(0, h * 0.58, -d / 2 + 0.28);
  root.add(wall);
  addRoundDiningTable(root, 0, d * 0.08, 1.15);
  addRoundDiningTable(root, -w * 0.32, -d * 0.16, 0.9);
  addRoundDiningTable(root, w * 0.32, -d * 0.16, 0.9);
  addRoundDiningTable(root, w * 0.24, d * 0.32, 0.85);
  addDimSumCart(root, -w * 0.06, d * 0.28, 0.6);
  for (let i = 0; i < 4; i++) addRedLantern(root, -w * 0.3 + i * (w * 0.2), h - 0.2, -d * 0.02);
  for (let i = 0; i < 2; i++) addRedLantern(root, -w * 0.38 + i * w * 0.76, h - 0.2, d * 0.26);
  addNeon(ctx, '海鮮酒家', IPAL.neonGold, 0, h * 0.72, -d / 2 + 0.3, 0, 2.2, 0.56);
  addBoard(ctx, 'dimsum', ['點心 · 茶芥', '早市 6:30 · 晚市 6:00'], -w * 0.4, h * 0.48, -d * 0.2, Math.PI / 2, 1.0, 0.7, { bg: 0x8f1f18, fg: '#ffd166' });
  const staff = peopleCount('worker', building.workers.length);
  for (let i = 0; i < Math.min(3, staff); i++) addPerson(root, { x: -w * 0.2 + i * 0.7, z: d * 0.3, ry: Math.PI * 0.9, kind: 'chef' });
  addPerson(root, { x: -0.2, z: d * 0.08, ry: Math.PI / 2, pose: 'sit', kind: 'office' });
  addPerson(root, { x: 0.4, z: d * 0.08, ry: -Math.PI / 2, pose: 'sit', kind: 'shopper' });
  addPerson(root, { x: -w * 0.32, z: -d * 0.16, ry: Math.PI, pose: 'sit', kind: 'elder' });
  addPerson(root, { x: w * 0.3, z: -d * 0.1, ry: Math.PI * 1.1, kind: 'tourist' });
  addPottedPlant(root, -w * 0.44, d * 0.38, 1.2, false);
}

/** 14. 商廈：開放式辦公室、海景。 */
function fillOfficeTower(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) addOfficeDesk(root, -w * 0.24 + i * w * 0.36, -d * 0.18 + j * d * 0.34, 0);
  }
  addOfficePartition(root, 0, -d * 0.02, 0, 2.4);
  addWhiteboard(root, w * 0.34, h * 0.52, -d / 2 + 0.26, 0, 1.8, 0.95);
  addBox(root, lam(0x8a6038), 1.8, 0.06, 0.9, w * 0.34, 0.76, 0.18);
  for (let i = 0; i < 4; i++) addBox(root, lam(0x2f3337), 0.4, 0.06, 0.4, w * 0.2 + i * 0.32, 0.46, 0.68);
  addWaterCooler(root, -w * 0.42, -d * 0.42);
  addPrinter(root, -w * 0.4, d * 0.38);
  for (let i = 0; i < 3; i++) addCeilingLamp(root, -w * 0.28 + i * w * 0.28, h - 0.14, -d * 0.05, 2.0);
  addNeon(ctx, '維港實業', IPAL.neonCyan, 0, h * 0.7, -d / 2 + 0.32, 0, 2.2, 0.55);
  const n = Math.max(2, peopleCount('worker', building.workers.length));
  for (let i = 0; i < n; i++) {
    addPerson(root, {
      x: -w * 0.24 + (i % 2) * w * 0.36,
      z: -d * 0.18 + Math.floor(i / 2) * d * 0.34 - 0.75,
      ry: Math.PI,
      pose: 'sit',
      kind: 'office',
    });
  }
  addPerson(root, { x: w * 0.06, z: d * 0.2, ry: Math.PI * 0.8, kind: 'office' });
  addPottedPlant(root, w * 0.42, d * 0.1, 1.2, false);
}

/** 15. 工廈：車間、機器、紙箱、通風槽。 */
function fillIndustrialBuilding(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  for (let i = 0; i < 3; i++) addBox(root, lam(IPAL.steelDark), w, 0.16, 0.2, 0, h - 0.2, -d * 0.3 + i * d * 0.3);
  addVentDuct(root, 0, h - 0.55, -d * 0.35, w * 0.8, 0, true);
  addMachine(root, -w * 0.26, -d * 0.16, 0, 1.0);
  addMachine(root, -w * 0.02, -d * 0.2, Math.PI, 0.9);
  addConveyor(root, w * 0.22, -d * 0.1, 0, 3.0);
  addPallet(root, w * 0.3, d * 0.16, 0.2);
  addCardboardBoxes(root, w * 0.3, d * 0.16, 4, 1.0);
  addCardboardBoxes(root, w * 0.38, d * 0.34, 3, 0.9);
  addPallet(root, -w * 0.36, d * 0.28, -0.3);
  addCardboardBoxes(root, -w * 0.36, d * 0.28, 3, 0.9);
  addBarrelDrum(root, -w * 0.42, -d * 0.34, 0x3f6f9f);
  addBarrelDrum(root, -w * 0.42, -d * 0.24, 0xd94a3f);
  addDocumentDesk(root, w * 0.04, d * 0.26, 0, 1.8);
  addExitSign(root, -w * 0.44, h - 0.4, d * 0.4);
  addFireHose(root, -w * 0.44, 1.2, -d * 0.1, Math.PI / 2);
  addBoard(ctx, 'safety', ['工業安全', '戴好安全帽', '切勿違規操作'], w * 0.28, h * 0.5, -d / 2 + 0.26, 0, 1.1, 0.8, { bg: 0xe0b33a, fg: '#1f2937', border: '#1f2937' });
  const n = peopleCount('worker', building.workers.length);
  const kinds: ('worker' | 'office')[] = ['worker', 'worker', 'office', 'worker', 'worker'];
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.3 + i * 0.85, z: d * 0.12 + (i % 2) * 0.2, ry: Math.PI * (0.6 + i * 0.12), kind: kinds[i % kinds.length] });
  }
}

/** 16. 食品廠：不銹鋼設備、輸送帶、蒸氣。 */
function fillFoodFactory(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  for (let i = 0; i < 2; i++) {
    addCyl(root, lam(0xc9ced2), 0.7, 0.7, 1.4, -w * 0.28 + i * w * 0.36, 0.7, -d * 0.24, 16);
    addSphere(root, lam(0xdfe3e6), 0.7, -w * 0.28 + i * w * 0.36, 1.42, -d * 0.24, 16, 8);
    addCyl(root, lam(0x8a9096), 0.06, 0.06, 1.0, -w * 0.28 + i * w * 0.36, 2.1, -d * 0.24, 8);
    addCyl(root, lam(0xd94a3f), 0.16, 0.16, 0.1, -w * 0.28 + i * w * 0.36, 1.9, -d * 0.24 + 0.5, 8);
  }
  for (let i = 0; i < 3; i++) {
    const steam = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), steamMat());
    steam.position.set(-w * 0.2 + i * 0.5, 2.3 + i * 0.1, -d * 0.24);
    markAnim(steam, 'steam2');
    root.add(steam);
  }
  addConveyor(root, w * 0.16, -d * 0.06, 0, 3.4);
  addCardboardBoxes(root, w * 0.3, d * 0.06, 4, 0.9);
  addCardboardBoxes(root, w * 0.38, d * 0.26, 3, 0.8);
  addDocumentDesk(root, -w * 0.04, d * 0.26, 0, 2.0);
  addCyl(root, lam(0xd94a3f), 0.1, 0.09, 0.18, -w * 0.14, 0.86, d * 0.26, 10);
  addCyl(root, lam(0x5f9a4a), 0.1, 0.09, 0.18, -w * 0.04, 0.86, d * 0.26, 10);
  addBox(root, lam(0xc9ced2), 1.0, 0.9, 0.5, w * 0.4, 0.45, d * 0.36);
  addCyl(root, lam(0x9fd0e0), 0.02, 0.02, 0.3, w * 0.4, 1.1, d * 0.36, 6);
  for (let i = 0; i < 3; i++) addCeilingLamp(root, -w * 0.28 + i * w * 0.28, h - 0.14, -d * 0.12, 2.2);
  addVentDuct(root, 0, h - 0.6, d * 0.3, w * 0.7, 0, true);
  addBoard(ctx, 'hygiene', ['食品廠', '生熟分開 · 保持清潔'], 0, h * 0.52, -d / 2 + 0.26, 0, 1.6, 0.7, { bg: 0x2f7f5a, fg: '#ffffff' });
  addExitSign(root, -w * 0.44, h - 0.42, -d * 0.4);
  const n = peopleCount('worker', building.workers.length);
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.3 + i * 0.85, z: d * 0.14 + (i % 2) * 0.2, ry: Math.PI * (0.55 + i * 0.15), kind: 'chef' });
  }
}

/** 17. 石礦場：石堆、碎石機、泥頭車。 */
function fillQuarry(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d } = dims;
  addRockPile(root, -w * 0.3, -d * 0.16, 8, 1.6);
  addRockPile(root, w * 0.24, -d * 0.3, 6, 1.3);
  addRockPile(root, w * 0.36, d * 0.16, 5, 1.1);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 2; j++) addBox(root, lam(0x9a978d), 0.9, 0.4, 0.6, -w * 0.06 + i * 0.95, 0.2 + j * 0.42, d * 0.18);
  }
  addCrusher(root, -w * 0.04, -d * 0.34, 0.2);
  addConveyor(root, w * 0.14, -d * 0.22, 0.1, 2.6);
  addDumpTruck(root, w * 0.3, d * 0.3, -0.8);
  const n = peopleCount('worker', building.workers.length);
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.2 + i * 0.9, z: d * 0.06, ry: Math.PI * (0.7 + i * 0.1), kind: 'worker' });
  }
  addTree(root, -w * 0.44, -d * 0.36, 0.9, false);
  addBird(root, w * 0.1, 0.5, -d * 0.1);
}

/** 18. 發電廠：控制室、渦輪、蒸汽管道。 */
function fillPowerPlant(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addTurbine(root, -w * 0.25, -d * 0.2, 0.2, 1.2);
  addTurbine(root, w * 0.06, -d * 0.2, 0.2, 1.0);
  addPipeRun(root, -w * 0.44, -d * 0.3, w * 0.44, -d * 0.3, h * 0.55, 0.18, 0x8a9096);
  addPipeRun(root, -w * 0.44, -d * 0.3, -w * 0.44, d * 0.2, h * 0.55, 0.14, 0x9a978d);
  addPipeRun(root, -w * 0.2, -d * 0.1, -w * 0.2, d * 0.4, h * 0.4, 0.12, 0x8a9096);
  addControlPanel(root, 0, d * 0.24, 0, 3.6);
  addControlPanel(root, -w * 0.34, d * 0.24, 0, 2.4);
  addBox(root, glass(0x9fd0e0, 0.2), w * 0.5, h * 0.5, 0.04, 0, h * 0.3, d * 0.06);
  addBoard(ctx, 'highvolt', ['高壓危險', 'HIGH VOLTAGE', '未經許可 不得進入'], w * 0.3, h * 0.5, -d / 2 + 0.26, 0, 1.2, 0.9, { bg: 0xe0b33a, fg: '#1f2937', border: '#b02a2a' });
  addExitSign(root, w * 0.44, h - 0.45, d * 0.3);
  addFireHose(root, w * 0.44, 1.2, -d * 0.2, -Math.PI / 2);
  for (let i = 0; i < 3; i++) addCeilingLamp(root, -w * 0.3 + i * w * 0.3, h - 0.14, -d * 0.02, 2.2);
  addBox(root, lam(IPAL.steelDark), w, 0.2, 0.24, 0, h - 0.35, d * 0.02);
  const n = peopleCount('worker', building.workers.length);
  const kinds: ('worker' | 'office')[] = ['office', 'worker', 'worker', 'office', 'worker'];
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.24 + i * 0.9, z: d * 0.06, ry: Math.PI, kind: kinds[i % kinds.length] });
  }
}

/** 19. 水務設施：濾水池、水管、閥門。 */
function fillWaterworks(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addFilterTank(root, -w * 0.24, -d * 0.22, 2.8, 2.0);
  addFilterTank(root, w * 0.26, -d * 0.22, 2.8, 2.0);
  addPipeRun(root, -w * 0.44, d * 0.02, w * 0.44, d * 0.02, 1.1, 0.2, 0x8a9096);
  addPipeRun(root, -w * 0.44, d * 0.02, -w * 0.44, -d * 0.4, 1.1, 0.14, 0x9a978d);
  addValveWheel(root, -w * 0.2, 1.3, d * 0.02, 0.3);
  addValveWheel(root, w * 0.16, 1.3, d * 0.02, 0.24);
  addValveWheel(root, -w * 0.44, 1.3, -d * 0.2, 0.22);
  addDocumentDesk(root, w * 0.1, d * 0.28, 0, 1.6);
  for (let i = 0; i < 4; i++) addCyl(root, glass(0x9fd0e0, 0.5), 0.05, 0.05, 0.16, w * 0.02 + i * 0.16, 0.88, d * 0.28, 8);
  addBoard(ctx, 'water', ['水務設施', '濾水廠 · 配水庫'], 0, h * 0.52, -d / 2 + 0.26, 0, 1.8, 0.7, { bg: 0x2f6f8f, fg: '#ffffff' });
  addBox(root, basic(0x5f9fb0), w * 0.5, 0.02, d * 0.2, 0, 0.02, d * 0.14);
  const n = peopleCount('worker', building.workers.length);
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.26 + i * 1.0, z: d * 0.16, ry: Math.PI * (0.6 + i * 0.12), kind: 'worker' });
  }
  addPottedPlant(root, w * 0.42, d * 0.36, 1.0, false);
}

/** 20. 進口商行：貨辦架、報關文件、鐵閘、電話。 */
function fillImportFirm(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addSampleShelf(root, -w * 0.28, -d * 0.3, 0, 2.2);
  addSampleShelf(root, w * 0.08, -d * 0.3, 0, 2.0);
  addPalletRack(root, w * 0.36, d * 0.06, -Math.PI / 2, { w: 2.4, h: 2.4, levels: 2 });
  addDocumentDesk(root, -w * 0.1, d * 0.16, 0.1, 2.0);
  addDocumentDesk(root, w * 0.24, -d * 0.02, -0.4, 1.6);
  addTelephone(root, -w * 0.18, 0.8, d * 0.16, 0.2);
  addTelephone(root, w * 0.16, 0.8, -d * 0.02, -0.4);
  addFilingCabinet(root, -w * 0.36, d * 0.02, Math.PI / 2);
  addFilingCabinet(root, -w * 0.36, d * 0.2, Math.PI / 2);
  addCardboardBoxes(root, w * 0.3, d * 0.3, 4, 1.0);
  addHandTruck(root, w * 0.06, d * 0.34, 0.3);
  addBarrelDrum(root, -w * 0.02, d * 0.36, 0x3f6f9f);
  addIronGate(root, w * 0.4, d * 0.42, -0.3, 1.4, 2.2);
  addNeon(ctx, '進口商行', IPAL.neonCyan, 0, h * 0.7, -d / 2 + 0.3, 0, 2.2, 0.55);
  addBoard(ctx, 'customs', ['報關文件', '入口許可證', '提單 · 裝箱單'], w * 0.4, h * 0.5, -d / 2 + 0.26, 0, 1.1, 0.8, { bg: 0xf2f0e6, fg: '#1f3a5f', border: '#1f3a5f' });
  addPoster(ctx, '入口', -w * 0.42, h * 0.55, d * 0.1, Math.PI / 2, 0.5, 0.7);
  const n = peopleCount('worker', building.workers.length);
  const kinds: ('office' | 'worker')[] = ['office', 'worker', 'office', 'worker', 'office'];
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.2 + i * 0.9, z: d * 0.06 + (i % 2) * 0.3, ry: Math.PI * (0.7 + i * 0.1), kind: kinds[i % kinds.length] });
  }
  addPerson(root, { x: -w * 0.1, z: d * 0.1, ry: 0, kind: 'office', pose: 'sit' });
}

/** 21. 貨櫃碼頭：貨櫃堆、龍門吊機、貨櫃船、維港。 */
function fillContainerPort(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addContainerShip(root, -w * 0.04, 0.02, -d * 0.62, 0.06);
  addGantryCrane(root, -w * 0.06, -d * 0.16, 0, 6.2, h * 1.35);
  addGantryCrane(root, w * 0.3, -d * 0.32, 0.2, 4.4, h * 1.0);
  addContainerStack(root, -w * 0.32, -d * 0.06, 0.1, { rows: 2, cols: 3, levels: 3 });
  addContainerStack(root, w * 0.18, -d * 0.02, -0.1, { rows: 2, cols: 3, levels: 2 });
  addContainerStack(root, w * 0.38, d * 0.18, 0.3, { rows: 2, cols: 2, levels: 2 });
  addContainerStack(root, -w * 0.4, d * 0.3, -0.2, { rows: 2, cols: 2, levels: 2 });
  addPallet(root, -w * 0.06, d * 0.24, 0.2);
  addCardboardBoxes(root, -w * 0.06, d * 0.24, 3, 0.9);
  addBox(root, lam(0x8a8f92), w, 0.28, 0.5, 0, 0.14, -d * 0.44);
  addHarbourRail(root, 0, -d * 0.44, w * 0.9);
  const n = peopleCount('worker', building.workers.length);
  const kinds: ('worker' | 'office')[] = ['worker', 'office', 'worker', 'worker', 'office'];
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.34 + i * 1.0, z: d * 0.3 + (i % 2) * 0.2, ry: Math.PI * (0.8 + i * 0.08), kind: kinds[i % kinds.length] });
  }
  addBird(root, w * 0.36, 0.4, -d * 0.2);
}

/** 22. 貨倉：重型貨架、貨物、包裝枱。 */
function fillWarehouse(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addPalletRack(root, -w * 0.3, -d * 0.28, 0, { w: 2.8, h: 2.8, levels: 3 });
  addPalletRack(root, -w * 0.02, -d * 0.28, 0, { w: 2.8, h: 2.8, levels: 3 });
  addPalletRack(root, w * 0.28, -d * 0.28, 0, { w: 2.8, h: 2.8, levels: 3 });
  addPalletRack(root, -w * 0.42, d * 0.1, Math.PI / 2, { w: 2.2, h: 2.2, levels: 2 });
  addPallet(root, w * 0.14, d * 0.18, 0.2);
  addCardboardBoxes(root, w * 0.14, d * 0.18, 4, 1.0);
  addCardboardBoxes(root, w * 0.3, d * 0.32, 3, 0.9);
  addBarrelDrum(root, -w * 0.2, d * 0.32, 0x3f6f9f);
  addBarrelDrum(root, -w * 0.08, d * 0.36, 0xd94a3f);
  addDocumentDesk(root, -w * 0.02, d * 0.26, 0, 2.0);
  addHandTruck(root, w * 0.36, d * 0.06, 0.4);
  for (let i = 0; i < 3; i++) addCeilingLamp(root, -w * 0.3 + i * w * 0.3, h - 0.14, -d * 0.1, 2.2);
  addBoard(ctx, 'warehouse', ['維港貨倉', '入庫 · 出庫 · 盤點'], 0, h * 0.52, -d / 2 + 0.26, 0, 1.8, 0.7, { bg: 0x2f3f4f, fg: '#ffd166' });
  addExitSign(root, w * 0.44, h - 0.42, -d * 0.3);
  const n = peopleCount('worker', building.workers.length);
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.2 + i * 1.0, z: d * 0.06 + (i % 2) * 0.25, ry: Math.PI * (0.6 + i * 0.1), kind: 'worker' });
  }
}

/** 23. 學校：課室、黑板、木枱、學生。 */
function fillSchool(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addBox(root, lam(0x8a6038), 3.3, 1.8, 0.05, 0, h * 0.55, -d / 2 + 0.24);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.7), blackboardMat());
  board.position.set(0, h * 0.55, -d / 2 + 0.29);
  root.add(board);
  addBox(root, lam(0x9a7a52), 3.4, 0.08, 0.2, 0, h * 0.55 - 0.92, -d / 2 + 0.3);
  addTeacherDesk(root, 0, -d * 0.24, 0);
  for (let i = 0; i < 3; i++) {
    addClassroomDesk(root, -w * 0.28 + i * w * 0.28, -d * 0.02, 0, true);
    addClassroomDesk(root, -w * 0.28 + i * w * 0.28, d * 0.22, 0, i !== 1);
  }
  addShelfUnit(root, w * 0.44, d * 0.02, -Math.PI / 2, { w: 1.2, h: 1.9, levels: 3, goods: [0x8a3a2a, 0x3f6f9f, 0x4f7a44, 0xd9c25a] });
  addBoard(ctx, 'school-motto', ['努力學習', '貢獻社會'], -w * 0.4, h * 0.6, -d / 2 + 0.26, 0, 0.8, 0.55, { bg: 0xd8e8f0, fg: '#1f3a5f' });
  addPoster(ctx, '校訓', w * 0.36, h * 0.6, -d / 2 + 0.26, 0, 0.45, 0.64);
  addCeilingFan(root, -w * 0.2, h - 0.3, 0, 0.8);
  addCeilingFan(root, w * 0.2, h - 0.3, 0, 0.8);
  for (let i = 0; i < 2; i++) addCeilingLamp(root, -w * 0.3 + i * w * 0.6, h - 0.14, -d * 0.1, 1.8);
  addPerson(root, { x: w * 0.34, z: d * 0.3, ry: -Math.PI * 0.5, kind: 'student' });
  const n = peopleCount('worker', building.workers.length);
  for (let i = 0; i < Math.min(2, n); i++) {
    addPerson(root, { x: -w * 0.24 + i * 1.0, z: d * 0.06, ry: Math.PI * 0.9, kind: 'teacher' });
  }
  addPottedPlant(root, -w * 0.42, d * 0.36, 1.0, false);
}

/** 24. 醫院：急症室、病床、護士站。 */
function fillHospital(ctx: FillCtx): void {
  const { root, dims } = ctx;
  const { w, d, h } = dims;
  addHospitalBed(root, -w * 0.3, -d * 0.2, 0, true);
  addHospitalBed(root, -w * 0.02, -d * 0.2, 0, false);
  addHospitalBed(root, w * 0.26, -d * 0.2, Math.PI, false);
  addNurseStation(root, 0, d * 0.14, Math.PI, 3.2);
  addBox(root, lam(0xdfeef2), 1.6, 2.0, 0.5, w * 0.36, 1.0, -d * 0.34);
  addBox(root, glass(0xbfe0ea, 0.24), 1.5, 1.0, 0.03, w * 0.36, 1.45, -d * 0.32);
  for (let i = 0; i < 5; i++) {
    addCyl(root, lam([0xd94a3f, 0x3f7fb0, 0xf2f0e6][i % 3]), 0.05, 0.05, 0.16, w * 0.3 + i * 0.14, 1.5, -d * 0.31, 7);
  }
  addBox(root, lam(0x8a8f96), 0.5, 0.06, 0.5, -w * 0.1, 0.5, d * 0.32);
  for (const [sx, sz] of [
    [-0.2, -0.2],
    [0.2, -0.2],
    [-0.2, 0.2],
    [0.2, 0.2],
  ]) {
    addCyl(root, lam(0x2a2f36), 0.05, 0.05, 0.04, -w * 0.1 + sx, 0.06, d * 0.32 + sz, 8, 0, Math.PI / 2);
  }
  addCyl(root, lam(0x8a9096), 0.02, 0.02, 2.0, -w * 0.18, 1.0, d * 0.3, 6);
  addBox(root, glass(0xd8f0f8, 0.6), 0.14, 0.28, 0.1, -w * 0.18, 1.8, d * 0.3);
  addNeon(ctx, '急症室', IPAL.neonPink, 0, h * 0.68, -d / 2 + 0.3, 0, 1.8, 0.5);
  addBoard(ctx, 'hospital', ['24 小時急症', '請保持安靜'], w * 0.28, h * 0.5, -d / 2 + 0.26, 0, 1.2, 0.6, { bg: 0x2f6f8f, fg: '#ffffff' });
  addExitSign(root, -w * 0.44, h - 0.42, d * 0.2);
  addFireHose(root, w * 0.44, 1.2, d * 0.1, -Math.PI / 2);
  addPerson(root, { x: -w * 0.06, z: d * 0.04, ry: Math.PI, kind: 'doctor' });
  addPerson(root, { x: w * 0.1, z: d * 0.0, ry: Math.PI, kind: 'nurse' });
  addPerson(root, { x: w * 0.24, z: d * 0.06, ry: Math.PI * 0.8, kind: 'nurse' });
  addPerson(root, { x: -w * 0.28, z: d * 0.3, ry: Math.PI * 0.3, kind: 'shopper' });
  addPottedPlant(root, w * 0.44, d * 0.38, 1.1, false);
}

/** 25. 警署：報案室、拘留室。 */
function fillPoliceStation(ctx: FillCtx): void {
  const { root, dims } = ctx;
  const { w, d, h } = dims;
  addPoliceCounter(root, -w * 0.1, d * 0.2, Math.PI, 3.2);
  addNeon(ctx, '報案室', IPAL.neonCyan, -w * 0.1, h * 0.68, -d / 2 + 0.3, 0, 1.8, 0.5);
  addDetentionCell(root, w * 0.34, -d * 0.18, 0.2, 2.2, 2.4);
  addDocumentDesk(root, -w * 0.28, -d * 0.1, 0.2, 1.8);
  addOfficeDesk(root, -w * 0.34, -d * 0.3, 0.2);
  addNoticeBoard(root, w * 0.02, h * 0.55, -d / 2 + 0.26, 0, 1.8, 1.0);
  addBoard(ctx, 'police-motto', ['香港警察', '服務為本 · 精益求精'], 0, h * 0.82, -d / 2 + 0.26, 0, 1.8, 0.6, { bg: 0x24354f, fg: '#ffffff' });
  addBoard(ctx, 'police-notice', ['報案須知', '請出示身份證', '保持冷靜'], -w * 0.42, h * 0.5, d * 0.2, Math.PI / 2, 0.9, 0.7, { bg: 0xf2f0e6, fg: '#1f3a5f', border: '#24354f' });
  addPerson(root, { x: -w * 0.1, z: d * 0.04, ry: 0, kind: 'police' });
  addPerson(root, { x: -w * 0.28, z: d * 0.06, ry: Math.PI * 0.9, kind: 'police' });
  addPerson(root, { x: w * 0.16, z: d * 0.3, ry: Math.PI * 0.4, kind: 'shopper' });
  addPerson(root, { x: w * 0.3, z: -d * 0.02, ry: -Math.PI * 0.3, kind: 'police' });
  addPottedPlant(root, -w * 0.42, d * 0.38, 1.0, false);
}

/** 26. 消防局：消防車、鋼梯、滑柱。 */
function fillFireStation(ctx: FillCtx): void {
  const { root, dims } = ctx;
  const { w, d, h } = dims;
  addFireTruck(root, -w * 0.12, -d * 0.16, 0);
  addSteelLadder(root, w * 0.42, -d * 0.2, Math.PI, h * 0.95);
  addFirePole(root, w * 0.32, -d * 0.3, h * 0.95);
  addFirePole(root, w * 0.38, -d * 0.3, h * 0.95);
  addFireHose(root, -w * 0.44, 1.3, d * 0.2, Math.PI / 2);
  addFireHose(root, -w * 0.44, 1.3, d * 0.02, Math.PI / 2);
  addBox(root, lam(0xd9b23f), 1.4, 0.9, 0.4, w * 0.34, 0.45, d * 0.2);
  for (let i = 0; i < 4; i++) {
    addSphere(root, lam(0xd94a3f), 0.14, w * 0.26 + i * 0.22, 1.0, d * 0.2, 8, 6);
    addBox(root, lam(0xd94a3f), 0.3, 0.04, 0.26, w * 0.26 + i * 0.22, 0.92, d * 0.2);
  }
  addBoard(ctx, 'fire-motto', ['消防局', '救火救人 · 分秒必爭'], w * 0.1, h * 0.55, -d / 2 + 0.26, 0, 1.8, 0.7, { bg: 0xb02a2a, fg: '#ffffff' });
  addBoard(ctx, 'fire-duty', ['今日值勤', 'A 隊 · 8 小時'], -w * 0.3, h * 0.5, -d / 2 + 0.26, 0, 0.9, 0.6, { bg: 0xf2f0e6, fg: '#1f2937' });
  addExitSign(root, w * 0.44, h - 0.42, d * 0.4);
  for (let i = 0; i < 3; i++) {
    addPerson(root, { x: -w * 0.28 + i * 0.8, z: d * 0.16, ry: Math.PI * (0.8 + i * 0.1), kind: 'fire' });
  }
  addPerson(root, { x: w * 0.16, z: d * 0.3, ry: -Math.PI * 0.4, kind: 'office' });
}

/** 27. 港鐵站：月台、列車、閘機、月台牌、路線圖。 */
function fillMtrStation(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addPlatformEdge(root, 0, -d * 0.34, w * 1.1);
  addMTRTrain(root, 0, 0.04, -d * 0.42, 0, w * 0.95);
  for (let i = 0; i < 3; i++) addMTRPillar(root, -w * 0.32 + i * w * 0.32, d * 0.16, h * 0.96, IPAL.mtrRed);
  for (let i = 0; i < 4; i++) addMTRGate(root, -w * 0.3 + i * 0.55, d * 0.36, 0);
  addTicketMachine(root, w * 0.36, d * 0.34, Math.PI);
  addTicketMachine(root, w * 0.42, d * 0.34, Math.PI);
  addPlatformSign(root, 0, h * 0.72, -d * 0.06, 0, '中環', '1', IPAL.mtrRed);
  addPlatformSign(root, -w * 0.3, h * 0.72, -d * 0.06, 0, '荃灣', '2', IPAL.mtrRed);
  addRouteMap(root, -w * 0.42, h * 0.5, d * 0.0, Math.PI / 2, 1.8);
  addBoard(ctx, 'mtr-station', ['維港站', 'Victoria Harbour Station'], 0, h * 0.86, -d / 2 + 0.28, 0, 2.4, 0.5, { bg: 0xb02a2a, fg: '#ffffff' });
  addBoard(ctx, 'mtr-notice', ['請小心月台空隙', 'Please mind the gap'], w * 0.42, h * 0.5, -d * 0.4, 0, 1.2, 0.5, { bg: 0xf2f0e6, fg: '#b02a2a', border: '#b02a2a' });
  addBench(root, -w * 0.16, d * 0.02, Math.PI);
  addTrashBin(root, w * 0.14, d * 0.02);
  addExitSign(root, -w * 0.44, h - 0.4, d * 0.3);
  addExitSign(root, w * 0.44, h - 0.4, d * 0.3);
  for (let i = 0; i < 3; i++) addCeilingLamp(root, -w * 0.3 + i * w * 0.3, h - 0.14, -d * 0.1, 2.4);
  const n = Math.max(2, peopleCount('worker', building.workers.length));
  const kinds: ('office' | 'student' | 'shopper' | 'elder' | 'tourist')[] = ['office', 'student', 'shopper', 'elder', 'tourist'];
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.32 + i * 0.9, z: d * 0.14 + (i % 2) * 0.14, ry: Math.PI * (0.4 + i * 0.15), kind: kinds[i % kinds.length] });
  }
  addPerson(root, { x: w * 0.3, z: d * 0.2, ry: Math.PI * 0.8, kind: 'nurse' });
}

/** 28. 巴士總站：站頭、雙層巴士、候車亭。 */
function fillBusTerminus(ctx: FillCtx): void {
  const { root, dims } = ctx;
  const { w, d } = dims;
  addDoubleDeckerBus(root, -w * 0.18, -d * 0.16, 0.02, 0xd9b23f);
  addDoubleDeckerBus(root, w * 0.28, d * 0.16, Math.PI * 0.96, 0xd93f3f);
  addBusShelter(root, -w * 0.36, d * 0.26, 0.1);
  addBusStopFlag(root, -w * 0.06, d * 0.34, 0.2, '968', '銅鑼灣');
  addBusStopFlag(root, w * 0.16, d * 0.34, 0.2, '960', '中環');
  addHarbourRail(root, -w * 0.14, d * 0.02, 1.6);
  addHarbourRail(root, w * 0.12, d * 0.2, 1.6, Math.PI / 2);
  addBox(root, lam(0xe4e0d4), w * 0.8, 0.02, 0.12, 0, 0.02, d * 0.02);
  for (let i = 0; i < 6; i++) addBox(root, lam(0xe4e0d4), 0.5, 0.02, 0.1, -w * 0.35 + i * 0.8, 0.02, -d * 0.24);
  addBox(root, lam(0xdfe3e6), w * 0.18, 2.0, 1.2, w * 0.4, 1.0, -d * 0.34);
  addBox(root, glass(0xbfe0ea, 0.24), w * 0.12, 0.6, 0.03, w * 0.4, 1.4, -d * 0.34 + 0.61);
  addBoard(ctx, 'bus-terminus', ['維港巴士總站', 'VICTORIA HARBOUR BUS TERMINUS'], 0, 2.6, -d * 0.44, 0, 2.6, 0.6, { bg: 0xd9b23f, fg: '#1f2937' });
  for (let i = 0; i < 3; i++) {
    addPerson(root, { x: -w * 0.3 + i * 0.5, z: d * 0.28, ry: Math.PI * 1.1, kind: i === 2 ? 'elder' : 'office' });
  }
  addPerson(root, { x: w * 0.3, z: d * 0.02, ry: 0, kind: 'worker' });
  addPerson(root, { x: w * 0.06, z: -d * 0.04, ry: Math.PI * 0.5, kind: 'student' });
  addBird(root, w * 0.4, 0.3, -d * 0.1);
  addTree(root, -w * 0.44, -d * 0.34, 0.9, false);
}

/** 29. 電車站：叮叮、路軌、街景、站牌。 */
function fillTramStop(ctx: FillCtx): void {
  const { root, dims } = ctx;
  const { w, d, h } = dims;
  addTramTrack(root, 0, -d * 0.12, w * 1.2);
  addTramCar(root, -w * 0.1, -d * 0.12, 0, 0x2f8f5f);
  addBox(root, lam(0xc9cdd0), w * 0.55, 0.16, 2.0, -w * 0.16, 0.08, d * 0.2);
  addBox(root, lam(0xe0b33a), w * 0.55, 0.02, 0.12, -w * 0.16, 0.17, d * 0.2);
  addBox(root, lam(0x8a9096), 0.08, 2.6, 0.08, -w * 0.3, 1.3, d * 0.3);
  addBox(root, lam(0x8a9096), 0.08, 2.6, 0.08, -w * 0.1, 1.3, d * 0.3);
  addBox(root, lam(0x2f8f5f), 0.9, 0.66, 0.06, -w * 0.2, 2.4, d * 0.3);
  const stopSign = new THREE.Mesh(
    new THREE.PlaneGeometry(0.82, 0.3),
    signBoardMat('tram-stop', ['電車站', 'TRAM STOP'], { bg: 0x2f8f5f, fg: '#ffffff', w: 256, h: 96 }),
  );
  stopSign.position.set(-w * 0.2, 2.5, d * 0.34);
  root.add(stopSign);
  addNeon(ctx, '酒樓', IPAL.neonPink, -w * 0.38, h * 1.05, -d * 1.0, 0, 1.0, 2.2, true);
  addNeon(ctx, '藥房', IPAL.neonCyan, w * 0.36, h * 1.0, -d * 1.05, 0, 1.0, 2.0, true);
  addNeon(ctx, '涼茶', IPAL.neonGold, w * 0.2, h * 0.95, -d * 1.02, 0, 0.9, 1.8, true);
  addPerson(root, { x: -w * 0.24, z: d * 0.24, ry: Math.PI * 0.4, kind: 'elder' });
  addPerson(root, { x: -w * 0.1, z: d * 0.24, ry: Math.PI * 0.2, kind: 'shopper' });
  addPerson(root, { x: w * 0.1, z: d * 0.3, ry: -Math.PI * 0.3, kind: 'office' });
  addLampPost(root, w * 0.4, d * 0.1, 3.4);
  addTrashBin(root, -w * 0.36, d * 0.3);
  addTree(root, w * 0.42, -d * 0.3, 0.8, false);
}

/** 30. 渡輪碼頭：天星小輪、閘口、維港、長椅。 */
function fillFerryPier(ctx: FillCtx): void {
  const { root, dims } = ctx;
  const { w, d, h } = dims;
  addStarFerry(root, w * 0.02, 0.05, -d * 0.48, 0.04);
  addFerryGate(root, -w * 0.3, d * 0.02, 0.2);
  addFerryGate(root, -w * 0.18, d * 0.02, 0.2);
  addBench(root, w * 0.1, d * 0.16, Math.PI);
  addBench(root, w * 0.26, d * 0.16, Math.PI);
  addBench(root, -w * 0.02, d * 0.32, Math.PI);
  addHarbourRail(root, w * 0.62, d * 0.3, 1.2);
  addBox(root, lam(0x2f7f6a), 1.8, 1.9, 1.0, -w * 0.38, 0.95, -d * 0.2);
  addBox(root, glass(0xbfe0ea, 0.24), 1.1, 0.6, 0.03, -w * 0.38, 1.35, -d * 0.2 + 0.52);
  const boothSign = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.36), starFerryMat());
  boothSign.position.set(-w * 0.38, 2.0, -d * 0.2 + 0.52);
  root.add(boothSign);
  addBoard(ctx, 'star-ferry', ['天星小輪', 'STAR FERRY', '往尖沙咀 · 中環'], w * 0.02, h * 0.78, -d * 0.66, 0, 3.2, 0.8, { bg: 0x2f7f6a, fg: '#ffffff' });
  addCyl(root, lam(0xf2f0e6), 0.26, 0.26, 0.05, 0, h * 0.72, d * 0.1, 16, Math.PI / 2, 0);
  addBox(root, lam(0x2f7f6a), 0.5, 0.1, 0.02, 0, h * 0.72, d * 0.13);
  for (let i = 0; i < 3; i++) {
    addPerson(root, { x: -w * 0.24 + i * 0.9, z: d * 0.24, ry: Math.PI * (0.9 + i * 0.1), kind: i % 2 ? 'tourist' : 'office' });
  }
  addPerson(root, { x: w * 0.2, z: d * 0.02, ry: Math.PI * 0.4, kind: 'shopper' });
  addBird(root, -w * 0.36, 0.3, d * 0.36);
  addPottedPlant(root, w * 0.36, -d * 0.02, 1.1, false);
}

/** 31. 公園：長椅、榕樹、雀鳥、涼亭、長者。 */
function fillPark(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d } = dims;
  addTree(root, -w * 0.3, -d * 0.18, 1.3, true);
  addTree(root, w * 0.28, -d * 0.26, 1.1, true);
  addTree(root, w * 0.38, d * 0.24, 0.9, false);
  addPavilion(root, -w * 0.02, -d * 0.3, 0.85);
  addBox(root, lam(0xb9b3a4), w * 0.9, 0.02, 1.0, 0, 0.02, d * 0.05);
  addBox(root, lam(0xb9b3a4), 1.0, 0.02, d * 0.7, -w * 0.1, 0.02, -d * 0.12);
  addBench(root, -w * 0.24, d * 0.2, Math.PI);
  addBench(root, w * 0.2, d * 0.2, Math.PI);
  addBench(root, w * 0.3, -d * 0.04, -Math.PI / 2);
  addFlowerBed(root, 0, -d * 0.06, 0, 2.6);
  addFlowerBed(root, -w * 0.36, d * 0.3, Math.PI / 2, 2.0);
  addTrashBin(root, w * 0.06, d * 0.2);
  addTrashBin(root, -w * 0.3, d * 0.02);
  addLampPost(root, -w * 0.14, d * 0.28, 3.2);
  addLampPost(root, w * 0.32, d * 0.12, 3.2);
  addBird(root, -w * 0.18, 0.24, d * 0.12);
  addBird(root, w * 0.12, 0.2, d * 0.16, 0x6f6560);
  addBird(root, w * 0.04, 0.3, d * 0.3, 0x9a8a6a);
  const n = peopleCount('worker', building.workers.length) + 2;
  const kinds: ('elder' | 'shopper' | 'kid' | 'tourist')[] = ['elder', 'shopper', 'kid', 'tourist'];
  for (let i = 0; i < Math.min(4, n); i++) {
    addPerson(root, {
      x: -w * 0.28 + i * 1.1,
      z: d * 0.34 - (i % 2) * 0.1,
      ry: Math.PI * (0.7 + i * 0.1),
      kind: kinds[i % kinds.length],
    });
  }
}

/** 32. 海濱長廊：欄杆、維港夜景、跑步者、長椅。 */
function fillPromenade(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d } = dims;
  addBoardwalk(root, 0, 0.02, w * 1.2, d * 0.8);
  addHarbourRail(root, 0, -d * 0.32, w * 1.1);
  addHarbourRail(root, -w * 0.4, d * 0.05, d * 0.7, Math.PI / 2);
  addJunkBoat(root, -w * 0.06, 0.02, -d * 0.66, 1.1);
  addBird(root, -w * 0.3, 0.5, -d * 0.4);
  addBird(root, w * 0.24, 0.6, -d * 0.36, 0x6f6560);
  addBench(root, -w * 0.24, d * 0.02, Math.PI);
  addBench(root, w * 0.12, d * 0.02, Math.PI);
  addBench(root, w * 0.3, d * 0.26, Math.PI * 0.8);
  addLampPost(root, -w * 0.36, d * 0.14, 3.4);
  addLampPost(root, w * 0.34, d * 0.14, 3.4);
  addTrashBin(root, w * 0.02, d * 0.14);
  addNeon(ctx, '維多利亞港', IPAL.neonCyan, 0, 2.7, -d * 0.42, 0, 2.6, 0.7);
  addBoard(ctx, 'promenade', ['海濱長廊', 'PROMENADE'], w * 0.34, 2.0, -d * 0.3, 0, 1.6, 0.5, { bg: 0x2f5f6f, fg: '#ffffff' });
  const n = Math.max(2, peopleCount('worker', building.workers.length) + 1);
  const kinds: ('office' | 'shopper' | 'tourist' | 'elder' | 'student')[] = ['office', 'shopper', 'tourist', 'elder', 'student'];
  for (let i = 0; i < Math.min(4, n); i++) {
    addPerson(root, { x: -w * 0.3 + i * 0.9, z: d * 0.18, ry: -Math.PI * (0.3 + i * 0.12), kind: kinds[i % kinds.length] });
  }
  addPerson(root, { x: w * 0.18, z: d * 0.3, ry: Math.PI, kind: 'tourist' });
}

/** 33. 通用住宅 fallback。 */
function fillGenericHome(ctx: FillCtx): void {
  const { root, dims } = ctx;
  const { w, d, h } = dims;
  addSofa(root, -w * 0.2, d * 0.04, Math.PI, 0x8a7f6a, 2.2);
  addCoffeeTable(root, -w * 0.1, d * 0.14, 0);
  addTVUnit(root, 0, -d * 0.34, 0, false);
  addDiningSet(root, w * 0.28, d * 0.14, 0.2, 3);
  addKitchenCounter(root, -w * 0.44, d * 0.2, Math.PI / 2, 1.8);
  addFridge(root, -w * 0.44, d * 0.02, Math.PI / 2, 0.8);
  addCeilingFan(root, 0, h - 0.3, 0, 0.75);
  addPerson(root, { x: w * 0.1, z: d * 0.3, ry: Math.PI * 0.8, kind: 'office' });
}

/** 34. 通用工商 fallback。 */
function fillGenericWork(ctx: FillCtx): void {
  const { root, dims } = ctx;
  const { w, d, h } = dims;
  addShelfUnit(root, -w * 0.2, -d * 0.2, 0, { w: 2.2, h: 1.9, levels: 4 });
  addShelfUnit(root, w * 0.2, -d * 0.2, 0, { w: 2.2, h: 1.9, levels: 4 });
  addDocumentDesk(root, 0, d * 0.2, 0, 2.0);
  addCardboardBoxes(root, w * 0.3, d * 0.1, 3, 1.0);
  addMachine(root, -w * 0.3, d * 0.1, 0.2, 0.9);
  addCeilingLamp(root, 0, h - 0.14, -d * 0.1, 2.2);
  addPerson(root, { x: -w * 0.1, z: d * 0.3, ry: Math.PI, kind: 'worker' });
}

// ═══════════════════════ Round 5 新增零件（水務／污水／機場／碼頭／小巴） ═══════════════════════

/** 行李篋（機場／客運站用）。 */
function addLuggage(parent: THREE.Object3D, x: number, y: number, z: number, color = 0x3a5f8f, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.scale.setScalar(scale);
  addBox(g, lam(color), 0.42, 0.5, 0.26, 0, 0.27, 0);
  addBox(g, lam(shade(color, 0.82)), 0.42, 0.04, 0.26, 0, 0.16, 0);
  addBox(g, lam(0x8a9096), 0.16, 0.03, 0.04, 0, 0.53, 0);
  addCyl(g, lam(0x2a2f36), 0.035, 0.035, 0.03, -0.14, 0.04, 0.1, 6, 0, Math.PI / 2);
  addCyl(g, lam(0x2a2f36), 0.035, 0.035, 0.03, 0.14, 0.04, 0.1, 6, 0, Math.PI / 2);
  parent.add(g);
  return g;
}

/** 航班資料顯示牌（離境大堂）。 */
function addFlightBoard(ctx: FillCtx, x: number, y: number, z: number, ry = 0, w = 3.2, h = 1.9): THREE.Mesh {
  return addBoard(
    ctx,
    'flight-board',
    [
      '航班資料 DEPARTURES',
      'CX 502  台北 TAIPEI      10:30  24',
      'HX 618  曼谷 BANGKOK     11:15  12',
      'UO 860  東京 TOKYO       12:05  31',
      'AK 139  新加坡 SINGAPORE 13:40   5',
      'MU 738  上海 SHANGHAI    14:25  18',
      'CI 906  台北 TAIPEI      15:10  24',
      'KA 201  北京 BEIJING     16:00   9',
    ],
    x,
    y,
    z,
    ry,
    w,
    h,
    { bg: 0x0b1622, fg: '#7fe0b0', border: '#2f6f8f', texW: 512, texH: 320 },
  );
}

/** 登機閘口牌。 */
function addGateSign(ctx: FillCtx, gate: string, dest: string, x: number, y: number, z: number, ry = 0): THREE.Mesh {
  return addBoard(ctx, `gate-${gate}`, [`閘口 GATE ${gate}`, `往 ${dest}`], x, y, z, ry, 1.5, 0.72, {
    bg: 0x0f2a1f,
    fg: '#5cff9d',
    border: '#5cff9d',
  });
}

/** 懸掛飛機模型（客運大樓裝飾）。 */
function addPlaneModel(parent: THREE.Object3D, x: number, y: number, z: number, scale = 1, color = 0xf2f0e8): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.scale.setScalar(scale);
  g.rotation.y = -0.35;
  const body = lam(color);
  const accent = lam(0x2f5f8f);
  addCyl(g, body, 0.2, 0.2, 2.6, 0, 0, 0, 12, 0, Math.PI / 2);
  const nose = addCone(g, body, 0.2, 0.5, 1.55, 0, 0, 12);
  nose.rotation.z = -Math.PI / 2;
  addBox(g, body, 0.9, 0.06, 2.5, 0.1, 0.02, 0);
  addBox(g, accent, 0.92, 0.05, 0.34, 0.1, 0.035, 0);
  addBox(g, body, 0.55, 0.5, 0.06, -0.95, 0.22, 0);
  addBox(g, body, 0.5, 0.04, 1.0, -1.1, 0.02, 0);
  for (const side of [-1, 1]) addCyl(g, lam(0x8a9096), 0.09, 0.09, 0.5, 0.05, -0.14, side * 0.75, 8, 0, Math.PI / 2);
  addBox(g, basic(0x9fd8ff), 1.6, 0.04, 0.03, 0.25, 0.04, 0.2);
  markAnim(g, 'bob');
  parent.add(g);
  return g;
}

/** 航空公司登記櫃位（櫃檯＋行李輸送帶＋螢幕）。 */
function addCheckInCounter(parent: THREE.Object3D, x: number, z: number, ry = 0, airlineColor = 0x1f4f7a): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0xf2f2ee), 2.6, 0.95, 0.62, 0, 0.48, 0);
  addBox(g, lam(0xd8dde0), 2.66, 0.06, 0.68, 0, 0.97, 0);
  addBox(g, lam(airlineColor), 2.6, 0.4, 0.03, 0, 0.62, 0.32);
  addBox(g, lam(0xe8e4dc), 2.2, 0.24, 0.5, 0, 0.06, 0.1);
  addBox(g, lam(0x3a4048), 2.8, 0.42, 0.5, 0, 0.32, -0.85);
  addBox(g, lam(0x2a2f36), 2.8, 0.06, 0.5, 0, 0.55, -0.85);
  addLuggage(g, -0.7, 0.58, -0.85, 0x3a5f8f, 0.8);
  addLuggage(g, 0.1, 0.58, -0.85, 0xb4453a, 0.75);
  addBox(g, lam(0x22262a), 0.42, 0.3, 0.04, -0.8, 1.2, -0.2);
  addBox(g, basic(0x8fd8ff), 0.38, 0.24, 0.01, -0.8, 1.2, -0.17);
  addBox(g, lam(0x2a2e33), 0.34, 0.02, 0.14, -0.8, 0.99, 0.02);
  addBox(g, lam(airlineColor), 0.9, 0.28, 0.05, 0.6, 1.35, 0.04);
  for (const side of [-1, 1]) addCyl(g, lam(0x9aa0a6), 0.02, 0.02, 0.9, side * 1.15, 0.45, 0.7, 6);
  addBox(g, lam(0x9aa0a6), 2.3, 0.03, 0.03, 0, 0.9, 0.7);
  parent.add(g);
  return g;
}

/** 機場候機排椅。 */
function addAirportSeats(parent: THREE.Object3D, x: number, z: number, ry = 0, seats = 4): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const metal = lam(0x8a9096);
  const seatMat = lam(0x2f5f8f);
  const span = seats * 0.6;
  addBox(g, metal, span, 0.07, 0.5, 0, 0.42, 0);
  for (let i = 0; i < seats; i++) {
    const sx = -((seats - 1) * 0.6) / 2 + i * 0.6;
    addBox(g, metal, 0.08, 0.42, 0.5, sx - 0.26, 0.21, 0);
    addBox(g, seatMat, 0.46, 0.09, 0.48, sx, 0.47, 0);
    addBox(g, seatMat, 0.46, 0.5, 0.07, sx, 0.72, -0.22);
  }
  addBox(g, metal, 0.1, 0.42, 0.5, span / 2, 0.21, 0);
  parent.add(g);
  return g;
}

/** 香港公共小巴（綠 van／紅 van）。 */
function addMinibus(parent: THREE.Object3D, x: number, z: number, ry = 0, color = 0x3f9a6a): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const body = lam(color);
  const glassM = basic(0xbfe8f0);
  addBox(g, body, 3.4, 1.3, 1.5, 0, 0.98, 0);
  addBox(g, lam(shade(color, 0.82)), 3.4, 0.26, 1.52, 0, 0.36, 0);
  addBox(g, lam(0xe0b33a), 2.9, 0.06, 1.54, 0, 1.5, 0);
  for (let i = 0; i < 4; i++) addBox(g, glassM, 0.5, 0.42, 0.02, -1.2 + i * 0.72, 1.28, 0.76);
  addBox(g, glassM, 0.04, 0.52, 1.1, 1.71, 1.28, 0);
  addBox(g, lam(0x2a3f4f), 0.06, 0.62, 0.5, 0.98, 0.72, 0.76);
  addBox(g, lam(0x1a1d20), 0.8, 0.22, 0.04, 1.5, 1.55, 0.62);
  addBox(g, lam(0x3f9a6a), 0.9, 0.16, 0.24, 1.2, 1.72, 0);
  for (const sx of [-1.05, 1.05]) {
    for (const sz of [-0.72, 0.72]) {
      addCyl(g, lam(0x1a1d20), 0.34, 0.34, 0.16, sx, 0.34, sz, 12, 0, Math.PI / 2);
      addCyl(g, lam(0x8a9096), 0.16, 0.16, 0.18, sx, 0.34, sz, 8, 0, Math.PI / 2);
    }
  }
  addBox(g, lam(0xf2f0e6), 0.3, 0.12, 0.02, 1.72, 0.62, 0.3);
  parent.add(g);
  return g;
}

/** 貨櫃車（拖頭＋40 呎貨櫃）。 */
function addContainerTruck(parent: THREE.Object3D, x: number, z: number, ry = 0, containerColor: number = IPAL.containerRed): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(containerColor), 3.2, 1.05, 1.28, -0.7, 1.3, 0);
  for (let i = 0; i < 5; i++) addBox(g, lam(shade(containerColor, 0.8)), 0.02, 0.9, 1.3, -1.9 + i * 0.62, 1.3, 0);
  addBox(g, lam(0x3a4048), 4.2, 0.18, 1.0, 0, 0.62, 0);
  addBox(g, lam(0xf2f0e8), 1.15, 1.15, 1.3, 1.85, 1.0, 0);
  addBox(g, lam(0x2f5f8f), 1.15, 0.28, 1.32, 1.85, 0.5, 0);
  addBox(g, basic(0x9fd8e8), 0.9, 0.5, 0.04, 1.9, 1.35, 0.66);
  addBox(g, basic(0xfff2cc), 0.14, 0.12, 0.05, 2.36, 0.72, 0.5);
  addBox(g, basic(0xfff2cc), 0.14, 0.12, 0.05, 2.36, 0.72, -0.5);
  for (const sx of [-1.7, -0.7, 1.7]) {
    for (const sz of [-0.6, 0.6]) addCyl(g, lam(0x1a1d20), 0.42, 0.42, 0.2, sx, 0.42, sz, 12, 0, Math.PI / 2);
  }
  parent.add(g);
  return g;
}

/** 地磅（貨櫃車稱重）。 */
function addWeighbridge(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x5f656b), 3.4, 0.12, 1.9, 0, 0.1, 0);
  addBox(g, lam(0x757b82), 3.0, 0.03, 1.62, 0, 0.17, 0);
  for (const side of [-1, 1]) addBox(g, lam(0xd9b23f), 3.4, 0.05, 0.08, 0, 0.04, side * 0.96);
  addBox(g, lam(0x2a2f36), 0.18, 1.2, 0.18, -1.9, 0.6, 0.0);
  addBox(g, basic(0xffd166), 0.44, 0.22, 0.03, -1.9, 1.28, 0.09);
  parent.add(g);
  return g;
}

/** 欄杆閘（碼頭閘口／車閘，臂會升降）。 */
function addBarrierGate(parent: THREE.Object3D, x: number, z: number, ry = 0, color = 0xe0b33a): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x8a9096), 0.36, 1.2, 0.36, 0, 0.6, 0);
  addBox(g, lam(0x2a2f36), 0.42, 0.2, 0.42, 0, 1.25, 0);
  addBox(g, lam(0xd9b23f), 0.5, 0.3, 0.06, 0, 1.05, 0.24);
  const arm = new THREE.Group();
  arm.position.set(0.1, 1.16, 0);
  addBox(arm, lam(color), 2.6, 0.1, 0.12, 1.3, 0, 0);
  for (let i = 0; i < 4; i++) addBox(arm, lam(0xb02a2a), 0.22, 0.11, 0.13, 0.5 + i * 0.6, 0, 0);
  markAnim(arm, 'barrier');
  g.add(arm);
  parent.add(g);
  return g;
}

/** 抽水／加壓泵組。 */
function addPumpUnit(parent: THREE.Object3D, x: number, z: number, ry = 0, scale = 1, color = 0x3f6f9f): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  g.scale.setScalar(scale);
  addBox(g, lam(0x6f757b), 1.1, 0.18, 1.0, 0, 0.09, 0);
  addCyl(g, lam(color), 0.34, 0.34, 0.9, 0, 0.62, 0, 14, 0, Math.PI / 2);
  addCyl(g, lam(0x9aa0a6), 0.2, 0.2, 0.26, 0.56, 0.62, 0, 12, 0, Math.PI / 2);
  addBox(g, lam(0x3a4048), 0.45, 0.5, 0.45, -0.5, 0.5, 0);
  addCyl(g, lam(0x8a9096), 0.09, 0.09, 0.75, 0.2, 1.12, 0, 8);
  addCyl(g, lam(0xd94a3f), 0.15, 0.15, 0.06, 0.2, 0.78, 0.42, 10, 0, Math.PI / 2);
  addBox(g, lam(0x2a2f36), 0.2, 0.14, 0.16, 0.2, 0.72, -0.4);
  markAnim(g, 'bob');
  parent.add(g);
  return g;
}

/** 逆滲透（RO）膜架（海水化淡廠）。 */
function addROMembraneRack(parent: THREE.Object3D, x: number, z: number, ry = 0, len = 2.6): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const steel = lam(0x8a9096);
  for (const sx of [-len / 2, len / 2]) {
    for (const sz of [-0.4, 0.4]) addBox(g, steel, 0.08, 1.8, 0.08, sx, 0.9, sz);
  }
  addBox(g, lam(0x6f757b), len + 0.1, 0.1, 0.96, 0, 0.05, 0);
  for (let lv = 0; lv < 3; lv++) {
    addBox(g, lam(0xc9ced2), len, 0.08, 0.9, 0, 0.55 + lv * 0.55, 0);
    for (let i = 0; i < 5; i++) {
      addCyl(g, lam(0xe4e8ea), 0.085, 0.085, len * 0.9, 0, 0.66 + lv * 0.55, -0.32 + i * 0.16, 10, 0, Math.PI / 2);
    }
  }
  addBox(g, lam(0x2f7f9f), len * 0.5, 0.16, 0.04, 0, 1.88, 0.24);
  parent.add(g);
  return g;
}

/** 圓形沉澱池（污水處理廠，刮泥臂會旋轉）。 */
function addSettlingTank(parent: THREE.Object3D, x: number, z: number, r = 1.3): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addCyl(g, lam(0x9a978d), r, r * 1.03, 0.8, 0, 0.4, 0, 24);
  addCyl(g, basic(0x4f7f6a), r * 0.88, r * 0.88, 0.04, 0, 0.79, 0, 24);
  addCyl(g, lam(0x8a8f92), r * 1.05, r * 1.05, 0.09, 0, 0.85, 0, 24);
  addCyl(g, lam(0x8a8f92), r * 1.0, r * 1.0, 0.09, 0, 1.0, 0, 24);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    addCyl(g, lam(0x8a8f92), 0.025, 0.025, 0.4, Math.cos(a) * r * 1.02, 0.9, Math.sin(a) * r * 1.02, 4);
  }
  const arm = new THREE.Group();
  arm.position.set(0, 0.9, 0);
  addBox(arm, lam(0xd9b23f), r * 1.9, 0.07, 0.12, 0, 0, 0);
  for (const side of [-1, 1]) addBox(arm, lam(0x5f656b), 0.08, 0.55, 0.08, side * r * 0.85, -0.28, 0);
  addBox(arm, lam(0x8a9096), 0.3, 0.2, 0.3, 0, 0.12, 0);
  markAnim(arm, 'slow-spin');
  g.add(arm);
  addCyl(g, lam(0x8a9096), 0.1, 0.1, 0.5, 0, 1.15, 0, 8);
  parent.add(g);
  return g;
}

/** 曝氣池（氣泡＋欄杆）。 */
function addAerationTank(parent: THREE.Object3D, x: number, z: number, w = 3.2, d = 1.6): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addBox(g, lam(0x8a8f92), w, 0.7, d, 0, 0.35, 0);
  addBox(g, basic(0x3f6f5a), w - 0.2, 0.04, d - 0.2, 0, 0.72, 0);
  for (let i = 0; i < 14; i++) {
    const bx = -w / 2 + 0.25 + ((i * 7) % 10) * (w - 0.5) / 10;
    const bz = -d / 2 + 0.2 + ((i * 5) % 6) * (d - 0.4) / 6;
    addSphere(g, basic(0x9fd8c0), 0.045 + ((i * 3) % 4) * 0.01, bx, 0.76, bz, 6, 5);
  }
  for (const side of [-1, 1]) {
    addBox(g, lam(0xd9b23f), w, 0.05, 0.05, 0, 1.0, side * (d / 2 - 0.05));
    addCyl(g, lam(0xd9b23f), 0.03, 0.03, 0.5, -w / 2 + 0.1, 0.85, side * (d / 2 - 0.05), 5);
    addCyl(g, lam(0xd9b23f), 0.03, 0.03, 0.5, w / 2 - 0.1, 0.85, side * (d / 2 - 0.05), 5);
  }
  parent.add(g);
  return g;
}

/** 監控幕牆（控制室）。 */
function addMonitorWall(
  parent: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  ry = 0,
  w = 2.2,
  h = 1.3,
  cols = 3,
  rows = 2,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  addBox(g, lam(0x1a1d20), w + 0.1, h + 0.1, 0.12, 0, 0, 0);
  const cw = w / cols;
  const ch = h / rows;
  const colors = [0x2f7f9f, 0x2f9f7f, 0x3f6f9f, 0x2f8f9f, 0x3f7f8f, 0x2f6f8f];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      addBox(g, basic(colors[(r * cols + c) % colors.length]), cw - 0.08, ch - 0.08, 0.01, -w / 2 + cw * (c + 0.5), h / 2 - ch * (r + 0.5), 0.07);
      addBox(g, basic(0xbfe8f0), cw * 0.3, 0.02, 0.01, -w / 2 + cw * (c + 0.5), h / 2 - ch * (r + 0.5) + 0.08, 0.075);
    }
  }
  addBox(g, lam(0x2a2f36), 0.1, h, 0.08, -w / 2 - 0.04, 0, 0);
  parent.add(g);
  return g;
}

/** X 光行李檢查機（機場／空運貨運站）。 */
function addXrayMachine(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0xdfe3e6), 2.0, 1.5, 1.0, 0, 0.75, 0);
  addBox(g, lam(0x2a2f36), 0.72, 0.5, 1.02, 0, 0.9, 0);
  addBox(g, lam(0x1a1d20), 0.56, 0.36, 0.02, 0, 0.9, 0.52);
  addBox(g, basic(0x7fe0b0), 0.5, 0.3, 0.01, 0, 0.9, 0.53);
  addBox(g, lam(0x3a4048), 2.4, 0.08, 0.5, 0, 0.75, 0);
  addBox(g, lam(IPAL.cardboard), 0.4, 0.3, 0.4, -0.5, 0.78, 0);
  addBox(g, lam(IPAL.cardboardDark), 0.3, 0.24, 0.3, 0.3, 0.78, 0);
  addBox(g, basic(0x2f8f9f), 0.34, 0.05, 0.02, 0, 1.4, 0.4);
  parent.add(g);
  return g;
}

/** 空運貨箱 ULD（銀色航空貨箱）。 */
function addULDPallet(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0xc9ced2), 1.15, 0.9, 1.0, 0, 0.45, 0);
  addBox(g, lam(0x9aa0a6), 1.18, 0.08, 1.03, 0, 0.9, 0);
  for (let i = 0; i < 4; i++) addBox(g, lam(0x8a9096), 0.04, 0.86, 1.02, -0.5 + i * 0.33, 0.45, 0);
  addBox(g, lam(0xf2f0e6), 0.3, 0.2, 0.01, 0, 0.6, 0.51);
  addBox(g, lam(0xd94a3f), 0.3, 0.05, 0.01, 0, 0.85, 0.51);
  addBox(g, lam(0x6f757b), 1.1, 0.1, 0.95, 0, 0.05, 0);
  parent.add(g);
  return g;
}

/** 貨運磅秤（空運貨運站）。 */
function addCargoScale(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x5f656b), 1.7, 0.1, 1.25, 0, 0.1, 0);
  addBox(g, lam(0x757b82), 1.5, 0.04, 1.1, 0, 0.16, 0);
  addBox(g, lam(0xd9b23f), 1.7, 0.04, 0.09, 0, 0.16, 0.6);
  addBox(g, lam(0x2a2f36), 0.16, 1.15, 0.16, -0.95, 0.58, 0);
  addBox(g, basic(0x7fe0b0), 0.44, 0.22, 0.03, -0.95, 1.2, 0.09);
  addBox(g, lam(IPAL.cardboard), 0.6, 0.45, 0.5, 0.2, 0.4, 0);
  addBox(g, lam(IPAL.cardboardDark), 0.5, 0.4, 0.45, -0.35, 0.38, 0.1);
  parent.add(g);
  return g;
}

// ═══════════════════════ Round 5 新增 9 種室內陳設 ═══════════════════════

/** 33. 水塔加壓泵房：主泵、上水立管、閥門、加壓控制箱。 */
function fillWaterTowerPump(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addPumpUnit(root, -w * 0.2, -d * 0.2, 0.15, 1.0, 0x3f7fb0);
  addPumpUnit(root, w * 0.16, -d * 0.2, -0.2, 0.85, 0x3f7fb0);
  // 上水立管直上天花
  addCyl(root, lam(0x8a9096), 0.17, 0.17, h - 0.32, w * 0.34, (h - 0.32) / 2, -d * 0.32, 14);
  addCyl(root, lam(0x9aa0a6), 0.22, 0.22, 0.12, w * 0.34, 0.8, -d * 0.32, 14);
  addValveWheel(root, w * 0.34, 1.5, -d * 0.32 + 0.26, 0.24);
  // 橫管與加壓閥
  addPipeRun(root, -w * 0.44, -d * 0.04, w * 0.3, -d * 0.04, 1.85, 0.15, 0x8a9096);
  addValveWheel(root, -w * 0.1, 2.06, -d * 0.04, 0.26);
  addValveWheel(root, w * 0.18, 2.06, -d * 0.04, 0.2);
  // 加壓控制箱與水錶
  addBox(root, lam(0x2a3036), 1.0, 1.3, 0.35, -w * 0.38, 0.65, d * 0.06);
  addBox(root, basic(0x5cff9d), 0.5, 0.16, 0.02, -w * 0.38, 1.1, d * 0.24);
  addBox(root, lam(0x1a1d20), 0.4, 0.3, 0.04, -w * 0.38, 1.32, d * 0.24);
  addCyl(root, lam(0x6f8f9a), 0.3, 0.3, 0.95, w * 0.4, 0.48, d * 0.28, 14);
  addPipeRun(root, w * 0.4, d * 0.28, w * 0.4, d * 0.08, 0.95, 0.12, 0x6f8f9a);
  addBoard(ctx, 'pump-room', ['水塔加壓泵房', 'WATER TOWER PUMP ROOM'], 0, h * 0.58, -d / 2 + 0.26, 0, 2.1, 0.72, {
    bg: 0x2f5f8f,
    fg: '#ffffff',
  });
  addExitSign(root, -w * 0.44, h - 0.4, d * 0.3);
  addFireHose(root, -w * 0.44, 1.2, d * 0.02, Math.PI / 2);
  const n = peopleCount('worker', building.workers.length);
  for (let i = 0; i < n; i++) addPerson(root, { x: -w * 0.3 + i * 0.9, z: d * 0.16, ry: Math.PI * (0.7 + i * 0.1), kind: 'worker' });
}

/** 34. 海水化淡廠：RO 膜架、高壓泵、濾水池、控制台。 */
function fillDesalPlant(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addROMembraneRack(root, -w * 0.26, -d * 0.24, 0, 2.8);
  addROMembraneRack(root, w * 0.08, -d * 0.24, 0, 2.8);
  addROMembraneRack(root, w * 0.34, d * 0.06, -Math.PI / 2, 2.6);
  addPumpUnit(root, -w * 0.28, d * 0.14, 0.35, 1.15, 0x2f7f9f);
  addPumpUnit(root, w * 0.14, d * 0.14, -0.3, 1.15, 0x2f7f9f);
  addFilterTank(root, -w * 0.02, -d * 0.26, 2.4, 1.3);
  addPipeRun(root, -w * 0.46, d * 0.32, w * 0.46, d * 0.32, 0.9, 0.24, 0x2f7f9f);
  addPipeRun(root, -w * 0.46, -d * 0.1, -w * 0.46, d * 0.32, 2.3, 0.14, 0x8fa6b8);
  addPipeRun(root, -w * 0.46, -d * 0.1, w * 0.46, -d * 0.1, 2.3, 0.14, 0x8fa6b8);
  addValveWheel(root, w * 0.28, 2.55, -d * 0.1, 0.26);
  addValveWheel(root, -w * 0.3, 2.55, -d * 0.1, 0.22);
  addBox(root, glass(0x9fd0e0, 0.16), w * 0.52, h * 0.46, 0.04, -w * 0.24, h * 0.3, d * 0.04);
  addControlPanel(root, -w * 0.24, d * 0.3, 0, 3.0);
  addControlPanel(root, w * 0.28, d * 0.24, 0.1, 2.2);
  for (let i = 0; i < 4; i++) addCyl(root, glass(0x9fd0e0, 0.5), 0.06, 0.06, 0.2, w * 0.34 + i * 0.14, 1.05, d * 0.36, 8);
  addBoard(ctx, 'desal', ['海水化淡廠', 'DESALINATION PLANT'], 0, h * 0.6, -d / 2 + 0.26, 0, 2.4, 0.78, {
    bg: 0x2f7f9f,
    fg: '#ffffff',
  });
  addBoard(ctx, 'desal-notice', ['高壓設備', 'HIGH PRESSURE'], -w * 0.42, h * 0.42, -d * 0.3, Math.PI / 2, 1.0, 0.6, {
    bg: 0xe0b33a,
    fg: '#1f2937',
    border: '#b02a2a',
  });
  addExitSign(root, w * 0.44, h - 0.42, d * 0.3);
  addFireHose(root, w * 0.44, 1.2, -d * 0.3, -Math.PI / 2);
  const n = peopleCount('worker', building.workers.length);
  const kinds: ('worker' | 'office')[] = ['office', 'worker', 'office', 'worker', 'worker'];
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.26 + i * 1.0, z: d * 0.08 + (i % 2) * 0.22, ry: Math.PI * (0.7 + i * 0.1), kind: kinds[i % kinds.length] });
  }
}

/** 35. 污水處理廠：沉澱池、曝氣池、污泥泵、控制台。 */
function fillSewagePlant(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addSettlingTank(root, -w * 0.26, -d * 0.18, 1.3);
  addSettlingTank(root, w * 0.12, -d * 0.18, 1.3);
  addAerationTank(root, -w * 0.05, d * 0.22, 3.4, 1.6);
  addPumpUnit(root, -w * 0.4, d * 0.3, 0.2, 0.95, 0x6f6a4a);
  addPipeRun(root, -w * 0.44, -d * 0.02, w * 0.4, -d * 0.02, 1.95, 0.18, 0x6f7a4a);
  addPipeRun(root, w * 0.4, -d * 0.02, w * 0.4, d * 0.3, 1.95, 0.14, 0x6f7a4a);
  addValveWheel(root, 0, 2.16, -d * 0.02, 0.26);
  addControlPanel(root, w * 0.32, d * 0.3, 0.1, 2.2);
  addDocumentDesk(root, w * 0.02, d * 0.36, 0, 1.6);
  for (let i = 0; i < 3; i++) addCyl(root, glass(0x8fb0bf, 0.55), 0.05, 0.05, 0.16, w * 0.02 + i * 0.14, 0.86, d * 0.36, 8);
  addBoard(ctx, 'sewage', ['污水處理廠', 'SEWAGE TREATMENT WORKS'], 0, h * 0.6, -d / 2 + 0.26, 0, 2.6, 0.78, {
    bg: 0x4f6f5a,
    fg: '#ffffff',
  });
  addBoard(ctx, 'sewage-notice', ['沉澱池', '請勿靠近'], -w * 0.42, h * 0.42, d * 0.1, Math.PI / 2, 0.9, 0.55, {
    bg: 0xe0b33a,
    fg: '#1f2937',
  });
  addHarbourRail(root, 0, -d * 0.4, w * 0.7);
  addExitSign(root, -w * 0.44, h - 0.42, d * 0.34);
  const n = peopleCount('worker', building.workers.length);
  const kinds: ('worker' | 'office')[] = ['worker', 'office', 'worker', 'worker', 'office'];
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.24 + i * 1.0, z: d * 0.06 + (i % 2) * 0.18, ry: Math.PI * (0.65 + i * 0.12), kind: kinds[i % kinds.length] });
  }
}

/** 36. 排污口泵房：抽水泵、出海排放管、格柵地面。 */
function fillSewageOutfall(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addPumpUnit(root, -w * 0.16, -d * 0.14, 0.1, 1.2, 0x4f6f5a);
  addPumpUnit(root, w * 0.2, -d * 0.14, -0.15, 0.9, 0x4f6f5a);
  // 出海排放管（穿過後牆）
  addBeam(root, lam(0x6f757b), 0, 0.62, d * 0.2, 0, 0.62, -d * 0.56, 0.34, 12);
  addCyl(root, lam(0x8a9096), 0.24, 0.24, 0.5, 0, 0.62, -d * 0.28, 12, 0, Math.PI / 2);
  addValveWheel(root, 0, 1.15, -d * 0.1, 0.3);
  // 格柵地面與水漬
  addBox(root, lam(0x3a4048), 1.8, 0.03, 1.2, -w * 0.06, 0.03, d * 0.2);
  for (let i = 0; i < 5; i++) addBox(root, lam(0x1a1d20), 1.7, 0.05, 0.06, -w * 0.06, 0.05, d * 0.2 - 0.4 + i * 0.2);
  addBox(root, basic(0x3f6f5a), w * 0.5, 0.02, d * 0.24, w * 0.1, 0.02, d * 0.1);
  addControlPanel(root, -w * 0.02, d * 0.28, 0, 2.0);
  addBoard(ctx, 'outfall', ['排污口泵房', 'OUTFALL PUMPING STATION'], 0, h * 0.6, -d / 2 + 0.26, 0, 2.4, 0.78, {
    bg: 0x2f4f5f,
    fg: '#ffffff',
  });
  addBoard(ctx, 'outfall-notice', ['污水設備', '未經許可不得進入'], w * 0.34, h * 0.44, -d / 2 + 0.26, 0, 1.1, 0.62, {
    bg: 0xe0b33a,
    fg: '#1f2937',
    border: '#b02a2a',
  });
  addExitSign(root, -w * 0.44, h - 0.4, -d * 0.3);
  addFireHose(root, w * 0.44, 1.2, -d * 0.3, -Math.PI / 2);
  const n = peopleCount('worker', building.workers.length);
  for (let i = 0; i < n; i++) addPerson(root, { x: -w * 0.26 + i * 0.95, z: d * 0.16, ry: Math.PI * (0.7 + i * 0.1), kind: 'worker' });
}

/** 37. 小巴車廠：綠 van／紅 van、維修坑、工具架、油泵。 */
function fillMinibusDepot(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addMinibus(root, -w * 0.22, -d * 0.26, 0.06, 0x3f9a6a);
  addMinibus(root, w * 0.3, -d * 0.02, Math.PI * 0.04, 0xd94a3f);
  // 維修坑（地面暗色＋黃黑警示）
  addBox(root, lam(0x1a1d20), 2.6, 0.04, 1.4, -w * 0.14, 0.03, d * 0.04);
  for (let i = 0; i < 6; i++) {
    addBox(root, lam(0xe0b33a), 0.34, 0.05, 0.1, -w * 0.14 - 1.0 + i * 0.42, 0.06, d * 0.04 - 0.75);
    addBox(root, lam(0xe0b33a), 0.34, 0.05, 0.1, -w * 0.14 - 1.0 + i * 0.42, 0.06, d * 0.04 + 0.75);
  }
  addShelfUnit(root, w * 0.38, -d * 0.3, -Math.PI / 2, { w: 1.6, h: 1.8, levels: 3, goods: [0x8a9096, 0xd94a3f, 0x3f7fb0, 0xe0b33a] });
  addCyl(root, lam(0xd94a3f), 0.22, 0.22, 1.25, w * 0.4, 0.63, -d * 0.04, 12);
  addBox(root, lam(0x2a2f36), 0.4, 0.3, 0.2, w * 0.4, 1.2, -d * 0.04 + 0.18);
  addDocumentDesk(root, -w * 0.08, d * 0.36, 0, 1.8);
  addBox(root, lam(0x3a4048), 0.5, 0.1, 0.3, -w * 0.08, 0.82, d * 0.36);
  addBoard(ctx, 'minibus-depot', ['小巴車廠', 'MINIBUS DEPOT'], 0, h * 0.56, -d / 2 + 0.26, 0, 2.2, 0.72, {
    bg: 0x2f7f5a,
    fg: '#ffffff',
  });
  addExitSign(root, w * 0.44, h - 0.42, d * 0.34);
  addFireHose(root, -w * 0.44, 1.2, d * 0.2, Math.PI / 2);
  const n = peopleCount('worker', building.workers.length);
  const kinds: ('worker' | 'office')[] = ['worker', 'office', 'worker', 'worker', 'office'];
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.28 + i * 1.0, z: d * 0.02 + (i % 2) * 0.22, ry: Math.PI * (0.7 + i * 0.1), kind: kinds[i % kinds.length] });
  }
}

/** 38. 機場客運大樓（離境大堂）：登記櫃位、航班牌、X 光、候機座椅、懸掛飛機。 */
function fillAirportTerminal(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addNeon(ctx, '香港國際機場', IPAL.neonCyan, 0, h * 0.68, -d / 2 + 0.32, 0, 3.2, 0.72);
  addBoard(ctx, 'departures', ['離境大堂 DEPARTURES'], 0, h * 0.84, -d / 2 + 0.3, 0, 4.0, 0.62, {
    bg: 0x10243a,
    fg: '#eaf4ff',
  });
  // 航空公司登記櫃位 ×3
  addCheckInCounter(root, -w * 0.28, -d * 0.18, 0, 0x1f4f7a);
  addCheckInCounter(root, 0, -d * 0.18, 0, 0xb02a2a);
  addCheckInCounter(root, w * 0.28, -d * 0.18, 0, 0x2f7f5a);
  // 航班資料牌（右側牆）
  addFlightBoard(ctx, w / 2 - 0.26, h * 0.55, -d * 0.3, -Math.PI / 2, 2.8, 1.7);
  // 保安檢查（X 光機＋金屬探測門柱）
  addXrayMachine(root, -w * 0.2, d * 0.16, 0);
  for (const sx of [0.04, 0.16, 0.28]) addBox(root, lam(0x8a9096), 0.26, 1.65, 0.26, w * sx, 0.82, d * 0.16);
  addBox(root, lam(0x8a9096), w * 0.26, 0.18, 0.26, w * 0.16, 1.7, d * 0.16);
  // 候機座椅 ×2 排
  addAirportSeats(root, -w * 0.28, d * 0.36, Math.PI, 4);
  addAirportSeats(root, w * 0.18, d * 0.36, Math.PI, 4);
  // 登機閘口牌（右側牆）
  addGateSign(ctx, '24', '台北 TAIPEI', w * 0.42, h * 0.5, -d / 2 + 0.28, 0);
  addGateSign(ctx, '12', '曼谷 BANGKOK', w * 0.42, h * 0.32, -d / 2 + 0.28, 0);
  // 懸掛飛機模型
  addPlaneModel(root, 0, h * 0.86, d * 0.18, 1.1);
  // 行李與旅客
  addLuggage(root, -w * 0.12, 0, d * 0.3, 0x3a5f8f, 1.0);
  addLuggage(root, w * 0.2, 0, d * 0.28, 0xd94a3f, 0.9);
  addLuggage(root, w * 0.06, 0, d * 0.24, 0x3f7f5a, 0.8);
  addTrashBin(root, w * 0.4, d * 0.3);
  addPottedPlant(root, -w * 0.42, d * 0.34, 1.4, false);
  addPottedPlant(root, w * 0.42, -d * 0.06, 1.2, false);
  addExitSign(root, -w * 0.44, h - 0.42, d * 0.3);
  addExitSign(root, w * 0.44, h - 0.42, d * 0.3);
  const n = Math.max(3, peopleCount('worker', building.workers.length) + 1);
  const kinds: ('tourist' | 'office' | 'shopper' | 'elder' | 'kid')[] = ['tourist', 'office', 'tourist', 'shopper', 'elder'];
  for (let i = 0; i < Math.min(5, n); i++) {
    addPerson(root, {
      x: -w * 0.34 + i * 1.15,
      z: d * 0.22 + (i % 2) * 0.14,
      ry: Math.PI * (0.5 + i * 0.12),
      kind: kinds[i % kinds.length],
      mask: i % 2 === 0,
    });
  }
}

/** 39. 空運貨運站：ULD 貨箱、卡板、X 光、磅秤、報關枱。 */
function fillAirCargoTerminal(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addULDPallet(root, -w * 0.12, -d * 0.26, 0.1);
  addULDPallet(root, w * 0.12, -d * 0.24, -0.1);
  addULDPallet(root, w * 0.36, -d * 0.06, 0.2);
  addPalletRack(root, -w * 0.38, -d * 0.02, Math.PI / 2, { w: 2.6, h: 2.6, levels: 3 });
  addPallet(root, w * 0.06, -d * 0.04, 0.2);
  addCardboardBoxes(root, w * 0.06, -d * 0.04, 4, 1.0);
  addCardboardBoxes(root, w * 0.2, d * 0.02, 3, 0.9);
  addXrayMachine(root, -w * 0.36, d * 0.12, Math.PI / 2);
  addCargoScale(root, w * 0.28, d * 0.14, -0.3);
  addConveyor(root, -w * 0.32, d * 0.02, Math.PI / 2, 2.6);
  addDocumentDesk(root, 0, d * 0.34, 0, 2.0);
  addTelephone(root, 0.3, 0.8, d * 0.34, 0.2);
  addFilingCabinet(root, -w * 0.42, d * 0.32, Math.PI / 2);
  addFilingCabinet(root, -w * 0.42, d * 0.14, Math.PI / 2);
  addBoard(ctx, 'air-cargo', ['空運貨運站', 'AIR CARGO TERMINAL'], 0, h * 0.58, -d / 2 + 0.26, 0, 2.8, 0.8, {
    bg: 0x2f5f8f,
    fg: '#ffffff',
  });
  addBoard(
    ctx,
    'cargo-info',
    ['貨運資料', 'CX 2084  HKG→TPE  已裝載', 'KA 841   HKG→PVG  處理中', 'UO 660   HKG→NRT  待報關'],
    w / 2 - 0.26,
    h * 0.4,
    -d * 0.02,
    -Math.PI / 2,
    1.5,
    0.9,
    { bg: 0x0d1622, fg: '#7fe0b0', border: '#2f6f8f' },
  );
  addExitSign(root, -w * 0.44, h - 0.42, d * 0.32);
  addFireHose(root, w * 0.44, 1.2, -d * 0.3, -Math.PI / 2);
  const n = peopleCount('worker', building.workers.length);
  const kinds: ('worker' | 'office')[] = ['worker', 'office', 'worker', 'worker', 'office'];
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.28 + i * 1.0, z: d * 0.04 + (i % 2) * 0.22, ry: Math.PI * (0.7 + i * 0.1), kind: kinds[i % kinds.length] });
  }
}

/** 40. 碼頭閘口：閘亭、地磅、欄杆閘、貨櫃車。 */
function fillPortGate(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  // 閘亭（左後）
  addBox(root, lam(0xf2f0e8), 2.3, 2.2, 1.7, -w * 0.32, 1.1, -d * 0.26);
  addBox(root, glass(0xbfe0ea, 0.22), 1.8, 0.8, 0.03, -w * 0.32, 1.5, -d * 0.26 + 0.86);
  addBox(root, lam(0xd9b23f), 2.4, 0.14, 1.8, -w * 0.32, 2.26, -d * 0.26);
  addBox(root, lam(0x2a2f36), 0.7, 0.35, 0.3, -w * 0.32, 1.05, -d * 0.26 + 0.95);
  addBox(root, basic(0x8fd8ff), 0.5, 0.22, 0.01, -w * 0.32, 1.1, -d * 0.26 + 1.11);
  // 地磅（前景中央）
  addWeighbridge(root, -w * 0.02, d * 0.08, 0);
  // 欄杆閘
  addBarrierGate(root, -w * 0.24, d * 0.06, 0, 0xe0b33a);
  addBarrierGate(root, w * 0.24, d * 0.02, Math.PI, 0xd94a3f);
  // 貨櫃車（右後，縮細避免遮擋視線）
  const truck = addContainerTruck(root, w * 0.18, -d * 0.14, Math.PI * 0.97, IPAL.containerBlue);
  truck.scale.setScalar(0.8);
  // 後方貨櫃堆
  addContainerStack(root, w * 0.36, -d * 0.4, 0.15, { rows: 1, cols: 2, levels: 2 });
  // 招牌與告示
  addBoard(ctx, 'port-gate', ['碼頭閘口', 'PORT GATE 3'], 0, h * 0.64, -d / 2 + 0.3, 0, 2.8, 0.9, {
    bg: 0x10243a,
    fg: '#ffd166',
  });
  addNeon(ctx, '貨櫃碼頭', IPAL.neonGold, -w * 0.36, h * 0.4, -d / 2 + 0.32, 0, 1.8, 0.55);
  addBoard(ctx, 'port-notice', ['排隊等候', 'KEEP CLEAR'], w * 0.4, 1.5, -d / 2 + 0.26, 0, 1.1, 0.55, {
    bg: 0xe0b33a,
    fg: '#1f2937',
  });
  addHarbourRail(root, 0, -d * 0.44, w * 0.8);
  addExitSign(root, -w * 0.44, h - 0.4, d * 0.3);
  const n = peopleCount('worker', building.workers.length);
  const kinds: ('worker' | 'office' | 'police')[] = ['office', 'worker', 'police', 'worker', 'office'];
  for (let i = 0; i < n; i++) {
    addPerson(root, { x: -w * 0.3 + i * 0.9, z: d * 0.06 + (i % 2) * 0.2, ry: Math.PI * (0.6 + i * 0.12), kind: kinds[i % kinds.length] });
  }
}

/** 41. 貨櫃堆場控制室：控制台、監控幕牆、維港景、操作員。 */
function fillPortYardControl(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d, h } = dims;
  addControlPanel(root, -w * 0.18, -d * 0.18, 0, 3.4);
  addControlPanel(root, w * 0.22, -d * 0.18, 0, 2.4);
  addMonitorWall(root, -w / 2 + 0.24, h * 0.56, d * 0.02, Math.PI / 2, 2.2, 1.3, 3, 2);
  for (const sx of [-w * 0.16, w * 0.04]) {
    addBox(root, lam(0x2f3337), 0.52, 0.08, 0.52, sx, 0.46, -d * 0.02);
    addBox(root, lam(0x2f3337), 0.52, 0.58, 0.08, sx, 0.78, -d * 0.02 - 0.24);
    addBox(root, lam(0x5f656b), 0.06, 0.4, 0.06, sx, 0.2, -d * 0.02);
  }
  addDocumentDesk(root, w * 0.34, d * 0.12, 0, 1.8);
  addTelephone(root, w * 0.28, 0.8, d * 0.12, -0.2);
  addTelephone(root, w * 0.4, 0.8, d * 0.12, 0.3);
  for (let i = 0; i < 3; i++) addCyl(root, lam(0xf2f0e6), 0.04, 0.035, 0.1, w * 0.3 + i * 0.1, 0.84, d * 0.14, 8);
  addBoard(ctx, 'yard-control', ['貨櫃堆場', 'YARD CONTROL 控制室'], w / 2 - 0.26, h * 0.55, -d * 0.24, -Math.PI / 2, 2.2, 0.72, {
    bg: 0x2f3f4f,
    fg: '#ffd166',
  });
  addNeon(ctx, '控制塔', IPAL.neonCyan, w * 0.36, h * 0.62, -d / 2 + 0.32, 0, 1.8, 0.6);
  addBoard(
    ctx,
    'yard-status',
    ['堆場狀態', '1 號泊位  龍門吊 A  運作中', '2 號泊位  龍門吊 B  待機'],
    -w * 0.26,
    h * 0.4,
    -d / 2 + 0.28,
    0,
    1.6,
    0.8,
    { bg: 0x0d1622, fg: '#7fe0b0', border: '#2f6f8f' },
  );
  addWaterCooler(root, w * 0.44, d * 0.34);
  addPottedPlant(root, -w * 0.42, d * 0.36, 1.2, false);
  addExitSign(root, -w * 0.44, h - 0.42, -d * 0.3);
  addExitSign(root, w * 0.44, h - 0.42, -d * 0.3);
  const n = Math.max(2, peopleCount('worker', building.workers.length));
  const kinds: ('office' | 'worker')[] = ['office', 'office', 'worker', 'office', 'worker'];
  for (let i = 0; i < Math.min(4, n); i++) {
    addPerson(root, { x: -w * 0.24 + i * 0.9, z: d * 0.14 + (i % 2) * 0.18, ry: Math.PI * (0.7 + i * 0.1), kind: kinds[i % kinds.length] });
  }
}

/** 42. 巴士站（細站）：候車亭、站牌、雙層巴士、乘客。 */
function fillBusStop(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d } = dims;
  addBox(root, lam(0x565a5e), w * 1.3, 0.03, d * 0.8, 0, 0.015, d * 0.1);
  addBusShelter(root, -w * 0.2, d * 0.16, 0.08);
  addBusStopFlag(root, w * 0.08, d * 0.2, 0.2, '968', '銅鑼灣');
  addBusStopFlag(root, w * 0.26, d * 0.2, 0.2, '960', '中環');
  const bus = addDoubleDeckerBus(root, w * 0.16, -d * 0.08, Math.PI * 0.02, 0xd9b23f);
  bus.scale.setScalar(0.82);
  addBench(root, -w * 0.34, d * 0.02, Math.PI);
  addLampPost(root, -w * 0.12, d * 0.3, 3.2);
  addTrashBin(root, w * 0.34, d * 0.02);
  addTree(root, -w * 0.42, -d * 0.3, 0.75, false);
  addBoard(ctx, 'bus-stop-sign', ['巴士站', 'BUS STOP'], -w * 0.06, 2.4, -d * 0.34, 0, 1.6, 0.5, {
    bg: 0xd9b23f,
    fg: '#1f2937',
  });
  const n = Math.max(2, peopleCount('worker', building.workers.length) + 2);
  const kinds: ('office' | 'elder' | 'student' | 'shopper')[] = ['office', 'elder', 'student', 'shopper'];
  for (let i = 0; i < Math.min(4, n); i++) {
    addPerson(root, { x: -w * 0.32 + i * 0.75, z: d * 0.26 + (i % 2) * 0.1, ry: -Math.PI * 0.35, kind: kinds[i % kinds.length] });
  }
  addBird(root, w * 0.2, 0.3, -d * 0.2);
}

/** 43. 小巴站（細站）：綠色專線小巴、站牌、乘客。 */
function fillMinibusStop(ctx: FillCtx): void {
  const { root, dims, building } = ctx;
  const { w, d } = dims;
  addBox(root, lam(0x565a5e), w * 1.3, 0.03, d * 0.8, 0, 0.015, d * 0.1);
  addMinibus(root, w * 0.08, -d * 0.06, Math.PI * 0.02, 0x3f9a6a);
  addCyl(root, lam(0x8a9096), 0.03, 0.03, 2.3, -w * 0.16, 1.15, d * 0.16, 8);
  addBoard(ctx, 'minibus-stop', ['小巴站', '綠色專線小巴', '41A 往 觀塘'], -w * 0.16, 2.3, d * 0.2, 0, 1.5, 0.9, {
    bg: 0x2f8f5f,
    fg: '#ffffff',
  });
  addBench(root, -w * 0.3, d * 0.24, Math.PI);
  addLampPost(root, w * 0.34, d * 0.16, 3.2);
  addTrashBin(root, w * 0.26, d * 0.26);
  addTree(root, -w * 0.4, -d * 0.28, 0.8, false);
  const n = Math.max(2, peopleCount('worker', building.workers.length) + 2);
  const kinds: ('shopper' | 'elder' | 'student' | 'office')[] = ['shopper', 'elder', 'student', 'office'];
  for (let i = 0; i < Math.min(4, n); i++) {
    addPerson(root, { x: -w * 0.28 + i * 0.7, z: d * 0.1 + (i % 2) * 0.12, ry: -Math.PI * 0.4, kind: kinds[i % kinds.length] });
  }
  addBird(root, w * 0.14, 0.28, -d * 0.2);
}

// ─────────────────────────── 樣式對應表 ───────────────────────────

type FillFn = (ctx: FillCtx) => void;

/** 室內樣式 → 陳設函式（`BUILDINGS[key].interior` 對應；Round 5 已加入 9 個新 key）。 */
export const INTERIOR_FILLERS: Record<string, FillFn> = {
  tongLau: fillTongLau,
  subdividedFlat: fillSubdividedFlat,
  publicHousing: fillPublicHousing,
  hOSFlat: fillHOSFlat,
  privateEstate: fillPrivateEstate,
  luxuryTower: fillLuxuryTower,
  farm: fillFarm,
  chaChaanTeng: fillChaChaanTeng,
  convenienceStore: fillConvenienceStore,
  wetMarket: fillWetMarket,
  supermarket: fillSupermarket,
  shoppingMall: fillShoppingMall,
  restaurant: fillRestaurant,
  officeTower: fillOfficeTower,
  industrialBuilding: fillIndustrialBuilding,
  foodFactory: fillFoodFactory,
  quarry: fillQuarry,
  powerPlant: fillPowerPlant,
  waterworks: fillWaterworks,
  importFirm: fillImportFirm,
  containerPort: fillContainerPort,
  warehouse: fillWarehouse,
  school: fillSchool,
  hospital: fillHospital,
  policeStation: fillPoliceStation,
  fireStation: fillFireStation,
  mtrStation: fillMtrStation,
  busTerminus: fillBusTerminus,
  tramStop: fillTramStop,
  ferryPier: fillFerryPier,
  park: fillPark,
  promenade: fillPromenade,
  // ── Round 5 新增 ──
  waterTower: fillWaterTowerPump,
  desalPlant: fillDesalPlant,
  sewagePlant: fillSewagePlant,
  sewageOutfall: fillSewageOutfall,
  minibusDepot: fillMinibusDepot,
  airportTerminal: fillAirportTerminal,
  airCargoTerminal: fillAirCargoTerminal,
  portGate: fillPortGate,
  portYard: fillPortYardControl,
  busStop: fillBusStop,
  minibusStop: fillMinibusStop,
};

const CATEGORY_FALLBACK: Record<string, FillFn> = {
  residential: fillGenericHome,
  commercial: fillGenericWork,
  industrial: fillGenericWork,
  logistics: fillGenericWork,
  civic: fillGenericWork,
  transport: fillGenericWork,
  decoration: fillPark,
};

interface StyleSpec {
  room: RoomSpec;
  camLift?: number;
  wAdd?: number;
  fill: FillFn;
}

function specFor(style: string, def: BuildingDef): StyleSpec {
  switch (style) {
    case 'tongLau':
      return { room: { floor: 'mosaic', wall: 'old', ceiling: 'white', window: 'street', windowCount: 1, accent: 0x6f4a2a }, fill: fillTongLau };
    case 'subdividedFlat':
      return { room: { floor: 'vinyl', wall: 'green', ceiling: 'grey', window: 'street', windowCount: 1, accent: 0x6f5a3a, lampCount: 1 }, fill: fillSubdividedFlat };
    case 'publicHousing':
      return { room: { floor: 'mosaic', wall: 'green', ceiling: 'white', window: 'street', windowCount: 2, accent: 0x5f6f5a }, fill: fillPublicHousing };
    case 'hOSFlat':
      return { room: { floor: 'vinyl', wall: 'cream', ceiling: 'white', window: 'street', windowCount: 2, accent: 0x8a7a5a }, fill: fillHOSFlat };
    case 'privateEstate':
      return { room: { floor: 'marble', wall: 'white', ceiling: 'white', window: 'street', windowCount: 2, floorToCeiling: true, accent: 0x8a8f96 }, fill: fillPrivateEstate };
    case 'luxuryTower':
      return { room: { floor: 'marble', wall: 'cream', ceiling: 'white', window: 'harbour', windowCount: 2, floorToCeiling: true, accent: 0xc9a24c, lampCount: 3 }, fill: fillLuxuryTower };
    case 'chaChaanTeng':
      return { room: { floor: 'checker', wall: 'green', ceiling: 'white', window: 'street', windowCount: 1, accent: 0x2f5a46 }, fill: fillChaChaanTeng };
    case 'convenienceStore':
      return { room: { floor: 'tileBlue', wall: 'white', ceiling: 'grey', window: 'street', windowCount: 1, accent: 0x4fa3c9 }, fill: fillConvenienceStore };
    case 'wetMarket':
      return { room: { semi: true, floor: 'concrete', wall: 'tile', ceiling: 'grey', accent: 0x2f7f6a, lampCount: 3 }, fill: fillWetMarket };
    case 'supermarket':
      return { room: { floor: 'tileBlue', wall: 'white', ceiling: 'grey', window: 'street', windowCount: 1, accent: 0x3f8f6a, lampCount: 3 }, fill: fillSupermarket };
    case 'shoppingMall':
      return { room: { floor: 'marble', wall: 'cream', ceiling: 'panel', window: 'street', windowCount: 2, accent: 0x9a5fb0, lampCount: 4 }, fill: fillShoppingMall, wAdd: 2.0 };
    case 'restaurant':
      return { room: { floor: 'checker', wall: 'red', ceiling: 'white', window: 'street', windowCount: 1, accent: 0xc9a24c, lampCount: 3 }, fill: fillRestaurant };
    case 'officeTower':
      return { room: { floor: 'tileBlue', wall: 'white', ceiling: 'grey', window: 'harbour', windowCount: 2, floorToCeiling: true, accent: 0x8fa6c0, lampCount: 3 }, fill: fillOfficeTower };
    case 'industrialBuilding':
      return { room: { floor: 'concrete', wall: 'metal', ceiling: 'concrete', accent: 0x596069, lampCount: 3 }, fill: fillIndustrialBuilding };
    case 'foodFactory':
      return { room: { floor: 'concrete', wall: 'white', ceiling: 'grey', accent: 0x8a9096, lampCount: 3 }, fill: fillFoodFactory };
    case 'powerPlant':
      return { room: { floor: 'concrete', wall: 'metal', ceiling: 'concrete', accent: 0x4f555b, lampCount: 3 }, fill: fillPowerPlant, wAdd: 1.0 };
    case 'waterworks':
      return { room: { semi: true, floor: 'concrete', wall: 'concrete', ceiling: 'grey', accent: 0x6f9aa6, lampCount: 3 }, fill: fillWaterworks };
    case 'importFirm':
      return { room: { floor: 'concrete', wall: 'blue', ceiling: 'grey', window: 'street', windowCount: 1, accent: 0x5f8faf }, fill: fillImportFirm };
    case 'containerPort':
      return { room: { outdoor: true, floor: 'asphalt', skyline: true, water: true, lampCount: 0 }, fill: fillContainerPort, camLift: 0.6 };
    case 'warehouse':
      return { room: { floor: 'concrete', wall: 'metal', ceiling: 'concrete', accent: 0x7a6a4a, lampCount: 3 }, fill: fillWarehouse };
    case 'school':
      return { room: { floor: 'vinyl', wall: 'cream', ceiling: 'white', window: 'street', windowCount: 2, accent: 0x4f7a5a }, fill: fillSchool };
    case 'hospital':
      return { room: { floor: 'mosaic', wall: 'hospital', ceiling: 'grey', window: 'street', windowCount: 1, accent: 0x6f9aa6, lampCount: 3 }, fill: fillHospital };
    case 'policeStation':
      return { room: { floor: 'tileBlue', wall: 'police', ceiling: 'grey', window: 'street', windowCount: 1, accent: 0x24354f }, fill: fillPoliceStation };
    case 'fireStation':
      return { room: { semi: true, floor: 'concrete', wall: 'red', ceiling: 'grey', accent: 0xb02a2a, lampCount: 3 }, fill: fillFireStation };
    case 'mtrStation':
      return { room: { floor: 'platform', wall: 'tile', ceiling: 'grey', accent: 0xb02a2a, lampCount: 3 }, fill: fillMtrStation };
    case 'busTerminus':
      return { room: { outdoor: true, floor: 'asphalt', skyline: true, lampCount: 0 }, fill: fillBusTerminus };
    case 'tramStop':
      return { room: { outdoor: true, floor: 'asphalt', skyline: true, water: true, lampCount: 0 }, fill: fillTramStop };
    case 'ferryPier':
      return { room: { semi: true, floor: 'boardwalk', wall: 'white', ceiling: 'grey', accent: 0x2f7f6a, lampCount: 2 }, fill: fillFerryPier };
    case 'park':
      return { room: { outdoor: true, floor: 'grass', skyline: true, lampCount: 0 }, fill: fillPark, camLift: 0.35 };
    case 'promenade':
      return { room: { outdoor: true, floor: 'boardwalk', skyline: true, water: true, lampCount: 0 }, fill: fillPromenade, camLift: 0.3 };
    case 'farm':
      return { room: { outdoor: true, floor: 'grass', skyline: true, lampCount: 0 }, fill: fillFarm, camLift: 0.2 };
    case 'quarry':
      return { room: { outdoor: true, floor: 'concrete', skyline: true, lampCount: 0 }, fill: fillQuarry, camLift: 0.2 };
    // ── Round 5 新增 ──
    case 'waterTower':
      return { room: { floor: 'concrete', wall: 'metal', ceiling: 'grey', accent: 0x3f7fb0, lampCount: 2 }, fill: fillWaterTowerPump };
    case 'desalPlant':
      return { room: { floor: 'concrete', wall: 'metal', ceiling: 'grey', accent: 0x6f8f9f, lampCount: 3 }, fill: fillDesalPlant, wAdd: 0.6 };
    case 'sewagePlant':
      return { room: { semi: true, floor: 'concrete', wall: 'concrete', ceiling: 'grey', accent: 0x6f6a4a, lampCount: 3 }, fill: fillSewagePlant };
    case 'sewageOutfall':
      return { room: { floor: 'concrete', wall: 'tile', ceiling: 'grey', accent: 0x4f6f5a, lampCount: 2 }, fill: fillSewageOutfall };
    case 'minibusDepot':
      return { room: { semi: true, floor: 'concrete', wall: 'metal', ceiling: 'grey', accent: 0xd9b23f, lampCount: 3 }, fill: fillMinibusDepot };
    case 'airportTerminal':
      return {
        room: {
          floor: 'marble',
          wall: 'white',
          ceiling: 'panel',
          window: 'harbour',
          windowCount: 3,
          floorToCeiling: true,
          accent: 0x8fa6c0,
          lampCount: 4,
        },
        fill: fillAirportTerminal,
        wAdd: 1.0,
      };
    case 'airCargoTerminal':
      return {
        room: { floor: 'concrete', wall: 'white', ceiling: 'grey', window: 'street', windowCount: 1, accent: 0x5f8faf, lampCount: 3 },
        fill: fillAirCargoTerminal,
      };
    case 'portGate':
      return { room: { semi: true, floor: 'asphalt', wall: 'metal', ceiling: 'grey', accent: 0xd9b23f, lampCount: 2 }, fill: fillPortGate };
    case 'portYard':
      return {
        room: {
          floor: 'tileBlue',
          wall: 'white',
          ceiling: 'grey',
          window: 'harbour',
          windowCount: 2,
          floorToCeiling: true,
          accent: 0x2f5f8f,
          lampCount: 3,
        },
        fill: fillPortYardControl,
      };
    case 'busStop':
      return { room: { outdoor: true, floor: 'asphalt', skyline: true, lampCount: 0 }, fill: fillBusStop, camLift: -1.0 };
    case 'minibusStop':
      return { room: { outdoor: true, floor: 'asphalt', skyline: true, lampCount: 0 }, fill: fillMinibusStop, camLift: -1.0 };
    default:
      return {
        room: { floor: 'vinyl', wall: 'cream', ceiling: 'white', window: 'street', windowCount: 1 },
        fill: INTERIOR_FILLERS[style] ?? CATEGORY_FALLBACK[def.category] ?? fillGenericHome,
      };
  }
}

// ─────────────────────────── 日夜 / 天氣 ───────────────────────────

/** 依時辰計算日照 0..1（與 environment 對齊的近似）。 */
function daylightFactor(clock: GameState['clock']): number {
  const t = (clock.hour * 60 + clock.minute) / 1440;
  return Math.max(0.04, Math.min(1, Math.sin((t - 0.22) * Math.PI * 2) * 0.62 + 0.5));
}

function collectAnimParts(root: THREE.Object3D): AnimPart[] {
  const parts: AnimPart[] = [];
  root.traverse((obj) => {
    const kind = obj.userData?.anim as string | undefined;
    if (!kind) return;
    parts.push({
      obj,
      kind,
      phase: parts.length * 1.37,
      baseX: obj.position.x,
      baseY: obj.position.y,
      baseRotX: obj.rotation.x,
      baseRotY: obj.rotation.y,
      baseRotZ: obj.rotation.z,
      baseScale: obj.scale.x,
    });
  });
  return parts;
}

// ─────────────────────────── 主建立函式 ───────────────────────────

const FALLBACK_DEF = (key: string): BuildingDef => ({
  key,
  name: key,
  desc: '',
  category: 'decoration',
  size: [1, 1],
  cost: 0,
  upkeep: 0,
  workers: 0,
  housing: 0,
  unlockPop: 0,
  color: 0xffffff,
});

export function createInteriorView(state: GameState, buildingId: number): InteriorView | null {
  const building: Building | undefined = state.buildings.find((b) => b.id === buildingId);
  if (!building) return null;
  const def: BuildingDef = BUILDINGS[building.key] ?? FALLBACK_DEF(building.key);
  const style = def.interior ?? def.category;
  const styleSpec = specFor(style, def);
  const fill = styleSpec.fill;

  const scene = new THREE.Scene();
  const outdoor = !!styleSpec.room.outdoor;
  scene.background = new THREE.Color(outdoor ? SKY_DAY.clone() : ROOM_BG);
  scene.fog = outdoor ? new THREE.Fog(0xa9c4d8, 34, 110) : new THREE.Fog(ROOM_BG, 26, 62);

  // 房間尺寸（依建築佔地格數）
  const sw = def.size[0];
  const sh = def.size[1];
  const dims: Dims = {
    w: 7.2 + (sw - 1) * 1.9 + (styleSpec.wAdd ?? 0),
    d: 6.4 + (sh - 1) * 1.7,
    h: 3.0 + (Math.max(sw, sh) - 1) * 0.42,
  };

  // 外殼與內容分開：外殼不合併投影，內容合併
  const shell = new THREE.Group();
  const content = new THREE.Group();
  scene.add(shell);
  scene.add(content);

  const room = buildRoom(scene, shell, dims, styleSpec.room);
  const ctx: FillCtx = { scene, root: content, dims, def, building, state, neon: [], room };
  fill(ctx);

  // 靜態幾何合併（大幅減少 draw call）
  finalizeInteriorScene(shell, false);
  finalizeInteriorScene(content, true);

  // 收集微動畫
  const parts = [...collectAnimParts(shell), ...collectAnimParts(content)];
  const neonPhases = ctx.neon.map(() => neonFlickerPhase());

  // ── 相機（依室內類型取景） ──
  const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.08, 240);
  const camLift = styleSpec.camLift ?? 0;
  const camBase = new THREE.Vector3(
    0,
    outdoor ? dims.h * 1.55 + 2.0 + camLift : dims.h * 0.34 + 0.95 + camLift,
    outdoor ? dims.d * 0.55 + 7.2 : dims.d * 0.5 + 3.0 + Math.max(0, dims.w - 8) * 0.14,
  );
  const camLook = new THREE.Vector3(0, outdoor ? dims.h * 0.55 : dims.h * 0.3, outdoor ? -dims.d * 0.24 : -dims.d * 0.16);
  camera.position.copy(camBase);
  camera.lookAt(camLook);
  if (outdoor && (style === 'park' || style === 'promenade' || style === 'farm')) {
    camBase.z += 1.6;
    camBase.y += 0.8;
    camera.position.copy(camBase);
    camera.lookAt(camLook);
  }

  let elapsed = 0;
  const flicker = (seed: number): number =>
    0.86 + Math.sin(elapsed * 7.3 + seed) * 0.07 + Math.sin(elapsed * 13.1 + seed * 2.1) * 0.05;

  const update = (s: GameState, dt: number): void => {
    elapsed += Math.min(0.1, Math.max(0, dt));
    const day = daylightFactor(s.clock);
    const weather = s.clock.weather;
    const overcast =
      weather === 'rain' || weather === 'snow'
        ? 0.6
        : weather === 'cloudy'
          ? 0.82
          : weather === 'storm'
            ? 0.34
            : weather === 'fog'
              ? 0.58
              : 1;
    const night = day < 0.42;

    // ── 窗光與環境光 ──
    room.windowLight.intensity = (0.25 + day * 2.3) * overcast * (outdoor ? 1.25 : 1);
    room.windowLight.color.setHex(day > 0.5 ? 0xfff1d0 : 0x9fb6d8);
    room.hemi.intensity = (outdoor ? 0.34 : 0.2) + day * (outdoor ? 0.62 : 0.42);
    room.ambient.intensity = (outdoor ? 0.3 : 0.4) + day * (outdoor ? 0.3 : 0.22);
    // 颱風閃電
    if (weather === 'storm') {
      const flash = Math.pow(Math.max(0, Math.sin(elapsed * 2.3 + Math.sin(elapsed * 5.7))), 8);
      room.ambient.intensity += flash * 1.5;
      room.windowLight.intensity += flash * 2.4;
    }
    // 戶外天空／霧色
    if (outdoor && scene.background instanceof THREE.Color && room.skyColors) {
      const target = room.skyColors.night.clone().lerp(room.skyColors.day, day);
      scene.background.copy(target);
      if (scene.fog instanceof THREE.Fog) scene.fog.color.copy(target);
    }
    // 室內燈隨日夜明滅
    for (let i = 0; i < room.lamps.length; i++) {
      room.lamps[i].intensity = (outdoor ? 2.5 : 3.5) + (1 - day) * 8 * flicker(i * 1.7);
    }
    // 窗外景日夜交叉淡入
    for (const wv of room.windows) {
      wv.day.opacity = Math.min(1, 0.12 + day * 1.05);
      wv.night.opacity = Math.min(1, (1 - day) * 1.1);
    }
    // 霓虹招牌閃爍
    for (let i = 0; i < ctx.neon.length; i++) {
      ctx.neon[i].color.setScalar(0.82 + 0.18 * Math.sin(elapsed * 5.3 + neonPhases[i]));
    }

    // ── 微動畫 ──
    for (const part of parts) {
      const t = elapsed + part.phase;
      switch (part.kind) {
        case 'fan':
          part.obj.rotation.y = part.baseRotY + elapsed * 3.2 + part.phase;
          break;
        case 'slow-spin':
          part.obj.rotation.y = part.baseRotY + elapsed * 0.22 + part.phase * 0.1;
          break;
        case 'barrier':
          part.obj.rotation.z = part.baseRotZ + (Math.sin(elapsed * 0.5 + part.phase) * 0.5 + 0.5) * 1.05;
          break;
        case 'person':
          part.obj.position.y = part.baseY + Math.sin(t * 1.5) * 0.008;
          part.obj.rotation.z = part.baseRotZ + Math.sin(t * 0.7) * 0.006;
          break;
        case 'sway':
          part.obj.rotation.z = part.baseRotZ + Math.sin(t * 1.1) * 0.05;
          break;
        case 'lantern':
          part.obj.rotation.z = part.baseRotZ + Math.sin(t * 1.05) * 0.07;
          break;
        case 'bob':
          part.obj.position.y = part.baseY + Math.sin(t * 1.35) * 0.04;
          part.obj.rotation.z = part.baseRotZ + Math.sin(t * 0.9) * 0.012;
          break;
        case 'bird':
          part.obj.position.y = part.baseY + Math.abs(Math.sin(t * 2.1)) * 0.07;
          part.obj.rotation.y = part.baseRotY + Math.sin(t * 2.9) * 0.32;
          break;
        case 'glow': {
          const scl = 1 + Math.sin(t * 3.1) * 0.08;
          part.obj.scale.setScalar(part.baseScale * scl);
          break;
        }
        case 'steam': {
          part.obj.scale.y = part.baseScale * (1 + Math.sin(t * 1.6) * 0.05);
          break;
        }
        case 'steam2': {
          const mesh = part.obj as THREE.Mesh;
          mesh.scale.setScalar(1 + ((elapsed * 0.22 + part.phase * 0.1) % 1) * 0.9);
          mesh.position.y = part.baseY + ((elapsed * 0.32 + part.phase * 0.13) % 1) * 1.2;
          break;
        }
        case 'escalator': {
          const mesh = part.obj as THREE.Mesh;
          const mat = mesh.material as THREE.MeshBasicMaterial;
          if (mat.map) mat.map.offset.y = -elapsed * 0.42;
          break;
        }
        case 'rain': {
          const mesh = part.obj as THREE.Mesh;
          const show = weather === 'rain' || weather === 'storm' || weather === 'snow';
          mesh.visible = show;
          if (show) {
            const mat = mesh.material as THREE.MeshBasicMaterial;
            if (mat.map) mat.map.offset.y = -elapsed * (weather === 'storm' ? 1.4 : 0.55);
          }
          break;
        }
        case 'rain-far': {
          const mesh = part.obj as THREE.Mesh;
          const show = weather === 'rain' || weather === 'storm' || weather === 'snow';
          mesh.visible = show;
          if (show) {
            const mat = mesh.material as THREE.MeshBasicMaterial;
            if (mat.map) mat.map.offset.y = -elapsed * (weather === 'storm' ? 2.2 : 0.9);
          }
          break;
        }
        case 'door-l':
          part.obj.position.x = part.baseX - Math.max(0, Math.sin(elapsed * 0.55 + 1.2)) * 0.42;
          break;
        case 'door-r':
          part.obj.position.x = part.baseX + Math.max(0, Math.sin(elapsed * 0.55 + 1.2)) * 0.42;
          break;
        case 'blink': {
          const mesh = part.obj as THREE.Mesh;
          const mat = mesh.material as THREE.MeshBasicMaterial;
          const on = Math.sin(elapsed * 6.0) > 0;
          mat.color.setRGB(on ? 1 : 0.18, on ? 0.28 : 0.02, on ? 0.42 : 0.04);
          break;
        }
        case 'sky-night':
          part.obj.visible = night;
          break;
        case 'sky-day':
          part.obj.visible = !night;
          break;
        default:
          break;
      }
    }

    // ── 相機極輕微呼吸（室內固定取景） ──
    camera.position.x = camBase.x + Math.sin(elapsed * 0.21) * 0.04;
    camera.position.y = camBase.y + Math.sin(elapsed * 0.17 + 1.2) * 0.018;
    camera.lookAt(camLook);
  };

  update(state, 0);

  return {
    scene,
    camera,
    update,
    dispose(): void {
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mat of mats) {
            if (!mat) continue;
            // 只釋放逐場建立的材質（窗景日夜板），快取材質保留重用
            if (mat.userData?.owned) mat.dispose();
          }
        }
      });
      room.windowLight.shadow.map?.dispose();
      room.windowLight.dispose();
      room.hemi.dispose();
      room.ambient.dispose();
      for (const lamp of room.lamps) lamp.dispose();
      scene.clear();
    },
  };
}

/** 供 UI／除錯：列出所有建築對應的室內樣式 key（涵蓋全部 BUILDINGS）。 */
export function interiorStyleKeys(): { key: string; interior: string; name: string }[] {
  return Object.keys(BUILDINGS).map((key) => ({
    key,
    interior: BUILDINGS[key].interior ?? BUILDINGS[key].category,
    name: BUILDINGS[key].name,
  }));
}
