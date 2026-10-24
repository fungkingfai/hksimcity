/**
 * 《維港之城》— 全域設定與資料表（Lead 維護）
 *
 * 香港版城市建造模擬的建築資料表、資源、地形、天氣、稅制、交通、姓名表等。
 * 其他 Agent 可讀取，但請勿修改本檔；需要新資料請通知 Lead。
 *
 * 金錢單位：港幣（HK$）。所有 cost／upkeep／income 皆為港幣。
 */

import type {
  BuildingCategory,
  BuildingDef,
  LogKind,
  ResourceKey,
  Season,
  ServiceKind,
  SimContext,
  TransitMode,
  Weather,
  ZoneType,
} from './types';

// ─────────────────────────── 世界常數 ───────────────────────────

export const GAME_VERSION = 5;

/** 香港地圖：480×480 格（由 CSDI／地政總署真實地理數據生成；約舊版 96×96 的 25 倍面積） */
export const GRID_WIDTH = 480;
export const GRID_HEIGHT = 480;
/** 相對 Round 2（96×96）的地圖線性放大倍率；渲染模組用嚟換算霧、天空、相機距離 */
export const MAP_SCALE = GRID_WIDTH / 96;
/** 地圖世界尺寸（格 × TILE_SIZE；TILE_SIZE=2） */
export const WORLD_SPAN = GRID_WIDTH * 2;
/** 每格世界單位 */
export const TILE_SIZE = 2;

/** 1 倍速時：每真實秒推進的遊戲分鐘（1440 / 30 = 48） */
export const GAME_MINUTES_PER_SECOND = 48;
export const DAYS_PER_MONTH = 7;
export const MONTHS_PER_YEAR = 12;
export const MINUTES_PER_DAY = 24 * 60;
/** 顯示年份起點（2026 年開局） */
export const START_YEAR = 2026;

/** 開局庫房（港幣） */
export const START_TREASURY = 8_000_000;
/** 預設稅率 */
export const DEFAULT_SALARY_TAX_RATE = 0.15;
export const DEFAULT_PROFIT_TAX_RATE = 0.165;
export const DEFAULT_RATES_RATE = 0.05;

/** 節慶：維港煙花匯演 */
export const FESTIVAL_COST = 800_000;
export const FESTIVAL_COOLDOWN_DAYS = 20;
/** 賣地：每次拍賣一幅土地 */
export const LAND_SALE_AMOUNT = 2_500_000;
export const LAND_SALE_COOLDOWN_DAYS = 15;

/** 道路／行人路造價（每格） */
export const ROAD_COST = 15_000;
export const SIDEWALK_COST = 5_000;
export const ROAD_UPKEEP = 0;
export const DEMOLISH_REFUND_RATE = 0.3;

/** 薪金（每月，港幣）：受僱市民的基準月薪 */
export const BASE_MONTHLY_SALARY = 18_000;
/** 每人每月基本生活開支（港幣；用於市民儲蓄與消費） */
export const BASE_LIVING_COST = 6_000;

/** 物流卡車容量 */
export const TRUCK_CAPACITY = 60;

export const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

// ─────────────────────────── 時間／季節 ───────────────────────────

export const SEASON_ORDER: Season[] = ['spring', 'summer', 'autumn', 'winter'];

export const SEASON_INFO: Record<Season, { name: string; color: string; emoji: string; months: string }> = {
  spring: { name: '春', color: '#8fbf6f', emoji: '🌱', months: '3–5月' },
  summer: { name: '夏', color: '#f0a33a', emoji: '☀', months: '6–8月' },
  autumn: { name: '秋', color: '#c97a4a', emoji: '🍂', months: '9–11月' },
  winter: { name: '冬', color: '#9fb6c9', emoji: '❄', months: '12–2月' },
};

/** 香港季節：3–5 春、6–8 夏、9–11 秋、12–2 冬 */
export function seasonOfMonth(month: number): Season {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

/** 各季基礎氣溫（攝氏，香港） */
export const SEASON_TEMP: Record<Season, number> = {
  spring: 23,
  summer: 30,
  autumn: 25,
  winter: 16,
};

/** 季節對產業的整體產量倍率（建築另有 weatherBonus） */
export const SEASON_FARM_BONUS: Record<Season, number> = {
  spring: 1.15,
  summer: 1.0,
  autumn: 1.2,
  winter: 0.7,
};

export const WEATHER_INFO: Record<
  Weather,
  { name: string; emoji: string; color: string; hint: string }
> = {
  clear: { name: '晴', emoji: '☀', color: '#f5c96a', hint: '陽光普照，適合外出與工程' },
  cloudy: { name: '陰', emoji: '☁', color: '#9aa7b5', hint: '多雲有薄霧，市面如常' },
  rain: { name: '雨', emoji: '🌧', color: '#6f95b8', hint: '下雨路滑，行人與車輛慢行' },
  storm: { name: '颱風', emoji: '🌀', color: '#8f6fc9', hint: '八號風球！渡輪停航、地盤停工' },
  fog: { name: '霧', emoji: '🌫', color: '#b9c4cc', hint: '大霧鎖港，航班延誤、能見度低' },
  snow: { name: '雪', emoji: '❄', color: '#d9e6f2', hint: '寒潮襲港，大帽山結霜，市民避寒' },
};

/** 各季天氣轉移權重（香港氣候） */
export const WEATHER_WEIGHTS: Record<Season, Record<Weather, number>> = {
  spring: { clear: 18, cloudy: 27, rain: 30, storm: 5, fog: 20, snow: 0 },
  summer: { clear: 30, cloudy: 18, rain: 30, storm: 20, fog: 2, snow: 0 },
  autumn: { clear: 52, cloudy: 25, rain: 12, storm: 5, fog: 6, snow: 0 },
  winter: { clear: 38, cloudy: 32, rain: 12, storm: 0, fog: 10, snow: 8 },
};

/** 天氣對產量、移動、幸福、交通的影響 */
export const WEATHER_EFFECT: Record<
  Weather,
  { farm: number; move: number; happiness: number; transit: number; powerDemand: number }
> = {
  clear: { farm: 1.05, move: 1, happiness: 2, transit: 1, powerDemand: 1.0 },
  cloudy: { farm: 1, move: 1, happiness: 0, transit: 1, powerDemand: 1.02 },
  rain: { farm: 1.2, move: 0.8, happiness: -1, transit: 0.9, powerDemand: 1.05 },
  storm: { farm: 0.2, move: 0.35, happiness: -8, transit: 0.35, powerDemand: 1.18 },
  fog: { farm: 1, move: 0.7, happiness: -2, transit: 0.75, powerDemand: 1.03 },
  snow: { farm: 0.4, move: 0.5, happiness: -6, transit: 0.5, powerDemand: 1.12 },
};

/** 颱風信號（風球） */
export const TYPHOON_SIGNALS = [1, 3, 8] as const;

// ─────────────────────────── 資源 ───────────────────────────

export interface ResourceDef {
  key: ResourceKey;
  name: string;
  short: string;
  color: string;
  /** 參考市價（港幣／單位） */
  price: number;
  /** 是否為民生消費品（市民會購買） */
  consumer: boolean;
}

export const RESOURCES: Record<ResourceKey, ResourceDef> = {
  food: { key: 'food', name: '食品', short: '食', color: '#e0a84f', price: 40, consumer: true },
  goods: { key: 'goods', name: '日用品', short: '日', color: '#5fa8c9', price: 120, consumer: true },
  electronics: {
    key: 'electronics',
    name: '電子產品',
    short: '電',
    color: '#c76bd1',
    price: 900,
    consumer: true,
  },
  materials: { key: 'materials', name: '建材', short: '材', color: '#9a9a92', price: 60, consumer: false },
};

export const RESOURCE_KEYS = Object.keys(RESOURCES) as ResourceKey[];

/** 批發價（物流）與零售價（市民消費）倍率 */
export const RETAIL_PRICE_MULTIPLIER: Record<ResourceKey, number> = {
  food: 1.5,
  goods: 2.0,
  electronics: 2.4,
  materials: 1.2,
};

// ─────────────────────────── 地形 ───────────────────────────

export interface TerrainDef {
  key: string;
  name: string;
  color: number;
  buildable: boolean;
  /** 建造費倍率（地形難度） */
  costMultiplier: number;
  /** 說明 */
  note: string;
}

export const TERRAIN_INFO: Record<string, TerrainDef> = {
  grass: { key: 'grass', name: '平地', color: 0x7fa86a, buildable: true, costMultiplier: 1, note: '新界鄉郊平地，一般建築皆可' },
  urban: { key: 'urban', name: '市區地', color: 0x9a9a8e, buildable: true, costMultiplier: 1, note: '已發展市區，舊區重建地' },
  reclaimed: { key: 'reclaimed', name: '填海地', color: 0x8f9a86, buildable: true, costMultiplier: 1.15, note: '填海新地，需打樁，造價較高' },
  fertile: { key: 'fertile', name: '農地', color: 0x9db85e, buildable: true, costMultiplier: 1, note: '農田首選，產量 +30%' },
  wetland: { key: 'wetland', name: '濕地', color: 0x6b8a72, buildable: false, costMultiplier: 0, note: '米埔濕地，不可建造' },
  forest: { key: 'forest', name: '林地', color: 0x4f7a4a, buildable: true, costMultiplier: 1.25, note: '需先清林，造價較高' },
  hill: { key: 'hill', name: '丘陵', color: 0x8c8a63, buildable: true, costMultiplier: 1.2, note: '山地建築，石礦場首選' },
  mountain: { key: 'mountain', name: '山地', color: 0x6d6a63, buildable: false, costMultiplier: 0, note: '不可建造（太平山／獅子山／大帽山）' },
  water: { key: 'water', name: '水域', color: 0x2f6f8f, buildable: false, costMultiplier: 0, note: '維港／河／水塘，可建渡輪碼頭' },
  sand: { key: 'sand', name: '沙灘', color: 0xc9b98c, buildable: false, costMultiplier: 0, note: '泳灘，不可建造' },
};

// ─────────────────────────── 建築資料表 ───────────────────────────

const B = (def: BuildingDef): BuildingDef => def;

export const BUILDINGS: Record<string, BuildingDef> = {
  // ── 住宅 ──────────────────────────────────────────────────
  tongLau: B({
    key: 'tongLau',
    name: '唐樓',
    desc: '戰後舊樓，一梯兩伙，樓下多為商舖。可容納 12 人，是香港城市發展的起點。',
    category: 'residential',
    size: [1, 1],
    cost: 180_000,
    upkeep: 800,
    workers: 0,
    housing: 12,
    unlockPop: 0,
    color: 0xb08d6a,
    needsRoad: true,
    interior: 'tongLau',
    zone: 'residential',
    weight: 4,
    minDevScore: 10,
  }),
  subdividedFlat: B({
    key: 'subdividedFlat',
    name: '劏房',
    desc: '單位分間成多間板間房，可容納 6 人。租金低廉，但居住環境擠迫。',
    category: 'residential',
    size: [1, 1],
    cost: 90_000,
    upkeep: 400,
    workers: 0,
    housing: 6,
    unlockPop: 0,
    color: 0x8d7a63,
    needsRoad: true,
    interior: 'subdividedFlat',
    zone: 'residential',
    weight: 3,
    minDevScore: 0,
  }),
  publicHousing: B({
    key: 'publicHousing',
    name: '公共屋邨',
    desc: '房委會公屋大廈，一層十多伙，可容納 60 人。輪候冊家庭的家。',
    category: 'residential',
    size: [2, 2],
    cost: 900_000,
    upkeep: 6_000,
    workers: 0,
    housing: 60,
    unlockPop: 90,
    color: 0xd9c9a8,
    needsRoad: true,
    interior: 'publicHousing',
    zone: 'residential',
    weight: 3,
    minDevScore: 30,
  }),
  hOSFlat: B({
    key: 'hOSFlat',
    name: '居屋苑',
    desc: '居者有其屋計劃屋苑，可容納 48 人。中產家庭上車之選。',
    category: 'residential',
    size: [2, 2],
    cost: 1_200_000,
    upkeep: 8_000,
    workers: 0,
    housing: 48,
    unlockPop: 220,
    color: 0xe4d6c0,
    needsRoad: true,
    interior: 'hOSFlat',
    zone: 'residential',
    weight: 2,
    minDevScore: 50,
  }),
  privateEstate: B({
    key: 'privateEstate',
    name: '私人屋苑',
    desc: '私人發展商屋苑，設會所與平台花園，可容納 80 人。',
    category: 'residential',
    size: [2, 2],
    cost: 2_400_000,
    upkeep: 16_000,
    workers: 0,
    housing: 80,
    unlockPop: 400,
    color: 0xb9c7d6,
    needsRoad: true,
    interior: 'privateEstate',
    zone: 'residential',
    weight: 2,
    minDevScore: 65,
  }),
  luxuryTower: B({
    key: 'luxuryTower',
    name: '豪宅',
    desc: '半山／南區豪宅，可容納 40 人。住戶消費力強，帶來可觀稅收。',
    category: 'residential',
    size: [2, 2],
    cost: 4_000_000,
    upkeep: 30_000,
    workers: 0,
    housing: 40,
    unlockPop: 800,
    color: 0xcfd8e3,
    needsRoad: true,
    interior: 'luxuryTower',
    zone: 'residential',
    weight: 1,
    minDevScore: 85,
  }),

  // ── 工業 ──────────────────────────────────────────────────
  farm: B({
    key: 'farm',
    name: '農田',
    desc: '新界農田，種植蔬菜稻米，供應全港食品。建於農地產量更高。',
    category: 'industrial',
    size: [2, 2],
    cost: 150_000,
    upkeep: 1_500,
    workers: 4,
    housing: 0,
    unlockPop: 0,
    color: 0x8fbf5f,
    needsRoad: false,
    interior: 'farm',
    production: {
      output: 'food',
      amountPerDay: 24,
      allowedTerrain: ['fertile', 'grass'],
      seasonBonus: { spring: 1.2, summer: 1.1, autumn: 1.25, winter: 0.7 },
      weatherBonus: { rain: 1.2, storm: 0.2, fog: 0.9 },
    },
    zone: 'farmland',
    weight: 1,
    minDevScore: 0,
  }),
  quarry: B({
    key: 'quarry',
    name: '石礦場',
    desc: '在丘陵開採石料，供應建材。需建於丘陵。',
    category: 'industrial',
    size: [2, 2],
    cost: 600_000,
    upkeep: 6_000,
    workers: 6,
    housing: 0,
    unlockPop: 30,
    color: 0x9a9a92,
    needsRoad: true,
    interior: 'quarry',
    production: {
      output: 'materials',
      amountPerDay: 12,
      allowedTerrain: ['hill', 'grass', 'urban'],
      weatherBonus: { storm: 0.2, rain: 0.8 },
    },
    zone: 'industrial',
    weight: 1,
    minDevScore: 30,
  }),
  industrialBuilding: B({
    key: 'industrialBuilding',
    name: '工廈',
    desc: '多層工業大廈，以建材裝配電子產品，是本地產業的支柱。',
    category: 'industrial',
    size: [2, 2],
    cost: 1_100_000,
    upkeep: 10_000,
    workers: 14,
    housing: 0,
    unlockPop: 70,
    color: 0x8b95a3,
    needsRoad: true,
    interior: 'industrialBuilding',
    production: {
      output: 'electronics',
      amountPerDay: 6,
      input: { resource: 'materials', amountPerDay: 5 },
      weatherBonus: { storm: 0.3 },
    },
    zone: 'industrial',
    weight: 3,
    minDevScore: 35,
  }),
  foodFactory: B({
    key: 'foodFactory',
    name: '食品廠',
    desc: '入口食材加工成包裝食品，供應全港街市與超市。',
    category: 'industrial',
    size: [2, 2],
    cost: 900_000,
    upkeep: 8_000,
    workers: 10,
    housing: 0,
    unlockPop: 90,
    color: 0xc9a45c,
    needsRoad: true,
    interior: 'foodFactory',
    production: {
      output: 'food',
      amountPerDay: 16,
      input: { resource: 'goods', amountPerDay: 3 },
      weatherBonus: { storm: 0.3 },
    },
    zone: 'industrial',
    weight: 2,
    minDevScore: 20,
  }),
  powerPlant: B({
    key: 'powerPlant',
    name: '發電廠',
    desc: '為全城供電。發電廠方圓 22 格內的建築有穩定電力；人口超出容量會停電。',
    category: 'industrial',
    size: [3, 3],
    cost: 5_000_000,
    upkeep: 50_000,
    workers: 20,
    housing: 0,
    unlockPop: 180,
    color: 0x5f6b78,
    needsRoad: true,
    interior: 'powerPlant',
    utility: { kind: 'power', radius: 22, capacity: 1600 },
    ploppable: true,
  }),
  waterworks: B({
    key: 'waterworks',
    name: '水務設施',
    desc: '濾水廠與配水庫，為方圓 18 格提供食水。人口超出容量會缺水。',
    category: 'industrial',
    size: [2, 2],
    cost: 2_600_000,
    upkeep: 22_000,
    workers: 8,
    housing: 0,
    unlockPop: 90,
    color: 0x6f9aa6,
    needsRoad: true,
    interior: 'waterworks',
    utility: { kind: 'water', radius: 18, capacity: 2000 },
    ploppable: true,
  }),

  // ── 物流 ──────────────────────────────────────────────────
  importFirm: B({
    key: 'importFirm',
    name: '進口商行',
    desc: '向內地及海外入貨的批發商行，每日進口日用品，供應街市與便利店。',
    category: 'logistics',
    size: [2, 2],
    cost: 240_000,
    upkeep: 2_500,
    workers: 5,
    housing: 0,
    unlockPop: 0,
    color: 0x5f8faf,
    needsRoad: true,
    interior: 'importFirm',
    production: {
      output: 'goods',
      amountPerDay: 10,
      weatherBonus: { storm: 0.1, rain: 0.85 },
    },
    zone: 'industrial',
    weight: 2,
    minDevScore: 5,
  }),
  containerPort: B({
    key: 'containerPort',
    name: '貨櫃碼頭',
    desc: '葵涌貨櫃碼頭：每日進口日用品並出口本地電子產品。需臨水而建。',
    category: 'logistics',
    size: [4, 3],
    cost: 8_000_000,
    upkeep: 80_000,
    workers: 30,
    housing: 0,
    unlockPop: 300,
    color: 0x64829a,
    needsWater: true,
    needsRoad: true,
    interior: 'containerPort',
    production: {
      output: 'goods',
      amountPerDay: 45,
      weatherBonus: { storm: 0.1, rain: 0.85 },
    },
    ploppable: true,
  }),
  warehouse: B({
    key: 'warehouse',
    name: '貨倉',
    desc: '儲存食品、日用品、電子產品與建材，容量 600。物流的樞紐。',
    category: 'logistics',
    size: [2, 2],
    cost: 500_000,
    upkeep: 4_000,
    workers: 6,
    housing: 0,
    unlockPop: 30,
    color: 0x9b8563,
    needsRoad: true,
    interior: 'warehouse',
    storage: { capacity: 600, accepted: 'all' },
    zone: 'industrial',
    weight: 3,
    minDevScore: 0,
  }),

  // ── 商業 ──────────────────────────────────────────────────
  chaChaanTeng: B({
    key: 'chaChaanTeng',
    name: '茶餐廳',
    desc: '港式茶餐廳，賣奶茶菠蘿油。消耗食品，帶來收入與街坊幸福。',
    category: 'commercial',
    size: [1, 1],
    cost: 220_000,
    upkeep: 2_000,
    workers: 6,
    housing: 0,
    unlockPop: 20,
    color: 0xc96b4a,
    needsRoad: true,
    interior: 'chaChaanTeng',
    service: {
      kind: 'restaurant',
      radius: 6,
      consumes: { resource: 'food', amountPerDay: 2 },
      happiness: 5,
      incomePerDay: 2_500,
    },
    zone: 'commercial',
    weight: 3,
    minDevScore: 5,
  }),
  convenienceStore: B({
    key: 'convenienceStore',
    name: '便利店',
    desc: '24 小時便利店，向周邊居民供應食品與日用品。',
    category: 'commercial',
    size: [1, 1],
    cost: 160_000,
    upkeep: 1_500,
    workers: 3,
    housing: 0,
    unlockPop: 10,
    color: 0x4fa3c9,
    needsRoad: true,
    interior: 'convenienceStore',
    storage: { capacity: 120, accepted: ['food', 'goods'] },
    service: { kind: 'market', radius: 4, incomePerDay: 900 },
    zone: 'commercial',
    weight: 3,
    minDevScore: 0,
  }),
  wetMarket: B({
    key: 'wetMarket',
    name: '街市',
    desc: '傳統濕貨街市，菜檔肉檔魚檔林立，供應周邊民居食品與日用品。',
    category: 'commercial',
    size: [2, 2],
    cost: 450_000,
    upkeep: 5_000,
    workers: 10,
    housing: 0,
    unlockPop: 40,
    color: 0xcf9a6a,
    needsRoad: true,
    interior: 'wetMarket',
    storage: { capacity: 300, accepted: ['food', 'goods'] },
    service: { kind: 'market', radius: 9, incomePerDay: 2_200 },
    zone: 'commercial',
    weight: 2,
    minDevScore: 20,
  }),
  supermarket: B({
    key: 'supermarket',
    name: '超市',
    desc: '連鎖超級市場，貨品齊全，服務半徑大，收入穩定。',
    category: 'commercial',
    size: [2, 2],
    cost: 1_000_000,
    upkeep: 10_000,
    workers: 12,
    housing: 0,
    unlockPop: 150,
    color: 0x3f8f6a,
    needsRoad: true,
    interior: 'supermarket',
    storage: { capacity: 500, accepted: 'all' },
    service: { kind: 'market', radius: 12, incomePerDay: 5_000 },
    zone: 'commercial',
    weight: 2,
    minDevScore: 35,
  }),
  shoppingMall: B({
    key: 'shoppingMall',
    name: '商場',
    desc: '大型購物商場，雲集名店食肆，帶來可觀零售收入與利得稅。',
    category: 'commercial',
    size: [3, 2],
    cost: 3_200_000,
    upkeep: 30_000,
    workers: 25,
    housing: 0,
    unlockPop: 350,
    color: 0x9a5fb0,
    needsRoad: true,
    interior: 'shoppingMall',
    storage: { capacity: 700, accepted: 'all' },
    service: {
      kind: 'market',
      radius: 16,
      incomePerDay: 14_000,
      happiness: 4,
      taxBonus: 0.1,
    },
    zone: 'commercial',
    weight: 1,
    minDevScore: 70,
  }),
  restaurant: B({
    key: 'restaurant',
    name: '酒樓',
    desc: '中式酒樓，一家大小飲茶食飯。消耗食品，收入與幸福俱佳。',
    category: 'commercial',
    size: [2, 2],
    cost: 1_600_000,
    upkeep: 15_000,
    workers: 20,
    housing: 0,
    unlockPop: 300,
    color: 0xb0453c,
    needsRoad: true,
    interior: 'restaurant',
    service: {
      kind: 'restaurant',
      radius: 10,
      consumes: { resource: 'food', amountPerDay: 5 },
      happiness: 8,
      incomePerDay: 9_000,
    },
    zone: 'commercial',
    weight: 2,
    minDevScore: 50,
  }),
  officeTower: B({
    key: 'officeTower',
    name: '商廈',
    desc: '甲級寫字樓，提供大量白領職位，帶動利得稅收。',
    category: 'commercial',
    size: [2, 2],
    cost: 1_800_000,
    upkeep: 20_000,
    workers: 40,
    housing: 0,
    unlockPop: 160,
    color: 0x8fa6c0,
    needsRoad: true,
    interior: 'officeTower',
    service: { kind: 'office', radius: 1, taxBonus: 0.15 },
    zone: 'commercial',
    weight: 2,
    minDevScore: 55,
  }),

  // ── 公共設施 ──────────────────────────────────────────────
  school: B({
    key: 'school',
    name: '學校',
    desc: '中小學，為社區提供教育，提升周邊幸福度與文化。',
    category: 'civic',
    size: [2, 2],
    cost: 1_600_000,
    upkeep: 14_000,
    workers: 18,
    housing: 0,
    unlockPop: 100,
    color: 0x6f9a5f,
    needsRoad: true,
    interior: 'school',
    service: { kind: 'school', radius: 10, happiness: 6, capacity: 400 },
    ploppable: true,
  }),
  hospital: B({
    key: 'hospital',
    name: '醫院',
    desc: '公立醫院，24 小時急症室，消耗日用品，大幅提升市民健康與幸福。',
    category: 'civic',
    size: [3, 2],
    cost: 4_500_000,
    upkeep: 45_000,
    workers: 40,
    housing: 0,
    unlockPop: 220,
    color: 0xdfe6ec,
    needsRoad: true,
    interior: 'hospital',
    service: {
      kind: 'hospital',
      radius: 16,
      consumes: { resource: 'goods', amountPerDay: 2 },
      happiness: 8,
      capacity: 500,
    },
    ploppable: true,
  }),
  policeStation: B({
    key: 'policeStation',
    name: '警署',
    desc: '維持治安，提升周邊幸福度與稅收效率。',
    category: 'civic',
    size: [2, 2],
    cost: 1_800_000,
    upkeep: 18_000,
    workers: 15,
    housing: 0,
    unlockPop: 120,
    color: 0x3f5f9f,
    needsRoad: true,
    interior: 'policeStation',
    service: { kind: 'police', radius: 12, happiness: 4, taxBonus: 0.05, capacity: 300 },
    ploppable: true,
  }),
  fireStation: B({
    key: 'fireStation',
    name: '消防局',
    desc: '消防及救護服務，火警與颱風時守護市民。',
    category: 'civic',
    size: [2, 2],
    cost: 1_700_000,
    upkeep: 16_000,
    workers: 14,
    housing: 0,
    unlockPop: 120,
    color: 0xb0443f,
    needsRoad: true,
    interior: 'fireStation',
    service: { kind: 'fire', radius: 12, happiness: 3, capacity: 300 },
    ploppable: true,
  }),

  // ── 交通 ──────────────────────────────────────────────────
  mtrStation: B({
    key: 'mtrStation',
    name: '港鐵站',
    desc: '港鐵車站，上班族的主要通勤方式。方圓 14 格居民可快速通勤並帶來車費收入。',
    category: 'transport',
    size: [2, 2],
    cost: 4_000_000,
    upkeep: 40_000,
    workers: 15,
    housing: 0,
    unlockPop: 180,
    color: 0xb02a2a,
    needsRoad: true,
    interior: 'mtrStation',
    transit: { mode: 'mtr', radius: 14, capacity: 900, fare: 8 },
    ploppable: true,
  }),
  busTerminus: B({
    key: 'busTerminus',
    name: '巴士總站',
    desc: '專營巴士總站，多條路線由此開出，服務半徑內居民可搭巴士通勤。',
    category: 'transport',
    size: [2, 2],
    cost: 1_300_000,
    upkeep: 12_000,
    workers: 10,
    housing: 0,
    unlockPop: 80,
    color: 0xd9b23f,
    needsRoad: true,
    interior: 'busTerminus',
    transit: { mode: 'bus', radius: 10, capacity: 500, fare: 5 },
    ploppable: true,
  }),
  tramStop: B({
    key: 'tramStop',
    name: '電車站',
    desc: '港島電車站，叮叮慢行，票價便宜，深受街坊歡迎。',
    category: 'transport',
    size: [1, 1],
    cost: 450_000,
    upkeep: 4_000,
    workers: 2,
    housing: 0,
    unlockPop: 40,
    color: 0x2f8f5f,
    needsRoad: true,
    interior: 'tramStop',
    transit: { mode: 'tram', radius: 6, capacity: 300, fare: 3 },
    ploppable: true,
  }),
  ferryPier: B({
    key: 'ferryPier',
    name: '渡輪碼頭',
    desc: '天星小輪碼頭，來往維港兩岸與離島。需臨水而建，颱風時停航。',
    category: 'transport',
    size: [3, 2],
    cost: 1_200_000,
    upkeep: 11_000,
    workers: 8,
    housing: 0,
    unlockPop: 150,
    color: 0x2f7f6a,
    needsWater: true,
    needsRoad: true,
    interior: 'ferryPier',
    transit: { mode: 'ferry', radius: 12, capacity: 400, fare: 4 },
    ploppable: true,
  }),

  // ── 休憩／裝飾 ────────────────────────────────────────────
  park: B({
    key: 'park',
    name: '公園',
    desc: '社區公園，綠樹成蔭，提升周邊幸福度。',
    category: 'decoration',
    size: [2, 2],
    cost: 350_000,
    upkeep: 3_000,
    workers: 2,
    housing: 0,
    unlockPop: 0,
    color: 0x5f9a5a,
    needsRoad: false,
    interior: 'park',
    service: { kind: 'park', radius: 7, happiness: 5 },
    ploppable: true,
  }),
  promenade: B({
    key: 'promenade',
    name: '海濱長廊',
    desc: '維港海濱長廊，跑步散步好去處。提升周邊幸福度。',
    category: 'decoration',
    size: [1, 1],
    cost: 180_000,
    upkeep: 1_000,
    workers: 0,
    housing: 0,
    unlockPop: 0,
    color: 0x4f9a9a,
    needsRoad: false,
    needsWater: true,
    interior: 'promenade',
    service: { kind: 'promenade', radius: 5, happiness: 4 },
    ploppable: true,
  }),
};

export const BUILDING_LIST = Object.values(BUILDINGS);

export const CATEGORY_INFO: Record<BuildingCategory, { name: string; order: number; color: string }> = {
  residential: { name: '住宅', order: 1, color: '#e8b04a' },
  commercial: { name: '商業', order: 2, color: '#e060a0' },
  industrial: { name: '工業', order: 3, color: '#7a8fa6' },
  logistics: { name: '物流', order: 4, color: '#5fb0c9' },
  civic: { name: '公共', order: 5, color: '#6fcf8f' },
  transport: { name: '交通', order: 6, color: '#e2492f' },
  decoration: { name: '休憩', order: 7, color: '#8fcf6f' },
};

// ─────────────────────────── 分區（Zoning） ───────────────────────────

/**
 * 分區玩法：玩家只劃分住宅／商業／工業／農業區並連接道路，
 * 開發商按需求與環境自動興建對應建築。以下為分區資料表。
 */
export interface ZoneDef {
  key: ZoneType;
  name: string;
  short: string;
  desc: string;
  /** 分區色塊顏色（十六進位數字，供 three.js） */
  color: number;
  /** CSS 顏色（UI 用） */
  colorHex: string;
  /** 每格劃區費用（港幣） */
  costPerTile: number;
  /** 解鎖所需人口 */
  unlockPop: number;
  /** 說明 */
  hint: string;
}

export const ZONES: Record<ZoneType, ZoneDef> = {
  residential: {
    key: 'residential',
    name: '住宅區',
    short: '住',
    desc: '劃分住宅用地，開發商按需求興建劏房、唐樓、公屋、居屋、私人屋苑與豪宅。',
    color: 0x35d07f,
    colorHex: '#35d07f',
    costPerTile: 1_200,
    unlockPop: 0,
    hint: '住宅需求高、鄰近交通與公共設施、環境好時會興建更高級住宅。',
  },
  commercial: {
    key: 'commercial',
    name: '商業區',
    short: '商',
    desc: '劃分商業用地，自動興建便利店、茶餐廳、街市、超市、酒樓、商場與商廈。',
    color: 0x2fb7ff,
    colorHex: '#2fb7ff',
    costPerTile: 1_500,
    unlockPop: 0,
    hint: '人口愈多、市民購物需求愈大，商業需求愈高；靠近住宅與道路更易發展。',
  },
  industrial: {
    key: 'industrial',
    name: '工業區',
    short: '工',
    desc: '劃分工業用地，自動興建貨倉、進口商行、食品廠、工廈與石礦場。',
    color: 0xffb02e,
    colorHex: '#ffb02e',
    costPerTile: 1_500,
    unlockPop: 0,
    hint: '提供職位與貨物；貨倉與進口商行支撐物流，石礦場只可建於丘陵。',
  },
  farmland: {
    key: 'farmland',
    name: '農業區',
    short: '農',
    desc: '劃分農業用地（只可劃在農地／平地），自動興建農田供應食品。',
    color: 0x9bd44a,
    colorHex: '#9bd44a',
    costPerTile: 700,
    unlockPop: 0,
    hint: '食品需求高的時候，農業需求會上升；農田受季節與天氣影響產量。',
  },
};

export const ZONE_ORDER: ZoneType[] = ['residential', 'commercial', 'industrial', 'farmland'];

/** 刪除分區工具（分區工具：'zone:<ZoneType>'、拆除道路／建築：'demolish'、取消分區：'dezone'） */
export const ZONE_TOOL_PREFIX = 'zone:';

export function zoneTool(zone: ZoneType): string {
  return `${ZONE_TOOL_PREFIX}${zone}`;
}

export function zoneOfTool(tool: string | null): ZoneType | null {
  if (!tool || !tool.startsWith(ZONE_TOOL_PREFIX)) return null;
  const key = tool.slice(ZONE_TOOL_PREFIX.length) as ZoneType;
  return key in ZONES ? key : null;
}

/** 自動開發參數（sim/zoning.ts 使用；數值可平衡調整） */
export const AUTO_DEVELOP = {
  /** 每 N 遊戲日檢討一次需求／開發 */
  intervalDays: 1,
  /** 每區每日最多新增建築（304 大地圖為 96 地圖 10 倍面積，開發速率同步放大） */
  maxBuildingsPerZonePerDay: 6,
  /** 每日全城最多新增建築 */
  maxBuildingsPerDay: 15,
  /** 需求高於此值才會開發 */
  minDemand: 0.12,
  /** 需求低於此值持續多日 → 視為供過於求（暫不開發） */
  overSupplyDemand: -0.35,
  /** 建築連續多少日無道路連接 → 自動清拆 */
  abandonDays: 8,
  /** 全城自動建築上限（304 大地圖；實測高密度城市 152 棟，預留擴充空間） */
  maxAutoBuildings: 1200,
  /** 土地發展分數對自動建築等級的影響（0..100） */
  developmentScore: {
    base: 18,
    powerWeight: 14,
    waterWeight: 12,
    policeWeight: 8,
    fireWeight: 8,
    schoolWeight: 10,
    hospitalWeight: 8,
    transitWeight: 10,
    happinessWeight: 12,
    landValueWeight: 10,
  },
};

/** 自動開發建築（有 def.zone） */
export function zoneBuildingDefs(zone: ZoneType): BuildingDef[] {
  return BUILDING_LIST.filter((d) => d.zone === zone);
}

/** 玩家可手動放置的建築（公共設施／交通／休憩／地標） */
export const PLOPPABLE_BUILDINGS = BUILDING_LIST.filter((d) => d.ploppable === true);

/** 建造面板只顯示「玩家可手動放置」的建築分類 */
export const PLOPPABLE_CATEGORIES: BuildingCategory[] = ['civic', 'transport', 'decoration', 'logistics', 'industrial'];

/** 開局模式：已有城鎮（starter）的設定 */
export const STARTER_TOWN = {
  treasury: 6_500_000,
  /** 開局預建後跑多少日模擬，讓市民遷入及建築運作（main.ts warm-up） */
  warmupDays: 10,
  /** 預建人口目標（會經模擬自然遷入，不用硬塞） */
  targetPopulation: 145,
  /** 道路／分區布局半徑（格） */
  layoutRadius: 9,
};

/** 建築總維護費（每月） */
export function totalUpkeep(buildings: { key: string }[]): number {
  return buildings.reduce((sum, b) => sum + (BUILDINGS[b.key]?.upkeep ?? 0), 0);
}

// ─────────────────────────── 交通／車輛 ───────────────────────────

export interface TransitInfo {
  mode: TransitMode;
  name: string;
  color: string;
  emoji: string;
  /** 興建所需建築 key */
  building: string;
}

export const TRANSIT_INFO: Record<TransitMode, TransitInfo> = {
  mtr: { mode: 'mtr', name: '港鐵', color: '#b02a2a', emoji: '🚇', building: 'mtrStation' },
  bus: { mode: 'bus', name: '巴士', color: '#d9b23f', emoji: '🚌', building: 'busTerminus' },
  tram: { mode: 'tram', name: '電車', color: '#2f8f5f', emoji: '🚋', building: 'tramStop' },
  ferry: { mode: 'ferry', name: '渡輪', color: '#2f7f6a', emoji: '⛴️', building: 'ferryPier' },
};

/** 通勤方式對通勤時間的倍率（相對步行 1） */
export const TRANSIT_SPEED: Record<TransitMode | 'walk', number> = {
  walk: 1,
  mtr: 4.2,
  bus: 2.2,
  tram: 1.6,
  ferry: 3.0,
};

/** 路面車輛顏色（香港常見車色） */
export const VEHICLE_COLORS: Record<string, number[]> = {
  bus: [0xd9b23f, 0xd93f3f, 0xf0f0f0],
  minibus: [0x3f8f5f, 0xd9b23f],
  taxi: [0xd93f3f, 0x3f8fbf],
  tram: [0x2f8f5f, 0x2f6f9f],
  ferry: [0x2f7f6a, 0xf0f0f0],
  truck: [0xf0f0f0, 0x3f6f9f, 0xd93f3f],
  van: [0xf0f0f0, 0x9fb0c0],
  car: [0xf0f0f0, 0x2f2f2f, 0xb02a2a, 0x2f5f9f, 0xcfd8e3],
  motorcycle: [0x2f2f2f, 0xb02a2a],
};

/** 建築夜間霓虹燈色（渲染用） */
export const NEON_COLORS = [0xff3d7f, 0x24e0ff, 0xffd166, 0xa45bff, 0x5cff9d, 0xff7a3d];

// ─────────────────────────── 香港地名與霓虹招牌 ───────────────────────────

/** 地圖標籤（正規化座標 0..1，worldgen 依此在世界放置名牌；世界生成可微調） */
export const MAP_LABELS: { name: string; x: number; y: number; kind: 'district' | 'mountain' | 'water' | 'island' }[] = [
  { name: '新界', x: 0.45, y: 0.14, kind: 'district' },
  { name: '大帽山', x: 0.36, y: 0.1, kind: 'mountain' },
  { name: '沙田', x: 0.62, y: 0.22, kind: 'district' },
  { name: '西貢', x: 0.82, y: 0.2, kind: 'district' },
  { name: '荃灣', x: 0.28, y: 0.3, kind: 'district' },
  { name: '葵涌', x: 0.33, y: 0.4, kind: 'district' },
  { name: '深水埗', x: 0.44, y: 0.43, kind: 'district' },
  { name: '旺角', x: 0.5, y: 0.45, kind: 'district' },
  { name: '九龍', x: 0.6, y: 0.46, kind: 'district' },
  { name: '觀塘', x: 0.7, y: 0.44, kind: 'district' },
  { name: '獅子山', x: 0.56, y: 0.36, kind: 'mountain' },
  { name: '維多利亞港', x: 0.55, y: 0.58, kind: 'water' },
  { name: '中環', x: 0.42, y: 0.68, kind: 'district' },
  { name: '銅鑼灣', x: 0.55, y: 0.68, kind: 'district' },
  { name: '北角', x: 0.63, y: 0.68, kind: 'district' },
  { name: '太平山', x: 0.37, y: 0.74, kind: 'mountain' },
  { name: '香港島', x: 0.5, y: 0.8, kind: 'district' },
  { name: '赤柱', x: 0.58, y: 0.88, kind: 'district' },
  { name: '大嶼山', x: 0.14, y: 0.62, kind: 'island' },
  { name: '東涌', x: 0.2, y: 0.52, kind: 'district' },
  { name: '赤鱲角', x: 0.1, y: 0.45, kind: 'island' },
  { name: '南丫島', x: 0.36, y: 0.9, kind: 'island' },
  { name: '長洲', x: 0.2, y: 0.82, kind: 'island' },
];

/** 霓虹招牌文字（建築招牌／室內裝飾用） */
export const NEON_SIGNS = [
  '大藥房',
  '金行',
  '酒樓',
  '麻雀',
  '跌打',
  '找換',
  '燒臘',
  '涼茶',
  '鐘錶',
  '眼鏡',
  '髮廊',
  '茶餐廳',
  '海鮮酒家',
  '珠寶',
  '電器',
  '粥麵',
  '按摩',
  '旅館',
  '押',
  '夜總會',
];

/** 香港街道名（用於室內／路牌／存檔名等） */
export const STREET_NAMES = [
  '皇后大道中',
  '德輔道中',
  '彌敦道',
  '佐敦道',
  '軒尼詩道',
  '英皇道',
  '亞皆老街',
  '荔枝角道',
  '青山公路',
  '沙田正街',
  '觀塘道',
  '漆咸道南',
  '干諾道中',
  '高士威道',
  '上海街',
  '廟街',
  '女人街',
  '波鞋街',
];

/** 飲品／小吃（茶餐廳室內用） */
export const HK_FOODS = ['絲襪奶茶', '鴛鴦', '菠蘿油', '蛋撻', '西多士', '雲吞麵', '叉燒飯', '魚蛋粉', '燒賣', '腸粉'];

// ─────────────────────────── 市民姓名 ───────────────────────────

export const SURNAMES = [
  '陳', '黃', '李', '梁', '張', '劉', '何', '林', '吳', '王', '楊', '許', '鄭', '謝', '鄧', '馮',
  '曾', '譚', '鍾', '葉', '周', '蔡', '羅', '馬', '蘇', '潘', '余', '胡', '司徒', '歐陽', '麥', '尹',
];

export const GIVEN_NAMES = [
  '志明', '美玲', '家俊', '詠欣', '浩然', '嘉欣', '俊傑', '小玲', '偉業', '淑芬',
  '國強', '雅雯', '子軒', '曉彤', '俊宏', '凱琳', '志豪', '美恩', '永恆', '詠詩',
  '家輝', '靜怡', '寶儀', '浩賢', '佩珊', '文輝', '頌恩', '天樂', '詩雅', '卓然',
  '梓軒', '芷晴', '俊熙', '悅彤', '諾謙', '希桐', '宇軒', '詠嵐', '浩然', '子晴',
];

/** 英文名（香港人常中英夾雜；市民名字有機率使用） */
export const ENGLISH_NAMES = [
  'Kelvin', 'Fiona', 'Jason', 'Karen', 'Ryan', 'Michelle', 'Vincent', 'Cherry',
  'Alan', 'Winnie', 'Eric', 'Mandy', 'Wilson', 'Gigi', 'Tommy', 'Suki',
  'Derek', 'Maggie', 'Samuel', 'Yennis',
];

// ─────────────────────────── 教學 ───────────────────────────

export const TUTORIAL_STEPS: { title: string; text: string }[] = [
  {
    title: '歡迎來到維港之城',
    text: '你是香港城市規劃師。目標：在維港兩岸建起一座宜居、繁榮、可持續的國際都會。',
  },
  {
    title: '第一步：鋪路',
    text: '選擇「道路」工具，從預設市中心向外鋪馬路；再用「行人路」連接街區與公園。',
  },
  {
    title: '第二步：起樓',
    text: '在馬路旁興建唐樓與劏房，市民便會遷入。人口是解鎖新建築的關鍵。',
  },
  {
    title: '第三步：開店與物流',
    text: '興建街市與便利店，並用貨倉把食品、日用品送到店舖；市民會購物，商稅自然增加。',
  },
  {
    title: '第四步：交通與公共設施',
    text: '人口上升後，建港鐵站／巴士總站縮短通勤；建警署、學校、醫院提升幸福度。',
  },
  {
    title: '第五步：財政與天氣',
    text: '在財政面板調整薪俸稅、利得稅與差餉。留意天文台警告：颱風會令渡輪停航、地盤停工。',
  },
];

// ─────────────────────────── 工具函式 ───────────────────────────

export function createSimContext(toast: (text: string, kind?: LogKind) => void): SimContext {
  return {
    toast,
    log: (text: string, kind: LogKind = 'info') => toast(text, kind),
  };
}

/** 天氣轉移的隨機挑選（使用傳入的 rng） */
export function pickWeather(season: Season, rng: () => number): Weather {
  const weights = WEATHER_WEIGHTS[season];
  const entries = Object.entries(weights) as [Weather, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [weather, weight] of entries) {
    r -= weight;
    if (r <= 0) return weather;
  }
  return 'clear';
}

/** 港幣格式：$1,234,567 */
export function formatMoney(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(Math.round(amount));
  return `${sign}$${abs.toLocaleString('zh-HK')}`;
}

/** 港幣短格式：$123.5萬 / $1.23億 */
export function formatMoneyShort(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  if (abs >= 100_000_000) return `${sign}$${(abs / 100_000_000).toFixed(2).replace(/\.?0+$/, '')}億`;
  if (abs >= 10_000) return `${sign}$${(abs / 10_000).toFixed(1).replace(/\.0$/, '')}萬`;
  return formatMoney(amount);
}

/** 服務種類中文名（UI 用） */
export const SERVICE_NAMES: Record<ServiceKind, string> = {
  market: '零售',
  restaurant: '餐飲',
  school: '教育',
  hospital: '醫療',
  police: '治安',
  fire: '消防',
  park: '公園',
  promenade: '海濱',
  office: '寫字樓',
  water: '食水',
  power: '電力',
};

export const COLOR = {
  night: '#0b1426',
  nightDeep: '#060b16',
  neonPink: '#ff3d7f',
  neonCyan: '#24e0ff',
  neonGold: '#ffd166',
  neonPurple: '#a45bff',
  neonGreen: '#5cff9d',
  panel: '#101b2e',
  panelLight: '#182740',
  text: '#eaf4ff',
  textDim: '#9fb3c8',
  danger: '#ff5a5a',
  good: '#5cff9d',
  mtrRed: '#b02a2a',
  busYellow: '#d9b23f',
  tramGreen: '#2f8f5f',
};
