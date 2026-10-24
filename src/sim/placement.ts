/**
 * 建築／道路／行人路的擺放與拆除規則（《維港之城》）。
 *
 * main.ts 的 actions 與 city-view 的幽靈預覽直接呼叫這裡，以下介面必須保持：
 *   canPlaceBuilding(state, key, x, y): PlaceResult
 *   placeBuilding(state, key, x, y): PlaceResult
 *   placeRoad(state, x, y): PlaceResult
 *   placeSidewalk(state, x, y): PlaceResult          ← 保留 export（新玩法道路已整合行人路）
 *   demolishAt(state, x, y): { ok, reason?, refund }
 *   demolishBuildingById(state, id): number
 *   updateConnectedBuildings(state): void
 *
 * 第二輪「分區玩法」新增（main.ts／zoning.ts 呼叫）：
 *   paintZone(state, x, y, zone): PlaceResult                劃分區（可覆蓋舊分區，收費）
 *   eraseZone(state, x, y): PlaceResult & { refund: number } 取消分區（退 50%）
 *   canAutoPlaceBuilding(state, key, x, y): boolean          分區自動開發預檢
 *   placeAutoBuilding(state, key, x, y): Building | null     分區自動開發（開發商出資、不扣錢）
 *
 * 香港版擺放規則：
 *   1. 不可超出地圖；地形需可建（山地／水域／濕地／沙灘不可）。
 *      生產建築（BuildingDef.production.allowedTerrain）另有地形限制：
 *      農田只可建於農地／平地；石礦場建於丘陵／平地等。
 *   2. 地形建造成本倍率：TERRAIN_INFO[tile.terrain].costMultiplier
 *      （填海地 1.15、林地 1.25、丘陵 1.2），實際造價 = 定義造價 × 平均倍率。
 *   3. needsWater：貨櫃碼頭／渡輪碼頭／海濱長廊必須臨海或臨河（相鄰水域格）。
 *   3b. 地區／特殊規則（GDD §2.6）：電車站只可在香港島、貨櫃碼頭只可在西岸港口、
 *      林地不可建高密度住宅／工業／商廈、豪宅需海景或山景、學校／醫院不可貼近發電廠。
 *   4. needsRoad：必須臨馬路「或行人路」。唐樓／公屋／商舖等均需臨街；
 *      農田（needsRoad=false）與公園、海濱長廊可免。
 *   5. 需人口解鎖（unlockPop）與足夠庫房儲備。
 *   6. 拆除退還 30% 造價（config.DEMOLISH_REFUND_RATE）。
 *
 * 連通狀態：
 *   building.connected = 外側（正交）有任何 tile.road 或 tile.sidewalk。
 *   building.active    = connected 或該建築免臨路。
 *   貨車物流只認馬路（roadAccessTiles），純行人路的建築可營運但貨車送不到。
 *
 * 帳目：建造費即時從 treasury 扣除，並記入 finance.expenseThisMonth 與
 * expenseBreakdown.infrastructure（拆除退款反向沖銷），讓 UI 財政面板即時反映。
 */

import {
  BUILDINGS,
  DEMOLISH_REFUND_RATE,
  ROAD_COST,
  SIDEWALK_COST,
  TERRAIN_INFO,
  ZONES,
} from '../core/config';
import type { Building, GameState, PlaceResult, ResourceKey, TerrainType, ZoneType } from '../core/types';
import { addCargo } from './logistics-inventory';
import {
  invalidatePathCache,
  isBuildingWalkConnected,
  notifyRoadAdded,
  roadTilesAroundFootprint,
  walkTilesAroundFootprint,
} from './pathfinding';

// ─────────────────────────── 世界變更版本（供 stats/zoning 快取） ───────────────────────────

/**
 * 任何擺放／拆除（建築、道路、行人路、分區）都會遞增此版本號。
 * stats.ts 用嚟快取覆蓋率／分區統計，避免每幀重算；唔會寫入存檔。
 */
let worldRevision = 0;

/** 目前世界變更版本（單調遞增） */
export function worldRevisionOf(): number {
  return worldRevision;
}

function bumpWorldRevision(): void {
  worldRevision++;
}

/**
 * 分區變更版本（只在 paintZone／eraseZone 時遞增）。
 * stats.ts 用嚟快取「分區格數」，避免每鋪一格路都重掃 92k tiles。
 */
let zoneRevision = 0;

/** 目前分區變更版本（單調遞增） */
export function zoneRevisionOf(): number {
  return zoneRevision;
}

function bumpZoneRevision(): void {
  zoneRevision++;
}

// ─────────────────────────── 大地圖 tile 索引（typed arrays） ───────────────────────────

/**
 * 480×480 = 230,400 格，逐格讀 `state.tiles[i].zone/road/buildingId`（object）好貴
 * （一次全掃 5–20ms）。呢度用 Uint8Array 索引，讓 zoning/stats 可以快速掃描／檢查相鄰格，
 * 提升大 map 效能；索引喺第一次需要時由現有 tiles 建立，之後由擺放／拆除函式增量更新。
 * 新局／讀檔會建立新 GameState → WeakMap miss → 自動重建，不會 stale。
 */
export interface TileIndex {
  /** 每格分區 code：0 無、1 住宅、2 商業、3 工業、4 農業 */
  zone: Uint8Array;
  /** 每格是否有馬路（1/0） */
  road: Uint8Array;
  /** 每格是否有建築（1/0） */
  building: Uint8Array;
}

const ZONE_CODE: Record<ZoneType, number> = { residential: 1, commercial: 2, industrial: 3, farmland: 4 };
/** zone → tile index code（供 zoning 使用） */
export const ZONE_CODES: Record<ZoneType, number> = ZONE_CODE;
/** code → ZoneType（index 0 = null） */
export const ZONE_CODE_NAMES: readonly (ZoneType | null)[] = [
  null,
  'residential',
  'commercial',
  'industrial',
  'farmland',
];

const tileIndexCache = new WeakMap<GameState, TileIndex>();

/** 取得（必要時建立）tile 索引；建索引係一次 O(n) 掃描，之後 O(1) 更新。 */
export function tileIndexOf(state: GameState): TileIndex {
  const cached = tileIndexCache.get(state);
  if (cached) return cached;
  const n = state.tiles.length;
  const index: TileIndex = {
    zone: new Uint8Array(n),
    road: new Uint8Array(n),
    building: new Uint8Array(n),
  };
  const tiles = state.tiles;
  for (let i = 0; i < n; i++) {
    const tile = tiles[i];
    const zone = tile.zone;
    if (zone) index.zone[i] = ZONE_CODE[zone] ?? 0;
    if (tile.road) index.road[i] = 1;
    if (tile.buildingId >= 0) index.building[i] = 1;
  }
  tileIndexCache.set(state, index);
  return index;
}

/** 若索引已建立就更新（未建立時唔需要，因為之後建立會讀最新 tiles）。 */
function tileIndexIfAny(state: GameState): TileIndex | null {
  return tileIndexCache.get(state) ?? null;
}

/** 設定／清除某格分區（索引已存在時同步） */
function noteZoneTile(state: GameState, idx: number, zone: ZoneType | null): void {
  const index = tileIndexIfAny(state);
  if (index) index.zone[idx] = zone ? ZONE_CODE[zone] ?? 0 : 0;
}

/** 設定／清除某格馬路（索引已存在時同步） */
function noteRoadTile(state: GameState, idx: number, isRoad: boolean): void {
  const index = tileIndexIfAny(state);
  if (index) index.road[idx] = isRoad ? 1 : 0;
}

/** 標記／清除建築 footprint（索引已存在時同步） */
function noteBuildingTiles(state: GameState, tiles: number[], filled: boolean): void {
  const index = tileIndexIfAny(state);
  if (!index) return;
  for (const idx of tiles) index.building[idx] = filled ? 1 : 0;
}

// ─────────────────────────── 地形規則 ───────────────────────────

/** 地形可否鋪路／行人路／起樓（與 config TERRAIN_INFO.buildable 一致） */
function terrainBuildable(terrain: TerrainType): boolean {
  return TERRAIN_INFO[terrain]?.buildable ?? false;
}

function terrainName(terrain: TerrainType): string {
  return TERRAIN_INFO[terrain]?.name ?? terrain;
}

/** 地形建造成本倍率（多格建築取平均） */
function terrainCostMultiplier(state: GameState, x: number, y: number, w: number, h: number): number {
  let total = 0;
  let count = 0;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) continue;
      const tile = state.tiles[ty * state.width + tx];
      total += TERRAIN_INFO[tile.terrain]?.costMultiplier ?? 1;
      count++;
    }
  }
  return count > 0 ? total / count : 1;
}

// ─────────────────────────── 地區規則（GDD §2.2／§2.6） ───────────────────────────

/** 香港分區（依設計座標矩形，優先次序同 GDD §2.2） */
export type HkBigRegion =
  | 'westPort' // 西岸港口／大嶼山北（葵涌、荃灣、東涌、赤鱲角）
  | 'islands' // 南區及離島
  | 'harbour' // 維多利亞港
  | 'newTerritories' // 新界北
  | 'lionRock' // 獅子山走廊
  | 'kowloon' // 九龍
  | 'hongKongIsland' // 香港島
  | 'other';

/** 依格座標判斷所屬大區（給地區限制與 UI 用） */
export function regionAt(x: number, y: number): HkBigRegion {
  if (y >= 34 && y <= 48 && x < 34) return 'westPort';
  if ((x < 26 && y > 48 && y <= 70) || y >= 80) return 'islands';
  if (y >= 51 && y <= 60) return 'harbour';
  if (y <= 32) return 'newTerritories';
  if (y >= 33 && y <= 37) return 'lionRock';
  if (y >= 38 && y <= 50) return 'kowloon';
  if (y >= 61 && y <= 79) return 'hongKongIsland';
  return 'other';
}

const REGION_NAMES: Record<HkBigRegion, string> = {
  westPort: '西岸港口',
  islands: '南區及離島',
  harbour: '維多利亞港',
  newTerritories: '新界',
  lionRock: '獅子山走廊',
  kowloon: '九龍',
  hongKongIsland: '香港島',
  other: '香港',
};

/** 建築中心（格座標） */
function footprintCenter(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return { x: x + w / 2, y: y + h / 2 };
}

/** 在建築外圍 radius 格內（歐氏）尋找指定地形 */
function terrainNearby(
  state: GameState,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  predicate: (terrain: TerrainType) => boolean,
): boolean {
  const center = footprintCenter(x, y, w, h);
  const r2 = radius * radius;
  const minX = Math.max(0, Math.floor(center.x - radius));
  const maxX = Math.min(state.width - 1, Math.ceil(center.x + radius));
  const minY = Math.max(0, Math.floor(center.y - radius));
  const maxY = Math.min(state.height - 1, Math.ceil(center.y + radius));
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      const dx = tx + 0.5 - center.x;
      const dy = ty + 0.5 - center.y;
      if (dx * dx + dy * dy > r2) continue;
      if (predicate(state.tiles[ty * state.width + tx].terrain)) return true;
    }
  }
  return false;
}

/**
 * GDD §2.6 地區／特殊限制。回傳 null 代表通過，否則回傳香港用語原因。
 * - 電車站：只可在香港島（港島北岸電車線概念）。
 * - 貨櫃碼頭：只可建於西岸港口（葵青一帶，x<34、y 34–48）。
 * - 林地：不可建高密度住宅、工業與商廈／商場（需先清林）。
 * - 豪宅：需距海 ≤4 格或距山地／丘陵 ≤3 格（景觀）。
 * - 學校／醫院：不可建於發電廠 3 格內（污染）。
 */
function specialPlacementRule(
  state: GameState,
  key: string,
  x: number,
  y: number,
): string | null {
  const def = BUILDINGS[key];
  const [w, h] = def.size;
  const center = footprintCenter(x, y, w, h);
  const region = regionAt(Math.floor(center.x), Math.floor(center.y));

  if (key === 'tramStop' && region !== 'hongKongIsland') {
    return '電車站只可在香港島興建（港島電車線）';
  }
  if (key === 'containerPort' && region !== 'westPort') {
    return '貨櫃碼頭只可建於葵涌／西岸港口一帶';
  }

  // 林地限制（逐格檢查 footprint）
  if (key === 'officeTower' || key === 'shoppingMall' || def.category === 'industrial') {
    const tiles = buildingFootprintTiles(state, x, y, w, h);
    if (tiles.some((idx) => state.tiles[idx].terrain === 'forest')) {
      return '林地不可建工業或商廈，請先清林或另覓平地';
    }
  }
  if (def.category === 'residential' && def.housing > 0 && key !== 'subdividedFlat') {
    const tiles = buildingFootprintTiles(state, x, y, w, h);
    if (tiles.some((idx) => state.tiles[idx].terrain === 'forest')) {
      return '林地不可建高密度住宅，請另覓平地';
    }
  }

  // 豪宅景觀要求
  if (key === 'luxuryTower') {
    const nearWater = terrainNearby(state, x, y, w, h, 4, (t) => t === 'water');
    const nearHill = terrainNearby(state, x, y, w, h, 3, (t) => t === 'hill' || t === 'mountain');
    if (!nearWater && !nearHill) {
      return '豪宅須有海景（距海 ≤4 格）或山景（距山地 ≤3 格）';
    }
  }

  // 學校／醫院不可貼近發電廠（污染）
  if (key === 'school' || key === 'hospital') {
    for (const building of state.buildings) {
      if (building.key !== 'powerPlant') continue;
      const c = footprintCenter(building.x, building.y, building.w, building.h);
      const dx = c.x - center.x;
      const dy = c.y - center.y;
      if (dx * dx + dy * dy <= 3 * 3) {
        return `${def.name}不可建於發電廠 3 格範圍內（空氣污染）`;
      }
    }
  }

  return null;
}

// ─────────────────────────── 建築需求規則 ───────────────────────────

/** 某建築種類是否需要臨街（馬路或行人路）才能擺放／營運 */
export function buildingNeedsRoad(key: string): boolean {
  const def = BUILDINGS[key];
  if (!def) return false;
  if (typeof def.needsRoad === 'boolean') return def.needsRoad;
  return def.category !== 'decoration';
}

/** 建築是否可營運（連街且非停擺）。物流／生產／人口子系統可共用。 */
export function isBuildingOperational(building: Building): boolean {
  return building.active && building.connected;
}

/** 建築是否已連通街道（馬路或行人路） */
export function isBuildingStreetConnected(state: GameState, building: Building): boolean {
  return isBuildingWalkConnected(state, building);
}

export function getBuildingAt(state: GameState, x: number, y: number): Building | null {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return null;
  const id = state.tiles[y * state.width + x].buildingId;
  if (id < 0) return null;
  return state.buildings.find((b) => b.id === id) ?? null;
}

export function buildingFootprintTiles(
  state: GameState,
  x: number,
  y: number,
  w: number,
  h: number,
): number[] {
  const tiles: number[] = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) return [];
      tiles.push(ty * state.width + tx);
    }
  }
  return tiles;
}

/** 建築四周（含斜角）是否有水域：維港／城門河／水塘 */
function hasAdjacentWater(state: GameState, x: number, y: number, w: number, h: number): boolean {
  const check = (tx: number, ty: number): boolean => {
    if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) return false;
    return state.tiles[ty * state.width + tx].terrain === 'water';
  };
  for (let dx = -1; dx <= w; dx++) {
    if (check(x + dx, y - 1) || check(x + dx, y + h)) return true;
  }
  for (let dy = -1; dy <= h; dy++) {
    if (check(x - 1, y + dy) || check(x + w, y + dy)) return true;
  }
  return false;
}

/** 目前總人口（用於解鎖判斷；stats 每幀更新，citizens 為權威資料） */
function populationOf(state: GameState): number {
  return Math.max(state.stats.population, state.citizens.length);
}

/** 生產建築的地形限制說明文字 */
function allowedTerrainLabel(def: { production?: { allowedTerrain?: TerrainType[] } }): string {
  const allowed = def.production?.allowedTerrain;
  if (!allowed || !allowed.length) return '';
  return allowed.map((t) => terrainName(t)).join('／');
}

// ─────────────────────────── 擺放檢查 ───────────────────────────

export function canPlaceBuilding(state: GameState, key: string, x: number, y: number): PlaceResult {
  const def = BUILDINGS[key];
  if (!def) return { ok: false, reason: '未知的建築種類', cost: 0 };
  // 分區玩法：屬分區自動開發的建築不可手動放置；只有 ploppable（公共／交通／休憩）可由玩家興建
  if (def.zone) {
    return {
      ok: false,
      reason: '此建築由分區自動開發，請劃分住宅／商業／工業／農業區',
      cost: def.cost,
    };
  }
  if (!def.ploppable) {
    return { ok: false, reason: '此建築暫不可手動興建', cost: def.cost };
  }
  const [w, h] = def.size;
  if (x < 0 || y < 0 || x + w > state.width || y + h > state.height) {
    return { ok: false, reason: '超出地圖範圍', cost: def.cost };
  }

  const tiles = buildingFootprintTiles(state, x, y, w, h);
  if (!tiles.length) return { ok: false, reason: '超出地圖範圍', cost: def.cost };

  // 地形建造成本（多格取平均倍率）
  const multiplier = terrainCostMultiplier(state, x, y, w, h);
  const cost = Math.round(def.cost * multiplier);

  if (state.finance.treasury < cost) {
    return { ok: false, reason: '庫房不足，無法動工', cost };
  }
  if (populationOf(state) < def.unlockPop) {
    return { ok: false, reason: `人口達 ${def.unlockPop} 後解鎖`, cost };
  }

  const allowed = def.production?.allowedTerrain;
  const allowedSet = allowed && allowed.length ? new Set<TerrainType>(allowed) : null;
  for (const idx of tiles) {
    const tile = state.tiles[idx];
    if (!terrainBuildable(tile.terrain)) {
      return { ok: false, reason: `${def.name}不可建於${terrainName(tile.terrain)}`, cost };
    }
    if (tile.buildingId >= 0) return { ok: false, reason: '此地已有建築', cost };
    if (tile.road) return { ok: false, reason: '此處是馬路，請先清拆', cost };
    if (tile.sidewalk) return { ok: false, reason: '此處是行人路，請先清拆', cost };
    if (allowedSet && !allowedSet.has(tile.terrain)) {
      return { ok: false, reason: `${def.name}須建於${allowedTerrainLabel(def)}`, cost };
    }
  }

  // 地區／特殊規則（GDD §2.6）
  const special = specialPlacementRule(state, key, x, y);
  if (special) return { ok: false, reason: special, cost };

  if (def.needsWater && !hasAdjacentWater(state, x, y, w, h)) {
    return { ok: false, reason: '必須臨海或臨河建造', cost };
  }

  if (buildingNeedsRoad(key)) {
    if (roadTilesAroundFootprint(state, x, y, w, h).length === 0) {
      const walk = walkTilesAroundFootprint(state, x, y, w, h);
      if (walk.length === 0) {
        return { ok: false, reason: '須臨馬路或行人路建造', cost };
      }
    }
  }

  return { ok: true, cost };
}

export function placeBuilding(state: GameState, key: string, x: number, y: number): PlaceResult {
  const check = canPlaceBuilding(state, key, x, y);
  if (!check.ok) return check;
  const def = BUILDINGS[key];
  const [w, h] = def.size;
  const footprint = buildingFootprintTiles(state, x, y, w, h);

  const building: Building = {
    id: state.nextBuildingId++,
    key,
    x,
    y,
    w,
    h,
    active: true,
    connected: false,
    workers: [],
    residents: [],
    inventory: {},
    productionProgress: 0,
    level: 1,
    builtOnDay: state.clock.totalDays,
    incomeThisMonth: 0,
    expenseThisMonth: 0,
  };
  for (const idx of footprint) state.tiles[idx].buildingId = building.id;
  noteBuildingTiles(state, footprint, true);
  state.buildings.push(building);
  building.connected = isBuildingStreetConnected(state, building);
  building.active = building.connected || !buildingNeedsRoad(key);

  // 付款：即時扣庫房並記入基建支出
  const cost = check.cost;
  state.finance.treasury -= cost;
  state.finance.expenseThisMonth += cost;
  state.finance.expenseBreakdown.infrastructure =
    (state.finance.expenseBreakdown.infrastructure ?? 0) + cost;
  bumpWorldRevision();

  return { ok: true, cost };
}

// ─────────────────────────── 道路與行人路 ───────────────────────────

export function placeRoad(state: GameState, x: number, y: number): PlaceResult {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) {
    return { ok: false, reason: '超出地圖範圍', cost: ROAD_COST };
  }
  const tile = state.tiles[y * state.width + x];
  if (tile.road) return { ok: false, reason: '此處已有馬路', cost: ROAD_COST };
  if (tile.buildingId >= 0) return { ok: false, reason: '此處已有建築', cost: ROAD_COST };
  if (!terrainBuildable(tile.terrain)) {
    return { ok: false, reason: `不可在${terrainName(tile.terrain)}上鋪路`, cost: ROAD_COST };
  }
  if (state.finance.treasury < ROAD_COST) return { ok: false, reason: '庫房不足，無法鋪路', cost: ROAD_COST };

  tile.road = true;
  // 馬路兩側自動鋪設行人路邊（同一格 sidewalk 供行人尋路／渲染）
  tile.sidewalk = true;
  noteRoadTile(state, y * state.width + x, true);
  state.finance.treasury -= ROAD_COST;
  state.finance.expenseThisMonth += ROAD_COST;
  state.finance.expenseBreakdown.infrastructure =
    (state.finance.expenseBreakdown.infrastructure ?? 0) + ROAD_COST;
  // 新增道路：保留仍有效嘅 cached path，只清「無路」快取（大幅減少拖曳鋪路卡頓）
  notifyRoadAdded();
  updateConnectedBuildings(state);
  bumpWorldRevision();
  return { ok: true, cost: ROAD_COST };
}

/** 鋪設行人專用路（$5,000／格）。行人可走；車輛不可走。 */
export function placeSidewalk(state: GameState, x: number, y: number): PlaceResult {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) {
    return { ok: false, reason: '超出地圖範圍', cost: SIDEWALK_COST };
  }
  const tile = state.tiles[y * state.width + x];
  if (tile.road) return { ok: false, reason: '此處是馬路，路邊已有行人路', cost: SIDEWALK_COST };
  if (tile.sidewalk) return { ok: false, reason: '此處已有行人路', cost: SIDEWALK_COST };
  if (tile.buildingId >= 0) return { ok: false, reason: '此處已有建築', cost: SIDEWALK_COST };
  if (!terrainBuildable(tile.terrain)) {
    return { ok: false, reason: `不可在${terrainName(tile.terrain)}上鋪行人路`, cost: SIDEWALK_COST };
  }
  if (state.finance.treasury < SIDEWALK_COST) {
    return { ok: false, reason: '庫房不足，無法鋪行人路', cost: SIDEWALK_COST };
  }

  tile.sidewalk = true;
  state.finance.treasury -= SIDEWALK_COST;
  state.finance.expenseThisMonth += SIDEWALK_COST;
  state.finance.expenseBreakdown.infrastructure =
    (state.finance.expenseBreakdown.infrastructure ?? 0) + SIDEWALK_COST;
  notifyRoadAdded();
  updateConnectedBuildings(state);
  bumpWorldRevision();
  return { ok: true, cost: SIDEWALK_COST };
}

// ─────────────────────────── 分區劃分／取消（第二輪玩法） ───────────────────────────

/** 取消分區退款比例（劃區費的 50%） */
export const ZONE_REFUND_RATE = 0.5;

/** 劃區／取消分區的結果（main.ts 會讀 result.refund） */
export interface ZoneOpResult extends PlaceResult {
  refund: number;
}

/** 劃區收費記帳（同建造費，計入基建支出） */
function payZoneCost(state: GameState, cost: number): void {
  state.finance.treasury -= cost;
  state.finance.expenseThisMonth += cost;
  state.finance.expenseBreakdown.infrastructure =
    (state.finance.expenseBreakdown.infrastructure ?? 0) + cost;
}

/**
 * 劃分分區（$ZONES[zone].costPerTile／格）。
 * - 可覆蓋已存在的其他分區（重新規劃，照收費、不退款；同格同區則拒絕）。
 * - 不可劃在馬路／建築上；地形需可建；農地區只可劃在農地／平地。
 * reason 保持簡短香港用語（main.ts 拖曳時會 toast 節流）。
 */
export function paintZone(state: GameState, x: number, y: number, zone: ZoneType): PlaceResult {
  const zoneDef = ZONES[zone];
  if (!zoneDef) return { ok: false, reason: '未知分區', cost: 0 };
  const cost = zoneDef.costPerTile;
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) {
    return { ok: false, reason: '超出地圖範圍', cost };
  }
  const tile = state.tiles[y * state.width + x];
  if (tile.zone === zone) return { ok: false, reason: `此處已是${zoneDef.name}`, cost };
  if (tile.road) return { ok: false, reason: '此處是馬路', cost };
  if (tile.buildingId >= 0) return { ok: false, reason: '此處已有建築', cost };
  if (!terrainBuildable(tile.terrain)) {
    return { ok: false, reason: `不可在${terrainName(tile.terrain)}上劃區`, cost };
  }
  if (zone === 'farmland' && tile.terrain !== 'fertile' && tile.terrain !== 'grass') {
    return { ok: false, reason: '農地區只可劃在農地／平地', cost };
  }
  if (populationOf(state) < zoneDef.unlockPop) {
    return { ok: false, reason: `人口達 ${zoneDef.unlockPop} 後解鎖`, cost };
  }
  if (state.finance.treasury < cost) return { ok: false, reason: '庫房不足，無法劃區', cost };

  tile.zone = zone;
  noteZoneTile(state, y * state.width + x, zone);
  payZoneCost(state, cost);
  bumpZoneRevision();
  return { ok: true, cost };
}

/**
 * 取消分區（退 50% 劃區費）。只清 tile.zone，唔會拆建築（建築由 demolishAt 處理）。
 */
export function eraseZone(state: GameState, x: number, y: number): ZoneOpResult {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) {
    return { ok: false, reason: '超出地圖範圍', cost: 0, refund: 0 };
  }
  const tile = state.tiles[y * state.width + x];
  if (!tile.zone) return { ok: false, reason: '此處未劃分區', cost: 0, refund: 0 };
  const zone = tile.zone;
  const cost = ZONES[zone]?.costPerTile ?? 0;
  const refund = Math.floor(cost * ZONE_REFUND_RATE);
  tile.zone = null;
  noteZoneTile(state, y * state.width + x, null);
  recordRefund(state, refund);
  bumpZoneRevision();
  return { ok: true, cost, refund };
}

// ─────────────────────────── 分區自動開發（開發商建屋） ───────────────────────────

/**
 * 分區自動開發預檢：
 * - 只限 def.zone 建築；
 * - footprint 每格都要在「同一個 zone」、地形可建、無馬路／建築；
 * - 4 鄰接要有馬路或行人路（道路已整合行人路，開發商只會臨街起樓）；
 * - 生產建築 allowedTerrain、林地／豪宅景觀等特殊規則照樣適用。
 */
export function canAutoPlaceBuilding(state: GameState, key: string, x: number, y: number): boolean {
  const def = BUILDINGS[key];
  if (!def || !def.zone) return false;
  const [w, h] = def.size;
  if (x < 0 || y < 0 || x + w > state.width || y + h > state.height) return false;
  const tiles = buildingFootprintTiles(state, x, y, w, h);
  if (!tiles.length) return false;

  const allowed = def.production?.allowedTerrain;
  let zoneCovered = 0;
  for (const idx of tiles) {
    const tile = state.tiles[idx];
    if (!tile) return false;
    // footprint 需「至少有 zone 覆蓋」：農業區特別允許跨到旁邊未劃區嘅可建農地
    // （開局城鎮／玩家沿路零星劃農地時，2×2 農田先有機會形成）
    if (tile.zone === def.zone) zoneCovered++;
    else if (!(def.zone === 'farmland' && (tile.zone === null || tile.zone === undefined))) return false;
    if (tile.buildingId >= 0) return false;
    if (tile.road) return false;
    if (!terrainBuildable(tile.terrain)) return false;
    if (allowed && allowed.length && !allowed.includes(tile.terrain)) return false;
    if (tile.terrain === 'forest') {
      // 林地不可建高密度住宅／工業／商廈（同手動擺放規則）
      if (def.category === 'industrial') return false;
      if (def.category === 'residential' && key !== 'subdividedFlat') return false;
      if (key === 'officeTower' || key === 'shoppingMall') return false;
    }
  }

  if (zoneCovered === 0) return false;

  // 臨街（馬路或行人路）：def.needsRoad=false 的建築（農田）可唔臨路——
  // 農田可以喺較偏遠嘅農地開墾，產品先入本地庫存（有路後貨車才來收貨，
  // 市民亦可由全城存糧直接取用）。其他分區建築一律要臨街。
  if (buildingNeedsRoad(key)) {
    if (!roadTilesAroundFootprint(state, x, y, w, h).length) {
      if (!walkTilesAroundFootprint(state, x, y, w, h).length) return false;
    }
  }

  // 地區／特殊規則（豪宅景觀等；tramStop/containerPort 唔會係自動建築）
  if (specialPlacementRule(state, key, x, y)) return false;
  return true;
}

/**
 * 由「開發商」自動興建分區建築：
 * - 不扣玩家庫房（開發商出資），但建築照樣計維護費／稅收；
 * - Building.auto=true、Building.zone=def.zone、connected 由臨街判定；
 * - tiles 保留分區值（之後建築被拆仍會自動重建）。
 */
export function placeAutoBuilding(state: GameState, key: string, x: number, y: number): Building | null {
  if (!canAutoPlaceBuilding(state, key, x, y)) return null;
  const def = BUILDINGS[key];
  const [w, h] = def.size;
  const footprint = buildingFootprintTiles(state, x, y, w, h);
  const building: Building = {
    id: state.nextBuildingId++,
    key,
    x,
    y,
    w,
    h,
    active: true,
    connected: false,
    workers: [],
    residents: [],
    inventory: {},
    productionProgress: 0,
    level: 1,
    builtOnDay: state.clock.totalDays,
    incomeThisMonth: 0,
    expenseThisMonth: 0,
    auto: true,
    zone: def.zone,
  };
  for (const idx of footprint) state.tiles[idx].buildingId = building.id;
  noteBuildingTiles(state, footprint, true);
  state.buildings.push(building);
  building.connected = isBuildingStreetConnected(state, building);
  building.active = building.connected || !buildingNeedsRoad(key);
  bumpWorldRevision();
  return building;
}

// ─────────────────────────── 拆除 ───────────────────────────

/** 街道設施（馬路／行人路）的退還金額 */
function streetRefund(cost: number): number {
  return Math.floor(cost * DEMOLISH_REFUND_RATE);
}

/**
 * 拆除退款：先沖銷本月基建支出；若本月尚未有足夠支出可沖銷（例如新月份第 1 日清拆），
 * 餘額記作「其他收入」，確保月報表加總仍然等於庫房實際變動。
 */
function recordRefund(state: GameState, refund: number): void {
  if (refund <= 0) return;
  state.finance.treasury += refund;
  const finance = state.finance;
  const applied = Math.min(refund, Math.max(0, finance.expenseThisMonth));
  if (applied > 0) {
    finance.expenseThisMonth = Math.round((finance.expenseThisMonth - applied) * 100) / 100;
    const infra = finance.expenseBreakdown.infrastructure ?? 0;
    finance.expenseBreakdown.infrastructure = Math.max(0, Math.round((infra - applied) * 100) / 100);
  }
  const excess = refund - applied;
  if (excess > 0) {
    finance.incomeThisMonth = Math.round((finance.incomeThisMonth + excess) * 100) / 100;
    finance.incomeBreakdown.other = Math.round(((finance.incomeBreakdown.other ?? 0) + excess) * 100) / 100;
  }
}

/**
 * 拆除格上的建築／馬路／行人路；回傳退還金額。
 * 同一格同時有馬路與行人路時，先拆馬路（保留行人路），第二次再拆行人路。
 */
export function demolishAt(
  state: GameState,
  x: number,
  y: number,
): { ok: boolean; reason?: string; refund: number } {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) {
    return { ok: false, reason: '超出地圖範圍', refund: 0 };
  }
  const tile = state.tiles[y * state.width + x];
  if (tile.buildingId >= 0) {
    const refund = demolishBuildingById(state, tile.buildingId);
    return { ok: true, refund };
  }
  if (tile.road) {
    const refund = streetRefund(ROAD_COST);
    tile.road = false;
    noteRoadTile(state, y * state.width + x, false);
    recordRefund(state, refund);
    invalidatePathCache();
    updateConnectedBuildings(state);
    bumpWorldRevision();
    return { ok: true, refund };
  }
  if (tile.sidewalk) {
    const refund = streetRefund(SIDEWALK_COST);
    tile.sidewalk = false;
    recordRefund(state, refund);
    invalidatePathCache();
    updateConnectedBuildings(state);
    bumpWorldRevision();
    return { ok: true, refund };
  }
  return { ok: false, reason: '此處沒有可清拆的建築或道路', refund: 0 };
}

/** 拆除建築後，處理正在前往該建築的貨車貨物（退回來源，避免貨物憑空消失） */
function reclaimCartsBoundTo(state: GameState, buildingId: number): void {
  if (!state.carts.length) return;
  const carts = state.carts;
  let write = 0;
  for (let i = 0; i < carts.length; i++) {
    const cart = carts[i];
    if (cart.toId !== buildingId) {
      carts[write++] = cart;
      continue;
    }
    // 目的地被拆：貨物退回來源（來源若也同時被拆，最後由清理流程處理）
    const from = state.buildings.find((b) => b.id === cart.fromId && b.id !== buildingId);
    if (from) addCargo(from, cart.resource as ResourceKey, cart.amount);
    cart.done = true;
  }
  carts.length = write;
}

export function demolishBuildingById(state: GameState, id: number): number {
  const index = state.buildings.findIndex((b) => b.id === id);
  if (index < 0) return 0;
  const building = state.buildings[index];
  const def = BUILDINGS[building.key];
  // 自動開發建築由開發商出資，玩家清拆冇退款；手動 ploppable 建築照舊退 30%
  const refund = building.auto ? 0 : Math.floor((def?.cost ?? 0) * DEMOLISH_REFUND_RATE);

  // 先回收在途貨物（此時建築還在 buildings 陣列中，來源查找要排除自己）
  reclaimCartsBoundTo(state, id);

  for (let yd = 0; yd < building.h; yd++) {
    for (let xd = 0; xd < building.w; xd++) {
      const tx = building.x + xd;
      const ty = building.y + yd;
      if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) continue;
      const tile = state.tiles[ty * state.width + tx];
      if (tile.buildingId === building.id) tile.buildingId = -1;
    }
  }
  {
    const footprint: number[] = [];
    for (let yd = 0; yd < building.h; yd++) {
      for (let xd = 0; xd < building.w; xd++) {
        const tx = building.x + xd;
        const ty = building.y + yd;
        if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) continue;
        footprint.push(ty * state.width + tx);
      }
    }
    noteBuildingTiles(state, footprint, false);
  }
  state.buildings.splice(index, 1);
  recordRefund(state, refund);

  // 清理市民的住家與工作參照
  for (const citizen of state.citizens) {
    if (citizen.homeId === id) {
      citizen.homeId = -1;
      citizen.state = 'idle';
      citizen.targetId = -1;
      citizen.path = [];
      citizen.pathProgress = 0;
    }
    if (citizen.workId === id) citizen.workId = -1;
  }
  invalidatePathCache();
  updateConnectedBuildings(state);
  bumpWorldRevision();
  return refund;
}

/** 重新計算每棟建築的街道連通狀態與營運旗標 */
export function updateConnectedBuildings(state: GameState): void {
  for (const building of state.buildings) {
    const connected = isBuildingStreetConnected(state, building);
    building.connected = connected;
    building.active = connected || !buildingNeedsRoad(building.key);
  }
}
