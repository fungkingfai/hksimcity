/**
 * 香港財政系統（《維港之城》）— 對齊 docs/GAME_DESIGN_HK.md §7。
 *
 * 對外契約（docs/ARCHITECTURE.md §5.2）：
 *   tickDailyFinance(state, ctx): void   每日（跨日時呼叫）：服務收入即時入帳
 *   monthlyFinance(state, ctx): void     每月（跨月時結算上月）：稅收、營運支出、月報表
 *
 * ── 收入（7 類，IncomeKind）─────────────────────────────────────
 *  salaryTax 薪俸稅 = Σ 受僱市民月薪 × salaryTaxRate（0..0.2）
 *  profitTax 利得稅 = Σ(商業／工業／物流建築造價 × 5%) × profitTaxRate（0..0.25）
 *                     （GDD §7.2：以建築造價 5% 作每月應評稅利潤的簡化模型）
 *  rates     差餉   = Σ 建築造價（× 等級係數）× ratesRate ÷ 12（按 % 每月，0..0.12）
 *  service   服務收入 = 零售／餐飲每日 incomePerDay × 使用率（即時入帳，見 tickDailyFinance）
 *  fares     車費   = 由 transport-dev 的 transit.ts 每日入帳（本檔不重複計算）
 *  landSale  賣地   = main.ts 即時入帳（$2,500,000／次）
 *  other     其他   = 預留（入口／雜項）
 *
 * ── 支出（6 類，ExpenseKind）────────────────────────────────────
 *  upkeep       維護費   = Σ BuildingDef.upkeep（月底）
 *  civilService 公務員薪酬 = 人口 × $300 + (civic／transport 實際員工) × $1,000
 *  welfare      社會福利   = 長者（65+）× $600 + 失業（工作年齡）× $1,000
 *  infrastructure 基建   = 建造費即時記入（馬路 $0 維護，GDD §7.3）；月底不再計
 *  festival     節慶     = main.ts 煙花匯演即時入帳
 *  other        其他     = 災後維修等（預留）
 *
 * ── 帳務一致性 ──────────────────────────────────────────────────
 *  - finance.incomeThisMonth／expenseThisMonth 與 breakdown 為「本月已發生」累計：
 *    建造費、賣地、煙花、每日服務收入、車費即時入帳；月底把稅收／營運支出補上並計入報表。
 *  - 月報表 balance 恰好等於庫房本月變動（treasury 只再加稅收 − 營運支出）。
 *  - 稅率對民心的影響由 citizens-dev 的 population.ts happinessTarget 計算
 *    （salaryTaxRate × 22、ratesRate × 20）；本檔提供 taxHappinessPenalty() 給 UI 參考，
 *    不再重複扣幸福。赤字（treasury < 0）亦由 population.ts 扣民心，本檔只發破產警告。
 */

import { BASE_MONTHLY_SALARY, BUILDINGS, MONTHS_PER_YEAR, RESOURCES, totalUpkeep } from '../core/config';
import { pipeUpkeepMonthly } from './utilities';
import type {
  Building,
  ExpenseKind,
  Finance,
  GameState,
  IncomeKind,
  MonthRecord,
  ResourceKey,
  SimContext,
} from '../core/types';
import { MARKET_GOODS, accepts, shelfTargetFor } from './logistics-inventory';
import { resetTransitLineMonthly } from './transit';

// ─────────────────────────── 數值常數（GDD §7.2／§7.3） ───────────────────────────

/** 利得稅應評稅利潤：工商物流建築造價的比例（每月） */
export const PROFIT_TAX_BASE_RATE = 0.05;
/** 公務員薪酬：每人每月（人口比例部分） */
export const CIVIL_SERVICE_PER_POP = 300;
/** 公務員薪酬：每位公共服務員工每月（學校／醫院／警署／消防／交通） */
export const CIVIL_SERVICE_PER_WORKER = 1_000;
/** 長者生活津貼（每月，65 歲以上） */
export const WELFARE_ELDERLY = 600;
/** 失業援助（每月，工作年齡市民） */
export const WELFARE_UNEMPLOYED = 1_000;
/** 勞動年齡／退休年齡（與 population.ts 一致） */
const WORKING_AGE = 16;
const RETIRE_AGE = 65;
/** 服務建築備料需可撐幾日才算「貨源充足」 */
const SERVICE_SUPPLY_DAYS = 3;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Round 5 新系統建築（人口 <300 時維護費半價，避免細城市破產） */
const ROUND5_SYSTEM_KEYS = new Set([
  'waterTower',
  'desalPlant',
  'sewagePlant',
  'sewageOutfall',
  'airportTerminal',
  'airCargoTerminal',
  'portGate',
  'portYard',
  'busStop',
  'minibusStop',
  'minibusDepot',
]);
const fmt = (value: number): string => `${Math.round(value).toLocaleString('zh-Hant')}`;

/** 連續虧空月份計數（不進存檔；讀檔後重新累計，只影響警告） */
const fiscalStress = new WeakMap<GameState, number>();

// ─────────────────────────── 帳目小工具 ───────────────────────────

/** 記錄收入（trade.ts 等模組共用） */
export function addIncome(finance: Finance, kind: IncomeKind, amount: number): void {
  if (!(amount > 0)) return;
  const value = round2(amount);
  finance.incomeThisMonth = round2(finance.incomeThisMonth + value);
  finance.incomeBreakdown[kind] = round2((finance.incomeBreakdown[kind] ?? 0) + value);
}

function addExpense(finance: Finance, kind: ExpenseKind, amount: number): void {
  if (!(amount > 0)) return;
  const value = round2(amount);
  finance.expenseThisMonth = round2(finance.expenseThisMonth + value);
  finance.expenseBreakdown[kind] = round2((finance.expenseBreakdown[kind] ?? 0) + value);
}

/**
 * 稅率造成的民心壓力（參考值，GDD §7.4：薪俸每 1% −0.3、利得每 1% −0.1、差餉每 1% −0.2）。
 * 實際幸福計算在 population.ts；此函式只供 UI 顯示／其他模組參考，finance 不會重複扣。
 */
export function taxHappinessPenalty(state: GameState): number {
  const finance = state.finance;
  return round2(
    finance.salaryTaxRate * 100 * 0.3 + finance.profitTaxRate * 100 * 0.1 + finance.ratesRate * 100 * 0.2,
  );
}

// ─────────────────────────── 服務覆蓋 ───────────────────────────

/** 建築中心（與 citizen-common.buildingCenter 一致） */
function centerOf(building: Building): { x: number; y: number } {
  return { x: building.x + building.w / 2, y: building.y + building.h / 2 };
}

/** 服務半徑內的住宅人口（歐氏距離；用於 UI／除錯） */
export function residentsWithinRadius(state: GameState, building: Building, radius: number): number {
  if (!(radius > 0)) return 0;
  const center = centerOf(building);
  const r2 = radius * radius;
  let population = 0;
  for (const home of state.buildings) {
    const homeDef = BUILDINGS[home.key];
    if (!homeDef || homeDef.housing <= 0 || home.residents.length === 0) continue;
    const homeCenter = centerOf(home);
    const dx = homeCenter.x - center.x;
    const dy = homeCenter.y - center.y;
    if (dx * dx + dy * dy <= r2) population += home.residents.length;
  }
  return population;
}

/** 零售貨架平均填充率（用於服務收入使用率；按各建築貨架目標加權平均） */
function shelfFillRatio(building: Building): number {
  let totalTarget = 0;
  let filled = 0;
  for (const resource of MARKET_GOODS) {
    if (!accepts(building, resource)) continue;
    const target = shelfTargetFor(building, resource);
    if (target <= 0) continue;
    totalTarget += target;
    filled += Math.min(target, building.inventory[resource] ?? 0);
  }
  if (totalTarget <= 0) return 1;
  return Math.min(1, filled / totalTarget);
}

// ─────────────────────────── 每日服務收入 ───────────────────────────

/**
 * 每日服務建築收入：街市／超市／便利店／商場（market）、茶餐廳／酒樓（restaurant）。
 * 使用率 util = 人力 × 貨源（GDD §4.6：有貨全額、無貨 ×0.3；零售另按貨架填充率）。
 * 收入即時入庫房、本月累計、incomeBreakdown.service 與建築 incomeThisMonth。
 */
export function tickDailyFinance(state: GameState, ctx: SimContext): void {
  const clock = state.clock;
  const finance = state.finance;
  const starved: string[] = [];

  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    const service = def?.service;
    if (!service) continue;
    if (!building.active || !building.connected) continue;

    const staffing = def.workers > 0 ? Math.min(1, building.workers.length / def.workers) : 1;
    if (staffing <= 0) continue;

    const consumes = service.consumes;
    let supply = 1;

    if (consumes) {
      const stock = building.inventory[consumes.resource] ?? 0;
      const dailyNeed = consumes.amountPerDay;
      if (stock <= 0.05) {
        // GDD §4.6：無貨 → 收入 ×0.3、幸福加成 0
        supply = 0.3;
        starved.push(def.name);
      } else {
        supply = Math.min(1, stock / Math.max(0.1, dailyNeed * SERVICE_SUPPLY_DAYS));
        supply = Math.max(supply, 0.5); // 有貨至少做到半數生意
        // 每日消耗（按人力比例）
        const spend = Math.min(stock, dailyNeed * staffing);
        const left = round2(stock - spend);
        if (left <= 0.005) delete building.inventory[consumes.resource];
        else building.inventory[consumes.resource] = left;
      }
    } else if (service.kind === 'market') {
      // 零售：貨架越滿，生意越好（有貨全額、貨架空虛 ×0.3）
      supply = Math.max(0.3, shelfFillRatio(building));
    }

    if (!service.incomePerDay) continue;

    const util = staffing * supply;
    const income = round2(service.incomePerDay * util);
    if (income <= 0) continue;

    addIncome(finance, 'service', income);
    finance.treasury = round2(finance.treasury + income);
    building.incomeThisMonth = round2(building.incomeThisMonth + income);
  }

  // 缺貨歇業提示（每 5 日一次，且只提示有收入消耗的商家）
  if (starved.length > 0 && clock.totalDays % 5 === 0) {
    const names = [...new Set(starved)].slice(0, 3).join('、');
    ctx.log(`${names}因缺貨而暫停營業，記得讓貨車補貨。`, 'warn');
  }
}

// ─────────────────────────── 每月結算 ───────────────────────────

/** 計算本月稅收（不改帳） */
function computeMonthlyTaxes(state: GameState): {
  salaryTax: number;
  profitTax: number;
  rates: number;
  salaryBase: number;
  profitBase: number;
  ratesBase: number;
} {
  const finance = state.finance;

  // 薪俸稅：受僱市民月薪（市民 salary 由 population.ts 依工作建築設定）
  let salaryBase = 0;
  for (const citizen of state.citizens) {
    if (citizen.workId < 0) continue;
    salaryBase += citizen.salary > 0 ? citizen.salary : BASE_MONTHLY_SALARY;
  }
  const salaryTax = round2(salaryBase * finance.salaryTaxRate);

  // 利得稅：商業／工業／物流建築造價 × 5% 作應評稅利潤（GDD §7.2）
  let profitBase = 0;
  for (const building of state.buildings) {
    if (!building.active) continue;
    const def = BUILDINGS[building.key];
    if (!def) continue;
    if (def.category !== 'commercial' && def.category !== 'industrial' && def.category !== 'logistics') continue;
    profitBase += def.cost * PROFIT_TAX_BASE_RATE;
  }
  const profitBaseRounded = round2(profitBase);
  const profitTax = round2(profitBaseRounded * finance.profitTaxRate);

  // 差餉：建築估值（造價 × 等級係數）× 差餉率 ÷ 12（每月）
  let ratesBase = 0;
  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    if (!def) continue;
    const levelFactor = 1 + (Math.max(1, building.level) - 1) * 0.5;
    ratesBase += def.cost * levelFactor;
  }
  const ratesBaseRounded = round2(ratesBase);
  const rates = round2((ratesBaseRounded * finance.ratesRate) / 12);

  return {
    salaryTax,
    profitTax,
    rates,
    salaryBase: round2(salaryBase),
    profitBase: profitBaseRounded,
    ratesBase: ratesBaseRounded,
  };
}

/** 計算本月營運支出（不改帳） */
function computeMonthlyExpenses(state: GameState): {
  upkeep: number;
  civilService: number;
  welfare: number;
  infrastructure: number;
  civilWorkers: number;
  publicStaffWorkers: number;
  unemployed: number;
  seniors: number;
} {
  // 建築維護：Round 5 新系統（管網／機場碼頭／巴士小巴相關）喺人口 <300 時 50% 折扣，
  // 避免細城市一開局就被新系統維護費拖垮（合約 §7）。
  const populationNow = state.citizens.length;
  const newSystemDiscount = populationNow < 300 ? 0.5 : 1;
  let baseUpkeep = 0;
  let newSystemUpkeep = 0;
  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    const upkeepOfBuilding = def?.upkeep ?? 0;
    if (ROUND5_SYSTEM_KEYS.has(building.key)) newSystemUpkeep += upkeepOfBuilding;
    else baseUpkeep += upkeepOfBuilding;
  }
  const upkeep = round2(baseUpkeep + newSystemUpkeep * newSystemDiscount);

  // 公務員薪酬：人口 × $300 + 公共服務（civic／transport）實際員工 × $1,000
  let publicStaffWorkers = 0;
  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    if (!def) continue;
    if (def.category !== 'civic' && def.category !== 'transport') continue;
    publicStaffWorkers += building.workers.length;
  }
  const population = state.citizens.length;
  const civilService = round2(
    population * CIVIL_SERVICE_PER_POP + publicStaffWorkers * CIVIL_SERVICE_PER_WORKER,
  );

  // 社會福利：長者 + 失業（工作年齡）
  let unemployed = 0;
  let seniors = 0;
  for (const citizen of state.citizens) {
    if (citizen.age >= RETIRE_AGE) {
      seniors++;
      continue;
    }
    if (citizen.workId < 0 && citizen.age >= WORKING_AGE) unemployed++;
  }
  const welfare = round2(seniors * WELFARE_ELDERLY + unemployed * WELFARE_UNEMPLOYED);

  // 基建：GDD §7.3 ROAD_UPKEEP = 0；Round 5 加地下管網每月維護（人口 <300 半價）
  const infrastructure = round2(pipeUpkeepMonthly(state) * newSystemDiscount);

  return {
    upkeep,
    civilService,
    welfare,
    infrastructure,
    civilWorkers: publicStaffWorkers,
    publicStaffWorkers,
    unemployed,
    seniors,
  };
}

/** 月底結算：稅收、營運支出、月報表、破產警告 */
export function monthlyFinance(state: GameState, ctx: SimContext): void {
  const clock = state.clock;
  const finance = state.finance;

  // 跨月後結算的是「上一月」
  const recordYear = clock.month === 1 ? clock.year - 1 : clock.year;
  const recordMonth = clock.month === 1 ? MONTHS_PER_YEAR : clock.month - 1;

  // ── 1) 稅收 ──
  const taxes = computeMonthlyTaxes(state);
  const taxIncome = round2(taxes.salaryTax + taxes.profitTax + taxes.rates);

  // ── 2) 營運支出 ──
  const expenses = computeMonthlyExpenses(state);
  const operatingExpense = round2(
    expenses.upkeep + expenses.civilService + expenses.welfare + expenses.infrastructure,
  );

  // ── 3) 入帳（即時收支早於本月已入庫房；此處只加稅收與營運支出）──
  finance.treasury = round2(finance.treasury + taxIncome - operatingExpense);
  addIncome(finance, 'salaryTax', taxes.salaryTax);
  addIncome(finance, 'profitTax', taxes.profitTax);
  addIncome(finance, 'rates', taxes.rates);
  addExpense(finance, 'upkeep', expenses.upkeep);
  addExpense(finance, 'civilService', expenses.civilService);
  addExpense(finance, 'welfare', expenses.welfare);
  if (expenses.infrastructure > 0) addExpense(finance, 'infrastructure', expenses.infrastructure);

  // ── 4) 月報表 ──
  const income = round2(finance.incomeThisMonth);
  const expense = round2(finance.expenseThisMonth);
  const balance = round2(income - expense);
  const population = state.citizens.length;
  const happiness = population
    ? round2(state.citizens.reduce((sum, citizen) => sum + citizen.happiness, 0) / population)
    : 70;

  const incomeByKind: Partial<Record<IncomeKind, number>> = { ...finance.incomeBreakdown };
  const record: MonthRecord = {
    year: recordYear,
    month: recordMonth,
    income,
    expense,
    balance,
    population,
    happiness: Math.round(happiness),
    incomeByKind,
  };
  finance.history.push(record);
  if (finance.history.length > 24) finance.history.splice(0, finance.history.length - 24);
  finance.lastMonthIncome = income;
  finance.lastMonthExpense = expense;

  // totalIncome：main.ts 賣地時已即時累加，月結扣回該部分避免重複；totalExpense 月結一次過累加
  const landSaleCounted = finance.incomeBreakdown.landSale ?? 0;
  finance.totalIncome = round2(finance.totalIncome + Math.max(0, income - landSaleCounted));
  finance.totalExpense = round2(finance.totalExpense + expense);

  // ── 5) 破產／赤字警告（民心影響由 population.ts 負責）──
  const previousStress = fiscalStress.get(state) ?? 0;
  const negativeMonths = finance.treasury < 0 ? previousStress + 1 : 0;
  fiscalStress.set(state, negativeMonths);

  // ── 6) 訊息（香港用語）──
  const incomeParts: string[] = [];
  const inBd = finance.incomeBreakdown;
  if ((inBd.salaryTax ?? 0) >= 0.5) incomeParts.push(`薪俸稅 ${fmt(inBd.salaryTax ?? 0)}`);
  if ((inBd.profitTax ?? 0) >= 0.5) incomeParts.push(`利得稅 ${fmt(inBd.profitTax ?? 0)}`);
  if ((inBd.rates ?? 0) >= 0.5) incomeParts.push(`差餉 ${fmt(inBd.rates ?? 0)}`);
  if ((inBd.service ?? 0) >= 0.5) incomeParts.push(`服務收入 ${fmt(inBd.service ?? 0)}`);
  if ((inBd.fares ?? 0) >= 0.5) incomeParts.push(`車費 ${fmt(inBd.fares ?? 0)}`);
  if ((inBd.landSale ?? 0) >= 0.5) incomeParts.push(`賣地 ${fmt(inBd.landSale ?? 0)}`);
  if ((inBd.other ?? 0) >= 0.5) incomeParts.push(`其他 ${fmt(inBd.other ?? 0)}`);
  const expenseParts: string[] = [];
  const outBd = finance.expenseBreakdown;
  if ((outBd.upkeep ?? 0) >= 0.5) expenseParts.push(`維護 ${fmt(outBd.upkeep ?? 0)}`);
  if ((outBd.civilService ?? 0) >= 0.5) expenseParts.push(`公務員薪酬 ${fmt(outBd.civilService ?? 0)}`);
  if ((outBd.welfare ?? 0) >= 0.5) expenseParts.push(`福利 ${fmt(outBd.welfare ?? 0)}`);
  if ((outBd.infrastructure ?? 0) >= 0.5) expenseParts.push(`基建 ${fmt(outBd.infrastructure ?? 0)}`);
  if ((outBd.festival ?? 0) >= 0.5) expenseParts.push(`節慶 ${fmt(outBd.festival ?? 0)}`);

  const outcome = balance >= 0 ? `盈餘 +${fmt(balance)}` : `虧蝕 −${fmt(-balance)}`;
  ctx.log(
    `【${recordYear}年${recordMonth}月】財政結算：收入 ${fmt(income)} 元（${incomeParts.join('、') || '暫無收入'}），` +
      `支出 ${fmt(expense)} 元（${expenseParts.join('、') || '暫無支出'}），${outcome}；` +
      `人口 ${population}、民心 ${Math.round(happiness)}、庫房 ${fmt(finance.treasury)} 元。`,
    balance >= 0 ? 'good' : 'warn',
  );

  if (balance < 0 && finance.treasury >= 0) {
    ctx.log(`本月入不敷支 ${fmt(-balance)} 元，留意開支或調整稅率。`, 'warn');
  }
  if (negativeMonths > 0) {
    if (negativeMonths >= 2) {
      ctx.log(`庫房連續 ${negativeMonths} 個月赤字（${fmt(finance.treasury)} 元），市民不滿，速開源節流！`, 'bad');
    } else {
      ctx.log(`庫房出現赤字（${fmt(finance.treasury)} 元），若下月仍未改善，民心將受影響。`, 'bad');
    }
  }

  // ── 7) 新月份重新累計 ──
  finance.incomeThisMonth = 0;
  finance.expenseThisMonth = 0;
  finance.incomeBreakdown = {};
  finance.expenseBreakdown = {};
  for (const building of state.buildings) {
    building.incomeThisMonth = 0;
    building.expenseThisMonth = 0;
  }
  // 車費本月累計由 transit.ts 累加、月結後清零（transport-dev 約定）
  state.transit.faresThisMonth = 0;
  // 巴士／小巴路線月結（Round 5）
  resetTransitLineMonthly(state);

  // 供除錯：保留最後稅基供 UI tooltip 可擴充
  void taxes.salaryBase;
  void taxes.profitBase;
  void taxes.ratesBase;
  void expenses.civilWorkers;
}

// ─────────────────────────── 查詢（UI 用） ───────────────────────────

/** 目前稅率一覽（UI 財政面板） */
export function taxRates(state: GameState): {
  salary: number;
  profit: number;
  rates: number;
} {
  return {
    salary: state.finance.salaryTaxRate,
    profit: state.finance.profitTaxRate,
    rates: state.finance.ratesRate,
  };
}

/** 本月是否入不敷支（UI 紅色警示） */
export function isDeficit(state: GameState): boolean {
  return state.finance.incomeThisMonth < state.finance.expenseThisMonth;
}

/** 本月各收入分類（UI 用，回傳副本） */
export function incomeBreakdownOf(state: GameState): Partial<Record<IncomeKind, number>> {
  return { ...state.finance.incomeBreakdown };
}

/** 本月各支出分類（UI 用，回傳副本） */
export function expenseBreakdownOf(state: GameState): Partial<Record<ExpenseKind, number>> {
  return { ...state.finance.expenseBreakdown };
}

/** 以某資源市價估算貨值（UI／除錯用） */
export function marketValue(resource: ResourceKey, amount: number): number {
  return Math.round((RESOURCES[resource]?.price ?? 0) * amount);
}

/** 預估本月稅收（UI 財政面板「預估月收入」即時顯示用；不改帳） */
export function estimatedMonthlyTaxes(state: GameState): {
  salaryTax: number;
  profitTax: number;
  rates: number;
  total: number;
} {
  const taxes = computeMonthlyTaxes(state);
  return {
    salaryTax: taxes.salaryTax,
    profitTax: taxes.profitTax,
    rates: taxes.rates,
    total: round2(taxes.salaryTax + taxes.profitTax + taxes.rates),
  };
}

/** 預估本月營運支出（UI 用） */
export function estimatedMonthlyExpenses(state: GameState): {
  upkeep: number;
  civilService: number;
  welfare: number;
  total: number;
} {
  const expenses = computeMonthlyExpenses(state);
  return {
    upkeep: expenses.upkeep,
    civilService: expenses.civilService,
    welfare: expenses.welfare,
    total: round2(expenses.upkeep + expenses.civilService + expenses.welfare + expenses.infrastructure),
  };
}
