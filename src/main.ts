/**
 * 《維港之城》進入點：組裝 State、Actions、渲染器、UI 與模擬主迴圈。
 */

import './styles.css';
import {
  BUILDINGS,
  FESTIVAL_COOLDOWN_DAYS,
  FESTIVAL_COST,
  LAND_SALE_AMOUNT,
  LAND_SALE_COOLDOWN_DAYS,
  STARTER_TOWN,
  ZONES,
  formatMoneyShort,
  zoneOfTool,
} from './core/config';
import { applyUiMode, isMobileUi } from './core/device';
import { createGameState, deriveClockFields } from './core/new-game';
import { GameStore } from './core/store';
import * as saves from './core/save';
import type { GameActions, GameState, LogKind, NewGameMode, SimContext, TransitLine, TransitLineInput, TransitLineMode } from './core/types';
import { CityView } from './render/city-view';
import { buildingAnchor } from './render/coords';
import { createUI } from './ui/ui';
import { createSimulation } from './sim/simulation';
import {
  demolishAt,
  demolishBuildingById,
  eraseZone,
  paintZone,
  placeAutoBuilding,
  placeBuilding,
  placeRoad,
} from './sim/placement';
import { updateStats } from './sim/stats';
import { computeUtilitySnapshot, layStarterPipes, placePipe, removePipe } from './sim/utilities';
import { regionKindAt } from './sim/placement';
import { upgradeTradeBuilding } from './sim/trade';
import {
  createTransitLine,
  deleteTransitLine,
  updateTransitLine,
} from './sim/transit';
import { computeZoneDemand, zoneStats } from './sim/zoning';

/** starter 模式：讀檔／新局後跑幾日模擬，令城市「已運作」（市民遷入、就業、生產） */
function warmUpStarterTown(state: GameState): void {
  if (state.gameMode !== 'starter') return;
  const simulation = createSimulation();
  const ctx: SimContext = {
    toast: () => {},
    log: () => {},
  };
  const prevSpeed = state.clock.speed;
  state.clock.paused = false;
  state.clock.speed = 3;
  for (let i = 0; i < STARTER_TOWN.warmupDays; i++) {
    simulation.update(state, 10, ctx);
  }
  state.clock.speed = prevSpeed > 0 ? Math.min(3, prevSpeed) : 1;
  state.clock.paused = false;
  updateStats(state);
}

/** 讀檔後把暫時性 UI 狀態歸零 */
function sanitizeLoadedState(state: GameState): GameState {
  state.ui.mode = 'city';
  state.ui.interiorId = null;
  state.ui.tool = null;
  state.ui.showFinance = false;
  state.ui.showHelp = false;
  state.ui.showSave = false;
  state.ui.showTransit = false;
  state.ui.showStats = false;
  state.ui.showUtilityPanel = false;
  state.ui.showTradePanel = false;
  state.ui.showUnderground = false;
  state.ui.lineEditorActive = false;
  state.ui.lineDraft = null;
  state.ui.showZones ??= true;
  state.ui.showStartScreen = false;
  state.clock.paused = state.ui.paused;
  return state;
}

function createActions(store: GameStore): GameActions {
  const s = (): GameState => store.state;
  const refresh = (): void => {
    updateStats(store.state);
    store.bumpUI();
  };
  // 拖曳劃區／鋪路時，重複的失敗提示要節流，避免洗版
  let lastWarnText = '';
  let lastWarnAt = 0;
  const warn = (text: string): void => {
    const now = performance.now();
    if (text === lastWarnText && now - lastWarnAt < 1500) return;
    lastWarnText = text;
    lastWarnAt = now;
    store.toast(text, 'warn');
  };

  const actions: GameActions = {
    setTool(tool: string | null): void {
      const state = s();
      state.ui.tool = tool;
      if (tool) state.ui.selectedId = null;
      store.bumpUI();
    },

    applyToolAt(tileIndex: number): void {
      const state = s();
      if (tileIndex < 0 || tileIndex >= state.tiles.length) return;
      const tool = state.ui.tool;
      if (!tool) return;
      const tx = tileIndex % state.width;
      const ty = Math.floor(tileIndex / state.width);

      if (tool === 'line-select') {
        const draft = state.ui.lineDraft;
        const buildingId = state.tiles[tileIndex].buildingId;
        if (!draft) return;
        if (buildingId < 0) {
          warn('請點擊巴士／小巴站建築作為路線站點');
          return;
        }
        const def = BUILDINGS[state.buildings.find((b) => b.id === buildingId)?.key ?? ''];
        const stopMode = def?.stopMode;
        if (stopMode !== draft.mode) {
          warn(draft.mode === 'bus' ? '巴士線請選擇巴士站或巴士總站' : '小巴線請選擇小巴站或小巴車廠');
          return;
        }
        const pos = draft.stopIds.indexOf(buildingId);
        if (pos >= 0) draft.stopIds.splice(pos, 1);
        else draft.stopIds.push(buildingId);
        store.bumpUI();
        return;
      }

      if (tool.startsWith('pipe:')) {
        const kind = tool.slice(5);
        if (kind === 'remove') {
          let any = false;
          let refund = 0;
          for (const k of ['water', 'sewer', 'power'] as const) {
            const r = removePipe(state, tx, ty, k);
            if (r.ok) {
              any = true;
              refund += r.cost;
            }
          }
          if (any) {
            store.toast(`已拆除管道，退還 ${formatMoneyShort(refund)}`, 'info');
            refresh();
          }
          return;
        }
        if (kind === 'water' || kind === 'sewer' || kind === 'power') {
          const result = placePipe(state, tx, ty, kind);
          if (result.ok) refresh();
          else if (result.reason) warn(result.reason);
          return;
        }
        return;
      }

      if (tool === 'road') {
        const result = placeRoad(state, tx, ty);
        if (result.ok) refresh();
        else if (result.reason) warn(result.reason);
        return;
      }
      const zone = zoneOfTool(tool);
      if (zone) {
        if (state.tiles[tileIndex].zone === zone) return;
        const result = paintZone(state, tx, ty, zone);
        if (result.ok) refresh();
        else if (result.reason) warn(result.reason);
        return;
      }
      if (tool === 'dezone') {
        if (!state.tiles[tileIndex].zone) return;
        const result = eraseZone(state, tx, ty);
        if (result.ok) {
          if (result.refund && result.refund > 0) {
            store.toast(`已取消分區，退還 ${formatMoneyShort(result.refund)}`, 'info');
          }
          refresh();
        } else if (result.reason) {
          warn(result.reason);
        }
        return;
      }
      if (tool === 'demolish') {
        const result = demolishAt(state, tx, ty);
        if (result.ok) {
          if (result.refund > 0) store.toast(`已清拆，退還 ${formatMoneyShort(result.refund)}`, 'info');
          if (state.ui.mode === 'interior') actions.exitInterior();
          refresh();
        } else if (result.reason) {
          warn(result.reason);
        }
        return;
      }

      const def = BUILDINGS[tool];
      if (!def) return;
      const anchor = buildingAnchor(state, tool, def.size[0], def.size[1], tx, ty);
      const result = placeBuilding(state, tool, anchor.x, anchor.y);
      if (result.ok) {
        const placed = state.buildings[state.buildings.length - 1];
        state.ui.selectedId = placed?.id ?? null;
        store.toast(`已興建「${def.name}」，花費 ${formatMoneyShort(def.cost)}`, 'good');
        refresh();
      } else if (result.reason) {
        warn(result.reason);
      }
    },

    select(tileIndex: number): void {
      const state = s();
      if (tileIndex < 0 || tileIndex >= state.tiles.length) return;
      const id = state.tiles[tileIndex].buildingId;
      state.ui.selectedId = id >= 0 ? id : null;
      store.emit('select', id >= 0 ? id : null);
      store.bumpUI();
    },

    selectBuilding(id: number | null): void {
      s().ui.selectedId = id;
      store.emit('select', id);
      store.bumpUI();
    },

    enterBuilding(id: number): void {
      const state = s();
      const building = state.buildings.find((b) => b.id === id);
      if (!building) return;
      state.ui.mode = 'interior';
      state.ui.interiorId = id;
      state.ui.selectedId = id;
      state.ui.showFinance = false;
      state.ui.showTransit = false;
      state.ui.showStats = false;
      state.ui.showHelp = false;
      state.ui.showSave = false;
      store.emit('enter', id);
      store.bumpUI();
    },

    exitInterior(): void {
      const state = s();
      if (state.ui.mode === 'city') return;
      state.ui.mode = 'city';
      state.ui.interiorId = null;
      store.emit('exit');
      store.bumpUI();
    },

    setSpeed(speed: number): void {
      const state = s();
      const clamped = Math.max(0, Math.min(3, Math.round(speed)));
      state.ui.speed = clamped;
      state.clock.speed = clamped;
      state.ui.paused = clamped === 0;
      state.clock.paused = clamped === 0;
      store.bumpUI();
    },

    togglePause(): void {
      const state = s();
      if (state.clock.paused) {
        const speed = state.clock.speed > 0 ? state.clock.speed : state.ui.speed > 0 ? state.ui.speed : 1;
        state.ui.speed = speed;
        state.clock.speed = speed;
        state.clock.paused = false;
        state.ui.paused = false;
      } else {
        state.clock.paused = true;
        state.ui.paused = true;
      }
      store.bumpUI();
    },

    setTaxRate(kind: 'salary' | 'profit' | 'rates', rate: number): void {
      const finance = s().finance;
      if (kind === 'salary') finance.salaryTaxRate = Math.max(0, Math.min(0.2, rate));
      else if (kind === 'profit') finance.profitTaxRate = Math.max(0, Math.min(0.25, rate));
      else finance.ratesRate = Math.max(0, Math.min(0.12, rate));
      store.bumpUI();
    },

    holdFestival(): void {
      const state = s();
      const finance = state.finance;
      if (state.clock.totalDays - finance.lastFestivalDay < FESTIVAL_COOLDOWN_DAYS) {
        store.toast(`煙花匯演需間隔 ${FESTIVAL_COOLDOWN_DAYS} 日，再等等吧。`, 'warn');
        return;
      }
      if (finance.treasury < FESTIVAL_COST) {
        store.toast('庫房不足，無法舉辦煙花匯演。', 'bad');
        return;
      }
      finance.treasury -= FESTIVAL_COST;
      finance.expenseThisMonth += FESTIVAL_COST;
      finance.expenseBreakdown.festival = (finance.expenseBreakdown.festival ?? 0) + FESTIVAL_COST;
      finance.lastFestivalDay = state.clock.totalDays;
      for (const citizen of state.citizens) citizen.happiness = Math.min(100, citizen.happiness + 12);
      store.log('維港煙花匯演盛大舉行，市民歡呼，民心大振。', 'good');
      store.toast('維港煙花匯演！市民歡呼，幸福度上升。', 'good');
      refresh();
    },

    sellLand(): void {
      const state = s();
      const finance = state.finance;
      if (state.clock.weather === 'storm') {
        store.toast('八號風球生效，暫停賣地，待風球除下再拍賣。', 'warn');
        return;
      }
      if (state.clock.totalDays - finance.lastLandSaleDay < LAND_SALE_COOLDOWN_DAYS) {
        store.toast(`賣地需間隔 ${LAND_SALE_COOLDOWN_DAYS} 日，再等等吧。`, 'warn');
        return;
      }
      finance.treasury += LAND_SALE_AMOUNT;
      finance.incomeThisMonth += LAND_SALE_AMOUNT;
      finance.totalIncome += LAND_SALE_AMOUNT;
      finance.incomeBreakdown.landSale = (finance.incomeBreakdown.landSale ?? 0) + LAND_SALE_AMOUNT;
      finance.lastLandSaleDay = state.clock.totalDays;
      finance.landSales += 1;
      store.log(`政府拍賣一幅土地，庫房進帳 ${formatMoneyShort(LAND_SALE_AMOUNT)}。`, 'good');
      store.toast(`成功賣地，庫房進帳 ${formatMoneyShort(LAND_SALE_AMOUNT)}。`, 'good');
      refresh();
    },

    demolishBuilding(id: number): void {
      const state = s();
      const building = state.buildings.find((b) => b.id === id);
      if (!building) return;
      const def = BUILDINGS[building.key];
      const refund = demolishBuildingById(state, id);
      if (state.ui.selectedId === id) state.ui.selectedId = null;
      if (state.ui.interiorId === id) actions.exitInterior();
      store.toast(`已清拆「${def?.name ?? '建築'}」，退還 ${formatMoneyShort(refund)}`, 'info');
      refresh();
    },

    saveGame(slot: number): boolean {
      const ok = saves.saveToSlot(store.state, slot);
      store.toast(ok ? `已保存至存檔 ${slot}` : '存檔失敗', ok ? 'good' : 'bad');
      store.bumpUI();
      return ok;
    },

    loadGame(slot: number): boolean {
      const loaded = saves.loadFromSlot(slot);
      if (!loaded) {
        store.toast('此存檔格是空的或損毀。', 'warn');
        return false;
      }
      store.setState(sanitizeLoadedState(loaded));
      store.toast('存檔已載入。', 'good');
      return true;
    },

    deleteSave(slot: number): void {
      saves.deleteSlot(slot);
      store.toast(`已刪除存檔 ${slot}`, 'info');
      store.bumpUI();
    },

    getSaves: () => saves.listSaves(),

    exportSave(): void {
      saves.exportSave(store.state);
      store.toast('已匯出存檔檔案。', 'good');
    },

    async importSave(file: File): Promise<boolean> {
      const loaded = await saves.importSaveFile(file);
      if (!loaded) {
        store.toast('匯入失敗：檔案格式不正確。', 'bad');
        return false;
      }
      store.setState(sanitizeLoadedState(loaded));
      store.toast('存檔已成功匯入。', 'good');
      return true;
    },

    newGame(seed?: number, mode: NewGameMode = 'empty'): void {
      const state = createGameState(seed, mode);
      if (mode === 'starter') warmUpStarterTown(state);
      state.ui.showStartScreen = false;
      state.clock.paused = false;
      state.ui.paused = false;
      state.clock.speed = 1;
      state.ui.speed = 1;
      store.setState(state);
      store.toast(
        mode === 'starter' ? '已載入已有城鎮，繼續發展吧！' : '新的維港城市在此奠基，先鋪路再劃分區吧！',
        'good',
      );
    },

    startGame(mode: NewGameMode, seed?: number): void {
      actions.newGame(seed, mode);
    },

    toggleZones(): void {
      const state = s();
      state.ui.showZones = !state.ui.showZones;
      store.bumpUI();
    },

    focusTile(x: number, y: number): void {
      store.emit('focus', { x, y, mode: 'tile' });
    },

    fitMap(): void {
      store.emit('focus', { x: 0, y: 0, mode: 'map' });
    },

    toggleFinance(): void {
      const state = s();
      state.ui.showFinance = !state.ui.showFinance;
      state.ui.showHelp = false;
      state.ui.showSave = false;
      state.ui.showTransit = false;
      state.ui.showStats = false;
      store.bumpUI();
    },

    toggleTransit(): void {
      const state = s();
      state.ui.showTransit = !state.ui.showTransit;
      state.ui.showFinance = false;
      state.ui.showHelp = false;
      state.ui.showSave = false;
      state.ui.showStats = false;
      store.bumpUI();
    },

    toggleStats(): void {
      const state = s();
      state.ui.showStats = !state.ui.showStats;
      state.ui.showFinance = false;
      state.ui.showHelp = false;
      state.ui.showSave = false;
      state.ui.showTransit = false;
      store.bumpUI();
    },

    toggleHelp(): void {
      const state = s();
      state.ui.showHelp = !state.ui.showHelp;
      state.ui.showFinance = false;
      state.ui.showSave = false;
      state.ui.showTransit = false;
      state.ui.showStats = false;
      store.bumpUI();
    },

    toggleSavePanel(): void {
      const state = s();
      state.ui.showSave = !state.ui.showSave;
      state.ui.showFinance = false;
      state.ui.showHelp = false;
      state.ui.showTransit = false;
      state.ui.showStats = false;
      store.bumpUI();
    },

    toggleUnderground(): void {
      const state = s();
      state.ui.showUnderground = !state.ui.showUnderground;
      if (!state.ui.showUnderground) {
        // 關閉地下層時，如正在用管道工具就清走
        if (state.ui.tool?.startsWith('pipe:')) state.ui.tool = null;
      }
      store.bumpUI();
    },

    toggleUtilityPanel(): void {
      const state = s();
      state.ui.showUtilityPanel = !state.ui.showUtilityPanel;
      state.ui.showFinance = false;
      state.ui.showTransit = false;
      state.ui.showStats = false;
      state.ui.showHelp = false;
      state.ui.showSave = false;
      store.bumpUI();
    },

    upgradeTradeBuilding(buildingId: number): { ok: boolean; reason?: string; cost?: number } {
      const state = s();
      const result = upgradeTradeBuilding(state, buildingId);
      if (result.ok) {
        store.toast(`設施已升級，花費 ${formatMoneyShort(result.cost ?? 0)}`, 'good');
        refresh();
      } else if (result.reason) {
        warn(result.reason);
      }
      return result;
    },

    beginLineEditor(mode: TransitLineMode): void {
      const state = s();
      const depotKey = mode === 'bus' ? 'busTerminus' : 'minibusDepot';
      if (!state.buildings.some((b) => BUILDINGS[b.key]?.key === depotKey)) {
        warn(mode === 'bus' ? '請先興建巴士總站作為車廠' : '請先興建小巴車廠');
        return;
      }
      if (!state.buildings.some((b) => BUILDINGS[b.key]?.stopMode === mode)) {
        warn(mode === 'bus' ? '先興建至少兩個巴士站' : '先興建至少兩個小巴站');
        return;
      }
      state.ui.lineEditorActive = true;
      state.ui.lineDraft = { mode, stopIds: [] };
      state.ui.showTransit = true;
      state.ui.showFinance = false;
      state.ui.showStats = false;
      state.ui.showUtilityPanel = false;
      state.ui.showTradePanel = false;
      state.ui.tool = 'line-select';
      store.toast(mode === 'bus' ? '建線模式：依次點擊巴士站（再點可移除）' : '建線模式：依次點擊小巴站（再點可移除）', 'info');
      store.bumpUI();
    },

    toggleLineStop(buildingId: number): void {
      const state = s();
      const draft = state.ui.lineDraft;
      if (!draft) return;
      const building = state.buildings.find((b) => b.id === buildingId);
      if (!building) return;
      if (BUILDINGS[building.key]?.stopMode !== draft.mode) {
        warn(draft.mode === 'bus' ? '這不是巴士站' : '這不是小巴站');
        return;
      }
      const pos = draft.stopIds.indexOf(buildingId);
      if (pos >= 0) draft.stopIds.splice(pos, 1);
      else draft.stopIds.push(buildingId);
      store.bumpUI();
    },

    finishLineEditor(): void {
      const state = s();
      const draft = state.ui.lineDraft;
      if (!draft) return;
      const stopIds = draft.stopIds.slice();
      if (stopIds.length < 2) {
        warn('路線至少需要 2 個站點');
        return;
      }
      const result = createTransitLine(state, {
        mode: draft.mode,
        stopIds,
        loop: true,
        vehicleCount: Math.max(1, Math.min(6, Math.ceil(stopIds.length / 3))),
        fare: draft.mode === 'bus' ? 6 : 4,
      });
      if (!result.ok) {
        warn(result.reason ?? '未能建立路線');
        return;
      }
      state.ui.lineEditorActive = false;
      state.ui.lineDraft = null;
      state.ui.tool = null;
      state.ui.selectedLineId = result.id ?? null;
      store.toast('路線已開通，可在交通面板調整車數與票價', 'good');
      refresh();
    },

    cancelLineEditor(): void {
      const state = s();
      state.ui.lineEditorActive = false;
      state.ui.lineDraft = null;
      if (state.ui.tool === 'line-select') state.ui.tool = null;
      store.bumpUI();
    },

    createTransitLine(input: TransitLineInput): { ok: boolean; reason?: string; id?: number } {
      const result = createTransitLine(s(), input);
      if (result.ok) {
        s().ui.selectedLineId = result.id ?? null;
        refresh();
      } else if (result.reason) warn(result.reason);
      return result;
    },

    updateTransitLine(
      id: number,
      patch: Partial<Pick<TransitLine, 'vehicleCount' | 'fare' | 'name' | 'color' | 'loop' | 'suspended'>>,
    ): { ok: boolean; reason?: string } {
      const result = updateTransitLine(s(), id, patch);
      if (result.ok) refresh();
      else if (result.reason) warn(result.reason);
      return result;
    },

    deleteTransitLine(id: number): boolean {
      const ok = deleteTransitLine(s(), id);
      if (ok) {
        if (s().ui.selectedLineId === id) s().ui.selectedLineId = null;
        refresh();
      }
      return ok;
    },

    toggleTradePanel(): void {
      const state = s();
      state.ui.showTradePanel = !state.ui.showTradePanel;
      state.ui.showFinance = false;
      state.ui.showTransit = false;
      state.ui.showStats = false;
      state.ui.showHelp = false;
      state.ui.showSave = false;
      store.bumpUI();
    },

    closeOverlays(): void {
      const state = s();
      state.ui.showFinance = false;
      state.ui.showHelp = false;
      state.ui.showSave = false;
      state.ui.showTransit = false;
      state.ui.showStats = false;
      state.ui.showUtilityPanel = false;
      state.ui.showTradePanel = false;
      if (state.ui.lineEditorActive) {
        state.ui.lineEditorActive = false;
        state.ui.lineDraft = null;
      }
      store.bumpUI();
    },
  };
  return actions;
}

function boot(): void {
  const uiMode = applyUiMode();
  const gameRoot = document.getElementById('game-root');
  const uiRoot = document.getElementById('ui-root');
  if (!gameRoot || !uiRoot) throw new Error('找不到遊戲容器');

  const autosaved = saves.loadAutosave();
  let initialState: GameState;
  if (autosaved) {
    initialState = sanitizeLoadedState(autosaved);
  } else {
    initialState = createGameState(undefined, 'starter');
    warmUpStarterTown(initialState);
    initialState.ui.showStartScreen = true;
    initialState.ui.showTutorial = false;
    // 開局畫面顯示期間暫停模擬，等玩家選擇模式
    initialState.clock.paused = true;
  }
  const store = new GameStore(initialState);
  const actions = createActions(store);
  const view = new CityView({ container: gameRoot, store, actions });
  const ui = createUI(uiRoot, store, actions);
  const simulation = createSimulation();
  const ctx: SimContext = {
    toast: (text: string, kind: LogKind = 'info') => store.toast(text, kind),
    log: (text: string, kind: LogKind = 'info') => store.log(text, kind),
  };

  let last = performance.now();
  let autosaveTimer = 0;
  let bootHidden = false;

  const loop = (now: number): void => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    try {
      simulation.update(store.state, dt, ctx);
      view.frame();
      ui.update(store.state);
    } catch (err) {
      console.error('[遊戲迴圈錯誤]', err);
    }
    autosaveTimer += dt;
    if (autosaveTimer >= 60) {
      autosaveTimer = 0;
      saves.autosave(store.state);
    }
    if (!bootHidden) {
      bootHidden = true;
      setTimeout(() => {
        const bootScreen = document.getElementById('boot-screen');
        bootScreen?.classList.add('hidden');
        setTimeout(() => bootScreen?.remove(), 700);
      }, 450);
    }
    requestAnimationFrame(loop);
  };

  requestAnimationFrame((t) => {
    last = t;
    loop(t);
  });

  const persist = (): void => {
    saves.autosave(store.state);
  };
  window.addEventListener('beforeunload', persist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persist();
  });

  // 除錯用
  (window as unknown as Record<string, unknown>).__HK_CITY__ = {
    store,
    actions,
    view,
    ui,
    simulation,
    ctx,
    BUILDINGS,
    ZONES,
    deriveClockFields,
    // QA／debug 用：分區查詢與自動建築（正常遊玩唔會用）
    zoneDebug: {
      paintZone,
      eraseZone,
      placeAutoBuilding,
      placeBuilding,
      computeZoneDemand,
      zoneStats,
      placePipe,
      removePipe,
      computeUtilitySnapshot,
      layStarterPipes,
      regionKindAt,
    },
  };
  if (uiMode === 'mobile') {
    setTimeout(() => {
      store.toast('手機操作：單指拖曳平移 · 雙指縮放／旋轉 · 點擊建造 · 連點兩次進入建築', 'info');
    }, 2200);
  }
  console.info(
    `《維港之城》已啟動（${isMobileUi() ? '手機' : '電腦'}介面）— 按 H 查看操作說明`,
  );
}

try {
  boot();
} catch (err) {
  console.error(err);
  const bootScreen = document.getElementById('boot-screen');
  if (bootScreen) {
    bootScreen.innerHTML = `<div class="boot-inner"><h1>載入失敗</h1><p class="boot-sub">${String(err)}</p></div>`;
  }
}
