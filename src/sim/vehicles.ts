/**
 * 道路交通車輛模擬（transport-dev）：巴士、小巴、的士、私家車、電單車、電車、渡輪。
 *
 * 對外契約（docs/ARCHITECTURE.md §5.3）：
 *   tickVehicles(state, gameMinutes): void   每幀移動車輛、生成／回收（simulation.ts 每幀呼叫）
 *   spawnTrafficVehicle(state, kind): Vehicle | null
 *   despawnTrafficVehicle(state, id): void
 *   trafficVehicleTargets(state): VehicleTargets
 *   MAX_TRAFFIC_VEHICLES = 120
 *
 * 設計
 * - 車輛沿 `tile.road === true` 的道路格四方向行走；自行 BFS 建立路徑（不依賴
 *   systems-dev 的 A*，避免互相影響），按人口與交通建築數量生成，上限 120。
 * - 生成：
 *     巴士（雙層，黃／紅）    需要巴士總站；由總站附近道路開出
 *     小巴（綠 van／紅 van）  有巴士總站時由總站附近開出，否則路面隨機
 *     的士（紅）／私家車／電單車  路面隨機
 *     電車（叮叮，綠色）      只在電車站附近道路生成（無電車站則不出現）
 *     渡輪（天星小輪）        兩個以上渡輪碼頭，於碼頭對開水域之間直線航行
 *   物流貨車／客貨車（state.carts）由 citizens-dev 的 render/citizens.ts 負責，本檔不生成。
 *   港鐵列車在地底／高架走廊，戶外不渲染（港鐵只以站點及交通統計呈現）。
 * - 速度感：格／遊戲分鐘（1 倍速時 1 現實秒 ≈ 48 遊戲分鐘）。路口減速、同格／
 *   前方塞車減速、天氣（WEATHER_EFFECT.move）減速、夜間略快、颱風大幅減速。
 * - 渡輪：颱風（weather === 'storm'）或 state.transit.suspended 時停航（回港）；
 *   渡輪只在水域航行，出生前會驗證兩點之間整條航線都是水域。
 * - 座標慣例：`vehicle.x/y` 為「格中心座標」（格 (tx,ty) 中心 = tx+0.5, ty+0.5），
 *   與舊版 citizens 一致；render/vehicles.ts 用它換算世界座標。
 * - 存檔：車輛全部寫在 state.vehicles（Vehicle 契約），done=true 的會在下一幀回收。
 *   執行期快取（道路索引、BFS buffer、生成節奏）放在 WeakMap，不進存檔。
 */

import { BUILDINGS, TRANSIT_LINE_CONFIG, WEATHER_EFFECT } from '../core/config';
import { mulberry32, type Rng } from '../core/rng';
import type { Building, GameState, TransitLine, TransitMode, Vehicle, VehicleKind } from '../core/types';
import { getTransitLines, lineRoadPath } from './transit';
import { railTrainRoutes, type RailTrainRoute } from './rail';

// ─────────────────────────── 常數（檔案頂部集中管理） ───────────────────────────

/** 同時存在的交通車輛上限（效能預算；不含 logistics carts） */
export const MAX_TRAFFIC_VEHICLES = 120;

/** 道路車輛速度（格／遊戲分鐘）。1 格約 40~50 米；1 倍速 1 現實秒 = 48 遊戲分鐘。 */
const VEHICLE_SPEED: Record<VehicleKind, number> = {
  bus: 0.05,
  minibus: 0.065,
  taxi: 0.09,
  car: 0.082,
  motorcycle: 0.105,
  tram: 0.042,
  ferry: 0.075,
  truck: 0.055,
  van: 0.072,
  mtr: 0.2,
};

/** 各種路面車的 BFS 目標路徑長度（格） */
const ROUTE_STEPS: Record<string, { min: number; max: number }> = {
  bus: { min: 18, max: 55 },
  minibus: { min: 12, max: 40 },
  tram: { min: 10, max: 34 },
  default: { min: 8, max: 30 },
};

/** 生成節奏（累積遊戲分鐘）；塞滿城市後放慢，避免一次爆量 */
const SPAWN_INTERVAL_MIN = 20;
const SPAWN_INTERVAL_MAX = 65;

/** 巴士／小巴在總站附近幾格內的道路出生 */
const TERMINUS_SPAWN_RADIUS = 4;
/** 電車只可在電車站附近幾格的道路出生 */
const TRAM_SPAWN_RADIUS = 5;

/** 路口（3 條以上道路相接）減速 */
const INTERSECTION_SLOWDOWN = 0.68;
/** 同格擠塞／前方擠塞減速 */
const JAM_SLOWDOWN = 0.45;
/** 到達目的地後直接收車的機率（其餘繼續開往下一段） */
const RECYCLE_CHANCE = 0.24;

/** 夜間（22:00–06:00）車輛目標數量倍率；傍晚亦稍減 */
const NIGHT_TRAFFIC_FACTOR = 0.32;
const EVENING_TRAFFIC_FACTOR = 0.72;

/** 渡輪航道 BFS 上限（格）；超過 400 格視為太遠，唔派船 */
const MAX_FERRY_PATH_TILES = 400;
/** 渡輪最短航道（格）；太短就唔算過海航線 */
const MIN_FERRY_PATH_TILES = 3;
/** 水域 BFS 最多探索節點（防止喺巨型地圖亂探） */
const WATER_BFS_VISIT_LIMIT = 40000;

/** 生成用的 BFS 擴散上限（避免大 map 全搜） */
const BFS_VISIT_LIMIT = 3200;

/** 颱風時路面車輛目標數量倍率（其餘天氣用 WEATHER_EFFECT.move） */
const STORM_TRAFFIC_FACTOR = 0.4;

/** 可自動生成的交通車輛種類（truck／van 由物流負責；mtr 列車由鐵路網單獨派車） */
export const TRAFFIC_KINDS: VehicleKind[] = ['bus', 'minibus', 'taxi', 'car', 'motorcycle', 'tram'];

/** 同時最多嘅港鐵列車數（Round 6 鐵路網） */
export const MAX_RAIL_TRAINS = 8;
/** 每幀最多補幾架列車（避免一次爆量） */
const RAIL_TRAIN_SPAWN_PER_TICK = 2;

/** 交通系統執行期診斷（QA／除錯用；不進存檔） */
export interface VehicleDiagnostics {
  roads: number;
  target: number;
  count: number;
  spawnAttempts: number;
  spawnSuccess: number;
  spawnFailures: number;
  retired: number;
  /** 目前路線車輛數（巴士／小巴） */
  lineVehicles: number;
}

const diagnostics: VehicleDiagnostics = {
  roads: 0,
  target: 0,
  count: 0,
  spawnAttempts: 0,
  spawnSuccess: 0,
  spawnFailures: 0,
  retired: 0,
  lineVehicles: 0,
};

/** 讀取交通系統執行期診斷（累計值；新局／讀檔後會沿用同一組計數） */
export function getVehicleDiagnostics(): VehicleDiagnostics {
  return { ...diagnostics };
}

// ─────────────────────────── 執行期快取 ───────────────────────────

interface RoadIndex {
  /** 以 state.ui.revision 偵測道路變更 */
  revision: number;
  roadTiles: number[];
  isRoad: Uint8Array;
  /** 每格的道路鄰接數（用於判斷路口） */
  degree: Uint8Array;
}

interface VehiclesRuntime {
  roadIndex: RoadIndex | null;
  rng: Rng;
  /** 每格車輛佔用數（每幀重建） */
  occupancy: Int16Array | null;
  /** BFS 重用 buffer（避免每次生成都 new） */
  bfsDist: Int32Array | null;
  bfsParent: Int32Array | null;
  bfsQueue: Int32Array | null;
  spawnAccumulator: number;
  /** 上一幀的車輛目標總數（除數用） */
  targetTotal: number;
  /** 渡輪航道 BFS 重用 buffer */
  waterStamp: Int32Array | null;
  waterParent: Int32Array | null;
  waterQueue: Int32Array | null;
  waterToken: number;
}

const runtimes = new WeakMap<GameState, VehiclesRuntime>();

function runtimeOf(state: GameState): VehiclesRuntime {
  let rt = runtimes.get(state);
  if (!rt) {
    rt = {
      roadIndex: null,
      rng: mulberry32((state.seed ^ 0x5f356495) >>> 0),
      occupancy: null,
      bfsDist: null,
      bfsParent: null,
      bfsQueue: null,
      spawnAccumulator: 0,
      targetTotal: 0,
      waterStamp: null,
      waterParent: null,
      waterQueue: null,
      waterToken: 0,
    };
    runtimes.set(state, rt);
  }
  return rt;
}

// ─────────────────────────── 道路索引 ───────────────────────────

function buildRoadIndex(state: GameState, revision: number): RoadIndex {
  const n = state.width * state.height;
  const isRoad = new Uint8Array(n);
  const degree = new Uint8Array(n);
  const roadTiles: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!state.tiles[i]?.road) continue;
    isRoad[i] = 1;
    roadTiles.push(i);
  }
  const width = state.width;
  for (const index of roadTiles) {
    const x = index % width;
    const y = (index / width) | 0;
    let d = 0;
    if (y > 0 && isRoad[index - width]) d++;
    if (y < state.height - 1 && isRoad[index + width]) d++;
    if (x > 0 && isRoad[index - 1]) d++;
    if (x < width - 1 && isRoad[index + 1]) d++;
    degree[index] = d;
  }
  return { revision, roadTiles, isRoad, degree };
}

function ensureRoadIndex(state: GameState, rt: VehiclesRuntime): RoadIndex {
  if (!rt.roadIndex || rt.roadIndex.revision !== state.ui.revision) {
    rt.roadIndex = buildRoadIndex(state, state.ui.revision);
  }
  return rt.roadIndex;
}

// ─────────────────────────── 小工具 ───────────────────────────

/** 車輛所屬路線（Vehicle.lineId，Round 5）；非路線車輛回傳 null */
function vehicleLineId(vehicle: Vehicle): number | null {
  const lineId = vehicle.lineId;
  return typeof lineId === 'number' && lineId > 0 ? lineId : null;
}

function setVehicleLineId(vehicle: Vehicle, lineId: number): void {
  vehicle.lineId = lineId;
}

/** 路線顏色 #rrggbb → 0xrrggbb（解不到用巴士黃） */
function parseLineColor(color: string | undefined): number {
  if (!color) return 0xd9b23f;
  const match = /^#([0-9a-fA-F]{6})$/.exec(color);
  return match ? parseInt(match[1], 16) : 0xd9b23f;
}

/** 目前非路線車輛（generic 車流）數量 */
function countGenericVehicles(state: GameState): number {
  let count = 0;
  for (const vehicle of state.vehicles) {
    if (vehicle.done) continue;
    if (vehicle.kind === 'mtr') continue; // 港鐵列車唔佔用路面車流 quota
    if (vehicleLineId(vehicle) === null) count++;
  }
  return count;
}

/** 目前路線車輛數量 */
function countLineVehicles(state: GameState): number {
  let count = 0;
  for (const vehicle of state.vehicles) {
    if (!vehicle.done && vehicleLineId(vehicle) !== null) count++;
  }
  return count;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function tileCenterX(state: GameState, index: number): number {
  return (index % state.width) + 0.5;
}

function tileCenterY(state: GameState, index: number): number {
  return Math.floor(index / state.width) + 0.5;
}

function isWaterAt(state: GameState, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) return false;
  return state.tiles[ty * state.width + tx]?.terrain === 'water';
}

function randomOf<T>(rng: Rng, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length) % list.length];
}

function isNight(state: GameState): boolean {
  const hour = state.clock.hour;
  return hour < 6 || hour >= 22;
}

function isEvening(state: GameState): boolean {
  const hour = state.clock.hour;
  return hour >= 19 && hour < 22;
}

/** 天氣對車速／車量的影響（颱風另計） */
function weatherTrafficFactor(state: GameState): number {
  if (state.clock.weather === 'storm') return STORM_TRAFFIC_FACTOR;
  const move = WEATHER_EFFECT[state.clock.weather]?.move ?? 1;
  return clamp(move, 0.35, 1.1);
}

/** 車輛目前所在格 index（以 path + pathProgress 計算；渡輪回傳 -1） */
function currentTileOf(state: GameState, v: Vehicle): number {
  if (v.kind === 'ferry' || v.path.length < 2) return -1;
  const last = v.path.length - 1;
  const seg = clamp(Math.floor(v.pathProgress), 0, last - 1);
  return v.path[seg];
}

/** 依 path／pathProgress 更新 x/y/angle（格中心座標系） */
function updateVehiclePose(state: GameState, v: Vehicle): void {
  const path = v.path;
  const last = path.length - 1;
  if (last < 0) return;
  if (last === 0) {
    v.x = tileCenterX(state, path[0]);
    v.y = tileCenterY(state, path[0]);
    return;
  }
  const rawIndex = Math.floor(v.pathProgress);
  const index = clamp(rawIndex, 0, last - 1);
  const t = clamp(v.pathProgress - index, 0, 1);
  const a = path[index];
  const b = path[Math.min(index + 1, last)];
  const ax = tileCenterX(state, a);
  const ay = tileCenterY(state, a);
  const bx = tileCenterX(state, b);
  const by = tileCenterY(state, b);
  v.x = ax + (bx - ax) * t;
  v.y = ay + (by - ay) * t;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx !== 0 || dy !== 0) v.angle = Math.atan2(dx, dy);
}

// ─────────────────────────── BFS 路線 ───────────────────────────

interface BfsResult {
  path: number[];
  end: number;
}

/**
 * 由 start 沿道路 BFS，隨機選一個距離在 [minSteps, maxSteps] 的可達格作終點。
 * 重用 buffer，只在生成／改路時呼叫（不影響每幀效能）。
 */
function findRoute(
  state: GameState,
  rt: VehiclesRuntime,
  index: RoadIndex,
  start: number,
  minSteps: number,
  maxSteps: number,
): BfsResult | null {
  const n = state.width * state.height;
  if (n <= 0 || start < 0 || start >= n) return null;
  if (!index.isRoad[start]) return null;
  if (!rt.bfsDist || rt.bfsDist.length !== n) {
    rt.bfsDist = new Int32Array(n);
    rt.bfsParent = new Int32Array(n);
    rt.bfsQueue = new Int32Array(n);
  }
  const dist = rt.bfsDist;
  const parent = rt.bfsParent as Int32Array;
  const queue = rt.bfsQueue as Int32Array;
  // 只重設今次 BFS 走過的格（比 fill 整個 map 便宜）
  const touched: number[] = [];
  const width = state.width;
  const height = state.height;
  const rng = rt.rng;

  dist[start] = 0;
  parent[start] = -1;
  queue[0] = start;
  touched.push(start);
  let head = 0;
  let tail = 1;
  const candidates: number[] = [];
  let lastReached = start;

  while (head < tail && tail < BFS_VISIT_LIMIT) {
    const cur = queue[head++];
    const d = dist[cur];
    lastReached = cur;
    if (d >= maxSteps) continue;
    const cx = cur % width;
    const cy = (cur / width) | 0;
    for (let dir = 0; dir < 4; dir++) {
      let nb: number;
      if (dir === 0) {
        if (cy === 0) continue;
        nb = cur - width;
      } else if (dir === 1) {
        if (cy === height - 1) continue;
        nb = cur + width;
      } else if (dir === 2) {
        if (cx === 0) continue;
        nb = cur - 1;
      } else {
        if (cx === width - 1) continue;
        nb = cur + 1;
      }
      if (!index.isRoad[nb] || dist[nb] !== 0 || nb === start) continue;
      dist[nb] = d + 1;
      parent[nb] = cur;
      touched.push(nb);
      queue[tail++] = nb;
      if (d + 1 >= minSteps) candidates.push(nb);
      if (tail >= BFS_VISIT_LIMIT) break;
    }
  }

  let end = -1;
  if (candidates.length > 0) {
    end = candidates[Math.floor(rng() * candidates.length) % candidates.length];
  } else if (lastReached !== start && dist[lastReached] >= 2) {
    end = lastReached;
  }

  let path: number[] | null = null;
  if (end >= 0) {
    path = [];
    let cur = end;
    let guard = 0;
    while (cur !== -1 && guard++ < n) {
      path.push(cur);
      cur = parent[cur];
    }
    path.reverse();
    if (path.length < 2 || path[0] !== start) path = null;
  }

  // 重設走過的格（保留 0 作為未訪問；start 的 dist 也要重設）
  for (const cell of touched) dist[cell] = 0;
  return path ? { path, end } : null;
}

/** 選一段新路線：由 from 沿道路延伸；失敗回傳 null */
function assignRoute(
  state: GameState,
  rt: VehiclesRuntime,
  index: RoadIndex,
  kind: VehicleKind,
  from: number,
): number[] | null {
  const steps = ROUTE_STEPS[kind] ?? ROUTE_STEPS.default;
  const result = findRoute(state, rt, index, from, steps.min, steps.max);
  return result ? result.path : null;
}

// ─────────────────────────── 生成：選點 ───────────────────────────

/** 指定交通模式站點附近（radius 格內）的道路格 */
function roadTilesNearTransit(
  state: GameState,
  rt: VehiclesRuntime,
  index: RoadIndex,
  mode: TransitMode,
  radius: number,
): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const building of state.buildings) {
    const transit = BUILDINGS[building.key]?.transit;
    if (!transit || transit.mode !== mode) continue;
    if (!building.active) continue;
    for (let ty = building.y - radius; ty < building.y + building.h + radius; ty++) {
      for (let tx = building.x - radius; tx < building.x + building.w + radius; tx++) {
        if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) continue;
        const tile = ty * state.width + tx;
        if (!index.isRoad[tile] || seen.has(tile)) continue;
        // 距離建築佔地（以中心點近似）在 radius 內
        const cx = building.x + building.w / 2;
        const cy = building.y + building.h / 2;
        const dx = tx + 0.5 - cx;
        const dy = ty + 0.5 - cy;
        if (dx * dx + dy * dy > radius * radius) continue;
        seen.add(tile);
        result.push(tile);
      }
    }
  }
  void rt;
  return result;
}

/** 隨機挑一格道路（避開已擠塞的格） */
function randomRoadTile(state: GameState, rt: VehiclesRuntime, index: RoadIndex): number {
  const roads = index.roadTiles;
  if (roads.length === 0) return -1;
  const occupancy = rt.occupancy;
  for (let attempt = 0; attempt < 8; attempt++) {
    const tile = roads[Math.floor(rt.rng() * roads.length) % roads.length];
    if (!occupancy || occupancy[tile] <= 1) return tile;
  }
  return roads[Math.floor(rt.rng() * roads.length) % roads.length];
}

function chooseSpawnTile(
  state: GameState,
  rt: VehiclesRuntime,
  index: RoadIndex,
  kind: VehicleKind,
): number {
  if (kind === 'tram') {
    const tiles = roadTilesNearTransit(state, rt, index, 'tram', TRAM_SPAWN_RADIUS);
    if (tiles.length === 0) return -1;
    return randomOf(rt.rng, tiles);
  }
  if (kind === 'bus') {
    const tiles = roadTilesNearTransit(state, rt, index, 'bus', TERMINUS_SPAWN_RADIUS);
    if (tiles.length === 0) return -1;
    return randomOf(rt.rng, tiles);
  }
  if (kind === 'minibus') {
    const tiles = roadTilesNearTransit(state, rt, index, 'bus', TERMINUS_SPAWN_RADIUS);
    if (tiles.length > 0 && rt.rng() < 0.65) return randomOf(rt.rng, tiles);
    return randomRoadTile(state, rt, index);
  }
  return randomRoadTile(state, rt, index);
}

// ─────────────────────────── 生成：車輛 ───────────────────────────

const TAXI_RED = 0xd93f3f;
const MINIBUS_GREEN = 0x3f8f5f;
const MINIBUS_RED = 0xd93f3f;
const BUS_YELLOW = 0xd9b23f;
const BUS_RED = 0xd93f3f;
const TRAM_GREEN = 0x2f8f5f;
const FERRY_GREEN_WHITE = 0x2f7f6a;

function pickVehicleColor(state: GameState, kind: VehicleKind, rng: Rng): number {
  switch (kind) {
    case 'bus':
      return rng() < 0.7 ? BUS_YELLOW : BUS_RED;
    case 'minibus':
      return rng() < 0.62 ? MINIBUS_GREEN : MINIBUS_RED;
    case 'taxi':
      return TAXI_RED;
    case 'tram':
      return TRAM_GREEN;
    case 'ferry':
      return FERRY_GREEN_WHITE;
    case 'car':
      return randomOf(rng, [0xf0f0f0, 0x2f2f2f, 0xb02a2a, 0x2f5f9f, 0xcfd8e3, 0x8a9a8a]);
    case 'motorcycle':
      return randomOf(rng, [0x2f2f2f, 0xb02a2a, 0x2f5f9f]);
    default:
      void state;
      return 0xcfd8e3;
  }
}

function pickVehicleLoad(kind: VehicleKind, rng: Rng): number {
  switch (kind) {
    case 'bus':
      return 8 + Math.floor(rng() * 78);
    case 'minibus':
      return 2 + Math.floor(rng() * 16);
    case 'taxi':
      return 1 + Math.floor(rng() * 4);
    case 'car':
      return 1 + Math.floor(rng() * 4);
    case 'motorcycle':
      return rng() < 0.5 ? 1 : 2;
    case 'tram':
      return 6 + Math.floor(rng() * 50);
    case 'ferry':
      return 20 + Math.floor(rng() * 130);
    default:
      return 0;
  }
}

/** 建立一輛道路交通車輛並加入 state.vehicles；失敗回傳 null */
function spawnRoadVehicle(
  state: GameState,
  rt: VehiclesRuntime,
  index: RoadIndex,
  kind: VehicleKind,
): Vehicle | null {
  if (state.vehicles.length >= MAX_TRAFFIC_VEHICLES) return null;
  const start = chooseSpawnTile(state, rt, index, kind);
  if (start < 0) return null;
  const path = assignRoute(state, rt, index, kind, start);
  if (!path || path.length < 2) return null;

  const rng = rt.rng;
  const vehicle: Vehicle = {
    id: state.nextVehicleId++,
    kind,
    x: tileCenterX(state, start),
    y: tileCenterY(state, start),
    angle: 0,
    path,
    pathProgress: 0,
    speed: VEHICLE_SPEED[kind] * (0.88 + rng() * 0.24),
    color: pickVehicleColor(state, kind, rng),
    load: pickVehicleLoad(kind, rng),
    transit: true,
    done: false,
  };
  updateVehiclePose(state, vehicle);
  state.vehicles.push(vehicle);
  return vehicle;
}

// ─────────────────────────── 生成：渡輪 ───────────────────────────

/** 渡輪碼頭對開的水域格（碼頭佔地四周一圈） */
function pierWaterTiles(state: GameState, building: Building): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  const push = (tx: number, ty: number): void => {
    if (!isWaterAt(state, tx, ty)) return;
    const tile = ty * state.width + tx;
    if (seen.has(tile)) return;
    seen.add(tile);
    result.push(tile);
  };
  for (let dx = 0; dx < building.w; dx++) {
    push(building.x + dx, building.y - 1);
    push(building.x + dx, building.y + building.h);
  }
  for (let dy = 0; dy < building.h; dy++) {
    push(building.x - 1, building.y + dy);
    push(building.x + building.w, building.y + dy);
  }
  // 碼頭被陸地包圍時，再向外找一格（部分地圖碼頭與水面隔一格）
  if (result.length === 0) {
    for (let dy = -2; dy <= building.h + 1; dy++) {
      for (let dx = -2; dx <= building.w + 1; dx++) {
        push(building.x + dx, building.y + dy);
      }
    }
  }
  return result;
}

/** 航道全部格都係水？（spawn 前／每次重用都驗） */
function isWaterPathValid(state: GameState, path: number[]): boolean {
  if (path.length < MIN_FERRY_PATH_TILES) return false;
  for (const tile of path) {
    if (state.tiles[tile]?.terrain !== 'water') return false;
  }
  return true;
}

/**
 * 水域 4 鄰接 BFS：由 starts（碼頭 A 對開水域）搵最近可達 goals（碼頭 B 對開水域）。
 * 只可行 water tile；回傳包含頭尾嘅完整 tile path（最短），搵唔到／超過 maxTiles 回傳 null。
 * 用 runtime buffer（stamp/parent/queue）避免每次 allocation。
 */
function findWaterPath(
  state: GameState,
  rt: VehiclesRuntime,
  starts: number[],
  goals: number[],
  maxTiles: number,
): number[] | null {
  const n = state.tiles.length;
  if (!rt.waterStamp || rt.waterStamp.length !== n) {
    rt.waterStamp = new Int32Array(n);
    rt.waterParent = new Int32Array(n);
    rt.waterQueue = new Int32Array(n);
    rt.waterToken = 0;
  }
  const stamp = rt.waterStamp;
  const parent = rt.waterParent as Int32Array;
  const queue = rt.waterQueue as Int32Array;
  rt.waterToken += 1;
  if (rt.waterToken > 0x3fffffff) {
    stamp.fill(0);
    rt.waterToken = 1;
  }
  const token = rt.waterToken;

  const goalSet = new Set<number>();
  for (const goal of goals) {
    if (state.tiles[goal]?.terrain === 'water') goalSet.add(goal);
  }
  if (goalSet.size === 0) return null;

  let head = 0;
  let tail = 0;
  for (const start of starts) {
    if (stamp[start] === token) continue;
    if (state.tiles[start]?.terrain !== 'water') continue;
    stamp[start] = token;
    parent[start] = -1;
    queue[tail++] = start;
  }
  if (tail === 0) return null;

  const width = state.width;
  const height = state.height;
  let visited = 0;
  while (head < tail && visited < WATER_BFS_VISIT_LIMIT) {
    const cur = queue[head++];
    visited++;
    if (goalSet.has(cur)) {
      const path: number[] = [];
      let node = cur;
      while (node !== -1) {
        path.push(node);
        node = parent[node];
      }
      path.reverse();
      return path.length >= MIN_FERRY_PATH_TILES && path.length <= maxTiles ? path : null;
    }
    const x = cur % width;
    const y = (cur / width) | 0;
    const neighbors = [
      y > 0 ? cur - width : -1,
      y < height - 1 ? cur + width : -1,
      x > 0 ? cur - 1 : -1,
      x < width - 1 ? cur + 1 : -1,
    ];
    for (const next of neighbors) {
      if (next < 0 || stamp[next] === token) continue;
      if (state.tiles[next]?.terrain !== 'water') continue;
      stamp[next] = token;
      parent[next] = cur;
      queue[tail++] = next;
    }
  }
  return null;
}

/**
 * 找一對可通航的渡輪碼頭航道：由碼頭 A 對開水域 BFS 到碼頭 B 對開水域，
 * 保證**整條 path 每格都係 water**（唔會再出現船喺陸地／馬路上）。
 * 碼頭對由遠至近試（遠航線較有維港氣勢）；BFS 超過 400 格 skip。
 */
function findFerryRoute(state: GameState, rt: VehiclesRuntime): number[] | null {
  const piers: Building[] = [];
  for (const building of state.buildings) {
    const transit = BUILDINGS[building.key]?.transit;
    if (transit?.mode === 'ferry' && building.active) piers.push(building);
  }
  if (piers.length < 2) return null;
  const waterTiles = piers.map((pier) => pierWaterTiles(state, pier));

  const pairs: { a: number; b: number; dist: number }[] = [];
  for (let i = 0; i < piers.length; i++) {
    for (let j = i + 1; j < piers.length; j++) {
      if (waterTiles[i].length === 0 || waterTiles[j].length === 0) continue;
      const pi = piers[i];
      const pj = piers[j];
      const dist = Math.hypot(
        pi.x + pi.w / 2 - (pj.x + pj.w / 2),
        pi.y + pi.h / 2 - (pj.y + pj.h / 2),
      );
      pairs.push({ a: i, b: j, dist });
    }
  }
  pairs.sort((a, b) => b.dist - a.dist);
  for (const pair of pairs) {
    const path = findWaterPath(state, rt, waterTiles[pair.a], waterTiles[pair.b], MAX_FERRY_PATH_TILES);
    if (!path) continue;
    if (!isWaterPathValid(state, path)) continue;
    // 一半機會反向航行（兩岸出發方向都有船）
    return rt.rng() < 0.5 ? path : path.slice().reverse();
  }
  return null;
}

function spawnFerryVehicle(state: GameState, rt: VehiclesRuntime): Vehicle | null {
  if (state.vehicles.length >= MAX_TRAFFIC_VEHICLES) return null;
  if (state.transit.suspended || state.clock.weather === 'storm') return null;
  const route = findFerryRoute(state, rt);
  if (!route || !isWaterPathValid(state, route)) return null;
  const rng = rt.rng;
  const path = route.slice();
  const vehicle: Vehicle = {
    id: state.nextVehicleId++,
    kind: 'ferry',
    x: tileCenterX(state, path[0]),
    y: tileCenterY(state, path[0]),
    angle: 0,
    path,
    pathProgress: 0,
    speed: VEHICLE_SPEED.ferry * (0.9 + rng() * 0.2),
    color: FERRY_GREEN_WHITE,
    load: pickVehicleLoad('ferry', rng),
    transit: true,
    done: false,
  };
  updateVehiclePose(state, vehicle);
  state.vehicles.push(vehicle);
  return vehicle;
}

// ─────────────────────────── 對外生成 helper ───────────────────────────

/**
 * 手動生成一輛交通車輛（除錯／事件／測試用）。
 * 只接受 TRAFFIC_KINDS（truck／van 屬物流、mtr 不戶外渲染 → 回傳 null）。
 */
export function spawnTrafficVehicle(state: GameState, kind: VehicleKind = 'car'): Vehicle | null {
  if (!TRAFFIC_KINDS.includes(kind) && kind !== 'ferry') return null;
  const rt = runtimeOf(state);
  const index = ensureRoadIndex(state, rt);
  if (kind === 'ferry') return spawnFerryVehicle(state, rt);
  return spawnRoadVehicle(state, rt, index, kind);
}

/** 回收指定車輛（不存在或已回收則忽略） */
export function despawnTrafficVehicle(state: GameState, id: number): void {
  for (let i = state.vehicles.length - 1; i >= 0; i--) {
    if (state.vehicles[i].id === id) {
      state.vehicles[i].done = true;
      return;
    }
  }
}

// ─────────────────────────── 數量目標 ───────────────────────────

export interface VehicleTargets {
  bus: number;
  minibus: number;
  taxi: number;
  car: number;
  motorcycle: number;
  tram: number;
  ferry: number;
}

/** 依人口、道路數量、交通建築、時間與天氣計算各車種目標數量（總和 <= 120） */
export function trafficVehicleTargets(state: GameState): VehicleTargets {
  const rt = runtimeOf(state);
  const index = ensureRoadIndex(state, rt);
  const targets: VehicleTargets = { bus: 0, minibus: 0, taxi: 0, car: 0, motorcycle: 0, tram: 0, ferry: 0 };
  const roads = index.roadTiles.length;
  if (roads < 8) return targets;

  let busTerminals = 0;
  let tramStops = 0;
  let piers = 0;
  for (const building of state.buildings) {
    const transit = BUILDINGS[building.key]?.transit;
    if (!transit) continue;
    if (transit.mode === 'bus') busTerminals++;
    else if (transit.mode === 'tram') tramStops++;
    else if (transit.mode === 'ferry') piers++;
  }

  const pop = state.citizens.length;
  // 城市規模 0~1（350 人左右已算「有規模」；上限 1.6 讓人口多時車流更旺）
  const scale = clamp(pop / 350, 0.1, 1.6);
  const dayFactor = isNight(state) ? NIGHT_TRAFFIC_FACTOR : isEvening(state) ? EVENING_TRAFFIC_FACTOR : 1;
  const weatherFactor = weatherTrafficFactor(state);
  const roadFactor = clamp(roads / 180, 0.25, 1.25);

  const density = scale * dayFactor * weatherFactor * roadFactor;
  // 基本車流跟道路長度走：小村莊只有幾架車，發展後才車水馬龍
  const roadBaseCars = clamp(roads / 45, 0, 6);
  const roadBaseTaxis = clamp(roads / 100, 0, 3);
  targets.car = Math.round(roadBaseCars + density * 24);
  targets.taxi = Math.round(roadBaseTaxis + density * 11);
  targets.motorcycle = Math.round(clamp(roads / 200, 0, 2) + density * 6);
  targets.minibus = Math.round((busTerminals > 0 ? 2 : 1) + density * 4);
  targets.bus = busTerminals > 0 ? Math.round(busTerminals * 2 + density * 4) : 0;
  targets.tram = tramStops > 0 ? Math.round(Math.min(6, tramStops * 2) * (0.45 + 0.55 * dayFactor)) : 0;
  targets.ferry =
    piers >= 2 && !state.transit.suspended && state.clock.weather !== 'storm'
      ? Math.min(4, Math.floor(piers / 2) + 1)
      : 0;

  // 上限 120：超出時按比例縮減路面車（渡輪優先保留）
  const roadTargets: (keyof VehicleTargets)[] = ['bus', 'minibus', 'taxi', 'car', 'motorcycle', 'tram'];
  let roadSum = roadTargets.reduce((sum, key) => sum + targets[key], 0);
  const budget = MAX_TRAFFIC_VEHICLES - targets.ferry;
  if (roadSum > budget && roadSum > 0) {
    const factor = budget / roadSum;
    for (const key of roadTargets) targets[key] = Math.floor(targets[key] * factor);
    roadSum = budget;
  }

  // 開局未有市民：留少量車流令城市不至於完全死寂
  if (pop === 0) {
    targets.car = Math.min(targets.car, roads > 40 ? 3 : 0);
    targets.taxi = Math.min(targets.taxi, roads > 70 ? 1 : 0);
    targets.motorcycle = 0;
    targets.minibus = Math.min(targets.minibus, 1);
  }
  return targets;
}

function countVehiclesByKind(state: GameState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const vehicle of state.vehicles) {
    if (vehicle.done) continue;
    // 路線車輛有自己的車數管理，唔計入 generic 車流目標
    if (vehicleLineId(vehicle) !== null) continue;
    counts[vehicle.kind] = (counts[vehicle.kind] ?? 0) + 1;
  }
  return counts;
}

/** 依目標差額挑選下一部要生成的車種 */
function pickNextKind(
  rt: VehiclesRuntime,
  targets: VehicleTargets,
  counts: Record<string, number>,
): VehicleKind | null {
  const candidates: { kind: VehicleKind; weight: number }[] = [];
  const push = (kind: VehicleKind, weight: number): void => {
    if ((counts[kind] ?? 0) < targets[kind as keyof VehicleTargets]) candidates.push({ kind, weight });
  };
  push('bus', 0.7);
  push('minibus', 0.8);
  push('taxi', 1.3);
  push('car', 1.8);
  push('motorcycle', 0.7);
  push('tram', 0.7);
  if (candidates.length === 0) return null;
  let total = 0;
  for (const candidate of candidates) total += candidate.weight;
  let roll = rt.rng() * total;
  for (const candidate of candidates) {
    roll -= candidate.weight;
    if (roll <= 0) return candidate.kind;
  }
  return candidates[candidates.length - 1].kind;
}

// ─────────────────────────── 每幀更新 ───────────────────────────

/** 建立每格佔用數（塞車判斷）；每幀 O(車輛數) */
function rebuildOccupancy(state: GameState, rt: VehiclesRuntime): void {
  const n = state.width * state.height;
  if (!rt.occupancy || rt.occupancy.length !== n) rt.occupancy = new Int16Array(n);
  else rt.occupancy.fill(0);
  for (const vehicle of state.vehicles) {
    // 渡輪喺水面、港鐵列車喺鐵路圖層，唔計入道路佔用
    if (vehicle.done || vehicle.kind === 'ferry' || vehicle.kind === 'mtr') continue;
    const tile = currentTileOf(state, vehicle);
    if (tile >= 0 && tile < n) rt.occupancy[tile]++;
  }
}

/** 道路被拆／路徑失效時重新接路；回傳 false 代表應回收 */
function rebuildRouteOnBrokenRoad(
  state: GameState,
  rt: VehiclesRuntime,
  index: RoadIndex,
  vehicle: Vehicle,
): boolean {
  const tile = currentTileOf(state, vehicle);
  const fallback = tile >= 0 && index.isRoad[tile] ? tile : findNearestRoad(state, index, vehicle.x, vehicle.y);
  if (fallback < 0) return false;
  const path = assignRoute(state, rt, index, vehicle.kind, fallback);
  if (!path) return false;
  vehicle.path = path;
  vehicle.pathProgress = 0;
  updateVehiclePose(state, vehicle);
  return true;
}

/** 找最近的道路格（最多搜 6 格半徑） */
function findNearestRoad(state: GameState, index: RoadIndex, x: number, y: number): number {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  for (let radius = 1; radius <= 6; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) continue;
        const tile = ny * state.width + nx;
        if (index.isRoad[tile]) return tile;
      }
    }
  }
  return -1;
}

/** 更新一輛道路車輛；回傳 false 代表應回收 */
function updateRoadVehicle(
  state: GameState,
  rt: VehiclesRuntime,
  index: RoadIndex,
  vehicle: Vehicle,
  gameMinutes: number,
  globalSpeedFactor: number,
): boolean {
  const path = vehicle.path;
  const last = path.length - 1;
  if (last < 1) return false;

  const seg = clamp(Math.floor(vehicle.pathProgress), 0, last - 1);
  const tileA = path[seg];
  const tileB = path[seg + 1];
  if (!index.isRoad[tileA] || !index.isRoad[tileB]) {
    return rebuildRouteOnBrokenRoad(state, rt, index, vehicle);
  }

  // 速度：路況（路口、同格擠塞、前方擠塞）× 天氣／夜間
  let factor = globalSpeedFactor;
  if (index.degree[tileA] >= 3) factor *= INTERSECTION_SLOWDOWN;
  const occupancy = rt.occupancy;
  if (occupancy) {
    const same = occupancy[tileA];
    const ahead = occupancy[tileB] ?? 0;
    if (same > 1) factor *= Math.max(JAM_SLOWDOWN, 1 / (1 + (same - 1) * 0.6));
    if (ahead > 2) factor *= 0.78;
  }
  factor = clamp(factor, 0.12, 1.6);

  vehicle.pathProgress += Math.max(0.001, vehicle.speed * factor) * gameMinutes;
  if (vehicle.pathProgress >= last) {
    if (rt.rng() < RECYCLE_CHANCE) return false;
    // 到達路徑終點：由終點續開新路線
    const next = assignRoute(state, rt, index, vehicle.kind, path[last]);
    if (!next) return false;
    vehicle.path = next;
    vehicle.pathProgress = 0;
    // 抵達「總站」時更換載客（視覺用途）
    vehicle.load = pickVehicleLoad(vehicle.kind, rt.rng);
  }
  updateVehiclePose(state, vehicle);
  return true;
}

/** 更新一輛路線巴士／小巴（沿 line path 循環；到總站調頭）；回傳 false 代表應回收 */
function updateLineVehicle(
  state: GameState,
  rt: VehiclesRuntime,
  index: RoadIndex,
  vehicle: Vehicle,
  line: TransitLine,
  gameMinutes: number,
  globalSpeedFactor: number,
): boolean {
  const path = vehicle.path;
  const last = path.length - 1;
  if (last < 1) return false;
  const seg = clamp(Math.floor(vehicle.pathProgress), 0, last - 1);
  const tileA = path[seg];
  const tileB = path[seg + 1];
  if (!index.isRoad[tileA] || !index.isRoad[tileB]) return false; // 道路被拆：下一幀重新派路

  let factor = globalSpeedFactor;
  if (index.degree[tileA] >= 3) factor *= INTERSECTION_SLOWDOWN;
  const occupancy = rt.occupancy;
  if (occupancy) {
    const same = occupancy[tileA];
    const ahead = occupancy[tileB] ?? 0;
    if (same > 1) factor *= Math.max(JAM_SLOWDOWN, 1 / (1 + (same - 1) * 0.6));
    if (ahead > 2) factor *= 0.78;
  }
  factor = clamp(factor, 0.12, 1.6);

  vehicle.pathProgress += Math.max(0.001, vehicle.speed * factor) * gameMinutes;
  if (vehicle.pathProgress >= last) {
    if (line.loop) {
      // 循環線：lineRoadPath 已把起點補喺尾格，回捲即可無縫循環
      vehicle.pathProgress -= last;
      if (vehicle.pathProgress < 0) vehicle.pathProgress = 0;
    } else {
      // 雙向線：到總站後反轉自己條 path 調頭
      vehicle.path.reverse();
      vehicle.pathProgress = 0;
    }
    vehicle.load = Math.max(
      1,
      Math.round(TRANSIT_LINE_CONFIG.capacityPerVehicle[line.mode] * (0.25 + rt.rng() * 0.5)),
    );
  }
  updateVehiclePose(state, vehicle);
  return true;
}

/** 生成一輛路線車輛（巴士／小巴；沿站點道路循環） */
function spawnLineVehicle(
  state: GameState,
  rt: VehiclesRuntime,
  index: RoadIndex,
  line: TransitLine,
): Vehicle | null {
  if (state.vehicles.length >= MAX_TRAFFIC_VEHICLES) return null;
  if (line.vehicleCount <= 0 || line.suspended) return null;
  const path = lineRoadPath(state, line);
  if (!path || path.length < 2) return null;
  void index;
  const kind: VehicleKind = line.mode === 'bus' ? 'bus' : 'minibus';
  const rng = rt.rng;
  const vehiclePath = path.slice();
  // 非循環線：一半車輛由另一方向開出（雙向服務）
  if (!line.loop && rng() < 0.5) vehiclePath.reverse();
  const startProgress = rng() * (vehiclePath.length - 1);
  const vehicle: Vehicle = {
    id: state.nextVehicleId++,
    kind,
    x: 0,
    y: 0,
    angle: 0,
    path: vehiclePath,
    pathProgress: startProgress,
    speed: VEHICLE_SPEED[kind] * (0.94 + rng() * 0.12),
    color: parseLineColor(line.color),
    load: Math.round(TRANSIT_LINE_CONFIG.capacityPerVehicle[line.mode] * (0.25 + rng() * 0.5)),
    transit: true,
    done: false,
  };
  setVehicleLineId(vehicle, line.id);
  updateVehiclePose(state, vehicle);
  state.vehicles.push(vehicle);
  return vehicle;
}

/**
 * 同步路線車輛：
 *  - 刪線／停駛／颱風 → 移除相關車輛
 *  - 減少車數 → 移除多餘車輛
 *  - 新增線／加車 → 逐步補車（每幀最多 2 架）
 *  - 路線車輛總數會佔用 MAX_TRAFFIC_VEHICLES quota，generic 車流自動讓位
 */
function syncLineVehicles(state: GameState, rt: VehiclesRuntime, index: RoadIndex): void {
  const lines = getTransitLines(state);
  const stormy = state.clock.weather === 'storm';
  const byLine = new Map<number, Vehicle[]>();
  for (const vehicle of state.vehicles) {
    if (vehicle.done) continue;
    const lineId = vehicleLineId(vehicle);
    if (lineId === null) continue;
    const list = byLine.get(lineId);
    if (list) list.push(vehicle);
    else byLine.set(lineId, [vehicle]);
  }

  const lineById = new Map<number, TransitLine>();
  for (const line of lines) lineById.set(line.id, line);

  // 目標車數（停駛／颱風 = 0；再按總 quota 縮減）
  const desired = new Map<number, number>();
  let desiredTotal = 0;
  for (const line of lines) {
    const count = line.vehicleCount > 0 && !line.suspended && !stormy ? line.vehicleCount : 0;
    desired.set(line.id, count);
    desiredTotal += count;
  }
  const lineBudget = Math.max(0, MAX_TRAFFIC_VEHICLES - countGenericVehicles(state));
  if (desiredTotal > lineBudget) {
    const scale = lineBudget / Math.max(1, desiredTotal);
    for (const [id, count] of desired) desired.set(id, Math.max(0, Math.floor(count * scale)));
  }

  // 移除多餘／失效路線車輛
  for (const [lineId, vehicles] of byLine) {
    const line = lineById.get(lineId);
    const target = line ? desired.get(lineId) ?? 0 : 0;
    for (let i = target; i < vehicles.length; i++) {
      if (vehicles[i].done) continue;
      vehicles[i].done = true;
      diagnostics.retired++;
    }
  }

  // 補充車輛（每幀最多 2 架）
  let spawnBudget = 2;
  for (const line of lines) {
    if (spawnBudget <= 0) break;
    const target = desired.get(line.id) ?? 0;
    if (target <= 0) continue;
    const current = byLine.get(line.id)?.length ?? 0;
    let missing = Math.max(0, target - current);
    while (missing > 0 && spawnBudget > 0 && state.vehicles.length < MAX_TRAFFIC_VEHICLES) {
      if (!spawnLineVehicle(state, rt, index, line)) break;
      spawnBudget--;
      missing--;
    }
  }
  diagnostics.lineVehicles = countLineVehicles(state);
}

/** 將 generic 車流目標壓縮到指定總量（路線車輛佔用 quota 時用） */
function capTargetsToBudget(targets: VehicleTargets, budget: number): void {
  const keys: (keyof VehicleTargets)[] = ['bus', 'minibus', 'taxi', 'car', 'motorcycle', 'tram', 'ferry'];
  let sum = 0;
  for (const key of keys) sum += targets[key];
  if (sum <= budget || sum <= 0) return;
  const scale = budget / sum;
  for (const key of keys) targets[key] = Math.floor(targets[key] * scale);
}

// ─────────────────────────── Round 6：港鐵列車（rail network） ───────────────────────────

/** 現有 mtr 列車（未 done） */
function existingRailTrains(state: GameState): Vehicle[] {
  const result: Vehicle[] = [];
  for (const vehicle of state.vehicles) {
    if (!vehicle.done && vehicle.kind === 'mtr') result.push(vehicle);
  }
  return result;
}

/** 生成一架港鐵列車，沿 rail route 循環；冇路網／已滿回傳 null */
function spawnRailTrain(state: GameState, rt: VehiclesRuntime, route: RailTrainRoute): Vehicle | null {
  if (route.path.length < 2) return null;
  if (existingRailTrains(state).length >= MAX_RAIL_TRAINS) return null;
  // 列車唔佔用路面 120 架 quota，但整體仍有上限避免無限增長
  if (state.vehicles.length >= MAX_TRAFFIC_VEHICLES + MAX_RAIL_TRAINS) return null;
  const rng = rt.rng;
  const path = route.path.slice();
  const vehicle: Vehicle = {
    id: state.nextVehicleId++,
    kind: 'mtr',
    x: 0,
    y: 0,
    angle: 0,
    path,
    pathProgress: rng() * (path.length - 1),
    speed: VEHICLE_SPEED.mtr * (0.9 + rng() * 0.2),
    color: 0xb02a2a,
    load: 60 + Math.floor(rng() * 240),
    transit: true,
    done: false,
  };
  updateVehiclePose(state, vehicle);
  state.vehicles.push(vehicle);
  return vehicle;
}

/**
 * 同步鐵路列車：路網每個有效分量（≥2 已接駁站）按建議車數派車，總數上限 MAX_RAIL_TRAINS。
 * 刪軌／改路網 → 列車 path 失效會回收，下一幀按新路網重新派車。
 */
function syncRailTrains(state: GameState, rt: VehiclesRuntime): void {
  const routes = railTrainRoutes(state);
  const trains = existingRailTrains(state);
  let desiredTotal = 0;
  const desiredPerRoute: number[] = routes.map((route) => {
    const count = clamp(route.trains, 1, 3);
    desiredTotal += count;
    return count;
  });
  if (desiredTotal > MAX_RAIL_TRAINS) {
    const scale = MAX_RAIL_TRAINS / desiredTotal;
    for (let i = 0; i < desiredPerRoute.length; i++) {
      desiredPerRoute[i] = Math.max(1, Math.floor(desiredPerRoute[i] * scale));
    }
    desiredTotal = desiredPerRoute.reduce((sum, count) => sum + count, 0);
    desiredTotal = Math.min(desiredTotal, MAX_RAIL_TRAINS);
  }

  // 超額列車回收（由尾開始）
  for (let i = trains.length - 1; i >= desiredTotal; i--) {
    trains[i].done = true;
    diagnostics.retired++;
  }

  // 補車（round-robin；每幀上限 2 架）
  let missing = Math.max(0, desiredTotal - trains.length);
  let spawnBudget = RAIL_TRAIN_SPAWN_PER_TICK;
  let cursor = 0;
  while (missing > 0 && spawnBudget > 0 && routes.length > 0) {
    const route = routes[cursor % routes.length];
    cursor++;
    if (!spawnRailTrain(state, rt, route)) break;
    missing--;
    spawnBudget--;
  }
}

/** 更新一架港鐵列車；回傳 false 代表應回收（路軌被拆） */
function updateRailTrain(state: GameState, vehicle: Vehicle, gameMinutes: number): boolean {
  const path = vehicle.path;
  const last = path.length - 1;
  if (last < 1) return false;
  const seg = clamp(Math.floor(vehicle.pathProgress), 0, last - 1);
  const tileA = path[seg];
  const tileB = path[seg + 1];
  const gradeA = state.tiles[tileA]?.rail;
  const gradeB = state.tiles[tileB]?.rail;
  if (!gradeA || !gradeB) return false; // 路軌被拆：回收，sync 會按新路網重派

  // 速度：颱風時地下段維持 80%、地面／高架 50%；其他天氣地下段基本唔受影響
  const stormy = state.clock.weather === 'storm';
  const weatherMove = WEATHER_EFFECT[state.clock.weather]?.move ?? 1;
  let factor: number;
  if (gradeA === 'underground' && gradeB === 'underground') {
    factor = stormy ? 0.8 : 1;
  } else {
    factor = stormy ? 0.5 : Math.max(0.5, weatherMove);
  }
  vehicle.pathProgress += Math.max(0.001, vehicle.speed * factor) * gameMinutes;
  if (vehicle.pathProgress >= last) {
    // 到總站：反轉自己條 path 調頭（雙向行車）
    vehicle.path.reverse();
    vehicle.pathProgress = 0;
    vehicle.load = 60 + Math.floor(Math.random() * 240);
  }
  updateVehiclePose(state, vehicle);
  return true;
}

/** 更新一艘渡輪；回傳 false 代表應回收（颱風停航／航道失效） */
function updateFerryVehicle(state: GameState, vehicle: Vehicle, gameMinutes: number): boolean {
  if (state.transit.suspended || state.clock.weather === 'storm') return false;
  const path = vehicle.path;
  const last = path.length - 1;
  if (last < 1) return false;
  // 每次重用航道都驗一次：玩家／地圖若改動水域就回收（下一幀按新航道重派）
  if (!isWaterPathValid(state, path)) return false;

  const seg = clamp(Math.floor(vehicle.pathProgress), 0, last - 1);
  if (state.tiles[path[seg]]?.terrain !== 'water' || state.tiles[path[seg + 1]]?.terrain !== 'water') {
    return false;
  }

  // 沿 tile path 推進（船速較慢；按遊戲分鐘）
  vehicle.pathProgress += Math.max(0.0001, vehicle.speed) * gameMinutes;
  if (vehicle.pathProgress >= last) {
    // 到岸：調頭回航（雙向航道），並更換乘客
    vehicle.path.reverse();
    vehicle.pathProgress = 0;
    vehicle.load = 20 + Math.floor(Math.random() * 130);
    updateVehiclePose(state, vehicle);
    return true;
  }
  updateVehiclePose(state, vehicle);
  return true;
}

/**
 * 每幀更新交通車輛：移動、生成、回收。
 * @param gameMinutes 本幀推進的遊戲分鐘（simulation.ts 已按倍速換算）
 */
export function tickVehicles(state: GameState, gameMinutes: number): void {
  if (!Number.isFinite(gameMinutes) || gameMinutes <= 0) return;
  // 保險：單幀最多推進 180 遊戲分鐘（讀檔／切分頁回來不會瞬間橫越地圖）
  const dt = Math.min(gameMinutes, 180);
  const rt = runtimeOf(state);
  const index = ensureRoadIndex(state, rt);
  rebuildOccupancy(state, rt);

  const weatherFactor = weatherTrafficFactor(state);
  const nightBoost = isNight(state) ? 1.12 : 1;
  const speedFactor = clamp(weatherFactor * nightBoost, 0.15, 1.3);

  // ── 1) 移動現有車輛（generic 車流 + 巴士／小巴路線車輛） ──
  const targets = trafficVehicleTargets(state);
  const lineCount = countLineVehicles(state);
  if (lineCount > 0) capTargetsToBudget(targets, Math.max(4, MAX_TRAFFIC_VEHICLES - lineCount));
  rt.targetTotal =
    targets.bus +
    targets.minibus +
    targets.taxi +
    targets.car +
    targets.motorcycle +
    targets.tram +
    targets.ferry;

  const lineById = new Map<number, TransitLine>();
  for (const line of getTransitLines(state)) lineById.set(line.id, line);
  const stormy = state.clock.weather === 'storm';

  for (const vehicle of state.vehicles) {
    if (vehicle.done) continue;
    if (vehicle.kind === 'ferry') {
      if (!updateFerryVehicle(state, vehicle, dt)) {
        vehicle.done = true;
        diagnostics.retired++;
      }
      continue;
    }
    if (vehicle.kind === 'mtr') {
      if (!updateRailTrain(state, vehicle, dt)) {
        vehicle.done = true;
        diagnostics.retired++;
      }
      continue;
    }
    const lineId = vehicleLineId(vehicle);
    if (lineId !== null) {
      const line = lineById.get(lineId);
      if (!line || line.suspended || stormy) {
        vehicle.done = true;
        diagnostics.retired++;
        continue;
      }
      if (!updateLineVehicle(state, rt, index, vehicle, line, dt, speedFactor)) {
        vehicle.done = true;
        diagnostics.retired++;
      }
      continue;
    }
    if (!updateRoadVehicle(state, rt, index, vehicle, dt, speedFactor)) {
      vehicle.done = true;
      diagnostics.retired++;
    }
  }

  // ── 2) 回收 done 車輛（in-place，避免每幀配置新陣列） ──
  for (let i = state.vehicles.length - 1; i >= 0; i--) {
    if (state.vehicles[i].done) state.vehicles.splice(i, 1);
  }

  // ── 2b) 路線車輛同步（刪線／停駛／加減車／颱風） ──
  syncLineVehicles(state, rt, index);

  // ── 2c) 港鐵列車同步（Round 6 鐵路網；冇路軌時自然 0 架） ──
  syncRailTrains(state, rt);

  // ── 3) 生成（依目標數量與節奏） ──
  if (index.roadTiles.length < 8) return;
  const counts = countVehiclesByKind(state);
  const total = state.vehicles.length;
  rt.spawnAccumulator += dt;
  const fillRatio = rt.targetTotal > 0 ? clamp(total / rt.targetTotal, 0, 1) : 1;
  const interval = SPAWN_INTERVAL_MIN + (SPAWN_INTERVAL_MAX - SPAWN_INTERVAL_MIN) * fillRatio;
  if (rt.spawnAccumulator < interval) return;
  rt.spawnAccumulator = 0;

  let spawned = 0;
  const maxSpawnPerTick = 1;
  diagnostics.spawnAttempts++;
  diagnostics.roads = index.roadTiles.length;
  diagnostics.target = rt.targetTotal;
  diagnostics.count = state.vehicles.length;
  // 渡輪優先：有碼頭但未夠船時先補渡輪
  const ferryCount = counts.ferry ?? 0;
  if (targets.ferry > ferryCount) {
    if (spawnFerryVehicle(state, rt)) spawned++;
  }
  if (spawned < maxSpawnPerTick && state.vehicles.length < MAX_TRAFFIC_VEHICLES) {
    const kind = pickNextKind(rt, targets, countVehiclesByKind(state));
    if (kind && spawnRoadVehicle(state, rt, index, kind)) spawned++;
  }
  if (spawned > 0) diagnostics.spawnSuccess++;
  else diagnostics.spawnFailures++;
  if (spawned === 0 && total > rt.targetTotal) {
    // 超出目標（例如入夜後車流減少）：逐步回收最舊的非渡輪車輛
    for (const vehicle of state.vehicles) {
      if (vehicle.kind !== 'ferry' && !vehicle.done) {
        vehicle.done = true;
        break;
      }
    }
  }
}
