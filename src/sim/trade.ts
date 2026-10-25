/**
 * 機場／貨櫃碼頭貿易結算（Round 5）。
 *
 * 機場：客運大樓＋空運貨運站 → 旅客／貨運量、收入、就業、噪音；
 *       8 格內冇公共交通接駁 → 客流 ×0.7；颱風 8 號關閉（收入 0）。
 * 貨櫃碼頭：containerPort＋portGate＋portYard → TEU 吞吐／收入；
 *       任何臨水地點都可建；葵涌貨櫃碼頭區有吞吐加成，區外只有輕微折扣（×0.9）。
 * 升級：airportTerminal／containerPort 可升 level 1–3（成本見 TRADE_CONFIG）。
 * 收入以 finance income 'other' 逐日入帳（與服務收入模式一致）。
 */

import { BUILDINGS, TRADE_CONFIG } from '../core/config';
import type { Building, GameState, SimContext } from '../core/types';
import { addIncome } from './finance';
import { buildingInRegion } from './placement';

const round2 = (v: number): number => Math.round(v * 100) / 100;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 建築中心 */
function centerOf(building: Building): { x: number; y: number } {
  return { x: building.x + building.w / 2, y: building.y + building.h / 2 };
}

/** 設施等級倍率（level 1→1、2→1.5、3→2） */
function levelMultiplier(level: number): number {
  const lv = Math.max(1, Math.min(3, Math.floor(level) || 1));
  return 1 + 0.5 * (lv - 1);
}

/** 取某 tradeRole 的 active 建築 */
function activeRoleBuildings(state: GameState, role: string): Building[] {
  const result: Building[] = [];
  for (const building of state.buildings) {
    if (!building.active) continue;
    if (BUILDINGS[building.key]?.tradeRole === role) result.push(building);
  }
  return result;
}

/** 建築 8 格內（歐氏距離）是否有公共交通站（MTR／巴士／小巴／電車／渡輪） */
function hasTransitNear(state: GameState, building: Building, radius = TRADE_CONFIG.airport.transitRadius): boolean {
  const center = centerOf(building);
  const r2 = radius * radius;
  for (const other of state.buildings) {
    if (!BUILDINGS[other.key]?.transit) continue;
    if (!other.active) continue;
    const c = centerOf(other);
    const dx = c.x - center.x;
    const dy = c.y - center.y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}

/** 工業／物流每日產出（單位；用作空運／海運貨運需求） */
function industrialOutputUnits(state: GameState): number {
  let units = 0;
  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    const production = def?.production;
    if (!production) continue;
    if (!building.active) continue;
    if (def.category !== 'industrial' && def.category !== 'logistics') continue;
    const ratio = def.workers > 0 ? clamp01(building.workers.length / def.workers) : 1;
    units += production.amountPerDay * ratio;
  }
  return units;
}

/** 商業就業人數（已入職） */
function commercialJobs(state: GameState): number {
  let jobs = 0;
  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    if (!def || def.category !== 'commercial' || def.workers <= 0) continue;
    if (!building.active) continue;
    jobs += Math.min(def.workers, building.workers.length);
  }
  return jobs;
}

/** 颱風訊號 ≥8 時機場關閉 */
function airportClosed(state: GameState): boolean {
  return (state.stats.typhoonSignal ?? 0) >= 8;
}

/** 機場半徑 25 格內住宅居民比例（噪音投訴 0..1） */
function noiseComplaints(state: GameState, terminals: Building[]): number {
  if (!terminals.length) return 0;
  const population = state.citizens.length;
  if (population <= 0) return 0;
  const radius = 25;
  const r2 = radius * radius;
  const centers = terminals.map(centerOf);
  let affected = 0;
  for (const home of state.buildings) {
    const def = BUILDINGS[home.key];
    if (!def || def.housing <= 0 || home.residents.length === 0) continue;
    const c = centerOf(home);
    for (const center of centers) {
      const dx = c.x - center.x;
      const dy = c.y - center.y;
      if (dx * dx + dy * dy <= r2) {
        affected += home.residents.length;
        break;
      }
    }
  }
  return round2(clamp01(affected / population));
}

/**
 * 每日貿易結算：由 simulation.ts 跨日時呼叫。
 * 會更新 state.trade、stats.airportPassengers／portThroughput／tradeRevenue，
 * 並把收入即時入庫房（finance income 'other'）。
 */
export function tickTrade(state: GameState, ctx: SimContext): void {
  const clock = state.clock;
  const population = state.citizens.length;
  const closed = airportClosed(state);
  const cfg = TRADE_CONFIG;

  // ── 機場 ──
  const passengerTerminals = activeRoleBuildings(state, 'airportPassenger');
  const cargoTerminals = activeRoleBuildings(state, 'airportCargo');
  let passengerCapacity = 0;
  for (const terminal of passengerTerminals) {
    passengerCapacity += cfg.airport.terminalCapacity * levelMultiplier(terminal.level);
  }
  let cargoCapacity = 0;
  for (const terminal of cargoTerminals) {
    cargoCapacity += cfg.airport.cargoCapacityPerTerminal * levelMultiplier(terminal.level);
  }
  const weather = cfg.airport.weatherFactor[state.clock.weather] ?? 1;
  const transitLinked =
    passengerTerminals.length > 0
      ? passengerTerminals.some((t) => hasTransitNear(state, t))
      : cargoTerminals.some((t) => hasTransitNear(state, t));
  const transitFactor = transitLinked ? 1 : cfg.airport.noTransitDiscount;
  const passengerDemand =
    cfg.airport.passengerBase +
    population * cfg.airport.passengerPerPopulation +
    commercialJobs(state) * cfg.airport.passengerPerCommercialJob;
  const industrialOutput = industrialOutputUnits(state);
  const passengers =
    closed || !passengerTerminals.length
      ? 0
      : round2(Math.min(passengerCapacity, passengerDemand * weather) * transitFactor);
  const cargo =
    closed || !cargoTerminals.length
      ? 0
      : round2(Math.min(cargoCapacity, industrialOutput * 0.2) * transitFactor);
  const airportRevenue = closed
    ? 0
    : round2(passengers * cfg.airport.passengerFare + cargo * cfg.airport.cargoRevenuePerTonne);
  const airportJobs =
    passengerTerminals.reduce((sum, b) => sum + (BUILDINGS[b.key]?.workers ?? 0), 0) +
    cargoTerminals.reduce((sum, b) => sum + (BUILDINGS[b.key]?.workers ?? 0), 0);
  const noise = closed ? 0 : noiseComplaints(state, passengerTerminals);

  // ── 貨櫃碼頭 ──
  const portTerminals = activeRoleBuildings(state, 'portTerminal');
  const portGates = activeRoleBuildings(state, 'portGate');
  const portYards = activeRoleBuildings(state, 'portYard');
  const offRegion = cfg.port.offRegionPenalty;
  let teuCapacity = 0;
  for (const terminal of portTerminals) {
    const inRegion = buildingInRegion(state, terminal, 'containerPort');
    teuCapacity += cfg.port.terminalCapacity * levelMultiplier(terminal.level) * (inRegion ? 1 : offRegion);
  }
  for (const gate of portGates) {
    const inRegion = buildingInRegion(state, gate, 'containerPort');
    teuCapacity += cfg.port.gateCapacity * (inRegion ? 1 : offRegion);
  }
  for (const yard of portYards) {
    const inRegion = buildingInRegion(state, yard, 'containerPort');
    teuCapacity += cfg.port.yardCapacity * (inRegion ? 1 : offRegion);
  }
  // 1 TEU ≈ 8 個貨物單位（見 ROUND5_AIRPORT_PORT 設計）；另加人口帶動的本地貿易
  const portDemand = industrialOutput / 8 + population * 0.05;
  const throughput = round2(Math.min(teuCapacity, portDemand));
  const portRevenue = round2(throughput * cfg.port.revenuePerTeu);
  const portJobs =
    portTerminals.reduce((sum, b) => sum + (BUILDINGS[b.key]?.workers ?? 0), 0) +
    portGates.reduce((sum, b) => sum + (BUILDINGS[b.key]?.workers ?? 0), 0) +
    portYards.reduce((sum, b) => sum + (BUILDINGS[b.key]?.workers ?? 0), 0);

  const tradeRevenue = round2(airportRevenue + portRevenue);
  state.trade = {
    airport: {
      passengerCapacity: round2(passengerCapacity),
      passengers,
      cargoCapacity: round2(cargoCapacity),
      cargo,
      revenueToday: airportRevenue,
      jobs: airportJobs,
      noiseComplaints: noise,
    },
    port: {
      teuCapacity: round2(teuCapacity),
      throughput,
      revenueToday: portRevenue,
      jobs: portJobs,
    },
    lastUpdatedDay: clock.totalDays,
  };

  // stats（UI 面板直接讀）
  state.stats.airportPassengers = passengers;
  state.stats.portThroughput = throughput;
  state.stats.tradeRevenue = tradeRevenue;

  // 收入即時入帳（finance income 'other'）
  if (tradeRevenue > 0) {
    addIncome(state.finance, 'other', tradeRevenue);
    state.finance.treasury = round2(state.finance.treasury + tradeRevenue);
  }

  // 旅遊業帶動商業需求（合約：tourism 令商業需求 +0.05）
  if (passengers > 0) {
    state.zoneDemand.commercial = round2(Math.min(1, (state.zoneDemand.commercial ?? 0) + 0.05));
  }

  // 提示（每 6 日一次，避免洗版）
  if (clock.totalDays % 6 === 0) {
    if (airportJobs > 0 || portJobs > 0) {
      if (!transitLinked && (passengerTerminals.length > 0 || cargoTerminals.length > 0)) {
        ctx.log('機場未有公共交通接駁（8 格內無車站），旅客量打七折；可考慮加建港鐵站／巴士站。', 'warn');
      }
      if (!closed && noise > 0.25 && passengerTerminals.length > 0) {
        ctx.log('機場噪音影響附近居民，請避免在跑道及客運大樓 25 格內建住宅。', 'info');
      }
    }
    if (portTerminals.length > 0) {
      const outside = portTerminals.some((t) => !buildingInRegion(state, t, 'containerPort'));
      if (outside) {
        ctx.log('有貨櫃碼頭建於葵涌貨櫃碼頭區外，吞吐量打七折；建議搬入港口區。', 'info');
      }
      if (teuCapacity > 0 && portDemand > teuCapacity * 1.1) {
        ctx.log('貨櫃碼頭吞吐量不足，貨物排隊；可加建碼頭閘口或貨櫃堆場。', 'info');
      }
    }
  }
}

/**
 * 升級貿易設施（main.ts action 用）：airportTerminal／containerPort 可升 level 1–3。
 * 成本：機場 [0, 6M, 12M]、碼頭 [0, 4M, 8M]（按目標等級 index）。
 */
export function upgradeTradeBuilding(
  state: GameState,
  buildingId: number,
): { ok: boolean; reason?: string; cost?: number } {
  const building = state.buildings.find((b) => b.id === buildingId);
  if (!building) return { ok: false, reason: '找不到建築' };
  const key = building.key;
  let upgradeCosts: readonly number[] | null = null;
  if (key === 'airportTerminal') upgradeCosts = TRADE_CONFIG.airport.upgradeCosts;
  else if (key === 'containerPort') upgradeCosts = TRADE_CONFIG.port.upgradeCosts;
  if (!upgradeCosts) return { ok: false, reason: '此建築不可升級' };
  const maxLevel = key === 'airportTerminal' ? TRADE_CONFIG.airport.maxLevel : TRADE_CONFIG.port.maxLevel;
  if (building.level >= maxLevel) return { ok: false, reason: `已達最高等級 ${maxLevel}` };
  const targetLevel = building.level + 1;
  const cost = upgradeCosts[targetLevel - 1] ?? 0;
  if (state.finance.treasury < cost) return { ok: false, reason: '庫房不足，無法升級' };
  state.finance.treasury -= cost;
  state.finance.expenseThisMonth += cost;
  state.finance.expenseBreakdown.infrastructure =
    (state.finance.expenseBreakdown.infrastructure ?? 0) + cost;
  building.level = targetLevel;
  return { ok: true, cost };
}
