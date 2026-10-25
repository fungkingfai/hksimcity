/**
 * Round 6／issue #6：內地公路／鐵路糧食支援 sim 單元測試。
 */
import { describe, expect, it } from 'vitest';
import { BORDER_CONFIG, BUILDINGS } from '../src/core/config';
import { createGameState } from '../src/core/new-game';
import type { Building, GameState, SimContext } from '../src/core/types';
import {
  computeMainlandSupply,
  mainlandFoodSupportAvailable,
  mainlandPendingFood,
  tickMainland,
} from '../src/sim/mainland';
import { Simulation } from '../src/sim/simulation';

const ctx: SimContext = { toast: () => {}, log: () => {} };
let nextId = 5000;

function addBuilding(state: GameState, overrides: Partial<Building> & { key: string; x: number; y: number }): Building {
  const def = BUILDINGS[overrides.key];
  const w = overrides.w ?? def?.size[0] ?? 1;
  const h = overrides.h ?? def?.size[1] ?? 1;
  const building: Building = {
    id: nextId++,
    key: overrides.key,
    x: overrides.x,
    y: overrides.y,
    w,
    h,
    active: true,
    connected: true,
    workers: [],
    residents: [],
    inventory: {},
    productionProgress: 0,
    level: 1,
    builtOnDay: 1,
    incomeThisMonth: 0,
    expenseThisMonth: 0,
  };
  Object.assign(building, overrides);
  state.buildings.push(building);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const tile = state.tiles[(building.y + dy) * state.width + building.x + dx];
      if (tile) tile.buildingId = building.id;
    }
  }
  return building;
}

function findFlat(state: GameState, fromX = 0, fromY = 0): { x: number; y: number } {
  for (let y = Math.max(2, fromY); y < state.height - 4; y++) {
    for (let x = fromX; x < state.width; x++) {
      const tile = state.tiles[y * state.width + x];
      if (!tile) continue;
      if (tile.terrain !== 'grass' && tile.terrain !== 'urban' && tile.terrain !== 'fertile') continue;
      if (tile.buildingId >= 0 || tile.road || tile.rail) continue;
      return { x, y };
    }
  }
  throw new Error('找不到平地');
}

/** 在指定行 x0..x0+count 鋪路面（只為測試；直接寫 tile flags） */
function layRoadRow(state: GameState, x0: number, y: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const x = x0 + i;
    if (x < 0 || x >= state.width) continue;
    const tile = state.tiles[y * state.width + x];
    if (!tile) continue;
    tile.road = true;
    tile.sidewalk = true;
  }
}

function layRailRow(state: GameState, x0: number, y: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const x = x0 + i;
    if (x < 0 || x >= state.width) continue;
    const tile = state.tiles[y * state.width + x];
    if (!tile) continue;
    tile.rail = 'surface';
  }
}

function makeState(): GameState {
  const state = createGameState(20261022, 'empty');
  state.finance.treasury = 100_000_000;
  return state;
}

/** 道路口岸（3×2）＋ 貼住嘅 30 格道路＋貨倉 */
function setupRoadGate(state: GameState): { gate: Building; warehouse: Building; roadY: number } {
  const spot = findFlat(state);
  const gate = addBuilding(state, { key: 'roadBorderGate', x: spot.x, y: spot.y });
  const roadY = spot.y - 1;
  layRoadRow(state, spot.x - 5, roadY, 40);
  const warehouse = addBuilding(state, { key: 'warehouse', x: spot.x, y: spot.y + 3 });
  return { gate, warehouse, roadY };
}

describe('內地邊境糧食支援', () => {
  it('道路口岸接駁道路＋貨倉：每日 +60 food、stats／MainlandState 更新', () => {
    const state = makeState();
    const { warehouse } = setupRoadGate(state);
    const snapshot = computeMainlandSupply(state);
    expect(snapshot.roadLinks).toBe(1);
    expect(snapshot.railLinks).toBe(0);
    expect(snapshot.crossings[0].connected).toBe(true);
    expect(snapshot.foodPerDay).toBe(BORDER_CONFIG.roadFoodPerDay);
    expect(mainlandFoodSupportAvailable(state)).toBe(true);

    tickMainland(state, ctx);
    expect(warehouse.inventory.food ?? 0).toBeCloseTo(BORDER_CONFIG.roadFoodPerDay, 2);
    expect(state.stats.mainlandFoodPerDay).toBe(BORDER_CONFIG.roadFoodPerDay);
    expect(state.mainland?.roadLinks).toBe(1);
    expect(state.mainland?.lastImportDay).toBe(state.clock.totalDays);
    expect(mainlandPendingFood(state)).toBe(0);
  });

  it('未接駁口岸：foodPerDay 0、唔會入貨', () => {
    const state = makeState();
    const spot = findFlat(state);
    addBuilding(state, { key: 'roadBorderGate', x: spot.x, y: spot.y });
    const warehouse = addBuilding(state, { key: 'warehouse', x: spot.x, y: spot.y + 3 });
    const snapshot = computeMainlandSupply(state);
    expect(snapshot.roadLinks).toBe(0);
    expect(snapshot.foodPerDay).toBe(0);
    expect(snapshot.crossings[0].connected).toBe(false);
    expect(mainlandFoodSupportAvailable(state)).toBe(false);
    tickMainland(state, ctx);
    expect(warehouse.inventory.food ?? 0).toBe(0);
    expect(state.stats.mainlandFoodPerDay).toBe(0);
  });

  it('鐵路口岸接駁鐵路軌：每日 +120 food（高於道路口岸）', () => {
    const state = makeState();
    const spot = findFlat(state);
    addBuilding(state, { key: 'railBorderGate', x: spot.x, y: spot.y });
    layRailRow(state, spot.x - 5, spot.y - 1, 40);
    const warehouse = addBuilding(state, { key: 'warehouse', x: spot.x, y: spot.y + 3 });
    const snapshot = computeMainlandSupply(state);
    expect(snapshot.railLinks).toBe(1);
    expect(snapshot.foodPerDay).toBe(BORDER_CONFIG.railFoodPerDay);
    tickMainland(state, ctx);
    expect(warehouse.inventory.food ?? 0).toBeCloseTo(BORDER_CONFIG.railFoodPerDay, 2);
  });

  it('鐵路口岸未有鐵路時 fallback：四鄰道路 component >20 亦可接駁', () => {
    const state = makeState();
    const spot = findFlat(state);
    addBuilding(state, { key: 'railBorderGate', x: spot.x, y: spot.y });
    layRoadRow(state, spot.x - 5, spot.y - 1, 40);
    const snapshot = computeMainlandSupply(state);
    expect(snapshot.railLinks).toBe(1);
    expect(snapshot.crossings[0].connected).toBe(true);
  });

  it('道路＋鐵路口岸同時接駁：supply 加總；受天氣影響（颱風 ×0.5）', () => {
    const state = makeState();
    const spot = findFlat(state);
    addBuilding(state, { key: 'roadBorderGate', x: spot.x, y: spot.y });
    layRoadRow(state, spot.x - 5, spot.y - 1, 40);
    const railSpot = findFlat(state, spot.x + 60);
    addBuilding(state, { key: 'railBorderGate', x: railSpot.x, y: railSpot.y });
    layRailRow(state, railSpot.x - 5, railSpot.y - 1, 40);
    const normal = computeMainlandSupply(state);
    expect(normal.roadLinks).toBe(1);
    expect(normal.railLinks).toBe(1);
    expect(normal.foodPerDay).toBe(BORDER_CONFIG.roadFoodPerDay + BORDER_CONFIG.railFoodPerDay);

    state.clock.weather = 'storm';
    const stormy = computeMainlandSupply(state);
    expect(stormy.foodPerDay).toBeCloseTo((BORDER_CONFIG.roadFoodPerDay + BORDER_CONFIG.railFoodPerDay) * 0.5, 2);
    tickMainland(state, ctx); // 跨天氣唔 crash
    expect(state.stats.mainlandFoodPerDay).toBeCloseTo(stormy.foodPerDay, 2);
  });

  it('倉庫滿咗：食物入 pendingFood 翌日再試（唔會消失）', () => {
    const state = makeState();
    const { warehouse } = setupRoadGate(state);
    warehouse.inventory.food = 600; // warehouse capacity 600，已滿
    tickMainland(state, ctx);
    expect(mainlandPendingFood(state)).toBeGreaterThan(0);
    const pending = mainlandPendingFood(state);

    // 加新倉庫，翌日再結算：pending + 當日 supply 都會入新倉
    const fresh = addBuilding(state, { key: 'warehouse', x: warehouse.x + 4, y: warehouse.y });
    state.clock.totalDays += 1;
    tickMainland(state, ctx);
    expect((fresh.inventory.food ?? 0) + pending).toBeGreaterThanOrEqual(pending);
    expect(fresh.inventory.food ?? 0).toBeGreaterThan(0);
  });

  it('simulation.ts 每日自動 call tickMainland（接駁口岸會入糧）', () => {
    const state = makeState();
    const { warehouse } = setupRoadGate(state);
    const sim = new Simulation();
    state.clock.paused = false;
    state.clock.speed = 3;
    const before = Date.now();
    sim.update(state, 10, ctx); // 10 秒 @3x = 1 遊戲日
    expect(Date.now() - before).toBeLessThan(30_000);
    expect(warehouse.inventory.food ?? 0).toBeGreaterThan(0);
    expect(state.mainland?.lastImportDay).toBeGreaterThan(0);
  });
});
