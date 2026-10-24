/**
 * 機場／貨櫃碼頭貿易面板（Round 5 · Phase C）。
 *
 * `ui.showTradePanel` 控制（快捷鍵 Y／手機「貿易」）。
 * 顯示 `state.trade`：機場客流／容量、貨運噸數、碼頭 TEU／容量、每日收入、就業、噪音；
 * 逐座機場／碼頭建築列表（Lv、道路接駁、升級費用），升級 call `actions.upgradeTradeBuilding?.()`。
 * `state.trade` 未計算時 fallback 顯示建築數量與 config 估算容量。
 */

import { BUILDINGS, TRADE_CONFIG, formatMoney, formatMoneyShort } from '../core/config';
import type { GameActions, GameState } from '../core/types';
import type { GameStore } from '../core/store';
import { delegate, esc, num, pct, qs, setClass } from './dom';
import { ico } from './icons';
import { createOverlayHost, modalShell, restoreInfoPanel } from './overlay';

export interface TradePanelView {
  update(state: GameState): void;
  destroy(): void;
}

const AIRPORT_KEYS = ['airportTerminal', 'airCargoTerminal'];
const PORT_KEYS = ['containerPort', 'portGate', 'portYard'];

function terminalKeys(state: GameState, keys: string[]): string[] {
  const present = new Set(state.buildings.map((b) => b.key));
  return keys.filter((key) => present.has(key));
}

export function createTradePanel(container: HTMLElement, store: GameStore, actions: GameActions): TradePanelView {
  const closePanel = (): void => {
    store.state.ui.showTradePanel = false;
    restoreInfoPanel(store);
    store.bumpUI();
  };
  const host = createOverlayHost(container, actions, closePanel);
  let lastSig = '';

  const upgradeCost = (key: string, level: number): number | null => {
    const cfg = key === 'airportTerminal' || key === 'airCargoTerminal' ? TRADE_CONFIG.airport : TRADE_CONFIG.port;
    const next = Math.max(1, Math.round(level));
    if (next >= cfg.maxLevel) return null;
    return cfg.upgradeCosts[next] ?? null;
  };

  const terminalRow = (state: GameState, buildingId: number, key: string): string => {
    const building = state.buildings.find((b) => b.id === buildingId);
    if (!building) return '';
    const def = BUILDINGS[key];
    if (!def) return '';
    const cost = upgradeCost(key, building.level);
    const status = !building.connected
      ? '<span class="st-status bad">未連路</span>'
      : building.active
        ? '<span class="st-status ok">運作中</span>'
        : '<span class="st-status warn">停用</span>';
    return `
      <div class="trade-terminal" data-id="${building.id}">
        <span class="trade-ico">${def.utility?.kind === 'power' ? '⚡' : '🏭'}</span>
        <span class="trade-name"><b>${esc(def.name)}</b><small>Lv.${building.level} · ${building.w}×${building.h} 格</small></span>
        ${status}
        <button type="button" class="trade-focus" data-act="trade-focus" data-id="${building.id}" title="鏡頭飛到建築">${ico('target')}定位</button>
        ${
          cost == null
            ? '<span class="trade-max">滿級</span>'
            : `<button type="button" class="trade-upgrade" data-act="trade-upgrade" data-id="${building.id}" title="升級（${formatMoneyShort(cost)}）">升級 ${formatMoneyShort(cost)}</button>`
        }
      </div>`;
  };

  const render = (state: GameState): void => {
    const trade = state.trade;
    const airportBuildings = state.buildings.filter((b) => AIRPORT_KEYS.includes(b.key));
    const portBuildings = state.buildings.filter((b) => PORT_KEYS.includes(b.key));

    const airportCount = airportBuildings.length;
    const portCount = portBuildings.length;
    const estPaxCap =
      state.buildings.filter((b) => b.key === 'airportTerminal').length * TRADE_CONFIG.airport.terminalCapacity;
    const estCargoCap =
      state.buildings.filter((b) => b.key === 'airCargoTerminal').length *
        TRADE_CONFIG.airport.cargoCapacityPerTerminal +
      state.buildings.filter((b) => b.key === 'airportTerminal').length * TRADE_CONFIG.airport.cargoCapacityPerTerminal;
    const estTeuCap =
      portBuildings.reduce((sum, b) => {
        if (b.key === 'containerPort') return sum + TRADE_CONFIG.port.terminalCapacity;
        if (b.key === 'portYard') return sum + TRADE_CONFIG.port.yardCapacity;
        return sum + TRADE_CONFIG.port.gateCapacity;
      }, 0) + estPortGateBonus(state);

    const airport = trade?.airport;
    const port = trade?.port;

    const airportBlock = airport
      ? `
        <div class="trade-hero" style="--trade:#5fb4d6">
          <div class="trade-hero-main">
            <span class="fin-label">機場客運</span>
            <b class="fin-amount">${num(airport.passengers)} <small>/ ${num(airport.passengerCapacity)} 人次</small></b>
            <span class="fin-sub">貨運 ${num(airport.cargo)} / ${num(airport.cargoCapacity)} 噸 · 噪音投訴 ${pct(airport.noiseComplaints)}</span>
          </div>
          <div class="trade-stats">
            <div class="fin-card"><span>每日收入</span><b class="positive">${formatMoney(airport.revenueToday)}</b></div>
            <div class="fin-card"><span>就業</span><b>${num(airport.jobs)} 人</b></div>
            <div class="fin-card"><span>客運容量</span><b>${num(airport.passengerCapacity)}</b></div>
            <div class="fin-card"><span>貨運容量</span><b>${num(airport.cargoCapacity)} 噸</b></div>
          </div>
        </div>
        <div class="trade-meter">
          <div class="trade-row"><span>客流使用率</span><b>${airport.passengerCapacity ? pct(airport.passengers / airport.passengerCapacity) : '—'}</b></div>
          <div class="metric-bar"><i class="tone-${ratio(airport.passengers / Math.max(1, airport.passengerCapacity))}" style="width:${Math.min(100, Math.round((airport.passengers / Math.max(1, airport.passengerCapacity)) * 100))}%"></i></div>
        </div>`
      : fallbackHero('機場', 'airport', estPaxCap, estCargoCap, airportCount);

    const portBlock = port
      ? `
        <div class="trade-hero" style="--trade:#d9b23f">
          <div class="trade-hero-main">
            <span class="fin-label">貨櫃碼頭</span>
            <b class="fin-amount">${num(port.throughput)} <small>/ ${num(port.teuCapacity)} TEU</small></b>
            <span class="fin-sub">吞吐使用率 ${pct(port.throughput / Math.max(1, port.teuCapacity))}</span>
          </div>
          <div class="trade-stats">
            <div class="fin-card"><span>每日收入</span><b class="positive">${formatMoney(port.revenueToday)}</b></div>
            <div class="fin-card"><span>就業</span><b>${num(port.jobs)} 人</b></div>
            <div class="fin-card"><span>TEU 容量</span><b>${num(port.teuCapacity)}</b></div>
            <div class="fin-card"><span>泊位/堆場</span><b>${portCount} 座</b></div>
          </div>
        </div>
        <div class="trade-meter">
          <div class="trade-row"><span>吞吐使用率</span><b>${pct(port.throughput / Math.max(1, port.teuCapacity))}</b></div>
          <div class="metric-bar"><i class="tone-${ratio(port.throughput / Math.max(1, port.teuCapacity))}" style="width:${Math.min(100, Math.round((port.throughput / Math.max(1, port.teuCapacity)) * 100))}%"></i></div>
        </div>`
      : fallbackHero('碼頭', 'port', estTeuCap, 0, portCount);

    const airportRows = airportBuildings.map((b) => terminalRow(state, b.id, b.key)).join('');
    const portRows = portBuildings.map((b) => terminalRow(state, b.id, b.key)).join('');

    const body = `
      ${!trade ? `<div class="util-fallback">${ico('info')}<div><b>貿易數據計算中／尚未接駁</b><p>模擬系統未提供機場／碼頭營運快照。你仍可興建機場客運大樓、空運貨運站、貨櫃碼頭、碼頭閘口及貨櫃堆場；模擬接駁後會顯示客流、吞吐、收入與就業。</p></div></div>` : ''}

      <div class="trade-grid">
        <section class="fin-block trade-block">
          <div class="block-head"><h3>${ico('plane')}機場</h3><span class="mini">${airportCount} 座設施</span></div>
          ${airportBlock}
          <div class="trade-list">${airportRows || '<div class="station-empty">尚未興建機場設施；到建造 → 交通／物流放置機場客運大樓、空運貨運站（必須在機場區）。</div>'}</div>
        </section>

        <section class="fin-block trade-block">
          <div class="block-head"><h3>${ico('ship')}貨櫃碼頭</h3><span class="mini">${portCount} 座設施</span></div>
          ${portBlock}
          <div class="trade-list">${portRows || '<div class="station-empty">尚未興建碼頭設施；到建造 → 物流放置貨櫃碼頭、碼頭閘口、貨櫃堆場（必須臨水及連接道路）。</div>'}</div>
        </section>
      </div>

      <div class="fin-block">
        <div class="block-head"><h3>${ico('chart')}營運提示</h3><span class="mini">貿易每日結算</span></div>
        <ul class="help-list compact">
          <li>機場提供旅客、旅遊收入與航空業職位；客運大樓容量 9,000 人次，貨運站提升貨運容量。附近住宅會有噪音影響。</li>
          <li>貨櫃碼頭需要臨水＋道路；碼頭閘口提升卡車進出效率、貨櫃堆場提升 TEU 容量，兩者都會影響吞吐瓶頸。</li>
          <li>8 號風球或暴雨期間機場航班與碼頭裝卸會受影響，收入下降。</li>
          <li>每座設施可升級（Lv.1–3），升級費用按 <b>${ico('coin')}金錢</b> 由庫房支付。</li>
        </ul>
      </div>
      <p class="modal-foot-note">${ico('info')}數據由貿易系統每日結算；升級建築後需要道路接駁才會運作。快捷鍵 <b>Y</b> 開關本面板。</p>
    `;

    host.show(
      modalShell({
        key: 'trade',
        badge: '貿',
        title: '機場 · 貨櫃碼頭貿易',
        subtitle: '客運 · 貨運 · 吞吐 · 就業',
        body,
      }),
    );
    lastSig = signature(state);
  };

  const estPortGateBonus = (state: GameState): number =>
    state.buildings.filter((b) => b.key === 'portGate').length * TRADE_CONFIG.port.gateCapacity * 0.5;

  const ratio = (value: number): 'good' | 'ok' | 'bad' => {
    if (value > 0.9) return 'bad';
    if (value > 0.7) return 'ok';
    return 'good';
  };

  const fallbackHero = (name: string, kind: 'airport' | 'port', capA: number, capB: number, count: number): string => `
    <div class="trade-hero" style="--trade:${kind === 'airport' ? '#5fb4d6' : '#d9b23f'}">
      <div class="trade-hero-main">
        <span class="fin-label">${name}${kind === 'airport' ? '客運' : '吞吐'}（估算）</span>
        <b class="fin-amount">— <small>/ ${num(capA)} ${kind === 'airport' ? '人次' : 'TEU'}</small></b>
        <span class="fin-sub">${kind === 'airport' ? `貨運容量約 ${num(capB)} 噸 · ` : ''}${count} 座設施 · 等待每日模擬數據</span>
      </div>
      <div class="trade-stats">
        <div class="fin-card"><span>每日收入</span><b>—</b></div>
        <div class="fin-card"><span>就業</span><b>—</b></div>
        <div class="fin-card"><span>容量</span><b>${num(capA)}</b></div>
        <div class="fin-card"><span>設施</span><b>${count} 座</b></div>
      </div>
    </div>`;

  const signature = (state: GameState): string => {
    const t = state.trade;
    const levels = state.buildings
      .filter((b) => AIRPORT_KEYS.includes(b.key) || PORT_KEYS.includes(b.key))
      .map((b) => `${b.id}:${b.level}:${b.connected ? 1 : 0}:${b.active ? 1 : 0}`)
      .join(',');
    return [
      t?.lastUpdatedDay ?? -1,
      Math.round(t?.airport.passengers ?? 0),
      Math.round(t?.airport.revenueToday ?? 0),
      Math.round(t?.port.throughput ?? 0),
      Math.round(t?.port.revenueToday ?? 0),
      Math.round(state.finance.treasury),
      state.buildings.length,
      levels,
    ].join('|');
  };

  const offClick = delegate(host.layer, 'click', '[data-act]', (node) => {
    switch (node.dataset.act) {
      case 'trade-upgrade': {
        const id = Number(node.dataset.id);
        if (!Number.isFinite(id)) return;
        if (typeof actions.upgradeTradeBuilding === 'function') {
          const result = actions.upgradeTradeBuilding(id);
          store.toast(result.ok ? '設施已升級' : result.reason ?? '升級失敗', result.ok ? 'info' : 'warn');
        } else {
          // fallback：main 未接 action 時直接改 state（示範用，唔扣錢）
          const building = store.state.buildings.find((b) => b.id === id);
          if (building) {
            building.level = Math.min(3, building.level + 1);
            store.toast('（示範）設施已升級；main 接駁 upgradeTradeBuilding 後會正式收費', 'info');
            store.bumpUI();
          }
        }
        break;
      }
      case 'trade-focus': {
        const id = Number(node.dataset.id);
        const building = store.state.buildings.find((b) => b.id === id);
        if (building) {
          actions.focusTile(building.x + building.w / 2, building.y + building.h / 2);
        }
        break;
      }
      default:
        break;
    }
  });

  const update = (state: GameState): void => {
    if (!state.ui.showTradePanel) {
      host.hide();
      lastSig = '';
      return;
    }
    const sig = signature(state);
    if (sig !== lastSig) render(state);
  };

  return {
    update,
    destroy(): void {
      offClick();
      host.destroy();
    },
  };
}
