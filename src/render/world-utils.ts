/**
 * 世界渲染共用工具（world-dev 私有模組）。
 *
 * terrain.ts / roads.ts / environment.ts 共用同一套「地形高度、太陽方位、
 * 天空配色、天氣係數」，確保光影、水面反光與地形起伏一致。
 *
 * 香港版重點：
 *  - 亞熱帶季風氣候：夏天酷熱多雷雨、春天潮濕有霧、秋天晴朗、冬天偶有寒潮；
 *  - 六種天氣（晴／陰／雨／颱風／霧／雪）；颱風有狂風暴雨與閃電；
 *  - 山頂（大帽山／太平山／獅子山）在冬季與寒潮時結霜積雪（遊戲化表現）；
 *  - 維港水色偏青綠（不是內陸湖藍），城市夜間霓虹暖光。
 */

import * as THREE from 'three';
import { TERRAIN_INFO } from '../core/config';
import type { Season, TerrainType, Tile, Weather } from '../core/types';

// ─────────────────────────── 高度常數 ───────────────────────────

/** 水面高度（世界 y） */
export const WATER_SURFACE_Y = 0.14;
/** 一般可建平地的基準地面高度（建築底部約 y=0.28，剛好略埋入基座） */
export const GROUND_Y = 0.3;
/** 道路石板最低頂面高度 */
export const ROAD_BASE_Y = 0.345;

const GRASS_LIFT = 0.02;
const FERTILE_LIFT = 0.012;
const FOREST_LIFT = 0.018;
const SAND_LIFT = 0.01;
const HILL_LIFT = 0.28;
/** 山地最高抬升：大帽山（957m）在遊戲內約 3.2 單位高，形成明顯山形 */
const MOUNTAIN_LIFT = 2.55;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 0..1 的平滑插值 */
function smooth01(v: number): number {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}

/** 地塊頂面高度：可建地維持在 0.28~0.39（與建築 y≈0.28 相容），山地則大幅抬高。 */
export function tileTopY(tile: Tile): number {
  const e = tile.elevation;
  switch (tile.terrain) {
    case 'water':
      return 0.01;
    case 'sand':
      return GROUND_Y - 0.03 + smooth01((e - 0.28) / 0.06) * SAND_LIFT;
    case 'fertile':
      return GROUND_Y - 0.006 + smooth01((e - 0.3) / 0.08) * FERTILE_LIFT;
    case 'wetland':
      return GROUND_Y - 0.02 + smooth01((e - 0.3) / 0.08) * 0.008;
    case 'reclaimed':
    case 'urban':
      return GROUND_Y + 0.006 + smooth01((e - 0.3) / 0.08) * 0.01;
    case 'grass':
      return GROUND_Y + smooth01((e - 0.3) / 0.1) * GRASS_LIFT;
    case 'forest':
      return GROUND_Y + smooth01((e - 0.3) / 0.1) * FOREST_LIFT;
    case 'hill':
      return 0.33 + smooth01((e - 0.44) / 0.16) * HILL_LIFT;
    case 'mountain':
      return 0.9 + smooth01((e - 0.59) / 0.3) * MOUNTAIN_LIFT;
    default:
      return GROUND_Y;
  }
}

/** 道路石板頂面高度（跟隨地形，略高於地面） */
export function roadSurfaceY(tile: Tile): number {
  if (tile.terrain === 'water') return ROAD_BASE_Y - 0.12; // 過海隧道：貼近水面
  return Math.max(ROAD_BASE_Y, tileTopY(tile) + 0.035);
}

/** 地形顏色（不含每格 variant 的明暗），供基礎渲染與小地圖參考 */
export function terrainBaseColor(terrain: TerrainType, out: THREE.Color): THREE.Color {
  return out.setHex(TERRAIN_INFO[terrain]?.color ?? 0x86a85c);
}

// ─────────────────────────── 季節配色（香港） ───────────────────────────

export interface SeasonPalette {
  grass: number;
  urban: number;
  reclaimed: number;
  fertile: number;
  wetland: number;
  forest: number;
  hill: number;
  mountain: number;
  sand: number;
  leaf: number;
  leafWarm: number;
  leafPalm: number;
  /** 山頂積雪混合量 0..1（冬季／寒潮） */
  snow: number;
  vivid: number;
}

const SEASON_PALETTES: Record<Season, SeasonPalette> = {
  spring: {
    // 春天潮濕多霧：草木嫩綠、天色偏灰白
    grass: 0x7cae52,
    urban: 0x8f9391,
    reclaimed: 0x929a8b,
    fertile: 0x8fba58,
    wetland: 0x5f8158,
    forest: 0x3f6c3b,
    hill: 0x7d8a58,
    mountain: 0x7e7d74,
    sand: 0xd3c196,
    leaf: 0x6fa44e,
    leafWarm: 0xc98f9d,
    leafPalm: 0x5d9448,
    snow: 0,
    vivid: 1,
  },
  summer: {
    // 夏天濃綠、陽光猛烈、雷雨多
    grass: 0x548f36,
    urban: 0x7e817f,
    reclaimed: 0x828a7c,
    fertile: 0x7ab043,
    wetland: 0x4f7550,
    forest: 0x2f5a30,
    hill: 0x6f7f45,
    mountain: 0x77746a,
    sand: 0xd8c897,
    leaf: 0x4f8b3c,
    leafWarm: 0x8fa04a,
    leafPalm: 0x4e8c3e,
    snow: 0,
    vivid: 1,
  },
  autumn: {
    // 秋天晴朗乾爽：香港仍以常綠為主，少量楓香轉紅
    grass: 0x7d9c47,
    urban: 0x94938d,
    reclaimed: 0x959a89,
    fertile: 0x93ad4f,
    wetland: 0x5c7a55,
    forest: 0x466b39,
    hill: 0x858355,
    mountain: 0x807d72,
    sand: 0xd4c193,
    leaf: 0x6f9a44,
    leafWarm: 0xc27a3e,
    leafPalm: 0x5a8a42,
    snow: 0,
    vivid: 1,
  },
  winter: {
    // 冬天清涼乾燥：草木仍綠但偏黃，山頂有霜／薄雪
    grass: 0x8a9a63,
    urban: 0x909493,
    reclaimed: 0x91968c,
    fertile: 0x98a86a,
    wetland: 0x647a5c,
    forest: 0x51704a,
    hill: 0x8a8a65,
    mountain: 0xa8adad,
    sand: 0xd9cbac,
    leaf: 0x708b55,
    leafWarm: 0x9a8058,
    leafPalm: 0x668c55,
    snow: 0.55,
    vivid: 0.98,
  },
};

export interface SeasonColors {
  grass: THREE.Color;
  urban: THREE.Color;
  reclaimed: THREE.Color;
  fertile: THREE.Color;
  wetland: THREE.Color;
  forest: THREE.Color;
  hill: THREE.Color;
  mountain: THREE.Color;
  sand: THREE.Color;
  leaf: THREE.Color;
  leafWarm: THREE.Color;
  leafPalm: THREE.Color;
  snow: number;
  vivid: number;
}

export function seasonColors(season: Season, out: SeasonColors): SeasonColors {
  const p = SEASON_PALETTES[season];
  out.grass.setHex(p.grass);
  out.urban.setHex(p.urban);
  out.reclaimed.setHex(p.reclaimed);
  out.fertile.setHex(p.fertile);
  out.wetland.setHex(p.wetland);
  out.forest.setHex(p.forest);
  out.hill.setHex(p.hill);
  out.mountain.setHex(p.mountain);
  out.sand.setHex(p.sand);
  out.leaf.setHex(p.leaf);
  out.leafWarm.setHex(p.leafWarm);
  out.leafPalm.setHex(p.leafPalm);
  out.snow = p.snow;
  out.vivid = p.vivid;
  return out;
}

export function createSeasonColors(): SeasonColors {
  return {
    grass: new THREE.Color(),
    urban: new THREE.Color(),
    reclaimed: new THREE.Color(),
    fertile: new THREE.Color(),
    wetland: new THREE.Color(),
    forest: new THREE.Color(),
    hill: new THREE.Color(),
    mountain: new THREE.Color(),
    sand: new THREE.Color(),
    leaf: new THREE.Color(),
    leafWarm: new THREE.Color(),
    leafPalm: new THREE.Color(),
    snow: 0,
    vivid: 1,
  };
}

// ─────────────────────────── 太陽／月亮 ───────────────────────────

export interface SunState {
  /** 太陽方向（單位向量，由地面指向太陽） */
  dir: THREE.Vector3;
  /** 太陽高度（-1..1，y 分量） */
  elevation: number;
  /** 0=夜、1=正午 */
  daylight: number;
}

export function createSunState(): SunState {
  return { dir: new THREE.Vector3(0.4, 0.8, 0.3).normalize(), elevation: 0.8, daylight: 1 };
}

/** 各季日出／日落時刻（小時，香港緯度 22°N） */
function sunTimes(season: Season): { sunrise: number; sunset: number; maxElev: number } {
  switch (season) {
    case 'spring':
      return { sunrise: 6.2, sunset: 18.5, maxElev: 0.86 };
    case 'summer':
      return { sunrise: 5.4, sunset: 19.2, maxElev: 0.97 };
    case 'autumn':
      return { sunrise: 6.2, sunset: 18.1, maxElev: 0.8 };
    case 'winter':
      return { sunrise: 6.9, sunset: 17.6, maxElev: 0.62 };
    default:
      return { sunrise: 6, sunset: 18, maxElev: 0.8 };
  }
}

function sunPath(
  hour: number,
  minute: number,
  season: Season,
  out: THREE.Vector3,
): { elevation: number; daylight: number } {
  const { sunrise, sunset, maxElev } = sunTimes(season);
  const h = hour + minute / 60;
  const dayLen = sunset - sunrise;
  const t = (h - sunrise) / dayLen;
  const az = Math.PI * t; // 0 = 東升, PI = 西落
  const sinAz = Math.sin(az);
  const along = Math.cos(az); // 東 → 西
  // 正午太陽偏南（世界 +z 為南），讓陰影略往北落
  out.set(along, sinAz * Math.sin(maxElev), 0.45 * sinAz + 0.12).normalize();
  const elevation = out.y;
  const daylight = smooth01((elevation + 0.06) / 0.32);
  return { elevation, daylight };
}

/** 計算太陽狀態；回傳物件由呼叫端持有，避免每幀配置 */
export function computeSun(hour: number, minute: number, season: Season, out: SunState): SunState {
  const r = sunPath(hour, minute, season, out.dir);
  out.elevation = r.elevation;
  out.daylight = r.daylight;
  return out;
}

/** 月亮方向（與太陽大致相反，夜晚高掛） */
export function computeMoonDir(hour: number, minute: number, season: Season, out: THREE.Vector3): THREE.Vector3 {
  const h = (hour + 12) % 24;
  sunPath(h, minute, season, out);
  out.y = Math.max(-0.2, out.y * 0.85);
  out.normalize();
  return out;
}

// ─────────────────────────── 天空配色 ───────────────────────────

export interface SkyPalette {
  zenith: THREE.Color;
  horizon: THREE.Color;
  fog: THREE.Color;
  sun: THREE.Color;
  moon: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  ambient: THREE.Color;
}

export function createSkyPalette(): SkyPalette {
  return {
    zenith: new THREE.Color(0x5f9fd0),
    horizon: new THREE.Color(0xd8e6d8),
    fog: new THREE.Color(0xc8dce8),
    sun: new THREE.Color(0xfff0cf),
    moon: new THREE.Color(0xd8e2ff),
    hemiSky: new THREE.Color(0xdfefff),
    hemiGround: new THREE.Color(0x5d6b4a),
    ambient: new THREE.Color(0x9fb0c0),
  };
}

interface SkyScheme {
  nightZenith: number;
  nightHorizon: number;
  dayZenith: number;
  dayHorizon: number;
  duskZenith: number;
  duskHorizon: number;
  ground: number;
}

/** 香港天空：日間偏海洋藍而帶濕氣薄霞、晨昏有明顯橙紅、夜晚光害令地平線偏暖 */
const SKY_SCHEMES: Record<Season, SkyScheme> = {
  spring: {
    nightZenith: 0x0a1226,
    nightHorizon: 0x27364e,
    dayZenith: 0x7faecb,
    dayHorizon: 0xdfe8e2,
    duskZenith: 0x6e6c9c,
    duskHorizon: 0xf0a878,
    ground: 0x5f6b44,
  },
  summer: {
    nightZenith: 0x081024,
    nightHorizon: 0x243550,
    dayZenith: 0x5b9fd4,
    dayHorizon: 0xe2ecdf,
    duskZenith: 0x77608f,
    duskHorizon: 0xf9a055,
    ground: 0x4e613c,
  },
  autumn: {
    nightZenith: 0x0a1325,
    nightHorizon: 0x283a52,
    dayZenith: 0x6ea6cf,
    dayHorizon: 0xe9dcc0,
    duskZenith: 0x6f5f8c,
    duskHorizon: 0xf2a45f,
    ground: 0x6b634a,
  },
  winter: {
    nightZenith: 0x0b1429,
    nightHorizon: 0x2c3f5a,
    dayZenith: 0x8ea9c4,
    dayHorizon: 0xe2e8ec,
    duskZenith: 0x606a92,
    duskHorizon: 0xeaa878,
    ground: 0x7b7f80,
  },
};

const tmpColorA = new THREE.Color();
const tmpColorB = new THREE.Color();

/** 天氣對天空的影響 */
const WEATHER_SKY: Record<Weather, { color: number; amount: number; fog: number }> = {
  clear: { color: 0xffffff, amount: 0, fog: 0 },
  cloudy: { color: 0x9aa6b2, amount: 0.55, fog: 0.22 },
  rain: { color: 0x66727e, amount: 0.7, fog: 0.45 },
  storm: { color: 0x4a4f66, amount: 0.85, fog: 0.62 },
  fog: { color: 0xc3ccd2, amount: 0.7, fog: 0.9 },
  snow: { color: 0xc2ccd6, amount: 0.55, fog: 0.35 },
};

/**
 * 依季節、天氣、日照取樣天空／霧／光照配色（寫入 out，可每幀呼叫）。
 */
export function sampleSkyPalette(
  season: Season,
  weather: Weather,
  daylight: number,
  out: SkyPalette,
): SkyPalette {
  const scheme = SKY_SCHEMES[season];
  const dayMix = smooth01(daylight);
  const nightMix = 1 - dayMix;
  // 晨昏暖色：只在太陽貼近地平線時出現，深夜與正午皆為 0
  const duskWindow = clamp01(1 - Math.abs(daylight - 0.24) / 0.2);
  const duskMix = duskWindow * clamp01((daylight - 0.03) / 0.09) * 0.85;

  out.zenith
    .setHex(scheme.nightZenith)
    .lerp(tmpColorA.setHex(scheme.dayZenith), dayMix)
    .lerp(tmpColorB.setHex(scheme.duskZenith), duskMix * 0.5);
  out.horizon
    .setHex(scheme.nightHorizon)
    .lerp(tmpColorA.setHex(scheme.dayHorizon), dayMix)
    .lerp(tmpColorB.setHex(scheme.duskHorizon), duskMix);

  // 天氣：陰雨雪時天空轉灰、飽和度降低
  const w = WEATHER_SKY[weather];
  if (w.amount > 0) {
    tmpColorA.setHex(w.color);
    // 夜晚的陰天灰要更暗
    tmpColorA.multiplyScalar(0.25 + dayMix * 0.75);
    if (weather === 'fog') {
      // 大霧：整個天空變成奶白色，日夜差異縮小
      tmpColorA.multiplyScalar(0.55 + dayMix * 0.45);
      out.zenith.lerp(tmpColorA, w.amount * 0.92);
      out.horizon.lerp(tmpColorA, w.amount * 0.97);
    } else if (weather === 'storm') {
      // 颱風：鉛灰帶紫
      tmpColorA.lerp(tmpColorB.setHex(0x3b3250), 0.35);
      out.zenith.lerp(tmpColorA, w.amount * 0.9);
      out.horizon.lerp(tmpColorA, w.amount * 0.95);
    } else {
      out.zenith.lerp(tmpColorA, w.amount * 0.85);
      out.horizon.lerp(tmpColorA, w.amount);
    }
  }

  // 太陽色：晨昏偏橘，正午偏暖白
  tmpColorA.setHex(0xff6f38);
  tmpColorB.setHex(0xfff2d6);
  out.sun.copy(tmpColorA).lerp(tmpColorB, smooth01((daylight - 0.1) / 0.5));

  // 月亮：淡藍白
  out.moon.setHex(0xd4e0ff).multiplyScalar(0.9);

  // 半球光與環境光
  out.hemiSky.copy(out.horizon).lerp(out.zenith, 0.55);
  out.hemiGround.setHex(scheme.ground).multiplyScalar(0.5 + 0.6 * dayMix);
  out.ambient.copy(out.hemiSky).multiplyScalar(0.55 + nightMix * 0.28);

  // 霧：以地平線色為底，但降低飽和度（避免晨昏時整個世界變成橘褐色）
  out.fog.copy(out.horizon);
  {
    const lum = out.fog.r * 0.3 + out.fog.g * 0.55 + out.fog.b * 0.15;
    out.fog.lerp(tmpColorA.setRGB(lum, lum, lum * 1.04), 0.42);
    // 夜間霧色提亮一點點，避免遠景整片死黑；同時帶一點城市光害暖色
    if (nightMix > 0.5) out.fog.lerp(tmpColorA.setRGB(0.055, 0.075, 0.115), (nightMix - 0.5) * 0.5);
  }
  if (weather === 'fog') {
    out.fog.lerp(tmpColorA.setHex(0xd6dde2).multiplyScalar(0.35 + dayMix * 0.65), 0.82);
  } else if (weather === 'storm') {
    out.fog.lerp(tmpColorA.setHex(0x4c4a5e).multiplyScalar(0.35 + dayMix * 0.65), 0.7);
  } else if (w.fog > 0) {
    out.fog.lerp(tmpColorA.setHex(weather === 'snow' ? 0xdfe6ec : 0x8c98a4), w.fog * 0.7);
  }
  // 晨昏時霧氣帶一點暖色
  if (duskMix > 0) out.fog.lerp(tmpColorA.setHex(0xe8b088), duskMix * 0.14);
  return out;
}

/** 地圖視覺尺度：96 地圖 = 1、304 地圖 = 3.1667（用於天空、霧、粒子範圍等） */
export function mapViewScale(width: number, height: number): number {
  return Math.max(width, height) / 96;
}

/** 霧的遠近距離（相機距離尺度；scale = 地圖視覺尺度） */
export function fogRange(weather: Weather, daylight: number, scale = 1): { near: number; far: number } {
  const base = (95 + daylight * 90) * scale;
  // 夜間稍微放寬霧距，讓城市與遠山在月色下仍可辨識
  const nightK = 1 - clamp01(daylight * 3);
  const nearK = 1 + nightK * 0.55;
  const farK = 1 + nightK * 0.85;
  switch (weather) {
    case 'rain':
      return { near: base * 0.28 * nearK, far: base * 1.5 * farK };
    case 'storm':
      return { near: base * 0.16 * nearK, far: base * 0.95 * farK };
    case 'fog':
      // 大霧鎖港：能見度極低（但保留少許城市輪廓）
      return { near: base * 0.06 * nearK, far: base * 0.42 * farK };
    case 'snow':
      return { near: base * 0.2 * nearK, far: base * 1.15 * farK };
    case 'cloudy':
      return { near: base * 0.55 * nearK, far: base * 2.6 * farK };
    default:
      // 晴天視距較遠，俯瞰全港時仍保留顏色
      return { near: base * 1.0 * nearK, far: base * 6.2 * farK };
  }
}

/** 風力（影響樹搖曳、粒子橫向漂移、海面波浪） */
export function windStrength(weather: Weather, intensity: number): number {
  switch (weather) {
    case 'storm':
      // 颱風：狂風（8 號風球）
      return 6 + intensity * 5;
    case 'rain':
      return 1.5 + intensity * 1.8;
    case 'snow':
      return 1.1 + intensity * 0.9;
    case 'fog':
      return 0.35 + intensity * 0.25;
    case 'cloudy':
      return 0.9 + intensity * 0.35;
    default:
      return 0.5 + intensity * 0.25;
  }
}

/** 降水種類；晴／陰／霧回傳 null；颱風視為暴雨 */
export function precipitationKind(weather: Weather): 'rain' | 'snow' | null {
  if (weather === 'rain' || weather === 'storm') return 'rain';
  if (weather === 'snow') return 'snow';
  return null;
}

/** 天氣對日照亮度的乘數（陰雨雪霧變暗） */
export function weatherLightFactor(weather: Weather): number {
  switch (weather) {
    case 'cloudy':
      return 0.8;
    case 'rain':
      return 0.58;
    case 'storm':
      return 0.34;
    case 'fog':
      return 0.72;
    case 'snow':
      return 0.66;
    default:
      return 1;
  }
}

/**
 * 山頂霜雪量（0..1）：只影響高處。
 * 冬季基礎 0.35～0.6，寒潮（snow）再加；太平山／獅子山較低，大帽山最高。
 */
export function mountainSnowAmount(season: Season, weather: Weather, tempC: number, elevation: number): number {
  // 真實 DTM 高程映射為 0.3–0.92（大帽山 957m ≈ 0.92），舊門檻 0.55 會令
  // 大量山腰變白色階梯方塊。雪線提高到 0.8（≈ 550m 以上），且只在真正寒潮／
  // 下雪天才有明顯積雪。香港冬季一般 15–20°C，晴天不應有雪。
  if (elevation < 0.8) return 0;
  const high = clamp01((elevation - 0.8) / 0.12);
  const cold = clamp01((10 - tempC) / 10);
  let base = 0;
  if (weather === 'snow') base = 0.6 + cold * 0.35;
  else if (season === 'winter' && tempC <= 6) base = 0.2 + cold * 0.3;
  return clamp01(base * high);
}

/** 地面霜／薄雪（冬季清晨、寒潮時低地也有薄霜） */
export function snowCover(season: Season, weather: Weather, tempC: number): number {
  const cold = clamp01((12 - tempC) / 12);
  if (weather === 'snow') return clamp01(0.35 + cold * 0.5);
  if (season === 'winter' && cold > 0.2) return clamp01(cold * 0.35);
  return 0;
}
