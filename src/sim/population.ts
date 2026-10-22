/**
 * 人口系統：每日遷入／出生／死亡／遷出、住宅分配、就業配對、租金與幸福度公式。
 *
 * 由 simulation.ts 於跨日時呼叫 `tickPopulation(state, ctx)`。
 * 市民的每幀行為（移動、購物、吃飯、消閒）在 citizens.ts；本檔只做人口與配置。
 *
 * 香港住宅階梯（吸引力由差到好）：
 *   劏房 0.55 → 唐樓 0.80 → 公共屋邨 1.00 → 居屋苑 1.12 → 私人屋苑 1.30 → 豪宅 1.50
 * 租金（每月）與居住質素同時影響幸福度；新移民按「吸引力 ÷ 距離」加權選擇住所。
 *
 * 幸福度（0..100）＝ 住宅質素、就業、通勤、食品、日用品、消閒、服務（治安／醫療／
 * 教育／公園）、公用設施（電力／食水覆蓋）、天氣、稅率、租金負擔、節慶、赤字。
 * 每日平滑：下降最多 6、上升最多 4（危機有感覺、復原較慢）。
 *
 * 保持 `tickPopulation(state, ctx)` 對外介面。
 */

import { BUILDINGS, DAYS_PER_MONTH, STARTER_TOWN, WEATHER_EFFECT } from '../core/config';
import type { Building, Citizen, GameState, SimContext, TransitMode, ZoneType } from '../core/types';
import {
  FOOD_PER_CITIZEN_PER_DAY,
  GOODS_PER_CITIZEN_PER_DAY,
  MAX_POPULATION,
  averageHappiness,
  buildingCenter,
  canCommute,
  cachedBuilding,
  clamp,
  createCitizen,
  getCitizenCache,
  getExtras,
  housingCapacity,
  housingVacancies,
  isWorkingAge,
  pickCommuteMode,
  randInt,
  randRange,
  refreshBuildingIndex,
  removeCitizen,
  salaryForWork,
  type CitizenCache,
} from './citizen-common';

// ─────────────────────────── 分區需求 ───────────────────────────

/** 分區需求（-1..1；stats 為準，過渡期回退 state.zoneDemand，最後回退 0） */
export function zoneDemandSnapshot(state: GameState): Record<ZoneType, number> {
  const statsDemand = state.stats?.zoneDemand;
  if (statsDemand && typeof statsDemand.residential === 'number') return statsDemand;
  const stateDemand = state.zoneDemand;
  if (stateDemand && typeof stateDemand.residential === 'number') return stateDemand;
  // 過渡期（zoning／stats 未接駁時）用職位空缺與住宅空置粗估住宅需求
  let jobCap = 0;
  let employed = 0;
  for (const b of state.buildings) {
    const def = BUILDINGS[b.key];
    if (def && def.workers > 0 && b.active) jobCap += b.workers.length;
  }
  for (const c of state.citizens) if (c.workId >= 0) employed++;
  const vacancies = housingVacancies(state).total;
  const estimate = clamp((jobCap - employed) / 200 + (vacancies > 0 ? 0.2 : -0.2), -1, 1);
  return { residential: estimate, commercial: 0, industrial: 0, farmland: 0 };
}

// ─────────────────────────── 住宅階梯 ───────────────────────────

export interface HousingProfile {
  name: string;
  /** 居住質素 0..6（幸福度直接加分） */
  quality: number;
  /** 每月租金（港幣） */
  rent: number;
  /** 遷入吸引力（0.5 差 ~ 1.5 好） */
  attractiveness: number;
}

/** 各住宅類型的質素、租金與吸引力（香港樓宇階梯） */
export const HOUSING_PROFILES: Record<string, HousingProfile> = {
  subdividedFlat: { name: '劏房', quality: 1.5, rent: 3_500, attractiveness: 0.55 },
  tongLau: { name: '唐樓', quality: 3.0, rent: 5_500, attractiveness: 0.8 },
  publicHousing: { name: '公共屋邨', quality: 4.0, rent: 2_400, attractiveness: 1.0 },
  hOSFlat: { name: '居屋苑', quality: 4.6, rent: 9_000, attractiveness: 1.12 },
  privateEstate: { name: '私人屋苑', quality: 5.4, rent: 16_000, attractiveness: 1.3 },
  luxuryTower: { name: '豪宅', quality: 6.0, rent: 32_000, attractiveness: 1.5 },
};

const DEFAULT_HOUSING: HousingProfile = {
  name: '住宅',
  quality: 3.0,
  rent: 5_000,
  attractiveness: 0.8,
};

/** 住宅類型資料（未知 key 回傳一般住宅） */
export function housingProfile(key: string): HousingProfile {
  return HOUSING_PROFILES[key] ?? DEFAULT_HOUSING;
}

/** 市民住所的居住質素（0..6；無家可歸回傳 0） */
export function housingQualityOf(state: GameState, homeId: number): number {
  if (homeId < 0) return 0;
  const home = state.buildings.find((b) => b.id === homeId);
  if (!home) return 0;
  return housingProfile(home.key).quality;
}

/** 市民住所的每月租金（港幣；無家可歸回傳 0） */
export function housingRentOf(state: GameState, homeId: number): number {
  if (homeId < 0) return 0;
  const home = state.buildings.find((b) => b.id === homeId);
  return home ? housingProfile(home.key).rent : 0;
}

// ─────────────────────────── 每日人口結算 ───────────────────────────

export function tickPopulation(state: GameState, ctx: SimContext): void {
  const cache = getCitizenCache(state);
  refreshBuildingIndex(state, cache);

  reconcileAssignments(state, cache);

  // 每年 1 月 1 日全體長一歲（遊戲一年 = 84 日）
  if (state.clock.month === 1 && state.clock.day === 1) {
    for (const citizen of state.citizens) citizen.age = Math.min(110, citizen.age + 1);
  }

  assignHousing(state, cache);
  assignEmployment(state, cache);

  collectRentAndIncome(state, cache);

  const deaths = processDeaths(state, cache);
  const births = processBirths(state, cache);
  const leavers = processEmigration(state, cache);
  const migrants = tryImmigration(state, cache);

  reportPopulationEvents(state, cache, ctx, { births, deaths, leavers, migrants });
}

// ─────────────────────────── 名單一致性 ───────────────────────────

/** 重建 residents／workers 與 citizen.homeId/workId 對應，去除無效與超額參照 */
function reconcileAssignments(state: GameState, cache: CitizenCache): void {
  const citizenById = new Map<number, Citizen>();
  for (const c of state.citizens) citizenById.set(c.id, c);
  const buildingIds = new Set<number>();
  for (const b of state.buildings) buildingIds.add(b.id);

  for (const c of state.citizens) {
    if (c.homeId >= 0 && !buildingIds.has(c.homeId)) {
      c.homeId = -1;
      if (c.targetId === c.homeId) c.targetId = -1;
      if (c.state === 'home') c.state = 'idle';
    }
    if (c.workId >= 0 && !buildingIds.has(c.workId)) {
      c.workId = -1;
      c.salary = 0;
      if (c.state === 'working') c.state = 'idle';
    }
    // 存檔相容：補齊新欄位
    if (typeof c.salary !== 'number') c.salary = salaryForWork(cachedBuilding(cache, c.workId));
    if (!c.commuteMode) c.commuteMode = 'walk';
    if (!c.needs) c.needs = { food: 55, goods: 45, leisure: 40 };
    if (typeof c.needs.leisure !== 'number') c.needs.leisure = 40;
  }

  const homeLists = new Map<number, number[]>();
  const workLists = new Map<number, number[]>();
  for (const c of state.citizens) {
    if (c.homeId >= 0) {
      const list = homeLists.get(c.homeId) ?? [];
      list.push(c.id);
      homeLists.set(c.homeId, list);
    }
    if (c.workId >= 0) {
      const list = workLists.get(c.workId) ?? [];
      list.push(c.id);
      workLists.set(c.workId, list);
    }
  }

  for (const b of state.buildings) {
    const cap = housingCapacity(b);
    if (cap > 0) {
      const ids = (homeLists.get(b.id) ?? []).slice();
      while (ids.length > cap) {
        const id = ids.pop() as number;
        const c = citizenById.get(id);
        if (c) {
          c.homeId = -1;
          if (c.state === 'home') c.state = 'idle';
          if (c.targetId === b.id) c.targetId = -1;
        }
      }
      b.residents = ids;
    } else {
      for (const id of b.residents) {
        const c = citizenById.get(id);
        if (c && c.homeId === b.id) c.homeId = -1;
      }
      b.residents = [];
    }

    const wcap = BUILDINGS[b.key]?.workers ?? 0;
    if (wcap > 0) {
      const ids = (workLists.get(b.id) ?? []).slice();
      while (ids.length > wcap) {
        const id = ids.pop() as number;
        const c = citizenById.get(id);
        if (c) {
          c.workId = -1;
          c.salary = 0;
          if (c.state === 'working') c.state = 'idle';
          if (c.targetId === b.id) c.targetId = -1;
        }
      }
      b.workers = ids;
    } else {
      for (const id of b.workers) {
        const c = citizenById.get(id);
        if (c && c.workId === b.id) {
          c.workId = -1;
          c.salary = 0;
        }
      }
      b.workers = [];
    }
  }
}

// ─────────────────────────── 住宅分配 ───────────────────────────

interface Vacancy {
  building: Building;
  profile: HousingProfile;
  cx: number;
  cy: number;
  cap: number;
}

function vacancyList(state: GameState): Vacancy[] {
  const list: Vacancy[] = [];
  for (const b of state.buildings) {
    const cap = housingCapacity(b);
    if (cap <= 0 || !b.active) continue;
    if (b.residents.length >= cap) continue;
    const center = buildingCenter(b);
    list.push({ building: b, profile: housingProfile(b.key), cx: center.x, cy: center.y, cap });
  }
  return list;
}

/** 無家市民遷入合適的住宅（按吸引力÷距離加權；劏房最後考慮） */
export function assignHousing(state: GameState, cache: CitizenCache): number {
  const now = state.clock.minutes;
  const vacant = vacancyList(state);
  if (!vacant.length) return 0;

  const homeless = state.citizens.filter((c) => c.homeId < 0);
  if (!homeless.length) return 0;

  let moved = 0;
  for (const citizen of homeless) {
    let best: Vacancy | null = null;
    let bestScore = -Infinity;
    for (const v of vacant) {
      if (v.building.residents.length >= v.cap) continue;
      const dist = Math.hypot(v.cx - citizen.x, v.cy - citizen.y);
      const score = v.profile.attractiveness / (1 + dist / 10);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    if (!best) break;
    citizen.homeId = best.building.id;
    best.building.residents.push(citizen.id);
    citizen.happiness = clamp(citizen.happiness + 6, 0, 100);
    if (citizen.targetId < 0) citizen.targetId = best.building.id;
    const extras = getExtras(cache, citizen, now);
    extras.pendingPlan = true;
    extras.busyUntil = now + randRange(20, 90);
    moved++;
  }
  return moved;
}

// ─────────────────────────── 就業配對 ───────────────────────────

/** 讓 16~64 歲無業市民投入可用職缺；優先離家近且道路／公共交通可達的工作 */
export function assignEmployment(state: GameState, cache: CitizenCache): number {
  interface JobSlot {
    building: Building;
    slots: number;
    cx: number;
    cy: number;
    isFood: boolean;
  }
  const jobs: JobSlot[] = [];
  for (const b of state.buildings) {
    const def = BUILDINGS[b.key];
    if (!def || def.workers <= 0 || !b.active) continue;
    const slots = def.workers - b.workers.length;
    if (slots <= 0) continue;
    const center = buildingCenter(b);
    jobs.push({
      building: b,
      slots,
      cx: center.x,
      cy: center.y,
      isFood: def.production?.output === 'food',
    });
  }
  if (!jobs.length) return 0;

  const unemployed = state.citizens.filter((c) => isWorkingAge(c) && c.workId < 0);
  if (!unemployed.length) return 0;

  // 糧食緊張時優先派市民去農田／食品廠（否則遠處農田長期缺人 → 全城缺糧）
  const foodCritical =
    state.stats.foodPerDay > 0 && state.stats.foodStored / state.stats.foodPerDay < 2;
  const foodJobs = foodCritical ? jobs.filter((j) => j.isFood) : null;

  /**
   * 以單次線性掃描揀最近 k 個空缺（避免每位失業市民 sort 整份 jobs：高密度時 O(U×J log J)）。
   * foodCritical 時候選 = 最近 k 個糧食職位，唔夠再補最近的非糧食職位。
   */
  const pickNearest = (source: JobSlot[], x: number, y: number, k: number): JobSlot[] => {
    const top: JobSlot[] = [];
    const dists: number[] = [];
    for (const j of source) {
      if (j.slots <= 0) continue;
      const dx = j.cx - x;
      const dy = j.cy - y;
      const d = dx * dx + dy * dy;
      if (top.length < k) {
        let i = top.length;
        top.push(j);
        dists.push(d);
        while (i > 0 && dists[i] < dists[i - 1]) {
          const tj = top[i - 1];
          top[i - 1] = top[i];
          top[i] = tj;
          const td = dists[i - 1];
          dists[i - 1] = dists[i];
          dists[i] = td;
          i--;
        }
      } else if (d < dists[k - 1]) {
        top[k - 1] = j;
        dists[k - 1] = d;
        let i = k - 1;
        while (i > 0 && dists[i] < dists[i - 1]) {
          const tj = top[i - 1];
          top[i - 1] = top[i];
          top[i] = tj;
          const td = dists[i - 1];
          dists[i - 1] = dists[i];
          dists[i] = td;
          i--;
        }
      }
    }
    return top;
  };

  // 同一個 home→work 配對（家庭成員同住）只需檢查一次 canCommute
  const commuteCache = new Map<string, boolean>();
  const canReach = (home: Building | null, homeId: number, job: JobSlot): boolean => {
    const key = `${homeId}:${job.building.id}`;
    let ok = commuteCache.get(key);
    if (ok === undefined) {
      ok = canCommute(state, cache, home, job.building);
      if (!ok && job.isFood) {
        // 糧食生產（農田／食品廠）通勤放寬：離家 28 格內可聘用（農業工人住田邊宿舍／
        // 僱主接駁）；否則偏遠農田永遠缺人，全城缺糧。
        if (home) {
          const dx = job.cx - (home.x + home.w / 2);
          const dy = job.cy - (home.y + home.h / 2);
          if (Math.hypot(dx, dy) <= 28) ok = true;
        }
      }
      commuteCache.set(key, ok);
    }
    return ok;
  };

  const candidateLimit = foodCritical ? 8 : 5;
  let hired = 0;
  for (const citizen of unemployed) {
    const home = cachedBuilding(cache, citizen.homeId);
    const hx = home ? home.x + home.w / 2 : citizen.x;
    const hy = home ? home.y + home.h / 2 : citizen.y;
    let candidates: JobSlot[];
    if (foodJobs && foodJobs.length) {
      candidates = pickNearest(foodJobs, hx, hy, candidateLimit);
      if (candidates.length < candidateLimit) {
        for (const extra of pickNearest(jobs, hx, hy, candidateLimit - candidates.length)) {
          if (!candidates.includes(extra)) candidates.push(extra);
        }
      }
    } else {
      candidates = pickNearest(jobs, hx, hy, candidateLimit);
    }

    for (const job of candidates) {
      if (job.slots <= 0) continue;
      if (!canReach(home, citizen.homeId, job)) continue;
      citizen.workId = job.building.id;
      citizen.salary = salaryForWork(job.building);
      citizen.commuteMode = pickCommuteMode(state, home, job.building);
      job.building.workers.push(citizen.id);
      job.slots--;
      if (citizen.state === 'idle') citizen.state = home ? 'home' : 'idle';
      const extras = getExtras(cache, citizen, state.clock.minutes);
      extras.pendingPlan = true;
      hired++;
      break;
    }
  }
  return hired;
}

// ─────────────────────────── 租金與個人收入 ───────────────────────────

const LIVING_COST_PER_DAY = 6_000 / DAYS_PER_MONTH;
/** 失業救濟（象徵式，只入市民私人錢財，不涉國庫） */
const WELFARE_PER_DAY = 250;

/** 每日收租、出糧、生活費（市民私人錢財；不影響國庫） */
function collectRentAndIncome(state: GameState, cache: CitizenCache): void {
  for (const citizen of state.citizens) {
    const home = cachedBuilding(cache, citizen.homeId);
    const rent = home ? housingProfile(home.key).rent / DAYS_PER_MONTH : 0;

    // 收入：在職月薪 ÷ 每月日數；失業／退休人士象徵式救濟
    let income = 0;
    if (citizen.workId >= 0 && citizen.salary > 0) {
      const work = cachedBuilding(cache, citizen.workId);
      income = work && work.active ? citizen.salary / DAYS_PER_MONTH : WELFARE_PER_DAY;
    } else if (!isWorkingAge(citizen)) {
      income = WELFARE_PER_DAY;
    }

    const net = income - LIVING_COST_PER_DAY - rent;
    citizen.money = clamp(citizen.money + net, 0, 2_000_000);

    // 交不起租：欠租扣幸福（不趕走，避免人口大起大落）
    if (rent > 0 && citizen.money < 100) {
      citizen.happiness = clamp(citizen.happiness - 0.6, 0, 100);
    }
  }
}

// ─────────────────────────── 幸福度公式 ───────────────────────────

/** 每日幸福度計算的輸入（由 citizens.ts 掃描需求／服務後提供） */
export interface HappinessInputs {
  /** 服務加成（治安＋醫療＋教育＋公園＋海濱等，上限 20） */
  serviceHappiness: number;
  /** 住所有沒有零售店（街市／超市／便利店／商場） */
  hasMarket: boolean;
  /** 住所有沒有餐廳（茶餐廳／酒樓） */
  hasRestaurant: boolean;
  /** 估計單程通勤時間（遊戲分鐘） */
  commuteMinutes: number;
  /** 通勤方式 */
  commuteMode: TransitMode | 'walk';
  /** 節慶效應（0..12） */
  festivalBoost: number;
  /** 服務覆蓋率 0..1（stats 提供；警／消／校／醫；各 −2..+2，合共最多 +8） */
  policeCoverage: number;
  fireCoverage: number;
  schoolCoverage: number;
  hospitalCoverage: number;
}

/**
 * 市民幸福度目標值（0..100）。
 * 組成：需求（食品／日用品／消閒）＋服務＋就業＋住宅質素＋通勤＋公用設施＋天氣
 *       − 稅率 − 租金負擔 − 貧窮 − 無家 − 赤字。
 */
export function happinessTarget(state: GameState, citizen: Citizen, inputs: HappinessInputs): number {
  const home = citizen.homeId >= 0 ? state.buildings.find((b) => b.id === citizen.homeId) : null;
  const profile = home ? housingProfile(home.key) : null;

  // 需求 0..100 → 最多 +30
  let target = 44;
  target += citizen.needs.food * 0.14; // 最多 14
  target += citizen.needs.goods * 0.09; // 最多 9
  target += citizen.needs.leisure * 0.09; // 最多 9

  // 服務點加成（公園／海濱／商場／餐廳；治安／醫療／教育改用下方 stats 覆蓋率，避免重複）
  target += Math.min(20, Math.max(0, inputs.serviceHappiness));

  // 服務覆蓋率（警／消／校／醫；各 −2..+2，合共最多 +8）。
  // 小城市（人口 <150）權重遞減：這些設施解鎖人口較高，早期不可能有覆蓋，不宜重罰。
  const coverageWeight = clamp(state.citizens.length / 150, 0.3, 1);
  const coverageTerm = (value: number): number => (clamp(value, 0, 1) - 0.5) * 4 * coverageWeight;
  target += coverageTerm(inputs.policeCoverage);
  target += coverageTerm(inputs.fireCoverage);
  target += coverageTerm(inputs.schoolCoverage);
  target += coverageTerm(inputs.hospitalCoverage);

  // 分區供需長期失衡小懲罰（工商農供過於求 → 經濟不景；最多 −3）
  const demand = zoneDemandSnapshot(state);
  const overSupply =
    Math.max(0, -demand.commercial) * 0.6 +
    Math.max(0, -demand.industrial) * 0.25 +
    Math.max(0, -demand.farmland) * 0.15;
  target -= Math.min(3, overSupply * 3);

  // 就業
  if (isWorkingAge(citizen)) target += citizen.workId >= 0 ? 5 : -5;
  else if (citizen.age >= 65) target += 1;

  // 住宅質素（劏房 1.5 ~ 豪宅 6.0）
  if (profile) target += profile.quality;
  else target -= 14; // 無家可歸

  // 通勤：公共交通有加分，過長通勤扣分
  if (inputs.commuteMode !== 'walk') target += 2;
  target -= Math.min(6, Math.max(0, (inputs.commuteMinutes - 20) * 0.08));

  // 租金負擔：住所租金佔月薪比重太高扣分
  if (profile && citizen.workId >= 0 && citizen.salary > 0) {
    const burden = (profile.rent / citizen.salary) * 100;
    if (burden > 35) target -= Math.min(5, (burden - 35) * 0.12);
  } else if (profile && citizen.workId < 0) {
    target -= 2; // 無業交租壓力
  }
  if (citizen.money < 300) target -= 3;

  // 零售／餐廳可達性
  if (inputs.hasMarket) target += 1.5;
  if (inputs.hasRestaurant) target += 1.5;

  // 公用設施覆蓋（0..1 → ±6）；小城市（人口 < 160）權重遞減，
  // 因為發電廠／水務設施本身解鎖人口較高，早期不可能有覆蓋。
  // 人口 <80：未解鎖發電廠／水務設施，不扣分；80→200 線性增加至全額。
  const popNow = state.citizens.length;
  const utilityWeight = popNow >= 200 ? 1 : popNow < 80 ? 0 : (popNow - 80) / 120;
  target += ((state.stats.powerCoverage ?? 0) - 0.5) * 12 * utilityWeight;
  target += ((state.stats.waterCoverage ?? 0) - 0.5) * 12 * utilityWeight;

  // 稅率（薪俸稅 0..0.2、差餉 0..0.12）
  const taxPenalty = state.finance.salaryTaxRate * 22 + state.finance.ratesRate * 20;
  target -= taxPenalty;

  // 天氣
  target += WEATHER_EFFECT[state.clock.weather]?.happiness ?? 0;

  // 節慶（維港煙花匯演後的餘韻）
  target += inputs.festivalBoost;

  // 庫房赤字
  if (state.finance.treasury < 0) target -= 4;

  return clamp(target, 0, 100);
}

/** 每日更新一位市民的幸福度（下降快、上升慢） */
export function applyDailyHappiness(state: GameState, citizen: Citizen, inputs: HappinessInputs): void {
  const target = happinessTarget(state, citizen, inputs);
  const delta = clamp(target - citizen.happiness, -6, 4);
  citizen.happiness = clamp(citizen.happiness + delta, 0, 100);
}

// ─────────────────────────── 死亡 ───────────────────────────

function processDeaths(state: GameState, cache: CitizenCache): number {
  const now = state.clock.minutes;
  const harsh = state.clock.season === 'winter' ? 1.2 : 1;
  const dead: Citizen[] = [];

  for (const citizen of state.citizens) {
    let p = 0.00035 + Math.max(0, citizen.age - 60) * 0.00022;
    const extras = getExtras(cache, citizen, now);
    if (extras.starveDays > 5) p += 0.025 * Math.min(5, extras.starveDays - 5);
    if (citizen.happiness < 20) p *= 1.4;
    if (state.clock.weather === 'storm' && citizen.homeId < 0) p *= 1.5;
    p *= harsh;
    if (Math.random() < p) dead.push(citizen);
  }

  let count = 0;
  for (const citizen of dead) {
    removeCitizen(state, cache, citizen.id);
    count++;
  }
  return count;
}

// ─────────────────────────── 出生 ───────────────────────────

function processBirths(state: GameState, cache: CitizenCache): number {
  const pop = state.citizens.length;
  if (pop >= MAX_POPULATION) return 0;
  const vacancies = housingVacancies(state).total;
  if (vacancies <= 0) return 0;
  if (averageHappiness(state) < 66) return 0;

  // 每 100 居民每日約 0.35 名新生（遊戲年僅 84 日，兒童會隨年長大）
  const expected = pop * 0.0035;
  let count = Math.floor(expected);
  if (Math.random() < expected - count) count++;
  count = Math.min(count, vacancies, MAX_POPULATION - pop, 4);
  if (count <= 0) return 0;

  const avg = averageHappiness(state);
  let born = 0;
  for (let i = 0; i < count; i++) {
    const candidates = state.buildings.filter((b) => {
      const cap = housingCapacity(b);
      return cap > 0 && b.active && b.residents.length < cap;
    });
    if (!candidates.length) break;
    // 父母住在同一屋苑優先（在該住宅出生的機率較高）
    const parents = state.citizens.filter((c) => c.homeId >= 0 && c.age >= 18 && c.age <= 45);
    let home = candidates[randInt(0, candidates.length - 1)];
    if (parents.length && Math.random() < 0.7) {
      const parent = parents[randInt(0, parents.length - 1)];
      const parentHome = candidates.find((b) => b.id === parent.homeId);
      if (parentHome) home = parentHome;
    }
    // 新生兒以 1~3 歲幼童出現（遊戲年 84 日，會逐年長大）
    createCitizen(state, cache, {
      age: randInt(1, 3),
      gender: Math.random() < 0.5 ? 'male' : 'female',
      homeId: home.id,
      happiness: clamp(avg + randRange(-5, 5), 40, 92),
      money: randRange(0, 1_000),
      food: 70,
      goods: 55,
      leisure: 35,
      state: 'home',
    });
    born++;
  }
  return born;
}

// ─────────────────────────── 遷出 ───────────────────────────

function processEmigration(state: GameState, cache: CitizenCache): number {
  const now = state.clock.minutes;
  const pop = state.citizens.length;
  if (pop === 0) return 0;
  const maxLeavers = Math.max(1, Math.floor(pop / 80));
  const leavers: Citizen[] = [];

  for (const citizen of state.citizens) {
    const extras = getExtras(cache, citizen, now);
    if (citizen.homeId < 0) extras.homelessDays++;
    else extras.homelessDays = 0;
    if (citizen.happiness < 28) extras.lowHappinessDays++;
    else extras.lowHappinessDays = 0;

    const suffers = extras.lowHappinessDays >= 3 || extras.homelessDays >= 5;
    if (!suffers) continue;
    if (leavers.length >= maxLeavers) continue;
    // 失業兼冇錢更加想走
    const chance = citizen.workId < 0 && citizen.money < 1_000 ? 0.18 : 0.1;
    if (Math.random() < chance) leavers.push(citizen);
  }

  for (const citizen of leavers) removeCitizen(state, cache, citizen.id);
  return leavers.length;
}

// ─────────────────────────── 移民遷入 ───────────────────────────

/**
 * 每日移民：與分區住宅需求（stats.zoneDemand.residential）掛鈎。
 *   - 需求正 → 加快遷入（demandFactor 1+d×1.6）；需求負（住宅過剩）→ 大幅放慢
 *   - 空置單位比例高時放慢（需求正時 ×0.3 系數、需求負時 ×0.75；starter warm-up 有下限 0.65）
 *   - starter 模式首 warmupDays+1 日：demandFactor 最少 1.4、每日上限 14（預建城鎮要快速填滿）
 *   - 平均幸福 ≥40（人口 <60 時 37）才會有人搬入；家庭 1–3 人按住宅吸引力加權入伙
 * 回傳遷入人數。
 */
export function tryImmigration(state: GameState, cache: CitizenCache): number {
  const pop = state.citizens.length;
  if (pop >= MAX_POPULATION) return 0;

  const { total: vacancies, houses } = housingVacancies(state);
  if (houses === 0 || vacancies <= 0) return 0;

  const happiness = averageHappiness(state);
  // 遷入門檻：一般 40；人口 < 60 時再放寬 3（早期未有零售／公園，避免人口死鎖）
  const threshold = pop < 60 ? 37 : 40;
  if (happiness < threshold) return 0;

  // ── 分區住宅需求：正 → 加快、負／過剩 → 放慢 ──
  const demand = zoneDemandSnapshot(state).residential;
  // starter 模式 warm-up：預建城鎮本身已有大量住宅空位，需求公式會因空置率高而轉負；
  // 這段時間要盡快填滿，否則 warm-up 後人口不足（Lead 目標：10 日 100–150 人）。
  const warmingUp = state.gameMode === 'starter' && state.clock.totalDays <= STARTER_TOWN.warmupDays + 1;
  const demandFactor = warmingUp ? Math.max(1.4, clamp(1 + demand * 1.6, 0.15, 3.2)) : clamp(1 + demand * 1.6, 0.15, 3.2);

  // ── 空置率：住宅單位空置多時放慢遷入（需求正時只輕微放慢）──
  let totalHousing = 0;
  for (const b of state.buildings) {
    const cap = housingCapacity(b);
    if (cap <= 0 || !b.active) continue;
    totalHousing += cap;
  }
  const vacancyRatio = totalHousing > 0 ? vacancies / totalHousing : 0;
  let vacancyDamp = 1 - vacancyRatio * (demand > 0.15 ? 0.3 : 0.75);
  if (warmingUp) vacancyDamp = Math.max(0.65, vacancyDamp);

  // 城市吸引力：民心越高、越多空位（有樓住）越多新家庭
  const attractiveness = clamp((happiness - (threshold - 6)) / 90, 0.05, 0.6);
  let expected = 0;
  const rolls = Math.min(vacancies, 60);
  for (let i = 0; i < rolls; i++) {
    if (Math.random() < attractiveness) expected++;
  }
  expected = expected * demandFactor * Math.max(0.1, vacancyDamp);
  if (expected <= 0.5) return 0;

  // 每日上限：starter warm-up 14 人；早期（<60 人）最多 14 人，之後按人口規模放寬（5 + pop/20）
  const dailyCap = warmingUp ? 14 : pop < 60 ? 14 : 5 + Math.floor(pop / 20);
  const count = Math.min(Math.round(expected), dailyCap, MAX_POPULATION - pop);
  if (count <= 0) return 0;

  const now = state.clock.minutes;
  let moved = 0;
  let remaining = count;
  for (let n = 0; n < count && remaining > 0; n++) {
    const candidates = state.buildings.filter((b) => {
      const cap = housingCapacity(b);
      return cap > 0 && b.active && b.residents.length < cap;
    });
    if (!candidates.length) break;
    // 按吸引力加權選住宅
    let totalWeight = 0;
    for (const b of candidates) totalWeight += housingProfile(b.key).attractiveness;
    let roll = Math.random() * totalWeight;
    let home = candidates[candidates.length - 1];
    for (const b of candidates) {
      roll -= housingProfile(b.key).attractiveness;
      if (roll <= 0) {
        home = b;
        break;
      }
    }

    // 一個家庭 1~3 人（戶主＋伴侶／子女），受住宅空位限制
    const room = housingCapacity(home) - home.residents.length;
    const familySize = Math.min(room, remaining, 1 + (Math.random() < 0.45 ? 1 : 0) + (Math.random() < 0.25 ? 1 : 0));
    const adultCount = Math.min(familySize, Math.random() < 0.35 ? 2 : 1);
    const happinessBase = randRange(50, 66);
    for (let m = 0; m < familySize; m++) {
      const isAdult = m < adultCount;
      const age = isAdult ? randInt(18, 46) : randInt(1, 12);
      const citizen = createCitizen(state, cache, {
        age,
        homeId: home.id,
        happiness: happinessBase + randRange(-4, 4),
        money: isAdult ? randRange(3_000, 12_000) : randRange(200, 1_500),
        state: 'home',
      });
      const extras = getExtras(cache, citizen, now);
      extras.pendingPlan = false;
      extras.busyUntil = now + randRange(40, 180);
    }
    moved += familySize;
    remaining -= familySize;
  }
  return moved;
}

// ─────────────────────────── 通知與里程碑 ───────────────────────────

interface PopulationEvents {
  births: number;
  deaths: number;
  leavers: number;
  migrants: number;
}

function reportPopulationEvents(
  state: GameState,
  cache: CitizenCache,
  ctx: SimContext,
  events: PopulationEvents,
): void {
  const pop = state.citizens.length;

  if (events.migrants > 0 && state.clock.totalDays - cache.lastImmigrationToastDay >= 10) {
    cache.lastImmigrationToastDay = state.clock.totalDays;
    ctx.log(`新家庭搬進維港之城：${events.migrants} 人遷入定居，街坊愈來愈熱鬧。`, 'good');
  }
  if (events.leavers > 0 && state.clock.totalDays % 5 === 0) {
    ctx.log(`有 ${events.leavers} 名市民搬離本市，民心與居住環境急需改善。`, 'warn');
  }

  // 人口里程碑（以 100 為級距；最後一級為上限）
  const milestones = [50, 100, 200, 400, 600, 800, 1000, 1200, 1400, MAX_POPULATION];
  for (const threshold of milestones) {
    if (pop >= threshold && cache.populationMilestone < threshold) {
      cache.populationMilestone = threshold;
      if (threshold === MAX_POPULATION) {
        ctx.log(`維港之城人口達到上限 ${MAX_POPULATION} 人，成為國際都會！`, 'good');
      } else {
        ctx.log(`市區人口突破 ${threshold} 人，樓宇與交通需求大增。`, 'good');
      }
      break;
    }
  }

  // 失業提醒（偶爾）
  if (pop >= 20) {
    let unemployed = 0;
    for (const c of state.citizens) if (isWorkingAge(c) && c.workId < 0) unemployed++;
    if (unemployed / pop > 0.3 && state.clock.totalDays - cache.lastJobToastDay > 6) {
      cache.lastJobToastDay = state.clock.totalDays;
      ctx.log(`約有 ${unemployed} 名市民失業，多建商業／工業／交通建築創造就業吧。`, 'warn');
    }
  }
}

// 供 citizens.ts 匯總需求時使用的小工具（保持人口模組對外的純查詢）
export { FOOD_PER_CITIZEN_PER_DAY, GOODS_PER_CITIZEN_PER_DAY };
