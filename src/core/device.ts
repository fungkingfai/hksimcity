/**
 * 裝置 / 介面模式偵測。
 *
 * 手機或平板（粗指標／觸控／行動裝置 UA）使用手機版 UI；
 * 桌上型電腦使用原本的電腦版 UI。
 * 可用 ?ui=mobile / ?ui=desktop 強制切換（方便測試與除錯）。
 */

export type UiMode = 'mobile' | 'desktop';

let cachedMode: UiMode | null = null;

function forcedMode(): UiMode | null {
  try {
    const param = new URLSearchParams(window.location.search).get('ui');
    if (param === 'mobile' || param === 'desktop') return param;
  } catch {
    /* ignore */
  }
  return null;
}

/** 僅偵測，不套用 class（可重複呼叫，結果快取） */
export function getUiMode(): UiMode {
  if (cachedMode) return cachedMode;
  const forced = forcedMode();
  if (forced) {
    cachedMode = forced;
    return cachedMode;
  }

  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    cachedMode = 'desktop';
    return cachedMode;
  }

  const ua = navigator.userAgent ?? '';
  const uaMobile = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini|IEMobile/i.test(ua);
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const noHover = typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches;
  const maxTouch = navigator.maxTouchPoints ?? 0;
  const narrow = window.innerWidth <= 900;

  // iPadOS 13+ 會偽裝成 Macintosh，但 maxTouchPoints > 1。
  const iPadOs = /Macintosh/i.test(ua) && maxTouch > 1;

  if (iPadOs || ((coarse || maxTouch > 0) && (narrow || uaMobile || noHover)) || (uaMobile && narrow)) {
    cachedMode = 'mobile';
  } else {
    cachedMode = 'desktop';
  }
  return cachedMode;
}

/** 是否使用手機版介面 */
export function isMobileUi(): boolean {
  return getUiMode() === 'mobile';
}

/**
 * 將介面模式套用到 <html>：
 *  - data-ui-mode="mobile|desktop"
 *  - class ui-mobile / ui-desktop（供全域 CSS 使用，例如 canvas 的 touch-action）
 */
export function applyUiMode(): UiMode {
  const mode = getUiMode();
  if (typeof document !== 'undefined') {
    const html = document.documentElement;
    html.dataset.uiMode = mode;
    html.classList.toggle('ui-mobile', mode === 'mobile');
    html.classList.toggle('ui-desktop', mode === 'desktop');
  }
  return mode;
}

/** 重設快取（僅測試或執行期切換使用） */
export function resetUiModeCache(): void {
  cachedMode = null;
}
