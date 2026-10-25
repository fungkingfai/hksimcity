/**
 * 地下管網工具列（Round 5 · Phase A）。
 *
 * 當 `ui.showUnderground` 或正在使用 `pipe:*` 工具時，於畫面底部顯示：
 *  - 食水管／污水管／電力電纜（PIPE_INFO 造價＋維護）＋拆除管道（退 25%）
 *  - 三網即時覆蓋率摘要（state.utilities）
 *  - 公用設施面板 button、返回地面（U）button
 *
 * 地下模式下 mode-hint 會收起，由本工具列顯示操作提示。
 */

import { PIPE_INFO } from '../core/config';
import type { GameActions, GameState } from '../core/types';
import type { GameStore } from '../core/store';
import { delegate, num, qs, setClass, setHidden, setText } from './dom';
import { ico } from './icons';
import { activatePipeTool, pipeKindOfTool, toggleUtilityPanel, type PipeToolKind } from './round5-helpers';

export interface UndergroundBarView {
  update(state: GameState): void;
  destroy(): void;
}

const PIPE_ORDER: Exclude<PipeToolKind, 'remove'>[] = ['water', 'sewer', 'power'];

const PIPE_ICON: Record<Exclude<PipeToolKind, 'remove'>, 'water' | 'valve' | 'power'> = {
  water: 'water',
  sewer: 'valve',
  power: 'power',
};

export function createUndergroundBar(container: HTMLElement, store: GameStore, actions: GameActions): UndergroundBarView {
  const root = document.createElement('div');
  root.className = 'ug-bar';
  root.hidden = true;
  root.innerHTML = `
    <div class="ug-head">
      <span class="ug-title">${ico('pipe')}<b>地下管網</b><span class="ug-mode">水 · 污水 · 電 · 鐵路</span></span>
      <span class="ug-status" data-k="ugStatus">管網計算中…</span>
      <div class="ug-actions">
        <button type="button" class="ug-action" data-act="ug-utility" title="公用設施面板">${ico('gauge')}<span>公用</span></button>
        <button type="button" class="ug-action" data-act="ug-exit" title="返回地面（U）">${ico('close')}<span>返回地面</span><kbd>U</kbd></button>
      </div>
    </div>
    <div class="ug-tools">
      ${PIPE_ORDER.map((kind) => {
        const info = PIPE_INFO[kind];
        return `
          <button type="button" class="ug-tool" data-act="ug-pipe" data-kind="${kind}" style="--pipe:${info.color}" title="${info.name}">
            <span class="ug-ico">${ico(PIPE_ICON[kind])}</span>
            <span class="ug-meta"><b>${info.name}</b><small>$${num(info.cost)}/格 · 維護 $${info.upkeep}/月</small></span>
          </button>`;
      }).join('')}
      <button type="button" class="ug-tool danger" data-act="ug-pipe" data-kind="remove" style="--pipe:#ff5a5a" title="拆除管道（退 25%）">
        <span class="ug-ico">${ico('hammer')}</span>
        <span class="ug-meta"><b>拆除管道</b><small>退還 25% 造價</small></span>
      </button>
    </div>
    <p class="ug-hint" data-k="ugHint">點擊／拖曳地圖鋪設管道；建築需接駁對應管道先有水／電。管道可穿過道路下方。</p>
  `;
  container.appendChild(root);

  const statusEl = qs<HTMLElement>(root, '[data-k="ugStatus"]')!;
  const hintEl = qs<HTMLElement>(root, '[data-k="ugHint"]')!;
  const toolButtons = Array.from(root.querySelectorAll<HTMLElement>('[data-act="ug-pipe"]'));

  const offClick = delegate(root, 'click', '[data-act]', (node) => {
    switch (node.dataset.act) {
      case 'ug-pipe': {
        const kind = node.dataset.kind as PipeToolKind | undefined;
        if (kind) activatePipeTool(store, actions, kind);
        break;
      }
      case 'ug-utility':
        toggleUtilityPanel(store, actions);
        break;
      case 'ug-exit': {
        const ui = store.state.ui;
        if (typeof actions.toggleUnderground === 'function') actions.toggleUnderground();
        else {
          ui.showUnderground = false;
          ui.tool = null;
          store.bumpUI();
        }
        break;
      }
      default:
        break;
    }
  });

  let lastKey = '';
  let lastTool = '';

  const update = (state: GameState): void => {
    const ui = state.ui;
    const pipeKind = pipeKindOfTool(ui.tool);
    const show = Boolean(ui.showUnderground) || pipeKind !== null;
    if (root.hidden === show) root.hidden = !show;
    if (!show) return;

    // active tool
    if (lastTool !== (ui.tool ?? '')) {
      lastTool = ui.tool ?? '';
      for (const btn of toolButtons) {
        setClass(btn, 'active', pipeKind !== null && btn.dataset.kind === pipeKind);
      }
    }

    const snap = state.utilities;
    const statusKey = snap
      ? `${snap.revision}|${Math.round(snap.water.coverage * 100)}|${Math.round(snap.sewage.coverage * 100)}|${Math.round(snap.power.coverage * 100)}|${Math.round(snap.pipeUpkeep)}`
      : 'none';
    if (statusKey !== lastKey) {
      lastKey = statusKey;
      if (snap) {
        const parts = [
          `水 ${Math.round(snap.water.coverage * 100)}%`,
          `污水 ${Math.round(snap.sewage.coverage * 100)}%`,
          `電 ${Math.round(snap.power.coverage * 100)}%`,
          `管 ${num(snap.pipeCounts.water + snap.pipeCounts.sewer + snap.pipeCounts.power)} 格`,
        ];
        setText(statusEl, parts.join(' · '));
        setClass(statusEl, 'warn', snap.water.shortage > 0.05 || snap.sewage.overflow > 0.02 || snap.power.shortage > 0.05);
      } else {
        setText(statusEl, '管網計算中／尚未接駁（等待模擬）');
        setClass(statusEl, 'warn', false);
      }
    }

    setHidden(hintEl, false);
    const pipeLabel = pipeKind
      ? pipeKind === 'remove'
        ? '拆除管道'
        : PIPE_INFO[pipeKind].name
      : '';
    setHidden(hintEl, false);
    setText(
      hintEl,
      pipeKind
        ? `正在鋪設「${pipeLabel}」：點擊／拖曳地圖 · 右鍵取消 · Esc 返回`
        : '點擊上方工具鋪設食水管／污水管／電力電纜；建築需接駁先有水／電。地下層亦顯示地下鐵路軌（地面／高架鐵路按地圖顯示）。',
    );
  };

  return {
    update,
    destroy(): void {
      offClick();
      root.remove();
    },
  };
}
