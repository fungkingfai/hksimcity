/**
 * 浮動提示（toast）：霓虹港風四種樣式（消息／好消息／留意／警示），自動消退。
 * 訂閱 GameStore 的 'toast' 事件，不參與每幀 update。
 */

import type { LogKind } from '../core/types';
import type { GameStore } from '../core/store';
import { el, esc } from './dom';
import { ICON } from './icons';

interface ToastPayload {
  text?: string;
  kind?: LogKind;
}

const KIND_META: Record<LogKind, { icon: string; label: string }> = {
  info: { icon: ICON.info, label: '消息' },
  good: { icon: ICON.check, label: '好消息' },
  warn: { icon: ICON.warn, label: '留意' },
  bad: { icon: ICON.close, label: '警示' },
};

export interface ToastsView {
  destroy(): void;
}

export function createToasts(container: HTMLElement, store: GameStore): ToastsView {
  const stack = el('div', 'toast-stack');
  stack.setAttribute('aria-live', 'polite');
  container.appendChild(stack);

  const timers = new Set<number>();

  const spawn = (text: string, kind: LogKind): void => {
    const meta = KIND_META[kind] ?? KIND_META.info;
    const node = el(
      'div',
      `toast toast-${kind}`,
      `<span class="toast-mark">${meta.icon}</span><div class="toast-body"><b>${meta.label}</b><span>${esc(text)}</span></div>`,
    );
    stack.appendChild(node);
    // 先讓節點進 DOM 再啟動進場動畫
    requestAnimationFrame(() => node.classList.add('show'));
    const removeTimer = window.setTimeout(() => {
      timers.delete(removeTimer);
      node.classList.remove('show');
      const dropTimer = window.setTimeout(() => {
        timers.delete(dropTimer);
        node.remove();
      }, 320);
      timers.add(dropTimer);
    }, 3400);
    timers.add(removeTimer);
    while (stack.children.length > 5) stack.firstElementChild?.remove();
  };

  const off = store.on('toast', (payload) => {
    const data = (payload ?? {}) as ToastPayload;
    spawn(data.text ?? '', data.kind ?? 'info');
  });

  return {
    destroy(): void {
      off();
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
      stack.remove();
    },
  };
}
