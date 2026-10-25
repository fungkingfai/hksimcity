/**
 * 模擬主迴圈（香港版）：固定順序呼叫各子系統。
 *
 * 每個影格由 main.ts 呼叫 Simulation.update(state, realDt, ctx)。
 * 呼叫順序（不要任意更改；其他 Agent 依賴此順序）：
 *   1. advanceClock          時間／天氣（回傳跨日／跨月／跨年／跨季旗標）
 *   2. tickCitizens          市民移動（走路、搭車、購物、上班）
 *   3. tickLogistics         貨車與貨物（每幀）
 *   4. tickVehicles          交通車輛（巴士／小巴／的士／電車／渡輪）
 *   5. newDay  → updateConnectivity → tickProduction → tickPopulation
 *               → tickTransit（載客／車費）→ tickDailyFinance（服務收入）
 *               → updateStats → 每日事件提示
 *   6. newMonth → monthlyFinance
 *   7. updateStats           統計（供 UI 顯示）
 *
 * 效能：所有昂貴結算都只在跨日／跨月時執行；每幀只做市民／物流／車輛移動與 O(n) 統計。
 */

import { GAME_MINUTES_PER_SECOND } from '../core/config';
import type { GameState, SimContext } from '../core/types';
import { advanceClock } from './time';
import { tickCitizens } from './citizens';
import { tickPopulation } from './population';
import { tickLogistics } from './logistics';
import { tickVehicles } from './vehicles';
import { tickTransit } from './transit';
import { tickProduction } from './production';
import { tickZoning } from './zoning';
import { monthlyFinance, tickDailyFinance } from './finance';
import { updateStats } from './stats';
import { updateConnectedBuildings } from './placement';
import { computeUtilitySnapshot } from './utilities';
import { tickTrade } from './trade';
import { tickMainland } from './mainland';

export class Simulation {
  update(state: GameState, realDt: number, ctx: SimContext): void {
    const clock = state.clock;
    if (clock.paused) {
      // 暫停時仍刷新一次統計，讓 UI 反映外部動作（建造／拆除／稅率）後的最新數字
      updateStats(state);
      return;
    }
    const speed = Math.max(0, clock.speed);
    const gameMinutes = realDt * GAME_MINUTES_PER_SECOND * speed;
    if (gameMinutes <= 0) return;

    // 1) 時間／天氣
    const flags = advanceClock(state, gameMinutes, ctx);

    // 2~4) 每幀：市民、物流、交通車輛
    tickCitizens(state, gameMinutes, ctx);
    tickLogistics(state, gameMinutes, ctx);
    tickVehicles(state, gameMinutes);

    // 5) 跨日：連通性 → 生產 → 人口 → 交通 →（若同時跨月先月結）→ 服務收入 → 統計 → 提示
    if (flags.newDay) {
      updateConnectedBuildings(state);
      // Round 5：地下管網每日結算（water／sewage／power），供生產效率與 UI 使用
      computeUtilitySnapshot(state, true);
      tickZoning(state, ctx);
      tickProduction(state, ctx);
      tickPopulation(state, ctx);
      tickTransit(state, ctx);
      // 機場／貨櫃碼頭貿易結算（收入即時入帳）
      tickTrade(state, ctx);
      // 內地公路／鐵路糧食支援（Round 6／issue #6）：口岸接駁後每日輸入糧食
      tickMainland(state, ctx);
      if (flags.newMonth) monthlyFinance(state, ctx);
      tickDailyFinance(state, ctx);
      updateStats(state);
      runDailyEvents(state, ctx);
    } else if (flags.newMonth) {
      monthlyFinance(state, ctx);
    }

    // 6) 每幀統計
    updateStats(state);
  }
}

/** 建立模擬器（無狀態，方便讀檔後直接沿用） */
export function createSimulation(): Simulation {
  return new Simulation();
}

/** 每日事件提示：食品告急、公用設施、交通、人口里程碑、天氣警告 */
function runDailyEvents(state: GameState, ctx: SimContext): void {
  const { clock, stats } = state;
  if (stats.population <= 0) return;

  // 食品安全
  if (stats.foodPerDay > 0) {
    const daysLeft = stats.foodStored / stats.foodPerDay;
    if (daysLeft < 2 && clock.totalDays % 2 === 0) {
      ctx.toast('食品庫存只剩不到兩日！盡快補充食品供應。', 'bad');
    }
  }

  // 公用設施（Round 5：地下管網接駁／容量）
  const utilities = state.utilities;
  if (stats.population >= 40 && clock.totalDays % 5 === 0 && utilities) {
    if (utilities.power.shortage > 0.15) {
      ctx.log('電力供應不足（請加建發電廠／變電站並鋪設電纜接駁）。', 'warn');
    } else if (utilities.power.unconnectedBuildings > 0) {
      ctx.log('有建築未接駁電纜，請由發電廠鋪設電纜到各區。', 'info');
    } else if (utilities.water.shortage > 0.15) {
      ctx.log('食水供應緊張，水務署呼籲節約用水（請加建水務設施／水塔並接駁水管）。', 'warn');
    } else if (utilities.water.unconnectedBuildings > 0) {
      ctx.log('有建築未接駁食水管，請鋪設水管接駁水務設施。', 'info');
    } else if (utilities.sewage.overflow > 0.05) {
      ctx.log('污水處理量不足，未處理污水排出海；請加建污水處理廠。', 'warn');
    } else if (utilities.sewage.unconnectedBuildings > 0) {
      ctx.log('有建築未接駁污水管，請接駁污水處理廠或排污口。', 'info');
    }
    if (utilities.waterQuality < 0.7) {
      ctx.log('食水水質欠佳（排污口影響），市民關注健康；可改以污水處理廠處理污水。', 'warn');
    }
  }

  // 交通
  if (stats.population >= 120 && clock.totalDays % 7 === 0) {
    if (stats.transitCoverage < 0.35) {
      ctx.log('公共交通覆蓋不足，通勤時間過長，市民要求增設港鐵站／巴士線。', 'warn');
    }
  }

  // 失業
  if (
    stats.employed > 0 &&
    stats.unemployed / Math.max(1, stats.employed + stats.unemployed) > 0.25 &&
    clock.totalDays % 6 === 0
  ) {
    ctx.log('失業率偏高，市民要求更多職位；考慮興建商廈、工廈或商場。', 'warn');
  }

  // 幸福度
  if (stats.happiness < 30 && clock.totalDays % 4 === 0) {
    ctx.log('市民怨氣沖天，幸福度低迷；檢視住房、食品、交通與稅率。', 'bad');
  }
}
