/**
 * 路網與行人路路徑搜尋（《維港之城》）。
 *
 * 香港版重點：
 *   - 地圖有「馬路」（tile.road）同「行人路」（tile.sidewalk）兩種路網。
 *   - 車輛（物流貨車）只可行馬路；行人可行馬路或行人路（行人路優先）。
 *   - 馬路格通常同時帶 sidewalk（placeRoad 會一併鋪行人路邊），
 *     但行人專用路（placeSidewalk）只有 sidewalk 冇 road。
 *
 * 對外介面（舊版名稱全部保留，其他模組依賴）：
 *   findRoadPath(state, start, goal): number[] | null
 *   findRoadPathToAny(state, start, goals): RoadPathHit | null
 *   findPathBetweenBuildings(state, fromId, toId): number[] | null
 *   roadAccessTiles(state, building): number[]
 *   roadTilesAroundFootprint(state, x, y, w, h): number[]
 *   buildingAnchorTile(state, building): number
 *   isBuildingConnected(state, building): boolean
 *   nearestRoadTile(state, x, y, maxRadius?): number
 *   isRoadTile(state, index) / invalidatePathCache()
 *
 * 新增（香港版）：
 *   isSidewalkTile / isWalkableTile / isWalkableXY
 *   walkAccessTiles(state, building)          行人出入口（行人路優先）
 *   findWalkPath / findWalkPathToAny / findWalkPathBetweenBuildings
 *
 * 效能：
 *   - A*＋二元堆，四方向；曼哈頓啟發式（可採納）。
 *   - 單起點／終點、建築對建築皆有快取；道路／行人路變更或換局時失效。
 *   - 行人路加權：行人路成本 1、馬路成本 3（行人在馬路上要避車，較慢），
 *     令行人盡量沿行人路行，但過馬路仍然可行。
 */

import type { Building, GameState } from '../core/types';

// ─────────────────────────── 座標工具 ───────────────────────────

export function tileIndex(state: GameState, x: number, y: number): number {
  return y * state.width + x;
}

export function tileXY(state: GameState, index: number): { x: number; y: number } {
  return { x: index % state.width, y: Math.floor(index / state.width) };
}

export function inBounds(state: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < state.width && y < state.height;
}

/** 是否馬路格（車輛可走） */
export function isRoadTile(state: GameState, index: number): boolean {
  return index >= 0 && index < state.tiles.length && state.tiles[index].road;
}

/** 是否行人路格 */
export function isSidewalkTile(state: GameState, index: number): boolean {
  return index >= 0 && index < state.tiles.length && !!state.tiles[index].sidewalk;
}

/** 是否可行人（馬路或行人路） */
export function isWalkableTile(state: GameState, index: number): boolean {
  if (index < 0 || index >= state.tiles.length) return false;
  const tile = state.tiles[index];
  return tile.road || !!tile.sidewalk;
}

/** 座標版：是否可行人 */
export function isWalkableXY(state: GameState, x: number, y: number): boolean {
  return inBounds(state, x, y) && isWalkableTile(state, y * state.width + x);
}

// ─────────────────────────── 建築臨路格 ───────────────────────────

/**
 * 建築佔地四周（正交、不含斜角）的道路格 index。
 * 供擺放預檢在還沒建立 Building 物件時使用。
 */
export function roadTilesAroundFootprint(
  state: GameState,
  x: number,
  y: number,
  w: number,
  h: number,
): number[] {
  const result: number[] = [];
  const pushIfRoad = (tx: number, ty: number): void => {
    if (!inBounds(state, tx, ty)) return;
    const idx = ty * state.width + tx;
    if (state.tiles[idx]?.road) result.push(idx);
  };
  for (let dx = 0; dx < w; dx++) {
    pushIfRoad(x + dx, y - 1);
    pushIfRoad(x + dx, y + h);
  }
  for (let dy = 0; dy < h; dy++) {
    pushIfRoad(x - 1, y + dy);
    pushIfRoad(x + w, y + dy);
  }
  return result;
}

/** 建築四周（正交）的道路格（有快取；道路變更／換局時失效） */
export function roadAccessTiles(state: GameState, building: Building): number[] {
  ensureCacheFor(state);
  const cached = roadAccessCache.get(building.id);
  if (cached) return cached;
  const result = roadTilesAroundFootprint(state, building.x, building.y, building.w, building.h);
  roadAccessCache.set(building.id, result);
  return result;
}

/** 建築是否已連通道路（只計馬路；物流使用） */
export function isBuildingConnected(state: GameState, building: Building): boolean {
  return roadAccessTiles(state, building).length > 0;
}

/**
 * 建築四周（正交）的行人出入口：行人路格優先，其次馬路格。
 * 行人路與馬路可以同時存在（馬路自帶行人路邊），此時只回傳行人路格。
 */
export function walkTilesAroundFootprint(
  state: GameState,
  x: number,
  y: number,
  w: number,
  h: number,
  sidewalksOnly = false,
): number[] {
  const sidewalk: number[] = [];
  const roads: number[] = [];
  const visit = (tx: number, ty: number): void => {
    if (!inBounds(state, tx, ty)) return;
    const idx = ty * state.width + tx;
    const tile = state.tiles[idx];
    if (tile?.sidewalk) sidewalk.push(idx);
    else if (tile?.road && !sidewalksOnly) roads.push(idx);
  };
  for (let dx = 0; dx < w; dx++) {
    visit(x + dx, y - 1);
    visit(x + dx, y + h);
  }
  for (let dy = 0; dy < h; dy++) {
    visit(x - 1, y + dy);
    visit(x + w, y + dy);
  }
  return sidewalk.length ? sidewalk : roads;
}

/** 建築的行人出入口格（行人路優先；有快取，道路變更／換局時失效） */
export function walkAccessTiles(state: GameState, building: Building): number[] {
  ensureCacheFor(state);
  const cached = walkAccessCache.get(building.id);
  if (cached) return cached;
  const result = walkTilesAroundFootprint(state, building.x, building.y, building.w, building.h);
  walkAccessCache.set(building.id, result);
  return result;
}

/** 建築是否接上行人網絡（行人路或馬路） */
export function isBuildingWalkConnected(state: GameState, building: Building): boolean {
  return walkAccessTiles(state, building).length > 0;
}

/** 離 (x,y) 最近的道路格；找不到回傳 -1。用於道路被拆後重新接路。 */
export function nearestRoadTile(state: GameState, x: number, y: number, maxRadius = 7): number {
  if (inBounds(state, x, y) && state.tiles[tileIndex(state, x, y)].road) {
    return tileIndex(state, x, y);
  }
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const tx = x + dx;
        const ty = y + dy;
        if (!inBounds(state, tx, ty)) continue;
        if (state.tiles[tileIndex(state, tx, ty)].road) return tileIndex(state, tx, ty);
      }
    }
  }
  return -1;
}

/** 離 (x,y) 最近的行人路／馬路格；找不到回傳 -1。 */
export function nearestWalkableTile(state: GameState, x: number, y: number, maxRadius = 7): number {
  if (inBounds(state, x, y) && isWalkableTile(state, tileIndex(state, x, y))) {
    return tileIndex(state, x, y);
  }
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const tx = x + dx;
        const ty = y + dy;
        if (!inBounds(state, tx, ty)) continue;
        const idx = tileIndex(state, tx, ty);
        if (isWalkableTile(state, idx)) return idx;
      }
    }
  }
  return -1;
}

// ─────────────────────────── 快取 ───────────────────────────

const INF = 0x3fffffff;
/**
 * 快取上限：按地圖面積縮放（304×304=92,416 格約為 96×96 的 10 倍）。
 * 除條目數外亦限制總 path 點數，避免大地圖／長路徑食爆記憶體。
 */
const BASE_CACHE_LIMIT = 16384;
const MAX_PATH_POINTS = 400_000;

/** 依地圖面積調整快取條目上限（92k 格 → 約 52k） */
function cacheLimitFor(state: GameState): number {
  const areaScale = state.tiles.length / (96 * 96);
  return Math.min(65536, Math.round(BASE_CACHE_LIMIT * Math.max(1, Math.sqrt(areaScale))));
}

/** 各 cache 已儲存 path 點數（用於總量上限） */
const cachePoints = { path: 0, link: 0, walk: 0 };
type CacheKind = keyof typeof cachePoints;

let cacheState: GameState | null = null;
/** 車輛道路路徑快取 */
const pathCache = new Map<number, number[] | null>();
/** 建築對建築的道路路徑快取（物流每 20 遊戲分鐘會重複查同一批建築對） */
const linkCache = new Map<string, number[] | null>();
/** 建築對建築的行人路徑快取 */
const walkLinkCache = new Map<string, number[] | null>();

/** 建築臨路／臨行人路格快取（buildingId → tiles）；道路變更或換局時失效 */
const roadAccessCache = new Map<number, number[]>();
const walkAccessCache = new Map<number, number[]>();

function ensureCacheFor(state: GameState): void {
  if (cacheState !== state) {
    cacheState = state;
    pathCache.clear();
    linkCache.clear();
    walkLinkCache.clear();
    roadAccessCache.clear();
    walkAccessCache.clear();
    cachePoints.path = 0;
    cachePoints.link = 0;
    cachePoints.walk = 0;
  }
}

/** 道路或行人路「被拆」後呼叫：所有快取路徑可能失效，全部清空 */
export function invalidatePathCache(): void {
  pathCache.clear();
  linkCache.clear();
  walkLinkCache.clear();
  roadAccessCache.clear();
  walkAccessCache.clear();
  cachePoints.path = 0;
  cachePoints.link = 0;
  cachePoints.walk = 0;
}

/**
 * 道路／行人路「新增」後呼叫：
 * 新增道路只會令更多位置可達，舊 cached path 仍然有效（只可能唔係最短），
 * 所以保留有效路徑，只清「無路（null）」快取同建築臨路格快取。
 * 大幅減少玩家拖曳鋪路時 cache 全清 → A* 重算嘅卡頓。
 */
export function notifyRoadAdded(): void {
  for (const [key, value] of pathCache) if (value === null) pathCache.delete(key);
  for (const [key, value] of linkCache) if (value === null) linkCache.delete(key);
  for (const [key, value] of walkLinkCache) if (value === null) walkLinkCache.delete(key);
  // 臨路格快取會影響建築 connected，必須清（建築數目通常遠少於路徑數，重建成本低）
  roadAccessCache.clear();
  walkAccessCache.clear();
}

/** 將路徑寫入指定 cache（同時管理條目數／總點數上限；超限則整批清空） */
function storeCached(
  kind: CacheKind,
  cache: Map<number | string, number[] | null>,
  key: number | string,
  path: number[] | null,
  state: GameState,
): void {
  const limit = cacheLimitFor(state);
  const points = cachePoints[kind];
  const size = path?.length ?? 0;
  if (cache.size >= limit || points + size > MAX_PATH_POINTS) {
    cache.clear();
    cachePoints[kind] = 0;
  }
  cache.set(key, path);
  cachePoints[kind] = (cachePoints[kind] ?? 0) + size;
}

// ─────────────────────────── A* 核心 ───────────────────────────

export interface RoadPathHit {
  path: number[];
  /** 實際抵達的目標格（多目標時不一定是最後一個） */
  goal: number;
}

/** A* 重用 scratch buffer（每張地圖一套；避免每次搜尋配置大量 typed array） */
interface SearchScratch {
  n: number;
  gen: number;
  gScore: Int32Array;
  prev: Int32Array;
  stamp: Int32Array;
  closedStamp: Int32Array;
  heapNode: Int32Array;
  heapF: Float64Array;
}

let scratch: SearchScratch | null = null;

function scratchFor(n: number): SearchScratch {
  if (!scratch || scratch.n !== n || scratch.gen >= 0x3ffffffe) {
    scratch = {
      n,
      gen: 0,
      gScore: new Int32Array(n),
      prev: new Int32Array(n),
      stamp: new Int32Array(n),
      closedStamp: new Int32Array(n),
      heapNode: new Int32Array(n + 1),
      heapF: new Float64Array(n + 1),
    };
  }
  scratch.gen++;
  return scratch;
}

/**
 * Weighted A* 啟發式權重：大地圖（304）長距離搜尋會展開好多節點，
 * 用 1.25 輕微放寬可大幅減少 expansion（路徑或長 5–15%，遊戲內可接受），
 * 換取 2–4 倍速度。必須 >1 才有效、唔可以太大（否則路徑太差）。
 */
const ROAD_HEURISTIC_WEIGHT = 1.25;
const WALK_HEURISTIC_WEIGHT = 1.15;

function manhattan(state: GameState, a: number, b: number): number {
  const ax = a % state.width;
  const ay = (a / state.width) | 0;
  const bx = b % state.width;
  const by = (b / state.width) | 0;
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

/** 搜尋模式：'road' 只走馬路；'walk' 走行人路＋馬路（行人路較便宜） */
type SearchMode = 'road' | 'walk';

/** 行人進入某格的成本（行人路 1、馬路 3＝過馬路較慢） */
function walkCost(tile: { road: boolean; sidewalk?: boolean }): number {
  return tile.sidewalk ? 1 : 3;
}

/**
 * 多起點／多終點的 A*（四方向）。
 * - road 模式：只有 tile.road 可走；goal 必須是道路格。
 * - walk 模式：tile.road 或 tile.sidewalk 可走；goal 必須可行人。
 * - start 本身不強制可走（市民／車輛可能由建築錨點出發，下一步才接路）。
 * 回傳路徑包含起點與終點格 index。
 */
function search(state: GameState, starts: number[], goals: number[], mode: SearchMode): RoadPathHit | null {
  const { width, height, tiles } = state;
  const n = tiles.length;
  if (!n) return null;

  const passable = (idx: number): boolean => {
    const tile = tiles[idx];
    if (!tile) return false;
    return mode === 'road' ? tile.road : tile.road || !!tile.sidewalk;
  };

  const validGoals: number[] = [];
  for (const g of goals) {
    if (g >= 0 && g < n && passable(g)) validGoals.push(g);
  }
  if (!validGoals.length) return null;

  const goalFlag = new Uint8Array(n);
  for (const g of validGoals) goalFlag[g] = 1;
  const singleGoal = validGoals.length === 1 ? validGoals[0] : -1;

  // 重用 scratch buffer（避免每次搜尋配置 4 個大 typed array；用 generation stamp 免 fill）
  const scratch = scratchFor(n);
  const gScore = scratch.gScore;
  const prev = scratch.prev;
  const stamp = scratch.stamp;
  const closedStamp = scratch.closedStamp;
  const gen = scratch.gen;

  // 二元堆（惰性刪除：彈出時跳過 closed）
  const heapNode = scratch.heapNode;
  const heapF = scratch.heapF;
  let heapSize = 0;

  const push = (node: number, f: number): void => {
    let i = heapSize++;
    heapNode[i] = node;
    heapF[i] = f;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= heapF[i]) break;
      const tn = heapNode[p];
      heapNode[p] = heapNode[i];
      heapNode[i] = tn;
      const tf = heapF[p];
      heapF[p] = heapF[i];
      heapF[i] = tf;
      i = p;
    }
  };

  const pop = (): number => {
    const top = heapNode[0];
    heapSize--;
    if (heapSize > 0) {
      heapNode[0] = heapNode[heapSize];
      heapF[0] = heapF[heapSize];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heapSize && heapF[l] < heapF[m]) m = l;
        if (r < heapSize && heapF[r] < heapF[m]) m = r;
        if (m === i) break;
        const tn = heapNode[m];
        heapNode[m] = heapNode[i];
        heapNode[i] = tn;
        const tf = heapF[m];
        heapF[m] = heapF[i];
        heapF[i] = tf;
        i = m;
      }
    }
    return top;
  };

  const heuristicWeight = mode === 'road' ? ROAD_HEURISTIC_WEIGHT : WALK_HEURISTIC_WEIGHT;
  const heuristic = (node: number): number => {
    // 曼哈頓距離 × 權重（weighted A*：容許稍長路徑換取大幅速度）
    if (singleGoal >= 0) return manhattan(state, node, singleGoal) * heuristicWeight;
    let best = INF;
    for (const g of validGoals) {
      const d = manhattan(state, node, g);
      if (d < best) best = d;
    }
    return best * heuristicWeight;
  };

  for (const s of starts) {
    if (s < 0 || s >= n) continue;
    if (goalFlag[s]) return { path: [s], goal: s };
    if (stamp[s] !== gen) {
      stamp[s] = gen;
      gScore[s] = 0;
      prev[s] = -1;
      push(s, heuristic(s));
    }
  }
  if (heapSize === 0) return null;

  let found = -1;
  while (heapSize > 0) {
    const cur = pop();
    if (closedStamp[cur] === gen) continue;
    closedStamp[cur] = gen;
    if (goalFlag[cur]) {
      found = cur;
      break;
    }
    const cx = cur % width;
    const cy = (cur / width) | 0;
    const curG = gScore[cur];
    // 四方向：北、南、西、東
    for (let dir = 0; dir < 4; dir++) {
      let nb: number;
      if (dir === 0) {
        if (cy === 0) continue;
        nb = cur - width;
      } else if (dir === 1) {
        if (cy === height - 1) continue;
        nb = cur + width;
      } else if (dir === 2) {
        if (cx === 0) continue;
        nb = cur - 1;
      } else {
        if (cx === width - 1) continue;
        nb = cur + 1;
      }
      if (closedStamp[nb] === gen) continue;
      const tile = tiles[nb];
      if (!tile) continue;
      const ok = mode === 'road' ? tile.road : tile.road || !!tile.sidewalk;
      if (!ok) continue;
      const stepCost = mode === 'walk' ? walkCost(tile) : 1;
      const g = curG + stepCost;
      if (stamp[nb] !== gen || g < gScore[nb]) {
        stamp[nb] = gen;
        gScore[nb] = g;
        prev[nb] = cur;
        push(nb, g + heuristic(nb));
      }
    }
  }

  if (found < 0) return null;
  const path: number[] = [];
  let cur = found;
  while (cur !== -1) {
    path.push(cur);
    cur = prev[cur];
    if (path.length > n) return null; // 防禦：不應發生
  }
  path.reverse();
  return { path, goal: found };
}

// ─────────────────────────── 對外查詢（車輛／道路） ───────────────────────────

/**
 * 找最短路徑（回傳包含起點與終點的格 index）。
 * start 可不為道路（例如建築錨點）；goal 必須是道路格。
 */
export function findRoadPath(state: GameState, start: number, goal: number): number[] | null {
  const n = state.tiles.length;
  if (start < 0 || start >= n || goal < 0 || goal >= n) return null;
  if (start === goal) return [start];
  ensureCacheFor(state);
  const key = start * n + goal;
  if (pathCache.has(key)) return pathCache.get(key) ?? null;
  const result = search(state, [start], [goal], 'road');
  const path = result ? result.path : null;
  storeCached('path', pathCache, key, path, state);
  return path;
}

/**
 * 從 start 前往 goals 中「最近」的一個（物流找最近倉庫／市集用）。
 * 回傳路徑與實際抵達的目標格；無路可通回傳 null。
 */
export function findRoadPathToAny(state: GameState, start: number, goals: number[]): RoadPathHit | null {
  const n = state.tiles.length;
  if (start < 0 || start >= n || !goals.length) return null;
  return search(state, [start], goals, 'road');
}

/**
 * 兩棟建築之間經由道路的最短路徑（會各自接上最近的臨路格）。
 * 回傳路徑的第一格是 from 的臨路格、最後一格是 to 的臨路格。
 */
export function findPathBetweenBuildings(state: GameState, fromId: number, toId: number): number[] | null {
  const from = state.buildings.find((b) => b.id === fromId);
  const to = state.buildings.find((b) => b.id === toId);
  if (!from || !to) return null;
  ensureCacheFor(state);
  const key = `${fromId}:${toId}`;
  if (linkCache.has(key)) return linkCache.get(key) ?? null;
  const starts = roadAccessTiles(state, from);
  const goals = roadAccessTiles(state, to);
  if (!starts.length || !goals.length) {
    storeCached('link', linkCache, key, null, state);
    return null;
  }
  const result = search(state, starts, goals, 'road');
  const path = result?.path ?? null;
  storeCached('link', linkCache, key, path, state);
  return path;
}

// ─────────────────────────── 對外查詢（行人） ───────────────────────────

/**
 * 行人最短路徑（行人路優先，仍可過馬路）。
 * start 可不為可行人格（例如建築錨點）；goal 必須在行人網絡上。
 */
export function findWalkPath(state: GameState, start: number, goal: number): number[] | null {
  const n = state.tiles.length;
  if (start < 0 || start >= n || goal < 0 || goal >= n) return null;
  if (!isWalkableTile(state, goal)) return null;
  if (start === goal) return [start];
  const result = search(state, [start], [goal], 'walk');
  return result?.path ?? null;
}

/** 行人多目標最近路徑（找最近公園／商場／車站等） */
export function findWalkPathToAny(state: GameState, start: number, goals: number[]): RoadPathHit | null {
  const n = state.tiles.length;
  if (start < 0 || start >= n || !goals.length) return null;
  return search(state, [start], goals, 'walk');
}

/** 兩棟建築之間經由行人路／馬路的最短路徑（行人路優先） */
export function findWalkPathBetweenBuildings(
  state: GameState,
  fromId: number,
  toId: number,
): number[] | null {
  const from = state.buildings.find((b) => b.id === fromId);
  const to = state.buildings.find((b) => b.id === toId);
  if (!from || !to) return null;
  ensureCacheFor(state);
  const key = `${fromId}:${toId}`;
  if (walkLinkCache.has(key)) return walkLinkCache.get(key) ?? null;
  const starts = walkAccessTiles(state, from);
  const goals = walkAccessTiles(state, to);
  let path: number[] | null = null;
  if (starts.length && goals.length) {
    path = search(state, starts, goals, 'walk')?.path ?? null;
  }
  if (!path) path = findPathBetweenBuildings(state, fromId, toId);
  storeCached('walk', walkLinkCache, key, path, state);
  return path;
}

/** 取得一棟建築的「物流錨點」：第一個臨路格，沒有則回傳建築中心格 */
export function buildingAnchorTile(state: GameState, building: Building): number {
  const access = roadAccessTiles(state, building);
  if (access.length) return access[0];
  return tileIndex(
    state,
    Math.min(state.width - 1, building.x + Math.floor(building.w / 2)),
    Math.min(state.height - 1, building.y + Math.floor(building.h / 2)),
  );
}

/** 取得一棟建築的「行人錨點」：第一個行人路格，其次馬路格，最後建築中心格 */
export function buildingWalkAnchorTile(state: GameState, building: Building): number {
  const access = walkAccessTiles(state, building);
  if (access.length) return access[0];
  return buildingAnchorTile(state, building);
}
