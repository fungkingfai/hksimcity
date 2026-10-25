/**
 * Round 6（GitHub issues）整合測試：現有樓群／邊境口岸／內地糧食／港鐵鐵路。
 */
import { describe, expect, it } from 'vitest';
import { GAME_VERSION } from '../src/core/config';
import { createGameState } from '../src/core/new-game';
import { Simulation } from '../src/sim/simulation';
import { canPlaceRail, placeRail, removeRail } from '../src/sim/rail';
import { RAIL_INFO } from '../src/core/config';

const ctx = { toast: () => {}, log: () => {} };

describe('Round 6 issues 整合', () => {
  it('版本為 8；starter 有真正 existing 樓群、口岸、內地糧食支援', () => {
    expect(GAME_VERSION).toBe(8);
    const state = createGameState(20261021, 'starter');
    const existing = state.buildings.filter((b) => b.existing);
    expect(existing.length).toBeGreaterThan(150);
    expect(existing.filter((b) => b.zone != null).length).toBeGreaterThan(150);
    expect(state.buildings.filter((b) => b.key === 'roadBorderGate' || b.key === 'railBorderGate').length).toBeGreaterThanOrEqual(2);
    const sim = new Simulation();
    state.clock.paused = false;
    state.clock.speed = 3;
    sim.update(state, 10, ctx); // 一遊戲日
    expect(state.stats.mainlandFoodPerDay ?? 0).toBeGreaterThan(0);
    expect((state.mainland?.crossings ?? []).some((c) => c.connected)).toBe(true);
    // existing 真樓必須有 tile.buildingId 對應（render 會跳過 faux）
    const builtTiles = state.tiles.filter((t) => t.buildingId >= 0).length;
    expect(builtTiles).toBeGreaterThan(existing.length);
  });

  it('empty 模式完全冇 existing／口岸／鐵路／內地支援', () => {
    const state = createGameState(20261022, 'empty');
    expect(state.buildings.filter((b) => b.existing).length).toBe(0);
    expect(state.buildings.filter((b) => b.key === 'roadBorderGate' || b.key === 'railBorderGate').length).toBe(0);
    expect(state.tiles.filter((t) => t.rail).length).toBe(0);
    expect(state.stats.mainlandFoodPerDay ?? 0).toBe(0);
  });

  it('鐵路工具：地面軌扣款、拆除退款；高架／地下可跨水', () => {
    const state = createGameState(20261023, 'empty');
    state.finance.treasury = 10_000_000;
    let land = -1;
    let water = -1;
    for (let i = 0; i < state.tiles.length; i++) {
      const t = state.tiles[i];
      if (land < 0 && (t.terrain === 'grass' || t.terrain === 'urban' || t.terrain === 'reclaimed')) land = i;
      if (water < 0 && t.terrain === 'water') water = i;
      if (land >= 0 && water >= 0) break;
    }
    expect(land).toBeGreaterThanOrEqual(0);
    const lx = land % state.width;
    const ly = Math.floor(land / state.width);
    const before = state.finance.treasury;
    const r = placeRail(state, lx, ly, 'surface');
    expect(r.ok).toBe(true);
    expect(state.tiles[land].rail).toBe('surface');
    expect(state.finance.treasury).toBe(before - RAIL_INFO.surface.cost);
    const refund = removeRail(state, lx, ly);
    expect(refund.ok).toBe(true);
    expect(state.tiles[land].rail).toBeUndefined();

    if (water >= 0) {
      const wx = water % state.width;
      const wy = Math.floor(water / state.width);
      expect(canPlaceRail(state, wx, wy, 'surface').ok).toBe(false);
      expect(canPlaceRail(state, wx, wy, 'elevated').ok).toBe(true);
      expect(canPlaceRail(state, wx, wy, 'underground').ok).toBe(true);
      expect(placeRail(state, wx, wy, 'elevated').ok).toBe(true);
    }
  });
});
