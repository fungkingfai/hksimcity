/**
 * Round 8（GitHub issues #14/#11）：深圳市範圍不可建設＋道路高架／隧道 placement＋roadPathBetween。
 */
import { describe, expect, it } from 'vitest';
import { BUILDINGS, ROAD_GRADE_INFO } from '../src/core/config';
import { createGameState } from '../src/core/new-game';
import type { GameState } from '../src/core/types';
import {
  canAutoPlaceBuilding,
  canPlaceBuilding,
  demolishAt,
  eraseZone,
  paintZone,
  placeRoad,
  placeSidewalk,
  roadGradeOf,
  roadPathBetween,
} from '../src/sim/placement';
import { BORDER_CROSSINGS, designToTileFloat, isShenzhenSideTile } from '../src/world/border';

function makeState(): GameState {
  const state = createGameState(20261022, 'empty');
  state.finance.treasury = 1_000_000_000;
  state.stats.population = 100_000;
  return state;
}

function findTile(state: GameState, predicate: (tileType: string, x: number, y: number) => boolean): { x: number; y: number } {
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      const tile = state.tiles[y * state.width + x];
      if (!tile) continue;
      if (predicate(tile.terrain, x, y)) return { x, y };
    }
  }
  throw new Error('找不到符合條件的格');
}

const SHENZHEN_REASON = '深圳市範圍只作參考，不可建設';

describe('Issue #14：深圳市範圍不可建設', () => {
  it('深圳側：道路（任何 grade）／行人路／分區／拆除／建築全部拒絕', () => {
    const state = makeState();
    const sz = findTile(state, (_terrain, x, y) => isShenzhenSideTile(x, y, state.width, state.height));
    expect(sz).toBeTruthy();
    for (const grade of ['surface', 'elevated', 'tunnel'] as const) {
      const result = placeRoad(state, sz.x, sz.y, grade);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe(SHENZHEN_REASON);
    }
    expect(placeSidewalk(state, sz.x, sz.y).ok).toBe(false);
    const zone = paintZone(state, sz.x, sz.y, 'residential');
    expect(zone.ok).toBe(false);
    expect(zone.reason).toBe(SHENZHEN_REASON);
    expect(eraseZone(state, sz.x, sz.y).reason).toBe(SHENZHEN_REASON);
    expect(demolishAt(state, sz.x, sz.y).reason).toBe(SHENZHEN_REASON);
    expect(canPlaceBuilding(state, 'park', sz.x, sz.y).reason).toBe(SHENZHEN_REASON);
    expect(canAutoPlaceBuilding(state, 'subdividedFlat', sz.x, sz.y)).toBe(false);
  });

  it('香港側（邊境通道附近）仍可鋪路、可建口岸建築', () => {
    const state = makeState();
    const crossing = BORDER_CROSSINGS[0];
    expect(crossing).toBeTruthy();
    const anchor = designToTileFloat(crossing.x, crossing.y, state.width, state.height);
    // 喺口岸附近搵一塊 3×2 全部可建、非深圳側、非水／山嘅地
    let spot: { x: number; y: number } | null = null;
    outer: for (let radius = 2; radius <= 40 && !spot; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const x = Math.round(anchor.x) + dx;
          const y = Math.round(anchor.y) + dy;
          if (x < 0 || y < 0 || x + 3 > state.width || y + 2 > state.height) continue;
          let ok = true;
          for (let yy = 0; yy < 2 && ok; yy++) {
            for (let xx = 0; xx < 3; xx++) {
              if (isShenzhenSideTile(x + xx, y + yy, state.width, state.height)) {
                ok = false;
                break;
              }
              const tile = state.tiles[(y + yy) * state.width + x + xx];
              if (!tile || !['grass', 'urban', 'reclaimed', 'fertile'].includes(tile.terrain) || tile.road || tile.buildingId >= 0) {
                ok = false;
                break;
              }
            }
          }
          if (!ok) continue;
          spot = { x, y };
          break outer;
        }
      }
    }
    if (!spot) {
      // 真實地圖口岸附近冇足夠平地：至少驗證道路可鋪喺非深圳側
      const near = findTile(state, (terrain, x, y) =>
        Math.abs(x - Math.round(anchor.x)) < 30 &&
        Math.abs(y - Math.round(anchor.y)) < 30 &&
        !isShenzhenSideTile(x, y, state.width, state.height) &&
        ['grass', 'urban', 'reclaimed'].includes(terrain),
      );
      expect(placeRoad(state, near.x, near.y, 'surface').ok).toBe(true);
      return;
    }
    // 口岸建築要臨路：先鋪一條路貼住 footprint
    layRoadNear(state, spot, 3, 2);
    const result = canPlaceBuilding(state, crossing.buildingKey, spot.x, spot.y);
    expect(result.ok).toBe(true);
  });
});

function layRoadNear(state: GameState, spot: { x: number; y: number }, w: number, h: number): void {
  // 只喺 footprint 外圍鋪路（唔可以鋪喺建築格上）
  const rows = [spot.y - 1, spot.y + h];
  for (const y of rows) {
    for (let x = spot.x - 1; x < spot.x + w + 1; x++) {
      if (x < 0 || x >= state.width || y < 0 || y >= state.height) continue;
      const tile = state.tiles[y * state.width + x];
      if (!tile || tile.buildingId >= 0) continue;
      tile.road = true;
      tile.sidewalk = true;
    }
  }
  const cols = [spot.x - 1, spot.x + w];
  for (const x of cols) {
    for (let y = spot.y - 1; y < spot.y + h + 1; y++) {
      if (x < 0 || x >= state.width || y < 0 || y >= state.height) continue;
      const tile = state.tiles[y * state.width + x];
      if (!tile || tile.buildingId >= 0) continue;
      tile.road = true;
      tile.sidewalk = true;
    }
  }
}

describe('Issue #11：道路高架／隧道 placement', () => {
  it('surface 不可喺水面／山地；elevated 可跨水；tunnel 可穿山；成本正確', () => {
    const state = makeState();
    const water = findTile(state, (terrain, x, y) =>
      terrain === 'water' && !isShenzhenSideTile(x, y, state.width, state.height),
    );
    // 山地（mountain）不可建；丘陵（hill）本身可建地面道路，所以用 mountain 測 surface 失敗
    const hill = findTile(state, (terrain, x, y) =>
      terrain === 'mountain' && !isShenzhenSideTile(x, y, state.width, state.height),
    );
    expect(water).toBeTruthy();
    expect(hill).toBeTruthy();

    expect(placeRoad(state, water.x, water.y, 'surface').ok).toBe(false);
    const elevated = placeRoad(state, water.x, water.y, 'elevated');
    expect(elevated.ok).toBe(true);
    expect(elevated.cost).toBe(ROAD_GRADE_INFO.elevated.cost);
    const waterTile = state.tiles[water.y * state.width + water.x];
    expect(waterTile.road).toBe(true);
    expect(waterTile.sidewalk).toBe(true);
    expect(roadGradeOf(waterTile)).toBe('elevated');

    const surfaceOnHill = placeRoad(state, hill.x, hill.y, 'surface');
    expect(surfaceOnHill.ok).toBe(false);
    const tunnel = placeRoad(state, hill.x, hill.y, 'tunnel');
    expect(tunnel.ok).toBe(true);
    expect(tunnel.cost).toBe(ROAD_GRADE_INFO.tunnel.cost);
    expect(roadGradeOf(state.tiles[hill.y * state.width + hill.x])).toBe('tunnel');
  });

  it('已地面道路可升級為高架（扣差價），升級後可再拆（退 30% 等級造價）', () => {
    const state = makeState();
    const flat = findTile(state, (terrain, x, y) =>
      ['grass', 'urban', 'reclaimed'].includes(terrain) &&
      !isShenzhenSideTile(x, y, state.width, state.height) &&
      state.tiles[y * state.width + x].buildingId < 0,
    );
    const before = state.finance.treasury;
    const built = placeRoad(state, flat.x, flat.y, 'surface');
    expect(built.ok).toBe(true);
    expect(built.cost).toBe(ROAD_GRADE_INFO.surface.cost);
    expect(before - state.finance.treasury).toBe(ROAD_GRADE_INFO.surface.cost);

    const upgrade = placeRoad(state, flat.x, flat.y, 'elevated');
    expect(upgrade.ok).toBe(true);
    expect(upgrade.cost).toBe(ROAD_GRADE_INFO.elevated.cost - ROAD_GRADE_INFO.surface.cost);
    expect(roadGradeOf(state.tiles[flat.y * state.width + flat.x])).toBe('elevated');

    const demolished = demolishAt(state, flat.x, flat.y);
    expect(demolished.ok).toBe(true);
    expect(demolished.refund).toBe(Math.floor(ROAD_GRADE_INFO.elevated.cost * 0.3));
    expect(state.tiles[flat.y * state.width + flat.x].road).toBe(false);
  });
});

describe('Issue #11：roadPathBetween L 形走線', () => {
  it('回傳連續 L 形格、包含 endpoints、唔重複', () => {
    const state = makeState();
    const flat = findTile(state, (terrain, x, y) =>
      ['grass', 'urban', 'reclaimed'].includes(terrain) &&
      !isShenzhenSideTile(x, y, state.width, state.height),
    );
    const x0 = flat.x;
    const y0 = flat.y;
    const x1 = Math.min(state.width - 1, x0 + 12);
    const y1 = Math.min(state.height - 1, y0 + 7);
    const path = roadPathBetween(state, x0, y0, x1, y1);
    expect(path.length).toBe(Math.abs(x1 - x0) + Math.abs(y1 - y0) + 1);
    expect(path[0]).toEqual({ x: x0, y: y0 });
    expect(path[path.length - 1]).toEqual({ x: x1, y: y1 });
    const seen = new Set<string>();
    for (const point of path) {
      const key = `${point.x},${point.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    for (let i = 1; i < path.length; i++) {
      const manhattan = Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y);
      expect(manhattan).toBe(1);
    }
    // 起終點同一格 → 只有一格
    expect(roadPathBetween(state, x0, y0, x0, y0)).toEqual([{ x: x0, y: y0 }]);
  });
});


describe('Round 8 存檔：道路等級 round-trip', () => {
  it('elevated／tunnel 道路 grade 可經 compact 存檔保存', async () => {
    const { serializeCompact, hydrateCompact } = await import('../src/core/save');
    const state = makeState();
    const flat = findTile(state, (terrain, x, y) =>
      ['grass', 'urban', 'reclaimed'].includes(terrain) &&
      !isShenzhenSideTile(x, y, state.width, state.height),
    );
    const elevated = placeRoad(state, flat.x, flat.y, 'elevated');
    expect(elevated.ok).toBe(true);
    const tunnelTile = findTile(state, (terrain, x, y) =>
      ['hill', 'mountain'].includes(terrain) &&
      !isShenzhenSideTile(x, y, state.width, state.height),
    );
    const tunnel = placeRoad(state, tunnelTile.x, tunnelTile.y, 'tunnel');
    expect(tunnel.ok).toBe(true);

    const raw = JSON.parse(serializeCompact(state, 4));
    const loaded = hydrateCompact(raw);
    expect(loaded).not.toBeNull();
    const loadedElevated = loaded!.tiles[flat.y * loaded!.width + flat.x];
    const loadedTunnel = loaded!.tiles[tunnelTile.y * loaded!.width + tunnelTile.x];
    expect(loadedElevated.road).toBe(true);
    expect(loadedElevated.roadGrade).toBe('elevated');
    expect(loadedTunnel.road).toBe(true);
    expect(loadedTunnel.roadGrade).toBe('tunnel');
  });
});
