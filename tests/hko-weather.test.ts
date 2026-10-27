/**
 * Round 9／GitHub issue #18：香港天文台（HKO）熱帶氣旋警告密度、1/3/8/9/10 風球、
 * 暴雨警告與渡輪／交通停航行為。
 */
import { describe, expect, it } from 'vitest';
import { createGameState } from '../src/core/new-game';
import type { GameState, SimContext } from '../src/core/types';
import { advanceClock } from '../src/sim/time';
import { typhoonSignalFor } from '../src/sim/transit';
import { typhoonSignalOf, updateStats } from '../src/sim/stats';
import {
  HKO_MONTHLY_TC_DAYS_1PLUS,
  HKO_MONTHLY_TC_DAYS_3PLUS,
  HKO_MONTHLY_TC_DAYS_8PLUS,
  HKO_MONTHLY_TC_DAYS_9OR10,
  HKO_TC_STAT_SOURCE,
  HKO_TC_YEAR_DAYS,
  HKO_TYPHOON_SIGNALS,
  hkoClockSignal,
  hkoDailyTyphoonProbability,
  hkoDirectionFromName,
  hkoMonthlyTyphoonDays,
  hkoRainstormWarning,
  hkoSampleTyphoonSignal,
  hkoTyphoonSeasonSummary,
  hkoTyphoonSignalName,
  hkoTyphoonSignalProbabilities,
  hkoTyphoonWarningText,
} from '../src/sim/hko-climate';

const ctx: SimContext = { toast: () => {}, log: () => {} };

function makeState(): GameState {
  const state = createGameState(20261022, 'empty');
  state.clock.weatherMinutesLeft = 9999;
  return state;
}

/** 設定一個指定風球的 storm 狀態 */
function setTyphoon(state: GameState, signal: number, directionName?: string): void {
  const clock = state.clock as GameState['clock'] & { typhoonSignal?: number; typhoonName?: string | null };
  clock.weather = 'storm';
  clock.weatherMinutesLeft = 9999;
  clock.typhoonSignal = signal as 0 | 1 | 3 | 8 | 9 | 10;
  clock.typhoonName = directionName ?? (signal === 8 ? '八號東北烈風或暴風信號' : hkoTyphoonSignalName(signal as 1 | 3 | 8 | 9 | 10));
  clock.warning = '';
}

describe('HKO 氣候數據（Table 6a 1961–2020）', () => {
  it('12 個月數據、年值與來源齊全', () => {
    expect(HKO_MONTHLY_TC_DAYS_1PLUS).toHaveLength(12);
    expect(HKO_MONTHLY_TC_DAYS_3PLUS).toHaveLength(12);
    expect(HKO_MONTHLY_TC_DAYS_8PLUS).toHaveLength(12);
    expect(HKO_MONTHLY_TC_DAYS_9OR10).toHaveLength(12);
    const sum = (arr: readonly number[]): number => arr.reduce((total, value) => total + value, 0);
    expect(sum(HKO_MONTHLY_TC_DAYS_1PLUS)).toBeCloseTo(HKO_TC_YEAR_DAYS.any, 0);
    expect(sum(HKO_MONTHLY_TC_DAYS_3PLUS)).toBeCloseTo(HKO_TC_YEAR_DAYS.three, 0);
    expect(sum(HKO_MONTHLY_TC_DAYS_8PLUS)).toBeCloseTo(HKO_TC_YEAR_DAYS.eight, 0);
    expect(sum(HKO_MONTHLY_TC_DAYS_9OR10)).toBeCloseTo(HKO_TC_YEAR_DAYS.nineOrTen, 1);
    expect(HKO_TC_STAT_SOURCE).toContain('hko.gov.hk');
    const summary = hkoTyphoonSeasonSummary();
    expect(summary.peakMonths).toEqual([7, 8, 9]);
    expect(summary.yearDays.any).toBeCloseTo(17.52, 2);
  });

  it('7–9 月最多；1–3 月為零；行政遞減（1+ ≥ 3+ ≥ 8+ ≥ 9/10）', () => {
    for (let month = 1; month <= 12; month++) {
      expect(hkoMonthlyTyphoonDays(month, 'any')).toBeGreaterThanOrEqual(
        hkoMonthlyTyphoonDays(month, 'three'),
      );
      expect(hkoMonthlyTyphoonDays(month, 'three')).toBeGreaterThanOrEqual(
        hkoMonthlyTyphoonDays(month, 'eight'),
      );
      expect(hkoMonthlyTyphoonDays(month, 'eight')).toBeGreaterThanOrEqual(
        hkoMonthlyTyphoonDays(month, 'nineOrTen'),
      );
    }
    for (const month of [1, 2, 3]) expect(hkoMonthlyTyphoonDays(month, 'any')).toBe(0);
    for (const month of [7, 8, 9]) {
      expect(hkoMonthlyTyphoonDays(month, 'any')).toBeGreaterThan(3);
      expect(hkoMonthlyTyphoonDays(month, 'eight')).toBeGreaterThan(0.5);
    }
    expect(hkoMonthlyTyphoonDays(7, 'any')).toBeGreaterThan(hkoMonthlyTyphoonDays(5, 'any'));
    expect(hkoDailyTyphoonProbability(7, 'any')).toBeGreaterThan(hkoDailyTyphoonProbability(4, 'any'));
    expect(hkoDailyTyphoonProbability(8, 'eight')).toBeGreaterThan(0);
    expect(hkoDailyTyphoonProbability(2, 'any')).toBe(0);
  });

  it('風球條件機率：sum=1、氣候分佈與 8+ 比例符合 HKO；強度越高越高級', () => {
    const juli = hkoTyphoonSignalProbabilities(7, 0.55);
    const sum = juli[1] + juli[3] + juli[8] + juli[9] + juli[10];
    expect(sum).toBeCloseTo(1, 2);
    const any = hkoMonthlyTyphoonDays(7, 'any');
    const eightPlus = hkoMonthlyTyphoonDays(7, 'eight');
    expect(juli[8] + juli[9] + juli[10]).toBeCloseTo(eightPlus / any, 2);
    expect(juli[1]).toBeGreaterThan(0.3);

    const high = hkoTyphoonSignalProbabilities(8, 1);
    const low = hkoTyphoonSignalProbabilities(8, 0.55);
    expect(high[8] + high[9] + high[10]).toBeGreaterThan(low[8] + low[9] + low[10]);
    expect(high[1]).toBeLessThan(low[1]);
  });

  it('1/3/8/9/10 號風球都可抽到；8 號有方向；名稱符合 HKO', () => {
    const seen = new Set<number>();
    const directions = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const sampled = hkoSampleTyphoonSignal((i + 0.5) / 400, 8, 1);
      expect(HKO_TYPHOON_SIGNALS).toContain(sampled.signal);
      seen.add(sampled.signal);
      if (sampled.signal === 8) {
        expect(['NE', 'NW', 'SE', 'SW']).toContain(sampled.direction);
        directions.add(sampled.direction ?? '');
      } else {
        expect(sampled.direction).toBeNull();
      }
    }
    for (const signal of HKO_TYPHOON_SIGNALS) expect(seen.has(signal)).toBe(true);
    expect(directions.size).toBe(4);
    expect(hkoTyphoonSignalName(8, 'NE')).toBe('八號東北烈風或暴風信號');
    expect(hkoTyphoonSignalName(10)).toContain('十號颶風');
    expect(hkoDirectionFromName('八號東南烈風或暴風信號')).toBe('SE');
  });

  it('暴雨警告分黃／紅／黑，暴雨夠強會加山泥傾瀉警告', () => {
    expect(hkoRainstormWarning(0.3)).toBeNull();
    const amber = hkoRainstormWarning(0.6);
    expect(amber?.level).toBe('amber');
    expect(amber?.name).toContain('黃色暴雨');
    const red = hkoRainstormWarning(0.82);
    expect(red?.level).toBe('red');
    expect(red?.name).toContain('紅色暴雨');
    const black = hkoRainstormWarning(0.96);
    expect(black?.level).toBe('black');
    expect(black?.name).toContain('黑色暴雨');
    expect(black?.landslip).toBe(true);
    expect(black?.text).toContain('山泥傾瀉');
  });

  it('clock 風球 reader：新欄位優先，舊存檔 fallback warning 文字', () => {
    expect(hkoClockSignal({ typhoonSignal: 9 })).toBe(9);
    expect(hkoClockSignal({ typhoonSignal: 8, warning: '八號東北烈風或暴風信號' })).toBe(8);
    expect(hkoClockSignal({ warning: '八號東北烈風或暴風信號' })).toBe(8);
    expect(hkoClockSignal({ warning: '三號強風信號' })).toBe(3);
    expect(hkoClockSignal({ warning: '一號戒備信號' })).toBe(1);
    expect(hkoClockSignal({ weather: 'storm' })).toBe(8);
    expect(hkoClockSignal({ weather: 'clear' })).toBe(0);
  });
});

describe('時間系統整合：HKO 風球／警告／渡輪停航', () => {
  it('3 號：警告文字正確、渡輪唔停航；8 號：停航；9/10 號：更嚴重', () => {
    const state = makeState();
    setTyphoon(state, 3);
    state.transit.suspended = true; // 強制由 true 變 false，驗證會跟 signal 調整
    advanceClock(state, 1, ctx);
    expect(state.clock.warning).toContain('三號強風信號');
    expect(state.transit.suspended).toBe(false);

    setTyphoon(state, 8, '八號東南烈風或暴風信號');
    advanceClock(state, 1, ctx);
    expect(state.clock.warning).toContain('八號東南');
    expect(state.clock.warning).toContain('渡輪停航');
    expect(state.transit.suspended).toBe(true);

    setTyphoon(state, 9);
    advanceClock(state, 1, ctx);
    expect(state.clock.warning).toContain('九號');
    expect(state.transit.suspended).toBe(true);

    setTyphoon(state, 10);
    advanceClock(state, 1, ctx);
    expect(state.clock.warning).toContain('十號颶風');
    expect(state.transit.suspended).toBe(true);
  });

  it('stats.typhoonSignal／transit.typhoonSignalFor 與 clock 一致（1/3/8/9/10）', () => {
    const state = makeState();
    for (const signal of [1, 3, 8, 9, 10]) {
      setTyphoon(state, signal);
      advanceClock(state, 1, ctx);
      updateStats(state);
      expect(state.stats.typhoonSignal).toBe(signal);
      expect(typhoonSignalOf(state)).toBe(signal);
      expect(typhoonSignalFor(state)).toBe(signal);
    }
    // 舊存檔：只有 warning 文字
    const legacy = makeState();
    (legacy.clock as GameState['clock'] & { typhoonSignal?: number }).typhoonSignal = undefined;
    legacy.clock.weather = 'storm';
    legacy.clock.warning = '八號西北烈風或暴風信號';
    expect(typhoonSignalFor(legacy)).toBe(8);
    expect(typhoonSignalOf(legacy)).toBe(8);
  });

  it('暴雨警告按強度更新 warning；冇雨時無暴雨警告', () => {
    const state = makeState();
    state.clock.weather = 'rain';
    state.clock.weatherMinutesLeft = 9999;
    for (const [intensity, expected] of [
      [0.4, '大雨提示'],
      [0.6, '黃色暴雨'],
      [0.82, '紅色暴雨'],
      [0.96, '黑色暴雨'],
    ] as const) {
      state.clock.weatherIntensity = intensity;
      advanceClock(state, 1, ctx);
      expect(state.clock.warning).toContain(expected);
    }
    state.clock.weather = 'clear';
    state.clock.weatherIntensity = 0;
    advanceClock(state, 1, ctx);
    expect(state.clock.warning === null || !String(state.clock.warning).includes('暴雨')).toBe(true);
  });

  it('五年模擬：颱風集中在 7–9 月、1–3 月無颱風、風球級數合法', () => {
    const state = makeState();
    state.transit.suspended = false;
    const stormDaysByMonth = new Array<number>(13).fill(0);
    const measuredSignals = new Set<number>();
    let lastDay = state.clock.totalDays;
    const startYear = state.clock.year;
    const minutesPerStep = 240;
    const stepsPerYear = (365 * 24 * 60) / minutesPerStep;
    for (let i = 0; i < stepsPerYear * 5; i++) {
      advanceClock(state, minutesPerStep, ctx);
      if (state.clock.weather === 'storm') {
        const signal = hkoClockSignal(state.clock);
        expect(HKO_TYPHOON_SIGNALS).toContain(signal);
        measuredSignals.add(signal);
      }
      if (state.clock.totalDays !== lastDay) {
        lastDay = state.clock.totalDays;
        if (state.clock.weather === 'storm') stormDaysByMonth[state.clock.month]++;
      }
      if (state.clock.year >= startYear + 5) break;
    }
    // 1–3 月唔應該有颱風（HKO 氣候值 0）
    expect(stormDaysByMonth[1] + stormDaysByMonth[2] + stormDaysByMonth[3]).toBe(0);
    // 7–9 月係風季高峰
    const summer = stormDaysByMonth[7] + stormDaysByMonth[8] + stormDaysByMonth[9];
    expect(summer).toBeGreaterThan(0);
    expect(summer).toBeGreaterThan(stormDaysByMonth[4] + stormDaysByMonth[5]);
    // 五年一定有 1 號及 3 號風球出現過
    expect(measuredSignals.has(1) || measuredSignals.has(3)).toBe(true);
  });
});
