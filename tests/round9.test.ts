/**
 * Round 9（GitHub issues #17–#20）整合測試：規劃街區、HKO 數據、CSDI 3D landmarks。
 */
import { describe, expect, it } from 'vitest';
import { GAME_VERSION } from '../src/core/config';
import { createGameState } from '../src/core/new-game';
import { LANDMARK_3D_MODELS } from '../src/world/hk-3d-landmarks.generated';
import {
  HKO_TC_YEAR_DAYS,
  HKO_TC_STAT_SOURCE,
  hkoMonthlyTyphoonDays,
  hkoTyphoonSignalProbabilities,
} from '../src/sim/hko-climate';
import { serializeCompact, hydrateCompact } from '../src/core/save';

describe('Round 9 issues', () => {
  it('版本 9；starter 有規劃街區（2,000–3,500 路）＋ CSDI 3D landmarks', () => {
    expect(GAME_VERSION).toBe(9);
    const state = createGameState(20261021, 'starter');
    const roads = state.tiles.filter((t) => t.road).length;
    expect(roads).toBeGreaterThanOrEqual(2000);
    expect(roads).toBeLessThanOrEqual(3500);
    const existing = state.buildings.filter((b) => b.existing);
    expect(existing.length).toBeGreaterThanOrEqual(300);
    const landmarks = state.buildings.filter((b) => b.model3d !== undefined);
    expect(landmarks.length).toBeGreaterThan(20);
    expect(LANDMARK_3D_MODELS.length).toBeGreaterThan(20);
    for (const b of landmarks) {
      expect(b.model3d).toBeGreaterThanOrEqual(0);
      expect(b.model3d!).toBeLessThan(LANDMARK_3D_MODELS.length);
      const tile = state.tiles[b.y * state.width + b.x];
      expect(tile.buildingId).toBe(b.id);
    }
    // 道路應有街區／窄街 mix（唔係全闊路）
    expect(state.tiles.filter((t) => t.road && t.localRoad).length).toBeGreaterThan(0);
  });

  it('HKO 1961–2020 月度颱風數據及信號機率', () => {
    expect(HKO_TC_STAT_SOURCE).toContain('hko.gov.hk');
    expect(HKO_TC_YEAR_DAYS.any).toBeCloseTo(17.52, 2);
    expect(HKO_TC_YEAR_DAYS.three).toBeCloseTo(9.38, 2);
    expect(HKO_TC_YEAR_DAYS.eight).toBeCloseTo(2.42, 2);
    expect(HKO_TC_YEAR_DAYS.nineOrTen).toBeCloseTo(0.43, 2);
    expect(hkoMonthlyTyphoonDays(1)).toBe(0);
    expect(hkoMonthlyTyphoonDays(9)).toBeGreaterThan(hkoMonthlyTyphoonDays(5));
    for (const month of [1, 3, 5, 7, 8, 9, 10, 12]) {
      const p = hkoTyphoonSignalProbabilities(month);
      const sum = p[1] + p[3] + p[8] + p[9] + p[10];
      expect(sum).toBeCloseTo(1, 3);
      expect(p[1]).toBeGreaterThanOrEqual(0);
      expect(p[10]).toBeGreaterThanOrEqual(0);
    }
  });

  it('存檔保留 CSDI landmark model3d', () => {
    const state = createGameState(20261021, 'starter');
    const landmark = state.buildings.find((b) => b.model3d !== undefined);
    expect(landmark).toBeTruthy();
    const raw = JSON.parse(serializeCompact(state, 3));
    const loaded = hydrateCompact(raw);
    expect(loaded).not.toBeNull();
    const loadedLandmark = loaded!.buildings.find((b) => b.id === landmark!.id);
    expect(loadedLandmark?.model3d).toBe(landmark!.model3d);
  });
});
