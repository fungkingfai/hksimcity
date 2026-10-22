/**
 * 頂欄：霓虹港風 HUD 的門面。
 *
 * 由左至右：城市霓虹招牌「維港之城」、香港日期＋時鐘＋天氣＋天文台警告、
 * 人口／庫房／幸福度、暫停與 0–3 倍速、建造／城事／財政／交通／存檔／說明按鈕。
 *
 * update() 每幀呼叫；所有欄位都以「上次值」比對後才寫入 DOM。
 */

import { SEASON_INFO, WEATHER_INFO, formatMoneyShort } from '../core/config';
import type { GameActions, GameState } from '../core/types';
import type { GameStore } from '../core/store';
import { getUiMode } from '../core/device';
import { delegate, happinessTone, num, qs, setClass, setText } from './dom';
import { formatClockHK, formatDateCompactHK, formatDateHK } from './format';
import { ico } from './icons';

export interface TopbarView {
  update(state: GameState): void;
  destroy(): void;
}

/** 天氣 emoji 對照（與 config 一致，但保留 fallback） */
const WX_EMOJI: Record<string, string> = {
  clear: '☀',
  cloudy: '☁',
  rain: '🌧',
  storm: '🌀',
  fog: '🌫',
  snow: '❄',
};

type WarnLevel = 'sig8' | 'sig3' | 'sig1' | 'blackrain' | 'rain' | 'hot' | 'cold' | 'fog' | 'other';

interface WarnInfo {
  level: WarnLevel;
  title: string;
  effects: string;
  icon: string;
  dismissible: boolean;
}

/** 由天文台警告文字＋天氣／風球推算橫幅內容 */
function resolveWarning(state: GameState): WarnInfo | null {
  const { clock, stats } = state;
  const text = clock.warning ?? '';
  const signal = Math.max(clock.weather === 'storm' ? 8 : 0, stats.typhoonSignal ?? 0);

  if (signal >= 8) {
    return {
      level: 'sig8',
      title: text || '八號烈風或暴風信號',
      effects: '停工停課 · 渡輪停航 · 電車停駛 · 貨運受阻',
      icon: '🌀',
      dismissible: false,
    };
  }
  if (signal === 3) {
    return {
      level: 'sig3',
      title: text || '三號強風信號',
      effects: '學校停課 · 渡輪減班 · 戶外工程放緩',
      icon: '💨',
      dismissible: false,
    };
  }
  if (signal === 1) {
    return {
      level: 'sig1',
      title: text || '一號戒備信號',
      effects: '熱帶氣旋接近 · 請留意天氣',
      icon: '🌬',
      dismissible: true,
    };
  }
  if (/黑.*雨/.test(text)) {
    return { level: 'blackrain', title: text, effects: '部分道路水浸 · 物流受阻', icon: '⛈', dismissible: true };
  }
  if (/暴雨/.test(text) || (clock.weather === 'rain' && text)) {
    return { level: 'rain', title: text || '暴雨警告', effects: '路面濕滑 · 行車與行人放慢', icon: '🌧', dismissible: true };
  }
  if (/酷熱/.test(text)) {
    return { level: 'hot', title: text, effects: '注意補水 · 用電高峰期', icon: '🥵', dismissible: true };
  }
  if (/寒冷/.test(text) || clock.weather === 'snow') {
    return { level: 'cold', title: text || '寒冷天氣警告', effects: '關顧長者 · 注意保暖', icon: '🥶', dismissible: true };
  }
  if (/霧/.test(text) || clock.weather === 'fog') {
    return { level: 'fog', title: text || '大霧警告', effects: '渡輪或停航 · 能見度低', icon: '🌫', dismissible: true };
  }
  if (text) {
    return { level: 'other', title: text, effects: WEATHER_INFO[clock.weather]?.hint ?? '', icon: '⚠', dismissible: true };
  }
  return null;
}

export function createTopbar(container: HTMLElement, store: GameStore, actions: GameActions): TopbarView {
  const mobileUi = getUiMode() === 'mobile';
  const root = document.createElement('header');
  root.className = 'topbar';
  root.innerHTML = `
    <div class="topbar-inner">
      <div class="tb-brand">
        <span class="brand-neon" aria-hidden="true"></span>
        <div class="brand-text">
          <b class="city-name" data-k="cityName">維港之城</b>
          <span class="brand-en">VICTORIA HARBOUR</span>
        </div>
        <span class="brand-tag" title="香港城市建造模擬">香港 · 城市建造</span>
      </div>

      <div class="tb-clock">
        <div class="tb-date">
          <span class="season-chip" data-k="season" title="季節">春</span>
          <b data-k="dateText">2026年3月1日 星期日</b>
          <span class="chip-time">${ico('clock')}<b data-k="time">06:00</b></span>
        </div>
        <div class="tb-weather">
          <button type="button" class="chip-weather wx-clear" data-k="weather" title="天氣">
            <span class="wx-ico" data-k="wxIcon">☀</span>
            <b data-k="wxName">晴</b>
            <em data-k="temp">23°C</em>
          </button>
          <button type="button" class="chip-warning" data-k="warning" data-act="warning-open" hidden title="天文台警告（點擊查看詳情）">
            <span class="warn-pulse" aria-hidden="true"></span>
            <span data-k="warningText"></span>
          </button>
        </div>
      </div>

      <div class="tb-stats">
        <div class="stat-pill" title="城市人口">
          <span class="pill-ico">${ico('people')}</span>
          <span class="pill-body"><span class="pill-label">人口</span><b class="pill-value" data-k="pop">0</b></span>
        </div>
        <div class="stat-pill treasury" data-k="moneyPill" title="庫房（港幣）">
          <span class="pill-ico">${ico('coin')}</span>
          <span class="pill-body"><span class="pill-label">庫房</span><b class="pill-value" data-k="money">$0</b></span>
          <span class="pill-spark" data-k="moneyTrend" aria-hidden="true"></span>
        </div>
        <div class="stat-pill happiness" data-k="happyPill" title="幸福度（0–100）">
          <span class="pill-ico">${ico('heart')}</span>
          <span class="pill-body"><span class="pill-label">幸福度</span><b class="pill-value" data-k="happy">70</b></span>
          <span class="happy-meter"><i data-k="happyBar"></i></span>
        </div>
      </div>

      <div class="tb-controls">
        <div class="speed-group" role="group" aria-label="遊戲速度">
          <button type="button" data-act="speed" data-speed="0" title="暫停（空白鍵）">${ico('pause')}</button>
          <button type="button" data-act="speed" data-speed="1" title="正常速度（1）">${ico('play1')}</button>
          <button type="button" data-act="speed" data-speed="2" title="二倍速（2）">${ico('play2')}</button>
          <button type="button" data-act="speed" data-speed="3" title="三倍速（3）">${ico('play3')}</button>
        </div>
        <button type="button" class="zone-view-btn" data-act="toggle-zones" title="顯示／隱藏分區色塊（L）" aria-label="顯示分區色塊">${ico('layers')}</button>
        <span class="pause-flag" data-k="pauseFlag" aria-live="polite">暫停</span>
      </div>

      <nav class="tb-actions" aria-label="功能面板">
        <button type="button" class="top-btn" data-act="toggle-build" title="建造面板（B）">${ico('hammer')}<span>建造</span></button>
        <button type="button" class="top-btn" data-act="stats" title="城事（J）">${ico('stats')}<span>城事</span></button>
        <button type="button" class="top-btn" data-act="finance" title="財政（F）">${ico('chart')}<span>財政</span></button>
        <button type="button" class="top-btn" data-act="transit" title="交通（T）">${ico('mtr')}<span>交通</span></button>
        <button type="button" class="top-btn" data-act="save" title="存檔">${ico('scroll')}<span>存檔</span></button>
        <button type="button" class="top-btn" data-act="help" title="說明（H）">${ico('book')}<span>說明</span></button>
      </nav>
    </div>
    <div class="topbar-trim" aria-hidden="true"></div>

    <div class="warning-banner" data-k="warningBanner" role="status" hidden>
      <span class="wb-pulse" aria-hidden="true"></span>
      <span class="wb-icon" data-k="wbIcon">🌀</span>
      <div class="wb-text">
        <b data-k="wbTitle"></b>
        <span data-k="wbEffects"></span>
      </div>
      <span class="wb-timer" data-k="wbTimer"></span>
      <button type="button" class="wb-close" data-act="dismiss-warning" title="收起警告" aria-label="收起警告">${ico('close')}</button>
    </div>

    <div class="typhoon-alert" data-k="typhoonAlert" hidden>
      <div class="ta-box" role="alertdialog" aria-label="八號風球警示">
        <span class="ta-icon" aria-hidden="true">🌀</span>
        <h2>八號烈風或暴風信號</h2>
        <p>天文台已發出八號風球。全港停工停課：渡輪停航、電車停駛、貨運受阻，地盤停止施工。</p>
        <ul>
          <li>碼頭裝卸暫停，街市與超市補貨變慢</li>
          <li>市民多留家中，通勤人次大減</li>
          <li>建議先存檔，待風球除下再繼續發展城市</li>
        </ul>
        <button type="button" class="primary" data-act="dismiss-typhoon-alert">知道了</button>
      </div>
    </div>
  `;
  container.appendChild(root);
  const hud = root.parentElement;

  const $ = <T extends HTMLElement>(sel: string): T => qs<T>(root, sel)!;

  const cityNameEl = $('[data-k="cityName"]');
  const seasonEl = $('[data-k="season"]');
  const dateTextEl = $('[data-k="dateText"]');
  const timeEl = $('[data-k="time"]');
  const weatherBtn = $('[data-k="weather"]');
  const wxIconEl = $('[data-k="wxIcon"]');
  const wxNameEl = $('[data-k="wxName"]');
  const tempEl = $('[data-k="temp"]');
  const warningBtn = $('[data-k="warning"]');
  const warningTextEl = $('[data-k="warningText"]');
  const moneyPill = $('[data-k="moneyPill"]');
  const moneyEl = $('[data-k="money"]');
  const popEl = $('[data-k="pop"]');
  const happyPill = $('[data-k="happyPill"]');
  const happyEl = $('[data-k="happy"]');
  const happyBar = $('[data-k="happyBar"]');
  const pauseFlag = $('[data-k="pauseFlag"]');
  const zoneViewBtn = $('[data-act="toggle-zones"]');
  const speedButtons = Array.from(root.querySelectorAll<HTMLElement>('[data-act="speed"]'));
  const panelButtons: { act: string; node: HTMLElement }[] = [
    { act: 'stats', node: $('[data-act="stats"]') },
    { act: 'finance', node: $('[data-act="finance"]') },
    { act: 'transit', node: $('[data-act="transit"]') },
    { act: 'save', node: $('[data-act="save"]') },
    { act: 'help', node: $('[data-act="help"]') },
  ];
  const banner = $('[data-k="warningBanner"]');
  const wbIcon = $('[data-k="wbIcon"]');
  const wbTitle = $('[data-k="wbTitle"]');
  const wbEffects = $('[data-k="wbEffects"]');
  const wbTimer = $('[data-k="wbTimer"]');
  const wbClose = $('[data-act="dismiss-warning"]');
  const typhoonAlert = $('[data-k="typhoonAlert"]');

  let dismissedKey = '';
  let typhoonAlertShown = false;

  const offClick = delegate(root, 'click', '[data-act]', (node) => {
    switch (node.dataset.act) {
      case 'speed':
        actions.setSpeed(Number(node.dataset.speed ?? 1));
        break;
      case 'stats':
        actions.toggleStats();
        break;
      case 'finance':
        actions.toggleFinance();
        break;
      case 'transit':
        actions.toggleTransit();
        break;
      case 'save':
        actions.toggleSavePanel();
        break;
      case 'help':
        actions.toggleHelp();
        break;
      case 'toggle-zones':
        actions.toggleZones();
        break;
      case 'warning-open':
        dismissedKey = '';
        lastBannerKey = '';
        break;
      case 'dismiss-warning':
        dismissedKey = warningBtn.dataset.warnKey ?? '';
        banner.hidden = true;
        hud?.classList.remove('has-warning');
        break;
      case 'dismiss-typhoon-alert':
        typhoonAlert.hidden = true;
        break;
      default:
        break; // 'toggle-build' 交由 ui.ts 處理
    }
  });

  // ── 快取上次值，避免每幀寫 DOM ──
  let lastCity = '';
  let lastDateKey = '';
  let lastTimeKey = '';
  let lastWeatherKey = '';
  let lastWarningKey = '';
  let lastMoney = Number.NaN;
  let lastPop = Number.NaN;
  let lastHappy = Number.NaN;
  let lastTone = '';
  let lastSpeed = -1;
  let lastPaused: boolean | null = null;
  let lastPanelKey = '';
  let lastWarningKey2 = '';
  let lastBannerKey = '';
  let lastTyphoon = false;

  const update = (state: GameState): void => {
    const clock = state.clock;
    const season = SEASON_INFO[clock.season];
    const weather = WEATHER_INFO[clock.weather];

    if (state.cityName !== lastCity) {
      lastCity = state.cityName;
      setText(cityNameEl, state.cityName || '維港之城');
    }

    const dateKey = `${clock.year}|${clock.month}|${clock.day}|${clock.weekday}|${clock.season}`;
    if (dateKey !== lastDateKey) {
      lastDateKey = dateKey;
      setText(seasonEl, season?.emoji ?? '');
      setText(dateTextEl, mobileUi ? formatDateCompactHK(clock) : formatDateHK(clock));
      dateTextEl.title = formatDateHK(clock);
      seasonEl.title = `${season?.name ?? ''}季（${season?.months ?? ''}）`;
    }

    const timeKey = `${clock.hour}|${clock.minute}`;
    if (timeKey !== lastTimeKey) {
      lastTimeKey = timeKey;
      setText(timeEl, formatClockHK(clock.hour, clock.minute));
    }

    const temp = Math.round(clock.tempC);
    const weatherKey = `${clock.weather}|${temp}`;
    if (weatherKey !== lastWeatherKey) {
      lastWeatherKey = weatherKey;
      const emoji = WX_EMOJI[clock.weather] ?? weather?.emoji ?? '☀';
      wxIconEl.textContent = emoji;
      setText(wxNameEl, weather?.name ?? '');
      setText(tempEl, `${temp}°C`);
      weatherBtn.className = `chip-weather wx-${clock.weather}`;
      weatherBtn.title = `${weather?.name ?? ''}：${weather?.hint ?? ''}`;
    }

    // ── 天文台警告：頂欄 chip + 全寬橫幅 ──
    const warn = resolveWarning(state);
    const typhoon = warn?.level === 'sig8';
    const warningKey = warn ? `${warn.level}|${warn.title}` : '';
    if (warningKey !== lastWarningKey) {
      lastWarningKey = warningKey;
      if (warn) {
        warningBtn.hidden = false;
        setText(warningTextEl, warn.title);
        setClass(warningBtn, 'is-typhoon', warn.level === 'sig8');
        setClass(warningBtn, 'is-severe', warn.level === 'sig8' || warn.level === 'sig3');
        warningBtn.dataset.warnKey = warningKey;
        warningBtn.title = `${warn.title}｜${warn.effects}`;
      } else {
        warningBtn.hidden = true;
      }
    }
    if (warningKey !== lastWarningKey2) {
      lastWarningKey2 = warningKey;
      // 警告內容改變時重置「已收起」狀態
      if (dismissedKey && dismissedKey !== warningKey) dismissedKey = '';
    }
    if (typhoon !== lastTyphoon) {
      lastTyphoon = typhoon;
      setClass(root, 'is-typhoon', typhoon);
      // 首次踏入八號風球：全屏警示（每次風球除下後可再彈）
      if (typhoon && !typhoonAlertShown) {
        typhoonAlertShown = true;
        typhoonAlert.hidden = false;
      }
      if (!typhoon) {
        typhoonAlertShown = false;
        typhoonAlert.hidden = true;
      }
    }

    const bannerKey = warn ? `${warningKey}|${Math.round(clock.weatherMinutesLeft / 30)}` : '';
    if (bannerKey !== lastBannerKey) {
      lastBannerKey = bannerKey;
      const dismissed = Boolean(warn && dismissedKey === warningKey);
      if (warn && (!dismissed || warn.level === 'sig8')) {
        banner.hidden = false;
        hud?.classList.add('has-warning');
        banner.className = `warning-banner level-${warn.level}`;
        wbIcon.textContent = warn.icon;
        setText(wbTitle, warn.title);
        setText(wbEffects, warn.effects);
        const total = clock.minutes + Math.max(0, clock.weatherMinutesLeft);
        const hh = Math.floor((total % 1440) / 60);
        const mm = Math.floor(total % 60);
        setText(wbTimer, `預計持續至 ${formatClockHK(hh, mm)}`);
        wbClose.hidden = !warn.dismissible;
      } else {
        banner.hidden = true;
        hud?.classList.remove('has-warning');
      }
    }

    const money = Math.round(state.finance.treasury);
    if (money !== lastMoney) {
      lastMoney = money;
      setText(moneyEl, formatMoneyShort(state.finance.treasury));
      setClass(moneyPill, 'negative', state.finance.treasury < 0);
      moneyPill.title = `庫房：${state.finance.treasury.toLocaleString('zh-HK')} 港元`;
    }

    const pop = state.stats.population;
    if (pop !== lastPop) {
      lastPop = pop;
      setText(popEl, num(pop));
    }

    const happy = Math.round(state.stats.happiness);
    const tone = happinessTone(happy);
    if (happy !== lastHappy || tone !== lastTone) {
      lastHappy = happy;
      lastTone = tone;
      setText(happyEl, String(happy));
      setClass(happyPill, 'good', tone === 'good');
      setClass(happyPill, 'bad', tone === 'bad');
      happyPill.title = `幸福度 ${happy}/100 — 受住房、就業、食品、公用設施、交通、稅率與天氣影響`;
      happyBar.style.width = `${Math.max(3, Math.min(100, happy))}%`;
    }

    const activeSpeed = clock.paused ? 0 : clock.speed;
    if (activeSpeed !== lastSpeed) {
      lastSpeed = activeSpeed;
      for (const btn of speedButtons) setClass(btn, 'active', Number(btn.dataset.speed) === activeSpeed);
    }
    if (clock.paused !== lastPaused) {
      lastPaused = clock.paused;
      setClass(root, 'is-paused', clock.paused);
      pauseFlag.classList.toggle('show', clock.paused);
    }

    const ui = state.ui;
    const panelKey = `${ui.showStats}|${ui.showFinance}|${ui.showTransit}|${ui.showSave}|${ui.showHelp}|${ui.showTutorial}`;
    if (panelKey !== lastPanelKey) {
      lastPanelKey = panelKey;
      for (const btn of panelButtons) {
        const active =
          btn.act === 'stats'
            ? ui.showStats
            : btn.act === 'finance'
              ? ui.showFinance
              : btn.act === 'transit'
                ? ui.showTransit
                : btn.act === 'save'
                  ? ui.showSave
                  : ui.showHelp || ui.showTutorial;
        setClass(btn.node, 'active', active);
      }
    }
    setClass(zoneViewBtn, 'active', ui.showZones);
  };

  return {
    update,
    destroy(): void {
      offClick();
      root.remove();
    },
  };
}
