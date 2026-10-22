/**
 * 存檔面板：霓虹港風「存檔」。
 *
 *  - 自動存檔格 + 3 個手動存檔格（時間、人口、庫房、日期）
 *  - 讀取／覆蓋／刪除（二次確認）
 *  - JSON 匯出／匯入
 *  - 另起新局（可輸入地圖種子）
 */

import { START_TREASURY, STARTER_TOWN, formatMoney, formatMoneyShort } from '../core/config';
import type { GameActions, GameState, NewGameMode, SaveSlotInfo } from '../core/types';
import type { GameStore } from '../core/store';
import { delegate, esc, num, timestampLabel } from './dom';
import { ico } from './icons';
import { createOverlayHost, modalShell, restoreInfoPanel } from './overlay';

export interface SavePanelView {
  update(state: GameState): void;
  destroy(): void;
}

type ConfirmState = { kind: 'delete' | 'new'; slot: number } | null;

const SLOT_NAMES = ['自動存檔', '存檔一', '存檔二', '存檔三'];

export function createSavePanel(container: HTMLElement, store: GameStore, actions: GameActions): SavePanelView {
  const closeSave = (): void => {
    store.state.ui.showSave = false;
    restoreInfoPanel(store);
    store.bumpUI();
  };
  const host = createOverlayHost(container, actions, closeSave);
  let current = false;
  let saves: SaveSlotInfo[] = [];
  let savesAt = 0;
  let savesDirty = true;
  let confirm: ConfirmState = null;
  let seedInput = '';
  let newGameMode: NewGameMode = 'starter';
  let lastSig = '';

  const markDirty = (): void => {
    savesDirty = true;
  };

  const offClick = delegate(host.layer, 'click', '[data-act]', (node) => {
    switch (node.dataset.act) {
      case 'save-slot': {
        const slot = Number(node.dataset.slot);
        if (!Number.isFinite(slot)) return;
        actions.saveGame(slot);
        markDirty();
        return;
      }
      case 'load-slot': {
        const slot = Number(node.dataset.slot);
        if (!Number.isFinite(slot)) return;
        if (actions.loadGame(slot)) markDirty();
        return;
      }
      case 'delete-slot': {
        const slot = Number(node.dataset.slot);
        if (!Number.isFinite(slot)) return;
        confirm = { kind: 'delete', slot };
        markDirty();
        return;
      }
      case 'confirm-delete': {
        if (confirm?.kind === 'delete') actions.deleteSave(confirm.slot);
        confirm = null;
        markDirty();
        return;
      }
      case 'cancel-confirm':
        confirm = null;
        seedInput = '';
        markDirty();
        return;
      case 'new-game':
        confirm = { kind: 'new', slot: 0 };
        newGameMode = store.state.gameMode === 'empty' ? 'empty' : 'starter';
        markDirty();
        return;
      case 'ng-mode': {
        const mode = node.dataset.mode as NewGameMode | undefined;
        if (mode === 'starter' || mode === 'empty') newGameMode = mode;
        markDirty();
        return;
      }
      case 'confirm-new-game': {
        const parsed = Number.parseInt(seedInput.trim(), 10);
        const seed = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
        confirm = null;
        seedInput = '';
        actions.newGame(seed, newGameMode);
        markDirty();
        return;
      }
      case 'export':
        actions.exportSave();
        return;
      default:
        return;
    }
  });

  const offInput = delegate(host.layer, 'input', '[data-act]', (node) => {
    if (node.dataset.act === 'seed-input') seedInput = (node as HTMLInputElement).value;
  });

  const offChange = delegate(host.layer, 'change', '[data-act="import"]', async (node) => {
    const input = node as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const ok = await actions.importSave(file);
    input.value = '';
    if (ok) markDirty();
  });

  const saveSignature = (): string =>
    saves
      .map(
        (slot) =>
          `${slot.slot}:${slot.empty ? 0 : 1}:${slot.savedAt}:${slot.population}:${Math.round(slot.treasury)}:${slot.cityName}:${slot.dateLabel}`,
      )
      .join('|') + `|${confirm ? `${confirm.kind}:${confirm.slot}:${seedInput}:${newGameMode}` : ''}`;

  const render = (): void => {
    const cards = saves
      .map((slot) => {
        const empty = slot.empty;
        const auto = slot.slot === 0;
        const isDeleteConfirm = confirm?.kind === 'delete' && confirm.slot === slot.slot;
        const body = empty
          ? '<div class="slot-body slot-empty"><span class="muted">此存檔格尚未使用</span></div>'
          : `<div class="slot-body">
              <b class="slot-city">${esc(slot.cityName || '維港之城')}</b>
              <div class="slot-meta">
                <span>人口 ${num(slot.population)}</span>
                <span>庫房 ${formatMoney(slot.treasury)}</span>
                <span>${esc(slot.dateLabel)}</span>
              </div>
            </div>`;
        const actionsHtml = `
          <div class="slot-actions">
            ${
              auto
                ? ''
                : `<button type="button" class="mini-btn" data-act="save-slot" data-slot="${slot.slot}">${empty ? '保存至此' : '覆蓋存檔'}</button>`
            }
            <button type="button" class="mini-btn ghost" data-act="load-slot" data-slot="${slot.slot}" ${empty ? 'disabled' : ''}>讀取</button>
            ${
              !auto && !empty
                ? `<button type="button" class="mini-btn danger" data-act="delete-slot" data-slot="${slot.slot}">刪除</button>`
                : ''
            }
          </div>
          ${
            isDeleteConfirm
              ? `<div class="confirm-inline"><span>確定刪除「${esc(slot.cityName)}」的存檔？</span>
                  <button type="button" class="danger" data-act="confirm-delete" data-slot="${slot.slot}">確定刪除</button>
                  <button type="button" data-act="cancel-confirm">取消</button></div>`
              : ''
          }`;
        return `
          <article class="save-slot${auto ? ' autosave' : ''}${empty ? ' empty' : ''}">
            <header class="slot-head">
              <span class="slot-name">${auto ? ico('clock') : ico('scroll')}${SLOT_NAMES[slot.slot] ?? `存檔 ${slot.slot}`}</span>
              <span class="slot-time">${empty ? '—' : timestampLabel(slot.savedAt)}</span>
            </header>
            ${body}
            ${actionsHtml}
          </article>`;
      })
      .join('');

    const newGameConfirm =
      confirm?.kind === 'new'
        ? `<div class="new-game-box">
            <p><b>確定另起新局？</b>目前未手動保存的進度將會遺失。</p>
            <div class="ng-modes" role="radiogroup" aria-label="開局模式">
              <button type="button" class="ng-mode${newGameMode === 'starter' ? ' selected' : ''}" data-act="ng-mode" data-mode="starter" role="radio" aria-checked="${newGameMode === 'starter'}">
                <b>已有城鎮</b>
                <small>中環起步 · 約 ${STARTER_TOWN.targetPopulation} 名居民 · ${formatMoneyShort(STARTER_TOWN.treasury)}</small>
              </button>
              <button type="button" class="ng-mode${newGameMode === 'empty' ? ' selected' : ''}" data-act="ng-mode" data-mode="empty" role="radio" aria-checked="${newGameMode === 'empty'}">
                <b>由零開始</b>
                <small>空地圖 · 5 名市民 · ${formatMoneyShort(START_TREASURY)}</small>
              </button>
            </div>
            <label class="seed-label">地圖種子（留空則隨機）
              <input type="text" inputmode="numeric" data-act="seed-input" value="${esc(seedInput)}" placeholder="例如 20260301" />
            </label>
            <div class="confirm-btns">
              <button type="button" class="danger" data-act="confirm-new-game">確定另起新局</button>
              <button type="button" data-act="cancel-confirm">取消</button>
            </div>
          </div>`
        : '';

    const body = `
      <p class="save-lead">${ico('scroll')}存檔保存在瀏覽器本機，運作期間每 60 秒自動存檔。可手動保存三格，或匯出 JSON 備份到其他裝置。「另起新局」可選已有城鎮或由零開始。</p>
      <p class="save-map">${ico('map')}目前地圖：${store.state.width}×${store.state.height} 格（約 ${num(store.state.width * store.state.height)} 格）· ${
        store.state.gameMode === 'starter' ? '已有城鎮' : '由零開始'
      }</p>
      <div class="save-list">${cards}</div>
      <div class="save-tools">
        <button type="button" class="save-tool" data-act="export">${ico('scroll')}匯出 JSON</button>
        <label class="save-tool file">
          ${ico('book')}匯入 JSON
          <input type="file" accept=".json,application/json" data-act="import" hidden />
        </label>
        <button type="button" class="save-tool danger-outline" data-act="new-game">${ico('warn')}另起新局</button>
      </div>
      ${newGameConfirm}
      <p class="modal-foot-note">${ico('info')}讀檔後城市會完整還原；匯入存檔會即時取代目前進度。</p>
    `;

    host.show(
      modalShell({
        key: 'save',
        badge: '檔',
        title: '存檔',
        subtitle: '自動存檔 · 手動三格 · 匯出匯入',
        body,
      }),
    );
    lastSig = saveSignature();
    host.layer.querySelector('.new-game-box, .confirm-inline')?.scrollIntoView({ block: 'nearest' });
  };

  const update = (state: GameState): void => {
    const open = state.ui.showSave;
    if (!open) {
      if (current) {
        current = false;
        lastSig = '';
        confirm = null;
        seedInput = '';
        host.hide();
      }
      return;
    }
    if (!current) {
      current = true;
      saves = actions.getSaves();
      savesAt = performance.now();
      savesDirty = false;
      lastSig = '';
      render();
      return;
    }
    const now = performance.now();
    if (savesDirty || now - savesAt > 3000) {
      saves = actions.getSaves();
      savesAt = now;
      savesDirty = false;
    }
    const sig = saveSignature();
    if (sig !== lastSig) render();
  };

  return {
    update,
    destroy(): void {
      offClick();
      offInput();
      offChange();
      host.destroy();
    },
  };
}
