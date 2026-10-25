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

import {
  BUILDINGS,
  RAIL_CONFIG,
  TRANSIT_INFO,
  TRANSIT_LINE_CONFIG,
  TRANSIT_SPEED,
  WEATHER_EFFECT,
} from '../core/config';
import type {
  Building,
  GameState,
  SimContext,
  TransitLine,
  TransitLineInput,
  TransitLineMode,
  TransitMode,
} from '../core/types';
import { pickCommuteMode } from './citizen-common';
import { findPathBetweenBuildings, roadAccessTiles } from './pathfinding';
import { worldRevisionOf } from './placement';
import { computeRailNetwork, getRailStats, tickRail, type RailTickSummary } from './rail';

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

/** Round 6：有鐵路網時，舊 mtr 半徑玩法只保留 30%（其餘由 tickRail 提供，避免 double count） */
const RAIL_LEGACY_MTR_SHARE = 0.3;

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
  return `${state.buildings.length}:${state.ui.revision}:${worldRevisionOf()}:${state.clock.totalDays}:${state.citizens.length}`;
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
  /** Round 5：只計舊站點半徑（未計路線站點）的服務人口／容量，用於 70/30 split */
  legacyResidentsServed?: number;
  legacyWorkersServed?: number;
  legacyCapacity?: number;
  /** Round 5：舊站點（未計路線）平均票價 */
  legacyFare?: number;
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
  // ── Round 5：巴士／小巴路線 ──
  /** 路線每日結算（同日重複呼叫 no-op） */
  lineLastDay: number;
  lineSummary: TransitLineDailySummary | null;
  /** line.id → 合併道路 path 快取（key 含 ui.revision／站點／loop） */
  linePathCache: Map<number, { key: string; path: number[] | null }>;
  lastLineLogDay: number;
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
      lineLastDay: -1,
      lineSummary: null,
      linePathCache: new Map(),
      lastLineLogDay: -999,
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

/** 覆蓋率計算用嘅站點規格（舊站點與 Round 5 路線站點共用） */
interface StationSpec {
  x: number;
  y: number;
  /** 半徑平方 */
  r2: number;
  capacity: number;
  fare: number;
  /** 覆蓋權重 0..1（Round 6：未接駁鐵路嘅 mtrStation 用 RAIL_CONFIG.isolatedStationCoverage 打折） */
  weight?: number;
}

/**
 * 把一批站點標記到住宅／就業點陣列（Float32Array 記錄最大覆蓋權重，可做局部折扣）。
 * 同一點被多個站覆蓋時取最大權重（例如接駁站 1.0 vs 孤立站 0.35）。
 */
function markServedSpecs(
  specs: StationSpec[],
  homes: PopulationPoint[],
  jobs: PopulationPoint[],
  servedHome: Float32Array,
  servedJob: Float32Array,
): void {
  for (const spec of specs) {
    const weight = spec.weight ?? 1;
    if (weight <= 0) continue;
    for (let i = 0; i < homes.length; i++) {
      if (servedHome[i] >= weight) continue;
      const dx = homes[i].x - spec.x;
      const dy = homes[i].y - spec.y;
      if (dx * dx + dy * dy <= spec.r2) servedHome[i] = weight;
    }
    for (let i = 0; i < jobs.length; i++) {
      if (servedJob[i] >= weight) continue;
      const dx = jobs[i].x - spec.x;
      const dy = jobs[i].y - spec.y;
      if (dx * dx + dy * dy <= spec.r2) servedJob[i] = weight;
    }
  }
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
  const coveredHomes = new Float32Array(homes.length);
  const coveredJobs = new Float32Array(jobs.length);
  let totalCapacity = 0;

  // Round 6：鐵路網接駁狀態（有 rail 時，未接駁 mtrStation 覆蓋率打折）
  const railNetwork = computeRailNetwork(state);
  const hasRail = railNetwork.length > 0;
  const railConnectedStationIds = new Set(railNetwork.connectedStationIds);

  for (const mode of TRANSIT_MODES) {
    const servedHome = new Float32Array(homes.length);
    const servedJob = new Float32Array(jobs.length);

    // 舊玩法：交通建築本身的 radius／capacity（bus 為巴士總站；tram/mtr/ferry 不變）
    const legacySpecs: StationSpec[] = [];
    for (const station of transitBuildings(state, mode)) {
      if (!station.active) continue;
      const transit = BUILDINGS[station.key]?.transit;
      if (!transit) continue;
      const center = buildingCenter(station);
      let weight = 1;
      if (mode === 'mtr' && hasRail && !railConnectedStationIds.has(station.id)) {
        // 未接駁鐵路網：舊半徑玩法仍運作，但覆蓋率打折（RAIL_CONFIG.isolatedStationCoverage）
        weight = RAIL_CONFIG.isolatedStationCoverage;
      }
      legacySpecs.push({
        x: center.x,
        y: center.y,
        r2: transit.radius * transit.radius,
        capacity: transit.capacity,
        fare: transit.fare,
        weight,
      });
    }
    markServedSpecs(legacySpecs, homes, jobs, servedHome, servedJob);
    let legacyResidentsServed = 0;
    let legacyWorkersServed = 0;
    for (let i = 0; i < homes.length; i++) if (servedHome[i] > 0) legacyResidentsServed += homes[i].weight * servedHome[i];
    for (let i = 0; i < jobs.length; i++) if (servedJob[i] > 0) legacyWorkersServed += jobs[i].weight * servedJob[i];
    let legacyCapacity = 0;
    let legacyFareWeight = 0;
    let legacyFareSum = 0;
    for (const spec of legacySpecs) {
      legacyCapacity += spec.capacity;
      legacyFareSum += spec.fare * spec.capacity;
      legacyFareWeight += spec.capacity;
    }
    if (legacyFareWeight > 0) legacyFareSum /= legacyFareWeight;
    else legacyFareSum = legacySpecs.length > 0 ? legacySpecs[0].fare : 0;

    // Round 5：路線站點（3 格）併入 bus 模式覆蓋（巴士＋小巴都計 bus 模式）
    const lineSpecs: StationSpec[] = [];
    let lineCapacity = 0;
    let lineFareWeighted = 0;
    let lineFareWeight = 0;
    if (mode === 'bus') {
      const seenStops = new Set<number>();
      for (const line of getTransitLines(state)) {
        if (line.suspended) continue;
        let validStops = 0;
        for (const stopId of line.stopIds) {
          const stop = findBuildingById(state, stopId);
          if (!stop || !stop.active || !isLineStopBuilding(stop, line.mode)) continue;
          validStops++;
          if (seenStops.has(stop.id)) continue;
          seenStops.add(stop.id);
          const center = buildingCenter(stop);
          lineSpecs.push({
            x: center.x,
            y: center.y,
            r2: LINE_STOP_RADIUS * LINE_STOP_RADIUS,
            capacity: 0,
            fare: 0,
          });
        }
        if (validStops >= 2) {
          const lineCap =
            line.vehicleCount *
            TRANSIT_LINE_CONFIG.capacityPerVehicle[line.mode] *
            TRANSIT_LINE_CONFIG.tripsPerVehiclePerDay[line.mode];
          lineCapacity += lineCap;
          lineFareWeighted += line.fare * lineCap;
          lineFareWeight += lineCap;
        }
      }
    }
    markServedSpecs(lineSpecs, homes, jobs, servedHome, servedJob);

    const capacity = legacyCapacity + lineCapacity;
    const stationCount = legacySpecs.length + lineSpecs.length;

    let residentsServed = 0;
    for (let i = 0; i < homes.length; i++) if (servedHome[i] > 0) residentsServed += homes[i].weight * servedHome[i];
    let workersServed = 0;
    for (let i = 0; i < jobs.length; i++) if (servedJob[i] > 0) workersServed += jobs[i].weight * servedJob[i];
    for (let i = 0; i < homes.length; i++) coveredHomes[i] = Math.max(coveredHomes[i], servedHome[i]);
    for (let i = 0; i < jobs.length; i++) coveredJobs[i] = Math.max(coveredJobs[i], servedJob[i]);
    totalCapacity += capacity;

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
    const averageFare =
      legacyFareWeight + lineFareWeight > 0
        ? (legacyFareSum * legacyFareWeight + lineFareWeighted) / (legacyFareWeight + lineFareWeight)
        : legacyFareSum;

    modes.push({
      mode,
      stations: stationCount,
      capacity,
      fare: averageFare,
      coverage: proximity * discount,
      residentialCoverage,
      employmentCoverage,
      residentsServed,
      workersServed,
      load,
      legacyResidentsServed,
      legacyWorkersServed,
      legacyCapacity,
      legacyFare: legacyFareSum,
    });
  }

  // 整體（任一模式）覆蓋率
  let residentialOverall = 0;
  let employmentOverall = 0;
  let servedResidents = 0;
  let servedWorkers = 0;
  if (homes.length > 0) {
    for (let i = 0; i < homes.length; i++) if (coveredHomes[i] > 0) servedResidents += homes[i].weight * coveredHomes[i];
    residentialOverall = totalResidents > 0 ? clamp(servedResidents / totalResidents, 0, 1) : 0;
  }
  if (jobs.length > 0) {
    for (let i = 0; i < jobs.length; i++) if (coveredJobs[i] > 0) servedWorkers += jobs[i].weight * coveredJobs[i];
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
  // Round 5／6：先結算巴士小巴路線＋鐵路（兩者同日 idempotent；simulation 之後再加呼叫都安全）
  const lineSummary = tickTransitLines(state, ctx);
  const linesActive = lineSummary.activeLines > 0;
  const railTick = tickRail(state, ctx);
  const railActive = railTick.connectedStations > 0 && railTick.length > 0;
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
    // 有路線營運時，bus 由 tickTransitLines 單獨結算；有鐵路網時 mtr 由 tickRail 結算
    // （兩者下面 override），唔參與按比例分配，避免 double count
    if (mode === 'bus' && linesActive) continue;
    if (mode === 'mtr' && railActive) continue;
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
  }

  // ── Round 5：有路線營運時，bus 模式 = 路線載客 + 舊站點半徑 30%（避免 double count） ──
  let busFareOverride: number | null = null;
  if (linesActive) {
    const busEntry = coverage.modes.find((m) => m.mode === 'bus');
    const legacyResidents = busEntry?.legacyResidentsServed ?? 0;
    const legacyWorkers = busEntry?.legacyWorkersServed ?? 0;
    const legacyWeather = Math.max(0, modeWeatherFactor('bus', state));
    const legacyBusRides = Math.round(
      Math.min(legacyResidents, legacyWorkers) * participation * TRIPS_PER_COMMUTER * legacyWeather,
    );
    const keptLegacy = Math.round(legacyBusRides * LINE_LEGACY_BUS_SHARE);
    dailyByMode.bus = lineSummary.ridership + keptLegacy;
    loadByMode.bus =
      busEntry && busEntry.capacity > 0 ? clamp(dailyByMode.bus / busEntry.capacity, 0, 1) : 0;
    busFareOverride = Math.round(
      lineSummary.fares + keptLegacy * (busEntry?.legacyFare ?? 5) * CONCESSION_RATIO,
    );
  }
  // ── Round 6：有鐵路網時，mtr 模式 = 鐵路網載客 + 舊站點半徑 30%（避免 double count） ──
  let mtrFareOverride: number | null = null;
  if (railActive) {
    const mtrEntry = coverage.modes.find((m) => m.mode === 'mtr');
    const legacyResidents = mtrEntry?.legacyResidentsServed ?? 0;
    const legacyWorkers = mtrEntry?.legacyWorkersServed ?? 0;
    const legacyWeather = Math.max(0, modeWeatherFactor('mtr', state));
    const legacyMtrRides = Math.round(
      Math.min(legacyResidents, legacyWorkers) * participation * TRIPS_PER_COMMUTER * legacyWeather,
    );
    const keptLegacy = Math.round(legacyMtrRides * RAIL_LEGACY_MTR_SHARE);
    dailyByMode.mtr = railTick.ridership + keptLegacy;
    loadByMode.mtr =
      mtrEntry && mtrEntry.capacity > 0 ? clamp(dailyByMode.mtr / mtrEntry.capacity, 0, 1) : 0;
    mtrFareOverride = Math.round(
      railTick.fares + keptLegacy * (mtrEntry?.legacyFare ?? 8) * CONCESSION_RATIO,
    );
  }
  for (const mode of TRANSIT_MODES) totalTrips += dailyByMode[mode];

  // ── 車費收入入帳（本模組負責；finance.ts 不可重複計算；faresThisMonth 清零交給 systems-dev） ──
  let faresToday = 0;
  for (const mode of TRANSIT_MODES) {
    // bus／mtr：路線／鐵路收入已於 tickTransitLines／tickRail 入帳，
    // 呢度只補舊站點半徑部分（避免 double count）
    if (mode === 'bus' && busFareOverride !== null) {
      faresToday += busFareOverride;
      continue;
    }
    if (mode === 'mtr' && mtrFareOverride !== null) {
      faresToday += mtrFareOverride;
      continue;
    }
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


// ─────────────────────────── Round 5：巴士／小巴路線 ───────────────────────────

/** 路線站點服務半徑（格）：居民／職位以此計潛在客流 */
const LINE_STOP_RADIUS = 3;
/** 每格路線預計行車分鐘（雙向 ×2；簡化用於班距計算） */
const LINE_MINUTES_PER_TILE = 1;
/** 班距（分鐘）門檻：>15 吸引力 ×0.5、>30 ×0.2 */
const LINE_HEADWAY_FAIR = 15;
const LINE_HEADWAY_POOR = 30;
/** 有路線營運時，舊「巴士總站半徑」玩法只保留 30% 載客（其餘由路線提供，避免 double count） */
const LINE_LEGACY_BUS_SHARE = 0.3;
/** 同時存在的路線數上限 */
const MAX_ACTIVE_LINES = 30;
/** 票價 ≤ 此值無吸引力懲罰（ROUND5_CONTRACTS §3.2：$6） */
const LINE_FARE_BASE = 6;
/** 票價每 +$1 的吸引力跌幅 */
const LINE_FARE_STEP_PENALTY = 0.08;
/** 票價吸引力下限 */
const LINE_MIN_ATTRACTIVENESS = 0.3;
/** 假日通勤客流係數 */
const LINE_WEEKEND_DEMAND = 0.62;

/** 建立／修改／刪除路線的回傳（GameActions 直接用） */
export interface TransitLineActionResult {
  ok: boolean;
  reason?: string;
  id?: number;
  cost?: number;
}

export interface TransitLineUpdateResult {
  ok: boolean;
  reason?: string;
  cost?: number;
  refund?: number;
}

/** 路線每日結算摘要（tickTransitLines 回傳；tickTransit 內部整合用） */
export interface TransitLineDailySummary {
  day: number;
  /** 營運中路線數（未停駛） */
  activeLines: number;
  ridership: number;
  fares: number;
  costs: number;
  profit: number;
}

/** UI 用：單一路線統計 */
export interface TransitLineStatsRow {
  id: number;
  name: string;
  mode: TransitLineMode;
  color: string;
  loop: boolean;
  suspended: boolean;
  /** 站點數 */
  stops: number;
  vehicleCount: number;
  fare: number;
  /** 當日載客 */
  ridership: number;
  /** 當日容量（車數 × 載客量 × 班次 × 天氣係數） */
  capacity: number;
  /** 載客率 0..1+ */
  loadPct: number;
  /** 當日收入 */
  fares: number;
  /** 當日營運成本 */
  costs: number;
  /** 當日盈利 */
  profit: number;
  /** 本月累計車費 */
  monthlyFares: number;
  /** 路線總長（格） */
  routeTiles: number;
  /** 預計班距（分鐘） */
  headwayMinutes: number;
}

export interface TransitLineStats {
  lines: TransitLineStatsRow[];
  count: number;
  /** 營運中路線數 */
  activeCount: number;
  totalRidership: number;
  totalRevenue: number;
  totalCost: number;
  totalProfit: number;
  totalVehicles: number;
}

// ── 路線基本工具 ──

/** 確保 state.transitLines 存在（新局／舊存檔兼容） */
export function getTransitLines(state: GameState): TransitLine[] {
  if (!state.transitLines) state.transitLines = [];
  return state.transitLines;
}

function findBuildingById(state: GameState, id: number): Building | undefined {
  for (const building of state.buildings) if (building.id === id) return building;
  return undefined;
}

/** 該建築可否作為指定模式的路線站（busStop／busTerminus，小巴站／小巴車廠） */
function isLineStopBuilding(building: Building, mode: TransitLineMode): boolean {
  const def = BUILDINGS[building.key];
  if (!def) return false;
  if (def.stopMode === mode) return true;
  // minibusDepot：config 暫未有 stopMode；按規格可作小巴站（兼容兩種情況）
  return mode === 'minibus' && building.key === 'minibusDepot';
}

/** 指定模式可作路線站的建築（UI 選站用） */
export function stopBuildingsForMode(state: GameState, mode: TransitLineMode): Building[] {
  const result: Building[] = [];
  for (const building of state.buildings) {
    if (isLineStopBuilding(building, mode)) result.push(building);
  }
  return result;
}

function lineModeLabel(mode: TransitLineMode): string {
  return mode === 'bus' ? '巴士' : '小巴';
}

/** 線路總站／車廠（depot）：bus 線需 ≥1 busTerminus；小巴線需 ≥1 minibusDepot */
function hasLineDepot(state: GameState, mode: TransitLineMode): boolean {
  const depotKey = mode === 'bus' ? 'busTerminus' : 'minibusDepot';
  for (const building of state.buildings) {
    if (building.key === depotKey && building.active) return true;
  }
  return false;
}

function parseCssColorInt(color: string): number | null {
  if (typeof color !== 'string') return null;
  const match = /^#([0-9a-fA-F]{6})$/.exec(color.trim());
  if (!match) return null;
  return parseInt(match[1], 16);
}

function lineColorInt(line: TransitLine): number {
  return parseCssColorInt(line.color) ?? 0xd9b23f;
}

/** 路線站點（Building 陣列，過濾已拆／停用） */
function lineStopBuildings(state: GameState, line: TransitLine): Building[] {
  const result: Building[] = [];
  for (const id of line.stopIds) {
    const building = findBuildingById(state, id);
    if (building) result.push(building);
  }
  return result;
}

/** 路線營運所需：所有站點存活、active、貼路 */
function lineStopsOperational(state: GameState, line: TransitLine): boolean {
  if (line.stopIds.length < 2) return false;
  for (const id of line.stopIds) {
    const building = findBuildingById(state, id);
    if (!building || !building.active || !isLineStopBuilding(building, line.mode)) return false;
    if (roadAccessTiles(state, building).length === 0) return false;
  }
  return true;
}

/** 逐對站點驗證道路連通；回傳第一個不通的站名（全部可通回傳 null） */
function findUnreachableStopPair(state: GameState, line: TransitLine): string | null {
  const stops = lineStopBuildings(state, line);
  if (stops.length < 2) return '站點不足';
  const pairs: number[] = [];
  for (let i = 0; i < stops.length - 1; i++) pairs.push(i);
  if (line.loop) pairs.push(stops.length - 1);
  for (const i of pairs) {
    const from = stops[i];
    const to = stops[(i + 1) % stops.length];
    if (from.id === to.id) continue;
    if (!findPathBetweenBuildings(state, from.id, to.id)) {
      return `${BUILDINGS[from.key]?.name ?? '站'} 同 ${BUILDINGS[to.key]?.name ?? '站'}`;
    }
  }
  return null;
}

/**
 * 路線合併道路 path（站點之間順序連接；循環線最後補回起點，形成閉環）。
 * 結果快取（line.id + ui.revision + 站點 + loop）；道路／建築變更會令 ui.revision 改變。
 */
export function lineRoadPath(state: GameState, line: TransitLine): number[] | null {
  const rt = runtimeOf(state);
  const stopsKey = `${line.stopIds.join(',')}:${line.loop ? 1 : 0}`;
  const key = `${state.ui.revision}:${stopsKey}`;
  const cached = rt.linePathCache.get(line.id);
  if (cached && cached.key === key) return cached.path;

  const stops = lineStopBuildings(state, line);
  let path: number[] | null = [];
  if (stops.length < 2) {
    path = null;
  } else {
    const pairs: number[] = [];
    for (let i = 0; i < stops.length - 1; i++) pairs.push(i);
    if (line.loop) pairs.push(stops.length - 1);
    for (const i of pairs) {
      const from = stops[i];
      const to = stops[(i + 1) % stops.length];
      if (from.id === to.id) continue;
      const segment = findPathBetweenBuildings(state, from.id, to.id);
      if (!segment || segment.length === 0) {
        path = null;
        break;
      }
      if (path.length === 0) path.push(...segment);
      else path.push(...segment.slice(1));
    }
    // 循環線：補回起點，令車輛可由尾格直接回捲到頭格
    if (path && line.loop && path.length > 1 && path[0] !== path[path.length - 1]) path.push(path[0]);
    if (path && path.length < 2) path = null;
  }
  rt.linePathCache.set(line.id, { key, path });
  return path;
}

/** 路線站點 3 格內的住宅人口與在職人數（跨站去重） */
function lineServedPopulation(
  state: GameState,
  line: TransitLine,
): { residents: number; jobs: number; stops: number } {
  const seenHome = new Set<number>();
  const seenJob = new Set<number>();
  let residents = 0;
  let jobs = 0;
  const stops = lineStopBuildings(state, line);
  const r2 = LINE_STOP_RADIUS * LINE_STOP_RADIUS;
  for (const stop of stops) {
    const center = buildingCenter(stop);
    for (const building of state.buildings) {
      const def = BUILDINGS[building.key];
      if (!def) continue;
      const c = buildingCenter(building);
      const dx = c.x - center.x;
      const dy = c.y - center.y;
      if (dx * dx + dy * dy > r2) continue;
      if (def.housing > 0 && building.residents.length > 0 && !seenHome.has(building.id)) {
        seenHome.add(building.id);
        residents += building.residents.length;
      }
      if (
        def.workers > 0 &&
        building.active &&
        building.workers.length > 0 &&
        !seenJob.has(building.id)
      ) {
        seenJob.add(building.id);
        jobs += building.workers.length;
      }
    }
  }
  return { residents, jobs, stops: stops.length };
}

/** 票價吸引力：≤$6 全額，每 +$1 扣 8%，最低 0.3 */
function lineFareAttractiveness(fare: number): number {
  if (fare <= LINE_FARE_BASE) return 1;
  return Math.max(LINE_MIN_ATTRACTIVENESS, 1 - (fare - LINE_FARE_BASE) * LINE_FARE_STEP_PENALTY);
}

/** 簡化班距（分鐘）：roundTrip = 2 × 路線長 × 每格分鐘 + 站數 × 1.2；headway = roundTrip / 車數 */
function lineHeadwayMinutes(line: TransitLine, routeTiles: number): number {
  const roundTrip = Math.max(10, 2 * routeTiles * LINE_MINUTES_PER_TILE + line.stopIds.length * 1.2);
  return roundTrip / Math.max(1, line.vehicleCount);
}

/** 班距吸引力：>15 分鐘 ×0.5、>30 分鐘 ×0.2 */
function lineHeadwayAttractiveness(headway: number): number {
  if (headway > LINE_HEADWAY_POOR) return 0.2;
  if (headway > LINE_HEADWAY_FAIR) return 0.5;
  return 1;
}

/** 路線每日容量（車數 × 載客量 × 班次）；天氣係數另乘 */
function lineDailyCapacity(line: TransitLine): number {
  return (
    line.vehicleCount *
    TRANSIT_LINE_CONFIG.capacityPerVehicle[line.mode] *
    TRANSIT_LINE_CONFIG.tripsPerVehiclePerDay[line.mode]
  );
}

function lineWeatherFactor(state: GameState): number {
  const factor = WEATHER_EFFECT[state.clock.weather]?.transit ?? 1;
  return Math.max(0.2, factor);
}

// ── 建立／修改／刪除路線 ──

/**
 * 建立巴士／小巴路線（GameActions.createTransitLine 直接呼叫）。
 * 驗證：模式、≥2 站、無重複、同 mode 站點、active＋貼路、道路連通、車數 1–12、票價 $3–$20、需有車廠／總站、庫房足夠。
 * 成本 = 車數 × 車價 + 開線費，即時扣庫房並記入 infrastructure。
 */
export function createTransitLine(state: GameState, input: TransitLineInput): TransitLineActionResult {
  const cfg = TRANSIT_LINE_CONFIG;
  const fail = (reason: string): TransitLineActionResult => ({ ok: false, reason });
  const mode = input?.mode;
  if (mode !== 'bus' && mode !== 'minibus') return fail('路線模式唔啱（只接受巴士／小巴）');
  const lines = getTransitLines(state);
  if (lines.length >= MAX_ACTIVE_LINES) return fail(`路線數目已達上限（最多 ${MAX_ACTIVE_LINES} 條）`);

  // 循環線若重複輸入起終點，去掉尾站
  let stopIds = Array.isArray(input.stopIds) ? [...input.stopIds] : [];
  if (input.loop && stopIds.length >= 3 && stopIds[0] === stopIds[stopIds.length - 1]) {
    stopIds = stopIds.slice(0, -1);
  }
  if (stopIds.length < 2) return fail('最少要 2 個站');
  if (stopIds.length > cfg.maxStops) return fail(`最多 ${cfg.maxStops} 個站`);
  if (new Set(stopIds).size !== stopIds.length) return fail('站點重複');

  const stopNames: string[] = [];
  for (const stopId of stopIds) {
    const building = findBuildingById(state, stopId);
    if (!building) return fail('有站點已經唔存在');
    const name = BUILDINGS[building.key]?.name ?? '站點';
    stopNames.push(name);
    if (!isLineStopBuilding(building, mode)) {
      return fail(`「${name}」唔啱呢條${lineModeLabel(mode)}線`);
    }
    if (!building.active) return fail(`「${name}」未啟用（要先連接道路）`);
    if (roadAccessTiles(state, building).length === 0) return fail(`「${name}」未貼路`);
  }

  // depot：巴士線需巴士總站；小巴線需小巴車廠（可不在線內）
  if (!hasLineDepot(state, mode)) {
    return fail(mode === 'bus' ? '巴士線需要至少一座巴士總站' : '小巴線需要至少一座小巴車廠');
  }

  const vehicleCount = Math.round(Number(input.vehicleCount));
  if (!Number.isFinite(vehicleCount) || vehicleCount < cfg.vehicleMin || vehicleCount > cfg.vehicleMax) {
    return fail(`車數要 ${cfg.vehicleMin}–${cfg.vehicleMax} 架`);
  }
  const fare = Math.round(Number(input.fare));
  if (!Number.isFinite(fare) || fare < cfg.fareMin || fare > cfg.fareMax) {
    return fail(`票價要 $${cfg.fareMin}–$${cfg.fareMax}`);
  }

  const draft: TransitLine = {
    id: 0,
    mode,
    name: input.name?.trim() || '',
    color: input.color ?? '',
    stopIds,
    loop: !!input.loop,
    vehicleCount,
    fare,
    createdDay: state.clock.totalDays,
    ridershipToday: 0,
    faresThisMonth: 0,
    lastMonthRidership: 0,
    suspended: false,
  };
  const unreachable = findUnreachableStopPair(state, draft);
  if (unreachable) return fail(`${unreachable} 之間冇道路連通`);

  const cost = vehicleCount * cfg.vehicleCost[mode] + cfg.openFee;
  if (state.finance.treasury < cost) {
    return fail(`庫房不足：開線需要 $${cost.toLocaleString('zh-HK')}`);
  }

  // ── 入帳（基建支出；與其他建造費一致：即時扣庫房） ──
  state.finance.treasury -= cost;
  state.finance.expenseThisMonth += cost;
  state.finance.expenseBreakdown.infrastructure = (state.finance.expenseBreakdown.infrastructure ?? 0) + cost;

  const id = state.nextTransitLineId ?? 1;
  state.nextTransitLineId = id + 1;
  const defaultName = `${lineModeLabel(mode)} ${id} 號線`;
  const color = parseCssColorInt(draft.color) !== null
    ? draft.color
    : cfg.colors[(id - 1) % cfg.colors.length];
  const line: TransitLine = { ...draft, id, name: draft.name || defaultName, color };
  lines.push(line);
  const rt = runtimeOf(state);
  rt.linePathCache.delete(id);

  return { ok: true, id, cost };
}

/**
 * 修改路線（車數／票價／名稱／顏色／循環／停駛）。
 * 加車：每架收全價；減車：退 50%；退款／補款即時調整庫房與基建支出。
 */
export function updateTransitLine(
  state: GameState,
  id: number,
  patch: Partial<Pick<TransitLine, 'vehicleCount' | 'fare' | 'name' | 'color' | 'loop' | 'suspended'>>,
): TransitLineUpdateResult {
  const cfg = TRANSIT_LINE_CONFIG;
  const fail = (reason: string): TransitLineUpdateResult => ({ ok: false, reason });
  const line = getTransitLines(state).find((item) => item.id === id);
  if (!line) return fail('路線唔存在');

  // ── 先驗證所有欄位（避免部分套用後才失敗） ──
  let nextVehicleCount = line.vehicleCount;
  let cost = 0;
  let refund = 0;
  if (patch.vehicleCount !== undefined) {
    const next = Math.round(Number(patch.vehicleCount));
    if (!Number.isFinite(next) || next < cfg.vehicleMin || next > cfg.vehicleMax) {
      return fail(`車數要 ${cfg.vehicleMin}–${cfg.vehicleMax} 架`);
    }
    const diff = next - line.vehicleCount;
    if (diff > 0) {
      cost = diff * cfg.vehicleCost[line.mode];
      if (state.finance.treasury < cost) {
        return fail(`庫房不足：加 ${diff} 架車需要 $${cost.toLocaleString('zh-HK')}`);
      }
    } else if (diff < 0) {
      refund = Math.round(-diff * cfg.vehicleCost[line.mode] * 0.5);
    }
    nextVehicleCount = next;
  }
  let nextFare = line.fare;
  if (patch.fare !== undefined) {
    const fare = Math.round(Number(patch.fare));
    if (!Number.isFinite(fare) || fare < cfg.fareMin || fare > cfg.fareMax) {
      return fail(`票價要 $${cfg.fareMin}–$${cfg.fareMax}`);
    }
    nextFare = fare;
  }
  let nextName = line.name;
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) return fail('路線名唔可以空白');
    if (name.length > 24) return fail('路線名太長（最多 24 個字）');
    nextName = name;
  }
  let nextColor = line.color;
  if (patch.color !== undefined) {
    if (parseCssColorInt(String(patch.color)) === null) return fail('路線顏色格式要 #rrggbb');
    nextColor = String(patch.color);
  }

  // ── 套用（車數加減即時補／退錢） ──
  if (cost > 0) {
    state.finance.treasury -= cost;
    state.finance.expenseThisMonth += cost;
    state.finance.expenseBreakdown.infrastructure =
      (state.finance.expenseBreakdown.infrastructure ?? 0) + cost;
  }
  if (refund > 0) {
    state.finance.treasury += refund;
    // 退款沖減本月基建支出（避免當成收入）；本月支出不足則只沖到 0
    const infra = state.finance.expenseBreakdown.infrastructure ?? 0;
    const applied = Math.min(infra, refund);
    state.finance.expenseBreakdown.infrastructure = infra - applied;
    state.finance.expenseThisMonth = Math.max(0, state.finance.expenseThisMonth - applied);
  }
  line.vehicleCount = nextVehicleCount;
  line.fare = nextFare;
  line.name = nextName;
  line.color = nextColor;
  if (patch.loop !== undefined) line.loop = !!patch.loop;
  if (patch.suspended !== undefined) line.suspended = !!patch.suspended;
  return { ok: true, cost, refund };
}

/** 刪除路線：退 50% 車輛成本、移除相關車輛、清快取 */
export function deleteTransitLine(state: GameState, id: number): boolean {
  const cfg = TRANSIT_LINE_CONFIG;
  const lines = getTransitLines(state);
  const index = lines.findIndex((line) => line.id === id);
  if (index < 0) return false;
  const line = lines[index];
  const refund = Math.round(line.vehicleCount * cfg.vehicleCost[line.mode] * 0.5);
  state.finance.treasury += refund;
  const infra = state.finance.expenseBreakdown.infrastructure ?? 0;
  const applied = Math.min(infra, refund);
  state.finance.expenseBreakdown.infrastructure = infra - applied;
  state.finance.expenseThisMonth = Math.max(0, state.finance.expenseThisMonth - applied);

  lines.splice(index, 1);
  runtimeOf(state).linePathCache.delete(id);

  // 移除路線車輛（Vehicle.lineId）
  for (let i = state.vehicles.length - 1; i >= 0; i--) {
    if (state.vehicles[i].lineId === id) state.vehicles.splice(i, 1);
  }
  if (state.ui.selectedLineId === id) state.ui.selectedLineId = null;
  return true;
}

/** 每日路線營運結算（同日重複呼叫會 no-op；tickTransit 會先自動呼叫） */
export function tickTransitLines(state: GameState, ctx: SimContext): TransitLineDailySummary {
  const rt = runtimeOf(state);
  const clock = state.clock;
  const lines = getTransitLines(state);

  // 每月清零 line.faresThisMonth 由 finance（monthlyFinance）呼叫 resetTransitLineMonthly；
  // 本檔只負責每日累加。
  if (rt.lineLastDay === clock.totalDays && rt.lineSummary) return rt.lineSummary;
  rt.lineLastDay = clock.totalDays;

  const weather = clock.weather;
  const stormy = weather === 'storm';
  const weatherFactor = lineWeatherFactor(state);
  const isWeekend = clock.weekday === 0 || clock.weekday === 6;
  const demandDayFactor = isWeekend ? LINE_WEEKEND_DEMAND : 1;
  const cfg = TRANSIT_LINE_CONFIG;

  let totalRiders = 0;
  let totalFares = 0;
  let totalCosts = 0;
  let activeLines = 0;
  let invalidLines = 0;

  for (const line of lines) {
    // 站點被拆／未連接：暫時停駛，待玩家修正
    if (!lineStopsOperational(state, line)) {
      line.ridershipToday = 0;
      invalidLines++;
      continue;
    }
    const path = lineRoadPath(state, line);
    if (!path) {
      line.ridershipToday = 0;
      invalidLines++;
      continue;
    }
    if (line.suspended) {
      line.ridershipToday = 0;
      continue;
    }
    activeLines++;
    const { residents, jobs } = lineServedPopulation(state, line);
    const potential = residents * 0.55 + jobs * 0.75;
    const capacityRaw = lineDailyCapacity(line);
    const capacity = stormy ? 0 : capacityRaw * weatherFactor;
    const headway = lineHeadwayMinutes(line, path.length);
    const attractiveness = stormy
      ? 0
      : lineFareAttractiveness(line.fare) *
        lineHeadwayAttractiveness(headway) *
        Math.max(0.25, weatherFactor) *
        demandDayFactor;
    const ridership = Math.max(0, Math.round(Math.min(potential * attractiveness, capacity * 0.9)));
    const fares = Math.round(ridership * line.fare);
    const costs = line.vehicleCount * cfg.dailyCostPerVehicle[line.mode];

    line.ridershipToday = ridership;
    line.faresThisMonth += fares;
    totalRiders += ridership;
    totalFares += fares;
    totalCosts += costs;

    // 帳目：票價收入（fares）＋營運成本（infrastructure，因為 ExpenseKind 未有 transitOps）
    if (fares > 0) {
      state.finance.treasury += fares;
      state.finance.incomeThisMonth += fares;
      state.finance.incomeBreakdown.fares = (state.finance.incomeBreakdown.fares ?? 0) + fares;
    }
    if (costs > 0) {
      state.finance.treasury -= costs;
      state.finance.expenseThisMonth += costs;
      state.finance.expenseBreakdown.infrastructure =
        (state.finance.expenseBreakdown.infrastructure ?? 0) + costs;
    }
  }

  const summary: TransitLineDailySummary = {
    day: clock.totalDays,
    activeLines,
    ridership: totalRiders,
    fares: totalFares,
    costs: totalCosts,
    profit: totalFares - totalCosts,
  };
  rt.lineSummary = summary;

  // 提示（每 7 日一次）：路線有問題／整體虧蝕
  if (clock.totalDays - rt.lastLineLogDay >= 7) {
    if (invalidLines > 0) {
      rt.lastLineLogDay = clock.totalDays;
      ctx.log(`有 ${invalidLines} 條巴士／小巴路線因站點被拆或未連接道路而停駛，請檢查路線。`, 'warn');
    } else if (summary.profit < -3000) {
      rt.lastLineLogDay = clock.totalDays;
      ctx.log(
        `巴士／小巴路線整體虧蝕 $${Math.abs(Math.round(summary.profit)).toLocaleString('zh-HK')}/日，考慮減車、加價或縮短路線。`,
        'warn',
      );
    }
  }
  return summary;
}

/**
 * 月結後清零路線每月車費累計（由 finance.monthlyFinance 呼叫）。
 * 同時把上月最後一日載客記入 lastMonthRidership，供 UI 顯示上月表現。
 */
export function resetTransitLineMonthly(state: GameState): void {
  for (const line of getTransitLines(state)) {
    line.lastMonthRidership = line.ridershipToday ?? 0;
    line.faresThisMonth = 0;
  }
}

/** UI 用：各路線當日營運統計（交通面板「路線」列表） */
export function getTransitLineStats(state: GameState): TransitLineStats {
  const cfg = TRANSIT_LINE_CONFIG;
  const weatherFactor = lineWeatherFactor(state);
  const stormy = state.clock.weather === 'storm';
  const rows: TransitLineStatsRow[] = [];
  let totalRidership = 0;
  let totalRevenue = 0;
  let totalCost = 0;
  let totalVehicles = 0;
  let activeCount = 0;

  for (const line of getTransitLines(state)) {
    const path = lineRoadPath(state, line);
    const routeTiles = path?.length ?? 0;
    const capacityRaw = lineDailyCapacity(line);
    const capacity = stormy ? 0 : capacityRaw * weatherFactor;
    const ridership = line.ridershipToday ?? 0;
    const fares = Math.round(ridership * line.fare);
    const costs = line.suspended ? 0 : line.vehicleCount * cfg.dailyCostPerVehicle[line.mode];
    if (!line.suspended) activeCount++;
    totalRidership += ridership;
    totalRevenue += fares;
    totalCost += costs;
    totalVehicles += line.vehicleCount;
    rows.push({
      id: line.id,
      name: line.name,
      mode: line.mode,
      color: line.color,
      loop: line.loop,
      suspended: !!line.suspended,
      stops: line.stopIds.length,
      vehicleCount: line.vehicleCount,
      fare: line.fare,
      ridership,
      capacity,
      loadPct: capacity > 0 ? ridership / capacity : 0,
      fares,
      costs,
      profit: fares - costs,
      monthlyFares: line.faresThisMonth ?? 0,
      routeTiles,
      headwayMinutes: Math.round(lineHeadwayMinutes(line, routeTiles) * 10) / 10,
    });
  }

  return {
    lines: rows,
    count: rows.length,
    activeCount,
    totalRidership,
    totalRevenue,
    totalCost,
    totalProfit: totalRevenue - totalCost,
    totalVehicles,
  };
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
  /** Round 5：巴士／小巴路線營運摘要（交通面板「路線」tab） */
  lines?: {
    count: number;
    activeCount: number;
    ridership: number;
    revenue: number;
    costs: number;
    profit: number;
  };
  /** Round 6：鐵路網摘要（交通面板用；cached，每幀成本低） */
  rail?: {
    length: number;
    gradeCounts: { surface: number; elevated: number; underground: number };
    connectedStations: number;
    isolatedStations: number;
    ridership: number;
    capacity: number;
    upkeepMonthly: number;
  };
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
    lines: (() => {
      const lineStats = getTransitLineStats(state);
      return {
        count: lineStats.count,
        activeCount: lineStats.activeCount,
        ridership: lineStats.totalRidership,
        revenue: lineStats.totalRevenue,
        costs: lineStats.totalCost,
        profit: lineStats.totalProfit,
      };
    })(),
    rail: (() => {
      const railStats = getRailStats(state);
      return {
        length: railStats.length,
        gradeCounts: { ...railStats.gradeCounts },
        connectedStations: railStats.connectedStations,
        isolatedStations: railStats.isolatedStations,
        ridership: railStats.ridership,
        capacity: railStats.capacity,
        upkeepMonthly: railStats.upkeepMonthly,
      };
    })(),
  };
}
