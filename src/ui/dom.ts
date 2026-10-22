/**
 * UI 共用小工具：DOM 建立、安全轉義、差異更新（diff）、格式化。
 *
 * 這裡的函式刻意保持極輕量：UI 的 update() 每個影格都會被呼叫，所有
 * 文字／樣式寫入都先比對目前值，避免每幀重建 DOM 或觸發重排。
 */

const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTML 轉義（所有動態文字進 innerHTML 前必經） */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESC_MAP[ch] ?? ch);
}

/** 建立元素（可帶 class 與 HTML 內容） */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  html = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

export function qs<T extends Element = HTMLElement>(parent: ParentNode, selector: string): T | null {
  return parent.querySelector<T>(selector);
}

export function qsa<T extends Element = HTMLElement>(parent: ParentNode, selector: string): T[] {
  return Array.from(parent.querySelectorAll<T>(selector));
}

// ─────────────────────────── 差異更新 ───────────────────────────

/** 只有內容不同才寫入 textContent */
export function setText(node: Element | null | undefined, text: string): void {
  if (!node) return;
  if (node.textContent !== text) node.textContent = text;
}

/** 只有狀態不同才切換 class */
export function setClass(node: Element | null | undefined, className: string, enabled: boolean): void {
  if (!node) return;
  if (node.classList.contains(className) !== enabled) node.classList.toggle(className, enabled);
}

export function setHidden(node: HTMLElement | null | undefined, hidden: boolean): void {
  if (!node) return;
  if (node.hidden !== hidden) node.hidden = hidden;
}

export function setCssVar(node: HTMLElement | null | undefined, name: string, value: string): void {
  if (!node) return;
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
}

/** 由呼叫端自行保證「只在簽章變更時」呼叫；此函式不做事前比對。 */
export function setHtml(node: Element | null | undefined, html: string): void {
  if (!node) return;
  node.innerHTML = html;
}

/**
 * 鍵入是否落喺輸入框中（快捷鍵要避開，否則打字會被攔截）。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true;
}

/**
 * 事件委派：監聽器只綁一次，內容重繪後仍有效。
 * 回傳取消函式。
 */
export function delegate(
  root: EventTarget,
  type: string,
  selector: string,
  handler: (node: HTMLElement, event: Event) => void,
): () => void {
  const listener = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const node = target.closest<HTMLElement>(selector);
    if (!node) return;
    if (root instanceof Node && !root.contains(node)) return;
    handler(node, event);
  };
  root.addEventListener(type, listener);
  return () => root.removeEventListener(type, listener);
}

// ─────────────────────────── 格式化 ───────────────────────────

export function hexColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 整數千分位 */
export function num(value: number): string {
  return Math.round(value).toLocaleString('zh-Hant');
}

/** 資源數量（整數較好看；小量保留一位小數） */
export function fmtAmount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 10) return String(Math.round(value));
  if (abs >= 0.05) return String(Math.round(value * 10) / 10);
  return '0';
}

/** 百分比（0..1 → 「73%」） */
export function pct(value: number, digits = 0): string {
  const clamped = clamp(value, 0, 1) * 100;
  return `${clamped.toFixed(digits)}%`;
}

/** 帶正負號的金額（已格式化字串） */
export function signed(money: string, value: number): string {
  return value > 0 ? `+${money}` : money;
}

/** 存檔時間：10/18 20:41 */
export function timestampLabel(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (v: number): string => String(v).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 建築維護費合計（每月） */
export function sumUpkeep(buildings: { key: string }[], lookup: (key: string) => number | undefined): number {
  let total = 0;
  for (const b of buildings) total += lookup(b.key) ?? 0;
  return total;
}

export type Tone = 'bad' | 'ok' | 'good';

export function happinessTone(value: number): Tone {
  if (value < 35) return 'bad';
  if (value < 65) return 'ok';
  return 'good';
}

/** 覆蓋率／滿足度色調（0..1） */
export function ratioTone(value: number): Tone {
  if (value < 0.4) return 'bad';
  if (value < 0.75) return 'ok';
  return 'good';
}

export function toneClass(prefix: string, tone: Tone): string {
  return `${prefix} ${prefix}-${tone}`;
}
