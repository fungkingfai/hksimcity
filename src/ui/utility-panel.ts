/**
 * 公用設施面板（Round 5 · Phase A）。
 *
 * `ui.showUtilityPanel` 控制；三個分頁：食水／污水／電力。
 * 數據來自 `state.utilities`（UtilitySnapshot，可能 undefined → 顯示「管網計算中／尚未接駁」）。
 * 每頁顯示：容量／需求／已供應、覆蓋率、短缺或溢出、供應源數、已接駁／未接駁、管道長度、
 * 每月管線維護費；可以直接切換 pipe 工具鋪管，或開關地下圖層。
 */

import { BUILDINGS, PIPE_INFO } from '../core/config';
import type { GameActions, GameState, UtilityNetworkStat, UtilitySnapshot } from '../core/types';
import type { GameStore } from '../core/store';
import { delegate, esc, num, qs, setClass, setText } from './dom';
import { ico, type IconName } from './icons';
import { createOverlayHost, modalShell, restoreInfoPanel } from './overlay';
import { activatePipeTool, toggleUnderground, type PipeToolKind } from './round5-helpers';

export interface UtilityPanelView {
  update(state: GameState): void;
  destroy(): void;
}

type Tab = 'water' | 'sewage' | 'power';

interface TabDef {
  key: Tab;
  label: string;
  short: string;
  icon: IconName;
  pipe: Exclude<PipeToolKind, 'remove'>;
  color: string;
}

const TABS: TabDef[] = [
  { key: 'water', label: '食水', short: '水', icon: 'water', pipe: 'water', color: '#5fb4d6' },
  { key: 'sewage', label: '污水', short: '污', icon: 'valve', pipe: 'sewer', color: '#8a9f66' },
  { key: 'power', label: '電力', short: '電', icon: 'power', pipe: 'power', color: '#e6c35a' },
];

function pct(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function bar(value: number, tone: 'good' | 'ok' | 'bad'): string {
  const width = Math.max(2, Math.round(Math.max(0, Math.min(1, value)) * 100));
  return `<div class="metric-bar"><i class="tone-${tone}" style="width:${width}%"></i></div>`;
}

function toneOf(value: number, reverse = false): 'good' | 'ok' | 'bad' {
  const v = reverse ? 1 - value : value;
  if (v < 0.4) return 'bad';
  if (v < 0.75) return 'ok';
  return 'good';
}

function utilityIcon(key: string): string {
  const kind = BUILDINGS[key]?.utility?.kind;
  if (kind === 'sewage') return '♻';
  if (kind === 'water') return '💧';
  if (kind === 'power') return '⚡';
  return '🏭';
}

interface TabData {
  stat: UtilityNetworkStat;
  pipeCount: number;
  sewage?: { treated: number; overflow: number };
  quality?: number;
}

function tabData(snap: UtilitySnapshot, tab: Tab): TabData {
  if (tab === 'water') {
    return { stat: snap.water, pipeCount: snap.pipeCounts.water, quality: snap.waterQuality };
  }
  if (tab === 'power') return { stat: snap.power, pipeCount: snap.pipeCounts.power };
  return {
    stat: snap.sewage,
    pipeCount: snap.pipeCounts.sewer,
    sewage: { treated: snap.sewage.treated, overflow: snap.sewage.overflow },
  };
}

export function createUtilityPanel(container: HTMLElement, store: GameStore, actions: GameActions): UtilityPanelView {
  const closePanel = (): void => {
    store.state.ui.showUtilityPanel = false;
    restoreInfoPanel(store);
    store.bumpUI();
  };
  const host = createOverlayHost(container, actions, closePanel);

  let activeTab: Tab = 'water';
  let lastSig = '';

  const sourceBuildings = (
    state: GameState,
    tab: Tab,
  ): { key: string; name: string; count: number; active: number }[] => {
    const kind = tab === 'sewage' ? 'sewage' : tab;
    const map = new Map<string, { key: string; name: string; count: number; active: number }>();
    for (const building of state.buildings) {
      const def = BUILDINGS[building.key];
      if (!def?.utility || def.utility.kind !== kind || !def.utility.source) continue;
      const entry = map.get(building.key) ?? { key: building.key, name: def.name, count: 0, active: 0 };
      entry.count++;
      if (building.active && building.connected) entry.active++;
      map.set(building.key, entry);
    }
    return [...map.values()];
  };

  const render = (state: GameState): void => {
    const snap = state.utilities;
    const tabDef = TABS.find((t) => t.key === activeTab) ?? TABS[0];
    const sources = sourceBuildings(state, activeTab);

    const tabButtons = TABS.map((tab) => {
      const stat = snap ? (tab.key === 'water' ? snap.water : tab.key === 'power' ? snap.power : snap.sewage) : null;
      const cover = stat ? pct(stat.coverage) : '—';
      const warn = stat ? stat.shortage > 0.05 : false;
      return `<button type="button" class="util-tab${tab.key === activeTab ? ' active' : ''}${warn ? ' warn' : ''}"
        data-act="util-tab" data-tab="${tab.key}" style="--util:${tab.color}">
        <span class="util-tab-ico">${ico(tab.icon)}</span>
        <span class="util-tab-text"><b>${tab.label}</b><small>覆蓋 ${cover}</small></span>
      </button>`;
    }).join('');

    const sourceList = sources.length
      ? sources
          .map(
            (entry) =>
              `<div class="util-source"><span>${utilityIcon(entry.key)}</span><b>${esc(entry.name)}</b><small>${entry.count} 座 · ${entry.active} 運作中</small></div>`,
          )
          .join('')
      : `<p class="muted center">未有任何${tabDef.label}供應源建築（先興建發電廠／水務設施／水塔／污水處理廠等）</p>`;

    let detail = '';
    if (!snap) {
      detail = `
        <div class="util-fallback">
          ${ico('info')}
          <div>
            <b>管網計算中／尚未接駁</b>
            <p>模擬系統未提供管網快照（可能係新局／存檔舊版／模擬未接好）。你可以先鋪設管道與興建供應源；每日結算後會顯示容量、覆蓋率與短缺。</p>
          </div>
        </div>
        <div class="util-grid">
          <div class="fin-block"><div class="block-head"><h3>供應源</h3><span class="mini">${sources.length} 種</span></div>${sourceList}</div>
          <div class="fin-block"><div class="block-head"><h3>管道</h3><span class="mini">尚未計算</span></div>
            <p class="hint">每格成本：食水管 $${num(PIPE_INFO.water.cost)}、污水管 $${num(PIPE_INFO.sewer.cost)}、電纜 $${num(PIPE_INFO.power.cost)}；拆除退 25%。</p>
          </div>
        </div>`;
    } else {
      const data = tabData(snap, activeTab);
      const stat = data.stat;
      const demandRatio = stat.demand > 0 ? stat.supplied / stat.demand : 1;
      const coverageTone = toneOf(stat.coverage);
      const shortage = activeTab === 'sewage' ? (data.sewage?.overflow ?? 0) : stat.shortage;
      const shortageTone = toneOf(shortage, true);
      const warnings: string[] = [];
      if (stat.sources === 0) warnings.push(`未有任何${tabDef.label}供應源：請先興建對應廠房／水塔。`);
      if (stat.shortage > 0.05) warnings.push(`${tabDef.label}容量不足（短缺 ${pct(stat.shortage)}）：加建供應源。`);
      if (stat.unconnectedBuildings > 0) {
        warnings.push(`${num(stat.unconnectedBuildings)} 棟建築未接駁${tabDef.label}管網：用管道連到建築。`);
      }
      if (activeTab === 'sewage' && (data.sewage?.overflow ?? 0) > 0.02) {
        warnings.push(`污水溢出 ${pct(data.sewage?.overflow ?? 0)}：污水處理容量不足，或排污口污染食水。`);
      }
      if (activeTab === 'water' && (data.quality ?? 1) < 0.6) {
        warnings.push(`食水水質欠佳（${pct(data.quality ?? 0)}）：減少排污口、加建污水處理廠。`);
      }

      const extra =
        activeTab === 'sewage'
          ? `<div class="util-extra">
              <div class="util-row"><span>已處理污水</span><b>${num(data.sewage?.treated ?? 0)}</b></div>
              <div class="util-row"><span>溢出比例</span><b class="${shortage > 0.02 ? 'negative' : 'positive'}">${pct(data.sewage?.overflow ?? 0)}</b></div>
              ${bar(1 - (data.sewage?.overflow ?? 0), shortageTone)}
            </div>`
          : activeTab === 'water'
            ? `<div class="util-extra">
                <div class="util-row"><span>食水水質</span><b class="${(data.quality ?? 1) < 0.6 ? 'negative' : 'positive'}">${pct(data.quality ?? 1)}</b></div>
                ${bar(data.quality ?? 1, toneOf(data.quality ?? 1))}
              </div>`
            : '';

      detail = `
        <div class="util-hero" style="--util:${tabDef.color}">
          <div class="util-hero-main">
            <span class="fin-label">${tabDef.label}供應</span>
            <b class="util-big">${num(stat.supplied)}<em> / ${num(stat.demand)}</em></b>
            <span class="fin-sub">容量 ${num(stat.capacity)} · 已供應 ${pct(demandRatio)} · 覆蓋 ${pct(stat.coverage)}</span>
          </div>
          <div class="util-hero-stats">
            <div class="fin-card"><span>覆蓋率</span><b class="tone-${coverageTone}">${pct(stat.coverage)}</b></div>
            <div class="fin-card"><span>${activeTab === 'sewage' ? '溢出比例' : '短缺'}</span><b class="${shortage > 0.05 ? 'negative' : 'positive'}">${pct(shortage)}</b></div>
            <div class="fin-card"><span>供應源</span><b>${num(stat.sources)} 座</b></div>
            <div class="fin-card"><span>已接駁</span><b>${num(stat.connectedBuildings)} 棟</b></div>
          </div>
        </div>

        <div class="util-meter">
          <div class="util-row"><span>管網覆蓋率</span><b>${pct(stat.coverage)}</b></div>
          ${bar(stat.coverage, coverageTone)}
          <div class="util-row"><span>${activeTab === 'sewage' ? '污水處理溢出' : '容量短缺'}</span><b class="${shortage > 0.05 ? 'negative' : ''}">${pct(shortage)}</b></div>
          ${bar(shortage, shortageTone)}
          ${extra}
        </div>

        <div class="util-grid">
          <div class="fin-block">
            <div class="block-head"><h3>${ico('pipe')}管網</h3><span class="mini">${PIPE_INFO[tabDef.pipe].name}</span></div>
            <div class="util-kv">
              <div><span>管道長度</span><b>${num(data.pipeCount)} 格</b></div>
              <div><span>未接駁建築</span><b class="${stat.unconnectedBuildings > 0 ? 'negative' : ''}">${num(stat.unconnectedBuildings)} 棟</b></div>
              <div><span>每月管線維護</span><b>$${num(snap.pipeUpkeep)}</b></div>
              <div><span>每格造價</span><b>$${num(PIPE_INFO[tabDef.pipe].cost)}</b></div>
            </div>
          </div>
          <div class="fin-block">
            <div class="block-head"><h3>${ico('city')}供應源</h3><span class="mini">${sources.length} 種 / ${num(stat.sources)} 座</span></div>
            <div class="util-sources">${sourceList}</div>
          </div>
        </div>

        ${warnings.length ? `<div class="util-warnings">${warnings.map((w) => `<div class="util-warning">${ico('warn')}<span>${esc(w)}</span></div>`).join('')}</div>` : ''}
      `;
    }

    const body = `
      <div class="util-tabs">${tabButtons}</div>
      ${detail}
      <div class="util-actions">
        <button type="button" class="fin-action" data-act="util-pipe" data-kind="${tabDef.pipe}">
          ${ico('pipe')}鋪設${PIPE_INFO[tabDef.pipe].name}（$${num(PIPE_INFO[tabDef.pipe].cost)}/格）
        </button>
        <button type="button" class="fin-action ghost" data-act="util-underground">
          ${ico('layers')}${state.ui.showUnderground ? '返回地面（U）' : '顯示地下管網（U）'}
        </button>
      </div>
      <p class="modal-foot-note">${ico('info')}建築需要以同類管道接駁到供應源（水／污水／電各自獨立）；管道可穿過道路下方。每日模擬後更新容量與覆蓋率。</p>
    `;

    host.show(
      modalShell({
        key: 'utility',
        badge: tabDef.short,
        title: '公用設施',
        subtitle: '食水 · 污水 · 電力管網',
        body,
      }),
    );
    lastSig = signature(state);
  };

  const signature = (state: GameState): string => {
    const snap = state.utilities;
    if (!snap) return `none|${state.buildings.length}|${activeTab}|${state.ui.showUnderground ? 1 : 0}`;
    return [
      snap.revision,
      Math.round(snap.water.coverage * 100),
      Math.round(snap.water.shortage * 100),
      Math.round(snap.sewage.coverage * 100),
      Math.round((snap.sewage.overflow ?? 0) * 100),
      Math.round(snap.power.coverage * 100),
      snap.pipeCounts.water,
      snap.pipeCounts.sewer,
      snap.pipeCounts.power,
      Math.round(snap.pipeUpkeep),
      Math.round((snap.waterQuality ?? 1) * 100),
      state.buildings.length,
      activeTab,
      state.ui.showUnderground ? 1 : 0,
    ].join('|');
  };

  const offClick = delegate(host.layer, 'click', '[data-act]', (node) => {
    switch (node.dataset.act) {
      case 'util-tab': {
        const tab = node.dataset.tab as Tab | undefined;
        if (tab && tab !== activeTab) {
          activeTab = tab;
          lastSig = '';
        }
        break;
      }
      case 'util-pipe': {
        const kind = node.dataset.kind as Exclude<PipeToolKind, 'remove'> | undefined;
        if (kind) {
          // 收起面板並切換 pipe 工具（activatePipeTool 會處理 underground layer）
          if (typeof actions.toggleUtilityPanel === 'function') actions.toggleUtilityPanel();
          else {
            store.state.ui.showUtilityPanel = false;
            store.bumpUI();
          }
          activatePipeTool(store, actions, kind);
        }
        break;
      }
      case 'util-underground':
        toggleUnderground(store, actions);
        break;
      default:
        break;
    }
  });

  // 面板開啟時，如 activeTab 被外部改（例如從建築卡點水）暫無；本地 tab 足夠。
  const update = (state: GameState): void => {
    if (!state.ui.showUtilityPanel) {
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
