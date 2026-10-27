/**
 * Round 9／issue #20：把 CSDI 3D-BIT00（LandsD）真實建築模型放進 starter 城市。
 *
 * `hk-3d-landmarks.generated.ts` 由 `tools/build-3d-landmarks.py` 抽取：
 *  - 真實 3DS 幾何（HK1980 座標）→ 相對中心、world units
 *  - 每座 landmark 一個 `Building.model3d` index，render 用 custom mesh
 *  - sim 沿用現有 building key（officeTower／privateEstate）的 jobs／housing
 *
 * 只喺 starter 模式呼叫（empty 完全由玩家建設）。
 */
import { BUILDINGS } from '../core/config';
import type { Building, GameState } from '../core/types';
import { LANDMARK_3D_MODELS } from './hk-3d-landmarks.generated';
import { isShenzhenSideTile } from './border';

const BUILDABLE = new Set(['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill']);

/**
 * 為 3D landmark 補一條短接入路：由 landmark 四鄰 BFS 到最近現有道路，
 * 只穿過可建地／空地，避免 landmark 成為無路可達的孤立樓。
 */
function linkLandmarkToRoad(
  state: GameState,
  bx: number,
  by: number,
): boolean {
  const { width, height, tiles } = state;
  const n = width * height;
  const parent = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  const push = (x: number, y: number, from: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (parent[i] !== -1) return;
    const t = tiles[i];
    if (t.buildingId >= 0 && from !== -2) return;
    if (t.terrain === 'water' || t.terrain === 'mountain') return;
    parent[i] = from;
    queue.push(i);
  };
  // seed = landmark 四鄰
  for (const [x, y] of [[bx + 1, by], [bx - 1, by], [bx, by + 1], [bx, by - 1]] as const) {
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const i = y * width + x;
    parent[i] = -2;
    queue.push(i);
  }
  let found = -1;
  for (let head = 0; head < queue.length && head < 5000; head++) {
    const cur = queue[head];
    const x = cur % width;
    const y = (cur - x) / width;
    if (tiles[cur].road && parent[cur] !== -2) { found = cur; break; }
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      push(nx, ny, cur);
    }
  }
  if (found < 0) return false;
  let cur = found;
  let guard = 0;
  while (cur >= 0 && parent[cur] >= 0 && guard < 24) {
    const t = tiles[cur];
    if (!t.road) {
      t.road = true;
      t.sidewalk = true;
      t.localRoad = true;
    }
    cur = parent[cur];
    guard++;
  }
  return true;
}

export function place3dLandmarks(state: GameState): { placed: number; models: number } {
  if (state.gameMode === 'empty' || !LANDMARK_3D_MODELS.length) return { placed: 0, models: 0 };
  const { width, height, tiles } = state;
  let placed = 0;
  for (let modelIndex = 0; modelIndex < LANDMARK_3D_MODELS.length; modelIndex++) {
    const model = LANDMARK_3D_MODELS[modelIndex];
    const baseX = Math.round(model.xTile);
    const baseY = Math.round(model.yTile);
    if (baseX < 2 || baseY < 2 || baseX >= width - 2 || baseY >= height - 2) continue;
    if (isShenzhenSideTile(baseX, baseY, width, height)) continue;
    // 喺 model 真實位置附近搵可用格（優先貼路，保持 existing 樓可運作）
    let spot: { x: number; y: number } | null = null;
    for (let r = 0; r <= 9 && !spot; r++) {
      for (let dy = -r; dy <= r && !spot; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = baseX + dx;
          const y = baseY + dy;
          if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
          const t = tiles[y * width + x];
          if (!BUILDABLE.has(t.terrain) || t.road || t.buildingId >= 0) continue;
          if (isShenzhenSideTile(x, y, width, height)) continue;
          spot = { x, y };
          break;
        }
      }
    }
    if (!spot) continue;
    const tall = model.heightM >= 150;
    const key = tall ? 'officeTower' : 'privateEstate';
    const def = BUILDINGS[key];
    if (!def) continue;
    const building: Building = {
      id: state.nextBuildingId++,
      key,
      x: spot.x,
      y: spot.y,
      w: 1,
      h: 1,
      active: true,
      connected: true,
      workers: [],
      residents: [],
      inventory: {},
      productionProgress: 0,
      level: tall ? 3 : 2,
      builtOnDay: 1,
      incomeThisMonth: 0,
      expenseThisMonth: 0,
      auto: false,
      existing: true,
      model3d: modelIndex,
      zone: tall ? 'commercial' : 'residential',
    };
    tiles[spot.y * width + spot.x].buildingId = building.id;
    tiles[spot.y * width + spot.x].zone = building.zone;
    state.buildings.push(building);
    linkLandmarkToRoad(state, spot.x, spot.y);
    placed++;
  }
  return { placed, models: LANDMARK_3D_MODELS.length };
}
