/**
 * 公共交通系統（transport-dev）：港鐵／巴士／電車／渡輪的覆蓋率、每日載客、
 * 車費結算與颱風停航。
 *
 * 對外契約（docs/ARCHITECTURE.md §5.3）：
 *   pickCommuteMode(state, home, work): TransitMode | 'walk'
 *      → 由 citizens-dev 在 `src/sim/citizen-common.ts` 擁有及實作（市民通勤的權威），
 *        本檔 import 後 re-export，確保全專案只有一份同名行為。
 *   transitCoverage(state): { mode; coverage }[]           ARCHITECTURE 契約名
 *   computeTransitCoverage(state): TransitCoverageResult   完整覆蓋率（住宅＋就業＋容量）
 *   tickTransit(state, ctx): void                          每日結算（simulation.ts 跨日時呼叫）
 *   getTransitStats(state): TransitStats                   UI 交通面板用
 *   recordTransitRide(state, mode): void                   市民上車記一程（可選）
 *   nearestTransitStop(state, x, y, mode?): TransitStopHit | null
 *   typhoonSignalFor(state): 0 | 1 | 3 | 8
 *
 * 分工與帳務
 * - 車費收入由本檔入帳：`transit.faresThisMonth`、`finance.treasury`、
 *   `finance.incomeThisMonth`、`finance.incomeBreakdown.fares`。finance.ts 不可重複計。
 *   `transit.faresThisMonth` 的每月清零由 systems-dev 的 monthlyFinance 負責（本檔只累加）。
 * - 本檔每日更新 `stats.transitCoverage / ridership / avgCommute / typhoonSignal`；
 *   systems-dev 的 updateStats 可直接保留這些值。
 * - 市民通勤人次由 citizens-dev 在市民上車時 `state.transit.byMode[mode] += 1`；
 *   本檔以「與上次結算的差額」讀取（不 double count、不清走他們的紀錄），
 *   再加權「覆蓋率 × 就業人口 × 容量 × 天氣」估算，寫回最終當日載客。
 *
 * 座標：建築中心 = (x + w/2, y + h/2)，半徑以格為單位（歐氏距離）。
 */

import { BUILDINGS, TRANSIT_INFO, TRANSIT_SPEED, WEATHER_EFFECT } from '../core/config';
import type { Building, GameState, SimContext, TransitMode } from '../core/types';
import { pickCommuteMode } from './citizen-common';

// pickCommuteMode 由 citizens-dev 擁有（市民通勤用），在此 re-export 方便 UI／測試／其他模組引用。
export { pickCommuteMode };

// ─────────────────────────── 數值常數 ───────────────────────────

/** 各模式固定順序（統計／UI 穩定） */
export const TRANSIT_MODES: TransitMode[] = ['mtr', 'bus', 'tram', 'ferry'];

/**
 * 步行時間換算：1 格 ≈ 5.5 分鐘（以 400~500 米一格、5 km/h 步行估算）。
 * 只用作「通勤時間／模式比較／UI 平均通勤」的換算；市民實際移動速度由 citizens.ts 控制。
 */
const WALK_MINUTES_PER_TILE = 5.5;

/** 平均候車時間（分鐘）：港鐵密、渡輪疏 */
const AVG_WAIT_MINUTES: Record<TransitMode, number> = { mtr: 3, bus: 4.5, tram: 2.5, ferry: 6 };

/** 接駁步行（住宅→站、站→工作，合共約 2.5 格） */
const AVG_ACCESS_TILES = 2.5;

/** 通勤參與率：平日有多少在職市民當日需要通勤（其餘放假／在家工作） */
const WEEKDAY_PARTICIPATION = 0.72;
const WEEKEND_PARTICIPATION = 0.34;

/** 每名通勤者每日乘車次數（返工 + 放工，另加少量外出） */
const TRIPS_PER_COMMUTER = 2.1;

/** 小童／長者／學生票價優惠 → 平均票價折扣 */
const CONCESSION_RATIO = 0.9;

/** 站點容量不足時，覆蓋率最多打 6 折（容量足夠則 100%） */
const MIN_CAPACITY_COVERAGE_DISCOUNT = 0.6;

/** 模式對天氣的敏感度：颱風時港鐵地下段大致維持，路面／渡輪大受影響 */
function modeWeatherFactor(mode: TransitMode, state: GameState): number {
  const transitFactor = WEATHER_EFFECT[state.clock.weather]?.transit ?? 1;
  if (state.clock.weather === 'storm') {
    if (mode === 'ferry') return 0; // 八號風球渡輪停航
    if (mode === 'mtr') return Math.max(0.72, transitFactor);
    return transitFactor; // 巴士 0.35、電車 0.35
  }
  if (mode === 'mtr') return Math.max(0.82, transitFactor);
  return transitFactor;
}

/** 覆蓋率快取簽章（避免每幀重算；UI 每幀查詢亦可接受） */
function coverageKey(state: GameState): string {
  return `${state.buildings.length}:${state.ui.revision}:${state.clock.totalDays}:${state.citizens.length}`;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function buildingCenter(b: Building): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** 兩建築中心距離（格） */
function centerDistance(a: Building, b: Building): number {
  const ca = buildingCenter(a);
  const cb = buildingCenter(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}

// ─────────────────────────── 覆蓋率 ───────────────────────────

/** 單一模式的覆蓋率與容量資料 */
export interface ModeCoverage {
  mode: TransitMode;
  /** 營運中的站點數 */
  stations: number;
  /** 每日載客容量（Σ 各站 capacity） */
  capacity: number;
  /** 平均每程車費 */
  fare: number;
  /** (住宅 + 就業) / 2 的可達率 0..1（容量不足會打折） */
  coverage: number;
  /** 住宅覆蓋率（純距離，未計容量） */
  residentialCoverage: number;
  /** 就業覆蓋率（純距離，未計容量） */
  employmentCoverage: number;
  residentsServed: number;
  workersServed: number;
  /** 需求（載客）÷ 容量；> 1 代表繁忙時間擠迫 */
  load: number;
}

/** 全城覆蓋率（任一模式可達） */
export interface TransitCoverageResult {
  modes: ModeCoverage[];
  /** 就業人口加權、任一模式可達 0..1（對應 stats.transitCoverage，容量不足會打折） */
  overall: number;
  residentialOverall: number;
  employmentOverall: number;
  residents: number;
  workers: number;
  /** 營運中站點總數 */
  stations: number;
}

interface CoverageCache {
  key: string;
  result: TransitCoverageResult;
}

/** 每個 GameState 一份執行期快取（不進存檔；讀檔／新局自動建立新一組） */
interface TransitRuntime {
  coverage: CoverageCache | null;
  /** 上次結算寫入 byMode 的最終值（用於計算市民新增人次的差額） */
  lastApplied: Record<TransitMode, number> | null;
  lastAppliedDay: number;
  lastStormLogDay: number;
  lastOvercrowdLogDay: number;
  faresToday: number;
}

const runtimes = new WeakMap<GameState, TransitRuntime>();

function runtimeOf(state: GameState): TransitRuntime {
  let rt = runtimes.get(state);
  if (!rt) {
    rt = {
      coverage: null,
      lastApplied: null,
      lastAppliedDay: -1,
      lastStormLogDay: -999,
      lastOvercrowdLogDay: -999,
      faresToday: 0,
    };
    runtimes.set(state, rt);
  }
  return rt;
}

/** 所有交通站點建築（可選限制模式） */
function transitBuildings(state: GameState, mode?: TransitMode): Building[] {
  const result: Building[] = [];
  for (const building of state.buildings) {
    const transit = BUILDINGS[building.key]?.transit;
    if (!transit) continue;
    if (mode && transit.mode !== mode) continue;
    result.push(building);
  }
  return result;
}

interface PopulationPoint {
  building: Building;
  x: number;
  y: number;
  weight: number;
}

/** 住宅（實際居民加權）與就業（在職人數加權）人口點 */
function populationPoints(state: GameState): {
  homes: PopulationPoint[];
  jobs: PopulationPoint[];
  totalResidents: number;
  totalWorkers: number;
} {
  const homes: PopulationPoint[] = [];
  const jobs: PopulationPoint[] = [];
  let totalResidents = 0;
  let totalWorkers = 0;
  let jobsCapacity = 0;

  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    if (!def) continue;
    const center = buildingCenter(building);
    if (def.housing > 0 && building.residents.length > 0) {
      const weight = building.residents.length;
      homes.push({ building, x: center.x, y: center.y, weight });
      totalResidents += weight;
    }
    if (def.workers > 0 && building.active && building.workers.length > 0) {
      const weight = building.workers.length;
      jobs.push({ building, x: center.x, y: center.y, weight });
      totalWorkers += weight;
    }
    if (def.workers > 0 && building.active) jobsCapacity += def.workers;
  }

  // 未有人上班（開局／新市鎮）時以職位數目作「潛在就業人口」估算，
  // 否則交通覆蓋率會在有人上班前一直是 0，UI 難以反映站點價值。
  if (totalWorkers === 0 && jobsCapacity > 0) {
    for (const building of state.buildings) {
      const def = BUILDINGS[building.key];
      if (!def || def.workers <= 0 || !building.active) continue;
      const center = buildingCenter(building);
      jobs.push({ building, x: center.x, y: center.y, weight: def.workers });
      totalWorkers += def.workers;
    }
  }
  return { homes, jobs, totalResidents, totalWorkers };
}

/** 容量折扣：tripDemand 超過 capacity 時覆蓋率按比例下降（最低 6 折） */
function capacityDiscount(capacity: number, tripDemand: number): number {
  if (tripDemand <= 0) return 1;
  if (capacity <= 0) return MIN_CAPACITY_COVERAGE_DISCOUNT;
  const ratio = clamp(capacity / tripDemand, 0, 1);
  return MIN_CAPACITY_COVERAGE_DISCOUNT + (1 - MIN_CAPACITY_COVERAGE_DISCOUNT) * ratio;
}

/**
 * 計算公共交通覆蓋率（住宅人口、就業人口、各模式）＋容量負荷。
 * 以每個交通建築的 `transit.radius` 為圓，建築中心距離 <= 半徑即為覆蓋；
 * 站點總容量不足應付需求時，該模式覆蓋率按比例打折（最低 6 折）。
 * 結果有快取：每日 tickTransit 會強制重算一次；其他時候以簽章重用。
 */
export function computeTransitCoverage(state: GameState, force = false): TransitCoverageResult {
  const rt = runtimeOf(state);
  const key = coverageKey(state);
  if (!force && rt.coverage && rt.coverage.key === key) return rt.coverage.result;

  const { homes, jobs, totalResidents, totalWorkers } = populationPoints(state);
  const modes: ModeCoverage[] = [];
  // 任一模式可達的住宅／就業人口（用於整體覆蓋率）
  const coveredHomes = new Uint8Array(homes.length);
  const coveredJobs = new Uint8Array(jobs.length);
  let totalCapacity = 0;

  for (const mode of TRANSIT_MODES) {
    const stations = transitBuildings(state, mode).filter((b) => b.active);
    let capacity = 0;
    let fareSum = 0;
    const servedHome = new Uint8Array(homes.length);
    const servedJob = new Uint8Array(jobs.length);

    for (const station of stations) {
      const transit = BUILDINGS[station.key]?.transit;
      if (!transit) continue;
      capacity += transit.capacity;
      fareSum += transit.fare;
      const center = buildingCenter(station);
      const r2 = transit.radius * transit.radius;

      for (let i = 0; i < homes.length; i++) {
        const home = homes[i];
        const dx = home.x - center.x;
        const dy = home.y - center.y;
        if (dx * dx + dy * dy <= r2) {
          servedHome[i] = 1;
          coveredHomes[i] = 1;
        }
      }
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const dx = job.x - center.x;
        const dy = job.y - center.y;
        if (dx * dx + dy * dy <= r2) {
          servedJob[i] = 1;
          coveredJobs[i] = 1;
        }
      }
    }
    totalCapacity += capacity;

    let residentsServed = 0;
    for (let i = 0; i < homes.length; i++) if (servedHome[i]) residentsServed += homes[i].weight;
    let workersServed = 0;
    for (let i = 0; i < jobs.length; i++) if (servedJob[i]) workersServed += jobs[i].weight;

    const residentialCoverage = totalResidents > 0 ? clamp(residentsServed / totalResidents, 0, 1) : 0;
    const employmentCoverage = totalWorkers > 0 ? clamp(workersServed / totalWorkers, 0, 1) : 0;
    const proximity =
      totalResidents > 0 && totalWorkers > 0
        ? (residentialCoverage + employmentCoverage) / 2
        : Math.max(residentialCoverage, employmentCoverage);

    const servedCommuters = Math.min(residentsServed, workersServed);
    const tripDemand = servedCommuters * TRIPS_PER_COMMUTER;
    const discount = capacityDiscount(capacity, tripDemand);
    const load = capacity > 0 ? tripDemand / capacity : 0;

    modes.push({
      mode,
      stations: stations.length,
      capacity,
      fare: stations.length > 0 ? fareSum / stations.length : 0,
      coverage: proximity * discount,
      residentialCoverage,
      employmentCoverage,
      residentsServed,
      workersServed,
      load,
    });
  }

  // 整體（任一模式）覆蓋率
  let residentialOverall = 0;
  let employmentOverall = 0;
  let servedResidents = 0;
  let servedWorkers = 0;
  if (homes.length > 0) {
    for (let i = 0; i < homes.length; i++) if (coveredHomes[i]) servedResidents += homes[i].weight;
    residentialOverall = totalResidents > 0 ? clamp(servedResidents / totalResidents, 0, 1) : 0;
  }
  if (jobs.length > 0) {
    for (let i = 0; i < jobs.length; i++) if (coveredJobs[i]) servedWorkers += jobs[i].weight;
    employmentOverall = totalWorkers > 0 ? clamp(servedWorkers / totalWorkers, 0, 1) : 0;
  }
  const overallProximity = totalWorkers > 0 ? employmentOverall : residentialOverall;
  const overallDiscount = capacityDiscount(
    totalCapacity,
    Math.min(servedResidents, servedWorkers) * TRIPS_PER_COMMUTER,
  );

  const result: TransitCoverageResult = {
    modes,
    overall: overallProximity * overallDiscount,
    residentialOverall,
    employmentOverall,
    residents: totalResidents,
    workers: totalWorkers,
    stations: modes.reduce((sum, mode) => sum + mode.stations, 0),
  };
  rt.coverage = { key, result };
  return result;
}

/** ARCHITECTURE §5.3 契約：各模式覆蓋率陣列 */
export function transitCoverage(state: GameState): { mode: TransitMode; coverage: number }[] {
  return computeTransitCoverage(state).modes.map((mode) => ({ mode: mode.mode, coverage: mode.coverage }));
}

// ─────────────────────────── 站點查詢 ───────────────────────────

export interface TransitStopHit {
  building: Building;
  mode: TransitMode;
  /** 與查詢點的距離（格） */
  distance: number;
}

/**
 * 找出 (x,y) 附近最近的公共交通站點（可指定模式）。
 * x/y 為格座標；只回傳 radius 內、營運中的站點。
 */
export function nearestTransitStop(
  state: GameState,
  x: number,
  y: number,
  mode?: TransitMode,
): TransitStopHit | null {
  let best: TransitStopHit | null = null;
  for (const building of state.buildings) {
    const transit = BUILDINGS[building.key]?.transit;
    if (!transit || !building.active) continue;
    if (mode && transit.mode !== mode) continue;
    const center = buildingCenter(building);
    const distance = Math.hypot(center.x - x, center.y - y);
    if (distance > transit.radius) continue;
    if (!best || distance < best.distance) best = { building, mode: transit.mode, distance };
  }
  return best;
}

// ─────────────────────────── 市民上車記數 ───────────────────────────

/**
 * 市民上車／上船時記一程（可選）。直接 `state.transit.byMode[mode] += 1` 效果等同；
 * tickTransit 會以差額讀取，不會重複計算。walk 不應呼叫。
 */
export function recordTransitRide(state: GameState, mode: TransitMode): void {
  if (!TRANSIT_MODES.includes(mode)) return;
  state.transit.byMode[mode] = (state.transit.byMode[mode] ?? 0) + 1;
}

// ─────────────────────────── 每日結算 ───────────────────────────

/** 颱風信號：八號風球＝8；其他警告文字含三號／一號風球時對應回傳，否則 0 */
export function typhoonSignalFor(state: GameState): number {
  if (state.clock.weather === 'storm') return 8;
  const warning = state.clock.warning ?? '';
  if (warning.includes('三號') || warning.includes('3號')) return 3;
  if (warning.includes('一號') || warning.includes('1號')) return 1;
  return 0;
}

/** 在職市民人數（tickPopulation 之後呼叫，數字最新） */
function employedCitizens(state: GameState): number {
  let employed = 0;
  for (const citizen of state.citizens) if (citizen.workId >= 0) employed++;
  return employed;
}

/** 在職市民住所與工作地點平均距離（格）；無資料時用 12 格 */
function averageCommuteDistance(state: GameState): number {
  if (state.citizens.length === 0) return 12;
  const byId = new Map<number, Building>();
  for (const building of state.buildings) byId.set(building.id, building);
  let sum = 0;
  let count = 0;
  for (const citizen of state.citizens) {
    if (citizen.workId < 0 || citizen.homeId < 0) continue;
    const home = byId.get(citizen.homeId);
    const work = byId.get(citizen.workId);
    if (!home || !work) continue;
    sum += centerDistance(home, work);
    count++;
  }
  return count > 0 ? sum / count : 12;
}

/**
 * 每日交通結算（simulation.ts 跨日時、tickPopulation 之後呼叫）：
 *   1. 重算覆蓋率
 *   2. 讀取市民通勤紀錄（差額）＋覆蓋率／就業／容量／天氣估算 → 各模式當日載客
 *   3. 車費收入入帳（transit／finance）
 *   4. 更新 suspended（颱風停航）與 log
 *   5. 更新 stats.transitCoverage / ridership / avgCommute / typhoonSignal
 */
export function tickTransit(state: GameState, ctx: SimContext): void {
  const rt = runtimeOf(state);
  const { clock, transit, finance, stats } = state;
  const coverage = computeTransitCoverage(state, true);
  const stormy = clock.weather === 'storm';
  const wasSuspended = transit.suspended;

  // ── 颱風：渡輪停航／復航（time.ts 亦會同步此欄位；本檔只補交通訊息） ──
  transit.suspended = stormy;
  if (stormy && !wasSuspended && clock.totalDays - rt.lastStormLogDay >= 2) {
    rt.lastStormLogDay = clock.totalDays;
    ctx.log('八號風球吹襲，天星小輪全線停航，巴士及電車減班，市民提早回家。', 'warn');
  } else if (!stormy && wasSuspended) {
    ctx.log('風球除下，天星小輪復航，維港航線逐步回復正常。', 'good');
  }

  // ── 市民通勤紀錄差額（citizens-dev 直接遞增 byMode；我們不覆蓋其原始資料） ──
  const citizenRides = {} as Record<TransitMode, number>;
  for (const mode of TRANSIT_MODES) {
    const raw = Math.max(0, transit.byMode[mode] ?? 0);
    if (rt.lastApplied) {
      citizenRides[mode] = Math.max(0, raw - (rt.lastApplied[mode] ?? 0));
    } else {
      // 第一次結算（或讀檔後）：byMode 可能殘留上次結算值，以在職人數封頂避免爆數
      citizenRides[mode] = Math.min(raw, employedCitizens(state) * 3 + 10);
    }
  }

  // ── 載客需求：就業人口 × 參與率 × 每程次數，按各模式覆蓋分配 ──
  const employed = employedCitizens(state);
  const isWeekend = clock.weekday === 0 || clock.weekday === 6;
  const participation = isWeekend ? WEEKEND_PARTICIPATION : WEEKDAY_PARTICIPATION;
  const commuterTrips = employed * participation * TRIPS_PER_COMMUTER;

  const potential: Record<TransitMode, number> = { mtr: 0, bus: 0, tram: 0, ferry: 0 };
  const weatherFactors: Record<TransitMode, number> = { mtr: 1, bus: 1, tram: 1, ferry: 1 };
  let potentialSum = 0;
  for (const mode of TRANSIT_MODES) {
    const modeCoverage = coverage.modes.find((m) => m.mode === mode);
    if (!modeCoverage || modeCoverage.stations === 0 || modeCoverage.capacity <= 0) continue;
    const weatherFactor = modeWeatherFactor(mode, state);
    weatherFactors[mode] = weatherFactor;
    if (weatherFactor <= 0) continue;
    // 兩端都受覆蓋夾住的通勤者才可能搭此模式
    const served = Math.min(modeCoverage.residentsServed, modeCoverage.workersServed);
    const p = served * participation * TRIPS_PER_COMMUTER * weatherFactor;
    potential[mode] = p;
    potentialSum += p;
  }

  let totalTrips = 0;
  const dailyByMode = { mtr: 0, bus: 0, tram: 0, ferry: 0 } as Record<TransitMode, number>;
  const loadByMode = {} as Record<TransitMode, number>;
  for (const mode of TRANSIT_MODES) {
    const modeCoverage = coverage.modes.find((m) => m.mode === mode);
    const capacity = modeCoverage?.capacity ?? 0;
    let estimate = 0;
    if (potentialSum > 0 && commuterTrips > 0) {
      estimate = (potential[mode] / potentialSum) * commuterTrips;
    }
    // 市民實際紀錄（單程乘車）加權：多數只記去程，回程以 ×1.08 補回；
    // 若市民紀錄多過估算（他們按實際行程逐程記錄），尊重他們的數字。
    const recorded = citizenRides[mode] * 1.08;
    let ridership = Math.max(estimate, recorded);

    // 容量上限：超載時載客率下跌（擠迫），同時影響平均通勤時間
    let load: number;
    if (capacity > 0 && ridership > capacity) {
      ridership = capacity;
      load = 1;
    } else {
      load = capacity > 0 ? clamp(ridership / capacity, 0, 1) : 0;
    }
    const rounded = Math.round(ridership);
    dailyByMode[mode] = rounded;
    loadByMode[mode] = load;
    totalTrips += rounded;
  }

  // ── 車費收入入帳（本模組負責；finance.ts 不可重複計算；faresThisMonth 清零交給 systems-dev） ──
  let faresToday = 0;
  for (const mode of TRANSIT_MODES) {
    const fare = coverage.modes.find((m) => m.mode === mode)?.fare ?? 0;
    faresToday += dailyByMode[mode] * fare * CONCESSION_RATIO;
  }
  faresToday = Math.round(faresToday);
  rt.faresToday = faresToday;
  if (faresToday > 0) {
    transit.faresThisMonth = Math.round((transit.faresThisMonth ?? 0) + faresToday);
    finance.treasury += faresToday;
    finance.incomeThisMonth += faresToday;
    finance.incomeBreakdown.fares = (finance.incomeBreakdown.fares ?? 0) + faresToday;
  }

  // ── 寫回載客統計（市民原始紀錄已加權包含在內，不會遺失） ──
  transit.dailyRidership = totalTrips;
  for (const mode of TRANSIT_MODES) transit.byMode[mode] = dailyByMode[mode];
  rt.lastApplied = { ...dailyByMode };
  rt.lastAppliedDay = clock.totalDays;

  // ── 平均通勤時間（分鐘，以市民實際 commuteMode 分佈優先） ──
  const avgDistance = averageCommuteDistance(state);
  const walkMinutes = avgDistance * WALK_MINUTES_PER_TILE;
  const citizenModeCounts: Record<TransitMode | 'walk', number> = {
    mtr: 0,
    bus: 0,
    tram: 0,
    ferry: 0,
    walk: 0,
  };
  let citizenModeTotal = 0;
  for (const citizen of state.citizens) {
    if (citizen.workId < 0) continue;
    const mode = citizen.commuteMode ?? 'walk';
    if (mode in citizenModeCounts) {
      citizenModeCounts[mode]++;
      citizenModeTotal++;
    }
  }

  let avgCommute = 0;
  if (employed > 0 && citizenModeTotal > 0) {
    for (const mode of TRANSIT_MODES) {
      const share = citizenModeCounts[mode] / citizenModeTotal;
      if (share <= 0) continue;
      avgCommute +=
        share *
        (AVG_ACCESS_TILES * WALK_MINUTES_PER_TILE +
          AVG_WAIT_MINUTES[mode] +
          (avgDistance * WALK_MINUTES_PER_TILE) /
            (TRANSIT_SPEED[mode] * Math.max(0.2, weatherFactors[mode])));
    }
    avgCommute += (citizenModeCounts.walk / citizenModeTotal) * walkMinutes;
  } else if (employed > 0 && totalTrips > 0) {
    // 未有 commuteMode 資料：以載客分佈估算
    const totalRiders = Math.max(1, totalTrips);
    let transitMinutes = 0;
    for (const mode of TRANSIT_MODES) {
      const share = dailyByMode[mode] / totalRiders;
      if (share <= 0) continue;
      transitMinutes +=
        share *
        (AVG_ACCESS_TILES * WALK_MINUTES_PER_TILE +
          AVG_WAIT_MINUTES[mode] +
          (avgDistance * WALK_MINUTES_PER_TILE) /
            (TRANSIT_SPEED[mode] * Math.max(0.2, weatherFactors[mode])));
    }
    const transitShare = clamp(totalTrips / Math.max(1, employed * participation), 0, 1);
    avgCommute = transitMinutes * transitShare + walkMinutes * (1 - transitShare);
  } else if (employed > 0) {
    avgCommute = walkMinutes;
  }
  // 颱風／大霧時通勤時間延長（顯示用）
  if (stormy) avgCommute *= 1.25;

  // ── 更新 stats（systems-dev 的 updateStats 可直接沿用） ──
  stats.transitCoverage = Math.round(coverage.overall * 1000) / 1000;
  stats.ridership = totalTrips;
  stats.avgCommute = Math.round(avgCommute * 10) / 10;
  stats.typhoonSignal = typhoonSignalFor(state);

  // ── 擠迫提示（節流，避免洗版） ──
  if (clock.totalDays - rt.lastOvercrowdLogDay >= 6) {
    for (const mode of TRANSIT_MODES) {
      if (loadByMode[mode] >= 0.98 && dailyByMode[mode] > 0) {
        rt.lastOvercrowdLogDay = clock.totalDays;
        ctx.log(
          `【${TRANSIT_INFO[mode].name}】繁忙時間嚴重擠迫（載客 ${dailyByMode[mode]} 人），市民要求增加路線或擴建車站。`,
          'warn',
        );
        break;
      }
    }
  }
}

// ─────────────────────────── UI 查詢 ───────────────────────────

/** UI 交通面板：單一模式 */
export interface TransitModeStats {
  mode: TransitMode;
  name: string;
  emoji: string;
  color: string;
  /** 營運中站點數 */
  stations: number;
  capacity: number;
  fare: number;
  coverage: number;
  residentialCoverage: number;
  employmentCoverage: number;
  /** 當日載客（state.transit.byMode） */
  ridership: number;
  /** 佔整體載客比例 0..1 */
  share: number;
  /** 是否停航（颱風時的渡輪） */
  suspended: boolean;
  /** 容量負荷 0..1 */
  load: number;
}

/** UI 交通面板：全城 */
export interface TransitStats {
  modes: TransitModeStats[];
  stations: number;
  /** 就業人口加權整體覆蓋率（= stats.transitCoverage） */
  coverage: number;
  residentialCoverage: number;
  employmentCoverage: number;
  ridership: number;
  /** 當日車費收入（最近一次結算） */
  faresToday: number;
  /** 本月車費收入累計 */
  faresThisMonth: number;
  suspended: boolean;
  typhoonSignal: number;
  avgCommute: number;
  /** 整體容量負荷 0..1 */
  load: number;
}

/** 給 UI 的交通統計（每幀可呼叫；覆蓋率有快取） */
export function getTransitStats(state: GameState): TransitStats {
  const rt = runtimeOf(state);
  const coverage = computeTransitCoverage(state);
  const totalRidership = state.transit.dailyRidership ?? 0;
  const suspended = state.transit.suspended;

  const modes: TransitModeStats[] = TRANSIT_MODES.map((mode) => {
    const info = TRANSIT_INFO[mode];
    const modeCoverage = coverage.modes.find((m) => m.mode === mode);
    const ridership = state.transit.byMode[mode] ?? 0;
    return {
      mode,
      name: info.name,
      emoji: info.emoji,
      color: info.color,
      stations: modeCoverage?.stations ?? 0,
      capacity: modeCoverage?.capacity ?? 0,
      fare: modeCoverage?.fare ?? 0,
      coverage: modeCoverage?.coverage ?? 0,
      residentialCoverage: modeCoverage?.residentialCoverage ?? 0,
      employmentCoverage: modeCoverage?.employmentCoverage ?? 0,
      ridership,
      share: totalRidership > 0 ? ridership / totalRidership : 0,
      suspended: suspended && mode === 'ferry',
      load: modeCoverage?.load ?? 0,
    };
  });

  const totalCapacity = modes.reduce((sum, mode) => sum + mode.capacity, 0);
  return {
    modes,
    stations: coverage.stations,
    coverage: coverage.overall,
    residentialCoverage: coverage.residentialOverall,
    employmentCoverage: coverage.employmentOverall,
    ridership: totalRidership,
    faresToday: rt.faresToday,
    faresThisMonth: state.transit.faresThisMonth,
    suspended,
    typhoonSignal: typhoonSignalFor(state),
    avgCommute: state.stats.avgCommute,
    load: totalCapacity > 0 ? Math.min(1, totalRidership / totalCapacity) : 0,
  };
}
