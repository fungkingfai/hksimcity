/**
 * 香港天文台（HKO）警告／氣候資料（Round 9 · issues #18／#20）。
 *
 * - resolveHkoWarning()：由 clock.typhoonSignal／clock.typhoonName／clock.warning 推算
 *   1／3／8（東北/西北/東南/西南）／9／10 號風球、黃／紅／黑暴雨、雷暴、山泥傾瀉、
 *   酷熱／寒冷／大霧等警告；topbar、城事面板共用。
 * - HKO_TC_WARNING_DAYS：香港天文台 1961–2020 年發出熱帶氣旋警告信號的月平均日數
 *   （官方資料：https://www.hko.gov.hk/tc/informtc/tcStatTable6a.htm）。
 */

import type { GameState } from '../core/types';

export const HKO_SOURCE_URL = 'https://www.hko.gov.hk/tc/informtc/tcStatTable6a.htm';
export const HKO_SOURCE_LABEL = '香港天文台 1961–2020 年熱帶氣旋警告信號月平均日數';

/** 1961–2020 月平均發出警告信號日數（HKO 官方表） */
export interface HkoClimateMonth {
  month: number;
  label: string;
  /** 一號或以上 */
  onePlus: number;
  /** 三號或以上 */
  threePlus: number;
  /** 八號或以上 */
  eightPlus: number;
  /** 九號或十號 */
  nineTen: number;
}

export const HKO_TC_WARNING_DAYS: HkoClimateMonth[] = [
  { month: 1, label: '1月', onePlus: 0, threePlus: 0, eightPlus: 0, nineTen: 0 },
  { month: 2, label: '2月', onePlus: 0, threePlus: 0, eightPlus: 0, nineTen: 0 },
  { month: 3, label: '3月', onePlus: 0, threePlus: 0, eightPlus: 0, nineTen: 0 },
  { month: 4, label: '4月', onePlus: 0.18, threePlus: 0.07, eightPlus: 0, nineTen: 0 },
  { month: 5, label: '5月', onePlus: 0.48, threePlus: 0.32, eightPlus: 0.08, nineTen: 0.02 },
  { month: 6, label: '6月', onePlus: 1.98, threePlus: 0.97, eightPlus: 0.2, nineTen: 0.02 },
  { month: 7, label: '7月', onePlus: 3.85, threePlus: 2.23, eightPlus: 0.6, nineTen: 0.08 },
  { month: 8, label: '8月', onePlus: 3.75, threePlus: 1.8, eightPlus: 0.67, nineTen: 0.17 },
  { month: 9, label: '9月', onePlus: 4.17, threePlus: 2.18, eightPlus: 0.62, nineTen: 0.1 },
  { month: 10, label: '10月', onePlus: 2.53, threePlus: 1.57, eightPlus: 0.22, nineTen: 0.05 },
  { month: 11, label: '11月', onePlus: 0.53, threePlus: 0.22, eightPlus: 0.03, nineTen: 0 },
  { month: 12, label: '12月', onePlus: 0.03, threePlus: 0.03, eightPlus: 0, nineTen: 0 },
];

/** 全年值（官方表年值） */
export const HKO_ANNUAL_TC = { onePlus: 17.52, threePlus: 9.38, eightPlus: 2.42, nineTen: 0.43 };

export function hkoMonth(month: number): HkoClimateMonth {
  return HKO_TC_WARNING_DAYS[Math.max(1, Math.min(12, Math.round(month))) - 1] ?? HKO_TC_WARNING_DAYS[0];
}

export function hkoSeasonNote(month: number): string {
  if (month >= 7 && month <= 9) return '颱風旺季：7–9 月平均最多 8 號或以上風球日數';
  if (month >= 5 && month <= 11) return '颱風季節（5–11 月）：留意天文台警告';
  return '非颱風季節（12–4 月）：熱帶氣旋影響較少';
}

export type HkoWarnLevel =
  | 'sig10'
  | 'sig9'
  | 'sig8'
  | 'sig3'
  | 'sig1'
  | 'blackrain'
  | 'redrain'
  | 'amberrain'
  | 'thunder'
  | 'landslip'
  | 'hot'
  | 'cold'
  | 'fog'
  | 'other';

export interface HkoWarnInfo {
  level: HkoWarnLevel;
  title: string;
  effects: string;
  icon: string;
  dismissible: boolean;
  /** 目前颱風信號（0 = 非風球警告） */
  signal: number;
  /** 8 號風球方向（東北／西北／東南／西南；非 8 號為空） */
  direction: string;
  /** 嚴重程度：1 輕／2 中／3 嚴重（8+、黑雨） */
  severity: 1 | 2 | 3;
}

interface ClockExtra {
  typhoonSignal?: number;
  typhoonName?: string;
  rainstorm?: string;
  warning?: string | null;
  weather?: string;
}

const clockExtra = (state: GameState): ClockExtra => state.clock as unknown as ClockExtra;

function parseSignalFromText(text: string): number {
  if (/十號/.test(text)) return 10;
  if (/九號/.test(text)) return 9;
  if (/八號/.test(text)) return 8;
  if (/三號/.test(text)) return 3;
  if (/一號/.test(text)) return 1;
  return 0;
}

/** 目前颱風信號：clock.typhoonSignal 優先；fallback stats／warning 文字／颱風天氣 */
export function currentTyphoonSignal(state: GameState): number {
  const clock = clockExtra(state);
  const text = clock.warning ?? '';
  const explicit = clock.typhoonSignal;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
  const stat = Number(state.stats.typhoonSignal) || 0;
  const parsed = parseSignalFromText(text);
  if (stat > 0) return Math.max(stat, parsed);
  if (parsed > 0) return parsed;
  // 舊存檔／舊模擬：颱風天氣但冇 signal 欄位
  return clock.weather === 'storm' ? 8 : 0;
}

/** 8 號風球方向 */
export function typhoonDirection(state: GameState): string {
  const clock = clockExtra(state);
  const text = `${clock.typhoonName ?? ''} ${clock.warning ?? ''}`;
  const match = /東北|西北|東南|西南/.exec(text);
  return match?.[0] ?? '';
}

function signalTitle(signal: number, direction: string, text: string): string {
  if (text && parseSignalFromText(text) === signal) return text;
  if (signal >= 10) return '十號颶風信號';
  if (signal === 9) return '九號烈風或暴風風力增強信號';
  if (signal >= 8) return `八號${direction}烈風或暴風信號`;
  if (signal === 3) return '三號強風信號';
  if (signal === 1) return '一號戒備信號';
  return text;
}

function signalEffects(signal: number): { effects: string; icon: string; severity: 1 | 2 | 3; dismissible: boolean } {
  if (signal >= 10) {
    return {
      effects: '颶風吹襲 · 全港停工停課 · 渡輪停航 · 港鐵露天段／電車停駛 · 非必要切勿外出',
      icon: '🌪',
      severity: 3,
      dismissible: false,
    };
  }
  if (signal === 9) {
    return {
      effects: '烈風／暴風風力增強 · 停工停課 · 渡輪停航 · 戶外交通停駛 · 遠離岸邊',
      icon: '🌀',
      severity: 3,
      dismissible: false,
    };
  }
  if (signal >= 8) {
    return {
      effects: '停工停課 · 渡輪停航 · 電車停駛 · 貨運受阻 · 地盤停止施工',
      icon: '🌀',
      severity: 3,
      dismissible: false,
    };
  }
  if (signal === 3) {
    return {
      effects: '學校停課 · 渡輪減班 · 戶外工程放緩 · 市民留意強風',
      icon: '💨',
      severity: 2,
      dismissible: false,
    };
  }
  return {
    effects: '熱帶氣旋接近 · 請留意天文台最新警告 · 做好防風準備',
    icon: '🌬',
    severity: 1,
    dismissible: true,
  };
}

/** 由 state 推算目前最嚴重警告（topbar／城事／help 共用） */
export function resolveHkoWarning(state: GameState): HkoWarnInfo | null {
  const clock = clockExtra(state);
  const text = clock.warning ?? '';
  const signal = currentTyphoonSignal(state);
  const direction = typhoonDirection(state);

  if (signal >= 1) {
    const meta = signalEffects(signal);
    return {
      level: signal >= 10 ? 'sig10' : signal === 9 ? 'sig9' : signal >= 8 ? 'sig8' : signal === 3 ? 'sig3' : 'sig1',
      title: signalTitle(signal, direction, text),
      effects: meta.effects,
      icon: meta.icon,
      dismissible: meta.dismissible,
      signal,
      direction,
      severity: meta.severity,
    };
  }

  const rainKind = clock.rainstorm ?? (/黑.*雨/.test(text) ? 'black' : /紅.*雨/.test(text) ? 'red' : /黃.*雨/.test(text) ? 'amber' : '');
  if (rainKind === 'black' || /黑.*雨/.test(text)) {
    return {
      level: 'blackrain',
      title: text || '黑色暴雨警告信號',
      effects: '部分道路嚴重水浸 · 學校停課 · 物流受阻 · 避免前往低窪地區',
      icon: '⛈',
      dismissible: true,
      signal: 0,
      direction: '',
      severity: 3,
    };
  }
  if (rainKind === 'red' || /紅.*雨/.test(text)) {
    return {
      level: 'redrain',
      title: text || '紅色暴雨警告信號',
      effects: '道路水浸 · 行車與行人放慢 · 學校停課安排',
      icon: '🌧',
      dismissible: true,
      signal: 0,
      direction: '',
      severity: 2,
    };
  }
  if (rainKind === 'amber' || /黃.*雨/.test(text) || /暴雨/.test(text)) {
    return {
      level: 'amberrain',
      title: text || '黃色暴雨警告信號',
      effects: '路面濕滑 · 低窪地區可能積水 · 行車放慢',
      icon: '🌧',
      dismissible: true,
      signal: 0,
      direction: '',
      severity: 1,
    };
  }
  if (/雷暴/.test(text)) {
    return {
      level: 'thunder',
      title: text,
      effects: '雷擊風險 · 戶外活動暫停 · 遠離空曠地方',
      icon: '⚡',
      dismissible: true,
      signal: 0,
      direction: '',
      severity: 1,
    };
  }
  if (/山泥傾瀉/.test(text)) {
    return {
      level: 'landslip',
      title: text,
      effects: '山坡地區風險 · 避免前往山邊 · 留意交通改道',
      icon: '⛰',
      dismissible: true,
      signal: 0,
      direction: '',
      severity: 2,
    };
  }
  if (/酷熱/.test(text)) {
    return {
      level: 'hot',
      title: text,
      effects: '注意補水 · 用電高峰期 · 長者與戶外工作者留意',
      icon: '🥵',
      dismissible: true,
      signal: 0,
      direction: '',
      severity: 1,
    };
  }
  if (/寒冷/.test(text) || clock.weather === 'snow') {
    return {
      level: 'cold',
      title: text || '寒冷天氣警告',
      effects: '關顧長者 · 注意保暖 · 山區可能結霜',
      icon: '🥶',
      dismissible: true,
      signal: 0,
      direction: '',
      severity: 1,
    };
  }
  if (/霧/.test(text) || clock.weather === 'fog') {
    return {
      level: 'fog',
      title: text || '大霧警告',
      effects: '渡輪或停航 · 能見度低 · 航班可能延誤',
      icon: '🌫',
      dismissible: true,
      signal: 0,
      direction: '',
      severity: 1,
    };
  }
  if (text) {
    return {
      level: 'other',
      title: text,
      effects: '請留意天文台最新天氣資訊',
      icon: '⚠',
      dismissible: true,
      signal: 0,
      direction: '',
      severity: 1,
    };
  }
  return null;
}

/** 8 號風球全屏警示文案 */
export function typhoonAlertCopy(signal: number, direction: string): { title: string; body: string; level: 'sig8' | 'sig9' | 'sig10' } {
  if (signal >= 10) {
    return {
      title: '十號颶風信號',
      body: '天文台已發出十號颶風信號。颶風級風力吹襲本港，全港停工停課：渡輪停航、港鐵露天段及電車停駛、機場航班大幅受阻，非必要切勿外出。',
      level: 'sig10',
    };
  }
  if (signal === 9) {
    return {
      title: '九號烈風或暴風風力增強信號',
      body: '天文台已發出九號風球，預料風力顯著增強。全港停工停課：渡輪停航、戶外交通停駛，市民應留在安全地方，遠離岸邊及低窪地區。',
      level: 'sig9',
    };
  }
  return {
    title: `八號${direction}烈風或暴風信號`,
    body: '天文台已發出八號風球。全港停工停課：渡輪停航、電車停駛、貨運受阻，地盤停止施工。',
    level: 'sig8',
  };
}
