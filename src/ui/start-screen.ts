/**
 * 開局模式選擇畫面（全屏霓虹港風）。
 *
 * 當 `state.ui.showStartScreen` 為 true 時顯示：
 *  - 已有城鎮（starter，新手推薦）：預載中環起步城鎮、約百多名居民、$650 萬
 *  - 由零開始（empty，挑戰）：空曠香港地圖、5 名市民、$800 萬
 *  - 選填地圖 seed（相同 seed 生成相同地圖）
 * 按下開始 → `actions.startGame(mode, seed)`；畫面由 Lead 的 action 收起。
 */

import { GRID_HEIGHT, GRID_WIDTH, START_TREASURY, STARTER_TOWN, formatMoneyShort } from '../core/config';
import { getUiMode } from '../core/device';
import type { NewGameMode } from '../core/types';
import type { GameActions, GameState } from '../core/types';
import type { GameStore } from '../core/store';
import { delegate, esc, num, qs, setClass, setHidden, setText } from './dom';
import { ico, type IconName } from './icons';

export interface StartScreenView {
  update(state: GameState): void;
  destroy(): void;
}

interface ModeDef {
  mode: NewGameMode;
  title: string;
  badge: string;
  icon: IconName;
  desc: string;
  points: string[];
  stats: [string, string][];
}

const MAP_W = GRID_WIDTH;
const MAP_H = GRID_HEIGHT;
const MAP_CELLS = GRID_WIDTH * GRID_HEIGHT;
const MAP_LABEL = `${MAP_W}×${MAP_H}`;
/** 相對 Round 2（96×96）的面積倍數（600² → 39 倍） */
const MAP_AREA_MULT = Math.max(1, Math.round(MAP_CELLS / (96 * 96)));

const MODES: ModeDef[] = [
  {
    mode: 'starter',
    title: '已有城鎮',
    badge: '新手推薦',
    icon: 'city',
    desc: `${MAP_LABEL} 真實香港地圖（CSDI／地政總署數據）上已有中環起步城鎮：道路、分區、唐樓公屋、街市與基本公共設施齊備，適合先學懂分區與需求。`,
    points: [
      `${MAP_LABEL} 真實香港地圖 · 預建中環起步城鎮`,
      '真實海岸線／地形（CSDI 地政總署 DTM 5m 數據）',
      '已有街市、學校、警署等公共設施，可直接擴建',
    ],
    stats: [
      ['起始庫房', formatMoneyShort(STARTER_TOWN.treasury)],
      ['目標人口', `${STARTER_TOWN.targetPopulation} 人`],
      ['地圖規模', MAP_LABEL],
    ],
  },
  {
    mode: 'empty',
    title: '由零開始',
    badge: '挑戰',
    icon: 'sprout',
    desc: `完全空地圖：冇道路、冇建築、冇任何預置設施；5 名市民＋${formatMoneyShort(START_TREASURY)}，由第一條路開始。地圖 ${MAP_LABEL}（約舊版 ${MAP_AREA_MULT} 倍面積）。`,
    points: [
      '完全空地：0 道路、0 建築、0 分區',
      '5 名市民、$800 萬起動資金',
      `地圖 ${MAP_LABEL}（約 ${num(MAP_CELLS)} 格，舊版 ${MAP_AREA_MULT} 倍面積）`,
    ],
    stats: [
      ['起始庫房', formatMoneyShort(START_TREASURY)],
      ['起始市民', '5 人'],
      ['地圖規模', MAP_LABEL],
    ],
  },
];

export function createStartScreen(
  container: HTMLElement,
  store: GameStore,
  actions: GameActions,
): StartScreenView {
  const mobile = getUiMode() === 'mobile';
  const root = document.createElement('div');
  root.className = 'start-screen';
  root.hidden = true;
  root.setAttribute('aria-label', '開局模式選擇');
  root.innerHTML = `
    <div class="ss-backdrop" aria-hidden="true"></div>
    <div class="ss-skyline" aria-hidden="true">
      <i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
    </div>
    <div class="ss-frame">
      <div class="ss-scroll">
      <header class="ss-head">
        <div class="ss-brand">
          <span class="ss-neon" aria-hidden="true"></span>
          <h1>維港之城</h1>
          <span class="ss-en">VICTORIA HARBOUR · CITY BUILDER</span>
        </div>
        <p class="ss-tagline">分區城市建造模擬 · 你劃地，開發商起樓，維港由你塑造</p>
        <span class="ss-map-tag">${MAP_LABEL} 大地圖 · 約 ${num(MAP_CELLS)} 格</span>
        <span class="ss-data-src">地圖數據：香港地理空間數據共享平台（CSDI）· 地政總署 DTM 5m／建築物輪廓</span>
      </header>

      <div class="ss-modes" role="radiogroup" aria-label="開局模式">
        ${MODES.map(
          (mode) => `
          <button type="button" class="ss-mode${mode.mode === 'starter' ? ' selected' : ''}"
            data-act="ss-mode" data-mode="${mode.mode}" role="radio" aria-checked="${mode.mode === 'starter'}">
            <span class="ss-mode-head">
              <span class="ss-mode-icon">${ico(mode.icon)}</span>
              <span class="ss-mode-title"><b>${mode.title}</b><em class="ss-badge">${mode.badge}</em></span>
              <span class="ss-radio" aria-hidden="true"></span>
            </span>
            <span class="ss-mode-desc">${mode.desc}</span>
            <span class="ss-mode-points">
              ${mode.points.map((point) => `<span><i aria-hidden="true">▸</i>${point}</span>`).join('')}
            </span>
            <span class="ss-mode-stats">
              ${mode.stats.map(([label, value]) => `<span><small>${label}</small><b>${esc(value)}</b></span>`).join('')}
            </span>
          </button>`,
        ).join('')}
      </div>

      <details class="ss-seed-row"${mobile ? '' : ' open'}>
        <summary class="ss-seed-summary">
          <span>地圖種子（選填）</span>
          <small>相同種子生成相同香港地圖</small>
        </summary>
        <div class="ss-seed-body">
          <label class="ss-seed-label" for="ss-seed-input">
            <span>地圖種子</span>
            <input id="ss-seed-input" type="text" inputmode="numeric" data-act="ss-seed" placeholder="留空＝隨機，例如 20260301" autocomplete="off" />
          </label>
          <button type="button" class="ss-dice" data-act="ss-dice" title="隨機種子">${ico('spark')}<span>隨機</span></button>
          <span class="ss-seed-hint">相同種子會生成相同的香港地圖</span>
        </div>
      </details>
      </div>

      <footer class="ss-foot">
        <p class="ss-note">${ico('info')}<span>已有城鎮適合第一次玩；由零開始適合想完全自由規劃的玩家。選擇後仍可隨時另起新局。</span></p>
        <button type="button" class="ss-start" data-act="ss-start">${ico('target')}<span class="ss-start-label">開始規劃</span><span class="ss-start-sub" data-k="ssModeLabel">已有城鎮</span></button>
      </footer>
    </div>
  `;
  container.appendChild(root);

  const $ = <T extends HTMLElement>(sel: string): T => qs<T>(root, sel)!;
  const modeButtons = Array.from(root.querySelectorAll<HTMLElement>('[data-act="ss-mode"]'));
  const seedInput = qs<HTMLInputElement>(root, '#ss-seed-input')!;
  const startBtn = $<HTMLButtonElement>('[data-act="ss-start"]');
  const modeLabel = $('[data-k="ssModeLabel"]');
  const seedHint = qs<HTMLElement>(root, '.ss-seed-hint')!;

  let selectedMode: NewGameMode = 'starter';
  let seedText = '';
  let pending = false;
  let pendingTimer = 0;
  let visible = false;

  const updateSel = (): void => {
    for (const btn of modeButtons) {
      const active = btn.dataset.mode === selectedMode;
      setClass(btn, 'selected', active);
      btn.setAttribute('aria-checked', String(active));
    }
    const def = MODES.find((m) => m.mode === selectedMode);
    setText(modeLabel, def ? `已選：${def.title}` : '');
  };

  const clearPending = (): void => {
    if (pendingTimer) window.clearTimeout(pendingTimer);
    pendingTimer = 0;
    pending = false;
    startBtn.disabled = false;
    startBtn.classList.remove('pending');
    setText(qs<HTMLElement>(startBtn, '.ss-start-label'), '開始規劃');
  };

  const start = (): void => {
    if (pending) return;
    const parsed = Number.parseInt(seedText.trim(), 10);
    const seed = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    pending = true;
    startBtn.disabled = true;
    startBtn.classList.add('pending');
    actions.startGame(selectedMode, seed);
    // 保險：若 Lead 的 startGame 沒有收起畫面，3 秒後解鎖
    pendingTimer = window.setTimeout(clearPending, 3000);
  };

  const offClick = delegate(root, 'click', '[data-act]', (node) => {
    switch (node.dataset.act) {
      case 'ss-mode': {
        const mode = node.dataset.mode as NewGameMode | undefined;
        if (mode !== 'starter' && mode !== 'empty') return;
        selectedMode = mode;
        updateSel();
        break;
      }
      case 'ss-dice': {
        seedText = String(Math.floor(Math.random() * 1_000_000_000));
        seedInput.value = seedText;
        break;
      }
      case 'ss-start':
        start();
        break;
      default:
        break;
    }
  });

  const offInput = delegate(root, 'input', '[data-act="ss-seed"]', (node) => {
    seedText = (node as HTMLInputElement).value;
    setHidden(seedHint, seedText.trim().length > 0);
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!visible) return;
    const tag = (event.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (event.code === 'Enter') start();
      return;
    }
    if (event.code === 'Enter') {
      event.preventDefault();
      start();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  const show = (): void => {
    visible = true;
    root.hidden = false;
    clearPending();
    updateSel();
    setHidden(seedHint, seedText.trim().length > 0);
    root.classList.add('show');
    document.getElementById('hud')?.classList.add('is-start-screen');
    if (getUiMode() === 'desktop') seedInput.focus({ preventScroll: true });
  };

  const hide = (): void => {
    if (!visible) return;
    visible = false;
    clearPending();
    root.classList.remove('show');
    root.hidden = true;
    document.getElementById('hud')?.classList.remove('is-start-screen');
  };

  const update = (state: GameState): void => {
    if (state.ui.showStartScreen) {
      if (!visible) show();
      // 起始畫面顯示時，若舊教學/面板仍在背景，不動 state（由 Lead 負責）
    } else if (visible) {
      hide();
    }
  };

  return {
    update,
    destroy(): void {
      offClick();
      offInput();
      window.removeEventListener('keydown', onKeyDown);
      clearPending();
      root.remove();
    },
  };
}
