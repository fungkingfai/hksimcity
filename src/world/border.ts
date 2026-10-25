/**
 * 深圳河／邊境通道共用世界資料（Issue #4）。
 *
 * 資料由 `tools/build-hk-data.py` 生成（`hk-map-data.generated.ts`），
 * 全部座標為 **96 設計座標**（renderer/worldgen 再乘以 width/96）。
 *
 * 用途：
 *  - worldgen：喺 `BORDER_CROSSINGS` 位置放道路／鐵路口岸（`roadBorderGate`／
 *    `railBorderGate`），並預留向北過河接駁；
 *  - sim placement：限制口岸建築只可放喺邊境通道附近（用 `isNearBorderCrossing`）；
 *  - existing-city：用 `isShenzhenSideDesign` 避開深圳範圍，只生成香港現有樓群。
 */
import { HK_MAP_DATA } from './hk-map-data.generated';
import type { BorderCrossingKind } from './hk-map-data-types';

export interface BorderCrossing {
  name: string;
  /** 96 設計座標（口岸 anchor，喺深圳河香港側） */
  x: number;
  y: number;
  kind: BorderCrossingKind;
  /** 對應 config BUILDINGS 嘅口岸建築 key */
  buildingKey: 'roadBorderGate' | 'railBorderGate';
}

const GATE_KEY: Record<BorderCrossingKind, 'roadBorderGate' | 'railBorderGate'> = {
  road: 'roadBorderGate',
  rail: 'railBorderGate',
};

/** 4 個真實邊境通道（羅湖／落馬洲／文錦渡／沙頭角），設計座標 */
export const BORDER_CROSSINGS: readonly BorderCrossing[] = (HK_MAP_DATA.borderCrossings ?? []).map((c) => ({
  name: c.name,
  x: c.x,
  y: c.y,
  kind: c.kind,
  buildingKey: GATE_KEY[c.kind],
}));

/** 深圳河中心線（96 設計座標；西→東）。 */
export const SHENZHEN_RIVER_CENTERLINE: readonly [number, number][] =
  HK_MAP_DATA.border?.centerline ?? [];

/** 深圳河兩岸 polygon ring（96 設計座標；可供 render 畫河面）。 */
export const SHENZHEN_RIVER_RING: readonly [number, number][] = HK_MAP_DATA.shenzhenRiver ?? [];

/** 河闊（tile，112m grid）。 */
export const BORDER_RIVER_WIDTH_TILES = HK_MAP_DATA.border?.riverWidthTiles ?? 2;

/** 設計座標 → tile 座標（浮點；同 renderer `designToWorld` 一致）。 */
export function designToTileFloat(
  designX: number,
  designY: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const sx = width / 96;
  const sy = height / 96;
  return { x: (designX + 0.5) * sx - 0.5, y: (designY + 0.5) * sy - 0.5 };
}

/** tile 座標（可浮點）→ 設計座標。 */
export function tileToDesignFloat(
  tx: number,
  ty: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const sx = width / 96;
  const sy = height / 96;
  return { x: (tx + 0.5) / sx - 0.5, y: (ty + 0.5) / sy - 0.5 };
}

/** 深圳河喺某設計 x 嘅中心設計 y（分段線性內插；西→東）。 */
export function borderYAtDesign(designX: number): number | null {
  const line = SHENZHEN_RIVER_CENTERLINE;
  if (line.length < 2) return null;
  if (designX <= line[0][0]) return line[0][1];
  for (let k = 0; k < line.length - 1; k++) {
    const [x0, y0] = line[k];
    const [x1, y1] = line[k + 1];
    if (designX <= x1) {
      const t = x1 === x0 ? 0 : (designX - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return line[line.length - 1][1];
}

/**
 * 設計座標係咪喺深圳側（深圳河以北）。
 * tile y 向北遞減；河中心線 y 以北 = 深圳。
 */
export function isShenzhenSideDesign(designX: number, designY: number): boolean {
  const y = borderYAtDesign(designX);
  if (y == null) return false;
  return designY < y - BORDER_RIVER_WIDTH_TILES * 0.5;
}

/** tile 座標係咪喺深圳側（已 cache 每張地圖嘅 mask，避免逐格掃 centerline）。 */
let shenzhenMaskCache: { width: number; height: number; mask: Uint8Array } | null = null;

export function isShenzhenSideTile(
  tx: number,
  ty: number,
  width: number,
  height: number,
): boolean {
  if (!shenzhenMaskCache || shenzhenMaskCache.width !== width || shenzhenMaskCache.height !== height) {
    const mask = new Uint8Array(width * height);
    const sx = width / 96;
    const sy = height / 96;
    for (let x = 0; x < width; x++) {
      const designX = (x + 0.5) / sx - 0.5;
      const by = borderYAtDesign(designX);
      if (by == null) continue;
      // design y < by - 河闊/2 → 深圳側；轉返 tile y
      const boundaryDesignY = by - BORDER_RIVER_WIDTH_TILES * 0.5;
      const boundaryTiles = (boundaryDesignY + 0.5) * sy - 0.5;
      const yEnd = Math.min(height - 1, Math.floor(boundaryTiles));
      for (let y = 0; y <= yEnd; y++) mask[y * width + x] = 1;
    }
    shenzhenMaskCache = { width, height, mask };
  }
  if (tx < 0 || ty < 0 || tx >= width || ty >= height) return false;
  return shenzhenMaskCache.mask[ty * width + tx] === 1;
}

/** 同最近邊境通道嘅設計距離（格）；用嚟限制口岸建築放置。 */
export function distanceToBorderCrossingDesign(designX: number, designY: number): number {
  let best = Infinity;
  for (const c of BORDER_CROSSINGS) {
    const d = Math.hypot(designX - c.x, designY - c.y);
    if (d < best) best = d;
  }
  return best;
}

/** 設計座標係咪喺指定口岸半徑內（單位：設計格）。 */
export function isNearBorderCrossing(
  designX: number,
  designY: number,
  radiusDesign = 6,
): boolean {
  return distanceToBorderCrossingDesign(designX, designY) <= radiusDesign;
}
