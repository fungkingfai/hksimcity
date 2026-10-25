/**
 * 港鐵鐵路網（Issue #5／Round 6 MVP）：地面／高架／地下鐵路規劃、路網連通、
 * 每日乘客與票價、每月維護費、列車路線。
 *
 * 對外契約（Lead 會喺 main.ts applyToolAt 接 `rail:*` 工具；render 另有任務）：
 *   placeRail(state, x, y, grade): RailPlaceResult
 *   removeRail(state, x, y): RailPlaceResult
 *   canPlaceRail(state, x, y, grade): RailPlaceResult
 *   isRailTool(tool) / railToolGrade(tool) / isRailRemoveTool(tool)
 *   computeRailNetwork(state, force?): RailNetworkSummary
 *   tickRail(state, ctx): RailTickSummary                // 每日（tickTransit 會自動呼叫）
 *   railUpkeepMonthly(state): number                     // 交 finance 月結加（見下）
 *   railConnectedStations(state): Building[]
 *   railStationAccessTiles(state, building): number[]
 *   nearestRailAccess(state, x, y, maxRadius?): number
 *   railTrainRoutes(state): RailTrainRoute[]             // vehicles.ts 派車用
 *   getRailStats(state): RailStats（UI 用）
 *
 * 圖層／成本
 * - 鐵路係獨立圖層（`tile.rail`），可以同道路／行人路／管線／建築共存。
 * - 造價／維護用 `RAIL_INFO[grade]`；放置扣庫房並記入 infrastructure；拆除退 30%。
 * - 地形：surface 只可陸地（不可水／山地）；elevated／underground 可跨水；
 *   underground 亦可穿越山地（隧道）。路基與分區無關。
 *
 * 連通與營運（MVP）
 * - 4 鄰接 rail tile 做 BFS 連通分量；`mtrStation.railStation` 建築若腳下或四鄰有 rail
 *   即為 connected station，否則 isolated（舊半徑玩法仍運作，但覆蓋率 × RAIL_CONFIG.isolatedStationCoverage）。
 * - 每日乘客 = Σ connectedStations × baseRidershipPerStation × 等級天氣係數
 *              + Σ 各 grade 軌道長 × ridershipPerTrackTile × 等級天氣係數
 *   cap = connectedStations × 900（每站容量），再 ×0.95 上限。
 * - 颱風：地下段維持 80%，地面／高架 50%；其他天氣用 WEATHER_EFFECT[weather].transit
 *   （地下段最少 90%）。
 * - 票價收入由 tickRail 入帳：`transit.byMode.mtr`、`transit.faresThisMonth`、
 *   `finance.treasury / incomeThisMonth / incomeBreakdown.fares`；
 *   **同 transit.ts 舊 mtr 半徑玩法以 70/30 split**（rail 為主、舊半徑保留 30%），
 *   `tickTransit` 只補舊半徑部分，避免 double count。
 * - 鐵路維護費：`railUpkeepMonthly(state)` 交 finance 月結加入 expense（infrastructure）；
 *   mtrStation 本身 upkeep 已由 totalUpkeep 計，唔會重複。
 *
 * 註：`GameState.railNetwork` optional 欄位由 Lead 加；未加前本檔會以安全方式寫入
 *     （runtime 只影響存檔體積，可接受；同時有 module cache）。
 */

import { BUILDINGS, RAIL_CONFIG, RAIL_INFO, RAIL_TOOLS, WEATHER_EFFECT } from '../core/config';
import type { Building, GameState, RailGrade, RailNetworkSnapshot, SimContext } from '../core/types';
import { markWorldChanged, worldRevisionOf } from './placement';

// ─────────────────────────── 常數 ───────────────────────────

/** 放置結果（沿用 PlaceResult 形狀，另加 refund） */
export interface RailPlaceResult {
  ok: boolean;
  reason?: string;
  cost: number;
  refund?: number;
}

/** 鐵路等級順序（統計／UI 穩定） */
export const RAIL_GRADES: RailGrade[] = ['surface', 'elevated', 'underground'];

/** 颱風時列車／乘客維持比率 */
const STORM_UNDERGROUND_FACTOR = 0.8;
const STORM_GROUND_FACTOR = 0.5;
/** 非颱風時地下段最低天氣係數（地底影響較細） */
const NORMAL_UNDERGROUND_MIN_FACTOR = 0.9;

/** 有鐵路網絡時，舊 mtr 半徑玩法只保留 30%（同 bus lines 70/30 一致） */
const RAIL_LEGACY_MTR_SHARE = 0.3;

/** 每日乘客上限係每站容量的比率 */
const RAIL_CAPACITY_RATIO = 0.95;

/** 車站地面接觸判定：腳下或四鄰 */
const STATION_ACCESS_RADIUS = 1;

/**
 * 鐵路圖層變更版本（只有 placeRail／removeRail／外部 hydrate 會遞增）。
 * 用嚟避免每日重掃 480×480 = 23 萬格 tiles（掃一次約 12ms），亦避免建築／道路
 * 變更無謂地令鐵路網重算。
 */
let railRevision = 0;

/** 目前鐵路圖層版本 */
export function railRevisionOf(): number {
  return railRevision;
}

/**
 * 外部直接改過 `tile.rail`（例如 Lead 嘅 starter 預建／存檔 hydrate）之後呼叫，
 * 令鐵路網快取失效。正常玩家操作 placeRail／removeRail 已自動遞增，毋須手動 call。
 */
export function invalidateRailCache(): void {
  railRevision++;
}

// ─────────────────────────── 工具 ───────────────────────────

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function inBounds(state: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < state.width && y < state.height;
}

function tileIndex(state: GameState, x: number, y: number): number {
  return y * state.width + x;
}

function tileXY(state: GameState, index: number): { x: number; y: number } {
  return { x: index % state.width, y: Math.floor(index / state.width) };
}

function isRailGrade(value: unknown): value is RailGrade {
  return value === 'surface' || value === 'elevated' || value === 'underground';
}

/** 工具字串是否鐵路工具（'rail:surface' / 'rail:elevated' / 'rail:underground' / 'rail:remove'） */
export function isRailTool(tool: string | null | undefined): boolean {
  return typeof tool === 'string' && (RAIL_TOOLS as readonly string[]).includes(tool);
}

/** 由 'rail:surface' 取得 grade；非鋪軌工具回傳 null */
export function railToolGrade(tool: string | null | undefined): RailGrade | null {
  if (typeof tool !== 'string' || !tool.startsWith('rail:')) return null;
  const grade = tool.slice('rail:'.length);
  return isRailGrade(grade) ? grade : null;
}

/** 是否鐵路拆除工具 */
export function isRailRemoveTool(tool: string | null | undefined): boolean {
  return tool === 'rail:remove';
}

/** 車站是否鐵路站（def.railStation） */
function isRailStation(building: Building): boolean {
  return !!BUILDINGS[building.key]?.railStation;
}

/** 建築佔地範圍內嘅 tile index */
function footprintTiles(state: GameState, building: Building): number[] {
  const result: number[] = [];
  for (let dy = 0; dy < building.h; dy++) {
    for (let dx = 0; dx < building.w; dx++) {
      const x = building.x + dx;
      const y = building.y + dy;
      if (inBounds(state, x, y)) result.push(tileIndex(state, x, y));
    }
  }
  return result;
}

/** 車站腳下或四鄰嘅 rail tile（已去重，只回傳有 rail 嘅格） */
export function railStationAccessTiles(state: GameState, building: Building): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  const push = (x: number, y: number): void => {
    if (!inBounds(state, x, y)) return;
    const index = tileIndex(state, x, y);
    if (seen.has(index)) return;
    if (!state.tiles[index]?.rail) return;
    seen.add(index);
    result.push(index);
  };
  // 佔地內（車站直接起喺軌道上／鐵路預留位）
  for (const index of footprintTiles(state, building)) {
    const { x, y } = tileXY(state, index);
    push(x, y);
  }
  // 四鄰（車站貼住路軌）
  for (let dx = 0; dx < building.w; dx++) {
    push(building.x + dx, building.y - STATION_ACCESS_RADIUS);
    push(building.x + dx, building.y + building.h - 1 + STATION_ACCESS_RADIUS);
  }
  for (let dy = 0; dy < building.h; dy++) {
    push(building.x - STATION_ACCESS_RADIUS, building.y + dy);
    push(building.x + building.w - 1 + STATION_ACCESS_RADIUS, building.y + dy);
  }
  return result;
}

// ─────────────────────────── 鋪設／拆除 ───────────────────────────

function railPlacementError(state: GameState, x: number, y: number, grade: RailGrade): string | null {
  if (!inBounds(state, x, y)) return '超出地圖範圍';
  const tile = state.tiles[tileIndex(state, x, y)];
  if (!tile) return '地塊不存在';
  if (tile.rail) return '呢格已經有鐵路（用拆除工具改動）';
  if (grade === 'surface') {
    if (tile.terrain === 'water') return '地面鐵路唔可以跨水，請用高架或地下鐵路';
    if (tile.terrain === 'mountain') return '山地要用地底隧道（地下鐵路）或高架鐵路';
  }
  return null;
}

/** 預檢鐵路可否鋪設（UI 幽靈預覽／main 可用；唔會扣錢） */
export function canPlaceRail(state: GameState, x: number, y: number, grade: RailGrade): RailPlaceResult {
  if (!isRailGrade(grade)) return { ok: false, reason: '鐵路等級唔啱', cost: 0 };
  const error = railPlacementError(state, x, y, grade);
  const info = RAIL_INFO[grade];
  if (error) return { ok: false, reason: error, cost: 0 };
  if (state.finance.treasury < info.cost) {
    return { ok: false, reason: `庫房不足：${info.name}每格 $${info.cost.toLocaleString('zh-HK')}`, cost: info.cost };
  }
  return { ok: true, cost: info.cost };
}

/**
 * 鋪設一格鐵路（獨立圖層，可與道路／管線／建築共存）。
 * 扣庫房並記入 finance.expenseBreakdown.infrastructure；成功會 markWorldChanged()。
 */
export function placeRail(state: GameState, x: number, y: number, grade: RailGrade): RailPlaceResult {
  if (!isRailGrade(grade)) return { ok: false, reason: '鐵路等級唔啱', cost: 0 };
  const error = railPlacementError(state, x, y, grade);
  const info = RAIL_INFO[grade];
  if (error) return { ok: false, reason: error, cost: 0 };
  if (state.finance.treasury < info.cost) {
    return { ok: false, reason: `庫房不足：${info.name}每格 $${info.cost.toLocaleString('zh-HK')}`, cost: info.cost };
  }
  const tile = state.tiles[tileIndex(state, x, y)];
  tile.rail = grade;
  railRevision++;
  state.finance.treasury -= info.cost;
  state.finance.expenseThisMonth += info.cost;
  state.finance.expenseBreakdown.infrastructure =
    (state.finance.expenseBreakdown.infrastructure ?? 0) + info.cost;
  markWorldChanged();
  return { ok: true, cost: info.cost };
}

/**
 * 拆除一格鐵路；退還 30%（同建築／道路拆除比率一致），退款沖減本月基建支出。
 */
export function removeRail(state: GameState, x: number, y: number): RailPlaceResult {
  if (!inBounds(state, x, y)) return { ok: false, reason: '超出地圖範圍', cost: 0 };
  const tile = state.tiles[tileIndex(state, x, y)];
  if (!tile?.rail) return { ok: false, reason: '呢格冇鐵路', cost: 0 };
  const info = RAIL_INFO[tile.rail];
  const refund = Math.round(info.cost * 0.3);
  delete tile.rail;
  railRevision++;
  state.finance.treasury += refund;
  const infra = state.finance.expenseBreakdown.infrastructure ?? 0;
  const applied = Math.min(infra, refund);
  state.finance.expenseBreakdown.infrastructure = infra - applied;
  state.finance.expenseThisMonth = Math.max(0, state.finance.expenseThisMonth - applied);
  markWorldChanged();
  // main.ts 拆除提示沿用 PlaceResult.cost 顯示退款，所以 cost 同 refund 都填退款額
  return { ok: true, cost: refund, refund };
}

// ─────────────────────────── 路網連通 ───────────────────────────

/** 單一連通分量 */
export interface RailComponentInfo {
  id: number;
  /** 分量內嘅 rail tile index（排序後） */
  tiles: number[];
  length: number;
  gradeCounts: Record<RailGrade, number>;
  /** 接駁到此分量嘅 mtrStation building id（腳下／四鄰有 rail） */
  stationIds: number[];
  /** 此分量接駁嘅車站數（≥2 才算有效鐵路段） */
  connectedStations: number;
}

/** 路網快照（每日／改變後重算；亦會寫入 state.railNetwork 方便 UI） */
export interface RailNetworkSummary {
  /** worldRevision + buildings.length 簽章（內部快取用） */
  signature: string;
  /** worldRevision 數字（寫入 state.railNetwork 用） */
  revision: number;
  length: number;
  gradeCounts: Record<RailGrade, number>;
  components: RailComponentInfo[];
  /** 所有 mtrStation 數目（已建成） */
  stations: number;
  /** 已接駁有效鐵路段（同分量 ≥2 站）嘅車站數 */
  connectedStations: number;
  /** 孤立車站數（未接軌或只係單站分量） */
  isolatedStations: number;
  connectedStationIds: number[];
  isolatedStationIds: number[];
  /** 已接駁車站每日容量（connectedStations × 900） */
  capacity: number;
  /** 未計天氣嘅理論每日乘客（base + track） */
  networkRidership: number;
  maxComponentLength: number;
  updatedDay: number;
}

interface RailRuntime {
  network: { signature: string; summary: RailNetworkSummary } | null;
  tick: { day: number; summary: RailTickSummary } | null;
  routes: { signature: string; routes: RailTrainRoute[] } | null;
  /** rail tile index 清單（只在 railRevision 改變時重掃） */
  railTiles: { revision: number; tiles: number[] } | null;
  /** 連通分量（只在 railRevision 改變時重算） */
  components: {
    revision: number;
    components: RailComponentInfo[];
    gradeCounts: Record<RailGrade, number>;
    length: number;
  } | null;
}

const runtimes = new WeakMap<GameState, RailRuntime>();

function runtimeOf(state: GameState): RailRuntime {
  let rt = runtimes.get(state);
  if (!rt) {
    rt = { network: null, tick: null, routes: null, railTiles: null, components: null };
    runtimes.set(state, rt);
  }
  return rt;
}

function networkSignature(state: GameState): string {
  return `${railRevision}:${state.buildings.length}`;
}

function emptyGradeCounts(): Record<RailGrade, number> {
  return { surface: 0, elevated: 0, underground: 0 };
}

/**
 * 計算鐵路網：4 鄰接 BFS 連通分量、各 grade 長度、已接駁／孤立車站。
 * 結果有快取（worldRevision + 建築數）；tickRail 每日會強制重算。
 */
export function computeRailNetwork(state: GameState, force = false): RailNetworkSummary {
  const rt = runtimeOf(state);
  const signature = networkSignature(state);
  if (!force && rt.network && rt.network.signature === signature) return rt.network.summary;

  // ── 1) rail tile 清單（只在 railRevision 改變時掃 tiles，避免每日 12ms 全圖掃描） ──
  if (!rt.railTiles || rt.railTiles.revision !== railRevision) {
    const tiles: number[] = [];
    const allTiles = state.tiles;
    for (let i = 0; i < allTiles.length; i++) {
      if (allTiles[i].rail) tiles.push(i);
    }
    rt.railTiles = { revision: railRevision, tiles };
    rt.components = null;
    rt.routes = null;
  }

  // ── 2) 4 鄰接連通分量（只在 railRevision 改變時重算；與建築增減無關） ──
  if (!rt.components || rt.components.revision !== railRevision) {
    const railSet = new Set(rt.railTiles.tiles);
    const visited = new Set<number>();
    const components: RailComponentInfo[] = [];
    const gradeCounts = emptyGradeCounts();
    let length = 0;
    const maxQueue = Math.max(16, rt.railTiles.tiles.length + 1);
    const queue = new Int32Array(maxQueue);
    for (const start of rt.railTiles.tiles) {
      if (visited.has(start)) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      visited.add(start);
      const tiles: number[] = [];
      const counts = emptyGradeCounts();
      while (head < tail) {
        const cur = queue[head++];
        tiles.push(cur);
        const g = state.tiles[cur]?.rail;
        if (g) counts[g]++;
        const x = cur % state.width;
        const y = Math.floor(cur / state.width);
        const neighbors = [
          y > 0 ? cur - state.width : -1,
          y < state.height - 1 ? cur + state.width : -1,
          x > 0 ? cur - 1 : -1,
          x < state.width - 1 ? cur + 1 : -1,
        ];
        for (const next of neighbors) {
          if (next < 0 || visited.has(next) || !railSet.has(next)) continue;
          visited.add(next);
          queue[tail++] = next;
        }
      }
      tiles.sort((a, b) => a - b);
      components.push({
        id: components.length,
        tiles,
        length: tiles.length,
        gradeCounts: counts,
        stationIds: [],
        connectedStations: 0,
      });
      length += tiles.length;
      for (const g of RAIL_GRADES) gradeCounts[g] += counts[g];
    }
    components.sort((a, b) => b.length - a.length);
    for (let i = 0; i < components.length; i++) components[i].id = i;
    rt.components = { revision: railRevision, components, gradeCounts, length };
    rt.routes = null;
  }
  const components = rt.components.components;
  const gradeCounts = rt.components.gradeCounts;
  const length = rt.components.length;

  // 車站接駁判定：railStation 建築腳下／四鄰有 rail → 所屬分量
  const stations = state.buildings.filter(isRailStation);
  const tileToComponent = new Map<number, number>();
  for (const component of components) for (const index of component.tiles) tileToComponent.set(index, component.id);

  /** station id → 佢接駁到嘅分量 id（可能多過一個，例如兩條平行線） */
  const stationComponents = new Map<number, Set<number>>();
  for (const station of stations) {
    const access = railStationAccessTiles(state, station);
    const componentIds = new Set<number>();
    for (const index of access) {
      const id = tileToComponent.get(index);
      if (id !== undefined) componentIds.add(id);
    }
    stationComponents.set(station.id, componentIds);
    for (const id of componentIds) {
      const component = components[id];
      if (component) component.stationIds.push(station.id);
    }
  }
  for (const component of components) {
    component.stationIds.sort((a, b) => a - b);
    component.connectedStations = component.stationIds.length;
  }

  // 有效鐵路段：同一分量有 ≥2 個車站（單站短樁未成線 → 當孤立）
  const connectedStationIds: number[] = [];
  const isolatedStationIds: number[] = [];
  for (const station of stations) {
    const componentIds = stationComponents.get(station.id) ?? new Set<number>();
    const usable = [...componentIds].some((id) => (components[id]?.stationIds.length ?? 0) >= 2);
    if (usable) connectedStationIds.push(station.id);
    else isolatedStationIds.push(station.id);
  }
  connectedStationIds.sort((a, b) => a - b);
  isolatedStationIds.sort((a, b) => a - b);

  const networkRidership = Math.round(
    connectedStationIds.length * RAIL_CONFIG.baseRidershipPerStation +
      length * RAIL_CONFIG.ridershipPerTrackTile,
  );
  const revision = worldRevisionOf();
  const summary: RailNetworkSummary = {
    signature,
    revision,
    length,
    gradeCounts,
    components,
    stations: stations.length,
    connectedStations: connectedStationIds.length,
    isolatedStations: isolatedStationIds.length,
    connectedStationIds,
    isolatedStationIds,
    capacity: connectedStationIds.length * 900,
    networkRidership,
    maxComponentLength: components[0]?.length ?? 0,
    updatedDay: state.clock.totalDays,
  };
  rt.network = { signature, summary };
  rt.routes = null; // 路網一變，列車路線快取失效

  // 寫入 GameState.railNetwork（Lead 已加 optional type；UI／save 可讀）
  let upkeep = 0;
  for (const grade of RAIL_GRADES) upkeep += gradeCounts[grade] * RAIL_INFO[grade].upkeep;
  upkeep += connectedStationIds.length * RAIL_CONFIG.stationUpkeep;
  upkeep += length * RAIL_CONFIG.trackUpkeep;
  const snapshot: RailNetworkSnapshot = {
    revision,
    gradeCounts: { ...gradeCounts },
    totalLength: length,
    components: components.length,
    largestComponent: components[0]?.length ?? 0,
    stations: stations.length,
    connectedStations: connectedStationIds.length,
    isolatedStations: isolatedStationIds.length,
    ridership: networkRidership,
    upkeep: Math.round(upkeep),
  };
  state.railNetwork = snapshot;
  return summary;
}

/** 已接駁鐵路嘅 mtrStation（active 且腳下／四鄰有 rail） */
export function railConnectedStations(state: GameState): Building[] {
  const network = computeRailNetwork(state);
  const ids = new Set(network.connectedStationIds);
  const result: Building[] = [];
  for (const building of state.buildings) {
    if (!isRailStation(building)) continue;
    if (ids.has(building.id)) result.push(building);
  }
  return result;
}

/** 離 (x,y) 最近的 rail tile index；冇就 -1 */
export function nearestRailAccess(state: GameState, x: number, y: number, maxRadius = 7): number {
  if (!inBounds(state, x, y)) return -1;
  const start = tileIndex(state, x, y);
  if (state.tiles[start]?.rail) return start;
  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(state, nx, ny)) continue;
        const index = tileIndex(state, nx, ny);
        if (state.tiles[index]?.rail) return index;
      }
    }
  }
  return -1;
}

// ─────────────────────────── 每日營運 ───────────────────────────

export interface RailTickSummary {
  day: number;
  length: number;
  connectedStations: number;
  isolatedStations: number;
  ridership: number;
  fares: number;
  capacity: number;
  upkeepMonthly: number;
  /** 地下／地面嘅天氣係數（UI 顯示） */
  undergroundFactor: number;
  groundFactor: number;
}

/** 各 grade 嘅天氣係數：颱風地下 80%／地面 50%；其他天氣用 transit 係數（地下最少 90%） */
function gradeWeatherFactors(state: GameState): { underground: number; ground: number } {
  const stormy = state.clock.weather === 'storm';
  const base = Math.max(0.2, WEATHER_EFFECT[state.clock.weather]?.transit ?? 1);
  if (stormy) return { underground: STORM_UNDERGROUND_FACTOR, ground: STORM_GROUND_FACTOR };
  return {
    underground: Math.max(NORMAL_UNDERGROUND_MIN_FACTOR, base),
    ground: Math.max(0.5, base),
  };
}

/** 車站天氣係數：其接駁軌道有 underground 就當地底 */
function stationGradeFactor(state: GameState, station: Building, factors: { underground: number; ground: number }): number {
  const access = railStationAccessTiles(state, station);
  for (const index of access) {
    if (state.tiles[index]?.rail === 'underground') return factors.underground;
  }
  return factors.ground;
}

/**
 * 計算鐵路每日營運（每日一次，tickTransit 會自動呼叫；同日 idempotent）。
 * 票價收入即時入 transit／finance；維護費唔喺呢度扣（由 finance 月結用 railUpkeepMonthly）。
 */
export function tickRail(state: GameState, ctx: SimContext): RailTickSummary {
  const rt = runtimeOf(state);
  const network = computeRailNetwork(state);
  const factors = gradeWeatherFactors(state);
  const upkeepMonthly = railUpkeepMonthly(state);

  if (rt.tick && rt.tick.day === state.clock.totalDays) return rt.tick.summary;

  let stationRidership = 0;
  for (const stationId of network.connectedStationIds) {
    const station = state.buildings.find((building) => building.id === stationId);
    if (!station) continue;
    stationRidership += RAIL_CONFIG.baseRidershipPerStation * stationGradeFactor(state, station, factors);
  }
  let trackRidership = 0;
  for (const grade of RAIL_GRADES) {
    const factor = grade === 'underground' ? factors.underground : factors.ground;
    trackRidership += network.gradeCounts[grade] * RAIL_CONFIG.ridershipPerTrackTile * factor;
  }
  const capacity = network.capacity;
  const raw = stationRidership + trackRidership;
  const ridership = capacity > 0 ? Math.round(Math.min(raw, capacity * RAIL_CAPACITY_RATIO)) : 0;
  const fares = ridership * RAIL_CONFIG.farePerRide;

  if (ridership > 0) {
    // 票價收入入帳（tickTransit 之後只補舊半徑 30% 部分，唔會 double count）
    state.transit.byMode.mtr = ridership;
    state.transit.faresThisMonth = Math.round((state.transit.faresThisMonth ?? 0) + fares);
    state.finance.treasury += fares;
    state.finance.incomeThisMonth += fares;
    state.finance.incomeBreakdown.fares = (state.finance.incomeBreakdown.fares ?? 0) + fares;
  }

  // stats（railStations / railLength 已有型別；mtrCoverage 型別未加，安全寫入）
  state.stats.railStations = network.connectedStations;
  state.stats.railLength = network.length;
  const stationTotal = network.stations;
  (state.stats as typeof state.stats & { mtrCoverage?: number }).mtrCoverage =
    stationTotal > 0 ? Math.round((network.connectedStations / stationTotal) * 1000) / 1000 : 0;

  const summary: RailTickSummary = {
    day: state.clock.totalDays,
    length: network.length,
    connectedStations: network.connectedStations,
    isolatedStations: network.isolatedStations,
    ridership,
    fares,
    capacity,
    upkeepMonthly,
    undergroundFactor: factors.underground,
    groundFactor: factors.ground,
  };
  rt.tick = { day: state.clock.totalDays, summary };

  // 首次接駁成網提示（每 5 日節流）
  if (network.connectedStations > 0 && network.length > 0 && state.clock.totalDays % 5 === 0) {
    const stationNote = network.isolatedStations > 0 ? `，另有 ${network.isolatedStations} 個站未接駁` : '';
    ctx.log(
      `港鐵鐵路網：${network.length} 格軌道、${network.connectedStations} 個車站已接駁${stationNote}；每日約 ${ridership.toLocaleString('zh-HK')} 人次。`,
      'good',
    );
  }
  return summary;
}

/**
 * 鐵路每月維護費 = 各 grade 軌道格數 × RAIL_INFO.upkeep + 已接駁車站 × stationUpkeep。
 * 交 finance 月結加入 expense（infrastructure）；本檔唔會重複扣。
 * （mtrStation 本身建築 upkeep 由 totalUpkeep 計，唔包括喺呢度以外嘅重複。）
 */
export function railUpkeepMonthly(state: GameState): number {
  const network = computeRailNetwork(state);
  let upkeep = 0;
  for (const grade of RAIL_GRADES) {
    upkeep += network.gradeCounts[grade] * RAIL_INFO[grade].upkeep;
  }
  upkeep += network.connectedStations * RAIL_CONFIG.stationUpkeep;
  upkeep += network.length * RAIL_CONFIG.trackUpkeep;
  return Math.round(upkeep);
}

/** UI／月報用鐵路統計 */
export interface RailStats {
  length: number;
  gradeCounts: Record<RailGrade, number>;
  components: number;
  stations: number;
  connectedStations: number;
  isolatedStations: number;
  capacity: number;
  ridership: number;
  fares: number;
  upkeepMonthly: number;
  maxComponentLength: number;
}

export function getRailStats(state: GameState): RailStats {
  const network = computeRailNetwork(state);
  const rt = runtimeOf(state);
  const summary = rt.tick && rt.tick.day === state.clock.totalDays ? rt.tick.summary : null;
  return {
    length: network.length,
    gradeCounts: { ...network.gradeCounts },
    components: network.components.length,
    stations: network.stations,
    connectedStations: network.connectedStations,
    isolatedStations: network.isolatedStations,
    capacity: network.capacity,
    ridership: summary?.ridership ?? 0,
    fares: summary?.fares ?? 0,
    upkeepMonthly: railUpkeepMonthly(state),
    maxComponentLength: network.maxComponentLength,
  };
}

// ─────────────────────────── 列車路線（vehicles.ts 用） ───────────────────────────

export interface RailTrainRoute {
  /** 對應 rail 連通分量 id */
  componentId: number;
  /** 沿 rail tile 嘅路徑（頭尾係車站／端點） */
  path: number[];
  /** 此分量已接駁車站數 */
  stations: number;
  /** 建議列車數（每分量 1–3） */
  trains: number;
  /** 分量是否全程地下（render／天氣用） */
  undergroundOnly: boolean;
}

/** 由 start 沿 rail tile BFS 到 goal，回傳包含頭尾嘅 tile path（同分量內） */
function railPathBetween(state: GameState, start: number, goal: number): number[] | null {
  if (start === goal) return [start];
  const total = state.tiles.length;
  const parent = new Int32Array(total).fill(-1);
  const visited = new Uint8Array(total);
  const queue = new Int32Array(Math.max(16, total));
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  visited[start] = 1;
  while (head < tail) {
    const cur = queue[head++];
    if (cur === goal) {
      const path: number[] = [];
      let node = cur;
      while (node !== -1) {
        path.push(node);
        node = parent[node];
      }
      path.reverse();
      return path;
    }
    const x = cur % state.width;
    const y = Math.floor(cur / state.width);
    const neighbors = [
      y > 0 ? cur - state.width : -1,
      y < state.height - 1 ? cur + state.width : -1,
      x > 0 ? cur - 1 : -1,
      x < state.width - 1 ? cur + 1 : -1,
    ];
    for (const next of neighbors) {
      if (next < 0 || visited[next]) continue;
      if (!state.tiles[next]?.rail) continue;
      visited[next] = 1;
      parent[next] = cur;
      queue[tail++] = next;
    }
  }
  return null;
}

/**
 * 為每個「≥2 個已接駁車站且長度 ≥3」的連通分量產生列車路線。
 * 用頭兩個站之間嘅最短 rail path；結果有快取（路網簽章）。
 */
export function railTrainRoutes(state: GameState): RailTrainRoute[] {
  const network = computeRailNetwork(state);
  const rt = runtimeOf(state);
  if (rt.routes && rt.routes.signature === network.signature) return rt.routes.routes;

  const routes: RailTrainRoute[] = [];
  for (const component of network.components) {
    if (component.length < 3 || component.connectedStations < 2) continue;
    const stationBuildings = component.stationIds
      .map((id) => state.buildings.find((building) => building.id === id))
      .filter((building): building is Building => !!building);
    const a = stationBuildings[0] ? railStationAccessTiles(state, stationBuildings[0])[0] : undefined;
    const b = stationBuildings[1] ? railStationAccessTiles(state, stationBuildings[1])[0] : undefined;
    if (a === undefined || b === undefined) continue;
    const path = railPathBetween(state, a, b);
    if (!path || path.length < 2) continue;
    const trains = clamp(component.connectedStations, 1, 3);
    routes.push({
      componentId: component.id,
      path,
      stations: component.connectedStations,
      trains,
      undergroundOnly: component.gradeCounts.underground === component.length,
    });
  }
  rt.routes = { signature: network.signature, routes };
  return routes;
}
