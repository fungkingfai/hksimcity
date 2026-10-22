/**
 * 香港市民系統共用模組（citizens-dev 專用）
 *
 * 提供 citizens.ts 與 population.ts 共用的基礎能力：
 *   - 跨影格暫存（WeakMap<GameState, CitizenCache>，換局／讀檔自動失效）
 *   - 香港市民姓名（中文名／英文名＋中文姓）、性別年齡、月薪 salary、通勤方式 commuteMode
 *   - 需求（food／goods／leisure）與零售購物（扣店舖庫存、扣市民錢、店舖收入）
 *   - 行人通行判定與行人 A*（只走 tile.road || tile.sidewalk，行人路優先）
 *   - 公共交通站點查詢與通勤模式選擇 pickCommuteMode（本檔為權威版本；
 *     transport-dev 的 transit.ts 可 import 使用，市民模擬一律用這份）
 *   - 每日通勤人次統計（寫入 state.transit.byMode 供 transit 統計；只加不清零）
 *   - 建立／移除市民、開局流民、全城食品儲備、住宅空位、平均幸福度
 *
 * 座標慣例：
 *   citizen.x / citizen.y 為「格中心座標」（格 (tx,ty) 中心 = (tx+0.5, ty+0.5)）。
 *   Cart.x / Cart.y 為「格索引浮點」（由 systems-dev 維持；渲染端優先以 cart.path 插值）。
 *
 * 天氣與時間：一律從 state.clock 讀；不 import sim/time.ts，避免整合期耦合。
 */

import {
  BUILDINGS,
  DAYS_PER_MONTH,
  ENGLISH_NAMES,
  GIVEN_NAMES,
  RESOURCES,
  RETAIL_PRICE_MULTIPLIER,
  SURNAMES,
  TRANSIT_SPEED,
  WEATHER_EFFECT,
} from '../core/config';
import type {
  Building,
  Citizen,
  CitizenNeeds,
  CitizenState,
  GameState,
  ResourceKey,
  ServiceKind,
  SimContext,
  TransitMode,
} from '../core/types';
import { removeCargo, stockOf } from './logistics-inventory';
import { worldRevisionOf } from './placement';

// ─────────────────────────── 常數 ───────────────────────────

/** 人口上限（效能考量：1600 人 + 900 行人同屏仍保 60fps） */
export const MAX_POPULATION = 1600;

/**
 * 市民步速（格／遊戲分鐘）：0.06 格／遊戲分鐘 ≈ 2.9 格／真實秒 @1 倍速。
 * 通勤時再乘 TRANSIT_SPEED[mode]（港鐵 4.2 倍等）。
 */
export const CITIZEN_SPEED = 0.06;

/** 作息（時）：06:00 起床、08:00 出門、09:00 上班、13:00 午飯、18:00 下班、22:00 睡眠 */
export const WAKE_HOUR = 6;
export const DEPART_HOUR = 8;
export const WORK_START_HOUR = 9;
export const LUNCH_START_HOUR = 13;
export const LUNCH_END_HOUR = 14;
export const WORK_END_HOUR = 18;
/** 星期六下午放假（香港常見長短週） */
export const SATURDAY_END_HOUR = 13;
export const SLEEP_HOUR = 22;
/** 每日需求結算時刻（時） */
export const DAWN_HOUR = 5;

/** 勞動年齡：16～64 歲；65 歲退休 */
export const WORKING_AGE = 16;
export const RETIRE_AGE = 65;
/** 學齡：6～17 歲 */
export const SCHOOL_AGE = 6;
export const SCHOOL_END_AGE = 18;

/**
 * 消耗率（對齊 systems-dev／Lead）：
 *   食品 0.5 單位／人／日、日用品 0.2 單位／人／日（街市／超市／便利店有貨時才扣）。
 *   兒童食量 ×0.6。
 */
export const FOOD_PER_CITIZEN_PER_DAY = 0.5;
export const GOODS_PER_CITIZEN_PER_DAY = 0.2;
export const CHILD_FOOD_FACTOR = 0.6;

/** 茶餐廳／酒樓一餐的消費（港幣；庫存由 finance 每日扣，市民只付錢） */
export const MEAL_COST = 120;
/** 私人錢財上限（避免長年累積成天文數字） */
export const MAX_PERSONAL_MONEY = 2_000_000;
/** 市民每日象徵性儲蓄／開支（月薪／生活費已換算為日） */
export const DAILY_LIVING_COST = 6_000 / DAYS_PER_MONTH;

/** 通勤方式中文名（UI／log 用） */
export const MODE_NAMES: Record<TransitMode | 'walk', string> = {
  walk: '步行',
  mtr: '港鐵',
  bus: '巴士',
  tram: '電車',
  ferry: '渡輪',
};

/** 步行接駁＋等車時間（遊戲分鐘；按模式） */
const TRANSIT_WAIT_MINUTES: Record<TransitMode, number> = {
  mtr: 6,
  bus: 9,
  tram: 7,
  ferry: 12,
};

// ─────────────────────────── 型別 ───────────────────────────

/** 市民活動（比 core 的 CitizenState 更細，只存在暫存，不入存檔） */
export type CitizenActivity =
  | 'home'
  | 'commute'
  | 'work'
  | 'lunch'
  | 'shop'
  | 'groceries'
  | 'eat'
  | 'leisure'
  | 'school'
  | 'wander'
  | 'idle';

/** 不屬於 core/types 的市民暫存資料（存檔不保存，讀檔後以預設值重建） */
export interface CitizenExtras {
  /** 目前活動結束的絕對遊戲分鐘 */
  busyUntil: number;
  /** 需要重新規劃下一個目的地 */
  pendingPlan: boolean;
  /** 目前／剛完成的活動種類 */
  activity: CitizenActivity;
  /** 今日已用餐（需求結算用） */
  ateToday: boolean;
  /** 連續無家可歸天數 */
  homelessDays: number;
  /** 連續低幸福天數 */
  lowHappinessDays: number;
  /** 連續飢餓天數 */
  starveDays: number;
  /** 上次規劃失敗時間（避免同幀重試） */
  retryAt: number;
  /** 本次通勤出發的遊戲分鐘（用於統計平均通勤時間），-1 = 未在通勤 */
  tripStartedAt: number;
  /** 本次通勤是否已記入載客統計（避免重複記） */
  rideRecorded: boolean;
  /** 今日已購物次數 */
  shoppedToday: number;
  /** 今日已休閒次數 */
  leisureToday: number;
  /** 今日已從市場買到的食品量（避免與每日結算重複扣庫存） */
  foodBoughtToday: number;
  /** 上次吃午飯的日期（totalDays；避免同一日重複去午飯） */
  lunchDoneDay: number;
}

/** 服務點（市集／餐廳／學校／醫院／警署／消防局／公園／海濱等） */
export interface ServicePoint {
  building: Building;
  kind: ServiceKind;
  /** 建築中心格座標（格中心座標系） */
  x: number;
  y: number;
  radius: number;
  happiness: number;
  capacity: number;
}

/** 公共交通站點（港鐵站／巴士總站／電車站／渡輪碼頭） */
export interface TransitStop {
  building: Building;
  mode: TransitMode;
  x: number;
  y: number;
  radius: number;
}

/** 每日通勤統計 */
export interface CommuteDayCounts {
  /** 統計所屬日期（totalDays） */
  day: number;
  byMode: Record<TransitMode, number>;
  walkTrips: number;
  trips: number;
  totalMinutes: number;
  /** 指數移動平均通勤時間（遊戲分鐘） */
  avgMinutes: number;
}

/** 行人 A* 的重用暫存（避免每次尋路都分配大陣列） */
interface WalkSearchScratch {
  n: number;
  g: Int32Array;
  prev: Int32Array;
  stamp: Int32Array;
  goalFlag: Uint8Array;
  heapNode: Int32Array;
  heapF: Float64Array;
  searchId: number;
}

/** 每日需求結算的分幀狀態（暫存，不入存檔） */
export interface NeedsBatchState {
  day: number;
  index: number;
  hungry: number;
  thirsty: number;
  cityHasGoodsRetail: boolean;
  cityHasLeisure: boolean;
  cityHasPower: boolean;
  cityHasWater: boolean;
  earlyGame: boolean;
  festivalBoost: number;
}

export interface CitizenCache {
  extras: Map<number, CitizenExtras>;
  initialized: boolean;
  /** 建築索引（每幀刷新） */
  byId: Map<number, Building>;
  /** 服務建築清單（建築變動或隔日重建） */
  services: ServicePoint[];
  /** 交通站點清單（與服務清單同步重建） */
  transitStops: TransitStop[];
  servicesBuiltAt: number;
  servicesBuildingCount: number;
  /** 可通行格簽章（道路／行人路變動偵測） */
  walkSignature: number;
  walkTilesAt: number;
  /** 上次重算行人路網簽章時嘅世界版本（鋪路／拆路／起樓／劃區會 bump；版本未變就唔使掃 92k tiles） */
  walkSignatureRevision: number;
  /** 行人路徑快取 */
  pairCache: Map<number, number[] | null>;
  linkCache: Map<string, number[] | null>;
  pathScratch: WalkSearchScratch | null;
  /** 行人路網連通分量（省去就業配對時逐對 A*；路網簽章改變時重建） */
  walkComponents: { signature: number; ids: Int32Array } | null;
  /** 各建築可達到的行人路網分量 id（建築 id → 分量 id 清單，路網改變時清空） */
  buildingComponents: Map<number, number[]>;
  /** buildingComponents 對應嘅行人路網簽章（防止路網改動後回傳 stale 分量） */
  buildingComponentsSignature: number;
  /** 可通行格清單（隨機漫步用，每 30 遊戲分鐘重算） */
  walkList: number[] | null;
  walkListAt: number;
  walkListSignature: number;
  /** 城中心／開局 spawn 附近陸地錨點 */
  centerAnchor: { x: number; y: number } | null;
  /** 上次執行住宅／就業重分配的遊戲分鐘 */
  lastAssignMinute: number;
  /** 公平輪轉游標（每幀規劃預算用） */
  planCursor: number;
  /** 建築數量變動偵測 */
  lastBuildingCount: number;
  /** 每日需求結算日期 */
  needsDay: number;
  /** 每日需求結算的分幀狀態（1600 人一次過掃描會造成 ~20ms 尖峰，分幀攤薄） */
  needsBatch: NeedsBatchState | null;
  /** 通知去重 */
  lastHungerToastDay: number;
  lastJobToastDay: number;
  lastImmigrationToastDay: number;
  lastShortageToastDay: number;
  lastPowerToastDay: number;
  lastWaterToastDay: number;
  populationMilestone: number;
  /** 每日通勤統計 */
  commute: CommuteDayCounts;
}

function createCommuteCounts(day: number): CommuteDayCounts {
  return {
    day,
    byMode: { mtr: 0, bus: 0, tram: 0, ferry: 0 },
    walkTrips: 0,
    trips: 0,
    totalMinutes: 0,
    avgMinutes: 0,
  };
}

const caches = new WeakMap<GameState, CitizenCache>();

function createCache(day: number): CitizenCache {
  return {
    extras: new Map(),
    initialized: false,
    byId: new Map(),
    services: [],
    transitStops: [],
    servicesBuiltAt: -99999,
    servicesBuildingCount: -1,
    walkSignature: -1,
    walkTilesAt: -99999,
    walkSignatureRevision: -1,
    pairCache: new Map(),
    linkCache: new Map(),
    pathScratch: null,
    walkComponents: null,
    buildingComponents: new Map(),
    buildingComponentsSignature: -1,
    walkList: null,
    walkListAt: -99999,
    walkListSignature: -1,
    centerAnchor: null,
    planCursor: 0,
    lastAssignMinute: -99999,
    lastBuildingCount: -1,
    needsDay: -1,
    needsBatch: null,
    lastHungerToastDay: -99999,
    lastJobToastDay: -99999,
    lastImmigrationToastDay: -99999,
    lastShortageToastDay: -99999,
    lastPowerToastDay: -99999,
    lastWaterToastDay: -99999,
    populationMilestone: 0,
    commute: createCommuteCounts(day),
  };
}

/** 取得（必要時建立）此局的市民暫存；換局／讀檔因 state 物件不同而自動重建 */
export function getCitizenCache(state: GameState): CitizenCache {
  let cache = caches.get(state);
  if (!cache) {
    cache = createCache(state.clock?.totalDays ?? 1);
    caches.set(state, cache);
  }
  return cache;
}

export function createExtras(now: number): CitizenExtras {
  return {
    busyUntil: now + 20 + Math.random() * 100,
    pendingPlan: true,
    activity: 'idle',
    ateToday: false,
    homelessDays: 0,
    lowHappinessDays: 0,
    starveDays: 0,
    retryAt: -99999,
    tripStartedAt: -1,
    rideRecorded: false,
    shoppedToday: 0,
    leisureToday: 0,
    foodBoughtToday: 0,
    lunchDoneDay: -1,
  };
}

export function getExtras(cache: CitizenCache, citizen: Citizen, now: number): CitizenExtras {
  let extras = cache.extras.get(citizen.id);
  if (!extras) {
    extras = createExtras(now);
    cache.extras.set(citizen.id, extras);
  }
  return extras;
}

// ─────────────────────────── 小工具 ───────────────────────────

export function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function randInt(min: number, maxInclusive: number): number {
  return min + Math.floor(Math.random() * (maxInclusive - min + 1));
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function clampMoney(value: number): number {
  return clamp(value, 0, MAX_PERSONAL_MONEY);
}

/** 建築中心（格中心座標系） */
export function buildingCenter(b: Building): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

export function buildingDef(key: string) {
  return BUILDINGS[key];
}

/** 建築庫存（透過 systems-dev 的物流庫存 API 讀取，避免容量／浮點問題） */
export function inventoryOf(b: Building, resource: ResourceKey): number {
  return stockOf(b, resource);
}

/** 加入建築庫存（回傳實際加入量；市民系統只作小幅加減） */
export function addInventory(b: Building, resource: ResourceKey, amount: number): number {
  if (!(amount > 0)) return 0;
  const have = stockOf(b, resource);
  b.inventory[resource] = Math.round((have + amount) * 10) / 10;
  return amount;
}

/** 從建築扣貨（扣不到回傳 false，不做部分扣除） */
export function takeInventory(b: Building, resource: ResourceKey, amount: number): boolean {
  if (amount <= 0) return true;
  if (stockOf(b, resource) + 1e-6 < amount) return false;
  return removeCargo(b, resource, amount) + 1e-6 >= amount;
}

/** 零售價（港幣）＝ 參考市價 × 零售倍率 */
export function retailPrice(resource: ResourceKey, amount = 1): number {
  const price = (RESOURCES[resource]?.price ?? 1) * (RETAIL_PRICE_MULTIPLIER[resource] ?? 1);
  return Math.max(1, Math.round(price * amount * 10) / 10);
}

/**
 * 市民向建築付費購買貨物：扣庫存、扣市民錢、記入該建築本月收入。
 * 回傳是否成功（買不起或沒貨則 false）。
 */
export function buyResource(citizen: Citizen, building: Building, resource: ResourceKey, amount: number): boolean {
  const cost = retailPrice(resource, amount);
  if (citizen.money + 1e-6 < cost) return false;
  if (!takeInventory(building, resource, amount)) return false;
  citizen.money = clampMoney(citizen.money - cost);
  building.incomeThisMonth += cost;
  return true;
}

// ─────────────────────────── 建築索引與服務查詢 ───────────────────────────

/** 每幀刷新建築索引（n 很小，Map 重建成本可忽略） */
export function refreshBuildingIndex(state: GameState, cache: CitizenCache): void {
  cache.byId.clear();
  for (const b of state.buildings) cache.byId.set(b.id, b);
}

export function cachedBuilding(cache: CitizenCache, id: number): Building | null {
  if (id < 0) return null;
  return cache.byId.get(id) ?? null;
}

/** 住宅容量（0 = 非住宅） */
export function housingCapacity(b: Building): number {
  const def = BUILDINGS[b.key];
  if (!def || def.housing <= 0) return 0;
  return def.housing;
}

export function isResidentialActive(b: Building): boolean {
  return housingCapacity(b) > 0 && b.active;
}

/** 重建服務建築清單與交通站點（建築數量變動或隔日時呼叫） */
export function refreshServices(state: GameState, cache: CitizenCache): void {
  const points: ServicePoint[] = [];
  const stops: TransitStop[] = [];
  for (const b of state.buildings) {
    const def = BUILDINGS[b.key];
    if (!def) continue;
    const service = def.service;
    if (service) {
      const center = buildingCenter(b);
      points.push({
        building: b,
        kind: service.kind,
        x: center.x,
        y: center.y,
        radius: service.radius ?? 5,
        happiness: service.happiness ?? 0,
        capacity: service.capacity ?? 0,
      });
    }
    const transit = def.transit;
    if (transit) {
      const center = buildingCenter(b);
      stops.push({ building: b, mode: transit.mode, x: center.x, y: center.y, radius: transit.radius });
    }
  }
  cache.services = points;
  cache.transitStops = stops;
  cache.servicesBuiltAt = state.clock.minutes;
  cache.servicesBuildingCount = state.buildings.length;
}

function ensureServiceCache(state: GameState, cache: CitizenCache): void {
  const now = state.clock.minutes;
  if (cache.servicesBuildingCount !== state.buildings.length || now - cache.servicesBuiltAt > 1440) {
    refreshServices(state, cache);
  }
}

/** 取得最新服務清單（建築數量改變或超過 1 日就重建） */
export function servicePoints(state: GameState, cache: CitizenCache): ServicePoint[] {
  ensureServiceCache(state, cache);
  return cache.services;
}

/** 取得最新交通站點清單 */
export function transitStops(state: GameState, cache: CitizenCache): TransitStop[] {
  ensureServiceCache(state, cache);
  return cache.transitStops;
}

/** 交通站點是否已經營運（active 且未拆除） */
export function stopOperational(cache: CitizenCache, stop: TransitStop): boolean {
  const b = cache.byId.get(stop.building.id);
  return !!b && b === stop.building && b.active;
}

export function insideService(sp: ServicePoint, x: number, y: number): boolean {
  const dx = sp.x - x;
  const dy = sp.y - y;
  return dx * dx + dy * dy <= sp.radius * sp.radius;
}

/** 落在 (x,y) 半徑內、且仍在營運的服務點（同類可有多個） */
export function servicePointsNear(
  state: GameState,
  cache: CitizenCache,
  x: number,
  y: number,
  kind?: ServiceKind,
): ServicePoint[] {
  const result: ServicePoint[] = [];
  for (const sp of servicePoints(state, cache)) {
    if (kind && sp.kind !== kind) continue;
    if (cache.byId.get(sp.building.id) !== sp.building) continue;
    if (!sp.building.active) continue;
    if (!insideService(sp, x, y)) continue;
    result.push(sp);
  }
  return result;
}

/** 最近的服務點（同類），沒有回傳 null */
export function nearestServicePoint(
  state: GameState,
  cache: CitizenCache,
  x: number,
  y: number,
  kind: ServiceKind,
): ServicePoint | null {
  let best: ServicePoint | null = null;
  let bestDist = Infinity;
  for (const sp of servicePointsNear(state, cache, x, y, kind)) {
    const d = (sp.x - x) ** 2 + (sp.y - y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = sp;
    }
  }
  return best;
}

// ─────────────────────────── 行人路網與尋路 ───────────────────────────

/** 可行人的格：道路或行人路（建築／水／山地不可） */
export function isPassableTile(state: GameState, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) return false;
  const tile = state.tiles[ty * state.width + tx];
  if (!tile) return false;
  return tile.road || !!tile.sidewalk;
}

/** 是否行人路格（行人優先走這裡） */
export function isSidewalkTile(state: GameState, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) return false;
  const tile = state.tiles[ty * state.width + tx];
  return !!tile?.sidewalk;
}

/** 可站立的陸地（行人路網未建成時，市民／流民站在陸地上） */
export function isLandTile(state: GameState, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) return false;
  const terrain = state.tiles[ty * state.width + tx]?.terrain;
  return terrain !== 'water' && terrain !== 'mountain';
}

/**
 * 行人路網簽章：優先靠 placement 的世界版本（鋪路／拆路／起樓／劃區都會 bump），
 * 世界版本未變就唔使掃 304×304＝92k tiles（單次掃描約 1.7ms，之前每 5 遊戲分鐘掃一次）。
 * 另外每 120 遊戲分鐘做一次 fallback 掃描，以防有模組直接改 tile.road 而冇 bump 版本
 *（例如載入存檔／未來災害系統）。
 */
const WALK_SIGNATURE_FALLBACK_MINUTES = 120;

export function walkNetworkSignature(state: GameState, cache: CitizenCache): number {
  const now = state.clock.minutes;
  const revision = worldRevisionOf();
  if (
    cache.walkSignatureRevision === revision &&
    cache.walkTilesAt > -9999 &&
    now - cache.walkTilesAt < WALK_SIGNATURE_FALLBACK_MINUTES
  ) {
    return cache.walkSignature;
  }
  let count = 0;
  let hash = 0;
  const tiles = state.tiles;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (t.road || t.sidewalk) {
      count++;
      hash = (hash * 31 + i) | 0;
    }
  }
  const signature = count * 104729 + (hash & 0x7fffffff);
  if (signature !== cache.walkSignature) {
    // 路網改變：清空行人路徑快取＋連通分量快取
    cache.pairCache.clear();
    cache.linkCache.clear();
    cache.walkComponents = null;
    cache.buildingComponents.clear();
    cache.buildingComponentsSignature = signature;
  }
  cache.walkSignature = signature;
  cache.walkSignatureRevision = revision;
  cache.walkTilesAt = now;
  return signature;
}

/** 可通行格清單（隨機漫步用，每 30 遊戲分鐘或路網改變時重算） */
export function walkableTiles(state: GameState, cache: CitizenCache): number[] {
  const now = state.clock.minutes;
  const signature = walkNetworkSignature(state, cache);
  // 簽章已覆蓋「路網有冇變」；唔需要再每 30 分鐘無謂重建跑 92k tiles
  if (cache.walkList && cache.walkListSignature === signature) {
    return cache.walkList;
  }
  const list: number[] = [];
  const tiles = state.tiles;
  for (let i = 0; i < tiles.length; i++) if (tiles[i].road || tiles[i].sidewalk) list.push(i);
  cache.walkList = list;
  cache.walkListSignature = signature;
  cache.walkListAt = now;
  return list;
}

function getScratch(cache: CitizenCache, n: number): WalkSearchScratch {
  let sc = cache.pathScratch;
  if (!sc || sc.n !== n) {
    sc = {
      n,
      g: new Int32Array(n),
      prev: new Int32Array(n),
      stamp: new Int32Array(n),
      goalFlag: new Uint8Array(n),
      heapNode: new Int32Array(n * 4 + 8),
      heapF: new Float64Array(n * 4 + 8),
      searchId: 0,
    };
    cache.pathScratch = sc;
  }
  return sc;
}

const WALK_COST = { sidewalk: 1, road: 2 } as const;
const INF = 0x3fffffff;

/**
 * 行人 A*（四方向）：只走 road／sidewalk；行人路成本 1、馬路成本 2（優先行人路）。
 * 多起點／多終點（建築外側可有多個臨路格）。
 * 回傳路徑（含起點與終點格）與實際抵達的目標格。
 */
function searchWalkNetwork(
  state: GameState,
  cache: CitizenCache,
  starts: number[],
  goals: number[],
): { path: number[]; goal: number } | null {
  const { width, height, tiles } = state;
  const n = tiles.length;
  if (!n) return null;
  const sc = getScratch(cache, n);
  const id = ++sc.searchId;
  const { g, prev, stamp, goalFlag, heapNode, heapF } = sc;

  const validGoals: number[] = [];
  for (const goal of goals) {
    if (goal < 0 || goal >= n) continue;
    const t = tiles[goal];
    if (!(t.road || t.sidewalk)) continue;
    if (goalFlag[goal]) continue;
    goalFlag[goal] = 1;
    validGoals.push(goal);
  }
  if (!validGoals.length) return null;

  let heapSize = 0;
  const push = (node: number, f: number): void => {
    let i = heapSize++;
    heapNode[i] = node;
    heapF[i] = f;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= heapF[i]) break;
      const tn = heapNode[p];
      heapNode[p] = heapNode[i];
      heapNode[i] = tn;
      const tf = heapF[p];
      heapF[p] = heapF[i];
      heapF[i] = tf;
      i = p;
    }
  };
  const pop = (): number => {
    const top = heapNode[0];
    heapSize--;
    if (heapSize > 0) {
      heapNode[0] = heapNode[heapSize];
      heapF[0] = heapF[heapSize];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heapSize && heapF[l] < heapF[m]) m = l;
        if (r < heapSize && heapF[r] < heapF[m]) m = r;
        if (m === i) break;
        const tn = heapNode[m];
        heapNode[m] = heapNode[i];
        heapNode[i] = tn;
        const tf = heapF[m];
        heapF[m] = heapF[i];
        heapF[i] = tf;
        i = m;
      }
    }
    return top;
  };

  const heuristic = (node: number): number => {
    const nx = node % width;
    const ny = (node / width) | 0;
    let best = INF;
    for (const goal of validGoals) {
      const gx = goal % width;
      const gy = (goal / width) | 0;
      const d = Math.abs(nx - gx) + Math.abs(ny - gy);
      if (d < best) best = d;
    }
    return best * WALK_COST.sidewalk;
  };

  for (const start of starts) {
    if (start < 0 || start >= n) continue;
    if (goalFlag[start]) {
      for (const goal of validGoals) goalFlag[goal] = 0;
      return { path: [start], goal: start };
    }
    if (stamp[start] !== id) {
      stamp[start] = id;
      g[start] = 0;
      prev[start] = -1;
      push(start, heuristic(start));
    }
  }
  if (heapSize === 0) {
    for (const goal of validGoals) goalFlag[goal] = 0;
    return null;
  }

  let found = -1;
  let guard = 0;
  while (heapSize > 0 && guard++ < n * 6) {
    const cur = pop();
    if (g[cur] < 0) continue; // 已被更優路徑取代（惰性刪除）
    if (goalFlag[cur]) {
      found = cur;
      break;
    }
    const cx = cur % width;
    const cy = (cur / width) | 0;
    const base = g[cur];
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
      const tile = tiles[nb];
      if (!tile || !(tile.road || tile.sidewalk)) continue;
      const cost = base + (tile.sidewalk ? WALK_COST.sidewalk : WALK_COST.road);
      if (stamp[nb] !== id || cost < g[nb]) {
        stamp[nb] = id;
        g[nb] = cost;
        prev[nb] = cur;
        push(nb, cost + heuristic(nb));
      }
    }
  }
  for (const goal of validGoals) goalFlag[goal] = 0;
  if (found < 0) return null;

  const path: number[] = [];
  let cur = found;
  while (cur !== -1 && path.length <= n) {
    path.push(cur);
    cur = prev[cur];
  }
  path.reverse();
  return { path, goal: found };
}

/** 單一起點→單一終點的行人路徑（tile index；含頭尾） */
export function findWalkPath(state: GameState, cache: CitizenCache, start: number, goal: number): number[] | null {
  const n = state.tiles.length;
  if (start < 0 || start >= n || goal < 0 || goal >= n) return null;
  if (start === goal) return [start];
  walkNetworkSignature(state, cache);
  const key = start * n + goal;
  if (cache.pairCache.has(key)) return cache.pairCache.get(key) ?? null;
  const result = searchWalkNetwork(state, cache, [start], [goal]);
  const path = result?.path ?? null;
  if (cache.pairCache.size >= 4096) cache.pairCache.clear();
  cache.pairCache.set(key, path);
  return path;
}

/** 多目標行人路徑（找最近目標） */
export function findWalkPathToAny(
  state: GameState,
  cache: CitizenCache,
  start: number,
  goals: number[],
): { path: number[]; goal: number } | null {
  const n = state.tiles.length;
  if (start < 0 || start >= n || !goals.length) return null;
  walkNetworkSignature(state, cache);
  return searchWalkNetwork(state, cache, [start], goals);
}

/** 建築外側（正交）的可行人格，行人路優先、其次道路 */
export function walkAccessTiles(state: GameState, building: Building): number[] {
  const result: number[] = [];
  const pushIf = (tx: number, ty: number): void => {
    if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) return;
    const idx = ty * state.width + tx;
    const tile = state.tiles[idx];
    if (tile.road || tile.sidewalk) result.push(idx);
  };
  for (let dx = 0; dx < building.w; dx++) {
    pushIf(building.x + dx, building.y - 1);
    pushIf(building.x + dx, building.y + building.h);
  }
  for (let dy = 0; dy < building.h; dy++) {
    pushIf(building.x - 1, building.y + dy);
    pushIf(building.x + building.w, building.y + dy);
  }
  // 行人路優先（成本低），同類保持穩定順序
  result.sort((a, b) => {
    const sa = state.tiles[a].sidewalk ? 0 : 1;
    const sb = state.tiles[b].sidewalk ? 0 : 1;
    return sa - sb;
  });
  return result;
}

/** 行人路網連通分量（4 方向 flood-fill；路網簽章不變時重用） */
function walkComponentIds(state: GameState, cache: CitizenCache): { signature: number; ids: Int32Array } {
  const signature = walkNetworkSignature(state, cache);
  if (cache.walkComponents && cache.walkComponents.signature === signature) return cache.walkComponents;
  const n = state.tiles.length;
  const ids = new Int32Array(n).fill(-1);
  const tiles = state.tiles;
  const stack = new Int32Array(n);
  let component = 0;
  for (let start = 0; start < n; start++) {
    const tile = tiles[start];
    if (ids[start] !== -1 || !(tile.road || tile.sidewalk)) continue;
    let top = 0;
    stack[top++] = start;
    ids[start] = component;
    while (top > 0) {
      const cur = stack[--top];
      const cx = cur % state.width;
      const cy = (cur / state.width) | 0;
      for (let dir = 0; dir < 4; dir++) {
        let nb: number;
        if (dir === 0) {
          if (cy === 0) continue;
          nb = cur - state.width;
        } else if (dir === 1) {
          if (cy === state.height - 1) continue;
          nb = cur + state.width;
        } else if (dir === 2) {
          if (cx === 0) continue;
          nb = cur - 1;
        } else {
          if (cx === state.width - 1) continue;
          nb = cur + 1;
        }
        if (ids[nb] !== -1) continue;
        const t = tiles[nb];
        if (!(t.road || t.sidewalk)) continue;
        ids[nb] = component;
        stack[top++] = nb;
      }
    }
    component++;
  }
  cache.walkComponents = { signature, ids };
  cache.buildingComponents.clear();
  return cache.walkComponents;
}

/** 建築可達的行人路網分量 id（多個臨路格可能屬不同網絡；免路建築用最近可通行格） */
export function buildingWalkComponents(state: GameState, cache: CitizenCache, building: Building): number[] {
  // 先確認路網簽章（revision 快取下極便宜）；過期就清走 stale 分量
  const signature = walkNetworkSignature(state, cache);
  if (cache.buildingComponentsSignature !== signature) {
    cache.buildingComponents.clear();
    cache.buildingComponentsSignature = signature;
  }
  const cached = cache.buildingComponents.get(building.id);
  if (cached) return cached;
  const { ids } = walkComponentIds(state, cache);
  const result: number[] = [];
  const access = walkAccessTiles(state, building);
  for (const tile of access) {
    const comp = ids[tile];
    if (comp >= 0 && !result.includes(comp)) result.push(comp);
  }
  if (!result.length) {
    const goal = buildingWalkGoal(state, cache, building);
    if (goal >= 0) {
      const comp = ids[goal];
      if (comp >= 0) result.push(comp);
    }
  }
  cache.buildingComponents.set(building.id, result);
  return result;
}

/** 兩棟建築是否喺同一行人路網分量（等價於存在行人路徑，但唔需要 A*；就業配對快好多） */
export function sharesWalkComponent(
  state: GameState,
  cache: CitizenCache,
  from: Building,
  to: Building,
): boolean {
  const fromComponents = buildingWalkComponents(state, cache, from);
  if (!fromComponents.length) return false;
  const toComponents = buildingWalkComponents(state, cache, to);
  for (const comp of toComponents) if (fromComponents.includes(comp)) return true;
  return false;
}

/** 離 (tx,ty) 最近的可行人格；沒有回傳 -1 */
/** 離 (tx,ty) 最近的可行人格；沒有回傳 -1 */
export function nearestWalkTile(
  state: GameState,
  cache: CitizenCache,
  tx: number,
  ty: number,
  maxRadius = 16,
): number {
  const cx = clamp(Math.floor(tx), 0, state.width - 1);
  const cy = clamp(Math.floor(ty), 0, state.height - 1);
  if (isPassableTile(state, cx, cy)) return cy * state.width + cx;
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 1; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        const edgeY = Math.abs(dy) === r;
        const step = edgeY ? 1 : r * 2;
        for (let dx = -r; dx <= r; dx += step) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= state.width || y >= state.height) continue;
          const idx = y * state.width + x;
          const tile = state.tiles[idx];
          const passable = tile.road || tile.sidewalk;
          if (!passable) continue;
          if (pass === 0 && !tile.sidewalk) continue;
          return idx;
        }
      }
    }
  }
  // 全城最近可通行格（道路網絡可能不在附近）
  const list = walkableTiles(state, cache);
  if (!list.length) return -1;
  let best = -1;
  let bestDist = Infinity;
  for (const idx of list) {
    const x = idx % state.width;
    const y = (idx / state.width) | 0;
    const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    if (d < bestDist) {
      bestDist = d;
      best = idx;
    }
  }
  return best;
}

/** 建築的移動目標格（行人路優先，沒有臨路格就用附近最近可通行格） */
export function buildingWalkGoal(state: GameState, cache: CitizenCache, building: Building): number {
  const access = walkAccessTiles(state, building);
  if (access.length) return access[0];
  // 免路建築（農田／公園等）離路較遠：行人接駁範圍放寬到 20 格，
  // 否則偏遠農田永遠請唔到工人 → 全城缺糧。
  const center = buildingCenter(building);
  return nearestWalkTile(state, cache, center.x, center.y, 20);
}

/** 市民出發的可通行格：目前所在建築的臨路格，否則座標附近最近可通行格 */
export function citizenStartTile(state: GameState, cache: CitizenCache, citizen: Citizen): number {
  const occupant = cachedBuilding(cache, citizen.targetId);
  if (occupant) {
    const goal = buildingWalkGoal(state, cache, occupant);
    if (goal >= 0) return goal;
  }
  const tile = nearestWalkTile(state, cache, citizen.x, citizen.y, 16);
  if (tile >= 0) return tile;
  const anchor = spawnAnchor(state, cache);
  return nearestWalkTile(state, cache, anchor.x, anchor.y, 24);
}

/**
 * 兩棟建築之間的行人路徑（多起點／多終點，行人路優先）。
 * 結果有快取，路網改變時自動失效。
 */
export function findWalkPathBetweenBuildings(
  state: GameState,
  cache: CitizenCache,
  from: Building,
  to: Building,
): { path: number[]; goal: number } | null {
  walkNetworkSignature(state, cache);
  const key = `${from.id}:${to.id}`;
  if (cache.linkCache.has(key)) {
    const cached = cache.linkCache.get(key);
    return cached ? { path: cached, goal: cached[cached.length - 1] } : null;
  }
  const starts = walkAccessTiles(state, from);
  const goals = walkAccessTiles(state, to);
  if (!starts.length || !goals.length) {
    // 其中一邊沒有臨路格：用附近最近可通行格補救
    const fc = buildingCenter(from);
    const tc = buildingCenter(to);
    const s = starts.length ? starts[0] : nearestWalkTile(state, cache, fc.x, fc.y, 20);
    const g = goals.length ? goals[0] : nearestWalkTile(state, cache, tc.x, tc.y, 20);
    if (s < 0 || g < 0) {
      cache.linkCache.set(key, null);
      return null;
    }
    const res = searchWalkNetwork(state, cache, [s], [g]);
    const path = res?.path ?? null;
    if (cache.linkCache.size >= 2048) cache.linkCache.clear();
    cache.linkCache.set(key, path);
    return path && res ? { path, goal: res.goal } : null;
  }
  const res = searchWalkNetwork(state, cache, starts, goals);
  const path = res?.path ?? null;
  if (cache.linkCache.size >= 2048) cache.linkCache.clear();
  cache.linkCache.set(key, path);
  return path && res ? { path, goal: res.goal } : null;
}

/**
 * 判斷住宅→工作地是否可通勤：有行人路徑，或有大眾運輸可達（pickCommuteMode 非步行）。
 * 工作建築必須 active（物流／連通路網會在缺路時設 false）。
 */
export function canCommute(state: GameState, cache: CitizenCache, home: Building | null, work: Building): boolean {
  if (!work.active) return false;
  if (home) {
    // 同一行人路網分量即可通勤（唔使逐對行 A*；1600 人時就業配對快好多）
    if (sharesWalkComponent(state, cache, home, work)) return true;
  } else {
    const center = buildingCenter(work);
    const goal = buildingWalkGoal(state, cache, work);
    const start = nearestWalkTile(state, cache, center.x, center.y, 20);
    if (goal >= 0 && start >= 0 && findWalkPath(state, cache, start, goal)) return true;
  }
  return pickCommuteMode(state, home, work) !== 'walk';
}

// ─────────────────────────── 開局錨點 ───────────────────────────

/** 開局 spawn 附近的可站立陸地（格中心座標系）；流民與無路網時使用 */
export function spawnAnchor(state: GameState, cache: CitizenCache): { x: number; y: number } {
  if (cache.centerAnchor) return cache.centerAnchor;
  const sx = clamp(Math.floor(state.spawn?.x ?? state.width / 2), 0, state.width - 1);
  const sy = clamp(Math.floor(state.spawn?.y ?? state.height / 2), 0, state.height - 1);
  for (let r = 0; r <= 24; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = sx + dx;
        const ty = sy + dy;
        if (isLandTile(state, tx, ty)) {
          cache.centerAnchor = { x: tx + 0.5, y: ty + 0.5 };
          return cache.centerAnchor;
        }
      }
    }
  }
  cache.centerAnchor = { x: sx + 0.5, y: sy + 0.5 };
  return cache.centerAnchor;
}

/** 舊名保留：城中心錨點 */
export const cityCenterAnchor = spawnAnchor;

// ─────────────────────────── 公共交通與通勤模式 ───────────────────────────

/** (x,y) 附近、指定模式且已營運的最近交通站點 */
export function nearestTransitStop(
  state: GameState,
  cache: CitizenCache,
  x: number,
  y: number,
  mode?: TransitMode,
): TransitStop | null {
  let best: TransitStop | null = null;
  let bestDist = Infinity;
  for (const stop of transitStops(state, cache)) {
    if (mode && stop.mode !== mode) continue;
    if (!stopOperational(cache, stop)) continue;
    const d = (stop.x - x) ** 2 + (stop.y - y) ** 2;
    if (d > stop.radius * stop.radius) continue;
    if (d < bestDist) {
      bestDist = d;
      best = stop;
    }
  }
  return best;
}

/**
 * 選擇通勤方式（本函式為市民模擬的權威版本；transit.ts 可 import）。
 * 條件：住所與工作地點兩端都有站點在服務半徑內；以步行接駁＋候車＋乘車時間
 * 與全程步行比較，最快且明顯快過步行才選公共交通。颱風時渡輪停航。
 */
export function pickCommuteMode(
  state: GameState,
  home: Building | null,
  work: Building | null,
): TransitMode | 'walk' {
  if (!work) return 'walk';
  const cache = getCitizenCache(state);
  const homeCenter = home ? buildingCenter(home) : spawnAnchor(state, cache);
  const workCenter = buildingCenter(work);
  const dist = Math.hypot(workCenter.x - homeCenter.x, workCenter.y - homeCenter.y);
  const walkMinutes = dist / CITIZEN_SPEED + 2;
  // 短程（少於 6 格）一定步行，避免 5 格路程都搭港鐵
  if (dist < 6) return 'walk';

  const weatherMove = WEATHER_EFFECT[state.clock.weather]?.move ?? 1;
  const transitWeather = WEATHER_EFFECT[state.clock.weather]?.transit ?? 1;
  const suspended = state.transit.suspended || state.clock.weather === 'storm';

  let bestMode: TransitMode | 'walk' = 'walk';
  let bestMinutes = walkMinutes / Math.max(0.35, weatherMove);

  const modes: TransitMode[] = ['mtr', 'bus', 'tram', 'ferry'];
  for (const mode of modes) {
    if (mode === 'ferry' && suspended) continue;
    const homeStop = nearestTransitStop(state, cache, homeCenter.x, homeCenter.y, mode);
    const workStop = nearestTransitStop(state, cache, workCenter.x, workCenter.y, mode);
    if (!homeStop || !workStop) continue;
    if (homeStop.building.id === workStop.building.id) continue; // 同一站不能「搭一個站」來回
    const accessWalk =
      Math.hypot(homeStop.x - homeCenter.x, homeStop.y - homeCenter.y) / CITIZEN_SPEED;
    const egressWalk =
      Math.hypot(workCenter.x - workStop.x, workCenter.y - workStop.y) / CITIZEN_SPEED;
    const rideDist = Math.hypot(workStop.x - homeStop.x, workStop.y - homeStop.y);
    const ride = (rideDist + 2) / (CITIZEN_SPEED * (TRANSIT_SPEED[mode] ?? 1));
    // 天氣對路面交通（巴士／電車／渡輪）有影響，港鐵影響較小
    const weatherPenalty = mode === 'mtr' ? 1 : 1 / Math.max(0.3, transitWeather);
    const wait = TRANSIT_WAIT_MINUTES[mode] * (mode === 'mtr' ? 1 : weatherPenalty);
    const total = accessWalk + egressWalk + ride * weatherPenalty + wait;
    if (total < bestMinutes * 0.94) {
      bestMinutes = total;
      bestMode = mode;
    }
  }
  return bestMode;
}

/** 記錄用：跨日自動歸零（只會在真正有通勤活動時呼叫） */
function commuteCountsForRecord(state: GameState, cache: CitizenCache): CommuteDayCounts {
  const day = state.clock.totalDays;
  if (cache.commute.day !== day) {
    cache.commute = createCommuteCounts(day);
  }
  return cache.commute;
}

/** 讀取用：唔會清零（跨日後未有新行程時仍可讀到前一日數字） */
function peekCommuteCounts(cache: CitizenCache): CommuteDayCounts {
  return cache.commute;
}

/**
 * 市民「上車／上船」時呼叫：累計當日各模式人次並寫入 state.transit.byMode。
 * 依 transport-dev 約定：只加不清零，tickTransit 以差額結算。
 */
export function recordCommuteRide(state: GameState, mode: TransitMode | 'walk'): void {
  if (mode === 'walk') return;
  const cache = getCitizenCache(state);
  const counts = commuteCountsForRecord(state, cache);
  counts.byMode[mode]++;
  counts.trips++;
  const byMode = state.transit.byMode;
  byMode[mode] = (byMode[mode] ?? 0) + 1;
}

/** 市民抵達目的地時呼叫：記錄實際通勤時間（指數移動平均） */
export function recordCommuteArrival(state: GameState, mode: TransitMode | 'walk', minutes: number): void {
  if (!(minutes > 0) || minutes > 24 * 60) return;
  const cache = getCitizenCache(state);
  const counts = commuteCountsForRecord(state, cache);
  if (mode === 'walk') counts.walkTrips++;
  counts.totalMinutes += minutes;
  counts.avgMinutes = counts.avgMinutes > 0 ? counts.avgMinutes * 0.9 + minutes * 0.1 : minutes;
}

export interface CommuteStats {
  /** 當日各公共交通模式人次（不含步行） */
  byMode: Record<TransitMode, number>;
  /** 當日公共交通總人次 */
  rides: number;
  walkTrips: number;
  /** 平均單程通勤時間（遊戲分鐘，指數移動平均） */
  avgCommuteMinutes: number;
}

/** 當日通勤統計（供 transit／stats 讀取；不會清零 state.transit.byMode） */
export function getCommuteStats(state: GameState): CommuteStats {
  const cache = getCitizenCache(state);
  const counts = peekCommuteCounts(cache);
  return {
    byMode: { ...counts.byMode },
    rides: counts.trips,
    walkTrips: counts.walkTrips,
    avgCommuteMinutes: counts.avgMinutes,
  };
}

/** 當日各模式通勤人次（供 transport-dev 的 tickTransit 讀取） */
export function getDailyCommuteCounts(state: GameState): Record<TransitMode, number> {
  const cache = getCitizenCache(state);
  return { ...peekCommuteCounts(cache).byMode };
}

// ─────────────────────────── 薪金 ───────────────────────────

/** 各行業月薪（港幣；未列出的按分類預設） */
const SALARY_BY_BUILDING: Record<string, number> = {
  officeTower: 34_000,
  mtrStation: 24_000,
  busTerminus: 21_000,
  tramStop: 18_000,
  ferryPier: 19_000,
  containerPort: 21_000,
  warehouse: 16_000,
  importFirm: 17_000,
  shoppingMall: 17_000,
  restaurant: 16_000,
  chaChaanTeng: 14_000,
  supermarket: 15_000,
  wetMarket: 14_000,
  convenienceStore: 13_000,
  industrialBuilding: 17_000,
  foodFactory: 16_000,
  farm: 12_000,
  quarry: 18_000,
  powerPlant: 26_000,
  waterworks: 24_000,
  school: 22_000,
  hospital: 25_000,
  policeStation: 23_000,
  fireStation: 22_000,
  park: 13_000,
  promenade: 12_000,
};

/** 依工作建築決定月薪（港幣）；失業回傳 0 */
export function salaryForWork(work: Building | null): number {
  if (!work) return 0;
  const fixed = SALARY_BY_BUILDING[work.key];
  if (fixed) return fixed;
  const category = BUILDINGS[work.key]?.category;
  switch (category) {
    case 'commercial':
      return 16_000;
    case 'industrial':
      return 16_000;
    case 'logistics':
      return 18_000;
    case 'civic':
      return 20_000;
    case 'transport':
      return 21_000;
    case 'decoration':
      return 13_000;
    default:
      return 18_000;
  }
}

// ─────────────────────────── 香港姓名 ───────────────────────────

/** 女性常用字（用於從 config 姓名表分辨性別） */
const FEMALE_CHARS = '美玲欣嘉詠淑雅雯彤琳恩詩怡儀珊晴桐嵐雪花月玉蘭梅春竹小和雲星樂婷琪莉娜妮珊嫻慧敏麗芳娟珍';
const MALE_CHARS = '志俊浩偉國強豪恆輝賢文樂然軒熙謙宇業宏達德仁義禮智信成大山河海天光寶貴榮華興平旺健峰銘鈞朗';

/** 英文名性別（config ENGLISH_NAMES 混合，這裡按常見性別分類） */
const FEMALE_ENGLISH_SET = new Set([
  'Fiona',
  'Karen',
  'Michelle',
  'Cherry',
  'Winnie',
  'Mandy',
  'Gigi',
  'Suki',
  'Maggie',
  'Yennis',
]);

function classifyGivenName(name: string): 'male' | 'female' | 'both' {
  let female = false;
  let male = false;
  for (const ch of name) {
    if (FEMALE_CHARS.includes(ch)) female = true;
    if (MALE_CHARS.includes(ch)) male = true;
  }
  if (female && !male) return 'female';
  if (male && !female) return 'male';
  return 'both';
}

const FEMALE_GIVEN = GIVEN_NAMES.filter((n) => classifyGivenName(n) === 'female');
const MALE_GIVEN = GIVEN_NAMES.filter((n) => classifyGivenName(n) === 'male');

function englishPool(gender: 'male' | 'female'): string[] {
  return ENGLISH_NAMES.filter((n) => (gender === 'female') === FEMALE_ENGLISH_SET.has(n));
}

/**
 * 產生香港市民姓名：
 *   - 75% 中文姓名：香港常見姓（陳黃李梁…）＋ 1~2 字名（志明、美玲…）
 *   - 25% 中英夾雜：英文名＋中文姓（Karen 黃、Kelvin 陳）
 */
export function generateCitizenName(gender: 'male' | 'female'): string {
  const surname = SURNAMES[randInt(0, SURNAMES.length - 1)] ?? '陳';
  if (Math.random() < 0.25) {
    const pool = englishPool(gender);
    const english = (pool.length ? pool : ENGLISH_NAMES)[randInt(0, (pool.length ? pool : ENGLISH_NAMES).length - 1)];
    return `${english} ${surname}`;
  }
  const pool = gender === 'female' ? FEMALE_GIVEN : MALE_GIVEN;
  const fallback = pool.length ? pool : GIVEN_NAMES;
  const pieces = Math.random() < 0.3 ? 2 : 1;
  let given = '';
  for (let i = 0; i < pieces; i++) given += fallback[randInt(0, fallback.length - 1)] ?? '志明';
  return surname + given;
}

// ─────────────────────────── 市民建立／移除 ───────────────────────────

export interface NewCitizenOptions {
  age?: number;
  gender?: 'male' | 'female';
  homeId?: number;
  workId?: number;
  x?: number;
  y?: number;
  happiness?: number;
  money?: number;
  salary?: number;
  food?: number;
  goods?: number;
  leisure?: number;
  state?: CitizenState;
  commuteMode?: TransitMode | 'walk';
}

export function defaultNeeds(partial: { food?: number; goods?: number; leisure?: number } = {}): CitizenNeeds {
  return {
    food: partial.food ?? randRange(52, 78),
    goods: partial.goods ?? randRange(38, 66),
    leisure: partial.leisure ?? randRange(32, 58),
  };
}

/** 建立市民並掛入住宅／工作建築名單；回傳新市民 */
export function createCitizen(state: GameState, cache: CitizenCache, opts: NewCitizenOptions = {}): Citizen {
  const now = state.clock.minutes;
  const gender = opts.gender ?? (Math.random() < 0.5 ? 'male' : 'female');
  const homeId = opts.homeId ?? -1;
  const workId = opts.workId ?? -1;
  const age = opts.age ?? randInt(16, 46);
  const anchor = spawnAnchor(state, cache);
  const home = cachedBuilding(cache, homeId);
  const work = cachedBuilding(cache, workId);

  let x = opts.x ?? anchor.x + randRange(-1.2, 1.2);
  let y = opts.y ?? anchor.y + randRange(-1.2, 1.2);
  if (home && opts.x == null && opts.y == null) {
    const center = buildingCenter(home);
    x = center.x + randRange(-0.3, 0.3);
    y = center.y + randRange(-0.3, 0.3);
  }

  const citizen: Citizen = {
    id: state.nextCitizenId++,
    name: generateCitizenName(gender),
    age,
    gender,
    homeId,
    workId,
    happiness: clamp(opts.happiness ?? randRange(55, 72), 0, 100),
    money: clampMoney(opts.money ?? randRange(2_000, 9_000)),
    salary: opts.salary ?? salaryForWork(work),
    state: opts.state ?? (homeId >= 0 ? 'home' : 'idle'),
    x,
    y,
    path: [],
    pathProgress: 0,
    targetId: homeId >= 0 ? homeId : -1,
    commuteMode: opts.commuteMode ?? pickCommuteMode(state, home, work),
    look: Math.random(),
    needs: defaultNeeds({ food: opts.food, goods: opts.goods, leisure: opts.leisure }),
  };

  if (home && !home.residents.includes(citizen.id)) home.residents.push(citizen.id);
  if (work && !work.workers.includes(citizen.id)) work.workers.push(citizen.id);

  const extras = createExtras(now);
  extras.activity =
    citizen.state === 'working' ? 'work' : citizen.state === 'shopping' ? 'shop' : 'idle';
  cache.extras.set(citizen.id, extras);
  state.citizens.push(citizen);
  return citizen;
}

/** 移除市民（含建築名單、暫存資料清理） */
export function removeCitizen(state: GameState, cache: CitizenCache, id: number): void {
  const index = state.citizens.findIndex((c) => c.id === id);
  if (index < 0) return;
  state.citizens.splice(index, 1);
  for (const building of state.buildings) {
    if (building.residents.length) {
      const ri = building.residents.indexOf(id);
      if (ri >= 0) building.residents.splice(ri, 1);
    }
    if (building.workers.length) {
      const wi = building.workers.indexOf(id);
      if (wi >= 0) building.workers.splice(wi, 1);
    }
  }
  cache.extras.delete(id);
}

/** 啟動時建立開局流民（新局或讀到沒有市民的存檔時） */
export function ensureInitialPopulation(state: GameState, cache: CitizenCache, ctx: SimContext): void {
  if (cache.initialized) return;
  cache.initialized = true;
  if (state.citizens.length > 0) return;

  // 香港開局：5 名成年人（16~40 歲）在 spawn（中環／尖沙咀一帶）附近找落腳處
  const count = 5;
  const anchor = spawnAnchor(state, cache);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.8;
    const dist = randRange(1.5, 4.5);
    const x = clamp(anchor.x + Math.cos(angle) * dist, 1, state.width - 1);
    const y = clamp(anchor.y + Math.sin(angle) * dist, 1, state.height - 1);
    createCitizen(state, cache, {
      age: randInt(16, 40),
      x,
      y,
      happiness: randRange(44, 62),
      money: randRange(3_000, 8_000),
      food: randRange(45, 68),
      goods: randRange(30, 52),
      leisure: randRange(20, 42),
      state: 'idle',
    });
  }
  ctx.log('幾名市民在街頭徘徊，正尋找落腳的地方。先鋪路、再興建唐樓安置他們。', 'info');
}

// ─────────────────────────── 全城食品儲備／零售交易 ───────────────────────────

/** 全城建築的食品庫存總和（保留舊名 cityGrainReserve；grain 概念改為 food） */
export function cityGrainReserve(state: GameState): number {
  let total = 0;
  for (const building of state.buildings) total += stockOf(building, 'food');
  return total;
}

/** 新名：全城食品儲備 */
export const cityFoodReserve = cityGrainReserve;

/**
 * 從全城食品儲備取用（給「住宅不在市場半徑內，但有全城存糧」的保底吃飯用）。
 * 優先順序：倉儲 > 生產（輸出食品者）> 市場 > 生產建築的輸入食品；同優先序先扣存貨最多者。
 */
export function consumeCityGrain(state: GameState, amount: number): boolean {
  if (amount <= 0) return true;
  let best: Building | null = null;
  let bestPriority = -1;
  let bestStock = 0;
  for (const building of state.buildings) {
    const stock = stockOf(building, 'food');
    if (stock <= 1e-6) continue;
    const def = BUILDINGS[building.key];
    const isProducerInput = def?.production?.input?.resource === 'food';
    const priority = isProducerInput
      ? 0
      : def?.storage
        ? 3
        : def?.production
          ? 2
          : def?.service?.kind === 'market'
            ? 1
            : 0;
    if (priority > bestPriority || (priority === bestPriority && stock > bestStock)) {
      best = building;
      bestPriority = priority;
      bestStock = stock;
    }
  }
  if (!best) return false;
  return removeCargo(best, 'food', amount) + 1e-6 >= amount;
}

/** 新名：從全城食品儲備取用 */
export const consumeCityFood = consumeCityGrain;

/** 市集／超市／便利店是否有民生消費品（食品或日用品） */
export function marketHasGoods(building: Building): boolean {
  return stockOf(building, 'food') >= 0.1 || stockOf(building, 'goods') >= 0.1;
}

/**
 * 市民到零售店（街市／超市／便利店／商場）購物：
 * 買日用品（needs.goods 低時）與少量食品（needs.food 低時），
 * 扣店舖庫存、扣市民錢、記入店舖本月收入（零售價 = 參考價 × 零售倍率）。
 * 回傳實際購買的種類數（0 = 買不到）。
 */
export function marketPurchase(citizen: Citizen, market: Building): number {
  let count = 0;
  const money = citizen.money;

  // 日用品：需求越低買越多（0.1 單位／次，約 $24）
  const goodsStock = stockOf(market, 'goods');
  if (goodsStock >= 0.1 && citizen.needs.goods < 78 && money >= retailPrice('goods', 0.1)) {
    if (buyResource(citizen, market, 'goods', 0.1)) {
      citizen.needs.goods = clamp(citizen.needs.goods + 9, 0, 100);
      count++;
    }
  }

  // 食品：以「補充」為主，每日結算已扣 0.5 單位，這裡只補少量（0.1 單位，約 $6）
  const foodStock = stockOf(market, 'food');
  if (foodStock >= 0.1 && citizen.needs.food < 62 && citizen.money >= retailPrice('food', 0.1)) {
    if (buyResource(citizen, market, 'food', 0.1)) {
      citizen.needs.food = clamp(citizen.needs.food + 8, 0, 100);
      count++;
    }
  }
  return count;
}

/** 住宅空位總數 */
export function housingVacancies(state: GameState): { total: number; houses: number } {
  let total = 0;
  let houses = 0;
  for (const b of state.buildings) {
    const cap = housingCapacity(b);
    if (cap <= 0 || !b.active) continue;
    houses++;
    total += Math.max(0, cap - b.residents.length);
  }
  return { total, houses };
}

/** 平均幸福度（無市民時回傳 60） */
export function averageHappiness(state: GameState): number {
  if (!state.citizens.length) return 60;
  let sum = 0;
  for (const c of state.citizens) sum += c.happiness;
  return sum / state.citizens.length;
}

/** 是否勞動年齡（可受僱） */
export function isWorkingAge(citizen: Citizen): boolean {
  return citizen.age >= WORKING_AGE && citizen.age < RETIRE_AGE;
}

/** 是否學齡兒童 */
export function isSchoolAge(citizen: Citizen): boolean {
  return citizen.age >= SCHOOL_AGE && citizen.age < SCHOOL_END_AGE;
}

/** 是否週末（香港：星期日 weekday=0 全休；星期六 weekday=6 下午放假） */
export function isSunday(state: GameState): boolean {
  return state.clock.weekday === 0;
}

export function isSaturday(state: GameState): boolean {
  return state.clock.weekday === 6;
}

/** 是否颱風（八號風球） */
export function isTyphoon(state: GameState): boolean {
  return state.clock.weather === 'storm';
}

/** 目前是否下雨／落雪／打風（行人撐傘．減少外出） */
export function isWetWeather(state: GameState): boolean {
  const weather = state.clock.weather;
  return weather === 'rain' || weather === 'snow' || weather === 'storm';
}
