/**
 * 交通車輛渲染（transport-dev）：程序化低多邊形香港交通工具。
 *
 * 對外介面（docs/ARCHITECTURE.md §5.1）：
 *   createVehiclesView(state): VehiclesView
 *   VehiclesView.group / update(state, dt) / dispose()
 *
 * 車輛種類與造型
 *   bus      雙層巴士：黃／紅車身、上下層車窗、路線牌、車頭／車尾燈
 *   minibus  小巴：綠色／紅色車身＋白頂（綠 van／紅 van）
 *   taxi     的士：紅色車身＋車頂燈箱
 *   car      私家車：隨機車色、車窗、頭尾燈
 *   motorcycle 電單車：車身、車輪、車頭燈、戴頭盔的司機
 *   tram     電車（叮叮）：綠色車身、白色車頂、集電弓
 *   ferry    天星小輪：綠白船身、上層船艙、紅色煙囪、航行燈與船尾浪花
 *
 * 技術
 * - 4 個 InstancedMesh 共用幾何／材質：盒（車身）、圓柱（車輪／煙囪／欄杆）、
 *   車窗（日間深色玻璃 / 夜間暖黃窗光）、車燈（additive 發光；夜間更亮）。
 *   每部車由「零件表」組合，逐格寫入 instance matrix / color，全部車輛只需 4 個 draw call。
 * - 位置以 state.vehicles 為準（vehicle.x/y 為格中心座標），渲染層再平滑插值位置與朝向
 *   （新車直接對位、大幅跳動直接校正），避免讀檔或低 FPS 時鬼影。
 * - 渡輪以 WATER_SURFACE_Y 浮於水面，輕微上下浮動；路面車用 roadSurfaceY 貼合地形。
 * - 香港靠左行駛：車輛按行車方向向左偏移半條車道，來回方向自然分開。
 * - 夜間：車窗透出暖光、車頭燈／車尾燈／的士頂燈發亮、電車目的地牌發亮。
 * - 座標：格中心 (x+0.5, y+0.5) → 世界座標與 render/coords.ts 一致（地圖置中）。
 */

import * as THREE from 'three';
import type { GameState, Vehicle, VehicleKind } from '../core/types';
import { TILE } from './coords';
import { WATER_SURFACE_Y, roadSurfaceY, tileTopY } from './world-utils';

export interface VehiclesView {
  group: THREE.Group;
  update(state: GameState, dt: number): void;
  dispose(): void;
}

// ─────────────────────────── 渲染常數 ───────────────────────────

/** 最多同時渲染的交通車輛（與 sim/vehicles.ts 的 MAX_TRAFFIC_VEHICLES 一致） */
const MAX_RENDER_VEHICLES = 128;

/** 車道偏移（世界單位；香港靠左行駛） */
const LANE_OFFSET = 0.2;

/** 渡輪浮動高度修正（船身吃水） */
const FERRY_DRAFT = -0.05;

/** 夜間玻璃／車窗顏色 */
const GLASS_DAY = 0x22303f;
const GLASS_NIGHT = 0xffe0a0;

/** 車身用色（與 core/config VEHICLE_COLORS 對應，另補香港常見色） */
const CAR_COLORS = [0xf0f0f0, 0x2f2f2f, 0xb02a2a, 0x2f5f9f, 0xcfd8e3, 0x8a9a8a, 0xb8b8b0];
const MOTORCYCLE_COLORS = [0x2f2f2f, 0xb02a2a, 0x2f5f9f, 0x3f3f3f];
const AD_COLORS = [0xff3d7f, 0x24e0ff, 0xffd166, 0x5cff9d, 0xff7a3d, 0xa45bff];

// ─────────────────────────── 零件表 ───────────────────────────

/** 零件使用哪一個 InstancedMesh */
type PartMesh = 'box' | 'cyl' | 'win' | 'glow';

interface Part {
  mesh: PartMesh;
  /** 本地座標：x = 右、y = 上（0 為地面）、z = 車頭方向 */
  x: number;
  y: number;
  z: number;
  /** 本地旋轉（母體 yaw 會自動疊加） */
  rx?: number;
  ry?: number;
  rz?: number;
  /** 尺寸（世界單位） */
  sx: number;
  sy: number;
  sz: number;
  color: number;
  /** body = 用車輛 color；ad = 用霓虹廣告色（按車輛 id 選） */
  role?: 'body' | 'ad';
  /** 顏色亮度微調（乘數） */
  dim?: number;
}

type PartTemplate = Part[];

function part(
  mesh: PartMesh,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  color: number,
  extra: Partial<Part> = {},
): Part {
  return { mesh, x, y, z, sx, sy, sz, color, ...extra };
}

/** 四個車輪（本地 x = 車闊一半、z = 軸距一半） */
function addWheels(
  parts: PartTemplate,
  halfWidth: number,
  axleZ: number,
  radius: number,
  thickness: number,
  count = 4,
): void {
  const zs = count === 4 ? [axleZ, -axleZ] : [axleZ, 0, -axleZ];
  for (const z of zs) {
    for (const side of [-1, 1]) {
      parts.push(
        part('cyl', side * (halfWidth - 0.01), radius, z, radius, thickness, radius, 0x1b1b1b, {
          rz: Math.PI / 2,
        }),
      );
    }
  }
}

/** 共用：車頭／車尾燈（日間暗淡、夜間發光） */
function addLights(
  parts: PartTemplate,
  halfWidth: number,
  halfLength: number,
  headY: number,
  tailY: number,
  size = 0.1,
): void {
  parts.push(
    part('glow', halfWidth * 0.58, headY, halfLength + 0.015, size, size * 0.72, 0.02, 0xfff0c0),
    part('glow', -halfWidth * 0.58, headY, halfLength + 0.015, size, size * 0.72, 0.02, 0xfff0c0),
    part('glow', halfWidth * 0.62, tailY, -halfLength - 0.015, size * 0.9, size * 0.8, 0.02, 0xff3326),
    part('glow', -halfWidth * 0.62, tailY, -halfLength - 0.015, size * 0.9, size * 0.8, 0.02, 0xff3326),
  );
}

/** 共用：車頭燈照在地面的光暈（夜間更明顯；日間幾乎不可見） */
function addHeadlightPools(parts: PartTemplate, halfWidth: number, halfLength: number): void {
  for (const side of [-1, 1]) {
    parts.push(
      part('glow', side * halfWidth * 0.58, 0.035, halfLength + 0.55, 0.18, 0.01, 0.9, 0xfff0c0, {
        dim: 0.16,
      }),
    );
  }
  // 車尾紅色煞車燈在地面的淡淡反光
  parts.push(part('glow', 0, 0.035, -halfLength - 0.35, 0.3, 0.01, 0.45, 0xff3326, { dim: 0.06 }));
}

/** 雙層巴士（黃／紅；香港最常見的交通風景） */
function busTemplate(): PartTemplate {
  const parts: PartTemplate = [];
  const W = 0.78; // 車闊
  const L = 2.0; // 車長
  const bodyBottom = 0.24;
  // 下層車身
  parts.push(part('box', 0, bodyBottom + 0.28, 0, W, 0.56, L, 0xd9b23f, { role: 'body' }));
  // 上層車身（略窄）
  parts.push(part('box', 0, bodyBottom + 0.56 + 0.24, 0, W * 0.97, 0.48, L * 0.98, 0xd9b23f, { role: 'body' }));
  // 車頂
  parts.push(part('box', 0, bodyBottom + 1.06, 0, W * 0.93, 0.06, L * 0.94, 0xe8e4d8));
  // 冷氣機組
  parts.push(part('box', 0, bodyBottom + 1.13, -0.1, W * 0.52, 0.07, 0.52, 0xdcdcd4));
  // 車頭／車尾保險桿
  parts.push(
    part('box', 0, bodyBottom + 0.03, L / 2 + 0.015, W * 0.94, 0.13, 0.08, 0x22262a),
    part('box', 0, bodyBottom + 0.03, -L / 2 - 0.015, W * 0.94, 0.13, 0.08, 0x22262a),
  );
  // 車身腰線（白色腰帶）
  parts.push(part('box', 0, bodyBottom + 0.52, 0, W * 1.005, 0.08, L * 0.92, 0xe9e4d2));
  // 下層側窗與車門
  parts.push(
    part('win', W / 2 + 0.006, bodyBottom + 0.32, 0.2, 0.02, 0.24, L * 0.62, GLASS_DAY),
    part('win', -W / 2 - 0.006, bodyBottom + 0.32, 0.2, 0.02, 0.24, L * 0.62, GLASS_DAY),
    part('box', W / 2 + 0.008, bodyBottom + 0.2, L * 0.36, 0.02, 0.34, 0.3, 0x2c3238),
  );
  // 上層側窗（連續長窗）
  parts.push(
    part('win', W / 2 + 0.005, bodyBottom + 0.82, 0.05, 0.02, 0.26, L * 0.74, GLASS_DAY),
    part('win', -W / 2 - 0.005, bodyBottom + 0.82, 0.05, 0.02, 0.26, L * 0.74, GLASS_DAY),
  );
  // 車頭大銀幕（上下層）
  parts.push(
    part('win', 0, bodyBottom + 0.34, L / 2 + 0.006, W * 0.84, 0.26, 0.02, GLASS_DAY),
    part('win', 0, bodyBottom + 0.84, L / 2 * 0.99, W * 0.8, 0.24, 0.02, GLASS_DAY),
    part('win', 0, bodyBottom + 0.82, -L / 2 * 0.99, W * 0.8, 0.2, 0.02, GLASS_DAY),
  );
  // 路線牌（夜間發光）
  parts.push(part('glow', 0, bodyBottom + 1.0, L / 2 + 0.005, W * 0.5, 0.1, 0.02, 0xffd166));
  // 香港巴士車身廣告
  parts.push(
    part('box', W / 2 + 0.008, bodyBottom + 0.33, -0.35, 0.02, 0.3, L * 0.3, 0xffffff, {
      role: 'ad',
      ry: 0,
    }),
    part('box', -W / 2 - 0.008, bodyBottom + 0.33, -0.35, 0.02, 0.3, L * 0.3, 0xffffff, {
      role: 'ad',
    }),
  );
  addLights(parts, W / 2, L / 2, bodyBottom + 0.12, bodyBottom + 0.28, 0.11);
  addHeadlightPools(parts, W / 2, L / 2);
  addWheels(parts, W / 2 + 0.005, L * 0.31, 0.11, 0.1);
  return parts;
}

/** 小巴（綠 van／紅 van，白頂） */
function minibusTemplate(): PartTemplate {
  const parts: PartTemplate = [];
  const W = 0.62;
  const L = 1.34;
  const bottom = 0.18;
  parts.push(part('box', 0, bottom + 0.27, 0, W, 0.54, L, 0x3f8f5f, { role: 'body' }));
  // 白頂
  parts.push(part('box', 0, bottom + 0.56, 0, W * 0.98, 0.08, L * 0.98, 0xf2f0e8));
  // 車窗（環繞）
  parts.push(
    part('win', 0, bottom + 0.86, L / 2 + 0.008, W * 0.8, 0.26, 0.02, GLASS_DAY),
    part('win', W / 2 + 0.006, bottom + 0.8, -0.05, 0.02, 0.24, L * 0.7, GLASS_DAY),
    part('win', -W / 2 - 0.006, bottom + 0.8, -0.05, 0.02, 0.24, L * 0.7, GLASS_DAY),
    part('win', 0, bottom + 0.82, -L / 2 - 0.008, W * 0.72, 0.2, 0.02, GLASS_DAY),
  );
  // 綠色／紅色車頂小牌（綠 van 綠頂、紅 van 紅頂）
  parts.push(part('box', 0, bottom + 0.62, L * 0.18, W * 0.42, 0.05, 0.24, 0xffffff, { role: 'body' }));
  // 車頭燈、尾燈
  addLights(parts, W / 2, L / 2, bottom + 0.18, bottom + 0.2, 0.09);
  addHeadlightPools(parts, W / 2, L / 2);
  // 保險桿
  parts.push(
    part('box', 0, bottom + 0.02, L / 2 + 0.01, W * 0.92, 0.1, 0.06, 0x2a2e30),
    part('box', 0, bottom + 0.02, -L / 2 - 0.01, W * 0.92, 0.1, 0.06, 0x2a2e30),
  );
  addWheels(parts, W / 2 + 0.005, L * 0.3, 0.085, 0.08);
  return parts;
}

/** 車身很長的紅色車頂燈箱……即係的士 */
function taxiTemplate(): PartTemplate {
  const parts: PartTemplate = [];
  const W = 0.5;
  const L = 1.02;
  const bottom = 0.16;
  parts.push(part('box', 0, bottom + 0.12, 0, W, 0.24, L, 0xd93f3f, { role: 'body' }));
  // 車廂（紅色，四門）
  parts.push(part('box', 0, bottom + 0.28, -0.04, W * 0.9, 0.2, L * 0.5, 0xd93f3f, { role: 'body' }));
  // 車窗
  parts.push(
    part('win', 0, bottom + 0.3, L * 0.24, W * 0.78, 0.16, 0.02, GLASS_DAY),
    part('win', 0, bottom + 0.3, -L * 0.3, W * 0.74, 0.14, 0.02, GLASS_DAY),
    part('win', W * 0.45, bottom + 0.3, -0.04, 0.02, 0.14, L * 0.34, GLASS_DAY),
    part('win', -W * 0.45, bottom + 0.3, -0.04, 0.02, 0.14, L * 0.34, GLASS_DAY),
  );
  // 車頂燈箱（的士招牌，夜間發光）
  parts.push(
    part('box', 0, bottom + 0.42, 0.12, 0.2, 0.07, 0.14, 0xf5f0dc),
    part('glow', 0, bottom + 0.47, 0.12, 0.15, 0.04, 0.1, 0xfff2b0),
  );
  // 車牌
  parts.push(part('glow', 0, bottom + 0.1, L / 2 + 0.01, 0.16, 0.05, 0.01, 0xf0e8c0, { dim: 0.55 }));
  addLights(parts, W / 2, L / 2, bottom + 0.14, bottom + 0.15, 0.085);
  addHeadlightPools(parts, W / 2, L / 2);
  addWheels(parts, W / 2 + 0.005, L * 0.3, 0.075, 0.07);
  return parts;
}

/** 私家車 */
function carTemplate(): PartTemplate {
  const parts: PartTemplate = [];
  const W = 0.52;
  const L = 1.04;
  const bottom = 0.16;
  parts.push(part('box', 0, bottom + 0.11, 0, W, 0.22, L, 0xcfd8e3, { role: 'body' }));
  parts.push(part('box', 0, bottom + 0.27, -0.05, W * 0.88, 0.18, L * 0.46, 0xcfd8e3, { role: 'body' }));
  parts.push(
    part('win', 0, bottom + 0.29, L * 0.22, W * 0.74, 0.14, 0.02, GLASS_DAY),
    part('win', 0, bottom + 0.29, -L * 0.29, W * 0.7, 0.12, 0.02, GLASS_DAY),
    part('win', W * 0.44, bottom + 0.29, -0.04, 0.02, 0.12, L * 0.3, GLASS_DAY),
    part('win', -W * 0.44, bottom + 0.29, -0.04, 0.02, 0.12, L * 0.3, GLASS_DAY),
  );
  addLights(parts, W / 2, L / 2, bottom + 0.12, bottom + 0.13, 0.08);
  addHeadlightPools(parts, W / 2, L / 2);
  addWheels(parts, W / 2 + 0.005, L * 0.3, 0.075, 0.07);
  return parts;
}

/** 電單車（連司機） */
function motorcycleTemplate(): PartTemplate {
  const parts: PartTemplate = [];
  const W = 0.2;
  const L = 0.66;
  // 車身
  parts.push(part('box', 0, 0.38, 0, W, 0.16, L, 0x2f2f2f, { role: 'body' }));
  // 油箱
  parts.push(part('box', 0, 0.44, 0.08, W * 0.9, 0.12, 0.24, 0x2f2f2f, { role: 'body' }));
  // 座墊
  parts.push(part('box', 0, 0.47, -0.16, W * 0.85, 0.07, 0.24, 0x1d1d1d));
  // 車頭／車尾燈
  parts.push(part('glow', 0, 0.48, L / 2 + 0.01, 0.09, 0.08, 0.02, 0xfff0c0));
  parts.push(part('glow', 0, 0.42, -L / 2 - 0.01, 0.07, 0.06, 0.02, 0xff3326));
  // 手把
  parts.push(part('cyl', 0, 0.56, 0.24, 0.015, 0.34, 0.015, 0x8a8a8a, { rz: Math.PI / 2 }));
  // 車輪
  parts.push(
    part('cyl', 0, 0.2, L * 0.34, 0.2, 0.07, 0.2, 0x1b1b1b, { rz: Math.PI / 2 }),
    part('cyl', 0, 0.2, -L * 0.34, 0.2, 0.07, 0.2, 0x1b1b1b, { rz: Math.PI / 2 }),
  );
  // 司機（頭盔＋風衣）
  parts.push(
    part('box', 0, 0.62, -0.1, 0.22, 0.26, 0.18, 0x2b4a6a),
    part('box', 0, 0.8, -0.1, 0.16, 0.16, 0.16, 0xb02a2a),
    part('box', 0, 0.66, 0.08, 0.16, 0.1, 0.12, 0x1e1e1e),
  );
  return parts;
}

/** 電車（叮叮）：綠色車身、白色車頂、集電弓 */
function tramTemplate(): PartTemplate {
  const parts: PartTemplate = [];
  const W = 0.64;
  const L = 1.86;
  const bottom = 0.26;
  // 下層車身
  parts.push(part('box', 0, bottom + 0.26, 0, W, 0.52, L, 0x2f8f5f, { role: 'body' }));
  // 白色上層
  parts.push(part('box', 0, bottom + 0.62, 0, W * 0.98, 0.24, L * 0.99, 0xf0ede0));
  // 綠色車頂
  parts.push(part('box', 0, bottom + 0.78, 0, W * 0.94, 0.06, L * 0.96, 0x2f8f5f));
  // 車窗（上層連續窗、下層窗）
  parts.push(
    part('win', W / 2 + 0.006, bottom + 0.64, 0, 0.02, 0.18, L * 0.8, GLASS_DAY),
    part('win', -W / 2 - 0.006, bottom + 0.64, 0, 0.02, 0.18, L * 0.8, GLASS_DAY),
    part('win', W / 2 + 0.006, bottom + 0.28, 0, 0.02, 0.2, L * 0.72, GLASS_DAY),
    part('win', -W / 2 - 0.006, bottom + 0.28, 0, 0.02, 0.2, L * 0.72, GLASS_DAY),
    part('win', 0, bottom + 0.32, L / 2 + 0.006, W * 0.78, 0.24, 0.02, GLASS_DAY),
    part('win', 0, bottom + 0.32, -L / 2 - 0.006, W * 0.78, 0.2, 0.02, GLASS_DAY),
  );
  // 目的地牌（夜間發亮）
  parts.push(part('glow', 0, bottom + 0.52, L / 2 + 0.009, W * 0.44, 0.08, 0.02, 0xffe9a0));
  // 車頭燈（叮叮只得一盞）
  parts.push(part('glow', 0, bottom + 0.14, L / 2 + 0.01, 0.12, 0.12, 0.02, 0xfff0c0));
  parts.push(part('glow', 0, bottom + 0.16, -L / 2 - 0.01, 0.1, 0.08, 0.02, 0xff3326));
  // 底盤裙邊
  parts.push(part('box', 0, bottom - 0.04, 0, W * 0.9, 0.14, L * 0.9, 0x1f3a2c));
  // 集電弓
  parts.push(
    part('cyl', 0, bottom + 1.02, 0.2, 0.02, 0.5, 0.02, 0x3a3a3a),
    part('box', 0, bottom + 1.26, 0.2, 0.44, 0.035, 0.035, 0x3a3a3a),
    part('box', 0, bottom + 1.28, 0.2, 0.05, 0.05, 0.3, 0x2a2a2a),
  );
  addWheels(parts, W / 2 - 0.02, L * 0.3, 0.09, 0.08);
  return parts;
}

/** 天星小輪：綠白船身、雙層船艙、紅色煙囪、航行燈、船尾浪花 */
function ferryTemplate(): PartTemplate {
  const parts: PartTemplate = [];
  const W = 1.24;
  const L = 2.6;
  // 船身（吃水線下略深）
  parts.push(part('box', 0, 0.04, 0, W, 0.32, L, 0x2f7f6a, { role: 'body' }));
  // 白色水線
  parts.push(part('box', 0, 0.16, 0, W * 1.01, 0.07, L * 1.005, 0xf0ede0));
  // 下層甲板
  parts.push(part('box', 0, 0.28, 0, W * 0.96, 0.12, L * 0.92, 0xe8e4d6));
  // 下層船艙（綠色）
  parts.push(part('box', 0, 0.4, 0, W * 0.92, 0.2, L * 0.78, 0x2f7f6a));
  // 下層窗
  parts.push(
    part('win', W * 0.465, 0.42, 0, 0.02, 0.12, L * 0.66, GLASS_DAY),
    part('win', -W * 0.465, 0.42, 0, 0.02, 0.12, L * 0.66, GLASS_DAY),
  );
  // 上層船艙（白色）
  parts.push(part('box', 0, 0.6, 0, W * 0.82, 0.24, L * 0.62, 0xf2efe4));
  parts.push(
    part('win', W * 0.415, 0.62, 0, 0.02, 0.14, L * 0.52, GLASS_DAY),
    part('win', -W * 0.415, 0.62, 0, 0.02, 0.14, L * 0.52, GLASS_DAY),
    part('win', 0, 0.62, L * 0.31 + 0.005, W * 0.66, 0.12, 0.02, GLASS_DAY),
  );
  // 頂層綠色船頂
  parts.push(part('box', 0, 0.74, 0, W * 0.86, 0.06, L * 0.66, 0x2f7f6a));
  // 紅色煙囪（天星小輪標誌）
  parts.push(
    part('cyl', 0, 0.9, -0.22, 0.11, 0.32, 0.11, 0xc0392b),
    part('cyl', 0, 1.06, -0.22, 0.115, 0.06, 0.115, 0x222222),
  );
  // 船桅
  parts.push(part('cyl', 0, 0.94, L * 0.34, 0.02, 0.42, 0.02, 0x3a3a3a));
  // 航行燈：左紅右綠
  parts.push(
    part('glow', -W * 0.5, 0.52, L * 0.1, 0.06, 0.06, 0.06, 0xff3326),
    part('glow', W * 0.5, 0.52, L * 0.1, 0.06, 0.06, 0.06, 0x5cff9d),
    part('glow', 0, 0.5, L * 0.48, 0.1, 0.08, 0.02, 0xfff0c0),
  );
  // 船尾浪花（additive 白色）
  parts.push(part('glow', 0, -0.02, -L * 0.6, W * 1.5, 0.02, L * 0.55, 0xdff6ff, { dim: 0.45 }));
  return parts;
}

/** 港鐵列車：3 節白色車廂、紅色腰線、藍色車頂線、夜間窗光／頭尾燈。 */
function trainTemplate(): PartTemplate {
  const parts: PartTemplate = [];
  const W = 0.92;
  const L = 2.0;
  const carZ = [-2.16, 0, 2.16];
  for (let c = 0; c < carZ.length; c++) {
    const z = carZ[c];
    // 車身（白色）
    parts.push(part('box', 0, 0.58, z, W, 0.56, L, 0xf2f1ea));
    // 車頂（略深灰）
    parts.push(part('box', 0, 0.88, z, W * 0.96, 0.08, L * 0.98, 0xb9bdc2));
    // 紅色腰線
    parts.push(part('box', 0, 0.44, z, W + 0.01, 0.1, L * 0.99, 0xb02a2a));
    // 藍色車頂線
    parts.push(part('box', 0, 0.82, z, W + 0.01, 0.035, L * 0.99, 0x2f5f9f));
    // 兩側連續車窗（夜間發亮）
    parts.push(
      part('win', W / 2 + 0.008, 0.62, z, 0.02, 0.2, L * 0.82, GLASS_DAY),
      part('win', -W / 2 - 0.008, 0.62, z, 0.02, 0.2, L * 0.82, GLASS_DAY),
    );
    // 車門（深色）
    parts.push(
      part('box', W / 2 + 0.004, 0.52, z - L * 0.28, 0.025, 0.44, 0.3, 0x39424a),
      part('box', -W / 2 - 0.004, 0.52, z - L * 0.28, 0.025, 0.44, 0.3, 0x39424a),
    );
    // 車底轉向架
    parts.push(
      part('box', 0, 0.2, z, W * 0.78, 0.18, L * 0.82, 0x2a2f33),
      part('cyl', 0, 0.16, z + L * 0.28, 0.1, 0.08, 0.1, 0x151515, { rz: Math.PI / 2 }),
      part('cyl', 0, 0.16, z - L * 0.28, 0.1, 0.08, 0.1, 0x151515, { rz: Math.PI / 2 }),
    );
  }
  // 頭尾燈
  parts.push(
    part('glow', 0, 0.45, 3.18, 0.28, 0.1, 0.02, 0xfff0c0),
    part('glow', 0, 0.45, -3.18, 0.28, 0.1, 0.02, 0xff3326),
  );
  return parts;
}

const TEMPLATES: Record<string, PartTemplate> = {
  bus: busTemplate(),
  minibus: minibusTemplate(),
  taxi: taxiTemplate(),
  car: carTemplate(),
  motorcycle: motorcycleTemplate(),
  tram: tramTemplate(),
  ferry: ferryTemplate(),
  mtr: trainTemplate(),
};

/** 預處理零件：把本地位置／旋轉／尺寸烘成矩陣，每幀只需 parent × local 一次矩陣乘。 */
interface PreparedPart {
  mesh: PartMesh;
  /** 本地矩陣的三條基底向量（已含尺寸；方便直接寫入 instanceMatrix，免每幀矩陣乘法） */
  b0x: number;
  b0y: number;
  b0z: number;
  b1x: number;
  b1y: number;
  b1z: number;
  b2x: number;
  b2y: number;
  b2z: number;
  /** 本地位移 */
  ox: number;
  oy: number;
  oz: number;
  color: number;
  dim?: number;
  role?: 'body' | 'ad';
}

const PREPARED: Record<string, PreparedPart[]> = {};
const PREPARED_CAPACITY: Record<PartMesh, number> = { box: 0, cyl: 0, win: 0, glow: 0 };
{
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const localMatrix = new THREE.Matrix4();
  for (const [kind, parts] of Object.entries(TEMPLATES)) {
    const prepared: PreparedPart[] = [];
    for (const item of parts) {
      euler.set(item.rx ?? 0, item.ry ?? 0, item.rz ?? 0, 'YXZ');
      quat.setFromEuler(euler);
      pos.set(item.x, item.y, item.z);
      scale.set(item.sx, item.sy, item.sz);
      localMatrix.compose(pos, quat, scale);
      const e = localMatrix.elements;
      prepared.push({
        mesh: item.mesh,
        b0x: e[0],
        b0y: e[1],
        b0z: e[2],
        b1x: e[4],
        b1y: e[5],
        b1z: e[6],
        b2x: e[8],
        b2y: e[9],
        b2z: e[10],
        ox: e[12],
        oy: e[13],
        oz: e[14],
        color: item.color,
        dim: item.dim,
        role: item.role,
      });
    }
    PREPARED[kind] = prepared;
    const counts: Record<PartMesh, number> = { box: 0, cyl: 0, win: 0, glow: 0 };
    for (const item of prepared) counts[item.mesh]++;
    for (const mesh of Object.keys(counts) as PartMesh[]) {
      PREPARED_CAPACITY[mesh] = Math.max(PREPARED_CAPACITY[mesh], counts[mesh] * MAX_RENDER_VEHICLES);
    }
  }
}

/** 未知車種（truck／van／mtr 不屬交通渲染範圍）用私家車頂替，避免空白 */
function templateFor(kind: VehicleKind): PreparedPart[] {
  return PREPARED[kind] ?? PREPARED.car;
}

// ─────────────────────────── 小工具 ───────────────────────────

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 夜間程度 0..1（黃昏漸變、清晨漸亮） */
function nightFactor(state: GameState): number {
  const hour = state.clock.hour + state.clock.minute / 60;
  if (hour >= 20 || hour < 5) return 1;
  if (hour >= 18.5) return clamp01((hour - 18.5) / 1.5);
  if (hour < 6.5) return 1 - clamp01((hour - 5) / 1.5);
  return 0;
}

function lerpAngle(current: number, target: number, t: number): number {
  const twoPi = Math.PI * 2;
  let delta = (target - current) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta < -Math.PI) delta += twoPi;
  return current + delta * t;
}

/** 由車輛 id 產生穩定的 0..1 值（顏色深淺、車型變化） */
function idHash(id: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 車輛顏色（配合 sim 設定的 vehicle.color；未知車種用料色） */
function bodyColorOf(vehicle: Vehicle): number {
  if (vehicle.color >= 0) return vehicle.color;
  if (vehicle.kind === 'car') return CAR_COLORS[0];
  if (vehicle.kind === 'motorcycle') return MOTORCYCLE_COLORS[0];
  return 0xcfd8e3;
}

// ─────────────────────────── 建立視圖 ───────────────────────────

interface SmoothState {
  x: number;
  z: number;
  yaw: number;
  /** 最後出現的幀（清理用） */
  touch: number;
}

export function createVehiclesView(state: GameState): VehiclesView {
  const group = new THREE.Group();
  group.name = 'vehicles';

  const halfW = (state.width * TILE) / 2;
  const halfH = (state.height * TILE) / 2;

  // ── 共用幾何／材質 ──
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 8);
  const boxMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const cylinderMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const windowMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  // ── 依零件表上限配置 InstancedMesh（預留 10% 餘裕） ──
  const meshCapacity: Record<PartMesh, number> = {
    box: Math.ceil(PREPARED_CAPACITY.box * 1.1),
    cyl: Math.ceil(PREPARED_CAPACITY.cyl * 1.1),
    win: Math.ceil(PREPARED_CAPACITY.win * 1.1),
    glow: Math.ceil(PREPARED_CAPACITY.glow * 1.1),
  };

  const makeMesh = (geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, name: string): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, capacity));
    mesh.name = name;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = name === 'vehicle-boxes' || name === 'vehicle-cylinders';
    mesh.receiveShadow = false;
    const white = new THREE.Color(0xffffff);
    for (let i = 0; i < capacity; i++) mesh.setColorAt(i, white);
    if (mesh.instanceColor) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    group.add(mesh);
    return mesh;
  };

  const boxMesh = makeMesh(boxGeometry, boxMaterial, meshCapacity.box, 'vehicle-boxes');
  const cylMesh = makeMesh(cylinderGeometry, cylinderMaterial, meshCapacity.cyl, 'vehicle-cylinders');
  const winMesh = makeMesh(boxGeometry, windowMaterial, meshCapacity.win, 'vehicle-windows');
  const glowMesh = makeMesh(boxGeometry, glowMaterial, meshCapacity.glow, 'vehicle-glow');

  // ── 每幀重用物件 ──
  const smooth = new Map<number, SmoothState>();
  let frame = 0;
  let elapsed = 0;

  interface BufferCounter {
    box: number;
    cyl: number;
    win: number;
    glow: number;
  }
  const used: BufferCounter = { box: 0, cyl: 0, win: 0, glow: 0 };

  // 直接寫入 InstancedMesh 的 matrix / color buffer，省去每幀建立矩陣物件。
  const instanceMatrixArrays: Record<PartMesh, Float32Array> = {
    box: boxMesh.instanceMatrix.array as Float32Array,
    cyl: cylMesh.instanceMatrix.array as Float32Array,
    win: winMesh.instanceMatrix.array as Float32Array,
    glow: glowMesh.instanceMatrix.array as Float32Array,
  };
  const instanceColorArrays: Record<PartMesh, Float32Array> = {
    box: boxMesh.instanceColor!.array as Float32Array,
    cyl: cylMesh.instanceColor!.array as Float32Array,
    win: winMesh.instanceColor!.array as Float32Array,
    glow: glowMesh.instanceColor!.array as Float32Array,
  };

  // 顏色快取：把「顏色 × 亮度（量化）」對應到共用的 Color，避免每幀 setHex/multiplyScalar。
  const colorCache = new Map<number, THREE.Color>();
  const resolveColor = (hex: number, brightness: number): THREE.Color => {
    const b = brightness < 0 ? 0 : brightness > 2 ? 2 : brightness;
    const bIndex = Math.round(b * 96);
    const key = hex * 128 + bIndex;
    let cached = colorCache.get(key);
    if (!cached) {
      cached = new THREE.Color(hex).multiplyScalar(bIndex / 96);
      if (colorCache.size > 8192) colorCache.clear();
      colorCache.set(key, cached);
    }
    return cached;
  };

  /**
   * 追加一個零件 instance：
   *   matrix = T(px,py,pz) × Ry(yaw) × 本地矩陣
   * 本地矩陣只需三條基底向量（已預處理），每幀只做 yaw 旋轉，直接寫 Float32Array。
   */
  const appendPart = (
    mesh: PartMesh,
    px: number,
    py: number,
    pz: number,
    cosYaw: number,
    sinYaw: number,
    p: PreparedPart,
    col: THREE.Color,
  ): void => {
    const index = used[mesh];
    if (index >= meshCapacity[mesh]) return;
    const m = instanceMatrixArrays[mesh];
    const o = index * 16;
    m[o] = p.b0x * cosYaw + p.b0z * sinYaw;
    m[o + 1] = p.b0y;
    m[o + 2] = -p.b0x * sinYaw + p.b0z * cosYaw;
    m[o + 3] = 0;
    m[o + 4] = p.b1x * cosYaw + p.b1z * sinYaw;
    m[o + 5] = p.b1y;
    m[o + 6] = -p.b1x * sinYaw + p.b1z * cosYaw;
    m[o + 7] = 0;
    m[o + 8] = p.b2x * cosYaw + p.b2z * sinYaw;
    m[o + 9] = p.b2y;
    m[o + 10] = -p.b2x * sinYaw + p.b2z * cosYaw;
    m[o + 11] = 0;
    m[o + 12] = px;
    m[o + 13] = py;
    m[o + 14] = pz;
    m[o + 15] = 1;
    const ca = instanceColorArrays[mesh];
    const co = index * 3;
    ca[co] = col.r;
    ca[co + 1] = col.g;
    ca[co + 2] = col.b;
    used[mesh]++;
  };

  const update = (s: GameState, dt: number): void => {
    elapsed += dt;
    frame++;
    const night = nightFactor(s);
    // 白天車燈只餘一點暗光，晚上全亮
    const glowBrightness = 0.14 + 0.86 * night;

    used.box = 0;
    used.cyl = 0;
    used.win = 0;
    used.glow = 0;

    const width = s.width;
    const height = s.height;
    const maxVehicles = Math.min(s.vehicles.length, MAX_RENDER_VEHICLES);
    const lerpPosition = 1 - Math.exp(-dt * 18);
    const lerpYaw = 1 - Math.exp(-dt * 12);

    for (let i = 0; i < maxVehicles; i++) {
      const vehicle = s.vehicles[i];
      if (!vehicle || vehicle.done) continue;
      const template = templateFor(vehicle.kind);
      const isMtr = vehicle.kind === 'mtr';

      // ── 目標世界座標（vehicle.x/y 為格中心座標） ──
      const isFerry = vehicle.kind === 'ferry';
      const targetX = vehicle.x * TILE - halfW;
      const targetZ = vehicle.y * TILE - halfH;
      const targetYaw = vehicle.angle;

      // ── 平滑位置／朝向（新車直接對位；跳位過大直接校正） ──
      let smoothState = smooth.get(vehicle.id);
      if (!smoothState) {
        smoothState = { x: targetX, z: targetZ, yaw: targetYaw, touch: frame };
        smooth.set(vehicle.id, smoothState);
      } else {
        const dx = targetX - smoothState.x;
        const dz = targetZ - smoothState.z;
        if (dx * dx + dz * dz > (TILE * 4) * (TILE * 4)) {
          smoothState.x = targetX;
          smoothState.z = targetZ;
        } else {
          smoothState.x += dx * lerpPosition;
          smoothState.z += dz * lerpPosition;
        }
        smoothState.yaw = lerpAngle(smoothState.yaw, targetYaw, lerpYaw);
        smoothState.touch = frame;
      }

      const yaw = smoothState.yaw;

      // ── 貼地高度 ──
      let baseY: number;
      let laneX = 0;
      let laneZ = 0;
      if (isFerry) {
        baseY = WATER_SURFACE_Y + FERRY_DRAFT + Math.sin(elapsed * 1.3 + idHash(vehicle.id) * 6.28) * 0.025;
      } else if (isMtr) {
        const tx = Math.min(width - 1, Math.max(0, Math.floor(vehicle.x)));
        const ty = Math.min(height - 1, Math.max(0, Math.floor(vehicle.y)));
        const tile = s.tiles[ty * width + tx];
        const grade = tile?.rail ?? 'surface';
        if (grade === 'underground' && !s.ui.showUnderground) {
          // U 層未開：地下列車唔顯示（同地下管網圖層一致）
          continue;
        }
        if (!tile) baseY = 0.35;
        else if (grade === 'elevated') baseY = tileTopY(tile) + 3.06;
        else if (grade === 'underground') baseY = tileTopY(tile) + 0.3;
        else baseY = tileTopY(tile) + 0.17;
      } else {
        const tx = Math.min(width - 1, Math.max(0, Math.floor(vehicle.x)));
        const ty = Math.min(height - 1, Math.max(0, Math.floor(vehicle.y)));
        const tile = s.tiles[ty * width + tx];
        baseY = tile ? roadSurfaceY(tile) : 0.35;
        // 香港靠左行駛：按朝向向左偏移
        laneX = Math.cos(yaw) * LANE_OFFSET;
        laneZ = -Math.sin(yaw) * LANE_OFFSET;
      }

      const baseX = smoothState.x + laneX;
      const baseZ = smoothState.z + laneZ;

      const idSeed = idHash(vehicle.id);
      const tint = 0.9 + idSeed * 0.2;
      const bodyColor = bodyColorOf(vehicle);
      const adColor = AD_COLORS[Math.floor(idHash(vehicle.id * 7 + 3) * AD_COLORS.length) % AD_COLORS.length];
      // 每部車固定幾種色（車身、廣告、車窗、夜燈）只查一次快取
      const bodyResolved = resolveColor(bodyColor, tint);
      const adResolved = resolveColor(adColor, 0.85 + idHash(vehicle.id * 13 + 5) * 0.3);
      const windowHex = night > 0.35 ? GLASS_NIGHT : GLASS_DAY;
      const windowBrightness = night > 0.35 ? 0.62 + idHash(vehicle.id * 17 + 1) * 0.26 : 0.85;
      const windowResolved = resolveColor(windowHex, windowBrightness);
      const glowScale = glowBrightness * 1.15;
      const cosYaw = Math.cos(yaw);
      const sinYaw = Math.sin(yaw);

      for (const item of template) {
        const px = baseX + item.ox * cosYaw + item.oz * sinYaw;
        const py = baseY + item.oy;
        const pz = baseZ - item.ox * sinYaw + item.oz * cosYaw;
        let col: THREE.Color;
        if (item.role === 'body') col = bodyResolved;
        else if (item.role === 'ad') col = adResolved;
        else if (item.mesh === 'win') col = windowResolved;
        else if (item.mesh === 'glow') col = resolveColor(item.color, (item.dim ?? 1) * glowScale);
        else col = resolveColor(item.color, tint);
        appendPart(item.mesh, px, py, pz, cosYaw, sinYaw, item, col);
      }
    }

    boxMesh.count = used.box;
    cylMesh.count = used.cyl;
    winMesh.count = used.win;
    glowMesh.count = used.glow;
    boxMesh.instanceMatrix.needsUpdate = true;
    cylMesh.instanceMatrix.needsUpdate = true;
    winMesh.instanceMatrix.needsUpdate = true;
    glowMesh.instanceMatrix.needsUpdate = true;
    if (boxMesh.instanceColor) boxMesh.instanceColor.needsUpdate = true;
    if (cylMesh.instanceColor) cylMesh.instanceColor.needsUpdate = true;
    if (winMesh.instanceColor) winMesh.instanceColor.needsUpdate = true;
    if (glowMesh.instanceColor) glowMesh.instanceColor.needsUpdate = true;

    // 清理長時間未見的車輛（拆除／回收）
    if (frame % 120 === 0) {
      for (const [id, entry] of smooth) {
        if (frame - entry.touch > 240) smooth.delete(id);
      }
    }
  };

  update(state, 0);

  return {
    group,
    update,
    dispose(): void {
      smooth.clear();
      boxGeometry.dispose();
      cylinderGeometry.dispose();
      boxMaterial.dispose();
      cylinderMaterial.dispose();
      windowMaterial.dispose();
      glowMaterial.dispose();
      boxMesh.dispose();
      cylMesh.dispose();
      winMesh.dispose();
      glowMesh.dispose();
      group.clear();
    },
  };
}
