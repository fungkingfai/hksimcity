/**
 * 存檔系統：localStorage 自動存檔 + 3 個手動存檔格 + JSON 匯出／匯入（香港版）。
 *
 * v5（480×480 真實地理大地圖）：存檔改為「種子 + 真實地形重新生成 + 稀疏格變更（道路／行人路／分區）」，
 * 不再序列化 230,400 格地形。建築／市民／財政等照舊儲存。
 * 舊版 96×96 完整存檔因尺寸不同會被拒絕（提示重新開局），匯入亦只接受 304×304。
 * 測試／SSR 環境沒有 localStorage 時，所有函式安全地回傳失敗。
 */

import { GAME_VERSION, GRID_HEIGHT, GRID_WIDTH } from './config';
import { createTransitState, displayYear } from './new-game';
import type { GameState, SaveSlotInfo, Tile, ZoneType } from './types';
import { generateWorld } from '../world/worldgen';

const PREFIX = 'victoria-harbour.save.';
export const AUTOSAVE_SLOT = 0;
export const MANUAL_SLOTS = [1, 2, 3] as const;
export const MAX_SLOTS = 4;

/** v4 稀疏分區編碼：zone 0=null 1=住宅 2=商業 3=工業 4=農業；flag bit0=road bit1=sidewalk */
const ZONE_CODE: Record<ZoneType, number> = { residential: 1, commercial: 2, industrial: 3, farmland: 4 };
const CODE_ZONE: (ZoneType | null)[] = [null, 'residential', 'commercial', 'industrial', 'farmland'];

interface CompactSaveFile {
  format: 'hk-city-compact';
  version: number;
  seed: number;
  width: number;
  height: number;
  gameMode: 'starter' | 'empty';
  /** 稀疏格變更：[tileIndex, packed] 成對 */
  tileEdits: number[];
  /** 存檔列表用快照（避免為列表重新生成 304×304 地形） */
  info: {
    slot: number;
    cityName: string;
    population: number;
    treasury: number;
    dateLabel: string;
    savedAt: number;
  };
  /** GameState 除 tiles 以外的完整內容 */
  state: Omit<GameState, 'tiles'>;
}

function packTile(tile: Tile): number {
  const zoneCode = tile.zone ? ZONE_CODE[tile.zone] ?? 0 : 0;
  return (tile.road ? 1 : 0) | (tile.sidewalk ? 2 : 0) | (zoneCode << 2);
}

/** 把完整 state 轉為精簡存檔 JSON 字串 */
export function serializeCompact(state: GameState, slot = 0): string {
  const edits: number[] = [];
  for (let i = 0; i < state.tiles.length; i++) {
    const tile = state.tiles[i];
    if (tile.road || tile.sidewalk || tile.zone) edits.push(i, packTile(tile));
  }
  const { tiles: _tiles, ...rest } = state;
  const file: CompactSaveFile = {
    format: 'hk-city-compact',
    version: GAME_VERSION,
    seed: state.seed,
    width: state.width,
    height: state.height,
    gameMode: state.gameMode,
    tileEdits: edits,
    info: {
      slot,
      cityName: state.cityName,
      population: state.stats.population,
      treasury: state.finance.treasury,
      dateLabel: dateLabel(state),
      savedAt: state.savedAt,
    },
    state: rest,
  };
  return JSON.stringify(file);
}

/** 由精簡存檔還原完整 GameState（重新生成地形 + 套用稀疏變更 + 重建 buildingId） */
export function hydrateCompact(raw: unknown): GameState | null {
  if (!raw || typeof raw !== 'object') return null;
  const file = raw as Partial<CompactSaveFile>;
  if (file.format !== 'hk-city-compact' || !file.state) return null;
  const seed = typeof file.seed === 'number' ? file.seed : 20261021;
  const width = file.width ?? GRID_WIDTH;
  const height = file.height ?? GRID_HEIGHT;
  if (width !== GRID_WIDTH || height !== GRID_HEIGHT) {
    console.warn('[save] 存檔地圖尺寸與目前版本不同，忽略');
    return null;
  }
  const gameMode = file.gameMode === 'starter' ? 'starter' : 'empty';
  const world = generateWorld(seed, width, height, { starterRoads: gameMode === 'starter' });
  const tiles = world.tiles;
  const edits = file.tileEdits ?? [];
  for (let k = 0; k + 1 < edits.length; k += 2) {
    const idx = edits[k];
    const packed = edits[k + 1];
    const tile = tiles[idx];
    if (!tile) continue;
    tile.road = (packed & 1) === 1;
    tile.sidewalk = (packed & 2) === 2;
    tile.zone = CODE_ZONE[(packed >> 2) & 7] ?? null;
  }
  const state = {
    ...(file.state as GameState),
    version: GAME_VERSION,
    seed,
    width,
    height,
    spawn: (file.state as GameState).spawn ?? world.spawn,
    gameMode,
    tiles,
  } as GameState;
  for (const tile of tiles) tile.buildingId = -1;
  for (const building of state.buildings) {
    for (let dy = 0; dy < building.h; dy++) {
      for (let dx = 0; dx < building.w; dx++) {
        const x = building.x + dx;
        const y = building.y + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        tiles[y * width + x].buildingId = building.id;
      }
    }
  }
  return normalizeState(state);
}

function storageKey(slot: number): string {
  return `${PREFIX}slot${slot}`;
}

function hasStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

/** 香港日期標籤：2026年3月1日（星期日） */
export function dateLabel(state: GameState): string {
  const { clock } = state;
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${displayYear(clock.year)}年${clock.month}月${clock.day}日（星期${weekdays[clock.weekday ?? 0]}）`;
}

/** 驗證／升級讀入的存檔物件，失敗回傳 null */
export function normalizeState(raw: unknown): GameState | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Partial<GameState>;
  if (typeof data.width !== 'number' || typeof data.height !== 'number') return null;
  if (!Array.isArray(data.tiles) || !Array.isArray(data.buildings)) return null;
  if (!data.tiles.length) return null;
  if (!data.clock || !data.finance || !data.ui) return null;
  if ((data.width as number) !== GRID_WIDTH || (data.height as number) !== GRID_HEIGHT) {
    console.warn(
      `[save] 存檔地圖 ${data.width}×${data.height} 與目前 ${GRID_WIDTH}×${GRID_HEIGHT} 不相容，忽略`,
    );
    return null;
  }

  const version = typeof data.version === 'number' ? data.version : 1;
  if (version > GAME_VERSION) {
    console.warn(`[save] 存檔版本 ${version} 高於遊戲版本 ${GAME_VERSION}，嘗試載入`);
  }
  data.version = GAME_VERSION;

  // 補齊可能缺失的欄位（存檔相容）
  data.citizens ??= [];
  data.carts ??= [];
  data.vehicles ??= [];
  data.spawn ??= { x: Math.floor(data.width / 2), y: Math.floor(data.height / 2) };
  data.log ??= [];
  data.nextBuildingId ??= data.buildings.reduce((m, b) => Math.max(m, b.id + 1), 1);
  data.nextCitizenId ??= data.citizens.reduce((m, c) => Math.max(m, c.id + 1), 1);
  data.nextCartId ??= data.carts.reduce((m, c) => Math.max(m, c.id + 1), 1);
  data.nextVehicleId ??= data.vehicles.reduce((m, v) => Math.max(m, v.id + 1), 1);
  data.nextLogId ??= data.log.reduce((m, l) => Math.max(m, l.id + 1), 1);
  data.cityName ??= '維港之城';
  data.createdAt ??= Date.now();
  data.savedAt ??= Date.now();

  // 財政
  const f = data.finance;
  f.salaryTaxRate ??= 0.15;
  f.profitTaxRate ??= 0.165;
  f.ratesRate ??= 0.05;
  f.incomeBreakdown ??= {};
  f.expenseBreakdown ??= {};
  f.lastLandSaleDay ??= -999;
  f.landSales ??= 0;

  // 時間
  const c = data.clock;
  c.weekday ??= 0;
  c.warning ??= null;
  c.tempC ??= 22;

  // UI
  const u = data.ui;
  u.showTransit ??= false;
  u.showStats ??= false;
  u.showZones ??= true;
  u.showStartScreen = false;
  u.buildCategory ??= 'civic';
  u.hover ??= -1;

  // 交通
  data.transit ??= createTransitState();
  data.transit.byMode ??= { mtr: 0, bus: 0, tram: 0, ferry: 0 };

  // 分區玩法（v3）
  data.gameMode ??= 'empty';
  data.zoneDemand ??= { residential: 0.3, commercial: 0.2, industrial: 0.2, farmland: 0.1 };
  for (const zone of ['residential', 'commercial', 'industrial', 'farmland'] as const) {
    if (typeof data.zoneDemand[zone] !== 'number') data.zoneDemand[zone] = 0;
  }
  for (const tile of data.tiles) {
    if (tile.zone === undefined) tile.zone = null;
    if (tile.sidewalk === undefined) tile.sidewalk = tile.road ? true : false;
  }

  // 統計
  const stats = (data.stats ??= {
    population: data.citizens.length,
    households: 0,
    jobs: 0,
    employed: 0,
    unemployed: 0,
    homeless: 0,
    happiness: 50,
    foodStored: 0,
    foodPerDay: 0,
    netIncome: 0,
    goodsInTransit: 0,
    powerCoverage: 0,
    waterCoverage: 0,
    transitCoverage: 0,
    ridership: 0,
    avgCommute: 0,
    typhoonSignal: 0,
    zoneDemand: { ...data.zoneDemand },
    zoneTiles: { residential: 0, commercial: 0, industrial: 0, farmland: 0 },
    zoneBuildings: { residential: 0, commercial: 0, industrial: 0, farmland: 0 },
    policeCoverage: 0,
    fireCoverage: 0,
    schoolCoverage: 0,
    hospitalCoverage: 0,
    landValue: 0,
  });
  stats.powerCoverage ??= 0;
  stats.waterCoverage ??= 0;
  stats.transitCoverage ??= 0;
  stats.ridership ??= 0;
  stats.avgCommute ??= 0;
  stats.typhoonSignal ??= 0;
  stats.zoneDemand ??= { ...data.zoneDemand };
  stats.zoneTiles ??= { residential: 0, commercial: 0, industrial: 0, farmland: 0 };
  stats.zoneBuildings ??= { residential: 0, commercial: 0, industrial: 0, farmland: 0 };
  stats.policeCoverage ??= 0;
  stats.fireCoverage ??= 0;
  stats.schoolCoverage ??= 0;
  stats.hospitalCoverage ??= 0;
  stats.landValue ??= 0;

  // 市民／貨車相容欄位
  for (const citizen of data.citizens) {
    citizen.salary ??= 18_000;
    citizen.commuteMode ??= 'walk';
    if (citizen.needs && citizen.needs.leisure === undefined) {
      (citizen.needs as unknown as { leisure: number }).leisure =
        (citizen.needs as unknown as { culture?: number }).culture ?? 50;
    }
  }
  for (const cart of data.carts) {
    cart.vehicleKind ??= 'truck';
  }
  for (const building of data.buildings) {
    building.auto ??= false;
    if (building.zone === undefined) building.zone = undefined;
  }

  return data as GameState;
}

export function saveToSlot(state: GameState, slot: number): boolean {
  if (!hasStorage()) return false;
  if (slot < 0 || slot >= MAX_SLOTS) return false;
  try {
    state.savedAt = Date.now();
    state.version = GAME_VERSION;
    localStorage.setItem(storageKey(slot), serializeCompact(state, slot));
    return true;
  } catch (err) {
    console.error('[save] 寫入失敗', err);
    return false;
  }
}

export function loadFromSlot(slot: number): GameState | null {
  if (!hasStorage()) return null;
  try {
    const text = localStorage.getItem(storageKey(slot));
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && (parsed as { format?: string }).format === 'hk-city-compact') {
      return hydrateCompact(parsed);
    }
    return normalizeState(parsed);
  } catch (err) {
    console.error('[save] 讀取失敗', err);
    return null;
  }
}

export function deleteSlot(slot: number): void {
  if (!hasStorage()) return;
  try {
    localStorage.removeItem(storageKey(slot));
  } catch {
    /* ignore */
  }
}

export function getSaveSlotInfo(slot: number): SaveSlotInfo {
  const base: SaveSlotInfo = {
    slot,
    empty: true,
    cityName: '',
    population: 0,
    treasury: 0,
    dateLabel: '',
    savedAt: 0,
  };
  if (!hasStorage()) return base;
  try {
    const text = localStorage.getItem(storageKey(slot));
    if (!text) return base;
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && (parsed as { format?: string }).format === 'hk-city-compact') {
      const info = (parsed as CompactSaveFile).info;
      if (!info) return base;
      return {
        slot,
        empty: false,
        cityName: info.cityName,
        population: info.population,
        treasury: info.treasury,
        dateLabel: info.dateLabel,
        savedAt: info.savedAt,
      };
    }
    const state = normalizeState(parsed);
    if (!state) return base;
    return {
      slot,
      empty: false,
      cityName: state.cityName,
      population: state.stats.population,
      treasury: state.finance.treasury,
      dateLabel: dateLabel(state),
      savedAt: state.savedAt,
    };
  } catch {
    return base;
  }
}

export function listSaves(): SaveSlotInfo[] {
  const result: SaveSlotInfo[] = [];
  for (let slot = 0; slot < MAX_SLOTS; slot++) result.push(getSaveSlotInfo(slot));
  return result;
}

export function autosave(state: GameState): boolean {
  return saveToSlot(state, AUTOSAVE_SLOT);
}

export function loadAutosave(): GameState | null {
  return loadFromSlot(AUTOSAVE_SLOT);
}

/** 觸發瀏覽器下載 JSON 存檔 */
export function exportSave(state: GameState): void {
  if (typeof document === 'undefined') return;
  const safeName = state.cityName.replace(/[\\/:*?"<>|]/g, '_');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const blob = new Blob([serializeCompact(state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `victoria-harbour-${safeName}-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 讀取使用者選擇的 JSON 存檔 */
export async function importSaveFile(file: File): Promise<GameState | null> {
  try {
    const text = await file.text();
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && (parsed as { format?: string }).format === 'hk-city-compact') {
      return hydrateCompact(parsed);
    }
    return normalizeState(parsed);
  } catch (err) {
    console.error('[save] 匯入失敗', err);
    return null;
  }
}
