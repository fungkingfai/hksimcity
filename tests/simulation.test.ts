/**
 * 《維港之城》模擬整合測試（第二版：分區玩法）
 *
 * 驗證：道路整合行人路、分區繪製規則、開發商自動建屋、需求、人口就業、
 * 公共設施、颱風停航、存檔 round-trip。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { BUILDINGS, ZONES } from '../src/core/config';
import { createGameState } from '../src/core/new-game';
import type { GameState, SimContext, ZoneType } from '../src/core/types';
import { createSimulation } from '../src/sim/simulation';
import {
  canPlaceBuilding,
  eraseZone,
  paintZone,
  placeAutoBuilding,
  placeBuilding,
  placeRoad,
  updateConnectedBuildings,
} from '../src/sim/placement';
import { updateStats } from '../src/sim/stats';
import { advanceClock } from '../src/sim/time';

const ctx: SimContext = {
  toast: () => {
    /* noop */
  },
  log: () => {
    /* noop */
  },
};

const BUILDABLE = new Set(['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill']);

function makeState(seed = 20261021): GameState {
  const state = createGameState(seed, 'empty');
  state.ui.showTutorial = false;
  state.ui.showStartScreen = false;
  state.clock.paused = false;
  state.clock.speed = 3;
  return state;
}

function idx(state: GameState, x: number, y: number): number {
  return y * state.width + x;
}

/** 找一片可建基地 */
function findBase(state: GameState, w = 18, h = 16): { x: number; y: number } {
  const W = state.width;
  const H = state.height;
  const sx = state.spawn.x;
  const sy = state.spawn.y;
  let best: { x: number; y: number } | null = null;
  let bestScore = -Infinity;
  for (let y = 3; y + h < H - 3; y++) {
    for (let x = 3; x + w < W - 3; x++) {
      let okCount = 0;
      let ok = true;
      for (let dy = 0; dy < h && ok; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const t = state.tiles[idx(state, x + dx, y + dy)];
          if (t.buildingId >= 0 || !BUILDABLE.has(t.terrain)) {
            ok = false;
            break;
          }
          okCount++;
        }
      }
      if (!ok || okCount < w * h - 8) continue;
      const score = okCount - Math.hypot(x + w / 2 - sx, y + h / 2 - sy) * 1.5;
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  if (!best) throw new Error('找不到可建基地');
  return best;
}

function buildRoadGrid(state: GameState): { bx: number; by: number } {
  const { x: bx, y: by } = findBase(state);
  for (const ry of [by + 3, by + 7, by + 11]) {
    for (let x = bx + 1; x <= bx + 16; x++) placeRoad(state, x, ry);
  }
  for (const rx of [bx + 5, bx + 10, bx + 15]) {
    for (let y = by + 1; y <= by + 14; y++) placeRoad(state, rx, y);
  }
  updateConnectedBuildings(state);
  return { bx, by };
}

/** 在道路之間劃分區 */
function paintZoneBlocks(state: GameState, bx: number, by: number): Record<ZoneType, number> {
  const counts: Record<ZoneType, number> = { residential: 0, commercial: 0, industrial: 0, farmland: 0 };
  for (let y = by + 1; y < by + 16; y++) {
    for (let x = bx + 1; x < bx + 17; x++) {
      const t = state.tiles[idx(state, x, y)];
      if (t.road || t.buildingId >= 0 || t.zone) continue;
      const dy = y - by;
      let zone: ZoneType;
      if (dy <= 6) zone = 'residential';
      else if (dy <= 9) zone = 'commercial';
      else zone = 'industrial';
      if (paintZone(state, x, y, zone).ok) counts[zone]++;
    }
  }
  // 農地：在附近找 fertile/grass 劃農業區
  let farms = 0;
  for (let r = 2; r <= 24 && farms < 20; r++) {
    for (let dy = -r; dy <= r && farms < 20; dy++) {
      for (let dx = -r; dx <= r && farms < 20; dx++) {
        const x = state.spawn.x + dx;
        const y = state.spawn.y + dy;
        if (x < 2 || y < 2 || x >= state.width - 2 || y >= state.height - 2) continue;
        const t = state.tiles[idx(state, x, y)];
        if (t.terrain !== 'fertile' && t.terrain !== 'grass') continue;
        if (t.road || t.buildingId >= 0 || t.zone) continue;
        if (paintZone(state, x, y, 'farmland').ok) {
          farms++;
          counts.farmland++;
        }
      }
    }
  }
  return counts;
}

function runDays(state: GameState, days: number): void {
  const simulation = createSimulation();
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < 20; k++) simulation.update(state, 0.5, ctx);
  }
}

beforeEach(() => {
  /* 每個測試使用新 state */
});

describe('分區玩法整合', () => {
  it('道路整合行人路；分區繪製規則正確', () => {
    const state = makeState();
    const { x: bx, y: by } = findBase(state);
    // 道路自帶行人路
    expect(placeRoad(state, bx + 1, by + 3).ok).toBe(true);
    const roadTile = state.tiles[idx(state, bx + 1, by + 3)];
    expect(roadTile.road).toBe(true);
    expect(roadTile.sidewalk).toBe(true);
    // 不可在道路劃區
    expect(paintZone(state, bx + 1, by + 3, 'residential').ok).toBe(false);
    // 住／商／工可劃在可建地
    const before = state.finance.treasury;
    expect(paintZone(state, bx + 2, by + 2, 'residential').ok).toBe(true);
    expect(state.tiles[idx(state, bx + 2, by + 2)].zone).toBe('residential');
    expect(state.finance.treasury).toBe(before - ZONES.residential.costPerTile);
    // 同一格再劃同區 → 拒絕
    expect(paintZone(state, bx + 2, by + 2, 'residential').ok).toBe(false);
    // 可改劃其他分區（重新規劃）
    expect(paintZone(state, bx + 2, by + 2, 'commercial').ok).toBe(true);
    expect(state.tiles[idx(state, bx + 2, by + 2)].zone).toBe('commercial');
    // 取消分區（退 50%）
    const tBefore = state.finance.treasury;
    const erased = eraseZone(state, bx + 2, by + 2);
    expect(erased.ok).toBe(true);
    expect(erased.refund).toBeGreaterThan(0);
    expect(state.finance.treasury).toBeGreaterThan(tBefore);
    expect(state.tiles[idx(state, bx + 2, by + 2)].zone).toBeFalsy();
  });

  it('開發商按分區自動建屋，帶動人口與就業', () => {
    const state = makeState();
    const { bx, by } = buildRoadGrid(state);
    const counts = paintZoneBlocks(state, bx, by);
    expect(counts.residential).toBeGreaterThan(10);
    expect(counts.commercial).toBeGreaterThan(5);
    expect(counts.industrial).toBeGreaterThan(5);

    runDays(state, 30);
    updateStats(state);

    const auto = state.buildings.filter((b) => b.auto);
    const byZone: Record<string, number> = { residential: 0, commercial: 0, industrial: 0, farmland: 0 };
    for (const b of auto) if (b.zone) byZone[b.zone]++;
    expect(auto.length).toBeGreaterThan(8);
    expect(byZone.residential).toBeGreaterThan(0);
    expect(byZone.industrial).toBeGreaterThan(0);
    expect(state.stats.population).toBeGreaterThan(10);
    expect(state.stats.jobs).toBeGreaterThan(0);
    // 需求在合法範圍
    for (const zone of ['residential', 'commercial', 'industrial', 'farmland'] as const) {
      expect(state.stats.zoneDemand[zone]).toBeGreaterThanOrEqual(-1);
      expect(state.stats.zoneDemand[zone]).toBeLessThanOrEqual(1);
    }
    // 分區統計有值
    expect(state.stats.zoneTiles.residential).toBeGreaterThan(0);
    expect(state.stats.zoneBuildings.residential).toBeGreaterThan(0);
  });

  it('自動開發建築不可手動放置；公共設施可手動放置', () => {
    const state = makeState();
    const { x: bx, y: by } = findBase(state);
    // 先鋪一條馬路（公共設施需臨路）
    for (let x = bx + 1; x <= bx + 16; x++) placeRoad(state, x, by + 3);
    expect(placeBuilding(state, 'tongLau', bx + 2, by + 2).ok).toBe(false);
    expect(placeBuilding(state, 'supermarket', bx + 2, by + 2).ok).toBe(false);
    // 公共設施：公園（解鎖 0）
    expect(placeBuilding(state, 'park', bx + 2, by + 1).ok).toBe(true);
    // 高人口解鎖後可放警署／發電廠
    state.stats.population = 300;
    expect(placeBuilding(state, 'policeStation', bx + 5, by + 1).ok).toBe(true);
    expect(placeBuilding(state, 'powerPlant', bx + 9, by + 4).ok).toBe(true);
    // placeAutoBuilding 只接受分區建築
    expect(placeAutoBuilding(state, 'tongLau', bx + 3, by + 4)).toBeNull();
    // 在分區上自動放置成功
    expect(paintZone(state, bx + 3, by + 4, 'residential').ok).toBe(true);
    placeRoad(state, bx + 3, by + 3);
    expect(placeAutoBuilding(state, 'tongLau', bx + 3, by + 4)).toBeTruthy();
    expect(canPlaceBuilding(state, 'tongLau', bx + 3, by + 4).ok).toBe(false);
  });

  it('分區需求隨供應變化（供需平衡）', () => {
    const state = makeState();
    const { bx, by } = buildRoadGrid(state);
    // 大量劃住宅區 → 供應增加後住宅需求應回落
    for (let y = by + 1; y < by + 15; y++) {
      for (let x = bx + 1; x < bx + 17; x++) {
        const t = state.tiles[idx(state, x, y)];
        if (!t.road && t.buildingId < 0) paintZone(state, x, y, 'residential');
      }
    }
    const initial = state.stats.zoneDemand.residential;
    runDays(state, 20);
    expect(state.stats.zoneDemand.residential).toBeLessThanOrEqual(initial + 0.1);
  });

  it('颱風令渡輪停航、晴天復航', () => {
    const state = makeState();
    state.clock.weather = 'storm';
    state.clock.weatherMinutesLeft = 100_000;
    advanceClock(state, 10, ctx);
    expect(state.transit.suspended).toBe(true);
    expect(state.clock.warning).toBeTruthy();
    state.clock.weather = 'clear';
    state.clock.weatherMinutesLeft = 100_000;
    advanceClock(state, 10, ctx);
    expect(state.transit.suspended).toBe(false);
  });

  it('存檔 round-trip 保留分區與自動建築', async () => {
    const { normalizeState } = await import('../src/core/save');
    const state = makeState();
    const { bx, by } = buildRoadGrid(state);
    paintZoneBlocks(state, bx, by);
    runDays(state, 12);
    const clone = normalizeState(JSON.parse(JSON.stringify(state)));
    expect(clone).toBeTruthy();
    expect(clone!.tiles.filter((t) => t.zone).length).toBe(state.tiles.filter((t) => t.zone).length);
    expect(clone!.gameMode).toBe(state.gameMode);
    expect(clone!.buildings.filter((b) => b.auto).length).toBe(state.buildings.filter((b) => b.auto).length);
    runDays(clone!, 5);
    expect(clone!.clock.totalDays).toBeGreaterThan(state.clock.totalDays);
  });

  it('所有 config 建築皆有室內 key，且只分為 auto 或 ploppable', () => {
    for (const def of Object.values(BUILDINGS)) {
      expect(def.interior).toBeTruthy();
      expect(Boolean(def.zone) || def.ploppable === true).toBe(true);
    }
  });
});
