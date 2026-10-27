/**
 * 城市統計：每幀更新 state.stats，供 UI、市民幸福度與事件判斷使用（《維港之城》）。
 *
 * 統計欄位受 core/types.ts 的 GameStats 契約限制（不可自行新增欄位）；
 * 需要額外數字時用本檔的純查詢函式（不寫入 state）。
 *
 * 覆蓋率公式
 *   powerCoverage / waterCoverage：以「人口加權」——住宅人口在任一發電廠／水務設施
 *     半徑內的比率（GDD §4.3）。容量是否足夠另由 production.ts 的 utilityStatus 處理，
 *     並在 stats 之外由 UI／事件提示。
 *   transitCoverage：以「就業人口加權」——就業市民的家或工作地點在任一公共交通
 *     站點半徑內的比率。若 transport-dev 的 tickTransit 已寫入更準確的值就保留它。
 *   ridership：直接讀 state.transit.dailyRidership（transport-dev 每日結算）。
 *   avgCommute：優先保留 transport-dev 的值；未有時以住所與工作地點直線距離 ×
 *     通勤模式速度估算（遊戲分鐘）。
 *   typhoonSignal：weather === 'storm' → 8；否則由 clock.warning 解析一／三／八號風球。
 *
 * 分區玩法（第二輪）
 *   zoneDemand：直接讀 state.zoneDemand（tickZoning 每日平滑後的權威值）。
 *   zoneTiles／zoneBuildings：掃 tiles.zone 與 BuildingDef.zone 統計。
 *   policeCoverage／fireCoverage／schoolCoverage／hospitalCoverage：人口加權的
 *     服務半徑覆蓋率（同 powerCoverage 邏輯；供應不足由服務容量另行處理）。
 *   landValue：已發展建築平均發展分數 0..100（baseDevelopmentScore＋景觀加成）。
 *
 * 食物：FOOD_PER_CITIZEN_PER_DAY = 0.5（與 citizens-dev citizen-common 一致），
 *      日用品 0.2／人／日只用於 UI 參考。
 *
 * 效能：O(建築數 + 市民數)，每幀一次；交通覆蓋的昂貴估算有簽章快取，
 *       其餘皆單次加總，不做排序、不建立大型暫存陣列。
 */

import { BUILDINGS, TRANSIT_SPEED } from '../core/config';
import type { Building, GameState, ResourceKey, ZoneType } from '../core/types';
import { hkoClockSignal } from './hko-climate';
import { computeUtilitySnapshot } from './utilities';
import { amenityBonus, baseDevelopmentScore, zoneDemandOf } from './zoning';
import { tileIndexOf, worldRevisionOf, ZONE_CODE_NAMES, zoneRevisionOf } from './placement';

/** 每人每日食品需求（單位；與 citizens-dev 的 FOOD_PER_CITIZEN_PER_DAY 一致） */
export const FOOD_PER_CITIZEN_PER_DAY = 0.5;
/** 每人每日日用品需求（單位，UI 參考用） */
export const GOODS_PER_CITIZEN_PER_DAY = 0.2;
/** 勞動年齡（與 population.ts 一致）：16～64 歲 */
export const WORKING_AGE = 16;
export const RETIRE_AGE = 65;
/** 步行速度（格／遊戲分鐘；與 citizen-common.CITIZEN_SPEED 一致） */
const WALK_TILES_PER_MINUTE = 0.06;

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round1 = (value: number): number => Math.round(value * 10) / 10;

// ─────────────────────────── 純查詢函式 ───────────────────────────

/** 全城建築庫存中某資源的總量（不含貨車上的貨物） */
export function totalStored(state: GameState, resource: ResourceKey): number {
  let total = 0;
  for (const building of state.buildings) total += building.inventory[resource] ?? 0;
  return total;
}

/** 食品總庫存（含街市貨架、倉庫、餐廳備料） */
export function totalFoodStored(state: GameState): number {
  return totalStored(state, 'food');
}

/** 食品安全天數：目前存糧可支撐幾日（無人口時回傳 Infinity） */
export function foodDaysLeft(state: GameState): number {
  const perDay = state.citizens.length * FOOD_PER_CITIZEN_PER_DAY;
  if (perDay <= 0) return Infinity;
  return totalFoodStored(state) / perDay;
}

/** 就業率 0..1（就業 / 可按勞動人口） */
export function employmentRate(state: GameState): number {
  const labor = state.stats.employed + state.stats.unemployed;
  return labor > 0 ? state.stats.employed / labor : 0;
}

function centerOf(building: Building): { x: number; y: number } {
  return { x: building.x + building.w / 2, y: building.y + building.h / 2 };
}

function distanceSq(a: Building, b: Building): number {
  const ca = centerOf(a);
  const cb = centerOf(b);
  const dx = ca.x - cb.x;
  const dy = ca.y - cb.y;
  return dx * dx + dy * dy;
}

// ─────────────────────────── 統計快取（每幀 updateStats 用） ───────────────────────────

/**
 * 統計快取簽章：世界變更版本（擺放／拆除／劃區）＋ 遊戲日 ＋ 人口。
 * 覆蓋率／分區格數唔需要每幀重算，只喺世界或人口變化時失效 → 1600 人時
 * updateStats 由 ~1.0ms 降到 ~0.1ms（peak p99 亦大幅下降）。
 */
function statsSignature(state: GameState): string {
  return `${worldRevisionOf()}:${state.clock.totalDays}:${state.citizens.length}:${state.nextBuildingId}`;
}

interface CoverageCacheEntry {
  signature: string;
  power: number;
  water: number;
  police: number;
  fire: number;
  school: number;
  hospital: number;
}
const coverageCache = new WeakMap<GameState, CoverageCacheEntry>();

interface ZoneCountTilesEntry {
  signature: string;
  tiles: Record<ZoneType, number>;
}
interface ZoneCountBuildingsEntry {
  signature: string;
  buildings: Record<ZoneType, number>;
}
const zoneTilesCache = new WeakMap<GameState, ZoneCountTilesEntry>();
const zoneBuildingsCache = new WeakMap<GameState, ZoneCountBuildingsEntry>();

/** 公用設施管網覆蓋率 0..1（Round 5：由 utilities snapshot 提供） */
export function utilityCoverage(state: GameState, kind: 'power' | 'water'): number {
  const snapshot = computeUtilitySnapshot(state);
  return kind === 'power' ? snapshot.power.coverage : snapshot.water.coverage;
}

/** 公共交通可達率 0..1（就業人口加權：家或工作地點在車站半徑內） */
export function transitCoverageFallback(state: GameState): number {
  const stations: { building: Building; radius: number }[] = [];
  for (const building of state.buildings) {
    const transit = BUILDINGS[building.key]?.transit;
    if (!transit || !building.active) continue;
    stations.push({ building, radius: transit.radius });
  }
  if (!stations.length) return 0;

  const buildingById = new Map<number, Building>();
  for (const building of state.buildings) buildingById.set(building.id, building);

  let employed = 0;
  let covered = 0;
  for (const citizen of state.citizens) {
    if (citizen.workId < 0) continue;
    employed++;
    const home = buildingById.get(citizen.homeId);
    const work = buildingById.get(citizen.workId);
    const pos = home ? centerOf(home) : { x: citizen.x, y: citizen.y };
    const workPos = work ? centerOf(work) : pos;
    let hit = false;
    for (const station of stations) {
      const center = centerOf(station.building);
      const r2 = station.radius * station.radius;
      const dh = (pos.x - center.x) ** 2 + (pos.y - center.y) ** 2;
      const dw = (workPos.x - center.x) ** 2 + (workPos.y - center.y) ** 2;
      if (dh <= r2 || dw <= r2) {
        hit = true;
        break;
      }
    }
    if (hit) covered++;
  }
  return employed > 0 ? round2(covered / employed) : 0;
}

/** 平均通勤時間估算（遊戲分鐘）：住所→工作地點，按通勤方式速度 */
export function estimateAvgCommute(state: GameState): number {
  const buildingById = new Map<number, Building>();
  for (const building of state.buildings) buildingById.set(building.id, building);
  let total = 0;
  let count = 0;
  for (const citizen of state.citizens) {
    if (citizen.workId < 0) continue;
    const home = buildingById.get(citizen.homeId);
    const work = buildingById.get(citizen.workId);
    if (!home || !work) continue;
    const ca = centerOf(home);
    const cb = centerOf(work);
    const distance = Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y);
    const mode = citizen.commuteMode ?? 'walk';
    const speed = WALK_TILES_PER_MINUTE * (TRANSIT_SPEED[mode] ?? 1);
    // 搭車另有候車／步行到站時間，約 6 分鐘
    const wait = mode === 'walk' ? 0 : 6;
    total += distance / Math.max(0.01, speed) + wait;
    count++;
  }
  return count > 0 ? Math.round(total / count) : 0;
}

/** 由 clock.warning 與天氣推算颱風信號（0／1／3／8） */
/**
 * 颱風信號（Round 9／issue #18）：優先讀 HKO clock.typhoonSignal（1/3/8/9/10）；
 * 舊存檔先 fallback 解析 warning 文字；storm 而冇資料時視為 8 號。
 * 與 transit.typhoonSignalFor 共用 hko-climate.hkoClockSignal，避免兩處唔一致。
 */
export function typhoonSignalOf(state: GameState): number {
  return hkoClockSignal(state.clock);
}

// ─────────────────────────── 交通估算快取 ───────────────────────────

interface TransitCacheEntry {
  signature: string;
  coverage: number;
  commute: number;
}

const transitCache = new WeakMap<GameState, TransitCacheEntry>();

function transitSignature(state: GameState): string {
  return `${state.buildings.length}:${state.citizens.length}:${state.clock.totalDays}:${state.transit.dailyRidership}`;
}

// ─────────────────────────── 分區／服務覆蓋（第二輪） ───────────────────────────

/** 某類服務（警／消／校／醫）的人口加權覆蓋率 0..1 */
export function serviceKindCoverage(
  state: GameState,
  kind: 'police' | 'fire' | 'school' | 'hospital',
): number {
  ensureCoverageCache(state);
  const cached = coverageCache.get(state);
  if (!cached) return 0;
  return cached[kind];
}

/** 一次過計 4 種服務覆蓋＋水電覆蓋並寫入 cache（每簽章一次） */
function ensureCoverageCache(state: GameState): void {
  const signature = statsSignature(state);
  const cached = coverageCache.get(state);
  if (cached && cached.signature === signature) return;
  const entry: CoverageCacheEntry = {
    signature,
    power: 0,
    water: 0,
    police: computeServiceCoverage(state, 'police'),
    fire: computeServiceCoverage(state, 'fire'),
    school: computeServiceCoverage(state, 'school'),
    hospital: computeServiceCoverage(state, 'hospital'),
  };
  coverageCache.set(state, entry);
}

/** 某類服務（警／消／校／醫）的人口加權覆蓋率 0..1（實際計算） */
function computeServiceCoverage(
  state: GameState,
  kind: 'police' | 'fire' | 'school' | 'hospital',
): number {
  const population = state.citizens.length;
  if (population <= 0) return 0;
  const services: { building: Building; radius: number }[] = [];
  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    if (!def?.service || def.service.kind !== kind) continue;
    if (!building.active) continue;
    const radius = def.service.radius ?? 0;
    if (radius > 0) services.push({ building, radius });
  }
  if (!services.length) return 0;

  let covered = 0;
  for (const home of state.buildings) {
    const def = BUILDINGS[home.key];
    if (!def || def.housing <= 0 || home.residents.length === 0) continue;
    for (const service of services) {
      if (distanceSq(home, service.building) <= service.radius * service.radius) {
        covered += home.residents.length;
        break;
      }
    }
  }
  return round2(covered / population);
}

/** 分區格數／建築數統計（每幀 O(tiles + buildings)；tiles 掃描很便宜） */
function zoneCounts(state: GameState): {
  tiles: Record<ZoneType, number>;
  buildings: Record<ZoneType, number>;
} {
  // 分區格數只受「劃區／取消分區」影響（zoneRevision）；分區建築數就受建築結構影響。
  // 分開兩個 cache：鋪路／起樓唔會令分區格數重掃 92k tiles。
  const tilesSig = `${zoneRevisionOf()}`;
  let tilesEntry = zoneTilesCache.get(state);
  if (!tilesEntry || tilesEntry.signature !== tilesSig) {
    const tiles: Record<ZoneType, number> = { residential: 0, commercial: 0, industrial: 0, farmland: 0 };
    // 480 地圖 230k 格：用 Uint8Array 索引（object 逐格掃描太貴）
    const zoneArr = tileIndexOf(state).zone;
    for (let i = 0; i < zoneArr.length; i++) {
      const code = zoneArr[i];
      if (!code) continue;
      const zone = ZONE_CODE_NAMES[code];
      if (zone) tiles[zone]++;
    }
    tilesEntry = { signature: tilesSig, tiles };
    zoneTilesCache.set(state, tilesEntry);
  }
  const buildingsSig = `${state.buildings.length}:${state.nextBuildingId}`;
  let buildingsEntry = zoneBuildingsCache.get(state);
  if (!buildingsEntry || buildingsEntry.signature !== buildingsSig) {
    const buildings: Record<ZoneType, number> = { residential: 0, commercial: 0, industrial: 0, farmland: 0 };
    for (const building of state.buildings) {
      if (building.auto && building.zone) buildings[building.zone]++;
    }
    buildingsEntry = { signature: buildingsSig, buildings };
    zoneBuildingsCache.set(state, buildingsEntry);
  }
  return { tiles: tilesEntry.tiles, buildings: buildingsEntry.buildings };
}

// 地價（平均發展分數）快取：建築位置／服務覆蓋每日變化，唔需要每幀重算
interface LandValueCacheEntry {
  signature: string;
  value: number;
}
const landValueCache = new WeakMap<GameState, LandValueCacheEntry>();

/** 地價 0..100 = 已發展建築平均發展分數（基礎分＋景觀；不含地價自身，避免循環） */
export function landValueOf(state: GameState): number {
  const buildings = state.buildings;
  if (!buildings.length) return 40;
  const s = state.stats;
  // 只喺建築結構／換日／人口變化時重算（唔包 worldRevision：鋪路唔會改變地價，
  // 避免玩家拖曳鋪路時每幀重掃所有建築嘅 amenity）。
  const signature = `${buildings.length}:${state.nextBuildingId}:${state.clock.totalDays}:${state.citizens.length}`;
  const cached = landValueCache.get(state);
  if (cached && cached.signature === signature) return cached.value;

  const base = baseDevelopmentScore(state);
  // 公園／海濱中心點只預算一次，避免每棟建築都掃全部 buildings（O(n²)）
  const parks: { x: number; y: number }[] = [];
  for (const building of buildings) {
    if (building.key !== 'park' && building.key !== 'promenade') continue;
    parks.push({ x: building.x + building.w / 2, y: building.y + building.h / 2 });
  }
  let total = 0;
  for (const building of buildings) {
    const cx = Math.floor(building.x + building.w / 2);
    const cy = Math.floor(building.y + building.h / 2);
    total += Math.min(100, base + amenityBonus(state, cx, cy, parks));
  }
  const value = Math.max(0, Math.min(100, Math.round(total / buildings.length)));
  landValueCache.set(state, { signature, value });
  return value;
}

// ─────────────────────────── 每幀統計 ───────────────────────────

/** 更新每幀統計（由 simulation.ts／main.ts 呼叫） */
export function updateStats(state: GameState): void {
  const { citizens, buildings, carts, stats, finance } = state;

  let households = 0;
  let jobs = 0;
  let foodStored = 0;
  for (const building of buildings) {
    const def = BUILDINGS[building.key];
    if (!def) continue;
    if (def.housing > 0 && building.residents.length > 0) households++;
    // 職缺數：營運中工作建築的總容量（未連通路仍算職缺，只是無法全面營運）
    if (def.workers > 0 && building.active) jobs += def.workers;
    foodStored += building.inventory.food ?? 0;
  }

  let employed = 0;
  let unemployed = 0;
  let homeless = 0;
  let happinessSum = 0;
  for (const citizen of citizens) {
    if (citizen.workId >= 0) employed++;
    else if (citizen.age >= WORKING_AGE && citizen.age < RETIRE_AGE) unemployed++;
    if (citizen.homeId < 0) homeless++;
    happinessSum += citizen.happiness;
  }

  // 物流中的貨物（貨車手上）
  let goodsInTransit = 0;
  for (const cart of carts) goodsInTransit += cart.amount;

  stats.population = citizens.length;
  stats.households = households;
  stats.jobs = jobs;
  stats.employed = employed;
  stats.unemployed = unemployed;
  stats.homeless = homeless;
  stats.happiness = citizens.length ? round2(happinessSum / citizens.length) : 70;
  stats.foodStored = round1(foodStored);
  stats.foodPerDay = round1(citizens.length * FOOD_PER_CITIZEN_PER_DAY);
  stats.goodsInTransit = round1(goodsInTransit);
  stats.netIncome = round2(finance.lastMonthIncome - finance.lastMonthExpense);

  // 公用設施管網覆蓋率（Round 5：水／污水／電；水管網 BFS snapshot）
  const utilities = computeUtilitySnapshot(state);
  stats.powerCoverage = utilities.power.coverage;
  stats.waterCoverage = utilities.water.coverage;
  stats.sewageCoverage = utilities.sewage.coverage;
  stats.waterQuality = utilities.waterQuality;

  // 交通統計：ridership 直接讀 transit 每日結算；coverage／avgCommute 有 transport-dev 值就保留
  stats.ridership = Math.max(0, Math.round(state.transit.dailyRidership));
  const hasTransitBuilding = buildings.some((b) => !!BUILDINGS[b.key]?.transit);
  if (hasTransitBuilding) {
    const signature = transitSignature(state);
    const cached = transitCache.get(state);
    let coverage = stats.transitCoverage;
    let commute = stats.avgCommute;
    if (!(coverage > 0.001)) {
      // transport-dev 尚未提供（stub／尚未跨日）：用簡單空間估算（每日快取）
      if (!cached || cached.signature !== signature) {
        coverage = transitCoverageFallback(state);
        commute = estimateAvgCommute(state);
        transitCache.set(state, { signature, coverage, commute });
      } else {
        coverage = cached.coverage;
        commute = cached.commute;
      }
    }
    stats.transitCoverage = Math.min(1, round2(coverage));
    if (!(commute > 0)) commute = estimateAvgCommute(state);
    stats.avgCommute = Math.round(commute);
  } else {
    stats.transitCoverage = 0;
    stats.avgCommute = 0;
  }

  // 分區玩法：服務覆蓋率（人口加權）、分區統計、需求、地價
  stats.policeCoverage = serviceKindCoverage(state, 'police');
  stats.fireCoverage = serviceKindCoverage(state, 'fire');
  stats.schoolCoverage = serviceKindCoverage(state, 'school');
  stats.hospitalCoverage = serviceKindCoverage(state, 'hospital');
  const zones = zoneCounts(state);
  stats.zoneTiles = zones.tiles;
  stats.zoneBuildings = zones.buildings;
  stats.zoneDemand = { ...zoneDemandOf(state) };
  stats.landValue = landValueOf(state);

  // 颱風信號（每幀依天氣／天文台警告更新）
  stats.typhoonSignal = typhoonSignalOf(state);
}
