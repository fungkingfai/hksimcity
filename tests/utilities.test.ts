/**
 * Round 5 地下管網＋機場／貨櫃碼頭貿易系統（systems-dev）單元測試。
 * 只覆蓋 sim 邏輯（唔經 main.ts／render），用 createGameState 建真實 600 地圖。
 */
import { describe, expect, it } from 'vitest';
import { BUILDINGS, PIPE_INFO, pipeMonthlyUpkeep } from '../src/core/config';
import { createGameState } from '../src/core/new-game';
import type { Building, GameState } from '../src/core/types';
import { regionKindAt } from '../src/sim/placement';
import {
  computeUtilitySnapshot,
  layStarterPipes,
  pipeCountsOf,
  pipeUpkeepMonthly,
  placePipe,
  removePipe,
  utilityDemandOf,
  utilityFactorFor,
} from '../src/sim/utilities';
import { tickTrade, upgradeTradeBuilding } from '../src/sim/trade';

// ─────────────────────────── 測試輔助 ───────────────────────────

type BuildingOverrides = Partial<Building> & { key: string; x: number; y: number };

let nextTestBuildingId = 1000;

function addBuilding(state: GameState, overrides: BuildingOverrides): Building {
  const def = BUILDINGS[overrides.key];
  const w = overrides.w ?? def?.size[0] ?? 1;
  const h = overrides.h ?? def?.size[1] ?? 1;
  const building: Building = {
    id: nextTestBuildingId++,
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

const PIPE_OK_TERRAIN = new Set(['grass', 'urban', 'fertile', 'reclaimed']);

/** 找一段連續 6 格可建平地（方便測試 source＋pipe＋住宅），無建築／無道路 */
function findFlat(state: GameState, fromX = 0, fromY = 0): { x: number; y: number } {
  for (let y = Math.max(1, fromY); y < state.height - 1; y++) {
    for (let x = Math.max(0, fromX); x < state.width - 6; x++) {
      let ok = true;
      for (let dx = 0; dx < 6 && ok; dx++) {
        const tile = state.tiles[y * state.width + x + dx];
        if (!tile || !PIPE_OK_TERRAIN.has(tile.terrain) || tile.buildingId >= 0 || tile.road) ok = false;
      }
      if (ok) return { x, y };
    }
  }
  throw new Error('找不到平地');
}

function addResidents(state: GameState, home: Building, count: number): void {
  for (let i = 0; i < count; i++) {
    const id = state.nextCitizenId++;
    home.residents.push(id);
    state.citizens.push({
      id,
      name: `測試市民${i}`,
      age: 30,
      gender: 'male',
      homeId: home.id,
      workId: -1,
      happiness: 70,
      money: 20000,
      salary: 0,
      state: 'home',
      x: home.x,
      y: home.y,
      path: [],
      pathProgress: 0,
      targetId: -1,
      commuteMode: 'walk',
      look: 0.5,
      needs: { food: 70, goods: 70, leisure: 60 },
    });
  }
  state.stats.population = state.citizens.length;
}

function makeEmptyState(): GameState {
  const state = createGameState(20261022, 'empty');
  state.finance.treasury = 100_000_000;
  return state;
}

// ─────────────────────────── 管道擺放 ───────────────────────────

describe('地下管道擺放規則', () => {
  it('可鋪在可建地，扣庫房並記基建支出；重複鋪／水域會被拒', () => {
    const state = makeEmptyState();
    const flat = findFlat(state);
    const before = state.finance.treasury;
    const result = placePipe(state, flat.x, flat.y, 'water');
    expect(result.ok).toBe(true);
    expect(result.cost).toBe(PIPE_INFO.water.cost);
    expect(state.finance.treasury).toBe(before - PIPE_INFO.water.cost);
    expect(state.finance.expenseBreakdown.infrastructure).toBeGreaterThan(0);
    expect(state.tiles[flat.y * state.width + flat.x].waterPipe).toBe(true);

    const again = placePipe(state, flat.x, flat.y, 'water');
    expect(again.ok).toBe(false);
    expect(again.reason).toContain('已有');

    let waterTile: { x: number; y: number } | null = null;
    for (let y = 0; y < state.height && !waterTile; y++) {
      for (let x = 0; x < state.width; x++) {
        if (state.tiles[y * state.width + x].terrain === 'water') {
          waterTile = { x, y };
          break;
        }
      }
    }
    expect(waterTile).toBeTruthy();
    const inWater = placePipe(state, waterTile!.x, waterTile!.y, 'water');
    expect(inWater.ok).toBe(false);
    expect(inWater.reason).toContain('不可');
  });

  it('拆管退回 25% 並清除 pipe', () => {
    const state = makeEmptyState();
    const flat = findFlat(state);
    placePipe(state, flat.x, flat.y, 'power');
    const refund = removePipe(state, flat.x, flat.y, 'power');
    expect(refund.ok).toBe(true);
    expect(refund.cost).toBe(Math.round(PIPE_INFO.power.cost * PIPE_INFO.power.refund));
    expect(state.tiles[flat.y * state.width + flat.x].powerCable).toBe(false);
  });
});

// ─────────────────────────── 管網接駁／容量／fallback ───────────────────────────

describe('公用設施管網接駁與容量', () => {
  it('source＋pipe＋住宅接駁：coverage 1、factor 1', () => {
    const state = makeEmptyState();
    const spot = findFlat(state);
    const source = addBuilding(state, { key: 'waterTower', x: spot.x, y: spot.y });
    expect(source).toBeTruthy();
    // 水塔 1×1，右邊鋪食水管
    expect(placePipe(state, spot.x + 1, spot.y, 'water').ok).toBe(true);
    // 住宅（2×2）放喺水管延伸到嘅位置
    const home = addBuilding(state, { key: 'publicHousing', x: spot.x + 3, y: spot.y });
    addResidents(state, home, 4);
    expect(placePipe(state, spot.x + 2, spot.y, 'water').ok).toBe(true);
    expect(placePipe(state, spot.x + 3, spot.y, 'water').ok).toBe(true);

    const snapshot = computeUtilitySnapshot(state, true);
    expect(snapshot.water.capacity).toBeGreaterThan(0);
    expect(snapshot.water.demand).toBeCloseTo(4, 1);
    expect(snapshot.water.connectedBuildings).toBe(1);
    expect(snapshot.water.coverage).toBe(1);
    expect(utilityFactorFor(state, home, 'water')).toBe(1);
    expect(utilityDemandOf(home, 'water')).toBeCloseTo(4, 1);
  });

  it('容量不足時 factor = capacityFloor + (1-floor)×supplyRatio', () => {
    const state = makeEmptyState();
    const spot = findFlat(state);
    addBuilding(state, { key: 'waterTower', x: spot.x, y: spot.y }); // 800
    placePipe(state, spot.x + 1, spot.y, 'water');
    const home = addBuilding(state, { key: 'publicHousing', x: spot.x + 3, y: spot.y });
    addResidents(state, home, 1000); // demand 1000 > 800
    placePipe(state, spot.x + 2, spot.y, 'water');
    placePipe(state, spot.x + 3, spot.y, 'water');
    const snapshot = computeUtilitySnapshot(state, true);
    expect(snapshot.water.capacity).toBeCloseTo(800, 0);
    expect(snapshot.water.demand).toBeCloseTo(1000, 0);
    const ratio = 800 / 1000;
    const factor = utilityFactorFor(state, home, 'water');
    expect(factor).toBeCloseTo(0.5 + 0.5 * ratio, 3);
    expect(snapshot.water.shortage).toBeCloseTo(1 - ratio, 2);
  });

  it('未有 source → noSource fallback；有 source 但未接駁 → unconnected fallback', () => {
    const state = makeEmptyState();
    const spot = findFlat(state);
    const home = addBuilding(state, { key: 'publicHousing', x: spot.x, y: spot.y });
    addResidents(state, home, 4);
    // 有水管但冇水務設施
    placePipe(state, spot.x - 1, spot.y, 'water');
    expect(utilityFactorFor(state, home, 'water')).toBeCloseTo(0.55, 3);

    // 加 source（放遠處，水管唔通）
    const far = findFlat(state, spot.x + 20);
    addBuilding(state, { key: 'waterTower', x: far.x, y: far.y });
    placePipe(state, far.x + 1, far.y, 'water');
    expect(utilityFactorFor(state, home, 'water')).toBeCloseTo(0.25, 3);
  });

  it('污水處理量不足時 overflow > 0', () => {
    const state = makeEmptyState();
    const spot = findFlat(state);
    addBuilding(state, { key: 'sewageOutfall', x: spot.x, y: spot.y }); // 1400
    placePipe(state, spot.x + 1, spot.y, 'sewer');
    const home = addBuilding(state, { key: 'publicHousing', x: spot.x + 3, y: spot.y });
    addResidents(state, home, 1800); // 污水 demand = 1620 > 1400
    placePipe(state, spot.x + 2, spot.y, 'sewer');
    placePipe(state, spot.x + 3, spot.y, 'sewer');
    const snapshot = computeUtilitySnapshot(state, true);
    expect(snapshot.sewage.overflow).toBeGreaterThan(0);
    expect(snapshot.sewage.overflow).toBeCloseTo((1620 - 1400) / 1620, 2);
  });
});

// ─────────────────────────── Starter 管網 ───────────────────────────

describe('Starter 預建管網', () => {
  it('道路下鋪齊三種管，pipeCounts／維護費一致，source 有相鄰管', () => {
    const state = createGameState(20261022, 'starter');
    const counts = layStarterPipes(state);
    expect(counts.water).toBeGreaterThan(0);
    expect(counts.sewer).toBeGreaterThan(0);
    expect(counts.power).toBeGreaterThan(0);
    expect(pipeCountsOf(state)).toEqual(counts);
    expect(pipeUpkeepMonthly(state)).toBe(pipeMonthlyUpkeep(counts));

    const snapshot = computeUtilitySnapshot(state, true);
    expect(snapshot.revision).toBeGreaterThanOrEqual(0);
    expect(snapshot.pipeCounts).toEqual(counts);

    // 所有 utility source 都要有相鄰同類管，capacity 才會計入
    const W = state.width;
    for (const building of state.buildings) {
      const utility = BUILDINGS[building.key]?.utility;
      if (!utility?.source) continue;
      const perimeter: number[] = [];
      for (let dx = 0; dx < building.w; dx++) {
        if (building.y > 0) perimeter.push((building.y - 1) * W + building.x + dx);
        if (building.y + building.h < state.height) perimeter.push((building.y + building.h) * W + building.x + dx);
      }
      for (let dy = 0; dy < building.h; dy++) {
        if (building.x > 0) perimeter.push((building.y + dy) * W + building.x - 1);
        if (building.x + building.w < W) perimeter.push((building.y + dy) * W + building.x + building.w);
      }
      const hasPipe = perimeter.some((idx) => {
        const tile = state.tiles[idx];
        if (!tile) return false;
        if (utility.kind === 'water') return !!tile.waterPipe;
        if (utility.kind === 'sewage') return !!tile.sewerPipe;
        return !!tile.powerCable;
      });
      expect(hasPipe).toBe(true);
    }
  });
});

// ─────────────────────────── 機場／貨櫃碼頭貿易 ───────────────────────────

describe('機場／貨櫃碼頭貿易結算', () => {
  it('機場客運：需求、容量、收入、jobs、無交通接駁折扣', () => {
    const state = makeEmptyState();
    addBuilding(state, { key: 'airportTerminal', x: 100, y: 300, w: 4, h: 3, level: 1 });
    for (let i = 0; i < 100; i++) state.citizens.push({ id: state.nextCitizenId++ } as never);
    state.stats.population = 100;
    tickTrade(state, { toast: () => {}, log: () => {} });
    const airport = state.trade!.airport;
    expect(airport.passengerCapacity).toBe(9000);
    // 800 + 100×0.25 = 825；冇 8 格內交通 → ×0.7
    expect(airport.passengers).toBeCloseTo(825 * 0.7, 0);
    expect(airport.revenueToday).toBeCloseTo(825 * 0.7 * 120, 0);
    expect(airport.jobs).toBe(180);
    expect(state.stats.airportPassengers).toBe(airport.passengers);
    expect(state.finance.incomeBreakdown.other).toBeGreaterThan(0);
  });

  it('貨櫃碼頭：region 內 capacity 計足，區外 ×0.9', () => {
    const state = makeEmptyState();
    // 找 containerPort region 內一格
    let inside: { x: number; y: number } | null = null;
    for (let y = 200; y < 360 && !inside; y++) {
      for (let x = 0; x < state.width; x++) {
        if (regionKindAt(state, x, y) === 'containerPort') {
          inside = { x, y };
          break;
        }
      }
    }
    expect(inside).toBeTruthy();
    addBuilding(state, { key: 'containerPort', x: inside!.x, y: inside!.y, w: 4, h: 3, level: 1 });
    const gate = addBuilding(state, { key: 'portGate', x: inside!.x + 5, y: inside!.y, w: 2, h: 2 });
    const yard = addBuilding(state, { key: 'portYard', x: inside!.x + 8, y: inside!.y, w: 3, h: 2 });
    // region 內 gate／yard 用真實 region 判斷；若隨機位置超出 region 就略過斷言
    if (regionKindAt(state, gate.x, gate.y) !== 'containerPort') {
      gate.x = inside!.x + 4;
      gate.y = inside!.y;
    }
    if (regionKindAt(state, yard.x, yard.y) !== 'containerPort') {
      yard.x = inside!.x;
      yard.y = inside!.y + 3;
    }
    tickTrade(state, { toast: () => {}, log: () => {} });
    const port = state.trade!.port;
    expect(port.teuCapacity).toBeGreaterThanOrEqual(45);

    // 區外碼頭：只用 45×0.9
    const outsideState = makeEmptyState();
    const outside = findFlat(outsideState, 0);
    addBuilding(outsideState, { key: 'containerPort', x: outside.x, y: outside.y, w: 4, h: 3 });
    tickTrade(outsideState, { toast: () => {}, log: () => {} });
    expect(outsideState.trade!.port.teuCapacity).toBeCloseTo(45 * 0.9, 2);
  });

  it('颱風 8 號機場關閉（收入 0）；升級扣庫房並提升 level', () => {
    const state = makeEmptyState();
    state.finance.treasury = 30_000_000;
    const terminal = addBuilding(state, { key: 'airportTerminal', x: 100, y: 300, w: 4, h: 3, level: 1 });
    state.stats.typhoonSignal = 8;
    tickTrade(state, { toast: () => {}, log: () => {} });
    expect(state.trade!.airport.passengers).toBe(0);
    expect(state.trade!.airport.revenueToday).toBe(0);

    state.stats.typhoonSignal = 0;
    const first = upgradeTradeBuilding(state, terminal.id);
    expect(first.ok).toBe(true);
    expect(first.cost).toBe(6_000_000);
    expect(terminal.level).toBe(2);
    const second = upgradeTradeBuilding(state, terminal.id);
    expect(second.ok).toBe(true);
    expect(terminal.level).toBe(3);
    const third = upgradeTradeBuilding(state, terminal.id);
    expect(third.ok).toBe(false);
    expect(third.reason).toContain('最高');
  });
});
