/**
 * Round 8／Issue #16：渡輪航道（船在陸上修正）＋ Issue #11：道路 grade 唔影響車輛。
 *
 * #16 根因：舊實作揀兩個碼頭對開水域點，再用直線取樣（isWaterLine）判斷；
 * 兩點之間嘅直線可以切過陸地角落／短半島（取樣解析度問題），而渡輪 render
 * 只係兩點直線插值 → 用戶見到船喺馬路／陸地上。修正：用 4 鄰接水域 BFS
 * 搵完整 water-only path（>400 格 skip），spawn 前及每次行程重用時驗證全條航道；
 * 地形改動令航道失效就回收。
 *
 * #11：車輛路徑只依賴 `tile.road`（A*／BFS 都唔睇 roadGrade）；道路 grade
 * （surface／elevated／tunnel）只影響 placement／render。以下用 mock grade 驗證
 * 車輛可正常生成、行駛、回收。
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TRANSIT_SPEED } from '../src/core/config';
import { createGameState } from '../src/core/new-game';
import type { Building, GameState, RoadGrade, SimContext, Vehicle } from '../src/core/types';
import { tickVehicles, trafficVehicleTargets } from '../src/sim/vehicles';

const ctx: SimContext = {
  toast: () => {
    /* noop */
  },
  log: () => {
    /* noop */
  },
};

const AREA = { x0: 120, y0: 120, w: 70, h: 40 };

interface FerryFixture {
  state: GameState;
  waterBlock: { x0: number; y0: number; w: number; h: number };
  landStrip: { x0: number; y0: number; w: number; h: number };
  bridgeRoad: { x: number; y: number };
}

let shared: FerryFixture;
let resetCounter = 0;

function idx(state: GameState, x: number, y: number): number {
  return y * state.width + x;
}

function setTerrain(state: GameState, x: number, y: number, terrain: 'water' | 'grass'): void {
  const tile = state.tiles[idx(state, x, y)];
  if (!tile) return;
  tile.terrain = terrain;
  tile.elevation = 0.4;
  tile.buildingId = -1;
  delete tile.roadGrade;
  if (terrain === 'water') {
    tile.road = false;
    tile.sidewalk = false;
  }
}

function paintLandRect(state: GameState, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) setTerrain(state, x, y, 'grass');
  }
}

function paintWaterRect(state: GameState, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) setTerrain(state, x, y, 'water');
  }
}

function addBuilding(state: GameState, key: string, x: number, y: number, w: number, h: number): Building {
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
  state.buildings.push(building);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const tile = state.tiles[(y + dy) * state.width + x + dx];
      if (tile) tile.buildingId = building.id;
    }
  }
  return building;
}

function makeFixture(): FerryFixture {
  const state = createGameState(80016, 'empty');
  state.gameMode = 'empty';
  state.ui.showTutorial = false;
  state.ui.showStartScreen = false;
  state.clock.weather = 'clear';
  state.clock.paused = false;
  state.clock.speed = 1;
  state.finance.treasury = 500_000_000;

  // 先將測試區域全部變陸地（包住水域，避免 BFS 由地圖其他水域繞過屏障）
  paintLandRect(state, AREA.x0, AREA.y0, AREA.w, AREA.h);

  return {
    state,
    // 全水路測試：大水域（內陸測試區）
    waterBlock: { x0: AREA.x0 + 6, y0: AREA.y0 + 6, w: 42, h: 20 },
    // 有陸地屏障測試：左右兩個水域，中間 7 格陸地牆
    landStrip: { x0: AREA.x0 + 25, y0: AREA.y0 + 6, w: 7, h: 20 },
    bridgeRoad: { x: AREA.x0 + 8, y: AREA.y0 + 33 },
  };
}

beforeAll(() => {
  shared = makeFixture();
});

/** 重設可變狀態＋重建測試區域地貌（每 test 獨立） */
function freshFixture(): FerryFixture {
  const fixture = shared;
  const state = fixture.state;
  resetCounter++;
  state.buildings.length = 0;
  state.nextBuildingId = 1;
  state.transitLines = [];
  state.nextTransitLineId = 1;
  state.vehicles.length = 0;
  state.nextVehicleId = 1;
  state.citizens.length = 0;
  state.carts.length = 0;
  state.finance.treasury = 500_000_000;
  state.finance.incomeThisMonth = 0;
  state.finance.expenseThisMonth = 0;
  state.finance.incomeBreakdown = {};
  state.finance.expenseBreakdown = {};
  state.transit.dailyRidership = 0;
  state.transit.faresThisMonth = 0;
  state.transit.byMode = { mtr: 0, bus: 0, tram: 0, ferry: 0 };
  state.transit.suspended = false;
  state.clock.totalDays = 200 + resetCounter * 8;
  state.clock.year = 1;
  state.clock.month = 1;
  state.clock.day = 3;
  state.clock.weekday = 1;
  state.clock.weather = 'clear';
  state.clock.warning = null;
  state.clock.paused = false;
  state.clock.speed = 1;

  // 重建測試區：全部陸地
  paintLandRect(state, AREA.x0, AREA.y0, AREA.w, AREA.h);
  // 一小段道路（畀 tickVehicles 通過「有道路」門檻；渡輪唔受道路影響）
  for (let dx = 0; dx < 16; dx++) {
    const tile = state.tiles[idx(state, fixture.bridgeRoad.x + dx, fixture.bridgeRoad.y)];
    if (tile) {
      tile.road = true;
      tile.sidewalk = true;
      tile.terrain = 'grass';
    }
  }
  state.ui.revision += 1;
  return fixture;
}

/** 全水路場景：一個大水域＋左右岸各一個渡輪碼頭 */
function setupOpenWater(fixture: FerryFixture): void {
  const { state, waterBlock } = fixture;
  paintWaterRect(state, waterBlock.x0, waterBlock.y0, waterBlock.w, waterBlock.h);
  // 碼頭 A：水域左上、碼頭貼住水域上邊
  addBuilding(state, 'ferryPier', waterBlock.x0 + 4, waterBlock.y0 - 3, 3, 2);
  // 碼頭 B：水域右下、碼頭貼住水域下邊
  addBuilding(state, 'ferryPier', waterBlock.x0 + waterBlock.w - 8, waterBlock.y0 + waterBlock.h + 1, 3, 2);
  state.ui.revision += 1;
}

/** 有陸地屏障場景：兩個水域由 7 格陸地分隔 */
function setupSplitWater(fixture: FerryFixture): void {
  const { state, waterBlock, landStrip } = fixture;
  paintWaterRect(state, waterBlock.x0, waterBlock.y0, waterBlock.w, waterBlock.h);
  // 中間整條陸地牆（由水域上邊至下邊）
  paintLandRect(state, landStrip.x0, landStrip.y0, landStrip.w, landStrip.h);
  addBuilding(state, 'ferryPier', waterBlock.x0 + 4, waterBlock.y0 - 3, 3, 2);
  addBuilding(state, 'ferryPier', landStrip.x0 + landStrip.w + 8, waterBlock.y0 + waterBlock.h + 1, 3, 2);
  state.ui.revision += 1;
}

function ferriesOf(state: GameState): Vehicle[] {
  return state.vehicles.filter((vehicle) => vehicle.kind === 'ferry');
}

function tileIsWater(state: GameState, x: number, y: number): boolean {
  return state.tiles[idx(state, Math.floor(x), Math.floor(y))]?.terrain === 'water';
}

function runVehicleTicks(state: GameState, frames: number, gameMinutes = 0.8): void {
  for (let i = 0; i < frames; i++) tickVehicles(state, gameMinutes);
}

describe('Issue #16：渡輪航道（水域 BFS）', () => {
  it('全水路：可以 spawn，path 每格都係 water', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    setupOpenWater(fixture);
    // 確認 ferry 目標 > 0
    const targets = trafficVehicleTargets(state);
    expect(targets.ferry).toBeGreaterThan(0);
    runVehicleTicks(state, 600);
    const ferries = ferriesOf(state);
    expect(ferries.length).toBeGreaterThan(0);
    for (const ferry of ferries) {
      expect(ferry.path.length).toBeGreaterThanOrEqual(3);
      expect(ferry.path.every((tile) => state.tiles[tile]?.terrain === 'water')).toBe(true);
      expect(tileIsWater(state, ferry.x, ferry.y)).toBe(true);
    }
  });

  it('中間有陸地屏障：不得 spawn（唔會船喺陸地／馬路）', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    setupSplitWater(fixture);
    const targets = trafficVehicleTargets(state);
    expect(targets.ferry).toBeGreaterThan(0); // 有兩個碼頭，但 BFS 唔通
    runVehicleTicks(state, 900);
    expect(ferriesOf(state)).toHaveLength(0);
    // 所有車輛都唔會路過測試水域以外嘅陸地航道（根本冇 ferry）
    expect(state.vehicles.every((vehicle) => vehicle.kind !== 'ferry')).toBe(true);
  });

  it('渡輪航行 20 日：每一步位置仍喺 water tile', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    setupOpenWater(fixture);
    runVehicleTicks(state, 600);
    const ferries = ferriesOf(state);
    expect(ferries.length).toBeGreaterThan(0);

    // 20 遊戲日 = 28800 遊戲分鐘；每 tick 2 分鐘 → 14400 ticks
    const ticks = (20 * 1440) / 2;
    let offWater = 0;
    const initial = ferries.map((ferry) => ferry.id);
    for (let i = 0; i < ticks; i++) {
      tickVehicles(state, 2);
      if (i % 20 !== 0) continue;
      for (const ferry of ferriesOf(state)) {
        if (!tileIsWater(state, ferry.x, ferry.y)) offWater++;
      }
    }
    expect(offWater).toBe(0);
    // 20 日後仍然有渡輪（唔會全部漂走／卡死）
    expect(ferriesOf(state).length).toBeGreaterThan(0);
    expect(initial.length).toBeGreaterThan(0);
    // 航道全程仍然係水
    for (const ferry of ferriesOf(state)) {
      expect(ferry.path.every((tile) => state.tiles[tile]?.terrain === 'water')).toBe(true);
    }
  });

  it('航道被地形改動破壞：下一次 update 會回收（唔會照樣喺陸地行）', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    setupOpenWater(fixture);
    runVehicleTicks(state, 600);
    const ferries = ferriesOf(state);
    expect(ferries.length).toBeGreaterThan(0);
    const ferry = ferries[0];
    // 將航道其中一格改做陸地（模擬玩家／地圖改動）
    const blocked = ferry.path[Math.floor(ferry.path.length / 2)];
    state.tiles[blocked].terrain = 'grass';
    // 再多改一格確保 BFS 唔會即刻搵到只差一格嘅替代路徑而繼續「合法」
    const blocked2 = ferry.path[Math.floor(ferry.path.length / 2) + 1];
    if (blocked2 !== undefined) state.tiles[blocked2].terrain = 'grass';
    // 只行一幀：舊渡輪應即時被標記回收（sync 之後可能重派新船，但唔會用舊 invalid path）
    tickVehicles(state, 0.01);
    for (const remaining of ferriesOf(state)) {
      expect(remaining.path.every((tile) => state.tiles[tile]?.terrain === 'water')).toBe(true);
      expect(tileIsWater(state, remaining.x, remaining.y)).toBe(true);
    }
    expect(ferry.done).toBe(true);
  });

  it('渡輪速度比路面車慢（VEHICLE 常數 sanity）', () => {
    // 只係確保 ferry 有合理速度；TRANSIT_SPEED.ferry 係通勤時間倍率，唔係車輛速度
    expect(TRANSIT_SPEED.ferry).toBeGreaterThan(0);
    const fixture = freshFixture();
    setupOpenWater(fixture);
    runVehicleTicks(fixture.state, 600);
    for (const ferry of ferriesOf(fixture.state)) {
      expect(ferry.speed).toBeGreaterThan(0);
      expect(ferry.speed).toBeLessThan(0.5);
    }
  });
});

describe('Issue #11：道路 grade（surface／elevated／tunnel）唔影響車輛 sim', () => {
  /** 喺測試區鋪一段東西向道路，回傳 tile indices；grade 用 mock 寫入 tile.roadGrade */
  function paintRoad(state: GameState, grade: RoadGrade | undefined, count = 24): number[] {
    const tiles: number[] = [];
    const startX = AREA.x0 + 4;
    const y = AREA.y0 + 36;
    for (let i = 0; i < count; i++) {
      const tile = state.tiles[idx(state, startX + i, y)];
      tile.terrain = 'grass';
      tile.road = true;
      tile.sidewalk = true;
      tile.buildingId = -1;
      if (grade) tile.roadGrade = grade;
      else delete tile.roadGrade;
      tiles.push(idx(state, startX + i, y));
    }
    state.ui.revision += 1;
    return tiles;
  }

  it('elevated／tunnel 道路上車輛可生成、沿 tile.road 移動（path 只認 road，唔認 grade）', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    // 先清走預設道路，只留測試道路
    for (let i = 0; i < state.tiles.length; i++) {
      state.tiles[i].road = false;
      state.tiles[i].sidewalk = false;
    }
    const elevated = paintRoad(state, 'elevated');
    expect(elevated.length).toBe(24);
    expect(state.tiles[elevated[0]].roadGrade).toBe('elevated');

    // 加人口（車輛目標數跟人口）＋少量市民
    for (let i = 0; i < 300; i++) {
      state.citizens.push({
        id: state.nextCitizenId++,
        name: `道路測試${i}`,
        age: 30,
        gender: 'male',
        homeId: -1,
        workId: -1,
        happiness: 70,
        money: 1000,
        salary: 18000,
        state: 'home',
        x: 130,
        y: 155,
        path: [],
        pathProgress: 0,
        targetId: -1,
        commuteMode: 'walk',
        look: 0.5,
        needs: { food: 80, goods: 80, leisure: 80 },
      });
    }
    runVehicleTicks(state, 500);
    const roadVehicles = state.vehicles.filter((vehicle) => vehicle.kind !== 'ferry' && vehicle.kind !== 'mtr');
    expect(roadVehicles.length).toBeGreaterThan(0);
    for (const vehicle of roadVehicles) {
      expect(vehicle.path.length).toBeGreaterThan(1);
      expect(vehicle.path.every((tile) => state.tiles[tile]?.road)).toBe(true);
    }

    // 行駛中位置會變
    const before = roadVehicles.map((vehicle) => `${vehicle.x.toFixed(2)},${vehicle.y.toFixed(2)}`);
    runVehicleTicks(state, 200);
    const after = state.vehicles
      .filter((vehicle) => vehicle.kind !== 'ferry' && vehicle.kind !== 'mtr')
      .map((vehicle) => `${vehicle.x.toFixed(2)},${vehicle.y.toFixed(2)}`);
    expect(after.some((pos, index) => pos !== before[index])).toBe(true);

    // 同一段路全部改做 tunnel grade：車輛照行，唔會因為 grade 而卡死／回收
    for (const tileIndex of elevated) state.tiles[tileIndex].roadGrade = 'tunnel';
    state.ui.revision += 1;
    runVehicleTicks(state, 200);
    const afterTunnel = state.vehicles.filter((vehicle) => vehicle.kind !== 'ferry' && vehicle.kind !== 'mtr');
    expect(afterTunnel.length).toBeGreaterThan(0);
    for (const vehicle of afterTunnel) {
      expect(vehicle.path.every((tile) => state.tiles[tile]?.road)).toBe(true);
      expect(Number.isFinite(vehicle.x)).toBe(true);
    }
  });

  it('冇 roadGrade 欄位（舊存檔／普通地面路）行為不變', () => {
    const fixture = freshFixture();
    const { state } = fixture;
    for (let i = 0; i < state.tiles.length; i++) {
      state.tiles[i].road = false;
      state.tiles[i].sidewalk = false;
    }
    const roads = paintRoad(state, undefined);
    expect(state.tiles[roads[0]].roadGrade).toBeUndefined();
    runVehicleTicks(state, 400);
    const roadVehicles = state.vehicles.filter((vehicle) => vehicle.kind !== 'ferry' && vehicle.kind !== 'mtr');
    expect(roadVehicles.length).toBeGreaterThan(0);
    for (const vehicle of roadVehicles) {
      expect(vehicle.path.every((tile) => state.tiles[tile]?.road)).toBe(true);
    }
  });
});
