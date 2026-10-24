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
  TRANSIT_LINE_CONFIG,
  TRANSIT_SPEED,
  WEATHER_INFO,
  formatMoney,
  formatMoneyShort,
} from '../core/config';
import type {
  GameActions,
  GameState,
  TransitLine,
  TransitLineMode,
  TransitMode,
  TransitState,
} from '../core/types';
import type { GameStore } from '../core/store';
import { delegate, esc, num, pct, ratioTone, setClass } from './dom';
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

function modeCard(stat: ModeStats, state: GameState, lineCount = 0): string {
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
        ${stat.mode === 'bus' ? `<span>玩家路線 ${lineCount} 條</span>` : ''}
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
  /** 建線草稿選項（本地，main 只存 mode＋stopIds） */
  let draftOptions = { vehicleCount: 2, fare: 6, loop: false };

  const CLEAR_DRAFT = (state: GameState): void => {
    state.ui.lineEditorActive = false;
    state.ui.lineDraft = null;
    store.bumpUI();
  };

  const lineProfit = (line: TransitLine): { revenue: number; cost: number; profit: number } => {
    const revenue = Math.round(line.ridershipToday * line.fare);
    const cost = line.vehicleCount * TRANSIT_LINE_CONFIG.dailyCostPerVehicle[line.mode];
    return { revenue, cost, profit: revenue - cost };
  };

  const lineModeLabel = (mode: TransitLineMode): string => (mode === 'bus' ? '巴士' : '小巴');

  const eligibleStops = (state: GameState, mode: TransitLineMode) =>
    state.buildings.filter((b) =>
      mode === 'bus' ? b.key === 'busStop' || b.key === 'busTerminus' : b.key === 'minibusStop' || b.key === 'minibusDepot',
    );

  const startEditor = (state: GameState, mode: TransitLineMode): void => {
    draftOptions = { vehicleCount: 2, fare: mode === 'bus' ? 6 : 4, loop: false };
    if (typeof actions.beginLineEditor === 'function') {
      // main 會驗證車廠／站點、set tool='line-select'、開 transit panel
      actions.beginLineEditor(mode);
      store.bumpUI();
      return;
    }
    // fallback：main 未接 action 時，UI 自己建立草稿
    store.state.ui.lineEditorActive = true;
    store.state.ui.lineDraft = { mode, stopIds: [] };
    store.state.ui.showTransit = true;
    store.state.ui.selectedLineId = null;
    store.bumpUI();
  };

  const toggleDraftStop = (state: GameState, id: number): void => {
    if (typeof actions.toggleLineStop === 'function') {
      actions.toggleLineStop(id);
      return;
    }
    const draft = state.ui.lineDraft;
    if (!draft) return;
    const idx = draft.stopIds.indexOf(id);
    if (idx >= 0) {
      draft.stopIds.splice(idx, 1);
    } else {
      if (draft.stopIds.length >= TRANSIT_LINE_CONFIG.maxStops) {
        store.toast(`最多 ${TRANSIT_LINE_CONFIG.maxStops} 個站`, 'warn');
        return;
      }
      draft.stopIds.push(id);
    }
    store.bumpUI();
  };

  const finishEditor = (state: GameState): void => {
    const draft = state.ui.lineDraft;
    if (!draft) return;
    const stops = draft.stopIds;
    if (stops.length < 2) {
      store.toast('路線最少需要 2 個站', 'warn');
      return;
    }
    const hasDepot = state.buildings.some(
      (b) => stops.includes(b.id) && (draft.mode === 'bus' ? b.key === 'busTerminus' : b.key === 'minibusDepot'),
    );
    if (!hasDepot) {
      store.toast(draft.mode === 'bus' ? '巴士線需要至少 1 座巴士總站' : '小巴線需要至少 1 座小巴車廠', 'warn');
      return;
    }
    const cfg = TRANSIT_LINE_CONFIG;
    const vehicleCount = Math.min(cfg.vehicleMax, Math.max(cfg.vehicleMin, draftOptions.vehicleCount));
    const fare = Math.min(cfg.fareMax, Math.max(cfg.fareMin, draftOptions.fare));
    const color = cfg.colors[(state.transitLines?.length ?? 0) % cfg.colors.length];
    const name = `${lineModeLabel(draft.mode)} ${(state.transitLines?.length ?? 0) + 1} 號線`;
    const input = {
      mode: draft.mode,
      stopIds: [...stops],
      loop: draftOptions.loop,
      vehicleCount,
      fare,
      name,
      color,
    };

    if (typeof actions.createTransitLine === 'function') {
      const result = actions.createTransitLine(input);
      if (!result.ok) {
        store.toast(result.reason ?? '建立路線失敗', 'warn');
        return;
      }
      CLEAR_DRAFT(state);
      store.toast(`已建立「${name}」`, 'info');
      return;
    }
    // fallback：main 未接 createTransitLine 時，UI 直接寫入路線（示範可用）
    const cost = cfg.vehicleCost[draft.mode] * vehicleCount + cfg.openFee;
    if (state.finance.treasury < cost) {
      store.toast(`庫房不足：開線需要 ${formatMoneyShort(cost)}`, 'warn');
      return;
    }
    state.finance.treasury -= cost;
    state.transitLines = state.transitLines ?? [];
    const id = state.nextTransitLineId ?? state.transitLines.length + 1;
    state.nextTransitLineId = id + 1;
    const line: TransitLine = {
      id,
      mode: draft.mode,
      name,
      color,
      stopIds: [...stops],
      loop: false,
      vehicleCount,
      fare,
      createdDay: state.clock.totalDays,
      ridershipToday: 0,
      faresThisMonth: 0,
      lastMonthRidership: 0,
    };
    state.transitLines.push(line);
    state.ui.selectedLineId = id;
    CLEAR_DRAFT(state);
    store.toast(`（示範）已建立「${name}」，開線費 ${formatMoneyShort(cost)}；main 接駁後會改用正式結算`, 'info');
  };

  const updateLine = (state: GameState, id: number, patch: Partial<TransitLine>): void => {
    if (typeof actions.updateTransitLine === 'function') {
      const result = actions.updateTransitLine(id, patch);
      if (!result.ok) store.toast(result.reason ?? '更新路線失敗', 'warn');
      return;
    }
    const line = (state.transitLines ?? []).find((entry) => entry.id === id);
    if (!line) return;
    Object.assign(line, patch);
    store.bumpUI();
  };

  const renderRoutes = (state: GameState): string => {
    const lines = state.transitLines ?? [];
    const busCount = lines.filter((line) => line.mode === 'bus').length;
    const miniCount = lines.length - busCount;
    const selectedId = state.ui.selectedLineId ?? null;
    const selected = lines.find((line) => line.id === selectedId);
    const draft = state.ui.lineEditorActive ? state.ui.lineDraft ?? null : null;

    const lineRows = lines
      .map((line) => {
        const stats = lineProfit(line);
        const profitTone = stats.profit >= 0 ? 'positive' : 'negative';
        const suspended = line.suspended ? '<span class="line-badge suspended">停駛</span>' : '';
        return `
          <div class="line-row${line.id === selectedId ? ' selected' : ''}" data-id="${line.id}">
            <span class="line-color" style="--line:${line.color}"></span>
            <span class="line-main">
              <b>${esc(line.name)}${suspended}</b>
              <small>${lineModeLabel(line.mode)} · ${line.stopIds.length} 站 · ${line.vehicleCount} 車 · $${line.fare} 票價</small>
            </span>
            <span class="line-stat"><small>今日載客</small><b>${num(line.ridershipToday)}</b></span>
            <span class="line-stat"><small>今日淨收入</small><b class="${profitTone}">${stats.profit >= 0 ? '+' : ''}${formatMoneyShort(stats.profit)}</b></span>
            <button type="button" class="line-edit" data-act="route-select" data-id="${line.id}">${line.id === selectedId ? '收起' : '編輯'}</button>
          </div>`;
      })
      .join('');

    const detail = selected
      ? `
        <div class="line-detail" data-id="${selected.id}">
          <div class="line-detail-head">
            <b>${ico('route')}${esc(selected.name)}</b>
            <span class="mini">上月載客 ${num(selected.lastMonthRidership)} · 本月車費 ${formatMoney(selected.faresThisMonth)}</span>
          </div>
          <div class="line-fields">
            <label>名稱<input type="text" data-line-field="name" data-id="${selected.id}" value="${esc(selected.name)}" maxlength="24"></label>
            <label>車數 <b data-k="line-vehicles">${selected.vehicleCount}</b><input type="range" min="${TRANSIT_LINE_CONFIG.vehicleMin}" max="${TRANSIT_LINE_CONFIG.vehicleMax}" value="${selected.vehicleCount}" data-line-field="vehicleCount" data-id="${selected.id}"></label>
            <label>票價 <b data-k="line-fare">$${selected.fare}</b><input type="range" min="${TRANSIT_LINE_CONFIG.fareMin}" max="${TRANSIT_LINE_CONFIG.fareMax}" value="${selected.fare}" data-line-field="fare" data-id="${selected.id}"></label>
            <label class="line-check"><input type="checkbox" data-line-field="loop" data-id="${selected.id}" ${selected.loop ? 'checked' : ''}> 循環線</label>
            <label>路線顏色<input type="color" data-line-field="color" data-id="${selected.id}" value="${selected.color}"></label>
          </div>
          <div class="line-actions">
            <button type="button" data-act="route-suspend" data-id="${selected.id}">${selected.suspended ? '重開路線' : '暫停路線'}</button>
            <button type="button" class="danger" data-act="route-delete" data-id="${selected.id}">刪除路線</button>
          </div>
        </div>`
      : '';

    const draftStops = draft
      ? draft.stopIds
          .map((id, idx) => {
            const building = state.buildings.find((b) => b.id === id);
            return `<span class="draft-stop"><b>${idx + 1}</b>${esc(building ? BUILDINGS[building.key]?.name ?? `#${id}` : `#${id}`)}</span>`;
          })
          .join('')
      : '';

    const stopChoices = draft
      ? eligibleStops(state, draft.mode)
          .map((building) => {
            const idx = draft.stopIds.indexOf(building.id);
            const selectedStop = idx >= 0;
            const isDepot = draft.mode === 'bus' ? building.key === 'busTerminus' : building.key === 'minibusDepot';
            return `<button type="button" class="draft-choice${selectedStop ? ' selected' : ''}" data-act="route-stop" data-id="${building.id}" ${building.connected && building.active ? '' : 'title="此站未連路／停用"'}>
              <b>${selectedStop ? idx + 1 : '+'}</b>${esc(BUILDINGS[building.key]?.name ?? building.key)}${isDepot ? ' · 總站' : ''}
            </button>`;
          })
          .join('')
      : '';

    const hasDepot = draft
      ? draft.stopIds.some((id) => {
          const b = state.buildings.find((entry) => entry.id === id);
          return draft.mode === 'bus' ? b?.key === 'busTerminus' : b?.key === 'minibusDepot';
        })
      : false;
    const canFinish = Boolean(draft && draft.stopIds.length >= 2 && hasDepot);

    const editor = draft
      ? `
        <div class="line-editor">
          <div class="line-detail-head">
            <b>${ico('route')}新增${lineModeLabel(draft.mode)}線（示範模式）</b>
            <span class="mini">${draft.stopIds.length} / ${TRANSIT_LINE_CONFIG.maxStops} 站</span>
          </div>
          <p class="hint">① 從下方站點清單按順序加入（重複點擊可移除）；② 巴士線需有巴士總站、小巴線需有小巴車廠；③ 完成後建立路線。</p>
          <div class="draft-stops">${draftStops || '<span class="muted">尚未加入站點（可點地圖站點或下方清單）</span>'}</div>
          <div class="line-fields draft-fields">
            <label>車數 <b>${draftOptions.vehicleCount}</b><input type="range" min="${TRANSIT_LINE_CONFIG.vehicleMin}" max="${TRANSIT_LINE_CONFIG.vehicleMax}" value="${draftOptions.vehicleCount}" data-draft-field="vehicleCount"></label>
            <label>票價 <b>$${draftOptions.fare}</b><input type="range" min="${TRANSIT_LINE_CONFIG.fareMin}" max="${TRANSIT_LINE_CONFIG.fareMax}" value="${draftOptions.fare}" data-draft-field="fare"></label>
            <label class="line-check"><input type="checkbox" data-draft-field="loop" ${draftOptions.loop ? 'checked' : ''}> 循環線</label>
          </div>
          <div class="draft-choices">${stopChoices || '<div class="station-empty">未有合資格站點；先興建巴士站／總站或小巴站／車廠。</div>'}</div>
          <div class="line-actions">
            <button type="button" data-act="route-undo">↩ Undo</button>
            <button type="button" data-act="route-clear">清除站點</button>
            <button type="button" class="danger" data-act="route-cancel">取消</button>
            <button type="button" class="primary" data-act="route-finish" ${canFinish ? '' : 'disabled title="最少 2 站及 1 個總站／車廠"'}>完成（${draft.stopIds.length} 站）</button>
          </div>
        </div>`
      : '';

    return `
      <div class="fin-block tr-lines">
        <div class="block-head">
          <h3>${ico('route')}路線管理</h3>
          <span class="mini">總 ${lines.length} 條 · 巴士 ${busCount} · 小巴 ${miniCount}</span>
        </div>
        <div class="tr-line-tools">
          <button type="button" class="line-new" data-act="route-new" data-mode="bus">${ico('bus')}＋ 新增巴士線</button>
          <button type="button" class="line-new mini" data-act="route-new" data-mode="minibus">${ico('bus')}＋ 新增小巴線</button>
        </div>
        <div class="line-list">${lineRows || '<div class="station-empty">尚未建立玩家路線。先興建巴士站／巴士總站（或小巴站／小巴車廠），再按「新增巴士線」。路線會加入每日載客與車費收入。</div>'}</div>
        ${detail}
        ${editor}
      </div>`;
  };


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
      (state.transitLines ?? []).map((line) => `${line.id}:${line.vehicleCount}:${line.fare}:${line.ridershipToday}:${line.suspended ? 1 : 0}:${line.stopIds.length}`).join(','),
      state.ui.lineEditorActive
        ? `editor:${state.ui.lineDraft?.stopIds.join('-') ?? ''}:${draftOptions.vehicleCount}:${draftOptions.fare}:${draftOptions.loop ? 1 : 0}`
        : 'no-editor',
      state.ui.selectedLineId ?? -1,
      Math.round(state.finance.treasury),
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
      ${renderRoutes(state)}

      <div class="fin-block" style="margin-top:10px">
        <div class="block-head"><h3>${ico('chart')}模式分擔</h3><span class="mini">今日載客</span></div>
        <div class="mode-share">${modeShare}</div>
      </div>

      <div class="transit-grid">
        ${modes.map((stat) => modeCard(stat, state, (state.transitLines ?? []).filter((l) => l.mode === 'bus').length)).join('')}
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

  const offClick = delegate(host.layer, 'click', '[data-act]', (node) => {
    const state = store.state;
    switch (node.dataset.act) {
      case 'select-station': {
        const id = Number(node.dataset.id);
        if (Number.isFinite(id)) actions.selectBuilding(id);
        break;
      }
      case 'route-new': {
        const mode = node.dataset.mode as TransitLineMode | undefined;
        if (mode === 'bus' || mode === 'minibus') startEditor(state, mode);
        break;
      }
      case 'route-select': {
        const id = Number(node.dataset.id);
        state.ui.selectedLineId = state.ui.selectedLineId === id ? null : id;
        store.bumpUI();
        break;
      }
      case 'route-stop': {
        const id = Number(node.dataset.id);
        if (Number.isFinite(id)) toggleDraftStop(state, id);
        break;
      }
      case 'route-undo': {
        const draft = state.ui.lineDraft;
        if (draft && draft.stopIds.length) {
          const lastStop = draft.stopIds[draft.stopIds.length - 1];
          if (typeof actions.toggleLineStop === 'function') actions.toggleLineStop(lastStop);
          else {
            draft.stopIds.pop();
            store.bumpUI();
          }
        }
        break;
      }
      case 'route-clear': {
        if (state.ui.lineDraft) {
          state.ui.lineDraft.stopIds = [];
          store.bumpUI();
        }
        break;
      }
      case 'route-cancel': {
        if (typeof actions.cancelLineEditor === 'function') actions.cancelLineEditor();
        else CLEAR_DRAFT(state);
        break;
      }
      case 'route-finish':
        finishEditor(state);
        break;
      case 'route-suspend': {
        const id = Number(node.dataset.id);
        const line = (state.transitLines ?? []).find((entry) => entry.id === id);
        if (line) updateLine(state, id, { suspended: !line.suspended });
        break;
      }
      case 'route-delete': {
        const id = Number(node.dataset.id);
        if (typeof actions.deleteTransitLine === 'function') {
          if (actions.deleteTransitLine(id)) {
            state.ui.selectedLineId = null;
            store.toast('已刪除路線', 'info');
          }
        } else {
          state.transitLines = (state.transitLines ?? []).filter((line) => line.id !== id);
          state.ui.selectedLineId = null;
          store.toast('（示範）已刪除路線', 'info');
          store.bumpUI();
        }
        break;
      }
      default:
        break;
    }
  });

  const onChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    const draftField = target.dataset.draftField;
    if (draftField) {
      if (draftField === 'vehicleCount') draftOptions.vehicleCount = Math.round(Number(target.value));
      else if (draftField === 'fare') draftOptions.fare = Math.round(Number(target.value));
      else if (draftField === 'loop') draftOptions.loop = (target as HTMLInputElement).checked;
      store.bumpUI();
      return;
    }
    const field = target.dataset.lineField;
    const id = Number(target.dataset.id);
    if (!field || !Number.isFinite(id)) return;
    const state = store.state;
    const line = (state.transitLines ?? []).find((entry) => entry.id === id);
    if (!line) return;
    if (field === 'name') {
      const name = target.value.trim().slice(0, 24);
      if (name) updateLine(state, id, { name });
    } else if (field === 'vehicleCount') {
      updateLine(state, id, { vehicleCount: Math.round(Number(target.value)) });
    } else if (field === 'fare') {
      updateLine(state, id, { fare: Math.round(Number(target.value)) });
    } else if (field === 'loop') {
      updateLine(state, id, { loop: (target as HTMLInputElement).checked });
    } else if (field === 'color') {
      updateLine(state, id, { color: target.value });
    }
  };
  host.layer.addEventListener('change', onChange);

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
      offClick();
      host.layer.removeEventListener('change', onChange);
      host.destroy();
    },
  };
}
