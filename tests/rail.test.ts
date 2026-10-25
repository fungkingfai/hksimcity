/**
 * Round 6／Issue #5：港鐵地面／高架／地下鐵路測試（transport-dev）
 *
 * 覆蓋：rail:* 工具 helper、placeRail／removeRail 成本與地形限制、
 * computeRailNetwork 連通分量／車站接駁（≥2 站）／isolated snapshot、
 * tickRail 每日乘客／收入／颱風因素、railUpkeepMonthly、
 * transit coverage 對孤立站打折、tickTransit mtr 整合（唔 double count）、
 * vehicles 港鐵列車生成／行走／拆軌回收。
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RAIL_CONFIG, RAIL_INFO } from '../src/core/config';
import { createGameState } from '../src/core/new-game';
import type { Building, GameState, SimContext } from '../src/core/types';
import { markWorldChanged, worldRevisionOf } from '../src/sim/placement';
import {
  canPlaceRail,
  computeRailNetwork,
  getRailStats,
  invalidateRailCache,
  isRailRemoveTool,
  isRailTool,
  placeRail,
  railConnectedStations,
  railStationAccessTiles,
  railToolGrade,
  railTrainRoutes,
  railUpkeepMonthly,
  removeRail,
  tickRail,
} from '../src/sim/rail';
import { computeTransitCoverage, tickTransit } from '../src/sim/transit';
import { MAX_RAIL_TRAINS, tickVehicles } from '../src/sim/vehicles';

const ctx: SimContext = {
  toast: () => {
    /* noop */
  },
  log: () => {
    /* noop */
  },
};

interface RailFixture {
  state: GameState;
  /** 一條 ≥50 格連續陸地嘅 y 座標 */
  row: number;
  /** 該段陸地起點 x */
  x0: number;
  water: number;
  mountain: number;
  stationA: Building;
  stationB: Building;
  stationC: Building;
  homes: Building[];
  jobs: Building;
  buildingCount: number;
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

function makeFixture(): RailFixture {
  const state = createGameState(20261025, 'empty');
  state.gameMode = 'empty';
  state.ui.showTutorial = false;
  state.ui.showStartScreen = false;
  state.finance.treasury = 200_000_000;
  state.clock.weather = 'clear';
  state.clock.weekday = 1;
  const W = state.width;

  // 連續陸地（≥50 格）
  let row = -1;
  let x0 = -1;
  for (let y = 20; y < state.height - 5 && row < 0; y++) {
    let run = 0;
    for (let x = 20; x < state.width - 5; x++) {
      const tile = state.tiles[y * W + x];
      const land = tile && tile.terrain !== 'water' && tile.terrain !== 'mountain' && tile.terrain !== 'sand';
      if (land) {
        run++;
        if (run >= 50) {
          row = y;
          x0 = x - 49;
          break;
        }
      } else {
        run = 0;
      }
    }
  }
  if (row < 0) throw new Error('找不到足夠長嘅陸地');

  let water = -1;
  let mountain = -1;
  for (let i = 0; i < state.tiles.length && (water < 0 || mountain < 0); i++) {
    if (water < 0 && state.tiles[i].terrain === 'water') water = i;
    if (mountain < 0 && state.tiles[i].terrain === 'mountain') mountain = i;
  }

  // 三個港鐵站：A／B 喺同一段路軌上方（之後接駁），C 孤立
  const stationA = addBuilding(state, 'mtrStation', x0 + 4, row - 1, 2, 2);
  const stationB = addBuilding(state, 'mtrStation', x0 + 18, row - 1, 2, 2);
  const stationC = addBuilding(state, 'mtrStation', x0 + 34, row + 3, 2, 2);
  const homes: Building[] = [];
  for (let i = 0; i < 8; i++) {
    homes.push(addBuilding(state, 'publicHousing', x0 + 2 + i * 2, row - 3, 2, 2, 40));
  }
  const jobs = addBuilding(state, 'officeTower', x0 + 6, row - 5, 2, 2, 0, 60);
  // 市民（tickTransit 會計就業／通勤）
  const home = homes[0];
  for (let i = 0; i < 30; i++) {
    state.citizens.push({
      id: state.nextCitizenId++,
      name: `鐵路測試${i}`,
      age: 30,
      gender: 'male',
      homeId: home.id,
      workId: jobs.id,
      happiness: 70,
      money: 1000,
      salary: 18000,
      state: 'home',
      x: x0,
      y: row,
      path: [],
      pathProgress: 0,
      targetId: -1,
      commuteMode: 'mtr',
      look: 0.5,
      needs: { food: 80, goods: 80, leisure: 80 },
    });
  }

  return {
    state,
    row,
    x0,
    water,
    mountain,
    stationA,
    stationB,
    stationC,
    homes,
    jobs,
    buildingCount: state.buildings.length,
  };
}

let shared: RailFixture;
let resetCounter = 0;

beforeAll(() => {
  shared = makeFixture();
});

/** 重設可變狀態（清 rail／路線／車輛／財政／時鐘；保留世界與 fixture 建築） */
function resetFixture(): RailFixture {
  const fixture = shared;
  const state = fixture.state;
  state.buildings.length = fixture.buildingCount;
  for (const building of state.buildings) {
    building.active = true;
    building.connected = true;
  }
  for (let i = 0; i < state.tiles.length; i++) {
    if (state.tiles[i].rail) delete state.tiles[i].rail;
  }
  state.transitLines = [];
  state.nextTransitLineId = 1;
  state.vehicles.length = 0;
  state.nextVehicleId = 1;
  state.finance.treasury = 200_000_000;
  state.finance.incomeThisMonth = 0;
  state.finance.expenseThisMonth = 0;
  state.finance.incomeBreakdown = {};
  state.finance.expenseBreakdown = {};
  state.transit.dailyRidership = 0;
  state.transit.faresThisMonth = 0;
  state.transit.byMode = { mtr: 0, bus: 0, tram: 0, ferry: 0 };
  state.transit.suspended = false;
  state.stats.railStations = 0;
  state.stats.railLength = 0;
  state.clock.totalDays = 100 + ++resetCounter * 8;
  state.clock.year = 1;
  state.clock.month = 1;
  state.clock.day = 3;
  state.clock.weekday = 1;
  state.clock.weather = 'clear';
  state.clock.warning = null;
  state.clock.paused = false;
  state.clock.speed = 1;
  // 直接清 tile.rail（唔經 removeRail）→ 必須通知 rail 圖層快取失效
  invalidateRailCache();
  markWorldChanged();
  return fixture;
}

function freshFixture(): RailFixture {
  return resetFixture();
}

/** 沿 row 鋪一段鐵路（x0+from .. x0+to，含頭尾） */
function placeRailRun(fixture: RailFixture, from: number, to: number, grade: 'surface' | 'elevated' | 'underground' = 'surface'): void {
  for (let i = from; i <= to; i++) {
    const fixtureX = fixture.x0 + i;
    const existing = fixture.state.tiles[fixture.row * fixture.state.width + fixtureX]?.rail;
    if (existing) continue; // 已鋪過同一段（測試內分段鋪）
    const result = placeRail(fixture.state, fixtureX, fixture.row, grade);
    expect(result.ok, result.reason).toBe(true);
  }
}

function nextDay(state: GameState): void {
  state.clock.totalDays += 1;
  state.clock.day = (state.clock.day % 7) + 1;
  state.clock.weekday = (state.clock.weekday + 1) % 7;
  state.clock.weather = 'clear';
}

describe('Round 6：工具 helper 與放置規則', () => {
  it('rail:* 工具 helper 正確', () => {
    expect(isRailTool('rail:surface')).toBe(true);
    expect(isRailTool('rail:elevated')).toBe(true);
    expect(isRailTool('rail:underground')).toBe(true);
    expect(isRailTool('rail:remove')).toBe(true);
    expect(isRailTool('road')).toBe(false);
    expect(railToolGrade('rail:surface')).toBe('surface');
    expect(railToolGrade('rail:elevated')).toBe('elevated');
    expect(railToolGrade('rail:underground')).toBe('underground');
    expect(railToolGrade('rail:remove')).toBeNull();
    expect(isRailRemoveTool('rail:remove')).toBe(true);
  });

  it('地面鐵路：陸地成功、扣錢記 infrastructure、同格重複失敗', () => {
    const { state, row, x0 } = freshFixture();
    const treasuryBefore = state.finance.treasury;
    const result = placeRail(state, x0 + 10, row, 'surface');
    expect(result.ok).toBe(true);
    expect(result.cost).toBe(RAIL_INFO.surface.cost);
    expect(treasuryBefore - state.finance.treasury).toBe(RAIL_INFO.surface.cost);
    expect(state.finance.expenseBreakdown.infrastructure).toBe(RAIL_INFO.surface.cost);
    expect(state.tiles[row * state.width + x0 + 10].rail).toBe('surface');
    expect(placeRail(state, x0 + 10, row, 'surface').ok).toBe(false);
    expect(placeRail(state, x0 + 10, row, 'underground').ok).toBe(false);
  });

  it('地形限制：地面不可跨水／山；高架、地下可跨水；地下可穿山', () => {
    const { state, water, mountain } = freshFixture();
    const waterX = water % state.width;
    const waterY = Math.floor(water / state.width);
    expect(placeRail(state, waterX, waterY, 'surface').ok).toBe(false);
    expect(placeRail(state, waterX, waterY, 'elevated').ok).toBe(true);

    // 再搵一格水（避開已鋪）
    let water2 = -1;
    for (let i = 0; i < state.tiles.length; i++) {
      if (state.tiles[i].terrain === 'water' && !state.tiles[i].rail) {
        water2 = i;
        break;
      }
    }
    expect(water2).toBeGreaterThanOrEqual(0);
    expect(placeRail(state, water2 % state.width, Math.floor(water2 / state.width), 'underground').ok).toBe(true);

    if (mountain >= 0) {
      const mx = mountain % state.width;
      const my = Math.floor(mountain / state.width);
      expect(placeRail(state, mx, my, 'surface').ok).toBe(false);
      expect(placeRail(state, mx, my, 'underground').ok).toBe(true);
    }
  });

  it('超出地圖／庫房不足 → 失敗', () => {
    const { state, row, x0 } = freshFixture();
    expect(placeRail(state, -1, row, 'surface').ok).toBe(false);
    expect(placeRail(state, state.width + 5, row, 'surface').ok).toBe(false);
    state.finance.treasury = 10;
    const result = placeRail(state, x0 + 11, row, 'surface');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('庫房不足');
    expect(state.tiles[row * state.width + x0 + 11].rail).toBeUndefined();
  });

  it('拆除退 30% 並沖減 infrastructure；空地拆除失敗', () => {
    const { state, row, x0 } = freshFixture();
    placeRail(state, x0 + 12, row, 'surface');
    const treasuryBefore = state.finance.treasury;
    const result = removeRail(state, x0 + 12, row);
    expect(result.ok).toBe(true);
    expect(result.refund).toBe(Math.round(RAIL_INFO.surface.cost * 0.3));
    expect(state.finance.treasury - treasuryBefore).toBe(result.refund);
    expect(state.tiles[row * state.width + x0 + 12].rail).toBeUndefined();
    expect(removeRail(state, x0 + 12, row).ok).toBe(false);
  });

  it('canPlaceRail 唔會扣錢', () => {
    const { state, row, x0 } = freshFixture();
    const treasuryBefore = state.finance.treasury;
    const preview = canPlaceRail(state, x0 + 13, row, 'elevated');
    expect(preview.ok).toBe(true);
    expect(preview.cost).toBe(RAIL_INFO.elevated.cost);
    expect(state.finance.treasury).toBe(treasuryBefore);
    expect(state.tiles[row * state.width + x0 + 13].rail).toBeUndefined();
  });
});

describe('Round 6：路網連通與車站接駁', () => {
  it('連通分量：一段 6 格 = 1 分量；斷開兩段 = 2 分量', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    placeRailRun(fixture, 10, 15);
    let network = computeRailNetwork(state, true);
    expect(network.length).toBe(6);
    expect(network.components.length).toBe(1);
    expect(network.gradeCounts.surface).toBe(6);
    expect(network.maxComponentLength).toBe(6);

    placeRailRun(fixture, 20, 23);
    network = computeRailNetwork(state, true);
    expect(network.length).toBe(10);
    expect(network.components.length).toBe(2);
    expect(network.maxComponentLength).toBe(6);
  });

  it('已接駁車站（同分量 ≥2 站）／孤立車站 snapshot 正確', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    expect(computeRailNetwork(state, true).stations).toBe(3);
    // 只鋪 A 站附近 2 格：單站分量 → 當孤立
    placeRailRun(fixture, 4, 5);
    let network = computeRailNetwork(state, true);
    expect(network.connectedStations).toBe(0);
    expect(network.isolatedStations).toBe(3);

    // 鋪通 A→B（覆蓋兩站腳下）
    placeRailRun(fixture, 4, 19);
    network = computeRailNetwork(state, true);
    expect(network.connectedStations).toBe(2);
    expect(network.isolatedStations).toBe(1);
    expect(railConnectedStations(state).map((b) => b.id).sort()).toEqual(
      [fixture.stationA.id, fixture.stationB.id].sort(),
    );
    expect(railStationAccessTiles(state, fixture.stationA).length).toBeGreaterThan(0);

    // state.railNetwork snapshot（Lead 型別）
    const snapshot = state.railNetwork;
    expect(snapshot).toBeDefined();
    expect(snapshot?.revision).toBe(worldRevisionOf());
    expect(snapshot?.totalLength).toBe(network.length);
    expect(snapshot?.components).toBe(network.components.length);
    expect(snapshot?.largestComponent).toBe(network.maxComponentLength);
    expect(snapshot?.stations).toBe(3);
    expect(snapshot?.connectedStations).toBe(2);
    expect(snapshot?.isolatedStations).toBe(1);
    expect(snapshot?.upkeep).toBe(railUpkeepMonthly(state));
  });

  it('列車路線：有 ≥2 接駁站才產生，path 全部係 rail', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    placeRailRun(fixture, 4, 5);
    expect(railTrainRoutes(state)).toHaveLength(0);
    placeRailRun(fixture, 4, 19);
    const routes = railTrainRoutes(state);
    expect(routes.length).toBe(1);
    expect(routes[0].stations).toBe(2);
    expect(routes[0].trains).toBeGreaterThanOrEqual(1);
    expect(routes[0].path.length).toBeGreaterThan(1);
    expect(routes[0].path.every((tile) => !!state.tiles[tile].rail)).toBe(true);
  });

  it('railUpkeepMonthly = 各 grade 長度 × upkeep + 接駁站 × stationUpkeep', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    placeRailRun(fixture, 4, 19); // 16 格 surface
    placeRailRun(fixture, 40, 42, 'elevated'); // 3 格 elevated
    placeRailRun(fixture, 45, 46, 'underground'); // 2 格 underground
    const network = computeRailNetwork(state, true);
    const expected = Math.round(
      network.gradeCounts.surface * RAIL_INFO.surface.upkeep +
        network.gradeCounts.elevated * RAIL_INFO.elevated.upkeep +
        network.gradeCounts.underground * RAIL_INFO.underground.upkeep +
        network.connectedStations * RAIL_CONFIG.stationUpkeep,
    );
    expect(railUpkeepMonthly(state)).toBe(expected);
    expect(getRailStats(state).upkeepMonthly).toBe(expected);
  });
});

describe('Round 6：tickRail 每日營運', () => {
  it('乘客／票價／stats 正確；同日 idempotent', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    placeRailRun(fixture, 4, 19); // 16 格 surface，接駁 A/B
    const network = computeRailNetwork(state, true);
    const expectedRidership = Math.round(
      Math.min(
        network.connectedStations * RAIL_CONFIG.baseRidershipPerStation +
          network.length * RAIL_CONFIG.ridershipPerTrackTile,
        network.capacity * 0.95,
      ),
    );
    nextDay(state);
    state.clock.weather = 'clear';
    const treasuryBefore = state.finance.treasury;
    const faresBefore = state.finance.incomeBreakdown.fares ?? 0;
    const summary = tickRail(state, ctx);
    expect(summary.connectedStations).toBe(2);
    expect(summary.length).toBe(network.length);
    expect(summary.ridership).toBe(expectedRidership);
    expect(summary.fares).toBe(expectedRidership * RAIL_CONFIG.farePerRide);
    expect(state.finance.treasury - treasuryBefore).toBe(summary.fares);
    expect((state.finance.incomeBreakdown.fares ?? 0) - faresBefore).toBe(summary.fares);
    expect(state.transit.byMode.mtr).toBe(summary.ridership);
    expect(state.transit.faresThisMonth).toBeGreaterThanOrEqual(summary.fares);
    expect(state.stats.railStations).toBe(2);
    expect(state.stats.railLength).toBe(network.length);
    // 同日再 call 唔會再入帳
    const treasuryAfter = state.finance.treasury;
    const again = tickRail(state, ctx);
    expect(again.ridership).toBe(summary.ridership);
    expect(state.finance.treasury).toBe(treasuryAfter);
  });

  it('颱風：地面段乘客 50%、地下段 80%', () => {
    const surfaceFixture = freshFixture();
    placeRailRun(surfaceFixture, 4, 19);
    nextDay(surfaceFixture.state);
    surfaceFixture.state.clock.weather = 'clear';
    const clearSurface = tickRail(surfaceFixture.state, ctx);
    nextDay(surfaceFixture.state);
    surfaceFixture.state.clock.weather = 'storm';
    const stormSurface = tickRail(surfaceFixture.state, ctx);
    expect(stormSurface.groundFactor).toBe(0.5);
    expect(stormSurface.ridership).toBeLessThan(clearSurface.ridership);
    expect(stormSurface.ridership).toBeGreaterThan(0);

    const underFixture = freshFixture();
    placeRailRun(underFixture, 4, 19, 'underground');
    nextDay(underFixture.state);
    underFixture.state.clock.weather = 'clear';
    const clearUnder = tickRail(underFixture.state, ctx);
    nextDay(underFixture.state);
    underFixture.state.clock.weather = 'storm';
    const stormUnder = tickRail(underFixture.state, ctx);
    expect(stormUnder.undergroundFactor).toBe(0.8);
    expect(stormUnder.ridership).toBeGreaterThan(Math.round(clearUnder.ridership * 0.7));
    expect(stormUnder.ridership).toBeLessThan(clearUnder.ridership);
  });

  it('冇已接駁車站時唔會改動 mtr byMode（舊半徑玩法保留）', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    placeRailRun(fixture, 40, 42); // 遠離車站，冇 connected station
    nextDay(state);
    state.clock.weather = 'clear';
    const summary = tickRail(state, ctx);
    expect(summary.connectedStations).toBe(0);
    expect(summary.ridership).toBe(0);
    expect(state.transit.byMode.mtr).toBe(0);
  });
});

describe('Round 6：transit 覆蓋率與 tickTransit 整合', () => {
  it('未接駁鐵路的 mtrStation 覆蓋率 × isolatedStationCoverage', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    // 冇 rail：舊半徑覆蓋全額
    const noRail = computeTransitCoverage(state, true).modes.find((mode) => mode.mode === 'mtr');
    expect(noRail?.residentialCoverage).toBeGreaterThan(0.9);

    // 有 rail 但全部遠離車站 → 車站孤立，覆蓋率 ×0.35
    placeRailRun(fixture, 40, 42);
    const isolated = computeTransitCoverage(state, true).modes.find((mode) => mode.mode === 'mtr');
    expect(isolated?.residentialCoverage).toBeCloseTo(RAIL_CONFIG.isolatedStationCoverage, 2);

    // 接駁 A/B → 兩站覆蓋恢復全額（C 仍孤立，但佢半徑內冇住宅）
    placeRailRun(fixture, 4, 19);
    const connected = computeTransitCoverage(state, true).modes.find((mode) => mode.mode === 'mtr');
    expect(connected?.residentialCoverage).toBeGreaterThan(0.9);
  });

  it('tickTransit：mtr 載客 = 鐵路網 + 舊半徑 30%，車費唔 double count', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    placeRailRun(fixture, 4, 19);
    nextDay(state);
    state.clock.weather = 'clear';
    const railTick = tickRail(state, ctx); // tickTransit 會重用同日 summary
    const faresBefore = state.finance.incomeBreakdown.fares ?? 0;
    tickTransit(state, ctx);
    const addedFares = (state.finance.incomeBreakdown.fares ?? 0) - faresBefore;
    expect(state.transit.byMode.mtr).toBeGreaterThanOrEqual(railTick.ridership);
    // 只會補舊半徑部分（30%），唔會整條鐵路收入再入一次
    expect(addedFares).toBeLessThan(railTick.fares * 2);
    expect(addedFares - railTick.fares).toBeLessThan(2000);
    expect(Number.isFinite(state.stats.transitCoverage)).toBe(true);
    expect(state.stats.transitCoverage).toBeGreaterThan(0);
  });
});

describe('Round 6：vehicles 港鐵列車', () => {
  it('有鐵路網就派 mtr 列車沿軌行駛，數目 ≤ MAX_RAIL_TRAINS', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    placeRailRun(fixture, 4, 19);
    for (let i = 0; i < 300; i++) tickVehicles(state, 48 * 0.016);
    const trains = state.vehicles.filter((vehicle) => vehicle.kind === 'mtr');
    expect(trains.length).toBeGreaterThan(0);
    expect(trains.length).toBeLessThanOrEqual(MAX_RAIL_TRAINS);
    for (const train of trains) {
      expect(train.path.length).toBeGreaterThan(1);
      expect(train.path.every((tile) => !!state.tiles[tile].rail)).toBe(true);
      expect(Number.isFinite(train.x)).toBe(true);
    }
    // 有行駛（位置會變）
    const before = trains.map((train) => `${train.x.toFixed(2)},${train.y.toFixed(2)}`);
    for (let i = 0; i < 120; i++) tickVehicles(state, 48 * 0.016);
    const after = state.vehicles
      .filter((vehicle) => vehicle.kind === 'mtr')
      .map((train) => `${train.x.toFixed(2)},${train.y.toFixed(2)}`);
    expect(after.some((pos, index) => pos !== before[index])).toBe(true);
  });

  it('颱風時列車維持行駛；拆走所有路軌後列車消失', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    placeRailRun(fixture, 4, 19);
    for (let i = 0; i < 300; i++) tickVehicles(state, 48 * 0.016);
    expect(state.vehicles.some((vehicle) => vehicle.kind === 'mtr')).toBe(true);

    state.clock.weather = 'storm';
    for (let i = 0; i < 120; i++) tickVehicles(state, 48 * 0.016);
    expect(state.vehicles.some((vehicle) => vehicle.kind === 'mtr')).toBe(true);

    // 拆走所有路軌（用 removeRail，會 markWorldChanged）
    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const tile = state.tiles[y * state.width + x];
        if (tile.rail) removeRail(state, x, y);
      }
    }
    state.clock.weather = 'clear';
    for (let i = 0; i < 60; i++) tickVehicles(state, 48 * 0.016);
    expect(state.vehicles.filter((vehicle) => vehicle.kind === 'mtr')).toHaveLength(0);
  });

  it('getRailStats 回傳統計', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    placeRailRun(fixture, 4, 19);
    const stats = getRailStats(state);
    expect(stats.length).toBe(computeRailNetwork(state).length);
    expect(stats.connectedStations).toBe(2);
    expect(stats.isolatedStations).toBe(1);
    expect(stats.components).toBe(1);
    expect(stats.upkeepMonthly).toBeGreaterThan(0);
  });
});
