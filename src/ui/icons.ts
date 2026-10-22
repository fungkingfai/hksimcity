/**
 * 介面圖示：全部以內嵌 SVG／Emoji 自繪，不依賴任何外部圖片或字型。
 *
 * 24 小時霓虹港風的圖示語言：細線條、霓虹色由 CSS 控制（currentColor），
 * 建築卡用香港辨識度高的 Emoji（可接受且離線可用）。
 */

import { RESOURCES, RESOURCE_KEYS, TRANSIT_INFO } from '../core/config';
import type { ResourceKey, TransitMode, Weather } from '../core/types';
import { esc, fmtAmount } from './dom';

const wrap = (body: string): string =>
  `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON = {
  coin: wrap(
    '<circle cx="8" cy="8" r="6.1"/><path d="M5.6 8h4.8M8 5.6v4.8"/>',
  ),
  people: wrap(
    '<circle cx="5.6" cy="5.8" r="2.3"/><path d="M1.9 13.1c.5-2.7 2.1-4 3.7-4s3.2 1.3 3.7 4"/>' +
      '<circle cx="11.6" cy="6.6" r="1.8"/><path d="M10.6 9.6c1.7 0 3 1.1 3.4 3.3"/>',
  ),
  heart: wrap('<path d="M8 13.4S2.2 10 2.2 5.9A3.1 3.1 0 0 1 8 3.6a3.1 3.1 0 0 1 5.8 2.3c0 4.1-5.8 7.5-5.8 7.5Z"/>'),
  clock: wrap('<circle cx="8" cy="8" r="6.1"/><path d="M8 4.6V8l2.4 1.5"/>'),
  sun: wrap(
    '<circle cx="8" cy="8" r="3.1"/><path d="M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7' +
      'M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2"/>',
  ),
  cloud: wrap('<path d="M4.6 12.3h7a2.6 2.6 0 0 0 .2-5.2A3.7 3.7 0 0 0 5 6.2a3 3 0 0 0-.4 6.1Z"/>'),
  rain: wrap(
    '<path d="M4.6 10.2h7a2.6 2.6 0 0 0 .2-5.2A3.7 3.7 0 0 0 5 4.1a3 3 0 0 0-.4 6.1Z"/>' +
      '<path d="m5.6 12.4-.6 1.8M8.4 12.4l-.6 1.8M11.2 12.4l-.6 1.8"/>',
  ),
  storm: wrap(
    '<path d="M13.6 10.6a3 3 0 0 0-2.9-4.6A4.4 4.4 0 0 0 3 6.9a2.9 2.9 0 0 0 .9 5.6h3.3"/>' +
      '<path d="m8.6 10.4-2 3.2h2.6l-.8 2.4 2.8-3.6H8.8Z"/>',
  ),
  fog: wrap(
    '<path d="M4.6 8.2h7a2.3 2.3 0 0 0 .1-4.6A3.5 3.5 0 0 0 5 4.5a2.8 2.8 0 0 0-.4 3.7Z"/>' +
      '<path d="M2.6 10.2h10.8M4.4 12.2h9.2M6.2 14.2h7"/>',
  ),
  snow: wrap(
    '<path d="M8 2v12M3 5l10 6M13 5 3 11"/><path d="m6.4 3.2 1.6 1.4 1.6-1.4M6.4 12.8 8 11.4l1.6 1.4"/>',
  ),
  pause: wrap('<rect x="5" y="3.6" width="2.2" height="8.8" rx="0.5"/><rect x="8.8" y="3.6" width="2.2" height="8.8" rx="0.5"/>'),
  play1: wrap('<path d="M5.4 3.8 12 8l-6.6 4.2Z"/>'),
  play2: wrap('<path d="M3.4 3.8 9 8l-5.6 4.2Z"/><path d="M9.4 3.8 15 8l-5.6 4.2Z"/>'),
  play3: wrap('<path d="M1.6 3.8 6 8l-4.4 4.2Z"/><path d="M6.6 3.8 11 8l-4.4 4.2Z"/><path d="M11.6 3.8 16 8l-4.4 4.2Z"/>'),
  close: wrap('<path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6"/>'),
  chevronLeft: wrap('<path d="M9.8 3.6 5.4 8l4.4 4.4"/>'),
  chevronRight: wrap('<path d="M6.2 3.6 10.6 8l-4.4 4.4"/>'),
  lock: wrap('<rect x="3.6" y="7" width="8.8" height="6.2" rx="1"/><path d="M5.6 7V5.4a2.4 2.4 0 0 1 4.8 0V7"/>'),
  road: wrap('<path d="M5.2 2.2 3.4 13.8M10.8 2.2l1.8 11.6"/><path d="M8 3.2v1.8M8 7.4v1.8M8 11.6v1.8" stroke-dasharray="1 2"/>'),
  sidewalk: wrap(
    '<rect x="2.4" y="2.4" width="11.2" height="11.2" rx="1.2"/><path d="M2.4 8h11.2M8 2.4v11.2"/>',
  ),
  hammer: wrap(
    '<path d="m3.2 13 4.9-4.9"/><path d="M7.2 2.9 12.9 8.6l-1.7 1.7L5.5 4.6Z"/><path d="M6.6 2.1 9 4.5"/>',
  ),
  door: wrap(
    '<path d="M4.2 13.4V3.2h6.2l2.2 1.6v8.6"/><path d="M2.6 13.4h10.8"/><path d="M8.4 8.2h.1"/>',
  ),
  back: wrap('<path d="M13.2 8H3.4"/><path d="M7.4 4 3.4 8l4 4"/>'),
  book: wrap(
    '<path d="M8 3.4C6.4 2.2 4.2 2.1 2.4 2.6v10c1.8-.5 4-.4 5.6.8 1.6-1.2 3.8-1.3 5.6-.8v-10c-1.8-.5-4-.4-5.6.8Z"/>' +
      '<path d="M8 3.4v10"/>',
  ),
  warn: wrap('<path d="M8 2.2 14.2 13H1.8Z"/><path d="M8 6.4v3.4M8 11.6h.1"/>'),
  check: wrap('<path d="m2.8 8.4 3.4 3.4 7-8"/>'),
  info: wrap('<circle cx="8" cy="8" r="6.1"/><path d="M8 7.2v4M8 4.9h.1"/>'),
  scroll: wrap(
    '<path d="M4 3.2h8.4a1.4 1.4 0 0 1 0 2.8H5.4V12a1.4 1.4 0 0 1-2.8 0V4.6a1.4 1.4 0 0 1 1.4-1.4Z"/>' +
      '<path d="M8 6.6h3.6M8 9h3.6"/>',
  ),
  chart: wrap('<path d="M2.4 13.6h11.2"/><path d="M4.4 11V7.4M7.2 11V4.6M10 11V8.6M12.8 11V5.8"/>'),
  land: wrap(
    '<path d="M2.4 12.4h11.2"/><path d="M8 2.6v6.2"/><path d="m5.6 6.4 2.4 2.4 2.4-2.4"/><path d="M3.4 12.4v1.6M12.6 12.4v1.6"/>',
  ),
  fireworks: wrap(
    '<path d="M8 1.8v3M8 11.2v3M1.8 8h3M11.2 8h3M3.6 3.6l2.1 2.1M10.3 10.3l2.1 2.1M12.4 3.6l-2.1 2.1M5.7 10.3l-2.1 2.1"/>' +
      '<circle cx="8" cy="8" r="1.2"/>',
  ),
  stats: wrap('<path d="M3 13.4V2.6M3 13.4h10.4"/><path d="m5 10 2.6-3 2.3 1.9L13 5"/>'),
  mtr: wrap(
    '<rect x="3.6" y="1.9" width="8.8" height="9.4" rx="2.4"/><path d="M3.6 6.4h8.8"/>' +
      '<path d="M8 1.9v9.4"/><path d="m5.2 13.7 1.6-2.4M10.8 13.7l-1.6-2.4"/>',
  ),
  bus: wrap(
    '<rect x="2.6" y="2.6" width="10.8" height="8.6" rx="1.6"/><path d="M2.6 7.4h10.8"/>' +
      '<circle cx="5.4" cy="12.2" r="1.1"/><circle cx="10.6" cy="12.2" r="1.1"/>',
  ),
  tram: wrap(
    '<rect x="3.4" y="3.4" width="9.2" height="7.2" rx="1.4"/><path d="M3.4 7.4h9.2"/>' +
      '<path d="M8 3.4V1.6M5.6 1.6h4.8"/><circle cx="5.6" cy="12.2" r="1"/><circle cx="10.4" cy="12.2" r="1"/>',
  ),
  ferry: wrap(
    '<path d="M2.6 9.6h10.8l-1.6 3.2H4.2Z"/><path d="M4.6 9.6V6.2h6.8v3.4"/><path d="M8 6.2V2.8M6 2.8h4"/>' +
      '<path d="M2.6 13.6c1 .6 2 .6 3 0s2-.6 3 0 2 .6 3 0 1.6-.5 2.2-.2"/>',
  ),
  power: wrap('<path d="M8.8 1.8 4.4 9h3.2l-.8 5.2L11.6 7H8.4Z"/>'),
  water: wrap('<path d="M8 1.8C6 4.6 4.4 6.6 4.4 9a3.6 3.6 0 0 0 7.2 0c0-2.4-1.6-4.4-3.6-7.2Z"/>'),
  truck: wrap(
    '<path d="M1.8 4.4h6.6v6.8H1.8Z"/><path d="M8.4 6.6h2.8l2 2.2v2.4H8.4Z"/>' +
      '<circle cx="4.4" cy="12.4" r="1.1"/><circle cx="11.6" cy="12.4" r="1.1"/>',
  ),
  spark: wrap('<path d="M8 1.8 9.3 6l4.2 1.3L9.3 8.6 8 12.8 6.7 8.6 2.5 7.3 6.7 6Z"/><path d="M12.8 11.4v2.4M11.6 12.6h2.4"/>'),
  target: wrap('<circle cx="8" cy="8" r="6.1"/><circle cx="8" cy="8" r="2.4"/><path d="M8 1.9v1.6M8 12.5v1.6M1.9 8h1.6M12.5 8h1.6"/>'),
  tag: wrap('<path d="M2.4 2.4h5.2l6 6-5.2 5.2-6-6Z"/><circle cx="5.4" cy="5.4" r="1"/>'),
  compass: wrap('<circle cx="8" cy="8" r="6.1"/><path d="m5.4 10.6 2-3.2 3.2-2-2 3.2Z"/>'),
  zoneResidential: wrap('<path d="M2.2 7.6 8 2.6l5.8 5"/><path d="M3.6 7v6.4h8.8V7"/><path d="M6.6 13.4v-3.6h2.8v3.6"/>'),
  zoneCommercial: wrap('<path d="M2.6 5.6h10.8v2.2a2 2 0 0 1-2 2H4.6a2 2 0 0 1-2-2Z"/><path d="M3.6 9.6v3.8h8.8V9.6"/><path d="M5 5.6 6 2.8h4l1 2.8"/>'),
  zoneIndustrial: wrap('<path d="M2.4 13.4V7.4l3.4 2V7.4l3.4 2V7.4l3.4 2v4Z"/><path d="M2.4 7.4 3.4 3h2l.6 2.2"/><path d="M10.6 3.2h2.4l.6 4.2"/>'),
  zoneFarmland: wrap('<path d="M8 13.6V5.2"/><path d="M8 9.4C6 9.4 4.6 8 4.6 6.1 6.6 6.1 8 7.5 8 9.4Z"/><path d="M8 9.4c2 0 3.4-1.4 3.4-3.3C9.4 6.1 8 7.5 8 9.4Z"/><path d="M2.6 13.6h10.8"/>'),
  eraser: wrap('<path d="m3 11.4 5.2-5.2 4.6 4.6-2.6 2.6H5.4Z"/><path d="M2.2 13.8h11.6"/><path d="m8.2 6.2 2.2-2.2 4.2 4.2-2.2 2.2"/>'),
  layers: wrap('<path d="m8 2.2 6 3.2-6 3.2-6-3.2Z"/><path d="m2 8.2 6 3.2 6-3.2"/><path d="m2 11.4 6 3.2 6-3.2"/>'),
  city: wrap('<path d="M2.2 13.6h11.6"/><path d="M3.4 13.6V6.4h3v7.2M6.4 13.6V3.6h3.2v10M9.6 13.6v-5h3v5"/><path d="M7.2 6h1.6M7.2 8.2h1.6M7.2 10.4h1.6"/>'),
  sprout: wrap('<path d="M8 14V7.2"/><path d="M8 8.8C6.1 8.8 4.8 7.5 4.8 5.6 6.7 5.6 8 6.9 8 8.8Z"/><path d="M8 8.8c1.9 0 3.2-1.3 3.2-3.2C9.3 5.6 8 6.9 8 8.8Z"/><path d="M2.6 14h10.8"/>'),
  eye: wrap('<path d="M1.6 8S4 3.8 8 3.8 14.4 8 14.4 8 12 12.2 8 12.2 1.6 8 1.6 8Z"/><circle cx="8" cy="8" r="2.1"/>'),
  map: wrap('<path d="M2.2 4.2 6 2.6l4 1.6 3.8-1.6v9.2L10 13.4 6 11.8l-3.8 1.6Z"/><path d="M6 2.6v9.2M10 4.2v9.2"/>'),
  food: wrap('<path d="M2.6 7h10.8a5.4 5.4 0 0 1-10.8 0Z"/><path d="M4.6 7c0-2 1.4-3.6 3.4-3.6S11.4 5 11.4 7"/><path d="M2.2 13.4h11.6"/>'),
  goods: wrap('<path d="M3.2 5.2h9.6l-.9 8.4H4.1Z"/><path d="M5.6 5.2V4a2.4 2.4 0 0 1 4.8 0v1.2"/>'),
} as const;

export type IconName = keyof typeof ICON;

export const ico = (name: IconName): string => ICON[name];

/** 天氣 emoji（天文台風格） */
export function weatherIcon(weather: Weather): string {
  const map: Record<Weather, string> = {
    clear: '☀',
    cloudy: '☁',
    rain: '🌧',
    storm: '🌀',
    fog: '🌫',
    snow: '❄',
  };
  return map[weather] ?? '☀';
}

/** 天氣中文名（由 config 傳入較準，此為備援） */
export function weatherName(weather: Weather): string {
  const map: Record<Weather, string> = {
    clear: '晴',
    cloudy: '陰',
    rain: '雨',
    storm: '颱風',
    fog: '霧',
    snow: '雪',
  };
  return map[weather] ?? weather;
}

export function weatherHint(weather: Weather): string {
  const map: Record<Weather, string> = {
    clear: '陽光普照，適合外出與工程',
    cloudy: '多雲有薄霧，市面如常',
    rain: '下雨路滑，行人與車輛慢行',
    storm: '八號風球！渡輪停航、地盤停工',
    fog: '大霧鎖港，航班延誤、能見度低',
    snow: '寒潮襲港，大帽山結霜，市民避寒',
  };
  return map[weather] ?? '';
}

/** 季節 emoji（config 的 SEASON_INFO 再包一層） */
export function seasonGlyph(season: string): string {
  const map: Record<string, string> = {
    spring: '🌱',
    summer: '☀',
    autumn: '🍂',
    winter: '❄',
  };
  return map[season] ?? '';
}

/** 霓虹小章（取代舊版朱紅印章；保留 seal 函式名以兼容其他面板） */
export function sealHtml(text: string, extra = ''): string {
  return `<span class="seal${extra ? ` ${extra}` : ''}">${esc(text)}</span>`;
}

/** 資源小章（顏色方塊 + 名稱 + 數量） */
export function resourceChip(key: ResourceKey, amount: number): string {
  const def = RESOURCES[key];
  if (!def) return '';
  return (
    `<span class="res-chip" style="--res:${def.color}" title="${esc(def.name)}">` +
    `<i class="res-sq">${esc(def.short)}</i><b>${fmtAmount(amount)}</b><em>${esc(def.name)}</em></span>`
  );
}

/** 一組庫存 → 資源章列表 */
export function resourceChips(
  inventory: Partial<Record<ResourceKey, number>>,
  emptyText = '空空如也',
): string {
  const entries = (Object.entries(inventory) as [ResourceKey, number][]).filter(
    ([key, value]) => RESOURCES[key] && value > 0.01,
  );
  if (!entries.length) return `<span class="muted">${esc(emptyText)}</span>`;
  entries.sort((a, b) => RESOURCE_KEYS.indexOf(a[0]) - RESOURCE_KEYS.indexOf(b[0]));
  return entries.map(([key, value]) => resourceChip(key, value)).join('');
}

/** 市民名牌 */
export function personPill(name: string, sub = ''): string {
  return `<span class="person" title="${esc(name)}${sub ? ` · ${esc(sub)}` : ''}">${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>`;
}

/** 交通模式 emoji */
export function transitIcon(mode: TransitMode): string {
  return TRANSIT_INFO[mode]?.emoji ?? '🚌';
}

/** 建築卡 Emoji（香港辨識度優先） */
export const BUILDING_GLYPHS: Record<string, string> = {
  tongLau: '🏚',
  subdividedFlat: '🚪',
  publicHousing: '🏢',
  hOSFlat: '🏘',
  privateEstate: '🏙',
  luxuryTower: '🏰',
  farm: '🌾',
  quarry: '⛏',
  industrialBuilding: '🏭',
  foodFactory: '🥫',
  powerPlant: '⚡',
  waterworks: '🚰',
  importFirm: '🧾',
  containerPort: '🚢',
  warehouse: '📦',
  chaChaanTeng: '☕',
  convenienceStore: '🏪',
  wetMarket: '🥬',
  supermarket: '🛒',
  shoppingMall: '🛍',
  restaurant: '🥟',
  officeTower: '🏢',
  school: '🏫',
  hospital: '🏥',
  policeStation: '🚓',
  fireStation: '🚒',
  mtrStation: '🚇',
  busTerminus: '🚌',
  tramStop: '🚋',
  ferryPier: '⛴',
  park: '🌳',
  promenade: '🌊',
};

/** 建築卡圖示；未知 key 用首字 */
export function buildingGlyph(key: string, name: string): string {
  return BUILDING_GLYPHS[key] ?? esc(name.slice(0, 1));
}
