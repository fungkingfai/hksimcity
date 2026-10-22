/**
 * 物流庫存規則（《維港之城》4 種資源）。
 *
 * 資源：food 食品、goods 日用品、electronics 電子產品、materials 建材
 * （見 core/config.ts RESOURCES）。
 *
 * 各建築可存放的資源
 *   - 倉儲類（貨倉／超市／商場／街市／便利店／進口商行等有 BuildingDef.storage 者）：
 *     依 storage.accepted（'all' = 全部物流資源），容量 = storage.capacity（總量制）。
 *   - 生產建築（農田／食品廠／工廈／石礦場／貨櫃碼頭／進口商行）：
 *     產出物與投入物各自一個本地暫存，上限 PRODUCER_LOCAL_CAP。
 *   - 服務建築（茶餐廳／酒樓／醫院）：各自備料上限 SERVICE_STOCK_CAP（服務 consumes 的資源）。
 *   - 其他建築：容量 0，不參與物流。
 *
 * 所有貨物移動都經由 addCargo / removeCargo 實際加減，不可憑空生成或消失
 * （生產與服務消耗由 production.ts／finance.ts 負責）。
 *
 * 零售貨架目標 MARKET_SHELF_TARGETS 以「街市（storage 300）」為基準，
 * 依實際貨架容量按比例縮放（便利店細貨架、超市大貨架），見 shelfTargetFor()。
 */

import { BUILDINGS, RESOURCES } from '../core/config';
import type { Building, ResourceKey } from '../core/types';

/** 生產建築本地暫存上限（每個資源；產出與投入分開計；GDD §4.5 本地暫存 60） */
export const PRODUCER_LOCAL_CAP = 60;
/** 服務建築營運備料上限（無特別設定者；茶餐廳／酒樓另見 SERVICE_STOCK_CAPS） */
export const SERVICE_STOCK_CAP = 30;

/** 服務建築備料上限（GDD §4.6：茶餐廳本地暫存 40、酒樓 60、醫院 40） */
export const SERVICE_STOCK_CAPS: Record<string, number> = {
  chaChaanTeng: 40,
  restaurant: 60,
  hospital: 40,
};

/** 服務建築備料目標 = 上限 × 此比例（物流補貨目標） */
export const SERVICE_STOCK_TARGET_RATIO = 0.75;

/** 物流會補進零售貨架的民生資源（建材不零售；電子產品只有商場／超市賣） */
export const MARKET_GOODS: ResourceKey[] = ['food', 'goods', 'electronics'];

/**
 * 零售貨架目標（GDD §4.6 表格；單位）。
 * 這些是各零售點「理想存量」，物流會補到呢個數，貨架容量見 config.storage.capacity。
 */
export const RETAIL_SHELF_TARGETS: Record<string, Partial<Record<ResourceKey, number>>> = {
  convenienceStore: { food: 30, goods: 40 },
  wetMarket: { food: 120, goods: 60 },
  supermarket: { food: 150, goods: 120 },
  shoppingMall: { food: 80, goods: 200, electronics: 40 },
};

/**
 * 通用零售貨架目標（以街市為基準；未知零售點或 data-driven fallback 用）。
 * 具體建築優先看 RETAIL_SHELF_TARGETS。
 */
export const MARKET_SHELF_TARGETS: Partial<Record<ResourceKey, number>> = {
  food: 120,
  goods: 60,
  electronics: 40,
};

/** 基準貨架容量（MARKET_SHELF_TARGETS 以此容量為 1.0 倍） */
export const RETAIL_TARGET_BASE_CAPACITY = 300;

/** 建築對應的定義（未知建築回傳 undefined） */
export function defOf(building: Building) {
  return BUILDINGS[building.key];
}

/** 是否為倉儲建築（有 storage 定義） */
export function isStorage(building: Building): boolean {
  return !!BUILDINGS[building.key]?.storage;
}

/** 是否為生產建築 */
export function isProducer(building: Building): boolean {
  return !!BUILDINGS[building.key]?.production;
}

/** 服務種類（'market' | 'restaurant' | ...；非服務建築回傳 null） */
export function serviceKindOf(building: Building): string | null {
  return BUILDINGS[building.key]?.service?.kind ?? null;
}

/** 是否零售點（街市／超市／便利店／商場） */
export function isMarket(building: Building): boolean {
  return serviceKindOf(building) === 'market';
}

/** 是否餐飲（茶餐廳／酒樓） */
export function isRestaurant(building: Building): boolean {
  return serviceKindOf(building) === 'restaurant';
}

/** 是否物流倉儲（貨倉或進口商行等 logistics 類有 storage 的建築） */
export function isLogisticsStorage(building: Building): boolean {
  const def = BUILDINGS[building.key];
  return !!def?.storage && def.category === 'logistics';
}

/** 該建築可存放哪些資源；null 代表不可存放任何資源 */
export function acceptedResourcesOf(building: Building): ResourceKey[] | 'all' | null {
  const def = BUILDINGS[building.key];
  if (!def) return null;
  if (def.storage) return def.storage.accepted;
  if (def.production) {
    const list: ResourceKey[] = [def.production.output];
    if (def.production.input) list.push(def.production.input.resource);
    return list;
  }
  if (def.service?.consumes) return [def.service.consumes.resource];
  return null;
}

/** 建築庫存容量（總量制）。0 代表不能存貨。 */
export function capacityOf(building: Building): number {
  const def = BUILDINGS[building.key];
  if (!def) return 0;
  if (def.storage) return def.storage.capacity;
  // 生產／服務建築以「單一資源上限」計，總容量給 UI 一個參考值
  if (def.production) return PRODUCER_LOCAL_CAP;
  if (def.service?.consumes) return SERVICE_STOCK_CAPS[building.key] ?? SERVICE_STOCK_CAP;
  return 0;
}

/** 是否接受某資源 */
export function accepts(building: Building, resource: ResourceKey): boolean {
  const accepted = acceptedResourcesOf(building);
  if (!accepted) return false;
  return accepted === 'all' || accepted.includes(resource);
}

/** 目前庫存總量 */
export function inventoryTotal(building: Building): number {
  let total = 0;
  for (const key in building.inventory) {
    total += building.inventory[key as ResourceKey] ?? 0;
  }
  return total;
}

/**
 * 該建築對「某資源」還可容納多少（扣除 reserved：已派車、尚未抵達的入庫量）。
 * - 倉儲／零售貨架：容量為所有資源總和制。
 * - 生產建築：每個資源各自上限 PRODUCER_LOCAL_CAP（產出與投入分開）。
 * - 服務建築：備料上限 SERVICE_STOCK_CAP。
 * - 其他建築：0。
 */
export function freeCapacityFor(building: Building, resource: ResourceKey, reserved = 0): number {
  if (!accepts(building, resource)) return 0;
  const def = BUILDINGS[building.key];
  if (!def) return 0;
  if (def.storage) {
    return Math.max(0, def.storage.capacity - inventoryTotal(building) - reserved);
  }
  if (def.production) {
    return Math.max(0, PRODUCER_LOCAL_CAP - (building.inventory[resource] ?? 0) - reserved);
  }
  if (def.service?.consumes) {
    const cap = SERVICE_STOCK_CAPS[building.key] ?? SERVICE_STOCK_CAP;
    return Math.max(0, cap - (building.inventory[resource] ?? 0) - reserved);
  }
  return 0;
}

/** 可再容納的總量（總量制建築用；生產／服務建築請用 freeCapacityFor） */
export function freeCapacity(building: Building, reserved = 0): number {
  return Math.max(0, capacityOf(building) - inventoryTotal(building) - reserved);
}

/** 某資源目前庫存量 */
export function stockOf(building: Building, resource: ResourceKey): number {
  return building.inventory[resource] ?? 0;
}

/** 資源數量保留一位小數（避免 0.30000000000000004 類誤差） */
export function roundQty(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 把貨物加入建築庫存；回傳實際加入量（0 表示不接受／已滿）。
 * 不會超過容量；小數保留一位，避免浮點誤差累積。
 */
export function addCargo(building: Building, resource: ResourceKey, amount: number, reserved = 0): number {
  if (!(amount > 0) || !accepts(building, resource)) return 0;
  const room = freeCapacityFor(building, resource, reserved);
  if (room <= 0) return 0;
  const added = Math.min(amount, room);
  building.inventory[resource] = roundQty((building.inventory[resource] ?? 0) + added);
  return added;
}

/** 從建築庫存取出貨物；回傳實際取出量 */
export function removeCargo(building: Building, resource: ResourceKey, amount: number): number {
  if (!(amount > 0)) return 0;
  const have = building.inventory[resource] ?? 0;
  if (have <= 0) return 0;
  const taken = Math.min(have, amount);
  const left = roundQty(have - taken);
  if (left <= 0.0001) delete building.inventory[resource];
  else building.inventory[resource] = left;
  return taken;
}

/** 服務建築補貨目標（茶餐廳 30、酒樓 45、醫院 30） */
export function serviceStockTargetFor(building: Building): number {
  const cap = SERVICE_STOCK_CAPS[building.key] ?? SERVICE_STOCK_CAP;
  return Math.max(4, Math.round(cap * SERVICE_STOCK_TARGET_RATIO));
}

/**
 * 零售貨架目標：
 *   1. RETAIL_SHELF_TARGETS 有該建築 key → 直接用（GDD §4.6 表格）
 *   2. 否則 = MARKET_SHELF_TARGETS[resource] × clamp(容量 / 300, 0.35, 1.4)
 */
export function shelfTargetFor(building: Building, resource: ResourceKey): number {
  if (!accepts(building, resource)) return 0;
  const table = RETAIL_SHELF_TARGETS[building.key];
  if (table) return table[resource] ?? 0;
  const base = MARKET_SHELF_TARGETS[resource] ?? 0;
  if (base <= 0) return 0;
  const capacity = BUILDINGS[building.key]?.storage?.capacity ?? 0;
  const scale = Math.max(0.35, Math.min(1.4, capacity / RETAIL_TARGET_BASE_CAPACITY));
  return Math.round(base * scale);
}

/** 零售點貨架總填充率 0..1（UI 物流健康度用） */
export function shelfFillRatio(building: Building): number {
  const capacity = BUILDINGS[building.key]?.storage?.capacity ?? 0;
  if (capacity <= 0) return 0;
  return Math.min(1, inventoryTotal(building) / capacity);
}

/** 資源中文名（UI 用） */
export function resourceName(resource: ResourceKey): string {
  return RESOURCES[resource]?.name ?? resource;
}
