/**
 * 物流貨運系統（《維港之城》）。
 *
 * 物流鏈（香港版 4 種資源）
 *   ① 生產者 → 貨倉
 *      農田／食品廠／工廈／石礦場／貨櫃碼頭／進口商行把本地存貨用貨車送往最近貨倉。
 *   ② 貨倉 → 零售補貨
 *      街市／超市／便利店／商場的貨架目標（MARKET_SHELF_TARGETS）不足時，
 *      由最近貨倉提貨補上；貨架庫存供 citizens.ts 的市民購物扣減。
 *   ③ 貨倉 → 餐飲／醫院備料、生產投入
 *      茶餐廳／酒樓補食品、醫院補日用品、工廈補建材、食品廠補日用品。
 *   ④ 早期未有貨倉時：生產者直接送貨至零售（開局農田＋便利店即可運作）。
 *
 * 貨櫃碼頭（containerPort）在 GDD v1 只是「日用品進口生產建築」，不產生現金、不做出口；
 * 其 goods 產出與其他生產者一樣經貨車送往貨倉／零售。
 *
 * 規則
 *   - 所有貨物移動都經 addCargo／removeCargo 實際加減：派車時先從來源扣除，
 *     抵達目的地才入庫（Cart 在途 = state.carts）。
 *   - 目的建築容量會扣除「已派車在途」的預留量（reserved），避免多台車同時超收。
 *   - 貨車沿馬路 A*（findPathBetweenBuildings）行駛，速度受天氣移動倍率影響
 *     （颱風 ×0.35 變慢）；道路中途被拆會自動重新尋路，無路可走則退貨回來源。
 *   - 同一時間最多 MAX_CARTS 台；每 30 遊戲分鐘派遣一次，每次最多 10 台。
 *   - 純行人路的建築（只有 sidewalk 冇 road）視作「街舖」：貨車停最近馬路（≤8 格），
 *     最後一段由職員推車仔上落貨；完全冇街道連接的建築才收不到貨。
 *
 * 保持 `tickLogistics(state, gameMinutes, ctx)` 介面（由 simulation.ts 每幀呼叫）。
 */

import { BUILDINGS, MAP_SCALE, TRUCK_CAPACITY, WEATHER_EFFECT } from '../core/config';
import type { Building, Cart, GameState, ResourceKey, SimContext } from '../core/types';
import {
  MARKET_GOODS,
  PRODUCER_LOCAL_CAP,
  serviceStockTargetFor,
  accepts,
  addCargo,
  capacityOf,
  freeCapacityFor,
  inventoryTotal,
  isLogisticsStorage,
  isMarket,
  isProducer,
  removeCargo,
  roundQty,
  shelfTargetFor,
  stockOf,
} from './logistics-inventory';
import {
  findPathBetweenBuildings,
  findRoadPathToAny,
  nearestRoadTile,
  roadAccessTiles,
  tileXY,
  walkAccessTiles,
} from './pathfinding';
import { updateConnectedBuildings, worldRevisionOf } from './placement';

/** 相容舊版：其他模組可能 import updateConnectivity */
export { updateConnectedBuildings as updateConnectivity } from './placement';

// ─────────────────────────── 參數 ───────────────────────────

/** 每台貨車載貨上限（單位；config TRUCK_CAPACITY = 60） */
export const CART_CAPACITY = TRUCK_CAPACITY;
/** 同時最多幾台貨車 */
export const MAX_CARTS = 60;
/** 一次派車的最少載量（GDD §4.5：本地庫存 ≥ 10 才值得派車） */
const MIN_LOAD = 10;
/** 貨車速度：格／遊戲分鐘（× 地圖線性放大，保持 304 地圖嘅真實時間路途合理） */
const CART_SPEED = 0.1 * MAP_SCALE;
/** 每 30 遊戲分鐘評估一次派遣（@1× 約 0.625 真實秒） */
const DISPATCH_INTERVAL = 30;
/** 每次派遣週期最多派出幾台，避免一次爆量 */
const MAX_DISPATCH_PER_CYCLE = 10;
/**
 * 每次派遣週期可用嘅路徑搜尋時間預算（ms）。
 * 玩家大規模鋪路後 path cache 會失效，如果一次過對幾百個目標做長途 A*（304 地圖每個 5–15ms）
 * 會造成嚴重卡頓；用 wall-clock 預算限制每次派遣工作量，其餘留待下個週期（30 遊戲分鐘後）繼續。
 */
const DISPATCH_SEARCH_BUDGET_MS = 3.5;
/** 生產建築投入物備料目標（工廈建材／食品廠日用品） */
const PRODUCER_INPUT_TARGET = Math.min(PRODUCER_LOCAL_CAP - 10, 40);

// ─────────────────────────── 執行期暫存 ───────────────────────────

interface LogisticsRuntime {
  dispatchTimer: number;
  /** destinationId → resource → 已在途、尚未抵達的入庫量（容量預留） */
  reserved: Map<number, Partial<Record<ResourceKey, number>>>;
  /** 上次「道路未接通」提示（每 5 日一次） */
  lastNoRoadLogDay: number;
  /** buildingId → Building 索引（建築數量變更時重建；避免每次 O(n) find） */
  byId: Map<number, Building>;
  indexCount: number;
  indexNextId: number;
  /** 每次派遣週期共用嘅建築分類快取（跨多個 dispatch 函式重用；道路／建築變更前有效） */
  cycle: CycleCache | null;
  /** 本次派遣週期嘅路徑搜尋截止時間（ms；防止 cache 冷時一次過做太多 A*） */
  cycleDeadline: number;
  /** 本次派遣週期嘅路徑搜尋預算已用完（剩餘派遣留待下個週期） */
  budgetExhausted: boolean;
  /** 「街口送貨」後備路徑快取（key `fromId:toId`；worldRevision 變更即清） */
  freightCache: Map<string, number[] | null>;
  freightSig: string;
}

/** 一次派遣週期內重用的建築分類清單（避免每個目標都 O(全部建築) 掃描） */
interface CycleCache {
  token: string;
  markets: Building[];
  /** 可出貨的生產者 */
  producers: Building[];
  /** 有 service.consumes 的服務建築（餐廳／醫院） */
  consumers: Building[];
  /** 物流倉儲（貨倉／進口商行等 logistics 有 storage） */
  warehouses: Building[];
  /** 住宅（用作農業選址／診斷時參考，暫未用但保留） */
  housings: Building[];
}

/** 以 GameState 為 key：換局／讀檔後自動重建，不污染存檔 */
const runtimes = new WeakMap<GameState, LogisticsRuntime>();

function runtimeOf(state: GameState): LogisticsRuntime {
  let rt = runtimes.get(state);
  if (!rt) {
    rt = {
      dispatchTimer: 0,
      reserved: new Map(),
      lastNoRoadLogDay: -999,
      byId: new Map(),
      indexCount: -1,
      indexNextId: -1,
      cycle: null,
      cycleDeadline: 0,
      budgetExhausted: false,
      freightCache: new Map(),
      freightSig: '',
    };
    // 讀檔後：把仍在途的貨車重新計入目的地容量預留
    for (const cart of state.carts) {
      if (cart.done) continue;
      const to = state.buildings.find((b) => b.id === cart.toId);
      if (!to) continue;
      if (capacityOf(to) > 0) addReserved(rt, to.id, cart.resource, cart.amount);
    }
    runtimes.set(state, rt);
  }
  return rt;
}

function reservedIn(rt: LogisticsRuntime, buildingId: number, resource: ResourceKey): number {
  return rt.reserved.get(buildingId)?.[resource] ?? 0;
}

function reservedTotalFor(rt: LogisticsRuntime, buildingId: number): number {
  const map = rt.reserved.get(buildingId);
  if (!map) return 0;
  let total = 0;
  for (const key in map) total += map[key as ResourceKey] ?? 0;
  return total;
}

function addReserved(rt: LogisticsRuntime, buildingId: number, resource: ResourceKey, amount: number): void {
  if (!(amount > 0)) return;
  let map = rt.reserved.get(buildingId);
  if (!map) {
    map = {};
    rt.reserved.set(buildingId, map);
  }
  map[resource] = roundQty((map[resource] ?? 0) + amount);
}

function releaseReserved(rt: LogisticsRuntime, buildingId: number, resource: ResourceKey, amount: number): void {
  const map = rt.reserved.get(buildingId);
  if (!map) return;
  const left = roundQty((map[resource] ?? 0) - amount);
  if (left > 0.05) map[resource] = left;
  else delete map[resource];
  let empty = true;
  for (const key in map) {
    empty = false;
    break;
  }
  if (empty) rt.reserved.delete(buildingId);
}

// ─────────────────────────── 小工具 ───────────────────────────

function findBuilding(state: GameState, id: number): Building | undefined {
  const rt = runtimes.get(state);
  if (rt) {
    if (rt.indexCount !== state.buildings.length || rt.indexNextId !== state.nextBuildingId) {
    refreshBuildingIndex(state, rt);
  }
    const cached = rt.byId.get(id);
    if (cached) return cached;
  }
  return state.buildings.find((b) => b.id === id);
}

/** 重建 buildingId → Building 索引（建築被拆／新增後由呼叫端或 findBuilding 偵測） */
function refreshBuildingIndex(state: GameState, rt: LogisticsRuntime): void {
  rt.byId.clear();
  for (const building of state.buildings) rt.byId.set(building.id, building);
  rt.indexCount = state.buildings.length;
  rt.indexNextId = state.nextBuildingId;
  rt.cycle = null;
}

/** 取得本派遣週期共用嘅建築分類（token 包含建築數及 nextBuildingId，建築增減即失效） */
function cycleOf(state: GameState, rt: LogisticsRuntime): CycleCache {
  const token = `${state.buildings.length}:${state.nextBuildingId}`;
  if (rt.cycle && rt.cycle.token === token) return rt.cycle;
  const markets: Building[] = [];
  const producers: Building[] = [];
  const consumers: Building[] = [];
  const warehouses: Building[] = [];
  const housings: Building[] = [];
  // 注意：呢個 cache 只按「建築結構」失效，唔包括道路變更，所以清單唔可以先篩臨路；
  // 臨路／可出貨判斷喺實際派遣時做（roadAccessTiles 已有快取，成本低）。
  for (const building of state.buildings) {
    if (!isOperating(building)) continue;
    const def = BUILDINGS[building.key];
    if (!def) continue;
    if (isMarket(building)) markets.push(building);
    if (isProducer(building)) producers.push(building);
    if (def.service?.consumes) consumers.push(building);
    if (isLogisticsStorage(building)) warehouses.push(building);
    if (def.housing > 0) housings.push(building);
  }
  rt.cycle = { token, markets, producers, consumers, warehouses, housings };
  return rt.cycle;
}

/** 建築是否正常營運（active；有路與否交由尋路判斷） */
function isOperating(building: Building): boolean {
  return building.active;
}

/** 建築是否接上馬路（貨車可達）；行人路-only 的建築貨車送不到，但有「街口送貨」後備 */
function hasRoadAccess(state: GameState, building: Building): boolean {
  return roadAccessTiles(state, building).length > 0;
}

/** 貨車最後一段「人手送貨」的最大距離（格）：貨車停在最近馬路，店員推車仔送入舖 */
const MAX_DELIVERY_CARRY = 8;

/** 目的建築的貨車目標道路格：臨路格；純行人路建築則用最近馬路（街口） */
function deliveryRoadGoals(state: GameState, building: Building): number[] {
  return streetRoadStops(state, building);
}

/**
 * 建築對應的「貨車上落貨街口」：臨路格；冇臨路就用最近馬路（≤8 格，職員推車仔上落貨）。
 * requireWalk：零售／服務建築要求有行人路入口（客人行得到）；工廠農田可放寬（廠車出入）。
 */
function streetRoadStops(state: GameState, building: Building, requireWalk = true): number[] {
  const direct = roadAccessTiles(state, building);
  if (direct.length) return direct;
  if (requireWalk && !hasWalkAccess(state, building)) return [];
  const cx = Math.floor(building.x + building.w / 2);
  const cy = Math.floor(building.y + building.h / 2);
  const anchor = nearestRoadTile(state, cx, cy, MAX_DELIVERY_CARRY);
  return anchor >= 0 ? [anchor] : [];
}

/** 該建築可否用貨車出貨（臨馬路，或貨車可停附近街口由職員推車上貨） */
function canShipFrom(state: GameState, building: Building): boolean {
  return streetRoadStops(state, building, false).length > 0;
}

/**
 * 貨運路徑：首選建築對建築的馬路 A*；若來源／目的地只有行人路（臨街但無馬路），
 * 貨車會停在最近的馬路街口，貨物由職員推車仔上落（findFreightPath 回傳的 path
 * 起點／終點是街口道路格，spawnCart / completeCart 照常扣貨入庫）。
 */
/**
 * 貨運路徑：先試建築→建築直達；冇路可達時用「貨車停街口、職員送貨」後備。
 * 後備路徑係昂貴 A*（480 地圖長途可達 5–6ms），用快取避免同一對建築每次派遣重算。
 */
function findFreightPath(state: GameState, from: Building, to: Building): number[] | null {
  const direct = findPathBetweenBuildings(state, from.id, to.id);
  if (direct && direct.length) return direct;
  const rt = runtimeOf(state);
  const sig = `${worldRevisionOf()}:${state.buildings.length}:${state.nextBuildingId}`;
  if (rt.freightSig !== sig) {
    rt.freightSig = sig;
    rt.freightCache.clear();
  }
  const key = `${from.id}:${to.id}`;
  if (rt.freightCache.has(key)) return rt.freightCache.get(key) ?? null;
  const fromStops = streetRoadStops(state, from, false);
  const goals = streetRoadStops(state, to);
  let path: number[] | null = null;
  if (fromStops.length && goals.length) {
    const hit = findRoadPathToAny(state, fromStops[0], goals);
    path = hit && hit.path.length ? hit.path : null;
  }
  if (rt.freightCache.size >= 4096) rt.freightCache.clear();
  rt.freightCache.set(key, path);
  return path;
}

/** 建築是否接上可行人網絡（行人路或馬路；用 pathfinding 快取） */
function hasWalkAccess(state: GameState, building: Building): boolean {
  return walkAccessTiles(state, building).length > 0;
}

/**
 * 目的建築對某資源還可收多少（已扣在途預留）。
 * 倉儲／零售貨架以總容量計算；生產／服務建築以單一資源上限計算。
 */
function roomFor(rt: LogisticsRuntime, building: Building, resource: ResourceKey): number {
  if (capacityOf(building) > 0 && !BUILDINGS[building.key]?.production) {
    return freeCapacityFor(building, resource, reservedTotalFor(rt, building.id));
  }
  return freeCapacityFor(building, resource, reservedIn(rt, building.id, resource));
}

/** 每次查路最多考慮嘅候選數（先用曼哈頓距離篩最接近嘅幾個，避免 O(n²) A* 查詢） */
const MAX_PATH_CANDIDATES = 6;

function tileDistance(a: Building, b: Building): number {
  return Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) + Math.abs(a.y + a.h / 2 - (b.y + b.h / 2));
}

/**
 * 由 source 前往候選建築中「道路距離最近」的一棟；找不到回傳 null。
 * 效能：先按曼哈頓距離排序只查最近 MAX_PATH_CANDIDATES 個（路徑有 cache）；
 * 全部冇直達路時，先試最近 2 個用「街口送貨」後備，避免對所有組合做昂貴 A*。
 */
function nearestReachable(
  state: GameState,
  source: Building,
  candidates: Building[],
): { building: Building; path: number[] } | null {
  if (!candidates.length) return null;
  const rt = runtimeOf(state);
  if (rt.budgetExhausted) return null;
  // 大地圖減少候選數（每個 A* 更貴，用曼哈頓最近幾個已足夠）
  const candidateCount = state.tiles.length > 40000 ? 4 : MAX_PATH_CANDIDATES;
  const sorted = candidates
    .filter((c) => c.id !== source.id)
    .map((c) => ({ c, d: tileDistance(source, c) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, candidateCount);
  let best: { building: Building; path: number[] } | null = null;
  for (const entry of sorted) {
    const path = findPathBetweenBuildings(state, source.id, entry.c.id);
    if (path && path.length && (!best || path.length < best.path.length)) {
      best = { building: entry.c, path };
    }
    if (performance.now() > rt.cycleDeadline) {
      rt.budgetExhausted = true;
      return best;
    }
  }
  if (best) return best;
  // 後備：最近 2 個候選行「貨車停街口、職員送貨」
  for (const entry of sorted.slice(0, 2)) {
    const path = findFreightPath(state, source, entry.c);
    if (path && path.length) return { building: entry.c, path };
    if (performance.now() > rt.cycleDeadline) {
      rt.budgetExhausted = true;
      return null;
    }
  }
  return null;
}

/** 可作為某資源來源的貨倉（有存貨、有馬路；用週期快取清單） */
function warehouseSources(state: GameState, resource: ResourceKey): Building[] {
  const rt = runtimeOf(state);
  const cycle = cycleOf(state, rt);
  const result: Building[] = [];
  for (const building of cycle.warehouses) {
    if (!accepts(building, resource)) continue;
    if (stockOf(building, resource) < MIN_LOAD) continue;
    result.push(building);
  }
  return result;
}

/** 可作為某資源來源的生產者（本地暫存有貨、可出貨；用週期快取清單） */
function producerSources(state: GameState, resource: ResourceKey): Building[] {
  const rt = runtimeOf(state);
  const cycle = cycleOf(state, rt);
  const result: Building[] = [];
  for (const building of cycle.producers) {
    const def = BUILDINGS[building.key];
    if (def?.production?.output !== resource) continue;
    if (stockOf(building, resource) < MIN_LOAD) continue;
    result.push(building);
  }
  return result;
}

/** 找最近的可供貨來源：貨倉優先，無貨倉時才由生產者直送 */
function findSourceFor(
  state: GameState,
  target: Building,
  resource: ResourceKey,
): { building: Building; path: number[] } | null {
  const hit = nearestReachable(state, target, warehouseSources(state, resource));
  if (hit) return hit;
  return nearestReachable(state, target, producerSources(state, resource));
}

// ─────────────────────────── 派車 ───────────────────────────

/**
 * 建立一台貨車：先確認有路、再從來源扣貨，抵達時才入庫。
 * phase：'deliver' = 生產者送往貨倉／零售；'pickup' = 由貨倉／生產者提貨送往目的地。
 */
function spawnCart(
  state: GameState,
  rt: LogisticsRuntime,
  from: Building,
  to: Building,
  resource: ResourceKey,
  amount: number,
  phase: Cart['phase'],
): Cart | null {
  if (state.carts.length >= MAX_CARTS) return null;
  const take = Math.min(amount, stockOf(from, resource));
  if (take < MIN_LOAD) return null;
  const path = findFreightPath(state, from, to);
  if (!path || !path.length) return null;
  const removed = removeCargo(from, resource, take);
  if (removed < MIN_LOAD) {
    if (removed > 0) addCargo(from, resource, removed);
    return null;
  }
  // 目的地有容量者預留空間，避免多台車同時送達造成超收
  if (capacityOf(to) > 0) addReserved(rt, to.id, resource, removed);
  const start = tileXY(state, path[0]);
  const cart: Cart = {
    id: state.nextCartId++,
    resource,
    amount: roundQty(removed),
    capacity: CART_CAPACITY,
    fromId: from.id,
    toId: to.id,
    x: start.x,
    y: start.y,
    path,
    pathProgress: 0,
    phase,
    vehicleKind: removed >= 28 ? 'truck' : 'van',
    done: false,
  };
  state.carts.push(cart);
  return cart;
}

/** 貨車完成：把貨物交給目的建築（抵達才入庫） */
function completeCart(state: GameState, rt: LogisticsRuntime, cart: Cart, ctx: SimContext): void {
  const to = findBuilding(state, cart.toId);
  const from = findBuilding(state, cart.fromId);
  if (!to) {
    // 目的地被拆除：貨物退回來源（有空間的話）
    if (from) addCargo(from, cart.resource, cart.amount);
    releaseReserved(rt, cart.toId, cart.resource, cart.amount);
    return;
  }
  releaseReserved(rt, to.id, cart.resource, cart.amount);
  const accepted = addCargo(to, cart.resource, cart.amount);
  if (accepted + 0.01 < cart.amount) {
    // 目的地臨時滿了：剩餘退回來源（再不行就損耗）
    const leftover = roundQty(cart.amount - accepted);
    if (from) addCargo(from, cart.resource, leftover);
  }
}

/** 取消貨車：貨物退回來源 */
function cancelCart(state: GameState, rt: LogisticsRuntime, cart: Cart): void {
  const from = findBuilding(state, cart.fromId);
  if (from) addCargo(from, cart.resource, cart.amount);
  releaseReserved(rt, cart.toId, cart.resource, cart.amount);
  cart.done = true;
}

/** 道路被拆後重新接路；失敗則取消貨車（貨物退回來源） */
function rerouteCart(state: GameState, rt: LogisticsRuntime, cart: Cart): void {
  const last = cart.path.length - 1;
  const currentIndex = cart.path[Math.max(0, Math.min(last, Math.floor(cart.pathProgress)))];
  const current = tileXY(state, currentIndex);
  const start = state.tiles[currentIndex]?.road
    ? currentIndex
    : nearestRoadTile(state, current.x, current.y, 6);
  if (start >= 0) {
    const to = findBuilding(state, cart.toId);
    const goals = to ? deliveryRoadGoals(state, to) : [];
    const hit = goals.length ? findRoadPathToAny(state, start, goals) : null;
    if (hit && hit.path.length) {
      cart.path = hit.path;
      cart.pathProgress = 0;
      const startXY = tileXY(state, hit.path[0]);
      cart.x = startXY.x;
      cart.y = startXY.y;
      return;
    }
  }
  cancelCart(state, rt, cart);
}

// ─────────────────────────── 移動 ───────────────────────────

function moveCarts(state: GameState, gameMinutes: number, rt: LogisticsRuntime, ctx: SimContext): void {
  if (!state.carts.length) return;
  // 颱風／暴雨令貨車變慢（WEATHER_EFFECT.move：storm 0.35、rain 0.8）
  const moveMultiplier = WEATHER_EFFECT[state.clock.weather]?.move ?? 1;
  const step = CART_SPEED * moveMultiplier * gameMinutes;
  const survivors: Cart[] = [];

  for (const cart of state.carts) {
    if (cart.done) continue;
    if (!cart.path.length) {
      completeCart(state, rt, cart, ctx);
      continue;
    }
    const last = cart.path.length - 1;
    const currentIndex = cart.path[Math.max(0, Math.min(last, Math.floor(cart.pathProgress)))];
    const nextIndex = Math.min(last, Math.floor(cart.pathProgress + step + 1e-6));
    const nextTile = state.tiles[cart.path[nextIndex]];

    // 前方道路被拆：重新尋路
    if (nextIndex !== currentIndex && !nextTile?.road) {
      rerouteCart(state, rt, cart);
      if (!cart.done) survivors.push(cart);
      continue;
    }

    cart.pathProgress += step;
    if (cart.pathProgress >= last) {
      const end = tileXY(state, cart.path[last]);
      cart.x = end.x;
      cart.y = end.y;
      completeCart(state, rt, cart, ctx);
      continue;
    }

    const i = Math.floor(cart.pathProgress);
    const t = cart.pathProgress - i;
    const a = tileXY(state, cart.path[i]);
    const b = tileXY(state, cart.path[i + 1]);
    cart.x = a.x + (b.x - a.x) * t;
    cart.y = a.y + (b.y - a.y) * t;
    survivors.push(cart);
  }
  state.carts = survivors;
}

// ─────────────────────────── 派遣：生產者 → 貨倉／零售 ───────────────────────────

function dispatchProducerOutput(state: GameState, rt: LogisticsRuntime, budget: number): number {
  let dispatched = 0;
  const cycle = cycleOf(state, rt);
  for (const producer of cycle.producers) {
    if (rt.budgetExhausted || dispatched >= budget || state.carts.length >= MAX_CARTS) break;
    const def = BUILDINGS[producer.key];
    const production = def?.production;
    if (!def || !production) continue;
    if (!canShipFrom(state, producer)) continue;
    const resource = production.output;
    const available = stockOf(producer, resource);
    if (available < MIN_LOAD) continue;

    // 1) 送往有容量的貨倉
    const warehouseCandidates: Building[] = [];
    for (const building of cycle.warehouses) {
      if (building.id === producer.id) continue;
      if (!canShipFrom(state, building)) continue;
      if (!accepts(building, resource)) continue;
      if (roomFor(rt, building, resource) < MIN_LOAD) continue;
      warehouseCandidates.push(building);
    }
    const storageHit = nearestReachable(state, producer, warehouseCandidates);
    if (storageHit) {
      const dest = storageHit.building;
      const space = roomFor(rt, dest, resource);
      const amount = Math.min(available, CART_CAPACITY, space);
      if (amount >= MIN_LOAD && spawnCart(state, rt, producer, dest, resource, amount, 'deliver')) {
        dispatched++;
        continue;
      }
    }

    // 2) 未有貨倉（或貨倉已滿）時：民生資源直接送零售，開局物流不致中斷
    if (!MARKET_GOODS.includes(resource)) continue;
    const marketCandidates: Building[] = [];
    for (const building of cycle.markets) {
      if (!accepts(building, resource)) continue;
      const target = shelfTargetFor(building, resource);
      const need = target - stockOf(building, resource) - reservedIn(rt, building.id, resource);
      if (need < MIN_LOAD) continue;
      if (roomFor(rt, building, resource) < MIN_LOAD) continue;
      marketCandidates.push(building);
    }
    const marketHit = nearestReachable(state, producer, marketCandidates);
    if (!marketHit) continue;
    const market = marketHit.building;
    const target = shelfTargetFor(market, resource);
    const need = target - stockOf(market, resource) - reservedIn(rt, market.id, resource);
    const amount = Math.min(available, CART_CAPACITY, need, roomFor(rt, market, resource));
    if (amount >= MIN_LOAD && spawnCart(state, rt, producer, market, resource, amount, 'deliver')) {
      dispatched++;
    }
  }
  return dispatched;
}

// ─────────────────────────── 派遣：貨倉 → 零售補貨 ───────────────────────────

function dispatchMarketRestock(state: GameState, rt: LogisticsRuntime, budget: number): number {
  let dispatched = 0;
  const cycle = cycleOf(state, rt);
  for (const market of cycle.markets) {
    if (rt.budgetExhausted || dispatched >= budget || state.carts.length >= MAX_CARTS) break;
    if (!deliveryRoadGoals(state, market).length) continue;
    for (const resource of MARKET_GOODS) {
      if (rt.budgetExhausted || dispatched >= budget || state.carts.length >= MAX_CARTS) break;
      if (!accepts(market, resource)) continue;
      const target = shelfTargetFor(market, resource);
      if (target <= 0) continue;
      const need = target - stockOf(market, resource) - reservedIn(rt, market.id, resource);
      if (need < MIN_LOAD) continue;
      const source = findSourceFor(state, market, resource);
      if (!source) continue;
      const amount = Math.min(
        need,
        stockOf(source.building, resource),
        CART_CAPACITY,
        roomFor(rt, market, resource),
      );
      if (amount < MIN_LOAD) continue;
      if (spawnCart(state, rt, source.building, market, resource, amount, 'pickup')) dispatched++;
    }
  }
  return dispatched;
}

// ─────────────────────────── 派遣：貨倉 → 生產投入 ───────────────────────────

/**
 * 生產建築補投入物（工廈建材、食品廠日用品）。
 * 優先級最高：工廠有原料才有本地產出，整條物流鏈才轉得動。
 */
function dispatchProducerInputs(state: GameState, rt: LogisticsRuntime, budget: number): number {
  let dispatched = 0;
  const cycle = cycleOf(state, rt);
  for (const building of cycle.producers) {
    if (rt.budgetExhausted || dispatched >= budget || state.carts.length >= MAX_CARTS) break;
    const def = BUILDINGS[building.key];
    const input = def?.production?.input;
    if (!def || !input) continue;
    if (!deliveryRoadGoals(state, building).length) continue;

    const resource = input.resource;
    const need = PRODUCER_INPUT_TARGET - stockOf(building, resource) - reservedIn(rt, building.id, resource);
    if (need < MIN_LOAD) continue;
    const source = findSourceFor(state, building, resource);
    if (!source) continue;
    const amount = Math.min(
      need,
      stockOf(source.building, resource),
      CART_CAPACITY,
      roomFor(rt, building, resource),
    );
    if (amount < MIN_LOAD) continue;
    if (spawnCart(state, rt, source.building, building, resource, amount, 'pickup')) dispatched++;
  }
  return dispatched;
}

// ─────────────────────────── 派遣：貨倉 → 餐飲／醫院備料 ───────────────────────────

/** 茶餐廳／酒樓補食品、醫院補日用品（service.consumes） */
function dispatchServiceStock(state: GameState, rt: LogisticsRuntime, budget: number): number {
  let dispatched = 0;
  const cycle = cycleOf(state, rt);
  for (const building of cycle.consumers) {
    if (rt.budgetExhausted || dispatched >= budget || state.carts.length >= MAX_CARTS) break;
    const def = BUILDINGS[building.key];
    const consumed = def?.service?.consumes;
    if (!def || !consumed) continue;
    if (!deliveryRoadGoals(state, building).length) continue;

    const need =
      serviceStockTargetFor(building) -
      stockOf(building, consumed.resource) -
      reservedIn(rt, building.id, consumed.resource);
    if (need < MIN_LOAD) continue;
    const source = findSourceFor(state, building, consumed.resource);
    if (!source) continue;
    const amount = Math.min(
      need,
      stockOf(source.building, consumed.resource),
      CART_CAPACITY,
      roomFor(rt, building, consumed.resource),
    );
    if (amount < MIN_LOAD) continue;
    if (spawnCart(state, rt, source.building, building, consumed.resource, amount, 'pickup')) dispatched++;
  }
  return dispatched;
}

// ─────────────────────────── 清理無效貨車 ───────────────────────────

function cleanupInvalidCarts(state: GameState, rt: LogisticsRuntime): void {
  if (!state.carts.length) return;
  const ids = new Set<number>();
  for (const building of state.buildings) ids.add(building.id);
  let invalid = false;
  for (const cart of state.carts) {
    if (!ids.has(cart.toId)) {
      invalid = true;
      break;
    }
  }
  if (!invalid) return;
  const survivors: Cart[] = [];
  for (const cart of state.carts) {
    if (ids.has(cart.toId)) {
      survivors.push(cart);
      continue;
    }
    const from = findBuilding(state, cart.fromId);
    if (from) addCargo(from, cart.resource, cart.amount);
    releaseReserved(rt, cart.toId, cart.resource, cart.amount);
    cart.done = true;
  }
  state.carts = survivors;
}

/** 「有道路未接通」提示（每 5 日最多一次） */
function maybeWarnNoRoad(state: GameState, ctx: SimContext): void {
  const day = state.clock.totalDays;
  // 生產者無馬路 → 貨車出不了貨；任何建築完全無街道 → 無法營運
  const blocked = state.buildings.some((b) => {
    if (!isOperating(b)) return false;
    const def = BUILDINGS[b.key];
    if (!def || def.category === 'decoration') return false; // 公園／海濱長廊免臨路
    if (!hasWalkAccess(state, b)) return true;
    return isProducer(b) && !canShipFrom(state, b);
  });
  if (!blocked) return;
  const rt = runtimeOf(state);
  if (day - rt.lastNoRoadLogDay < 5) return;
  rt.lastNoRoadLogDay = day;
  ctx.log('有廠房未接上馬路，貨車無法出貨；請鋪設馬路連接。', 'warn');
}

// ─────────────────────────── 主入口 ───────────────────────────

/** 每幀由 simulation 呼叫；gameMinutes 為本影格推進的遊戲分鐘 */
export function tickLogistics(state: GameState, gameMinutes: number, ctx: SimContext): void {
  const rt = runtimeOf(state);
  // 建築增減後重建索引／清週期快取（建築放置／拆除比每幀少，成本可接受）
  if (rt.indexCount !== state.buildings.length || rt.indexNextId !== state.nextBuildingId) {
    refreshBuildingIndex(state, rt);
  }

  // 1) 移動已派遣的貨車
  moveCarts(state, gameMinutes, rt, ctx);

  // 2) 派遣（固定頻率 + 每次上限，避免爆量）
  rt.dispatchTimer += gameMinutes;
  if (rt.dispatchTimer >= DISPATCH_INTERVAL) {
    rt.dispatchTimer = Math.max(0, rt.dispatchTimer - DISPATCH_INTERVAL);
    cleanupInvalidCarts(state, rt);
    // 每次派遣週期重設路徑搜尋預算（避免 cache 冷時一次過做太多 A*）
    rt.budgetExhausted = false;
    rt.cycleDeadline = performance.now() + DISPATCH_SEARCH_BUDGET_MS;
    if (state.carts.length < MAX_CARTS) {
      // 優先級：生產投入 → 零售補貨 → 餐飲備料 → 生產者出貨（避免出貨獨佔預算）
      let budget = MAX_DISPATCH_PER_CYCLE;
      budget -= dispatchProducerInputs(state, rt, budget);
      if (budget > 0) budget -= dispatchMarketRestock(state, rt, budget);
      if (budget > 0) budget -= dispatchServiceStock(state, rt, budget);
      if (budget > 0) dispatchProducerOutput(state, rt, budget);
    }
    maybeWarnNoRoad(state, ctx);
  }
}

/** 除錯／UI 用：目前各資源在途貨量 */
export function inTransitByResource(state: GameState): Partial<Record<ResourceKey, number>> {
  const result: Partial<Record<ResourceKey, number>> = {};
  for (const cart of state.carts) {
    result[cart.resource] = roundQty((result[cart.resource] ?? 0) + cart.amount);
  }
  return result;
}

/** 除錯／UI 用：全城倉儲（貨倉）平均使用率 0..1 */
export function warehouseFillRatio(state: GameState): number {
  let total = 0;
  let used = 0;
  for (const building of state.buildings) {
    if (!isLogisticsStorage(building)) continue;
    total += capacityOf(building);
    used += inventoryTotal(building);
  }
  return total > 0 ? Math.min(1, used / total) : 0;
}
