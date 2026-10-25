/**
 * 真實地理數據（CSDI／地政總署）生成的地圖資料型別。
 * 由 `tools/build-hk-data.py` 離線生成 `hk-map-data.generated.ts`；
 * 資料包含 600×600 格（112m/tile）地形、高程、建築密度／高度、真實地名、地標、隧道與市區區塊。
 */

export type MapLabelKind = 'district' | 'mountain' | 'water' | 'island' | 'landmark' | 'reservoir';
export type MapLandmarkKind = 'peakTower' | 'buddha' | 'ferrisWheel' | 'clockTower' | 'convention' | 'bigBridge';
export type MapRegionKind = 'skyline' | 'airport' | 'runway' | 'containerPort' | 'newTown';
export type BorderCrossingKind = 'road' | 'rail';

export interface MapData {
  format: 'hk-map-data-v1';
  width: number;
  heightTiles: number;
  tileMeters: number;
  e0: number;
  nTop: number;
  /** 地形 RLE（每 pair: terrainCode, runLength）base64 */
  terrainRle: string;
  /** 每格高程（0..255，0=海，255≈650m）base64 */
  elevation: string;
  /** 每格建築覆蓋率（0..255）base64 */
  density: string;
  /** 每格平均建築高度（0..255 ≈ 0..500m）base64 */
  buildingHeight: string;
  labels: [string, number, number, MapLabelKind][];
  landmarks: [string, number, number, MapLandmarkKind][];
  /** [名稱, 設計 x, 設計 y]（設計座標 = 96 基準，renderer 會再換算） */
  tunnels: [string, number, number][];
  regions: [string, number, number, number, number, MapRegionKind][];
  spawn: { x: number; y: number };
  /** 土地利用 class（0..92，600×600；來自規劃署 LUHK 2020）base64，每格 1 byte */
  landuse?: string;
  /** 道路 hint bit mask（每格 1 bit；來自 landuse 41/42）。
   *  編碼：tile index i → byte i>>3、bit i&7（LSB-first）；byte array base64。 */
  roadHint?: string;
  /** 深圳河／邊境元資料（Issue #4） */
  border?: {
    riverWidthTiles?: number;
    /** 深圳河中心線（96 設計座標；西→東） */
    centerline?: [number, number][];
  };
  /** 深圳河及邊境通道（設計座標） */
  borderCrossings?: { name: string; x: number; y: number; kind: BorderCrossingKind }[];
  /** 深圳河多邊形（設計座標 ring；可供 render 畫河／邊界） */
  shenzhenRiver?: [number, number][];
}
