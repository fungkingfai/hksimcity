/**
 * Issue #7：starter 模式「現有樓群」世界生成。
 *
 * 由 `hk-map-data.generated.ts` 嘅土地用途（landuse）、建築密度/高度（density /
 * buildingHeight）同道路 hint（landuse 41/42）生成香港已發展區嘅現有樓群：
 *  - 用 roadHint 鋪主要道路（避開深圳範圍、水域、山地；保持 close to reality）；
 *  - 只喺 landuse 住宅／商業／工業／農地類別 + density 高嘅格放 `Building`；
 *  - 每棟都貼近道路，footprint 1–2×1–2，level 1–3，`existing: true`；
 *  - **唔會** 即時塞 citizens／workers（由 sim 自然遷入）；空模式唔會呼叫。
 *
 * 由 `core/starter-town.ts`（Lead 整合）喺 buildStarterTown() 之後呼叫一次：
 *   const stats = generateExistingBuildings(state);
 * Render 注意：terrain faux skyline 需要跳過 `tile.buildingId >= 0`，否則真假樓重疊。
 */

import { BUILDINGS } from '../core/config';
import type { Building, GameState, Tile, ZoneType } from '../core/types';
import { HK_MAP_DATA } from './hk-map-data.generated';
import { BORDER_CROSSINGS, designToTileFloat, isShenzhenSideTile } from './border';

export interface ExistingCityOptions {
  /** 最多生成幾多棟（default 420；要求 ~250–500） */
  maxBuildings?: number;
  /** 最多鋪幾多格道路（default 3000） */
  maxRoads?: number;
  /** 距 spawn 幾多格內唔生成（避免覆蓋 starter-town 小鎮；default 20） */
  minSpawnDistance?: number;
  /** 現有公共設施數量（default 60；要求 40–80） */
  maxFacilities?: number;
  /** 是否自動接駁現有道路 component（default true） */
  connectRoads?: boolean;
  /** 是否自動放置邊境口岸＋接駁（default true） */
  buildBorderLinks?: boolean;
  /** 接駁道路最多新增幾多格（default 3500） */
  maxConnectorRoads?: number;
  /** 只連接 size >= N 嘅 component（default 2） */
  minComponentSize?: number;
}

export interface ExistingCityStats {
  buildings: number;
  roads: number;
  /** 已規劃 zone 嘅 tile 數（building footprint 總和） */
  zones: number;
  /** 預留住宅容量（BUILDINGS.housing 總和） */
  housing: number;
  /** 預留職位容量（BUILDINGS.workers 總和） */
  jobs: number;
  /** 現有公共設施（學校／警署／消防／醫院／公園）數量 */
  facilities: number;
  /** 邊境口岸建築數量（Issue #4） */
  gates: number;
  /** 為接駁道路 component／口岸而新增嘅道路格 */
  connectorRoads: number;
  /** 接駁前後嘅道路連通分量數 */
  componentsBefore: number;
  componentsAfter: number;
  /** 現有建築物（含公共設施／口岸）貼住主道路網絡嘅數量 */
  buildingsOnMainNetwork: number;
}

const BUILDABLE = new Set(['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill']);

/** 土地利用 class → 分區（Issue #7；只生成呢四類，其餘 skip） */
const ZONE_BY_LU: Record<number, ZoneType> = {
  1: 'residential', // private residential
  2: 'residential', // public residential
  3: 'residential', // rural settlement
  11: 'commercial', // commercial/business
  21: 'industrial', // industrial
  22: 'industrial', // industrial estates/science parks
  23: 'industrial', // warehouse/open storage
  61: 'farmland', // agricultural land
};

/** 每個分區可用嘅現有樓宇 key（會按 footprint / 可放位置篩選） */
const DEFS_BY_ZONE: Record<ZoneType, string[]> = {
  residential: ['subdividedFlat', 'tongLau', 'publicHousing', 'hOSFlat', 'privateEstate'],
  commercial: ['convenienceStore', 'chaChaanTeng', 'wetMarket', 'supermarket', 'officeTower'],
  industrial: ['warehouse', 'industrialBuilding', 'foodFactory'],
  farmland: ['farm'],
  // 現有城市不會生成農地以外嘅其他 zone
};

interface Layers {
  landuse: Uint8Array;
  roadHint: Uint8Array;
}

/** 現有公共設施（landuse 31 GIC / 32 open space 生成；Issue #7 追加） */
const FACILITY_DEFS_GIC = [
  { key: 'school', weight: 34 },
  { key: 'policeStation', weight: 22 },
  { key: 'fireStation', weight: 22 },
  { key: 'hospital', weight: 22 },
];
const FACILITY_DEFS_PARK = [{ key: 'park', weight: 1 }];

/** 道路連通 helper 用嘅可步行／可建地 */
const WALKABLE = BUILDABLE;

interface ConnectivityStats {
  componentsBefore: number;
  componentsAfter: number;
  connectorRoads: number;
}

interface BorderLinkStats {
  gates: number;
  roadTiles: number;
  railTiles: number;
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node fallback（測試／工具用）
  const g = globalThis as unknown as { Buffer?: { from(s: string, enc: string): Uint8Array } };
  if (g.Buffer) return new Uint8Array(g.Buffer.from(b64, 'base64'));
  return new Uint8Array(0);
}

let cachedLayers: Layers | null | undefined;

function loadLayers(): Layers | null {
  if (cachedLayers !== undefined) return cachedLayers;
  if (!HK_MAP_DATA.landuse || !HK_MAP_DATA.roadHint) {
    cachedLayers = null;
    return null;
  }
  const landuse = base64ToBytes(HK_MAP_DATA.landuse);
  const roadHint = base64ToBytes(HK_MAP_DATA.roadHint);
  const expected = HK_MAP_DATA.width * HK_MAP_DATA.heightTiles;
  if (landuse.length !== expected) {
    cachedLayers = null;
    return null;
  }
  cachedLayers = { landuse, roadHint };
  return cachedLayers;
}

function hash01(x: number, y: number, seed: number, salt = 0): number {
  let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(seed + salt, 83492791)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function roadHintAt(layers: Layers, i: number): boolean {
  const b = layers.roadHint[i >> 3];
  return b !== undefined && ((b >> (i & 7)) & 1) === 1;
}

function touchesRoad(
  state: GameState,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  const { width, height, tiles } = state;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      for (const [nx, ny] of [
        [xx + 1, yy],
        [xx - 1, yy],
        [xx, yy + 1],
        [xx, yy - 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (tiles[ny * width + nx].road) return true;
      }
    }
  }
  return false;
}

function freeFootprint(state: GameState, x: number, y: number, w: number, h: number): boolean {
  const { width, height, tiles } = state;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) return false;
      const t = tiles[yy * width + xx];
      if (t.road || t.buildingId >= 0) return false;
      if (!BUILDABLE.has(t.terrain)) return false;
    }
  }
  return true;
}

function isWalkableIndex(state: GameState, i: number): boolean {
  const t = state.tiles[i];
  return t.road || WALKABLE.has(t.terrain);
}

/** 道路連通分量（4 鄰接）；回傳 labels（-1 = 非道路）、sizes、每 component 嘅 tile 清單。 */
function computeRoadComponents(state: GameState): {
  labels: Int32Array;
  sizes: number[];
  byComp: number[][];
} {
  const n = state.width * state.height;
  const labels = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const byComp: number[][] = [];
  const queue: number[] = [];
  const width = state.width;
  const height = state.height;
  for (let i = 0; i < n; i++) {
    if (!state.tiles[i].road || labels[i] >= 0) continue;
    const comp = sizes.length;
    labels[i] = comp;
    queue.length = 0;
    queue.push(i);
    const tiles: number[] = [];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      tiles.push(cur);
      const x = cur % width;
      const y = (cur - x) / width;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (!state.tiles[ni].road || labels[ni] >= 0) continue;
        labels[ni] = comp;
        queue.push(ni);
      }
    }
    sizes.push(tiles.length);
    byComp.push(tiles);
  }
  return { labels, sizes, byComp };
}

/** 由一組 road tiles 做 multi-source BFS，穿過可步行地（道路／可建地）；回傳 parent 鏈。 */
function bfsFromTiles(
  state: GameState,
  sources: number[],
): { parent: Int32Array; dist: Int32Array } {
  const n = state.width * state.height;
  const parent = new Int32Array(n).fill(-1);
  const dist = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  for (const s of sources) {
    if (s < 0 || s >= n) continue;
    if (dist[s] >= 0) continue;
    dist[s] = 0;
    parent[s] = -2;
    queue.push(s);
  }
  const width = state.width;
  const height = state.height;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const d = dist[cur];
    const x = cur % width;
    const y = (cur - x) / width;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (dist[ni] >= 0) continue;
      if (!isWalkableIndex(state, ni)) continue;
      dist[ni] = d + 1;
      parent[ni] = cur;
      queue.push(ni);
    }
  }
  return { parent, dist };
}

/** 由 parent 鏈由 target 行返 source，回傳要新加嘅道路 tile。 */
function traceConnector(state: GameState, parent: Int32Array, dist: Int32Array, target: number, maxAdd: number): number[] {
  if (target < 0 || dist[target] < 0) return [];
  const added: number[] = [];
  let cur = target;
  let guard = 0;
  while (cur >= 0 && parent[cur] !== -2 && guard < 4096) {
    guard++;
    if (!state.tiles[cur].road) {
      added.push(cur);
      if (added.length >= maxAdd) break;
    }
    cur = parent[cur];
  }
  return added;
}

/**
 * 把抽樣 roadHint 道路「補窿」：如果同行／同列隔一格有路，就補中間格；
 * 亦會補對角缺口（4-neigh 連通）。raster 道路取樣本應連續，補窿後 component
 * 數目由幾百個大幅減少，令現有樓宇可以真正連通。
 */
function densifySelectedRoads(state: GameState): number {
  const { width, height, tiles } = state;
  let added = 0;
  const walkable = (i: number): boolean => {
    const t = tiles[i];
    return !t.road && !t.buildingId && WALKABLE.has(t.terrain);
  };
  const setRoad = (i: number, a?: number, b?: number): void => {
    if (tiles[i].road) return;
    tiles[i].road = true;
    // 補窿格預設係窄街；如果兩邊都係主幹（localRoad=false）就維持闊路
    const ta = a != null ? tiles[a] : null;
    const tb = b != null ? tiles[b] : null;
    const bothTrunk =
      !!ta && (ta as Tile & { localRoad?: boolean }).localRoad === false &&
      !!tb && (tb as Tile & { localRoad?: boolean }).localRoad === false;
    (tiles[i] as Tile & { localRoad?: boolean }).localRoad = !bothTrunk;
    added++;
  };
  for (let pass = 0; pass < 2; pass++) {
    // 橫向 / 縱向一格窿
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!tiles[i].road) continue;
        if (x + 2 < width && tiles[i + 2].road && walkable(i + 1)) setRoad(i + 1, i, i + 2);
        if (y + 2 < height && tiles[(y + 2) * width + x].road && walkable((y + 1) * width + x)) setRoad((y + 1) * width + x, i, (y + 2) * width + x);
      }
    }
    // 對角缺口：兩條正交路各自有路但斜角相鄰 → 補一格令 4-neigh 連通
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        const a = y * width + x;
        const b = (y + 1) * width + x + 1;
        if (!tiles[a].road || !tiles[b].road) continue;
        const right = y * width + x + 1;
        const down = (y + 1) * width + x;
        if (tiles[right].road || tiles[down].road) continue;
        if (walkable(right)) setRoad(right, a, b);
        else if (walkable(down)) setRoad(down, a, b);
      }
    }
  }
  return added;
}

/**
 * 接駁現有道路 component（Issue #7 追加）。
 * 以最大 component 為核心，逐個細 component 用 BFS／A*（Manhattan）穿過可建地連過去；
 * 只會喺 grass/urban/reclaimed/fertile/forest/hill 行，避開 water／mountain／wetland／sand。
 */
export function connectExistingRoadComponents(
  state: GameState,
  options: { maxConnectorRoads?: number; minComponentSize?: number } = {},
): ConnectivityStats {
  const maxAdd = Math.max(0, options.maxConnectorRoads ?? 3500);
  const minSize = Math.max(1, options.minComponentSize ?? 1);
  const before = computeRoadComponents(state);
  const componentsBefore = before.sizes.length;
  if (componentsBefore <= 1) {
    return { componentsBefore, componentsAfter: componentsBefore, connectorRoads: 0 };
  }
  let totalAdded = 0;
  let comps = before;
  for (let iter = 0; iter < 5; iter++) {
    if (comps.sizes.length <= 1 || totalAdded >= maxAdd) break;
    // 最大 component 做主網
    let mainIdx = 0;
    for (let k = 1; k < comps.sizes.length; k++) {
      if (comps.sizes[k] > comps.sizes[mainIdx]) mainIdx = k;
    }
    const mainTiles = comps.byComp[mainIdx];
    const { parent, dist } = bfsFromTiles(state, mainTiles);
    // 細 component 由大到細接駁
    const order = comps.sizes
      .map((size, idx) => ({ size, idx }))
      .filter((c) => c.idx !== mainIdx && c.size >= minSize)
      .sort((a, b) => b.size - a.size);
    const connected = new Set<number>();
    for (const c of order) {
      if (totalAdded >= maxAdd) break;
      let best = -1;
      for (const ti of comps.byComp[c.idx]) {
        if (dist[ti] < 0) continue;
        if (best < 0 || dist[ti] < dist[best]) best = ti;
      }
      if (best < 0) continue;
      const add = traceConnector(state, parent, dist, best, maxAdd - totalAdded);
      for (const ti of add) {
        if (!state.tiles[ti].road) {
          state.tiles[ti].road = true;
          (state.tiles[ti] as Tile & { localRoad?: boolean }).localRoad = true;
          totalAdded++;
        }
      }
      connected.add(c.idx);
    }
    if (totalAdded === 0) break;
    const next = computeRoadComponents(state);
    if (next.sizes.length >= comps.sizes.length) {
      comps = next;
      break;
    }
    comps = next;
  }
  return {
    componentsBefore,
    componentsAfter: comps.sizes.length,
    connectorRoads: totalAdded,
  };
}

/** 喺 anchor 附近搵一個可放 w×h footprint（全可建地、無道路／建築、唔喺深圳）。 */
function findFreeFootprintNear(
  state: GameState,
  anchorX: number,
  anchorY: number,
  w: number,
  h: number,
  maxRadius = 14,
): { x: number; y: number } | null {
  const { width, height } = state;
  for (let r = 0; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (r > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = anchorX + dx;
        const y = anchorY + dy;
        if (x < 0 || y < 0 || x + w > width || y + h > height) continue;
        if (!freeFootprint(state, x, y, w, h)) continue;
        if (isShenzhenSideTile(x, y, width, height)) continue;
        return { x, y };
      }
    }
  }
  return null;
}

/** 由某組起始格 BFS 到最近現有道路；回傳要新增嘅道路格（未 set road）。 */
function roadPathFrom(
  state: GameState,
  starts: number[],
  maxExpand = 4000,
): { path: number[]; found: boolean } {
  const { width, height } = state;
  const n = width * height;
  const parent = new Int32Array(n).fill(-1);
  const dist = new Int32Array(n).fill(-1);
  const queue: number[] = [];
  for (const s of starts) {
    if (s < 0 || s >= n || dist[s] >= 0) continue;
    dist[s] = 0;
    parent[s] = -2;
    queue.push(s);
  }
  let found = -1;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    // 搵到現有道路就即刻停（唔需要掃全張 600×600 圖）
    if (state.tiles[cur].road && dist[cur] > 0) {
      found = cur;
      break;
    }
    const x = cur % width;
    const y = (cur - x) / width;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (dist[ni] >= 0) continue;
      if (!isWalkableIndex(state, ni)) continue;
      dist[ni] = dist[cur] + 1;
      parent[ni] = cur;
      queue.push(ni);
    }
  }
  if (found < 0) return { path: [], found: false };
  return { path: traceConnector(state, parent, dist, found, maxExpand), found: true };
}

/**
 * 最後一步：將「未貼主道路網絡」嘅現有樓宇逐棟接駁（透過其相鄰道路 tile
 * trace 返主 component，補少量道路）。確保住宅／工商／公共設施可通勤及接駁管網。
 */
function connectBuildingsToMainNetwork(
  state: GameState,
  maxAdd = 2600,
): { roads: number; connectedBuildings: number } {
  const comps = computeRoadComponents(state);
  if (comps.sizes.length === 0) return { roads: 0, connectedBuildings: 0 };
  let mainIdx = 0;
  for (let k = 1; k < comps.sizes.length; k++) {
    if (comps.sizes[k] > comps.sizes[mainIdx]) mainIdx = k;
  }
  const mainTiles = comps.byComp[mainIdx];
  const { parent, dist } = bfsFromTiles(state, mainTiles);
  const { width, height } = state;
  let added = 0;
  let connectedBuildings = 0;
  for (const b of state.buildings) {
    if (!b.existing) continue;
    const adjRoads: number[] = [];
    for (let dy = 0; dy < b.h; dy++) {
      for (let dx = 0; dx < b.w; dx++) {
        const tx = b.x + dx;
        const ty = b.y + dy;
        for (const [nx, ny] of [[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]] as const) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (state.tiles[ni].road) adjRoads.push(ni);
        }
      }
    }
    if (adjRoads.length === 0) continue;
    if (adjRoads.some((ti) => comps.labels[ti] === mainIdx)) {
      connectedBuildings++;
      continue;
    }
    let best = -1;
    for (const ti of adjRoads) {
      if (dist[ti] < 0) continue;
      if (best < 0 || dist[ti] < dist[best]) best = ti;
    }
    if (best < 0) continue;
    const add = traceConnector(state, parent, dist, best, maxAdd - added);
    for (const ti of add) {
      if (!state.tiles[ti].road) {
        state.tiles[ti].road = true;
        (state.tiles[ti] as Tile & { localRoad?: boolean }).localRoad = true;
        added++;
      }
    }
    if (add.length > 0 || dist[best] >= 0) connectedBuildings++;
    if (added >= maxAdd) break;
  }
  return { roads: added, connectedBuildings };
}

/**
 * 最後防線：確保所有 existing 邊境口岸都連到主道路網絡（mainland sim 需要 component >20）。
 * 有啲口岸貼河／貼山，buildBorderLinks 可能搵唔到路；呢度補一條短支路再 trace 主網絡。
 */
export function ensureBorderGatesLinked(state: GameState): { linked: number; roads: number } {
  const { width, height } = state;
  const gates = state.buildings.filter(
    (b) => b.key === 'roadBorderGate' || b.key === 'railBorderGate',
  );
  if (!gates.length) return { linked: 0, roads: 0 };
  const comps = computeRoadComponents(state);
  if (!comps.sizes.length) return { linked: 0, roads: 0 };
  let mainIdx = 0;
  for (let k = 1; k < comps.sizes.length; k++) {
    if (comps.sizes[k] > comps.sizes[mainIdx]) mainIdx = k;
  }
  const mainTiles = comps.byComp[mainIdx];
  const { parent, dist } = bfsFromTiles(state, mainTiles);
  let roads = 0;
  let linked = 0;
  for (const gate of gates) {
    // 蒐集口岸四鄰（正交）嘅可建格
    const perimeter: number[] = [];
    const push = (x: number, y: number): void => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const i = y * width + x;
      if (comps.labels[i] === mainIdx) return; // 已連主網
      perimeter.push(i);
    };
    for (let dx = 0; dx < gate.w; dx++) {
      push(gate.x + dx, gate.y - 1);
      push(gate.x + dx, gate.y + gate.h);
    }
    for (let dy = 0; dy < gate.h; dy++) {
      push(gate.x - 1, gate.y + dy);
      push(gate.x + gate.w, gate.y + dy);
    }
    const buildable = perimeter.filter((i) => {
      const t = state.tiles[i];
      return t.road || (WALKABLE.has(t.terrain) && !isShenzhenSideTile(i % width, (i / width) | 0, width, height));
    });
    if (!buildable.length) continue;
    let adjRoads = buildable.filter((i) => state.tiles[i].road);
    if (!adjRoads.length) {
      // 揀一格可建四鄰鋪支路
      const stub = buildable[0];
      if (!state.tiles[stub].road) {
        state.tiles[stub].road = true;
        state.tiles[stub].sidewalk = true;
        roads++;
      }
      adjRoads = [stub];
    }
    // 由 main 網絡 BFS 到最近嘅口岸支路，trace 返補路
    let best = -1;
    for (const ti of adjRoads) {
      if (dist[ti] < 0) continue;
      if (best < 0 || dist[ti] < dist[best]) best = ti;
    }
    if (best >= 0) {
      const add = traceConnector(state, parent, dist, best, 3000);
      for (const ti of add) {
        if (!state.tiles[ti].road) {
          state.tiles[ti].road = true;
          state.tiles[ti].sidewalk = true;
          roads++;
        }
      }
    }
    // rail gate 加一小段 surface rail 作視覺（mainland 道路 fallback 仍會用）
    if (gate.key === 'railBorderGate') {
      for (const ti of adjRoads) {
        const t = state.tiles[ti];
        if (!t.rail && !t.road) {
          t.rail = 'surface';
          break;
        }
      }
    }
    linked++;
  }
  return { linked, roads };
}

/**
 * 放置 4 個邊境口岸（Issue #4）＋由口岸接駁到最近道路。
 * roadBorderGate／railBorderGate 3×2、existing/免費；rail gate 會喺旁邊鋪幾格
 * `rail='surface'` 作視覺（mainland 支援以道路 component 作 fallback，由 core 整合）。
 */
export function buildBorderLinks(state: GameState): BorderLinkStats {
  const res: BorderLinkStats = { gates: 0, roadTiles: 0, railTiles: 0 };
  const { width, height } = state;
  for (const crossing of BORDER_CROSSINGS) {
    const def = BUILDINGS[crossing.buildingKey];
    if (!def) continue;
    const w = Math.max(1, Math.min(3, def.size[0]));
    const h = Math.max(1, Math.min(2, def.size[1]));
    const dt = designToTileFloat(crossing.x, crossing.y, width, height);
    // 口岸放喺河嘅香港側（tile y 向南 +4 左右），再搵附近可建地
    const spot = findFreeFootprintNear(state, Math.round(dt.x), Math.round(dt.y + 4), w, h, 16);
    if (!spot) continue;
    // 先搵接駁路徑（搵唔到就 skip 呢個口岸）
    const startTiles: number[] = [];
    for (let dx = 0; dx < w; dx++) {
      startTiles.push((spot.y - 1) * width + spot.x + dx);
      startTiles.push((spot.y + h) * width + spot.x + dx);
    }
    for (let dy = 0; dy < h; dy++) {
      startTiles.push((spot.y + dy) * width + spot.x - 1);
      startTiles.push((spot.y + dy) * width + spot.x + w);
    }
    const validStarts = startTiles.filter((ti) => ti >= 0 && ti < width * height && isWalkableIndex(state, ti));
    if (validStarts.length === 0) continue;
    const link = roadPathFrom(state, validStarts, 5000);
    if (!link.found) continue;
    // 放建築
    const building: Building = {
      id: state.nextBuildingId++,
      key: crossing.buildingKey,
      x: spot.x,
      y: spot.y,
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
      auto: false,
      existing: true,
    };
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        state.tiles[(spot.y + dy) * width + spot.x + dx].buildingId = building.id;
      }
    }
    state.buildings.push(building);
    res.gates++;
    for (const ti of link.path) {
      if (!state.tiles[ti].road) {
        state.tiles[ti].road = true;
        res.roadTiles++;
      }
    }
    // rail gate：旁邊鋪幾格 surface rail 作視覺
    if (crossing.kind === 'rail') {
      for (let k = 0; k < 5; k++) {
        const yy = spot.y - 1 - k;
        const xx = spot.x + Math.floor(w / 2);
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) break;
        const ti = yy * width + xx;
        const t = state.tiles[ti];
        if (t.road || t.buildingId >= 0) continue;
        if (!WALKABLE.has(t.terrain)) break;
        if (!t.rail) {
          t.rail = 'surface';
          res.railTiles++;
        }
      }
    }
  }
  return res;
}

/**
 * 由 landuse 31（GIC）／32（open space）生成現有公共設施（Issue #7 追加）：
 * 學校／警署／消防局／醫院／公園，約 40–80 座，貼路、existing:true、level 1–2。
 */
export function placeExistingFacilities(
  state: GameState,
  options: { maxFacilities?: number; minSpawnDistance?: number } = {},
): { facilities: number; jobs: number } {
  const layers = loadLayers();
  if (!layers) return { facilities: 0, jobs: 0 };
  const { width, height } = state;
  const spawn = state.spawn ?? { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  const target = Math.max(0, Math.min(80, options.maxFacilities ?? 60));
  const minSpawnDistance = Math.max(0, options.minSpawnDistance ?? 14);
  const CELL = 8;
  const cells = new Map<number, { i: number; x: number; y: number; lu: number; priority: number }[]>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const t = state.tiles[i];
      if (t.road || t.buildingId >= 0) continue;
      if (!BUILDABLE.has(t.terrain)) continue;
      if (isShenzhenSideTile(x, y, width, height)) continue;
      const lu = layers.landuse[i];
      if (lu !== 31 && lu !== 32) continue;
      if (Math.hypot(x - spawn.x, y - spawn.y) < minSpawnDistance) continue;
      if (!touchesRoad(state, x, y, 1, 1)) continue;
      const key = Math.floor(y / CELL) * Math.ceil(width / CELL) + Math.floor(x / CELL);
      const list = cells.get(key) ?? [];
      list.push({ i, x, y, lu, priority: (t.density ?? 0) + hash01(x, y, state.seed, 71) * 30 });
      cells.set(key, list);
    }
  }
  let facilities = 0;
  let jobs = 0;
  const keys = [...cells.keys()].sort((a, b) => a - b);
  for (const key of keys) {
    if (facilities >= target) break;
    const list = (cells.get(key) ?? []).sort((a, b) => b.priority - a.priority);
    for (const c of list) {
      if (facilities >= target) break;
      const pool = c.lu === 32 ? FACILITY_DEFS_PARK : FACILITY_DEFS_GIC;
      const totalW = pool.reduce((sum, d) => sum + d.weight, 0);
      let r = hash01(c.x, c.y, state.seed, 73) * totalW;
      let chosenIdx = 0;
      for (let k = 0; k < pool.length; k++) {
        r -= pool[k].weight;
        if (r <= 0) {
          chosenIdx = k;
          break;
        }
      }
      // 候選 LU31/32 格本身唔一定貼住現有道路（道路網已簡化）；喺 2 格內
      // 搵一個 free footprint + 貼路位置。
      const OFFSETS: [number, number][] = [
        [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2],
      ];
      let placed = false;
      for (const [ox, oy] of OFFSETS) {
        if (placed) break;
        const px = c.x + ox;
        const py = c.y + oy;
        if (!touchesRoad(state, px, py, 1, 1)) continue;
        for (let k = 0; k < pool.length && !placed; k++) {
          const def = BUILDINGS[pool[(chosenIdx + k) % pool.length].key];
          if (!def) continue;
          const w = Math.max(1, Math.min(3, def.size[0]));
          const h = Math.max(1, Math.min(2, def.size[1]));
          if (!freeFootprint(state, px, py, w, h)) continue;
          if (!touchesRoad(state, px, py, w, h)) continue;
          if (isShenzhenSideTile(px, py, width, height)) continue;
          const level = 1 + (hash01(px, py, state.seed, 77) > 0.5 ? 1 : 0);
          const building: Building = {
            id: state.nextBuildingId++,
            key: def.key,
            x: px,
            y: py,
            w,
            h,
            active: true,
            connected: true,
            workers: [],
            residents: [],
            inventory: {},
            productionProgress: 0,
            level,
            builtOnDay: 1,
            incomeThisMonth: 0,
            expenseThisMonth: 0,
            auto: false,
            existing: true,
          };
          for (let dy = 0; dy < h; dy++) {
            for (let dx = 0; dx < w; dx++) {
              state.tiles[(py + dy) * width + px + dx].buildingId = building.id;
            }
          }
          state.buildings.push(building);
          facilities++;
          jobs += def.workers ?? 0;
          placed = true;
        }
      }
      if (placed) break; // 每個 cell 最多一座設施，保持全港分佈
    }
  }
  return { facilities, jobs };
}

/**
 * 生成現有樓群（會直接 mutate `state.tiles`／`state.buildings`）。
 * 只喺 starter 模式有效；empty 模式回傳 0。
 */
export function generateExistingBuildings(
  state: GameState,
  options: ExistingCityOptions = {},
): ExistingCityStats {
  const result: ExistingCityStats = {
    buildings: 0,
    roads: 0,
    zones: 0,
    housing: 0,
    jobs: 0,
    facilities: 0,
    gates: 0,
    connectorRoads: 0,
    componentsBefore: 0,
    componentsAfter: 0,
    buildingsOnMainNetwork: 0,
  };
  if (state.gameMode === 'empty') return result;
  const layers = loadLayers();
  if (!layers) {
    if (typeof console !== 'undefined') {
      console.warn('[existing-city] hk-map-data 未包含 landuse／roadHint，跳過現有樓群生成');
    }
    return result;
  }
  const { width, height, tiles, seed } = state;
  const spawn = state.spawn ?? { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  const maxBuildings = Math.max(0, options.maxBuildings ?? 420);
  const maxRoads = Math.max(0, options.maxRoads ?? 3000);
  const minSpawnDistance = Math.max(0, options.minSpawnDistance ?? 20);

  // ── 1. 道路：用 landuse 41/42 roadHint 鋪真實主要道路 ──
  // 先以 roadHint 本身嘅 4-neigh 連通分量為單位，優先保留最大嘅真實道路網，
  // 避免「按 density 抽樣」造成 800+ 段碎片（connectivity 亦會快好多）。
  const hintSet = new Uint8Array(width * height);
  const hintTiles: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!roadHintAt(layers, i)) continue;
      const t = tiles[i];
      if (t.road || t.buildingId >= 0) continue;
      if (!BUILDABLE.has(t.terrain)) continue;
      if (isShenzhenSideTile(x, y, width, height)) continue;
      if (Math.hypot(x - spawn.x, y - spawn.y) < Math.max(12, minSpawnDistance - 8)) continue;
      hintSet[i] = 1;
      hintTiles.push(i);
    }
  }
  // roadHint components（4-neigh）
  const hintComp = new Int32Array(width * height).fill(-1);
  const hintComps: number[][] = [];
  for (const seed of hintTiles) {
    if (hintComp[seed] >= 0) continue;
    const id = hintComps.length;
    const list: number[] = [];
    const queue: number[] = [seed];
    hintComp[seed] = id;
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      list.push(cur);
      const x = cur % width;
      const y = (cur - x) / width;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (!hintSet[ni] || hintComp[ni] >= 0) continue;
        hintComp[ni] = id;
        queue.push(ni);
      }
    }
    hintComps.push(list);
  }
  hintComps.sort((a, b) => b.length - a.length);
  // #10：starter 道路唔好太密。existing 生成路 cap 收緊到 2,400 格（加 starter 小鎮
  // 同接駁後總數約 2,800–3,400）；其中頭 45% 當主幹（闊路），其餘做窄街
  // `localRoad=true`（render 用窄身深灰街，唔再成片黑）。
  const roadCap = Math.min(maxRoads, 2400);
  const trunkBudget = Math.round(roadCap * 0.45);
  let selectedRoads = 0;
  for (const comp of hintComps) {
    if (selectedRoads >= roadCap) break;
    if (selectedRoads + comp.length > roadCap) continue; // 揀細啲 component 填滿 cap
    for (const i of comp) {
      if (tiles[i].road) continue;
      tiles[i].road = true;
      (tiles[i] as Tile & { localRoad?: boolean }).localRoad = selectedRoads >= trunkBudget;
      selectedRoads++;
    }
  }
  result.roads += selectedRoads;

    // 補窿：將抽樣道路連返連續（減少 component 數，令現有樓宇真係通勤到）
  const densified = densifySelectedRoads(state);
  result.roads += densified;

  // ── 2. 候選樓宇：貼路 + landuse zone + density 高 + 遠離 spawn 小鎮 ──
  interface Candidate {
    index: number;
    x: number;
    y: number;
    zone: ZoneType;
    density: number;
    height: number;
    priority: number;
  }
  const candidates: Candidate[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const t = tiles[i];
      if (t.road || t.buildingId >= 0) continue;
      if (!BUILDABLE.has(t.terrain)) continue;
      if (isShenzhenSideTile(x, y, width, height)) continue;
      const zone = ZONE_BY_LU[layers.landuse[i]];
      if (!zone) continue;
      const density = t.density ?? 0;
      if (density < 12) continue;
      if (Math.hypot(x - spawn.x, y - spawn.y) < minSpawnDistance) continue;
      // 每格最多對應一個 candidate（之後 footprint 檢查會再篩）
      candidates.push({
        index: i,
        x,
        y,
        zone,
        density,
        height: t.buildingHeight ?? 0,
        priority: density * 2 + (t.buildingHeight ?? 0) * 0.5 + hash01(x, y, seed, 11) * 20,
      });
    }
  }

  // 空間分佈：每 6×6 tile cell 最多 3 棟，確保分佈全港而非集中一區
  const CELL = 6;
  const cells = new Map<number, Candidate[]>();
  for (const c of candidates) {
    const cx = Math.floor(c.x / CELL);
    const cy = Math.floor(c.y / CELL);
    const key = cy * Math.ceil(width / CELL) + cx;
    const arr = cells.get(key);
    if (arr) arr.push(c);
    else cells.set(key, [c]);
  }
  const cellKeys = [...cells.keys()].sort((a, b) => a - b);
  const perCell = 3;
  const placed: Candidate[] = [];
  for (const key of cellKeys) {
    if (placed.length >= maxBuildings) break;
    const list = (cells.get(key) ?? []).sort((a, b) => b.priority - a.priority);
    let count = 0;
    for (const c of list) {
      if (count >= perCell) break;
      if (placed.length >= maxBuildings) break;
      if (!touchesRoad(state, c.x, c.y, 1, 1)) continue;
      if (!freeFootprint(state, c.x, c.y, 1, 1)) continue;
      placed.push(c);
      count++;
    }
  }

  // ── 3. 放 Building（1–2×1–2 footprint、level 1–3、existing:true） ──
  for (const c of placed) {
    const defKeys = DEFS_BY_ZONE[c.zone];
    if (!defKeys || defKeys.length === 0) continue;
    const start = Math.floor(hash01(c.x, c.y, seed, 23) * defKeys.length);
    let chosen: Building | null = null;
    for (let k = 0; k < defKeys.length; k++) {
      const key = defKeys[(start + k) % defKeys.length];
      const def = BUILDINGS[key];
      if (!def) continue;
      const w = Math.max(1, Math.min(2, def.size[0]));
      const h = Math.max(1, Math.min(2, def.size[1]));
      if (!freeFootprint(state, c.x, c.y, w, h)) continue;
      if (!touchesRoad(state, c.x, c.y, w, h)) continue;
      const level = Math.max(1, Math.min(3, 1 + Math.floor(c.height / 90)));
      const building: Building = {
        id: state.nextBuildingId++,
        key,
        x: c.x,
        y: c.y,
        w,
        h,
        active: true,
        connected: true,
        workers: [],
        residents: [],
        inventory: {},
        productionProgress: 0,
        level,
        builtOnDay: 1,
        incomeThisMonth: 0,
        expenseThisMonth: 0,
        auto: false,
        zone: c.zone,
        existing: true,
      };
      chosen = building;
      break;
    }
    if (!chosen) continue;
    for (let dy = 0; dy < chosen.h; dy++) {
      for (let dx = 0; dx < chosen.w; dx++) {
        const ti = (chosen.y + dy) * width + (chosen.x + dx);
        tiles[ti].buildingId = chosen.id;
        tiles[ti].zone = c.zone;
        result.zones++;
      }
    }
    state.buildings.push(chosen);
    result.buildings++;
    const def = BUILDINGS[chosen.key];
    result.housing += def?.housing ?? 0;
    result.jobs += def?.workers ?? 0;
  }

  // ── 4. 現有公共設施（landuse 31／32；Issue #7 追加） ──
  const facilityStats = placeExistingFacilities(state, {
    maxFacilities: options.maxFacilities ?? 60,
    minSpawnDistance: Math.max(12, minSpawnDistance - 6),
  });
  result.facilities = facilityStats.facilities;
  result.buildings += facilityStats.facilities;
  result.jobs += facilityStats.jobs;

  // ── 5. 邊境口岸＋接駁（Issue #4／#6） ──
  if (options.buildBorderLinks !== false) {
    const border = buildBorderLinks(state);
    result.gates = border.gates;
    result.buildings += border.gates;
    result.roads += border.roadTiles;
  }

  // ── 6. 道路 component 接駁（Issue #7 追加） ──
  if (options.connectRoads !== false) {
    const conn = connectExistingRoadComponents(state, {
      maxConnectorRoads: options.maxConnectorRoads ?? 3500,
      minComponentSize: options.minComponentSize ?? 2,
    });
    result.componentsBefore = conn.componentsBefore;
    result.connectorRoads = conn.connectorRoads;
    result.roads += conn.connectorRoads;
    // 逐棟現有樓宇接駁到主道路網絡（最後一哩）
    const buildingLink = connectBuildingsToMainNetwork(state);
    result.connectorRoads += buildingLink.roads;
    result.roads += buildingLink.roads;
    // 口岸最後一哩：確保 border gates 貼主網絡（mainland sim 需要 component >20）
    const gateLink = ensureBorderGatesLinked(state);
    result.connectorRoads += gateLink.roads;
    result.roads += gateLink.roads;
    const finalComps = computeRoadComponents(state);
    result.componentsAfter = finalComps.sizes.length;
    // 重新計 buildingsOnMainNetwork（畀 Lead 睇連通率）
    let onMain = 0;
    let mainIdx = 0;
    for (let k = 1; k < finalComps.sizes.length; k++) {
      if (finalComps.sizes[k] > finalComps.sizes[mainIdx]) mainIdx = k;
    }
    for (const b of state.buildings) {
      if (!b.existing) continue;
      let touchesMain = false;
      for (let dy = 0; dy < b.h && !touchesMain; dy++) {
        for (let dx = 0; dx < b.w && !touchesMain; dx++) {
          const tx = b.x + dx;
          const ty = b.y + dy;
          for (const [nx, ny] of [[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]] as const) {
            if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) continue;
            const ni = ny * state.width + nx;
            if (state.tiles[ni].road && finalComps.labels[ni] === mainIdx) touchesMain = true;
          }
        }
      }
      if (touchesMain) onMain++;
    }
    result.buildingsOnMainNetwork = onMain;
  } else {
    const comps = computeRoadComponents(state);
    result.componentsBefore = comps.sizes.length;
    result.componentsAfter = comps.sizes.length;
  }

  return result;
}
