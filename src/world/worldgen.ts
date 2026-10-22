/**
 * 《維港之城》世界生成：96×96 香港地圖。
 *
 * 地理藍圖（設計座標 0..96，x 西→東、y 北→南，香港在北半球，故北在上方）：
 *
 *  ┌──────────────────────────────────────────────────────────┐
 *  │ 深圳河 y0–2 │ 新界：大帽山(34,8)、粉嶺、元朗、米埔濕地   │
 *  │             │ 沙田/城門河 → 吐露港、西貢、馬鞍山、將軍澳│
 *  │──────────────────────────────────────────────────────────│
 *  │ 九龍半島：深水埗/旺角/九龍/觀塘、獅子山(52,35)、          │
 *  │           啟德跑道伸入維港、西九龍填海                    │
 *  │ 維多利亞港：東西向 y≈51–62、寬 6–9 格、東端鯉魚門收窄      │
 *  │ 香港島：中環/灣仔/銅鑼灣/北角、太平山(35,70)、南區、       │
 *  │         大潭水塘、赤柱；南面為南海                          │
 *  │ 大嶼山(西)：鳳凰山/大東山、東涌、大澳、赤鱲角機場；        │
 *  │             離島：青衣、南丫島、長洲、坪洲、東龍洲          │
 *  └──────────────────────────────────────────────────────────┘
 *
 * 生成步驟：
 *   1. 以「海岸線函數 + 島嶼多邊形 + 填海／機場／碼頭填土」雕刻陸地；
 *   2. 山脈以高斯峰 + 稜線距離場疊加，得出可辨識的大帽山／獅子山／太平山；
 *   3. 依城市分區（urban）、填海（reclaimed）、農地、濕地、郊野公園（forest）分類；
 *   4. 保證可建面積（≥52%）與 spawn 周邊為平整可建地；
 *   5. 預置 spawn 小街區（馬路 + 行人路）與 3 條過海隧道（水格 road=true，
 *      由 render/roads.ts 畫成隧道），讓市民與車輛可過海。
 *
 * 介面保持不變：`generateWorld(seed, width?, height?, options?)`、`createTiles(seed)`。
 * 本檔另 export 香港地名／地標／區域資料，供 terrain / environment / UI 模組使用
 * （全部為 96×96 設計座標，使用時乘以 state.width/96 換算）。
 */

import { GRID_HEIGHT, GRID_WIDTH } from '../core/config';
import { clamp, hash2d, mulberry32, ValueNoise } from '../core/rng';
import type { TerrainType, Tile } from '../core/types';

// ─────────────────────────── 對外型別 ───────────────────────────

export interface WorldGenResult {
  width: number;
  height: number;
  tiles: Tile[];
  /** 建議的開局鏡頭中心（格座標）：中環／金鐘一帶的北岸市中心 */
  spawn: { x: number; y: number };
}

/** 設計座標基準尺寸（香港地圖原稿為 96×96） */
export const HK_DESIGN_SIZE = 96;

export type HkPlaceKind = 'district' | 'mountain' | 'water' | 'island' | 'landmark' | 'reservoir';

/** 香港地名（設計座標；terrain/environment 用以放置地名標籤） */
export interface HkPlace {
  name: string;
  x: number;
  y: number;
  kind: HkPlaceKind;
}

/** 地標（設計座標；terrain 用以放置凌霄閣、天壇大佛、摩天輪、鐘樓等） */
export interface HkLandmark {
  name: string;
  x: number;
  y: number;
  kind: 'peakTower' | 'buddha' | 'ferrisWheel' | 'clockTower' | 'convention' | 'bigBridge';
}

/** 地區塊（設計座標；terrain 用以生成天際線樓群、機場跑道、貨櫃碼頭等） */
export interface HkRegion {
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: 'skyline' | 'airport' | 'runway' | 'containerPort' | 'newTown';
}

/** 維港三條過海隧道（設計 x 座標；y 範圍由地形決定） */
export const HK_TUNNELS: { name: string; x: number }[] = [
  { name: '西區海底隧道', x: 33 },
  { name: '紅磡海底隧道', x: 52 },
  { name: '東區海底隧道', x: 70 },
];

/** 香港地名標籤（對齊 core/config.ts MAP_LABELS 的概念位置，並按實際海岸微調） */
export const HK_PLACES: HkPlace[] = [
  { name: '新界', x: 44, y: 13, kind: 'district' },
  { name: '大帽山', x: 34, y: 8, kind: 'mountain' },
  { name: '沙田', x: 58, y: 21, kind: 'district' },
  { name: '吐露港', x: 72, y: 21.5, kind: 'water' },
  { name: '西貢', x: 80, y: 24, kind: 'district' },
  { name: '大埔', x: 74, y: 15, kind: 'district' },
  { name: '馬鞍山', x: 72, y: 28, kind: 'mountain' },
  { name: '荃灣', x: 27, y: 29, kind: 'district' },
  { name: '葵涌', x: 31, y: 37, kind: 'district' },
  { name: '青衣', x: 24, y: 42, kind: 'island' },
  { name: '將軍澳', x: 82, y: 41, kind: 'district' },
  { name: '清水灣', x: 86, y: 33, kind: 'water' },
  { name: '米埔', x: 10, y: 11, kind: 'landmark' },
  { name: '深水埗', x: 42, y: 42, kind: 'district' },
  { name: '旺角', x: 48, y: 44, kind: 'district' },
  { name: '九龍', x: 58, y: 44, kind: 'district' },
  { name: '觀塘', x: 67, y: 43, kind: 'district' },
  { name: '啟德', x: 59, y: 50, kind: 'landmark' },
  { name: '獅子山', x: 52, y: 35, kind: 'mountain' },
  { name: '西九龍', x: 37, y: 48, kind: 'landmark' },
  { name: '維多利亞港', x: 53, y: 55, kind: 'water' },
  { name: '中環', x: 40, y: 64, kind: 'district' },
  { name: '銅鑼灣', x: 53, y: 64, kind: 'district' },
  { name: '北角', x: 61, y: 64, kind: 'district' },
  { name: '太平山', x: 35, y: 70, kind: 'mountain' },
  { name: '香港島', x: 46, y: 78, kind: 'island' },
  { name: '赤柱', x: 56, y: 84, kind: 'district' },
  { name: '大潭水塘', x: 55, y: 76, kind: 'reservoir' },
  { name: '大嶼山', x: 12, y: 60, kind: 'island' },
  { name: '鳳凰山', x: 7, y: 60, kind: 'mountain' },
  { name: '東涌', x: 20, y: 50, kind: 'district' },
  { name: '赤鱲角', x: 8, y: 43, kind: 'island' },
  { name: '南丫島', x: 34, y: 89, kind: 'island' },
  { name: '長洲', x: 19, y: 79, kind: 'island' },
  { name: '坪洲', x: 24, y: 60, kind: 'island' },
  { name: '深圳河', x: 56, y: 2, kind: 'water' },
];

/** 地標（設計座標） */
export const HK_LANDMARKS: HkLandmark[] = [
  { name: '山頂凌霄閣', x: 34, y: 70, kind: 'peakTower' },
  { name: '天壇大佛', x: 8, y: 62, kind: 'buddha' },
  { name: '中環摩天輪', x: 41, y: 60, kind: 'ferrisWheel' },
  { name: '尖沙咀鐘樓', x: 47, y: 52, kind: 'clockTower' },
  { name: '會展新翼', x: 47, y: 61, kind: 'convention' },
  { name: '青馬大橋', x: 21, y: 47, kind: 'bigBridge' },
];

/** 地區塊（設計座標；渲染用） */
export const HK_REGIONS: HkRegion[] = [
  { name: '中環天際線', x0: 36, y0: 60, x1: 52, y1: 66, kind: 'skyline' },
  { name: '尖沙咀天際線', x0: 42, y0: 45, x1: 56, y1: 51, kind: 'skyline' },
  { name: '觀塘商廈', x0: 62, y0: 40, x1: 72, y1: 47, kind: 'skyline' },
  { name: '荃灣樓群', x0: 23, y0: 28, x1: 31, y1: 35, kind: 'skyline' },
  { name: '沙田樓群', x0: 55, y0: 19, x1: 64, y1: 26, kind: 'newTown' },
  { name: '赤鱲角機場', x0: 2, y0: 39, x1: 15, y1: 48, kind: 'airport' },
  { name: '機場跑道', x0: 3, y0: 44, x1: 14, y1: 46, kind: 'runway' },
  { name: '葵青貨櫃碼頭', x0: 25, y0: 34, x1: 33, y1: 41, kind: 'containerPort' },
  { name: '啟德跑道', x0: 57, y0: 52, x1: 60, y1: 59, kind: 'runway' },
];

/** 走陸行 spawn 附近預置道路的設計座標（回報與文檔用） */
export const HK_SPAWN_DESIGN = { x: 44, y: 63 };

// ─────────────────────────── 幾何工具 ───────────────────────────

type Pt = [number, number];

/** 折線插值（依 x 取 y；用於海岸線） */
function piecewise(points: Pt[], x: number): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) {
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return points[points.length - 1][1];
}

/** 點到線段距離 */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey || 1;
  const t = clamp(((px - ax) * ex + (py - ay) * ey) / len2, 0, 1);
  const dx = px - (ax + ex * t);
  const dy = py - (ay + ey * t);
  return Math.sqrt(dx * dx + dy * dy);
}

/** 多邊形有號距離（內負、外正） */
function polygonSdf(px: number, py: number, pts: Pt[]): number {
  let dist = Infinity;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    dist = Math.min(dist, segDist(px, py, xi, yi, xj, yj));
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return (inside ? -1 : 1) * Math.sqrt(dist);
}

// ─────────────────────────── 海岸線資料 ───────────────────────────

/**
 * 九龍／新界南岸線（由西向東）：[x, y]。
 * 北岸以西九龍/尖沙咀/紅磡/啟德/觀塘/油塘/鯉魚門為界，南面是維港；
 * x>76 後為將軍澳／清水灣海岸（向南突出）。
 */
const SOUTH_COAST: Pt[] = [
  [0, 28],
  [4, 29],
  [8, 30],
  [12, 31],
  [16, 33],
  [20, 35],
  [24, 38],
  [28, 40],
  [30, 42],
  [32, 45],
  [34, 47.5],
  [36, 49.5],
  [40, 50.5],
  [44, 50.5],
  [48, 51],
  [52, 51.5],
  [56, 52],
  [60, 52.5],
  [64, 53],
  [68, 54],
  [72, 56],
  [76, 57.5],
  [80, 52],
  [84, 48],
  [88, 44],
  [92, 40],
  [96, 37],
];

/** 東面海岸線 [y, x]：清水灣／西貢以東為海 */
const EAST_COAST: Pt[] = [
  [0, 96],
  [4, 95],
  [8, 94],
  [12, 92],
  [16, 91],
  [20, 89],
  [24, 87],
  [28, 86],
  [32, 87],
  [36, 90],
  [40, 92],
  [44, 94],
  [48, 95],
  [52, 96],
  [96, 96],
];

/** 香港島海岸（順時針） */
const HK_ISLAND: Pt[] = [
  [20, 62],
  [23, 59.5],
  [27, 58.5],
  [31, 58],
  [36, 58],
  [41, 58],
  [46, 58.5],
  [51, 58.5],
  [56, 59],
  [61, 59],
  [66, 60],
  [70, 62],
  [73, 66],
  [72, 70],
  [74, 73],
  [71, 76],
  [66, 79],
  [63, 78.5],
  [61, 80.5],
  [60, 84],
  [57, 86],
  [54, 84],
  [52, 80],
  [50, 82],
  [48, 80],
  [45, 82],
  [41, 81],
  [38, 80],
  [34, 81],
  [30, 79],
  [26, 76],
  [23, 72],
  [21, 68],
  [19, 65],
];

/** 大嶼山海岸（順時針；北岸為汲水門／東涌，南岸為長沙泳灘） */
const LANTAU: Pt[] = [
  [2, 50],
  [5, 47],
  [9, 46],
  [13, 47],
  [17, 46],
  [21, 47],
  [26, 50],
  [27, 55],
  [26, 60],
  [24, 65],
  [22, 70],
  [20, 74],
  [16, 78],
  [12, 79.5],
  [8, 77],
  [5, 73],
  [3, 68],
  [2, 60],
  [1, 54],
];

/** 青衣島 */
const TSING_YI: Pt[] = [
  [19, 38.5],
  [23.5, 37],
  [27.5, 39.5],
  [29.5, 44],
  [27, 48],
  [21.5, 47],
  [19, 43.5],
];

/** 南丫島（兩個山頭連成） */
const LAMMA: Pt[] = [
  [29.5, 85.5],
  [34, 84],
  [38, 86.5],
  [39.5, 90],
  [36.5, 92.5],
  [32, 91.5],
  [28.5, 88.5],
];

/** 赤鱲角（機場島，人工填海） */
const CHEK_LAP_KOK: Pt[] = [
  [2, 40],
  [6, 39],
  [11, 40],
  [14, 43],
  [13, 47],
  [8, 48],
  [4, 46],
  [2, 43],
];

/** 山巔（設計座標、高度 0..1、影響半徑） */
const PEAKS: { x: number; y: number; h: number; r: number }[] = [
  { x: 34, y: 8, h: 1.0, r: 10 }, // 大帽山 957m
  { x: 42, y: 12, h: 0.55, r: 7 }, // 大帽山東坡
  { x: 7, y: 60, h: 0.95, r: 7 }, // 鳳凰山 934m
  { x: 14, y: 56, h: 0.82, r: 6.5 }, // 大東山 869m
  { x: 11, y: 54, h: 0.6, r: 5 }, // 彌勒山
  { x: 35, y: 70, h: 0.78, r: 7 }, // 太平山 552m
  { x: 52, y: 35, h: 0.62, r: 6 }, // 獅子山
  { x: 46, y: 34, h: 0.5, r: 5 }, // 筆架山
  { x: 61, y: 33, h: 0.58, r: 5.5 }, // 大老山
  { x: 68, y: 35, h: 0.66, r: 5.5 }, // 飛鵝山
  { x: 72, y: 27, h: 0.7, r: 5.5 }, // 馬鞍山 702m
  { x: 59, y: 68, h: 0.6, r: 6 }, // 柏架山
  { x: 55, y: 77, h: 0.4, r: 4.5 }, // 大潭山
  { x: 82, y: 13, h: 0.52, r: 6 }, // 石屋山
  { x: 8, y: 25, h: 0.58, r: 5.5 }, // 青山 583m
  { x: 15, y: 32, h: 0.42, r: 5 }, // 大欖
  { x: 23, y: 43, h: 0.28, r: 3 }, // 青衣山
  { x: 19, y: 79, h: 0.22, r: 2.4 }, // 長洲
  { x: 34, y: 89, h: 0.3, r: 3 }, // 南丫島山地
  { x: 78, y: 57, h: 0.24, r: 2.4 }, // 東龍洲
];

/** 山稜線（設計座標、高度、寬度） */
const RIDGES: { x1: number; y1: number; x2: number; y2: number; h: number; r: number }[] = [
  { x1: 22, y1: 15, x2: 40, y2: 5, h: 0.45, r: 6.5 }, // 大帽山稜線
  { x1: 28, y1: 17, x2: 42, y2: 11, h: 0.38, r: 5.5 },
  { x1: 44, y1: 36, x2: 64, y2: 34, h: 0.34, r: 4.5 }, // 獅子山–大老山稜線
  { x1: 64, y1: 34, x2: 76, y2: 27, h: 0.34, r: 4.5 }, // 馬鞍山稜線
  { x1: 4, y1: 57, x2: 16, y2: 62, h: 0.42, r: 5.5 }, // 大嶼山主稜
  { x1: 6, y1: 63, x2: 17, y2: 70, h: 0.3, r: 4.5 },
  { x1: 28, y1: 67, x2: 44, y2: 73, h: 0.32, r: 5 }, // 港島山稜
  { x1: 50, y1: 68, x2: 64, y2: 72, h: 0.28, r: 4.5 }, // 港島東山稜
  { x1: 74, y1: 10, x2: 88, y2: 18, h: 0.32, r: 5.5 }, // 西貢山稜
  { x1: 80, y1: 12, x2: 92, y2: 22, h: 0.26, r: 5 },
  { x1: 4, y1: 20, x2: 12, y2: 28, h: 0.3, r: 4.5 }, // 青山稜線
  { x1: 10, y1: 28, x2: 22, y2: 34, h: 0.24, r: 4.5 }, // 大欖
  { x1: 82, y1: 30, x2: 90, y2: 37, h: 0.24, r: 4 }, // 清水灣山
  { x1: 33, y1: 87, x2: 36, y2: 90, h: 0.2, r: 2.6 }, // 南丫島
];

/** 都會區（設計座標：中心、半徑） */
const URBAN_ZONES: { x: number; y: number; rx: number; ry: number }[] = [
  // 九龍
  { x: 41, y: 42, rx: 4.5, ry: 4 }, // 深水埗
  { x: 48, y: 44, rx: 4, ry: 3.5 }, // 旺角
  { x: 44, y: 48, rx: 3, ry: 2.4 }, // 油麻地
  { x: 45, y: 50.5, rx: 3, ry: 1.8 }, // 尖沙咀
  { x: 51, y: 49, rx: 2.6, ry: 2 }, // 紅磡
  { x: 56, y: 46, rx: 3.4, ry: 3 }, // 九龍城／土瓜灣
  { x: 55, y: 41, rx: 3, ry: 2.6 }, // 黃大仙
  { x: 67, y: 43, rx: 4.2, ry: 3.4 }, // 觀塘
  { x: 63, y: 38, rx: 2.6, ry: 2.4 }, // 牛頭角
  { x: 59, y: 49.5, rx: 2.6, ry: 2 }, // 啟德
  // 荃灣／葵涌
  { x: 27, y: 30, rx: 3.6, ry: 3 }, // 荃灣
  { x: 31, y: 37, rx: 3.2, ry: 2.8 }, // 葵涌
  // 港島北岸
  { x: 25, y: 63, rx: 2.6, ry: 2 }, // 西環
  { x: 30, y: 62.5, rx: 2.6, ry: 2 }, // 上環／西營盤
  { x: 40, y: 63, rx: 3.6, ry: 2.8 }, // 中環
  { x: 45, y: 63, rx: 2.6, ry: 2.2 }, // 金鐘／灣仔
  { x: 52, y: 63.5, rx: 2.6, ry: 2.2 }, // 銅鑼灣
  { x: 59, y: 64, rx: 2.4, ry: 2.2 }, // 北角
  { x: 63, y: 64.5, rx: 2, ry: 2 }, // 鰂魚涌
  { x: 68, y: 66, rx: 2.6, ry: 2.4 }, // 西灣河／筲箕灣
  { x: 71, y: 71, rx: 2.4, ry: 2.6 }, // 柴灣
  { x: 34, y: 77, rx: 2.6, ry: 2.2 }, // 香港仔
  { x: 57, y: 83, rx: 2.2, ry: 2 }, // 赤柱
  { x: 34, y: 69, rx: 1.8, ry: 1.6 }, // 山頂
  { x: 37, y: 66, rx: 1.8, ry: 1.6 }, // 半山
  // 新界新市鎮
  { x: 58, y: 21, rx: 4, ry: 3.4 }, // 沙田
  { x: 74, y: 15, rx: 3, ry: 2.6 }, // 大埔
  { x: 50, y: 6, rx: 3.4, ry: 2.6 }, // 粉嶺／上水
  { x: 4, y: 25, rx: 2.8, ry: 2.6 }, // 屯門
  { x: 11, y: 21, rx: 3, ry: 2.6 }, // 元朗
  { x: 82, y: 41, rx: 4.4, ry: 3.4 }, // 將軍澳
  { x: 20, y: 50, rx: 3.2, ry: 2.6 }, // 東涌
  { x: 80, y: 24, rx: 2, ry: 2 }, // 西貢市
];

/** 填海／新市鎮填土區（設計座標矩形）：會補成陸地並標為 reclaimed */
const RECLAIM_RECTS: { name: string; x0: number; y0: number; x1: number; y1: number }[] = [
  { name: '西九龍填海', x0: 33, y0: 47, x1: 41, y1: 51 },
  { name: '中環灣仔填海', x0: 36, y0: 57, x1: 51, y1: 61 },
  { name: '啟德發展區', x0: 54, y0: 47, x1: 63, y1: 52 },
  { name: '啟德跑道', x0: 56, y0: 51, x1: 61, y1: 59 },
  { name: '東涌填海', x0: 16, y0: 45, x1: 24, y1: 52 },
  { name: '葵青貨櫃碼頭', x0: 25, y0: 34, x1: 33, y1: 42 },
  { name: '沙田填海', x0: 55, y0: 20, x1: 64, y1: 27 },
  { name: '將軍澳填海', x0: 77, y0: 38, x1: 87, y1: 45 },
  { name: '赤鱲角機場', x0: 2, y0: 39, x1: 15, y1: 48 },
  { name: '杏花邨填海', x0: 68, y0: 61, x1: 72, y1: 64 },
];

/** 農地（設計座標橢圓區） */
const FERTILE_ZONES: { x: number; y: number; rx: number; ry: number }[] = [
  { x: 11, y: 17, rx: 8, ry: 6.5 }, // 元朗平原
  { x: 19, y: 23, rx: 5.5, ry: 4.5 }, // 錦田
  { x: 49, y: 6.5, rx: 8, ry: 4 }, // 粉嶺／上水
  { x: 59, y: 18, rx: 4.4, ry: 3 }, // 沙田谷
  { x: 78, y: 14, rx: 5, ry: 3.5 }, // 西貢
  { x: 18, y: 64, rx: 3.6, ry: 3.4 }, // 梅窩
  { x: 23, y: 33, rx: 3.4, ry: 2.6 }, // 大欖
  { x: 13, y: 40, rx: 3, ry: 2.4 }, // 大嶼山北岸農地
];

/** 郊野公園／林地（設計座標橢圓區；山坡另計） */
const FOREST_ZONES: { x: number; y: number; rx: number; ry: number }[] = [
  { x: 12, y: 62, rx: 9, ry: 9 }, // 大嶼山郊野公園
  { x: 8, y: 70, rx: 5, ry: 5 },
  { x: 82, y: 17, rx: 8, ry: 9 }, // 西貢東郊野公園
  { x: 88, y: 30, rx: 4, ry: 5 },
  { x: 32, y: 13, rx: 10, ry: 7 }, // 大帽山郊野公園
  { x: 52, y: 30, rx: 10, ry: 6 }, // 城門／金山
  { x: 70, y: 28, rx: 5, ry: 4 }, // 馬鞍山
  { x: 36, y: 72, rx: 9, ry: 6 }, // 港島西郊野公園
  { x: 58, y: 75, rx: 8, ry: 5 }, // 大潭郊野公園
  { x: 15, y: 30, rx: 5, ry: 5 }, // 大欖郊野公園
  { x: 78, y: 44, rx: 5, ry: 4 }, // 將軍澳後山
];

/** 泳灘（設計座標；靠近岸邊生成沙灘） */
const BEACHES: { x: number; y: number; r: number }[] = [
  { x: 49, y: 81.5, r: 2.4 }, // 淺水灣
  { x: 55, y: 84, r: 2.2 }, // 赤柱
  { x: 62, y: 79.5, r: 2.2 }, // 石澳
  { x: 66, y: 78.5, r: 2 }, // 大浪灣
  { x: 86, y: 36, r: 2.4 }, // 清水灣
  { x: 84, y: 41, r: 2.2 }, // 銀線灣
  { x: 11, y: 76.5, r: 2.6 }, // 大嶼山長沙
  { x: 14, y: 77, r: 2.2 }, // 塘福
  { x: 7, y: 74, r: 2.2 }, // 貝澳
  { x: 20, y: 73, r: 2 }, // 銀礦灣
  { x: 21, y: 80, r: 2 }, // 長洲東灣
  { x: 33, y: 87, r: 2 }, // 南丫島洪聖爺灣
  { x: 88, y: 24, r: 2.2 }, // 西貢大浪西灣
  { x: 23, y: 60, r: 1.6 }, // 坪洲
];

/** 米埔／大澳濕地（設計座標矩形） */
const WETLAND_RECTS: { name: string; x0: number; y0: number; x1: number; y1: number }[] = [
  { name: '米埔濕地', x0: 4, y0: 5, x1: 18, y1: 17 },
  { name: '大澳濕地', x0: 2, y0: 49, x1: 6, y1: 54 },
  { name: '塱原濕地', x0: 38, y0: 6, x1: 43, y1: 10 },
];

// ─────────────────────────── 主生成函數 ───────────────────────────

export interface GenerateWorldOptions {
  /**
   * 是否預置 spawn 小街區與三條過海隧道（預設 true：開局即有市區道路，
   * 符合驗收「有預設市中心與起始道路」）。世界生成不變時可關閉以作純地形預覽。
   */
  starterRoads?: boolean;
}

export function generateWorld(
  seed = 20261021,
  width = GRID_WIDTH,
  height = GRID_HEIGHT,
  options: GenerateWorldOptions = {},
): WorldGenResult {
  const s = seed >>> 0;
  const rng = mulberry32(s);
  const coastNoise = new ValueNoise(s + 101);
  const detailNoise = new ValueNoise(s + 202);
  const ridgeNoise = new ValueNoise(s + 303);
  const patchNoise = new ValueNoise(s + 404);
  const forestNoise = new ValueNoise(s + 505);

  const sx = width / HK_DESIGN_SIZE;
  const sy = height / HK_DESIGN_SIZE;
  const size = width * height;
  const idx = (x: number, y: number): number => y * width + x;
  /** 格中心 → 設計座標 */
  const toDesign = (x: number, y: number): { x: number; y: number } => ({
    x: (x + 0.5) / sx - 0.5,
    y: (y + 0.5) / sy - 0.5,
  });
  /** 設計座標 → 格座標（四捨五入） */
  const toTile = (dx: number, dy: number): { x: number; y: number } => ({
    x: clamp(Math.round((dx + 0.5) * sx - 0.5), 0, width - 1),
    y: clamp(Math.round((dy + 0.5) * sy - 0.5), 0, height - 1),
  });

  // ───────────── 1. 水域雕刻 ─────────────

  /** 0 = 陸地；>0 = 水域種類 */
  const WATER_SEA = 1;
  const WATER_HARBOUR = 2;
  const WATER_RIVER = 3;
  const WATER_RESERVOIR = 4;
  const WATER_POND = 5;
  const WATER_BOUNDARY = 6; // 深圳河

  const land = new Uint8Array(size).fill(1);
  const waterKind = new Uint8Array(size);

  const carve = (x: number, y: number, kind: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = idx(x, y);
    land[i] = 0;
    waterKind[i] = kind;
  };
  const fillLand = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = idx(x, y);
    land[i] = 1;
    if (waterKind[i]) waterKind[i] = 0;
  };

  /** Tolo Harbour：吐露港水道（由沙田河口向東出海） */
  const TOLO_A = { x: 62, y: 24 };
  const TOLO_B = { x: 90, y: 19 };

  /** NW 后海灣多邊形（深圳灣） */
  const NW_BAY: Pt[] = [
    [0, 0],
    [0, 17],
    [4, 19],
    [8, 16],
    [10, 12],
    [9, 7],
    [6, 3],
    [2, 0],
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { x: dx, y: dy } = toDesign(x, y);
      const i = idx(x, y);
      const wob = (coastNoise.at(dx * 0.19 + 3.3, dy * 0.19 + 7.1) - 0.5) * 2.2;
      const wob2 = (coastNoise.at(dx * 0.11 + 11.7, dy * 0.11 + 2.9) - 0.5) * 2.4;

      // 深圳河：地圖最北 2~3 行為界河
      const riverEdge = 1.7 + (patchNoise.at(dx * 0.13 + 4.4, 1.7) - 0.5) * 0.8;
      if (dy < riverEdge) {
        land[i] = 0;
        waterKind[i] = WATER_BOUNDARY;
        continue;
      }

      // 后海灣（西北角）
      if (polygonSdf(dx, dy, NW_BAY) + (patchNoise.at(dx * 0.3, dy * 0.3) - 0.5) * 1.4 < 0) {
        land[i] = 0;
        waterKind[i] = WATER_SEA;
        continue;
      }

      // 南面海域：九龍／新界／將軍澳海岸以南
      if (dy > piecewise(SOUTH_COAST, dx) + wob) {
        land[i] = 0;
        waterKind[i] = dy < 62 ? WATER_HARBOUR : WATER_SEA;
        continue;
      }

      // 東面海域：西貢／清水灣以東
      if (dx > piecewise(EAST_COAST, dy) + wob2) {
        land[i] = 0;
        waterKind[i] = WATER_SEA;
        continue;
      }

      // 吐露港海灣
      const toloD = segDist(dx, dy, TOLO_A.x, TOLO_A.y, TOLO_B.x, TOLO_B.y);
      if (toloD < 2.35 + (patchNoise.at(dx * 0.27 + 9, dy * 0.27 + 5) - 0.5) * 1.3) {
        land[i] = 0;
        waterKind[i] = WATER_SEA;
        continue;
      }
      // 沙田海口小灣
      const shaTinMouth = Math.hypot(dx - 62, dy - 24);
      if (shaTinMouth < 2.2 + (patchNoise.at(dx * 0.4, dy * 0.4) - 0.5) * 0.9) {
        land[i] = 0;
        waterKind[i] = WATER_SEA;
      }
    }
  }

  // ───────────── 2. 島嶼登陸（在海上補回陸地） ─────────────

  const stampPolygon = (pts: Pt[], jitter: number, filler: number): void => {
    // 先求 bbox 加快
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [px, py] of pts) {
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
    const x0 = clamp(Math.floor((minX - 1.5) * sx), 0, width - 1);
    const x1 = clamp(Math.ceil((maxX + 1.5) * sx), 0, width - 1);
    const y0 = clamp(Math.floor((minY - 1.5) * sy), 0, height - 1);
    const y1 = clamp(Math.ceil((maxY + 1.5) * sy), 0, height - 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const { x: dx, y: dy } = toDesign(x, y);
        const n = (coastNoise.at(dx * 0.42 + 17, dy * 0.42 + 23) - 0.5) * jitter;
        if (polygonSdf(dx, dy, pts) + n < 0) {
          const i = idx(x, y);
          land[i] = 1;
          if (waterKind[i]) waterKind[i] = 0;
          if (filler > 0) waterKind[i] = 0;
        }
      }
    }
  };

  stampPolygon(HK_ISLAND, 1.3, 0);
  stampPolygon(LANTAU, 1.5, 0);
  stampPolygon(TSING_YI, 0.8, 0);
  stampPolygon(LAMMA, 0.7, 0);
  stampPolygon(CHEK_LAP_KOK, 0.7, 0);

  // 長洲（啞鈴形：兩個橢圓）
  const stampEllipse = (cx: number, cy: number, rx: number, ry: number, jitter: number): void => {
    const x0 = clamp(Math.floor((cx - rx - 2) * sx), 0, width - 1);
    const x1 = clamp(Math.ceil((cx + rx + 2) * sx), 0, width - 1);
    const y0 = clamp(Math.floor((cy - ry - 2) * sy), 0, height - 1);
    const y1 = clamp(Math.ceil((cy + ry + 2) * sy), 0, height - 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const { x: dx, y: dy } = toDesign(x, y);
        const wob = (patchNoise.at(dx * 0.5 + 31, dy * 0.5 + 37) - 0.5) * jitter;
        const d = ((dx - cx) / rx) ** 2 + ((dy - cy) / ry) ** 2;
        if (d < 1 + wob) {
          const i = idx(x, y);
          land[i] = 1;
          waterKind[i] = 0;
        }
      }
    }
  };
  stampEllipse(17.5, 78, 2.7, 2.9, 0.35); // 長洲西
  stampEllipse(20.8, 80.3, 2.5, 2.3, 0.35); // 長洲東
  stampEllipse(24, 59.5, 2.3, 1.9, 0.3); // 坪洲
  stampEllipse(19.5, 57.5, 1.5, 1.3, 0.25); // 青洲
  stampEllipse(78, 57, 2.4, 2.2, 0.4); // 東龍洲
  stampEllipse(44, 92, 1.6, 1.5, 0.3); // 蒲台島

  // ───────────── 3. 填海區（向海補地） ─────────────

  for (const rect of RECLAIM_RECTS) {
    const x0 = clamp(Math.floor(rect.x0 * sx), 0, width - 1);
    const x1 = clamp(Math.ceil(rect.x1 * sx) - 1, 0, width - 1);
    const y0 = clamp(Math.floor(rect.y0 * sy), 0, height - 1);
    const y1 = clamp(Math.ceil(rect.y1 * sy) - 1, 0, height - 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const { x: dx, y: dy } = toDesign(x, y);
        const edge =
          Math.min(
            (dx - rect.x0) / Math.max(0.8, rect.x1 - rect.x0),
            (rect.x1 - dx) / Math.max(0.8, rect.x1 - rect.x0),
            (dy - rect.y0) / Math.max(0.8, rect.y1 - rect.y0),
            (rect.y1 - dy) / Math.max(0.8, rect.y1 - rect.y0),
          );
        // 邊緣用雜訊稍微不規則，不要四四方方
        const wob = (patchNoise.at(dx * 0.7 + 3, dy * 0.7 + 9) - 0.5) * 0.35;
        if (edge > 0.03 + wob) fillLand(x, y);
      }
    }
  }

  // ───────────── 4. 水塘與河流 ─────────────

  const carveEllipse = (cx: number, cy: number, rx: number, ry: number, kind: number, jitter = 0.5): void => {
    const x0 = clamp(Math.floor((cx - rx - 2) * sx), 0, width - 1);
    const x1 = clamp(Math.ceil((cx + rx + 2) * sx), 0, width - 1);
    const y0 = clamp(Math.floor((cy - ry - 2) * sy), 0, height - 1);
    const y1 = clamp(Math.ceil((cy + ry + 2) * sy), 0, height - 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = idx(x, y);
        if (!land[i]) continue;
        const { x: dx, y: dy } = toDesign(x, y);
        const wob = (patchNoise.at(dx * 0.45 + 43, dy * 0.45 + 51) - 0.5) * jitter;
        const d = ((dx - cx) / rx) ** 2 + ((dy - cy) / ry) ** 2;
        if (d < 1 + wob) {
          land[i] = 0;
          waterKind[i] = kind;
        }
      }
    }
  };

  // 水塘（在山谷中）
  carveEllipse(47, 13, 3.2, 2.2, WATER_RESERVOIR); // 城門水塘
  carveEllipse(55, 76, 3.0, 2.4, WATER_RESERVOIR); // 大潭水塘
  carveEllipse(32, 75, 1.8, 1.5, WATER_RESERVOIR); // 薄扶林水塘
  carveEllipse(7, 68, 3.0, 2.0, WATER_RESERVOIR); // 石壁水塘
  carveEllipse(85, 8, 3.4, 1.8, WATER_RESERVOIR); // 萬宜水庫
  carveEllipse(78, 11, 3.0, 1.7, WATER_RESERVOIR); // 船灣淡水湖
  carveEllipse(17, 32, 2.2, 1.5, WATER_RESERVOIR); // 大欖涌水塘
  carveEllipse(34, 79, 1.4, 1.1, WATER_RESERVOIR); // 香港仔上水塘

  /** 河流：沿折線挖 1 格寬的水道 */
  const carveRiver = (pts: Pt[], widthTiles: number, kind: number): void => {
    for (let k = 1; k < pts.length; k++) {
      const [ax, ay] = pts[k - 1];
      const [bx, by] = pts[k];
      const steps = Math.ceil(Math.hypot(bx - ax, by - ay) * 3);
      for (let q = 0; q <= steps; q++) {
        const t = q / steps;
        const dx = ax + (bx - ax) * t;
        const dy = ay + (by - ay) * t;
        const r = widthTiles / 2 + (patchNoise.at(dx * 0.6, dy * 0.6) - 0.5) * 0.5;
        const x0 = clamp(Math.floor((dx - r) * sx) - 1, 0, width - 1);
        const x1 = clamp(Math.ceil((dx + r) * sx) + 1, 0, width - 1);
        const y0 = clamp(Math.floor((dy - r) * sy) - 1, 0, height - 1);
        const y1 = clamp(Math.ceil((dy + r) * sy) + 1, 0, height - 1);
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const i = idx(x, y);
            if (!land[i]) continue;
            const p = toDesign(x, y);
            if (Math.hypot(p.x - dx, p.y - dy) <= r) {
              land[i] = 0;
              waterKind[i] = kind;
            }
          }
        }
      }
    }
  };

  // 城門河：城門水塘 → 沙田 → 吐露港
  carveRiver(
    [
      [47, 13],
      [49, 16],
      [52, 18.5],
      [55, 21],
      [58, 22.5],
      [60, 23.5],
      [62, 24],
    ],
    0.95,
    WATER_RIVER,
  );
  // 錦田河（元朗平原）
  carveRiver(
    [
      [10, 20],
      [13, 24],
      [16, 28],
      [18, 32],
    ],
    0.7,
    WATER_RIVER,
  );
  // 林村河（大埔）
  carveRiver(
    [
      [66, 9],
      [69, 12],
      [72, 15],
      [76, 18],
    ],
    0.7,
    WATER_RIVER,
  );
  // 東涌河
  carveRiver(
    [
      [22, 45],
      [21, 48],
      [20, 50],
    ],
    0.6,
    WATER_RIVER,
  );
  // 大澳河（大嶼山）
  carveRiver(
    [
      [3, 52],
      [5, 53],
      [7, 55],
    ],
    0.6,
    WATER_RIVER,
  );
  // 深圳河已於北面邊界生成；后海灣內再加一條小水道連接米埔
  carveRiver(
    [
      [9, 5],
      [9, 9],
      [10, 12],
    ],
    0.6,
    WATER_RIVER,
  );

  // 濕地魚塘（米埔一帶的小水塘）
  for (const pond of [
    { x: 7, y: 8, r: 1.2 },
    { x: 10, y: 11, r: 1.0 },
    { x: 13, y: 8, r: 1.1 },
    { x: 7, y: 14, r: 1.0 },
    { x: 14, y: 13, r: 0.9 },
    { x: 4, y: 51, r: 0.9 },
    { x: 41, y: 8, r: 0.9 },
  ]) {
    carveEllipse(pond.x, pond.y, pond.r, pond.r * 0.85, WATER_POND, 0.35);
  }

  // 海岸線小島／礁石點綴（在維港與南部海域加一些細小島嶼）
  for (let k = 0; k < 14; k++) {
    const ax = 20 + rng() * 60;
    const ay = 48 + rng() * 20;
    const { x: tx, y: ty } = toTile(ax, ay);
    const i = idx(tx, ty);
    if (land[i]) continue;
    // 只在維港／海域中加小礁石島
    if (waterKind[i] !== WATER_HARBOUR && waterKind[i] !== WATER_SEA) continue;
    const rw = rng() < 0.3 ? 1 : 0;
    for (let dy = -rw; dy <= rw; dy++) {
      for (let dx = -rw; dx <= rw; dx++) {
        if (dx !== 0 || dy !== 0) continue;
        land[idx(tx + dx, ty + dy)] = 0; // 保持水域（礁石由渲染處理）
      }
    }
  }

  // ───────────── 4.5 海岸線平滑 ─────────────
  // 以多數濾波清理海／港口的 1 格寬鋸齒（只作用於 sea/harbour，不動河流、水塘），
  // 令海岸線更自然，亦減少渲染時逐格海崖碎片。
  {
    for (let pass = 0; pass < 2; pass++) {
      const snapshot = land.slice();
      const kindSnapshot = waterKind.slice();
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = idx(x, y);
          let landN = 0;
          let seaN = 0;
          let otherN = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const ni = idx(x + dx, y + dy);
              if (snapshot[ni]) landN++;
              else if (kindSnapshot[ni] === WATER_SEA || kindSnapshot[ni] === WATER_HARBOUR) seaN++;
              else otherN++;
            }
          }
          if (otherN > 0) continue; // 鄰近河流／水塘時不動
          if (snapshot[i]) {
            // 陸地：被海水包圍 ≥6 格的窄尖/碎地 → 變回海
            if (seaN >= 6) {
              land[i] = 0;
              waterKind[i] = WATER_SEA;
            }
          } else if (kindSnapshot[i] === WATER_SEA || kindSnapshot[i] === WATER_HARBOUR) {
            // 海水：被陸地包圍 ≥6 格的窄水口 → 填成陸地
            if (landN >= 6) {
              land[i] = 1;
              waterKind[i] = 0;
            }
          }
        }
      }
    }
  }

  // ───────────── 5. 距離場（水深／離水距離） ─────────────

  const waterDepth = new Uint8Array(size).fill(255);
  const distToWater = new Uint8Array(size).fill(255);
  {
    const waterQueue: number[] = [];
    const landQueue: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = idx(x, y);
        let nearWater = false;
        for (let dy = -1; dy <= 1 && !nearWater; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            if (!land[idx(nx, ny)]) {
              nearWater = true;
              break;
            }
          }
        }
        if (!land[i]) {
          if (nearWater || x === 0 || y === 0 || x === width - 1 || y === height - 1) {
            waterDepth[i] = 1;
            waterQueue.push(i);
          }
        } else if (nearWater) {
          distToWater[i] = 1;
          landQueue.push(i);
        }
      }
    }
    // 水深 BFS（水域內）
    for (let head = 0; head < waterQueue.length; head++) {
      const i = waterQueue[head];
      const d = waterDepth[i];
      if (d >= 5) continue;
      const x = i % width;
      const y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = idx(nx, ny);
          if (land[ni] || waterDepth[ni] !== 255) continue;
          waterDepth[ni] = d + 1;
          waterQueue.push(ni);
        }
      }
    }
    // 離水距離 BFS（陸地內，上限 18）
    for (let head = 0; head < landQueue.length; head++) {
      const i = landQueue[head];
      const d = distToWater[i];
      if (d >= 18) continue;
      const x = i % width;
      const y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = idx(nx, ny);
          if (!land[ni] || distToWater[ni] !== 255) continue;
          distToWater[ni] = d + 1;
          landQueue.push(ni);
        }
      }
    }
  }

  // ───────────── 6. 高程場（山峰＋稜線） ─────────────

  const elev = new Float32Array(size);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      const { x: dx, y: dy } = toDesign(x, y);
      let m = 0;
      for (const p of PEAKS) {
        const q = ((dx - p.x) ** 2 + (dy - p.y) ** 2) / (p.r * p.r);
        if (q > 2.6) continue;
        m = Math.max(m, p.h * Math.exp(-q * 1.55));
      }
      for (const rg of RIDGES) {
        const d = segDist(dx, dy, rg.x1, rg.y1, rg.x2, rg.y2) / rg.r;
        if (d > 1.8) continue;
        m = Math.max(m, rg.h * Math.exp(-d * d * 1.35));
      }
      // 山體雜訊，避免圓錐太死板
      m += (ridgeNoise.fbm(dx * 0.075 + 5.1, dy * 0.075 + 2.3, 3) - 0.46) * 0.22;
      m = clamp(m, 0, 1.15);

      if (!land[i]) {
        elev[i] = 0.2 + Math.min(1, (waterDepth[i] === 255 ? 1 : waterDepth[i]) / 6) * 0.06;
      } else {
        const flat = 0.3 + (detailNoise.fbm(dx * 0.21 + 8, dy * 0.21 + 4, 3) - 0.5) * 0.07;
        elev[i] = clamp(flat + m * 0.62, 0.26, 1);
      }
    }
  }

  // ───────────── 7. 城市／填海／農地／林地／濕地遮罩 ─────────────

  const inEllipseZones = (
    dx: number,
    dy: number,
    zones: { x: number; y: number; rx: number; ry: number }[],
    noiseScale: number,
    jitter: number,
  ): boolean => {
    for (const z of zones) {
      const d = ((dx - z.x) / z.rx) ** 2 + ((dy - z.y) / z.ry) ** 2;
      if (d > 1.35) continue;
      const wob = (patchNoise.at(dx * noiseScale + 61, dy * noiseScale + 67) - 0.5) * jitter;
      if (d + wob < 1) return true;
    }
    return false;
  };
  const inRect = (dx: number, dy: number, rect: { x0: number; y0: number; x1: number; y1: number }): boolean =>
    dx >= rect.x0 && dx <= rect.x1 && dy >= rect.y0 && dy <= rect.y1;

  const urban = new Uint8Array(size);
  const reclaimed = new Uint8Array(size);
  const fertile = new Uint8Array(size);
  const wetland = new Uint8Array(size);
  const forestZone = new Uint8Array(size);

  /** 郊野公園內大片林地 */
  const countryPark = new Uint8Array(size);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      const { x: dx, y: dy } = toDesign(x, y);
      if (inEllipseZones(dx, dy, URBAN_ZONES, 0.3, 0.3)) urban[i] = 1;
      if (RECLAIM_RECTS.some((r) => inRect(dx, dy, r))) reclaimed[i] = 1;
      if (inEllipseZones(dx, dy, FERTILE_ZONES, 0.35, 0.45)) fertile[i] = 1;
      if (WETLAND_RECTS.some((r) => inRect(dx, dy, r))) wetland[i] = 1;
      if (inEllipseZones(dx, dy, FOREST_ZONES, 0.22, 0.35)) {
        forestZone[i] = 1;
        countryPark[i] = 1;
      }
    }
  }

  // 濕地：只保留低地（高程較低）部分，山邊自動收窄
  for (let i = 0; i < size; i++) {
    if (!wetland[i]) continue;
    if (!land[i] || elev[i] > 0.42) {
      wetland[i] = 0;
      continue;
    }
    const x = i % width;
    const y = (i - x) / width;
    const { x: dx, y: dy } = toDesign(x, y);
    if (hash2d(x, y, s + 811) > 0.9) wetland[i] = 0;
    if (dy < 4 && dx > 14) wetland[i] = 0;
  }

  // ───────────── 8. 地形分類 ─────────────

  const terrain = new Array<TerrainType>(size).fill('grass');

  const beachOf = (x: number, y: number): boolean => {
    const { x: dx, y: dy } = toDesign(x, y);
    for (const b of BEACHES) {
      if (Math.hypot(dx - b.x, dy - b.y) <= b.r) return true;
    }
    return false;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      const { x: dx, y: dy } = toDesign(x, y);
      if (!land[i]) {
        terrain[i] = 'water';
        continue;
      }
      const e = elev[i];
      const n = hash2d(x, y, s + 1234);

      // 市區／填海／濕地：壓平成低地
      if ((urban[i] || reclaimed[i] || wetland[i]) && e < 0.62) {
        elev[i] = 0.312 + hash2d(x, y, s + 61) * 0.022;
      }

      if (e >= 0.595) {
        // 山地：郊野公園內的岩峰；近山頂亦保留少許林地
        terrain[i] = 'mountain';
        continue;
      }
      if (e >= 0.438) {
        // 山坡：大部分為郊野公園林地，部分丘陵（可建、石礦場首選）
        const forestRoll = n + (countryPark[i] ? 0.25 : 0) + forestNoise.at(dx * 0.18 + 7, dy * 0.18 + 3) * 0.35;
        terrain[i] = forestRoll > 0.78 ? 'hill' : 'forest';
        continue;
      }
      if (distToWater[i] <= 1 && beachOf(x, y) && e < 0.42) {
        terrain[i] = 'sand';
        elev[i] = 0.298 + hash2d(x, y, s + 71) * 0.01;
        continue;
      }
      if (wetland[i]) {
        terrain[i] = 'wetland';
        continue;
      }
      if (reclaimed[i]) {
        // 填海區：市中心填海地帶多為市區，其餘為新填地
        const closeToCore = inEllipseZones(dx, dy, URBAN_ZONES, 0.3, 0.3);
        terrain[i] = closeToCore ? 'urban' : 'reclaimed';
        continue;
      }
      if (urban[i]) {
        terrain[i] = 'urban';
        continue;
      }
      if (fertile[i]) {
        // 少量農地中混入草地，令田塊有邊界
        terrain[i] = n < 0.9 ? 'fertile' : 'grass';
        continue;
      }
      if (forestZone[i] || e > 0.4) {
        terrain[i] = n < 0.42 ? 'forest' : 'grass';
        continue;
      }
      // 平地：鄉郊草地，夾雜零星林地
      terrain[i] = n < 0.06 ? 'forest' : 'grass';
    }
  }

  // 沙灘只保留臨水者
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      if (terrain[i] !== 'sand') continue;
      if (distToWater[i] <= 2) continue;
      terrain[i] = 'grass';
    }
  }

  // 山頂（elevation > 0.83）與山脊保留少量碎石山地
  // 確保每座主要山峰都有 mountain 核心（避免全部變成 forest）
  for (const p of PEAKS) {
    if (p.h < 0.45) continue;
    const { x: cx, y: cy } = toTile(p.x, p.y);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = idx(x, y);
        if (!land[i]) continue;
        if (dx * dx + dy * dy > 4.5) continue;
        terrain[i] = 'mountain';
      }
    }
  }

  // 太平山／大帽山／獅子山等山名地標位置的山體（保證可辨識的山形）
  const ensurePeakAt = (dxIn: number, dyIn: number, radius: number): void => {
    const { x: cx, y: cy } = toTile(dxIn, dyIn);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius + 1) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = idx(x, y);
        if (!land[i]) continue;
        if (terrain[i] === 'water') continue;
        terrain[i] = 'mountain';
        elev[i] = Math.max(elev[i], 0.66);
      }
    }
  };
  ensurePeakAt(34, 8, 2); // 大帽山
  ensurePeakAt(35, 70, 2); // 太平山
  ensurePeakAt(52, 35, 2); // 獅子山
  ensurePeakAt(7, 60, 2); // 鳳凰山
  ensurePeakAt(72, 27, 1); // 馬鞍山
  ensurePeakAt(68, 35, 1); // 飛鵝山

  // ───────────── 9. 可建面積保障 ─────────────

  const area = size;
  const BUILDABLE = new Set<TerrainType>(['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill']);
  const FLAT_BUILDABLE = new Set<TerrainType>(['grass', 'urban', 'reclaimed', 'fertile']);
  const countTerrain = (): { buildable: number; flat: number; water: number; mountain: number } => {
    let buildable = 0;
    let flat = 0;
    let water = 0;
    let mountain = 0;
    for (let i = 0; i < area; i++) {
      const t = terrain[i];
      if (BUILDABLE.has(t)) buildable++;
      if (FLAT_BUILDABLE.has(t)) flat++;
      if (t === 'water') water++;
      if (t === 'mountain') mountain++;
    }
    return { buildable, flat, water, mountain };
  };

  // 先把過多的森林／丘陵轉為草地，確保平地足夠（同時清理少數隨機噪點）
  {
    let stats = countTerrain();
    const flatTarget = Math.floor(area * 0.44);
    let guard = 0;
    while (stats.flat < flatTarget && guard < 400000) {
      guard++;
      const i = Math.floor(rng() * area);
      const t = terrain[i];
      if (t === 'forest' || t === 'hill') {
        // 只把低地／緩坡轉為草地（保留郊野公園的山林）
        if (elev[i] < 0.5 && hash2d(i % width, Math.floor(i / width), s + 919) > 0.35) {
          terrain[i] = 'grass';
          elev[i] = Math.min(elev[i], 0.38);
          if (guard % 512 === 0) stats = countTerrain();
        }
      }
    }
    stats = countTerrain();
    // 可建面積不足 52%：把部分山地邊緣轉為丘陵
    if (stats.buildable < area * 0.52) {
      const needed = Math.ceil(area * 0.54) - stats.buildable;
      let converted = 0;
      for (let k = 0; k < area && converted < needed; k++) {
        const i = (k * 7919 + 104729) % area;
        if (terrain[i] !== 'mountain') continue;
        terrain[i] = 'hill';
        elev[i] = Math.min(elev[i], 0.55);
        converted++;
      }
    }
  }

  // ───────────── 10. 維港兩岸市區補強（用橢圓分區，保持自然海岸線） ─────────────

  const SHORE_URBAN: { x: number; y: number; rx: number; ry: number }[] = [
    { x: 26, y: 62, rx: 4, ry: 2.6 }, // 西環
    { x: 33, y: 61.5, rx: 4, ry: 2.6 }, // 上環
    { x: 41, y: 61.5, rx: 5, ry: 3 }, // 中環
    { x: 47, y: 62, rx: 3.4, ry: 2.6 }, // 金鐘灣仔
    { x: 54, y: 62.5, rx: 3.4, ry: 2.6 }, // 銅鑼灣
    { x: 62, y: 63, rx: 4, ry: 2.8 }, // 北角鰂魚涌
    { x: 69, y: 65, rx: 3.2, ry: 3 }, // 筲箕灣
    { x: 43, y: 47.5, rx: 4.4, ry: 3 }, // 尖沙咀
    { x: 50, y: 47.5, rx: 3.6, ry: 2.6 }, // 紅磡
    { x: 58, y: 46, rx: 4.4, ry: 3 }, // 九龍城
    { x: 66, y: 45.5, rx: 4.4, ry: 3 }, // 觀塘
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      if (terrain[i] === 'water' || terrain[i] === 'mountain' || terrain[i] === 'sand') continue;
      const { x: dx, y: dy } = toDesign(x, y);
      if (inEllipseZones(dx, dy, SHORE_URBAN, 0.35, 0.3)) {
        if (terrain[i] === 'forest' || terrain[i] === 'hill') elev[i] = Math.min(elev[i], 0.37);
        terrain[i] = 'urban';
      }
    }
  }

  // ───────────── 11. spawn 開局街區（平整、可建、非水域） ─────────────

  const spawnDesign = HK_SPAWN_DESIGN;
  const spawnTile = toTile(spawnDesign.x, spawnDesign.y);
  {
    // 以 spawn 為中心約 17×11 的市中心街區，全部平整為 urban/reclaimed；
    // 由海岸（y≈57）開始向南，不會侵入維港水域。形狀以橢圓＋雜訊過渡，避免死板方塊。
    for (let y = spawnTile.y - 4; y <= spawnTile.y + 7; y++) {
      for (let x = spawnTile.x - 8; x <= spawnTile.x + 8; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = idx(x, y);
        const { x: dx, y: dy } = toDesign(x, y);
        const ell =
          ((dx - spawnDesign.x) / 9) ** 2 + ((dy - spawnDesign.y) / 6.2) ** 2;
        if (ell > 1 + (patchNoise.at(dx * 0.5, dy * 0.5) - 0.5) * 0.5) continue;
        land[i] = 1;
        if (waterKind[i]) waterKind[i] = 0;
        const nearWater = dy < spawnDesign.y - 2.2;
        terrain[i] = nearWater || (reclaimed[i] && hash2d(x, y, s + 33) < 0.5) ? 'reclaimed' : 'urban';
        elev[i] = 0.312 + hash2d(x, y, s + 41) * 0.018;
        urban[i] = 1;
      }
    }
    // spawn 核心 7×7：保證全平地
    for (let y = spawnTile.y - 3; y <= spawnTile.y + 3; y++) {
      for (let x = spawnTile.x - 3; x <= spawnTile.x + 3; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = idx(x, y);
        terrain[i] = 'urban';
        elev[i] = 0.312;
        land[i] = 1;
      }
    }
  }

  // ───────────── 12. 預置道路：spawn 小街區 + 三條過海隧道 ─────────────

  const roadTiles = new Set<number>();
  const sidewalkTiles = new Set<number>();
  const addRoad = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = idx(x, y);
    if (!land[i] && !waterKind[i]) return;
    const t = terrain[i];
    // 道路可建在地形可建地與水域（水域＝隧道／跨海）
    if (t === 'mountain') return;
    if (!land[i]) {
      // 只在水域（隧道）上放路
      roadTiles.add(i);
      return;
    }
    if (t === 'sand' || t === 'wetland') {
      // 預置道路不停在沙灘／濕地上（避免奇怪入口）
      return;
    }
    roadTiles.add(i);
  };
  const addSidewalk = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = idx(x, y);
    if (!land[i]) return;
    const t = terrain[i];
    if (t === 'water' || t === 'mountain') return;
    if (roadTiles.has(i)) return;
    sidewalkTiles.add(i);
  };

  if (options.starterRoads !== false) {
    // 起步街道以 spawn 西南面的路口為中心，令 spawn 本身位於街區內的可建平地
    const street = toTile(42, 61);
    const stx = street.x;
    const sty = street.y;
    // 東西向主街（兩條）＋南北向大街：形成可直接起樓的十字街區
    for (let x = Math.max(0, stx - 7); x <= Math.min(width - 1, stx + 5); x++) addRoad(x, sty - 1);
    for (let y = Math.max(0, sty - 4); y <= Math.min(height - 1, sty + 5); y++) addRoad(stx, y);
    for (let x = Math.max(0, stx - 4); x <= Math.min(width - 1, stx + 3); x++) addRoad(x, sty - 4);
    for (let y = Math.max(0, sty - 2); y <= Math.min(height - 1, sty + 3); y++) addRoad(stx + 4, y);

    // 行人路：所有緊貼預置道路、且可建的鄰格
    for (const i of roadTiles) {
      const x = i % width;
      const y = (i - x) / width;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        addSidewalk(x + dx, y + dy);
      }
    }
    // 三條過海隧道：在指定設計 x 找到最長的一段水域，鋪成隧道
    for (const tunnel of HK_TUNNELS) {
      const tx = clamp(Math.round((tunnel.x + 0.5) * sx - 0.5), 1, width - 2);
      // 掃描所有水域連續段，選取中心在維港範圍（設計 y 48~66）者
      let best: { start: number; end: number } | null = null;
      let y = 0;
      while (y < height) {
        const i = idx(tx, y);
        if (!land[i]) {
          const start = y;
          while (y < height && !land[idx(tx, y)]) y++;
          const end = y - 1;
          const midDesignY = ((start + end) / 2 + 0.5) / sy - 0.5;
          if (midDesignY >= 48 && midDesignY <= 66 && end - start + 1 >= 3) {
            if (!best || end - start > best.end - best.start) best = { start, end };
          }
        } else {
          y++;
        }
      }
      if (!best) continue;
      for (let yy = best.start; yy <= best.end; yy++) addRoad(tx, yy);
      // 隧道兩端入口：各鋪 2 格陸上引道，方便玩家接駁道路網
      for (const dir of [-1, 1] as const) {
        const portalY = dir < 0 ? best.start - 1 : best.end + 1;
        for (let k = 0; k < 2; k++) {
          const py = portalY + dir * k;
          if (py < 0 || py >= height) continue;
          const pi = idx(tx, py);
          if (!land[pi]) continue;
          if (terrain[pi] !== 'mountain' && terrain[pi] !== 'sand' && terrain[pi] !== 'wetland') {
            terrain[pi] = 'reclaimed';
            elev[pi] = 0.315;
            addRoad(tx, py);
          }
        }
      }
    }
  }

  // ───────────── 13. 輸出 Tile[] ─────────────

  const tiles: Tile[] = new Array(size);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      let t = terrain[i];
      let e = land[i] ? elev[i] : 0.2 + Math.min(1, (waterDepth[i] === 255 ? 1 : waterDepth[i]) / 6) * 0.06;
      if (t === 'water') e = 0.2 + Math.min(1, (waterDepth[i] === 255 ? 1 : waterDepth[i]) / 6) * 0.06;
      const road = roadTiles.has(i);
      const sidewalk = sidewalkTiles.has(i) && !road;
      if (road && land[i] && t === 'water') t = 'urban';
      tiles[i] = {
        terrain: t,
        elevation: Number(clamp(e, 0.02, 1).toFixed(3)),
        variant: hash2d(x, y, s + 53),
        buildingId: -1,
        road,
        ...(sidewalk ? { sidewalk: true } : {}),
      };
    }
  }

  return { width, height, tiles, spawn: spawnTile };
}

/** 建立一份空白（未遊玩）世界資料，供開新局使用 */
export function createTiles(seed: number): Tile[] {
  return generateWorld(seed).tiles;
}
