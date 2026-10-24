/**
 * Round 5：巴士／小巴路線系統測試（transport-dev）
 *
 * 覆蓋：createTransitLine 驗證（模式／站數／重複／車廠／庫房／連通）、每日營運結算
 * （載客／收入／成本、票價與車數彈性、idempotent、跨月累計）、update／delete、
 * tickTransit 整合（byMode.bus、車費唔 double count）、颱風停駛、路線車輛生成／回收、
 * 覆蓋率整合（路線站點併入 bus 模式）。
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TRANSIT_LINE_CONFIG } from '../src/core/config';
import { createGameState } from '../src/core/new-game';
import type { Building, GameState, SimContext, Vehicle } from '../src/core/types';
import {
  computeTransitCoverage,
  createTransitLine,
  deleteTransitLine,
  getTransitLineStats,
  getTransitLines,
  lineRoadPath,
  resetTransitLineMonthly,
  stopBuildingsForMode,
  tickTransit,
  tickTransitLines,
  updateTransitLine,
} from '../src/sim/transit';
import { tickVehicles } from '../src/sim/vehicles';

const ctx: SimContext = {
  toast: () => {
    /* noop */
  },
  log: () => {
    /* noop */
  },
};

interface Fixture {
  state: GameState;
  stops: Building[];
  homes: Building[];
  jobs: Building[];
  depot: Building;
  minibusStops: Building[];
  minibusDepot: Building;
  islandStop: Building;
}

function roadTile(state: GameState, x: number, y: number): void {
  const tile = state.tiles[y * state.width + x];
  if (!tile) return;
  if (tile.terrain === 'water' || tile.terrain === 'mountain' || tile.terrain === 'sand') {
    tile.terrain = 'urban';
  }
  tile.road = true;
  tile.buildingId = -1;
}

function addBuilding(
  state: GameState,
  key: string,
  x: number,
  y: number,
  w: number,
  h: number,
  residents = 0,
  workers = 0,
): Building {
  const building: Building = {
    id: state.nextBuildingId++,
    key,
    x,
    y,
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
  for (let i = 0; i < residents; i++) building.residents.push(0);
  for (let i = 0; i < workers; i++) building.workers.push(0);
  state.buildings.push(building);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const tile = state.tiles[(y + dy) * state.width + x + dx];
      if (tile) tile.buildingId = building.id;
    }
  }
  return building;
}

/** 建立一個測試城市：一條東西直路（y=30, x=10..80）＋沿線站點／住宅／商廈 */
function makeFixture(): Fixture {
  const state = createGameState(20261024, 'empty');
  state.gameMode = 'empty';
  state.ui.showTutorial = false;
  state.ui.showStartScreen = false;
  state.clock.paused = false;
  state.clock.weather = 'clear';
  state.clock.weekday = 1; // 平日
  state.finance.treasury = 100_000_000;

  const W = state.width;
  for (let x = 10; x <= 80; x++) {
    roadTile(state, x, 30);
    roadTile(state, x, 31);
  }
  // 一條獨立道路（唔連接主路），用於「冇道路連通」測試
  for (let x = 10; x <= 20; x++) roadTile(state, x, 60);
  state.ui.revision++;

  const stops = [
    addBuilding(state, 'busStop', 14, 32, 1, 1),
    addBuilding(state, 'busStop', 30, 32, 1, 1),
    addBuilding(state, 'busStop', 46, 32, 1, 1),
    addBuilding(state, 'busStop', 62, 32, 1, 1),
  ];
  const homes = [
    addBuilding(state, 'publicHousing', 12, 33, 2, 2, 60),
    addBuilding(state, 'privateEstate', 44, 33, 2, 2, 80),
  ];
  const jobs = [
    addBuilding(state, 'officeTower', 28, 33, 2, 2, 0, 40),
    addBuilding(state, 'shoppingMall', 60, 33, 3, 1, 0, 25),
  ];
  // 巴士總站（depot，唔在線內亦可；貼路）
  const depot = addBuilding(state, 'busTerminus', 50, 32, 2, 2);
  // 小巴站＋小巴車廠
  const minibusStops = [
    addBuilding(state, 'minibusStop', 20, 32, 1, 1),
    addBuilding(state, 'minibusStop', 36, 32, 1, 1),
    addBuilding(state, 'minibusStop', 52, 32, 1, 1),
  ];
  const minibusDepot = addBuilding(state, 'minibusDepot', 66, 33, 2, 2);
  const islandStop = addBuilding(state, 'busStop', 15, 61, 1, 1);

  // 就業人口：workers 已佔用（路線結算只用 workers.length）
  for (let i = 0; i < 30; i++) {
    jobs[0].workers.push(state.nextCitizenId + i);
    state.citizens.push({
      id: state.nextCitizenId++,
      name: `測試${i}`,
      age: 30,
      gender: 'male',
      homeId: homes[0].id,
      workId: jobs[0].id,
      happiness: 70,
      money: 1000,
      salary: 18000,
      state: 'home',
      x: 20,
      y: 30,
      path: [],
      pathProgress: 0,
      targetId: -1,
      commuteMode: 'bus',
      look: 0.5,
      needs: { food: 80, goods: 80, leisure: 80 },
    });
  }
  return { state, stops, homes, jobs, depot, minibusStops, minibusDepot, islandStop };
}

function nextDay(state: GameState): void {
  state.clock.totalDays += 1;
  state.clock.day = (state.clock.day % 7) + 1;
  state.clock.weekday = (state.clock.weekday + 1) % 7;
  state.clock.weather = 'clear';
}

function busLineInput(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    mode: 'bus' as const,
    stopIds: fixture.stops.map((stop) => stop.id),
    loop: false,
    vehicleCount: 4,
    fare: 5,
    ...overrides,
  };
}

function vehicleLineId(vehicle: Vehicle): number | null {
  const lineId = (vehicle as Vehicle & { lineId?: number }).lineId;
  return typeof lineId === 'number' ? lineId : null;
}

// 世界生成（480×480）成本高：整個 test file 只建一次，每個 test 重設可變狀態。
let sharedFixture: Fixture;
let resetCounter = 0;

beforeAll(() => {
  sharedFixture = makeFixture();
});

/** 重設路線／車輛／財政／時鐘等可變狀態（保留世界、道路、建築） */
function resetFixture(): Fixture {
  const fixture = sharedFixture;
  const state = fixture.state;
  // 移除測試中途加嘅建築（bug 防禦）並重設 active
  state.buildings.length = 14; // fixture 建築數：4 站 + 2 住宅 + 2 就業 + depot + 3 小巴站 + 小巴廠 + islandStop + ...
  if (state.buildings.length < 1) throw new Error('fixture 建築數不符');
  for (const building of state.buildings) building.active = true;
  state.transitLines = [];
  state.nextTransitLineId = 1;
  state.vehicles = [];
  state.nextVehicleId = 1;
  state.nextBuildingId = Math.max(state.nextBuildingId, ...state.buildings.map((b) => b.id + 1));
  state.finance.treasury = 100_000_000;
  state.finance.incomeThisMonth = 0;
  state.finance.expenseThisMonth = 0;
  state.finance.incomeBreakdown = {};
  state.finance.expenseBreakdown = {};
  state.transit.dailyRidership = 0;
  state.transit.faresThisMonth = 0;
  state.transit.suspended = false;
  state.transit.byMode = { mtr: 0, bus: 0, tram: 0, ferry: 0 };
  state.clock.weather = 'clear';
  state.clock.warning = null;
  state.clock.weekday = 1;
  state.clock.speed = 1;
  state.clock.paused = false;
  // 每次 reset 用一個唔同嘅 totalDays（避免 tickTransitLines 同日 idempotent guard），
  // 但固定 month=1，避免測試中途跨月影響 line.faresThisMonth。
  resetCounter += 1;
  state.clock.totalDays = 100 + resetCounter * 8;
  state.clock.year = 1;
  state.clock.month = 1;
  state.clock.day = 3;
  state.ui.revision += 1;
  return fixture;
}

/** 每個 test 用呢個取 fixture（已重設） */
function freshFixture(): Fixture {
  return resetFixture();
}

describe('Round 5：createTransitLine 驗證', () => {
  it('合法路線：扣錢、預設名稱／顏色、道路 path 可合併', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    const before = state.finance.treasury;
    const result = createTransitLine(state, busLineInput(fixture));
    expect(result.ok).toBe(true);
    expect(result.id).toBe(1);
    const expectedCost =
      4 * TRANSIT_LINE_CONFIG.vehicleCost.bus + TRANSIT_LINE_CONFIG.openFee;
    expect(result.cost).toBe(expectedCost);
    expect(before - state.finance.treasury).toBe(expectedCost);
    expect(state.finance.expenseBreakdown.infrastructure).toBe(expectedCost);
    const line = getTransitLines(state)[0];
    expect(line.mode).toBe('bus');
    expect(line.name).toContain('巴士');
    expect(line.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(line.vehicleCount).toBe(4);
    expect(line.fare).toBe(5);
    expect(line.createdDay).toBe(state.clock.totalDays);
    const path = lineRoadPath(state, line);
    expect(path).not.toBeNull();
    expect((path as number[]).length).toBeGreaterThan(10);
  });

  it('少於 2 站 → 失敗', () => {
    const fixture = freshFixture();
    const result = createTransitLine(fixture.state, busLineInput(fixture, { stopIds: [fixture.stops[0].id] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('2 個站');
  });

  it('重複站 → 失敗', () => {
    const fixture = freshFixture();
    const result = createTransitLine(
      fixture.state,
      busLineInput(fixture, { stopIds: [fixture.stops[0].id, fixture.stops[0].id] }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('重複');
  });

  it('模式不符（巴士線用小巴站）→ 失敗', () => {
    const fixture = freshFixture();
    const result = createTransitLine(
      fixture.state,
      busLineInput(fixture, { stopIds: [fixture.stops[0].id, fixture.minibusStops[0].id] }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('唔啱');
  });

  it('冇 depot → 失敗', () => {
    const fixture = freshFixture();
    fixture.depot.active = false;
    const result = createTransitLine(fixture.state, busLineInput(fixture));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('巴士總站');
  });

  it('庫房不足 → 失敗（唔會扣錢）', () => {
    const fixture = freshFixture();
    fixture.state.finance.treasury = 1000;
    const before = fixture.state.finance.treasury;
    const result = createTransitLine(fixture.state, busLineInput(fixture));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('庫房不足');
    expect(fixture.state.finance.treasury).toBe(before);
    expect(getTransitLines(fixture.state)).toHaveLength(0);
  });

  it('站點之間冇道路連通 → 失敗', () => {
    const fixture = freshFixture();
    const result = createTransitLine(
      fixture.state,
      busLineInput(fixture, { stopIds: [fixture.stops[0].id, fixture.islandStop.id] }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('冇道路連通');
  });

  it('車數／票價超出範圍 → 失敗', () => {
    const fixture = freshFixture();
    const tooMany = createTransitLine(fixture.state, busLineInput(fixture, { vehicleCount: 99 }));
    expect(tooMany.ok).toBe(false);
    const tooPricey = createTransitLine(fixture.state, busLineInput(fixture, { fare: 99 }));
    expect(tooPricey.ok).toBe(false);
  });

  it('小巴線需要小巴車廠，並可建成', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    fixture.minibusDepot.active = false;
    const noDepot = createTransitLine(state, {
      mode: 'minibus',
      stopIds: fixture.minibusStops.map((stop) => stop.id),
      loop: false,
      vehicleCount: 3,
      fare: 4,
    });
    expect(noDepot.ok).toBe(false);
    expect(noDepot.reason).toContain('小巴車廠');

    fixture.minibusDepot.active = true;
    // 先建車廠（active），再建線
    const result = createTransitLine(state, {
      mode: 'minibus',
      stopIds: fixture.minibusStops.map((stop) => stop.id),
      loop: false,
      vehicleCount: 3,
      fare: 4,
    });
    expect(result.ok).toBe(true);
  });

  it('stopBuildingsForMode 回傳對應模式站點（含小巴車廠）', () => {
    const fixture = freshFixture();
    const bus = stopBuildingsForMode(fixture.state, 'bus');
    const minibus = stopBuildingsForMode(fixture.state, 'minibus');
    expect(bus.some((b) => b.id === fixture.stops[0].id)).toBe(true);
    expect(bus.some((b) => b.id === fixture.minibusStops[0].id)).toBe(false);
    expect(minibus.some((b) => b.key === 'minibusDepot')).toBe(true);
  });
});

describe('Round 5：tickTransitLines 營運結算', () => {
  it('每日載客／收入／成本入帳，byMode.bus 包含路線', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    const created = createTransitLine(state, busLineInput(fixture));
    expect(created.ok).toBe(true);
    nextDay(state);
    const financeBefore = {
      fares: state.finance.incomeBreakdown.fares ?? 0,
      infra: state.finance.expenseBreakdown.infrastructure ?? 0,
      treasury: state.finance.treasury,
    };
    const summary = tickTransitLines(state, ctx);
    const line = getTransitLines(state)[0];
    expect(summary.activeLines).toBe(1);
    expect(summary.ridership).toBeGreaterThan(0);
    expect(line.ridershipToday).toBe(summary.ridership);
    expect(summary.fares).toBe(Math.round(summary.ridership * line.fare));
    expect(summary.costs).toBe(line.vehicleCount * TRANSIT_LINE_CONFIG.dailyCostPerVehicle.bus);
    expect(summary.profit).toBe(summary.fares - summary.costs);
    // 車費收入、成本分別入帳
    expect((state.finance.incomeBreakdown.fares ?? 0) - financeBefore.fares).toBe(summary.fares);
    expect((state.finance.expenseBreakdown.infrastructure ?? 0) - financeBefore.infra).toBe(summary.costs);
    expect(state.finance.treasury - financeBefore.treasury).toBe(summary.fares - summary.costs);
    expect(line.faresThisMonth).toBeGreaterThan(0);

    // 同日重複呼叫 idempotent（唔會 double count）
    const after = {
      fares: state.finance.incomeBreakdown.fares ?? 0,
      infra: state.finance.expenseBreakdown.infrastructure ?? 0,
    };
    const again = tickTransitLines(state, ctx);
    expect(again.ridership).toBe(summary.ridership);
    expect(state.finance.incomeBreakdown.fares ?? 0).toBe(after.fares);
    expect(state.finance.expenseBreakdown.infrastructure ?? 0).toBe(after.infra);
  });

  it('加價 → 載客下降；加車 → 容量上升', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    createTransitLine(state, busLineInput(fixture, { vehicleCount: 4, fare: 5 }));
    nextDay(state);
    state.clock.weekday = 1;
    const baseSummary = tickTransitLines(state, ctx);
    const baseRidership = baseSummary.ridership;
    const baseCapacity = getTransitLineStats(state).lines[0].capacity;
    expect(baseRidership).toBeGreaterThan(0);

    // 只加價、唔加車：吸引力下降 → 載客下降
    expect(updateTransitLine(state, 1, { fare: 12 }).ok).toBe(true);
    nextDay(state);
    state.clock.weekday = 1;
    const priceySummary = tickTransitLines(state, ctx);
    expect(priceySummary.ridership).toBeLessThan(baseRidership);

    // 加車：容量上升（班距亦改善）
    expect(updateTransitLine(state, 1, { vehicleCount: 10 }).ok).toBe(true);
    nextDay(state);
    state.clock.weekday = 1;
    tickTransitLines(state, ctx);
    const newStats = getTransitLineStats(state);
    expect(newStats.lines[0].capacity).toBeGreaterThan(baseCapacity);
    expect(newStats.lines[0].headwayMinutes).toBeLessThan(30);
  });

  it('路線載客計入 tickTransit 的 byMode.bus，車費唔 double count', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    createTransitLine(state, busLineInput(fixture));
    nextDay(state);
    const lineSummary = tickTransitLines(state, ctx);
    const faresBefore = state.finance.incomeBreakdown.fares ?? 0;
    tickTransit(state, ctx);
    expect(state.transit.byMode.bus).toBeGreaterThanOrEqual(lineSummary.ridership);
    expect(state.transit.dailyRidership).toBeGreaterThanOrEqual(lineSummary.ridership);
    const addedFares = (state.finance.incomeBreakdown.fares ?? 0) - faresBefore;
    // 只會再加舊站點半徑 30% 部分，不會整條線再計一次
    expect(addedFares).toBeLessThan(lineSummary.fares * 2);
    expect(addedFares).toBeGreaterThanOrEqual(0);
  });

  it('颱風日路線停駛（載客 0）', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    createTransitLine(state, busLineInput(fixture));
    nextDay(state);
    tickTransitLines(state, ctx);
    nextDay(state);
    state.clock.weather = 'storm';
    const summary = tickTransitLines(state, ctx);
    expect(summary.ridership).toBe(0);
    expect(summary.fares).toBe(0);
    expect(getTransitLines(state)[0].ridershipToday).toBe(0);
  });

  it('停駛路線（suspended）不計載客／成本', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    createTransitLine(state, busLineInput(fixture));
    updateTransitLine(state, 1, { suspended: true });
    nextDay(state);
    const summary = tickTransitLines(state, ctx);
    expect(summary.activeLines).toBe(0);
    expect(summary.ridership).toBe(0);
    expect(summary.costs).toBe(0);
  });

  it('resetTransitLineMonthly：月結清零本月車費、記錄上月載客（finance 月結呼叫）', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    createTransitLine(state, busLineInput(fixture));
    nextDay(state);
    state.clock.weekday = 1;
    tickTransitLines(state, ctx);
    const line = getTransitLines(state)[0];
    expect(line.faresThisMonth).toBeGreaterThan(0);
    const lastDayRidership = line.ridershipToday;
    resetTransitLineMonthly(state);
    expect(line.faresThisMonth).toBe(0);
    expect(line.lastMonthRidership).toBe(lastDayRidership);
  });

  it('跨日累計 line.faresThisMonth', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    createTransitLine(state, busLineInput(fixture));
    nextDay(state);
    const day1 = tickTransitLines(state, ctx);
    const monthAfterDay1 = getTransitLines(state)[0].faresThisMonth;
    nextDay(state);
    const day2 = tickTransitLines(state, ctx);
    expect(monthAfterDay1).toBe(day1.fares);
    expect(getTransitLines(state)[0].faresThisMonth).toBe(day1.fares + day2.fares);
  });
});

describe('Round 5：updateTransitLine／deleteTransitLine', () => {
  it('加車扣全價、減車退 50%、票價／名稱／顏色可改', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    createTransitLine(state, busLineInput(fixture));
    const treasuryBefore = state.finance.treasury;
    const up = updateTransitLine(state, 1, { vehicleCount: 6, fare: 7, name: '5B 中環—銅鑼灣', color: '#ff3d7f' });
    expect(up.ok).toBe(true);
    expect(treasuryBefore - state.finance.treasury).toBe(2 * TRANSIT_LINE_CONFIG.vehicleCost.bus);
    const line = getTransitLines(state)[0];
    expect(line.vehicleCount).toBe(6);
    expect(line.fare).toBe(7);
    expect(line.name).toBe('5B 中環—銅鑼灣');
    expect(line.color).toBe('#ff3d7f');

    const treasuryAfterUp = state.finance.treasury;
    const down = updateTransitLine(state, 1, { vehicleCount: 2 });
    expect(down.ok).toBe(true);
    expect(down.refund).toBe(Math.round(4 * TRANSIT_LINE_CONFIG.vehicleCost.bus * 0.5));
    expect(state.finance.treasury - treasuryAfterUp).toBe(down.refund);
  });

  it('加車庫房不足 → 失敗且唔會部分套用', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    createTransitLine(state, busLineInput(fixture));
    state.finance.treasury = 1000;
    const result = updateTransitLine(state, 1, { vehicleCount: 12, name: '新名' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('庫房不足');
    const line = getTransitLines(state)[0];
    expect(line.vehicleCount).toBe(4);
    expect(line.name).not.toBe('新名');
  });

  it('非法票價／顏色 → 失敗', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    createTransitLine(state, busLineInput(fixture));
    expect(updateTransitLine(state, 1, { fare: 1 }).ok).toBe(false);
    expect(updateTransitLine(state, 1, { color: 'red' }).ok).toBe(false);
    expect(updateTransitLine(state, 999, { fare: 5 }).ok).toBe(false);
  });

  it('刪線：退 50% 車輛成本、移除路線與車輛', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    createTransitLine(state, busLineInput(fixture));
    for (let i = 0; i < 120; i++) tickVehicles(state, 48 * 0.016);
    expect(state.vehicles.some((vehicle) => vehicleLineId(vehicle) === 1)).toBe(true);

    const treasuryBefore = state.finance.treasury;
    const deleted = deleteTransitLine(state, 1);
    expect(deleted).toBe(true);
    expect(getTransitLines(state)).toHaveLength(0);
    expect(state.finance.treasury - treasuryBefore).toBe(
      Math.round(4 * TRANSIT_LINE_CONFIG.vehicleCost.bus * 0.5),
    );
    // 相關車輛即時移除
    expect(state.vehicles.some((vehicle) => vehicleLineId(vehicle) === 1)).toBe(false);
  });
});

describe('Round 5：覆蓋率與路線車輛', () => {
  it('路線站點併入 bus 模式覆蓋率', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    // 先只計巴士總站（legacy）覆蓋
    const before = computeTransitCoverage(state, true);
    const beforeBus = before.modes.find((mode) => mode.mode === 'bus');
    expect(beforeBus?.stations).toBe(1);
    createTransitLine(state, busLineInput(fixture));
    fixture.state.ui.revision++; // 模擬 main.ts bumpUI，令覆蓋率快取失效
    const after = computeTransitCoverage(state, true);
    const afterBus = after.modes.find((mode) => mode.mode === 'bus');
    expect(afterBus?.stations).toBeGreaterThan((beforeBus?.stations ?? 0));
    expect(afterBus?.capacity).toBeGreaterThan(beforeBus?.capacity ?? 0);
    expect(afterBus?.coverage).toBeGreaterThanOrEqual(beforeBus?.coverage ?? 0);
    expect(after.overall).toBeGreaterThanOrEqual(before.overall);
    expect(afterBus?.legacyCapacity).toBe(beforeBus?.capacity);
  });

  it('每線 spawn vehicleCount 架巴士／小巴並循環行駛', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    createTransitLine(state, busLineInput(fixture, { vehicleCount: 3, loop: true }));
    for (let i = 0; i < 400; i++) tickVehicles(state, 48 * 0.016);
    const lineVehicles = state.vehicles.filter((vehicle) => vehicleLineId(vehicle) === 1);
    expect(lineVehicles.length).toBe(3);
    expect(lineVehicles.every((vehicle) => vehicle.kind === 'bus')).toBe(true);
    const before = lineVehicles.map((vehicle) => `${vehicle.x.toFixed(2)},${vehicle.y.toFixed(2)}`);
    for (let i = 0; i < 200; i++) tickVehicles(state, 48 * 0.016);
    const after = state.vehicles
      .filter((vehicle) => vehicleLineId(vehicle) === 1)
      .map((vehicle) => `${vehicle.x.toFixed(2)},${vehicle.y.toFixed(2)}`);
    expect(after.some((position, index) => position !== before[index])).toBe(true);
  });

  it('颱風時路線車輛停駛，復航後重新出現', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    createTransitLine(state, busLineInput(fixture, { vehicleCount: 2 }));
    for (let i = 0; i < 300; i++) tickVehicles(state, 48 * 0.016);
    expect(state.vehicles.filter((vehicle) => vehicleLineId(vehicle) === 1).length).toBeGreaterThan(0);

    state.clock.weather = 'storm';
    for (let i = 0; i < 60; i++) tickVehicles(state, 48 * 0.016);
    expect(state.vehicles.filter((vehicle) => vehicleLineId(vehicle) === 1)).toHaveLength(0);

    state.clock.weather = 'clear';
    for (let i = 0; i < 200; i++) tickVehicles(state, 48 * 0.016);
    expect(state.vehicles.filter((vehicle) => vehicleLineId(vehicle) === 1).length).toBeGreaterThan(0);
  });
});
