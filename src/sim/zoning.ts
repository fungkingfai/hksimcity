/**
 * 分區自動開發系統（《維港之城》第二輪：SimCity／Cities: Skylines 式玩法）。
 *
 * 玩家只鋪路＋劃分住宅（R）／商業（C）／工業（I）／農業（F）區，
 * 「開發商」按需求與環境每日自動用貨車…唔係，係自動起屋；市政設施（發電廠、水務、
 * 警署、消防局、學校、醫院、交通、公園）仍由玩家手動放置（ploppable）。
 *
 * 對外契約（docs/ARCHITECTURE 與 Lead 的 simulation.ts 接線）：
 *   computeZoneDemand(state): Record<ZoneType, number>   即時目標需求 -1..1
 *   tickZoning(state, ctx): void                          每日（newDay）由 simulation.ts 呼叫
 *   zoneStats(state): ZoneStatsResult                     UI 用（分區面板／城事面板）
 *   developmentScore(state, x, y): number                 地塊發展分數 0..100（UI 用）
 *   cityDevelopmentScore(state): number                   全城發展分數（唔使座標）
 *   zoneDemandOf(state): Record<ZoneType, number>         回傳 state.zoneDemand（平滑後）
 *
 * 需求公式（純函式；tickZoning 會把目標值平滑寫入 state.zoneDemand）
 *   住宅 = 0.55 + 職位空缺拉力 + 幸福拉力 − 房屋空置率×1.9 − 失業率×0.5
 *   商業 = (3 + 人口×0.2 − 商業職位) ÷ 需求分母，再酌情加幸福拉力
 *   工業 = (4 + 失業×1.1 + 人口×0.1 − 工業職位) ÷ 需求分母
 *   農業 = 存糧偏離目標 6 日天數的壓力 + 農田超額懲罰（無人口時給開局正需求）
 * 過度開發（房屋空置、商業／工業職位過剩、存糧充足）→ 需求轉負，自動開發暫停。
 *
 * 自動開發規則（AUTO_DEVELOP）
 *   - 只考慮「有分區、空置、地形可建、footprint 全在該分區、4 鄰接馬路」的地塊；
 *   - 候選建築 = zoneBuildingDefs(zone) 中 unlockPop ≤ 人口 且 minDevScore ≤ 發展分數；
 *     以 weight 加權抽選（可重現的 hash，不用 Math.random）；
 *   - 每日每區上限 2 座、全城 5 座、全城自動建築上限 420；
 *   - 需求 > 0.45 時每區可起 2 座，0.12–0.45 時 1 座，低於 minDemand 停工；
 *   - 自動建築 auto=true、zone=該區，不扣玩家庫房（開發商出資），照樣交維護費與稅；
 *   - 放棄機制：連續 AUTO_DEVELOP.abandonDays 日無道路連接或分區被取消 → 自動清拆。
 */

import { AUTO_DEVELOP, BUILDINGS, MAP_SCALE, TERRAIN_INFO, ZONES, ZONE_ORDER, zoneBuildingDefs } from '../core/config';
import { hash2d } from '../core/rng';
import type { GameState, SimContext, ZoneType } from '../core/types';
import {
  buildingFootprintTiles,
  canAutoPlaceBuilding,
  demolishBuildingById,
  isBuildingStreetConnected,
  placeAutoBuilding,
} from './placement';

// ─────────────────────────── 常數 ───────────────────────────

/** 需求平滑：每日向目標值收斂的比例（越大反應越快） */
const DEMAND_SMOOTHING = 0.45;
/** 目標存糧日數（農業需求以此為平衡點） */
const FOOD_TARGET_DAYS = 6;
/** 商業職位需求：3 個基礎 + 人口 ×0.22（零售／餐飲／寫字樓） */
const COMMERCIAL_JOBS_BASE = 3;
/** 工業職位需求：4 個基礎 + 人口 ×0.28 + 失業人口 ×1.15（工廈／貨倉／碼頭） */
const INDUSTRIAL_JOBS_BASE = 4;
const INDUSTRIAL_JOBS_PER_POP = 0.28;
const INDUSTRIAL_JOBS_PER_UNEMPLOYED = 1.15;
/** 勞動年齡（與 population.ts 一致） */
const WORKING_AGE = 16;
const RETIRE_AGE = 65;
/**
 * 內部開發門檻：config AUTO_DEVELOP.minDemand（0.12）作 UI 顯示用，
 * 實際開發用較低門檻（0.05）＋「某區 0 棟而需求為正」bootstrap，避免開局停滯。
 */
const INTERNAL_MIN_DEMAND = 0.05;
/** 需求下限（避免「起一兩棟就跌到 -0.9」死鎖；供需仍可轉負暫停開發） */
const DEMAND_FLOOR = -0.6;
/** 早期需求保底（人口 < 300 時避免少許空置就停建） */
const DEMAND_BOOTSTRAP = 0.15;

/**
 * 地圖面積倍率（304×304 約為 96×96 的 10 倍）。
 * 需求公式嘅「已劃未開發」pipeline 門檻要按面積放大，否則 304 地圖玩家正常
 * 劃大塊地就會被當成過度劃區；同時 developer 每區每日上限不變。
 */
const AREA_SCALE = MAP_SCALE * MAP_SCALE;

/** 每個分區每日收集嘅候選地塊上限（避免 304 地圖一次過處理幾萬格） */
const MAX_SITES_PER_ZONE = 4000;
/** 每次自動開發每個建築定義最多試幾個候選地塊 */
const MAX_ANCHOR_TRIES = 50;

const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** 空白需求表 */
export function emptyZoneDemand(): Record<ZoneType, number> {
  return { residential: 0, commercial: 0, industrial: 0, farmland: 0 };
}

// ─────────────────────────── 統計小工具 ───────────────────────────

function countCitizens(state: GameState): {
  pop: number;
  workingAge: number;
  unemployed: number;
  employed: number;
} {
  let workingAge = 0;
  let unemployed = 0;
  let employed = 0;
  for (const citizen of state.citizens) {
    if (citizen.workId >= 0) employed++;
    if (citizen.age >= WORKING_AGE && citizen.age < RETIRE_AGE) {
      workingAge++;
      if (citizen.workId < 0) unemployed++;
    }
  }
  return { pop: state.citizens.length, workingAge, unemployed, employed };
}

/** 住宅房屋總容量（所有有 housing 的建築） */
function housingCapacity(state: GameState): number {
  let capacity = 0;
  for (const building of state.buildings) {
    capacity += BUILDINGS[building.key]?.housing ?? 0;
  }
  return capacity;
}

/** 某分區的職位容量（營運中的自動建築；用 BuildingDef.workers） */
function zoneWorkerCapacity(state: GameState, zone: ZoneType): number {
  let workers = 0;
  for (const building of state.buildings) {
    if (!building.active) continue;
    const def = BUILDINGS[building.key];
    if (!def || def.zone !== zone) continue;
    workers += def.workers;
  }
  return workers;
}

/** 各分區「已劃分但未開發」的格數（建築覆蓋、未起樓）；用於需求公式的規劃供應壓力 */
function undevelopedZoneTiles(state: GameState): Record<ZoneType, number> {
  const counts: Record<ZoneType, number> = { residential: 0, commercial: 0, industrial: 0, farmland: 0 };
  for (const tile of state.tiles) {
    if (!tile.zone) continue;
    if (tile.buildingId >= 0 || tile.road) continue;
    counts[tile.zone]++;
  }
  return counts;
}

/** 某分區的已建成建築數（包括玩家手動放置但屬該分區的建築） */
export function zoneBuildingCount(state: GameState, zone: ZoneType): number {
  let count = 0;
  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    if (!def) continue;
    if (def.zone === zone) count++;
  }
  return count;
}

/** 全城自動開發建築數（Building.auto） */
export function autoBuildingCount(state: GameState): number {
  let count = 0;
  for (const building of state.buildings) if (building.auto) count++;
  return count;
}

// ─────────────────────────── 分區需求 ───────────────────────────

/**
 * 即時目標需求（-1..1，正＝有需求，負＝供過於求）。
 * 唔會改 state；tickZoning 會平滑後寫入 state.zoneDemand。
 */
export function computeZoneDemand(
  state: GameState,
  precomputedEmpty?: Record<ZoneType, number>,
): Record<ZoneType, number> {
  const { pop, workingAge, unemployed, employed } = countCitizens(state);
  const happiness = clamp(state.stats.happiness || 70, 0, 100);
  const jobs = Math.max(0, state.stats.jobs || 0);
  const empty = precomputedEmpty ?? undevelopedZoneTiles(state);

  // 未開發分區的「規劃供應」壓力：劃得越多、未起樓越多 → 需求越低（避免過度劃區）
  // 304 地圖（面積 ×~10）：門檻按面積放大，避免正常大塊劃區被誤判過度供應
  const commercialPipeline = Math.min(1, empty.commercial / (40 * AREA_SCALE));
  const industrialPipeline = Math.min(1, empty.industrial / (40 * AREA_SCALE));
  const farmlandPipeline = Math.min(1, empty.farmland / (30 * AREA_SCALE));

  // ── 住宅 ──
  // 已建房屋容許 30% 空置（預留搬遷流轉）；超出部分視為供應過剩
  const capacity = housingCapacity(state);
  const allowedVacantHomes = Math.max(6, pop * 0.3);
  const vacancyPressure =
    capacity > 0
      ? clamp((capacity - pop - allowedVacantHomes) / Math.max(30, capacity), 0, 1)
      : 0;
  // 已劃但未開發住宅地：超出「近期可吸納量」越多 → 需求越低。
  // 大幅過度劃區（例如人口 50 卻劃 250+ 格住宅）會令住宅需求轉負，開發商暫停建樓。
  const pipelineBuffer = Math.max(80, pop * 0.5) * AREA_SCALE;
  const residentialPipelinePressure = clamp(
    (empty.residential - pipelineBuffer) / Math.max(60, empty.residential * 0.5),
    0,
    1,
  );
  const jobVacancies = Math.max(0, jobs - employed);
  const jobPull = clamp(jobVacancies / Math.max(25, pop * 0.4), 0, 0.45);
  const happinessPull = clamp((happiness - 50) / 125, -0.4, 0.4);
  const unemploymentRate = workingAge > 0 ? unemployed / workingAge : 0;
  let residential =
    0.6 +
    jobPull * 0.5 +
    happinessPull * 0.8 -
    unemploymentRate * 0.4 -
    vacancyPressure * 1.1 -
    residentialPipelinePressure * 0.9;
  // 完全冇人口的新城市：由開發商先行起樓吸引市民
  if (pop === 0) residential = 0.72 - residentialPipelinePressure * 0.4;
  // 保底：人口 < 300 且非嚴重過剩（空置／未開發地未爆錶）→ 住宅需求最低 +0.15
  if (pop < 300 && vacancyPressure < 0.45 && residentialPipelinePressure < 0.5) {
    residential = Math.max(residential, DEMAND_BOOTSTRAP);
  }
  residential = clamp(residential, DEMAND_FLOOR, 0.9);

  // ── 商業 ──
  const commercialWorkers = zoneWorkerCapacity(state, 'commercial');
  const commercialNeeded = COMMERCIAL_JOBS_BASE + pop * 0.22;
  const commercialGap = commercialNeeded - commercialWorkers;
  let commercial =
    clamp(commercialGap / Math.max(6, commercialNeeded * 0.55), -0.85, 0.95) * 0.9 +
    clamp((happiness - 55) / 220, -0.1, 0.12) -
    commercialPipeline * 0.2;
  // 保底：商業職位仍少於人口 25%（有購物需求）→ 至少 +0.15
  if (pop > 0 && commercialWorkers < pop * 0.25 && commercialPipeline < 0.6) {
    commercial = Math.max(commercial, DEMAND_BOOTSTRAP);
  }
  commercial = clamp(commercial, DEMAND_FLOOR, 0.9);

  // ── 工業 ──
  const industrialWorkers = zoneWorkerCapacity(state, 'industrial');
  const industrialNeeded =
    INDUSTRIAL_JOBS_BASE + pop * INDUSTRIAL_JOBS_PER_POP + unemployed * INDUSTRIAL_JOBS_PER_UNEMPLOYED;
  const industrialGap = industrialNeeded - industrialWorkers;
  let industrial = clamp(industrialGap / Math.max(8, industrialNeeded * 0.55), -0.85, 0.95) * 0.95;
  // 貨物短缺（日用品庫存低）→ 工業需求加碼
  if (pop > 0) {
    let goodsStored = 0;
    for (const building of state.buildings) goodsStored += building.inventory.goods ?? 0;
    if (goodsStored < pop * 0.2 * 2) industrial += 0.12;
  }
  industrial = clamp(industrial - industrialPipeline * 0.2, DEMAND_FLOOR, 1);
  // 保底：失業率 > 5% 或職位少於人口 45% → 工業需求至少 +0.15（創造就業）
  const totalJobs = Math.max(jobs, 0);
  if (pop > 0 && industrialPipeline < 0.65) {
    if (unemploymentRate > 0.05 || totalJobs < pop * 0.45) {
      industrial = Math.max(industrial, DEMAND_BOOTSTRAP);
    }
  }
  industrial = clamp(industrial, DEMAND_FLOOR, 0.9);

  // ── 農業 ──
  const foodPerDay = Math.max(0, state.stats.foodPerDay || pop * 0.5);
  const foodStored = Math.max(0, state.stats.foodStored || 0);
  const foodDays = foodPerDay > 0 ? foodStored / foodPerDay : 0;
  const farmBuildings = zoneBuildingCount(state, 'farmland');
  const neededFarms = Math.max(1, (foodPerDay + 2) / 24); // 1 座農田約 24 食品／日
  let farmland: number;
  if (pop < 10) {
    farmland = 0.55; // 開局先起農田，保證有食品
  } else {
    farmland = clamp(((FOOD_TARGET_DAYS - foodDays) / FOOD_TARGET_DAYS) * 1.8, -0.9, 0.95);
  }
  farmland -= Math.max(0, farmBuildings - neededFarms * 1.6) * 0.12;
  farmland = farmland - farmlandPipeline * 0.2;
  // 保底：存糧少於 8 日 → 農業需求至少 +0.15
  if (foodDays < 8 && farmlandPipeline < 0.65) farmland = Math.max(farmland, DEMAND_BOOTSTRAP);
  farmland = clamp(farmland, DEMAND_FLOOR, 0.9);

  return {
    residential: round2(residential),
    commercial: round2(commercial),
    industrial: round2(industrial),
    farmland: round2(farmland),
  };
}

/** 回傳 state.zoneDemand（tickZoning 平滑後的權威值；未初始化時即時計算） */
export function zoneDemandOf(state: GameState): Record<ZoneType, number> {
  if (!state.zoneDemand) return computeZoneDemand(state);
  const demand = state.zoneDemand;
  // 若從未 tick（全 0），給 UI 一個即時估算
  let any = false;
  for (const zone of ZONE_ORDER) {
    if (Math.abs(demand[zone] ?? 0) > 0.001) any = true;
  }
  return any ? demand : computeZoneDemand(state);
}

// ─────────────────────────── 發展分數 ───────────────────────────

/** 局部景觀加成 0..8：近水／近山／近公園與海濱 */
function localAmenity(state: GameState, x: number, y: number): number {
  let bonus = 0;
  let water = false;
  let hill = false;
  for (let dy = -4; dy <= 4 && !(water && hill); dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) continue;
      const dist2 = dx * dx + dy * dy;
      const terrain = state.tiles[ty * state.width + tx].terrain;
      if (!water && dist2 <= 16 && terrain === 'water') {
        water = true;
        bonus += 3;
      }
      if (!hill && dist2 <= 9 && (terrain === 'hill' || terrain === 'mountain')) {
        hill = true;
        bonus += 2;
      }
    }
  }
  // 公園／海濱長廊（6 格內）
  for (const building of state.buildings) {
    if (building.key !== 'park' && building.key !== 'promenade') continue;
    const cx = building.x + building.w / 2;
    const cy = building.y + building.h / 2;
    const dx = cx - (x + 0.5);
    const dy = cy - (y + 0.5);
    if (dx * dx + dy * dy <= 36) {
      bonus += 2;
      break;
    }
  }
  return Math.min(8, bonus);
}

/**
 * 基礎發展分數 0..100（服務覆蓋＋幸福，不包括地價項，避免 stats.landValue ↔ 發展分數循環）。
 * 同時供 stats.ts 計算 landValue（平均發展分數）用。
 */
export function baseDevelopmentScore(state: GameState): number {
  const s = state.stats;
  const DS = AUTO_DEVELOP.developmentScore;
  const raw =
    DS.base +
    (s.powerCoverage ?? 0) * DS.powerWeight +
    (s.waterCoverage ?? 0) * DS.waterWeight +
    (s.policeCoverage ?? 0) * DS.policeWeight +
    (s.fireCoverage ?? 0) * DS.fireWeight +
    (s.schoolCoverage ?? 0) * DS.schoolWeight +
    (s.hospitalCoverage ?? 0) * DS.hospitalWeight +
    (s.transitCoverage ?? 0) * DS.transitWeight +
    ((s.happiness || 70) / 100) * DS.happinessWeight;
  return Math.round(clamp(raw, 0, 100));
}

/** 局部景觀加成 0..8（近水／近山／近公園；UI 與 landValue 用） */
export function amenityBonus(state: GameState, x: number, y: number): number {
  return localAmenity(state, x, y);
}

/** 全城發展分數 0..100（基礎分＋地價；tickZoning 揀樓用） */
export function cityDevelopmentScore(state: GameState): number {
  const s = state.stats;
  const DS = AUTO_DEVELOP.developmentScore;
  const landValue = s.landValue > 0 ? Math.min(100, s.landValue) : 40;
  const raw = baseDevelopmentScore(state) + (landValue / 100) * DS.landValueWeight;
  return Math.round(clamp(raw, 0, 100));
}

/** 地塊發展分數 0..100（全城分數＋局部景觀加成；UI 用） */
export function developmentScore(state: GameState, x: number, y: number): number {
  const score = cityDevelopmentScore(state) + amenityBonus(state, x, y);
  return Math.round(clamp(score, 0, 100));
}

// ─────────────────────────── 執行期暫存 ───────────────────────────

interface ZoningRuntime {
  /** buildingId → 連續無道路／無分區日數 */
  abandonDays: Map<number, number>;
  /** 每區上次 log 日 */
  lastLogDay: Record<ZoneType, number>;
  /** 是否已提示「開發商開始建屋」 */
  announcedStart: boolean;
  lastAbandonLogDay: number;
  lastOverSupplyLogDay: number;
  /** 某區有需求但連續多日搵唔到合適地塊 → 提示玩家地塊太窄 */
  stallDays: Record<ZoneType, number>;
  lastStallHintDay: Record<ZoneType, number>;
}

const runtimes = new WeakMap<GameState, ZoningRuntime>();

function runtimeOf(state: GameState): ZoningRuntime {
  let rt = runtimes.get(state);
  if (!rt) {
    rt = {
      abandonDays: new Map(),
      lastLogDay: { residential: -999, commercial: -999, industrial: -999, farmland: -999 },
      announcedStart: false,
      lastAbandonLogDay: -999,
      lastOverSupplyLogDay: -999,
      stallDays: { residential: 0, commercial: 0, industrial: 0, farmland: 0 },
      lastStallHintDay: { residential: -999, commercial: -999, industrial: -999, farmland: -999 },
    };
    runtimes.set(state, rt);
  }
  return rt;
}

// ─────────────────────────── 放棄機制 ───────────────────────────

/** 自動建築：連續無道路／分區被取消 → 自動清拆（開發商放棄） */
function abandonAutoBuildings(state: GameState, rt: ZoningRuntime, ctx: SimContext): void {
  if (!state.buildings.some((b) => b.auto)) return;
  const doomed: number[] = [];
  for (const building of state.buildings) {
    if (!building.auto) continue;
    const zone = building.zone;
    const zoneCancelled = !zone || state.tiles[building.y * state.width + building.x]?.zone !== zone;
    const connected = building.connected || isBuildingStreetConnected(state, building);
    if (zoneCancelled || !connected) {
      const days = (rt.abandonDays.get(building.id) ?? 0) + 1;
      rt.abandonDays.set(building.id, days);
      if (days >= AUTO_DEVELOP.abandonDays) doomed.push(building.id);
    } else {
      rt.abandonDays.delete(building.id);
    }
  }
  if (!doomed.length) return;
  for (const id of doomed) {
    rt.abandonDays.delete(id);
    demolishBuildingById(state, id);
  }
  const day = state.clock.totalDays;
  if (day - rt.lastAbandonLogDay >= 2) {
    rt.lastAbandonLogDay = day;
    ctx.log(
      `${doomed.length} 座自動建築因分區取消或道路中斷而被清拆（開發商放棄）。`,
      'warn',
    );
  }
}

// ─────────────────────────── 自動開發 ───────────────────────────

/**
 * 每次分區開發／需求計算嘅一次過掃描（O(tiles) = 92k，每日一次）：
 * - empty：已劃但未開發格數（供 demand pipeline 用）
 * - sites：各區「可作自動開發 anchor」嘅地塊，並按建築尺寸（1×1／2×2／3×2）分組，
 *   避免 tryDevelopOne 對每個建築定義都重複檢查整片分區。
 * 篩選條件：地形可建、無建築／道路、同尺寸 footprint 全部同區，非農田需臨路。
 */
type SiteSize = '1x1' | '2x2' | '3x2';
const SITE_SIZES: SiteSize[] = ['1x1', '2x2', '3x2'];

interface ZoneSurvey {
  empty: Record<ZoneType, number>;
  sites: Record<ZoneType, Record<SiteSize, number[]>>;
}

function newSiteMap(): Record<SiteSize, number[]> {
  return { '1x1': [], '2x2': [], '3x2': [] };
}

function surveyZoneSites(state: GameState): ZoneSurvey {
  const empty: Record<ZoneType, number> = { residential: 0, commercial: 0, industrial: 0, farmland: 0 };
  const sites: Record<ZoneType, Record<SiteSize, number[]>> = {
    residential: newSiteMap(),
    commercial: newSiteMap(),
    industrial: newSiteMap(),
    farmland: newSiteMap(),
  };
  const width = state.width;
  const height = state.height;
  const tiles = state.tiles;

  const footprintOk = (idx: number, w: number, h: number, zone: ZoneType): boolean => {
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x + w > width || y + h > height) return false;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const tile = tiles[(y + dy) * width + x + dx];
        if (tile.zone !== zone || tile.buildingId >= 0 || tile.road || !TERRAIN_INFO[tile.terrain]?.buildable) {
          return false;
        }
      }
    }
    if (zone === 'farmland') return true;
    // 非農田需 4 鄰接馬路／行人路（道路已整合行人路）
    for (let dx = 0; dx < w; dx++) {
      const left = tiles[(y) * width + x + dx - 1];
      if (left && left.road) return true;
      const rightX = x + dx + 1;
      if (rightX < width) {
        const right = tiles[y * width + rightX];
        if (right && right.road) return true;
      }
    }
    for (let dy = 0; dy < h; dy++) {
      const up = tiles[(y + dy - 1) * width + x];
      if (up && up.road) return true;
      const downY = y + dy + 1;
      if (downY < height) {
        const down = tiles[downY * width + x];
        if (down && down.road) return true;
      }
    }
    return false;
  };

  for (let idx = 0; idx < tiles.length; idx++) {
    const tile = tiles[idx];
    const zone = tile.zone;
    if (!zone) continue;
    if (tile.buildingId >= 0 || tile.road) {
      continue;
    }
    // demand pipeline 用：所有已劃未開發格（唔計地形）
    empty[zone]++;
    if (!TERRAIN_INFO[tile.terrain]?.buildable) continue;
    if (zone === 'farmland') {
      if (tile.terrain !== 'fertile' && tile.terrain !== 'grass') continue;
    }
    const lists = sites[zone];
    for (const size of SITE_SIZES) {
      const [w, h] = size === '1x1' ? [1, 1] : size === '2x2' ? [2, 2] : [3, 2];
      if (!footprintOk(idx, w, h, zone)) continue;
      const list = lists[size];
      if (list.length < MAX_SITES_PER_ZONE) list.push(idx);
      else {
        const slot = ((idx * 2654435761) >>> 0) % list.length;
        if (((idx * 7 + state.clock.totalDays) & 127) === 0) list[slot] = idx;
      }
    }
  }
  return { empty, sites };
}

/** 建築 key 對應 site 尺寸分組 */
function siteSizeOf(def: { size: readonly number[] }): SiteSize {
  const [w, h] = def.size;
  if (w >= 3) return '3x2';
  if (w >= 2 || h >= 2) return '2x2';
  return '1x1';
}

/** 加權抽選：回傳已按「隨機權重」排好序的候選建築定義 */
function weightedOrder(
  defs: ReturnType<typeof zoneBuildingDefs>,
  zoneIndex: number,
  day: number,
  attempt: number,
  seed: number,
  preferFood = false,
): ReturnType<typeof zoneBuildingDefs> {
  const ordered = defs
    .map((def) => ({
      def,
      roll: hash2d(attempt * 131 + zoneIndex * 17, day, seed) / Math.max(0.1, def.weight ?? 1),
    }))
    .sort((a, b) => a.roll - b.roll)
    .map((entry) => entry.def);
  if (preferFood) {
    // 糧食緊張：食品生產建築（食品廠）優先
    ordered.sort((a, b) => {
      const fa = a.production?.output === 'food' ? 0 : 1;
      const fb = b.production?.output === 'food' ? 0 : 1;
      return fa - fb;
    });
  }
  return ordered;
}

/** 嘗試在某分區起一座自動建築；成功回傳 true */
function tryDevelopOne(
  state: GameState,
  zone: ZoneType,
  defs: ReturnType<typeof zoneBuildingDefs>,
  sites: Record<SiteSize, number[]>,
  zoneIndex: number,
  rt: ZoningRuntime,
  focus?: { x: number; y: number } | null,
  preferFood = false,
): boolean {
  const day = state.clock.totalDays;
  const attempt = (state.nextBuildingId + sites['1x1'].length + sites['2x2'].length) % 997;
  const ordered = weightedOrder(defs, zoneIndex, day, attempt, state.seed, preferFood);
  const width = state.width;
  // 農業區：候選地塊按「距離住宅重心」排序（農田工人要通勤，太遠請唔到人）；
  // 只排一次、最多處理 focus 附近 800 個（其餘靠 offset 輪換）。
  let farmSorted: number[] | null = null;
  if (focus && zone === 'farmland') {
    const all: number[] = [];
    for (const size of SITE_SIZES) for (const idx of sites[size]) all.push(idx);
    all.sort((a, b) => {
      const ax = a % width;
      const ay = (a / width) | 0;
      const bx = b % width;
      const by = (b / width) | 0;
      const da = (ax - focus.x) ** 2 + (ay - focus.y) ** 2;
      const db = (bx - focus.x) ** 2 + (by - focus.y) ** 2;
      return da - db;
    });
    farmSorted = all.slice(0, 800);
  }

  let defAttempts = 0;
  // 連續失敗上限：地塊存在但受地形／地區規則限制時，避免同一形狀試幾百次。
  // 分區已連續幾日開發失敗時再收緊（輪到玩家補路／改劃後 stallDays 會歸零）。
  const maxFailsPerDef = rt.stallDays[zone] >= 2 ? 8 : 20;
  for (const def of ordered) {
    if (++defAttempts > 3) break;
    const size = siteSizeOf(def);
    const candidates = farmSorted ?? sites[size];
    if (!candidates.length) continue;
    const offset = Math.floor(
      hash2d(day + attempt * 7 + zoneIndex * 13, candidates.length, state.seed) * candidates.length,
    );
    const tries = Math.min(candidates.length, MAX_ANCHOR_TRIES);
    let fails = 0;
    for (let k = 0; k < tries; k++) {
      const idx = candidates[(offset + k) % candidates.length];
      const x = idx % width;
      const y = (idx / width) | 0;
      // placeAutoBuilding 內部已做齊 canAutoPlaceBuilding 檢查（唔重複驗證，省一半成本）
      const building = placeAutoBuilding(state, def.key, x, y);
      if (building) {
        rt.abandonDays.delete(building.id);
        return true;
      }
      if (++fails >= maxFailsPerDef) break;
    }
  }
  return false;
}

/** 自動開發訊息（每區每 3 日最多一次） */
function logDevelopment(state: GameState, zone: ZoneType, count: number, rt: ZoningRuntime, ctx: SimContext): void {
  const day = state.clock.totalDays;
  if (day - rt.lastLogDay[zone] < 3) return;
  rt.lastLogDay[zone] = day;
  const zoneName = ZONES[zone]?.name ?? zone;
  if (!rt.announcedStart) {
    rt.announcedStart = true;
    ctx.toast('開發商開始喺你劃定嘅分區起樓，城市開始發展！', 'good');
  }
  const text =
    zone === 'residential'
      ? `${zoneName}有 ${count} 座住宅樓宇落成，市民陸續遷入。`
      : zone === 'commercial'
        ? `${zoneName}有 ${count} 間商舖開業，帶動消費與就業。`
        : zone === 'industrial'
          ? `${zoneName}有 ${count} 座廠房／貨倉投產，提供職位與貨源。`
          : `${zoneName}有 ${count} 塊農田開墾，食品供應增加。`;
  ctx.log(text, 'good');
}

/** 過度開發提示（每 12 日最多一次） */
function maybeLogOverSupply(state: GameState, rt: ZoningRuntime, ctx: SimContext): void {
  const day = state.clock.totalDays;
  if (day - rt.lastOverSupplyLogDay < 12) return;
  const zone = ZONE_ORDER.find(
    (z) => (state.zoneDemand[z] ?? 0) <= AUTO_DEVELOP.overSupplyDemand,
  );
  if (!zone) return;
  rt.lastOverSupplyLogDay = day;
  ctx.log(
    `${ZONES[zone]?.name ?? zone}供過於求，開發商暫停建樓；可考慮改劃其他分區或改善配套。`,
    'info',
  );
}

// ─────────────────────────── 每日入口 ───────────────────────────

/** 每日由 simulation.ts 在跨日時呼叫 */
export function tickZoning(state: GameState, ctx: SimContext): void {
  const rt = runtimeOf(state);
  const day = state.clock.totalDays;

  // 0) 一次過掃描（92k tiles，每日一次）：同時得出未開發格數（demand 用）
  //    同各尺寸候選開發地塊，避免 tryDevelopOne 對每個定義重複掃描。
  const survey = surveyZoneSites(state);

  // 1) 需求：計算目標值並平滑寫入 state.zoneDemand
  const target = computeZoneDemand(state, survey.empty);
  if (!state.zoneDemand) state.zoneDemand = emptyZoneDemand();
  for (const zone of ZONE_ORDER) {
    const prev = state.zoneDemand[zone] ?? 0;
    state.zoneDemand[zone] = round2(clamp(prev + (target[zone] - prev) * DEMAND_SMOOTHING, -1, 1));
  }
  // 令同日之後嘅 tickPopulation 讀到最新需求
  state.stats.zoneDemand = { ...state.zoneDemand };

  // 2) 放棄機制（無路／分區取消）
  abandonAutoBuildings(state, rt, ctx);

  // 3) 需求不足 → 暫停開發
  const demand = state.zoneDemand;

  // 4) 全城自動建築上限
  if (autoBuildingCount(state) >= AUTO_DEVELOP.maxAutoBuildings) {
    maybeLogOverSupply(state, rt, ctx);
    return;
  }

  // 5) 自動開發：先 bootstrap（某區 0 棟而需求為正），再按需求由高至低
  const zoneSites = survey.sites;
  const autoByZone: Record<ZoneType, number> = {
    residential: 0,
    commercial: 0,
    industrial: 0,
    farmland: 0,
  };
  for (const building of state.buildings) {
    if (building.auto && building.zone) autoByZone[building.zone]++;
  }
  const hasLand = (zone: ZoneType): boolean => SITE_SIZES.some((size) => zoneSites[zone][size].length > 0);
  const bootstrapZones = ZONE_ORDER.filter(
    (z) => hasLand(z) && autoByZone[z] === 0 && (demand[z] ?? 0) > 0.001,
  ).sort((a, b) => (demand[b] ?? 0) - (demand[a] ?? 0));
  const normalZones = ZONE_ORDER.filter(
    (z) => hasLand(z) && (demand[z] ?? 0) > INTERNAL_MIN_DEMAND,
  ).sort((a, b) => (demand[b] ?? 0) - (demand[a] ?? 0));
  const order = [...bootstrapZones, ...normalZones.filter((z) => !bootstrapZones.includes(z))];
  if (!order.length) {
    maybeLogOverSupply(state, rt, ctx);
    return;
  }

  const score = cityDevelopmentScore(state);
  let globalBudget = AUTO_DEVELOP.maxBuildingsPerDay;
  let builtTotal = 0;

  // 住宅重心（農業區優先喺呢個位置附近開發，方便農田工人通勤）
  let housingX = 0;
  let housingY = 0;
  let housingN = 0;
  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    if (!def || def.housing <= 0) continue;
    housingX += building.x + building.w / 2;
    housingY += building.y + building.h / 2;
    housingN++;
  }
  const housingFocus =
    housingN > 0 ? { x: housingX / housingN, y: housingY / housingN } : { x: state.spawn.x, y: state.spawn.y };

  // 糧食緊張 → 農業區優先開發＋工業區優先建食品廠
  const earlyFoodDays =
    state.stats.foodPerDay > 0 ? state.stats.foodStored / state.stats.foodPerDay : Infinity;
  const foodCritical = earlyFoodDays < 3;
  const prioritizeFarmland = state.citizens.length < 60 && earlyFoodDays < 4;
  if (prioritizeFarmland) {
    const farmIdx = order.indexOf('farmland');
    if (farmIdx > 0) {
      order.splice(farmIdx, 1);
      order.unshift('farmland');
    }
  }

  for (const zone of order) {
    if (globalBudget <= 0) break;
    const zoneDemand = demand[zone] ?? 0;
    const isBootstrap = bootstrapZones.includes(zone) && autoByZone[zone] === 0;
    // 需求越高，起得越多；bootstrap 至少 1 座
    const perZoneAllowance =
      zoneDemand >= 0.45 ? AUTO_DEVELOP.maxBuildingsPerZonePerDay : 1;
    const budget = Math.min(Math.max(1, perZoneAllowance), globalBudget);
    // 自動開發唔再用玩家解鎖人口（unlockPop）限制：改由 minDevScore／需求控制等級，
    // 否則早期（人口 < 10）商業區永遠起唔到便利店，會造成經濟死鎖。
    const defs = zoneBuildingDefs(zone).filter((def) => (def.minDevScore ?? 0) <= score);
    if (!defs.length) continue;
    const zoneIndex = ZONE_ORDER.indexOf(zone);
    const sites = zoneSites[zone];
    let built = 0;
    for (let slot = 0; slot < budget; slot++) {
      if (
        !tryDevelopOne(state, zone, defs, sites, zoneIndex, rt, housingFocus, foodCritical && zone === 'industrial')
      ) {
        break;
      }
      built++;
      builtTotal++;
      if (isBootstrap && built >= 1) break;
    }
    if (built > 0) {
      logDevelopment(state, zone, built, rt, ctx);
      rt.stallDays[zone] = 0;
    } else if (hasLand(zone) && zoneDemand > 0.2) {
      rt.stallDays[zone]++;
      if (rt.stallDays[zone] >= 3 && day - rt.lastStallHintDay[zone] >= 6) {
        rt.lastStallHintDay[zone] = day;
        const name = ZONES[zone]?.name ?? zone;
        const needsBig = zone === 'industrial' || zone === 'commercial' || zone === 'farmland';
        ctx.log(
          needsBig
            ? `${name}有需求但搵唔到合適地塊：較大型建築需要 2×2／3×2 連續分區地塊並臨近馬路，可將分區劃闊少少。`
            : `${name}有需求但搵唔到合適地塊：請確認分區有臨近馬路及足夠空間。`,
          'info',
        );
      }
    }
    globalBudget -= built;
  }

  // 6) 過度開發提示
  if (builtTotal === 0) maybeLogOverSupply(state, rt, ctx);
  void day;
}

// ─────────────────────────── UI 查詢 ───────────────────────────

export interface ZoneDevelopInfo {
  zone: ZoneType;
  tiles: number;
  buildings: number;
  housing: number;
  jobs: number;
  demand: number;
}

export interface ZoneStatsResult {
  demand: Record<ZoneType, number>;
  zoneTiles: Record<ZoneType, number>;
  zoneBuildings: Record<ZoneType, number>;
  autoBuildings: number;
  landValue: number;
  cityScore: number;
  perZone: Record<ZoneType, ZoneDevelopInfo>;
}

/** 分區統計（UI 分區面板／城事面板用） */
export function zoneStats(state: GameState): ZoneStatsResult {
  const zoneTiles: Record<ZoneType, number> = {
    residential: 0,
    commercial: 0,
    industrial: 0,
    farmland: 0,
  };
  for (const tile of state.tiles) {
    if (tile.zone) zoneTiles[tile.zone]++;
  }

  const zoneBuildings: Record<ZoneType, number> = {
    residential: 0,
    commercial: 0,
    industrial: 0,
    farmland: 0,
  };
  const housing: Record<ZoneType, number> = {
    residential: 0,
    commercial: 0,
    industrial: 0,
    farmland: 0,
  };
  const jobs: Record<ZoneType, number> = {
    residential: 0,
    commercial: 0,
    industrial: 0,
    farmland: 0,
  };
  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    if (!def?.zone) continue;
    zoneBuildings[def.zone]++;
    housing[def.zone] += def.housing;
    jobs[def.zone] += def.workers;
  }

  const demand = state.zoneDemand ?? computeZoneDemand(state);
  const perZone = {} as Record<ZoneType, ZoneDevelopInfo>;
  for (const zone of ZONE_ORDER) {
    perZone[zone] = {
      zone,
      tiles: zoneTiles[zone],
      buildings: zoneBuildings[zone],
      housing: housing[zone],
      jobs: jobs[zone],
      demand: round2(demand[zone] ?? 0),
    };
  }

  return {
    demand: { ...demand },
    zoneTiles,
    zoneBuildings,
    autoBuildings: autoBuildingCount(state),
    landValue: Math.round(state.stats.landValue || 40),
    cityScore: cityDevelopmentScore(state),
    perZone,
  };
}

/** 某格可分區／可開發的簡短原因（UI tooltip 用）；null 代表可開發 */
export function zoneBlockReason(state: GameState, x: number, y: number): string | null {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return '超出地圖範圍';
  const tile = state.tiles[y * state.width + x];
  if (tile.road) return '此處是馬路';
  if (tile.buildingId >= 0) return '此處已有建築';
  return null;
}

/** 內部：用於測試／除錯，回傳目前 zone 建築格 footprint 是否完整在分區內 */
export function isFootprintZoned(state: GameState, x: number, y: number, w: number, h: number): boolean {
  const tiles = buildingFootprintTiles(state, x, y, w, h);
  if (!tiles.length) return false;
  for (const idx of tiles) {
    if (!state.tiles[idx].zone) return false;
  }
  return true;
}
