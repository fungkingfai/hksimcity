/**
 * 開新局：建立完整 GameState（香港版）。
 *
 * 兩種開局模式：
 *  - starter：已有城鎮（中環起步城鎮，預建道路／分區／建築／公共設施；main.ts warm-up）
 *  - empty：由零開始（空地圖＋少量市民＋起始庫房）
 */

import {
  DAYS_PER_MONTH,
  DEFAULT_PROFIT_TAX_RATE,
  DEFAULT_RATES_RATE,
  DEFAULT_SALARY_TAX_RATE,
  GAME_MINUTES_PER_SECOND,
  GAME_VERSION,
  MINUTES_PER_DAY,
  MONTHS_PER_YEAR,
  SEASON_TEMP,
  START_TREASURY,
  START_YEAR,
  pickWeather,
  seasonOfMonth,
} from './config';
import { mulberry32 } from './rng';
import { buildStarterTown } from './starter-town';
import type { GameClock, GameState, NewGameMode, TransitState, UIState, ZoneType } from './types';
import { generateWorld } from '../world/worldgen';

export const DEFAULT_CITY_NAME = '維港之城';

export function createClock(seed: number): GameClock {
  const rng = mulberry32(seed + 99);
  const season = seasonOfMonth(1);
  return {
    minutes: 8 * 60,
    totalDays: 1,
    day: 1,
    month: 1,
    year: 1,
    hour: 8,
    minute: 0,
    weekday: 1,
    season,
    // 開局天氣固定晴朗，給玩家清晰的第一印象（之後才隨季節轉變）
    weather: 'clear',
    weatherMinutesLeft: 240 + Math.floor(rng() * 180),
    tempC: SEASON_TEMP[season],
    warning: null,
    weatherIntensity: 0,
    paused: false,
    speed: 1,
  };
}

export function emptyZoneDemand(): Record<ZoneType, number> {
  return { residential: 0.5, commercial: 0.3, industrial: 0.35, farmland: 0.25 };
}

export function zeroZoneDemand(): Record<ZoneType, number> {
  return { residential: 0, commercial: 0, industrial: 0, farmland: 0 };
}

export function createUIState(showStartScreen = true): UIState {
  return {
    tool: null,
    selectedId: null,
    hover: -1,
    speed: 1,
    paused: false,
    mode: 'city',
    interiorId: null,
    buildCategory: 'civic',
    showFinance: false,
    showHelp: false,
    showSave: false,
    showTutorial: true,
    showTransit: false,
    showStats: false,
    showZones: true,
    showStartScreen,
    revision: 0,
  };
}

export function createTransitState(): TransitState {
  return {
    dailyRidership: 0,
    faresThisMonth: 0,
    suspended: false,
    byMode: { mtr: 0, bus: 0, tram: 0, ferry: 0 },
  };
}

export function createGameState(
  seed = Math.floor(Math.random() * 1e9),
  mode: NewGameMode = 'empty',
  cityName = DEFAULT_CITY_NAME,
): GameState {
  const world = generateWorld(seed, undefined, undefined, { starterRoads: mode === 'starter' });
  const clock = createClock(seed);
  const state: GameState = {
    version: GAME_VERSION,
    seed,
    cityName,
    width: world.width,
    height: world.height,
    spawn: world.spawn,
    gameMode: mode,
    zoneDemand: emptyZoneDemand(),
    tiles: world.tiles,
    buildings: [],
    citizens: [],
    carts: [],
    vehicles: [],
    transit: createTransitState(),
    clock,
    finance: {
      treasury: START_TREASURY,
      salaryTaxRate: DEFAULT_SALARY_TAX_RATE,
      profitTaxRate: DEFAULT_PROFIT_TAX_RATE,
      ratesRate: DEFAULT_RATES_RATE,
      incomeThisMonth: 0,
      expenseThisMonth: 0,
      incomeBreakdown: {},
      expenseBreakdown: {},
      lastMonthIncome: 0,
      lastMonthExpense: 0,
      history: [],
      totalIncome: 0,
      totalExpense: 0,
      lastFestivalDay: -999,
      lastLandSaleDay: -999,
      landSales: 0,
    },
    stats: {
      population: 0,
      households: 0,
      jobs: 0,
      employed: 0,
      unemployed: 0,
      homeless: 0,
      happiness: 70,
      foodStored: 0,
      foodPerDay: 0,
      netIncome: 0,
      goodsInTransit: 0,
      powerCoverage: 0,
      waterCoverage: 0,
      transitCoverage: 0,
      ridership: 0,
      avgCommute: 0,
      typhoonSignal: 0,
      zoneDemand: emptyZoneDemand(),
      zoneTiles: { residential: 0, commercial: 0, industrial: 0, farmland: 0 },
      zoneBuildings: { residential: 0, commercial: 0, industrial: 0, farmland: 0 },
      policeCoverage: 0,
      fireCoverage: 0,
      schoolCoverage: 0,
      hospitalCoverage: 0,
      landValue: 0,
    },
    ui: createUIState(),
    log: [],
    nextBuildingId: 1,
    nextCitizenId: 1,
    nextCartId: 1,
    nextVehicleId: 1,
    nextLogId: 1,
    createdAt: Date.now(),
    savedAt: Date.now(),
  };

  if (mode === 'starter') {
    buildStarterTown(state);
    state.ui.buildCategory = 'civic';
    state.zoneDemand = { residential: 0.6, commercial: 0.4, industrial: 0.4, farmland: 0.15 };
    state.log.push({
      id: state.nextLogId++,
      year: state.clock.year,
      month: state.clock.month,
      day: state.clock.day,
      text: `歡迎回到${cityName}！這是一個已運作的中環社區。你可以劃分更多分區、增建公共設施，繼續擴展城市。`,
      kind: 'info',
    });
  } else {
    state.ui.buildCategory = 'civic';
    state.log.push({
      id: state.nextLogId++,
      year: state.clock.year,
      month: state.clock.month,
      day: state.clock.day,
      text: `歡迎來到${cityName}！先鋪設馬路（馬路已包含行人路），再劃分住宅區、商業區、工業區及農業區；開發商會按需求自動興建。`,
      kind: 'info',
    });
  }
  return state;
}

/** 由分鐘數推算日期欄位（time.ts 亦使用，集中避免重複） */
export function deriveClockFields(clock: GameClock): void {
  const totalMinutes = Math.max(0, clock.minutes);
  const totalDays = Math.floor(totalMinutes / MINUTES_PER_DAY) + 1;
  const minutesOfDay = totalMinutes % MINUTES_PER_DAY;
  clock.totalDays = totalDays;
  clock.hour = Math.floor(minutesOfDay / 60);
  clock.minute = Math.floor(minutesOfDay % 60);
  const monthIndex = (totalDays - 1) % (DAYS_PER_MONTH * MONTHS_PER_YEAR);
  clock.month = Math.floor(monthIndex / DAYS_PER_MONTH) + 1;
  clock.day = (monthIndex % DAYS_PER_MONTH) + 1;
  clock.year = Math.floor((totalDays - 1) / (DAYS_PER_MONTH * MONTHS_PER_YEAR)) + 1;
  clock.season = seasonOfMonth(clock.month);
  // 星期：假日＝真實日期中的星期日（週日）；以開局日為星期一
  clock.weekday = (totalDays - 1) % 7;
}

/** 遊戲分鐘 → 倍速換算 */
export function gameMinutesForRealDelta(realDt: number, speed: number): number {
  return realDt * GAME_MINUTES_PER_SECOND * Math.max(0, speed);
}

/** 顯示年份（2026 年起） */
export function displayYear(year: number): number {
  return START_YEAR + year - 1;
}
