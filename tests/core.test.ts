/**
 * 《維港之城》核心與世界單元測試（vitest）
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUILDINGS,
  BUILDING_LIST,
  CATEGORY_INFO,
  GRID_HEIGHT,
  GRID_WIDTH,
  RESOURCES,
  RESOURCE_KEYS,
  ROAD_COST,
  SIDEWALK_COST,
  START_TREASURY,
  START_YEAR,
  TERRAIN_INFO,
  TRANSIT_INFO,
  WEATHER_EFFECT,
  WEATHER_INFO,
  WEATHER_WEIGHTS,
  formatMoney,
  formatMoneyShort,
  seasonOfMonth,
} from '../src/core/config';
import { createClock, createGameState } from '../src/core/new-game';
import { generateWorld } from '../src/world/worldgen';
import { formatGameDate, formatShortDate, weekdayName } from '../src/core/format';
import { normalizeState, listSaves } from '../src/core/save';
import type { GameState, TerrainType, Weather } from '../src/core/types';

// Node 環境的 localStorage 模擬
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
});

// ─────────────────────────── 設定資料表 ───────────────────────────

describe('香港設定資料表', () => {
  it('地圖為 480×480（真實香港地理數據；96×96 的 25 倍面積）、起始庫房與道路造價合理', () => {
    expect(GRID_WIDTH).toBe(480);
    expect(GRID_HEIGHT).toBe(480);
    expect(GRID_WIDTH * GRID_HEIGHT).toBeGreaterThanOrEqual(96 * 96 * 25);
    expect(START_TREASURY).toBeGreaterThan(1_000_000);
    expect(ROAD_COST).toBeGreaterThan(0);
    expect(SIDEWALK_COST).toBeGreaterThan(0);
    expect(SIDEWALK_COST).toBeLessThan(ROAD_COST);
  });

  it('至少 31 種香港建築，資料完整', () => {
    expect(BUILDING_LIST.length).toBeGreaterThanOrEqual(31);
    const keys = new Set(BUILDING_LIST.map((d) => d.key));
    expect(keys.size).toBe(BUILDING_LIST.length);
    // 必備香港建築
    for (const key of [
      'tongLau',
      'subdividedFlat',
      'publicHousing',
      'hOSFlat',
      'privateEstate',
      'luxuryTower',
      'chaChaanTeng',
      'convenienceStore',
      'wetMarket',
      'supermarket',
      'shoppingMall',
      'restaurant',
      'officeTower',
      'industrialBuilding',
      'farm',
      'foodFactory',
      'powerPlant',
      'waterworks',
      'containerPort',
      'importFirm',
      'warehouse',
      'school',
      'hospital',
      'policeStation',
      'fireStation',
      'park',
      'promenade',
      'mtrStation',
      'busTerminus',
      'tramStop',
      'ferryPier',
    ]) {
      expect(BUILDINGS[key], key).toBeTruthy();
    }
  });

  it('建築數值與類別合法', () => {
    for (const def of BUILDING_LIST) {
      expect(def.key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.category in CATEGORY_INFO).toBe(true);
      expect(def.size[0]).toBeGreaterThan(0);
      expect(def.size[1]).toBeGreaterThan(0);
      expect(def.cost).toBeGreaterThan(0);
      expect(def.upkeep).toBeGreaterThanOrEqual(0);
      expect(def.unlockPop).toBeGreaterThanOrEqual(0);
      expect(typeof def.color).toBe('number');
      expect(def.interior, `${def.key} 必須有室內場景 key`).toBeTruthy();
      if (def.production) {
        expect(RESOURCE_KEYS).toContain(def.production.output);
        expect(def.production.amountPerDay).toBeGreaterThan(0);
        if (def.production.input) expect(RESOURCE_KEYS).toContain(def.production.input.resource);
      }
      if (def.storage) {
        expect(def.storage.capacity).toBeGreaterThan(0);
        if (def.storage.accepted !== 'all') {
          for (const resource of def.storage.accepted) expect(RESOURCE_KEYS).toContain(resource);
        }
      }
      if (def.service?.consumes) {
        expect(RESOURCE_KEYS).toContain(def.service.consumes.resource);
      }
      if (def.transit) {
        expect(Object.keys(TRANSIT_INFO)).toContain(def.transit.mode);
        expect(def.transit.radius).toBeGreaterThan(0);
        expect(def.transit.capacity).toBeGreaterThan(0);
        expect(def.transit.fare).toBeGreaterThan(0);
      }
      if (def.utility) {
        expect(['water', 'power']).toContain(def.utility.kind);
        expect(def.utility.radius).toBeGreaterThan(0);
        expect(def.utility.capacity).toBeGreaterThan(0);
      }
    }
  });

  it('四種物流資源與價格齊全', () => {
    expect(RESOURCE_KEYS.sort()).toEqual(['electronics', 'food', 'goods', 'materials']);
    for (const key of RESOURCE_KEYS) {
      expect(RESOURCES[key].price).toBeGreaterThan(0);
      expect(RESOURCES[key].name.length).toBeGreaterThan(0);
    }
  });

  it('地形資料表齊全且至少五種可建', () => {
    const terrains: TerrainType[] = [
      'grass',
      'urban',
      'reclaimed',
      'fertile',
      'wetland',
      'forest',
      'hill',
      'mountain',
      'water',
      'sand',
    ];
    for (const terrain of terrains) expect(TERRAIN_INFO[terrain]).toBeTruthy();
    const buildable = terrains.filter((t) => TERRAIN_INFO[t].buildable);
    expect(buildable.length).toBeGreaterThanOrEqual(5);
    expect(TERRAIN_INFO.water.buildable).toBe(false);
    expect(TERRAIN_INFO.mountain.buildable).toBe(false);
  });

  it('香港季節按月份正確劃分', () => {
    expect(seasonOfMonth(3)).toBe('spring');
    expect(seasonOfMonth(5)).toBe('spring');
    expect(seasonOfMonth(6)).toBe('summer');
    expect(seasonOfMonth(8)).toBe('summer');
    expect(seasonOfMonth(9)).toBe('autumn');
    expect(seasonOfMonth(11)).toBe('autumn');
    expect(seasonOfMonth(12)).toBe('winter');
    expect(seasonOfMonth(1)).toBe('winter');
    expect(seasonOfMonth(2)).toBe('winter');
  });

  it('六種香港天氣（晴／陰／雨／颱風／霧／雪）齊全', () => {
    const weathers: Weather[] = ['clear', 'cloudy', 'rain', 'storm', 'fog', 'snow'];
    for (const w of weathers) {
      expect(WEATHER_INFO[w]).toBeTruthy();
      expect(WEATHER_EFFECT[w]).toBeTruthy();
      for (const season of ['spring', 'summer', 'autumn', 'winter'] as const) {
        expect(WEATHER_WEIGHTS[season][w]).toBeGreaterThanOrEqual(0);
      }
    }
    // 雪只在冬季
    expect(WEATHER_WEIGHTS.summer.snow).toBe(0);
    expect(WEATHER_WEIGHTS.winter.snow).toBeGreaterThan(0);
    // 颱風夏季最多
    expect(WEATHER_WEIGHTS.summer.storm).toBeGreaterThan(WEATHER_WEIGHTS.winter.storm);
  });

  it('港幣格式', () => {
    expect(formatMoney(1_234_567)).toBe('$1,234,567');
    expect(formatMoney(-5000)).toBe('-$5,000');
    expect(formatMoneyShort(2_500_000)).toBe('$250萬');
    expect(formatMoneyShort(1_500)).toBe('$1,500');
  });
});

// ─────────────────────────── 香港地圖 ───────────────────────────

describe('香港地圖世界生成', () => {
  it('生成 480×480、tile 陣列與 spawn', () => {
    const world = generateWorld(20261021);
    expect(world.width).toBe(480);
    expect(world.height).toBe(480);
    expect(world.tiles.length).toBe(480 * 480);
    expect(world.spawn.x).toBeGreaterThan(0);
    expect(world.spawn.y).toBeGreaterThan(0);
    expect(world.spawn.x).toBeLessThan(480);
    expect(world.spawn.y).toBeLessThan(480);
    for (const tile of world.tiles) {
      expect(tile.buildingId).toBe(-1);
      expect(tile.elevation).toBeGreaterThanOrEqual(0);
      expect(tile.elevation).toBeLessThanOrEqual(1);
    }
  });

  it('有維港水域、山地與多種地形', () => {
    const world = generateWorld(20261021);
    const counts = new Map<string, number>();
    for (const tile of world.tiles) counts.set(tile.terrain, (counts.get(tile.terrain) ?? 0) + 1);
    expect(counts.get('water') ?? 0).toBeGreaterThan(200);
    expect(counts.get('mountain') ?? 0).toBeGreaterThan(20);
    expect(counts.get('urban') ?? 0).toBeGreaterThan(50);
    expect((counts.get('fertile') ?? 0) + (counts.get('grass') ?? 0)).toBeGreaterThan(300);
  });

  it('spawn 周邊可建且不在水上', () => {
    const world = generateWorld(20261021);
    const { x, y } = world.spawn;
    const tile = world.tiles[y * world.width + x];
    expect(tile.terrain).not.toBe('water');
    expect(TERRAIN_INFO[tile.terrain].buildable).toBe(true);
  });

  it('預設市中心道路與行人路存在', () => {
    const world = generateWorld(20261021);
    expect(world.tiles.filter((t) => t.road).length).toBeGreaterThan(5);
  });

  it('同一 seed 可重現', () => {
    const a = generateWorld(12345);
    const b = generateWorld(12345);
    expect(a.spawn).toEqual(b.spawn);
    expect(a.tiles.map((t) => t.terrain)).toEqual(b.tiles.map((t) => t.terrain));
  });
});

// ─────────────────────────── 開局與日期 ───────────────────────────

describe('開新局', () => {
  it('建立完整 GameState（香港版）', () => {
    const state = createGameState(42);
    expect(state.cityName).toBe('維港之城');
    expect(state.version).toBeGreaterThanOrEqual(2);
    expect(state.tiles.length).toBe(state.width * state.height);
    expect(state.spawn).toBeTruthy();
    expect(state.finance.treasury).toBe(START_TREASURY);
    expect(state.finance.salaryTaxRate).toBeGreaterThan(0);
    expect(state.finance.profitTaxRate).toBeGreaterThan(0);
    expect(state.finance.ratesRate).toBeGreaterThan(0);
    expect(state.finance.incomeBreakdown).toBeTruthy();
    expect(state.finance.expenseBreakdown).toBeTruthy();
    expect(state.transit.byMode.mtr).toBe(0);
    expect(Array.isArray(state.vehicles)).toBe(true);
    expect(state.stats.powerCoverage).toBe(0);
    expect(state.clock.weekday).toBeGreaterThanOrEqual(0);
    expect(state.clock.weekday).toBeLessThanOrEqual(6);
    expect(state.ui.showTransit).toBe(false);
    expect(state.ui.showStats).toBe(false);
    expect(state.log.length).toBeGreaterThan(0);
  });

  it('日期顯示為香港年份與星期', () => {
    const state = createGameState(7);
    const clock = state.clock;
    clock.year = 1;
    clock.month = 3;
    clock.day = 1;
    clock.weekday = 1;
    expect(formatShortDate(clock)).toBe(`${START_YEAR}年3月1日`);
    expect(formatGameDate(clock)).toContain('星期一');
    expect(weekdayName(clock)).toBe('星期一');
  });

  it('時鐘初始為早上八時、第一年、開局晴朗', () => {
    const clock = createClock(5);
    expect(clock.hour).toBe(8);
    expect(clock.weather).toBe('clear');
    expect(clock.minute).toBe(0);
    expect(clock.totalDays).toBe(1);
    expect(clock.year).toBe(1);
  });
});

// ─────────────────────────── 存檔 ───────────────────────────

describe('存檔系統', () => {
  it('存檔 → 讀檔完整還原', async () => {
    const { saveToSlot, loadFromSlot, deleteSlot } = await import('../src/core/save');
    const state = createGameState(99);
    state.finance.treasury = 4_321_000;
    state.ui.showTutorial = false;
    expect(saveToSlot(state, 1)).toBe(true);
    const loaded = loadFromSlot(1);
    expect(loaded).toBeTruthy();
    expect(loaded!.finance.treasury).toBe(4_321_000);
    expect(loaded!.width).toBe(state.width);
    expect(loaded!.spawn).toEqual(state.spawn);
    expect(listSaves()[1].empty).toBe(false);
    deleteSlot(1);
    expect(listSaves()[1].empty).toBe(true);
  });

  it('normalizeState 補齊新版欄位並拒絕壞檔', () => {
    const state = createGameState(11) as unknown as Record<string, unknown>;
    delete state.vehicles;
    delete state.transit;
    delete state.spawn;
    const fixed = normalizeState(state);
    expect(fixed).toBeTruthy();
    expect(fixed!.vehicles).toEqual([]);
    expect(fixed!.transit.byMode).toBeTruthy();
    expect(fixed!.spawn).toBeTruthy();
    expect(normalizeState(null)).toBeNull();
    expect(normalizeState({ width: 10, height: 10 })).toBeNull();
    expect(normalizeState({ width: 10, height: 10, tiles: [], buildings: [] })).toBeNull();
  });

  it('精簡存檔可序列化且體積合理（480 地圖唔會爆 localStorage）', async () => {
    const { serializeCompact } = await import('../src/core/save');
    const state: GameState = createGameState(3);
    const json = serializeCompact(state, 1);
    expect(json.length).toBeGreaterThan(1000);
    expect(json.length).toBeLessThan(2_000_000);
    expect(JSON.parse(json).version).toBe(state.version);
  });
});
