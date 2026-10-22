/**
 * 彈出面板共用外殼（財政／交通／存檔／說明／教學）。
 *
 * 每個面板各自建立一個 `.modal-root` 容器，內容以 `modalShell()` 產生：
 *   <div class="modal-backdrop" data-modal="finance">
 *     <div class="modal modal-finance">…</div>
 *   </div>
 * 關閉：點背景、右上角 × 或 Esc（Esc 由 CityView 的 closeOverlays 統一處理）。
 */

import { getUiMode } from '../core/device';
import type { GameStore } from '../core/store';
import type { GameActions } from '../core/types';
import { delegate, esc } from './dom';
import { ico, sealHtml } from './icons';

/**
 * 桌面版關閉彈出面板後，重新顯示右側「城事」面板
 * （Lead 的 toggleX action 會把 showStats 關掉，這裡在關閉時還原）。
 */
export function restoreInfoPanel(store: GameStore): void {
  if (getUiMode() === 'desktop' && store.state.ui.mode === 'city') {
    store.state.ui.showStats = true;
  }
}

export interface OverlayHost {
  layer: HTMLElement;
  /** 是否正在顯示 */
  readonly isOpen: boolean;
  /** 顯示／替換內容（傳入 modalShell() 的 HTML） */
  show(html: string): void;
  /** 收起並清空內容 */
  hide(): void;
  destroy(): void;
}

export function createOverlayHost(
  container: HTMLElement,
  actions: GameActions,
  closeOverride?: () => void,
): OverlayHost {
  const layer = document.createElement('div');
  layer.className = 'modal-root';
  layer.setAttribute('aria-hidden', 'true');
  container.appendChild(layer);

  let open = false;

  const close = (): void => {
    if (closeOverride) closeOverride();
    else actions.closeOverlays();
  };

  const onLayerClick = (event: Event): void => {
    const target = event.target;
    if (target instanceof Element && target.classList.contains('modal-backdrop')) close();
  };
  layer.addEventListener('click', onLayerClick);
  const offClose = delegate(layer, 'click', '[data-act="close"]', close);

  const show = (html: string): void => {
    layer.innerHTML = html;
    layer.classList.add('open');
    layer.setAttribute('aria-hidden', 'false');
    open = true;
  };

  const hide = (): void => {
    if (!open && !layer.innerHTML) return;
    open = false;
    layer.classList.remove('open');
    layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML = '';
  };

  return {
    layer,
    get isOpen(): boolean {
      return open;
    },
    show,
    hide,
    destroy(): void {
      layer.removeEventListener('click', onLayerClick);
      offClose();
      layer.remove();
    },
  };
}

export interface ModalShellOptions {
  key: string;
  badge: string;
  title: string;
  subtitle: string;
  body: string;
  footer?: string;
}

/** 彈出面板外框（霓虹玻璃 + 港鐵色帶） */
export function modalShell(opts: ModalShellOptions): string {
  const { key, badge, title, subtitle, body, footer } = opts;
  return `
    <div class="modal-backdrop" data-modal="${esc(key)}">
      <div class="modal modal-${esc(key)}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-frame">
          <div class="modal-glow" aria-hidden="true"></div>
          <header class="modal-head">
            <div class="modal-heading">
              ${sealHtml(badge, 'modal-seal')}
              <div class="modal-heading-text">
                <h2>${esc(title)}</h2>
                <small>${subtitle}</small>
              </div>
            </div>
            <button type="button" class="modal-close" data-act="close" title="關閉（Esc）">${ico('close')}</button>
          </header>
          <div class="modal-body">${body}</div>
          ${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}
        </div>
      </div>
    </div>
  `;
}

/** 金錢正負號格式 */
export function signedMoney(value: number, moneyFormatter: (v: number) => string): string {
  if (value > 0) return `+${moneyFormatter(value)}`;
  return moneyFormatter(value);
}

/** 簡易進度條（分類收支比例） */
export function ratioBar(value: number, total: number, tone: 'cyan' | 'pink' | 'gold' = 'cyan'): string {
  const ratio = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  return `<span class="ratio-bar"><i class="ratio-${tone}" style="width:${Math.round(ratio * 100)}%"></i></span>`;
}
