/** CSDI 3D-BIT00 real building landmark model (Round 9 / issue #20). */
export interface Landmark3DModel {
  id: number;
  /** CSDI 3D-BIT00 sheet, e.g. 11SW8D */
  sheet: string;
  /** Real building height in metres (3DS z span) */
  heightM: number;
  /** Tile coords derived from HK1980 model centroid */
  xTile: number;
  yTile: number;
  /** Relative vertices in world units: x(east), y(up), z(south); centroid at origin, base y=0 */
  verts: number[];
  /** Triangle indices into verts/3 */
  tris: number[];
}
