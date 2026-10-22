/**
 * 開局模式「已有城鎮（starter）」：在中環 spawn 附近預建一個可運作的小城鎮。
 *
 * 只直接操作 state.tiles／state.buildings（不依賴 sim 模組，避免循環 import）；
 * 建築物會標記 auto/zone（由分區自動開發而來）。真正的市民遷入／就業／生產
 * 由 main.ts 的 warm-up（跑數日模擬）完成。
 */

import { BUILDINGS, STARTER_TOWN, ZONES } from './config';
import type { Building, GameState, ZoneType } from './types';

const BUILDABLE = new Set(['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill']);

function idx(state: GameState, x: number, y: number): number {
  return y * state.width + x;
}

function inBounds(state: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < state.width && y < state.height;
}

function buildableAt(state: GameState, x: number, y: number): boolean {
  if (!inBounds(state, x, y)) return false;
  return BUILDABLE.has(state.tiles[idx(state, x, y)].terrain);
}

function freeTile(state: GameState, x: number, y: number): boolean {
  if (!buildableAt(state, x, y)) return false;
  const t = state.tiles[idx(state, x, y)];
  return t.buildingId < 0 && !t.road && !t.sidewalk;
}

function touchesStreet(state: GameState, x: number, y: number, w: number, h: number): boolean {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      for (const [nx, ny] of [
        [xx + 1, yy],
        [xx - 1, yy],
        [xx, yy + 1],
        [xx, yy - 1],
      ]) {
        if (!inBounds(state, nx, ny)) continue;
        const t = state.tiles[idx(state, nx, ny)];
        if (t.road || t.sidewalk) return true;
      }
    }
  }
  return false;
}

function footprintFree(state: GameState, x: number, y: number, w: number, h: number): boolean {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (!inBounds(state, x + dx, y + dy)) return false;
      const t = state.tiles[idx(state, x + dx, y + dy)];
      if (t.buildingId >= 0 || t.road) return false;
    }
  }
  return true;
}

function makeRoad(state: GameState, x: number, y: number): void {
  if (!buildableAt(state, x, y)) return;
  const t = state.tiles[idx(state, x, y)];
  if (t.buildingId >= 0) return;
  t.road = true;
  // 道路整合行人路：馬路自帶行人路
  t.sidewalk = true;
  t.zone = null;
}

function setZone(state: GameState, x: number, y: number, zone: ZoneType): void {
  if (!buildableAt(state, x, y)) return;
  const t = state.tiles[idx(state, x, y)];
  if (t.road || t.buildingId >= 0) return;
  if (zone === 'farmland') {
    if (t.terrain !== 'fertile' && t.terrain !== 'grass') return;
  }
  t.zone = zone;
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
  if (!footprintFree(state, x, y, w, h)) return null;
  if (def.needsWater) {
    // 只需簡單檢查附近有無水（開局城鎮用）
    let nearWater = false;
    for (let dy = -2; dy <= h + 1 && !nearWater; dy++) {
      for (let dx = -2; dx <= w + 1; dx++) {
        if (!inBounds(state, x + dx, y + dy)) continue;
        if (state.tiles[idx(state, x + dx, y + dy)].terrain === 'water') {
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
      const t = state.tiles[idx(state, x + dx, y + dy)];
      t.buildingId = building.id;
      if (!t.zone && building.zone) t.zone = building.zone;
    }
  }
  state.buildings.push(building);
  return building;
}

/** 在指定中心附近找一個可放 w×h 建築、緊貼街道的位置 */
function findSpot(
  state: GameState,
  cx: number,
  cy: number,
  w: number,
  h: number,
  radius: number,
  zone?: ZoneType,
): { x: number; y: number } | null {
  for (let r = 1; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!footprintFree(state, x, y, w, h)) continue;
        if (!touchesStreet(state, x, y, w, h)) continue;
        if (zone) {
          let ok = true;
          for (let yy = 0; yy < h && ok; yy++) {
            for (let xx = 0; xx < w; xx++) {
              if (state.tiles[idx(state, x + xx, y + yy)].zone !== zone) {
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
 * 建立 starter 城鎮：道路網、四色分區、19 種自動建築的一部分、公共設施與交通。
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
  const zoneCounts: Record<ZoneType, number> = {
    residential: 0,
    commercial: 0,
    industrial: 0,
    farmland: 0,
  };

  // ── 1. 道路網（沿用世界生成的起步道路，再補棋盤街道） ──
  const rowOffsets = [-10, -6, -2, 2, 6, 10];
  const colOffsets = [-12, -8, -4, 0, 4, 8, 12];
  for (const dy of rowOffsets) {
    for (let dx = -14; dx <= 14; dx++) makeRoad(state, sx + dx, sy + dy);
  }
  for (const dx of colOffsets) {
    for (let dy = -12; dy <= 14; dy++) makeRoad(state, sx + dx, sy + dy);
  }

  // ── 2. 分區（依方位與距離） ──
  for (let dy = -12; dy <= 12; dy++) {
    for (let dx = -16; dx <= 16; dx++) {
      const x = sx + dx;
      const y = sy + dy;
      if (!buildableAt(state, x, y)) continue;
      const t = state.tiles[idx(state, x, y)];
      if (t.road) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      let zone: ZoneType | null = null;
      // 均衡 R/C/I：北面住宅、中央商業、南面工業（預留足夠職位區，避免人口增長後失業）
      if (d <= 10) {
        if (dy <= -5) zone = 'residential';
        else if (dy <= -1) zone = 'commercial';
        else if (dy <= 7) zone = 'industrial';
        else zone = 'commercial';
      } else if (d <= 14) {
        if (dy < -3) zone = 'residential';
        else if (dy <= 2) zone = 'commercial';
        else if (dy <= 9) zone = 'industrial';
      }
      // 農地：周邊農地／平地
      if (!zone && d >= 5 && d <= 20 && (t.terrain === 'fertile' || t.terrain === 'grass')) {
        zone = 'farmland';
      }
      if (zone) {
        setZone(state, x, y, zone);
        if (state.tiles[idx(state, x, y)].zone === zone) zoneCounts[zone] += 1;
      }
    }
  }

  // 確保農業區有 2×2 連續地塊（方便開發商起碼頭 2×2 農田）
  for (let r = 4; r <= 22 && zoneCounts.farmland < 48; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = sx + dx;
        const y = sy + dy;
        // 只要 2×2 全部係農地／平地空位就成塊劃農業區
        let ok = true;
        for (let yy = 0; yy < 2 && ok; yy++) {
          for (let xx = 0; xx < 2; xx++) {
            if (!buildableAt(state, x + xx, y + yy)) {
              ok = false;
              break;
            }
            const t = state.tiles[idx(state, x + xx, y + yy)];
            if (t.terrain !== 'fertile' && t.terrain !== 'grass') {
              ok = false;
              break;
            }
            if (t.road || t.buildingId >= 0 || t.zone) {
              ok = false;
              break;
            }
          }
        }
        if (!ok) continue;
        for (let yy = 0; yy < 2; yy++) {
          for (let xx = 0; xx < 2; xx++) {
            setZone(state, x + xx, y + yy, 'farmland');
            if (state.tiles[idx(state, x + xx, y + yy)].zone === 'farmland') zoneCounts.farmland += 1;
          }
        }
      }
    }
  }

  // ── 3. 公共設施（玩家手動放置類） ──
  const services: [string, number, number][] = [
    ['powerPlant', 3, 3],
    ['waterworks', 2, 2],
    ['policeStation', 2, 2],
    ['fireStation', 2, 2],
    ['school', 2, 2],
    ['park', 2, 2],
    ['busTerminus', 2, 2],
    ['mtrStation', 2, 2],
    ['hospital', 3, 2],
  ];
  let servicePlaced = 0;
  for (const [key, w, h] of services) {
    const spot = findSpot(state, sx, sy, w, h, 16);
    if (!spot) continue;
    const built = addBuilding(state, key, spot.x, spot.y, { auto: false });
    if (!built) continue;
    servicePlaced++;
    // 公共設施底下的土地不再算作可開發分區
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const t = state.tiles[idx(state, spot.x + dx, spot.y + dy)];
        t.zone = null;
      }
    }
  }

  // ── 4. 自動開發建築（住宅／商業／工業／農業） ──
  const autoPlan: [string, number, number][] = [
    ['publicHousing', 2, 2],
    ['publicHousing', 2, 2],
    ['tongLau', 1, 1],
    ['tongLau', 1, 1],
    ['tongLau', 1, 1],
    ['tongLau', 1, 1],
    ['subdividedFlat', 1, 1],
    ['subdividedFlat', 1, 1],
    ['convenienceStore', 1, 1],
    ['convenienceStore', 1, 1],
    ['convenienceStore', 1, 1],
    ['chaChaanTeng', 1, 1],
    ['chaChaanTeng', 1, 1],
    ['chaChaanTeng', 1, 1],
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
    const spot = findSpot(state, sx, sy, w, h, 18, zone);
    if (spot && addBuilding(state, key, spot.x, spot.y)) autoCount++;
  }

  // 開局倉庫預放食品／日用品，避免新手未劃農業區就缺糧
  for (const b of state.buildings) {
    if (b.key === 'warehouse') {
      b.inventory.food = 520;
      b.inventory.goods = 180;
    }
    if (b.key === 'wetMarket' || b.key === 'supermarket' || b.key === 'convenienceStore') {
      b.inventory.food = Math.max(b.inventory.food ?? 0, 80);
      b.inventory.goods = Math.max(b.inventory.goods ?? 0, 50);
    }
  }

  state.finance.treasury = STARTER_TOWN.treasury;
  state.gameMode = 'starter';
  state.log.push({
    id: state.nextLogId++,
    year: state.clock.year,
    month: state.clock.month,
    day: state.clock.day,
    text: `【已有城鎮】中環一帶已有 ${state.buildings.length} 棟建築、${zoneCounts.residential + zoneCounts.commercial + zoneCounts.industrial + zoneCounts.farmland} 格分區。你可以直接繼續發展，或重新規劃。`,
    kind: 'good',
  });
  return {
    roads: state.tiles.filter((t) => t.road).length,
    zones: zoneCounts,
    autoBuildings: autoCount,
    services: servicePlaced,
  };
}
