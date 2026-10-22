/**
 * 生產系統：每日結算生產建築的產出、投入與本地暫存（《維港之城》）。
 *
 * 對外契約：tickProduction(state, ctx): void（每日一次，由 simulation.ts 在跨日時呼叫）
 *
 * 香港版生產建築（見 core/config.ts）：
 *   農田 farm            → food 24／日（吃地形：農地／平地，四季分明，免臨路）
 *   食品廠 foodFactory   → food 16／日（投入 goods 3）
 *   工廈 industrialBuilding → electronics 6／日（投入 materials 5）
 *   石礦場 quarry        → materials 12／日（丘陵）
 *   貨櫃碼頭 containerPort → goods 45／日（進口）
 *   進口商行 importFirm  → goods 10／日（進口）
 *
 * 規則
 * 1. 只有 building.active（連街或免臨路）的生產建築才營運。
 * 2. 效率 = 工人比例（workers.length / def.workers）；無工人即停工。
 * 3. 倍率：
 *    季節：production.seasonBonus（無設定時食品按 SEASON_FARM_BONUS 室內化折半）
 *    天氣：production.weatherBonus（無設定時露天生產用 WEATHER_EFFECT.farm）
 *    地形：生產建築自身的 allowedTerrain 地形（農地 +30%／丘陵 +20%，按覆蓋格比例）
 *    公用設施：發電廠／水務設施圓形覆蓋內可用；全城供應容量不足則按比例減產。
 *    每日 ±7% 可重現小波動（hash2d）。
 * 4. 需要 input 的工廠先從「自己的」inventory 扣料；不足則當日停產
 *    （物流會負責把原料補進來，production 不主動領料）。
 * 5. 產出只寫入 building.inventory（本地暫存上限 60／資源），
 *    由 logistics.ts 的貨車搬去貨倉／零售；生產不直接入庫房。
 */

import {
  BUILDINGS,
  RESOURCES,
  SEASON_FARM_BONUS,
  WEATHER_EFFECT,
} from '../core/config';
import { hash2d } from '../core/rng';
import type { Building, GameState, ResourceKey, SimContext, TerrainType } from '../core/types';
import { addCargo, removeCargo, stockOf } from './logistics-inventory';

/** 生產建築本地暫存上限（與 logistics-inventory.PRODUCER_LOCAL_CAP 一致；物流前來搬走前上限） */
export const PRODUCTION_LOCAL_CAP = 60;

/**
 * 地形加成表：output → 地形 → 加成比例。
 * 農田在農地 +30%；石礦場在丘陵 +20%（config 的 allowedTerrain 已限制只能建在該地形）。
 */
const TERRAIN_BONUS: Partial<Record<ResourceKey, Partial<Record<TerrainType, number>>>> = {
  food: { fertile: 0.3 },
  materials: { hill: 0.2 },
};

/** 露天生產（受天氣 farm 倍率直接影響）；其餘視為室內廠房，影響減弱 */
const OUTDOOR_OUTPUTS: ReadonlySet<ResourceKey> = new Set<ResourceKey>(['food', 'materials']);

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** 工人比例 0..1 */
function workerRatio(building: Building, required: number): number {
  if (required <= 0) return 1;
  return Math.max(0, Math.min(1, building.workers.length / required));
}

/** 建築覆蓋範圍內的地形加成（以格數比例加權），回傳 ≥1 的乘數 */
function terrainMultiplier(state: GameState, building: Building, output: ResourceKey): number {
  const table = TERRAIN_BONUS[output];
  if (!table) return 1;
  let bonus = 0;
  let tiles = 0;
  for (let dy = 0; dy < building.h; dy++) {
    for (let dx = 0; dx < building.w; dx++) {
      const tx = building.x + dx;
      const ty = building.y + dy;
      if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) continue;
      const tile = state.tiles[ty * state.width + tx];
      tiles++;
      bonus += table[tile.terrain] ?? 0;
    }
  }
  if (tiles === 0) return 1;
  return 1 + bonus / tiles;
}

/** 季節倍率 */
function seasonMultiplier(state: GameState, building: Building, output: ResourceKey): number {
  const production = BUILDINGS[building.key]?.production;
  if (!production) return 1;
  const explicit = production.seasonBonus?.[state.clock.season];
  if (typeof explicit === 'number') return explicit;
  // 未設定的食品生產（如食品廠）受季節影響較輕（室內加工）
  if (output === 'food') {
    const farmBonus = SEASON_FARM_BONUS[state.clock.season];
    return 1 + (farmBonus - 1) * 0.35;
  }
  return 1;
}

/** 天氣倍率 */
function weatherMultiplier(state: GameState, building: Building, output: ResourceKey): number {
  const production = BUILDINGS[building.key]?.production;
  if (!production) return 1;
  const weather = state.clock.weather;
  const explicit = production.weatherBonus?.[weather];
  if (typeof explicit === 'number') return explicit;
  const farmEffect = WEATHER_EFFECT[weather].farm;
  if (OUTDOOR_OUTPUTS.has(output)) return farmEffect;
  // 室內廠房：天氣只透過原料／物流間接影響
  return 1 + (farmEffect - 1) * 0.25;
}

// ─────────────────────────── 公用設施（電力／食水） ───────────────────────────

interface UtilityInfo {
  buildings: Building[];
  radius: number;
  capacity: number;
  /** 需求（人口單位） */
  demand: number;
  /** 全城供應比例 0..1（容量不足時 <1） */
  supplyRatio: number;
}

function centerOf(building: Building): { x: number; y: number } {
  return { x: building.x + building.w / 2, y: building.y + building.h / 2 };
}

function withinRadius(a: Building, b: Building, radius: number): boolean {
  const ca = centerOf(a);
  const cb = centerOf(b);
  const dx = ca.x - cb.x;
  const dy = ca.y - cb.y;
  return dx * dx + dy * dy <= radius * radius;
}

/** 全城公用設施供應情況（電力需求以人口＋工業用電估算） */
export function utilityStatus(state: GameState, kind: 'power' | 'water'): UtilityInfo {
  const buildings: Building[] = [];
  let capacity = 0;
  let radius = 0;
  for (const building of state.buildings) {
    const utility = BUILDINGS[building.key]?.utility;
    if (!utility || utility.kind !== kind) continue;
    if (!building.active) continue;
    buildings.push(building);
    capacity += utility.capacity;
    radius = Math.max(radius, utility.radius);
  }
  // 需求：人口 + 工業／物流建築工人（用電較多）
  let demand = state.citizens.length;
  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    if (!def) continue;
    if (def.category === 'industrial' || def.category === 'logistics') {
      demand += def.workers * 0.6;
    } else if (def.category === 'commercial') {
      demand += def.workers * 0.3;
    }
  }
  demand = Math.max(1, demand);
  const supplyRatio = capacity > 0 ? Math.min(1, capacity / demand) : 0;
  return { buildings, radius, capacity, demand: round2(demand), supplyRatio };
}

/**
 * 某建築的公用設施服務係數 0..1：
 *   - 全城未建同類設施 → 0.55（小店自備發電機／水缸，只夠半力生產；開局不至於停擺）
 *   - 不在任何設施半徑內 → 0.45（舊區電網／水壓不足）
 *   - 在覆蓋內但全城容量不足 → 0.6 + 0.4 × supplyRatio
 *   - 正常 → 1
 */
function utilityFactor(info: UtilityInfo, building: Building): number {
  if (!info.buildings.length) return 0.55;
  let inside = false;
  for (const utility of info.buildings) {
    const radius = BUILDINGS[utility.key]?.utility?.radius ?? info.radius;
    if (withinRadius(utility, building, radius)) {
      inside = true;
      break;
    }
  }
  if (!inside) return 0.45;
  if (info.supplyRatio >= 0.999) return 1;
  return 0.6 + 0.4 * info.supplyRatio;
}

// ─────────────────────────── 每日生產 ───────────────────────────

/** 地形限制（config allowedTerrain）帶來的額外產量說明 */
function allowedTerrainBonus(state: GameState, building: Building): number {
  // 已於 terrainMultiplier 處理；此函式保留給未來擴充
  void state;
  void building;
  return 1;
}

/** 每日生產結算 */
export function tickProduction(state: GameState, ctx: SimContext): void {
  const clock = state.clock;
  const stalled: string[] = [];
  const power = utilityStatus(state, 'power');
  const water = utilityStatus(state, 'water');

  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    const production = def?.production;
    if (!production) continue;

    if (!building.active) {
      building.productionProgress = 0;
      stalled.push(def.name);
      continue;
    }

    const ratio = workerRatio(building, def.workers);
    if (ratio <= 0) {
      building.productionProgress = 0;
      stalled.push(def.name);
      continue;
    }

    // 需要原料者：先確認自己的本地庫存足量（不足則整批停產；物流負責補料）
    const inputDef = production.input;
    const inputNeed = inputDef ? inputDef.amountPerDay * ratio : 0;
    if (inputDef && stockOf(building, inputDef.resource) + 1e-6 < inputNeed) {
      building.productionProgress = 0;
      stalled.push(def.name);
      continue;
    }

    // 本地暫存已滿（扣除投入後仍有空間才生產）
    const inputStockNow = inputDef ? stockOf(building, inputDef.resource) : 0;
    const outputStockNow = stockOf(building, production.output);
    const roomAfterInput = PRODUCTION_LOCAL_CAP - (inputStockNow - inputNeed) - outputStockNow;
    if (roomAfterInput <= 0.01) {
      building.productionProgress = 0;
      continue;
    }

    // 扣投入原料
    if (inputDef) removeCargo(building, inputDef.resource, inputNeed);

    const seasonMult = seasonMultiplier(state, building, production.output);
    const weatherMult = weatherMultiplier(state, building, production.output);
    const terrainMult = terrainMultiplier(state, building, production.output);
    // 公用設施：電子廠吃電、食品廠／農田吃水（兩者都略受影響）
    const powerFactor = utilityFactor(power, building);
    const waterFactor = utilityFactor(water, building);
    const utilityMult =
      production.output === 'electronics'
        ? powerFactor * (0.9 + 0.1 * waterFactor)
        : production.output === 'food'
          ? waterFactor * (0.9 + 0.1 * powerFactor)
          : 0.75 + 0.25 * Math.min(powerFactor, waterFactor);
    // 每日 ±7% 可重現小波動
    const dailyNoise = 1 + (hash2d(building.id, clock.totalDays, state.seed) - 0.5) * 0.14;
    const potential =
      production.amountPerDay * ratio * seasonMult * weatherMult * terrainMult * utilityMult * allowedTerrainBonus(state, building);
    const produced = potential * dailyNoise;

    const added = addCargo(building, production.output, produced);
    building.productionProgress = Math.max(0, Math.min(1, potential / production.amountPerDay));

    // 本地暫存已滿：多餘產出只能浪費（等待貨車清空）；偶爾提醒
    if (added < produced - 0.01 && clock.totalDays % 6 === 0 && (building.id + clock.totalDays) % 6 === 0) {
      ctx.log(
        `「${def.name}」的本地存貨已滿，多餘${RESOURCES[production.output]?.name ?? '貨物'}暫時無法出貨。`,
        'warn',
      );
    }
  }

  // 停工提示：每 3 日彙總一次，避免每棟建築每日洗版
  if (stalled.length > 0 && clock.totalDays % 3 === 0) {
    const names = [...new Set(stalled)];
    const shown = names.slice(0, 3).join('、');
    const more = names.length > 3 ? ` 等 ${names.length} 類` : '';
    ctx.log(`${shown}${more}工廠停工：待補工人、原料或道路連通。`, 'warn');
  }

  // 電力／食水不足提示（每 5 日一次）
  if (clock.totalDays % 5 === 0) {
    if (state.citizens.length > 0 && power.supplyRatio < 0.85) {
      ctx.log(
        `全城電力供應緊張（供應 ${Math.round(power.supplyRatio * 100)}%），工廠與商廈減產；請加建發電廠。`,
        'warn',
      );
    }
    if (state.citizens.length > 0 && water.supplyRatio < 0.85) {
      ctx.log(
        `全城食水供應緊張（供應 ${Math.round(water.supplyRatio * 100)}%），食品生產受影響；請加建水務設施。`,
        'warn',
      );
    }
  }
}
