/**
 * 《維港之城》DOM 介面入口（霓虹港風 · 桌面＋手機）。
 *
 * 對外介面固定（Lead 的 main.ts 依賴）：
 *   createUI(root, store, actions): GameUI
 *   GameUI.update(state)   —— 每幀由主迴圈呼叫
 *   GameUI.destroy()
 *
 * 各子面板以「上次值比對 / 簽章比對」做差異更新，不會每幀重建 DOM。
 * 視覺樣式全部是純 CSS／內嵌 SVG／Emoji；字型使用系統繁體中文字型，離線可玩。
 */

import './css/topbar.css';
import './css/build.css';
import './css/info.css';
import './css/modals.css';
import './css/interior.css';
import './css/toasts.css';
import './css/responsive.css';
import './css/mobile.css';
import './css/start-screen.css';
import './css/minimap.css';
import './css/round5.css';

import { BUILDINGS, ROAD_COST, ZONES, formatMoney } from '../core/config';
import { applyUiMode, getUiMode } from '../core/device';
import type { GameActions, GameState } from '../core/types';
import type { GameStore } from '../core/store';
import { delegate, isTypingTarget, qs, setClass, setHidden } from './dom';
import { ico } from './icons';
import { createTopbar } from './topbar';
import { createBuildPanel } from './build-panel';
import { createInfoPanel } from './info-panel';
import { createInteriorPanel } from './interior-panel';
import { createFinancePanel } from './finance-panel';
import { createTransitPanel } from './transit-panel';
import { createSavePanel } from './save-panel';
import { createHelpPanel } from './help-panel';
import { createToasts } from './toasts';
import { createMobileBar } from './mobile-bar';
import { createStartScreen } from './start-screen';
import { createMinimap } from './minimap';
import { createUndergroundBar } from './underground-bar';
import { createUtilityPanel } from './utility-panel';
import { createTradePanel } from './trade-panel';
import { toggleTradePanel, toggleUnderground } from './round5-helpers';

export interface GameUI {
  update(state: GameState): void;
  destroy(): void;
}

export function createUI(root: HTMLElement, store: GameStore, actions: GameActions): GameUI {
  applyUiMode();
  const mobileUi = getUiMode() === 'mobile';

  root.innerHTML = `
    <div class="hud" id="hud">
      <div class="hud-vignette" aria-hidden="true"></div>
      <div class="hud-scanline" aria-hidden="true"></div>

      <button type="button" class="panel-handle handle-build" data-act="expand" data-panel="build" title="展開建造面板">
        ${ico('chevronRight')}<span>建造</span>
      </button>
      <button type="button" class="panel-handle handle-info" data-act="expand" data-panel="info" title="展開城事面板">
        <span>城事</span>${ico('chevronLeft')}
      </button>

      <div class="mode-hint" data-k="modeHint" aria-live="polite">
        <span class="mode-hint-ico" data-k="hintIcon"></span>
        <span class="mode-hint-text" data-k="hintText"></span>
        <button type="button" class="mode-hint-cancel" data-act="cancel-tool" title="取消（Esc）">${ico('close')}</button>
      </div>
    </div>
  `;

  const hud = qs<HTMLElement>(root, '#hud')!;
  hud.classList.add(mobileUi ? 'is-mobile-ui' : 'is-desktop-ui');

  // 桌面版預設打開「城事」面板；手機版用底部 sheet。
  if (!mobileUi && !store.state.ui.showStats && store.state.ui.mode === 'city') {
    store.state.ui.showStats = true;
  }

  const topbar = createTopbar(hud, store, actions);
  const buildPanel = createBuildPanel(hud, store, actions);
  const infoPanel = createInfoPanel(hud, store, actions);
  const interiorPanel = createInteriorPanel(hud, store, actions);
  const financePanel = createFinancePanel(hud, store, actions);
  const transitPanel = createTransitPanel(hud, store, actions);
  const savePanel = createSavePanel(hud, store, actions);
  const helpPanel = createHelpPanel(hud, store, actions);
  const toasts = createToasts(hud, store);
  const mobileBar = mobileUi ? createMobileBar(hud, store, actions) : null;
  const startScreen = createStartScreen(hud, store, actions);
  const minimap = createMinimap(hud, store, actions);
  const undergroundBar = createUndergroundBar(hud, store, actions);
  const utilityPanel = createUtilityPanel(hud, store, actions);
  const tradePanel = createTradePanel(hud, store, actions);

  const modeHint = qs<HTMLElement>(hud, '[data-k="modeHint"]')!;
  const hintText = qs<HTMLElement>(hud, '[data-k="hintText"]')!;
  const hintIcon = qs<HTMLElement>(hud, '[data-k="hintIcon"]')!;
  const hintCancel = qs<HTMLElement>(hud, '.mode-hint-cancel')!;

  // ── 面板收合（寬螢幕）／抽屜（窄螢幕）／手機底部面板 ──
  const isNarrow = (): boolean => mobileUi || window.innerWidth <= 980;

  const setPanelOpen = (panel: 'build' | 'info', open: boolean): void => {
    if (isNarrow()) hud.classList.toggle(`is-${panel}-open`, open);
    else hud.classList.toggle(`is-${panel}-collapsed`, !open);
  };

  const togglePanel = (panel: 'build' | 'info'): void => {
    if (isNarrow()) {
      const isOpen = hud.classList.contains(`is-${panel}-open`);
      hud.classList.toggle(`is-${panel}-open`, !isOpen);
      hud.classList.toggle('is-sheet-open', !isOpen);
    } else {
      hud.classList.toggle(`is-${panel}-collapsed`);
    }
  };

  const closeSheets = (): void => {
    hud.classList.remove('is-build-open', 'is-info-open', 'is-sheet-open');
  };

  const offActions = delegate(root, 'click', '[data-act]', (node) => {
    const act = node.dataset.act;
    if (act === 'collapse' || act === 'expand') {
      const panel = node.dataset.panel === 'info' ? 'info' : 'build';
      if (act === 'expand') setPanelOpen(panel, true);
      else setPanelOpen(panel, false);
      return;
    }
    if (act === 'toggle-build') {
      togglePanel('build');
      return;
    }
    if (act === 'cancel-tool') actions.setTool(null);
  });

  // 讀檔／新局後（store.setState → 'reset'）：桌面版重新打開城事面板
  const offReset = store.on('reset', () => {
    if (!mobileUi && store.state.ui.mode === 'city') store.state.ui.showStats = true;
  });

  const onResize = (): void => {
    if (mobileUi) return;
    if (!isNarrow()) hud.classList.remove('is-build-open', 'is-info-open', 'is-sheet-open');
  };
  window.addEventListener('resize', onResize);

  // ── 額外快捷鍵（城市鏡頭／遊戲速度由 CityView 處理） ──
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    switch (event.code) {
      case 'KeyR':
        actions.setTool(store.state.ui.tool === 'road' ? null : 'road');
        break;
      case 'KeyZ':
        actions.setTool(store.state.ui.tool === 'zone:residential' ? null : 'zone:residential');
        break;
      case 'KeyC':
        actions.setTool(store.state.ui.tool === 'zone:commercial' ? null : 'zone:commercial');
        break;
      case 'KeyV':
        actions.setTool(store.state.ui.tool === 'zone:industrial' ? null : 'zone:industrial');
        break;
      case 'KeyN':
        actions.setTool(store.state.ui.tool === 'zone:farmland' ? null : 'zone:farmland');
        break;
      case 'KeyM':
        actions.setTool(store.state.ui.tool === 'dezone' ? null : 'dezone');
        break;
      case 'KeyX':
        actions.setTool(store.state.ui.tool === 'demolish' ? null : 'demolish');
        break;
      case 'KeyL':
        actions.toggleZones();
        break;
      case 'KeyU':
        toggleUnderground(store, actions);
        break;
      case 'KeyY':
        toggleTradePanel(store, actions);
        break;
      case 'KeyO':
        actions.fitMap();
        break;
      case 'KeyP': {
        const spawn = store.state.spawn;
        actions.focusTile(spawn.x, spawn.y);
        break;
      }
      case 'KeyB':
        togglePanel('build');
        break;
      case 'KeyG':
      case 'KeyJ':
        actions.toggleStats();
        break;
      case 'KeyT':
        actions.toggleTransit();
        break;
      case 'Escape': {
        let changed = false;
        if (store.state.ui.showTutorial) {
          store.state.ui.showTutorial = false;
          changed = true;
        }
        if (hud.classList.contains('is-sheet-open')) {
          closeSheets();
          changed = true;
        }
        if (changed) store.bumpUI();
        break;
      }
      default:
        break;
    }
  };
  window.addEventListener('keydown', onKeyDown);

  // ── 模式提示（建造中／室內） ──
  let lastHintKey = '';
  const updateHint = (state: GameState): void => {
    const ui = state.ui;
    const tool = ui.tool;
    const key = `${ui.mode}|${tool ?? ''}|${mobileUi ? 'm' : 'd'}`;
    if (key === lastHintKey) return;
    lastHintKey = key;

    if (ui.mode === 'interior') {
      const building = ui.interiorId != null ? state.buildings.find((b) => b.id === ui.interiorId) : undefined;
      const name = building ? (BUILDINGS[building.key]?.name ?? '') : '';
      hintIcon.innerHTML = ico('door');
      hintText.textContent = mobileUi
        ? `${name} · 室內 — 點「返回城市」離開`
        : `${name} · 室內 — 雙擊戶外或按 Esc 返回城市`;
      setClass(modeHint, 'show', true);
      setClass(modeHint, 'interior', true);
      setHidden(hintCancel, true);
      return;
    }

    setClass(modeHint, 'interior', false);
    if (!tool || tool.startsWith('pipe:')) {
      // pipe 工具由地下管網工具列顯示提示
      setClass(modeHint, 'show', false);
      return;
    }
    if (tool === 'road') {
      hintIcon.innerHTML = ico('road');
      hintText.textContent = mobileUi
        ? `鋪設馬路（已含行人路）：點擊地圖逐格鋪設 · 每格 ${formatMoney(ROAD_COST)}`
        : `鋪設馬路（已含行人路）：按住左鍵拖曳連續鋪設 · 每格 ${formatMoney(ROAD_COST)} · 右鍵取消`;
    } else if (tool === 'dezone') {
      hintIcon.innerHTML = ico('eraser');
      hintText.textContent = mobileUi
        ? '取消分區：點擊地圖逐格清除 · 右鍵取消'
        : '取消分區：按住左鍵拖曳清除色塊 · 右鍵取消';
    } else if (tool === 'demolish') {
      hintIcon.innerHTML = ico('hammer');
      hintText.textContent = mobileUi
        ? '拆卸模式：點擊要拆去的建築或道路'
        : '拆卸模式：點擊要拆去的建築或道路 · 建築退還 30% · 右鍵取消';
    } else if (tool.startsWith('zone:')) {
      const zone = tool.slice(5);
      const zoneDef = ZONES[zone as keyof typeof ZONES];
      hintIcon.innerHTML = ico('layers');
      hintText.textContent = `${mobileUi ? '點擊／拖曳' : '按住左鍵拖曳'}劃分${zoneDef?.name ?? '分區'} · 每格 ${formatMoney(zoneDef?.costPerTile ?? 0)}`;
    } else {
      const def = BUILDINGS[tool];
      if (!def) {
        setClass(modeHint, 'show', false);
        return;
      }
      hintIcon.innerHTML = ico('target');
      hintText.textContent = mobileUi
        ? `放置「${def.name}」：${def.size[0]}×${def.size[1]} 格 · 點擊地圖放置`
        : `放置「${def.name}」：${def.size[0]}×${def.size[1]} 格 · 造價 ${formatMoney(def.cost)} · 左鍵放置 · 右鍵取消`;
    }
    setClass(modeHint, 'show', true);
    setHidden(hintCancel, false);
  };

  const update = (state: GameState): void => {
    setClass(hud, 'is-interior', state.ui.mode === 'interior');
    setClass(hud, 'is-start-screen', Boolean(state.ui.showStartScreen));
    startScreen.update(state);
    minimap.update(state);
    undergroundBar.update(state);
    utilityPanel.update(state);
    tradePanel.update(state);
    topbar.update(state);
    buildPanel.update(state);
    infoPanel.update(state);
    interiorPanel.update(state);
    financePanel.update(state);
    transitPanel.update(state);
    savePanel.update(state);
    helpPanel.update(state);
    mobileBar?.update(state);
    updateHint(state);

    // 桌面版：城事面板開關
    if (!mobileUi) {
      setClass(hud, 'is-info-hidden', !state.ui.showStats);
      if (state.ui.showStats) hud.classList.remove('is-info-collapsed');
    }
  };

  update(store.state);

  return {
    update,
    destroy(): void {
      offActions();
      offReset();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeyDown);
      topbar.destroy();
      buildPanel.destroy();
      infoPanel.destroy();
      interiorPanel.destroy();
      financePanel.destroy();
      transitPanel.destroy();
      savePanel.destroy();
      helpPanel.destroy();
      toasts.destroy();
      mobileBar?.destroy();
      startScreen.destroy();
      minimap.destroy();
      undergroundBar.destroy();
      utilityPanel.destroy();
      tradePanel.destroy();
      root.innerHTML = '';
    },
  };
}
