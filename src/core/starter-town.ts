/**
 * 開局模式「已有城鎮（starter）」：在 spawn 附近預建一個可運作的小城鎮。
 *
 * Round 4：真實地理 480×480 地圖（CSDI／地政總署 DTM）——海岸線與山地令
 * 「隨機鋪街」好易出現斷開嘅街道網絡，造成市民無法通勤、農田請唔到工人。
 * 因此本版改為 **連通優先**：
 *  1. 先計算 spawn 所屬嘅可建地連通分量；
 *  2. 只在同一分量內用「節點格網 + BFS」鋪設互相連通嘅道路；
 *  3. 只喺道路可達範圍（距路 ≤2 格）劃分區，確保住宅／工商／農地都在同一路網；
 *  4. 公共設施全部貼近市中心/住宅放置，避免服務覆蓋 0%。
 *
 * 只直接操作 state.tiles／state.buildings（不依賴 sim 模組，避免循環 import）。
 */

import { BUILDINGS, STARTER_TOWN } from './config';
import { generateExistingBuildings } from '../world/existing-city';
import { place3dLandmarks } from '../world/hk-3d-landmarks';
import { layStarterPipes } from '../sim/utilities';
import { createCitizen, getCitizenCache } from '../sim/citizen-common';
import type { Building, GameState, ZoneType } from './types';

const BUILDABLE = new Set(['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill']);
const FARM = new Set(['grass', 'fertile']);
const ROAD_RADIUS = 14;
const ZONE_RADIUS = 12;
/** 格網節點間距（格）：2 格 block，符合 2×2 建築 footprint */
const GRID_STEP = 3;

function idx(state: GameState, x: number, y: number): number {
  return y * state.width + x;
}

function inBounds(state: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < state.width && y < state.height;
}

function tileAt(state: GameState, x: number, y: number) {
  return state.tiles[idx(state, x, y)];
}

function buildableAt(state: GameState, x: number, y: number): boolean {
  if (!inBounds(state, x, y)) return false;
  return BUILDABLE.has(tileAt(state, x, y).terrain);
}

function freeFootprint(state: GameState, x: number, y: number, w: number, h: number): boolean {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (!inBounds(state, x + dx, y + dy)) return false;
      const t = tileAt(state, x + dx, y + dy);
      if (t.buildingId >= 0 || t.road) return false;
    }
  }
  return true;
}

function touchesStreet(state: GameState, x: number, y: number, w: number, h: number): boolean {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      for (const [nx, ny] of [[xx + 1, yy], [xx - 1, yy], [xx, yy + 1], [xx, yy - 1]] as const) {
        if (!inBounds(state, nx, ny)) continue;
        const t = tileAt(state, nx, ny);
        if (t.road || t.sidewalk) return true;
      }
    }
  }
  return false;
}

/** spawn 所屬可建地連通分量（4 鄰接；上限 radius 以避免掃全圖） */
function connectedComponent(state: GameState, sx: number, sy: number, radius: number): Set<number> {
  const out = new Set<number>();
  if (!buildableAt(state, sx, sy)) return out;
  const queue: [number, number][] = [[sx, sy]];
  out.add(idx(state, sx, sy));
  while (queue.length) {
    const [x, y] = queue.pop()!;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (Math.abs(nx - sx) > radius || Math.abs(ny - sy) > radius) continue;
      if (!buildableAt(state, nx, ny)) continue;
      const i = idx(state, nx, ny);
      if (out.has(i)) continue;
      out.add(i);
      queue.push([nx, ny]);
    }
  }
  return out;
}

function makeRoad(state: GameState, x: number, y: number, component: Set<number>): boolean {
  if (!inBounds(state, x, y)) return false;
  const i = idx(state, x, y);
  const t = state.tiles[i];
  if (t.road) return true;
  if (!component.has(i)) return false;
  if (t.buildingId >= 0) return false;
  t.road = true;
  t.sidewalk = true;
  t.zone = null;
  return true;
}

function paintRoadLine(
  state: GameState,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  component: Set<number>,
): number {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x0 + ((x1 - x0) * s) / Math.max(1, steps));
    const y = Math.round(y0 + ((y1 - y0) * s) / Math.max(1, steps));
    if (!component.has(idx(state, x, y))) return -1; // 整段不可達 → 放棄
  }
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x0 + ((x1 - x0) * s) / Math.max(1, steps));
    const y = Math.round(y0 + ((y1 - y0) * s) / Math.max(1, steps));
    makeRoad(state, x, y, component);
  }
  return steps + 1;
}

/** BFS 由 (x,y) 到最近道路的最短路徑，並把路徑鋪成道路（用於連接孤立的 spawn／節點） */
function connectToNetwork(state: GameState, x: number, y: number, component: Set<number>): boolean {
  if (tileAt(state, x, y).road) return true;
  const start = idx(state, x, y);
  if (!component.has(start)) return false;
  const prev = new Map<number, number>();
  const queue: number[] = [start];
  prev.set(start, -1);
  let found = -1;
  while (queue.length) {
    const cur = queue.shift()!;
    const cx = cur % state.width;
    const cy = (cur - cx) / state.width;
    if (state.tiles[cur].road) {
      found = cur;
      break;
    }
    for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]] as const) {
      const ni = idx(state, nx, ny);
      if (!component.has(ni) || prev.has(ni)) continue;
      prev.set(ni, cur);
      queue.push(ni);
    }
  }
  if (found < 0) return false;
  let cur: number | undefined = found;
  const path: number[] = [];
  while (cur != null && cur >= 0) {
    path.push(cur);
    cur = prev.get(cur);
    if (cur === start) {
      path.push(start);
      break;
    }
  }
  for (const i of path) {
    const px = i % state.width;
    const py = (i - px) / state.width;
    makeRoad(state, px, py, component);
  }
  return true;
}

/**
 * 連通優先道路網：由 spawn 主幹開始，以「格網間距 GRID_STEP」嘅可建地前沿逐格生長，
 * 只鋪同現有道路 4 鄰接嘅格 → 保證單一連通分量；遇到非格網空隙會鋪接駁路。
 */
function buildConnectedRoads(state: GameState, sx: number, sy: number, component: Set<number>): number {
  const width = state.width;
  const roadSet = new Set<number>();
  const markRoad = (x: number, y: number): boolean => {
    if (!inBounds(state, x, y)) return false;
    const i = idx(state, x, y);
    if (!component.has(i)) return false;
    const t = state.tiles[i];
    if (t.buildingId >= 0) return false;
    if (!t.road) {
      t.road = true;
      t.sidewalk = true;
      t.zone = null;
    }
    roadSet.add(i);
    return true;
  };
  const frontier = new Set<number>();
  const addFrontier = (i: number): void => {
    if (!component.has(i) || roadSet.has(i)) return;
    const t = state.tiles[i];
    if (t.buildingId >= 0 || t.road) return;
    frontier.add(i);
  };
  const addRoadWithFrontier = (x: number, y: number): void => {
    if (!markRoad(x, y)) return;
    const i = idx(state, x, y);
    const cx = i % width;
    const cy = (i - cx) / width;
    addFrontier(idx(state, cx + 1, cy));
    addFrontier(idx(state, cx - 1, cy));
    addFrontier(idx(state, cx, cy + 1));
    addFrontier(idx(state, cx, cy - 1));
  };

  // 主幹：spawn 向東西南北伸延到可建地邊界（短距離）
  addRoadWithFrontier(sx, sy);
  for (const [ddx, ddy, max] of [[1, 0, 8], [-1, 0, 8], [0, 1, 5], [0, -1, 5]] as const) {
    for (let d = 1; d <= max; d++) {
      const x = sx + ddx * d;
      const y = sy + ddy * d;
      if (!component.has(idx(state, x, y))) break;
      addRoadWithFrontier(x, y);
    }
  }

  const anchorX = ((sx % GRID_STEP) + GRID_STEP) % GRID_STEP;
  const anchorY = ((sy % GRID_STEP) + GRID_STEP) % GRID_STEP;
  const isGrid = (x: number, y: number): boolean =>
    ((x - anchorX) % GRID_STEP === 0 || (y - anchorY) % GRID_STEP === 0);
  // 目標道路數：連通分量約 45%，最多 420 格
  const target = Math.min(420, Math.max(80, Math.floor(component.size * 0.45)));
  const distToSpawn = (i: number): number => {
    const x = i % width;
    const y = (i - x) / width;
    return Math.abs(x - sx) + Math.abs(y - sy);
  };
  let guard = 0;
  while (roadSet.size < target && frontier.size > 0 && guard++ < 20000) {
    const list = [...frontier];
    list.sort((a, b) => distToSpawn(a) - distToSpawn(b));
    let chosen = -1;
    for (const i of list) {
      const x = i % width;
      const y = (i - x) / width;
      if (isGrid(x, y)) {
        chosen = i;
        break;
      }
    }
    if (chosen < 0) chosen = list[0]; // 格網覆蓋唔到 → 用接駁路
    frontier.delete(chosen);
    const cx = chosen % width;
    const cy = (chosen - cx) / width;
    addRoadWithFrontier(cx, cy);
  }
  // 確保 spawn 與主幹連通
  connectToNetwork(state, sx, sy, component);
  return roadSet.size;
}

function setZone(state: GameState, x: number, y: number, zone: ZoneType, component: Set<number>): boolean {
  if (!inBounds(state, x, y)) return false;
  const i = idx(state, x, y);
  if (!component.has(i)) return false;
  const t = state.tiles[i];
  if (t.road || t.sidewalk || t.buildingId >= 0 || t.zone) return false;
  if (zone === 'farmland' && !FARM.has(t.terrain)) return false;
  t.zone = zone;
  return true;
}

/** 把某格依方位／距離分成區位 */
function zoneKindFor(dx: number, dy: number, terrain: string, dist: number): ZoneType | null {
  // 農業：可耕地外圍（優先）
  if ((terrain === 'fertile' || terrain === 'grass') && dist >= 7) return 'farmland';
  // 市中心商業核心
  if (dist <= 2) return 'commercial';
  // 東面商業帶（近市中心）
  if (dx >= 3 && dx <= 10 && dy >= -6 && dy <= 4) return 'commercial';
  // 南／西面工業帶
  if (dy >= 5 || dx <= -6) return 'industrial';
  // 其餘住宅（北面／內陸）
  return 'residential';
}

function fillZones(
  state: GameState,
  sx: number,
  sy: number,
  component: Set<number>,
): Record<ZoneType, number> {
  const counts: Record<ZoneType, number> = { residential: 0, commercial: 0, industrial: 0, farmland: 0 };
  const roadDist = new Map<number, number>();
  const queue: number[] = [];
  for (const i of component) {
    if (!state.tiles[i].road) continue;
    roadDist.set(i, 0);
    queue.push(i);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    const d = roadDist.get(cur) ?? 0;
    if (d >= 3) continue;
    const cx = cur % state.width;
    const cy = (cur - cx) / state.width;
    for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]] as const) {
      const ni = idx(state, nx, ny);
      if (!component.has(ni) || roadDist.has(ni)) continue;
      roadDist.set(ni, d + 1);
      queue.push(ni);
    }
  }
  for (const i of component) {
    const d = roadDist.get(i);
    if (d == null || d === 0 || d > 2) continue;
    const x = i % state.width;
    const y = (i - x) / state.width;
    const dx = x - sx;
    const dy = y - sy;
    if (Math.abs(dx) > ZONE_RADIUS || Math.abs(dy) > ZONE_RADIUS) continue;
    if (tileAt(state, x, y).zone) continue;
    const zone = zoneKindFor(dx, dy, tileAt(state, x, y).terrain, Math.abs(dx) + Math.abs(dy));
    if (!zone) continue;
    if (setZone(state, x, y, zone, component)) counts[zone]++;
  }
  for (const i of component) {
    if (counts.farmland >= 48) break;
    const x = i % state.width;
    const y = (i - x) / state.width;
    const dx = x - sx;
    const dy = y - sy;
    if (Math.abs(dx) > ZONE_RADIUS + 3 || Math.abs(dy) > ZONE_RADIUS + 3) continue;
    let okay = true;
    for (let yy = 0; yy < 2 && okay; yy++) {
      for (let xx = 0; xx < 2; xx++) {
        const xi = idx(state, x + xx, y + yy);
        if (!component.has(xi) || state.tiles[xi].zone || state.tiles[xi].road) {
          okay = false;
          break;
        }
        if (!FARM.has(state.tiles[xi].terrain)) {
          okay = false;
          break;
        }
      }
    }
    if (!okay) continue;
    let nearRoad = false;
    for (let yy = -1; yy <= 2 && !nearRoad; yy++) {
      for (let xx = -1; xx <= 2; xx++) {
        const xi = idx(state, x + xx, y + yy);
        if (xi >= 0 && xi < state.tiles.length && state.tiles[xi].road) nearRoad = true;
      }
    }
    if (!nearRoad) continue;
    let added = 0;
    for (let yy = 0; yy < 2; yy++) {
      for (let xx = 0; xx < 2; xx++) {
        if (setZone(state, x + xx, y + yy, 'farmland', component)) added++;
      }
    }
    if (added === 4) counts.farmland += 4;
  }
  return counts;
}

/** 直接放入建築（不經 placement；開局專用） */
function addBuilding(
  state: GameState,
  key: string,
  x: number,
  y: number,
  options: { zone?: ZoneType; auto?: boolean } = {},
): Building | null {
  const def = BUILDINGS[key];
  if (!def) return null;
  const [w, h] = def.size;
  if (!freeFootprint(state, x, y, w, h)) return null;
  if (def.needsWater) {
    let nearWater = false;
    for (let dy = -2; dy <= h + 1 && !nearWater; dy++) {
      for (let dx = -2; dx <= w + 1; dx++) {
        if (inBounds(state, x + dx, y + dy) && tileAt(state, x + dx, y + dy).terrain === 'water') {
          nearWater = true;
          break;
        }
      }
    }
    if (!nearWater) return null;
  }
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
    auto: options.auto ?? def.zone != null,
    zone: options.zone ?? def.zone,
  };
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const t = tileAt(state, x + dx, y + dy);
      t.buildingId = building.id;
      if (!t.zone && building.zone) t.zone = building.zone;
    }
  }
  state.buildings.push(building);
  return building;
}

/** 建築附近有冇水域（建築自身 needsWater 用；與 addBuilding 的判定一致） */
function waterNear(state: GameState, x: number, y: number, w: number, h: number): boolean {
  for (let dy = -2; dy <= h + 1; dy++) {
    for (let dx = -2; dx <= w + 1; dx++) {
      if (inBounds(state, x + dx, y + dy) && tileAt(state, x + dx, y + dy).terrain === 'water') return true;
    }
  }
  return false;
}

/** 在中心附近找可放 w×h 建築、緊貼街道的位置（可選只放某分區） */
function findSpot(
  state: GameState,
  cx: number,
  cy: number,
  w: number,
  h: number,
  radius: number,
  zone?: ZoneType,
  requireRoad = true,
  needWater = false,
): { x: number; y: number } | null {
  for (let r = 1; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!freeFootprint(state, x, y, w, h)) continue;
        if (requireRoad && !touchesStreet(state, x, y, w, h)) continue;
        if (needWater && !waterNear(state, x, y, w, h)) continue;
        if (zone) {
          let ok = true;
          for (let yy = 0; yy < h && ok; yy++) {
            for (let xx = 0; xx < w; xx++) {
              if (tileAt(state, x + xx, y + yy).zone !== zone) {
                ok = false;
                break;
              }
            }
          }
          if (!ok) continue;
        }
        return { x, y };
      }
    }
  }
  return null;
}

/**
 * 建立 starter 城鎮：連通道路網、四色分區、自動開發建築、公共設施。
 * @returns 統計資料（供 log／測試）
 */
export function buildStarterTown(state: GameState): {
  roads: number;
  zones: Record<ZoneType, number>;
  autoBuildings: number;
  services: number;
} {
  const sx = state.spawn.x;
  const sy = state.spawn.y;
  // spawn 自身若不可建（真地理可能貼海），找最近可建格作城鎮中心
  let cx = sx;
  let cy = sy;
  if (!buildableAt(state, sx, sy)) {
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let dy = -8; dy <= 8; dy++) {
      for (let dx = -8; dx <= 8; dx++) {
        if (!buildableAt(state, sx + dx, sy + dy)) continue;
        const d = Math.abs(dx) + Math.abs(dy);
        if (d < bestD) {
          bestD = d;
          best = { x: sx + dx, y: sy + dy };
        }
      }
    }
    if (best) {
      cx = best.x;
      cy = best.y;
    }
  }
  const component = connectedComponent(state, cx, cy, ROAD_RADIUS);
  const roadCount = buildConnectedRoads(state, cx, cy, component);
  const zoneCounts = fillZones(state, cx, cy, component);
  // 中環一帶真實地形可能完全冇草地／農地：仍要預留農地區（揀可建、貼路、2×2）
  if (zoneCounts.farmland < 12) {
    const candidates: { i: number; farm: boolean }[] = [];
    for (const i of component) {
      const x = i % state.width;
      const y = (i - x) / state.width;
      const dx = x - cx;
      const dy = y - cy;
      if (Math.max(Math.abs(dx), Math.abs(dy)) > ZONE_RADIUS + 4) continue;
      const t = state.tiles[i];
      if (t.road || t.buildingId >= 0 || t.zone) continue;
      const farmTerrain = t.terrain === 'grass' || t.terrain === 'fertile';
      candidates.push({ i, farm: farmTerrain });
    }
    candidates.sort((a, b) => {
      const ax = a.i % state.width;
      const ay = (a.i - ax) / state.width;
      const bx = b.i % state.width;
      const by = (b.i - bx) / state.width;
      const da = Math.abs(ax - cx) + Math.abs(ay - cy);
      const db = Math.abs(bx - cx) + Math.abs(by - cy);
      return da - db;
    });
    for (const cand of candidates) {
      if (zoneCounts.farmland >= 24) break;
      const x = cand.i % state.width;
      const y = (cand.i - x) / state.width;
      let ok = true;
      for (let yy = 0; yy < 2 && ok; yy++) {
        for (let xx = 0; xx < 2; xx++) {
          const j = idx(state, x + xx, y + yy);
          if (!component.has(j) || state.tiles[j].road || state.tiles[j].buildingId >= 0 || state.tiles[j].zone) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;
      let nearRoad = false;
      for (let yy = -1; yy <= 2 && !nearRoad; yy++) {
        for (let xx = -1; xx <= 2; xx++) {
          const j = idx(state, x + xx, y + yy);
          if (j >= 0 && j < state.tiles.length && state.tiles[j].road) nearRoad = true;
        }
      }
      if (!nearRoad) continue;
      for (let yy = 0; yy < 2; yy++) {
        for (let xx = 0; xx < 2; xx++) {
          const t = state.tiles[idx(state, x + xx, y + yy)];
          t.zone = 'farmland';
          zoneCounts.farmland++;
        }
      }
    }
  }

  // 公共設施：全部貼近市中心／住宅（連通路網）
  const services: [string, number, number][] = [
    ['powerPlant', 3, 3],
    ['waterworks', 2, 2],
    ['sewagePlant', 3, 2],
    ['sewageOutfall', 1, 1],
    ['policeStation', 2, 2],
    ['fireStation', 2, 2],
    ['school', 2, 2],
    ['school', 2, 2],
    ['park', 2, 2],
    ['busTerminus', 2, 2],
    ['mtrStation', 2, 2],
    ['hospital', 3, 2],
  ];
  let servicePlaced = 0;
  for (const [key, w, h] of services) {
    const needWater = BUILDINGS[key]?.needsWater === true;
    let spot = findSpot(state, cx, cy, w, h, 12, undefined, true, needWater);
    if (!spot) spot = findSpot(state, cx, cy, w, h, 22, undefined, true, needWater);
    if (!spot) continue;
    const built = addBuilding(state, key, spot.x, spot.y, { auto: false });
    if (!built) continue;
    servicePlaced++;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) tileAt(state, spot.x + dx, spot.y + dy).zone = null;
    }
  }

  // 地下管網（Round 5）：starter 預先在道路下鋪齊水／污水／電力，並確保公用設施接駁
  {
    const markPipe = (x: number, y: number): void => {
      if (!inBounds(state, x, y)) return;
      const t = tileAt(state, x, y);
      if (t.terrain === 'water' || t.terrain === 'mountain' || t.terrain === 'sand') return;
      t.waterPipe = true;
      t.sewerPipe = true;
      t.powerCable = true;
    };
    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const t = tileAt(state, x, y);
        if (!t.road) continue;
        markPipe(x, y);
        markPipe(x + 1, y);
        markPipe(x - 1, y);
        markPipe(x, y + 1);
        markPipe(x, y - 1);
      }
    }
    // 每座公用設施（發電／水務／污水）周邊及腳下都要有管，確保 BFS 起點
    for (const b of state.buildings) {
      const utility = BUILDINGS[b.key]?.utility;
      if (!utility?.source) continue;
      for (let dy = -1; dy <= b.h; dy++) {
        for (let dx = -1; dx <= b.w; dx++) {
          markPipe(b.x + dx, b.y + dy);
        }
      }
    }
  }

  // 自動開發建築（住宅／商業／工業／農業）
  const autoPlan: [string, number, number][] = [
    ['publicHousing', 2, 2],
    ['publicHousing', 2, 2],
    ['publicHousing', 2, 2],
    ['tongLau', 1, 1],
    ['tongLau', 1, 1],
    ['tongLau', 1, 1],
    ['tongLau', 1, 1],
    ['tongLau', 1, 1],
    ['subdividedFlat', 1, 1],
    ['subdividedFlat', 1, 1],
    ['subdividedFlat', 1, 1],
    ['convenienceStore', 1, 1],
    ['convenienceStore', 1, 1],
    ['convenienceStore', 1, 1],
    ['chaChaanTeng', 1, 1],
    ['chaChaanTeng', 1, 1],
    ['chaChaanTeng', 1, 1],
    ['wetMarket', 2, 2],
    ['wetMarket', 2, 2],
    ['supermarket', 2, 2],
    ['officeTower', 2, 2],
    ['warehouse', 2, 2],
    ['warehouse', 2, 2],
    ['importFirm', 2, 2],
    ['foodFactory', 2, 2],
    ['industrialBuilding', 2, 2],
    ['industrialBuilding', 2, 2],
    ['farm', 2, 2],
    ['farm', 2, 2],
    ['farm', 2, 2],
    ['farm', 2, 2],
    ['farm', 2, 2],
    ['farm', 2, 2],
    ['farm', 2, 2],
  ];
  let autoCount = 0;
  for (const [key, w, h] of autoPlan) {
    const def = BUILDINGS[key];
    const zone = def?.zone ?? null;
    if (!zone) continue;
    const spot = findSpot(state, cx, cy, w, h, 18, zone, true);
    if (spot && addBuilding(state, key, spot.x, spot.y)) autoCount++;
  }

  // Issue #7：生成香港已發展區的「現有樓群」真正建築（existing:true；唔會塞市民，由 sim 遷入）
  const existingStats = generateExistingBuildings(state, {
    maxBuildings: 900,
    maxRoads: 5200,
    minSpawnDistance: 20,
  });
  // Issue #20／Round 9：加入 CSDI 3D-BIT00 真實建築模型（existing landmark）
  const landmarkStats = place3dLandmarks(state);

  // Issue #7／Round 5：現有道路亦要接駁公用管網（覆蓋現有樓宇）
  const pipeCounts = layStarterPipes(state);

  // Issue #7：為現有住宅預先遷入部分市民，令開局已有真實人口（之後由 sim 自然增長）
  {
    const cache = getCitizenCache(state);
    const homes = state.buildings
      .filter((b) => b.existing && b.zone === 'residential' && (BUILDINGS[b.key]?.housing ?? 0) > 0)
      .sort((a, b) => (BUILDINGS[b.key]?.housing ?? 0) - (BUILDINGS[a.key]?.housing ?? 0));
    let target = 400;
    for (const home of homes) {
      if (target <= 0) break;
      const capacity = Math.max(0, (BUILDINGS[home.key]?.housing ?? 0) - home.residents.length);
      const fill = Math.min(capacity, target);
      for (let k = 0; k < fill; k++) {
        const citizen = createCitizen(state, cache, {
          homeId: home.id,
          age: 18 + Math.floor(Math.random() * 45),
          state: 'home',
        });
        home.residents.push(citizen.id);
        state.citizens.push(citizen);
      }
      target -= fill;
    }
    state.stats.population = state.citizens.length;
  }

  for (const b of state.buildings) {
    if (b.key === 'warehouse') {
      b.inventory.food = Math.max(b.inventory.food ?? 0, 900);
      b.inventory.goods = Math.max(b.inventory.goods ?? 0, 180);
    }
    if (b.key === 'wetMarket' || b.key === 'supermarket' || b.key === 'convenienceStore') {
      b.inventory.food = Math.max(b.inventory.food ?? 0, 80);
      b.inventory.goods = Math.max(b.inventory.goods ?? 0, 50);
    }
  }

  state.finance.treasury = STARTER_TOWN.treasury;
  state.gameMode = 'starter';
  const zoneTotal =
    zoneCounts.residential + zoneCounts.commercial + zoneCounts.industrial + zoneCounts.farmland;
  void existingStats;
  void landmarkStats;
  void pipeCounts;
  state.log.push({
    id: state.nextLogId++,
    year: state.clock.year,
    month: state.clock.month,
    day: state.clock.day,
    text: `【已有城鎮】港島北岸已有 ${state.buildings.length} 棟建築、${zoneTotal} 格分區、${roadCount} 格連通道路。你可以直接繼續發展，或重新規劃。`,
    kind: 'good',
  });
  return {
    roads: roadCount,
    zones: zoneCounts,
    autoBuildings: autoCount,
    services: servicePlaced,
  };
}
