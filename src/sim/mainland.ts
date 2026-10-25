/**
 * 內地公路／鐵路糧食支援（Round 6／GitHub issue #6）。
 *
 * 玩法：
 *   - 玩家在邊境建「道路口岸」（roadBorderGate，$8M）或「鐵路口岸」（railBorderGate，$9M）。
 *   - 口岸要真正接駁城市交通：道路口岸四鄰要有馬路、且該道路連通分量 >20 格；
 *     鐵路口岸四鄰要有鐵路軌（或退而求其次：四鄰道路連通分量 >20 格，MVP 兼容未有鐵路網時）。
 *   - 已接駁口岸每日由內地輸入糧食：道路口岸 60／日、鐵路口岸 120／日（BORDER_CONFIG 可調），
 *     受天氣影響（颱風 ×0.5、暴雨 ×0.85、霧 ×0.9；其餘 1）。
 *   - 糧食優先入 warehouse／importFirm 庫存，其次可收 food 的市場／餐廳／食品廠；
 *     全部滿倉就暫存喺 `state.mainland.pendingFood`，翌日再試（唔會憑空消失）。
 *   - 進口成本 BORDER_CONFIG.foodImportCost × 實際入庫量（現時 0 = 中央支援），
 *     記入 finance.expenseBreakdown.other；口岸建築維護已由 building upkeep 計，唔重複。
 *   - 未能接駁的口岸 supply = 0，UI 會顯示警示。
 *
 * 對外 API：
 *   computeMainlandSupply(state): MainlandState        // 每日／UI 用（純計算，唔寫 state）
 *   tickMainland(state, ctx): void                     // simulation.ts 每日 call（tickTrade 之後、月結之前）
 *   mainlandFoodSupportAvailable(state): boolean       // UI：有冇「已接駁」口岸
 *   mainlandSupplyOf(state): MainlandState | undefined // UI：讀最近快照
 */

import { BORDER_CONFIG, BUILDINGS } from '../core/config';
import type { BorderCrossingKind, BorderCrossingState, GameState, MainlandState, SimContext } from '../core/types';
import { accepts, addCargo, freeCapacityFor } from './logistics-inventory';

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** 接駁判定：道路／鐵路連通分量需大於此格數 */
const MIN_LINKED_COMPONENT = 20;

/** 同一口岸糧食進口受天氣影響（簡化：唔做邊境擠塞排隊） */
function borderWeatherFactor(state: GameState): number {
  switch (state.clock.weather) {
    case 'storm':
      return 0.5;
    case 'rain':
      return 0.85;
    case 'fog':
      return 0.9;
    case 'snow':
      return 0.7;
    default:
      return 1;
  }
}

/** 建築 footprint 外圍（正交四鄰）格 index */
function perimeterOf(state: GameState, building: { x: number; y: number; w: number; h: number }): number[] {
  const result: number[] = [];
  const { x, y, w, h } = building;
  for (let dx = 0; dx < w; dx++) {
    if (y > 0) result.push((y - 1) * state.width + x + dx);
    if (y + h < state.height) result.push((y + h) * state.width + x + dx);
  }
  for (let dy = 0; dy < h; dy++) {
    if (x > 0) result.push((y + dy) * state.width + x - 1);
    if (x + w < state.width) result.push((y + dy) * state.width + x + w);
  }
  return result;
}

/**
 * 由 seeds 出發 BFS 計算連通分量大小；只需判斷 > MIN_LINKED_COMPONENT，
 * 所以數到 threshold+1 就提早結束（成本極低，口岸通常只有幾個）。
 * @param kind 'road' 走 tile.road；'rail' 走 tile.rail（任何 grade）
 */
function componentSizeAtLeast(
  state: GameState,
  seeds: number[],
  kind: 'road' | 'rail',
  threshold = MIN_LINKED_COMPONENT,
): boolean {
  const width = state.width;
  const height = state.height;
  const tiles = state.tiles;
  const visited = new Set<number>();
  const queue: number[] = [];
  for (const idx of seeds) {
    if (idx < 0 || idx >= tiles.length || visited.has(idx)) continue;
    const tile = tiles[idx];
    const walkable = kind === 'road' ? !!tile.road : !!tile.rail;
    if (!walkable) continue;
    visited.add(idx);
    queue.push(idx);
    if (visited.size > threshold) return true;
  }
  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head];
    const x = idx % width;
    const y = (idx / width) | 0;
    const neighbors: number[] = [];
    if (x > 0) neighbors.push(idx - 1);
    if (x + 1 < width) neighbors.push(idx + 1);
    if (y > 0) neighbors.push(idx - width);
    if (y + 1 < height) neighbors.push(idx + width);
    for (const nb of neighbors) {
      if (visited.has(nb)) continue;
      const tile = tiles[nb];
      if (!tile) continue;
      const walkable = kind === 'road' ? !!tile.road : !!tile.rail;
      if (!walkable) continue;
      visited.add(nb);
      if (visited.size > threshold) return true;
      queue.push(nb);
    }
  }
  return false;
}

/** 口岸是否已接駁：道路口岸需道路 component；鐵路口岸優先鐵路，未有鐵路時 fallback 道路 */
function crossingConnected(state: GameState, building: { x: number; y: number; w: number; h: number; key: string }): boolean {
  const def = BUILDINGS[building.key];
  const kind: BorderCrossingKind = def?.borderGate === 'rail' ? 'rail' : 'road';
  const perimeter = perimeterOf(state, building);
  if (kind === 'rail') {
    const railSeeds = perimeter.filter((idx) => !!state.tiles[idx]?.rail);
    if (railSeeds.length > 0 && componentSizeAtLeast(state, railSeeds, 'rail')) return true;
    // fallback（未有鐵路網／只有道路接駁）：道路 component >20 亦可
    const roadSeeds = perimeter.filter((idx) => !!state.tiles[idx]?.road);
    return componentSizeAtLeast(state, roadSeeds, 'road');
  }
  const roadSeeds = perimeter.filter((idx) => !!state.tiles[idx]?.road);
  return componentSizeAtLeast(state, roadSeeds, 'road');
}

/** 計算內地供應 snapshot（唔寫 state；tickMainland 會寫入並處理庫存） */
export function computeMainlandSupply(state: GameState): MainlandState {
  const weather = borderWeatherFactor(state);
  const crossings: BorderCrossingState[] = [];
  let roadLinks = 0;
  let railLinks = 0;
  let foodPerDay = 0;
  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    const kind = def?.borderGate;
    if (!kind) continue;
    const connected = building.active && crossingConnected(state, building);
    let food = 0;
    if (connected) {
      if (kind === 'rail') {
        railLinks++;
        food = BORDER_CONFIG.railFoodPerDay;
      } else {
        roadLinks++;
        food = BORDER_CONFIG.roadFoodPerDay;
      }
      foodPerDay += food;
    }
    crossings.push({
      name: def?.name ?? building.key,
      kind,
      x: building.x,
      y: building.y,
      connected,
      buildingId: building.id,
      foodPerDay: round2(food),
    });
  }
  return {
    roadLinks,
    railLinks,
    foodPerDay: round2(foodPerDay * weather),
    lastImportDay: state.mainland?.lastImportDay ?? 0,
    crossings,
  };
}

/** UI：有冇「已接駁」邊境口岸（可顯示內地支援） */
export function mainlandFoodSupportAvailable(state: GameState): boolean {
  const snapshot = state.mainland ?? computeMainlandSupply(state);
  return snapshot.roadLinks + snapshot.railLinks > 0;
}

/** UI：讀最近一次結算（未結算就先計一次） */
export function mainlandSupplyOf(state: GameState): MainlandState {
  return state.mainland ?? computeMainlandSupply(state);
}

/** 找可收 food 的建築（倉庫優先；市場／餐廳／食品廠等次之） */
function foodStoragePriority(building: { key: string }): number {
  const def = BUILDINGS[building.key];
  if (!def) return 99;
  if (def.storage && def.storage.accepted === 'all') return 0; // warehouse
  if (def.key === 'importFirm') return 1;
  if (def.service?.kind === 'market') return 2;
  if (def.service?.consumes?.resource === 'food') return 3;
  if (def.production?.output === 'food') return 4;
  return def.storage ? 5 : 6;
}

/** 將進口糧食分發入城市倉庫；回傳實際入庫量 */
function distributeFood(state: GameState, amount: number): number {
  if (!(amount > 0)) return 0;
  const candidates = state.buildings
    .filter((building) => building.inventory && accepts(building, 'food') && (BUILDINGS[building.key]?.storage || BUILDINGS[building.key]?.production || BUILDINGS[building.key]?.service))
    .sort((a, b) => foodStoragePriority(a) - foodStoragePriority(b));
  let remaining = amount;
  for (const building of candidates) {
    if (remaining <= 0.01) break;
    const room = freeCapacityFor(building, 'food');
    if (room <= 0.01) continue;
    const added = addCargo(building, 'food', Math.min(room, remaining));
    remaining -= added;
  }
  return round2(amount - remaining);
}

/** 紀錄支出（進口成本） */
function chargeFoodImport(state: GameState, cost: number): void {
  if (!(cost > 0)) return;
  state.finance.treasury = round2(state.finance.treasury - cost);
  state.finance.expenseThisMonth = round2(state.finance.expenseThisMonth + cost);
  state.finance.expenseBreakdown.other = round2((state.finance.expenseBreakdown.other ?? 0) + cost);
}

/** 每日結算（simulation.ts 於 tickTrade 之後、月結之前呼叫） */
export function tickMainland(state: GameState, ctx: SimContext): void {
  const clock = state.clock;
  const snapshot = computeMainlandSupply(state);
  const prev = state.mainland as (MainlandState & { pendingFood?: number }) | undefined;
  let pending = prev?.pendingFood ?? 0;
  const weatherGas = snapshot.foodPerDay; // 已乘天氣
  const importCostPerUnit = BORDER_CONFIG.foodImportCost;

  // 進口總量 = 今日供應 + 昨日未入庫嘅暫存
  let available = weatherGas + pending;
  // 若設定進口成本且庫房不足，只入口庫房可負擔部分，其餘留待翌日
  let affordable = available;
  if (importCostPerUnit > 0) {
    const maxByCash = Math.max(0, Math.floor(state.finance.treasury / importCostPerUnit));
    affordable = Math.min(available, maxByCash);
  }
  const delivered = distributeFood(state, affordable);
  const leftover = round2(available - delivered);
  const cost = round2(delivered * importCostPerUnit);
  chargeFoodImport(state, cost);

  // 寫回 snapshot（pendingFood 係額外欄位，存檔會連 state JSON 一齊存）
  const nextState: MainlandState & { pendingFood: number } = {
    ...snapshot,
    lastImportDay: clock.totalDays,
    pendingFood: Math.max(0, leftover),
  };
  state.mainland = nextState;
  state.stats.mainlandFoodPerDay = snapshot.foodPerDay;

  // 訊息（每月一次；未接駁口岸每 15 日提示一次）
  const logRts = logStateOf(state);
  if (clock.day === 1 && (snapshot.roadLinks + snapshot.railLinks > 0)) {
    if (clock.totalDays - logRts.lastMonthlyLogDay >= 20) {
      logRts.lastMonthlyLogDay = clock.totalDays;
      const costText = cost > 0 ? `，成本 $${Math.round(cost).toLocaleString('en-US')}` : '（中央支援，免費）';
      ctx.log(
        `內地糧食支援：道路口岸 ${snapshot.roadLinks} 個、鐵路口岸 ${snapshot.railLinks} 個，每日約 ${Math.round(snapshot.foodPerDay)} 單位食物${costText}。`,
        'good',
      );
    }
  }
  const gates = snapshot.crossings.filter((crossing) => !crossing.connected);
  if (gates.length > 0 && clock.totalDays - logRts.lastDisconnectedLogDay >= 15) {
    logRts.lastDisconnectedLogDay = clock.totalDays;
    ctx.log(
      `有 ${gates.length} 個邊境口岸未接駁城市交通（${gates.map((g) => g.name).join('、')}）——道路口岸要鋪馬路、鐵路口岸要鋪鐵路軌連到市區。`,
      'warn',
    );
  }
  if (leftover > 0 && clock.totalDays - logRts.lastStorageLogDay >= 15) {
    logRts.lastStorageLogDay = clock.totalDays;
    ctx.log(`內地運到嘅食物暫存邊境（${Math.round(leftover)} 單位），市內倉庫不足；請加建貨倉。`, 'warn');
  }
}

// ─────────────────────────── log 節流（唔入存檔） ───────────────────────────

interface MainlandLogState {
  lastMonthlyLogDay: number;
  lastDisconnectedLogDay: number;
  lastStorageLogDay: number;
}

const logStates = new WeakMap<GameState, MainlandLogState>();

function logStateOf(state: GameState): MainlandLogState {
  let logState = logStates.get(state);
  if (!logState) {
    logState = { lastMonthlyLogDay: -999, lastDisconnectedLogDay: -999, lastStorageLogDay: -999 };
    logStates.set(state, logState);
  }
  return logState;
}

/** 內部用途：讀暫存食物（測試／UI 可選） */
export function mainlandPendingFood(state: GameState): number {
  return (state.mainland as (MainlandState & { pendingFood?: number }) | undefined)?.pendingFood ?? 0;
}
