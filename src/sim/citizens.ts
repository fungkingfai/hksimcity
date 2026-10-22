/**
 * 香港市民行為：一日生活狀態機（家 → 通勤 → 上班 → 午飯 → 放工購物／消閒 → 回家）。
 *
 * 作息（香港）：
 *   06:00 起床 ─ 08:00–09:00 出門 ─ 09:00–13:00 上班 ─ 13:00–14:00 午飯（茶餐廳／街市）
 *   14:00–18:00 上班 ─ 18:00 放工（購物／消閒）─ 22:00 回家睡覺。
 *   星期日全休、星期六下午放假：去商場／茶餐廳／公園／海濱長廊。
 *   學齡兒童（6–17 歲）上學日到學校；長者（65+）飲茶、逛公園。
 *   颱風（八號風球）盡量留家；雨天照常但步伐慢（渲染撐傘）；夜晚街上人少。
 *
 * 通勤：citizen.commuteMode 由 citizen-common.pickCommuteMode 決定（步行／港鐵／巴士／
 * 電車／渡輪）；步行速度 × TRANSIT_SPEED[mode]。每次乘車記入 state.transit.byMode
 * （只加不清零，transport-dev 的 tickTransit 以差額結算）；抵達時記錄通勤時間。
 *
 * 購物：到 `market` 服務的零售店買 food／goods —— 扣店舖庫存、扣市民錢、
 * 寫店舖 incomeThisMonth（零售收入由 finance 月結計利得稅）；餐廳用餐付錢（食材由
 * finance 每日消耗，市民端不重複扣）。
 *
 * 每日需求結算（05:00）：每位市民合共消耗 food 0.5、goods 0.2（有市場貨源時），
 * 更新 needs 並經 population.applyDailyHappiness 計算幸福度。
 *
 * 對外介面：`tickCitizens(state, gameMinutes, ctx)`（simulation.ts 依賴，不可改簽名）。
 */

import { BUILDINGS, TRANSIT_SPEED, WEATHER_EFFECT } from '../core/config';
import type { Building, Citizen, GameState, ServiceKind, SimContext, TransitMode } from '../core/types';
import {
  CHILD_FOOD_FACTOR,
  CITIZEN_SPEED,
  DAWN_HOUR,
  DEPART_HOUR,
  FOOD_PER_CITIZEN_PER_DAY,
  GOODS_PER_CITIZEN_PER_DAY,
  LUNCH_END_HOUR,
  LUNCH_START_HOUR,
  MAX_POPULATION,
  MEAL_COST,
  RETIRE_AGE,
  SATURDAY_END_HOUR,
  SCHOOL_AGE,
  SCHOOL_END_AGE,
  SLEEP_HOUR,
  WAKE_HOUR,
  WORK_END_HOUR,
  WORK_START_HOUR,
  WORKING_AGE,
  type CitizenActivity,
  type CitizenCache,
  type CitizenExtras,
  type ServicePoint,
  buildingCenter,
  buildingWalkGoal,
  cachedBuilding,
  citizenStartTile,
  cityGrainReserve,
  clamp,
  consumeCityGrain,
  ensureInitialPopulation,
  findWalkPath,
  findWalkPathBetweenBuildings,
  getCitizenCache,
  getExtras,
  housingCapacity,
  inventoryOf,
  isPassableTile,
  isSaturday,
  isSunday,
  isTyphoon,
  isWetWeather,
  isWorkingAge,
  marketHasGoods,
  marketPurchase,
  nearestServicePoint,
  pickCommuteMode,
  randInt,
  randRange,
  recordCommuteArrival,
  recordCommuteRide,
  refreshBuildingIndex,
  servicePointsNear,
  spawnAnchor,
  type NeedsBatchState,
  takeInventory,
  walkableTiles,
} from './citizen-common';
import { applyDailyHappiness, assignEmployment, assignHousing } from './population';

// ─────────────────────────── 本地作息常數 ───────────────────────────

/** 上學時間 */
const SCHOOL_START_HOUR = 8;
const SCHOOL_END_HOUR = 15;
/** 晚上幾點後不再外出 */
const CURFEW_HOUR = 21;
/** 午飯時段長度（遊戲分鐘） */
const LUNCH_SLOT_MINUTES = 60;
/** 早餐時段（在家吃飯） */
const BREAKFAST_HOUR = 7;

// ─────────────────────────── 主進入點 ───────────────────────────

export function tickCitizens(state: GameState, gameMinutes: number, ctx: SimContext): void {
  const cache = getCitizenCache(state);
  refreshBuildingIndex(state, cache);

  // 開局流民（僅新局第一次呼叫時）
  ensureInitialPopulation(state, cache, ctx);

  // 建築變動 → 即時清理失效參照並重分配住宅／工作（玩家蓋房後流民馬上搬進去）
  if (state.buildings.length !== cache.lastBuildingCount) {
    cache.lastBuildingCount = state.buildings.length;
    pruneAssignments(state, cache);
    assignHousing(state, cache);
    assignEmployment(state, cache);
  }

  // 每日黎明需求結算
  maybeSettleDailyNeeds(state, cache, ctx);

  const clock = state.clock;
  const hour = clock.hour;
  const isNight = hour >= SLEEP_HOUR || hour < WAKE_HOUR;
  const weatherMove = WEATHER_EFFECT[clock.weather]?.move ?? 1;
  const baseSpeed = CITIZEN_SPEED * weatherMove * (isNight ? 0.9 : 1);
  const gameDelta = Math.max(0, gameMinutes);

  const total = state.citizens.length;
  if (total === 0) return;

  // 行為規劃預算：跟隨影格推進的遊戲時間放大，避免低 FPS（dt 大）時市民排不到行程
  let planBudget = clamp(Math.ceil((total * gameDelta) / 320) + 18, 18, 64);
  const cursor = cache.planCursor;

  for (let k = 0; k < total; k++) {
    const citizen = state.citizens[(cursor + k) % total];
    const extras = getExtras(cache, citizen, clock.minutes);

    if (citizen.state === 'walking') {
      const ageFactor = citizen.age < WORKING_AGE ? 0.8 : citizen.age >= RETIRE_AGE ? 0.82 : 1;
      let speed = baseSpeed * ageFactor;
      if (extras.activity === 'commute' && citizen.commuteMode !== 'walk') {
        speed *= TRANSIT_SPEED[citizen.commuteMode] ?? 1;
      }
      advanceWalker(state, cache, citizen, extras, speed * gameDelta, ctx);
      continue;
    }

    if (!extras.pendingPlan && clock.minutes >= extras.busyUntil) extras.pendingPlan = true;
    if (extras.pendingPlan && clock.minutes >= extras.retryAt) {
      if (planBudget <= 0) continue;
      planBudget--;
      planCitizen(state, cache, citizen, extras);
    }
  }
  cache.planCursor = (cursor + 13) % total;
}

/** 建築被拆除後清理市民的失效參照（每日 population.reconcileAssignments 之外的中途保護） */
function pruneAssignments(state: GameState, cache: CitizenCache): void {
  for (const citizen of state.citizens) {
    if (citizen.homeId >= 0 && !cache.byId.has(citizen.homeId)) {
      citizen.homeId = -1;
      if (citizen.state === 'home') citizen.state = 'idle';
      if (citizen.targetId === citizen.homeId) citizen.targetId = -1;
    }
    if (citizen.workId >= 0 && !cache.byId.has(citizen.workId)) {
      citizen.workId = -1;
      citizen.salary = 0;
      if (citizen.state === 'working') citizen.state = 'idle';
      if (citizen.targetId === citizen.workId) citizen.targetId = -1;
    }
  }
}

// ─────────────────────────── 每日需求結算 ───────────────────────────

/** 一位市民住宅附近的需求相關服務 */
interface NearbyNeeds {
  /** 半徑內有食品／日用品貨的市場（按距離排序） */
  markets: ServicePoint[];
  /** 半徑內最近的餐廳 */
  restaurant: ServicePoint | null;
  /** 半徑內最近的公園、海濱、商場 */
  leisureSpots: ServicePoint[];
  /** 各類服務中的幸福加成（同類取最近） */
  serviceHappiness: number;
  hasMarket: boolean;
  hasRestaurant: boolean;
}

function collectNearbyNeeds(state: GameState, cache: CitizenCache, x: number, y: number): NearbyNeeds {
  const points = servicePointsNear(state, cache, x, y);
  const nearestByKind = new Map<ServiceKind, ServicePoint>();
  const markets: ServicePoint[] = [];
  const leisureSpots: ServicePoint[] = [];
  let hasMarket = false;
  let hasRestaurant = false;

  for (const sp of points) {
    const prev = nearestByKind.get(sp.kind);
    const dist = (sp.x - x) ** 2 + (sp.y - y) ** 2;
    if (!prev || dist < (prev.x - x) ** 2 + (prev.y - y) ** 2) nearestByKind.set(sp.kind, sp);

    if (sp.kind === 'market') {
      if (marketHasGoods(sp.building)) {
        markets.push(sp);
        hasMarket = true;
      }
      // 商場同時是消閒去處
      if (sp.building.key === 'shoppingMall') leisureSpots.push(sp);
    } else if (sp.kind === 'restaurant') {
      hasRestaurant = true;
    } else if (sp.kind === 'park' || sp.kind === 'promenade') {
      leisureSpots.push(sp);
    }
  }
  markets.sort(
    (a, b) => (a.x - x) ** 2 + (a.y - y) ** 2 - ((b.x - x) ** 2 + (b.y - y) ** 2),
  );

  // 幸福度服務加成：公園、海濱、商場、餐廳（同類取最近，總和上限 20）。
  // 治安／醫療／教育／消防改用 stats 的覆蓋率（policeCoverage 等）計算，避免同類服務被重複計算。
  let serviceHappiness = 0;
  for (const [kind, sp] of nearestByKind) {
    if (kind === 'police' || kind === 'fire' || kind === 'school' || kind === 'hospital') continue;
    if (kind === 'market' && !sp.building.key.includes('Mall')) continue;
    serviceHappiness += BUILDINGS[sp.building.key]?.service?.happiness ?? 0;
  }
  serviceHappiness = Math.min(20, serviceHappiness);

  return {
    markets,
    restaurant: nearestByKind.get('restaurant') ?? null,
    leisureSpots,
    serviceHappiness,
    hasMarket,
    hasRestaurant,
  };
}

/** 估計單程通勤時間（遊戲分鐘；供幸福度公式用） */
function estimateCommuteMinutes(
  state: GameState,
  citizen: Citizen,
  home: Building | null,
  work: Building | null,
): number {
  if (!work) return 0;
  const from = home ? buildingCenter(home) : { x: citizen.x, y: citizen.y };
  const to = buildingCenter(work);
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const modeSpeed = citizen.commuteMode === 'walk' ? 1 : TRANSIT_SPEED[citizen.commuteMode] ?? 1;
  return dist / (CITIZEN_SPEED * modeSpeed) + (citizen.commuteMode === 'walk' ? 2 : 10);
}

/** 每幀處理幾多位市民的每日需求結算（1600 人 / 160 = 10 幀內完成，避免一次過掃描造成 ~20ms 尖峰） */
const NEEDS_BATCH_SIZE = 160;

/** 每日黎明需求結算：分幀執行（city 層面旗標只計一次，完成後才出 warning） */
function maybeSettleDailyNeeds(state: GameState, cache: CitizenCache, ctx: SimContext): void {
  const clock = state.clock;
  if (!cache.needsBatch) {
    if (clock.hour < DAWN_HOUR) return;
    if (cache.needsDay === clock.totalDays) return;
    cache.needsDay = clock.totalDays;
    cache.needsBatch = beginDailyNeeds(state, cache);
  }
  const batch = cache.needsBatch;
  if (state.citizens.length === 0) {
    cache.needsBatch = null;
    return;
  }
  const end = Math.min(state.citizens.length, batch.index + NEEDS_BATCH_SIZE);
  for (; batch.index < end; batch.index++) {
    settleCitizenNeeds(state, cache, state.citizens[batch.index], batch);
  }
  if (batch.index >= state.citizens.length) {
    finishDailyNeeds(state, cache, batch, ctx);
    cache.needsBatch = null;
  }
}

/** 建立當日需求結算批次（城市層面嘅零售／消閒／水電可達性只計算一次） */
function beginDailyNeeds(state: GameState, cache: CitizenCache): NeedsBatchState {
  const clock = state.clock;
  const pop = state.citizens.length;
  let cityHasGoodsRetail = false;
  let cityHasLeisure = false;
  let cityHasPower = false;
  let cityHasWater = false;
  for (const b of state.buildings) {
    const def = BUILDINGS[b.key];
    if (!def || !b.active) continue;
    const kind = def.service?.kind;
    if (kind === 'market' && inventoryOf(b, 'goods') > 0.05) cityHasGoodsRetail = true;
    if (kind === 'park' || kind === 'promenade' || b.key === 'shoppingMall') cityHasLeisure = true;
    if (def.utility?.kind === 'power') cityHasPower = true;
    if (def.utility?.kind === 'water') cityHasWater = true;
  }
  return {
    day: clock.totalDays,
    index: 0,
    hungry: 0,
    thirsty: 0,
    cityHasGoodsRetail,
    cityHasLeisure,
    cityHasPower,
    cityHasWater,
    earlyGame: pop < 40,
    festivalBoost: Math.max(0, 12 - (clock.totalDays - state.finance.lastFestivalDay)),
  };
}

/** 一位市民的每日需求結算（食品／日用品／消閒／通勤重估／幸福度） */
function settleCitizenNeeds(state: GameState, cache: CitizenCache, citizen: Citizen, batch: NeedsBatchState): void {
  const clock = state.clock;
  const now = clock.minutes;
  const extras = getExtras(cache, citizen, now);
  extras.ateToday = false;
  extras.shoppedToday = 0;
  extras.leisureToday = 0;
  extras.foodBoughtToday = 0;

  const home = cachedBuilding(cache, citizen.homeId);
  const pos = home ? buildingCenter(home) : { x: citizen.x, y: citizen.y };
  const nearby = collectNearbyNeeds(state, cache, pos.x, pos.y);
  const cityHasGoodsRetail = batch.cityHasGoodsRetail;
  const cityHasLeisure = batch.cityHasLeisure;
  const earlyGame = batch.earlyGame;

  // ── 食品（每人每日 0.5，兒童 ×0.6）──
  const needFood = FOOD_PER_CITIZEN_PER_DAY * (citizen.age < WORKING_AGE ? CHILD_FOOD_FACTOR : 1);
  let ate = false;
  for (const market of nearby.markets) {
    if (inventoryOf(market.building, 'food') >= needFood && takeInventory(market.building, 'food', needFood)) {
      ate = true;
      break;
    }
  }
  if (!ate && cityGrainReserve(state) >= needFood) {
    // 住宅不在市場半徑內，但全城有存糧（工場／貨倉）→ 自家囤糧，部分滿足
    ate = consumeCityGrain(state, needFood * 0.8);
  }
  if (!ate && nearby.restaurant && citizen.money >= MEAL_COST) {
    // 出外用膳：食材庫存由 finance 每日扣除，市民端只付錢（不重複扣 food）
    if (inventoryOf(nearby.restaurant.building, 'food') >= 0.1) {
      citizen.money = clamp(citizen.money - MEAL_COST, 0, 2_000_000);
      nearby.restaurant.building.incomeThisMonth += MEAL_COST;
      extras.ateToday = true;
      ate = true;
    }
  }
  if (ate) {
    citizen.needs.food = clamp(citizen.needs.food + 12, 0, 100);
    extras.ateToday = true;
  } else {
    citizen.needs.food = clamp(citizen.needs.food - 18, 0, 100);
    batch.hungry++;
  }

  // ── 日用品（每人每日 0.2；街市／超市／便利店有貨時才扣）──
  let goodsConsumed = false;
  const needGoods = GOODS_PER_CITIZEN_PER_DAY * (citizen.age < WORKING_AGE ? CHILD_FOOD_FACTOR : 1);
  for (const market of nearby.markets) {
    if (inventoryOf(market.building, 'goods') >= needGoods && takeInventory(market.building, 'goods', needGoods)) {
      goodsConsumed = true;
      break;
    }
  }
  // 冇任何零售貨源：市民簡樸度日，需求緩慢回落但不會歸零（有貨源但太遠則扣得較重）
  const goodsDelta = goodsConsumed ? 9 : cityHasGoodsRetail ? -9 : earlyGame ? -3 : -5;
  citizen.needs.goods = clamp(citizen.needs.goods + goodsDelta, cityHasGoodsRetail ? 0 : 28, 100);
  if (!goodsConsumed) batch.thirsty++;

  // ── 消閒（公園／海濱／商場）──
  const hasLeisure = nearby.leisureSpots.length > 0;
  // 未有公園／海濱／商場時，市民在街邊散步消遣（需求下限 30，不會歸零）
  const leisureDelta = hasLeisure ? 8 : cityHasLeisure ? -7 : earlyGame ? -2 : -3;
  citizen.needs.leisure = clamp(citizen.needs.leisure + leisureDelta, cityHasLeisure ? 0 : 30, 100);

  // ── 通勤模式每 3 日按最新交通站點重估（新站落成後市民會轉搭車）──
  const work = cachedBuilding(cache, citizen.workId);
  if (work && clock.totalDays % 3 === 0) {
    citizen.commuteMode = pickCommuteMode(state, home, work);
  }
  const commuteMinutes = estimateCommuteMinutes(state, citizen, home, work);

  // ── 幸福度（population.ts 的公式；每日平滑）──
  const stats = state.stats;
  applyDailyHappiness(state, citizen, {
    serviceHappiness: nearby.serviceHappiness,
    hasMarket: nearby.hasMarket,
    hasRestaurant: nearby.hasRestaurant,
    commuteMinutes,
    commuteMode: citizen.commuteMode,
    festivalBoost: batch.festivalBoost,
    policeCoverage: typeof stats?.policeCoverage === 'number' ? stats.policeCoverage : 0,
    fireCoverage: typeof stats?.fireCoverage === 'number' ? stats.fireCoverage : 0,
    schoolCoverage: typeof stats?.schoolCoverage === 'number' ? stats.schoolCoverage : 0,
    hospitalCoverage: typeof stats?.hospitalCoverage === 'number' ? stats.hospitalCoverage : 0,
  });

  // ── 連續飢餓天數（人口系統判斷死亡／遷出）──
  if (citizen.needs.food < 15) extras.starveDays = Math.min(30, extras.starveDays + 1);
  else extras.starveDays = 0;

  if (citizen.needs.food < 20) batch.hungry++;
}

/** 當日需求結算完成：飢荒／缺貨／水電提示（避免洗版） */
function finishDailyNeeds(state: GameState, cache: CitizenCache, batch: NeedsBatchState, ctx: SimContext): void {
  const clock = state.clock;
  const pop = state.citizens.length;
  if (pop === 0) return;
  const hungry = batch.hungry;
  const thirsty = batch.thirsty;

  if (pop >= 6 && hungry / pop > 0.4 && clock.totalDays - cache.lastHungerToastDay >= 3) {
    cache.lastHungerToastDay = clock.totalDays;
    ctx.log('糧食短缺，市民面有飢色——多建農田／食品廠，並確保街市／超市有貨。', 'warn');
  }
  if (pop >= 10 && thirsty / pop > 0.5 && clock.totalDays - cache.lastShortageToastDay >= 4) {
    cache.lastShortageToastDay = clock.totalDays;
    ctx.log('部分社區買不到日用品——多在住宅區附近建街市／超市／便利店，並確保物流補貨。', 'warn');
  }
  // 水電：未建發電廠／水務設施時，人口到一定規模會感到不便（幸福受影響的原因提示）
  if (!batch.cityHasPower && pop >= 30 && clock.totalDays - cache.lastPowerToastDay >= 8) {
    cache.lastPowerToastDay = clock.totalDays;
    ctx.log('市內部分地區未供電，市民生活不便——人口 180 可解鎖發電廠，先以社區設施補足幸福。', 'warn');
  }
  if (!batch.cityHasWater && pop >= 50 && clock.totalDays - cache.lastWaterToastDay >= 8) {
    cache.lastWaterToastDay = clock.totalDays;
    ctx.log('部分地區未接駁食水，居民要落街取水——人口 90 可解鎖水務設施。', 'warn');
  }
}

// ─────────────────────────── 路徑移動 ───────────────────────────

function advanceWalker(
  state: GameState,
  cache: CitizenCache,
  citizen: Citizen,
  extras: CitizenExtras,
  step: number,
  ctx: SimContext,
): void {
  const path = citizen.path;
  const last = path.length - 1;

  // 目標被拆除（放置系統通常已處理，這裡保險）
  if (citizen.targetId >= 0 && !cachedBuilding(cache, citizen.targetId)) {
    resetToIdle(state, extras, citizen, randRange(15, 40));
    return;
  }

  if (last < 0) {
    arriveCitizen(state, cache, citizen, extras, ctx);
    return;
  }

  // 前方道路／行人路被拆 → 重新規劃
  const nextIndex = Math.min(last, Math.floor(citizen.pathProgress) + 1);
  const nextTile = path[nextIndex];
  if (nextTile !== undefined) {
    const nx = nextTile % state.width;
    const ny = Math.floor(nextTile / state.width);
    if (!isPassableTile(state, nx, ny)) {
      resetToIdle(state, extras, citizen, randRange(20, 60));
      return;
    }
  }

  citizen.pathProgress += step;
  if (citizen.pathProgress >= last) {
    citizen.pathProgress = last;
    updatePositionOnPath(state, citizen);
    arriveCitizen(state, cache, citizen, extras, ctx);
    return;
  }
  if (citizen.pathProgress < 0) citizen.pathProgress = 0;
  updatePositionOnPath(state, citizen);
}

/** 依 path／pathProgress 更新市民格座標（格中心座標系） */
function updatePositionOnPath(state: GameState, citizen: Citizen): void {
  const path = citizen.path;
  const width = state.width;
  const last = path.length - 1;
  if (last < 0) return;
  const rawIndex = Math.floor(citizen.pathProgress);
  const index = clamp(rawIndex, 0, last);
  const t = clamp(citizen.pathProgress - index, 0, 1);
  const a = path[index];
  const b = path[Math.min(index + 1, last)];
  const ax = (a % width) + 0.5;
  const ay = Math.floor(a / width) + 0.5;
  const bx = (b % width) + 0.5;
  const by = Math.floor(b / width) + 0.5;
  citizen.x = ax + (bx - ax) * t;
  citizen.y = ay + (by - ay) * t;
}

function resetToIdle(state: GameState, extras: CitizenExtras, citizen: Citizen, dwell: number): void {
  citizen.path = [];
  citizen.pathProgress = 0;
  citizen.targetId = -1;
  citizen.state = 'idle';
  extras.activity = 'idle';
  extras.pendingPlan = true;
  extras.tripStartedAt = -1;
  extras.rideRecorded = false;
  extras.busyUntil = state.clock.minutes + dwell;
}

// ─────────────────────────── 抵達 ───────────────────────────

function arriveCitizen(
  state: GameState,
  cache: CitizenCache,
  citizen: Citizen,
  extras: CitizenExtras,
  _ctx: SimContext,
): void {
  const now = state.clock.minutes;
  const target = cachedBuilding(cache, citizen.targetId);
  const activity = extras.activity;

  citizen.path = [];
  citizen.pathProgress = 0;

  // 通勤時間統計（只有真正的通勤行程才計，避免徘徊行程污染平均通勤時間）
  if (activity === 'commute' && extras.tripStartedAt >= 0) {
    const minutes = now - extras.tripStartedAt;
    recordCommuteArrival(state, extras.rideRecorded ? citizen.commuteMode : 'walk', minutes);
  }
  extras.tripStartedAt = -1;
  extras.rideRecorded = false;

  if (activity === 'wander' || citizen.targetId < 0) {
    citizen.targetId = -1;
    citizen.state = 'idle';
    extras.activity = 'idle';
    extras.busyUntil = now + randRange(60, 150);
    return;
  }

  if (!target) {
    resetToIdle(state, extras, citizen, randRange(15, 40));
    return;
  }

  // 抵達建築：站到建築中心附近
  const center = buildingCenter(target);
  citizen.x = center.x + randRange(-0.22, 0.22);
  citizen.y = center.y + randRange(-0.22, 0.22);

  // 回到家
  if (target.id === citizen.homeId) {
    citizen.state = 'home';
    extras.activity = 'home';
    extras.busyUntil = homeDwellUntil(state, citizen);
    return;
  }

  // 抵達工作地
  if (target.id === citizen.workId) {
    citizen.state = 'working';
    extras.activity = 'work';
    extras.busyUntil = nextWorkBreakMinute(state, citizen, extras);
    return;
  }

  const def = BUILDINGS[target.key];
  const serviceKind = def?.service?.kind;

  // 零售：街市／超市／便利店／商場
  if (serviceKind === 'market') {
    marketPurchase(citizen, target);
    if (target.key === 'shoppingMall') {
      citizen.needs.leisure = clamp(citizen.needs.leisure + 8, 0, 100);
      citizen.happiness = clamp(citizen.happiness + 1, 0, 100);
    }
    extras.shoppedToday++;
    citizen.state = 'shopping';
    extras.activity = 'shop';
    extras.busyUntil = now + randRange(18, 40);
    return;
  }

  // 茶餐廳／酒樓用膳
  if (serviceKind === 'restaurant') {
    if (inventoryOf(target, 'food') >= 0.2 && citizen.money >= MEAL_COST) {
      citizen.money = clamp(citizen.money - MEAL_COST, 0, 2_000_000);
      target.incomeThisMonth += MEAL_COST; // 店舖收入（利得稅稅基）
      citizen.needs.food = clamp(citizen.needs.food + 18, 0, 100);
      citizen.happiness = clamp(citizen.happiness + 1, 0, 100);
      extras.ateToday = true;
    }
    citizen.state = 'shopping';
    extras.activity = 'eat';
    extras.busyUntil = now + randRange(35, 60);
    return;
  }

  // 公園／海濱長廊：消閒
  if (serviceKind === 'park' || serviceKind === 'promenade') {
    citizen.needs.leisure = clamp(citizen.needs.leisure + 12, 0, 100);
    citizen.happiness = clamp(citizen.happiness + 1, 0, 100);
    extras.leisureToday++;
    citizen.state = 'shopping';
    extras.activity = 'leisure';
    extras.busyUntil = now + randRange(40, 75);
    return;
  }

  // 學校：上課
  if (serviceKind === 'school') {
    const dayStart = (state.clock.totalDays - 1) * 1440;
    const schoolEnd = dayStart + SCHOOL_END_HOUR * 60 + citizen.look * 30;
    citizen.state = 'shopping';
    extras.activity = 'school';
    extras.busyUntil = Math.max(now + 40, schoolEnd);
    return;
  }

  // 其他建築（醫院／警署等不會特地前往）：短暫停留後再規劃
  citizen.state = 'idle';
  extras.activity = 'idle';
  extras.busyUntil = now + randRange(20, 60);
}

// ─────────────────────────── 行為規劃 ───────────────────────────

function atBuilding(citizen: Citizen, id: number): boolean {
  return citizen.state !== 'walking' && citizen.targetId === id;
}

/** 規劃下一個目的地（每次 pendingPlan 時呼叫） */
function planCitizen(state: GameState, cache: CitizenCache, citizen: Citizen, extras: CitizenExtras): void {
  extras.pendingPlan = false;
  extras.retryAt = state.clock.minutes + 8;

  const clock = state.clock;
  const now = clock.minutes;
  const hour = clock.hour;
  const dayStart = (clock.totalDays - 1) * 1440;
  const home = cachedBuilding(cache, citizen.homeId);
  const work = cachedBuilding(cache, citizen.workId);
  const workReady = !!work && work.active && work.id !== home?.id;
  const atHome = home ? atBuilding(citizen, home.id) : false;
  const atWork = work ? atBuilding(citizen, work.id) : false;
  const storm = isTyphoon(state);
  const sunday = isSunday(state);
  const saturday = isSaturday(state);
  const worker = isWorkingAge(citizen) && workReady;
  const student =
    citizen.age >= SCHOOL_AGE && citizen.age < SCHOOL_END_AGE && !isWorkingAge(citizen) && !worker;
  const retired = citizen.age >= RETIRE_AGE;

  // ── 1) 深夜：回家睡覺 ──
  if (hour >= SLEEP_HOUR || hour < WAKE_HOUR) {
    sendHome(state, cache, citizen, extras, home, atHome, atWork);
    return;
  }

  // ── 2) 颱風（八號風球）：盡量留家 ──
  if (storm) {
    if (worker && atWork && !sunday) {
      // 已返到公司：留在公司直到放工（颱風下唔通勤）
      citizen.state = 'working';
      extras.activity = 'work';
      extras.busyUntil = Math.max(now + 30, workEndMinute(state, citizen));
      return;
    }
    if (home) {
      if (!atHome && tryGoTo(state, cache, citizen, extras, home, 'home', false)) return;
      citizen.state = 'home';
      extras.activity = 'home';
      extras.busyUntil = now + randRange(120, 240);
      return;
    }
    streetIdle(state, cache, citizen, extras, now + 180);
    return;
  }

  // ── 3) 清晨（06:00–08:00）：在家 ──
  if (hour < DEPART_HOUR) {
    sendHome(state, cache, citizen, extras, home, atHome, atWork);
    return;
  }

  // ── 4) 學生：上學 ──
  if (student) {
    const anchor = home ? buildingCenter(home) : { x: citizen.x, y: citizen.y };
    const school = nearestServicePoint(state, cache, anchor.x, anchor.y, 'school');
    const inSchoolHours = !sunday && hour >= SCHOOL_START_HOUR && now < dayStart + SCHOOL_END_HOUR * 60;
    if (school && inSchoolHours) {
      if (atBuilding(citizen, school.building.id)) {
        const schoolEnd = dayStart + SCHOOL_END_HOUR * 60 + citizen.look * 30;
        citizen.state = 'shopping';
        extras.activity = 'school';
        extras.busyUntil = Math.max(now + 40, schoolEnd);
        return;
      }
      extras.activity = 'school';
      if (tryGoTo(state, cache, citizen, extras, school.building, 'school', false)) return;
    }
    leisurePlan(state, cache, citizen, extras, home, work, atHome, atWork, anchor);
    return;
  }

  // ── 5) 在職人士：上班日 ──
  if (worker && !sunday) {
    const startMinute = workStartMinute(state, citizen);
    const endMinute = workEndMinute(state, citizen);

    // 上班時段
    if (now >= startMinute && now < endMinute) {
      const lunchStart = dayStart + LUNCH_START_HOUR * 60 + citizen.look * 25;
      const lunchEnd = dayStart + LUNCH_END_HOUR * 60 + citizen.look * 20;
      if (now >= lunchStart && now < lunchEnd && extras.lunchDoneDay !== clock.totalDays) {
        extras.lunchDoneDay = clock.totalDays;
        if (atWork) {
          const spot = pickLunchSpot(state, cache, citizen, work as Building);
          if (spot) {
            const foodTrip = BUILDINGS[spot.key]?.service?.kind === 'restaurant';
            if (tryGoTo(state, cache, citizen, extras, spot, foodTrip ? 'eat' : 'groceries', false)) return;
          }
          // 冇餐廳／街市：留在公司食飯盒
          citizen.state = 'working';
          extras.activity = 'lunch';
          extras.busyUntil = Math.max(now + 20, lunchEnd);
          return;
        }
      }
      if (!atWork) {
        if (tryGoTo(state, cache, citizen, extras, work as Building, 'commute', true)) return;
      }
      citizen.state = 'working';
      extras.activity = 'work';
      extras.busyUntil = nextWorkBreakMinute(state, citizen, extras);
      return;
    }

    // 返工前（08:00–09:00）：出門
    if (now >= dayStart + DEPART_HOUR * 60 && now < startMinute) {
      if (!atWork) {
        if (tryGoTo(state, cache, citizen, extras, work as Building, 'commute', true)) return;
      }
      citizen.state = 'idle';
      extras.activity = 'idle';
      extras.busyUntil = now + randRange(10, 30);
      return;
    }

    // 放工後：購物、消閒、回家
    const anchor = atWork && work ? buildingCenter(work) : home ? buildingCenter(home) : { x: citizen.x, y: citizen.y };
    leisurePlan(state, cache, citizen, extras, home, work, atHome, atWork, anchor);
    return;
  }

  // ── 6) 星期日／星期六下午／退休／失業：購物、消閒、回家 ──
  const anchor = home ? buildingCenter(home) : { x: citizen.x, y: citizen.y };
  leisurePlan(state, cache, citizen, extras, home, work, atHome, atWork, anchor);
}

/** 回家（在家的話改為留家）；沒有家 → 街上徘徊 */
function sendHome(
  state: GameState,
  cache: CitizenCache,
  citizen: Citizen,
  extras: CitizenExtras,
  home: Building | null,
  atHome: boolean,
  atWork: boolean,
): void {
  const now = state.clock.minutes;
  if (!home) {
    streetIdle(state, cache, citizen, extras, now + randRange(120, 240));
    return;
  }
  if (atHome) {
    citizen.state = 'home';
    extras.activity = 'home';
    extras.busyUntil = homeDwellUntil(state, citizen);
    return;
  }
  // 由公司返家，或搭公共交通的市民返家，都算一程通勤（可記交通人次）
  const commute = atWork || citizen.commuteMode !== 'walk';
  if (tryGoTo(state, cache, citizen, extras, home, commute ? 'commute' : 'home', commute)) return;
  citizen.state = 'idle';
  extras.activity = 'idle';
  extras.busyUntil = now + randRange(40, 100);
}

/**
 * 假日／放工後／失業／退休的行程：
 * 茶餐廳食飯 → 街市／超市購物 → 公園／海濱／商場消閒 → 回家。
 */
function leisurePlan(
  state: GameState,
  cache: CitizenCache,
  citizen: Citizen,
  extras: CitizenExtras,
  home: Building | null,
  work: Building | null,
  atHome: boolean,
  atWork: boolean,
  anchor: { x: number; y: number },
): void {
  const clock = state.clock;
  const hour = clock.hour;
  const night = hour >= CURFEW_HOUR || hour >= SLEEP_HOUR;
  const rainy = isWetWeather(state);

  if (!night) {
    // 1) 餐廳：食飯／飲茶（假日與放工後常見）
    if (citizen.money >= MEAL_COST && citizen.needs.food < 72) {
      const restaurant = nearestServicePoint(state, cache, anchor.x, anchor.y, 'restaurant');
      if (restaurant && inventoryOf(restaurant.building, 'food') >= 0.1) {
        const want = citizen.needs.food < 50 || Math.random() < 0.5;
        if (want && tryGoTo(state, cache, citizen, extras, restaurant.building, 'eat', false)) return;
      }
    }

    // 2) 購物：街市／超市／便利店（落雨天都買餸）
    if ((citizen.needs.food < 60 || citizen.needs.goods < 60) && extras.shoppedToday < 2) {
      const market = nearestMarketWithStock(state, cache, anchor.x, anchor.y);
      if (market && Math.random() < 0.75) {
        if (tryGoTo(state, cache, citizen, extras, market, 'groceries', false)) return;
      }
    }

    // 3) 消閒：公園／海濱／商場（落雨、颱風除外；長者與假日更常去）
    const wantLeisure = citizen.needs.leisure < 62 && extras.leisureToday < 2 && !rainy;
    const spontaneous = !rainy && (isSunday(state) || citizen.age >= RETIRE_AGE) && Math.random() < 0.35;
    if (wantLeisure || spontaneous || (citizen.needs.leisure < 40 && !rainy)) {
      const spot = nearestLeisureSpot(state, cache, anchor.x, anchor.y);
      if (spot && (wantLeisure || spontaneous)) {
        if (tryGoTo(state, cache, citizen, extras, spot, 'leisure', false)) return;
      }
    }
  }

  // 4) 回家／留家
  if (home) {
    if (atHome) {
      citizen.state = 'home';
      extras.activity = 'home';
      extras.busyUntil = homeDwellUntil(state, citizen);
      return;
    }
    const commute = atWork || citizen.commuteMode !== 'walk';
    if (tryGoTo(state, cache, citizen, extras, home, commute ? 'commute' : 'home', commute)) return;
  }
  // 無家可歸：街頭踱步
  streetIdle(state, cache, citizen, extras, clock.minutes + randRange(80, 180));
  void work;
}

/** 街頭徘徊／露宿（無家者、或路網未建成時） */
function streetIdle(
  state: GameState,
  cache: CitizenCache,
  citizen: Citizen,
  extras: CitizenExtras,
  busyUntil: number,
): void {
  const now = state.clock.minutes;
  const anchor = spawnAnchor(state, cache);
  const tiles = walkableTiles(state, cache);
  if (tiles.length > 0 && !isTyphoon(state) && now % 2 === 0) {
    // 在 spawn 附近隨機漫步
    const start = citizenStartTile(state, cache, citizen);
    let goal = -1;
    for (let attempt = 0; attempt < 10; attempt++) {
      const idx = tiles[randInt(0, tiles.length - 1)];
      const tx = idx % state.width + 0.5;
      const ty = Math.floor(idx / state.width) + 0.5;
      if ((tx - anchor.x) ** 2 + (ty - anchor.y) ** 2 < 18 * 18) {
        goal = idx;
        break;
      }
    }
    if (goal < 0) goal = tiles[randInt(0, tiles.length - 1)];
    if (start >= 0 && goal >= 0 && start !== goal) {
      const path = findWalkPath(state, cache, start, goal);
      if (path) {
        citizen.state = 'walking';
        citizen.path = path;
        citizen.pathProgress = 0;
        citizen.targetId = -1;
        extras.activity = 'wander';
        extras.tripStartedAt = -1;
        extras.rideRecorded = false;
        citizen.x = (path[0] % state.width) + 0.5;
        citizen.y = Math.floor(path[0] / state.width) + 0.5;
        return;
      }
    }
  }
  citizen.state = 'idle';
  citizen.targetId = -1;
  citizen.path = [];
  citizen.pathProgress = 0;
  extras.activity = 'idle';
  extras.busyUntil = busyUntil;
  if (tiles.length === 0) {
    // 尚未有路：留在 spawn 附近空地
    citizen.x = clamp(anchor.x + randRange(-2, 2), 1, state.width - 1);
    citizen.y = clamp(anchor.y + randRange(-2, 2), 1, state.height - 1);
  }
}

/** 午飯地點：優先茶餐廳（有食材），否則街市／超市 */
function pickLunchSpot(state: GameState, cache: CitizenCache, citizen: Citizen, work: Building): Building | null {
  const center = buildingCenter(work);
  const restaurant = nearestServicePoint(state, cache, center.x, center.y, 'restaurant');
  if (restaurant && inventoryOf(restaurant.building, 'food') >= 0.2 && citizen.money >= MEAL_COST) {
    return restaurant.building;
  }
  const market = nearestMarketWithStock(state, cache, center.x, center.y);
  return market;
}

/** 附近有貨的零售店（最近） */
function nearestMarketWithStock(
  state: GameState,
  cache: CitizenCache,
  x: number,
  y: number,
): Building | null {
  let best: Building | null = null;
  let bestDist = Infinity;
  for (const sp of servicePointsNear(state, cache, x, y, 'market')) {
    if (!marketHasGoods(sp.building)) continue;
    const d = (sp.x - x) ** 2 + (sp.y - y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = sp.building;
    }
  }
  return best;
}

/** 附近消閒地點（公園 → 海濱 → 商場，取最近可用者） */
function nearestLeisureSpot(state: GameState, cache: CitizenCache, x: number, y: number): Building | null {
  let best: Building | null = null;
  let bestScore = Infinity;
  for (const sp of servicePointsNear(state, cache, x, y)) {
    let weight = -1;
    if (sp.kind === 'park') weight = 0;
    else if (sp.kind === 'promenade') weight = 1;
    else if (sp.kind === 'market' && sp.building.key === 'shoppingMall') weight = 2;
    if (weight < 0) continue;
    const d = (sp.x - x) ** 2 + (sp.y - y) ** 2;
    const score = d + weight * 9;
    if (score < bestScore) {
      bestScore = score;
      best = sp.building;
    }
  }
  return best;
}

/** 沿行人路走到目標建築 */
function tryGoTo(
  state: GameState,
  cache: CitizenCache,
  citizen: Citizen,
  extras: CitizenExtras,
  target: Building,
  activity: CitizenActivity,
  isCommuteTrip: boolean,
): boolean {
  const now = state.clock.minutes;
  const origin = citizen.targetId >= 0 && citizen.state !== 'walking' ? cachedBuilding(cache, citizen.targetId) : null;

  let path: number[] | null = null;
  if (origin && origin.id !== target.id) {
    const hit = findWalkPathBetweenBuildings(state, cache, origin, target);
    if (hit) path = hit.path;
  }
  if (!path) {
    const start = citizenStartTile(state, cache, citizen);
    const goal = buildingWalkGoal(state, cache, target);
    if (start < 0 || goal < 0) {
      extras.retryAt = now + randRange(40, 100);
      return false;
    }
    path = findWalkPath(state, cache, start, goal);
  }
  if (!path || !path.length) {
    extras.retryAt = now + randRange(45, 120);
    return false;
  }

  // 通勤紀錄：搭公共交通的市民每次上車記一程（walk 不計車費）
  if (isCommuteTrip) {
    extras.tripStartedAt = now;
    if (citizen.commuteMode !== 'walk') {
      recordCommuteRide(state, citizen.commuteMode);
      extras.rideRecorded = true;
    } else {
      extras.rideRecorded = false;
    }
  } else {
    extras.tripStartedAt = -1;
    extras.rideRecorded = false;
  }

  citizen.state = 'walking';
  citizen.path = path;
  citizen.pathProgress = 0;
  citizen.targetId = target.id;
  extras.activity = activity;
  const first = path[0];
  citizen.x = (first % state.width) + 0.5;
  citizen.y = Math.floor(first / state.width) + 0.5;
  return true;
}

// ─────────────────────────── 作息時間 ───────────────────────────

function dayStartMinute(state: GameState): number {
  return (state.clock.totalDays - 1) * 1440;
}

/** 上班時間（絕對遊戲分鐘；09:00 + 每人少許偏差） */
function workStartMinute(state: GameState, citizen: Citizen): number {
  return dayStartMinute(state) + WORK_START_HOUR * 60 + citizen.look * 40;
}

/** 放工時間（星期六 13:00、平日 18:00 + 少許偏差；固定當日時間，不可跟隨 now 滑動） */
function workEndMinute(state: GameState, citizen: Citizen): number {
  const endHour = isSaturday(state) ? SATURDAY_END_HOUR : WORK_END_HOUR;
  return dayStartMinute(state) + endHour * 60 + citizen.look * 40;
}

/** 工作期間的下一個休息／放工時間：未食午飯 → 午飯時間；否則放工時間 */
function nextWorkBreakMinute(state: GameState, citizen: Citizen, extras: CitizenExtras): number {
  const now = state.clock.minutes;
  const end = workEndMinute(state, citizen);
  if (extras.lunchDoneDay === state.clock.totalDays) return Math.max(end, now + 5);
  const lunchStart = dayStartMinute(state) + LUNCH_START_HOUR * 60 + citizen.look * 25;
  if (now < lunchStart - 5) return Math.min(lunchStart, end);
  return Math.max(end, now + 5);
}

/**
 * 留家要留到幾時（絕對遊戲分鐘）：
 * 清晨 → 起床／出門；假日 → 一兩個鐘後再出門；晚上回家 → 明早起床。
 */
function homeDwellUntil(state: GameState, citizen: Citizen): number {
  const clock = state.clock;
  const now = clock.minutes;
  const hour = clock.hour;
  const dayStart = dayStartMinute(state);
  const wake = dayStart + WAKE_HOUR * 60 + citizen.look * 40;
  const sunday = isSunday(state);
  const saturday = isSaturday(state);
  const worker = isWorkingAge(citizen) && citizen.workId >= 0;
  const retired = citizen.age >= RETIRE_AGE;
  // 依通勤時間提前出門：搭港鐵／巴士的市民可以遲少少，長途步行者要早啲出門口
  let depart = dayStart + DEPART_HOUR * 60 + 15 + citizen.look * 40;
  if (worker) {
    const work = cachedBuilding(getCitizenCache(state), citizen.workId);
    const commuteMinutes = estimateCommuteMinutes(state, citizen, cachedBuilding(getCitizenCache(state), citizen.homeId), work);
    if (work) {
      const startMinute = workStartMinute(state, citizen);
      depart = clamp(startMinute - commuteMinutes - 5, wake + 10, startMinute);
    }
  }

  if (isTyphoon(state)) return now + randRange(120, 240);
  if (hour >= SLEEP_HOUR || hour >= CURFEW_HOUR) {
    return Math.max(now + 30, dayStart + 1440 + WAKE_HOUR * 60 + citizen.look * 40);
  }
  if (hour < BREAKFAST_HOUR) {
    // 未到起床時間 → 睡到起床；已過起床時間 → 小睡片刻後再規劃（避免同一分鐘無限重試）
    return now < wake ? wake : now + randRange(20, 50);
  }
  if (hour < DEPART_HOUR) {
    if (worker && !sunday) return Math.max(now + 10, depart);
    if (saturday && worker) return Math.max(now + 10, depart);
    return now + randRange(40, 100);
  }
  if (sunday || (saturday && hour >= SATURDAY_END_HOUR) || retired) return now + randRange(50, 140);
  if (hour >= WORK_END_HOUR) return now + randRange(50, 140);
  return now + randRange(70, 160);
}

// ─────────────────────────── 提供給 UI／測試的統計 ───────────────────────────

/** 目前在外活動（步行／工作／購物）的市民數 */
export function activeCitizenCount(state: GameState): number {
  let count = 0;
  for (const c of state.citizens) if (c.state !== 'home') count++;
  return count;
}

/** 各通勤模式人數（現況；UI 交通面板可用） */
export function commuteModeBreakdown(state: GameState): Record<TransitMode | 'walk', number> {
  const result: Record<TransitMode | 'walk', number> = { walk: 0, mtr: 0, bus: 0, tram: 0, ferry: 0 };
  for (const c of state.citizens) {
    if (c.workId < 0) continue;
    result[c.commuteMode] = (result[c.commuteMode] ?? 0) + 1;
  }
  return result;
}

/** 城內可住人口使用率（0..1，UI 用） */
export function housingOccupancy(state: GameState): number {
  let cap = 0;
  let used = 0;
  for (const b of state.buildings) {
    const c = housingCapacity(b);
    if (c <= 0 || !b.active) continue;
    cap += c;
    used += b.residents.length;
  }
  return cap > 0 ? used / cap : 0;
}

void MAX_POPULATION;
