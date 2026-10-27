/**
 * 香港天文台（HKO）熱帶氣旋氣候數據（Round 9／GitHub issue #18）。
 *
 * 數據來源：HKO「熱帶氣旋警告信號統計」Table 6a（1961–2020）：
 *   https://www.hko.gov.hk/tc/informtc/tcStatTable6a.htm
 * 數值：各月平均發出熱帶氣旋警告信號的日數（年值 = 12 個月平均總和）。
 *
 * 本檔只提供純數據／機率／文字工具，唔會直接改 GameState：
 *   - time.ts 用 hkoDailyTyphoonProbability() 決定颱風天氣出現機率（按月份，唔再全年 uniform）；
 *   - 颱風出現時用 hkoTyphoonSignalProbabilities()／hkoSampleTyphoonSignal() 抽 1/3/8/9/10 號風球；
 *   - hkoTyphoonWarningText()／hkoRainstormWarning() 產生天文台正式警告名稱；
 *   - stats／transit 可直接用 hkoClockSignal() 讀 clock.typhoonSignal（未加 types 時 fallback 解析 warning）。
 */

/** HKO Table 6a 官方來源 */
export const HKO_TC_STAT_SOURCE = 'https://www.hko.gov.hk/tc/informtc/tcStatTable6a.htm';

/** HKO 熱帶氣旋警告信號級數（0 = 無警告） */
export type HkoTyphoonSignal = 0 | 1 | 3 | 8 | 9 | 10;

/** 八號風球方向（HKO 四個方向） */
export type HkoTyphoonDirection = 'NE' | 'NW' | 'SE' | 'SW';

/** 月平均警告日數的門檻類別 */
export type HkoTyphoonThreshold = 'any' | 'three' | 'eight' | 'nineOrTen';

/** 月份（1–12）平均發出「一號或以上」熱帶氣旋警告信號日數（1961–2020） */
export const HKO_MONTHLY_TC_DAYS_1PLUS: readonly number[] = [
  0, 0, 0, 0.18, 0.48, 1.98, 3.85, 3.75, 4.17, 2.53, 0.53, 0.03,
];

/** 月份平均「三號或以上」日數 */
export const HKO_MONTHLY_TC_DAYS_3PLUS: readonly number[] = [
  0, 0, 0, 0.07, 0.32, 0.97, 2.23, 1.8, 2.18, 1.57, 0.22, 0.03,
];

/** 月份平均「八號或以上」日數 */
export const HKO_MONTHLY_TC_DAYS_8PLUS: readonly number[] = [
  0, 0, 0, 0, 0.08, 0.2, 0.6, 0.67, 0.62, 0.22, 0.03, 0,
];

/** 月份平均「九號或十號」日數 */
export const HKO_MONTHLY_TC_DAYS_9OR10: readonly number[] = [
  0, 0, 0, 0, 0.02, 0.02, 0.08, 0.17, 0.1, 0.05, 0, 0,
];

/** 年平均值（日） */
export const HKO_TC_YEAR_DAYS: Record<HkoTyphoonThreshold, number> = {
  any: 17.52,
  three: 9.38,
  eight: 2.42,
  nineOrTen: 0.43,
};

/** 每月平均日數表（按門檻） */
const HKO_MONTHLY_TABLE: Record<HkoTyphoonThreshold, readonly number[]> = {
  any: HKO_MONTHLY_TC_DAYS_1PLUS,
  three: HKO_MONTHLY_TC_DAYS_3PLUS,
  eight: HKO_MONTHLY_TC_DAYS_8PLUS,
  nineOrTen: HKO_MONTHLY_TC_DAYS_9OR10,
};

/** 氣候平均每月日數（30.44 日／月；用作日機率） */
export const HKO_DAYS_PER_MONTH = 30.44;

/** HKO 風球名稱（8 號按方向細分；9/10 無方向） */
const SIGNAL_BASE_NAME: Record<Exclude<HkoTyphoonSignal, 0>, string> = {
  1: '一號戒備信號',
  3: '三號強風信號',
  8: '八號烈風或暴風信號',
  9: '九號烈風或暴風風力增強信號',
  10: '十號颶風信號',
};

/** 八號風球方向中文 */
export const HKO_DIRECTION_NAMES: Record<HkoTyphoonDirection, string> = {
  NE: '東北',
  NW: '西北',
  SE: '東南',
  SW: '西南',
};

/** 可抽到嘅非零風球 */
export const HKO_TYPHOON_SIGNALS: readonly Exclude<HkoTyphoonSignal, 0>[] = [1, 3, 8, 9, 10];

/** 每個月平均颱風警告日數（threshold 預設「一號或以上」） */
export function hkoMonthlyTyphoonDays(
  month: number,
  threshold: HkoTyphoonThreshold = 'any',
): number {
  const table = HKO_MONTHLY_TABLE[threshold] ?? HKO_MONTHLY_TC_DAYS_1PLUS;
  const m = Math.min(12, Math.max(1, Math.floor(month) || 1));
  return table[m - 1] ?? 0;
}

/** 每日出現熱帶氣旋警告（門檻可選）嘅氣候機率 0..1 */
export function hkoDailyTyphoonProbability(
  month: number,
  threshold: HkoTyphoonThreshold = 'any',
): number {
  return Math.min(1, hkoMonthlyTyphoonDays(month, threshold) / HKO_DAYS_PER_MONTH);
}

/** 由月份統計換算條件機率：1/3/8/9/10 號風球分佈（sum = 1，只喺有 TC 警告時用） */
export function hkoTyphoonSignalProbabilities(
  month: number,
  weatherIntensity = 1,
): Record<Exclude<HkoTyphoonSignal, 0>, number> {
  const any = hkoMonthlyTyphoonDays(month, 'any');
  const three = hkoMonthlyTyphoonDays(month, 'three');
  const eight = hkoMonthlyTyphoonDays(month, 'eight');
  const nineOrTen = hkoMonthlyTyphoonDays(month, 'nineOrTen');
  if (any <= 0) {
    // 1–3 月氣候上冇 TC 警告；理論上唔會抽，但回傳安全分佈
    return { 1: 1, 3: 0, 8: 0, 9: 0, 10: 0 };
  }
  const s8 = Math.min(eight, three);
  const s3 = Math.max(0, three - s8);
  const s1 = Math.max(0, any - three);
  const ninePlus = Math.min(nineOrTen, s8);
  const ten = ninePlus * 0.35;
  const nine = ninePlus * 0.65;
  const eightOnly = Math.max(0, s8 - ninePlus);
  const base = {
    1: s1 / any,
    3: s3 / any,
    8: eightOnly / any,
    9: nine / any,
    10: ten / any,
  };
  // 天氣強度調節：強度高時偏向較高風球（HKO 氣候平均 vs 強颱風事件）
  const mix = Math.max(0, Math.min(1, (weatherIntensity - 0.55) / 0.45)) * 0.55;
  const high = { 1: 0.18, 3: 0.3, 8: 0.34, 9: 0.12, 10: 0.06 };
  const blended = {
    1: base[1] * (1 - mix) + high[1] * mix,
    3: base[3] * (1 - mix) + high[3] * mix,
    8: base[8] * (1 - mix) + high[8] * mix,
    9: base[9] * (1 - mix) + high[9] * mix,
    10: base[10] * (1 - mix) + high[10] * mix,
  };
  const total = blended[1] + blended[3] + blended[8] + blended[9] + blended[10];
  const normalize = (v: number): number => Math.round((v / total) * 10000) / 10000;
  return {
    1: normalize(blended[1]),
    3: normalize(blended[3]),
    8: normalize(blended[8]),
    9: normalize(blended[9]),
    10: normalize(blended[10]),
  };
}

/** 由 0..1 roll 抽 8 號風球方向 */
export function hkoSampleTyphoonDirection(roll: number): HkoTyphoonDirection {
  const r = Math.max(0, Math.min(0.999999, roll));
  if (r < 0.25) return 'NE';
  if (r < 0.5) return 'NW';
  if (r < 0.75) return 'SE';
  return 'SW';
}

/**
 * 由單一 0..1 roll 抽風球（deterministic，方便測試）：
 * 先按 hkoTyphoonSignalProbabilities(month, weatherIntensity) 分佈抽信號；
 * 8 號再用 roll 細分方向。
 */
export function hkoSampleTyphoonSignal(
  roll: number,
  month: number,
  weatherIntensity = 1,
): { signal: Exclude<HkoTyphoonSignal, 0>; direction: HkoTyphoonDirection | null } {
  const probs = hkoTyphoonSignalProbabilities(month, weatherIntensity);
  const r = Math.max(0, Math.min(0.999999, roll));
  const order: Exclude<HkoTyphoonSignal, 0>[] = [1, 3, 8, 9, 10];
  let cumulative = 0;
  let signal: Exclude<HkoTyphoonSignal, 0> = 10;
  for (const candidate of order) {
    cumulative += probs[candidate];
    if (r <= cumulative) {
      signal = candidate;
      break;
    }
  }
  const direction = signal === 8 ? hkoSampleTyphoonDirection((r * 7.31) % 1) : null;
  return { signal, direction };
}

/** 由信號（及 8 號方向）產生正式警告名稱 */
export function hkoTyphoonSignalName(
  signal: HkoTyphoonSignal,
  direction: HkoTyphoonDirection | null = null,
): string {
  if (signal === 0 || !SIGNAL_BASE_NAME[signal]) return '無熱帶氣旋警告';
  if (signal === 8) {
    return `八號${HKO_DIRECTION_NAMES[direction ?? 'NE']}烈風或暴風信號`;
  }
  return SIGNAL_BASE_NAME[signal];
}

/** 颱風警告完整文字（含香港天文台提示） */
export function hkoTyphoonWarningText(
  signal: HkoTyphoonSignal,
  direction: HkoTyphoonDirection | null = null,
): string {
  const name = hkoTyphoonSignalName(signal, direction);
  switch (signal) {
    case 0:
      return '';
    case 1:
      return `${name} — 天文台提醒市民留意風暴動向，固定戶外物件`;
    case 3:
      return `${name} — 強風吹襲，戶外活動暫停，渡輪航班或受影響`;
    case 8:
      return `${name} — 渡輪停航、地盤停工、港股停市`;
    case 9:
      return `${name} — 風力增強，渡輪全面停航，市民應留在安全地方`;
    case 10:
      return `${name} — 持續颶風，天文台呼籲市民切勿外出`;
  }
}

/** 暴雨警告（按天氣強度分黃／紅／黑；暴雨期間可能發出山泥傾瀉警告） */
export interface HkoRainstormWarning {
  level: 'amber' | 'red' | 'black';
  name: string;
  /** 是否同時有山泥傾瀉警告 */
  landslip: boolean;
  text: string;
}

const RAINSTORM_LEVELS: { level: 'amber' | 'red' | 'black'; min: number; name: string }[] = [
  { level: 'amber', min: 0.55, name: '黃色暴雨警告信號' },
  { level: 'red', min: 0.78, name: '紅色暴雨警告信號' },
  { level: 'black', min: 0.92, name: '黑色暴雨警告信號' },
];

/** 按雨勢強度 0..1 取得暴雨警告（強度太低回傳 null） */
export function hkoRainstormWarning(intensity: number): HkoRainstormWarning | null {
  const value = Math.max(0, Math.min(1, intensity));
  let current: { level: 'amber' | 'red' | 'black'; min: number; name: string } | null = null;
  for (const level of RAINSTORM_LEVELS) {
    if (value >= level.min) current = level;
  }
  if (!current) return null;
  const landslip = current.level !== 'amber' && value >= 0.85;
  const advice =
    current.level === 'black'
      ? '低窪地區嚴重水浸，市民應留在安全地方'
      : current.level === 'red'
        ? '多處地區水浸，避免前往低窪地帶'
        : '低窪地區可能水浸，注意安全';
  return {
    level: current.level,
    name: current.name,
    landslip,
    text: `${current.name} — ${advice}${landslip ? '（山泥傾瀉警告生效）' : ''}`,
  };
}

/** 一年季節分佈摘要（供 UI／文件用） */
export function hkoTyphoonSeasonSummary(): {
  yearDays: Record<HkoTyphoonThreshold, number>;
  monthlyDays1Plus: readonly number[];
  peakMonths: number[];
  seasonMonths: number[];
  source: string;
} {
  return {
    yearDays: { ...HKO_TC_YEAR_DAYS },
    monthlyDays1Plus: HKO_MONTHLY_TC_DAYS_1PLUS,
    peakMonths: [7, 8, 9],
    seasonMonths: [5, 6, 7, 8, 9, 10, 11],
    source: HKO_TC_STAT_SOURCE,
  };
}

/** clock 兼容讀取（Lead 會加 clock.typhoonSignal?／typhoonName?；未加時用 warning fallback） */
interface ClockWithTyphoonFields {
  warning?: string | null;
  weather?: string;
  typhoonSignal?: number;
  typhoonName?: string | null;
}

/** 由 clock 讀目前風球（優先 clock.typhoonSignal，舊存檔 fallback 解析 warning） */
export function hkoClockSignal(clock: ClockWithTyphoonFields): HkoTyphoonSignal {
  const raw = clock.typhoonSignal;
  if (typeof raw === 'number' && raw > 0) {
    if (raw >= 10) return 10;
    if (raw >= 9) return 9;
    if (raw >= 8) return 8;
    if (raw >= 3) return 3;
    return 1;
  }
  const warning = clock.warning ?? '';
  if (/十號|10\s*號/.test(warning)) return 10;
  if (/九號|9\s*號/.test(warning)) return 9;
  if (/八號|8\s*號/.test(warning)) return 8;
  if (/三號|3\s*號/.test(warning)) return 3;
  if (/一號|1\s*號/.test(warning)) return 1;
  return clock.weather === 'storm' ? 8 : 0;
}

/** 由警告名稱（例如「八號東南烈風或暴風信號」）解析 8 號方向 */
export function hkoDirectionFromName(name: string | null | undefined): HkoTyphoonDirection | null {
  if (!name) return null;
  if (name.includes('東北')) return 'NE';
  if (name.includes('西北')) return 'NW';
  if (name.includes('東南')) return 'SE';
  if (name.includes('西南')) return 'SW';
  return null;
}

/** 由 clock 讀風球名稱（8 號方向已包含喺 typhoonName） */
export function hkoClockTyphoonName(clock: ClockWithTyphoonFields): string | null {
  const name = clock.typhoonName;
  if (typeof name === 'string' && name.length > 0) return name;
  const signal = hkoClockSignal(clock);
  if (signal === 0) return null;
  return hkoTyphoonSignalName(signal, null);
}
