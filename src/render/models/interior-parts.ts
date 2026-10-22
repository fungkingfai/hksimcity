/**
 * 《維港之城》— 香港室內場景零件庫（interiors-dev）
 *
 * 提供 32 種可進入香港建築室內所需程序化零件：
 *   唐樓鐵閘／碌架床／板間房／電飯煲／吊扇、茶餐廳卡位／餐牌／奶茶、
 *   便利店雪櫃／貨架／收銀、街市紅膠燈罩／菜檔肉檔魚檔、超市貨架購物車、
 *   商場扶手電梯／店舖、酒樓圓桌／點心車／龍鳳牆、商廈辦公桌／海景窗、
 *   工廈機器／貨箱、農田菜籮／農具／溫室、進口商行貨辦架／報關文件、
 *   發電廠控制台／渦輪、水務濾水池、貨櫃碼頭貨櫃／龍門吊機、貨倉重型貨架、
 *   學校課室黑板、醫院病床／簾、警署報案室／拘留室、消防車／鋼梯／滑柱、
 *   公園長椅／榕樹／雀鳥、海濱欄杆／維港、港鐵閘機／月台牌／列車車廂、
 *   巴士總站雙層巴士、電車叮叮、天星小輪……
 *
 * 另含：材質／貼圖／幾何共用工具、日夜窗外景（維港／街景）、
 * 靜態幾何合併（全室靜態陳設壓到約 2~4 個 draw call）與微動畫標記。
 *
 * 效能策略：
 *  - 顏色材質、Canvas 貼圖以 key 全域快取（跨進出場重用，不逐次建立）。
 *  - 進場：建立零件 → finalizeInteriorScene() 合併靜態幾何 → 動畫節點保留。
 *  - 出場：interior.ts 只釋放「逐場建立」的幾何；快取材質／貼圖保留重用。
 */

import * as THREE from 'three';
import { HK_FOODS } from '../../core/config';

export const HAS_DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';
export type Mat = THREE.Material;

// ─────────────────────────── 香港室內色調 ───────────────────────────

export const IPAL = {
  // 牆身
  wallOld: 0xd6c9ae,
  wallOldDark: 0xb9ab8c,
  wallGreen: 0xa9bfa4,
  wallPink: 0xd8bcb2,
  wallBlue: 0xa9c0cf,
  wallCream: 0xe6ddc8,
  wallWhite: 0xecece6,
  wallHospital: 0xdfe9ec,
  wallPolice: 0xcdd8e4,
  wallTile: 0xd8e2e0,
  wallRed: 0xa8483b,
  // 天花
  ceilWhite: 0xeeeae0,
  ceilGrey: 0xc9ccc9,
  ceilConcrete: 0x9a9890,
  // 地板
  floorMosaic: 0xe4e2da,
  floorBlueTile: 0x9fb8c0,
  floorWood: 0x9a6b3f,
  floorWoodDark: 0x6f4a2a,
  floorVinyl: 0xb09a7a,
  floorChecker: 0x26282a,
  floorConcrete: 0x9a9890,
  floorMarble: 0xe8e3d6,
  floorPlatform: 0x8a8f96,
  floorGrass: 0x6f9455,
  floorAsphalt: 0x565a5e,
  floorBoardwalk: 0xb08c5e,
  // 結構
  concrete: 0x9d9a92,
  concreteDark: 0x75726b,
  concreteLight: 0xc2beb4,
  steel: 0x8a939c,
  steelDark: 0x596069,
  iron: 0x4b5158,
  ironDark: 0x33383e,
  white: 0xf2f0e8,
  offWhite: 0xe4e2da,
  black: 0x1d1f22,
  wood: 0x8a6038,
  woodDark: 0x5c3f24,
  woodLight: 0xa97f4c,
  // 香港色
  mtrRed: 0xb02a2a,
  tramGreen: 0x2f8f5f,
  busYellow: 0xd9b23f,
  busRed: 0xd93f3f,
  ferryGreen: 0x2f7f6a,
  taxiRed: 0xd93f3f,
  neonPink: 0xff3d7f,
  neonCyan: 0x24e0ff,
  neonGold: 0xffd166,
  neonPurple: 0xa45bff,
  neonGreen: 0x5cff9d,
  terracotta: 0xc96b4a,
  tileRed: 0x9a4a3a,
  mahjongGreen: 0x2f7a5a,
  bamboo: 0xc9b070,
  redLantern: 0xcf3f2f,
  redLamp: 0xff5a3c,
  plasticRed: 0xd94a3f,
  plasticYellow: 0xe0b33a,
  plasticBlue: 0x3f7fb0,
  plasticGreen: 0x3f9a6a,
  paper: 0xefe5cf,
  cardboard: 0xb08a55,
  cardboardDark: 0x8f6c3e,
  // 人物
  skin: 0xe8c39a,
  skinDark: 0xc99a72,
  hair: 0x1f1a16,
  hairGrey: 0x9a9a96,
  // 貨櫃
  containerRed: 0xb4443a,
  containerBlue: 0x2f5f8f,
  containerGreen: 0x2f7a5a,
  containerOrange: 0xc97a3a,
  // 自然
  grass: 0x6f9455,
  leaf: 0x4f7a44,
  leafLight: 0x6f9a52,
  trunk: 0x6f5136,
  water: 0x2f6f8f,
} as const;

export type FloorStyle =
  | 'mosaic'
  | 'tileBlue'
  | 'wood'
  | 'vinyl'
  | 'checker'
  | 'concrete'
  | 'marble'
  | 'platform'
  | 'grass'
  | 'asphalt'
  | 'boardwalk';

export type WallStyle =
  | 'old'
  | 'green'
  | 'pink'
  | 'blue'
  | 'cream'
  | 'white'
  | 'hospital'
  | 'police'
  | 'tile'
  | 'concrete'
  | 'metal'
  | 'red';

export type CeilingStyle = 'white' | 'grey' | 'concrete' | 'panel';

// ─────────────────────────── 顏色工具 ───────────────────────────

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

/** 顏色加深／提亮（0.2 ~ 1.8）。 */
export function shade(color: number, factor: number): number {
  const r = clamp255(((color >> 16) & 255) * factor);
  const g = clamp255(((color >> 8) & 255) * factor);
  const b = clamp255((color & 255) * factor);
  return (r << 16) | (g << 8) | b;
}

export const darkenColor = (color: number, factor = 0.8): number => shade(color, factor);

export function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

const FONT = '"PingFang HK", "Noto Sans TC", "Microsoft JhengHei", "Heiti TC", sans-serif';
const SERIF = '"Noto Serif TC", "Songti TC", "PingFang HK", serif';

// ─────────────────────────── 材質快取 ───────────────────────────

const lamCache = new Map<number, THREE.MeshLambertMaterial>();
const basicCache = new Map<number, THREE.MeshBasicMaterial>();
const transCache = new Map<string, THREE.MeshBasicMaterial>();
const texMatCache = new Map<string, THREE.MeshBasicMaterial>();
const texCache = new Map<string, THREE.Texture>();

/** 受光材質（牆、木、金屬、布料…）— 顏色相同者共用。 */
export function lam(color: number): THREE.MeshLambertMaterial {
  let mat = lamCache.get(color);
  if (!mat) {
    mat = new THREE.MeshLambertMaterial({ color });
    lamCache.set(color, mat);
  }
  return mat;
}

/** 自發光／霓虹材質（不受光）— 顏色相同者共用。 */
export function basic(color: number): THREE.MeshBasicMaterial {
  let mat = basicCache.get(color);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
    basicCache.set(color, mat);
  }
  return mat;
}

/** 半透明材質（玻璃、蒸氣、雨）。 */
export function glass(color = 0xbfe0ea, opacity = 0.24): THREE.MeshBasicMaterial {
  const key = `${color}|${opacity}`;
  let mat = transCache.get(key);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      toneMapped: false,
    });
    transCache.set(key, mat);
  }
  return mat;
}

/** 建立逐場專屬材質（dispose 時會被追蹤釋放）。 */
export function ownMat<T extends THREE.Material>(mat: T): T {
  mat.userData.owned = true;
  return mat;
}

// ─────────────────────────── Canvas 貼圖工具 ───────────────────────────

function canvasTexture(
  key: string,
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D, W: number, H: number) => void,
): THREE.Texture | null {
  const hit = texCache.get(key);
  if (hit) return hit;
  if (!HAS_DOM) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  texCache.set(key, tex);
  return tex;
}

interface TexOptions {
  repeat?: [number, number];
  transparent?: boolean;
  side?: THREE.Side;
  toneMapped?: boolean;
}

/** 以 Canvas 貼圖建立（並快取）MeshBasicMaterial。 */
export function textureMat(
  key: string,
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D, W: number, H: number) => void,
  opts: TexOptions = {},
): THREE.MeshBasicMaterial {
  const matKey = `m|${key}|${opts.repeat ? opts.repeat.join('x') : ''}|${opts.transparent ? 1 : 0}`;
  const hit = texMatCache.get(matKey);
  if (hit) return hit;
  const tex = canvasTexture(`t|${key}`, w, h, draw);
  if (tex && opts.repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(opts.repeat[0], opts.repeat[1]);
  }
  const mat = new THREE.MeshBasicMaterial({
    map: tex ?? undefined,
    color: tex ? 0xffffff : 0x8f96a0,
    side: opts.side ?? THREE.FrontSide,
    transparent: opts.transparent ?? false,
    toneMapped: opts.toneMapped ?? false,
  });
  texMatCache.set(matKey, mat);
  return mat;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function centeredText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  size: number,
  color: string,
  opts: { bold?: boolean; font?: string; spacing?: number } = {},
): void {
  const font = opts.font ?? FONT;
  ctx.font = `${opts.bold === false ? '500' : '700'} ${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const spacing = opts.spacing ?? 0;
  if (!spacing) {
    ctx.fillText(text, cx, cy);
    return;
  }
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((s, v) => s + v, 0) + spacing * (chars.length - 1);
  let x = cx - total / 2;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], x + widths[i] / 2, cy);
    x += widths[i] + spacing;
  }
}

/** 直排文字（霓虹招牌／月台牌用）。 */
function verticalText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  top: number,
  bottom: number,
  color: string,
  size: number,
  font = FONT,
): void {
  const chars = [...text];
  const step = (bottom - top) / chars.length;
  ctx.font = `700 ${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], cx, top + step * (i + 0.5));
  }
}

// ─────────────────────────── 地板／牆／天花貼圖 ───────────────────────────

/** 香港室內地板材質（馬賽克地磚、木地板、膠地板、黑白階磚、雲石…）。 */
export function floorMat(style: FloorStyle): THREE.Material {
  switch (style) {
    case 'mosaic':
      return textureMat(
        'floor-mosaic',
        256,
        256,
        (ctx) => {
          ctx.fillStyle = cssColor(IPAL.floorMosaic);
          ctx.fillRect(0, 0, 256, 256);
          const s = 32;
          for (let y = 0; y < 256; y += s) {
            for (let x = 0; x < 256; x += s) {
              const odd = ((x / s + y / s) | 0) % 2 === 0;
              ctx.fillStyle = odd ? 'rgba(150,175,185,0.22)' : 'rgba(255,255,255,0.16)';
              ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
              ctx.fillStyle = 'rgba(120,130,130,0.28)';
              ctx.fillRect(x, y, s, 1);
              ctx.fillRect(x, y, 1, s);
            }
          }
        },
        { repeat: [3, 2.4] },
      );
    case 'tileBlue':
      return textureMat(
        'floor-tileblue',
        256,
        256,
        (ctx) => {
          ctx.fillStyle = cssColor(IPAL.floorBlueTile);
          ctx.fillRect(0, 0, 256, 256);
          const s = 64;
          for (let y = 0; y < 256; y += s) {
            for (let x = 0; x < 256; x += s) {
              ctx.fillStyle = (x + y) % 128 === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(70,110,125,0.14)';
              ctx.fillRect(x + 2, y + 2, s - 4, s - 4);
              ctx.strokeStyle = 'rgba(60,80,90,0.35)';
              ctx.lineWidth = 2;
              ctx.strokeRect(x + 1, y + 1, s - 2, s - 2);
            }
          }
        },
        { repeat: [3, 2.4] },
      );
    case 'wood':
      return textureMat(
        'floor-wood',
        256,
        256,
        (ctx) => {
          ctx.fillStyle = cssColor(IPAL.floorWood);
          ctx.fillRect(0, 0, 256, 256);
          const rowH = 34;
          let seed = 7;
          const rand = (): number => {
            seed = (seed * 16807) % 2147483647;
            return seed / 2147483647;
          };
          for (let y = 0; y < 256; y += rowH) {
            const f = 0.82 + rand() * 0.3;
            ctx.fillStyle = `rgb(${clamp255(0x9a * f)},${clamp255(0x6b * f)},${clamp255(0x3f * f)})`;
            ctx.fillRect(0, y, 256, rowH - 1);
            ctx.strokeStyle = 'rgba(70,44,24,0.25)';
            ctx.lineWidth = 1;
            for (let i = 0; i < 4; i++) {
              const yy = y + 4 + rand() * (rowH - 8);
              ctx.beginPath();
              ctx.moveTo(0, yy);
              ctx.lineTo(256, yy + Math.sin(yy) * 2);
              ctx.stroke();
            }
            ctx.fillStyle = 'rgba(40,24,12,0.5)';
            ctx.fillRect(0, y + rowH - 1, 256, 1);
            const offset = (Math.floor(y / rowH) % 2) * 120;
            ctx.fillRect(offset, y, 1, rowH);
          }
        },
        { repeat: [3, 2.4] },
      );
    case 'vinyl':
      return textureMat(
        'floor-vinyl',
        256,
        256,
        (ctx) => {
          ctx.fillStyle = cssColor(IPAL.floorVinyl);
          ctx.fillRect(0, 0, 256, 256);
          for (let i = 0; i < 900; i++) {
            ctx.fillStyle = i % 3 ? 'rgba(90,70,45,0.08)' : 'rgba(255,240,215,0.08)';
            ctx.fillRect((i * 37) % 256, (i * 71) % 256, 2, 2);
          }
          ctx.strokeStyle = 'rgba(70,55,35,0.25)';
          ctx.lineWidth = 2;
          for (let x = 0; x < 256; x += 64) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, 256);
            ctx.stroke();
          }
          for (let y = 0; y < 256; y += 64) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(256, y);
            ctx.stroke();
          }
        },
        { repeat: [3, 2.4] },
      );
    case 'checker':
      return textureMat(
        'floor-checker',
        256,
        256,
        (ctx) => {
          ctx.fillStyle = '#ded9cb';
          ctx.fillRect(0, 0, 256, 256);
          const s = 32;
          for (let y = 0; y < 256; y += s) {
            for (let x = 0; x < 256; x += s) {
              if (((x / s) | 0) % 2 === ((y / s) | 0) % 2) {
                ctx.fillStyle = cssColor(IPAL.floorChecker);
                ctx.fillRect(x, y, s, s);
              }
            }
          }
        },
        { repeat: [3, 2.4] },
      );
    case 'concrete':
      return textureMat(
        'floor-concrete',
        256,
        256,
        (ctx) => {
          ctx.fillStyle = cssColor(IPAL.floorConcrete);
          ctx.fillRect(0, 0, 256, 256);
          let seed = 13;
          const rand = (): number => {
            seed = (seed * 48271) % 2147483647;
            return seed / 2147483647;
          };
          for (let i = 0; i < 380; i++) {
            const a = 0.02 + rand() * 0.06;
            ctx.fillStyle = rand() > 0.5 ? `rgba(60,58,54,${a})` : `rgba(220,218,210,${a})`;
            ctx.beginPath();
            ctx.arc(rand() * 256, rand() * 256, 1 + rand() * 6, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.strokeStyle = 'rgba(80,78,72,0.22)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(30, 0);
          ctx.lineTo(90, 256);
          ctx.moveTo(180, 0);
          ctx.lineTo(230, 256);
          ctx.stroke();
        },
        { repeat: [3, 2.4] },
      );
    case 'marble':
      return textureMat(
        'floor-marble',
        256,
        256,
        (ctx) => {
          ctx.fillStyle = cssColor(IPAL.floorMarble);
          ctx.fillRect(0, 0, 256, 256);
          ctx.strokeStyle = 'rgba(150,145,130,0.35)';
          for (let i = 0; i < 7; i++) {
            ctx.lineWidth = 0.6 + (i % 3) * 0.5;
            ctx.beginPath();
            let y = (i * 41) % 256;
            ctx.moveTo(0, y);
            for (let x = 0; x <= 256; x += 32) {
              y += Math.sin(i * 2.1 + x * 0.05) * 8;
              ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
          ctx.strokeStyle = 'rgba(120,115,100,0.4)';
          ctx.lineWidth = 2;
          for (let x = 0; x < 256; x += 128) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, 256);
            ctx.stroke();
          }
          for (let y = 0; y < 256; y += 128) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(256, y);
            ctx.stroke();
          }
        },
        { repeat: [3, 2.4] },
      );
    case 'platform':
      return textureMat(
        'floor-platform',
        256,
        256,
        (ctx) => {
          ctx.fillStyle = cssColor(IPAL.floorPlatform);
          ctx.fillRect(0, 0, 256, 256);
          const s = 32;
          for (let y = 0; y < 256; y += s) {
            for (let x = 0; x < 256; x += s) {
              ctx.fillStyle = `rgba(${120 + ((x * 7 + y * 13) % 40)},${120 + ((x * 11 + y * 5) % 40)},${125 + ((x * 3 + y * 9) % 40)},0.5)`;
              ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
            }
          }
        },
        { repeat: [4, 3] },
      );
    case 'grass':
      return textureMat(
        'floor-grass',
        128,
        128,
        (ctx) => {
          ctx.fillStyle = cssColor(IPAL.grass);
          ctx.fillRect(0, 0, 128, 128);
          for (let i = 0; i < 500; i++) {
            ctx.fillStyle = i % 3 ? 'rgba(90,130,60,0.4)' : 'rgba(150,180,90,0.35)';
            ctx.fillRect((i * 37) % 128, (i * 61) % 128, 2, 3);
          }
        },
        { repeat: [6, 5] },
      );
    case 'asphalt':
      return textureMat(
        'floor-asphalt',
        128,
        128,
        (ctx) => {
          ctx.fillStyle = cssColor(IPAL.floorAsphalt);
          ctx.fillRect(0, 0, 128, 128);
          for (let i = 0; i < 300; i++) {
            ctx.fillStyle = i % 2 ? 'rgba(30,32,35,0.45)' : 'rgba(160,165,170,0.18)';
            ctx.fillRect((i * 53) % 128, (i * 29) % 128, 2, 2);
          }
        },
        { repeat: [6, 5] },
      );
    case 'boardwalk':
    default:
      return textureMat(
        'floor-boardwalk',
        256,
        256,
        (ctx) => {
          ctx.fillStyle = cssColor(IPAL.floorBoardwalk);
          ctx.fillRect(0, 0, 256, 256);
          const rowH = 26;
          for (let y = 0; y < 256; y += rowH) {
            ctx.fillStyle = `rgba(${140 + ((y * 7) % 30)},${105 + ((y * 3) % 25)},70,0.55)`;
            ctx.fillRect(0, y, 256, rowH - 2);
            ctx.fillStyle = 'rgba(70,50,30,0.5)';
            ctx.fillRect(0, y + rowH - 2, 256, 2);
            const off = (Math.floor(y / rowH) % 2) * 90;
            ctx.fillRect(off, y, 2, rowH);
          }
        },
        { repeat: [3, 2.4] },
      );
  }
}

/** 香港室內牆身材質（唐樓米牆／公屋綠牆／醫院白牆／金屬倉庫牆…）。 */
export function wallMat(style: WallStyle): THREE.Material {
  const colors: Record<WallStyle, number> = {
    old: IPAL.wallOld,
    green: IPAL.wallGreen,
    pink: IPAL.wallPink,
    blue: IPAL.wallBlue,
    cream: IPAL.wallCream,
    white: IPAL.wallWhite,
    hospital: IPAL.wallHospital,
    police: IPAL.wallPolice,
    tile: IPAL.wallTile,
    concrete: IPAL.concrete,
    metal: IPAL.steel,
    red: IPAL.wallRed,
  };
  const base = colors[style];
  return textureMat(
    `wall-${style}`,
    128,
    128,
    (ctx) => {
      ctx.fillStyle = cssColor(base);
      ctx.fillRect(0, 0, 128, 128);
      let seed = style.length * 37 + 11;
      const rand = (): number => {
        seed = (seed * 48271) % 2147483647;
        return seed / 2147483647;
      };
      if (style === 'tile') {
        const s = 32;
        for (let y = 0; y < 128; y += s) {
          for (let x = 0; x < 128; x += s) {
            ctx.fillStyle = (x + y) % 64 === 0 ? 'rgba(255,255,255,0.25)' : 'rgba(140,165,170,0.14)';
            ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
            ctx.strokeStyle = 'rgba(100,125,130,0.35)';
            ctx.strokeRect(x, y, s, s);
          }
        }
      } else if (style === 'metal') {
        for (let y = 0; y < 128; y += 10) {
          ctx.fillStyle = y % 20 === 0 ? 'rgba(255,255,255,0.09)' : 'rgba(40,45,50,0.14)';
          ctx.fillRect(0, y, 128, 4);
        }
        ctx.fillStyle = 'rgba(30,34,38,0.35)';
        for (let x = 0; x < 128; x += 42) ctx.fillRect(x, 0, 2, 128);
      } else if (style === 'hospital' || style === 'police') {
        ctx.fillStyle = 'rgba(110,150,160,0.16)';
        ctx.fillRect(0, 92, 128, 36);
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.fillRect(0, 88, 128, 3);
      } else {
        for (let i = 0; i < 160; i++) {
          const a = 0.02 + rand() * 0.05;
          ctx.fillStyle = rand() > 0.5 ? `rgba(90,78,58,${a})` : `rgba(255,250,235,${a})`;
          ctx.beginPath();
          ctx.arc(rand() * 128, rand() * 128, 1 + rand() * 4, 0, Math.PI * 2);
          ctx.fill();
        }
        if (style === 'old' || style === 'green' || style === 'pink') {
          ctx.fillStyle = 'rgba(120,115,95,0.14)';
          ctx.fillRect(0, 112, 128, 16);
        }
      }
    },
    { repeat: [2, 1.5] },
  );
}

export function ceilingMat(style: CeilingStyle): THREE.Material {
  const colors: Record<CeilingStyle, number> = {
    white: IPAL.ceilWhite,
    grey: IPAL.ceilGrey,
    concrete: IPAL.ceilConcrete,
    panel: 0xdad6c8,
  };
  return textureMat(
    `ceil-${style}`,
    128,
    128,
    (ctx) => {
      ctx.fillStyle = cssColor(colors[style]);
      ctx.fillRect(0, 0, 128, 128);
      ctx.strokeStyle = 'rgba(120,118,110,0.3)';
      ctx.lineWidth = 2;
      for (let x = 0; x < 128; x += 42) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 128);
        ctx.stroke();
      }
      for (let y = 0; y < 128; y += 42) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(128, y);
        ctx.stroke();
      }
    },
    { repeat: [4, 3] },
  );
}

// ─────────────────────────── 招牌／文字貼圖 ───────────────────────────

/** 霓虹招牌（直排或橫排）— 暗底＋發光字＋燈管邊框。 */
export function neonSignMat(text: string, color: number, vertical = false): THREE.MeshBasicMaterial {
  const w = vertical ? 128 : 320;
  const h = vertical ? 320 : 112;
  const col = cssColor(color);
  return textureMat(
    `neon|${text}|${color}|${vertical ? 'v' : 'h'}`,
    w,
    h,
    (ctx, W, H) => {
      ctx.fillStyle = '#140d18';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(4, 4, W - 8, H - 8);
      ctx.strokeStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = 14;
      ctx.lineWidth = 3;
      roundRect(ctx, 8, 8, W - 16, H - 16, 6);
      ctx.stroke();
      const draw = (blur: number, fill: string): void => {
        ctx.shadowColor = col;
        ctx.shadowBlur = blur;
        if (vertical) {
          verticalText(ctx, text, W / 2, H * 0.13, H * 0.9, fill, Math.min(W * 0.6, (H * 0.78) / text.length));
        } else {
          centeredText(ctx, text, W / 2, H / 2, H * 0.56, fill, { spacing: 2 });
        }
      };
      draw(26, col);
      draw(10, '#ffffff');
      ctx.shadowBlur = 0;
    },
  );
}

/** 一般招牌／指示牌（實色底＋文字）。 */
export function signBoardMat(
  key: string,
  lines: string[],
  opts: {
    bg?: number;
    fg?: string;
    w?: number;
    h?: number;
    border?: string;
    font?: string;
    accent?: string;
  } = {},
): THREE.MeshBasicMaterial {
  const w = opts.w ?? 256;
  const h = opts.h ?? 128;
  const bg = cssColor(opts.bg ?? 0xf2efe6);
  return textureMat(
    `board|${key}|${lines.join('/')}|${opts.bg ?? ''}`,
    w,
    h,
    (ctx, W, H) => {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      if (opts.accent) {
        ctx.fillStyle = opts.accent;
        ctx.fillRect(0, 0, W, H * 0.14);
      }
      if (opts.border) {
        ctx.strokeStyle = opts.border;
        ctx.lineWidth = 4;
        ctx.strokeRect(3, 3, W - 6, H - 6);
      }
      const n = Math.max(1, lines.length);
      const rowH = H / n;
      const longest = Math.max(...lines.map((l) => [...l].length || 1));
      const size = Math.min(rowH * 0.62, (W / longest) * 1.7);
      lines.forEach((line, i) => {
        centeredText(ctx, line, W / 2, rowH * (i + 0.5), size, opts.fg ?? '#1f2937', {
          font: opts.font ?? FONT,
          spacing: 1,
        });
      });
    },
  );
}

/** 茶餐廳餐牌（白底紅字）。 */
export function menuMat(): THREE.MeshBasicMaterial {
  return textureMat('menu-cha-chaan-teng', 256, 384, (ctx, W, H) => {
    ctx.fillStyle = '#f7f2e4';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#b02a2a';
    ctx.fillRect(0, 0, W, 54);
    centeredText(ctx, '茶 餐 廳 餐 牌', W / 2, 27, 26, '#fff6e0', { spacing: 2 });
    const foods = HK_FOODS.slice(0, 9);
    foods.forEach((food, i) => {
      const y = 86 + i * 32;
      ctx.fillStyle = '#2b2620';
      ctx.font = `600 19px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(food, 18, y);
      ctx.strokeStyle = 'rgba(120,110,90,0.4)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(26 + ctx.measureText(food).width + 6, y - 6);
      ctx.lineTo(W - 54, y - 6);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#b02a2a';
      ctx.textAlign = 'right';
      ctx.fillText(`$${22 + ((i * 7) % 26)}`, W - 16, y);
    });
    ctx.fillStyle = 'rgba(176,42,42,0.85)';
    ctx.font = `600 15px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('凍飲 +$3 · 外賣 +$1', W / 2, H - 22);
  });
}

/** 學校黑板（粉筆字）。 */
export function blackboardMat(subject = '中文科'): THREE.MeshBasicMaterial {
  return textureMat(`blackboard|${subject}`, 384, 224, (ctx, W, H) => {
    ctx.fillStyle = '#1f3b30';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let i = 0; i < 26; i++) {
      ctx.beginPath();
      ctx.moveTo((i * 53) % W, (i * 31) % H);
      ctx.lineTo(((i * 53) % W) + 40, ((i * 31) % H) + 6);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.86)';
    ctx.font = `700 26px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(`${subject}`, 22, 42);
    ctx.font = `600 20px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.fillText('今日課題：《香港的維多利亞港》', 22, 82);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `500 17px ${FONT}`;
    ctx.fillText('1. 維港兩岸的地貌', 30, 120);
    ctx.fillText('2. 填海與城市發展', 30, 148);
    ctx.fillText('3. 天星小輪與過海交通', 30, 176);
    ctx.fillStyle = 'rgba(255,220,180,0.75)';
    ctx.font = `500 16px ${FONT}`;
    ctx.fillText('功課：P.42 第 1-4 題', 210, 200);
  });
}

/** 港鐵月台牌（往中環／Platform 1）。 */
export function platformSignMat(dest: string, platform: string, color = 0xb02a2a): THREE.MeshBasicMaterial {
  return textureMat(`platform|${dest}|${platform}|${color}`, 384, 96, (ctx, W, H) => {
    ctx.fillStyle = cssColor(color);
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, H - 10, W, 10);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 30px ${FONT}`;
    ctx.fillText(`往 ${dest}`, 42, 50);
    ctx.font = `600 17px ${FONT}`;
    ctx.fillText('To ' + dest, 46, 76);
    ctx.textAlign = 'right';
    ctx.font = `700 22px ${FONT}`;
    ctx.fillText(platform, W - 34, 56);
  });
}

/** 港鐵路線圖（簡化版：多色路線 + 站點）。 */
export function routeMapMat(): THREE.MeshBasicMaterial {
  return textureMat('mtr-route-map', 384, 256, (ctx, W, H) => {
    ctx.fillStyle = '#f4f1e8';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#b02a2a';
    ctx.fillRect(0, 0, W, 30);
    centeredText(ctx, '港 鐵 路 線 圖', W / 2, 15, 16, '#ffffff', { spacing: 3 });
    const lines: [string, string, [number, number][]][] = [
      ['荃灣綫', '#e2231a', [[30, 80], [110, 80], [200, 100], [300, 100], [356, 130]]],
      ['港島綫', '#0075c2', [[30, 150], [120, 150], [210, 130], [300, 160], [356, 160]]],
      ['觀塘綫', '#00a040', [[60, 210], [140, 190], [220, 190], [300, 210], [350, 210]]],
      ['東鐵綫', '#53b7e8', [[40, 50], [120, 50], [210, 70], [330, 60]]],
    ];
    for (const [name, color, pts] of lines) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();
      for (const [x, y] of pts) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.font = `600 10px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(name, 8, pts[0][1] - 8);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.font = `500 10px ${FONT}`;
    ctx.fillText('請小心月台空隙 Please mind the platform gap', 12, H - 10);
  });
}

/** 巴士路線牌（968 往銅鑼灣）。 */
export function busRouteMat(route: string, dest: string): THREE.MeshBasicMaterial {
  return textureMat(`bus-route|${route}|${dest}`, 256, 72, (ctx, W, H) => {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffd166';
    ctx.font = `700 34px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(route, 14, H / 2 + 12);
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 20px ${FONT}`;
    ctx.fillText(`往 ${dest}`, 100, H / 2 + 8);
    ctx.fillStyle = '#d93f3f';
    ctx.fillRect(0, H - 8, W, 8);
  });
}

/** 電視螢幕（新聞畫面，發光）。 */
export function tvScreenMat(): THREE.MeshBasicMaterial {
  return textureMat('tv-screen', 256, 160, (ctx, W, H) => {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#2a4f8f');
    grad.addColorStop(1, '#10203f');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    for (let i = 0; i < 5; i++) ctx.fillRect(0, 24 + i * 26, W, 2);
    ctx.fillStyle = '#e8b04a';
    ctx.fillRect(16, 16, 92, 22);
    ctx.fillStyle = '#10203f';
    ctx.font = `700 15px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText('新聞台', 26, 33);
    ctx.fillStyle = '#dce6f0';
    ctx.font = `500 13px ${FONT}`;
    ctx.fillText('維港兩岸今晚有煙花匯演', 18, 66);
    ctx.fillRect(18, 78, 210, 2);
    ctx.fillText('天文台：明日多雲有雨', 18, 102);
    ctx.fillStyle = '#f0d9a0';
    ctx.font = `500 12px ${FONT}`;
    ctx.fillText('行政長官出席施政報告記者會', 18, 128);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(0, H - 26, W, 26);
  });
}

/** 招租／地產海報。 */
export function posterMat(text: string, color = 0xd93f3f): THREE.MeshBasicMaterial {
  return textureMat(`poster|${text}|${color}`, 128, 180, (ctx, W, H) => {
    ctx.fillStyle = '#f2ead6';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = cssColor(color);
    ctx.fillRect(0, 0, W, 46);
    ctx.fillStyle = '#fff8e8';
    ctx.font = `700 20px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(text.slice(0, 4), W / 2, 31);
    ctx.fillStyle = '#33302a';
    ctx.font = `600 15px ${FONT}`;
    ['業主放盤', '租金面議', '電話 9123 4567'].forEach((line, i) => ctx.fillText(line, W / 2, 80 + i * 30));
    ctx.strokeStyle = 'rgba(0,0,0,0.16)';
    ctx.strokeRect(2, 2, W - 4, H - 4);
  });
}

/** 龍鳳牆（酒樓大禮堂）。 */
export function dragonPhoenixMat(): THREE.MeshBasicMaterial {
  return textureMat('dragon-phoenix', 320, 176, (ctx, W, H) => {
    ctx.fillStyle = '#8f1f18';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#c9a24c';
    ctx.fillRect(8, 8, W - 16, H - 16);
    ctx.fillStyle = '#8f1f18';
    ctx.fillRect(14, 14, W - 28, H - 28);
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(40, 120);
    ctx.bezierCurveTo(80, 40, 130, 150, 165, 70);
    ctx.bezierCurveTo(195, 30, 210, 90, 250, 60);
    ctx.stroke();
    ctx.strokeStyle = '#ff8f6b';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(280, 130);
    ctx.bezierCurveTo(250, 80, 230, 140, 200, 100);
    ctx.stroke();
    ctx.fillStyle = '#ffd166';
    for (const [x, y, r] of [
      [52, 54, 5],
      [165, 42, 5],
      [258, 48, 5],
      [292, 118, 4],
    ]) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    centeredText(ctx, '龍 鳳 呈 祥', W / 2, H / 2 + 6, 26, '#ffd166', { font: SERIF, spacing: 4 });
  });
}

/** 安全出口指示（綠光）。 */
export function exitSignMat(): THREE.MeshBasicMaterial {
  return textureMat('exit-sign', 128, 64, (ctx, W, H) => {
    ctx.fillStyle = '#0f7a3f';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#d8ffe8';
    ctx.font = `700 26px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('出口 EXIT', W / 2, H / 2 + 9);
  });
}

/** 天星小輪船身招牌。 */
export function starFerryMat(): THREE.MeshBasicMaterial {
  return textureMat('star-ferry', 320, 96, (ctx, W, H) => {
    ctx.fillStyle = '#f4f2e8';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#2f7f6a';
    ctx.fillRect(0, H * 0.46, W, H * 0.2);
    ctx.fillStyle = '#123c33';
    ctx.font = `700 30px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('天星小輪', W / 2, H * 0.34);
    ctx.fillStyle = '#f4f2e8';
    ctx.font = `600 14px ${FONT}`;
    ctx.fillText('STAR FERRY', W / 2, H * 0.62);
  });
}

/** 扶手電梯踏板貼圖（會滾動）。 */
export function escalatorMat(): THREE.MeshBasicMaterial {
  return textureMat(
    'escalator-steps',
    128,
    128,
    (ctx, W, H) => {
      ctx.fillStyle = '#8a8f96';
      ctx.fillRect(0, 0, W, H);
      for (let y = 0; y < H; y += 16) {
        ctx.fillStyle = y % 32 === 0 ? '#6f737a' : '#a3a8af';
        ctx.fillRect(0, y, W, 12);
        ctx.fillStyle = '#4f545a';
        ctx.fillRect(0, y + 12, W, 4);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(0, 0, W, 3);
    },
    { repeat: [1, 6] },
  );
}

/** 雨滴／水痕（貼窗用）。 */
export function rainMat(): THREE.MeshBasicMaterial {
  return textureMat(
    'rain-streaks',
    128,
    256,
    (ctx, W, H) => {
      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < 90; i++) {
        const x = (i * 41) % W;
        const y = (i * 97) % H;
        const len = 8 + ((i * 13) % 26);
        ctx.strokeStyle = `rgba(200,225,245,${0.12 + ((i * 7) % 20) / 100})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 2, y + len);
        ctx.stroke();
      }
    },
    { repeat: [2, 1], transparent: true },
  );
}

/** 蒸氣／炊煙（透明貼圖）。 */
export function steamMat(): THREE.MeshBasicMaterial {
  return textureMat(
    'steam',
    64,
    64,
    (ctx, W, H) => {
      ctx.clearRect(0, 0, W, H);
      const g = ctx.createRadialGradient(W / 2, H / 2, 2, W / 2, H / 2, W / 2);
      g.addColorStop(0, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    },
    { transparent: true },
  );
}

// ─────────────────────────── 窗外景色（日夜兩款） ───────────────────────────

export interface WindowViewRefs {
  day: THREE.MeshBasicMaterial;
  night: THREE.MeshBasicMaterial;
}

/** 港式街景（窗外鄰樓、招牌、冷氣機）。 */
export function cityViewMat(night: boolean): THREE.MeshBasicMaterial {
  return textureMat(`view-city-${night ? 'n' : 'd'}`, 256, 160, (ctx, W, H) => {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    if (night) {
      sky.addColorStop(0, '#101a30');
      sky.addColorStop(0.7, '#1d2a44');
      sky.addColorStop(1, '#2a3247');
    } else {
      sky.addColorStop(0, '#a8c7dd');
      sky.addColorStop(0.7, '#d6dfe0');
      sky.addColorStop(1, '#dfe0d4');
    }
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    let seed = night ? 29 : 17;
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    let x = 0;
    while (x < W) {
      const bw = 26 + rand() * 34;
      const bh = 40 + rand() * 90;
      ctx.fillStyle = night ? '#20293a' : `rgba(${140 + rand() * 40},${140 + rand() * 40},${135 + rand() * 35},1)`;
      ctx.fillRect(x, H - bh, bw, bh);
      for (let wy = H - bh + 8; wy < H - 10; wy += 12) {
        for (let wx = x + 5; wx < x + bw - 6; wx += 11) {
          if (night) {
            ctx.fillStyle = rand() > 0.42 ? `rgba(255,225,150,${0.55 + rand() * 0.4})` : 'rgba(60,80,110,0.6)';
          } else {
            ctx.fillStyle = rand() > 0.5 ? 'rgba(90,120,140,0.5)' : 'rgba(190,205,210,0.65)';
          }
          ctx.fillRect(wx, wy, 6, 6);
        }
      }
      if (rand() > 0.5) {
        ctx.fillStyle = night ? '#3a4252' : '#9a9d99';
        ctx.fillRect(x + 4, H - bh + 18 + rand() * 30, 12, 8);
      }
      x += bw + 2;
    }
    if (night) {
      for (let i = 0; i < 4; i++) {
        const nx = 20 + i * 62;
        const col = ['#ff3d7f', '#24e0ff', '#ffd166', '#5cff9d'][i % 4];
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.75;
        ctx.fillRect(nx, H - 46 - (i % 3) * 14, 8, 26);
        ctx.globalAlpha = 1;
        const glow = ctx.createRadialGradient(nx + 4, H - 34, 1, nx + 4, H - 34, 30);
        glow.addColorStop(0, col);
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = glow;
        ctx.fillRect(nx - 26, H - 64, 60, 60);
        ctx.globalAlpha = 1;
      }
    }
    ctx.fillStyle = night ? '#141a26' : '#8d8f88';
    ctx.fillRect(0, H - 16, W, 16);
  });
}

/** 維多利亞港景（窗外／海濱用）：天際線、山、渡輪、帆船。 */
export function harbourViewMat(night: boolean): THREE.MeshBasicMaterial {
  return textureMat(`view-harbour-${night ? 'n' : 'd'}`, 512, 256, (ctx, W, H) => {
    const horizon = H * 0.52;
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    if (night) {
      sky.addColorStop(0, '#0a1224');
      sky.addColorStop(0.6, '#16233d');
      sky.addColorStop(1, '#2c3550');
    } else {
      sky.addColorStop(0, '#8fb8d8');
      sky.addColorStop(0.55, '#c3d6e2');
      sky.addColorStop(1, '#e3ddd0');
    }
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, horizon + 2);
    if (night) {
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.2 + ((i * 13) % 40) / 100})`;
        ctx.fillRect((i * 73) % W, ((i * 37) % horizon) * 0.8, 1.5, 1.5);
      }
    }
    ctx.fillStyle = night ? '#0d1524' : 'rgba(110,130,130,0.75)';
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    ctx.lineTo(0, horizon - 38);
    ctx.lineTo(60, horizon - 64);
    ctx.lineTo(120, horizon - 46);
    ctx.lineTo(175, horizon - 78);
    ctx.lineTo(240, horizon - 50);
    ctx.lineTo(300, horizon - 40);
    ctx.lineTo(W, horizon - 30);
    ctx.lineTo(W, horizon + 4);
    ctx.lineTo(0, horizon + 4);
    ctx.closePath();
    ctx.fill();
    let seed = night ? 71 : 33;
    const rand = (): number => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const towers: [number, number, number][] = [];
    let x = 40;
    while (x < W - 30) {
      const bw = 16 + rand() * 26;
      const bh = 24 + rand() * 82;
      towers.push([x, bw, bh]);
      x += bw + 3;
    }
    for (const [tx, bw, bh] of towers) {
      ctx.fillStyle = night ? '#101b2c' : 'rgba(120,135,145,0.9)';
      ctx.fillRect(tx, horizon - bh, bw, bh);
      if (night) {
        for (let wy = horizon - bh + 4; wy < horizon - 4; wy += 8) {
          for (let wx = tx + 3; wx < tx + bw - 3; wx += 7) {
            if (rand() > 0.45) {
              ctx.fillStyle = `rgba(255,220,150,${0.35 + rand() * 0.55})`;
              ctx.fillRect(wx, wy, 3, 4);
            }
          }
        }
      }
    }
    ctx.fillStyle = night ? '#3a4a5f' : 'rgba(90,110,125,0.95)';
    ctx.beginPath();
    ctx.moveTo(268, horizon - 96);
    ctx.lineTo(284, horizon - 20);
    ctx.lineTo(252, horizon - 20);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = night ? '#26374d' : 'rgba(140,155,165,0.95)';
    ctx.fillRect(196, horizon - 118, 20, 118);
    ctx.fillStyle = night ? 'rgba(255,225,160,0.5)' : 'rgba(220,230,235,0.6)';
    ctx.fillRect(200, horizon - 112, 12, 4);
    const water = ctx.createLinearGradient(0, horizon, 0, H);
    if (night) {
      water.addColorStop(0, '#0a1a2c');
      water.addColorStop(1, '#0c2233');
    } else {
      water.addColorStop(0, '#4a7f9a');
      water.addColorStop(1, '#2f6076');
    }
    ctx.fillStyle = water;
    ctx.fillRect(0, horizon, W, H - horizon);
    for (const [tx, bw, bh] of towers) {
      if (bh < 40) continue;
      const g = ctx.createLinearGradient(0, horizon, 0, H);
      const col = night ? 'rgba(255,220,150,' : 'rgba(230,240,245,';
      g.addColorStop(0, `${col}${night ? 0.5 : 0.25})`);
      g.addColorStop(1, `${col}0)`);
      ctx.fillStyle = g;
      ctx.fillRect(tx, horizon, Math.max(2, bw * 0.35), (H - horizon) * 0.8);
    }
    const jx = 70;
    const jy = horizon + 26;
    ctx.fillStyle = night ? '#1b2434' : '#4a3a2a';
    ctx.fillRect(jx, jy, 42, 6);
    ctx.fillStyle = '#b4433a';
    ctx.beginPath();
    ctx.moveTo(jx + 20, jy);
    ctx.lineTo(jx + 20, jy - 30);
    ctx.lineTo(jx + 36, jy);
    ctx.closePath();
    ctx.fill();
    const fx = 300;
    const fy = horizon + 34;
    ctx.fillStyle = '#2f7f6a';
    ctx.fillRect(fx, fy, 74, 12);
    ctx.fillStyle = '#f2f0e6';
    ctx.fillRect(fx + 4, fy - 10, 66, 10);
    ctx.fillStyle = '#2f7f6a';
    ctx.fillRect(fx + 8, fy - 18, 20, 8);
    ctx.fillStyle = night ? '#ffd166' : '#3f4a4a';
    for (let i = 0; i < 6; i++) ctx.fillRect(fx + 8 + i * 10, fy - 8, 5, 5);
    for (let i = 0; i < 26; i++) {
      ctx.fillStyle = night ? 'rgba(220,230,255,0.12)' : 'rgba(230,245,255,0.25)';
      ctx.fillRect((i * 47) % W, horizon + 12 + ((i * 31) % (H - horizon - 20)), 14, 1.5);
    }
    ctx.fillStyle = night ? '#141c26' : '#5a5f58';
    ctx.fillRect(0, H - 20, W, 5);
    for (let i = 0; i < 14; i++) ctx.fillRect(i * 40, H - 20, 4, 20);
  });
}

/** 戶外遠景天際線板（公園、海濱、碼頭用）。 */
export function skylineMat(night: boolean): THREE.MeshBasicMaterial {
  return textureMat(`skyline-${night ? 'n' : 'd'}`, 1024, 256, (ctx, W, H) => {
    const base = H * 0.82;
    const sky = ctx.createLinearGradient(0, 0, 0, base);
    if (night) {
      sky.addColorStop(0, '#0a1120');
      sky.addColorStop(1, '#1c2942');
    } else {
      sky.addColorStop(0, '#9cc0da');
      sky.addColorStop(1, '#dce2dc');
    }
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, base);
    ctx.fillStyle = night ? '#0e1626' : 'rgba(125,140,135,0.8)';
    ctx.beginPath();
    ctx.moveTo(0, base);
    ctx.lineTo(0, base - 70);
    ctx.lineTo(140, base - 118);
    ctx.lineTo(260, base - 84);
    ctx.lineTo(380, base - 132);
    ctx.lineTo(520, base - 92);
    ctx.lineTo(660, base - 108);
    ctx.lineTo(820, base - 80);
    ctx.lineTo(1024, base - 100);
    ctx.lineTo(1024, base);
    ctx.closePath();
    ctx.fill();
    let seed = night ? 91 : 13;
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    let x = 0;
    while (x < W) {
      const bw = 18 + rand() * 30;
      const bh = 20 + rand() * 120;
      ctx.fillStyle = night ? '#101a2a' : 'rgba(150,158,160,0.9)';
      ctx.fillRect(x, base - bh, bw, bh);
      if (night) {
        for (let wy = base - bh + 5; wy < base - 4; wy += 9) {
          for (let wx = x + 3; wx < x + bw - 4; wx += 8) {
            if (rand() > 0.43) {
              ctx.fillStyle = `rgba(255,218,150,${0.3 + rand() * 0.6})`;
              ctx.fillRect(wx, wy, 3, 4);
            }
          }
        }
      }
      x += bw + 2;
    }
    ctx.fillStyle = night ? '#0c1420' : 'rgba(90,105,90,0.9)';
    ctx.fillRect(0, base, W, H - base);
    if (night) {
      ctx.fillStyle = 'rgba(255,61,127,0.35)';
      ctx.fillRect(0, base - 2, W, 2);
    }
  });
}

// ─────────────────────────── 幾何工具 ───────────────────────────

export function addBox(
  parent: THREE.Object3D,
  mat: Mat,
  w: number,
  h: number,
  d: number,
  x = 0,
  y = 0,
  z = 0,
  ry = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  if (ry) mesh.rotation.y = ry;
  parent.add(mesh);
  return mesh;
}

export function addCyl(
  parent: THREE.Object3D,
  mat: Mat,
  rTop: number,
  rBottom: number,
  h: number,
  x = 0,
  y = 0,
  z = 0,
  seg = 10,
  ry = 0,
  rz = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, seg), mat);
  mesh.position.set(x, y, z);
  if (ry) mesh.rotation.y = ry;
  if (rz) mesh.rotation.z = rz;
  parent.add(mesh);
  return mesh;
}

export function addSphere(
  parent: THREE.Object3D,
  mat: Mat,
  r: number,
  x = 0,
  y = 0,
  z = 0,
  segW = 10,
  segH = 7,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, segW, segH), mat);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

export function addCone(
  parent: THREE.Object3D,
  mat: Mat,
  r: number,
  h: number,
  x = 0,
  y = 0,
  z = 0,
  seg = 10,
  ry = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), mat);
  mesh.position.set(x, y, z);
  if (ry) mesh.rotation.y = ry;
  parent.add(mesh);
  return mesh;
}

/** 平面：預設水平向上；傳 rx=0 則面向 +Z。 */
export function addPlane(
  parent: THREE.Object3D,
  mat: Mat,
  w: number,
  h: number,
  x = 0,
  y = 0,
  z = 0,
  rx = -Math.PI / 2,
  ry = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, 0);
  parent.add(mesh);
  return mesh;
}

export function addLathe(
  parent: THREE.Object3D,
  mat: Mat,
  pts: [number, number][],
  x = 0,
  y = 0,
  z = 0,
  seg = 12,
): THREE.Mesh {
  const vecs = pts.map(([r, py]) => new THREE.Vector2(Math.max(0.0001, r), py));
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(vecs, seg), mat);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

/** 兩點之間的樑／管。 */
export function addBeam(
  parent: THREE.Object3D,
  mat: Mat,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  thickness = 0.06,
  seg = 6,
): THREE.Mesh {
  const a = new THREE.Vector3(ax, ay, az);
  const b = new THREE.Vector3(bx, by, bz);
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = Math.max(0.001, dir.length());
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(thickness / 2, thickness / 2, len, seg), mat);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  parent.add(mesh);
  return mesh;
}

/** 標記微動畫節點（interior.ts 的 update 依 kind 處理）。 */
export function markAnim(obj: THREE.Object3D, kind: string): THREE.Object3D {
  obj.userData.anim = kind;
  return obj;
}

// ─────────────────────────── 靜態幾何合併 ───────────────────────────

const VERTEX_LIT = new THREE.MeshLambertMaterial({ vertexColors: true });
const VERTEX_BASIC = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });

interface MeshEntry {
  mesh: THREE.Mesh;
  matrix: THREE.Matrix4;
  material: THREE.Material;
}

function isMeshObject(obj: THREE.Object3D): obj is THREE.Mesh {
  return (obj as THREE.Mesh).isMesh === true;
}

function hasMap(mat: THREE.Material): boolean {
  return !!(mat as THREE.MeshBasicMaterial).map;
}

function isBasicMat(mat: THREE.Material): boolean {
  return (mat as THREE.MeshBasicMaterial).isMeshBasicMaterial === true;
}

function bakeGeometry(mesh: THREE.Mesh, matrix: THREE.Matrix4, color: THREE.Color | null): THREE.BufferGeometry {
  const src = mesh.geometry;
  const geo = src.index ? src.toNonIndexed() : src.clone();
  geo.applyMatrix4(matrix);
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
  }
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const pos = geo.getAttribute('position');
  if (!geo.getAttribute('uv')) {
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pos.count * 2), 2));
  }
  if (color) {
    const data = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      data[i * 3] = color.r;
      data[i * 3 + 1] = color.g;
      data[i * 3 + 2] = color.b;
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(data, 3));
  }
  return geo;
}

interface MergeBucket {
  material: THREE.Material;
  color: THREE.Color | null;
  geos: THREE.BufferGeometry[];
}

function bucketKeyFor(material: THREE.Material): { key: string; material: THREE.Material; color: THREE.Color | null } {
  const basicMat = isBasicMat(material);
  if (hasMap(material) || material.transparent || material.side !== THREE.FrontSide) {
    return { key: `m|${material.uuid}`, material, color: null };
  }
  if (basicMat) {
    return { key: '__basic', material: VERTEX_BASIC, color: (material as THREE.MeshBasicMaterial).color.clone() };
  }
  const lamMat = material as THREE.MeshLambertMaterial;
  if (lamMat.emissive && lamMat.emissive.r + lamMat.emissive.g + lamMat.emissive.b > 0.04) {
    return { key: '__basic', material: VERTEX_BASIC, color: lamMat.color.clone().add(lamMat.emissive) };
  }
  return { key: '__lit', material: VERTEX_LIT, color: lamMat.color.clone() };
}

function mergeEntries(parent: THREE.Object3D, entries: MeshEntry[], relativeTo: THREE.Matrix4, castShadow = true): void {
  const buckets = new Map<string, MergeBucket>();
  for (const entry of entries) {
    const { key, material, color } = bucketKeyFor(entry.material);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { material, color, geos: [] };
      buckets.set(key, bucket);
    }
    const rel = new THREE.Matrix4().copy(relativeTo).invert().multiply(entry.matrix);
    bucket.geos.push(bakeGeometry(entry.mesh, rel, color));
  }
  for (const entry of entries) entry.mesh.removeFromParent();
  const keep = new Set<THREE.BufferGeometry>();
  parent.traverse((obj) => {
    if (isMeshObject(obj)) keep.add(obj.geometry);
  });
  for (const entry of entries) {
    if (!keep.has(entry.mesh.geometry)) entry.mesh.geometry.dispose();
  }
  for (const bucket of buckets.values()) {
    const merged = mergeGeometriesSafe(bucket.geos);
    for (const geo of bucket.geos) geo.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, bucket.material);
    mesh.castShadow = castShadow && bucket.material !== VERTEX_BASIC;
    mesh.receiveShadow = true;
    parent.add(mesh);
  }
}

/** 合併同屬性 BufferGeometry；失敗時回傳 null。 */
function mergeGeometriesSafe(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!geos.length) return null;
  if (geos.length === 1) return geos[0];
  const attrNames = Object.keys(geos[0].attributes);
  const totalVerts = geos.reduce((sum, g) => sum + (g.getAttribute('position')?.count ?? 0), 0);
  if (totalVerts === 0) return null;
  const arrays = new Map<string, { array: Float32Array; size: number }>();
  for (const name of attrNames) {
    const size = geos[0].getAttribute(name).itemSize;
    arrays.set(name, { array: new Float32Array(totalVerts * size), size });
  }
  let offset = 0;
  for (const geo of geos) {
    const posAttr = geo.getAttribute('position');
    if (!posAttr) return null;
    for (const name of attrNames) {
      const src = geo.getAttribute(name);
      if (!src || src.count !== posAttr.count) return null;
      const slot = arrays.get(name)!;
      if (src.array instanceof Float32Array) {
        slot.array.set(src.array as Float32Array, offset * slot.size);
      } else {
        for (let i = 0; i < src.count; i++) {
          for (let c = 0; c < slot.size; c++) slot.array[(offset + i) * slot.size + c] = src.getComponent(i, c);
        }
      }
    }
    offset += posAttr.count;
  }
  const out = new THREE.BufferGeometry();
  for (const [name, slot] of arrays) {
    out.setAttribute(name, new THREE.Float32BufferAttribute(slot.array, slot.size));
  }
  out.computeBoundingSphere();
  return out;
}

/**
 * 室內完工：把靜態陳設依材質合併（受光面全部併成 1 個頂點色 mesh、
 * 發光面併成 1 個、貼圖面各自合併），動畫節點內部亦局部合併；
 * 每間室內最終約 8~25 個 draw call。
 */
export function finalizeInteriorScene(root: THREE.Object3D, castShadow = true): void {
  root.updateMatrixWorld(true);
  const base = root.matrixWorld.clone();
  const statics: MeshEntry[] = [];
  const animNodes: THREE.Object3D[] = [];

  const walk = (node: THREE.Object3D): void => {
    for (const child of node.children) {
      if (child.userData?.anim) {
        animNodes.push(child);
        continue;
      }
      if (isMeshObject(child) && !Array.isArray(child.material)) {
        statics.push({ mesh: child, matrix: child.matrixWorld.clone(), material: child.material as THREE.Material });
      } else {
        walk(child);
      }
    }
  };
  walk(root);

  mergeEntries(root, statics, base, castShadow);

  for (const node of animNodes) {
    if (isMeshObject(node)) continue;
    node.updateMatrixWorld(true);
    const nodeBase = node.matrixWorld.clone();
    const entries: MeshEntry[] = [];
    const collect = (parent: THREE.Object3D): void => {
      for (const child of parent.children) {
        if (child.userData?.anim) continue;
        if (isMeshObject(child) && !Array.isArray(child.material)) {
          if (hasMap(child.material) || child.material.transparent) continue;
          entries.push({
            mesh: child,
            matrix: child.matrixWorld.clone(),
            material: child.material as THREE.Material,
          });
        } else {
          collect(child);
        }
      }
    };
    collect(node);
    if (entries.length) mergeEntries(node, entries, nodeBase, castShadow);
  }
}

// ─────────────────────────── 房間基本構件 ───────────────────────────

/** 光管／吊燈。 */
export function addCeilingLamp(parent: THREE.Object3D, x: number, y: number, z: number, len = 1.6, warm = false): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const tubeMat = basic(warm ? 0xffe0b0 : 0xeaf4ff);
  addBox(g, lam(IPAL.steelDark), len + 0.16, 0.05, 0.22, 0, 0.08, 0);
  addBox(g, tubeMat, len, 0.07, 0.13, 0, 0, 0);
  for (const side of [-1, 1]) {
    addCyl(g, lam(IPAL.steelDark), 0.012, 0.012, 0.24, (len / 2 - 0.1) * side, 0.2, 0, 4);
  }
  parent.add(g);
  return g;
}

/** 吊扇（會轉）。 */
export function addCeilingFan(parent: THREE.Object3D, x: number, y: number, z: number, radius = 0.8): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  addCyl(g, lam(0x3a3f45), 0.12, 0.1, 0.16, 0, 0, 0, 8);
  addCyl(g, lam(0x9aa0a6), 0.035, 0.035, 0.5, 0, 0.28, 0, 6);
  const bladeMat = lam(0xb9b3a4);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const blade = addBox(g, bladeMat, radius, 0.03, 0.2, Math.cos(a) * radius * 0.5, -0.04, Math.sin(a) * radius * 0.5, -a);
    blade.rotation.z = 0.08;
  }
  addSphere(g, lam(0x6f767c), 0.06, 0, -0.06, 0, 8, 6);
  markAnim(g, 'fan');
  parent.add(g);
  return g;
}

/** 窗口式冷氣機。 */
export function addACUnit(parent: THREE.Object3D, x: number, y: number, z: number, ry = 0, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  g.scale.setScalar(scale);
  addBox(g, lam(0xd8d6cc), 0.9, 0.5, 0.24, 0, 0, 0);
  addBox(g, lam(0xb9b7ad), 0.74, 0.4, 0.03, 0, 0, 0.13);
  for (let i = 0; i < 5; i++) addBox(g, lam(0xa5a39a), 0.62, 0.02, 0.02, 0, 0.16 - i * 0.08, 0.16);
  addBox(g, lam(0x8a8880), 0.42, 0.16, 0.28, 0, -0.3, -0.02);
  parent.add(g);
  return g;
}

/** 通風槽。 */
export function addVentDuct(parent: THREE.Object3D, x: number, y: number, z: number, len = 3, ry = 0, square = false): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  const mat = lam(0x9aa0a6);
  if (square) {
    addBox(g, mat, len, 0.42, 0.42, 0, 0, 0);
    addBox(g, lam(0x757b82), 0.1, 0.46, 0.46, -len / 2 + 0.3, 0, 0);
    addBox(g, lam(0x757b82), 0.1, 0.46, 0.46, len / 2 - 0.3, 0, 0);
  } else {
    addCyl(g, mat, 0.2, 0.2, len, 0, 0, 0, 12, 0, Math.PI / 2);
    addCyl(g, lam(0xb6bcc2), 0.24, 0.24, 0.1, 0, 0, -len / 2 + 0.1, 12, 0, Math.PI / 2);
  }
  parent.add(g);
  return g;
}

/** 安全出口燈。 */
export function addExitSign(parent: THREE.Object3D, x: number, y: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  addBox(g, lam(0x2a2f2a), 0.9, 0.34, 0.08, 0, 0, 0);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.28), exitSignMat());
  face.position.z = 0.045;
  g.add(face);
  markAnim(face, 'glow');
  parent.add(g);
  return g;
}

/** 消防喉轆。 */
export function addFireHose(parent: THREE.Object3D, x: number, y: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  addBox(g, lam(0xb02a2a), 0.7, 0.7, 0.2, 0, 0, 0);
  addBox(g, lam(0xe8e6dc), 0.5, 0.5, 0.03, 0, 0, 0.12);
  addCyl(g, lam(0x8a8f96), 0.2, 0.2, 0.1, 0, 0, 0.15, 12, 0, Math.PI / 2);
  addBox(g, lam(0xe8e6dc), 0.5, 0.12, 0.02, 0, 0.16, 0.13);
  parent.add(g);
  return g;
}

/** 鐵閘（唐樓入門）。 */
export function addIronGate(parent: THREE.Object3D, x: number, z: number, ry = 0, width = 1.2, height = 2.0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const mat = lam(0x7c848c);
  const dark = lam(0x4f565d);
  addBox(g, dark, width + 0.16, 0.1, 0.1, 0, height, 0);
  addBox(g, dark, width + 0.16, 0.1, 0.1, 0, 0.05, 0);
  for (const side of [-1, 1]) addBox(g, dark, 0.08, height, 0.1, side * (width / 2), height / 2, 0);
  const bars = 7;
  for (let i = 0; i < bars; i++) {
    addCyl(g, mat, 0.022, 0.022, height - 0.16, -width / 2 + (width / bars) * (i + 0.5), height / 2, 0, 5);
  }
  for (let i = 1; i < 4; i++) addBox(g, mat, width, 0.035, 0.035, 0, (height / 4) * i, 0);
  addBox(g, mat, width * 0.7, 0.05, 0.03, 0, height * 0.62, 0);
  addBox(g, mat, width * 0.4, 0.05, 0.03, 0, height * 0.4, 0);
  parent.add(g);
  return g;
}

/** 窗框＋玻璃＋日夜窗外景（回傳日夜材質供 update 交叉淡入）。 */
export function addWindowView(
  parent: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  ry = 0,
  kind: 'street' | 'harbour' = 'street',
): WindowViewRefs {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  const frame = lam(0xc9cdd0);
  const frameDark = lam(0x8f9599);
  const dayMat = ownMat(
    new THREE.MeshBasicMaterial({
      map: (kind === 'harbour' ? harbourViewMat(false) : cityViewMat(false)).map,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const nightMat = ownMat(
    new THREE.MeshBasicMaterial({
      map: (kind === 'harbour' ? harbourViewMat(true) : cityViewMat(true)).map,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const dayPlane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), dayMat);
  dayPlane.position.z = 0.012;
  g.add(dayPlane);
  const nightPlane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), nightMat);
  nightPlane.position.z = 0.013;
  g.add(nightPlane);
  addBox(g, frame, w + 0.12, 0.07, 0.1, 0, h / 2, 0.04);
  addBox(g, frame, w + 0.12, 0.09, 0.1, 0, -h / 2, 0.04);
  addBox(g, frame, 0.07, h, 0.1, -w / 2, 0, 0.04);
  addBox(g, frame, 0.07, h, 0.1, w / 2, 0, 0.04);
  addBox(g, frameDark, 0.05, h, 0.06, 0, 0, 0.05);
  if (h > 1.2) addBox(g, frameDark, w, 0.05, 0.06, 0, h * 0.18, 0.05);
  addBox(g, lam(IPAL.concreteLight), w + 0.22, 0.08, 0.22, 0, -h / 2 - 0.06, 0.08);
  const rain = new THREE.Mesh(new THREE.PlaneGeometry(w, h), rainMat());
  rain.position.z = 0.05;
  rain.visible = false;
  markAnim(rain, 'rain');
  g.add(rain);
  parent.add(g);
  return { day: dayMat, night: nightMat };
}

/** 晾衫架。 */
export function addClothesRack(parent: THREE.Object3D, x: number, z: number, ry = 0, w = 1.8): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const pole = lam(0x8a9096);
  addCyl(g, pole, 0.02, 0.02, w, 0, 1.8, 0, 6, 0, Math.PI / 2);
  for (const side of [-1, 1]) {
    addCyl(g, pole, 0.02, 0.02, 1.85, side * (w / 2 - 0.06), 0.92, 0, 6);
    addCyl(g, lam(0x6f757b), 0.03, 0.03, 0.5, side * (w / 2 - 0.06), 0.02, 0, 6, 0, Math.PI / 2);
  }
  const shirts = [0x5f8fbf, 0xd9c9a0, 0xcf6f5a, 0xe8e4d8, 0x6f9a7a];
  const swing = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const cx = -w / 2 + 0.22 + i * (w / 2 - 0.2) * 0.5;
    addBox(swing, lam(shirts[i]), 0.3, 0.4, 0.02, cx, 1.55, 0);
    addBox(swing, lam(0x8a8f96), 0.02, 0.1, 0.02, cx, 1.78, 0);
  }
  markAnim(swing, 'sway');
  g.add(swing);
  parent.add(g);
  return g;
}

/** 神枱（紅燈、香爐）。 */
export function addAltar(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x7a2a20), 1.1, 0.75, 0.4, 0, 1.32, 0);
  addBox(g, lam(0xc9a24c), 1.16, 0.06, 0.44, 0, 1.72, 0);
  addBox(g, lam(0x5a1e18), 1.0, 0.9, 0.06, 0, 0.45, -0.14);
  addCyl(g, lam(0xc9a24c), 0.11, 0.13, 0.22, 0, 1.84, 0, 8);
  addCyl(g, lam(0x8a6f43), 0.09, 0.07, 0.12, 0, 1.96, 0, 8);
  addCyl(g, lam(0x6f6a60), 0.12, 0.1, 0.1, 0.3, 1.8, 0.02, 10);
  const lamp = addBox(g, basic(0xff3a2a), 0.09, 0.16, 0.09, -0.34, 1.78, 0.02);
  addBox(g, lam(0x8a1f18), 0.12, 0.04, 0.12, -0.34, 1.7, 0.02);
  markAnim(lamp, 'glow');
  parent.add(g);
  return g;
}

// ─────────────────────────── 住宅家具 ───────────────────────────

export function addSofa(parent: THREE.Object3D, x: number, z: number, ry = 0, color = 0x8a7f6a, len = 2.2): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const fabric = lam(color);
  const fabricDark = lam(darkenColor(color, 0.82));
  addBox(g, fabricDark, len, 0.34, 0.9, 0, 0.2, 0);
  addBox(g, fabric, len, 0.5, 0.24, 0, 0.6, -0.33);
  for (const side of [-1, 1]) addBox(g, fabricDark, 0.24, 0.56, 0.92, side * (len / 2 - 0.1), 0.36, 0);
  for (let i = 0; i < 3; i++) addBox(g, fabric, len / 3 - 0.08, 0.14, 0.72, -len / 3 + (len / 3) * i, 0.42, 0.04);
  addBox(g, lam(0xc9a24c), 0.34, 0.34, 0.12, -len / 2 + 0.35, 0.6, 0.2, 0.2);
  addBox(g, lam(0xb4554a), 0.32, 0.32, 0.12, len / 2 - 0.4, 0.58, 0.2, -0.2);
  parent.add(g);
  return g;
}

export function addCoffeeTable(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(IPAL.woodDark), 1.2, 0.07, 0.62, 0, 0.42, 0);
  for (const [sx, sz] of [
    [-0.5, -0.24],
    [0.5, -0.24],
    [-0.5, 0.24],
    [0.5, 0.24],
  ]) {
    addBox(g, lam(0x3a2a1c), 0.06, 0.4, 0.06, sx, 0.2, sz);
  }
  addBox(g, lam(0xd9d4c8), 0.28, 0.03, 0.2, 0.15, 0.47, 0.05);
  addCyl(g, lam(0xe8e4d8), 0.04, 0.035, 0.09, -0.2, 0.5, 0, 8);
  parent.add(g);
  return g;
}

/** 電視櫃＋舊電視／薄電視。 */
export function addTVUnit(parent: THREE.Object3D, x: number, z: number, ry = 0, old = false): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(IPAL.woodDark), 1.5, 0.5, 0.44, 0, 0.25, 0);
  addBox(g, lam(0x4a3524), 0.46, 0.34, 0.06, -0.36, 0.25, 0.23);
  addBox(g, lam(0x4a3524), 0.46, 0.34, 0.06, 0.32, 0.25, 0.23);
  if (old) {
    addBox(g, lam(0x5c5348), 0.86, 0.64, 0.5, 0, 0.86, 0);
    addBox(g, lam(0x3a3530), 0.64, 0.46, 0.03, -0.04, 0.9, 0.26);
    addBox(g, basic(0x6f8fa8), 0.58, 0.4, 0.01, -0.04, 0.9, 0.28);
    addCyl(g, lam(0x8a8f96), 0.008, 0.008, 0.6, 0.3, 1.44, -0.1, 4, 0, 0.5);
    addCyl(g, lam(0x8a8f96), 0.008, 0.008, 0.5, 0.18, 1.4, -0.05, 4, 0, -0.4);
  } else {
    addBox(g, lam(0x22262a), 1.15, 0.64, 0.06, 0, 0.94, 0);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(1.06, 0.56), tvScreenMat());
    face.position.set(0, 0.94, 0.035);
    g.add(face);
    addBox(g, lam(0x22262a), 0.2, 0.1, 0.14, 0, 0.58, 0);
    addBox(g, lam(0x22262a), 0.4, 0.04, 0.24, 0, 0.55, 0);
  }
  addBox(g, lam(0x1f2226), 0.3, 0.06, 0.2, 0.4, 0.53, 0.1);
  addBox(g, lam(0x2a2e33), 0.1, 0.03, 0.16, -0.3, 0.52, 0.12);
  parent.add(g);
  return g;
}

export function addDiningSet(parent: THREE.Object3D, x: number, z: number, ry = 0, chairs = 4): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addCyl(g, lam(0xc9c3b4), 0.62, 0.62, 0.05, 0, 0.72, 0, 16);
  addCyl(g, lam(0x8a8f96), 0.05, 0.05, 0.7, 0, 0.36, 0, 8);
  addCyl(g, lam(0x6f757b), 0.3, 0.34, 0.04, 0, 0.02, 0, 12);
  addCyl(g, lam(0xe8e4d8), 0.14, 0.12, 0.05, -0.14, 0.77, 0.05, 10);
  addCyl(g, lam(0xd9a04a), 0.11, 0.1, 0.04, -0.14, 0.8, 0.05, 10);
  addCyl(g, lam(0xe8e4d8), 0.12, 0.1, 0.05, 0.14, 0.77, -0.08, 10);
  addCyl(g, lam(0x5f8f4a), 0.09, 0.08, 0.04, 0.14, 0.8, -0.08, 10);
  addCyl(g, lam(0xe8e4d8), 0.05, 0.04, 0.06, 0, 0.78, 0.28, 8);
  const seatMats = [0x8a6a4a, 0x6f7f8a];
  for (let i = 0; i < chairs; i++) {
    const a = (i / chairs) * Math.PI * 2 + 0.4;
    const chair = new THREE.Group();
    chair.position.set(Math.cos(a) * 0.95, 0, Math.sin(a) * 0.95);
    chair.rotation.y = -a + Math.PI / 2;
    const m = lam(seatMats[i % 2]);
    addBox(chair, m, 0.42, 0.05, 0.42, 0, 0.44, 0);
    addBox(chair, m, 0.42, 0.5, 0.06, 0, 0.68, -0.18);
    for (const [sx, sz] of [
      [-0.17, -0.17],
      [0.17, -0.17],
      [-0.17, 0.17],
      [0.17, 0.17],
    ]) {
      addBox(chair, lam(0x3a3f45), 0.04, 0.44, 0.04, sx, 0.22, sz);
    }
    g.add(chair);
  }
  parent.add(g);
  return g;
}

export function addFridge(parent: THREE.Object3D, x: number, z: number, ry = 0, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  g.scale.setScalar(scale);
  addBox(g, lam(0xd9dde0), 0.68, 1.72, 0.62, 0, 0.86, 0);
  addBox(g, lam(0xc4c9cc), 0.68, 0.02, 0.62, 0, 1.18, 0);
  addBox(g, lam(0x8f9599), 0.03, 0.8, 0.05, 0.28, 1.05, 0.33);
  addBox(g, lam(0x8f9599), 0.03, 0.4, 0.05, 0.28, 0.6, 0.33);
  addBox(g, lam(0xe0c04a), 0.2, 0.16, 0.01, -0.16, 1.32, 0.32);
  addBox(g, lam(0x4fa3c9), 0.14, 0.2, 0.01, 0.05, 1.45, 0.32);
  parent.add(g);
  return g;
}

export function addKitchenCounter(parent: THREE.Object3D, x: number, z: number, ry = 0, len = 2.4): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0xc9c3b4), len, 0.82, 0.6, 0, 0.41, 0);
  addBox(g, lam(0xe4e0d4), len, 0.05, 0.64, 0, 0.84, 0);
  addBox(g, lam(0x8f9599), 0.5, 0.06, 0.4, -len / 4, 0.86, 0);
  addCyl(g, lam(0x9aa0a6), 0.02, 0.02, 0.24, -len / 4, 1.0, -0.14, 6);
  addBox(g, lam(0x2f3337), 0.52, 0.04, 0.44, len / 4, 0.87, 0);
  for (const sx of [-0.13, 0.13]) addCyl(g, lam(0x555a5f), 0.07, 0.07, 0.03, len / 4 + sx, 0.9, 0, 10);
  addCyl(g, lam(0xd9d4c8), 0.11, 0.1, 0.24, len / 4 + 0.02, 1.0, 0.06, 10);
  addBox(g, lam(0xc9ced2), 0.22, 0.18, 0.22, -len / 4 + 0.02, 0.96, 0.04);
  addBox(g, lam(0x2f3337), 0.2, 0.03, 0.2, -len / 4 + 0.02, 1.06, 0.04);
  for (let i = 0; i < 3; i++) {
    addBox(g, lam(0xb0aa9c), len / 3 - 0.06, 0.62, 0.02, -len / 3 + (len / 3) * (i + 0.5), 0.42, 0.31);
  }
  parent.add(g);
  return g;
}

/** 電飯煲（會冒蒸氣）。 */
export function addRiceCooker(parent: THREE.Object3D, x: number, y: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  addCyl(g, lam(0xe4e0d4), 0.13, 0.12, 0.2, 0, 0.1, 0, 12);
  addCyl(g, lam(0xf0ece2), 0.14, 0.14, 0.05, 0, 0.22, 0, 12);
  addCyl(g, lam(0xc9a24c), 0.03, 0.03, 0.04, 0, 0.26, 0, 8);
  addBox(g, lam(0xb02a2a), 0.04, 0.03, 0.02, 0.1, 0.16, 0.11);
  markAnim(g, 'steam');
  parent.add(g);
  return g;
}

/** 碌架床（上下格床）。 */
export function addBunkBed(parent: THREE.Object3D, x: number, z: number, ry = 0, single = false): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const frame = lam(0x8a9096);
  const w = 0.95;
  const len = 1.9;
  for (const [sx, sz] of [
    [-w / 2, -len / 2],
    [w / 2, -len / 2],
    [-w / 2, len / 2],
    [w / 2, len / 2],
  ]) {
    addCyl(g, frame, 0.025, 0.025, 1.7, sx, 0.85, sz, 6);
  }
  for (let i = 0; i < 2; i++) {
    if (single && i === 1) continue;
    const yy = i === 0 ? 0.42 : 1.28;
    addBox(g, frame, w, 0.04, len, 0, yy, 0);
    addBox(g, lam(0xe8e0cc), w - 0.08, 0.16, len - 0.1, 0, yy + 0.1, 0);
    addBox(g, lam(i === 0 ? 0x6f8fa8 : 0x9a6f7a), w - 0.12, 0.08, len * 0.62, 0, yy + 0.2, len * 0.14);
    addBox(g, lam(0xf2eee4), w - 0.4, 0.1, 0.3, 0, yy + 0.22, -len / 2 + 0.28);
  }
  if (!single) {
    addBox(g, frame, w, 0.22, 0.03, 0, 1.55, -len / 2);
    addBox(g, frame, 0.03, 0.22, len * 0.4, -w / 2, 1.55, -len * 0.3);
  }
  for (let i = 0; i < 4; i++) addBox(g, frame, w * 0.7, 0.03, 0.03, 0, 0.4 + i * 0.26, len / 2 - 0.1);
  addBox(g, lam(0xb08a55), 0.5, 0.2, 0.4, 0.1, 0.12, 0.3);
  parent.add(g);
  return g;
}

export function addSingleBed(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x6f4a2a), 1.0, 0.32, 1.95, 0, 0.18, 0);
  addBox(g, lam(0xf2eee4), 0.92, 0.16, 1.8, 0, 0.42, 0);
  addBox(g, lam(0xcf7f7a), 0.9, 0.08, 1.1, 0, 0.53, 0.24);
  addBox(g, lam(0xf6f2ea), 0.5, 0.1, 0.28, 0, 0.55, -0.76);
  addBox(g, lam(0x6f4a2a), 1.04, 0.7, 0.06, 0, 0.6, -1.02);
  parent.add(g);
  return g;
}

export function addWardrobe(parent: THREE.Object3D, x: number, z: number, ry = 0, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  g.scale.setScalar(scale);
  addBox(g, lam(0x8a6038), 1.2, 2.0, 0.58, 0, 1.0, 0);
  addBox(g, lam(0x6f4a2a), 0.56, 1.9, 0.03, -0.3, 1.0, 0.3);
  addBox(g, lam(0x6f4a2a), 0.56, 1.9, 0.03, 0.3, 1.0, 0.3);
  addCyl(g, lam(0xc9a24c), 0.015, 0.015, 0.16, -0.05, 1.05, 0.33, 5);
  addCyl(g, lam(0xc9a24c), 0.015, 0.015, 0.16, 0.05, 1.05, 0.33, 5);
  parent.add(g);
  return g;
}

/** 板間房隔板（劏房）。 */
export function addBoardPartition(parent: THREE.Object3D, x: number, z: number, ry = 0, len = 2.4, h = 2.2, door = true): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const panel = lam(0xd8d0ba);
  const frame = lam(0x9a865c);
  addBox(g, panel, len, h, 0.08, 0, h / 2, 0);
  addBox(g, frame, len, 0.06, 0.12, 0, h, 0);
  addBox(g, frame, 0.12, h, 0.12, -len / 2, h / 2, 0);
  addBox(g, frame, 0.12, h, 0.12, len / 2, h / 2, 0);
  for (let i = 1; i < 3; i++) addBox(g, frame, len, 0.05, 0.1, 0, (h / 3) * i, 0);
  if (door) {
    addBox(g, lam(0xb9a582), 0.06, h * 0.8, 0.7, len / 2 - 0.5, h * 0.4, 0.38);
    addBox(g, frame, 0.1, h * 0.82, 0.06, len / 2 - 0.5, h * 0.4, 0.72);
  }
  parent.add(g);
  return g;
}

export function addShoeCabinet(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x9a7a52), 1.0, 0.9, 0.32, 0, 0.45, 0);
  addBox(g, lam(0x7a5a38), 0.94, 0.02, 0.3, 0, 0.9, 0);
  for (let i = 0; i < 2; i++) addBox(g, lam(0x5f452a), 0.44, 0.7, 0.02, -0.24 + i * 0.48, 0.45, 0.17);
  for (let i = 0; i < 3; i++) addBox(g, lam(i % 2 ? 0x3a3f45 : 0x8a4a3a), 0.22, 0.08, 0.12, -0.3 + i * 0.28, 0.06, 0.22);
  parent.add(g);
  return g;
}

export function addPottedPlant(parent: THREE.Object3D, x: number, z: number, scale = 1, flower = false): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(scale);
  addCyl(g, lam(0x8a5a3a), 0.16, 0.13, 0.28, 0, 0.14, 0, 10);
  addCyl(g, lam(0x4f7a44), 0.05, 0.05, 0.5, 0, 0.5, 0, 6);
  addSphere(g, lam(0x4f7a44), 0.24, 0, 0.78, 0, 8, 6);
  addSphere(g, lam(0x5f8f4a), 0.18, 0.14, 0.92, 0.05, 8, 6);
  addSphere(g, lam(0x6f9a52), 0.16, -0.13, 0.9, -0.04, 8, 6);
  if (flower) {
    for (let i = 0; i < 3; i++) addSphere(g, lam(0xd94a6a), 0.035, -0.1 + i * 0.1, 0.98 + (i % 2) * 0.05, 0.12, 6, 5);
  }
  parent.add(g);
  return g;
}

/** 麻將枱。 */
export function addMahjongTable(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0xd8c25a), 0.86, 0.06, 0.86, 0, 0.74, 0);
  addBox(g, lam(0x2f7a5a), 0.8, 0.02, 0.8, 0, 0.78, 0);
  for (const [sx, sz] of [
    [-0.36, -0.36],
    [0.36, -0.36],
    [-0.36, 0.36],
    [0.36, 0.36],
  ]) {
    addBox(g, lam(0x5c3f24), 0.07, 0.72, 0.07, sx, 0.36, sz);
  }
  for (let i = 0; i < 6; i++) {
    addBox(g, lam(0xf2eee4), 0.07, 0.03, 0.05, -0.2 + (i % 3) * 0.14, 0.8, -0.14 + Math.floor(i / 3) * 0.1);
  }
  const seatMat = lam(0x6f7f8a);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const chair = new THREE.Group();
    chair.position.set(Math.cos(a) * 0.75, 0, Math.sin(a) * 0.75);
    chair.rotation.y = -a + Math.PI / 2;
    addBox(chair, seatMat, 0.36, 0.05, 0.36, 0, 0.42, 0);
    addBox(chair, seatMat, 0.36, 0.42, 0.05, 0, 0.62, -0.16);
    for (const [sx, sz] of [
      [-0.14, -0.14],
      [0.14, -0.14],
      [-0.14, 0.14],
      [0.14, 0.14],
    ]) {
      addBox(chair, lam(0x3a3f45), 0.035, 0.42, 0.035, sx, 0.21, sz);
    }
    g.add(chair);
  }
  parent.add(g);
  return g;
}

// ─────────────────────────── 零售／餐飲 ───────────────────────────

/** 卡位（茶餐廳）。 */
export function addBooth(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const green = lam(0x2f7a5a);
  const greenDark = lam(0x255f46);
  const vinyl = lam(0xc9b28a);
  for (const side of [-1, 1]) {
    addBox(g, green, 1.5, 0.42, 0.5, 0, 0.22, side * 0.62);
    addBox(g, greenDark, 1.5, 0.72, 0.14, 0, 0.72, side * 0.85);
    addBox(g, vinyl, 1.44, 0.1, 0.46, 0, 0.46, side * 0.62);
    addBox(g, vinyl, 1.44, 0.1, 0.1, 0, 0.7, side * 0.78);
  }
  addBox(g, lam(0xe8e4dc), 1.3, 0.06, 0.7, 0, 0.72, 0);
  for (const [sx, sz] of [
    [-0.5, -0.2],
    [0.5, -0.2],
    [-0.5, 0.2],
    [0.5, 0.2],
  ]) {
    addBox(g, lam(0x9aa0a6), 0.04, 0.7, 0.04, sx, 0.35, sz);
  }
  parent.add(g);
  return g;
}

/** 奶茶杯＋碟。 */
export function addMilkTea(parent: THREE.Object3D, x: number, y: number, z: number, plate = true): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  if (plate) addCyl(g, lam(0xe8e4d8), 0.12, 0.1, 0.015, 0, 0.008, 0, 12);
  addCyl(g, lam(0xf2eee4), 0.07, 0.055, 0.14, 0, 0.08, 0, 12);
  addCyl(g, lam(0xc9a46a), 0.062, 0.05, 0.05, 0, 0.11, 0, 12);
  addCyl(g, lam(0xe8e0cc), 0.072, 0.06, 0.015, 0, 0.15, 0, 12);
  parent.add(g);
  return g;
}

/** 圓凳。 */
export function addRoundStool(parent: THREE.Object3D, x: number, z: number, h = 0.45, color = 0xd94a3f): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addCyl(g, lam(color), 0.18, 0.17, 0.06, 0, h, 0, 12);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    addCyl(g, lam(0x8a8f96), 0.015, 0.02, h, Math.cos(a) * 0.13, h / 2, Math.sin(a) * 0.13, 5);
  }
  parent.add(g);
  return g;
}

/** 餐牌。 */
export function addMenuBoard(parent: THREE.Object3D, x: number, y: number, z: number, ry = 0, w = 0.9, h = 1.3, standing = false): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  addBox(g, lam(0x6f4a2a), w + 0.06, h + 0.06, 0.04, 0, 0, 0);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), menuMat());
  face.position.z = 0.025;
  g.add(face);
  if (standing) addBox(g, lam(0x5c3f24), w * 0.9, 0.05, 0.3, 0, -h / 2 - 0.02, 0.1);
  parent.add(g);
  return g;
}

/** 飲品櫃（發光）。 */
export function addDrinkFridge(parent: THREE.Object3D, x: number, z: number, ry = 0, w = 1.1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x2a3036), w, 2.0, 0.6, 0, 1.0, 0);
  addBox(g, basic(0xdff2ff), w - 0.16, 1.66, 0.04, 0, 1.08, -0.18);
  const drinkColors = [0xd94a3f, 0xe0b33a, 0x3f7fb0, 0x3f9a6a, 0x8f6f4a, 0xd9d4c8];
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i < 5; i++) {
      addBox(g, lam(drinkColors[(row + i) % drinkColors.length]), 0.1, 0.22, 0.1, -w / 2 + 0.2 + (i * (w - 0.36)) / 4, 0.46 + row * 0.4, 0.02);
    }
  }
  addBox(g, glass(0xbfe0ea, 0.18), w - 0.1, 1.78, 0.02, 0, 1.06, 0.28);
  addBox(g, lam(0x8f9599), 0.04, 0.7, 0.06, -0.2, 1.04, 0.33);
  addBox(g, lam(0x8f9599), 0.04, 0.7, 0.06, 0.2, 1.04, 0.33);
  addBox(g, lam(0x9a1f18), w, 0.26, 0.62, 0, 2.1, 0);
  parent.add(g);
  return g;
}

/** 貨架（便利店／超市）。 */
export function addShelfUnit(
  parent: THREE.Object3D,
  x: number,
  z: number,
  ry = 0,
  opts: { w?: number; h?: number; levels?: number; goods?: number[]; label?: string } = {},
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const w = opts.w ?? 1.6;
  const h = opts.h ?? 1.9;
  const levels = opts.levels ?? 4;
  const goods = opts.goods ?? [0xe0a84f, 0x5fa8c9, 0xc76bd1, 0xd94a3f, 0x5cff9d, 0xd9c25a];
  addBox(g, lam(0xd8d4c8), w, h, 0.06, 0, h / 2, -0.24);
  for (const side of [-1, 1]) addBox(g, lam(0xb0aca0), 0.04, h, 0.52, side * (w / 2 - 0.02), h / 2, 0);
  for (let i = 0; i < levels; i++) {
    const yy = 0.16 + (h - 0.3) * (i / Math.max(1, levels - 1));
    addBox(g, lam(0xe4e0d4), w - 0.06, 0.04, 0.5, 0, yy, 0);
    const count = Math.max(2, Math.floor((w - 0.16) / 0.16));
    for (let j = 0; j < count; j++) {
      const color = goods[(i * 3 + j) % goods.length];
      addBox(g, lam(color), 0.11, 0.16 + ((j * 7) % 3) * 0.03, 0.12, -w / 2 + 0.12 + j * 0.16, yy + 0.1, 0.02);
    }
  }
  addBox(g, lam(0xf2f0e6), w - 0.1, 0.09, 0.02, 0, 0.3, 0.26);
  if (opts.label) addBox(g, lam(0xd93f3f), w * 0.6, 0.2, 0.03, 0, h + 0.12, 0);
  parent.add(g);
  return g;
}

/** 收銀櫃檯＋收銀機。 */
export function addCashierCounter(parent: THREE.Object3D, x: number, z: number, ry = 0, w = 2.2): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x6f8f9a), w, 0.9, 0.62, 0, 0.45, 0);
  addBox(g, lam(0xe8e4dc), w + 0.06, 0.06, 0.68, 0, 0.93, 0);
  addBox(g, lam(0x4f6f7a), w, 0.3, 0.02, 0, 0.5, 0.32);
  addBox(g, lam(0x2a2f36), 0.36, 0.26, 0.3, -w / 4, 1.08, 0);
  addBox(g, basic(0x7fe0b0), 0.24, 0.14, 0.02, -w / 4, 1.18, 0.16);
  addBox(g, lam(0x3a3f45), 0.3, 0.04, 0.2, -w / 4, 1.0, 0.2);
  addBox(g, lam(0x1f2429), 0.16, 0.12, 0.16, w / 4, 1.03, 0);
  addBox(g, lam(0xd94a3f), 0.14, 0.2, 0.1, w / 4 + 0.2, 1.06, 0.1);
  addCyl(g, lam(0xbfe0ea), 0.035, 0.03, 0.12, w / 4 - 0.2, 1.06, 0.1, 8);
  parent.add(g);
  return g;
}

/** 購物車。 */
export function addShoppingCart(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const wire = lam(0x9aa0a6);
  addBox(g, wire, 0.5, 0.3, 0.7, 0, 0.55, 0);
  addBox(g, lam(0x8a9096), 0.5, 0.02, 0.7, 0, 0.4, 0);
  for (let i = 0; i < 5; i++) addCyl(g, wire, 0.01, 0.01, 0.66, -0.22 + i * 0.11, 0.55, 0, 4);
  addBox(g, lam(0xd94a3f), 0.14, 0.1, 0.04, 0, 0.78, 0.34);
  for (const [sx, sz] of [
    [-0.2, -0.26],
    [0.2, -0.26],
    [-0.2, 0.26],
    [0.2, 0.26],
  ]) {
    addCyl(g, lam(0x2a2f36), 0.05, 0.05, 0.04, sx, 0.06, sz, 8, 0, Math.PI / 2);
  }
  parent.add(g);
  return g;
}

/** 街市檔口（菜／肉／魚）。 */
export function addWetStall(
  parent: THREE.Object3D,
  x: number,
  z: number,
  ry = 0,
  kind: 'veg' | 'meat' | 'fish' = 'veg',
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0xb9b3a4), 2.2, 0.08, 0.9, 0, 0.86, 0);
  addBox(g, lam(0x9a9488), 2.16, 0.78, 0.86, 0, 0.43, 0);
  addRedPlasticLamp(g, 0, 2.3, 0);
  if (kind === 'veg') {
    for (let i = 0; i < 4; i++) {
      addBox(g, lam(0xe4e0d4), 0.6, 0.24, 0.4, -0.75 + i * 0.5, 1.02, 0.05);
      addSphere(g, lam(i % 2 ? 0x5f9a4a : 0x7ab05a), 0.2, -0.75 + i * 0.5, 1.2, 0.05, 8, 6);
      addSphere(g, lam(0x4f8a3a), 0.14, -0.7 + i * 0.5, 1.26, -0.04, 8, 6);
    }
    addCyl(g, lam(0x9a7a4a), 0.16, 0.14, 0.18, 0.9, 1.0, 0.2, 10);
    addBox(g, lam(0xf2f0e6), 0.2, 0.14, 0.01, -0.4, 1.28, 0.28);
  } else if (kind === 'meat') {
    addCyl(g, lam(0x8a8f96), 0.015, 0.015, 2.0, 0, 1.9, 0, 5, 0, Math.PI / 2);
    for (let i = 0; i < 3; i++) {
      addBox(g, lam(0xc96b6b), 0.3, 0.55, 0.22, -0.6 + i * 0.6, 1.5, 0.1);
      addBox(g, lam(0xd98f8f), 0.22, 0.1, 0.18, -0.6 + i * 0.6, 1.78, 0.1);
      addCyl(g, lam(0xd9d4c8), 0.012, 0.012, 0.28, -0.6 + i * 0.6, 1.9, 0.1, 4);
    }
    addBox(g, lam(0xc9a46a), 0.5, 0.06, 0.32, 0.55, 0.94, 0.1);
    addBox(g, lam(0x9aa0a6), 0.26, 0.02, 0.06, 0.62, 0.99, 0.1);
    addBox(g, lam(0x8a3a2a), 0.1, 0.04, 0.04, 0.78, 0.99, 0.1);
    addBox(g, lam(0xd94a3f), 0.4, 0.1, 0.3, -0.5, 0.95, 0.1);
  } else {
    addBox(g, lam(0xdfeef2), 1.6, 0.1, 0.7, 0, 0.94, 0);
    for (let i = 0; i < 5; i++) {
      addBox(g, lam(0x8fb0bf), 0.3, 0.08, 0.12, -0.6 + i * 0.3, 1.0, -0.1, 0.1);
      addCone(g, lam(0x6f9aaf), 0.06, 0.12, -0.6 + i * 0.3, 1.06, 0.12, 6, 0);
    }
    addBox(g, glass(0x9fd0e0, 0.3), 0.7, 0.4, 0.5, 0.7, 1.12, 0.1);
    addBox(g, lam(0x3f6f7a), 0.66, 0.28, 0.46, 0.7, 1.06, 0.1);
    addCyl(g, lam(0xd94a3f), 0.2, 0.17, 0.3, -0.9, 1.02, 0.15, 10);
  }
  addBox(g, lam(0xf2f0e6), 0.26, 0.18, 0.02, 0.2, 1.1, 0.42);
  addBox(g, lam(0xd9d4c8), 0.16, 0.22, 0.02, -0.2, 1.12, 0.42);
  parent.add(g);
  return g;
}

/** 紅色膠燈罩（街市）— 會發光。 */
export function addRedPlasticLamp(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  addCyl(g, lam(0x2a2f36), 0.012, 0.012, 0.5, 0, 0.25, 0, 4);
  addCyl(g, basic(0xff3a2a), 0.24, 0.1, 0.14, 0, -0.02, 0, 14);
  addSphere(g, basic(0xffe0b0), 0.07, 0, -0.1, 0, 8, 6);
  markAnim(g, 'glow');
  parent.add(g);
  return g;
}

/** 點心車。 */
export function addDimSumCart(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const steel = lam(0xc9ced2);
  addBox(g, steel, 1.2, 0.9, 0.7, 0, 0.62, 0);
  addBox(g, lam(0xd8d4c8), 1.24, 0.05, 0.74, 0, 1.08, 0);
  for (let i = 0; i < 3; i++) {
    addCyl(g, lam(0xd9c9a0), 0.16, 0.16, 0.1, -0.36 + i * 0.36, 1.16, -0.1, 12);
    addCyl(g, lam(0xc9b98a), 0.14, 0.14, 0.06, -0.36 + i * 0.36, 1.24, -0.1, 12);
    addSphere(g, lam(0xf2eee4), 0.06, -0.36 + i * 0.36, 1.28, -0.1, 6, 5);
  }
  addBox(g, lam(0xd9c9a0), 0.5, 0.24, 0.4, 0.3, 0.84, 0.1);
  for (const [sx, sz] of [
    [-0.42, -0.3],
    [0.42, -0.3],
  ]) {
    addCyl(g, lam(0x2a2f36), 0.11, 0.11, 0.05, sx, 0.12, sz, 10, 0, Math.PI / 2);
  }
  addBox(g, lam(0x8a8f96), 0.05, 0.7, 0.05, -0.55, 0.5, -0.34);
  addBox(g, lam(0x8a8f96), 0.05, 0.7, 0.05, 0.55, 0.5, -0.34);
  markAnim(g, 'bob');
  parent.add(g);
  return g;
}

/** 酒樓大圓枱。 */
export function addRoundDiningTable(parent: THREE.Object3D, x: number, z: number, r = 1.1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addCyl(g, lam(0xf2eee4), r, r, 0.07, 0, 0.74, 0, 24);
  addCyl(g, lam(0xcf9a6a), r * 0.98, r * 0.98, 0.02, 0, 0.78, 0, 24);
  addCyl(g, lam(0xd9d4c8), r * 0.42, r * 0.42, 0.03, 0, 0.81, 0, 18);
  addCyl(g, lam(0x8a6038), 0.16, 0.22, 0.72, 0, 0.36, 0, 10);
  addCyl(g, lam(0x6f4a2a), 0.5, 0.55, 0.06, 0, 0.03, 0, 14);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    addCyl(g, lam(0xf2eee4), 0.11, 0.1, 0.015, Math.cos(a) * r * 0.72, 0.79, Math.sin(a) * r * 0.72, 10);
    addCyl(g, lam(0xf6f2ea), 0.045, 0.04, 0.08, Math.cos(a) * r * 0.72, 0.83, Math.sin(a) * r * 0.72, 8);
  }
  addCyl(g, lam(0xf2f0e6), 0.1, 0.09, 0.16, 0.2, 0.85, 0.1, 10);
  addCyl(g, lam(0xd9c9a0), 0.14, 0.14, 0.09, -0.2, 0.83, -0.05, 12);
  const seat = lam(0xb0453c);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const chair = new THREE.Group();
    chair.position.set(Math.cos(a) * (r + 0.45), 0, Math.sin(a) * (r + 0.45));
    chair.rotation.y = -a + Math.PI / 2;
    addBox(chair, seat, 0.44, 0.06, 0.44, 0, 0.44, 0);
    addBox(chair, seat, 0.44, 0.52, 0.06, 0, 0.7, -0.2);
    for (const [sx, sz] of [
      [-0.18, -0.18],
      [0.18, -0.18],
      [-0.18, 0.18],
      [0.18, 0.18],
    ]) {
      addBox(chair, lam(0x6f4a2a), 0.04, 0.44, 0.04, sx, 0.22, sz);
    }
    g.add(chair);
  }
  parent.add(g);
  return g;
}

/** 紅色中式吊燈（會搖擺）。 */
export function addRedLantern(parent: THREE.Object3D, x: number, y: number, z: number, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.scale.setScalar(scale);
  addCyl(g, lam(0x2a2f36), 0.01, 0.01, 0.5, 0, 0.25, 0, 4);
  addSphere(g, basic(0xd93a2a), 0.2, 0, -0.1, 0, 12, 8);
  addCyl(g, lam(0xc9a24c), 0.1, 0.12, 0.05, 0, 0.05, 0, 10);
  addCyl(g, lam(0xc9a24c), 0.12, 0.1, 0.05, 0, -0.24, 0, 10);
  addCyl(g, lam(0xd9c25a), 0.02, 0.02, 0.24, 0, -0.4, 0, 5);
  markAnim(g, 'lantern');
  parent.add(g);
  return g;
}

// ─────────────────────────── 商場／商廈 ───────────────────────────

/** 扶手電梯（踏板貼圖會滾動）。 */
export function addEscalator(parent: THREE.Object3D, x: number, z: number, ry = 0, len = 5, rise = 2.2): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const angle = Math.atan2(rise, len);
  const bandLen = Math.hypot(len, rise);
  const steps = new THREE.Mesh(new THREE.PlaneGeometry(0.9, bandLen), escalatorMat());
  steps.rotation.x = -Math.PI / 2 + angle;
  steps.position.set(0, rise / 2 + 0.1, 0);
  markAnim(steps, 'escalator');
  g.add(steps);
  for (const side of [-1, 1]) {
    const rail = addBox(g, lam(0x2f3337), 0.06, 0.06, bandLen, side * 0.48, rise / 2 + 0.52, 0);
    rail.rotation.x = -angle;
    const glassSide = addBox(g, glass(0xbfe0ea, 0.2), 0.04, 0.6, bandLen, side * 0.48, rise / 2 + 0.3, 0);
    glassSide.rotation.x = -angle;
    addBox(g, lam(0x8a8f96), 0.08, 0.9, 0.2, side * 0.48, 0.45, -len / 2 + 0.1);
    addBox(g, lam(0x8a8f96), 0.08, 0.9, 0.2, side * 0.48, rise + 0.45, len / 2 - 0.1);
  }
  addBox(g, lam(0x9aa0a6), 1.2, 0.1, 0.9, 0, 0.05, -len / 2 - 0.4);
  addBox(g, lam(0x9aa0a6), 1.2, 0.1, 0.9, 0, rise + 0.05, len / 2 + 0.4);
  parent.add(g);
  return g;
}

/** 商場店舖門面（招牌＋櫥窗）。 */
export function addShopFront(
  parent: THREE.Object3D,
  x: number,
  z: number,
  ry = 0,
  opts: { w?: number; h?: number; name?: string; color?: number } = {},
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const w = opts.w ?? 2.4;
  const h = opts.h ?? 2.6;
  const color = opts.color ?? IPAL.neonPink;
  addBox(g, lam(0x3a3f45), w, h, 0.14, 0, h / 2, 0);
  addBox(g, glass(0xdff2ff, 0.28), w - 0.4, h * 0.52, 0.03, 0, h * 0.34, 0.09);
  const signW = Math.min(w - 0.2, 2.0);
  addBox(g, lam(0x1a1d20), signW + 0.06, signW * 0.32, 0.06, 0, h * 0.8, 0.04);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(signW, signW * 0.3), neonSignMat(opts.name ?? '名店', color, false));
  sign.position.set(0, h * 0.8, 0.11);
  g.add(sign);
  addBox(g, lam(0xf2f0e6), w - 0.6, 0.06, 0.4, 0, 0.6, 0.22);
  addCyl(g, lam(0xd9c9a0), 0.08, 0.08, 0.34, -w / 4, 0.8, 0.24, 8);
  addBox(g, lam(0xb0aca0), 0.2, 0.34, 0.14, w / 4, 0.8, 0.24);
  parent.add(g);
  return g;
}

export function addOfficeDesk(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const desk = lam(0xd8d4c8);
  addBox(g, desk, 1.5, 0.05, 0.7, 0, 0.74, 0);
  for (const [sx, sz] of [
    [-0.68, -0.28],
    [0.68, -0.28],
    [-0.68, 0.28],
    [0.68, 0.28],
  ]) {
    addBox(g, lam(0x9aa0a6), 0.05, 0.72, 0.05, sx, 0.37, sz);
  }
  addBox(g, lam(0x22262a), 0.55, 0.34, 0.04, 0, 0.98, -0.2);
  addBox(g, basic(0x8fd8ff), 0.5, 0.29, 0.01, 0, 0.98, -0.17);
  addBox(g, lam(0x22262a), 0.16, 0.04, 0.12, 0, 0.78, -0.2);
  addBox(g, lam(0x2a2e33), 0.44, 0.02, 0.14, 0, 0.78, 0.12);
  addBox(g, lam(0x2a2e33), 0.06, 0.02, 0.1, 0.3, 0.78, 0.12);
  addBox(g, lam(0xf2f0e6), 0.3, 0.01, 0.22, -0.4, 0.77, 0.1, 0.1);
  addCyl(g, lam(0xf2f0e6), 0.045, 0.04, 0.1, 0.55, 0.81, -0.05, 8);
  const chair = new THREE.Group();
  chair.position.set(0, 0, 0.72);
  chair.rotation.y = Math.PI;
  addBox(chair, lam(0x2f3337), 0.5, 0.08, 0.5, 0, 0.46, 0);
  addBox(chair, lam(0x2f3337), 0.5, 0.6, 0.08, 0, 0.78, -0.24);
  addBox(chair, lam(0x5f656b), 0.06, 0.4, 0.06, 0, 0.22, 0);
  for (const [sx, sz] of [
    [-0.22, -0.22],
    [0.22, -0.22],
    [-0.22, 0.22],
    [0.22, 0.22],
  ]) {
    addBox(chair, lam(0x22262a), 0.05, 0.06, 0.05, sx, 0.05, sz);
  }
  g.add(chair);
  parent.add(g);
  return g;
}

export function addOfficePartition(parent: THREE.Object3D, x: number, z: number, ry = 0, len = 1.6): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x9fb8c0), len, 0.9, 0.05, 0, 0.85, 0);
  addBox(g, lam(0xcfd8dc), len, 0.06, 0.08, 0, 1.3, 0);
  addBox(g, lam(0x8a9096), 0.05, 0.8, 0.05, -len / 2 + 0.02, 0.4, 0);
  addBox(g, lam(0x8a9096), 0.05, 0.8, 0.05, len / 2 - 0.02, 0.4, 0);
  parent.add(g);
  return g;
}

export function addWaterCooler(parent: THREE.Object3D, x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addBox(g, lam(0xd8dde0), 0.42, 1.0, 0.42, 0, 0.5, 0);
  addCyl(g, lam(0x9fd0e0), 0.16, 0.16, 0.44, 0, 1.22, 0, 12);
  addBox(g, lam(0x6f8f9a), 0.1, 0.1, 0.06, 0, 0.7, 0.23);
  parent.add(g);
  return g;
}

export function addPrinter(parent: THREE.Object3D, x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addBox(g, lam(0xe4e2da), 0.7, 0.9, 0.6, 0, 0.45, 0);
  addBox(g, lam(0xd0cec5), 0.6, 0.2, 0.4, 0, 0.98, 0);
  addBox(g, lam(0x9aa0a6), 0.2, 0.1, 0.2, 0.2, 1.05, 0);
  addBox(g, lam(0xf2f0e6), 0.3, 0.02, 0.24, -0.15, 1.09, 0);
  parent.add(g);
  return g;
}

export function addWhiteboard(
  parent: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  ry = 0,
  w = 2.2,
  h = 1.1,
  title = '會議室',
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  addBox(g, lam(0xd8dde0), w, h, 0.06, 0, 0, 0);
  addBox(g, lam(0x8a9096), w + 0.08, 0.06, 0.08, 0, h / 2 + 0.04, 0);
  addBox(g, lam(0x8a9096), w + 0.08, 0.06, 0.08, 0, -h / 2 - 0.04, 0);
  const mat = signBoardMat(
    `whiteboard-${title}`,
    ['維港之城 2026 年度計劃', '• 交通：港鐵覆蓋 +12%', '• 房屋：公屋輪候 3.1 年', '• 財政：庫房 $8,000,000'],
    { bg: 0xf4f6f8, fg: '#1f3a5f', w: 256, h: 128, border: '#8fa6b8' },
  );
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.1, h - 0.1), mat);
  face.position.z = 0.035;
  g.add(face);
  parent.add(g);
  return g;
}

// ─────────────────────────── 工業／農業／物流 ───────────────────────────

/** 廠房機器（CNC／沖壓機）。 */
export function addMachine(parent: THREE.Object3D, x: number, z: number, ry = 0, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  g.scale.setScalar(scale);
  addBox(g, lam(0x4f6f5a), 1.4, 1.2, 0.9, 0, 0.6, 0);
  addBox(g, lam(0x3a3f45), 1.0, 0.5, 0.4, 0, 1.25, 0);
  addBox(g, lam(0x8a9096), 0.3, 0.9, 0.3, 0.3, 1.5, 0);
  addBox(g, lam(0x2a2f36), 0.5, 0.34, 0.1, -0.35, 1.3, 0.4);
  addBox(g, basic(0x7fe0b0), 0.4, 0.2, 0.01, -0.35, 1.32, 0.46);
  for (let i = 0; i < 3; i++) addCyl(g, lam(0xd94a3f), 0.02, 0.02, 0.02, -0.5 + i * 0.1, 1.2, 0.47, 6, 0, Math.PI / 2);
  addBox(g, lam(0xe0b33a), 0.5, 0.06, 0.02, 0.4, 1.12, 0.46);
  addCyl(g, lam(0x8a9096), 0.06, 0.06, 1.0, 0.6, 1.9, -0.2, 8);
  parent.add(g);
  return g;
}

/** 輸送帶。 */
export function addConveyor(parent: THREE.Object3D, x: number, z: number, ry = 0, len = 3.2): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x8a9096), len, 0.08, 0.7, 0, 0.8, 0);
  addBox(g, lam(0x2f3337), len, 0.06, 0.72, 0, 0.9, 0);
  for (let i = 0; i < 6; i++) addCyl(g, lam(0x9aa0a6), 0.04, 0.04, 0.7, -len / 2 + 0.2 + (i * (len - 0.4)) / 5, 0.82, 0, 8, 0, Math.PI / 2);
  for (const side of [-1, 1]) {
    addBox(g, lam(0x5f656b), 0.08, 0.8, 0.08, side * (len / 2 - 0.1), 0.4, 0.3);
    addBox(g, lam(0x5f656b), 0.08, 0.8, 0.08, side * (len / 2 - 0.1), 0.4, -0.3);
  }
  parent.add(g);
  return g;
}

export function addCardboardBoxes(parent: THREE.Object3D, x: number, z: number, count = 3, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  for (let i = 0; i < count; i++) {
    const s = (0.42 + (i % 3) * 0.06) * scale;
    const bx = (i % 2) * s * 1.1;
    const bz = Math.floor(i / 2) * s * 1.1;
    const by = (i % 4 === 3 ? s : 0) + s / 2;
    addBox(g, lam(i % 2 ? IPAL.cardboard : IPAL.cardboardDark), s, s, s, bx, by, bz, (i * 0.3) % 1.5);
    addBox(g, lam(0xd9d4c8), s * 0.5, 0.01, s * 0.7, bx, by + s / 2, bz);
  }
  parent.add(g);
  return g;
}

export function addPallet(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(IPAL.woodLight), 1.1, 0.06, 0.9, 0, 0.12, 0);
  for (const side of [-1, 0, 1]) addBox(g, lam(IPAL.wood), 1.1, 0.08, 0.12, 0, 0.05, side * 0.34);
  parent.add(g);
  return g;
}

/** 重型貨架（貨倉）。 */
export function addPalletRack(
  parent: THREE.Object3D,
  x: number,
  z: number,
  ry = 0,
  opts: { w?: number; h?: number; levels?: number } = {},
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const w = opts.w ?? 2.4;
  const h = opts.h ?? 2.6;
  const levels = opts.levels ?? 3;
  const steelDark = lam(0x5f656b);
  for (const side of [-1, 1]) {
    for (const sz of [-0.5, 0.5]) addBox(g, steelDark, 0.08, h, 0.08, side * (w / 2), h / 2, sz);
    for (let i = 0; i < levels; i++) addBox(g, steelDark, 0.06, 0.06, 1.1, side * (w / 2), 0.3 + (i * (h - 0.5)) / levels, 0);
  }
  for (let i = 0; i < levels; i++) {
    const yy = 0.3 + (i * (h - 0.5)) / levels;
    addBox(g, lam(0xc97a3a), w, 0.07, 1.1, 0, yy, 0);
    for (let j = 0; j < 2; j++) {
      const boxes = addCardboardBoxes(g, -w / 4 + j * (w / 2), 0, 2, 1);
      boxes.position.set(-w / 4 + j * (w / 2), yy + 0.04, 0);
      boxes.scale.setScalar(0.9);
    }
  }
  parent.add(g);
  return g;
}

export function addBarrelDrum(parent: THREE.Object3D, x: number, z: number, color = 0x3f6f9f): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addCyl(g, lam(color), 0.26, 0.26, 0.82, 0, 0.41, 0, 12);
  for (const y of [0.2, 0.62]) addCyl(g, lam(darkenColor(color, 0.75)), 0.27, 0.27, 0.06, 0, y, 0, 12);
  parent.add(g);
  return g;
}

/** 石礦場碎石機。 */
export function addCrusher(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x6f6a60), 2.4, 1.2, 1.6, 0, 0.9, 0);
  addBox(g, lam(0x8a9096), 1.2, 1.8, 1.2, -0.6, 1.9, 0);
  addCyl(g, lam(0x4f4a44), 0.5, 0.5, 1.0, -0.6, 2.4, 0, 12, 0, Math.PI / 2);
  const chute = addBox(g, lam(0x8a9096), 0.9, 0.1, 2.4, 0.9, 1.7, 0);
  chute.rotation.x = -0.5;
  for (const [sx, sz] of [
    [-0.9, -0.7],
    [0.9, -0.7],
    [-0.9, 0.7],
    [0.9, 0.7],
  ]) {
    addBox(g, lam(0x5f656b), 0.14, 1.0, 0.14, sx, 0.5, sz);
  }
  parent.add(g);
  return g;
}

/** 石堆。 */
export function addRockPile(parent: THREE.Object3D, x: number, z: number, count = 5, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const mats = [lam(0x8a877e), lam(0x75726b), lam(0x9a978d)];
  for (let i = 0; i < count; i++) {
    const s = (0.28 + ((i * 37) % 23) / 100) * scale;
    const rock = addSphere(g, mats[i % 3], s, ((i % 3) - 1) * s * 1.4, s * 0.7 + (i % 2) * s * 0.6, (((i * 7) % 3) - 1) * s * 1.1, 7, 5);
    rock.scale.set(1.2, 0.72, 1);
  }
  parent.add(g);
  return g;
}

export function addDumpTruck(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0xd9b23f), 2.6, 0.5, 1.2, 0, 0.75, 0);
  addBox(g, lam(0x9a978d), 1.6, 0.7, 1.2, -0.55, 1.35, 0, 0.12);
  addBox(g, lam(0x2f5f8f), 1.0, 1.0, 1.1, 0.9, 1.25, 0);
  addBox(g, basic(0x9fd8ff), 0.8, 0.4, 0.04, 0.9, 1.45, 0.56);
  for (const [sx, sz] of [
    [-0.9, -0.55],
    [-0.9, 0.55],
    [0.9, -0.55],
    [0.9, 0.55],
  ]) {
    addCyl(g, lam(0x22262a), 0.28, 0.28, 0.18, sx, 0.32, sz, 12, 0, Math.PI / 2);
  }
  parent.add(g);
  return g;
}

/** 農具角落（鋤頭、水桶、竹籮、斗笠）。 */
export function addFarmTools(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  // 鋤頭
  addCyl(g, lam(IPAL.wood), 0.025, 0.03, 1.5, -0.3, 0.75, 0, 6);
  addBox(g, lam(0x8a9096), 0.3, 0.08, 0.06, -0.3, 1.45, 0.1, 0.5);
  // 水桶
  addCyl(g, lam(0x3f7fb0), 0.2, 0.16, 0.32, 0.2, 0.16, 0.2, 12);
  addCyl(g, lam(0x2f5f8f), 0.21, 0.21, 0.03, 0.2, 0.3, 0.2, 12);
  addCyl(g, lam(0x9fd0e0), 0.18, 0.18, 0.02, 0.2, 0.26, 0.2, 12);
  // 竹籮
  addLathe(g, lam(IPAL.bamboo), [
    [0.001, 0],
    [0.26, 0.02],
    [0.3, 0.3],
    [0.28, 0.34],
  ], -0.1, 0, 0.35, 10);
  // 斗笠
  const hat = addCone(g, lam(0xc9a46a), 0.34, 0.2, 0.45, 0.12, 0.1, 12);
  hat.rotation.z = 0.2;
  // 蔬菜籃
  addBox(g, lam(0x5f9a4a), 0.4, 0.14, 0.28, -0.5, 0.12, -0.2);
  addBox(g, lam(0x7ab05a), 0.36, 0.1, 0.24, -0.5, 0.24, -0.2);
  parent.add(g);
  return g;
}

/** 菜籮／菜箱（農田）。 */
export function addVegCrate(parent: THREE.Object3D, x: number, z: number, ry = 0, count = 3): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  for (let i = 0; i < count; i++) {
    const bx = (i % 2) * 0.55;
    const bz = Math.floor(i / 2) * 0.45;
    addBox(g, lam(0x5f9a4a), 0.48, 0.2, 0.36, bx, 0.1, bz);
    addSphere(g, lam(0x7ab05a), 0.16, bx, 0.24, bz, 7, 5);
    addSphere(g, lam(0x4f8a3a), 0.12, bx + 0.08, 0.28, bz + 0.04, 7, 5);
  }
  parent.add(g);
  return g;
}

/** 溫室棚架。 */
export function addGreenhouse(parent: THREE.Object3D, x: number, z: number, ry = 0, w = 3.0, d = 2.0, h = 2.2): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const frame = lam(0xc9ced2);
  for (const sx of [-w / 2, w / 2]) {
    for (const sz of [-d / 2, d / 2]) addCyl(g, frame, 0.03, 0.03, h, sx, h / 2, sz, 6);
  }
  addBox(g, frame, w + 0.1, 0.06, 0.06, 0, h, -d / 2);
  addBox(g, frame, w + 0.1, 0.06, 0.06, 0, h, d / 2);
  for (let i = 1; i < 4; i++) addCyl(g, frame, 0.02, 0.02, h, -w / 2 + (i * w) / 4, h / 2, -d / 2, 5);
  addBox(g, glass(0xd8f0f0, 0.18), w, h, 0.02, 0, h / 2, -d / 2);
  addBox(g, glass(0xd8f0f0, 0.18), w, h, 0.02, 0, h / 2, d / 2);
  addBox(g, glass(0xd8f0f0, 0.18), 0.02, h, d, -w / 2, h / 2, 0);
  const roof = addBox(g, glass(0xd8f0f0, 0.22), w, 0.02, d, 0, h + 0.02, 0);
  roof.rotation.x = 0.04;
  // 菜苗
  for (let i = 0; i < 6; i++) {
    addBox(g, lam(0x8a6038), w - 0.4, 0.12, 0.3, 0, 0.08, -d / 3 + (i % 3) * 0.45);
    addSphere(g, lam(0x5f9a4a), 0.11, -w / 3 + (i % 4) * 0.5, 0.24, -d / 3 + Math.floor(i / 3) * 0.6, 6, 5);
  }
  parent.add(g);
  return g;
}

/** 貨辦架（進口商行樣板貨）。 */
export function addSampleShelf(parent: THREE.Object3D, x: number, z: number, ry = 0, w = 2.0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x7a5a38), w, 2.1, 0.5, 0, 1.05, 0);
  for (let i = 0; i < 3; i++) {
    addBox(g, lam(0x9a7a52), w + 0.06, 0.05, 0.56, 0, 0.55 + i * 0.55, 0);
    // 貨辦：罐頭、盒裝、樽裝
    for (let j = 0; j < 4; j++) {
      const colors = [0xd94a3f, 0x4fa3c9, 0xe0b33a, 0x5f9a4a];
      if (j % 2 === 0) {
        addCyl(g, lam(colors[j % 4]), 0.07, 0.07, 0.16, -w / 2 + 0.25 + j * 0.5, 0.68 + i * 0.55, 0.05, 8);
        addCyl(g, lam(0xd9d4c8), 0.062, 0.062, 0.02, -w / 2 + 0.25 + j * 0.5, 0.77 + i * 0.55, 0.05, 8);
      } else {
        addBox(g, lam(colors[j % 4]), 0.18, 0.26, 0.14, -w / 2 + 0.25 + j * 0.5, 0.72 + i * 0.55, 0.05);
        addBox(g, lam(0xf2f0e6), 0.12, 0.1, 0.01, -w / 2 + 0.25 + j * 0.5, 0.74 + i * 0.55, 0.13);
      }
    }
  }
  addBox(g, lam(0x5f8faf), w * 0.8, 0.2, 0.03, 0, 1.95, 0.2);
  parent.add(g);
  return g;
}

/** 寫字枱（商行／貨倉辦公）。 */
export function addDocumentDesk(parent: THREE.Object3D, x: number, z: number, ry = 0, w = 1.6): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x8a6038), w, 0.06, 0.75, 0, 0.76, 0);
  for (const [sx, sz] of [
    [-w / 2 + 0.08, -0.3],
    [w / 2 - 0.08, -0.3],
    [-w / 2 + 0.08, 0.3],
    [w / 2 - 0.08, 0.3],
  ]) {
    addBox(g, lam(0x5c3f24), 0.07, 0.76, 0.07, sx, 0.38, sz);
  }
  // 文件、單據、計數機、電話、印章
  addBox(g, lam(0xf2f0e6), 0.34, 0.02, 0.26, -0.3, 0.8, 0.1, 0.15);
  addBox(g, lam(0xe8e2d0), 0.3, 0.02, 0.24, -0.28, 0.82, 0.08, -0.1);
  addBox(g, lam(0x2a2f36), 0.18, 0.03, 0.24, 0.3, 0.8, 0.1);
  addBox(g, lam(0x1a1d20), 0.2, 0.08, 0.16, 0.45, 0.84, -0.15);
  for (let i = 0; i < 4; i++) addBox(g, lam(0xd9d4c8), 0.05, 0.02, 0.05, 0.38 + (i % 2) * 0.1, 0.86, -0.18 + Math.floor(i / 2) * 0.07);
  addCyl(g, lam(0xb02a2a), 0.03, 0.03, 0.06, -0.5, 0.82, -0.12, 8);
  parent.add(g);
  return g;
}

/** 電話（枱頭電話）。 */
export function addTelephone(parent: THREE.Object3D, x: number, y: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  addBox(g, lam(0x1f2429), 0.22, 0.07, 0.18, 0, 0.035, 0);
  addBox(g, lam(0x2a3036), 0.22, 0.05, 0.06, 0, 0.1, 0);
  addCyl(g, lam(0x2a3036), 0.015, 0.015, 0.12, 0.09, 0.12, 0.03, 5, 0, Math.PI / 2);
  for (let i = 0; i < 6; i++) addCyl(g, lam(0xd9d4c8), 0.012, 0.012, 0.01, -0.06 + (i % 3) * 0.06, 0.012, 0.02 + Math.floor(i / 3) * 0.05, 6);
  parent.add(g);
  return g;
}

/** 文件櫃（報關文件）。 */
export function addFilingCabinet(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x8a9096), 0.7, 1.5, 0.6, 0, 0.75, 0);
  for (let i = 0; i < 4; i++) {
    addBox(g, lam(0x9aa0a6), 0.62, 0.3, 0.03, 0, 0.28 + i * 0.35, 0.31);
    addBox(g, lam(0x5f656b), 0.2, 0.03, 0.05, 0, 0.28 + i * 0.35, 0.34);
    addBox(g, lam(0xf2f0e6), 0.16, 0.06, 0.01, -0.18, 0.3 + i * 0.35, 0.33);
  }
  parent.add(g);
  return g;
}

/** 手推車（物流）。 */
export function addHandTruck(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x9aa0a6), 0.5, 0.06, 0.3, 0, 0.08, 0);
  for (const side of [-1, 1]) addCyl(g, lam(0x8a9096), 0.02, 0.02, 0.7, side * 0.2, 0.4, -0.1, 5);
  addBox(g, lam(0x8a9096), 0.44, 0.04, 0.04, 0, 0.72, -0.1);
  for (const side of [-1, 1]) addCyl(g, lam(0x1a1d20), 0.08, 0.08, 0.05, side * 0.2, 0.09, 0.1, 8, 0, Math.PI / 2);
  addBox(g, lam(IPAL.cardboard), 0.4, 0.34, 0.28, 0, 0.26, 0);
  parent.add(g);
  return g;
}

// ─────────────────────────── 公用設施 ───────────────────────────

/** 發電廠渦輪發電機。 */
export function addTurbine(parent: THREE.Object3D, x: number, z: number, ry = 0, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  g.scale.setScalar(scale);
  addBox(g, lam(0x6f757b), 2.6, 0.5, 1.2, 0, 0.25, 0);
  addCyl(g, lam(0x9aa0a6), 0.6, 0.6, 2.6, 0, 1.1, 0, 16, Math.PI / 2);
  for (let i = 0; i < 3; i++) addCyl(g, lam(0xc9a24c), 0.64, 0.64, 0.12, -0.8 + i * 0.8, 1.1, 0, 16, Math.PI / 2);
  addCyl(g, lam(0x4f555b), 0.3, 0.3, 0.9, 1.3, 1.1, 0, 12, 0, Math.PI / 2);
  addBox(g, lam(0x3a3f45), 0.5, 0.6, 0.4, -1.5, 1.0, 0);
  markAnim(g, 'bob');
  parent.add(g);
  return g;
}

/** 控制台。 */
export function addControlPanel(parent: THREE.Object3D, x: number, z: number, ry = 0, w = 3.2): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x3a4048), w, 1.0, 0.6, 0, 0.5, 0);
  addBox(g, lam(0x24292f), w, 0.5, 0.1, 0, 1.2, -0.24);
  const lightColors = [0x5cff9d, 0xffd166, 0x24e0ff, 0xff3d7f, 0x5cff9d, 0x24e0ff];
  for (let i = 0; i < 14; i++) {
    addBox(
      g,
      basic(lightColors[i % lightColors.length]),
      0.06,
      0.06,
      0.02,
      -w / 2 + 0.2 + (i % 7) * ((w - 0.4) / 6),
      1.05 + Math.floor(i / 7) * 0.2,
      -0.18,
    );
  }
  addBox(g, lam(0x1a1d20), w * 0.45, 0.4, 0.06, w * 0.22, 1.5, -0.1);
  addBox(g, basic(0x2f9f7f), w * 0.4, 0.32, 0.01, w * 0.22, 1.5, -0.06);
  addBox(g, lam(0x8a9096), w * 0.6, 0.05, 0.3, 0, 1.02, 0.2);
  parent.add(g);
  return g;
}

/** 水管。 */
export function addPipeRun(
  parent: THREE.Object3D,
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  y: number,
  thickness = 0.12,
  color = 0x8a9096,
): THREE.Group {
  const g = new THREE.Group();
  addBeam(g, lam(color), x1, y, z1, x2, y, z2, thickness);
  addCyl(g, lam(darkenColor(color, 0.8)), thickness * 0.9, thickness * 0.9, thickness * 0.7, (x1 + x2) / 2, y + thickness * 0.4, (z1 + z2) / 2, 8);
  parent.add(g);
  return g;
}

/** 閥門輪。 */
export function addValveWheel(parent: THREE.Object3D, x: number, y: number, z: number, r = 0.22): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  addCyl(g, lam(0x9aa0a6), 0.03, 0.03, 0.2, 0, 0, 0, 6, 0, Math.PI / 2);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    addBox(g, lam(0xd94a3f), r, 0.03, 0.03, Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, 0.03, a);
  }
  addCyl(g, lam(0xd94a3f), r, r, 0.03, 0, 0, 0, 16, 0, Math.PI / 2);
  parent.add(g);
  return g;
}

/** 濾水池（水務設施）。 */
export function addFilterTank(parent: THREE.Object3D, x: number, z: number, w = 2.4, d = 1.8): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addBox(g, lam(0x9aa0a6), w, 0.9, d, 0, 0.45, 0);
  addBox(g, lam(0x6f9aa6), w - 0.2, 0.06, d - 0.2, 0, 0.9, 0);
  addBox(g, basic(0x5f9fb0), w - 0.4, 0.02, d - 0.4, 0, 0.93, 0);
  for (const side of [-1, 1]) {
    addBox(g, lam(0xd9b23f), w, 0.05, 0.05, 0, 1.15, side * (d / 2 - 0.05));
    for (let i = 0; i < 4; i++) addBox(g, lam(0xd9b23f), 0.05, 0.3, 0.05, -w / 2 + 0.1 + (i * (w - 0.2)) / 3, 1.0, side * (d / 2 - 0.05));
  }
  for (let i = 0; i < 5; i++) addCyl(g, lam(0x9fd0e0), 0.03, 0.01, 0.1, -w / 3 + (i * w) / 6, 1.0, 0, 5);
  parent.add(g);
  return g;
}

// ─────────────────────────── 公共設施 ───────────────────────────

/** 課室枱＋凳（可坐學生）。 */
export function addClassroomDesk(parent: THREE.Object3D, x: number, z: number, ry = 0, occupied = true): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const wood = lam(0xc9a46a);
  addBox(g, wood, 0.7, 0.05, 0.5, 0, 0.72, 0);
  addBox(g, lam(0x8a6038), 0.06, 0.7, 0.06, -0.3, 0.36, -0.2);
  addBox(g, lam(0x8a6038), 0.06, 0.7, 0.06, 0.3, 0.36, -0.2);
  addBox(g, lam(0x8a6038), 0.06, 0.7, 0.06, -0.3, 0.36, 0.2);
  addBox(g, lam(0x8a6038), 0.06, 0.7, 0.06, 0.3, 0.36, 0.2);
  addBox(g, lam(0xd94a3f), 0.22, 0.03, 0.3, -0.1, 0.76, 0);
  addBox(g, lam(0x3f7fb0), 0.2, 0.03, 0.28, -0.08, 0.79, 0.02, 0.1);
  addBox(g, lam(0xf2f0e6), 0.1, 0.01, 0.14, 0.2, 0.75, 0.05);
  addCyl(g, lam(0x5c3f24), 0.012, 0.012, 0.16, 0.22, 0.8, 0.02, 5, 0, 1.2);
  addBox(g, lam(0x9a7a52), 0.4, 0.04, 0.36, 0, 0.42, 0.62);
  for (const [sx, sz] of [
    [-0.16, 0.5],
    [0.16, 0.5],
    [-0.16, 0.74],
    [0.16, 0.74],
  ]) {
    addBox(g, lam(0x6f4a2a), 0.04, 0.42, 0.04, sx, 0.21, sz);
  }
  if (occupied) addPerson(g, { x: 0, z: 0.64, ry: Math.PI, kind: 'student', pose: 'sit', scale: 0.94 });
  parent.add(g);
  return g;
}

export function addTeacherDesk(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x9a7a52), 1.6, 0.08, 0.7, 0, 0.82, 0);
  for (const [sx, sz] of [
    [-0.7, -0.28],
    [0.7, -0.28],
    [-0.7, 0.28],
    [0.7, 0.28],
  ]) {
    addBox(g, lam(0x6f4a2a), 0.07, 0.8, 0.07, sx, 0.4, sz);
  }
  addBox(g, lam(0xf2f0e6), 0.3, 0.02, 0.22, 0.3, 0.87, 0.05, 0.1);
  addBox(g, lam(0x3f7fb0), 0.26, 0.04, 0.32, -0.3, 0.88, 0);
  addCyl(g, lam(0xd94a3f), 0.03, 0.03, 0.1, 0.6, 0.9, 0.1, 6);
  addPerson(g, { x: 0, z: -0.9, ry: 0, kind: 'teacher' });
  parent.add(g);
  return g;
}

/** 病床（含簾、點滴、床頭櫃）。 */
export function addHospitalBed(parent: THREE.Object3D, x: number, z: number, ry = 0, occupied = false): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const frame = lam(0xb9bec2);
  addBox(g, frame, 1.0, 0.12, 2.0, 0, 0.5, 0);
  addBox(g, lam(0xf2f4f4), 0.92, 0.16, 1.9, 0, 0.62, 0);
  addBox(g, lam(0xbfe0d8), 0.9, 0.06, 1.3, 0, 0.72, 0.22);
  addBox(g, lam(0xf6f8f8), 0.5, 0.1, 0.3, 0, 0.74, -0.72);
  for (const [sx, sz] of [
    [-0.45, -0.9],
    [0.45, -0.9],
    [-0.45, 0.9],
    [0.45, 0.9],
  ]) {
    addCyl(g, lam(0x8a9096), 0.025, 0.025, 0.5, sx, 0.25, sz, 6);
  }
  for (const side of [-1, 1]) {
    addBox(g, frame, 0.95, 0.5, 0.05, 0, 0.75, side * 0.98);
    for (let i = 0; i < 4; i++) addCyl(g, frame, 0.015, 0.015, 0.5, -0.4 + i * 0.26, 0.75, side * 0.98, 5);
  }
  addCyl(g, lam(0x8a9096), 0.02, 0.02, 1.9, -0.62, 0.95, -0.85, 6);
  addCyl(g, lam(0x8a9096), 0.02, 0.02, 0.5, -0.62, 1.9, -0.85, 6, 0, Math.PI / 2);
  addBox(g, glass(0xd8f0f8, 0.6), 0.14, 0.26, 0.1, -0.62, 1.72, -0.68);
  addBox(g, lam(0xd8dde0), 0.44, 0.6, 0.42, 0.8, 0.3, -0.75);
  addCyl(g, lam(0xe8e4d8), 0.07, 0.06, 0.12, 0.8, 0.66, -0.75, 10);
  if (occupied) addPerson(g, { x: 0, z: 0.05, y: 0.28, ry: 0, kind: 'patient', pose: 'sit', scale: 0.9 });
  addBox(g, lam(0x9fc8c8), 1.4, 1.9, 0.03, 1.15, 0.95, 0.2, 0.2);
  parent.add(g);
  return g;
}

export function addNurseStation(parent: THREE.Object3D, x: number, z: number, ry = 0, w = 3.0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0xd8dde0), w, 0.95, 0.7, 0, 0.48, 0);
  addBox(g, lam(0xeef2f2), w + 0.08, 0.06, 0.76, 0, 0.98, 0);
  addBox(g, glass(0xdff2ff, 0.22), w, 0.9, 0.02, 0, 1.5, -0.3);
  for (const side of [-1, 1]) addBox(g, lam(0x8a9096), 0.06, 1.0, 0.06, side * (w / 2 - 0.1), 1.5, -0.3);
  addBox(g, lam(0x22262a), 0.5, 0.34, 0.05, -0.5, 1.2, -0.1);
  addBox(g, basic(0x8fd8ff), 0.45, 0.28, 0.01, -0.5, 1.2, -0.07);
  addBox(g, lam(0xf2f0e6), 0.3, 0.02, 0.24, 0.6, 1.02, 0.05);
  addCyl(g, lam(0xf2f0e6), 0.04, 0.035, 0.1, 0.9, 1.06, -0.15, 8);
  parent.add(g);
  return g;
}

/** 報案室櫃檯（警署）。 */
export function addPoliceCounter(parent: THREE.Object3D, x: number, z: number, ry = 0, w = 3.0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x24354f), w, 1.0, 0.7, 0, 0.5, 0);
  addBox(g, lam(0xd8dde0), w + 0.06, 0.06, 0.76, 0, 1.02, 0);
  addBox(g, lam(0xb02a2a), w, 0.12, 0.02, 0, 0.62, 0.36);
  addBox(g, lam(0x22262a), 0.55, 0.34, 0.05, -0.4, 1.24, -0.16);
  addBox(g, basic(0x8fd8ff), 0.5, 0.28, 0.01, -0.4, 1.24, -0.13);
  addBox(g, lam(0xf2f0e6), 0.26, 0.02, 0.2, 0.6, 1.06, 0.06, 0.2);
  addBox(g, lam(0x1a1d20), 0.1, 0.2, 0.06, 0.2, 1.1, -0.1);
  parent.add(g);
  return g;
}

/** 拘留室（鐵枝）。 */
export function addDetentionCell(parent: THREE.Object3D, x: number, z: number, ry = 0, w = 2.2, h = 2.4): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x9aa0a6), w + 0.2, h, 0.12, 0, h / 2, 0);
  addBox(g, lam(0x5f656b), w + 0.2, 0.12, 0.16, 0, h, 0);
  for (let i = 0; i < 11; i++) addCyl(g, lam(0x8a9096), 0.022, 0.022, h, -w / 2 + 0.1 + (i * (w - 0.2)) / 10, h / 2, 0.1, 5);
  for (let i = 1; i < 3; i++) addBox(g, lam(0x8a9096), w, 0.04, 0.04, 0, (h / 3) * i, 0.1);
  addBox(g, lam(0x3a4048), 0.2, 0.3, 0.16, w / 2 - 0.1, 1.1, 0.14);
  addBox(g, lam(0xb9b3a4), w - 0.4, 0.1, 0.5, 0, 0.5, 0.42);
  addBox(g, lam(0x9a978d), w - 0.4, 0.4, 0.5, 0, 0.25, 0.42);
  parent.add(g);
  return g;
}

export function addNoticeBoard(parent: THREE.Object3D, x: number, y: number, z: number, ry = 0, w = 1.8, h = 1.0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  addBox(g, lam(0x8a6038), w, h, 0.05, 0, 0, 0);
  addBox(g, lam(0xd8c9a8), w - 0.1, h - 0.1, 0.02, 0, 0, 0.035);
  const colors = [0xf2f0e6, 0xe8f0c8, 0xf0dcd8, 0xd8e8f0];
  for (let i = 0; i < 5; i++) {
    addBox(
      g,
      lam(colors[i % colors.length]),
      0.3,
      0.36,
      0.01,
      -w / 2 + 0.28 + (i % 3) * 0.42,
      h * 0.16 - Math.floor(i / 3) * 0.34,
      0.05,
      (i % 2 ? 1 : -1) * 0.05,
    );
  }
  parent.add(g);
  return g;
}

/** 消防車（簡化）。 */
export function addFireTruck(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const red = lam(0xb02a2a);
  addBox(g, red, 3.4, 1.1, 1.7, 0, 0.9, 0);
  addBox(g, red, 1.2, 0.9, 1.7, 1.55, 1.35, 0);
  addBox(g, basic(0x9fd8ff), 1.0, 0.5, 0.04, 1.55, 1.5, 0.86);
  addBox(g, lam(0xd8dde0), 2.2, 0.8, 1.7, -0.55, 1.85, 0);
  addBox(g, lam(0xd9b23f), 2.2, 0.14, 1.72, -0.55, 1.44, 0);
  const beacon = addBox(g, basic(0xff3d7f), 0.3, 0.12, 0.3, 1.2, 2.2, -0.4);
  markAnim(beacon, 'blink');
  const ladder = new THREE.Group();
  for (const side of [-1, 1]) addBox(ladder, lam(0xd8dde0), 0.05, 0.06, 2.0, side * 0.22, 0, 0);
  for (let i = 0; i < 8; i++) addBox(ladder, lam(0xd8dde0), 0.44, 0.04, 0.04, 0, 0, -0.9 + i * 0.26);
  ladder.position.set(-0.5, 2.4, 0);
  g.add(ladder);
  for (const [sx, sz] of [
    [-1.1, -0.75],
    [0.2, -0.75],
    [-1.1, 0.75],
    [0.2, 0.75],
  ]) {
    addCyl(g, lam(0x1a1d20), 0.42, 0.42, 0.26, sx, 0.42, sz, 14, 0, Math.PI / 2);
  }
  parent.add(g);
  return g;
}

/** 消防鋼梯（靠牆）。 */
export function addSteelLadder(parent: THREE.Object3D, x: number, z: number, ry = 0, h = 3.4): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  for (const side of [-1, 1]) addBox(g, lam(0x8a9096), 0.05, h, 0.05, side * 0.25, h / 2, 0);
  for (let i = 0; i < 10; i++) addBox(g, lam(0x9aa0a6), 0.54, 0.04, 0.04, 0, 0.3 + (i * (h - 0.5)) / 9, 0);
  parent.add(g);
  return g;
}

/** 消防滑柱。 */
export function addFirePole(parent: THREE.Object3D, x: number, z: number, h = 4.2): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addCyl(g, lam(0xc9ced2), 0.07, 0.07, h, 0, h / 2, 0, 10);
  addBox(g, lam(0xd9b23f), 0.3, 0.06, 0.3, 0, h, 0);
  parent.add(g);
  return g;
}

// ─────────────────────────── 交通 ───────────────────────────

/** 港鐵閘機（八達通感應器發光）。 */
export function addMTRGate(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0xb9bec2), 0.36, 1.0, 0.7, 0, 0.5, 0);
  addBox(g, lam(0x8a9096), 0.4, 0.08, 0.74, 0, 1.02, 0);
  addBox(g, basic(0x5cff9d), 0.1, 0.1, 0.02, 0, 0.86, 0.36);
  addBox(g, basic(0x5cff9d), 0.1, 0.1, 0.02, 0, 0.86, -0.36);
  addBox(g, glass(0x9fd8e0, 0.35), 0.06, 0.5, 0.3, 0.22, 0.72, 0);
  addCyl(g, lam(0xb02a2a), 0.09, 0.09, 0.02, 0, 0.55, 0.37, 12, 0, Math.PI / 2);
  parent.add(g);
  return g;
}

/** 售票機／增值機。 */
export function addTicketMachine(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x3a5f8f), 0.6, 1.7, 0.5, 0, 0.85, 0);
  addBox(g, lam(0x2a3f5f), 0.54, 0.4, 0.05, 0, 1.45, 0.26);
  addBox(g, basic(0x8fd8ff), 0.46, 0.3, 0.01, 0, 1.45, 0.29);
  addBox(g, lam(0x1a1d20), 0.3, 0.2, 0.06, 0, 1.0, 0.26);
  addBox(g, lam(0xb02a2a), 0.16, 0.08, 0.02, 0, 0.86, 0.27);
  addBox(g, lam(0xd8dde0), 0.3, 0.04, 0.2, 0, 0.78, 0.28);
  parent.add(g);
  return g;
}

/** 月台指示牌（吊掛）。 */
export function addPlatformSign(
  parent: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  ry = 0,
  dest = '中環',
  platform = '1',
  color = 0xb02a2a,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  addBox(g, lam(0x2a2f36), 1.96, 0.54, 0.05, 0, 0, 0);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.48), platformSignMat(dest, `${platform} 月台`, color));
  face.position.z = 0.03;
  g.add(face);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.48), platformSignMat(dest, `${platform} 月台`, color));
  back.rotation.y = Math.PI;
  back.position.z = -0.03;
  g.add(back);
  for (const side of [-1, 1]) addCyl(g, lam(0x8a9096), 0.015, 0.015, 0.5, side * 0.7, 0.5, 0, 5);
  parent.add(g);
  return g;
}

/** 港鐵路線圖（牆上燈箱）。 */
export function addRouteMap(parent: THREE.Object3D, x: number, y: number, z: number, ry = 0, w = 1.8): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  addBox(g, lam(0xd8dde0), w, w * 0.66, 0.08, 0, 0, 0);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.08, w * 0.66 - 0.08), routeMapMat());
  face.position.z = 0.05;
  g.add(face);
  parent.add(g);
  return g;
}

/** 港鐵列車車廂側面（有滑門動畫）。 */
export function addMTRTrain(parent: THREE.Object3D, x: number, y: number, z: number, ry = 0, len = 6): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  const body = lam(0xdfe3e6);
  addBox(g, body, len, 1.5, 0.9, 0, 0.9, 0);
  addBox(g, lam(0xb02a2a), len, 0.12, 0.92, 0, 1.68, 0);
  addBox(g, lam(0x9aa0a6), len, 0.12, 0.92, 0, 0.2, 0);
  const winMat = basic(0xbff0ff);
  for (let i = 0; i < 3; i++) {
    const dx = -len / 2 + 1.0 + i * 1.9;
    addBox(g, winMat, 0.7, 0.5, 0.02, dx - 0.55, 1.25, 0.46);
    addBox(g, winMat, 0.7, 0.5, 0.02, dx + 0.55, 1.25, 0.46);
    for (const side of [-1, 1]) {
      const panel = new THREE.Group();
      panel.position.set(dx + side * 0.22, 0.86, 0.47);
      addBox(panel, basic(0xdff0ff), 0.42, 1.3, 0.02, 0, 0, 0);
      addBox(panel, lam(0x9aa0a6), 0.42, 0.05, 0.03, 0, 0.68, 0);
      markAnim(panel, side < 0 ? 'door-l' : 'door-r');
      g.add(panel);
    }
  }
  addBox(g, basic(0xffd166), 0.9, 0.18, 0.01, -len / 3, 1.62, 0.465);
  addBox(g, lam(0x2a2f36), 0.94, 0.22, 0.02, -len / 3, 1.62, 0.455);
  for (const sx of [-len / 3, len / 3]) addBox(g, lam(0x2a2f36), 1.0, 0.3, 0.8, sx, 0.15, 0);
  parent.add(g);
  return g;
}

/** 月台黃色觸覺線。 */
export function addPlatformEdge(parent: THREE.Object3D, x: number, z: number, len = 8, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0xd9b23f), len, 0.04, 0.4, 0, 0.03, 0);
  for (let i = 0; i < 10; i++) addBox(g, lam(0xb99a2f), 0.12, 0.05, 0.5, -len / 2 + 0.4 + (i * (len - 0.8)) / 9, 0.035, 0);
  parent.add(g);
  return g;
}

/** 港鐵馬賽克柱。 */
export function addMTRPillar(parent: THREE.Object3D, x: number, z: number, h: number, color = 0xb02a2a): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addBox(g, wallMat('tile'), 0.6, h, 0.6, 0, h / 2, 0);
  addBox(g, lam(color), 0.64, 0.4, 0.64, 0, h * 0.62, 0);
  addBox(g, lam(0x9aa0a6), 0.7, 0.08, 0.7, 0, 0.05, 0);
  parent.add(g);
  return g;
}

/** 巴士站牌。 */
export function addBusStopFlag(parent: THREE.Object3D, x: number, z: number, ry = 0, route = '968', dest = '銅鑼灣'): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addCyl(g, lam(0x8a9096), 0.03, 0.03, 3.0, 0, 1.5, 0, 8);
  addBox(g, lam(0x2f3337), 0.7, 0.9, 0.05, 0, 2.6, 0);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.5), busRouteMat(route, dest));
  face.position.set(0, 2.75, 0.035);
  g.add(face);
  const face2 = new THREE.Mesh(
    new THREE.PlaneGeometry(0.66, 0.28),
    signBoardMat(`bs-${route}`, ['巴士站', 'BUS STOP'], { bg: 0xd9b23f, fg: '#1f2937', w: 128, h: 64 }),
  );
  face2.position.set(0, 2.35, 0.035);
  g.add(face2);
  parent.add(g);
  return g;
}

/** 巴士候車亭。 */
export function addBusShelter(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const steel = lam(0x8a9096);
  for (const side of [-1, 1]) {
    addCyl(g, steel, 0.04, 0.04, 2.6, side * 1.7, 1.3, 0, 8);
    addCyl(g, steel, 0.04, 0.04, 2.6, side * 1.7, 1.3, -0.9, 8);
  }
  addBox(g, lam(0xd8dde0), 3.8, 0.06, 1.2, 0, 2.62, -0.4);
  addBox(g, glass(0xbfe0ea, 0.18), 3.8, 1.5, 0.03, 0, 1.4, -0.95);
  addBox(g, lam(0x9a7a52), 3.0, 0.08, 0.4, 0, 0.5, -0.6);
  for (let i = 0; i < 3; i++) addBox(g, lam(0x6f4a2a), 0.06, 0.5, 0.4, -1.2 + i * 1.2, 0.25, -0.6);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.6), busRouteMat('968', '銅鑼灣'));
  sign.position.set(0, 2.3, -0.36);
  g.add(sign);
  parent.add(g);
  return g;
}

/** 雙層巴士（側面）。 */
export function addDoubleDeckerBus(parent: THREE.Object3D, x: number, z: number, ry = 0, color = 0xd9b23f): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const body = lam(color);
  addBox(g, body, 5.2, 2.6, 1.6, 0, 1.7, 0);
  addBox(g, lam(0xf2f0e6), 5.2, 0.34, 1.62, 0, 1.5, 0);
  addBox(g, lam(0x9aa0a6), 5.2, 0.2, 1.62, 0, 3.08, 0);
  for (let i = 0; i < 5; i++) {
    addBox(g, basic(0x9fd8e8), 0.62, 0.5, 0.02, -2.0 + i * 1.0, 2.5, 0.81);
    addBox(g, basic(0x9fd8e8), 0.62, 0.55, 0.02, -2.0 + i * 1.0, 1.15, 0.81);
  }
  addBox(g, lam(0x2a3f4f), 0.5, 1.1, 0.04, 2.1, 1.05, 0.81);
  const route = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.26), busRouteMat('968', '銅鑼灣'));
  route.position.set(-1.9, 2.95, 0.82);
  g.add(route);
  for (const sx of [-1.8, 1.8]) {
    for (const sz of [-0.8, 0.8]) {
      addCyl(g, lam(0x1a1d20), 0.44, 0.44, 0.2, sx, 0.44, sz, 14, 0, Math.PI / 2);
      addCyl(g, lam(0x8a9096), 0.24, 0.24, 0.22, sx, 0.44, sz, 10, 0, Math.PI / 2);
    }
  }
  addBox(g, lam(0x8a9096), 0.8, 0.2, 1.2, -1.9, 3.2, 0);
  parent.add(g);
  return g;
}

/** 電車（叮叮）。 */
export function addTramCar(parent: THREE.Object3D, x: number, z: number, ry = 0, color = 0x2f8f5f): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const body = lam(color);
  addBox(g, body, 5.6, 2.2, 1.5, 0, 1.75, 0);
  addBox(g, lam(0xf2f0e6), 5.6, 0.3, 1.52, 0, 1.3, 0);
  addBox(g, lam(0xf2f0e6), 5.6, 0.16, 1.52, 0, 2.9, 0);
  for (let i = 0; i < 6; i++) {
    addBox(g, basic(0xbfe8f0), 0.6, 0.52, 0.02, -2.3 + i * 0.92, 2.42, 0.76);
    addBox(g, basic(0xbfe8f0), 0.55, 0.5, 0.02, -2.3 + i * 0.92, 1.35, 0.76);
  }
  addBox(g, lam(0x2a3f4f), 0.5, 1.0, 0.04, 2.3, 1.05, 0.76);
  addBox(g, lam(0x2a3f4f), 0.5, 1.0, 0.04, -2.5, 1.05, 0.76);
  addCyl(g, lam(0xc9a24c), 0.1, 0.1, 0.06, 0, 2.98, 0, 10);
  addBox(g, lam(0x3a4048), 0.32, 0.24, 0.2, 2.1, 3.05, 0);
  addCyl(g, lam(0x8a9096), 0.02, 0.02, 1.2, 0, 3.5, 0, 5, 0, 0.4);
  addCyl(g, lam(0x8a9096), 0.02, 0.02, 1.0, 0, 3.9, 0, 5, 0, -0.7);
  addBox(g, lam(0x4f555b), 0.5, 0.05, 0.06, 0, 4.2, 0);
  for (const sx of [-1.9, 1.9]) {
    addCyl(g, lam(0x1a1d20), 0.36, 0.36, 0.14, sx, 0.36, 0.55, 14, 0, Math.PI / 2);
    addCyl(g, lam(0x1a1d20), 0.36, 0.36, 0.14, sx, 0.36, -0.55, 14, 0, Math.PI / 2);
  }
  parent.add(g);
  return g;
}

/** 電車路軌。 */
export function addTramTrack(parent: THREE.Object3D, x: number, z: number, len = 8, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  for (const side of [-1, 1]) addBox(g, lam(0x8a9096), len, 0.04, 0.07, 0, 0.03, side * 0.55);
  for (let i = 0; i < 9; i++) addBox(g, lam(0x5c3f24), 0.16, 0.05, 1.5, -len / 2 + 0.3 + (i * (len - 0.6)) / 8, 0.02, 0);
  addBox(g, lam(IPAL.floorAsphalt), len, 0.03, 2.4, 0, 0.01, 0);
  parent.add(g);
  return g;
}

/** 天星小輪（側面，會輕微浮動）。 */
export function addStarFerry(parent: THREE.Object3D, x: number, y: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  const hull = lam(0x2f7f6a);
  const white = lam(0xf2f0e6);
  addBox(g, hull, 7.0, 0.8, 2.0, 0, 0.4, 0);
  addBox(g, white, 7.2, 0.18, 2.1, 0, 0.86, 0);
  addBox(g, white, 5.8, 0.9, 1.8, 0, 1.4, 0);
  for (let i = 0; i < 6; i++) addBox(g, basic(0xfff2cc), 0.5, 0.4, 0.02, -2.2 + i * 0.9, 1.45, 0.91);
  addBox(g, white, 5.0, 0.85, 1.6, 0, 2.3, 0);
  addBox(g, hull, 5.0, 0.14, 1.62, 0, 2.8, 0);
  for (let i = 0; i < 5; i++) addBox(g, basic(0xfff2cc), 0.5, 0.4, 0.02, -1.8 + i * 0.9, 2.32, 0.81);
  addBox(g, white, 0.8, 0.7, 0.7, -1.7, 3.1, 0);
  addCyl(g, lam(0x9a1f18), 0.2, 0.22, 0.6, -1.7, 3.7, 0, 10);
  addCyl(g, lam(0x1a1d20), 0.22, 0.24, 0.08, -1.7, 4.02, 0, 10);
  addBox(g, white, 0.9, 0.7, 0.9, 1.9, 3.0, 0);
  const name = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.42), starFerryMat());
  name.position.set(0, 0.55, 1.02);
  g.add(name);
  for (const sx of [-2.4, 2.2]) addCyl(g, lam(0xe0b33a), 0.14, 0.14, 0.04, sx, 1.3, 0.92, 10, 0, Math.PI / 2);
  markAnim(g, 'bob');
  parent.add(g);
  return g;
}

/** 渡輪閘口。 */
export function addFerryGate(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(0x8a9096), 1.2, 1.1, 0.3, 0, 0.55, 0);
  addBox(g, lam(0x2f7f6a), 1.2, 0.14, 0.34, 0, 1.16, 0);
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 0.4),
    signBoardMat('ferry-gate', ['天星小輪', '往尖沙咀'], { bg: 0x2f7f6a, fg: '#ffffff', w: 256, h: 96 }),
  );
  face.position.set(0, 1.55, 0.16);
  g.add(face);
  for (const side of [-1, 1]) {
    addCyl(g, lam(0xd9b23f), 0.03, 0.03, 1.0, side * 0.9, 0.5, 0.9, 6);
    addBox(g, lam(0xd9b23f), 0.6, 0.05, 0.05, side * 0.6, 0.95, 0.9);
  }
  parent.add(g);
  return g;
}

// ─────────────────────────── 戶外 ───────────────────────────

export function addBench(parent: THREE.Object3D, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const wood = lam(0xa97f4c);
  for (let i = 0; i < 3; i++) addBox(g, wood, 1.7, 0.06, 0.12, 0, 0.48, -0.16 + i * 0.16);
  for (let i = 0; i < 3; i++) addBox(g, wood, 1.7, 0.06, 0.12, 0, 0.7 + i * 0.16, -0.26);
  for (const side of [-1, 1]) {
    addBox(g, lam(0x3a4048), 0.08, 0.48, 0.5, side * 0.7, 0.24, 0);
    addBox(g, lam(0x3a4048), 0.08, 0.55, 0.08, side * 0.7, 0.74, -0.26);
  }
  parent.add(g);
  return g;
}

export function addTree(parent: THREE.Object3D, x: number, z: number, scale = 1, banyan = true): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(scale);
  addCyl(g, lam(IPAL.trunk), 0.12, 0.2, 2.4, 0, 1.2, 0, 7);
  if (banyan) {
    const mats = [lam(IPAL.leaf), lam(IPAL.leafLight), lam(0x3f6a3a)];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      addSphere(g, mats[i % 3], 0.8 + (i % 2) * 0.25, Math.cos(a) * 0.9, 2.6 + (i % 3) * 0.25, Math.sin(a) * 0.9, 9, 7);
    }
    addSphere(g, mats[0], 1.0, 0, 3.2, 0, 10, 8);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.6;
      addCyl(g, lam(0x6f5a3a), 0.02, 0.03, 1.6, Math.cos(a) * 0.7, 1.4, Math.sin(a) * 0.7, 4);
    }
  } else {
    addCone(g, lam(IPAL.leaf), 0.7, 2.6, 0, 2.6, 0, 8);
  }
  addCyl(g, lam(IPAL.concreteLight), 0.8, 0.8, 0.12, 0, 0.06, 0, 14);
  addCyl(g, lam(0x5c4a30), 0.7, 0.7, 0.04, 0, 0.14, 0, 14);
  parent.add(g);
  return g;
}

/** 麻雀／白鴿（會跳）。 */
export function addBird(parent: THREE.Object3D, x: number, y: number, z: number, color = 0x8a7a5a): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  addSphere(g, lam(color), 0.07, 0, 0, 0, 7, 5);
  addSphere(g, lam(darkenColor(color, 0.85)), 0.045, 0.06, 0.03, 0, 6, 5);
  addCone(g, lam(0xd9b23f), 0.02, 0.05, 0.1, 0.02, 0, 5, Math.PI / 2);
  for (const side of [-1, 1]) addSphere(g, lam(darkenColor(color, 0.8)), 0.04, -0.02, 0.03, side * 0.06, 5, 4);
  addCone(g, lam(color), 0.03, 0.1, -0.1, 0.02, 0, 4);
  markAnim(g, 'bird');
  parent.add(g);
  return g;
}

export function addLampPost(parent: THREE.Object3D, x: number, z: number, h = 3.2): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addCyl(g, lam(0x5f656b), 0.06, 0.08, h, 0, h / 2, 0, 8);
  addCyl(g, lam(0x5f656b), 0.04, 0.04, 0.5, 0, h, 0.2, 6, 0, Math.PI / 2);
  const lamp = addBox(g, basic(0xffe6b0), 0.22, 0.12, 0.32, 0, h - 0.06, 0.4);
  addBox(g, lam(0x5f656b), 0.26, 0.06, 0.36, 0, h + 0.02, 0.4);
  markAnim(lamp, 'glow');
  parent.add(g);
  return g;
}

export function addFlowerBed(parent: THREE.Object3D, x: number, z: number, ry = 0, len = 2.4): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lam(IPAL.concreteLight), len, 0.3, 0.9, 0, 0.15, 0);
  addBox(g, lam(0x5c4a30), len - 0.16, 0.06, 0.74, 0, 0.33, 0);
  const colors = [0xd94a6a, 0xe0b33a, 0xd9d4c8, 0xc76bd1];
  for (let i = 0; i < 7; i++) {
    addSphere(g, lam(0x4f7a44), 0.12, -len / 2 + 0.2 + (i * (len - 0.4)) / 6, 0.42, 0.1, 6, 5);
    addSphere(g, lam(colors[i % colors.length]), 0.05, -len / 2 + 0.2 + (i * (len - 0.4)) / 6, 0.52, 0.1, 5, 4);
  }
  parent.add(g);
  return g;
}

export function addTrashBin(parent: THREE.Object3D, x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addCyl(g, lam(0x3f7f5f), 0.22, 0.2, 0.8, 0, 0.4, 0, 12);
  addCyl(g, lam(0x2f5f47), 0.24, 0.24, 0.08, 0, 0.82, 0, 12);
  addCyl(g, lam(0x1a1d20), 0.16, 0.16, 0.04, 0, 0.68, 0.19, 10, 0, Math.PI / 2);
  parent.add(g);
  return g;
}

/** 海濱欄杆。 */
export function addHarbourRail(parent: THREE.Object3D, x: number, z: number, len = 8, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const metal = lam(0x8a9096);
  addBox(g, metal, len, 0.06, 0.06, 0, 1.05, 0);
  addBox(g, metal, len, 0.05, 0.05, 0, 0.62, 0);
  for (let i = 0; i < 9; i++) addCyl(g, metal, 0.03, 0.03, 1.05, -len / 2 + (i * len) / 8, 0.52, 0, 6);
  addBox(g, lam(0xa97f4c), len, 0.08, 0.14, 0, 1.12, 0);
  parent.add(g);
  return g;
}

/** 木棧道。 */
export function addBoardwalk(parent: THREE.Object3D, x: number, z: number, w = 8, d = 3): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addBox(g, floorMat('boardwalk'), w, 0.12, d, 0, 0.06, 0);
  parent.add(g);
  return g;
}

/** 紅色帆船（維港）。 */
export function addJunkBoat(parent: THREE.Object3D, x: number, y: number, z: number, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.scale.setScalar(scale);
  addBox(g, lam(0x4a3524), 3.0, 0.36, 0.9, 0, 0.18, 0);
  addCyl(g, lam(0x4a3524), 0.05, 0.05, 2.4, -0.3, 1.3, 0, 5);
  const sail = lam(0xb4433a);
  for (let i = 0; i < 3; i++) {
    const s = 1.5 - i * 0.32;
    const sailMesh = addBox(g, sail, s, s * 0.9, 0.02, -0.3 + s / 2, 1.3 + i * 0.55, 0.02);
    sailMesh.rotation.z = -0.18;
  }
  addBox(g, lam(0x2a2f36), 0.7, 0.2, 0.4, 0.9, 0.42, 0);
  markAnim(g, 'bob');
  parent.add(g);
  return g;
}

/** 貨櫃堆。 */
export function addContainerStack(
  parent: THREE.Object3D,
  x: number,
  z: number,
  ry = 0,
  opts: { rows?: number; cols?: number; levels?: number } = {},
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const rows = opts.rows ?? 2;
  const cols = opts.cols ?? 3;
  const levels = opts.levels ?? 3;
  const colors = [IPAL.containerRed, IPAL.containerBlue, IPAL.containerGreen, IPAL.containerOrange];
  const w = 1.0;
  const d = 0.5;
  const h = 0.42;
  for (let lv = 0; lv < levels; lv++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const color = colors[(lv * 5 + r * 3 + c) % colors.length];
        const cx = -((cols - 1) * w) / 2 + c * w;
        const cz = -((rows - 1) * d) / 2 + r * d;
        const cy = h / 2 + lv * h;
        addBox(g, lam(color), w - 0.04, h - 0.04, d - 0.04, cx, cy, cz);
        for (let i = 0; i < 4; i++) {
          addBox(g, lam(darkenColor(color, 0.78)), 0.02, h - 0.1, d - 0.05, cx - w / 2 + 0.14 + (i * (w - 0.3)) / 3, cy, cz);
        }
        addBox(g, lam(0x3a3f45), 0.06, 0.08, 0.03, cx + w / 2 - 0.1, cy, cz + d / 2 - 0.02);
      }
    }
  }
  parent.add(g);
  return g;
}

/** 龍門吊機（貨櫃碼頭）。 */
export function addGantryCrane(
  parent: THREE.Object3D,
  x: number,
  z: number,
  ry = 0,
  span = 6,
  height = 5,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const steel = lam(0xd9b23f);
  const steelDark = lam(0xb99247);
  for (const sx of [-span / 2, span / 2]) {
    for (const sz of [-1.6, 1.6]) addBox(g, steelDark, 0.26, height, 0.26, sx, height / 2, sz);
    const brace = addBox(g, steel, 0.16, height * 1.1, 0.16, sx, height / 2, 0);
    brace.rotation.x = 0.42;
  }
  addBox(g, steel, span + 0.8, 0.3, 0.4, 0, height + 0.1, 0);
  addBox(g, steel, span + 0.8, 0.2, 0.3, 0, height * 0.62, 1.6);
  addBox(g, steel, span + 0.8, 0.2, 0.3, 0, height * 0.62, -1.6);
  addBox(g, steel, 2.4, 0.18, 0.3, span / 2 + 1.0, height + 0.2, 0);
  addCyl(g, lam(0x3a3f45), 0.02, 0.02, 2.2, span / 2 - 0.6, height - 1.0, 0, 5);
  addBox(g, lam(IPAL.containerBlue), 1.0, 0.42, 0.5, span / 2 - 0.6, height - 2.2, 0);
  addBox(g, lam(0xe8e4dc), 0.7, 0.6, 0.6, span / 2 - 1.5, height - 0.6, 0);
  addBox(g, basic(0x9fd8e8), 0.5, 0.3, 0.02, span / 2 - 1.5, height - 0.55, 0.31);
  parent.add(g);
  return g;
}

/** 貨櫃船（半個船身，在水面）。 */
export function addContainerShip(parent: THREE.Object3D, x: number, y: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  addBox(g, lam(0x2f3f4f), 12, 1.4, 3.4, 0, 0.4, 0);
  addBox(g, lam(0x9a1f18), 12, 0.5, 3.5, 0, 0.06, 0);
  addBox(g, lam(0xf2f0e6), 2.2, 2.2, 2.6, -4.6, 2.2, 0);
  addBox(g, lam(0x2f3f4f), 2.2, 0.3, 2.6, -4.6, 3.4, 0);
  for (let i = 0; i < 8; i++) addBox(g, basic(0xfff2cc), 0.3, 0.2, 0.02, -5.3 + (i % 3) * 0.5, 2.6 + Math.floor(i / 3) * 0.4, 1.31);
  for (let i = 0; i < 8; i++) {
    const color = [IPAL.containerRed, IPAL.containerBlue, IPAL.containerGreen][i % 3];
    addBox(g, lam(color), 1.0, 0.5, 2.6, -3.0 + i * 1.05, 1.5, 0);
    addBox(g, lam(darkenColor(color, 0.8)), 1.0, 0.5, 2.6, -3.0 + i * 1.05, 2.0, 0);
  }
  parent.add(g);
  return g;
}

/** 公園涼亭。 */
export function addPavilion(parent: THREE.Object3D, x: number, z: number, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(scale);
  addBox(g, lam(IPAL.concreteLight), 3.0, 0.2, 2.6, 0, 0.1, 0);
  for (const [sx, sz] of [
    [-1.2, -1.0],
    [1.2, -1.0],
    [-1.2, 1.0],
    [1.2, 1.0],
  ]) {
    addCyl(g, lam(0x8a3a2a), 0.09, 0.1, 2.4, sx, 1.3, sz, 8);
  }
  addBox(g, lam(0x6f4a2a), 3.2, 0.16, 2.8, 0, 2.5, 0);
  const roof = addCone(g, lam(0x51645b), 2.2, 1.1, 0, 3.1, 0, 4);
  roof.rotation.y = Math.PI / 4;
  addCyl(g, lam(0xc9a24c), 0.06, 0.06, 0.3, 0, 3.7, 0, 6);
  addBox(g, lam(0x9a7a52), 2.0, 0.08, 0.4, 0, 0.55, 0.8);
  parent.add(g);
  return g;
}

/** 維港水面。 */
export function addWaterPlane(parent: THREE.Object3D, x: number, z: number, w: number, d: number, night = false): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const mat = textureMat(
    `water-${night ? 'n' : 'd'}`,
    128,
    128,
    (ctx, W, H) => {
      ctx.fillStyle = night ? '#0c2233' : '#2f6f8f';
      ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < 70; i++) {
        ctx.fillStyle = night ? 'rgba(160,200,230,0.16)' : 'rgba(220,240,250,0.22)';
        ctx.fillRect((i * 37) % W, (i * 61) % H, 8 + ((i * 7) % 10), 1.5);
      }
    },
    { repeat: [Math.max(2, w / 3), Math.max(2, d / 3)] },
  );
  addPlane(g, mat, w, d, 0, 0.01, 0);
  parent.add(g);
  return g;
}

/** 戶外遠景天際線板（日夜交叉淡入）。 */
export function addSkylineBackdrop(
  parent: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  ry = 0,
  w = 60,
  h = 15,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  const night = new THREE.Mesh(new THREE.PlaneGeometry(w, h), skylineMat(true));
  night.position.z = -0.06;
  markAnim(night, 'sky-night');
  g.add(night);
  const day = new THREE.Mesh(new THREE.PlaneGeometry(w, h), skylineMat(false));
  markAnim(day, 'sky-day');
  g.add(day);
  parent.add(g);
  return g;
}

// ─────────────────────────── 人物 ───────────────────────────

export type PersonKind =
  | 'office'
  | 'student'
  | 'teacher'
  | 'elder'
  | 'worker'
  | 'chef'
  | 'nurse'
  | 'doctor'
  | 'police'
  | 'fire'
  | 'shopper'
  | 'tourist'
  | 'patient'
  | 'kid';

export type PersonPose = 'stand' | 'sit';

export interface PersonOptions {
  x: number;
  z: number;
  y?: number;
  ry?: number;
  kind?: PersonKind;
  pose?: PersonPose;
  scale?: number;
  mask?: boolean;
  idle?: boolean;
}

interface PersonStyle {
  top: number;
  bottom: number;
  hair: number;
  cap?: number;
  helmet?: number;
  mask?: boolean;
}

const PERSON_STYLE: Record<PersonKind, PersonStyle> = {
  office: { top: 0xdfe6ec, bottom: 0x2f3a4a, hair: 0x1f1a16, mask: true },
  student: { top: 0xf2f0e8, bottom: 0x2f4a6f, hair: 0x1f1a16 },
  teacher: { top: 0x8fa6b8, bottom: 0x3a3f45, hair: 0x1f1a16, mask: true },
  elder: { top: 0xc9b89a, bottom: 0x6f6a60, hair: 0x9a9a96, mask: true },
  worker: { top: 0x3f6f9f, bottom: 0x2f3a44, hair: 0x1f1a16, helmet: 0xe0b33a },
  chef: { top: 0xf2f0e6, bottom: 0x2a2f36, hair: 0x1f1a16, cap: 0xf2f0e6, mask: true },
  nurse: { top: 0xbfe0e0, bottom: 0x8fb8b8, hair: 0x1f1a16, mask: true },
  doctor: { top: 0xf4f6f6, bottom: 0x3a5f8f, hair: 0x1f1a16, mask: true },
  police: { top: 0x24354f, bottom: 0x1f2a3a, hair: 0x1f1a16, cap: 0x24354f },
  fire: { top: 0x2a3f5f, bottom: 0x1f2a3a, hair: 0x1f1a16, helmet: 0xd94a3f },
  shopper: { top: 0xc96b8a, bottom: 0x2f3a4a, hair: 0x1f1a16, mask: true },
  tourist: { top: 0xe0b33a, bottom: 0x5f8fbf, hair: 0x4a3524 },
  patient: { top: 0xd8e8e8, bottom: 0xd8e8e8, hair: 0x1f1a16 },
  kid: { top: 0xe0b33a, bottom: 0x3f6f9f, hair: 0x1f1a16 },
};

/** 低多邊形香港市民象徵（西裝、校服、師奶、長者、制服人員…）。 */
export function addPerson(parent: THREE.Object3D, opts: PersonOptions): THREE.Group {
  const kind = opts.kind ?? 'office';
  const style = PERSON_STYLE[kind];
  const pose = opts.pose ?? 'stand';
  const scale = opts.scale ?? 1;
  const g = new THREE.Group();
  g.position.set(opts.x, opts.y ?? 0, opts.z);
  g.rotation.y = opts.ry ?? 0;
  g.scale.setScalar(scale);
  const skin = lam(IPAL.skin);
  const top = lam(style.top);
  const bottom = lam(style.bottom);
  const hair = lam(style.hair);
  let headY: number;
  if (pose === 'sit') {
    addBox(g, bottom, 0.3, 0.16, 0.32, 0, 0.48, 0.06);
    addBox(g, bottom, 0.13, 0.32, 0.13, -0.08, 0.3, 0.22);
    addBox(g, bottom, 0.13, 0.32, 0.13, 0.08, 0.3, 0.22);
    addBox(g, top, 0.34, 0.44, 0.2, 0, 0.8, 0);
    headY = 1.18;
  } else {
    addBox(g, bottom, 0.13, 0.62, 0.13, -0.09, 0.31, 0);
    addBox(g, bottom, 0.13, 0.62, 0.13, 0.09, 0.31, 0);
    addBox(g, lam(0x1f1a16), 0.14, 0.07, 0.24, -0.09, 0.035, 0.03);
    addBox(g, lam(0x1f1a16), 0.14, 0.07, 0.24, 0.09, 0.035, 0.03);
    addBox(g, top, 0.38, 0.52, 0.22, 0, 0.92, 0);
    addBox(g, top, 0.1, 0.44, 0.12, -0.24, 0.9, 0);
    addBox(g, top, 0.1, 0.44, 0.12, 0.24, 0.9, 0);
    headY = 1.34;
  }
  addSphere(g, skin, 0.045, -0.24, pose === 'sit' ? 0.62 : 0.66, 0, 6, 5);
  addSphere(g, skin, 0.045, 0.24, pose === 'sit' ? 0.62 : 0.66, 0, 6, 5);
  addSphere(g, skin, 0.12, 0, headY, 0.01, 9, 7);
  const hairCap = addSphere(g, hair, 0.125, 0, headY + 0.02, -0.02, 9, 7);
  hairCap.scale.set(1, 0.86, 1);
  if (opts.mask ?? style.mask) addBox(g, lam(0xeef2f2), 0.16, 0.09, 0.03, 0, headY - 0.03, 0.11);
  if (style.cap) {
    addBox(g, lam(style.cap), 0.26, 0.09, 0.26, 0, headY + 0.1, 0);
    addBox(g, lam(style.cap), 0.26, 0.03, 0.12, 0, headY + 0.06, 0.16);
  }
  if (style.helmet) {
    const helmet = addSphere(g, lam(style.helmet), 0.15, 0, headY + 0.08, 0, 9, 7);
    helmet.scale.set(1, 0.8, 1);
  }
  if (kind === 'chef') addCyl(g, lam(0xf4f2ec), 0.12, 0.13, 0.2, 0, headY + 0.18, 0, 10);
  if (kind === 'tourist') addBox(g, lam(0x2f5f8f), 0.28, 0.36, 0.16, 0, 0.94, -0.2);
  if (kind === 'shopper') addBox(g, lam(0xc9a24c), 0.2, 0.3, 0.12, 0.3, 0.5, 0.04);
  if (kind === 'elder') addCyl(g, lam(0x6f4a2a), 0.015, 0.02, 0.9, 0.3, 0.45, 0.08, 5);
  if (opts.idle !== false) markAnim(g, 'person');
  parent.add(g);
  return g;
}

/** 小道具：膠袋（加生活氣息）。 */
export function addPlasticBag(parent: THREE.Object3D, x: number, y: number, z: number, color = 0xd94a3f): THREE.Mesh {
  return addBox(parent, lam(color), 0.16, 0.24, 0.09, x, y, z, ((x * 7) % 1.2) as number);
}
