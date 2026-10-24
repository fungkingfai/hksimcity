/**
 * 地下公用設施管網（Round 5）：食水／污水／電力。
 *
 * 設計原則（見 docs/ROUND5_CONTRACTS.md 第 2 節）：
 *   - 玩家真正鋪設地下管道／電纜（Tile.waterPipe／sewerPipe／powerCable），有成本、月維護、接駁規則。
 *   - 不做流體模擬：以「sparse pipe index + BFS 連通分量 + 容量池」代替。
 *   - 每日結算一次，結果寫入 state.utilities；UI／stats 直接讀 snapshot。
 *   - 建築接駁：footprint 任一格或四鄰有同類管道，且該管道屬「由可用 source 出發的連通分量」。
 *   - 全城未有同類 source → self-supply bootstrap（UTILITY_FALLBACK.noSource）。
 *   - 有 source 但未接駁 → UTILITY_FALLBACK.unconnected；容量不足 → capacityFloor + (1-floor)*supplyRatio。
 *
 * 效能：600×600（360,000 格）唔可以每次掃全部 tiles；管網以 Uint8Array bitwise 索引
 * （pipes index 首次建立掃一次，之後 placePipe／removePipe／layStarterPipes 增量更新），
 * BFS 只行有管嘅格。snapshot 以 worldRevision 作快取簽章。
 */

import {
  BUILDINGS,
  PIPE_INFO,
  TERRAIN_INFO,
  UTILITY_DEMAND,
  UTILITY_FALLBACK,
  pipeMonthlyUpkeep,
} from '../core/config';
import type {
  Building,
  GameState,
  PlaceResult,
  Tile,
  UtilityKind,
  UtilityNetworkStat,
  UtilitySnapshot,
} from '../core/types';
import { buildingFootprintTiles, markWorldChanged, worldRevisionOf } from './placement';

// ─────────────────────────── 管道種類與常數 ───────────────────────────

/** 管道種類（sewer = 污水管；對應服務 kind = sewage） */
export type PipeKind = 'water' | 'sewer' | 'power';

/** 管道 bit（Uint8Array index） */
const PIPE_BIT: Record<PipeKind, number> = { water: 1, sewer: 2, power: 4 };

/** 服務 kind ↔ 管道 kind 對應 */
const PIPE_KIND_OF_SERVICE: Record<UtilityKind, PipeKind> = {
  water: 'water',
  sewage: 'sewer',
  power: 'power',
};

/** 可鋪管的地形黑名單（合約：不可 water／mountain／sand／wetland） */
const PIPE_FORBIDDEN_TERRAIN = new Set(['water', 'mountain', 'sand', 'wetland']);

/** 服務 kind → config 需求 key */
const DEMAND_KEY: Record<UtilityKind, 'water' | 'sewage' | 'power'> = {
  water: 'water',
  sewage: 'sewage',
  power: 'power',
};

const round2 = (v: number): number => Math.round(v * 100) / 100;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ─────────────────────────── 管網索引（sparse bit index） ───────────────────────────

interface PipeBook {
  bits: Uint8Array;
  water: number;
  sewer: number;
  power: number;
}

const pipeBooks = new WeakMap<GameState, PipeBook>();

/** 由 tiles 建 pipe index（首次 O(n) 一次；之後增量更新） */
function buildPipeBook(state: GameState): PipeBook {
  const bits = new Uint8Array(state.tiles.length);
  let water = 0;
  let sewer = 0;
  let power = 0;
  const tiles = state.tiles;
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    let bit = 0;
    if (tile.waterPipe) {
      bit |= PIPE_BIT.water;
      water++;
    }
    if (tile.sewerPipe) {
      bit |= PIPE_BIT.sewer;
      sewer++;
    }
    if (tile.powerCable) {
      bit |= PIPE_BIT.power;
      power++;
    }
    if (bit) bits[i] = bit;
  }
  const book: PipeBook = { bits, water, sewer, power };
  pipeBooks.set(state, book);
  return book;
}

function pipeBookOf(state: GameState): PipeBook {
  return pipeBooks.get(state) ?? buildPipeBook(state);
}

/** 更新單格管道（若索引未建立就唔更新，等下次建立時讀最新 tiles） */
function setPipeTile(state: GameState, idx: number, kind: PipeKind, on: boolean): void {
  const book = pipeBooks.get(state);
  if (!book) return;
  const bit = PIPE_BIT[kind];
  const had = (book.bits[idx] & bit) !== 0;
  if (on && !had) {
    book.bits[idx] |= bit;
    if (kind === 'water') book.water++;
    else if (kind === 'sewer') book.sewer++;
    else book.power++;
  } else if (!on && had) {
    book.bits[idx] &= ~bit;
    if (kind === 'water') book.water--;
    else if (kind === 'sewer') book.sewer--;
    else book.power--;
  }
}

/** 管線格數（water／sewer／power） */
export function pipeCountsOf(state: GameState): { water: number; sewer: number; power: number } {
  const book = pipeBookOf(state);
  return { water: book.water, sewer: book.sewer, power: book.power };
}

// ─────────────────────────── 每局 runtime 快取 ───────────────────────────

interface UtilitiesRuntime {
  /** BFS 連通標記（重用 Uint8Array） */
  conn: Record<PipeKind, Uint8Array> | null;
  /** 上次 snapshot 計算時，各類服務已接駁的 building id */
  connected: Record<UtilityKind, Set<number>> | null;
}

const runtimes = new WeakMap<GameState, UtilitiesRuntime>();

function runtimeOf(state: GameState): UtilitiesRuntime {
  let rt = runtimes.get(state);
  if (!rt) {
    rt = { conn: null, connected: null };
    runtimes.set(state, rt);
  }
  return rt;
}

// ─────────────────────────── 幾何輔助 ───────────────────────────

/** 建築 footprint 格 index（用 placement 的 helper；越界回傳空陣列） */
function footprintOf(state: GameState, building: Building): number[] {
  return buildingFootprintTiles(state, building.x, building.y, building.w, building.h);
}

/** 建築外圍（正交四鄰）格 index（不含 footprint 本身） */
function perimeterOf(state: GameState, building: Building): number[] {
  const result: number[] = [];
  const { x, y, w, h } = building;
  for (let dx = 0; dx < w; dx++) {
    const up = (y - 1) * state.width + x + dx;
    const down = (y + h) * state.width + x + dx;
    if (y - 1 >= 0) result.push(up);
    if (y + h < state.height) result.push(down);
  }
  for (let dy = 0; dy < h; dy++) {
    if (x - 1 >= 0) result.push((y + dy) * state.width + x - 1);
    if (x + w < state.width) result.push((y + dy) * state.width + x + w);
  }
  return result;
}

/** 建築（footprint 或四鄰）是否有某類管 */
function buildingTouchesPipe(state: GameState, building: Building, kind: PipeKind): boolean {
  const book = pipeBookOf(state);
  const bit = PIPE_BIT[kind];
  for (const idx of footprintOf(state, building)) if ((book.bits[idx] ?? 0) & bit) return true;
  for (const idx of perimeterOf(state, building)) if ((book.bits[idx] ?? 0) & bit) return true;
  return false;
}

/** 建築四鄰是否有某類管（source 需要「相鄰管道」才計容量） */
function buildingAdjacentPipe(state: GameState, building: Building, kind: PipeKind): boolean {
  const book = pipeBookOf(state);
  const bit = PIPE_BIT[kind];
  for (const idx of perimeterOf(state, building)) if ((book.bits[idx] ?? 0) & bit) return true;
  return false;
}

/** 由來源（active、有相鄰管）的相鄰管道格出發 BFS，回傳連通標記（Uint8Array） */
function bfsPipeComponent(state: GameState, kind: PipeKind, sources: Building[]): Uint8Array {
  const rt = runtimeOf(state);
  const n = state.tiles.length;
  if (!rt.conn) {
    rt.conn = {
      water: new Uint8Array(n),
      sewer: new Uint8Array(n),
      power: new Uint8Array(n),
    };
  }
  const flags = rt.conn[kind];
  flags.fill(0);
  const book = pipeBookOf(state);
  const bits = book.bits;
  const bit = PIPE_BIT[kind];
  const width = state.width;
  const height = state.height;
  const queue: number[] = [];
  for (const source of sources) {
    for (const idx of perimeterOf(state, source)) {
      if (!(bits[idx] & bit) || flags[idx]) continue;
      flags[idx] = 1;
      queue.push(idx);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head];
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x > 0) {
      const nb = idx - 1;
      if (!flags[nb] && bits[nb] & bit) {
        flags[nb] = 1;
        queue.push(nb);
      }
    }
    if (x + 1 < width) {
      const nb = idx + 1;
      if (!flags[nb] && bits[nb] & bit) {
        flags[nb] = 1;
        queue.push(nb);
      }
    }
    if (y > 0) {
      const nb = idx - width;
      if (!flags[nb] && bits[nb] & bit) {
        flags[nb] = 1;
        queue.push(nb);
      }
    }
    if (y + 1 < height) {
      const nb = idx + width;
      if (!flags[nb] && bits[nb] & bit) {
        flags[nb] = 1;
        queue.push(nb);
      }
    }
  }
  return flags;
}

// ─────────────────────────── 需求計算 ───────────────────────────

/** 建築是否為公用設施供應源（def.utility.source） */
function isUtilitySource(building: Building, kind: UtilityKind): boolean {
  const def = BUILDINGS[building.key];
  const utility = def?.utility;
  return !!utility?.source && utility.kind === kind;
}

/**
 * 某建築對某服務的需求（人口當量）。
 * 住宅：每住客 × UTILITY_DEMAND.residential（合約：1.0 PE/人水、0.9 污水、0.35 電）。
 * 其他：def.workers × 佔用率 × 類別係數；workers=0 則 0。
 */
export function utilityDemandOf(building: Building, service: UtilityKind): number {
  const cfgKey = DEMAND_KEY[service];
  const def = BUILDINGS[building.key];
  if (!def) return 0;
  const table = UTILITY_DEMAND[def.category as keyof typeof UTILITY_DEMAND];
  if (!table) return 0;
  const coefficient = table[cfgKey] ?? 0;
  if (coefficient <= 0) return 0;
  if (def.housing > 0) {
    return building.residents.length * coefficient;
  }
  if (def.workers > 0) {
    const occupancy = clamp01(building.workers.length / def.workers);
    return def.workers * occupancy * coefficient;
  }
  return 0;
}

/** 建築對某服務是否有需求（用嚟判斷未接駁建築／fallback） */
export function buildingNeedsService(building: Building, service: UtilityKind): boolean {
  const def = BUILDINGS[building.key];
  if (!def) return false;
  const cfgKey = DEMAND_KEY[service];
  const table = UTILITY_DEMAND[def.category as keyof typeof UTILITY_DEMAND];
  if (!table) return false;
  if ((table[cfgKey] ?? 0) <= 0) return false;
  if (def.housing > 0) return building.residents.length > 0;
  return def.workers > 0;
}

interface DemandEntry {
  building: Building;
  water: number;
  sewage: number;
  power: number;
}

function collectDemands(state: GameState): DemandEntry[] {
  const result: DemandEntry[] = [];
  for (const building of state.buildings) {
    const water = utilityDemandOf(building, 'water');
    const sewage = utilityDemandOf(building, 'sewage');
    const power = utilityDemandOf(building, 'power');
    if (water > 0 || sewage > 0 || power > 0) result.push({ building, water, sewage, power });
  }
  return result;
}

// ─────────────────────────── Snapshot 計算 ───────────────────────────

function emptyStat(): UtilityNetworkStat {
  return {
    capacity: 0,
    demand: 0,
    supplied: 0,
    coverage: 0,
    connectedBuildings: 0,
    unconnectedBuildings: 0,
    sources: 0,
    shortage: 0,
  };
}

/** 排污口數量 → 食水水質（每個 -0.15，最低 0.5） */
function waterQualityOf(state: GameState): number {
  let outfalls = 0;
  for (const building of state.buildings) {
    if (building.key === 'sewageOutfall' && building.active) outfalls++;
  }
  return clamp01(1 - 0.15 * outfalls) === 0 ? 0.5 : clamp01(Math.max(0.5, 1 - 0.15 * outfalls));
}

function statForService(
  state: GameState,
  service: UtilityKind,
  demands: DemandEntry[],
  connectedSet: Set<number>,
): UtilityNetworkStat & { treated?: number; overflow?: number } {
  const pipeKind = PIPE_KIND_OF_SERVICE[service];
  const sources = state.buildings.filter((b) => isUtilitySource(b, service) && b.active);
  const usableSources = sources.filter((b) => buildingAdjacentPipe(state, b, pipeKind));
  let capacity = 0;
  for (const source of usableSources) {
    capacity += BUILDINGS[source.key]?.utility?.capacity ?? 0;
  }

  const key = DEMAND_KEY[service];
  let demand = 0;
  let connectedDemand = 0;
  let connectedResidents = 0;
  let totalResidents = 0;
  let connectedBuildings = 0;
  let unconnectedBuildings = 0;
  for (const entry of demands) {
    const amount = entry[key];
    if (amount <= 0) continue;
    demand += amount;
    const connected = connectedSet.has(entry.building.id);
    const def = BUILDINGS[entry.building.key];
    if (def?.housing && def.housing > 0) totalResidents += entry.building.residents.length;
    if (connected) {
      connectedBuildings++;
      connectedDemand += amount;
      if (def?.housing && def.housing > 0) connectedResidents += entry.building.residents.length;
    } else {
      unconnectedBuildings++;
    }
  }

  const supplied = Math.min(capacity, demand);
  const supplyRatio = demand > 0 ? clamp01(capacity / demand) : capacity > 0 ? 1 : 0;
  // 覆蓋率：人口加權（已接駁住客 × 供應比例 / 全城人口）
  const population = state.citizens.length;
  const coverage =
    population > 0
      ? round2(clamp01((connectedResidents / population) * (demand > 0 ? Math.min(1, supplyRatio) : 1)))
      : 0;

  const stat: UtilityNetworkStat & { treated?: number; overflow?: number } = {
    capacity: round2(capacity),
    demand: round2(demand),
    supplied: round2(supplied),
    coverage,
    connectedBuildings,
    unconnectedBuildings,
    sources: usableSources.length,
    shortage: demand > 0 ? round2(clamp01(1 - supplyRatio)) : 0,
  };
  if (service === 'sewage') {
    stat.treated = round2(supplied);
    stat.overflow = demand > 0 ? round2(clamp01((demand - capacity) / demand)) : 0;
  }
  void connectedDemand;
  return stat;
}

/**
 * 計算（或讀取快取）全城公用設施 snapshot。
 * - 預設以 worldRevision 作快取簽章；放置／拆除／鋪管後會自動失效。
 * - 每日結算（simulation.ts）用 force=true 強制重算並寫入 state.utilities。
 */
export function computeUtilitySnapshot(state: GameState, force = false): UtilitySnapshot {
  const revision = worldRevisionOf();
  if (!force && state.utilities && state.utilities.revision === revision) {
    return state.utilities;
  }
  const rt = runtimeOf(state);
  const book = pipeBookOf(state);
  const demands = collectDemands(state);

  const services: UtilityKind[] = ['water', 'sewage', 'power'];
  const stats: Partial<Record<UtilityKind, UtilityNetworkStat & { treated?: number; overflow?: number }>> = {};
  const connected: Record<UtilityKind, Set<number>> = {
    water: new Set<number>(),
    sewage: new Set<number>(),
    power: new Set<number>(),
  };
  for (const service of services) {
    const pipeKind = PIPE_KIND_OF_SERVICE[service];
    const sources = state.buildings.filter((b) => isUtilitySource(b, service) && b.active);
    const usableSources = sources.filter((b) => buildingAdjacentPipe(state, b, pipeKind));
    const flags = bfsPipeComponent(state, pipeKind, usableSources);
    // 標記接駁建築（footprint 或四鄰有連通管）
    for (const entry of demands) {
      if (utilityDemandOf(entry.building, service) <= 0) continue;
      let hit = false;
      for (const idx of footprintOf(state, entry.building)) {
        if (flags[idx]) {
          hit = true;
          break;
        }
      }
      if (!hit) {
        for (const idx of perimeterOf(state, entry.building)) {
          if (flags[idx]) {
            hit = true;
            break;
          }
        }
      }
      if (hit) connected[service].add(entry.building.id);
      // UI 接駁狀態（唔影響模擬）
      if (service === 'water') entry.building.watered = hit;
      else if (service === 'sewage') entry.building.sewered = hit;
      else entry.building.powered = hit;
    }
    stats[service] = statForService(state, service, demands, connected[service]);
  }

  const snapshot: UtilitySnapshot = {
    revision,
    water: stats.water as UtilityNetworkStat,
    sewage: stats.sewage as UtilitySnapshot['sewage'],
    power: stats.power as UtilityNetworkStat,
    pipeCounts: { water: book.water, sewer: book.sewer, power: book.power },
    waterQuality: waterQualityOf(state),
    pipeUpkeep: pipeMonthlyUpkeep({ water: book.water, sewer: book.sewer, power: book.power }),
  };
  state.utilities = snapshot;
  rt.connected = connected;
  return snapshot;
}

/** 確保 state.utilities 存在且未過期（stats／UI／production 用） */
export function ensureUtilitySnapshot(state: GameState): UtilitySnapshot {
  return computeUtilitySnapshot(state, false);
}

/**
 * 某建築對某服務的服務係數 0..1（生產效率用）：
 *   - 建築對該服務冇需求 → 1
 *   - 全城未有可用 source → UTILITY_FALLBACK.noSource（0.55）
 *   - 有 source 但未接駁 → UTILITY_FALLBACK.unconnected（0.25）
 *   - 接駁＋容量足夠 → 1
 *   - 容量不足 → capacityFloor + (1-capacityFloor)*supplyRatio
 */
export function utilityFactorFor(
  state: GameState,
  building: Building,
  service: UtilityKind,
): number {
  if (utilityDemandOf(building, service) <= 0) return 1;
  const snapshot = ensureUtilitySnapshot(state);
  const rt = runtimeOf(state);
  const stat = service === 'water' ? snapshot.water : service === 'sewage' ? snapshot.sewage : snapshot.power;
  if (stat.capacity <= 0) return UTILITY_FALLBACK.noSource;
  const connected = rt.connected?.[service]?.has(building.id) ?? false;
  if (!connected) return UTILITY_FALLBACK.unconnected;
  const supplyRatio = stat.demand > 0 ? Math.min(1, stat.capacity / stat.demand) : 1;
  if (supplyRatio >= 1) return 1;
  return UTILITY_FALLBACK.capacityFloor + (1 - UTILITY_FALLBACK.capacityFloor) * supplyRatio;
}

/** 建築對某服務的接駁狀態（UI／視覺用） */
export function buildingUtilityConnected(
  state: GameState,
  building: Building,
  service: UtilityKind,
): boolean {
  ensureUtilitySnapshot(state);
  return runtimeOf(state).connected?.[service]?.has(building.id) ?? false;
}

// ─────────────────────────── 鋪管／拆管 ───────────────────────────

function pipeUpkeepCost(terrain: string): number {
  // 簡單地形倍率（合約允許 1–1.6）：道路下較貴、林地／丘陵較貴
  if (terrain === 'forest') return 1.25;
  if (terrain === 'hill') return 1.2;
  if (terrain === 'reclaimed') return 1.15;
  return 1;
}

function stateFlagOf(tile: Tile, kind: PipeKind): boolean {
  if (kind === 'water') return !!tile.waterPipe;
  if (kind === 'sewer') return !!tile.sewerPipe;
  return !!tile.powerCable;
}

function setStateFlag(tile: Tile, kind: PipeKind, on: boolean): void {
  if (kind === 'water') tile.waterPipe = on;
  else if (kind === 'sewer') tile.sewerPipe = on;
  else tile.powerCable = on;
}

function pipeLabel(kind: PipeKind): string {
  return PIPE_INFO[kind].name;
}

/** 可鋪管地形檢查 */
function canLayPipeAt(state: GameState, x: number, y: number): string | null {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return '超出地圖範圍';
  const tile = state.tiles[y * state.width + x];
  if (PIPE_FORBIDDEN_TERRAIN.has(tile.terrain)) {
    return `不可在${TERRAIN_INFO[tile.terrain]?.name ?? tile.terrain}上鋪設管道`;
  }
  if (!TERRAIN_INFO[tile.terrain]?.buildable && !tile.road) {
    return `不可在${TERRAIN_INFO[tile.terrain]?.name ?? tile.terrain}上鋪設管道`;
  }
  return null;
}

/** 記錄基建支出（建造） */
function chargeInfrastructure(state: GameState, cost: number): void {
  state.finance.treasury -= cost;
  state.finance.expenseThisMonth += cost;
  state.finance.expenseBreakdown.infrastructure =
    (state.finance.expenseBreakdown.infrastructure ?? 0) + cost;
}

/** 記錄退款（拆管 25%）：先沖銷本月基建支出，唔夠就入 other 收入 */
function refundInfrastructure(state: GameState, refund: number): void {
  state.finance.treasury += refund;
  const spent = state.finance.expenseBreakdown.infrastructure ?? 0;
  if (spent >= refund) {
    state.finance.expenseThisMonth -= refund;
    state.finance.expenseBreakdown.infrastructure = spent - refund;
    return;
  }
  state.finance.expenseBreakdown.infrastructure = 0;
  state.finance.incomeThisMonth += refund;
  state.finance.incomeBreakdown.other = (state.finance.incomeBreakdown.other ?? 0) + refund;
}

/**
 * 鋪設一段地下管道（每次一格）。成本 = PIPE_INFO.cost × 地形倍率。
 * 可鋪在可建地／道路上，或建築腳下（retrofit）；不可鋪水域／山地／沙灘／濕地。
 */
export function placePipe(state: GameState, x: number, y: number, kind: PipeKind): PlaceResult {
  const base = PIPE_INFO[kind];
  if (!base) return { ok: false, reason: '未知的管道種類', cost: 0 };
  const invalid = canLayPipeAt(state, x, y);
  if (invalid) return { ok: false, reason: invalid, cost: base.cost };
  const tile = state.tiles[y * state.width + x];
  if (stateFlagOf(tile, kind)) {
    return { ok: false, reason: `此處已有${pipeLabel(kind)}`, cost: base.cost };
  }
  const cost = Math.round(base.cost * pipeUpkeepCost(tile.terrain));
  if (state.finance.treasury < cost) {
    return { ok: false, reason: '庫房不足，無法鋪設管道', cost };
  }
  setStateFlag(tile, kind, true);
  setPipeTile(state, y * state.width + x, kind, true);
  chargeInfrastructure(state, cost);
  markWorldChanged();
  return { ok: true, cost };
}

/** 拆除一段管道（退 25%）；返回 result.cost = 退款金額 */
export function removePipe(state: GameState, x: number, y: number, kind: PipeKind): PlaceResult {
  const base = PIPE_INFO[kind];
  if (!base) return { ok: false, reason: '未知的管道種類', cost: 0 };
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) {
    return { ok: false, reason: '超出地圖範圍', cost: 0 };
  }
  const idx = y * state.width + x;
  const tile = state.tiles[idx];
  if (!stateFlagOf(tile, kind)) {
    return { ok: false, reason: `此處沒有${pipeLabel(kind)}`, cost: 0 };
  }
  setStateFlag(tile, kind, false);
  setPipeTile(state, idx, kind, false);
  const refund = Math.round(base.cost * base.refund);
  refundInfrastructure(state, refund);
  markWorldChanged();
  return { ok: true, cost: refund };
}

/** 每月管線維護費（按管道長度；總表每條管單價） */
export function pipeUpkeepMonthly(state: GameState): number {
  const counts = pipeCountsOf(state);
  return pipeMonthlyUpkeep(counts);
}

// ─────────────────────────── Starter 預建管網 ───────────────────────────

/** 在建築附近找一格可鋪管的位置（優先四鄰、其次 footprint） */
function findPipeSpotNear(state: GameState, building: Building, preferPerimeter: boolean): number | null {
  const candidates = preferPerimeter
    ? [...perimeterOf(state, building), ...footprintOf(state, building)]
    : [...footprintOf(state, building), ...perimeterOf(state, building)];
  for (const idx of candidates) {
    const x = idx % state.width;
    const y = (idx / state.width) | 0;
    if (canLayPipeAt(state, x, y) === null) return idx;
  }
  return null;
}

/**
 * Starter 預建管網（Lead 會喺 core/starter-town.ts 建成後呼叫）：
 *  1. 所有道路格（隧道水面除外）鋪齊三種管；
 *  2. 每個公用設施 source 確保四鄰有同類管；
 *  3. 其他建築如冇管接駁，補一條（footprint 或四鄰），確保 starter 城市即時有水／電／污水。
 * 回傳全城 pipeCounts（water／sewer／power）。
 */
export function layStarterPipes(state: GameState): { water: number; sewer: number; power: number } {
  const tiles = state.tiles;
  const width = state.width;
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    if (!tile.road || tile.terrain === 'water') continue;
    tile.waterPipe = true;
    tile.sewerPipe = true;
    tile.powerCable = true;
  }
  // 由 tiles 重建索引，之後用增量更新
  pipeBooks.delete(state);
  const book = pipeBookOf(state);
  const bits = book.bits;
  const addPipe = (idx: number, kind: PipeKind): void => {
    if (bits[idx] & PIPE_BIT[kind]) return;
    bits[idx] |= PIPE_BIT[kind];
    const tile = tiles[idx];
    setStateFlag(tile, kind, true);
    if (kind === 'water') book.water++;
    else if (kind === 'sewer') book.sewer++;
    else book.power++;
  };

  const pipes: PipeKind[] = ['water', 'sewer', 'power'];
  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    if (!def) continue;
    const source = def.utility?.source ? def.utility.kind : null;
    for (const kind of pipes) {
      const serviceKindOfPipe: UtilityKind = kind === 'sewer' ? 'sewage' : kind;
      const needsPipe = source ? PIPE_KIND_OF_SERVICE[source] === kind : buildingNeedsService(building, serviceKindOfPipe);
      if (!needsPipe) continue;
      const adjacent = buildingAdjacentPipe(state, building, kind);
      if (source && adjacent) continue;
      if (!buildingTouchesPipe(state, building, kind)) {
        const spot = findPipeSpotNear(state, building, false);
        if (spot !== null) addPipe(spot, kind);
      } else if (source && buildingAdjacentPipe(state, building, kind) === false) {
        // source 已有 footprint 管但四鄰冇：補四鄰
        const spot = findPipeSpotNear(state, building, true);
        if (spot !== null) addPipe(spot, kind);
      }
    }
  }
  // 確保每一格道路管線都真的存在（上面已鋪，唔需要再處理）
  void width;
  state.utilities = undefined;
  markWorldChanged();
  return { water: book.water, sewer: book.sewer, power: book.power };
}
