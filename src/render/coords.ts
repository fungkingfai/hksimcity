/**
 * 世界座標 ↔ 格座標換算（所有渲染模組共用）。
 *
 * 地圖置中於原點：格 (0,0) 的左上角在 (-width*TILE/2, -height*TILE/2)，
 * x 軸向東、z 軸向南、y 軸向上。
 */

import { TILE_SIZE } from '../core/config';
import type { Building, GameState } from '../core/types';

export const TILE = TILE_SIZE;

/** 格左上角世界座標 */
export function tileCornerWorld(tx: number, ty: number, width: number, height: number): { x: number; z: number } {
  return {
    x: tx * TILE - (width * TILE) / 2,
    z: ty * TILE - (height * TILE) / 2,
  };
}

/** 格中心世界座標 */
export function tileWorld(tx: number, ty: number, width: number, height: number): { x: number; z: number } {
  return {
    x: (tx + 0.5) * TILE - (width * TILE) / 2,
    z: (ty + 0.5) * TILE - (height * TILE) / 2,
  };
}

export function tileIndexToWorld(state: GameState, index: number): { x: number; z: number } {
  return tileWorld(index % state.width, Math.floor(index / state.width), state.width, state.height);
}

/** 世界座標 → 格 index；超出地圖回傳 -1 */
export function worldToTileIndex(state: GameState, wx: number, wz: number): number {
  const tx = Math.floor((wx + (state.width * TILE) / 2) / TILE);
  const ty = Math.floor((wz + (state.height * TILE) / 2) / TILE);
  if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) return -1;
  return ty * state.width + tx;
}

export function worldToTileXY(state: GameState, wx: number, wz: number): { x: number; y: number } {
  const index = worldToTileIndex(state, wx, wz);
  if (index < 0) return { x: -1, y: -1 };
  return { x: index % state.width, y: Math.floor(index / state.width) };
}

/** 建築佔地中心世界座標 */
export function buildingWorldCenter(state: GameState, building: Building): { x: number; z: number } {
  const cx = building.x + building.w / 2;
  const cy = building.y + building.h / 2;
  return {
    x: cx * TILE - (state.width * TILE) / 2,
    z: cy * TILE - (state.height * TILE) / 2,
  };
}

/** 給定工具與滑鼠所在格，計算建築左上角（置中擺放） */
export function buildingAnchor(state: GameState, key: string, w: number, h: number, tileX: number, tileY: number): { x: number; y: number } {
  const ax = tileX - Math.floor((w - 1) / 2);
  const ay = tileY - Math.floor((h - 1) / 2);
  return { x: ax, y: ay };
}

export function mapHalfExtents(state: GameState): { halfW: number; halfH: number } {
  return { halfW: (state.width * TILE) / 2, halfH: (state.height * TILE) / 2 };
}
