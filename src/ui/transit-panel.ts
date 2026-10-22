/**
 * 交通面板：霓虹港風「香港交通」。
 *
 *  - 每日總載客、本月車費收入、平均通勤、整體交通覆蓋
 *  - 港鐵／巴士／電車／渡輪：站點數、覆蓋率、每日載客、載客率、票價、預計月收
 *  - 颱風停航提示（八號風球紅色閃爍）
 */

import {
  BUILDINGS,
  BUILDING_LIST,
  DAYS_PER_MONTH,
  MAP_LABELS,
  TRANSIT_INFO,
  TRANSIT_SPEED,
  WEATHER_INFO,
  formatMoney,
  formatMoneyShort,
} from '../core/config';
import type { GameActions, GameState, TransitMode, TransitState } from '../core/types';
import type { GameStore } from '../core/store';
import { esc, num, pct, ratioTone, setClass } from './dom';
import { formatMinutes } from './format';
import { ico, transitIcon } from './icons';
import { createOverlayHost, modalShell, restoreInfoPanel } from './overlay';

export interface TransitPanelView {
  update(state: GameState): void;
  destroy(): void;
}

const MODES: TransitMode[] = ['mtr', 'bus', 'tram', 'ferry'];

interface ModeStats {
  mode: TransitMode;
  stations: number;
  activeStations: number;
  coverage: number;
  ridership: number;
  capacity: number;
  fare: number;
  radius: number;
  monthlyFareEstimate: number;
}

/** 以住宅人口加權估算某模式的覆蓋率（與 transport-dev 的演算法方向一致） */
function modeCoverage(state: GameState, mode: TransitMode): number {
  const stationDef = BUILDING_LIST.find((def) => def.transit?.mode === mode)?.transit;
  const radius = stationDef?.radius ?? 0;
  const stations = state.buildings.filter((b) => BUILDINGS[b.key]?.transit?.mode === mode);
  if (!stations.length || radius <= 0) return 0;

  let total = 0;
  let covered = 0;
  for (const home of state.buildings) {
    const housing = BUILDINGS[home.key]?.housing ?? 0;
    if (housing <= 0 || home.residents.length === 0) continue;
    const residents = home.residents.length;
    total += residents;
    const hx = home.x + home.w / 2;
    const hy = home.y + home.h / 2;
    const inRange = stations.some((station) => {
      const sx = station.x + station.w / 2;
      const sy = station.y + station.h / 2;
      return Math.hypot(hx - sx, hy - sy) <= radius;
    });
    if (inRange) covered += residents;
  }
  return total > 0 ? covered / total : 0;
}

function collectModeStats(state: GameState, transit: TransitState): ModeStats[] {
  return MODES.map((mode) => {
    const info = TRANSIT_INFO[mode];
    const stations = state.buildings.filter((b) => BUILDINGS[b.key]?.transit?.mode === mode);
    const stationDef = BUILDING_LIST.find((def) => def.transit?.mode === mode)?.transit;
    const activeStations = stations.filter((b) => b.connected && b.active).length;
    const capacity = (stationDef?.capacity ?? 0) * stations.length;
    const ridership = transit.byMode?.[mode] ?? 0;
    const fare = stationDef?.fare ?? 0;
    return {
      mode,
      stations: stations.length,
      activeStations,
      coverage: modeCoverage(state, mode),
      ridership,
      capacity,
      fare,
      radius: stationDef?.radius ?? 0,
      monthlyFareEstimate: ridership * fare * DAYS_PER_MONTH,
    };
  });
}

function modeCard(stat: ModeStats, state: GameState): string {
  const info = TRANSIT_INFO[stat.mode];
  const load = stat.capacity > 0 ? Math.min(1.5, stat.ridership / stat.capacity) : 0;
  const loadPct = Math.round(load * 100);
  const tone = ratioTone(stat.coverage);
  const suspended =
    stat.mode === 'ferry' && (state.transit.suspended || state.clock.weather === 'storm');
  const empty = stat.stations === 0;

  return `
    <article class="transit-card${empty ? ' empty' : ''}${suspended ? ' suspended' : ''}" style="--mode:${info.color}">
      <header class="tc-head">
        <span class="tc-icon">${transitIcon(stat.mode)}</span>
        <div class="tc-title"><b>${esc(info.name)}</b><small>${esc(buildingName(stat.mode))}</small></div>
        <span class="tc-badge">${empty ? '未建設' : `${stat.stations} 站`}</span>
      </header>
      ${suspended ? `<div class="tc-alert">${ico('storm')}颱風停航 · 渡輪暫停服務</div>` : ''}
      <div class="tc-stats">
        <div class="tc-stat"><span>覆蓋率</span><b class="tone-${tone}">${pct(stat.coverage)}</b></div>
        <div class="tc-stat"><span>每日載客</span><b>${num(stat.ridership)}</b></div>
        <div class="tc-stat"><span>票價</span><b>$${stat.fare}</b></div>
        <div class="tc-stat"><span>服務半徑</span><b>${stat.radius} 格</b></div>
      </div>
      <div class="tc-load">
        <div class="tc-load-head"><span>載客率</span><b>${loadPct}%</b></div>
        <div class="metric-bar"><i class="tone-${loadPct > 90 ? 'bad' : loadPct > 65 ? 'ok' : 'good'}" style="width:${Math.min(100, loadPct)}%"></i></div>
      </div>
      <footer class="tc-foot">
        <span>運力 ${num(stat.capacity)}/日</span>
        <span>預計月收 ${formatMoneyShort(stat.monthlyFareEstimate)}</span>
        <span>每日 ${num(stat.ridership)} 人次</span>
      </footer>
    </article>
  `;
}

function buildingName(mode: TransitMode): string {
  return BUILDINGS[TRANSIT_INFO[mode].building]?.name ?? '';
}

/** 以最近的地圖標籤估算站點所在區（中環／旺角／沙田…） */
function districtOf(state: GameState, x: number, y: number): string {
  const nx = x / state.width;
  const ny = y / state.height;
  let best = '';
  let bestDist = Infinity;
  for (const label of MAP_LABELS) {
    if (label.kind === 'water') continue;
    const dist = Math.hypot(label.x - nx, label.y - ny);
    if (dist < bestDist) {
      bestDist = dist;
      best = label.name;
    }
  }
  return best || '維港';
}

export function createTransitPanel(container: HTMLElement, store: GameStore, actions: GameActions): TransitPanelView {
  const closeTransit = (): void => {
    store.state.ui.showTransit = false;
    restoreInfoPanel(store);
    store.bumpUI();
  };
  const host = createOverlayHost(container, actions, closeTransit);
  let lastSig = '';
  let lastWatermark = -1;

  const signature = (state: GameState): string => {
    const t = state.transit;
    return [
      Math.round(t.dailyRidership),
      Math.round(t.faresThisMonth),
      t.suspended ? 1 : 0,
      MODES.map((mode) => Math.round(t.byMode?.[mode] ?? 0)).join(','),
      Math.round(state.stats.transitCoverage * 1000),
      Math.round(state.stats.ridership),
      Math.round(state.stats.avgCommute),
      state.stats.typhoonSignal,
      state.clock.weather,
      state.buildings
        .filter((b) => BUILDINGS[b.key]?.transit)
        .map((b) => `${b.id}:${b.connected ? 1 : 0}:${b.active ? 1 : 0}`)
        .join(','),
      Math.round(state.clock.totalDays / 7),
    ].join('|');
  };

  const render = (state: GameState): void => {
    const t = state.transit;
    const stats = state.stats;
    const totalDaily = t.dailyRidership || stats.ridership || 0;
    const modes = collectModeStats(state, t);
    const totalStations = modes.reduce((sum, stat) => sum + stat.stations, 0);
    const typhoon = state.clock.weather === 'storm' || stats.typhoonSignal >= 8;
    const suspended = t.suspended || typhoon;

    const alert = suspended
      ? `<div class="tc-banner typhoon">${ico('storm')}<div><b>八號風球 · 公共交通停航</b><span>天星小輪暫停、戶外交通減速；市民多留家中。風球除下後自動恢復。</span></div></div>`
      : state.clock.weather === 'rain' || state.clock.weather === 'fog'
        ? `<div class="tc-banner weather">${ico('info')}<div><b>${WEATHER_INFO[state.clock.weather].name}天 · 交通減速</b><span>路面濕滑、能見度低，通勤時間會比平日長。</span></div></div>`
        : '';

    const totalModeRidership = MODES.reduce((sum, mode) => sum + (t.byMode?.[mode] ?? 0), 0) || 1;
    const modeShare = MODES.map((mode) => {
      const info = TRANSIT_INFO[mode];
      const value = t.byMode?.[mode] ?? 0;
      const share = value / totalModeRidership;
      return `
        <div class="mode-share-row" style="--mode:${info.color}">
          <span class="ms-name">${transitIcon(mode)} ${esc(info.name)}</span>
          <span class="ms-bar"><i style="width:${Math.max(1, Math.round(share * 100))}%"></i></span>
          <b>${Math.round(share * 100)}%</b>
          <em>${num(value)} 人次</em>
        </div>`;
    }).join('');

    const stationRows = state.buildings
      .filter((b) => BUILDINGS[b.key]?.transit)
      .sort((a, b) => (BUILDINGS[a.key]?.transit?.mode ?? '').localeCompare(BUILDINGS[b.key]?.transit?.mode ?? ''))
      .map((b) => {
        const def = BUILDINGS[b.key];
        const transitDef = def.transit!;
        const info = TRANSIT_INFO[transitDef.mode];
        const ferrySuspended =
          transitDef.mode === 'ferry' && (t.suspended || state.clock.weather === 'storm');
        const status = ferrySuspended
          ? { label: '停航', tone: 'bad' }
          : !b.connected
            ? { label: '未連路', tone: 'bad' }
            : b.active
              ? { label: '正常', tone: 'ok' }
              : { label: '停用', tone: 'warn' };
        return `<button type="button" class="station-row" data-act="select-station" data-id="${b.id}" style="--mode:${info.color}" title="點擊在地圖上選中此站">
          <span class="st-ico">${transitIcon(transitDef.mode)}</span>
          <span class="st-name">${esc(def.name)}</span>
          <span class="st-zone">${esc(districtOf(state, b.x + b.w / 2, b.y + b.h / 2))}</span>
          <span>半徑 ${transitDef.radius} 格</span>
          <span>容量 ${num(transitDef.capacity)}</span>
          <span>$${transitDef.fare} 車費</span>
          <span class="st-status ${status.tone}">${status.label}</span>
        </button>`;
      })
      .join('');

    const body = `
      <div class="transit-hero">
        <div class="tr-hero-main">
          <span class="fin-label">每日公共交通載客</span>
          <b class="fin-amount">${num(totalDaily)} <small>人次</small></b>
          <span class="fin-sub">全港 ${num(totalStations)} 個公共交通站點 · 平均通勤 ${formatMinutes(stats.avgCommute)}</span>
        </div>
        <div class="tr-cards">
          <div class="fin-card"><span>本月車費收入</span><b class="positive">${formatMoney(t.faresThisMonth)}</b></div>
          <div class="fin-card"><span>交通覆蓋率</span><b class="tone-${ratioTone(stats.transitCoverage)}">${pct(stats.transitCoverage)}</b></div>
          <div class="fin-card"><span>颱風信號</span><b class="${typhoon ? 'negative' : ''}">${typhoon ? `${Math.max(8, stats.typhoonSignal)} 號風球` : '無'}</b></div>
        </div>
      </div>
      ${alert}

      <div class="fin-block" style="margin-top:10px">
        <div class="block-head"><h3>${ico('chart')}模式分擔</h3><span class="mini">今日載客</span></div>
        <div class="mode-share">${modeShare}</div>
      </div>

      <div class="transit-grid">
        ${modes.map((stat) => modeCard(stat, state)).join('')}
      </div>
      <div class="fin-block">
        <div class="block-head"><h3>${ico('mtr')}站點列表</h3><span class="mini">點擊站點可在地圖選中</span></div>
        <div class="station-list">${
          stationRows ||
          '<div class="station-empty">尚未興建任何公共交通站點；在「建造 → 交通」興建港鐵站、巴士總站、電車站或渡輪碼頭。</div>'
        }</div>
      </div>

      <div class="fin-block">
        <div class="block-head"><h3>${ico('compass')}通勤方式</h3><span class="mini">市民按住所與工作地點選擇最快路線</span></div>
        <div class="transit-speeds">
          ${(
            [
              ['mtr', '港鐵', TRANSIT_SPEED.mtr],
              ['bus', '巴士', TRANSIT_SPEED.bus],
              ['tram', '電車', TRANSIT_SPEED.tram],
              ['ferry', '渡輪', TRANSIT_SPEED.ferry],
              ['walk', '步行', TRANSIT_SPEED.walk],
            ] as [TransitMode | 'walk', string, number][]
          )
            .map(
              ([mode, name, speed]) =>
                `<div class="speed-chip" style="--mode:${mode === 'walk' ? '#9fb3c8' : TRANSIT_INFO[mode].color}">
                  <span>${mode === 'walk' ? '🚶' : transitIcon(mode)} ${name}</span>
                  <b>×${speed.toFixed(1)}</b>
                </div>`,
            )
            .join('')}
        </div>
        <p class="hint">港鐵速度最快，巴士與電車覆蓋街區；渡輪跨維港兩岸但颱風停航。覆蓋率以住宅人口加權估算。</p>
      </div>
      <p class="modal-foot-note">${ico('info')}數據由交通系統每日結算：站點愈多、覆蓋愈廣，市民通勤時間愈短，車費收入亦愈高。</p>
    `;

    host.show(
      modalShell({
        key: 'transit',
        badge: '通',
        title: '香港交通',
        subtitle: '港鐵 · 巴士 · 電車 · 渡輪',
        body,
      }),
    );
  };

  const update = (state: GameState): void => {
    if (!state.ui.showTransit) {
      host.hide();
      lastSig = '';
      return;
    }
    const sig = signature(state);
    if (sig !== lastSig) {
      lastSig = sig;
      render(state);
    }
    // 颱風時 banner 閃爍（只切一次 class，避免每幀重繪）
    const wm = state.transit.suspended ? 1 : 0;
    if (wm !== lastWatermark) {
      lastWatermark = wm;
      const banner = host.layer.querySelector('.tc-banner.typhoon');
      if (banner) setClass(banner, 'blink', wm > 0);
    }
  };

  return {
    update,
    destroy(): void {
      host.destroy();
    },
  };
}
