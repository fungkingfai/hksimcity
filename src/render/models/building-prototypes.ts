/**
 * 《維港之城》— 32 種香港建築的程序化低多邊形模型。
 *
 * 設計重點：
 *  - 每種建築都有可辨識的香港輪廓：唐樓騎樓＋霓虹招牌＋晾衫、劏房鐵窗花、
 *    公屋十字型／長型大廈＋米黃外牆、玻璃幕牆商廈、貨櫃碼頭龍門吊機、
 *    發電廠冷卻塔＋煙囪、天星小輪鐘樓碼頭、港鐵站出口……
 *  - 原型（prototype）每種變體只建立一次，`mergeStaticMeshes()` 合併同材質
 *    靜態 mesh，建築實例只 clone 原型、共用 geometry/material。
 *  - 需要每幀微動的節點由 hk-parts 標記 userData.anim（霓虹招牌搖曳、晾衫、
 *    煙囪蒸氣、吊機小車、挖掘機手臂、旗幟、雪糕車），BuildingsView 收集後做
 *    transform 動畫。
 *  - 模型原點在佔地中心、地面 y=0（BuildingsView 會把整個 group 抬到 y≈0.28）；
 *    「正面」朝 +z，BuildingsView 會依最近道路自動轉向（臨水建築轉向水面）。
 *
 * 效能：所有原型幾何只建立一次；每棟樓約 3~12 個 draw call。
 */

import * as THREE from 'three';
import { BUILDINGS, NEON_SIGNS, STREET_NAMES } from '../../core/config';
import type { BuildingDef } from '../../core/types';
import { TILE } from '../coords';
import { MaterialLibrary, PAL } from './materials';
import { addBeamBetween, addCone, addCylinder, addBox, addSphere, mergeStaticMeshes } from './geometry-utils';
import {
  addACUnit,
  addACUnitsRow,
  addAluminiumWindow,
  addArcade,
  addBambooScaffold,
  addBasketballHoop,
  addBorderFence,
  addCoach,
  addFreightTrain,
  addHeavyRail,
  addLedInfoBoard,
  addPassengerTrain,
  addRailPlatform,
  addRailSignal,
  addAerationTank,
  addAircraft,
  addBarrelRoof,
  addBoomBarrier,
  addBusShelter,
  addClarifierTank,
  addContainerTruck,
  addControlTower,
  addFloodlightMast,
  addGateBooth,
  addGatePortal,
  addJetBridge,
  addMinibus,
  addMinibusStopSign,
  addOutfallPipe,
  addRadarDish,
  addWaterTower,
  addBench,
  addBusCanopy,
  addBusStopFlag,
  addBikeRack,
  addCanopy,
  addChimney,
  addClockTower,
  addContainerStack,
  addCoolingTower,
  addCrossSign,
  addExcavator,
  addFacade,
  addFence,
  addFitnessCorner,
  addFlagpole,
  addFireHoseReel,
  addFootbridge,
  addGangway,
  addGantryCrane,
  addHazardStripe,
  addHelipad,
  addIceCreamVan,
  addIronGate,
  addLabelSign,
  addLampPost,
  addLaundryPole,
  addLedScreen,
  addLifeRing,
  addLitterBin,
  addMarketCanopy,
  addMtrEntrance,
  addNeonSign,
  addParkPavilion,
  addPilings,
  addPipeRun,
  addPlayground,
  addPodium,
  addPond,
  addPublicToilet,
  addPylon,
  addQueueRail,
  addRailing,
  addRedLamp,
  addRefuseRoom,
  addRockFace,
  addRollerDoor,
  addRooftopClutter,
  addRooftopTank,
  addSilo,
  addSmokePlume,
  addSpoilPile,
  addStall,
  addStairs,
  addStationNameBand,
  addStreetSign,
  addTaxiStand,
  addTower,
  addTramRails,
  addTramShelter,
  addTramWires,
  addTicketBooth,
  addTransformer,
  addTree,
  addQuay,
  addConveyor,
  addShopFront,
  hash01,
} from './hk-parts';

// ─────────────────────────── 原型型別（對外契約，保持不變） ───────────────────────────

export interface BuildingPrototype {
  key: string;
  variant: number;
  root: THREE.Group;
  /** 佔地世界尺寸（寬、深） */
  footprintW: number;
  footprintD: number;
}

export interface PrototypeFactory {
  /** 取得（必要時建立）建築原型；variant 會依 cap 循環。 */
  get(key: string, variant?: number): BuildingPrototype;
  variantCount(key: string): number;
  dispose(): void;
}

export interface Ctx {
  lib: MaterialLibrary;
  root: THREE.Group;
  def: BuildingDef;
  w: number;
  h: number;
  /** 佔地世界寬／深 */
  W: number;
  D: number;
  variant: number;
}

// ─────────────────────────── 通用小工具 ───────────────────────────

/** 佔地範圍內舖地台。 */
function pad(ctx: Ctx, color: number, inset = 0.12, y = 0.02): void {
  addBox(ctx.root, ctx.lib.lambert(color), ctx.W - inset, 0.04, ctx.D - inset, 0, y, 0);
}

/** 瀝青地台 + 黃線。 */
function asphaltPad(ctx: Ctx, lines = false): void {
  pad(ctx, PAL.roadAsphalt, 0.1, 0.03);
  if (lines) {
    const line = ctx.lib.lambert(PAL.roadLine);
    addBox(ctx.root, line, ctx.W * 0.5, 0.012, 0.07, ctx.W * 0.18, 0.055, ctx.D * 0.28);
    addBox(ctx.root, line, ctx.W * 0.5, 0.012, 0.07, ctx.W * 0.18, 0.055, -ctx.D * 0.28);
  }
}

/** 草地地台。 */
function grassPad(ctx: Ctx): void {
  pad(ctx, PAL.leafDark, 0.1, 0.03);
}

/** 霓虹招牌文字（依 key／variant 取固定文字）。 */
function signText(ctx: Ctx, offset = 0, pool: readonly string[] = NEON_SIGNS): string {
  const seed = ctx.variant * 31 + ctx.def.key.length * 7 + offset * 13;
  return pool[Math.floor(hash01(seed) * pool.length) % pool.length];
}

/** 舖面簷篷（斜篷布）。 */
function addAwning(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  w: number,
  ry = 0,
  color: number = PAL.clothRed,
  depth = 0.55,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  const canopy = addBox(g, lib.lambert(color), w, 0.05, depth, 0, 0, depth / 2);
  canopy.rotation.x = 0.28;
  // 間條
  const stripeMat = lib.lambert(PAL.clothWhite);
  for (let i = 0; i < 3; i++) {
    addBox(g, stripeMat, w * 0.12, 0.056, depth, -w * 0.36 + i * w * 0.34, 0, depth / 2).rotation.x = 0.28;
  }
  // 支撐
  addBox(g, lib.lambert(PAL.ironDark), 0.03, 0.8, 0.03, -w / 2 + 0.05, -0.4, depth - 0.05);
  addBox(g, lib.lambert(PAL.ironDark), 0.03, 0.8, 0.03, w / 2 - 0.05, -0.4, depth - 0.05);
  return g;
}

/** 天台大字招牌（鋼架＋霓虹字，可微動）。 */
function addRoofSign(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  text: string,
  color: number,
  w = 2.0,
  anim = true,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  const frame = lib.lambert(PAL.steelGrey);
  addBox(g, frame, 0.06, 0.7, 0.06, -w * 0.38, 0.35, 0);
  addBox(g, frame, 0.06, 0.7, 0.06, w * 0.38, 0.35, 0);
  addBox(g, frame, w, 0.05, 0.05, 0, 0.68, 0);
  addBox(g, frame, 0.05, 0.3, 0.05, -w * 0.38, 0.15, 0.18).rotation.x = 0.5;
  addBox(g, frame, 0.05, 0.3, 0.05, w * 0.38, 0.15, 0.18).rotation.x = 0.5;
  const sign = addNeonSign(g, lib, {
    text,
    x: 0,
    y: 1.0,
    z: 0,
    vertical: false,
    color,
    w,
    h: w * 0.26,
    anim,
  });
  sign.position.y = 1.0;
  return g;
}

/** 掛在牆角、伸出街的直式霓虹招牌（香港招牌經典）。 */
function addPerpSign(
  ctx: Ctx,
  y: number,
  text: string,
  color: number,
  side = 1,
  anim = true,
  h = 0.95,
): void {
  addNeonSign(ctx.root, ctx.lib, {
    text,
    x: (ctx.W / 2 - 0.04) * side,
    y,
    z: ctx.D / 2 - 0.55,
    ry: (Math.PI / 2) * side,
    vertical: true,
    color,
    w: 0.32,
    h,
    anim,
  });
}

/** 鐵窗花（劏房／舊樓）— 一個向外凸出的金屬籠。 */
function addWindowCage(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  ry = 0,
  seed = 0,
): void {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  parent.add(g);
  const mat = lib.lambert(hash01(seed) > 0.5 ? PAL.rust : PAL.iron);
  const d = 0.14;
  addBox(g, mat, w, 0.022, d, 0, h / 2, d / 2);
  addBox(g, mat, w, 0.022, d, 0, -h / 2, d / 2);
  addBox(g, mat, 0.022, h, d, -w / 2, 0, d / 2);
  addBox(g, mat, 0.022, h, d, w / 2, 0, d / 2);
  for (let i = 0; i < 3; i++) {
    addBox(g, mat, 0.018, h, d, -w / 2 + (w / 4) * (i + 1), 0, d / 2);
  }
  addBox(g, mat, w, 0.018, 0.02, 0, 0, d);
  // 窗台上雜物（盆栽）
  if (hash01(seed + 3.7) > 0.5) {
    addCylinder(g, lib.lambert(PAL.clothRed), 0.05, 0.04, 0.07, w * 0.2, -h / 2 + 0.04, d - 0.03, 6);
  }
}

/** 一排鐵窗花＋冷氣機（劏房外牆）。 */
function addCageRow(
  ctx: Ctx,
  z: number,
  ry: number,
  y0: number,
  floors: number,
  floorH: number,
  count: number,
  seed: number,
): void {
  for (let f = 0; f < floors; f++) {
    const cy = y0 + floorH * f + floorH * 0.52;
    for (let c = 0; c < count; c++) {
      const cx = -ctx.W / 2 + (ctx.W / (count + 1)) * (c + 1);
      addWindowCage(ctx.root, ctx.lib, cx, cy, z, 0.3, 0.36, ry, seed + f * 5 + c);
      if (hash01(seed + f * 3.3 + c * 7.1) > 0.55) {
        addACUnit(ctx.root, ctx.lib, cx + 0.22, cy - 0.24, z, ry, 0.8);
      }
    }
  }
}

/** 外牆明喉（舊樓去水管／電線管）。 */
function addWallPipes(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  h: number,
  seed = 0,
): void {
  const mat = lib.lambert(hash01(seed) > 0.5 ? PAL.rust : PAL.ironDark);
  addCylinder(parent, mat, 0.025, 0.025, h, x, h / 2, z, 5);
  addCylinder(parent, mat, 0.02, 0.02, h * 0.7, x + 0.09, h * 0.35, z, 5);
}

/** 天台樓梯屋。 */
function addStairhood(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  color: number = PAL.concreteLight,
): void {
  addBox(parent, lib.lambert(color), 0.5, 0.5, 0.5, x, y + 0.25, z);
  addBox(parent, lib.lambert(PAL.ironDark), 0.2, 0.32, 0.03, x, y + 0.16, z + 0.26);
}

/** 天台公用天線陣（公屋／舊樓）。 */
function addAntennaFarm(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  w: number,
  d: number,
  y: number,
  seed = 0,
): void {
  for (let i = 0; i < 3; i++) {
    const x = (hash01(seed + i * 2.3) - 0.5) * w * 0.7;
    const z = (hash01(seed + i * 5.1) - 0.5) * d * 0.6;
    addCylinder(parent, lib.lambert(PAL.ironDark), 0.015, 0.02, 0.7 + hash01(seed + i) * 0.7, x, y + 0.5, z, 5);
    addBox(parent, lib.lambert(PAL.ironDark), 0.34, 0.015, 0.015, x, y + 0.85, z);
    addBox(parent, lib.lambert(PAL.ironDark), 0.12, 0.015, 0.015, x, y + 1.0, z);
  }
}

/** 地面一層店舖招牌橫額（無發光，日間也清晰）。 */
function addShopSignBand(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  text: string,
  bg: string,
  fg: string,
  w = 1.4,
  ry = 0,
): void {
  addBox(parent, lib.lambert(PAL.ironDark), w + 0.05, 0.34, 0.06, x, y, z, ry);
  const mat = lib.label(text, { w: 512, h: 112, bg, fg, border: fg, fontScale: 0.56 });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.3), mat);
  face.position.set(x, y, z + 0.04);
  face.rotation.y = ry;
  if (ry) {
    // 旋轉後需要沿法線偏移
    const off = 0.04;
    face.position.set(x + Math.sin(ry) * off, y, z + Math.cos(ry) * off);
  }
  parent.add(face);
}

// ═══════════════════════════ 住宅（6 種） ═══════════════════════════

/** 唐樓：4~5 層、騎樓底、霓虹招牌、晾衫、天台水塔。 */
function buildTongLau(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  const wallColors = [PAL.tongLauBrick, PAL.paintGreen, PAL.paintYellow, PAL.paintBlue];
  const wallColor = wallColors[v % wallColors.length];
  const floors = 4 + (v % 2);
  const arcadeH = 0.92;
  const floorH = 0.46;
  const bodyH = floors * floorH;
  const topY = arcadeH + bodyH;

  // 地台 + 騎樓
  pad(ctx, PAL.concreteDark, 0.08, 0.02);
  addArcade(root, lib, W - 0.12, D - 0.12, {
    y0: 0.02,
    height: arcadeH,
    depth: 0.5,
    columnColor: v % 2 === 0 ? PAL.concreteLight : PAL.wallGrey,
    seed: v,
  });

  // 上層樓宇（磚牆窗格）
  const style = 'brick';
  const tower = addTower(root, lib, {
    w: W - 0.14,
    d: D - 0.2,
    h: bodyH,
    y0: arcadeH + 0.04,
    style,
    wallColor,
    roofColor: v % 2 === 0 ? PAL.ironDark : PAL.concreteDark,
    facades: 'all',
    repeatMul: v % 2 === 0 ? 1 : 1.1,
  });
  // 外牆油漆色帶（每層）
  for (let f = 0; f < floors; f++) {
    const y = arcadeH + 0.04 + floorH * f + 0.03;
    addBox(root, lib.lambert(wallColor), W - 0.1, 0.06, D - 0.16, 0, y, 0);
  }
  // 3D 鋁窗（正面）＋冷氣機
  for (let f = 0; f < floors; f++) {
    const cy = arcadeH + 0.04 + floorH * f + floorH * 0.55;
    for (let c = 0; c < 2; c++) {
      const cx = -0.4 + c * 0.8;
      const lit = hash01(v * 11 + f * 3.1 + c * 5.7) > 0.55;
      addAluminiumWindow(root, lib, cx, cy, D / 2 - 0.1 + 0.02, 0.34, 0.3, 0, { lit, bars: v === 1 });
      if (hash01(v + f + c * 2.3) > 0.5) addACUnit(root, lib, cx + 0.3, cy - 0.2, D / 2 - 0.1, 0, 0.8);
    }
  }
  // 側面晾衫竹
  addLaundryPole(root, lib, W / 2 - 0.02, arcadeH + floorH * 1.6, 0.15, 1.0, Math.PI / 2, v + 1);
  addLaundryPole(root, lib, W / 2 - 0.02, arcadeH + floorH * 2.8, -0.5, 0.9, Math.PI / 2, v + 7);
  // 招牌
  addNeonSign(root, lib, {
    text: signText(ctx, 0, ['大藥房', '金行', '燒臘', '涼茶', '鐘錶', '押']),
    x: 0,
    y: arcadeH + 0.2,
    z: D / 2 + 0.06,
    vertical: false,
    color: v % 2 === 0 ? PAL.neonPink : PAL.neonGold,
    w: 1.3,
    h: 0.34,
    anim: false,
  });
  addPerpSign(ctx, topY - 0.9, signText(ctx, 1, ['跌打', '找換', '麻雀', '眼鏡', '髮廊']), v % 2 === 0 ? PAL.neonCyan : PAL.neonPink, 1, true, 1.0);
  // 天台
  addBox(root, lib.lambert(PAL.concreteLight), W - 0.18, 0.1, D - 0.24, 0, topY + 0.05, 0);
  addRooftopTank(root, lib, -W * 0.2, topY + 0.1, -D * 0.15, 0.9);
  addAntennaFarm(root, lib, W, D, topY + 0.1, v + 3);
  addStairhood(root, lib, W * 0.22, topY + 0.1, -D * 0.12);
  // 地面雜物
  addLitterBin(root, lib, -W / 2 + 0.25, D / 2 + 0.12);
  addBox(root, lib.lambert(PAL.woodLight), 0.34, 0.3, 0.3, W / 2 - 0.3, 0.17, D / 2 + 0.2);
  if (v === 2) {
    addBambooScaffold(root, lib, -W / 2 + 0.05, 0.1, 0.2, 0.5, topY - 0.1, Math.PI / 2, v);
  }
  // 側面後巷明喉
  addWallPipes(root, lib, -W / 2 - 0.02, 0.3, topY - 0.2, v);
  void tower;
}

/** 劏房：舊樓分間、窗戶密、鐵窗花、喉管、天台水箱。 */
function buildSubdividedFlat(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  const h = 2.7 + (v % 2) * 0.35;
  pad(ctx, PAL.concreteDark, 0.06, 0.02);
  // 舊樓主體（米灰／灰紅）
  addTower(root, lib, {
    w: W - 0.12,
    d: D - 0.14,
    h,
    style: 'brick',
    wallColor: v === 0 ? 0x8a7a6a : PAL.paintPink,
    roofColor: PAL.concreteDark,
    repeatMul: 1.15,
  });
  // 地舖 + 鐵閘
  addShopFront(root, lib, 0, 0.04, D / 2 - 0.06, W - 0.5, 0.72, 0);
  addIronGate(root, lib, 0, 0.04, D / 2 - 0.02, 0.9, 0.75, 0, v === 0 ? 0.3 : 0);
  // 密窗＋鐵窗花
  const floors = 4;
  const floorH = 0.55;
  addCageRow(ctx, D / 2 + 0.02, 0, 0.85, floors, floorH, 3, v + 1);
  addCageRow(ctx, -D / 2 - 0.02, Math.PI, 0.85, floors, floorH, 3, v + 5);
  // 側面窗花
  for (let f = 0; f < floors; f++) {
    const cy = 0.85 + floorH * f + 0.28;
    addWindowCage(root, lib, W / 2 + 0.02, cy, 0.2, 0.3, 0.34, Math.PI / 2, v + f);
    addWindowCage(root, lib, W / 2 + 0.02, cy, -0.4, 0.3, 0.34, Math.PI / 2, v + f + 9);
  }
  // 喉管
  addWallPipes(root, lib, W / 2 + 0.04, -0.35, h - 0.1, v);
  addWallPipes(root, lib, -W / 2 - 0.04, 0.3, h - 0.2, v + 2);
  // 天台水箱＋晾衫＋天線
  const topY = h;
  addBox(root, lib.lambert(PAL.concrete), W - 0.16, 0.08, D - 0.16, 0, topY + 0.04, 0);
  addRooftopTank(root, lib, -W * 0.18, topY + 0.08, -D * 0.15, 1.0);
  addRooftopTank(root, lib, W * 0.2, topY + 0.08, -D * 0.2, 0.75, PAL.steelGrey);
  addLaundryPole(root, lib, W * 0.12, topY + 0.4, D * 0.1, 1.1, 0.4, v + 11);
  addAntennaFarm(root, lib, W, D, topY + 0.1, v + 13);
  // 招牌
  addPerpSign(ctx, 1.55, signText(ctx, 2, ['按摩', '旅館', '跌打', '理髮', '麻雀']), PAL.neonCyan, -1, true, 0.9);
  addShopSignBand(root, lib, 0, 0.84, D / 2 + 0.05, '分間單位', '#1b2b33', '#ffd166', 1.0);
  // 垃圾／雜物
  addLitterBin(root, lib, W / 2 - 0.25, D / 2 + 0.1);
  if (v === 1) {
    addBambooScaffold(root, lib, W / 2 - 0.03, 0.1, 0, 0.55, h, Math.PI / 2, v);
  }
}

/** 公共屋邨：十字型／長型大廈，米黃外牆＋綠腰線＋晾衫。 */
function buildPublicHousing(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  const h = 6.4;
  const cream = v === 0 ? PAL.publicHousingCream : PAL.tileWhite;
  const accent = v === 0 ? PAL.publicHousingGreen : PAL.hosBlue;
  pad(ctx, PAL.leafDark, 0.14, 0.02);
  // 平台
  addPodium(root, lib, W - 0.3, D - 0.3, 0.26, { color: PAL.concreteLight, trim: PAL.concreteDark });

  const block = (x: number, z: number, w: number, d: number, height: number): void => {
    addTower(root, lib, {
      x,
      z,
      w,
      d,
      h: height,
      y0: 0.26,
      style: 'publicHousing',
      wallColor: cream,
      roofColor: PAL.concrete,
      repeatMul: 1.1,
    });
    // 綠腰線（每 2 層）
    for (let i = 1; i < 7; i += 2) {
      addBox(root, lib.lambert(accent), w + 0.05, 0.1, d + 0.05, x, 0.26 + (height / 7) * i, z);
    }
  };

  if (v === 0) {
    // 十字型：中央核心 + 四翼
    block(0, 0, 1.3, 1.3, h);
    block(0, -1.3, 0.95, 1.35, h * 0.94);
    block(0, 1.3, 0.95, 1.35, h * 0.94);
    block(1.35, 0, 1.35, 0.95, h * 0.94);
    block(-1.35, 0, 1.35, 0.95, h * 0.94);
    // 核心機房
    addBox(root, lib.lambert(PAL.concrete), 1.8, 0.5, 1.8, 0, 0.26 + h + 0.25, 0);
  } else {
    // 長型大廈：兩座平行 + 中央樓梯／電梯塔
    block(0.95, 0, 0.95, 3.1, h);
    block(-0.95, 0, 0.95, 3.1, h * 0.92);
    block(0, 0.1, 0.7, 0.9, h + 0.35);
  }

  // 天台水箱、天線、晾衫
  const topY = 0.26 + h;
  addRooftopTank(root, lib, -0.5, topY, -0.4, 1.0, PAL.aluminium);
  addRooftopTank(root, lib, 0.55, topY, 0.5, 0.85, PAL.steelGrey);
  addAntennaFarm(root, lib, W * 0.9, D * 0.9, topY, v + 21);
  for (let i = 0; i < 4; i++) {
    const px = -1.4 + i * 0.95;
    addLaundryPole(root, lib, px, topY - 1.2 - (i % 2) * 1.4, D / 2 + 0.02, 0.9, 0, v + i * 3);
  }
  // 平台花園、長椅、樹
  addTree(root, lib, -W * 0.38, D * 0.36, 0.55, 'banyan', v + 1, 0.26);
  addTree(root, lib, W * 0.38, -D * 0.36, 0.5, 'flower', v + 2, 0.26);
  addBench(root, lib, W * 0.2, D * 0.38, Math.PI, 0.26);
  // 屋邨名牌
  addLabelSign(root, lib, {
    text: v === 0 ? '彩虹邨' : '華富邨',
    sub: 'PUBLIC HOUSING ESTATE',
    x: 0,
    y: 0.9,
    z: D / 2 + 0.1,
    w: 1.6,
    h: 0.4,
    bg: '#1f5f3f',
    fg: '#f2f5ee',
    border: '#f2f5ee',
  });
  // 屋邨遊樂場
  addPlayground(root, lib, W * 0.32, D * 0.3, 0.6, 0.26);
  addRefuseRoom(root, lib, W / 2 - 0.4, -D / 2 + 0.4, 1.1, 0.7, Math.PI);
  addFireHoseReel(root, lib, -W * 0.3, 1.1, D / 2 + 0.05, 0);
}

/** 居屋苑：三座粉／藍色小塔＋平台會所。 */
function buildHOSFlat(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  const accent = v === 0 ? PAL.hosPink : PAL.hosBlue;
  const h = 5.0 + (v % 2) * 0.4;
  pad(ctx, PAL.leafDark, 0.12, 0.02);
  addPodium(root, lib, W - 0.3, D - 0.3, 0.24, { color: PAL.concreteLight, trim: accent });
  const tower = (x: number, z: number, height: number, style: 'hos' | 'tile' = 'hos'): void => {
    addTower(root, lib, {
      x,
      z,
      w: 0.9,
      d: 0.9,
      h: height,
      y0: 0.24,
      style,
      wallColor: accent,
      roofColor: PAL.concreteLight,
    });
    // 露台／窗台橫線
    for (let f = 1; f <= 6; f++) {
      addBox(root, lib.lambert(PAL.tileWhite), 1.0, 0.05, 1.0, x, 0.24 + (height / 6) * f, z);
    }
  };
  if (v === 0) {
    tower(-0.95, -0.85, h);
    tower(0.85, -0.85, h - 0.3);
    tower(0.0, 0.95, h + 0.2);
  } else {
    tower(-0.9, 0.15, h);
    tower(0.9, 0.15, h);
    // 低座會所
    addTower(root, lib, { x: 0, z: -1.1, w: 1.8, d: 0.8, h: 1.2, y0: 0.24, style: 'tile', wallColor: PAL.tileWhite });
    addBox(root, lib.lambert(accent), 1.84, 0.1, 0.84, 0, 1.49, -1.1);
  }
  // 天台水箱、天線
  const topY = 0.24 + h + 0.1;
  addRooftopTank(root, lib, -0.95, topY, -0.85, 0.8);
  addAntennaFarm(root, lib, W * 0.6, D * 0.6, topY, v + 31);
  // 晾衫
  addLaundryPole(root, lib, 0.8, 0.24 + h * 0.55, D / 2 - 0.3, 0.9, 0.2, v + 5);
  // 綠化、長椅、名牌
  addTree(root, lib, -W * 0.4, D * 0.38, 0.5, 'flower', v + 1, 0.24);
  addTree(root, lib, W * 0.4, D * 0.4, 0.45, 'banyan', v + 2, 0.24);
  addBench(root, lib, 0.4, D * 0.42, Math.PI, 0.24);
  addLabelSign(root, lib, {
    text: v === 0 ? '居屋苑' : '愉翠苑',
    sub: 'HOME OWNERSHIP SCHEME',
    x: 0,
    y: 0.95,
    z: D / 2 + 0.12,
    w: 1.5,
    h: 0.38,
    bg: '#7a4a6a',
    fg: '#ffffff',
    border: '#ffffff',
  });
  addBusStopFlag(root, lib, W / 2 - 0.35, D / 2 + 0.3, '2 8 9', { ry: Math.PI, y: 0.24 });
}

/** 私人屋苑：玻璃露台塔樓＋平台花園／泳池。 */
function buildPrivateEstate(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  const h = 5.6 + (v % 2) * 0.6;
  pad(ctx, PAL.leafDark, 0.1, 0.02);
  addPodium(root, lib, W - 0.26, D - 0.26, 0.28, { color: PAL.concreteLight, trim: PAL.neonCyan });
  const tower = (x: number, z: number, height: number, w = 1.0, d = 1.0): void => {
    addTower(root, lib, {
      x,
      z,
      w,
      d,
      h: height,
      y0: 0.28,
      style: 'glassBlue',
      wallColor: PAL.wallGrey,
      roofColor: PAL.concreteLight,
    });
    // 玻璃露台層
    for (let f = 1; f <= 8; f++) {
      const fy = 0.28 + (height / 8) * f;
      addBox(root, lib.lambert(PAL.tileWhite), w + 0.12, 0.05, d + 0.12, x, fy, z);
      addBox(
        root,
        lib.lambert(PAL.glassBlue, { transparent: true, opacity: 0.35 }),
        w + 0.1,
        0.08,
        0.02,
        x,
        fy + 0.06,
        z + d / 2 + 0.06,
      );
    }
  };
  if (v === 0) {
    tower(-0.9, -0.9, h);
    tower(0.9, -0.9, h + 0.3);
    tower(0, 0.9, h - 0.4, 1.2, 0.9);
    // 泳池
    addBox(root, lib.lambert(PAL.poolWater, { emissive: 0x123a4a, emissiveIntensity: 0.25 }), 1.5, 0.06, 0.9, -0.7, 0.32, 1.1);
    addRailing(root, lib, -1.45, 1.55, 0.05, 1.55, 0.4, { y: 0.3, color: PAL.aluminium });
  } else {
    tower(-1.0, 0.2, h + 0.4, 0.95, 1.1);
    tower(0.2, 0.2, h, 1.2, 1.1);
    tower(1.15, -1.0, h - 0.6, 0.9, 0.9);
    addTree(root, lib, -1.2, 1.2, 0.55, 'palm', v + 2, 0.28);
    addTree(root, lib, 1.2, 1.2, 0.5, 'flower', v + 3, 0.28);
  }
  // 會所
  addTower(root, lib, { x: -0.1, z: -1.35, w: 1.6, d: 0.7, h: 1.0, y0: 0.28, style: 'glassTeal', wallColor: PAL.tileWhite });
  addLabelSign(root, lib, {
    text: v === 0 ? '私人屋苑' : '海景花園',
    sub: 'PRIVATE ESTATE',
    x: 0,
    y: 1.0,
    z: D / 2 + 0.1,
    w: 1.6,
    h: 0.4,
    bg: '#1b2b33',
    fg: '#ffd166',
    border: '#ffd166',
  });
  // 園林
  addTree(root, lib, W * 0.38, D * 0.38, 0.5, 'banyan', v + 5, 0.28);
  addBench(root, lib, -W * 0.35, D * 0.4, Math.PI * 0.9, 0.28);
  addLampPost(root, lib, W * 0.35, -D * 0.3, 1.5, { y: 0.28 });
  // 天台
  const topY = 0.28 + h + 0.1;
  addRooftopTank(root, lib, -0.9, topY, -0.9, 0.8);
  addAntennaFarm(root, lib, W * 0.7, D * 0.7, topY, v + 41);
  addBox(root, lib.lambert(PAL.concreteLight), 0.7, 0.3, 0.6, 0.6, topY + 0.15, -0.2);
  // 名牌霓虹
  addNeonSign(root, lib, {
    text: '海景',
    x: -W * 0.2,
    y: 0.28 + h * 0.6,
    z: D / 2 + 0.05,
    vertical: true,
    color: PAL.neonCyan,
    w: 0.5,
    h: 1.1,
    anim: true,
  });
}

/** 豪宅：高層玻璃塔＋金光冠頂＋入口門廊。 */
function buildLuxuryTower(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  const h = 8.6 + (v % 2) * 1.2;
  pad(ctx, PAL.concreteLight, 0.08, 0.03);
  addPodium(root, lib, W - 0.4, D - 0.4, 0.3, { color: PAL.luxurySilver, trim: PAL.neonGold });

  const tower = (x: number, z: number, height: number, w: number, d: number): void => {
    // 主塔
    addTower(root, lib, {
      x,
      z,
      w,
      d,
      h: height,
      y0: 0.3,
      style: 'glassTeal',
      wallColor: PAL.glassTeal,
      roofColor: PAL.luxurySilver,
      roofBand: PAL.neonGold,
    });
    // 退台（頂部兩層收窄）
    addTower(root, lib, {
      x,
      z,
      w: w * 0.8,
      d: d * 0.8,
      h: height * 0.12,
      y0: 0.3 + height,
      style: 'glassTeal',
      wallColor: PAL.luxurySilver,
      roofColor: PAL.luxurySilver,
      roofBand: PAL.neonGold,
    });
    // 露台橫線
    for (let f = 1; f <= 10; f++) {
      addBox(root, lib.lambert(PAL.luxurySilver), w + 0.1, 0.04, d + 0.1, x, 0.3 + (height / 10) * f, z);
    }
    // 天台直升機坪標記＋天線
    addCylinder(root, lib.lambert(PAL.concreteDark), 0.3, 0.3, 0.05, x, 0.3 + height * 1.12 + 0.02, z, 10);
    addCylinder(root, lib.lambert(PAL.ironDark), 0.02, 0.03, 1.2, x, 0.3 + height * 1.12 + 0.6, z, 5);
    addSphere(root, lib.neonTube(PAL.neonRed), 0.04, x, 0.3 + height * 1.12 + 1.22, z, 5, 4);
  };
  if (v === 0) {
    tower(0, 0, h, 1.5, 1.5);
  } else {
    tower(-0.45, -0.3, h, 1.1, 1.1);
    tower(0.5, 0.25, h - 1.2, 1.0, 1.0);
  }
  // 入口門廊
  addBox(root, lib.lambert(PAL.luxurySilver), 1.2, 0.08, 0.5, 0, 0.58, D / 2 - 0.2);
  addCylinder(root, lib.lambert(PAL.neonGold), 0.04, 0.05, 0.55, -0.55, 0.3, D / 2 - 0.2, 6);
  addCylinder(root, lib.lambert(PAL.neonGold), 0.04, 0.05, 0.55, 0.55, 0.3, D / 2 - 0.2, 6);
  // 棕櫚
  addTree(root, lib, -W * 0.38, D * 0.36, 0.6, 'palm', v + 1, 0.3);
  addTree(root, lib, W * 0.38, D * 0.36, 0.6, 'palm', v + 2, 0.3);
  // 名牌
  addNeonSign(root, lib, {
    text: v === 0 ? '半山壹號' : '維港峰',
    x: 0,
    y: 0.92,
    z: D / 2 + 0.08,
    vertical: false,
    color: PAL.neonGold,
    w: 1.5,
    h: 0.32,
    anim: false,
  });
  // 保安亭
  addBox(root, lib.lambert(PAL.glassDark), 0.5, 0.6, 0.4, -W * 0.35, 0.6, D / 2 - 0.15);
  addBox(root, lib.lambert(PAL.luxurySilver), 0.56, 0.08, 0.46, -W * 0.35, 0.94, D / 2 - 0.15);
}

// ═══════════════════════════ 工業（6 種：農田、石礦場、工廈、食品廠、發電廠、水務） ═══════════════════════════

/** 農田：田壟／菜田、溫室、小農舍、菜籮（新界鄉郊感）。 */
function buildFarm(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  grassPad(ctx);
  // 泥路
  addBox(root, lib.lambert(PAL.earth), W - 0.3, 0.03, 0.3, 0, 0.05, 0.4);
  if (v === 0) {
    // 菜田田壟（一行行）
    for (let row = 0; row < 4; row++) {
      const z = -D / 2 + 0.45 + row * 0.55;
      addBox(root, lib.lambert(PAL.soil), W * 0.52, 0.08, 0.28, -W * 0.18, 0.09, z);
      for (let i = 0; i < 5; i++) {
        const c = [PAL.crop, PAL.leaf, PAL.cropGold][i % 3];
        addBox(root, lib.lambert(c), 0.16, 0.14, 0.2, -W * 0.42 + i * 0.42, 0.18, z);
      }
    }
    // 溫室
    addBox(root, lib.lambert(PAL.glassBlue, { transparent: true, opacity: 0.35 }), 1.4, 0.9, 1.2, W * 0.24, 0.45, -D * 0.2);
    addBox(root, lib.lambert(PAL.aluminium), 1.44, 0.05, 1.24, W * 0.24, 0.92, -D * 0.2);
    addBox(root, lib.lambert(PAL.aluminium), 0.05, 0.9, 1.24, W * 0.24 - 0.7, 0.45, -D * 0.2);
    addBox(root, lib.lambert(PAL.aluminium), 0.05, 0.9, 1.24, W * 0.24 + 0.7, 0.45, -D * 0.2);
  } else {
    // 水田（稻米）
    addBox(root, lib.lambert(PAL.poolWater), W * 0.66, 0.04, D * 0.42, -W * 0.1, 0.05, -D * 0.16);
    for (let row = 0; row < 3; row++) {
      const z = -D * 0.3 + row * 0.4;
      for (let i = 0; i < 6; i++) {
        addBox(root, lib.lambert(PAL.cropGold), 0.12, 0.22, 0.12, -W * 0.36 + i * 0.28, 0.16, z);
      }
    }
    // 小農舍
    addBox(root, lib.lambert(PAL.wallCream), 1.0, 0.7, 0.8, W * 0.28, 0.35, D * 0.24);
    addBox(root, lib.lambert(PAL.tileDark), 1.16, 0.12, 0.96, W * 0.28, 0.76, D * 0.24);
    addBox(root, lib.lambert(PAL.woodDark), 0.26, 0.45, 0.04, W * 0.28 + 0.24, 0.24, D * 0.24 + 0.42);
  }
  // 農舍（variant 0 的簡屋）
  if (v === 0) {
    addBox(root, lib.lambert(PAL.wallCream), 0.9, 0.65, 0.7, -W * 0.34, 0.33, D * 0.34);
    addBox(root, lib.lambert(PAL.tileDark), 1.04, 0.1, 0.84, -W * 0.34, 0.7, D * 0.34);
    addBox(root, lib.lambert(PAL.woodDark), 0.22, 0.4, 0.04, -W * 0.34, 0.22, D * 0.34 + 0.36);
  }
  // 菜籮／竹籃
  for (let i = 0; i < 3; i++) {
    addCylinder(root, lib.lambert(PAL.bamboo), 0.14, 0.11, 0.12, W * 0.3 + i * 0.28, 0.1, D * 0.05, 7);
    addCylinder(root, lib.lambert(PAL.leaf), 0.1, 0.1, 0.03, W * 0.3 + i * 0.28, 0.17, D * 0.05, 7);
  }
  // 稻草人／竹枝
  addCylinder(root, lib.lambert(PAL.wood), 0.025, 0.025, 1.1, -W * 0.34, 0.6, -D * 0.24, 5);
  addBox(root, lib.lambert(PAL.wood), 0.5, 0.03, 0.03, -W * 0.34, 0.85, -D * 0.24);
  addBox(root, lib.lambert(PAL.clothYellow), 0.22, 0.26, 0.2, -W * 0.34, 0.92, -D * 0.24);
  // 樹
  addTree(root, lib, W * 0.42, -D * 0.4, 0.5, 'banyan', v + 3, 0.02);
  addTree(root, lib, -W * 0.44, -D * 0.42, 0.4, 'flower', v + 4, 0.02);
  addFence(root, lib, -W / 2 + 0.1, D / 2 - 0.08, W / 2 - 0.1, D / 2 - 0.08, 0.5, { color: PAL.wood, mesh: false });
  addLabelSign(root, lib, {
    text: v === 0 ? '農田' : '稻田',
    sub: 'FARM',
    x: 0,
    y: 0.5,
    z: D / 2 - 0.02,
    w: 0.8,
    h: 0.22,
    bg: '#e8ece8',
    fg: '#1f6b45',
    border: '#1f6b45',
  });
}

/** 石礦場：開山爆破面、開採台階、輸送帶、挖掘機、碎石堆。 */
function buildQuarry(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  // 碎石地
  pad(ctx, PAL.gravel, 0.06, 0.03);
  addBox(root, lib.lambert(PAL.rockDark), W - 0.4, 0.06, D - 0.4, 0, 0.06, 0);
  // 岩面（後方＋左方）
  addRockFace(root, lib, 0, 0.05, -D / 2 + 0.25, W - 0.3, 1.8, 0, v + 1);
  addRockFace(root, lib, -W / 2 + 0.25, 0.05, 0, D - 1.0, 1.5, Math.PI / 2, v + 2);
  if (v === 1) addRockFace(root, lib, W / 2 - 0.25, 0.05, -0.3, D - 1.2, 1.2, -Math.PI / 2, v + 3);
  // 石堆
  addSpoilPile(root, lib, W * 0.22, 0.5, 0.9, 0.05);
  addSpoilPile(root, lib, W * 0.34, -D * 0.1, 0.6, 0.05, PAL.rockDark);
  addSpoilPile(root, lib, -W * 0.1, D * 0.18, 0.55, 0.05);
  // 輸送帶
  addConveyor(root, lib, -0.5, 0.4, -D * 0.2, W * 0.18, 1.1, D * 0.1);
  // 挖掘機
  addExcavator(root, lib, -W * 0.22, D * 0.16, -0.7, 0.05);
  addExcavator(root, lib, W * 0.1, -D * 0.08, 0.8, 0.05, PAL.cargoOrange);
  // 水池（沉澱池）
  addBox(root, lib.lambert(PAL.poolWater), 0.9, 0.04, 0.6, -W * 0.28, 0.08, D * 0.3);
  addRailing(root, lib, -W * 0.28 - 0.5, D * 0.3 - 0.35, -W * 0.28 + 0.5, D * 0.3 - 0.35, 0.4, { y: 0.04, color: PAL.hazardYellow });
  // 工地圍欄＋警示牌
  addFence(root, lib, -W / 2 + 0.08, D / 2 - 0.1, W / 2 - 0.08, D / 2 - 0.1, 0.9, { color: PAL.hazardYellow });
  addBox(root, lib.lambert(PAL.hazardYellow), 0.7, 0.4, 0.04, -W * 0.32, 1.0, D / 2 - 0.05);
  const warn = lib.label('爆破區', { w: 256, h: 128, bg: '#d9b23f', fg: '#2a2a2a', border: '#2a2a2a' });
  const warnFace = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.3), warn);
  warnFace.position.set(-W * 0.32, 1.0, D / 2 - 0.02);
  root.add(warnFace);
  // 工地辦公室（貨櫃）
  addBox(root, lib.lambert(PAL.wallWhite), 1.0, 0.55, 0.5, W * 0.35, 0.33, D * 0.34);
  addBox(root, lib.lambert(PAL.cargoBlue), 1.02, 0.08, 0.52, W * 0.35, 0.62, D * 0.34);
  addBox(root, lib.lambert(PAL.glassDark), 0.3, 0.2, 0.02, W * 0.35, 0.38, D * 0.34 + 0.26);
  // 告示牌
  addLabelSign(root, lib, {
    text: '石礦場',
    sub: 'QUARRY',
    x: 0,
    y: 0.9,
    z: D / 2 - 0.04,
    w: 1.1,
    h: 0.32,
    bg: '#8c857a',
    fg: '#ffffff',
    border: '#ffffff',
  });
}

/** 工廈：灰白工業大廈、貨運升降機、明喉、卸貨台、天台水塔。 */
function buildIndustrialBuilding(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  asphaltPad(ctx);
  // 主廠廈
  addTower(root, lib, {
    x: v === 0 ? -0.55 : -0.3,
    z: -0.25,
    w: v === 0 ? 2.1 : 2.9,
    d: v === 0 ? 1.7 : 2.3,
    h: 4.3,
    y0: 0.05,
    style: 'aluminium',
    wallColor: PAL.steelGrey,
    roofColor: PAL.concreteDark,
    repeatMul: 1.05,
  });
  if (v === 0) {
    // 附翼
    addTower(root, lib, {
      x: 0.85,
      z: 0.6,
      w: 1.1,
      d: 1.0,
      h: 3.2,
      y0: 0.05,
      style: 'aluminium',
      wallColor: PAL.concreteLight,
      roofColor: PAL.concreteDark,
      repeatMul: 0.9,
    });
  }
  // 貨運升降機塔（外掛）
  addBox(root, lib.lambert(PAL.concrete), 0.55, 3.6, 0.55, v === 0 ? 1.35 : 1.55, 1.85, -1.05);
  addBox(root, lib.lambert(PAL.ironDark), 0.6, 0.08, 0.6, v === 0 ? 1.35 : 1.55, 3.68, -1.05);
  // 卸貨台＋捲閘
  addBox(root, lib.lambert(PAL.concreteLight), 2.0, 0.24, 0.9, 0.2, 0.12, D / 2 - 0.55);
  addRollerDoor(root, lib, -0.35, 0.24, D / 2 - 0.08, 1.0, 1.2, 0, PAL.steelGrey);
  addRollerDoor(root, lib, 0.85, 0.24, D / 2 - 0.08, 0.8, 1.0, 0, PAL.cargoBlue);
  // 貨物暫存（紙箱／卡板）
  for (let i = 0; i < 5; i++) {
    const px = -W / 2 + 0.3 + (i % 3) * 0.35;
    const pz = D / 2 - 0.2 - Math.floor(i / 3) * 0.3;
    addBox(root, lib.lambert(PAL.woodLight), 0.3, 0.3, 0.28, px, 0.3, pz);
    addBox(root, lib.lambert(PAL.woodDark), 0.32, 0.03, 0.3, px, 0.015, pz);
  }
  // 外牆明喉＋管道
  addCylinder(root, lib.lambert(PAL.rust), 0.06, 0.06, 3.8, -W / 2 + 0.22, 1.95, D / 2 - 0.55, 6);
  for (let i = 0; i < 3; i++) {
    addPipeRun(
      root,
      lib,
      new THREE.Vector3(-W / 2 + 0.3, 1.0 + i * 0.9, D / 2 - 0.42),
      new THREE.Vector3(-W / 2 + 0.3, 1.0 + i * 0.9, D / 2 - 0.12),
      0.05,
    );
  }
  // 天台
  const topY = 0.05 + 4.3;
  addRooftopTank(root, lib, -0.55, topY, -0.7, 1.0);
  addRooftopClutter(root, lib, 2.0, 1.6, topY, v + 5, { tanks: 0, antennas: 1, ac: 3, vents: true });
  // 招牌（褪色）
  addLabelSign(root, lib, {
    text: '工廈',
    sub: 'INDUSTRIAL BUILDING',
    x: 0,
    y: 3.4,
    z: D / 2 + 0.04,
    w: 1.7,
    h: 0.44,
    bg: '#4a5a66',
    fg: '#dfe6ec',
    border: '#2a3238',
  });
  // 工廈招牌／外牆招租橫額
  addNeonSign(root, lib, {
    text: '招租',
    x: W / 2 - 0.02,
    y: 2.3,
    z: 0.4,
    ry: -Math.PI / 2,
    vertical: true,
    color: PAL.neonGreen,
    w: 0.3,
    h: 0.7,
    anim: true,
  });
  addFence(root, lib, -W / 2 + 0.1, D / 2 - 0.05, W * 0.1, D / 2 - 0.05, 0.6, { color: PAL.steelGrey });
  if (v === 1) {
    addBambooScaffold(root, lib, -W / 2 + 0.02, 0.2, 0.15, 0.5, 3.6, Math.PI / 2, v + 2);
  }
}

/** 食品廠：加工廠房＋筒倉＋煙囪蒸氣＋卸貨台。 */
function buildFoodFactory(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  asphaltPad(ctx);
  // 廠房
  addTower(root, lib, {
    x: -0.35,
    z: -0.5,
    w: 2.6,
    d: 1.7,
    h: 2.6,
    y0: 0.04,
    style: 'aluminium',
    wallColor: PAL.factoryCream,
    roofColor: PAL.concreteDark,
    repeatMul: 0.95,
  });
  // 鋸齒屋頂
  for (let i = 0; i < 4; i++) {
    const px = -1.5 + i * 0.72;
    const tooth = addBox(root, lib.lambert(PAL.aluminium), 0.7, 0.05, 1.5, px, 2.82, -0.5);
    tooth.rotation.z = 0.42;
    addBox(root, lib.lambert(PAL.glassDark), 0.05, 0.34, 1.4, px + 0.3, 2.95, -0.5);
  }
  // 筒倉
  addSilo(root, lib, 1.55, -1.25, 0.38, 1.7, 0.05, PAL.factoryCream);
  addSilo(root, lib, 2.1, -1.2, 0.3, 1.4, 0.05, PAL.aluminium);
  // 煙囪
  addChimney(root, lib, 2.2, 0.6, 0.22, 3.6, 0.05, { smoke: true });
  if (v === 1) addChimney(root, lib, 1.7, 0.95, 0.16, 2.4, 0.05, { smoke: true });
  // 卸貨台＋捲閘
  addBox(root, lib.lambert(PAL.concreteLight), 1.8, 0.22, 0.9, -0.4, 0.11, D / 2 - 0.5);
  addRollerDoor(root, lib, -0.9, 0.22, D / 2 - 0.06, 1.0, 1.1, 0, PAL.steelGrey);
  addRollerDoor(root, lib, 0.15, 0.22, D / 2 - 0.06, 0.8, 1.0, 0, PAL.steelGrey);
  // 管道
  addPipeRun(root, lib, new THREE.Vector3(1.0, 1.8, -1.0), new THREE.Vector3(1.4, 1.8, 0.2), 0.07);
  addPipeRun(root, lib, new THREE.Vector3(1.4, 1.8, 0.2), new THREE.Vector3(2.0, 2.4, 0.5), 0.07);
  // 貨箱／凍櫃
  addBox(root, lib.lambert(PAL.wallWhite), 0.8, 0.6, 0.5, -W / 2 + 0.55, 0.35, D / 2 - 0.2);
  addBox(root, lib.lambert(PAL.cargoBlue), 0.82, 0.06, 0.52, -W / 2 + 0.55, 0.67, D / 2 - 0.2);
  // 天台空調
  addRooftopClutter(root, lib, 1.6, 1.2, 2.9, v + 9, { tanks: 0, antennas: 1, ac: 2, vents: false });
  // 招牌
  addLabelSign(root, lib, {
    text: v === 0 ? '食品廠' : '食品加工廠',
    sub: 'FOOD FACTORY',
    x: 0,
    y: 2.2,
    z: D / 2 - 0.02,
    w: 1.8,
    h: 0.46,
    bg: '#c9a45c',
    fg: '#2a2118',
    border: '#2a2118',
  });
  addNeonSign(root, lib, {
    text: '食品',
    x: -W / 2 - 0.02,
    y: 2.4,
    z: 0.2,
    ry: Math.PI / 2,
    vertical: true,
    color: PAL.neonOrange,
    w: 0.28,
    h: 0.7,
    anim: false,
  });
  addFence(root, lib, -W / 2 + 0.1, D / 2 - 0.05, W / 2 - 0.1, D / 2 - 0.05, 0.7, { color: PAL.steelGrey, mesh: true });
  addTree(root, lib, W / 2 - 0.35, -D / 2 + 0.35, 0.45, 'banyan', v + 3, 0.04);
}

/** 發電廠：冷卻塔＋煙囪＋渦輪機廠房＋開關站（3x3 大佔地）。 */
function buildPowerPlant(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  asphaltPad(ctx);
  // 渦輪機廠房（後方長條）
  addTower(root, lib, {
    x: -0.3,
    z: -D / 2 + 1.35,
    w: W - 1.2,
    d: 1.9,
    h: 2.3,
    y0: 0.04,
    style: 'aluminium',
    wallColor: PAL.concreteLight,
    roofColor: PAL.concreteDark,
    repeatMul: 0.8,
  });
  // 機房頂部管道與吊車
  addPipeRun(root, lib, new THREE.Vector3(-W * 0.35, 2.45, -D / 2 + 0.8), new THREE.Vector3(W * 0.25, 2.45, -D / 2 + 0.8), 0.1);
  addBox(root, lib.lambert(PAL.wallWhite), 0.9, 0.3, 0.45, 0, 2.48, -D / 2 + 1.1);
  // 冷卻塔
  addCoolingTower(root, lib, v === 0 ? -1.55 : -1.9, 0.35, 1.25, 3.0, 0.04);
  addCoolingTower(root, lib, v === 0 ? 0.35 : 0.6, 0.95, 1.05, 2.5, 0.04);
  // 煙囪
  addChimney(root, lib, W / 2 - 1.0, -D / 2 + 1.0, 0.34, 5.8, 0.04);
  if (v === 1) addChimney(root, lib, W / 2 - 1.9, -D / 2 + 1.2, 0.26, 4.4, 0.04);
  // 開關站（前方）：電塔、變壓器、圍欄
  addPylon(root, lib, -W / 2 + 1.0, D / 2 - 0.9, 2.8, 0.04);
  addPylon(root, lib, -W / 2 + 2.6, D / 2 - 1.3, 2.4, 0.04);
  addTransformer(root, lib, W / 2 - 1.2, D / 2 - 1.6, 0.04, 1.1);
  addTransformer(root, lib, W / 2 - 0.6, D / 2 - 0.9, 0.04, 0.85);
  addPipeRun(root, lib, new THREE.Vector3(-W / 2 + 1.0, 0.5, D / 2 - 0.9), new THREE.Vector3(W / 2 - 1.2, 0.5, D / 2 - 1.6), 0.05);
  // 圍欄、警示
  addFence(root, lib, -W / 2 + 0.1, D / 2 - 0.12, W / 2 - 0.1, D / 2 - 0.12, 1.1, { color: PAL.steelGrey, mesh: true });
  addHazardStripe(root, lib, 0, D / 2 - 0.4, W - 0.3, 0.16, 0, 0.14);
  addHazardStripe(root, lib, 0, -D / 2 + 0.45, W - 0.3, 0.16, 0, 0.14);
  addFence(root, lib, -W / 2 + 0.12, -D / 2 + 0.25, -W / 2 + 0.12, D / 2 - 0.25, 1.1, { color: PAL.steelGrey, mesh: true });
  // 大門 + 招牌
  addBox(root, lib.lambert(PAL.concrete), 1.3, 0.3, 0.3, 0, 0.15, D / 2 - 0.55);
  addLabelSign(root, lib, {
    text: '發電廠',
    sub: 'POWER STATION',
    x: 0,
    y: 1.0,
    z: D / 2 - 0.55,
    w: 1.9,
    h: 0.5,
    bg: '#2a3238',
    fg: '#ffd166',
    border: '#ffd166',
  });
  addLampPost(root, lib, -W / 2 + 0.6, D / 2 - 0.7, 2.0, { y: 0.04 });
  addLampPost(root, lib, W / 2 - 0.6, D / 2 - 0.7, 2.0, { y: 0.04 });
  addTree(root, lib, -W / 2 + 0.4, -D / 2 + 0.4, 0.4, 'pine', v + 2, 0.04);
}

/** 水務設施：圓形沉澱池／濾水池＋高架水塔＋泵房。 */
function buildWaterworks(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  grassPad(ctx);
  addPodium(root, lib, W - 0.3, D - 0.3, 0.14, { color: PAL.concreteLight });
  // 泵房
  addTower(root, lib, {
    x: -0.8,
    z: -D / 2 + 0.9,
    w: 2.0,
    d: 1.1,
    h: 1.7,
    y0: 0.14,
    style: 'tile',
    wallColor: PAL.tileWhite,
    roofColor: PAL.concreteDark,
  });
  addPipeRun(root, lib, new THREE.Vector3(-0.8, 0.9, -D / 2 + 1.45), new THREE.Vector3(-0.8, 0.9, -D / 2 + 2.2), 0.12, PAL.kcrBlue);
  if (v === 0) {
    // 圓形沉澱池 ×2
    for (let i = 0; i < 2; i++) {
      const cx = -0.95 + i * 2.0;
      const cz = D * 0.12;
      addCylinder(root, lib.lambert(PAL.concreteLight), 0.88, 0.92, 0.5, cx, 0.39, cz, 18);
      addCylinder(root, lib.lambert(PAL.concreteDark), 0.92, 0.92, 0.08, cx, 0.66, cz, 18);
      addCylinder(root, lib.lambert(PAL.poolWater), 0.78, 0.78, 0.03, cx, 0.68, cz, 18);
      // 中心刮泥臂
      addCylinder(root, lib.lambert(PAL.steelGrey), 0.05, 0.06, 0.7, cx, 0.85, cz, 6);
      addBox(root, lib.lambert(PAL.steelGrey), 1.5, 0.04, 0.06, cx, 0.72, cz);
    }
  } else {
    // 矩形濾水池
    for (let i = 0; i < 3; i++) {
      const cz = -0.1 + i * 0.75;
      addBox(root, lib.lambert(PAL.concreteLight), 2.6, 0.4, 0.6, 0.2, 0.34, cz);
      addBox(root, lib.lambert(PAL.poolWater), 2.45, 0.03, 0.45, 0.2, 0.55, cz);
      addRailing(root, lib, -1.1, cz + 0.34, 1.5, cz + 0.34, 0.35, { y: 0.55, color: PAL.aluminium });
    }
  }
  // 高架水塔
  const tx = W / 2 - 0.85;
  const tz = -D / 2 + 0.9;
  for (const [dx, dz] of [
    [-0.3, -0.3],
    [0.3, -0.3],
    [-0.3, 0.3],
    [0.3, 0.3],
  ]) {
    addCylinder(root, lib.lambert(PAL.concrete), 0.06, 0.07, 2.0, tx + dx, 1.0, tz + dz, 6);
  }
  addBox(root, lib.lambert(PAL.concrete), 0.9, 0.14, 0.9, tx, 2.0, tz);
  addCylinder(root, lib.lambert(PAL.aluminium), 0.55, 0.55, 0.55, tx, 2.4, tz, 12);
  addCone(root, lib.lambert(PAL.steelGrey), 0.6, 0.24, tx, 2.8, tz, 12);
  addPipeRun(root, lib, new THREE.Vector3(tx, 1.0, tz + 0.4), new THREE.Vector3(tx, 0.55, tz + 1.4), 0.09, PAL.kcrBlue);
  // 圍欄、樹、招牌
  addFence(root, lib, -W / 2 + 0.12, D / 2 - 0.12, W / 2 - 0.12, D / 2 - 0.12, 1.0, { color: PAL.steelGrey, mesh: true });
  addTree(root, lib, -W / 2 + 0.4, D / 2 - 0.5, 0.5, 'banyan', v + 3, 0.14);
  addTree(root, lib, W / 2 - 0.4, D / 2 - 0.6, 0.45, 'flower', v + 4, 0.14);
  addLabelSign(root, lib, {
    text: '水務設施',
    sub: 'WATERWORKS',
    x: 0,
    y: 0.9,
    z: D / 2 - 0.08,
    w: 1.9,
    h: 0.46,
    bg: '#2f5f7a',
    fg: '#ffffff',
    border: '#ffffff',
  });
}

// ═══════════════════════════ 物流（3 種：進口商行、貨櫃碼頭、貨倉） ═══════════════════════════

/** 進口商行：舊式商行、貨辦紙箱、直式「進出口貿易」招牌、貨車泊位。 */
function buildImportFirm(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  asphaltPad(ctx, true);
  // 商行樓（3 層舊式商業樓）
  addTower(root, lib, {
    x: -0.35,
    z: -0.35,
    w: 2.6,
    d: 1.8,
    h: 3.2,
    y0: 0.04,
    style: 'brick',
    wallColor: v === 0 ? PAL.tongLauBrick : PAL.paintYellow,
    roofColor: PAL.concreteDark,
    repeatMul: 1.05,
  });
  // 地面辦事處玻璃門面
  addShopFront(root, lib, -0.35, 0.04, D / 2 - 0.4, 1.6, 0.85, 0);
  addAwning(root, lib, -0.35, 1.0, D / 2 - 0.45, 1.7, 0, v === 0 ? PAL.clothRed : PAL.clothBlue, 0.5);
  // 貨倉出入口＋捲閘
  addRollerDoor(root, lib, W / 2 - 0.65, 0.04, D / 2 - 0.08, 1.0, 1.3, 0, PAL.steelGrey);
  addBox(root, lib.lambert(PAL.concreteLight), 1.2, 0.2, 0.7, W / 2 - 0.65, 0.1, D / 2 - 0.5);
  // 紙箱／貨辦
  for (let i = 0; i < 8; i++) {
    const px = -W / 2 + 0.35 + (i % 4) * 0.34;
    const pz = D / 2 - 0.25 - Math.floor(i / 4) * 0.32;
    const h = 0.26 + hash01(v + i * 2.3) * 0.14;
    addBox(root, lib.lambert(PAL.woodLight), 0.3, h, 0.28, px, 0.04 + h / 2, pz);
    addBox(root, lib.lambert(0xb08d5a), 0.32, 0.03, 0.3, px, 0.055, pz);
  }
  // 手推車
  addBox(root, lib.lambert(PAL.ironDark), 0.4, 0.04, 0.5, 0.9, 0.14, D / 2 - 1.0);
  addBox(root, lib.lambert(PAL.ironDark), 0.04, 0.3, 0.04, 0.9, 0.3, D / 2 - 1.2);
  // 直式霓虹招牌「進出口貿易」
  addNeonSign(root, lib, {
    text: '進出口貿易',
    x: W / 2 - 0.02,
    y: 2.1,
    z: 0.35,
    ry: -Math.PI / 2,
    vertical: true,
    color: PAL.neonCyan,
    w: 0.32,
    h: 1.25,
    anim: true,
  });
  addShopSignBand(root, lib, 0, 0.85, D / 2 - 0.02, '進口商行', '#1b2b33', '#ffd166', 1.3);
  // 天台水箱、天線
  const topY = 3.24;
  addBox(root, lib.lambert(PAL.concreteLight), 2.5, 0.08, 1.7, -0.35, topY + 0.04, -0.35);
  addRooftopTank(root, lib, -1.0, topY + 0.08, -0.6, 0.85);
  addAntennaFarm(root, lib, 2, 1.4, topY + 0.1, v + 7);
  addStairhood(root, lib, 0.6, topY + 0.08, -0.7);
  // 泊車位黃線
  addBox(root, lib.lambert(PAL.roadYellow), 1.9, 0.012, 0.06, 1.2, 0.055, -D / 2 + 0.45);
  addBox(root, lib.lambert(PAL.roadYellow), 0.06, 0.012, 1.2, 0.3, 0.055, -D / 2 + 1.0);
  addBox(root, lib.lambert(PAL.roadYellow), 0.06, 0.012, 1.2, 2.1, 0.055, -D / 2 + 1.0);
  addLitterBin(root, lib, W / 2 - 0.25, D / 2 - 0.25);
  addTree(root, lib, W / 2 - 0.3, -D / 2 + 0.3, 0.4, 'banyan', v + 1, 0.04);
}

/** 貨櫃碼頭：貨櫃堆＋龍門吊機＋岸邊＋貨櫃車位（4x3，臨水轉向）。 */
function buildContainerPort(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  asphaltPad(ctx);
  // 岸邊（沿 +x 邊，模型轉向水面後就是維港岸線）
  const edgeX = W / 2 - 0.45;
  addBox(root, lib.lambert(PAL.concreteLight), 0.9, 0.26, D - 0.2, edgeX, 0.13, 0);
  addBox(root, lib.lambert(PAL.concreteDark), 0.9, 0.1, D - 0.2, edgeX, -0.02, 0);
  for (let i = 0; i < 5; i++) {
    addCylinder(root, lib.lambert(PAL.ironDark), 0.1, 0.12, 0.26, edgeX - 0.15, 0.32, -D / 2 + 0.7 + i * 1.2, 8);
  }
  addHazardStripe(root, lib, edgeX - 0.55, 0, 0.18, D - 0.4, 0, 0.18);
  // 貨櫃堆（三堆）
  const stacks: [number, number, number, number, number][] = [
    [-W / 2 + 1.0, -D / 2 + 0.65, 3, 2, 3],
    [-W / 2 + 2.6, -D / 2 + 0.65, 2, 2, 2],
    [-W / 2 + 1.0, D / 2 - 1.0, 2, 1, 2],
  ];
  if (v === 1) {
    stacks[0] = [-W / 2 + 0.9, -D / 2 + 0.6, 4, 2, 3];
    stacks[1] = [-W / 2 + 2.7, D / 2 - 1.0, 2, 1, 3];
    stacks.pop();
  }
  for (const [sx, sz, cols, rows, layers] of stacks) {
    addContainerStack(root, lib, sx, 0.05, sz, cols, rows, layers, v + cols * 3 + rows);
  }
  // 龍門吊機（面向 +x 海面）
  addGantryCrane(root, lib, edgeX - 0.3, -D / 4, 0, 0.05, 1.1);
  if (v === 0) addGantryCrane(root, lib, edgeX - 0.3, D / 3, 0, 0.05, 1.1);
  // 貨櫃車拖架
  addBox(root, lib.lambert(PAL.cargoRed), 1.2, 0.5, 0.55, 0.8, 0.3, D / 2 - 1.7);
  addBox(root, lib.lambert(PAL.ironDark), 0.9, 0.06, 0.6, 0.8, 0.08, D / 2 - 1.7);
  // 場內道路黃線
  for (let i = 0; i < 2; i++) {
    addBox(root, lib.lambert(PAL.roadYellow), 0.08, 0.012, D - 1.2, -0.4 + i * 0.4, 0.055, 0);
  }
  // 碼頭辦公室（貨櫃改裝）
  addBox(root, lib.lambert(PAL.wallWhite), 1.6, 0.7, 0.8, -W / 2 + 1.2, 0.42, D / 2 - 1.4);
  addBox(root, lib.lambert(PAL.cargoBlue), 1.62, 0.08, 0.82, -W / 2 + 1.2, 0.8, D / 2 - 1.4);
  addBox(root, lib.lambert(PAL.glassDark), 0.5, 0.24, 0.02, -W / 2 + 1.2, 0.5, D / 2 - 1.0);
  // 場燈
  for (let i = 0; i < 3; i++) {
    addCylinder(root, lib.lambert(PAL.steelGrey), 0.05, 0.06, 3.0, -W / 2 + 0.6 + i * 0.5, 1.5, -D / 2 + 0.5 + i * 2.2, 5);
    addBox(root, lib.lambert(PAL.wallWhite), 0.3, 0.12, 0.2, -W / 2 + 0.6 + i * 0.5, 3.05, -D / 2 + 0.5 + i * 2.2);
  }
  // 圍欄
  addFence(root, lib, -W / 2 + 0.1, D / 2 - 0.12, edgeX - 0.6, D / 2 - 0.12, 1.1, { color: PAL.steelGrey, mesh: true });
  // 招牌
  addLabelSign(root, lib, {
    text: '葵涌貨櫃碼頭',
    sub: 'KWAI CHUNG CONTAINER TERMINAL',
    x: -W / 2 + 1.2,
    y: 1.4,
    z: D / 2 - 1.4,
    w: 2.4,
    h: 0.55,
    bg: '#1b2b33',
    fg: '#ffd166',
    border: '#ffd166',
  });
  addNeonSign(root, lib, {
    text: '貨櫃碼頭',
    x: -W / 2 + 0.02,
    y: 2.6,
    z: -D / 2 + 1.2,
    ry: Math.PI / 2,
    vertical: true,
    color: PAL.neonCyan,
    w: 0.34,
    h: 1.1,
    anim: true,
  });
}

/** 貨倉：低層倉庫、卸貨台捲閘、卡板貨箱、通風管。 */
function buildWarehouse(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  asphaltPad(ctx, true);
  // 主倉
  addTower(root, lib, {
    x: -0.2,
    z: -0.45,
    w: 3.0,
    d: 1.9,
    h: 2.5,
    y0: 0.04,
    style: 'warehouse',
    wallColor: PAL.wallGrey,
    roofColor: PAL.concreteDark,
    repeatMul: 0.85,
  });
  // 屋頂通風管／水箱
  addRooftopClutter(root, lib, 2.8, 1.6, 2.56, v + 3, { tanks: 1, antennas: 0, ac: 2, vents: true });
  // 卸貨台（正面）
  addBox(root, lib.lambert(PAL.concreteLight), 2.6, 0.26, 1.0, 0, 0.13, D / 2 - 0.55);
  for (let i = 0; i < (v === 0 ? 2 : 3); i++) {
    const px = -1.0 + i * 1.0;
    addRollerDoor(root, lib, px, 0.26, D / 2 - 0.08, 0.85, 1.3, 0, i % 2 === 0 ? PAL.steelGrey : PAL.wallGrey);
    // 卸貨台邊緣黃黑
    addBox(root, lib.lambert(PAL.hazardYellow), 0.86, 0.05, 0.06, px, 0.26, D / 2 - 0.62);
  }
  // L 形附翼
  if (v === 1) {
    addTower(root, lib, {
      x: W / 2 - 0.55,
      z: 0.8,
      w: 1.2,
      d: 1.6,
      h: 2.0,
      y0: 0.04,
      style: 'warehouse',
      wallColor: PAL.wallGrey,
      roofColor: PAL.concreteDark,
    });
  }
  // 卡板、貨箱、籠車
  for (let i = 0; i < 4; i++) {
    const px = -W / 2 + 0.45 + i * 0.42;
    addBox(root, lib.lambert(PAL.woodDark), 0.38, 0.05, 0.34, px, 0.06, D / 2 - 1.7);
    addBox(root, lib.lambert(PAL.woodLight), 0.34, 0.3, 0.3, px, 0.23, D / 2 - 1.7);
    addBox(root, lib.lambert(PAL.cargoOrange), 0.36, 0.04, 0.32, px, 0.39, D / 2 - 1.7);
  }
  // 叉車（簡化）
  addBox(root, lib.lambert(PAL.busYellow), 0.5, 0.35, 0.4, W * 0.28, 0.3, D * 0.22);
  addBox(root, lib.lambert(PAL.ironDark), 0.06, 0.6, 0.06, W * 0.28 + 0.2, 0.55, D * 0.22);
  addBox(root, lib.lambert(PAL.ironDark), 0.5, 0.06, 0.06, W * 0.28 + 0.36, 0.3, D * 0.22);
  // 外牆通風扇
  for (let i = 0; i < 3; i++) {
    addCylinder(root, lib.lambert(PAL.ironDark), 0.16, 0.16, 0.06, -W / 2 + 0.55 + i * 0.6, 1.8, D / 2 - 0.1, 8);
  }
  // 招牌
  addLabelSign(root, lib, {
    text: v === 0 ? '貨倉' : '物流中心',
    sub: 'WAREHOUSE',
    x: 0,
    y: 2.0,
    z: D / 2 - 0.02,
    w: 1.7,
    h: 0.44,
    bg: '#7a5f3f',
    fg: '#f2e8d0',
    border: '#f2e8d0',
  });
  addFence(root, lib, -W / 2 + 0.1, D / 2 - 0.08, W / 2 - 0.1, D / 2 - 0.08, 0.6, { color: PAL.steelGrey });
  addTree(root, lib, -W / 2 + 0.3, -D / 2 + 0.35, 0.45, 'banyan', v + 2, 0.04);
  addLitterBin(root, lib, W / 2 - 0.25, -D / 2 + 0.3);
}

// ═══════════════════════════ 商業（7 種） ═══════════════════════════

/** 茶餐廳：地舖＋霓虹招牌＋卡位枱凳（1x1）。 */
function buildChaChaanTeng(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  pad(ctx, PAL.concreteDark, 0.06, 0.02);
  const shopH = v === 0 ? 1.15 : 0.95;
  // 地舖主體
  addBox(root, lib.lambert(PAL.concreteLight), W - 0.16, shopH, D - 0.3, 0, shopH / 2 + 0.04, -0.12);
  addShopFront(root, lib, 0, 0.04, D / 2 - 0.28, W - 0.3, shopH - 0.05, 0);
  addAwning(root, lib, 0, shopH * 0.72, D / 2 - 0.03, W - 0.24, 0, v === 0 ? PAL.clothRed : PAL.clothGreen, 0.5);
  // 招牌（橫）
  addNeonSign(root, lib, {
    text: '茶餐廳',
    x: -0.05,
    y: shopH + 0.28,
    z: D / 2 - 0.06,
    vertical: false,
    color: v === 0 ? PAL.neonPink : PAL.neonGold,
    w: 1.45,
    h: 0.36,
    anim: false,
  });
  // 直式招牌「粥麵」
  addNeonSign(root, lib, {
    text: signText(ctx, 3, ['粥麵', '燒臘', '奶茶']),
    x: W / 2 - 0.02,
    y: shopH + 0.42,
    z: D / 2 - 0.5,
    ry: -Math.PI / 2,
    vertical: true,
    color: PAL.neonCyan,
    w: 0.3,
    h: 0.85,
    anim: true,
  });
  // 二樓（唐樓上層）
  if (v === 1) {
    addTower(root, lib, {
      w: W - 0.16,
      d: D - 0.32,
      h: 0.95,
      y0: shopH + 0.06,
      style: 'brick',
      wallColor: PAL.paintGreen,
      roofColor: PAL.concreteDark,
    });
    for (let i = 0; i < 3; i++) {
      addAluminiumWindow(root, lib, -0.55 + i * 0.55, shopH + 0.58, D / 2 - 0.15, 0.34, 0.34, 0, {
        lit: i % 2 === 0,
      });
    }
    addACUnit(root, lib, 0.62, shopH + 0.36, D / 2 - 0.14, 0, 0.8);
    addRooftopTank(root, lib, -0.4, shopH + 1.03, -0.5, 0.75);
    addAntennaFarm(root, lib, W, D, shopH + 1.03, v + 3);
  } else {
    addBox(root, lib.lambert(PAL.concrete), W - 0.2, 0.1, D - 0.34, 0, shopH + 0.09, -0.12);
    addBox(root, lib.lambert(PAL.steelGrey), 0.4, 0.28, 0.4, -0.55, shopH + 0.28, -0.4);
    addCylinder(root, lib.lambert(PAL.ironDark), 0.06, 0.06, 0.3, 0.5, shopH + 0.25, -0.45, 6);
  }
  // 冷氣機
  addACUnit(root, lib, -0.65, shopH + 0.16, D / 2 - 0.12, 0, 0.85);
  addACUnit(root, lib, 0.62, shopH + 0.16, D / 2 - 0.12, 0, 0.85);
  // 門外卡位枱凳
  for (let i = 0; i < 2; i++) {
    const tx = -0.55 + i * 1.1;
    const tz = D / 2 + 0.28;
    addCylinder(root, lib.lambert(PAL.woodLight), 0.2, 0.2, 0.04, tx, 0.5, tz, 10);
    addCylinder(root, lib.lambert(PAL.ironDark), 0.025, 0.025, 0.48, tx, 0.26, tz, 5);
    addCylinder(root, lib.lambert(PAL.clothRed), 0.06, 0.06, 0.02, tx, 0.52, tz, 8);
    for (const dx of [-0.32, 0.32]) {
      addCylinder(root, lib.lambert(PAL.woodDark), 0.09, 0.09, 0.05, tx + dx, 0.42, tz, 7);
      addCylinder(root, lib.lambert(PAL.woodDark), 0.02, 0.02, 0.4, tx + dx, 0.21, tz, 4);
    }
  }
  // 餐牌
  addBox(root, lib.lambert(PAL.woodDark), 0.32, 0.42, 0.04, -W / 2 + 0.2, 0.24, D / 2 + 0.1);
  addLabelSign(root, lib, {
    text: v === 0 ? '絲襪奶茶' : '菠蘿油',
    sub: 'HK CAFE',
    x: 0,
    y: 0.35,
    z: D / 2 - 0.04,
    w: 0.9,
    h: 0.24,
    bg: '#f2ead6',
    fg: '#b02a2a',
    border: '#b02a2a',
  });
  addLitterBin(root, lib, W / 2 - 0.2, D / 2 + 0.12);
}

/** 便利店：玻璃門面、招牌燈箱、門外雪櫃（1x1）。 */
function buildConvenienceStore(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  const brandGreen = v === 0 ? 0x2f8f5f : 0xd97a2a;
  pad(ctx, PAL.concreteLight, 0.06, 0.02);
  addBox(root, lib.lambert(PAL.tileWhite), W - 0.16, 1.55, D - 0.3, 0, 0.8, -0.14);
  addShopFront(root, lib, 0, 0.04, D / 2 - 0.28, W - 0.3, 1.25, 0);
  // 招牌燈箱
  addBox(root, lib.lambert(brandGreen), W - 0.2, 0.42, 0.12, 0, 1.72, D / 2 - 0.18);
  addBox(root, lib.neonTube(PAL.wallWhite), W - 0.3, 0.06, 0.14, 0, 1.95, D / 2 - 0.18);
  addLabelSign(root, lib, {
    text: '便利店',
    sub: '24-HOUR CONVENIENCE STORE',
    x: 0,
    y: 1.72,
    z: D / 2 - 0.11,
    w: 1.6,
    h: 0.36,
    bg: v === 0 ? '#2f8f5f' : '#d97a2a',
    fg: '#ffffff',
    border: '#ffffff',
  });
  // 門口雪糕櫃
  addBox(root, lib.lambert(PAL.wallWhite), 0.6, 0.65, 0.45, -0.6, 0.35, D / 2 + 0.22);
  addBox(root, lib.lambert(PAL.glassDark), 0.56, 0.3, 0.44, -0.6, 0.62, D / 2 + 0.22);
  addBox(root, lib.lambert(brandGreen), 0.62, 0.06, 0.47, -0.6, 0.7, D / 2 + 0.22);
  // 報紙架、傘架
  addBox(root, lib.lambert(PAL.ironDark), 0.4, 0.3, 0.32, 0.65, 0.17, D / 2 + 0.2);
  addCylinder(root, lib.lambert(PAL.steelGrey), 0.1, 0.12, 0.4, W / 2 - 0.22, 0.22, D / 2 + 0.18, 8);
  // 鋁窗上層（如果高）
  addACUnit(root, lib, 0.2, 1.42, D / 2 - 0.16, 0, 0.8);
  addRooftopTank(root, lib, -0.5, 1.72, -0.6, 0.7);
  addNeonSign(root, lib, {
    text: '24小時',
    x: W / 2 - 0.02,
    y: 1.55,
    z: 0.2,
    ry: -Math.PI / 2,
    vertical: true,
    color: v === 0 ? PAL.neonGreen : PAL.neonOrange,
    w: 0.26,
    h: 0.7,
    anim: true,
  });
  addLitterBin(root, lib, W / 2 - 0.2, D / 2 + 0.1);
  addBikeRack(root, lib, -0.2, -D / 2 + 0.15, Math.PI);
}

/** 街市：簷篷＋檔口＋紅膠燈罩（2x2）。 */
function buildWetMarket(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  pad(ctx, PAL.concreteDark, 0.08, 0.02);
  // 濕滑地台
  addBox(root, lib.lambert(0x4a5258), W - 0.3, 0.02, D - 0.4, 0, 0.045, 0.1);
  // 後方街市大樓
  addTower(root, lib, {
    x: 0,
    z: -D / 2 + 0.8,
    w: W - 0.3,
    d: 1.3,
    h: 2.2,
    y0: 0.04,
    style: 'warehouse',
    wallColor: PAL.concreteLight,
    roofColor: PAL.concreteDark,
    repeatMul: 1.2,
  });
  // 大樓招牌
  addLabelSign(root, lib, {
    text: '街市',
    sub: 'WET MARKET',
    x: 0,
    y: 1.9,
    z: -D / 2 + 1.46,
    w: 1.8,
    h: 0.5,
    bg: '#cf9a6a',
    fg: '#2a2118',
    border: '#2a2118',
  });
  // 大樓地下入口
  addBox(root, lib.lambert(0x14181e), 1.0, 1.0, 0.06, 0, 0.55, -D / 2 + 1.46);
  // 簷篷（前方）
  addMarketCanopy(root, lib, {
    x: 0,
    z: 0.35,
    w: W - 0.4,
    d: D - 1.9,
    h: 1.55,
    colors: v === 0 ? [PAL.clothRed, PAL.clothWhite] : [PAL.clothBlue, PAL.clothWhite, PAL.clothYellow],
  });
  // 檔口
  addStall(root, lib, -W * 0.24, D * 0.22, 0.1, v + 1);
  addStall(root, lib, W * 0.22, D * 0.2, -0.15, v + 4);
  addStall(root, lib, -W * 0.24, D * 0.03, Math.PI, v + 7);
  addStall(root, lib, W * 0.22, D * 0.02, Math.PI, v + 9);
  // 紅膠燈罩掛在簷篷下
  for (let i = 0; i < 4; i++) {
    addRedLamp(root, lib, -W * 0.3 + i * (W * 0.2), 1.28, D * 0.34 - (i % 2) * 0.5, 1.0);
  }
  // 水桶、魚箱、菜籮
  for (let i = 0; i < 4; i++) {
    addBox(root, lib.lambert(i % 2 === 0 ? PAL.cargoBlue : PAL.wallWhite), 0.3, 0.22, 0.24, -W * 0.36 + i * 0.24, 0.16, D * 0.4);
    addBox(root, lib.lambert(PAL.cargoBlue), 0.32, 0.06, 0.26, -W * 0.36 + i * 0.24, 0.02, D * 0.4);
  }
  // 垃圾桶、污水渠
  addRefuseRoom(root, lib, -W / 2 + 0.45, D / 2 - 0.4, 1.0, 0.65, 0);
  addBox(root, lib.lambert(PAL.ironDark), W - 0.8, 0.02, 0.12, 0, 0.03, D * 0.1);
  addLitterBin(root, lib, W / 2 - 0.3, D / 2 - 0.3);
  addNeonSign(root, lib, {
    text: '新鮮',
    x: W / 2 - 0.02,
    y: 1.55,
    z: D * 0.1,
    ry: -Math.PI / 2,
    vertical: true,
    color: PAL.neonGreen,
    w: 0.26,
    h: 0.7,
    anim: false,
  });
  addTree(root, lib, -W / 2 + 0.25, -D / 2 + 0.3, 0.4, 'banyan', v + 2, 0.04);
}

/** 超市：大盒式建築、玻璃入口、停車／購物車位（2x2）。 */
function buildSupermarket(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  const brand = v === 0 ? 0x3f8f6a : 0xb0453c;
  asphaltPad(ctx, true);
  // 大盒
  addTower(root, lib, {
    x: 0,
    z: -0.35,
    w: W - 0.4,
    d: D - 1.1,
    h: 2.7,
    y0: 0.04,
    style: 'warehouse',
    wallColor: PAL.wallGrey,
    roofColor: PAL.concreteDark,
    repeatMul: 0.8,
  });
  // 品牌色帶
  addBox(root, lib.lambert(brand), W - 0.3, 0.3, 0.06, 0, 2.4, D / 2 - 0.85);
  // 招牌
  addLabelSign(root, lib, {
    text: v === 0 ? '超市' : '超級市場',
    sub: v === 0 ? 'SUPERMARKET' : 'SUPER STORE',
    x: 0,
    y: 2.4,
    z: D / 2 - 0.8,
    w: 2.4,
    h: 0.6,
    bg: v === 0 ? '#3f8f6a' : '#b0453c',
    fg: '#ffffff',
    border: '#ffffff',
  });
  // 玻璃入口
  addShopFront(root, lib, 0, 0.04, D / 2 - 0.55, 2.0, 1.5, 0);
  addAwning(root, lib, 0, 1.48, D / 2 - 0.52, 2.2, 0, brand, 0.55);
  // 入口簷篷
  addCanopy(root, lib, { x: 0, y: 1.85, z: D / 2 - 0.75, w: 2.6, d: 0.9, glass: true });
  // 購物車位
  for (let i = 0; i < 4; i++) {
    addBox(root, lib.lambert(PAL.steelGrey), 0.5, 0.02, 0.55, -W / 2 + 0.55 + i * 0.55, 0.06, D / 2 - 1.55);
    addBox(root, lib.lambert(PAL.steelGrey), 0.06, 0.5, 0.5, -W / 2 + 0.55 + i * 0.55, 0.3, D / 2 - 1.55);
  }
  // 後方卸貨
  addRollerDoor(root, lib, -W / 2 + 0.8, 0.04, -D / 2 + 0.28, 1.2, 1.4, 0, PAL.steelGrey);
  // 天台空調
  addRooftopClutter(root, lib, W * 0.7, D * 0.5, 2.78, v + 2, { tanks: 1, antennas: 1, ac: 4, vents: true, solar: v === 1 });
  // 泊車位
  for (let i = 0; i < 2; i++) {
    addBox(root, lib.lambert(PAL.roadLine), 0.06, 0.012, 0.9, -W / 2 + 0.8 + i * 1.1, 0.055, -D / 2 + 0.95);
  }
  // 樹、旗、促銷橫額
  addTree(root, lib, W / 2 - 0.4, D / 2 - 0.4, 0.5, 'banyan', v + 3, 0.04);
  addFlagpole(root, lib, W / 2 - 0.6, -D / 2 + 0.6, 1.8, brand, 0.04);
  addNeonSign(root, lib, {
    text: v === 0 ? '日日新鮮' : '震撼價',
    x: -W / 2 + 0.02,
    y: 1.8,
    z: 0.6,
    ry: Math.PI / 2,
    vertical: true,
    color: PAL.neonOrange,
    w: 0.28,
    h: 0.85,
    anim: true,
  });
}

/** 商場：多層玻璃中庭＋LED 大屏幕＋入口廣場（3x2）。 */
function buildShoppingMall(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  const accent = v === 0 ? PAL.neonPink : PAL.neonPurple;
  pad(ctx, PAL.concreteLight, 0.08, 0.02);
  addPodium(root, lib, W - 0.3, D - 0.3, 0.28, { color: PAL.luxurySilver, trim: accent });
  // 商場主體
  const mallW = W - 0.9;
  const mallD = D - 1.4;
  addTower(root, lib, {
    x: 0,
    z: -0.35,
    w: mallW,
    d: mallD,
    h: 4.2,
    y0: 0.28,
    style: 'mall',
    wallColor: PAL.glassBlue,
    roofColor: PAL.concreteLight,
    roofBand: accent,
    repeatMul: 1.1,
  });
  // 玻璃中庭（頂部）
  const atriumX = v === 0 ? 0 : -mallW * 0.22;
  const glassMat = lib.lambert(PAL.glassBlue, { transparent: true, opacity: 0.42 });
  addBox(root, glassMat, 1.8, 1.1, 1.1, atriumX, 4.28 + 0.55, -0.35);
  const roof = addBox(root, lib.lambert(PAL.glassTeal, { transparent: true, opacity: 0.5 }), 1.9, 0.06, 1.2, atriumX, 4.28 + 1.14, -0.35);
  roof.rotation.z = 0.04;
  addBox(root, lib.lambert(PAL.aluminium), 2.0, 0.05, 0.08, atriumX, 4.28 + 1.16, -0.35);
  // LED 大屏幕
  addLedScreen(root, lib, -mallW * 0.28, 3.1, D / 2 - 0.7, 1.5, 0.9, 0, v);
  // 入口簷篷＋自動門
  addShopFront(root, lib, 0.3, 0.28, D / 2 - 0.72, 2.4, 1.6, 0);
  addCanopy(root, lib, { x: 0.3, y: 2.1, z: D / 2 - 0.7, w: 3.2, d: 1.2, glass: true });
  addStairs(root, lib, 2.6, 3, 0.08, 0.18, 0.3, 0.28, D / 2 - 0.55, 0, PAL.stoneLight);
  // 扶手電梯（入口旁）
  const esc = addBox(root, lib.lambert(PAL.steelGrey), 0.5, 0.08, 1.6, W * 0.28, 1.1, D / 2 - 1.1);
  esc.rotation.x = 0.5;
  addBox(root, lib.lambert(PAL.glassBlue, { transparent: true, opacity: 0.35 }), 0.5, 0.4, 1.6, W * 0.28, 1.35, D / 2 - 1.1).rotation.x = 0.5;
  // 入口廣場：噴泉、樹、長椅、巴士站、的士站
  addCylinder(root, lib.lambert(PAL.stoneLight), 0.55, 0.6, 0.24, W * 0.12, 0.4, D / 2 - 0.15, 12);
  addCylinder(root, lib.lambert(PAL.poolWater), 0.45, 0.45, 0.04, W * 0.12, 0.52, D / 2 - 0.15, 12);
  addCylinder(root, lib.lambert(PAL.steelGrey), 0.05, 0.06, 0.5, W * 0.12, 0.75, D / 2 - 0.15, 6);
  addTree(root, lib, -W / 2 + 0.6, D / 2 - 0.45, 0.5, 'palm', v + 1, 0.28);
  addTree(root, lib, -W * 0.32, D / 2 - 0.35, 0.4, 'flower', v + 2, 0.28);
  addBench(root, lib, W * 0.05, D / 2 - 0.12, Math.PI, 0.28);
  addBusStopFlag(root, lib, W / 2 - 0.5, D / 2 + 0.22, '1A 6 9 14', { ry: Math.PI, y: 0.28 });
  addTaxiStand(root, lib, W / 2 - 1.2, D / 2 + 0.25, Math.PI, 0.28);
  addBikeRack(root, lib, -W / 2 + 0.5, D / 2 - 0.1, 0, 0.28);
  // 天台招牌
  addRoofSign(root, lib, 0, 4.28 + 0.35, -0.35, v === 0 ? '商場' : '購物中心', accent, 2.4, true);
  addRooftopClutter(root, lib, mallW * 0.7, mallD * 0.6, 4.5, v + 5, { tanks: 1, antennas: 1, ac: 3, vents: true });
  addLitterBin(root, lib, -W / 2 + 0.4, D / 2 - 0.15);
}

/** 酒樓：中式招牌、紅金立面、大紅燈籠、直式霓虹招牌（2x2）。 */
function buildRestaurant(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  const red = v === 0 ? PAL.wallRed : 0x8f3a3a;
  pad(ctx, PAL.concreteLight, 0.08, 0.02);
  // 樓身
  addTower(root, lib, {
    x: 0,
    z: -0.2,
    w: W - 0.5,
    d: D - 0.9,
    h: 3.2,
    y0: 0.04,
    style: 'brick',
    wallColor: red,
    roofColor: PAL.tileDark,
    repeatMul: 0.95,
  });
  // 中式屋簷（入口一層）
  addBox(root, lib.lambert(PAL.tileGreen), W - 0.2, 0.1, 0.9, 0, 1.15, D / 2 - 0.55);
  addBox(root, lib.lambert(PAL.gold), W - 0.24, 0.05, 0.86, 0, 1.21, D / 2 - 0.55);
  // 紅柱
  for (const px of [-W * 0.32, W * 0.32]) {
    addCylinder(root, lib.lambert(PAL.pillarRed), 0.08, 0.09, 1.2, px, 0.62, D / 2 - 0.6, 8);
  }
  // 大門＋階梯
  addBox(root, lib.lambert(PAL.goldDark), 0.9, 0.9, 0.06, 0, 0.5, D / 2 - 0.62);
  addStairs(root, lib, 1.4, 2, 0.09, 0.22, 0, 0.12, D / 2 - 0.45, 0, PAL.stoneLight);
  // 大紅燈籠
  for (let i = 0; i < 4; i++) {
    const px = -W * 0.4 + i * (W * 0.8 / 3);
    addCylinder(root, lib.lambert(PAL.lantern, { emissive: PAL.lanternGlow, emissiveIntensity: 0.55 }), 0.11, 0.13, 0.26, px, 1.4, D / 2 - 0.5, 8);
    addBox(root, lib.lambert(PAL.gold), 0.1, 0.03, 0.1, px, 1.55, D / 2 - 0.5);
    addBox(root, lib.lambert(PAL.ironDark), 0.012, 0.22, 0.012, px, 1.68, D / 2 - 0.5);
  }
  // 大招牌：直式霓虹「酒樓」
  const text = v === 0 ? '海鮮酒家' : '龍鳳酒樓';
  addNeonSign(root, lib, {
    text,
    x: W / 2 - 0.02,
    y: 2.4,
    z: 0.2,
    ry: -Math.PI / 2,
    vertical: true,
    color: PAL.neonPink,
    w: 0.4,
    h: 1.5,
    anim: true,
  });
  addNeonSign(root, lib, {
    text: '酒樓',
    x: 0,
    y: 1.8,
    z: D / 2 - 0.58,
    vertical: false,
    color: PAL.neonGold,
    w: 1.6,
    h: 0.4,
    anim: false,
  });
  // 天台招牌（大型霓虹）
  addRoofSign(root, lib, 0, 3.26, -0.2, text, PAL.neonPink, 2.4, true);
  // 天台水箱、天線
  addRooftopTank(root, lib, -0.8, 3.26, -0.9, 0.85);
  addAntennaFarm(root, lib, W * 0.6, D * 0.5, 3.3, v + 6);
  // 餐牌／花牌
  addBox(root, lib.lambert(PAL.gold), 0.3, 0.5, 0.04, -W / 2 + 0.35, 0.4, D / 2 - 0.3);
  addLabelSign(root, lib, {
    text: '飲茶點心',
    sub: 'DIM SUM',
    x: 0,
    y: 0.82,
    z: D / 2 - 0.55,
    w: 1.2,
    h: 0.3,
    bg: '#b02a2a',
    fg: '#ffd166',
    border: '#ffd166',
  });
  addPlanter2(root, lib, -W / 2 + 0.35, D / 2 - 0.55);
  addPlanter2(root, lib, W / 2 - 0.35, D / 2 - 0.55);
}

/** 小型花槽（酒樓／商廈門口用）。 */
function addPlanter2(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number): void {
  addBox(parent, lib.lambert(PAL.stoneLight), 0.36, 0.3, 0.36, x, 0.15, z);
  addSphere(parent, lib.lambert(PAL.leaf), 0.18, x, 0.4, z, 6, 4);
  addSphere(parent, lib.lambert(PAL.leafFlower), 0.1, x + 0.08, 0.44, z, 5, 4);
}

/** 商廈：玻璃幕牆塔樓、入口廣場、天台燈帶（2x2）。 */
function buildOfficeTower(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  pad(ctx, PAL.concreteLight, 0.08, 0.02);
  // 平台
  addPodium(root, lib, W - 0.3, D - 0.3, 0.5, { color: PAL.luxurySilver, trim: PAL.neonCyan });
  addShopFront(root, lib, 0, 0.3, D / 2 - 0.35, W - 0.6, 1.0, 0);
  addCanopy(root, lib, { x: 0, y: 1.5, z: D / 2 - 0.55, w: 2.6, d: 1.0, glass: true });
  const h = 8.2 + (v % 2) * 1.0;
  // 主塔
  addTower(root, lib, {
    x: 0,
    z: -0.25,
    w: W - 1.0,
    d: D - 1.1,
    h,
    y0: 0.5,
    style: 'office',
    wallColor: PAL.glassBlue,
    roofColor: PAL.concreteLight,
    roofBand: v === 0 ? PAL.neonCyan : PAL.neonGold,
    repeatMul: 1.0,
  });
  // 四角豎框（鋁飾）
  const tw = W - 1.0;
  const td = D - 1.1;
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    addBox(root, lib.lambert(PAL.aluminium), 0.1, h, 0.1, (sx * tw) / 2, 0.5 + h / 2, -0.25 + (sz * td) / 2);
  }
  // 退台＋天台機房
  const topY = 0.5 + h;
  addBox(root, lib.lambert(PAL.concreteLight), tw * 0.72, 0.5, td * 0.72, 0, topY + 0.25, -0.25);
  addBox(root, lib.lambert(PAL.aluminium), tw * 0.76, 0.08, td * 0.76, 0, topY + 0.52, -0.25);
  addCylinder(root, lib.lambert(PAL.ironDark), 0.02, 0.03, 1.6, 0, topY + 1.3, -0.25, 5);
  addSphere(root, lib.neonTube(PAL.neonRed), 0.05, 0, topY + 2.12, -0.25, 6, 4);
  addRooftopClutter(root, lib, tw * 0.6, td * 0.6, topY + 0.55, v + 4, { tanks: 0, antennas: 1, ac: 2, vents: true });
  // 入口廣場：樹、旗、的士站、巴士站
  addTree(root, lib, -W / 2 + 0.5, D / 2 - 0.45, 0.5, 'palm', v + 2, 0.28);
  addTree(root, lib, W / 2 - 0.5, D / 2 - 0.45, 0.45, 'banyan', v + 3, 0.28);
  addFlagpole(root, lib, -W / 2 + 0.9, D / 2 - 0.2, 2.0, PAL.mtrRed, 0.28);
  addFlagpole(root, lib, -W / 2 + 1.3, D / 2 - 0.2, 2.0, PAL.kcrBlue, 0.28);
  addTaxiStand(root, lib, W / 2 - 0.4, D / 2 - 0.1, Math.PI, 0.28);
  addBusStopFlag(root, lib, W / 2 - 1.1, D / 2 - 0.08, '18 720 788', { ry: Math.PI, y: 0.28 });
  // 大廈名牌
  addLabelSign(root, lib, {
    text: v === 0 ? '中環中心' : '維港廣場',
    sub: 'OFFICE TOWER',
    x: 0,
    y: 1.0,
    z: D / 2 - 0.62,
    w: 2.2,
    h: 0.5,
    bg: '#1b2b33',
    fg: '#24e0ff',
    border: '#24e0ff',
  });
  addBikeRack(root, lib, -W / 2 + 0.4, -D / 2 + 0.4, 0, 0.28);
}

// ═══════════════════════════ 公共設施（4 種） ═══════════════════════════

/** 學校：U 形校舍＋有蓋操場＋籃球架＋旗杆（2x2）。 */
function buildSchool(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  grassPad(ctx);
  addPodium(root, lib, W - 0.3, D - 0.3, 0.16, { color: PAL.concreteLight });
  const block = (x: number, z: number, w: number, d: number, h: number): void => {
    addTower(root, lib, {
      x,
      z,
      w,
      d,
      h,
      y0: 0.16,
      style: 'school',
      wallColor: PAL.schoolGreen,
      roofColor: PAL.concrete,
      repeatMul: 1.0,
    });
  };
  if (v === 0) {
    // U 形校舍
    block(0, -D / 2 + 0.85, W - 0.8, 1.0, 3.0);
    block(-W / 2 + 0.85, 0.25, 1.0, 1.6, 2.8);
    block(W / 2 - 0.85, 0.25, 1.0, 1.6, 2.8);
    // 有蓋操場
    addBox(root, lib.lambert(PAL.concreteLight), 1.9, 0.06, 1.5, 0, 1.55, 0.2);
    for (const [px, pz] of [
      [-0.85, -0.45],
      [0.85, -0.45],
      [-0.85, 0.8],
      [0.85, 0.8],
    ]) {
      addCylinder(root, lib.lambert(PAL.steelGrey), 0.04, 0.05, 1.5, px, 0.9, pz, 5);
    }
  } else {
    // 直排校舍＋禮堂
    block(0, -D / 2 + 0.85, W - 0.8, 1.1, 3.2);
    addTower(root, lib, {
      x: -W * 0.2,
      z: 0.9,
      w: 1.8,
      d: 1.2,
      h: 1.5,
      y0: 0.16,
      style: 'school',
      wallColor: PAL.schoolCream,
      roofColor: PAL.concrete,
    });
    addBox(root, lib.lambert(PAL.concreteLight), 1.5, 0.05, 1.0, W * 0.25, 1.3, 0.9);
    for (const [px, pz] of [
      [W * 0.1, 0.5],
      [W * 0.4, 0.5],
      [W * 0.1, 1.3],
      [W * 0.4, 1.3],
    ]) {
      addCylinder(root, lib.lambert(PAL.steelGrey), 0.04, 0.05, 1.28, px, 0.8, pz, 5);
    }
  }
  // 籃球場
  addBasketballHoop(root, lib, W * 0.3, D * 0.28, Math.PI, 0.16);
  addBasketballHoop(root, lib, W * 0.3 - 2.6, D * 0.28, 0, 0.16);
  // 旗杆
  addFlagpole(root, lib, -W / 2 + 0.5, D / 2 - 0.4, 2.4, PAL.mtrRed, 0.16);
  // 跑步徑／操場
  addBox(root, lib.lambert(0x8a5a4a), 2.4, 0.02, 1.0, -W * 0.05, 0.18, D * 0.32);
  // 圍欄、校門、招牌
  addFence(root, lib, -W / 2 + 0.12, D / 2 - 0.1, W / 2 - 0.12, D / 2 - 0.1, 1.0, { color: PAL.schoolGreen });
  addBox(root, lib.lambert(PAL.wallWhite), 1.4, 0.6, 0.2, 0, 0.5, D / 2 - 0.12);
  addLabelSign(root, lib, {
    text: v === 0 ? '學校' : '官立小學',
    sub: 'SCHOOL',
    x: 0,
    y: 1.55,
    z: D / 2 - 0.02,
    w: 1.5,
    h: 0.4,
    bg: '#2f6f3f',
    fg: '#ffffff',
    border: '#ffffff',
  });
  addTree(root, lib, -W / 2 + 0.5, -D / 2 + 0.4, 0.5, 'banyan', v + 2, 0.16);
  addTree(root, lib, W / 2 - 0.5, D / 2 - 0.6, 0.45, 'flower', v + 3, 0.16);
  addBench(root, lib, W * 0.05, D / 2 - 0.3, Math.PI, 0.16);
}

/** 醫院：十字標誌、直升機坪、急症室入口（3x2）。 */
function buildHospital(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  pad(ctx, PAL.concreteLight, 0.08, 0.02);
  // 主樓
  addTower(root, lib, {
    x: -0.3,
    z: -D / 2 + 1.3,
    w: W - 1.6,
    d: 1.9,
    h: 4.6,
    y0: 0.04,
    style: 'hospital',
    wallColor: PAL.hospitalWhite,
    roofColor: PAL.concreteLight,
    repeatMul: 1.0,
  });
  // 低座翼樓
  addTower(root, lib, {
    x: -1.9,
    z: D / 2 - 1.0,
    w: 2.2,
    d: 1.4,
    h: 2.4,
    y0: 0.04,
    style: 'hospital',
    wallColor: PAL.hospitalWhite,
    roofColor: PAL.concreteLight,
  });
  // 屋頂紅十字
  addCrossSign(root, lib, -0.3, 4.75 + 0.7, -D / 2 + 1.3 + 1.05, 0, 1.5);
  // 直升機坪（低座天台）
  addHelipad(root, lib, -1.9, 2.46, D / 2 - 1.0, 0.9);
  // 急症室入口
  addCanopy(root, lib, { x: 0.9, y: 1.8, z: D / 2 - 1.4, w: 2.6, d: 1.3, glass: true });
  addShopFront(root, lib, 0.9, 0.04, D / 2 - 1.2, 1.8, 1.4, 0);
  addNeonSign(root, lib, {
    text: '急症室',
    x: 0.9,
    y: 1.8,
    z: D / 2 - 1.35,
    vertical: false,
    color: PAL.neonRed,
    w: 1.4,
    h: 0.34,
    anim: false,
  });
  addStairs(root, lib, 2.0, 2, 0.08, 0.2, 0.9, 0.1, D / 2 - 1.05, 0, PAL.stoneLight);
  // 救護車泊位
  addBox(root, lib.lambert(PAL.roadAsphalt), 2.2, 0.02, 0.8, 0.9, 0.055, D / 2 - 0.5);
  addBox(root, lib.lambert(PAL.roadLine), 2.2, 0.012, 0.05, 0.9, 0.08, D / 2 - 0.85);
  // 天台機房、水箱、天線
  addRooftopClutter(root, lib, W * 0.5, D * 0.4, 4.68, v + 4, { tanks: 2, antennas: 1, ac: 3, vents: true });
  // 醫院名牌
  addLabelSign(root, lib, {
    text: v === 0 ? '醫院' : '公立醫院',
    sub: 'HOSPITAL',
    x: -1.9,
    y: 2.2,
    z: D / 2 - 0.28,
    w: 1.8,
    h: 0.46,
    bg: '#e8eef2',
    fg: '#1b2b33',
    border: '#c62828',
  });
  // 圍欄、樹、長椅
  addFence(root, lib, -W / 2 + 0.1, D / 2 - 0.1, 1.9, D / 2 - 0.1, 1.0, { color: PAL.steelGrey });
  addTree(root, lib, W / 2 - 0.6, D / 2 - 0.8, 0.5, 'banyan', v + 2, 0.04);
  addTree(root, lib, -W / 2 + 0.6, -D / 2 + 0.5, 0.45, 'flower', v + 3, 0.04);
  addBench(root, lib, W / 2 - 0.7, D / 2 - 0.4, Math.PI * 0.9, 0.04);
  addLitterBin(root, lib, -W / 2 + 0.4, D / 2 - 0.3);
}

/** 警署：藍白警署大樓＋瞭望塔＋警徽（2x2）。 */
function buildPoliceStation(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  pad(ctx, PAL.concreteLight, 0.08, 0.02);
  addTower(root, lib, {
    x: v === 0 ? 0.2 : -0.2,
    z: -0.35,
    w: W - 0.9,
    d: D - 1.5,
    h: 3.2,
    y0: 0.04,
    style: 'tile',
    wallColor: PAL.policeWhite,
    roofColor: PAL.concreteLight,
    repeatMul: 1.0,
  });
  // 藍色腰線
  addBox(root, lib.lambert(PAL.policeBlue), W - 0.86, 0.16, D - 1.46, v === 0 ? 0.2 : -0.2, 1.2, -0.35);
  addBox(root, lib.lambert(PAL.policeBlue), W - 0.86, 0.16, D - 1.46, v === 0 ? 0.2 : -0.2, 2.5, -0.35);
  // 瞭望塔
  const tx = v === 0 ? -W / 2 + 0.7 : W / 2 - 0.7;
  addBox(root, lib.lambert(PAL.policeWhite), 1.0, 4.2, 0.95, tx, 2.1, -D / 2 + 0.75);
  addBox(root, lib.lambert(PAL.policeBlue), 1.1, 0.2, 1.05, tx, 4.18, -D / 2 + 0.75);
  for (let i = 0; i < 4; i++) {
    addBox(root, lib.lambert(PAL.glassDark), 0.3, 0.4, 0.03, tx - 0.25 + (i % 2) * 0.5, 3.6 + Math.floor(i / 2) * 0.6, -D / 2 + 0.75 + 0.48);
  }
  // 入口＋警徽
  addCanopy(root, lib, { x: 0, y: 1.5, z: D / 2 - 0.75, w: 2.0, d: 0.9 });
  addShopFront(root, lib, 0, 0.04, D / 2 - 0.55, 1.4, 1.1, 0);
  const badge = lib.symbol('policeBadge', 128, 128, (ctx2) => {
    ctx2.fillStyle = '#1b2b33';
    ctx2.fillRect(0, 0, 128, 128);
    ctx2.fillStyle = '#3f5f9f';
    ctx2.beginPath();
    ctx2.arc(64, 60, 44, 0, Math.PI * 2);
    ctx2.fill();
    ctx2.fillStyle = '#ffd166';
    ctx2.beginPath();
    ctx2.arc(64, 60, 30, 0, Math.PI * 2);
    ctx2.fill();
    ctx2.fillStyle = '#1b2b33';
    ctx2.font = `900 30px ${'"Noto Sans TC", sans-serif'}`;
    ctx2.textAlign = 'center';
    ctx2.textBaseline = 'middle';
    ctx2.fillText('警', 64, 60);
  });
  const badgeFace = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), badge);
  badgeFace.position.set(0, 1.55, D / 2 - 0.6);
  root.add(badgeFace);
  // 天台、水箱、天線
  addBox(root, lib.lambert(PAL.concreteLight), W - 1.0, 0.1, D - 1.6, 0, 3.3, -0.35);
  addRooftopTank(root, lib, -0.7, 3.35, -0.7, 0.8);
  addAntennaFarm(root, lib, W * 0.6, D * 0.4, 3.4, v + 4);
  // 旗杆、圍欄、車位
  addFlagpole(root, lib, -W / 2 + 0.45, D / 2 - 0.28, 2.2, PAL.mtrRed, 0.04);
  addFence(root, lib, -W / 2 + 0.1, D / 2 - 0.1, W / 2 - 0.1, D / 2 - 0.1, 0.9, { color: PAL.policeBlue });
  addBox(root, lib.lambert(PAL.roadAsphalt), 1.6, 0.02, 0.7, W / 2 - 1.0, 0.055, D / 2 - 0.42);
  addBox(root, lib.lambert(PAL.roadLine), 1.6, 0.012, 0.04, W / 2 - 1.0, 0.08, D / 2 - 0.75);
  // 名牌
  addLabelSign(root, lib, {
    text: v === 0 ? '警署' : '警察局',
    sub: 'POLICE STATION',
    x: 0,
    y: 2.9,
    z: D / 2 - 1.44,
    w: 1.8,
    h: 0.46,
    bg: '#3f5f9f',
    fg: '#ffffff',
    border: '#ffffff',
  });
  addTree(root, lib, -W / 2 + 0.4, -D / 2 + 0.4, 0.45, 'banyan', v + 2, 0.04);
  addLitterBin(root, lib, W / 2 - 0.3, -D / 2 + 0.3);
}

/** 消防局：紅色捲閘、操練塔、消防喉（2x2）。 */
function buildFireStation(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  asphaltPad(ctx);
  // 消防局主樓
  addTower(root, lib, {
    x: -0.3,
    z: -0.5,
    w: W - 1.3,
    d: D - 1.5,
    h: 2.6,
    y0: 0.04,
    style: 'tile',
    wallColor: PAL.fireRed,
    roofColor: PAL.concreteLight,
    repeatMul: 0.9,
  });
  addBox(root, lib.lambert(PAL.wallWhite), W - 1.34, 0.26, D - 1.54, -0.3, 1.0, -0.5);
  // 紅色捲閘（車房）
  const bays = v === 0 ? 3 : 2;
  for (let i = 0; i < bays; i++) {
    const px = -W / 2 + 0.55 + i * 0.85;
    addRollerDoor(root, lib, px, 0.04, D / 2 - 0.55, 0.75, 1.55, 0, PAL.fireRed);
    addBox(root, lib.lambert(PAL.hazardYellow), 0.75, 0.05, 0.06, px, 0.04, D / 2 - 0.5);
  }
  // 車房前斜台
  addBox(root, lib.lambert(PAL.concreteLight), 2.8, 0.12, 0.8, 0, 0.06, D / 2 - 0.15);
  // 操練塔
  const tx = W / 2 - 0.7;
  addBox(root, lib.lambert(PAL.concreteLight), 1.1, 4.2, 1.1, tx, 2.1, -D / 2 + 0.8);
  addBox(root, lib.lambert(PAL.fireRed), 1.16, 0.12, 1.16, tx, 4.2, -D / 2 + 0.8);
  for (let f = 0; f < 4; f++) {
    addBox(root, lib.lambert(PAL.glassDark), 0.4, 0.3, 0.03, tx - 0.2, 1.0 + f * 0.8, -D / 2 + 0.8 + 0.56);
    addBox(root, lib.lambert(PAL.glassDark), 0.4, 0.3, 0.03, tx + 0.2, 1.0 + f * 0.8, -D / 2 + 0.8 + 0.56);
    addRailing(root, lib, tx - 0.5, -D / 2 + 0.8 + 0.58, tx + 0.5, -D / 2 + 0.8 + 0.58, 0.35, { y: 0.85 + f * 0.8, color: PAL.steelGrey });
  }
  // 消防喉、消防栓
  addCylinder(root, lib.lambert(PAL.fireRed), 0.1, 0.13, 0.5, -W / 2 + 0.35, 0.3, D / 2 - 0.15, 8);
  addSphere(root, lib.lambert(PAL.fireRed), 0.12, -W / 2 + 0.35, 0.62, D / 2 - 0.15, 6, 4);
  addFireHoseReel(root, lib, W / 2 - 0.35, 1.3, D / 2 - 0.6, 0);
  // 天台水箱、天線
  addRooftopTank(root, lib, -0.8, 2.66, -0.6, 0.85);
  addAntennaFarm(root, lib, W * 0.5, D * 0.4, 2.7, v + 4);
  // 旗杆、圍欄、招牌
  addFlagpole(root, lib, -W / 2 + 0.3, D / 2 - 0.3, 2.2, PAL.mtrRed, 0.04);
  addFence(root, lib, -W / 2 + 0.1, D / 2 - 0.08, W / 2 - 0.1, D / 2 - 0.08, 0.7, { color: PAL.fireRed });
  addLabelSign(root, lib, {
    text: '消防局',
    sub: 'FIRE STATION',
    x: -0.3,
    y: 2.3,
    z: D / 2 - 0.62,
    w: 2.0,
    h: 0.5,
    bg: '#b0443f',
    fg: '#ffffff',
    border: '#ffffff',
  });
  addLampPost(root, lib, W / 2 - 0.4, D / 2 - 0.3, 1.8, { y: 0.04 });
}

// ═══════════════════════════ 交通（4 種） ═══════════════════════════

/** 港鐵站：出入口＋站名牌＋天橋＋通風井（2x2）。 */
function buildMtrStation(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  pad(ctx, PAL.concreteLight, 0.08, 0.02);
  const names: [string, string][] = [
    ['中環', 'Central'],
    ['旺角', 'Mong Kok'],
    ['銅鑼灣', 'Causeway Bay'],
  ];
  const [nameZh, nameEn] = names[v % names.length];
  // 車站主體（地面站廳）
  addTower(root, lib, {
    x: 0,
    z: -D / 2 + 0.95,
    w: W - 0.7,
    d: 1.3,
    h: 2.4,
    y0: 0.04,
    style: 'tile',
    wallColor: PAL.tileWhite,
    roofColor: PAL.concreteLight,
    repeatMul: 1.1,
  });
  // 紅色站名帶
  addBox(root, lib.lambert(PAL.mtrRed), W - 0.74, 0.34, 0.06, 0, 2.28, -D / 2 + 0.95 + 0.67);
  addStationNameBand(root, lib, 0, 2.28, -D / 2 + 0.95 + 0.7, nameZh, nameEn, 0, 2.2);
  // 出入口
  addMtrEntrance(root, lib, {
    x: -W * 0.18,
    z: D * 0.2,
    y: 0.04,
    ry: 0,
    nameZh,
    nameEn,
    exit: v === 0 ? 'A1' : 'B2',
    canopy: true,
    footbridge: v !== 1,
  });
  // 通風井＋冷卻塔
  addBox(root, lib.lambert(PAL.concrete), 0.8, 1.2, 0.7, W / 2 - 0.55, 0.64, -D / 2 + 0.75);
  for (let i = 0; i < 4; i++) {
    addBox(root, lib.lambert(PAL.steelGrey), 0.7, 0.06, 0.04, W / 2 - 0.55, 0.3 + i * 0.24, -D / 2 + 0.75 + 0.36);
  }
  addCylinder(root, lib.lambert(PAL.steelGrey), 0.28, 0.3, 0.5, W / 2 - 0.55, 0.3, D / 2 - 0.6, 10);
  // 站外設施
  addBusStopFlag(root, lib, W / 2 - 0.35, D / 2 - 0.15, 'MTR 接駁巴士', { ry: Math.PI, y: 0.04 });
  addTaxiStand(root, lib, -W / 2 + 0.4, D / 2 - 0.12, Math.PI, 0.04);
  addBikeRack(root, lib, W / 2 - 0.9, D / 2 - 0.6, Math.PI, 0.04);
  addLitterBin(root, lib, -W / 2 + 0.3, D / 2 - 0.35);
  addTree(root, lib, -W / 2 + 0.45, -D / 2 + 0.45, 0.4, 'flower', v + 2, 0.04);
  // 站名大字（屋頂）
  addLabelSign(root, lib, {
    text: nameZh,
    sub: `${nameEn} STATION`,
    x: 0,
    y: 2.95,
    z: -D / 2 + 1.6,
    w: 2.4,
    h: 0.6,
    bg: '#b02a2a',
    fg: '#ffffff',
    border: '#ffffff',
  });
}

/** 巴士總站：月台上蓋＋站牌＋排隊欄（2x2）。 */
function buildBusTerminus(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  asphaltPad(ctx, true);
  // 月台上蓋
  if (v === 0) {
    addBusCanopy(root, lib, { x: -0.15, z: -D * 0.2, y: 0.03, w: W - 0.6, d: 1.2, height: 1.7 });
    addBusCanopy(root, lib, { x: 0, z: D * 0.28, y: 0.03, w: W - 1.1, d: 1.0, height: 1.55, ry: Math.PI });
  } else {
    addBusCanopy(root, lib, { x: 0.2, z: -D * 0.2, y: 0.03, w: W - 0.5, d: 1.3, height: 1.8 });
    addBusCanopy(root, lib, { x: -0.3, z: D * 0.3, y: 0.03, w: W - 0.8, d: 1.1, height: 1.65 });
  }
  // 站長室
  addBox(root, lib.lambert(PAL.wallWhite), 1.0, 0.9, 0.8, -W / 2 + 0.8, 0.5, -D / 2 + 0.6);
  addBox(root, lib.lambert(PAL.busYellow), 1.04, 0.1, 0.84, -W / 2 + 0.8, 0.98, -D / 2 + 0.6);
  addBox(root, lib.lambert(PAL.glassDark), 0.4, 0.3, 0.02, -W / 2 + 0.8, 0.6, -D / 2 + 1.01);
  // 站牌
  addBusStopFlag(root, lib, -W / 2 + 0.5, 0.4, '1A 5 9 11K 21', { ry: Math.PI / 2, y: 0.03 });
  addBusStopFlag(root, lib, W / 2 - 0.5, 0.9, '6 6A 6C 106', { ry: -Math.PI / 2, y: 0.03 });
  addBusStopFlag(root, lib, 0.4, D / 2 - 0.35, '8A 8P 12', { ry: Math.PI, y: 0.03 });
  // 排隊欄
  addQueueRail(root, lib, -W * 0.3, D * 0.12, 1.2, 0, 0.03);
  addQueueRail(root, lib, W * 0.2, -D * 0.05, 1.1, 0, 0.03);
  // 月台邊緣黃線
  addBox(root, lib.lambert(PAL.roadYellow), W - 0.5, 0.012, 0.08, 0, 0.055, -D * 0.02);
  // 巴士站長亭／售票
  addBox(root, lib.lambert(PAL.glassBlue, { transparent: true, opacity: 0.4 }), 0.8, 0.8, 0.5, W / 2 - 0.85, 0.55, -D / 2 + 0.7);
  addBox(root, lib.lambert(PAL.steelGrey), 0.86, 0.08, 0.56, W / 2 - 0.85, 0.98, -D / 2 + 0.7);
  // 垃圾房、樹、安全島
  addRefuseRoom(root, lib, W / 2 - 0.5, D / 2 - 0.55, 0.9, 0.6, Math.PI);
  addTree(root, lib, W / 2 - 0.35, -D / 2 + 0.4, 0.4, 'banyan', v + 2, 0.03);
  addLampPost(root, lib, -W / 2 + 0.35, W * 0.0, 2.0, { y: 0.03, ry: Math.PI / 2 });
  addHazardStripe(root, lib, 0, D / 2 - 0.18, W - 0.6, 0.12, 0, 0.1);
  // 招牌
  addLabelSign(root, lib, {
    text: v === 0 ? '巴士總站' : '公共運輸交匯處',
    sub: 'BUS TERMINUS',
    x: 0,
    y: 1.35,
    z: -D / 2 + 1.18,
    w: 2.0,
    h: 0.46,
    bg: '#2a5f9f',
    fg: '#ffffff',
    border: '#ffffff',
  });
}

/** 電車站：綠色站亭＋路軌＋架空電纜（1x1）。 */
function buildTramStop(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  pad(ctx, PAL.roadAsphalt, 0.04, 0.02);
  // 路軌（沿 x 方向）
  addTramRails(root, lib, 0, 0.05, W - 0.24, 0, 0.03);
  // 站亭
  addTramShelter(root, lib, 0, D * 0.24, Math.PI, 0.03);
  if (v === 1) {
    // 對面月台
    addTramShelter(root, lib, 0, -D * 0.24, 0, 0.03);
  } else {
    // 安全島 + 站牌
    addBox(root, lib.lambert(PAL.concreteLight), W * 0.7, 0.12, 0.5, 0, 0.08, -D * 0.24);
    addBusStopFlag(root, lib, W * 0.22, -D * 0.24, '1 2 3 4', { y: 0.14, ry: Math.PI });
  }
  // 架空電纜
  addTramWires(root, lib, -W / 2 + 0.15, 0, W / 2 - 0.15, 0, 2.0, 0.03);
  // 站名牌／時間表
  addLabelSign(root, lib, {
    text: '電車站',
    sub: 'TRAM STOP  1 2 3 4',
    x: 0,
    y: 1.62,
    z: D * 0.24 + 0.42,
    w: 1.1,
    h: 0.28,
    bg: '#2f8f5f',
    fg: '#ffffff',
    border: '#ffffff',
  });
  // 街道路牌
  addStreetSign(root, lib, W / 2 - 0.25, D / 2 - 0.2, 0.15, STREET_NAMES[(ctx.variant * 7) % STREET_NAMES.length], 'HK', Math.PI);
  // 長椅、垃圾筒、花槽
  addBench(root, lib, -W * 0.2, D * 0.12, Math.PI, 0.03);
  addLitterBin(root, lib, W * 0.28, D * 0.05);
  addPlanter2(root, lib, -W / 2 + 0.35, D / 2 - 0.35);
  addNeonSign(root, lib, {
    text: '叮叮',
    x: -W / 2 + 0.02,
    y: 1.5,
    z: -D * 0.2,
    ry: Math.PI / 2,
    vertical: true,
    color: PAL.neonGreen,
    w: 0.24,
    h: 0.6,
    anim: true,
  });
}

/** 渡輪碼頭：天星小輪風格碼頭＋鐘樓＋跳板＋樁柱（3x2，臨水轉向）。 */
function buildFerryPier(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  // 碼頭地台（前方 +x 伸向水面）
  addBox(root, lib.lambert(PAL.woodLight), W - 0.6, 0.14, D - 1.0, 0, 0.12, 0);
  for (let i = 0; i < 5; i++) {
    addBox(root, lib.lambert(PAL.woodDark), W - 0.7, 0.03, 0.06, 0, 0.2, -D / 2 + 0.6 + i * (D - 1.2) / 4);
  }
  // 樁柱（海面下）
  addPilings(root, lib, W * 0.2, 0, W * 0.6, D - 0.8, -0.35);
  addPilings(root, lib, -W * 0.2, 0, W * 0.4, D - 0.8, -0.35);
  // 碼頭主樓（候船室，綠白）
  addTower(root, lib, {
    x: -W / 2 + 1.05,
    z: 0,
    w: 2.0,
    d: D - 1.2,
    h: 2.0,
    y0: 0.19,
    style: 'tile',
    wallColor: PAL.wallWhite,
    roofColor: PAL.tramGreen,
    repeatMul: 1.0,
  });
  // 綠色屋簷
  addBox(root, lib.lambert(PAL.tramGreen), 2.2, 0.12, D - 0.9, -W / 2 + 1.05, 2.3, 0);
  addBox(root, lib.lambert(PAL.wallWhite), 2.24, 0.06, D - 0.86, -W / 2 + 1.05, 2.24, 0);
  // 碼頭大閘（閘口）
  addIronGate(root, lib, W / 2 - 1.0, 0.2, D / 2 - 1.4, 1.0, 0.8, 0, 1);
  addRailing(root, lib, W / 2 - 1.0, D / 2 - 1.4, W / 2 - 1.0, D / 2 - 0.4, 0.7, { y: 0.2, color: PAL.tramGreen });
  // 鐘樓（variant 0）
  if (v === 0) addClockTower(root, lib, -W / 2 + 1.05, -D / 2 + 1.0, 2.6, 0.7, 2.3, PAL.wallWhite);
  // 售票處
  addTicketBooth(root, lib, -W / 2 + 2.2, D / 2 - 1.3, 0, 0.19);
  // 候船室長椅
  addBench(root, lib, -W / 2 + 1.1, 0.6, Math.PI / 2, 0.2);
  addBench(root, lib, -W / 2 + 1.1, 0.05, Math.PI / 2, 0.2);
  // 跳板＋浮躉
  addGangway(root, lib, W / 2 - 1.0, 0.24, D / 2 - 0.9, 1.7, 0, -0.12);
  addGangway(root, lib, W / 2 - 1.0, 0.24, -D / 2 + 0.9, 1.7, 0, -0.12);
  addBox(root, lib.lambert(PAL.woodDark), 1.2, 0.12, 1.0, W / 2 + 0.6, 0.02, D / 2 - 0.9);
  addBox(root, lib.lambert(PAL.woodDark), 1.2, 0.12, 1.0, W / 2 + 0.6, 0.02, -D / 2 + 0.9);
  // 欄杆、救生圈、燈柱
  addRailing(root, lib, W * 0.1, D / 2 - 0.5, W - 0.7, D / 2 - 0.5, 0.55, { y: 0.19, color: PAL.wallWhite });
  addRailing(root, lib, W * 0.1, -D / 2 + 0.5, W - 0.7, -D / 2 + 0.5, 0.55, { y: 0.19, color: PAL.wallWhite });
  addLifeRing(root, lib, W / 2 - 0.8, 1.0, D / 2 - 0.5, Math.PI / 2);
  addLampPost(root, lib, W / 2 - 1.4, D / 2 - 0.6, 1.8, { y: 0.19 });
  addLampPost(root, lib, W / 2 - 1.4, -D / 2 + 0.6, 1.8, { y: 0.19 });
  // 天星小輪招牌
  addLabelSign(root, lib, {
    text: '天星小輪',
    sub: 'STAR FERRY',
    x: -W / 2 + 1.05,
    y: 2.75,
    z: 0.6,
    w: 1.8,
    h: 0.44,
    bg: '#1f5f3f',
    fg: '#f2f5ee',
    border: '#f2f5ee',
  });
  addNeonSign(root, lib, {
    text: '往中環',
    x: W / 2 - 0.55,
    y: 1.75,
    z: D / 2 - 0.6,
    vertical: true,
    color: PAL.neonGreen,
    w: 0.3,
    h: 0.85,
    anim: true,
  });
  addFlagpole(root, lib, W * 0.1, D / 2 - 0.35, 2.0, PAL.tramGreen, 0.19);
}

// ═══════════════════════════ 休憩（2 種） ═══════════════════════════

/** 公園：草坪、榕樹、涼亭、池塘、長椅、健體園地（2x2）。 */
function buildPark(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  grassPad(ctx);
  // 步道
  addBox(root, lib.lambert(PAL.stoneLight), W - 0.5, 0.03, 0.5, 0, 0.05, 0);
  addBox(root, lib.lambert(PAL.stoneLight), 0.5, 0.03, D - 0.5, -W * 0.18, 0.05, 0);
  // 大榕樹
  addTree(root, lib, -W * 0.3, -D * 0.3, 0.85, 'banyan', v + 1);
  addTree(root, lib, W * 0.3, -D * 0.28, 0.6, 'banyan', v + 2);
  addTree(root, lib, W * 0.32, D * 0.32, 0.5, 'flower', v + 3);
  if (v === 0) {
    // 池塘＋涼亭
    addPond(root, lib, -W * 0.2, D * 0.22, 1.6, 1.0);
    addParkPavilion(root, lib, W * 0.24, D * 0.18, 0.55, 0.03);
  } else {
    // 兒童遊樂場＋長者健體
    addPlayground(root, lib, -W * 0.22, D * 0.22, 0.85);
    addFitnessCorner(root, lib, W * 0.22, D * 0.23);
    addPond(root, lib, W * 0.22, -D * 0.24, 1.0, 0.7);
  }
  // 長椅、燈柱、垃圾桶
  addBench(root, lib, -W * 0.05, D * 0.05, 0, 0.03);
  addBench(root, lib, W * 0.18, -D * 0.1, Math.PI * 0.5, 0.03);
  addBench(root, lib, -W * 0.28, D * 0.02, Math.PI, 0.03);
  addLampPost(root, lib, -W * 0.05, -D * 0.4, 1.8);
  addLampPost(root, lib, W * 0.4, D * 0.05, 1.8);
  addLitterBin(root, lib, -W * 0.18, D * 0.1);
  addPublicToilet(root, lib, W / 2 - 0.6, -D / 2 + 0.55, Math.PI, 0.03);
  // 花圃
  addPlanter2(root, lib, W / 2 - 0.4, D / 2 - 0.3);
  addPlanter2(root, lib, -W / 2 + 0.35, -D / 2 + 0.35);
  // 公園名牌
  addLabelSign(root, lib, {
    text: v === 0 ? '公園' : '休息公園',
    sub: 'PUBLIC PARK',
    x: 0,
    y: 0.62,
    z: D / 2 - 0.12,
    w: 1.2,
    h: 0.3,
    bg: '#1f5f3f',
    fg: '#ffffff',
    border: '#ffffff',
  });
  addFlagpole(root, lib, 0, -D / 2 + 0.3, 1.8, PAL.tramGreen);
}

/** 海濱長廊：欄杆、長椅、燈柱、棕櫚（1x1，臨水轉向；欄杆在 +x 海面）。 */
function buildPromenade(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  // 海濱木/石棧道
  addBox(root, lib.lambert(PAL.stoneLight), W - 0.1, 0.1, D - 0.1, 0, 0.06, 0);
  for (let i = 0; i < 4; i++) {
    addBox(root, lib.lambert(i % 2 === 0 ? PAL.concreteLight : PAL.wallGrey), W - 0.2, 0.02, (D - 0.4) / 4, 0, 0.12, -D / 2 + 0.3 + ((D - 0.4) / 4) * (i + 0.5));
  }
  // 海邊欄杆（+x 側）
  addRailing(root, lib, W / 2 - 0.1, -D / 2 + 0.1, W / 2 - 0.1, D / 2 - 0.1, 0.62, {
    y: 0.12,
    color: PAL.wallWhite,
    posts: 6,
  });
  addRailing(root, lib, W / 2 - 0.22, -D / 2 + 0.1, W / 2 - 0.22, D / 2 - 0.1, 0.3, {
    y: 0.12,
    color: PAL.aluminium,
    posts: 6,
  });
  // 長椅面向海
  addBench(root, lib, W * 0.05, -D * 0.25, Math.PI / 2, 0.12);
  addBench(root, lib, W * 0.05, D * 0.15, Math.PI / 2, 0.12);
  if (v === 1) addBench(root, lib, -W * 0.15, -D * 0.05, Math.PI / 2, 0.12);
  // 燈柱、棕櫚
  addLampPost(root, lib, -W * 0.2, -D * 0.38, 1.9, { y: 0.12 });
  addLampPost(root, lib, -W * 0.2, D * 0.38, 1.9, { y: 0.12 });
  addTree(root, lib, -W * 0.3, 0, 0.55, 'palm', v + 1, 0.12);
  // 垃圾桶、飲水機、告示牌
  addLitterBin(root, lib, -W / 2 + 0.25, D / 2 - 0.25);
  addBox(root, lib.lambert(PAL.steelGrey), 0.16, 0.5, 0.12, -W / 2 + 0.25, 0.45, -D / 2 + 0.25);
  addLabelSign(root, lib, {
    text: '海濱長廊',
    sub: 'VICTORIA HARBOUR PROMENADE',
    x: 0,
    y: 0.9,
    z: 0.2,
    w: 1.2,
    h: 0.32,
    bg: '#1b4f6a',
    fg: '#ffffff',
    border: '#ffffff',
  });
  // 救生圈
  addLifeRing(root, lib, W / 2 - 0.35, 1.0, D * 0.3, Math.PI / 2);
  // 雪糕車（variant 1）
  if (v === 1) {
    addIceCreamVan(root, lib, -W * 0.05, -D * 0.26, Math.PI / 2, 0.12);
  } else {
    addPlanter2(root, lib, -W * 0.35, D * 0.35);
  }
  // 地燈（海濱夜景）
  for (let i = 0; i < 3; i++) {
    addBox(root, lib.neonTube(PAL.neonCyan), 0.06, 0.03, 0.06, W * 0.2, 0.16, -D * 0.35 + i * 0.6);
  }
}


// ═══════════════════════════ Round 5 新增（11 種） ═══════════════════════════

/** 水塔：圓柱水缸＋支架（variant 1 為地面圓缸），1x1。 */
function buildWaterTower(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  pad(ctx, PAL.concreteLight, 0.06, 0.02);
  addWaterTower(root, lib, 0, 0, 0.04, { squat: v === 1, color: v === 0 ? PAL.aluminium : PAL.steelGrey });
  // 食水主管接入（藍色喉管＋閥門）
  addPipeRun(root, lib, new THREE.Vector3(-W / 2 + 0.12, 0.2, 0.42), new THREE.Vector3(-0.05, 0.2, 0.42), 0.11, PAL.kcrBlue);
  addCylinder(root, lib.lambert(PAL.fireRed), 0.09, 0.09, 0.06, -W / 2 + 0.38, 0.28, 0.42, 8);
  // 圍欄、警示、樹木、垃圾桶
  addFence(root, lib, -W / 2 + 0.12, D / 2 - 0.1, W / 2 - 0.12, D / 2 - 0.1, 0.62, { color: PAL.steelGrey });
  addHazardStripe(root, lib, 0, D / 2 - 0.18, W - 0.45, 0.1, 0, 0.14);
  addTree(root, lib, W / 2 - 0.32, -D / 2 + 0.32, 0.34, 'banyan', v + 3, 0.02);
  addLitterBin(root, lib, -W / 2 + 0.28, -D / 2 + 0.32);
}

/** 海水化淡廠：廠房＋RO 膜組＋海水取水口／管道（3x3，臨海，+x 向海）。 */
function buildDesalPlant(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  asphaltPad(ctx);
  // 海邊混凝土岸線＋黃黑警示
  addBox(root, lib.lambert(PAL.concreteLight), 0.8, 0.26, D - 0.4, W / 2 - 0.42, 0.13, 0);
  addHazardStripe(root, lib, W / 2 - 0.9, 0, 0.16, D - 0.7, 0, 0.2);
  // 主廠房（逆滲透大樓，鋁窗工業立面）
  addTower(root, lib, {
    x: -1.15,
    z: -0.6,
    w: 2.5,
    d: 4.0,
    h: 2.5,
    y0: 0.04,
    style: 'aluminium',
    wallColor: PAL.concreteLight,
    roofColor: PAL.concreteDark,
    repeatMul: 0.8,
  });
  addRooftopClutter(root, lib, 2.1, 3.2, 2.58, v + 3, { tanks: 1, antennas: 1, ac: 2, vents: true });
  // 副廠房（預處理／控制室）
  addTower(root, lib, {
    x: -1.0,
    z: 2.2,
    w: 2.3,
    d: 1.2,
    h: 1.7,
    y0: 0.04,
    style: null,
    wallColor: PAL.factoryCream,
    roofColor: PAL.concreteDark,
  });
  addBox(root, lib.lambert(PAL.aluminiumDark), 2.36, 0.08, 1.26, -1.0, 1.78, 2.2);
  // 海水取水口＋入水管（伸向 +x 海面）
  const pipeZ = v === 0 ? [-1.3, 0.9] : [-1.5, 0.2];
  for (const pz of pipeZ) {
    addCylinder(root, lib.lambert(PAL.steelGrey), 0.2, 0.2, 2.9, 1.45, 0.38, pz, 10, 0, Math.PI / 2);
    addBox(root, lib.lambert(PAL.concrete), 0.22, 0.4, 0.44, 0.4, 0.2, pz);
    addBox(root, lib.lambert(PAL.concrete), 0.22, 0.4, 0.44, 2.1, 0.2, pz);
    // 取水格柵
    addBox(root, lib.lambert(PAL.cargoBlue), 0.32, 0.72, 0.72, 2.78, 0.4, pz);
    for (let i = 0; i < 3; i++) {
      addBox(root, lib.lambert(PAL.steelGrey), 0.02, 0.64, 0.05, 2.95, 0.4, pz - 0.22 + i * 0.22);
    }
  }
  // 前處理沉澱池 ×2
  const tankZ = v === 0 ? [-1.8, 1.6] : [-1.9, 1.9];
  for (const pz of tankZ) {
    addBox(root, lib.lambert(PAL.concreteLight), 1.5, 0.5, 1.2, 1.25, 0.27, pz);
    addBox(root, lib.lambert(PAL.poolWater), 1.36, 0.03, 1.06, 1.25, 0.54, pz);
    addCylinder(root, lib.lambert(PAL.concrete), 1.5, 1.5, 0.06, 1.25, 0.56, pz, 0);
    addRailing(root, lib, 0.55, pz + 0.62, 1.95, pz + 0.62, 0.35, { y: 0.55, color: PAL.aluminium, posts: 4 });
  }
  // RO 膜組架（一排排圓筒）
  for (let r = 0; r < 3; r++) {
    const ry = 0.45 + r * 0.34;
    addBox(root, lib.lambert(PAL.steelGrey), 1.9, 0.09, 0.78, 0.35, ry, 0.55);
    for (let i = 0; i < 5; i++) {
      addCylinder(root, lib.lambert(PAL.aluminium), 0.105, 0.105, 1.75, 0.35, ry + 0.13, 0.3 + i * 0.13, 6, 0, Math.PI / 2);
    }
  }
  // 化學品儲罐
  for (const [tx, tz] of [
    [-2.35, 1.85],
    [-2.35, 0.92],
  ]) {
    addCylinder(root, lib.lambert(PAL.tileWhite), 0.32, 0.34, 1.1, tx, 0.59, tz, 10);
    addCylinder(root, lib.lambert(PAL.steelGrey), 0.34, 0.34, 0.06, tx, 1.16, tz, 10);
  }
  // 泵房＋變壓器＋管道
  addBox(root, lib.lambert(PAL.tileWhite), 1.2, 1.0, 1.1, -2.4, 0.54, -1.1);
  addBox(root, lib.lambert(PAL.aluminiumDark), 1.26, 0.08, 1.16, -2.4, 1.08, -1.1);
  addBox(root, lib.lambert(PAL.glassDark), 0.42, 0.3, 0.02, -2.4, 0.7, -0.54);
  addTransformer(root, lib, -2.0, 0.1, 0.04, 1.0);
  addPipeRun(root, lib, new THREE.Vector3(-1.9, 1.9, -2.4), new THREE.Vector3(-0.5, 1.9, -2.9), 0.09, PAL.steelGrey);
  addPipeRun(root, lib, new THREE.Vector3(-0.2, 1.4, -2.6), new THREE.Vector3(-0.2, 1.4, 1.4), 0.08, PAL.steelGrey);
  // 圍欄、照明、樹
  addFence(root, lib, -W / 2 + 0.14, -D / 2 + 0.16, W / 2 - 0.3, -D / 2 + 0.16, 0.95, { color: PAL.steelGrey });
  addFence(root, lib, W / 2 - 0.2, -D / 2 + 0.2, W / 2 - 0.2, D / 2 - 0.2, 0.95, { color: PAL.steelGrey });
  addFloodlightMast(root, lib, -W / 2 + 0.55, -D / 2 + 0.6, 2.4, 0.04, { glow: false });
  addFloodlightMast(root, lib, W / 2 - 1.1, D / 2 - 0.8, 2.2, 0.04, { glow: false, heads: 2 });
  addTree(root, lib, -W / 2 + 0.45, D / 2 - 0.45, 0.4, 'palm', v + 2, 0.04);
  addTree(root, lib, -W / 2 + 0.95, D / 2 - 0.35, 0.32, 'banyan', v + 4, 0.04);
  addLitterBin(root, lib, W / 2 - 1.3, D / 2 - 0.3);
}

/** 污水處理廠：沉澱池＋曝氣池＋污泥房（3x2，臨海，+x 向海）。 */
function buildSewagePlant(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  grassPad(ctx);
  addBox(root, lib.lambert(PAL.concreteLight), W - 0.3, 0.06, D - 0.4, 0, 0.06, 0);
  // 污泥處理房
  addTower(root, lib, {
    x: -2.0,
    z: -1.15,
    w: 1.9,
    d: 1.2,
    h: 1.5,
    y0: 0.06,
    style: null,
    wallColor: PAL.concreteLight,
    roofColor: PAL.concreteDark,
  });
  // 鼓風機房
  addTower(root, lib, {
    x: -2.05,
    z: 0.55,
    w: 1.35,
    d: 1.05,
    h: 1.15,
    y0: 0.06,
    style: null,
    wallColor: PAL.tileWhite,
    roofColor: PAL.concrete,
  });
  // 控制室
  addTower(root, lib, {
    x: 0.15,
    z: -1.35,
    w: 1.15,
    d: 0.9,
    h: 1.0,
    y0: 0.06,
    style: null,
    wallColor: PAL.tileWhite,
    roofColor: PAL.concrete,
  });
  addBox(root, lib.lambert(PAL.glassDark), 0.9, 0.26, 0.02, 0.15, 0.72, -0.89);
  // 兩座圓形沉澱池
  addClarifierTank(root, lib, 1.55, v === 0 ? -1.0 : -0.9, 0.06, 0.78, 0.42);
  addClarifierTank(root, lib, 1.55, 1.02, 0.06, 0.78, 0.42);
  if (v === 1) addClarifierTank(root, lib, 0.35, 0.35, 0.06, 0.62, 0.36);
  // 曝氣池
  addAerationTank(root, lib, -0.55, 1.1, 2.1, 1.05, 0.06);
  // 污泥乾燥床
  for (let i = 0; i < 2; i++) {
    addBox(root, lib.lambert(PAL.concreteLight), 0.95, 0.24, 0.6, -0.75 + i * 1.1, 0.18, -0.25);
    addBox(root, lib.lambert(PAL.gravel), 0.8, 0.04, 0.48, -0.75 + i * 1.1, 0.32, -0.25);
  }
  // 連接管道
  addPipeRun(root, lib, new THREE.Vector3(-1.3, 0.55, 0.55), new THREE.Vector3(-0.4, 0.55, 1.1), 0.09, PAL.steelGrey);
  addPipeRun(root, lib, new THREE.Vector3(0.7, 0.5, 0.55), new THREE.Vector3(1.1, 0.5, -0.2), 0.08, PAL.steelGrey);
  addCylinder(root, lib.lambert(PAL.kcrBlue), 0.06, 0.06, 1.2, 0.7, 0.5, 0.5, 6, 0, Math.PI / 2);
  // 海邊出水口／岸線
  addBox(root, lib.lambert(PAL.concreteLight), 0.7, 0.24, D - 0.5, W / 2 - 0.4, 0.12, 0);
  addCylinder(root, lib.lambert(PAL.concreteDark), 0.13, 0.13, 0.9, W / 2 - 0.15, 0.26, 1.0, 8, 0, Math.PI / 2);
  addHazardStripe(root, lib, W / 2 - 0.82, 0, 0.14, D - 0.7, 0, 0.18);
  // 圍欄、樹、照明
  addFence(root, lib, -W / 2 + 0.12, -D / 2 + 0.14, W / 2 - 0.4, -D / 2 + 0.14, 0.9, { color: PAL.steelGrey });
  addFence(root, lib, -W / 2 + 0.12, D / 2 - 0.12, W / 2 - 0.6, D / 2 - 0.12, 0.9, { color: PAL.steelGrey });
  addTree(root, lib, -W / 2 + 0.45, D / 2 - 0.5, 0.42, 'banyan', v + 3, 0.06);
  addTree(root, lib, W / 2 - 1.2, D / 2 - 0.5, 0.34, 'flower', v + 5, 0.06);
  addFloodlightMast(root, lib, -W / 2 + 0.5, -D / 2 + 0.55, 2.2, 0.06, { glow: false, heads: 2 });
  // 廠名牌（land side = -x，面向 -x；只有 1 個 label 材質）
  addLabelSign(root, lib, {
    text: '污水處理廠',
    sub: 'SEWAGE TREATMENT WORKS',
    x: -W / 2 + 0.06,
    y: 1.15,
    z: 0.1,
    w: 1.9,
    h: 0.5,
    ry: -Math.PI / 2,
    bg: '#1f5f3f',
    fg: '#ffffff',
    border: '#ffffff',
  });
  addLitterBin(root, lib, -W / 2 + 0.35, D / 2 - 0.35);
}

/** 排污口：海邊大口徑排污管＋擴散器＋警示牌（1x1，臨海，+x 向海）。 */
function buildSewageOutfall(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  // 岸邊混凝土平台
  addBox(root, lib.lambert(PAL.concreteLight), W - 0.1, 0.16, D - 0.2, 0, 0.08, 0);
  addBox(root, lib.lambert(PAL.concreteDark), 0.7, 0.2, D - 0.2, -W / 2 + 0.35, 0.02, 0);
  addOutfallPipe(root, lib, -0.2, 0.06, 0, v === 0 ? 2.0 : 1.7);
  // 岸上控制箱／閥室
  addBox(root, lib.lambert(PAL.concreteLight), 0.6, 0.55, 0.5, -W / 2 + 0.42, 0.44, -0.35);
  addBox(root, lib.lambert(PAL.ironDark), 0.24, 0.3, 0.06, -W / 2 + 0.42, 0.4, -0.08);
  addBox(root, lib.lambert(PAL.aluminiumDark), 0.64, 0.07, 0.54, -W / 2 + 0.42, 0.75, -0.35);
  // 喉管支架＋警示黃黑柱
  addCylinder(root, lib.lambert(PAL.hazardYellow), 0.07, 0.07, 0.7, -0.6, 0.35, 0.6, 8);
  addCylinder(root, lib.lambert(PAL.hazardBlack), 0.08, 0.08, 0.1, -0.6, 0.55, 0.6, 8);
  addHazardStripe(root, lib, -0.2, D / 2 - 0.1, 1.2, 0.12, 0, 0.15);
  // 污水分支管接入
  addPipeRun(root, lib, new THREE.Vector3(-W / 2 + 0.2, 0.3, -0.5), new THREE.Vector3(-0.2, 0.3, -0.35), 0.11, PAL.steelGrey);
  // 警示牌（land side = -x，面向 -x；1 個 label）
  addLabelSign(root, lib, {
    text: '排污口',
    sub: 'SEWAGE OUTFALL · 污水排放',
    x: -W / 2 + 0.05,
    y: 0.85,
    z: 0.42,
    w: 1.1,
    h: 0.32,
    ry: -Math.PI / 2,
    bg: '#d9b23f',
    fg: '#2a2a2a',
    border: '#2a2a2a',
  });
  addTree(root, lib, -W / 2 + 0.35, D / 2 - 0.35, 0.3, 'banyan', v + 2, 0.1);
}

/** 路邊巴士站：候車亭＋站牌＋路線牌（1x1）。 */
function buildBusStop(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  pad(ctx, PAL.concreteLight, 0.04, 0.02);
  if (v === 0) {
    addBusShelter(root, lib, 0, 0.15, 0, 0.03, { routes: '1A 5 9 11K', bench: true });
  } else {
    // 無上蓋版本：站牌＋長椅＋排隊欄
    addBusShelter(root, lib, 0, 0.15, 0, 0.03, { routes: '6 6A 6C 106', bench: false });
    addBox(root, lib.lambert(PAL.busYellow), 1.2, 0.06, 0.5, -0.35, 0.06, -0.32);
    addCylinder(root, lib.lambert(PAL.steelGrey), 0.03, 0.035, 1.25, -0.6, 0.66, -0.32, 6);
    addCylinder(root, lib.lambert(PAL.steelGrey), 0.03, 0.035, 1.25, 0.5, 0.66, -0.32, 6);
  }
  // 巴士站黃格（路面標線）
  addBox(root, lib.lambert(PAL.roadYellow), W - 0.35, 0.012, 0.08, 0, 0.05, D / 2 - 0.16);
  addBox(root, lib.lambert(PAL.roadYellow), W - 0.35, 0.012, 0.08, 0, 0.05, D / 2 - 0.42);
  // 綠化＋垃圾桶
  addBox(root, lib.lambert(PAL.leafDark), 0.36, 0.18, 0.36, -W / 2 + 0.28, 0.11, -D / 2 + 0.28);
  addTree(root, lib, -W / 2 + 0.28, -D / 2 + 0.28, 0.26, 'shrub', v + 4, 0.06);
  addLitterBin(root, lib, W / 2 - 0.25, D / 2 - 0.3);
}

/** 綠色專線小巴站：綠頂站牌＋路線牌（1x1）。 */
function buildMinibusStop(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  pad(ctx, PAL.concreteLight, 0.04, 0.02);
  addMinibusStopSign(root, lib, v === 0 ? 0 : -0.15, 0.15, v === 0 ? 0 : Math.PI, 0.03, v === 0 ? '44 44A 77' : '54 55 56');
  // 綠色小巴站路面標記
  addBox(root, lib.lambert(PAL.tramGreen), W - 0.4, 0.012, 0.1, 0, 0.05, D / 2 - 0.16);
  addBox(root, lib.lambert(PAL.wallWhite), 0.5, 0.014, 0.16, -W / 2 + 0.4, 0.06, D / 2 - 0.16);
  // 小巴站簷篷（v1）
  if (v === 1) {
    addBox(root, lib.lambert(PAL.tramGreen), 1.3, 0.06, 0.7, 0.2, 1.28, 0.42);
    addCylinder(root, lib.lambert(PAL.steelGrey), 0.03, 0.035, 1.25, -0.4, 0.65, 0.66, 6);
    addCylinder(root, lib.lambert(PAL.steelGrey), 0.03, 0.035, 1.25, 0.8, 0.65, 0.66, 6);
  }
  addLitterBin(root, lib, W / 2 - 0.25, D / 2 - 0.3);
  addTree(root, lib, -W / 2 + 0.28, -D / 2 + 0.3, 0.28, 'flower', v + 3, 0.06);
}

/** 小巴車廠：車棚＋兩部小巴＋維修房（2x2）。 */
function buildMinibusDepot(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  asphaltPad(ctx);
  // 泊車位黃線
  for (let i = 0; i < 3; i++) {
    addBox(root, lib.lambert(PAL.roadYellow), 0.07, 0.012, 1.5, -1.35 + i * 1.1, 0.055, -0.2);
  }
  // 車棚（懸臂上蓋＋柱）
  addBox(root, lib.lambert(PAL.aluminium), 2.9, 0.09, 2.1, 0.1, 1.72, -0.45);
  addBox(root, lib.lambert(PAL.tramGreen), 2.94, 0.12, 0.1, 0.1, 1.66, 0.58);
  for (const [px, pz] of [
    [-1.2, -1.35],
    [1.4, -1.35],
    [-1.2, 0.4],
    [1.4, 0.4],
  ]) {
    addCylinder(root, lib.lambert(PAL.steelGrey), 0.05, 0.06, 1.7, px, 0.85, pz, 6);
  }
  // 兩部小巴（綠／紅）
  addMinibus(root, lib, -0.65, -0.55, 0, 0.04, false);
  addMinibus(root, lib, 0.75, -0.55, 0, 0.04, v === 1);
  // 維修房＋捲閘
  addTower(root, lib, {
    x: -0.85,
    z: 1.25,
    w: 1.9,
    d: 0.95,
    h: 1.35,
    y0: 0.04,
    style: null,
    wallColor: PAL.factoryCream,
    roofColor: PAL.concreteDark,
  });
  addRollerDoor(root, lib, -1.1, 0.04, 1.71, 0.8, 1.0, 0, PAL.steelGrey);
  addBox(root, lib.lambert(PAL.glassDark), 0.5, 0.3, 0.02, -0.1, 0.8, 1.73);
  // 油泵＋輪胎＋雜物
  addBox(root, lib.lambert(PAL.fireRed), 0.24, 0.5, 0.24, 1.35, 0.29, 0.95);
  addBox(root, lib.lambert(PAL.ironDark), 0.12, 0.16, 0.1, 1.35, 0.6, 1.0);
  addCylinder(root, lib.lambert(PAL.ironDark), 0.07, 0.07, 0.1, 1.35, 0.66, 1.12, 6, 0, Math.PI / 2);
  for (let i = 0; i < 3; i++) {
    addCylinder(root, lib.lambert(PAL.hazardBlack), 0.2, 0.2, 0.1, 1.45, 0.12 + i * 0.11, -1.45, 10);
  }
  addBox(root, lib.lambert(PAL.woodLight), 0.4, 0.3, 0.36, 1.2, 0.2, 1.4);
  // 圍欄、燈、名牌
  addFence(root, lib, -W / 2 + 0.12, -D / 2 + 0.14, W / 2 - 0.12, -D / 2 + 0.14, 0.75, { color: PAL.steelGrey });
  addFence(root, lib, -W / 2 + 0.12, -D / 2 + 0.2, -W / 2 + 0.12, D / 2 - 0.2, 0.75, { color: PAL.steelGrey });
  addLampPost(root, lib, -W / 2 + 0.4, -D / 2 + 0.45, 1.9, { y: 0.04, neon: false });
  addTree(root, lib, W / 2 - 0.35, D / 2 - 0.35, 0.32, 'banyan', v + 2, 0.04);
  addLabelSign(root, lib, {
    text: '小巴車廠',
    sub: 'MINIBUS DEPOT',
    x: 0.1,
    y: 1.15,
    z: D / 2 - 0.42,
    w: 1.5,
    h: 0.4,
    bg: '#2f7f4f',
    fg: '#ffffff',
    border: '#ffffff',
  });
}

/** 機場客運大樓：流線拱頂＋玻璃幕牆＋控制塔＋登機橋＋客機（4x3）。 */
function buildAirportTerminal(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  pad(ctx, PAL.concreteLight, 0.06, 0.02);
  // 停機坪（後方 -z）
  addBox(root, lib.lambert(PAL.roadAsphalt), W - 0.2, 0.03, D * 0.48, 0, 0.05, -D / 2 + D * 0.24);
  // 客運大樓主樓（玻璃幕牆）
  addTower(root, lib, {
    x: 0.2,
    z: 1.5,
    w: 6.6,
    d: 1.9,
    h: 2.35,
    y0: 0.05,
    style: 'glassBlue',
    wallColor: PAL.glassBlue,
    roofColor: PAL.wallWhite,
    repeatMul: 1.15,
  });
  // 流線拱頂（兩段不同高度）
  addBarrelRoof(root, lib, 0.2, 2.44, 1.5, 6.8, 2.15, 0.52, PAL.wallWhite);
  addBarrelRoof(root, lib, -2.55, 2.5, 1.5, 1.6, 1.9, 0.34, PAL.aluminium, 0);
  // 陸側入口玻璃＋雨棚
  addBox(root, lib.lambert(PAL.glassDark), 4.6, 1.5, 0.08, 0.2, 0.85, 2.47);
  for (let i = 0; i < 6; i++) {
    addBox(root, lib.lambert(PAL.aluminium), 0.06, 2.3, 0.1, -2.0 + i * 0.9, 1.2, 2.5);
  }
  addCanopy(root, lib, { x: 0.2, y: 1.55, z: 2.72, w: 5.4, d: 0.8, color: PAL.wallWhite });
  // 陸側落客位／的士站路面
  addBox(root, lib.lambert(PAL.roadAsphalt), W - 0.4, 0.02, 0.7, 0, 0.05, D / 2 - 0.4);
  for (let i = 0; i < 4; i++) {
    addBox(root, lib.lambert(PAL.roadLine), 0.06, 0.012, 0.5, -2.4 + i * 1.4, 0.07, D / 2 - 0.45);
  }
  // 西翼候機廊
  addTower(root, lib, {
    x: -3.35,
    z: 1.0,
    w: 1.2,
    d: 1.5,
    h: 1.6,
    y0: 0.05,
    style: null,
    wallColor: PAL.tileWhite,
    roofColor: PAL.concreteLight,
  });
  // 控制塔＋雷達
  addControlTower(root, lib, -3.3, -1.35, 2.7, 0.05);
  addRadarDish(root, lib, -2.5, -2.3, 0.05, 0.9);
  // 登機橋 ×2（由主樓後方伸向停機坪）
  addJetBridge(root, lib, -1.5, 0.95, 0.62, 1.5);
  addJetBridge(root, lib, 1.9, 0.95, 0.62, 1.5);
  // 客機 ×2（機頭向客運大樓）
  addAircraft(root, lib, -1.5, -1.55, -Math.PI / 2, 0.04, 0.78, { livery: v === 0 ? 0xb02a2a : 0x2f5f9f });
  addAircraft(root, lib, 1.9, -1.55, -Math.PI / 2, 0.04, 0.78, { livery: v === 0 ? 0x2f5f9f : 0xc9a24c });
  // 停機坪標線、照明
  addBox(root, lib.lambert(PAL.roadYellow), W - 1.4, 0.012, 0.07, 0, 0.07, -2.55);
  addFloodlightMast(root, lib, -3.3, -2.55, 2.5, 0.05, { glow: false });
  addFloodlightMast(root, lib, 3.4, -2.55, 2.5, 0.05, { glow: false });
  addFence(root, lib, -W / 2 + 0.12, -D / 2 + 0.12, W / 2 - 0.12, -D / 2 + 0.12, 0.9, { color: PAL.steelGrey });
  // 客運大樓名牌（正面 +z；1 個 label 材質）
  addLabelSign(root, lib, {
    text: v === 0 ? '香港國際機場' : '赤鱲角機場',
    sub: 'HONG KONG INTERNATIONAL AIRPORT',
    x: 0.2,
    y: 1.95,
    z: 2.56,
    w: 3.4,
    h: 0.55,
    bg: '#1b2b33',
    fg: '#eaf4ff',
    border: '#24e0ff',
  });
  addTree(root, lib, 2.9, D / 2 - 0.35, 0.32, 'palm', v + 2, 0.05);
  addLitterBin(root, lib, -2.6, D / 2 - 0.3);
}

/** 空運貨運站：貨運庫＋空運貨櫃＋貨機（3x2）。 */
function buildAirCargoTerminal(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  asphaltPad(ctx);
  // 貨運庫（拱頂）
  addTower(root, lib, {
    x: -0.55,
    z: 0.6,
    w: 4.1,
    d: 1.9,
    h: 2.2,
    y0: 0.04,
    style: null,
    wallColor: PAL.wallGrey,
    roofColor: PAL.concreteDark,
  });
  addBarrelRoof(root, lib, -0.55, 2.28, 0.6, 4.25, 2.1, 0.42, PAL.aluminium);
  // 空運貨物捲閘（面向停機坪 -z）
  for (let i = 0; i < 3; i++) {
    addRollerDoor(root, lib, -1.75 + i * 1.25, 0.04, -0.39, 0.95, 1.4, Math.PI, i === 1 ? PAL.cargoBlue : PAL.steelGrey);
    addBox(root, lib.lambert(PAL.hazardYellow), 0.95, 0.05, 0.06, -1.75 + i * 1.25, 0.04, -0.33);
  }
  // 卸貨平台
  addBox(root, lib.lambert(PAL.concreteLight), 3.9, 0.2, 0.7, -0.55, 0.12, -0.75);
  // 停機坪
  addBox(root, lib.lambert(PAL.roadAsphalt), W - 0.2, 0.03, D * 0.42, 0, 0.05, -D / 2 + D * 0.21);
  // 貨機（機頭向貨運站）
  addAircraft(root, lib, 2.2, -1.35, -Math.PI / 2, 0.04, 0.7, { cargo: true, livery: v === 0 ? PAL.cargoGreen : PAL.cargoBlue });
  // 空運貨櫃／卡板
  addContainerStack(root, lib, -2.25, -1.25, 1, 1, 2, v + 2);
  for (let i = 0; i < 4; i++) {
    addBox(root, lib.lambert(PAL.woodLight), 0.4, 0.22, 0.34, -1.3 + i * 0.5, 0.16, -1.5);
    addBox(root, lib.lambert(PAL.cargoOrange), 0.42, 0.05, 0.36, -1.3 + i * 0.5, 0.29, -1.5);
  }
  // 貨物裝卸車（輸送帶車）
  addBox(root, lib.lambert(PAL.busYellow), 0.5, 0.3, 0.4, 0.2, 0.25, -1.0);
  addBox(root, lib.lambert(PAL.steelGrey), 0.12, 0.5, 1.0, 0.55, 0.5, -1.0).rotation.x = -0.4;
  addBox(root, lib.lambert(PAL.ironDark), 0.5, 0.1, 0.44, 0.2, 0.06, -1.0);
  // 辦公翼＋雷達＋照明＋圍欄
  addTower(root, lib, {
    x: 2.35,
    z: 0.95,
    w: 1.15,
    d: 1.2,
    h: 1.5,
    y0: 0.04,
    style: null,
    wallColor: PAL.tileWhite,
    roofColor: PAL.concreteLight,
  });
  addBox(root, lib.lambert(PAL.glassDark), 0.9, 0.3, 0.02, 2.35, 1.0, 1.56);
  addRadarDish(root, lib, 2.6, -1.9, 0.04, 0.55);
  addFloodlightMast(root, lib, -W / 2 + 0.5, -D / 2 + 0.55, 2.4, 0.04, { glow: false, heads: 2 });
  addFence(root, lib, -W / 2 + 0.12, -D / 2 + 0.12, W / 2 - 0.12, -D / 2 + 0.12, 0.85, { color: PAL.steelGrey });
  addHazardStripe(root, lib, -W / 2 + 0.14, -D / 2 + 0.3, 0.14, D - 1.0, 0, 0.16);
  // 名牌（正面 +z）
  addLabelSign(root, lib, {
    text: '空運貨運站',
    sub: 'AIR CARGO TERMINAL',
    x: -0.55,
    y: 1.85,
    z: 1.57,
    w: 2.2,
    h: 0.5,
    bg: '#3f4a3a',
    fg: '#ffd166',
    border: '#ffd166',
  });
  addTree(root, lib, -2.6, D / 2 - 0.35, 0.3, 'banyan', v + 3, 0.04);
  addLitterBin(root, lib, 2.4, D / 2 - 0.3);
}

/** 碼頭閘口：龍門架＋閘亭＋自動閘桿＋貨櫃車（2x2）。 */
function buildPortGate(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  asphaltPad(ctx, true);
  // 三條行車線（沿 z 方向穿過閘口）
  for (const lx of [-1.2, 0, 1.2]) {
    addBox(root, lib.lambert(PAL.roadLine), 0.06, 0.012, 2.6, lx, 0.08, -0.2);
    addBox(root, lib.lambert(PAL.roadYellow), 0.06, 0.012, 0.5, lx, 0.08, 1.5);
  }
  // 龍門架
  addGatePortal(root, lib, 0, 0.55, 3.3, 1.75, 0.05);
  // 閘亭 ×2
  addGateBooth(root, lib, -1.7, 1.15, 0, 0.05);
  addGateBooth(root, lib, 1.7, 1.15, 0, 0.05);
  // 自動閘桿（車道入口）
  for (const lx of [-1.2, 0, 1.2]) {
    addBoomBarrier(root, lib, lx - 0.55, 0.05, 0.15, 0, 1.05, false);
  }
  // 等待過閘的貨櫃車 ×2
  addContainerTruck(root, lib, -1.2, -1.0, Math.PI / 2, 0.05, v === 0 ? PAL.cargoRed : PAL.cargoBlue);
  if (v === 1) addContainerTruck(root, lib, 1.2, -1.5, Math.PI / 2, 0.05, PAL.cargoYellow);
  // 輪胎護欄、CCTV、照明、圍欄
  for (let i = 0; i < 3; i++) {
    addCylinder(root, lib.lambert(PAL.hazardBlack), 0.18, 0.18, 0.12, -1.85 + i * 1.85, 0.11, -1.85, 10);
  }
  addCylinder(root, lib.lambert(PAL.steelGrey), 0.035, 0.045, 2.1, -W / 2 + 0.3, 1.05, -D / 2 + 0.4, 6);
  addBox(root, lib.lambert(PAL.ironDark), 0.14, 0.14, 0.24, -W / 2 + 0.3, 2.16, -D / 2 + 0.52);
  addCylinder(root, lib.lambert(PAL.steelGrey), 0.035, 0.045, 2.1, W / 2 - 0.3, 1.05, -D / 2 + 0.4, 6);
  addBox(root, lib.lambert(PAL.ironDark), 0.24, 0.14, 0.14, W / 2 - 0.42, 2.16, -D / 2 + 0.4);
  addFloodlightMast(root, lib, 1.9, -1.85, 2.4, 0.05, { glow: true, heads: 2 });
  addFence(root, lib, -W / 2 + 0.12, -D / 2 + 0.12, W / 2 - 0.12, -D / 2 + 0.12, 0.8, { color: PAL.steelGrey });
  addFence(root, lib, -W / 2 + 0.12, -D / 2 + 0.12, -W / 2 + 0.12, D / 2 - 0.25, 0.8, { color: PAL.steelGrey });
  // 閘口名牌（貼在龍門架橫樑；1 個 label）
  addLabelSign(root, lib, {
    text: '碼頭閘口',
    sub: 'PORT GATE',
    x: 0,
    y: 1.98,
    z: 0.66,
    w: 2.0,
    h: 0.4,
    bg: '#2a3238',
    fg: '#ffd166',
    border: '#ffd166',
  });
  addTree(root, lib, -W / 2 + 0.4, D / 2 - 0.35, 0.3, 'banyan', v + 3, 0.05);
}

/** 貨櫃堆場：貨櫃堆＋龍門吊（靜態）＋高桿燈（3x2）。 */
function buildPortYard(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  asphaltPad(ctx, true);
  // 貨櫃堆
  const stacks: [number, number, number, number, number][] =
    v === 0
      ? [
          [-1.75, -0.95, 2, 2, 3],
          [1.15, -1.0, 2, 2, 2],
          [-1.75, 0.95, 2, 1, 2],
          [1.35, 1.05, 1, 2, 2],
        ]
      : [
          [-1.9, -1.0, 1, 2, 3],
          [-0.7, -1.0, 1, 2, 2],
          [1.3, -0.9, 2, 2, 3],
          [-1.4, 0.95, 2, 1, 2],
        ];
  for (const [sx, sz, cols, rows, layers] of stacks) {
    addContainerStack(root, lib, sx, 0.05, sz, cols, rows, layers, v + cols * 7 + rows * 3);
  }
  // 龍門吊（靜態；beacon 併入 vertexNeon 桶、不加字牌）
  addGantryCrane(root, lib, v === 0 ? 0.1 : 0.8, 0.1, Math.PI / 2, 0.05, 0.82, {
    anim: false,
    sign: false,
    beacon: true,
  });
  // 場內通道黃線
  addBox(root, lib.lambert(PAL.roadYellow), W - 0.5, 0.012, 0.07, 0, 0.06, 0.05);
  addBox(root, lib.lambert(PAL.roadLine), 0.07, 0.012, D - 0.4, 0, 0.06, 0);
  // 堆場辦公室（貨櫃改裝）＋龍門吊操作員休息室
  addBox(root, lib.lambert(PAL.wallWhite), 1.3, 0.65, 0.6, W / 2 - 0.9, 0.38, D / 2 - 0.5);
  addBox(root, lib.lambert(PAL.cargoBlue), 1.32, 0.07, 0.62, W / 2 - 0.9, 0.73, D / 2 - 0.5);
  addBox(root, lib.lambert(PAL.glassDark), 0.44, 0.24, 0.02, W / 2 - 0.9, 0.5, D / 2 - 0.19);
  // 高桿燈（夜間 vertexNeon）
  addFloodlightMast(root, lib, -W / 2 + 0.5, -D / 2 + 0.5, 2.8, 0.05, { glow: true, heads: 3 });
  addFloodlightMast(root, lib, W / 2 - 0.5, -D / 2 + 0.5, 2.8, 0.05, { glow: true, heads: 3 });
  // 圍欄、輪胎、垃圾桶
  addFence(root, lib, -W / 2 + 0.12, -D / 2 + 0.12, W / 2 - 0.12, -D / 2 + 0.12, 1.0, { color: PAL.steelGrey });
  addFence(root, lib, -W / 2 + 0.12, -D / 2 + 0.2, -W / 2 + 0.12, D / 2 - 0.2, 1.0, { color: PAL.steelGrey });
  addHazardStripe(root, lib, 0, D / 2 - 0.12, W - 0.5, 0.12, 0, 0.16);
  addLitterBin(root, lib, -W / 2 + 0.4, D / 2 - 0.35);
  // 場名牌（正面 +z；1 個 label）
  addLabelSign(root, lib, {
    text: '貨櫃堆場',
    sub: 'CONTAINER YARD',
    x: -W / 2 + 1.35,
    y: 1.35,
    z: D / 2 - 0.42,
    w: 1.8,
    h: 0.46,
    bg: '#1b2b33',
    fg: '#24e0ff',
    border: '#24e0ff',
  });
  addTree(root, lib, W / 2 - 0.4, -D / 2 + 0.4, 0.32, 'banyan', v + 5, 0.05);
}


// ═══════════════════════════ Round 6 新增：邊境口岸（2 種） ═══════════════════════════

/** 道路口岸（深圳灣／落馬洲式）：檢查亭＋閘杆＋排隊車輛＋「往深圳」指示牌＋LED＋邊境圍欄（3x2）。 */
function buildRoadBorderGate(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  asphaltPad(ctx);
  const lanes = v === 0 ? [-1.45, 0, 1.45] : [-1.7, -0.35, 1.0, 2.0];
  // ── 車道標線（沿 z 方向過關）──
  for (const lx of lanes) {
    addBox(root, lib.lambert(PAL.roadLine), 0.06, 0.012, D - 0.6, lx, 0.08, 0);
    addBox(root, lib.lambert(PAL.roadLine), 0.06, 0.012, 0.4, lx, 0.08, D / 2 - 0.32);
  }
  // 停止線＋黃格
  addBox(root, lib.lambert(PAL.roadYellow), W - 1.0, 0.012, 0.08, 0, 0.08, 0.95);
  addHazardStripe(root, lib, -W / 2 + 0.5, -0.4, 0.35, 0.9, 0, 0.14);
  addHazardStripe(root, lib, W / 2 - 0.5, -0.4, 0.35, 0.9, 0, 0.14);
  // 檢查通道地面（車轍導引）
  for (const lx of lanes) {
    addBox(root, lib.lambert(PAL.ironDark), 0.9, 0.01, 1.8, lx, 0.06, 0.1);
  }
  // ── 大型檢查上蓋（橫跨車道）──
  const canopyW = W - 1.3;
  const canopyD = 1.7;
  addBox(root, lib.lambert(PAL.aluminium), canopyW, 0.12, canopyD, 0, 2.3, 0.1);
  addBox(root, lib.lambert(PAL.wallWhite), canopyW + 0.06, 0.06, canopyD + 0.06, 0, 2.39, 0.1);
  addBox(root, lib.lambert(PAL.steelGrey), canopyW, 0.18, 0.08, 0, 2.22, 0.1 + canopyD / 2);
  // 上蓋霓虹燈帶（夜間 vertexNeon）
  addBox(root, lib.neonTube(PAL.wallWhite), canopyW * 0.92, 0.035, 0.05, 0, 2.19, 0.1 + canopyD / 2 + 0.05);
  addBox(root, lib.neonTube(PAL.neonCyan), canopyW * 0.75, 0.03, 0.05, 0, 2.19, 0.1 - canopyD / 2 - 0.05);
  // 上蓋支柱
  const cols = v === 0 ? 4 : 5;
  for (let i = 0; i < cols; i++) {
    const px = -canopyW / 2 + 0.25 + ((canopyW - 0.5) / (cols - 1)) * i;
    addCylinder(root, lib.lambert(PAL.steelGrey), 0.055, 0.07, 2.25, px, 1.14, 0.1 + canopyD / 2 - 0.12, 6);
    addCylinder(root, lib.lambert(PAL.steelGrey), 0.045, 0.055, 2.25, px, 1.14, 0.1 - canopyD / 2 + 0.12, 6);
    addBeamBetween(
      root,
      lib.lambert(PAL.steelGrey),
      new THREE.Vector3(px, 2.2, 0.1 + canopyD / 2 - 0.12),
      new THREE.Vector3(px, 2.2, 0.1 - canopyD / 2 + 0.12),
      0.2,
      4,
    );
  }
  // ── 檢查亭（車道之間）──
  const boothX = v === 0 ? [-0.75, 0.75] : [-1.05, 0.35, 1.55];
  for (const bx of boothX) {
    addGateBooth(root, lib, bx, 0.1, 0, 0.05);
  }
  // ── 自動閘杆（紅白）──
  for (const lx of lanes) {
    addBoomBarrier(root, lib, lx - 0.45, 0.05, 0.62, 0, 0.9, false);
    addBoomBarrier(root, lib, lx - 0.45, 0.05, -0.55, Math.PI, 0.9, true);
  }
  // ── 大型方向指示牌龍門架（「往深圳」）──
  const signZ = D / 2 - 0.55;
  addBox(root, lib.lambert(PAL.steelGrey), 0.12, 2.7, 0.12, -W / 2 + 0.8, 1.35, signZ);
  addBox(root, lib.lambert(PAL.steelGrey), 0.12, 2.7, 0.12, W / 2 - 0.8, 1.35, signZ);
  addBox(root, lib.lambert(PAL.steelGrey), W - 1.5, 0.14, 0.14, 0, 2.62, signZ);
  addLabelSign(root, lib, {
    text: v === 0 ? '往深圳' : '深圳灣口岸',
    sub: v === 0 ? 'TO SHENZHEN · 落馬洲' : 'SHENZHEN BAY PORT',
    x: 0,
    y: 2.34,
    z: signZ + 0.09,
    w: 2.8,
    h: 0.5,
    bg: '#1f6b45',
    fg: '#ffffff',
    border: '#ffffff',
  });
  // ── LED 過關資訊屏（掛在上蓋前方）──
  addLedInfoBoard(root, lib, v === 0 ? -1.35 : -1.8, 1.82, 0.1 + canopyD / 2 + 0.06, 1.5, 0.42, 0, v === 0 ? ['往深圳 過關暢順', '請備回鄉證'] : ['深圳灣口岸', '車龍 15 分鐘'], '#ffb347');
  // ── 排隊／過關車輛（靜態）──
  addCoach(root, lib, lanes[1], 1.1, Math.PI / 2, 0.05, { livery: v === 0 ? 0x2f5f9f : 0xb02a2a });
  addContainerTruck(root, lib, lanes[0], -0.95, Math.PI / 2, 0.05, v === 0 ? PAL.cargoRed : PAL.cargoBlue);
  if (v === 1) addContainerTruck(root, lib, lanes[2], -1.3, Math.PI / 2, 0.05, PAL.cargoYellow);
  // ── 兩地邊境圍欄（左右＋後方留閘口）──
  addBorderFence(root, lib, -W / 2 + 0.12, -D / 2 + 0.15, -W / 2 + 0.12, D / 2 - 0.15, 1.3, { lamps: true });
  addBorderFence(root, lib, W / 2 - 0.12, -D / 2 + 0.15, W / 2 - 0.12, D / 2 - 0.15, 1.3, { lamps: true });
  addBorderFence(root, lib, -W / 2 + 0.12, -D / 2 + 0.15, -1.1, -D / 2 + 0.15, 1.3, { lamps: false });
  addBorderFence(root, lib, 1.1, -D / 2 + 0.15, W / 2 - 0.12, -D / 2 + 0.15, 1.3, { lamps: false });
  // ── CCTV、警示牌、速度限制牌 ──
  for (const [px, pz] of [
    [-W / 2 + 0.42, -D / 2 + 0.42],
    [W / 2 - 0.42, D / 2 - 0.42],
  ]) {
    addCylinder(root, lib.lambert(PAL.steelGrey), 0.035, 0.045, 2.2, px, 1.1, pz, 6);
    addBox(root, lib.lambert(PAL.ironDark), 0.16, 0.14, 0.26, px, 2.24, pz + 0.1);
  }
  addLabelSign(root, lib, {
    text: '邊境禁區',
    sub: 'BORDER AREA · 未經許可不得進入',
    x: -W / 2 + 0.95,
    y: 1.05,
    z: D / 2 - 0.12,
    w: 1.3,
    h: 0.42,
    bg: '#b02a2a',
    fg: '#ffffff',
    border: '#ffffff',
    ry: 0,
  });
  // 路面速度限制圈（幾何）
  addCylinder(root, lib.lambert(PAL.wallWhite), 0.22, 0.22, 0.04, -W / 2 + 1.65, 1.7, D / 2 - 0.2, 12, 0, Math.PI / 2);
  addBox(root, lib.lambert(PAL.hazardBlack), 0.28, 0.1, 0.02, -W / 2 + 1.65, 1.7, D / 2 - 0.17);
  // 綠化
  for (let i = 0; i < 3; i++) {
    addTree(root, lib, -W / 2 + 0.45 + i * 0.55, -D / 2 + 0.55, 0.26, 'shrub', v + i * 3, 0.05);
  }
  addLitterBin(root, lib, W / 2 - 0.35, D / 2 - 0.35);
}

/** 鐵路口岸（羅湖／落馬洲支線式）：月台＋雙軌＋客運/貨運列車在前面、車站大樓在後、海關棚、邊境圍欄（3x2）。 */
function buildRailBorderGate(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  const v = ctx.variant;
  pad(ctx, PAL.concreteLight, 0.06, 0.02);
  // 道碴地台（靠 +z 前方，等列車由遊戲鏡頭望得到）
  addBox(root, lib.lambert(PAL.concreteDark), W - 0.2, 0.05, D * 0.72, 0, 0.05, -D / 2 + D * 0.36 + 0.15);
  // ── 兩條重型鐵路軌（沿 x 穿過口岸）──
  const trackZ = v === 0 ? [0.85, 1.72] : [0.8, 1.66];
  for (const tz of trackZ) addHeavyRail(root, lib, 0, tz, W - 0.35, 0, 0.02);
  // ── 島式月台（軌道後方，+z 側為行車軌）──
  const platZ = v === 0 ? -0.18 : -0.1;
  addRailPlatform(root, lib, 0, platZ, W - 0.5, 0, 0.06, { canopy: true });
  // ── 車站大樓（月台後方／陸側）──
  const hallX = v === 0 ? -0.55 : -0.35;
  const hallW = v === 0 ? 3.8 : 4.1;
  addTower(root, lib, {
    x: hallX,
    z: -1.5,
    w: hallW,
    d: 0.8,
    h: 1.55,
    y0: 0.04,
    style: null,
    wallColor: PAL.tileWhite,
    roofColor: PAL.concreteLight,
  });
  addBox(root, lib.lambert(PAL.aluminium), hallW + 0.1, 0.09, 0.9, hallX, 1.64, -1.5);
  // 玻璃幕牆入口（面向 +z 月台／路）
  addBox(root, lib.lambert(PAL.glassDark), hallW - 0.7, 1.1, 0.06, hallX, 0.72, -1.08);
  for (let i = 0; i < 5; i++) {
    addBox(root, lib.lambert(PAL.aluminium), 0.05, 1.15, 0.1, hallX - hallW / 2 + 0.3 + i * ((hallW - 0.6) / 4), 0.72, -1.06);
  }
  // ── 站名牌（抬高到月台上蓋之上，正面一定望到）──
  addBox(root, lib.lambert(PAL.steelGrey), 0.06, 0.7, 0.06, hallX - 0.9, 1.85, -1.5);
  addBox(root, lib.lambert(PAL.steelGrey), 0.06, 0.7, 0.06, hallX + 0.9, 1.85, -1.5);
  addBox(root, lib.lambert(PAL.steelGrey), 2.0, 0.06, 0.06, hallX, 2.2, -1.5);
  addLabelSign(root, lib, {
    text: v === 0 ? '羅湖' : '落馬洲',
    sub: v === 0 ? 'LO WU · RAIL BORDER' : 'LOK MA CHAU · RAIL BORDER',
    x: hallX,
    y: 2.43,
    z: -1.47,
    w: 2.7,
    h: 0.52,
    bg: '#b02a2a',
    fg: '#ffffff',
    border: '#ffffff',
  });
  // ── LED 班次屏（掛月台上蓋前沿，列車上方）──
  addLedInfoBoard(root, lib, v === 0 ? -1.35 : 1.15, 1.5, platZ + 0.63, 1.3, 0.36, 0, v === 0 ? ['往深圳 12:30', '羅湖 → 深圳'] : ['往落馬洲 12:45', '福田口岸'], '#5cff9d');
  // 月台「往深圳」指示牌
  addLabelSign(root, lib, {
    text: '往深圳',
    sub: 'TO SHENZHEN',
    x: -W / 2 + 1.05,
    y: 1.62,
    z: platZ + 0.4,
    w: 1.0,
    h: 0.3,
    bg: '#1f6b45',
    fg: '#ffffff',
    border: '#ffffff',
    ry: 0,
  });
  // ── 海關檢查棚（左／右側，貼近月台）──
  const shedX = v === 0 ? W / 2 - 1.15 : -W / 2 + 1.15;
  addBox(root, lib.lambert(PAL.steelGrey), 1.9, 0.09, 1.15, shedX, 1.52, -1.05);
  addBox(root, lib.lambert(PAL.wallWhite), 1.94, 0.06, 1.19, shedX, 1.58, -1.05);
  for (const [px, pz] of [
    [shedX - 0.85, -0.55],
    [shedX + 0.85, -0.55],
    [shedX - 0.85, -1.55],
    [shedX + 0.85, -1.55],
  ]) {
    addCylinder(root, lib.lambert(PAL.steelGrey), 0.035, 0.04, 1.52, px, 0.76, pz, 6);
  }
  addBox(root, lib.lambert(PAL.woodLight), 1.2, 0.07, 0.42, shedX, 0.72, -1.0);
  addBox(root, lib.lambert(PAL.ironDark), 1.1, 0.6, 0.06, shedX, 0.42, -1.25);
  for (let i = 0; i < 3; i++) {
    addBox(root, lib.lambert(i % 2 === 0 ? PAL.cargoRed : PAL.cargoBlue), 0.26, 0.2, 0.18, shedX - 0.35 + i * 0.35, 0.52, -0.82);
  }
  addLabelSign(root, lib, {
    text: '海關檢查',
    sub: 'CUSTOMS',
    x: shedX,
    y: 1.26,
    z: -0.42,
    w: 1.1,
    h: 0.3,
    bg: '#1b2b33',
    fg: '#ffd166',
    border: '#ffd166',
  });
  // ── 列車（客運 EMU＋貨運列車，靜態；放前方軌道，鏡頭可見）──
  addPassengerTrain(root, lib, v === 0 ? 0.35 : -0.5, trackZ[0], 0, 0.06, {
    cars: 2,
    livery: v === 0 ? 0xb02a2a : 0x2f5f8a,
  });
  addFreightTrain(root, lib, v === 0 ? -0.25 : 0.3, trackZ[1], 0, 0.06, {
    wagons: v === 0 ? 2 : 1,
    locoColor: v === 0 ? 0x2f5f8a : 0x6b6f58,
    wagonColors: v === 0 ? [PAL.cargoRed, PAL.cargoBlue] : [PAL.cargoYellow],
  });
  // ── 貨運貨櫃／檢查區（車站後方兩側）──
  addContainerStack(root, lib, shedX > 0 ? -W / 2 + 1.35 : W / 2 - 1.35, -D / 2 + 0.5, 1, 1, 2, v + 3);
  addBox(root, lib.lambert(PAL.busYellow), 0.5, 0.32, 0.4, shedX > 0 ? -W / 2 + 2.45 : W / 2 - 2.45, 0.25, -D / 2 + 0.55);
  addBox(root, lib.lambert(PAL.ironDark), 0.5, 0.08, 0.44, shedX > 0 ? -W / 2 + 2.45 : W / 2 - 2.45, 0.1, -D / 2 + 0.55);
  // ── 鐵路號誌＋高桿燈 ──
  addRailSignal(root, lib, -W / 2 + 0.4, trackZ[1], 0, 0.06, 1.5);
  addRailSignal(root, lib, W / 2 - 0.45, trackZ[0], Math.PI, 0.06, 1.5);
  addFloodlightMast(root, lib, W / 2 - 0.5, -D / 2 + 0.5, 2.6, 0.06, { glow: true, heads: 2 });
  addFloodlightMast(root, lib, -W / 2 + 0.5, -D / 2 + 0.5, 2.4, 0.06, { glow: true, heads: 2 });
  // ── 兩地邊境圍欄（左右兩側，軌道前方留缺口）──
  const fenceH = 1.4;
  for (const sx of [-1, 1]) {
    const fx = sx * (W / 2 - 0.12);
    addBorderFence(root, lib, fx, -D / 2 + 0.12, fx, trackZ[0] - 0.62, fenceH, { lamps: true });
  }
  // 綠化、垃圾桶
  addTree(root, lib, -W / 2 + 0.4, D / 2 - 0.35, 0.26, 'banyan', v + 2, 0.06);
  addTree(root, lib, W / 2 - 0.4, -D / 2 + 0.3, 0.24, 'shrub', v + 4, 0.06);
  addLitterBin(root, lib, -W / 2 + 0.35, -D / 2 + 0.3);
}

// ─────────────────────────── 通用後備原型 ───────────────────────────

/** 未知 key 的後備原型（日後擴充建築時仍可顯示）。 */
function buildGeneric(ctx: Ctx): void {
  const { lib, root, W, D } = ctx;
  pad(ctx, PAL.concreteLight, 0.1, 0.02);
  addTower(root, lib, {
    w: W - 0.6,
    d: D - 0.6,
    h: 2.4 + (ctx.def.housing > 0 ? 1.2 : 0),
    y0: 0.04,
    style: 'tile',
    wallColor: PAL.concreteLight,
    roofColor: PAL.concreteDark,
  });
  addRooftopTank(root, lib, -W * 0.2, 2.5, -D * 0.2, 0.8);
  addAntennaFarm(root, lib, W, D, 2.5, ctx.variant + 1);
  addTree(root, lib, W * 0.35, D * 0.35, 0.45, 'banyan', ctx.variant + 2, 0.04);
  addLabelSign(root, lib, {
    text: ctx.def.name,
    sub: ctx.def.key.toUpperCase(),
    x: 0,
    y: 1.2,
    z: D / 2 - 0.32,
    w: 1.4,
    h: 0.36,
    bg: '#1b2b33',
    fg: '#ffffff',
    border: '#ffffff',
  });
}

// ─────────────────────────── 原型工廠（對外介面不變） ───────────────────────────

type Builder = (ctx: Ctx) => void;

/**
 * 32 種香港建築的建造函式。key 必須與 core/config.ts BUILDINGS 完全一致。
 * 新增建築：在 config 加 key 後，在這裡加 builder 及 VARIANTS 數量即可；
 * 未登記的 key 會用 buildGeneric 後備並在第一次建立時 console.warn。
 */
const BUILDERS: Record<string, Builder> = {
  // 住宅（6）
  tongLau: buildTongLau,
  subdividedFlat: buildSubdividedFlat,
  publicHousing: buildPublicHousing,
  hOSFlat: buildHOSFlat,
  privateEstate: buildPrivateEstate,
  luxuryTower: buildLuxuryTower,
  // 工業（6）
  farm: buildFarm,
  quarry: buildQuarry,
  industrialBuilding: buildIndustrialBuilding,
  foodFactory: buildFoodFactory,
  powerPlant: buildPowerPlant,
  waterworks: buildWaterworks,
  // 物流（3）
  importFirm: buildImportFirm,
  containerPort: buildContainerPort,
  warehouse: buildWarehouse,
  // 商業（7）
  chaChaanTeng: buildChaChaanTeng,
  convenienceStore: buildConvenienceStore,
  wetMarket: buildWetMarket,
  supermarket: buildSupermarket,
  shoppingMall: buildShoppingMall,
  restaurant: buildRestaurant,
  officeTower: buildOfficeTower,
  // 公共（4）
  school: buildSchool,
  hospital: buildHospital,
  policeStation: buildPoliceStation,
  fireStation: buildFireStation,
  // 交通（4）
  mtrStation: buildMtrStation,
  busTerminus: buildBusTerminus,
  tramStop: buildTramStop,
  ferryPier: buildFerryPier,
  // 休憩（2）
  park: buildPark,
  promenade: buildPromenade,
  // Round 5 新增（11）
  waterTower: buildWaterTower,
  desalPlant: buildDesalPlant,
  sewagePlant: buildSewagePlant,
  sewageOutfall: buildSewageOutfall,
  portGate: buildPortGate,
  portYard: buildPortYard,
  airportTerminal: buildAirportTerminal,
  airCargoTerminal: buildAirCargoTerminal,
  busStop: buildBusStop,
  minibusStop: buildMinibusStop,
  minibusDepot: buildMinibusDepot,
  // Round 6 新增（2）
  roadBorderGate: buildRoadBorderGate,
  railBorderGate: buildRailBorderGate,
};

/** 每種建築可用的外觀變體數量（用 building.id 取模，令同類建築不至於一模一樣）。 */
const VARIANTS: Record<string, number> = {
  tongLau: 3,
  subdividedFlat: 2,
  publicHousing: 2,
  hOSFlat: 2,
  privateEstate: 2,
  luxuryTower: 2,
  farm: 2,
  quarry: 2,
  industrialBuilding: 2,
  foodFactory: 2,
  powerPlant: 2,
  waterworks: 2,
  importFirm: 2,
  containerPort: 2,
  warehouse: 2,
  chaChaanTeng: 2,
  convenienceStore: 2,
  wetMarket: 2,
  supermarket: 2,
  shoppingMall: 2,
  restaurant: 2,
  officeTower: 2,
  school: 2,
  hospital: 2,
  policeStation: 2,
  fireStation: 2,
  mtrStation: 3,
  busTerminus: 2,
  tramStop: 2,
  ferryPier: 2,
  park: 2,
  promenade: 2,
  // Round 5 新增（每種 2 variants）
  waterTower: 2,
  desalPlant: 2,
  sewagePlant: 2,
  sewageOutfall: 2,
  portGate: 2,
  portYard: 2,
  airportTerminal: 2,
  airCargoTerminal: 2,
  busStop: 2,
  minibusStop: 2,
  minibusDepot: 2,
  // Round 6 新增
  roadBorderGate: 2,
  railBorderGate: 2,
};

/** 已實作原型的建築 key（供測試／除錯核對 BUILDINGS 覆蓋率）。 */
export const PROTOTYPE_KEYS: readonly string[] = Object.freeze(Object.keys(BUILDERS));

export function createPrototypeFactory(lib: MaterialLibrary): PrototypeFactory {
  const cache = new Map<string, BuildingPrototype>();
  const warned = new Set<string>();

  const build = (key: string, variant: number): BuildingPrototype => {
    const def = BUILDINGS[key];
    const wTiles = def?.size[0] ?? 1;
    const hTiles = def?.size[1] ?? 1;
    const W = wTiles * TILE;
    const D = hTiles * TILE;
    const root = new THREE.Group();
    root.name = `proto:${key}#${variant}`;
    const ctx: Ctx = {
      lib,
      root,
      def:
        def ??
        ({
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
        } as BuildingDef),
      w: wTiles,
      h: hTiles,
      W,
      D,
      variant,
    };
    const builder = BUILDERS[key];
    if (!builder && !warned.has(key)) {
      warned.add(key);
      // eslint-disable-next-line no-console
      console.warn(`[building-prototypes] 未登記的建築 key「${key}」，使用通用後備原型。`);
    }
    (builder ?? buildGeneric)(ctx);
    mergeStaticMeshes(root, lib);
    const proto: BuildingPrototype = { key, variant, root, footprintW: W, footprintD: D };
    cache.set(`${key}#${variant}`, proto);
    return proto;
  };

  // 開發期覆蓋率核對：config 的每個建築 key 都一定要有原型（只用 console.warn，不阻塞）
  const missing = Object.keys(BUILDINGS).filter((key) => !BUILDERS[key]);
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[building-prototypes] 以下建築缺少專屬原型，將用通用後備：${missing.join(', ')}`);
  }

  return {
    get(key: string, variant = 0): BuildingPrototype {
      const count = VARIANTS[key] ?? 1;
      const v = count > 1 ? ((variant % count) + count) % count : 0;
      const id = `${key}#${v}`;
      return cache.get(id) ?? build(key, v);
    },
    variantCount(key: string): number {
      return VARIANTS[key] ?? 1;
    },
    dispose(): void {
      for (const proto of cache.values()) {
        proto.root.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.isMesh) mesh.geometry?.dispose();
        });
      }
      cache.clear();
    },
  };
}
