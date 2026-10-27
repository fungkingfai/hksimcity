/**
 * 時間系統（香港版）：推進時鐘、日期換算、四季轉換、天氣轉移、氣溫、天文台警告。
 *
 * 對外契約（見 docs/ARCHITECTURE.md）：
 *   advanceClock(state, gameMinutes, ctx): TickFlags
 *   weatherModifiers(state) / daylightFactor(state) / weatherLabel(state) / isNight()
 *
 * 香港氣候設計
 * - 天氣：晴 clear／陰 cloudy／雨 rain／颱風 storm／霧 fog／雪 snow（寒潮，冬季罕見）。
 * - 春季潮濕大霧、夏季酷熱多雨兼颱風、秋季晴朗乾爽、冬季清涼有寒潮。
 * - 颱風期間天文台發出八號風球：戶外交通停擺、渡輪停航、地盤停工；渡輪狀態由
 *   `state.transit.suspended` 表示（本檔直接設定，transit 模組亦會同步）。
 * - 天氣持續 300~720 分鐘（約 6~15 真實秒 @1 倍速），颱風較短、霧較長。
 * - 氣溫 = 季節基準 + 日夜正弦 + 天氣修正，指數平滑；颱風／寒潮會令氣溫急降。
 */

import { deriveClockFields } from '../core/new-game';
import {
  SEASON_INFO,
  SEASON_TEMP,
  START_YEAR,
  WEATHER_EFFECT,
  WEATHER_INFO,
  WEATHER_WEIGHTS,
} from '../core/config';
import { mulberry32, type Rng } from '../core/rng';
import type { GameState, LogKind, Season, SimContext, Weather } from '../core/types';
import {
  hkoClockSignal,
  hkoClockTyphoonName,
  hkoDailyTyphoonProbability,
  hkoRainstormWarning,
  hkoDirectionFromName,
  hkoSampleTyphoonSignal,
  hkoTyphoonSignalName,
  hkoTyphoonWarningText,
  type HkoTyphoonDirection,
  type HkoTyphoonSignal,
} from './hko-climate';

export interface TickFlags {
  newDay: boolean;
  newMonth: boolean;
  newYear: boolean;
  /** 季節轉換（春→夏→秋→冬），本幀剛跨過季界 */
  newSeason: boolean;
}

/** 天氣粒子／強度的目標值 */
const WEATHER_TARGET_INTENSITY: Record<Weather, number> = {
  clear: 0,
  cloudy: 0.12,
  rain: 0.78,
  storm: 0.95,
  fog: 0.62,
  snow: 0.9,
};

const ALL_WEATHERS: Weather[] = ['clear', 'cloudy', 'rain', 'storm', 'fog', 'snow'];

/** 天氣持續時間（遊戲分鐘） */
const WEATHER_MIN_MINUTES = 300;
const WEATHER_VARIANCE_MINUTES = 420;
/** 不同天氣的持續倍率 */
const WEATHER_DURATION_MULT: Record<Weather, number> = {
  clear: 1.2,
  cloudy: 1.0,
  rain: 0.85,
  storm: 0.5,
  fog: 1.1,
  snow: 0.7,
};

/** 天氣對氣溫的修正（攝氏） */
const WEATHER_TEMP_OFFSET: Record<Weather, number> = {
  clear: 1,
  cloudy: -1,
  rain: -2,
  storm: -2,
  fog: 0,
  snow: -8,
};

/** 日夜溫差振幅（攝氏） */
const DIURNAL_AMPLITUDE = 5;

function weatherEntries(season: Season): [Weather, number][] {
  const weights = WEATHER_WEIGHTS[season];
  const entries: [Weather, number][] = [];
  for (const weather of ALL_WEATHERS) {
    const weight = weights[weather] ?? 0;
    if (weather === 'snow' && season !== 'winter') continue;
    if (weight > 0) entries.push([weather, weight]);
  }
  if (!entries.length) entries.push(['clear', 1]);
  return entries;
}

function weatherRng(state: GameState): Rng {
  const { clock } = state;
  const salt =
    Math.floor(clock.minutes) * 2654435761 +
    clock.totalDays * 40503 +
    Math.floor(clock.weatherMinutesLeft * 977);
  return mulberry32((state.seed ^ salt) >>> 0);
}

/**
 * 非颱風天氣選擇（HKO 熱帶氣旋機率由 rollWeather 另外處理，呢度排除 storm）。
 * 權重沿用 WEATHER_WEIGHTS（四季氣候），storm 權重唔再使用。
 */
function chooseNonStormWeather(season: Season, current: Weather, rng: Rng): Weather {
  const entries = weatherEntries(season).filter(([weather]) => weather !== 'storm');
  if (!entries.length) return 'clear';
  let total = 0;
  for (const [weather, weight] of entries) total += weather === current ? weight * 1.25 : weight;
  let roll = rng() * total;
  for (const [weather, weight] of entries) {
    roll -= weather === current ? weight * 1.25 : weight;
    if (roll <= 0) return weather;
  }
  return entries[entries.length - 1][0];
}

/** 每次颱風天氣 runtime 資料（方向、強度目標；唔入存檔） */
interface TyphoonRuntime {
  direction: HkoTyphoonDirection | null;
  /** 依風球級數決定 storm 天氣強度目標 */
  intensityTarget: number;
  lastSignal: HkoTyphoonSignal;
}

const typhoonRuntimes = new WeakMap<GameState, TyphoonRuntime>();

function typhoonRuntimeOf(state: GameState): TyphoonRuntime {
  let rt = typhoonRuntimes.get(state);
  if (!rt) {
    rt = { direction: null, intensityTarget: 0.86, lastSignal: 0 };
    typhoonRuntimes.set(state, rt);
  }
  return rt;
}

/** 風球級數 → storm 天氣強度目標 */
function signalIntensityTarget(signal: HkoTyphoonSignal): number {
  switch (signal) {
    case 1:
      return 0.52;
    case 3:
      return 0.68;
    case 8:
      return 0.88;
    case 9:
      return 0.96;
    case 10:
      return 1;
    default:
      return 0.86;
  }
}

/** 寫入 clock 嘅風球欄位（Lead 加 types 前後都兼容；非颱風時清零） */
function writeClockTyphoon(
  clock: GameState['clock'],
  signal: HkoTyphoonSignal,
  direction: HkoTyphoonDirection | null,
): void {
  const fields = clock as GameState['clock'] & {
    typhoonSignal?: number;
    typhoonName?: string | null;
  };
  fields.typhoonSignal = signal;
  fields.typhoonName = signal > 0 ? hkoTyphoonSignalName(signal, direction) : null;
}

function seasonName(season: Season): string {
  return SEASON_INFO[season].name;
}

function seasonToast(season: Season): string {
  switch (season) {
    case 'spring':
      return '春天潮濕多霧，維港一片煙雨；街道濕滑，記得帶傘。';
    case 'summer':
      return '夏日酷熱，驟雨頻繁，颱風季開始，天文台提醒市民留意風球。';
    case 'autumn':
      return '秋高氣爽，維港兩岸天色晴朗，是工程與郊遊的好時節。';
    case 'winter':
      return '寒潮南下，天氣清涼；大帽山或會結霜，長者注意保暖。';
  }
}

/** 目前颱風警告文字（用 clock.typhoonSignal／typhoonName；舊存檔 fallback hkoClockSignal） */
export function typhoonWarningTextOf(state: GameState): string | null {
  const signal = hkoClockSignal(state.clock);
  if (signal === 0) return null;
  const name = hkoClockTyphoonName(state.clock);
  const runtime = typhoonRuntimeOf(state);
  const direction = hkoDirectionFromName(state.clock.typhoonName) ?? runtime.direction;
  if (name && !name.includes('無熱帶氣旋')) {
    const base = hkoTyphoonWarningText(signal, direction);
    const baseName = hkoTyphoonSignalName(signal, direction);
    if (base.startsWith(baseName)) return base;
    return `${name}${base.slice(baseName.length)}`;
  }
  return hkoTyphoonWarningText(signal, direction);
}

/** 天文台警告文字（依天氣與氣溫） */
function warningFor(state: GameState): string | null {
  const { clock, transit } = state;
  switch (clock.weather) {
    case 'storm':
      return typhoonWarningTextOf(state);
    case 'rain': {
      const rainstorm = hkoRainstormWarning(clock.weatherIntensity);
      return rainstorm ? rainstorm.text : '大雨提示';
    }
    case 'fog':
      return '大霧警告 — 能見度低於 500 米';
    case 'snow':
      return clock.tempC <= 4 ? '寒冷天氣警告 — 大帽山結霜' : '寒冷天氣警告';
    case 'clear':
      if (clock.tempC >= 33) return '酷熱天氣警告 — 市區氣溫高企';
      if (clock.tempC <= 8) return '寒冷天氣警告 — 注意保暖';
      return null;
    default:
      if (clock.tempC >= 33) return '酷熱天氣警告';
      if (clock.tempC <= 8) return '寒冷天氣警告';
      return transit.suspended ? null : null;
  }
}

/** 天氣對市民／傳媒的提示 */
function weatherOnsetText(weather: Weather, season: Season, stormName: string | null = null): string {
  switch (weather) {
    case 'storm':
      return stormName
        ? `天文台發出${stormName}！狂風暴雨吹襲維港，市民應留意最新天氣消息。`
        : '天文台發出熱帶氣旋警告！狂風暴雨吹襲維港，市民應留意最新天氣消息。';
    case 'rain':
      return season === 'summer'
        ? '夏日暴雨傾盆，街上行人紛紛走避，交通慢駛。'
        : '細雨綿綿，維港兩岸一片朦朧，行人撐傘慢行。';
    case 'fog':
      return '大霧鎖港，能見度驟降，車輛慢駛、航班或受延誤。';
    case 'clear':
      return '雲開見日，天氣轉晴，維港兩岸份外明亮。';
    case 'snow':
      return '寒潮襲港，大帽山山頂結霜，市區氣溫急降，市民添衣保暖。';
    default:
      return '天色轉陰，維港上空的雲層漸厚。';
  }
}

function weatherTone(weather: Weather): LogKind {
  switch (weather) {
    case 'clear':
      return 'good';
    case 'rain':
    case 'fog':
      return 'info';
    case 'storm':
    case 'snow':
      return 'warn';
    default:
      return 'info';
  }
}

/**
 * 抽下一段天氣並寫回 clock；回傳是否有變化。
 * 颱風出現機率改用 HKO 1961–2020 月平均警告日數（表 6a），唔再全年 uniform。
 */
function rollWeather(state: GameState, ctx: SimContext): boolean {
  const clock = state.clock;
  const rng = weatherRng(state);
  const prev = clock.weather;
  const runtime = typhoonRuntimeOf(state);

  // 每次天氣 roll 平均覆蓋幾多日；用嚟把 HKO「日機率」換算成每 roll 機率
  const avgRollDays = (WEATHER_MIN_MINUTES + WEATHER_VARIANCE_MINUTES * 0.5) / (24 * 60);
  const stormChance = Math.min(0.5, hkoDailyTyphoonProbability(clock.month, 'any') * avgRollDays);

  let next: Weather;
  let stormSignal: HkoTyphoonSignal = 0;
  if (prev !== 'storm' && rng() < stormChance) {
    next = 'storm';
    // 颱風強度：以氣候分佈為主（0.55–0.67），再按 HKO 條件機率抽 1/3/8/9/10 號風球
    const intensityRoll = 0.55 + 0.06 * rng();
    const sampled = hkoSampleTyphoonSignal(rng(), clock.month, intensityRoll);
    stormSignal = sampled.signal;
    runtime.direction = sampled.direction;
    runtime.intensityTarget = signalIntensityTarget(stormSignal);
    runtime.lastSignal = stormSignal;
    writeClockTyphoon(clock, stormSignal, sampled.direction);
  } else {
    next = chooseNonStormWeather(clock.season, prev, rng);
    // 保險絲：非冬季不下雪
    if (next === 'snow' && clock.season !== 'winter') next = 'rain';
    if (next === 'storm') next = 'rain'; // chooseNonStormWeather 已排除，防禦
    if (prev === 'storm') {
      // 颱風過後：除下所有風球
      runtime.direction = null;
      runtime.lastSignal = 0;
      writeClockTyphoon(clock, 0, null);
    }
  }

  // 持續時間：颱風要跨到「一個警告日」的尺度（HKO 每月警告日數要對得上），
  // 1/3 號可持續約 1–2 日、8 號約 0.6–1.4 日、9/10 號較短（核心颶風時段）。
  let duration: number;
  if (next === 'storm') {
    let days: number;
    if (stormSignal === 1 || stormSignal === 3) days = 0.8 + 0.9 * rng();
    else if (stormSignal === 8) days = 0.6 + 0.8 * rng();
    else days = 0.4 + 0.5 * rng();
    duration = days * 24 * 60;
  } else {
    const mult = WEATHER_DURATION_MULT[next];
    duration = (WEATHER_MIN_MINUTES + rng() * WEATHER_VARIANCE_MINUTES) * mult;
  }
  clock.weatherMinutesLeft = Math.max(60, Math.round(duration));
  clock.weather = next;

  if (next !== prev) {
    const announce =
      next === 'storm' ||
      next === 'snow' ||
      next === 'fog' ||
      (next === 'rain' && prev === 'clear' && rng() < 0.6) ||
      (next === 'clear' && (prev === 'rain' || prev === 'storm' || prev === 'snow') && rng() < 0.5);
    if (announce) {
      const stormName = next === 'storm' ? hkoClockTyphoonName(clock) : null;
      ctx.toast(weatherOnsetText(next, clock.season, stormName), weatherTone(next));
    }
  }
  return next !== prev;
}

function announceSeason(state: GameState, isNewYear: boolean, ctx: SimContext): void {
  const clock = state.clock;
  const info = SEASON_INFO[clock.season];
  const yearNote = isNewYear ? `，${START_YEAR + clock.year - 1} 年開始` : '';
  ctx.log(`時序入${seasonName(clock.season)}${yearNote}。${seasonToast(clock.season)}`, isNewYear ? 'good' : 'info');
}

/** 推進遊戲時間；回傳跨日／跨月／跨年／跨季旗標 */
export function advanceClock(state: GameState, gameMinutes: number, ctx: SimContext): TickFlags {
  const clock = state.clock;
  const prevDay = clock.totalDays;
  const prevMonth = clock.month;
  const prevYear = clock.year;
  const prevSeason = clock.season;

  if (!Number.isFinite(gameMinutes) || gameMinutes <= 0) {
    return { newDay: false, newMonth: false, newYear: false, newSeason: false };
  }

  clock.minutes += gameMinutes;
  deriveClockFields(clock);

  // 天氣計時
  clock.weatherMinutesLeft -= gameMinutes;
  let guard = 0;
  while (clock.weatherMinutesLeft <= 0 && guard < 12) {
    rollWeather(state, ctx);
    guard++;
  }

  // 季節校正
  if (clock.season !== 'winter' && clock.weather === 'snow') {
    clock.weather = 'rain';
    clock.weatherMinutesLeft = Math.min(clock.weatherMinutesLeft, 180);
  }

  const flags: TickFlags = {
    newDay: clock.totalDays !== prevDay,
    newMonth: clock.month !== prevMonth,
    newYear: clock.year !== prevYear,
    newSeason: clock.season !== prevSeason,
  };

  if (flags.newSeason) announceSeason(state, flags.newYear, ctx);

  // 氣溫
  const hourFloat = clock.hour + clock.minute / 60;
  const diurnal = Math.sin(((hourFloat - 9) / 24) * Math.PI * 2) * DIURNAL_AMPLITUDE;
  const targetTemp = SEASON_TEMP[clock.season] + diurnal + WEATHER_TEMP_OFFSET[clock.weather];
  const tempBlend = 1 - Math.exp(-gameMinutes / 60);
  clock.tempC += (targetTemp - clock.tempC) * tempBlend;
  clock.tempC = clampNumber(clock.tempC, -5, 42);

  // 雨雪強度平滑
  let intensityTarget = WEATHER_TARGET_INTENSITY[clock.weather];
  if (clock.weather === 'rain') {
    intensityTarget = clampNumber(
      0.62 + 0.22 * Math.sin(clock.minutes * 0.011) + 0.1 * Math.sin(clock.minutes * 0.037),
      0.35,
      1,
    );
  } else if (clock.weather === 'storm') {
    const runtime = typhoonRuntimeOf(state);
    intensityTarget = clampNumber(runtime.intensityTarget + 0.04 * Math.sin(clock.minutes * 0.017), 0.4, 1);
  } else if (clock.weather === 'snow') {
    intensityTarget = clampNumber(0.78 + 0.16 * Math.sin(clock.minutes * 0.009), 0.5, 1);
  }
  const intensityBlend = 1 - Math.exp(-gameMinutes / 40);
  clock.weatherIntensity += (intensityTarget - clock.weatherIntensity) * intensityBlend;
  clock.weatherIntensity = clampNumber(clock.weatherIntensity, 0, 1);

  // 天文台警告 + 颱風停航狀態（Round 9：follow HKO 1/3/8/9/10 風球；渡輪 8 號或以上才停航）
  clock.warning = warningFor(state);
  const typhoonSignal = hkoClockSignal(clock);
  const shouldSuspend = typhoonSignal >= 8;
  const wasSuspended = state.transit.suspended;
  if (shouldSuspend !== wasSuspended) {
    state.transit.suspended = shouldSuspend;
    if (shouldSuspend) {
      const name = hkoClockTyphoonName(clock) ?? '八號烈風或暴風信號';
      ctx.log(`${name}生效：所有渡輪停航，戶外交通及地盤停工。`, 'warn');
    } else {
      ctx.log('風球除下，渡輪復航，市面逐步回復正常。', 'good');
    }
  }
  // 九號／十號：加強警告（每 6 個遊戲鐘頭一次，避免洗版）
  if ((typhoonSignal === 9 || typhoonSignal === 10) && clock.minutes % 360 < gameMinutes) {
    const name = hkoClockTyphoonName(clock) ?? hkoTyphoonSignalName(typhoonSignal);
    ctx.log(`${name}生效！風力達颶風程度，天文台呼籲市民留在安全地方，切勿外出。`, 'bad');
  }

  return flags;
}

function clampNumber(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 目前天氣對產業、移動、幸福、交通、用電的乘數 */
export function weatherModifiers(state: GameState): {
  farm: number;
  move: number;
  happiness: number;
  transit: number;
  powerDemand: number;
} {
  const effect = WEATHER_EFFECT[state.clock.weather];
  const result = {
    farm: effect.farm,
    move: effect.move,
    happiness: effect.happiness,
    transit: effect.transit,
    powerDemand: effect.powerDemand,
  };
  // Round 9：颱風按風球級數調整影響（1/3 號較輕；9/10 號更嚴重）
  if (state.clock.weather === 'storm') {
    const signal = hkoClockSignal(state.clock);
    if (signal === 1 || signal === 3) {
      const t = signal === 3 ? 1 : 0.5;
      result.farm = 0.65 - 0.15 * t;
      result.move = 0.7 - 0.1 * t;
      result.happiness = -2 - 2 * t;
      result.transit = 0.7 - 0.1 * t;
      result.powerDemand = 1.06 + 0.04 * t;
    } else if (signal === 9 || signal === 10) {
      result.farm = 0.1;
      result.move = 0.2;
      result.happiness = -11;
      result.transit = 0.2;
      result.powerDemand = 1.28;
    }
  }
  return result;
}

/** 日照進度 0..1（0=午夜, 0.5=正午） */
export function daylightFactor(state: GameState): number {
  const clock = state.clock;
  const t = (clock.hour * 60 + clock.minute) / (24 * 60);
  return Math.max(0, Math.sin((t - 0.25) * Math.PI * 2) * 0.5 + 0.5);
}

/** 是否正值夜間（供渲染／市民行為使用） */
export function isNight(state: GameState): boolean {
  const clock = state.clock;
  return clock.hour < 6 || clock.hour >= 19;
}

/** 目前是否正在下雨／落雪／打風 */
export function isPrecipitating(state: GameState): boolean {
  const weather = state.clock.weather;
  return weather === 'rain' || weather === 'snow' || weather === 'storm';
}

export function weatherLabel(state: GameState): string {
  const info = WEATHER_INFO[state.clock.weather];
  return `${info.emoji} ${info.name}`;
}

/** 是否颱風（八號風球） */
export function isTyphoon(state: GameState): boolean {
  return state.clock.weather === 'storm';
}
