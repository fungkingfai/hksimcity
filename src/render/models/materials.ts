/**
 * 《維港之城》— 建築共用材質庫（香港配色、霓虹招牌、玻璃幕牆貼圖）。
 *
 * 效能策略：
 *  - 材質以「顏色 + 參數」為 key 快取；所有建築實例共用同一批材質。
 *  - 玻璃幕牆／鋁窗採用 CanvasTexture 程序化貼圖（日光版＋夜燈版），
 *    一棟樓幾面牆只佔 1 個 draw call；夜間只換 map，不重建材質。
 *  - 霓虹招牌文字（NEON_SIGNS）以 CanvasTexture 繪製發光字，只建立一次後共用；
 *    日間由材質 color 壓暗（霓虹未開），夜間全亮。
 *  - 原型內的靜態幾何由 geometry-utils 依「頂點色桶」合併成數個 mesh；
 *    本檔提供 vertexLit / vertexWarm / vertexNeon / vertexBasic 等合併材質。
 *  - `dispose()` 一次釋放全部材質與貼圖（由 BuildingsView.dispose 呼叫）。
 *
 * 本檔可在無 DOM 環境（單元測試）安全載入：缺 document 時退回純色材質。
 *
 * 與舊版（華夏古城）的差異：配色改為香港（霓虹粉／青、玻璃藍、混凝土灰、
 * 公屋米黃、唐樓磚紅、港鐵紅、巴士黃、電車綠），新增霓虹招牌、玻璃幕牆、
 * 路牌標籤、自訂圖示（港鐵標誌／紅十字）等方法；原有 API 全部保留，
 * interiors-dev 可繼續使用 lambert / basic / own / canvasTexture / setNightMode。
 */

import * as THREE from 'three';

export const HAS_DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

/**
 * 低多邊形調色盤。前半保留舊版 key（室內模組仍會 import），
 * 後半是香港建築常用色。材質顏色一律由此取用，保持整體和諧。
 */
export const PAL = {
  // ── 牆體（通用） ──
  wallWhite: 0xe9e6dc,
  wallCream: 0xe2d7bf,
  wallGrey: 0xb9bcbd,
  wallMud: 0xb1986c,
  wallRed: 0xa8483b,
  wallRedDark: 0x8a352c,
  plasterWarm: 0xded0b4,
  concrete: 0xa8a9a4, // 混凝土灰
  concreteDark: 0x77787a,
  concreteLight: 0xc6c7c2,
  paintGreen: 0x6f8f72, // 舊樓外牆油漆綠（唐樓）
  paintPink: 0xd9a8a0, // 舊樓粉紅
  paintYellow: 0xd9c48a, // 舊樓米黃
  paintBlue: 0x8fa8b8, // 舊樓淺藍
  tileWhite: 0xe6e8e6, // 白磁磚（公屋／醫院）
  publicHousingCream: 0xd9c9a8, // 公屋米黃
  publicHousingGreen: 0x7a9a78, // 公屋綠腰線
  hosPink: 0xe0c4bc, // 居屋粉
  hosBlue: 0xb9c9d4, // 居屋藍
  luxurySilver: 0xd4dae0, // 豪宅銀灰
  tongLauBrick: 0xa8685a, // 唐樓磚紅
  tongLauBrickDark: 0x82504a,
  hospitalWhite: 0xe8eef2,
  schoolGreen: 0xcfe0c8,
  schoolCream: 0xe8e0c8,
  policeBlue: 0x3f5f9f,
  policeWhite: 0xe4e8ee,
  fireRed: 0xb0443f,
  fireRedDark: 0x8a2f2c,
  factoryCream: 0xd6c9a8,

  // ── 玻璃／金屬 ──
  glassDark: 0x2c3f4a,
  glassBlue: 0x3f6e8f,
  glassTeal: 0x2f6f6a,
  glassGreen: 0x4f7f6f,
  glassLit: 0xd9b98a, // 亮窗（帶暖色自發光）
  glassCool: 0xcfdde8, // 冷白亮窗
  aluminium: 0xb9c0c4, // 鋁窗框
  aluminiumDark: 0x8d9499,
  steelGrey: 0x7f8a92,
  mtrRed: 0xb02a2a,
  kcrBlue: 0x2f5f9f,
  busYellow: 0xd9b23f,
  tramGreen: 0x2f8f5f,
  neonPink: 0xff3d7f,
  neonCyan: 0x24e0ff,
  neonGold: 0xffd166,
  neonPurple: 0xa45bff,
  neonGreen: 0x5cff9d,
  neonOrange: 0xff7a3d,
  neonRed: 0xff4a4a,

  // ── 木構（舊版 key 保留，室內可用） ──
  wood: 0x7c5a37,
  woodLight: 0xa37d4f,
  woodDark: 0x4e3521,
  woodBlack: 0x2c2117,
  pillarRed: 0xa63e31,
  pillarRedDark: 0x7d2b24,
  // ── 屋瓦（舊 key；香港多用平屋頂，少量中式酒樓／公園涼亭仍用） ──
  tile: 0x56616f,
  tileDark: 0x3f4651,
  tileLight: 0x707a88,
  tileGreen: 0x51645b,
  // ── 茅草（舊 key） ──
  thatch: 0xb59a5c,
  thatchDark: 0x8b7443,
  thatchLight: 0xc9b077,
  // ── 石 ──
  stone: 0x9a9a90,
  stoneDark: 0x6f7068,
  stoneLight: 0xb8b7ac,
  rock: 0x8c857a, // 石礦場岩面
  rockDark: 0x6d675c,
  rockLight: 0xa89f8f,
  // ── 金屬／金飾 ──
  gold: 0xc9a24c,
  goldDark: 0x9a7833,
  iron: 0x596270,
  ironDark: 0x3b414a,
  bronze: 0x8a6f43,
  rust: 0x8a5a3a, // 鏽鐵（舊樓喉管）
  // ── 燈籠（酒樓／公園） ──
  lantern: 0xc9492f,
  lanternGlow: 0xffb36b,
  lanternDark: 0x8f2f22,
  // ── 布料 ──
  clothRed: 0xb4453a,
  clothBlue: 0x466880,
  clothTeal: 0x4e7f74,
  clothYellow: 0xc9a24c,
  clothWhite: 0xe8dfcc,
  clothPink: 0xc08a9a,
  clothGreen: 0x6f8f5f,
  clothPurple: 0x8a6fa0,
  clothOrange: 0xd98a4a,
  // ── 自然 ──
  crop: 0x9cb356,
  cropGold: 0xd6b856,
  leaf: 0x5f7f4a,
  leafDark: 0x48643a,
  leafBanyan: 0x4b6f3f, // 榕樹濃綠
  leafPalm: 0x6f9a4f, // 棕櫚
  leafFlower: 0xd97f8a, // 洋紫荊／杜鵑花色
  bamboo: 0x9aa85c, // 竹棚竹枝
  bambooDark: 0x7a8a48,
  bambooNet: 0x6f8f6a, // 竹棚安全網（綠）
  water: 0x4d7f9b,
  poolWater: 0x4fa8c9,
  earth: 0x8b6f45,
  soil: 0x6d5136,
  gravel: 0x9a9084,
  // ── 其他 ──
  paper: 0xefe5cf,
  dark: 0x241c15,
  smoke: 0xd8d2c4,
  steam: 0xe6e8e8,
  fire: 0xff7a32,
  ember: 0xffb347,
  ore: 0x7a6a58,
  coal: 0x2f2c29,
  // ── 香港街道／交通 ──
  roadAsphalt: 0x3f4247,
  roadLine: 0xe8e4d8,
  roadYellow: 0xd9b23f,
  streetSignGreen: 0x1f6b45, // 香港路牌綠
  streetSignWhite: 0xe8ece8,
  busStopBlue: 0x2a5f9f,
  taxiRed: 0xb02a2a,
  refuseGrey: 0x8a8f8a, // 垃圾房
  hazardYellow: 0xd9b23f, // 地盤黃黑
  hazardBlack: 0x2a2a2a,
  amberSignal: 0xffa62b,
  // ── 貨櫃顏色 ──
  cargoRed: 0xa8453a,
  cargoBlue: 0x2f5f8a,
  cargoYellow: 0xc9a24c,
  cargoGreen: 0x3f7a5a,
  cargoGrey: 0x8d9499,
  cargoOrange: 0xc97a3a,
} as const;

export interface LambertParams {
  emissive?: number;
  emissiveIntensity?: number;
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
  map?: THREE.Texture | null;
  depthWrite?: boolean;
}

export interface BasicParams {
  map?: THREE.Texture | null;
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
  depthWrite?: boolean;
  toneMapped?: boolean;
  blending?: THREE.Blending;
  vertexColors?: boolean;
}

export interface TextOptions {
  w?: number;
  h?: number;
  bg?: string;
  fg?: string;
  border?: string;
  vertical?: boolean;
  fontScale?: number;
  borderWidth?: number;
  /** 底部加流蘇／裝飾帶 */
  tassel?: boolean;
  /** 雙面（旗幡） */
  doubleSide?: boolean;
}

/** 霓虹招牌選項 */
export interface NeonSignOptions {
  /** 直式（掛牆伸出，香港招牌經典）或橫式（舖面招牌） */
  vertical?: boolean;
  /** 霓虹光管顏色（PAL.neon* 或 NEON_COLORS 其中一色） */
  color?: number;
  /** 底板顏色（預設深紫黑） */
  board?: string;
  /** 字體大小比例（0.4~0.8） */
  fontScale?: number;
  /** 雙面（直式伸出招牌兩面都要有字） */
  doubleSide?: boolean;
  /** 招牌加白色光管邊框 */
  border?: boolean;
  /** 畫布尺寸（預設直式 128×352、橫式 384×112） */
  w?: number;
  h?: number;
}

/** 平面標籤（港鐵站名牌、出口牌、路牌、巴士路線牌）選項 */
export interface LabelOptions {
  w?: number;
  h?: number;
  bg?: string;
  fg?: string;
  border?: string;
  vertical?: boolean;
  fontScale?: number;
  bold?: boolean;
  /** 左下角小字（如英文名） */
  sub?: string;
}

/** 玻璃幕牆／外牆貼圖款式 */
export type FacadeStyle =
  | 'glassBlue' // 藍玻璃幕牆（甲級商廈）
  | 'glassTeal' // 青綠玻璃（豪宅）
  | 'office' // 商廈（橫向間牆＋豎框）
  | 'aluminium' // 鋁窗工廈（橫帶窗）
  | 'publicHousing' // 公屋米黃小窗
  | 'hos' // 居屋粉／藍小窗
  | 'brick' // 唐樓磚紅
  | 'shop' // 地舖玻璃門面（便利店／茶餐廳）
  | 'mall' // 商場大玻璃
  | 'warehouse' // 貨倉坑板鐵皮
  | 'hospital' // 醫院白牆長窗
  | 'school' // 學校淺綠
  | 'tile'; // 白磁磚（警署／政府樓）

interface FacadeDef {
  cols: number;
  rows: number;
  /** 一張貼圖覆蓋的世界寬（格內單位） */
  tileW: number;
  /** 一張貼圖覆蓋的世界高 */
  tileH: number;
  /** 牆底色（日／夜同色系） */
  bg: string;
  bgDark: string;
  glass: string;
  glassDark: string;
  frame: string;
  /** 夜間亮窗色 */
  lit: string;
  /** 夜間亮窗比例 0..1 */
  litRatio: number;
  /** small：獨立小窗；ribbon：橫帶窗；curtain：整幅幕牆；shop：舖面；metal：坑板鐵皮 */
  kind: 'small' | 'ribbon' | 'curtain' | 'shop' | 'metal';
}

/** 各款外牆貼圖的世界尺寸（hk-parts 依此計算 UV repeat） */
export const FACADE_TILES: Record<FacadeStyle, { w: number; h: number }> = {
  glassBlue: { w: 2.4, h: 2.2 },
  glassTeal: { w: 2.4, h: 2.2 },
  office: { w: 2.4, h: 2.2 },
  aluminium: { w: 2.4, h: 2.2 },
  publicHousing: { w: 2.4, h: 2.2 },
  hos: { w: 2.4, h: 2.2 },
  brick: { w: 2.4, h: 2.2 },
  shop: { w: 2.0, h: 1.0 },
  mall: { w: 2.4, h: 1.8 },
  warehouse: { w: 1.6, h: 1.6 },
  hospital: { w: 2.4, h: 2.2 },
  school: { w: 2.4, h: 2.2 },
  tile: { w: 2.4, h: 2.2 },
};

const FACADE_DEFS: Record<FacadeStyle, FacadeDef> = {
  glassBlue: {
    cols: 4, rows: 4, tileW: 2.4, tileH: 2.2,
    bg: '#22313e', bgDark: '#16222c', glass: '#3f6e8f', glassDark: '#243c4c',
    frame: '#9fb2c0', lit: '#ffe2a8', litRatio: 0.42, kind: 'curtain',
  },
  glassTeal: {
    cols: 4, rows: 4, tileW: 2.4, tileH: 2.2,
    bg: '#1d3634', bgDark: '#132523', glass: '#2f6f6a', glassDark: '#1e4542',
    frame: '#b8ccc4', lit: '#ffedbb', litRatio: 0.5, kind: 'curtain',
  },
  office: {
    cols: 4, rows: 4, tileW: 2.4, tileH: 2.2,
    bg: '#2a3a46', bgDark: '#1b262e', glass: '#4a7fa8', glassDark: '#2b4a61',
    frame: '#cfd9e0', lit: '#fff0c4', litRatio: 0.55, kind: 'curtain',
  },
  aluminium: {
    cols: 4, rows: 4, tileW: 2.4, tileH: 2.2,
    bg: '#aeb3b6', bgDark: '#83888c', glass: '#5d7f96', glassDark: '#3a5364',
    frame: '#8d9499', lit: '#ffe2a8', litRatio: 0.33, kind: 'ribbon',
  },
  publicHousing: {
    cols: 4, rows: 4, tileW: 2.4, tileH: 2.2,
    bg: '#d9c9a8', bgDark: '#b3a688', glass: '#4f6a78', glassDark: '#34454f',
    frame: '#efe6d2', lit: '#ffd98c', litRatio: 0.38, kind: 'small',
  },
  hos: {
    cols: 4, rows: 4, tileW: 2.4, tileH: 2.2,
    bg: '#e4d6c0', bgDark: '#bdaf9a', glass: '#54707e', glassDark: '#384a55',
    frame: '#f4ecdd', lit: '#ffe0a0', litRatio: 0.42, kind: 'small',
  },
  brick: {
    cols: 4, rows: 4, tileW: 2.4, tileH: 2.2,
    bg: '#a8685a', bgDark: '#875248', glass: '#3f5f6e', glassDark: '#2b414c',
    frame: '#d9c9b0', lit: '#ffcf85', litRatio: 0.45, kind: 'small',
  },
  shop: {
    cols: 2, rows: 1, tileW: 2.0, tileH: 1.0,
    bg: '#252b31', bgDark: '#1a2026', glass: '#3f6f8f', glassDark: '#28485c',
    frame: '#c8d0d4', lit: '#ffe8b8', litRatio: 0.92, kind: 'shop',
  },
  mall: {
    cols: 3, rows: 3, tileW: 2.4, tileH: 1.8,
    bg: '#2f3540', bgDark: '#20252d', glass: '#5f8fa8', glassDark: '#38586b',
    frame: '#c0c8d0', lit: '#ffe6b8', litRatio: 0.68, kind: 'curtain',
  },
  warehouse: {
    cols: 2, rows: 2, tileW: 1.6, tileH: 1.6,
    bg: '#9aa0a6', bgDark: '#71777c', glass: '#4f6572', glassDark: '#35464f',
    frame: '#b8c0c6', lit: '#ffd890', litRatio: 0.25, kind: 'metal',
  },
  hospital: {
    cols: 4, rows: 4, tileW: 2.4, tileH: 2.2,
    bg: '#e8eef2', bgDark: '#bcc7ce', glass: '#6f8fa0', glassDark: '#4a6472',
    frame: '#f8fbfd', lit: '#fff4cc', litRatio: 0.5, kind: 'ribbon',
  },
  school: {
    cols: 4, rows: 4, tileW: 2.4, tileH: 2.2,
    bg: '#cfe0c8', bgDark: '#a6b9a0', glass: '#5d7f8a', glassDark: '#3c5560',
    frame: '#f0f4ec', lit: '#ffe6a8', litRatio: 0.4, kind: 'small',
  },
  tile: {
    cols: 4, rows: 4, tileW: 2.4, tileH: 2.2,
    bg: '#e2e0d8', bgDark: '#b8b6ae', glass: '#5f7a88', glassDark: '#3d5059',
    frame: '#f2f0ea', lit: '#ffe9b8', litRatio: 0.36, kind: 'small',
  },
};

const CN_FONT = '"Noto Serif TC", "Songti TC", "Source Han Serif TC", "STSong", "SimSun", serif';
const HK_FONT =
  '"Noto Sans TC", "PingFang HK", "Microsoft JhengHei", "Heiti TC", "Source Han Sans TC", sans-serif';

function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/** 簡單 hex 亮度調整（用於貼圖漸層）。 */
function shadeHex(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 255) * (1 + amount));
  const g = clamp(((n >> 8) & 255) * (1 + amount));
  const b = clamp((n & 255) * (1 + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** 置中繪製中文字（手動字距）。 */
function drawCenteredChars(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  fontSize: number,
  color: string,
  spacing: number,
  font = CN_FONT,
): void {
  ctx.font = `700 ${fontSize}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let x = cx - total / 2;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], x, cy);
    x += widths[i] + spacing;
  }
}

/** 豎排文字（從上而下）。 */
function drawVerticalChars(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  fontSize: number,
  color: string,
  spacing: number,
  font = CN_FONT,
): void {
  ctx.font = `700 ${fontSize}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const chars = [...text];
  const total = chars.length * fontSize + spacing * (chars.length - 1);
  let y = cy - total / 2 + fontSize / 2;
  for (const ch of chars) {
    ctx.fillText(ch, cx, y);
    y += fontSize + spacing;
  }
}

/** 穩定偽隨機（0..1），供貼圖亮窗分佈使用。 */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class MaterialLibrary {
  private materials = new Map<string, THREE.Material>();
  private textures: THREE.Texture[] = [];
  private facadeMaps = new Map<FacadeStyle, { day: THREE.Texture; night: THREE.Texture }>();
  private night = false;

  // ───────────────────────── 基本材質 ─────────────────────────

  /** 受光材質（牆、木、石、金屬…）。 */
  lambert(color: number, params: LambertParams = {}): THREE.MeshLambertMaterial {
    const key = `L|${color}|${params.emissive ?? ''}|${params.emissiveIntensity ?? ''}|${params.side ?? ''}|${
      params.transparent ? 1 : 0
    }|${params.opacity ?? ''}|${params.map ? params.map.uuid : ''}|${params.depthWrite === false ? 0 : 1}`;
    const found = this.materials.get(key);
    if (found) return found as THREE.MeshLambertMaterial;
    const mat = new THREE.MeshLambertMaterial({
      color,
      emissive: params.emissive ?? 0x000000,
      emissiveIntensity: params.emissiveIntensity ?? 1,
      side: params.side ?? THREE.FrontSide,
      transparent: params.transparent ?? false,
      opacity: params.opacity ?? 1,
      depthWrite: params.depthWrite ?? true,
    });
    if (params.map) mat.map = params.map;
    mat.name = key;
    this.materials.set(key, mat);
    return mat;
  }

  /** 自發光／貼圖材質（燈芯、招牌底板、LED）。 */
  basic(color: number, params: BasicParams = {}): THREE.MeshBasicMaterial {
    const key = `B|${color}|${params.side ?? ''}|${params.transparent ? 1 : 0}|${params.opacity ?? ''}|${
      params.depthWrite === false ? 0 : 1
    }|${params.toneMapped === false ? 0 : 1}|${params.blending ?? ''}|${params.map ? params.map.uuid : ''}`;
    const found = this.materials.get(key);
    if (found) return found as THREE.MeshBasicMaterial;
    const mat = new THREE.MeshBasicMaterial({
      color,
      side: params.side ?? THREE.FrontSide,
      transparent: params.transparent ?? false,
      opacity: params.opacity ?? 1,
      depthWrite: params.depthWrite ?? true,
      toneMapped: params.toneMapped ?? true,
      blending: params.blending ?? THREE.NormalBlending,
    });
    if (params.map) mat.map = params.map;
    mat.name = key;
    this.materials.set(key, mat);
    return mat;
  }

  /** 建築物的燈籠紅（自帶微弱自發光，夜間仍可見）。 */
  lantern(): THREE.MeshLambertMaterial {
    return this.lambert(PAL.lantern, { emissive: PAL.lanternGlow, emissiveIntensity: 0.55 });
  }

  // ───────────────────────── 文字招牌（舊 API 保留） ─────────────────────────

  /** 匾額：木底金字（橫排）。 */
  plaque(text: string, bg = '#231c15', fg = '#e9c874', border = '#a07c38'): THREE.Material {
    return this.textMaterial(text, {
      w: 320,
      h: 112,
      bg,
      fg,
      border,
      vertical: false,
      fontScale: 0.56,
      borderWidth: 7,
    });
  }

  /** 直幡／酒旗：布底大字（豎排）。 */
  banner(text: string, bg: number = PAL.clothRed, fg = '#f5ead2', border = '#e3c377'): THREE.Material {
    return this.textMaterial(text, {
      w: 128,
      h: 320,
      bg: cssColor(bg),
      fg,
      border,
      vertical: true,
      fontScale: 0.56,
      borderWidth: 5,
      tassel: true,
      doubleSide: true,
    });
  }

  /** 室內卷軸（書法、對聯）。 */
  scroll(text: string, bg = '#e7dcc4', fg = '#2c2419'): THREE.Material {
    return this.textMaterial(text, {
      w: 128,
      h: 340,
      bg,
      fg,
      border: '#8a6a3a',
      vertical: true,
      fontScale: 0.5,
      borderWidth: 4,
    });
  }

  /** 自由文字貼圖材質（快取；保留舊 API 供室內使用）。 */
  textMaterial(text: string, opts: TextOptions = {}): THREE.Material {
    const w = opts.w ?? 256;
    const h = opts.h ?? 128;
    const bg = opts.bg ?? '#231c15';
    const fg = opts.fg ?? '#e9c874';
    const border = opts.border ?? '#a07c38';
    const vertical = opts.vertical ?? false;
    const fontScale = opts.fontScale ?? 0.58;
    const borderWidth = opts.borderWidth ?? 6;
    const tassel = opts.tassel ?? false;
    const doubleSide = opts.doubleSide ?? false;
    const key = `T|${text}|${w}x${h}|${bg}|${fg}|${border}|${vertical ? 1 : 0}|${fontScale}|${borderWidth}|${tassel ? 1 : 0}|${doubleSide ? 1 : 0}`;
    const found = this.materials.get(key);
    if (found) return found;

    if (!HAS_DOM) {
      const fallback = this.basic(0x231c15);
      this.materials.set(key, fallback);
      return fallback;
    }

    const tex = this.canvasTexture(w, h, (ctx) => {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, bg);
      grad.addColorStop(1, shadeHex(bg, -0.12));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = border;
      ctx.lineWidth = borderWidth;
      ctx.strokeRect(borderWidth / 2, borderWidth / 2, w - borderWidth, h - borderWidth);
      ctx.strokeStyle = fg;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = Math.max(1, borderWidth * 0.35);
      ctx.strokeRect(borderWidth * 1.8, borderWidth * 1.8, w - borderWidth * 3.6, h - borderWidth * 3.6);
      ctx.globalAlpha = 1;

      const fontSize = Math.min(vertical ? w : h, vertical ? h : w) * fontScale;
      if (vertical) {
        drawVerticalChars(ctx, text, w / 2, h / 2, fontSize, fg, Math.max(2, fontSize * 0.08));
      } else {
        drawCenteredChars(ctx, text, w / 2, h / 2 + fontSize * 0.04, fontSize, fg, Math.max(2, fontSize * 0.1));
      }

      if (tassel) {
        ctx.fillStyle = border;
        ctx.fillRect(0, h - h * 0.045, w, h * 0.045);
        ctx.fillStyle = fg;
        ctx.globalAlpha = 0.65;
        for (let x = w * 0.08; x < w * 0.95; x += w * 0.11) {
          ctx.fillRect(x, h - h * 0.045, w * 0.035, h * 0.045);
        }
        ctx.globalAlpha = 1;
      }
    });
    if (!tex) {
      const fallback = this.basic(0x231c15);
      this.materials.set(key, fallback);
      return fallback;
    }
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      toneMapped: false,
      side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    });
    mat.name = key;
    this.materials.set(key, mat);
    return mat;
  }

  // ───────────────────────── 霓虹招牌（香港重點） ─────────────────────────

  /**
   * 霓虹招牌：黑底＋發光中文字（直式／橫式），雙面可選。
   * 日間由 setNightMode 壓暗材質顏色（霓虹未開），夜間全亮；
   * 同一文字／顏色只建立一次貼圖，所有招牌共用。
   */
  neonSign(text: string, opts: NeonSignOptions = {}): THREE.MeshBasicMaterial {
    const vertical = opts.vertical ?? true;
    const color = opts.color ?? PAL.neonPink;
    const board = opts.board ?? (vertical ? '#150f18' : '#1a1218');
    const fontScale = opts.fontScale ?? 0.62;
    const doubleSide = opts.doubleSide ?? true;
    const border = opts.border ?? true;
    const w = opts.w ?? (vertical ? 128 : 384);
    const h = opts.h ?? (vertical ? 352 : 112);
    const key = `S|${text}|${w}x${h}|${color}|${vertical ? 1 : 0}|${board}|${fontScale}|${doubleSide ? 1 : 0}|${border ? 1 : 0}`;
    const found = this.materials.get(key);
    if (found) return found as THREE.MeshBasicMaterial;

    if (!HAS_DOM) {
      const fallback = this.basic(0x2a1a24);
      this.materials.set(key, fallback);
      return fallback;
    }

    const tube = cssColor(color);
    const tubeBright = shadeHex(tube, 0.45);
    const ink = shadeHex(tube, 0.62);
    const tex = this.canvasTexture(w, h, (ctx) => {
      // 底板：深色亞克力＋少許反光
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, board);
      grad.addColorStop(1, shadeHex(board, 0.18));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // 光管邊框
      if (border) {
        ctx.strokeStyle = tube;
        ctx.lineWidth = Math.max(3, w * 0.035);
        ctx.shadowColor = tube;
        ctx.shadowBlur = Math.max(8, w * 0.06);
        ctx.strokeRect(w * 0.045, h * 0.035, w * 0.91, h * 0.93);
        ctx.shadowBlur = 0;
        ctx.strokeStyle = tubeBright;
        ctx.lineWidth = Math.max(1, w * 0.012);
        ctx.strokeRect(w * 0.045, h * 0.035, w * 0.91, h * 0.93);
      }

      // 發光文字（先畫粗光暈，再畫亮芯）
      const fontSize = Math.min(vertical ? w : h, vertical ? h : w) * fontScale;
      ctx.shadowColor = tube;
      ctx.shadowBlur = fontSize * 0.55;
      if (vertical) {
        drawVerticalChars(ctx, text, w / 2, h / 2, fontSize, tube, fontSize * 0.12, HK_FONT);
        ctx.shadowBlur = fontSize * 0.18;
        drawVerticalChars(ctx, text, w / 2, h / 2, fontSize, ink, fontSize * 0.12, HK_FONT);
      } else {
        drawCenteredChars(ctx, text, w / 2, h / 2, fontSize, tube, fontSize * 0.12, HK_FONT);
        ctx.shadowBlur = fontSize * 0.18;
        drawCenteredChars(ctx, text, w / 2, h / 2, fontSize, ink, fontSize * 0.12, HK_FONT);
      }
      ctx.shadowBlur = 0;

      // 直式招牌頂部小圓裝飾（燈泡）
      if (vertical) {
        ctx.fillStyle = tubeBright;
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.arc(w * (0.3 + i * 0.2), h * 0.88, Math.max(2, w * 0.03), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
    if (!tex) {
      const fallback = this.basic(0x2a1a24);
      this.materials.set(key, fallback);
      return fallback;
    }
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, side: doubleSide ? THREE.DoubleSide : THREE.FrontSide });
    mat.name = key;
    mat.color.setHex(this.night ? 0xffffff : 0x6e6e6e);
    mat.userData.hkSign = true;
    this.materials.set(key, mat);
    return mat;
  }

  /** 平台標籤（港鐵站名、出口牌、路牌、巴士路線牌）：白底／藍底黑字，日間清晰可見。 */
  label(text: string, opts: LabelOptions = {}): THREE.MeshBasicMaterial {
    const w = opts.w ?? 256;
    const h = opts.h ?? 96;
    const bg = opts.bg ?? '#e8ece8';
    const fg = opts.fg ?? '#1b2b33';
    const border = opts.border ?? '#7a8288';
    const vertical = opts.vertical ?? false;
    const fontScale = opts.fontScale ?? 0.56;
    const bold = opts.bold ?? true;
    const sub = opts.sub ?? '';
    const key = `Y|${text}|${w}x${h}|${bg}|${fg}|${border}|${vertical ? 1 : 0}|${fontScale}|${bold ? 1 : 0}|${sub}`;
    const found = this.materials.get(key);
    if (found) return found as THREE.MeshBasicMaterial;
    if (!HAS_DOM) {
      const fallback = this.basic(0xe8ece8);
      this.materials.set(key, fallback);
      return fallback;
    }
    const tex = this.canvasTexture(w, h, (ctx) => {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
      if (border !== 'none') {
        ctx.strokeStyle = border;
        ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.035);
        ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
      }
      const fontSize = Math.min(vertical ? w : h, vertical ? h : w) * fontScale;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = fg;
      if (vertical) {
        drawVerticalChars(ctx, text, w / 2, sub ? h * 0.44 : h / 2, fontSize, fg, fontSize * 0.1, HK_FONT);
        if (sub) {
          ctx.font = `600 ${Math.max(7, fontSize * 0.32)}px ${HK_FONT}`;
          ctx.fillText(sub, w / 2, h * 0.9);
        }
      } else {
        ctx.font = `${bold ? 800 : 600} ${fontSize}px ${HK_FONT}`;
        ctx.fillText(text, w / 2, sub ? h * 0.44 : h / 2);
        if (sub) {
          ctx.font = `600 ${Math.max(7, fontSize * 0.36)}px ${HK_FONT}`;
          ctx.fillStyle = fg;
          ctx.globalAlpha = 0.82;
          ctx.fillText(sub, w / 2, h * 0.82);
          ctx.globalAlpha = 1;
        }
      }
    });
    if (!tex) {
      const fallback = this.basic(0xe8ece8);
      this.materials.set(key, fallback);
      return fallback;
    }
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, side: THREE.DoubleSide });
    mat.name = key;
    mat.color.setHex(this.night ? 0xd8d8d8 : 0xffffff);
    this.materials.set(key, mat);
    return mat;
  }

  /**
   * 自訂圖示貼圖（港鐵標誌、紅十字、天星小輪鐘面、LED 屏幕…）。
   * 同一 name 只建立一次；draw 只在首次呼叫時執行。
   */
  symbol(name: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.MeshBasicMaterial {
    const key = `Z|${name}`;
    const found = this.materials.get(key);
    if (found) return found as THREE.MeshBasicMaterial;
    if (!HAS_DOM) {
      const fallback = this.basic(0xb02a2a);
      this.materials.set(key, fallback);
      return fallback;
    }
    const tex = this.canvasTexture(w, h, draw);
    if (!tex) {
      const fallback = this.basic(0xb02a2a);
      this.materials.set(key, fallback);
      return fallback;
    }
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, side: THREE.DoubleSide, transparent: false });
    mat.name = key;
    this.materials.set(key, mat);
    return mat;
  }

  // ───────────────────────── 玻璃幕牆／外牆貼圖 ─────────────────────────

  /**
   * 取得（必要時建立）某款外牆貼圖材質。日／夜各有貼圖，夜間由 setNightMode 換 map。
   * 使用方式：把平面 UV 依 FACADE_TILES[style] 乘上 repeat；見 hk-parts.addFacade()。
   */
  facade(style: FacadeStyle): THREE.MeshLambertMaterial {
    const key = `F|${style}`;
    const found = this.materials.get(key);
    if (found) return found as THREE.MeshLambertMaterial;
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.FrontSide });
    mat.name = key;
    this.materials.set(key, mat);
    if (!HAS_DOM) return mat;
    const def = FACADE_DEFS[style];
    const day = this.canvasTexture(256, 256, (ctx) => drawFacade(ctx, def, false));
    const night = this.canvasTexture(256, 256, (ctx) => drawFacade(ctx, def, true));
    if (day && night) {
      for (const tex of [day, night]) {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.needsUpdate = true;
      }
      this.facadeMaps.set(style, { day, night });
      mat.map = this.night ? night : day;
      mat.needsUpdate = true;
    }
    return mat;
  }

  // ───────────────────────── 建立／登記貼圖 ─────────────────────────

  /** 建立並登記一張 CanvasTexture（供室內地板、牆面、窗景使用）。 */
  canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture | null {
    if (!HAS_DOM) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    draw(ctx);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    this.textures.push(tex);
    return tex;
  }

  private ownedTexture(tex: THREE.Texture): THREE.Texture {
    this.textures.push(tex);
    return tex;
  }

  registerTexture(tex: THREE.Texture): THREE.Texture {
    return this.ownedTexture(tex);
  }

  /** 接管一個自建材質（例如貼圖地板），由本庫統一 dispose。 */
  own<T extends THREE.Material>(mat: T): T {
    this.materials.set(`own|${mat.uuid}`, mat);
    return mat;
  }

  // ───────────────────────── 合併用（vertex color）共用材質 ─────────────────────────
  // 建築原型把所有靜態同類材質合併成 1~3 個 mesh 後，用這些材質上色，
  // 色彩由頂點色烘入，故整棟建築只需數個 draw call。

  /** 受光頂點色材質（牆、木、石、金屬…）。 */
  vertexLit(side: THREE.Side = THREE.FrontSide): THREE.MeshLambertMaterial {
    return this.vertexMaterial('lit', side, 0x000000, 0);
  }

  /** 帶暖色自發光的頂點色材質（亮窗、室內透光、招牌底光）。 */
  vertexWarm(side: THREE.Side = THREE.FrontSide): THREE.MeshLambertMaterial {
    return this.vertexMaterial('warm', side, this.night ? 0xffc978 : 0x3a2a18, this.night ? 1.0 : 0.35);
  }

  /** 不受光頂點色材質（火焰、燈芯、LED）。 */
  vertexBasic(side: THREE.Side = THREE.FrontSide): THREE.MeshBasicMaterial {
    const key = `V|basic|${side}`;
    const found = this.materials.get(key);
    if (found) return found as THREE.MeshBasicMaterial;
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side, toneMapped: false });
    mat.name = key;
    this.materials.set(key, mat);
    return mat;
  }

  /**
   * 霓虹光管專用頂點色材質：夜間全亮（toneMapped:false），日間壓暗。
   * 由 hk-parts.neonTube() 建立的材質會標記 userData.hkNeon=true，
   * geometry-utils.mergeStaticMeshes 會把這類面合併到本材質。
   */
  vertexNeon(side: THREE.Side = THREE.FrontSide): THREE.MeshBasicMaterial {
    const key = `V|neon|${side}`;
    const found = this.materials.get(key);
    if (found) return found as THREE.MeshBasicMaterial;
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side, toneMapped: false, fog: false });
    mat.color.setHex(this.night ? 0xffffff : 0x5a5a5a);
    mat.name = key;
    this.materials.set(key, mat);
    return mat;
  }

  /** 霓虹光管原色材質（合併前暫時使用；合併時會轉成 vertexNeon）。 */
  neonTube(color: number): THREE.MeshBasicMaterial {
    const key = `N|${color}`;
    const found = this.materials.get(key);
    if (found) return found as THREE.MeshBasicMaterial;
    const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false, fog: false });
    mat.name = key;
    mat.userData.hkNeon = true;
    this.materials.set(key, mat);
    return mat;
  }

  /** 動畫部件用頂點色材質（霓虹招牌：帶光；其他：普通受光）。 */
  vertexAnim(side: THREE.Side, glow: boolean): THREE.MeshLambertMaterial {
    return glow
      ? this.vertexMaterial('animGlow', side, this.night ? 0xffb060 : 0x6a3a10, this.night ? 1.25 : 0.5)
      : this.vertexMaterial('lit', side, 0x000000, 0);
  }

  private vertexMaterial(
    kind: string,
    side: THREE.Side,
    emissive: number,
    emissiveIntensity: number,
  ): THREE.MeshLambertMaterial {
    const key = `V|${kind}|${side}`;
    const found = this.materials.get(key);
    if (found) return found as THREE.MeshLambertMaterial;
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side,
      emissive,
      emissiveIntensity,
    });
    mat.name = key;
    this.materials.set(key, mat);
    return mat;
  }

  /**
   * 夜間模式：
   *  - 亮窗（V|warm）轉暖黃透光；霓虹光管（V|neon）全亮；
   *  - 玻璃幕牆換上「夜燈版」貼圖（F|*）；
   *  - 霓虹招牌（S|*）由灰暗變全亮；
   * 只在日／夜切換時呼叫（每幀零成本）；材質為所有建築共用。
   */
  setNightMode(night: boolean): void {
    if (night === this.night) return;
    this.night = night;
    for (const [key, mat] of this.materials) {
      if (key.startsWith('V|warm|')) {
        const m = mat as THREE.MeshLambertMaterial;
        m.emissive.setHex(night ? 0xffc978 : 0x3a2a18);
        m.emissiveIntensity = night ? 1.0 : 0.35;
      } else if (key.startsWith('V|animGlow|')) {
        const m = mat as THREE.MeshLambertMaterial;
        m.emissive.setHex(night ? 0xffb060 : 0x6a3a10);
        m.emissiveIntensity = night ? 1.25 : 0.5;
      } else if (key.startsWith('V|neon|')) {
        (mat as THREE.MeshBasicMaterial).color.setHex(night ? 0xffffff : 0x5a5a5a);
      } else if (key.startsWith('S|')) {
        (mat as THREE.MeshBasicMaterial).color.setHex(night ? 0xffffff : 0x6e6e6e);
      } else if (key.startsWith('Y|')) {
        (mat as THREE.MeshBasicMaterial).color.setHex(night ? 0xd8d8d8 : 0xffffff);
      }
    }
    for (const [style, maps] of this.facadeMaps) {
      const mat = this.materials.get(`F|${style}`) as THREE.MeshLambertMaterial | undefined;
      if (mat) mat.map = night ? maps.night : maps.day;
    }
  }

  dispose(): void {
    for (const mat of this.materials.values()) mat.dispose();
    this.materials.clear();
    this.facadeMaps.clear();
    for (const tex of this.textures) tex.dispose();
    this.textures.length = 0;
  }
}

// ─────────────────────────── 外牆貼圖繪製 ───────────────────────────

/** 繪製一款玻璃幕牆／外牆貼圖（256×256，cols×rows 個窗格）。 */
function drawFacade(ctx: CanvasRenderingContext2D, def: FacadeDef, night: boolean): void {
  const W = 256;
  const H = 256;
  const bg = night ? def.bgDark : def.bg;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  // 牆面微漸層（上淺下深，模擬陽光／污漬）
  const wallGrad = ctx.createLinearGradient(0, 0, 0, H);
  wallGrad.addColorStop(0, shadeHex(bg, 0.06));
  wallGrad.addColorStop(1, shadeHex(bg, -0.08));
  ctx.fillStyle = wallGrad;
  ctx.fillRect(0, 0, W, H);

  const cw = W / def.cols;
  const ch = H / def.rows;

  if (def.kind === 'metal') {
    // 坑板鐵皮：豎向坑紋
    for (let x = 0; x < W; x += 6) {
      ctx.fillStyle = shadeHex(bg, x % 12 === 0 ? 0.07 : -0.05);
      ctx.fillRect(x, 0, 3, H);
    }
  }

  const seed = def.litRatio * 1000;
  for (let row = 0; row < def.rows; row++) {
    for (let col = 0; col < def.cols; col++) {
      const padX = cw * (def.kind === 'ribbon' ? 0.03 : 0.16);
      const padY = ch * (def.kind === 'ribbon' ? 0.26 : 0.2);
      const x = col * cw + padX;
      const y = row * ch + padY;
      const w = cw - padX * 2;
      const h = ch - padY * 2;
      const h01 = hash01(seed + row * 13.37 + col * 7.77);
      const lit = night && h01 < def.litRatio;

      if (lit) {
        // 亮窗：暖黃／冷白，帶光暈
        ctx.shadowColor = def.lit;
        ctx.shadowBlur = 7;
        ctx.fillStyle = def.lit;
        ctx.globalAlpha = 0.72 + h01 * 0.28;
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
        // 窗簾／人影
        ctx.fillStyle = shadeHex(def.lit, -0.32);
        ctx.globalAlpha = 0.35;
        ctx.fillRect(x, y, w, h * 0.28);
        ctx.globalAlpha = 1;
      } else {
        // 玻璃：日夜不同反光
        const gg = ctx.createLinearGradient(x, y, x + w, y + h);
        gg.addColorStop(0, night ? def.glassDark : def.glass);
        gg.addColorStop(0.55, shadeHex(night ? def.glassDark : def.glass, night ? 0.0 : 0.14));
        gg.addColorStop(1, shadeHex(night ? def.glassDark : def.glass, -0.2));
        ctx.fillStyle = gg;
        ctx.fillRect(x, y, w, h);
        if (!night) {
          // 日間玻璃斜向反光
          ctx.fillStyle = 'rgba(255,255,255,0.12)';
          ctx.beginPath();
          ctx.moveTo(x, y + h);
          ctx.lineTo(x + w * 0.45, y);
          ctx.lineTo(x + w * 0.68, y);
          ctx.lineTo(x + w * 0.2, y + h);
          ctx.closePath();
          ctx.fill();
        } else {
          // 夜間暗窗內隱約電視藍光
          if (h01 > 0.86) {
            ctx.fillStyle = 'rgba(110,170,220,0.35)';
            ctx.fillRect(x + w * 0.1, y + h * 0.1, w * 0.8, h * 0.8);
          }
        }
      }

      // 窗框
      ctx.strokeStyle = def.frame;
      ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.07);
      ctx.strokeRect(x, y, w, h);
      // 中間豎框／橫框
      ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.045);
      if (def.kind === 'curtain') {
        ctx.beginPath();
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w / 2, y + h);
        ctx.stroke();
      }
      if (def.kind === 'ribbon') {
        ctx.beginPath();
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w / 2, y + h);
        ctx.stroke();
      }
    }
  }

  // 樓層線／簷線
  ctx.strokeStyle = shadeHex(bg, night ? 0.18 : -0.22);
  ctx.lineWidth = 2;
  for (let row = 1; row < def.rows; row++) {
    ctx.beginPath();
    ctx.moveTo(0, row * ch);
    ctx.lineTo(W, row * ch);
    ctx.stroke();
  }

  if (def.kind === 'shop') {
    // 地舖：暖光室內、貨架、玻璃門
    ctx.fillStyle = night ? 'rgba(255,225,160,0.28)' : 'rgba(255,225,160,0.14)';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = def.frame;
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);
    // 中間玻璃門
    ctx.beginPath();
    ctx.moveTo(W * 0.5, 0);
    ctx.lineTo(W * 0.5, H);
    ctx.stroke();
    // 貨架橫線
    ctx.strokeStyle = night ? 'rgba(255,240,200,0.45)' : 'rgba(70,90,110,0.55)';
    ctx.lineWidth = 3;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.moveTo(W * 0.04, H * (0.18 + i * 0.2));
      ctx.lineTo(W * 0.46, H * (0.18 + i * 0.2));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(W * 0.54, H * (0.18 + i * 0.2));
      ctx.lineTo(W * 0.96, H * (0.18 + i * 0.2));
      ctx.stroke();
    }
  }
}
