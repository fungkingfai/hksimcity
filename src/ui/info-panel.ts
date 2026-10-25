/**
 * 右側「城事」面板（霓虹港風）：
 *  - 未選取建築：城市概況（人口／就業／食品／公用覆蓋／交通／幸福度／紀要／建言）
 *  - 選取建築：名稱、狀態、庫存、本月帳目、居民與員工、進入室內、拆卸
 *
 * 結構只在選取對象或關鍵數據變更時重建；逐幀數值只改 style / textContent。
 */

import {
  BUILDINGS,
  CATEGORY_INFO,
  RESOURCES,
  TRANSIT_INFO,
  WEATHER_INFO,
  ZONES,
  ZONE_ORDER,
  formatMoney,
  formatMoneyShort,
} from '../core/config';
import { getUiMode } from '../core/device';
import { zoneStats } from '../sim/zoning';
import type {
  Building,
  BuildingDef,
  Citizen,
  GameActions,
  GameState,
  ResourceKey,
  ZoneType,
} from '../core/types';
import type { GameStore } from '../core/store';
import {
  delegate,
  esc,
  hexColor,
  happinessTone,
  num,
  pct,
  qs,
  ratioTone,
  setClass,
  setCssVar,
  setHidden,
  setHtml,
  setText,
} from './dom';
import { formatShortDateHK, formatMinutes, seasonNameHK, displayYear } from './format';
import { ico, personPill, resourceChips, sealHtml } from './icons';
import { toggleTradePanel, toggleUnderground, toggleUtilityPanel } from './round5-helpers';

export interface InfoPanelView {
  update(state: GameState): void;
  destroy(): void;
}

const MAX_NAMES = 8;

const COMMUTE_LABEL: Record<string, string> = {
  walk: '步行',
  mtr: '港鐵',
  bus: '巴士',
  tram: '電車',
  ferry: '渡輪',
};

function inventoryTotals(state: GameState): Partial<Record<ResourceKey, number>> {
  const totals: Partial<Record<ResourceKey, number>> = {};
  for (const building of state.buildings) {
    for (const [key, value] of Object.entries(building.inventory) as [ResourceKey, number][]) {
      if (!value) continue;
      totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}

function citizenName(state: GameState, id: number): string {
  return state.citizens.find((c) => c.id === id)?.name ?? '無名氏';
}

function citizenDetail(state: GameState, id: number): string {
  const citizen: Citizen | undefined = state.citizens.find((c) => c.id === id);
  if (!citizen) return '';
  const parts: string[] = [];
  if (citizen.age) parts.push(`${citizen.age} 歲`);
  if (citizen.salary) parts.push(`$${Math.round(citizen.salary).toLocaleString('zh-HK')}/月`);
  if (citizen.commuteMode) parts.push(COMMUTE_LABEL[citizen.commuteMode] ?? '');
  return parts.filter(Boolean).join(' · ');
}

interface NoteRow {
  label: string;
  value: string;
}

function defNoteRows(def: BuildingDef): NoteRow[] {
  const rows: NoteRow[] = [];
  if (def.production) {
    const prod = def.production;
    rows.push({ label: '產出', value: `${RESOURCES[prod.output]?.name ?? prod.output} ${prod.amountPerDay}/日` });
    if (prod.input) {
      rows.push({
        label: '投入',
        value: `${RESOURCES[prod.input.resource]?.name ?? prod.input.resource} ${prod.input.amountPerDay}/日`,
      });
    }
  }
  if (def.service) {
    const svc = def.service;
    if (svc.radius) rows.push({ label: '服務半徑', value: `${svc.radius} 格` });
    if (svc.happiness) rows.push({ label: '幸福加成', value: `周邊 +${svc.happiness}` });
    if (svc.incomePerDay) rows.push({ label: '每日收入', value: `約 ${formatMoney(svc.incomePerDay)}` });
    if (svc.capacity) rows.push({ label: '服務容量', value: `${num(svc.capacity)} 人` });
  }
  if (def.transit) {
    rows.push({
      label: '交通',
      value: `${TRANSIT_INFO[def.transit.mode].name} · 半徑 ${def.transit.radius} 格 · 車費 $${def.transit.fare}`,
    });
    rows.push({ label: '運力', value: `每日 ${num(def.transit.capacity)} 人次` });
  }
  if (def.utility) {
    rows.push({
      label: def.utility.kind === 'power' ? '供電' : '供水',
      value: `半徑 ${def.utility.radius} 格 · 容量 ${num(def.utility.capacity)} 人`,
    });
  }
  if (def.storage) {
    const accepted =
      def.storage.accepted === 'all'
        ? '所有貨物'
        : def.storage.accepted.map((key) => RESOURCES[key]?.name ?? key).join('、');
    rows.push({ label: '倉儲', value: `容量 ${def.storage.capacity}（${accepted}）` });
  }
  if (def.housing > 0) rows.push({ label: '居住', value: `可住 ${def.housing} 人` });
  rows.push({ label: '維護', value: `每月 ${formatMoney(def.upkeep)}` });
  return rows;
}

/** 城規建言（香港語境） */
function zoneDemandOf(state: GameState, zone: ZoneType): number {
  return state.stats?.zoneDemand?.[zone] ?? state.zoneDemand?.[zone] ?? 0;
}

function hasService(state: GameState, kind: string): boolean {
  return state.buildings.some((b) => BUILDINGS[b.key]?.service?.kind === kind);
}

function hasUtility(state: GameState, kind: 'power' | 'water'): boolean {
  return state.buildings.some((b) => BUILDINGS[b.key]?.utility?.kind === kind);
}

/** 城規建言（分區玩法） */
function buildTips(state: GameState): string[] {
  const { stats, finance, clock } = state;
  const tips: string[] = [];
  const totalZones = ZONE_ORDER.reduce((sum, zone) => sum + (stats.zoneTiles?.[zone] ?? 0), 0);

  if (stats.population === 0) {
    tips.push('先鋪馬路（R），再劃住宅區（Z）——開發商會按需求自動興建住宅。');
  } else if (totalZones === 0) {
    tips.push('城市未有任何分區！用住宅區（Z）／商業區（C）／工業區（V）／農業區（N）刷子劃地。');
  }
  if (stats.population > 0) {
    const farmlandTiles = stats.zoneTiles?.farmland ?? 0;
    const neededFarmlandTiles = Math.ceil(Math.max(1, stats.population) / 50) * 4;
    const foodDays = stats.foodPerDay > 0 ? stats.foodStored / stats.foodPerDay : Infinity;
    if (stats.population >= 500 && farmlandTiles < neededFarmlandTiles) {
      tips.push(
        `人口 ${num(stats.population)} 人：農業區僅 ${farmlandTiles} 格，建議約 ${neededFarmlandTiles} 格（每 50 人 1 座農田），否則會出現糧食短缺。`,
      );
    } else if (stats.foodPerDay > 0 && foodDays < 3) {
      tips.push('糧食緊張：多劃農業區（N）或建食品廠，否則會出現糧食短缺警告。');
    }
  }
  if (!state.buildings.some((b) => BUILDINGS[b.key]?.utility?.kind === 'power') && stats.population > 0) {
    tips.push('尚未建發電廠：供電覆蓋不足會拖低發展分數與幸福度。');
  }
  if (!hasUtility(state, 'water') && stats.population > 0) {
    tips.push('尚未建水務設施：供水不足會限制分區自動發展。');
  }
  if (!hasService(state, 'police') && stats.population > 30) {
    tips.push('未有警署：治安服務可提升地價與住宅需求。');
  }
  if (!hasService(state, 'fire') && stats.population > 30) {
    tips.push('未有消防局：消防覆蓋會影響住宅與商業發展。');
  }
  if (!hasService(state, 'school') && stats.population > 80) {
    tips.push('未有學校：教育覆蓋可吸引家庭遷入，提升住宅需求。');
  }
  if (!hasService(state, 'hospital') && stats.population > 150) {
    tips.push('未建醫院：醫療覆蓋不足會拉低幸福度與地價。');
  }

  const demandTop = [...ZONE_ORDER].sort((a, b) => zoneDemandOf(state, b) - zoneDemandOf(state, a))[0];
  if (demandTop && zoneDemandOf(state, demandTop) >= 0.25) {
    const action =
      demandTop === 'residential'
        ? '多劃住宅區（Z），確保連接馬路與公共設施'
        : demandTop === 'commercial'
          ? '多劃商業區（C），靠近住宅與道路'
          : demandTop === 'industrial'
            ? '多劃工業區（V），提供職位與物流'
            : '多劃農業區（N），農地／平地優先';
    tips.push(`${ZONES[demandTop].name}需求高（${Math.round(zoneDemandOf(state, demandTop) * 100)}%）：${action}。`);
  }
  if (stats.hospitalCoverage < 0.5 || stats.schoolCoverage < 0.5) {
    tips.push('教育或醫療覆蓋不足，可補建學校／醫院提升地價。');
  }
  if (stats.landValue > 0 && stats.landValue < 40) {
    tips.push(`發展分數僅 ${Math.round(stats.landValue)}／100：先改善公用設施與服務覆蓋。`);
  }
  if (finance.treasury < 0) tips.push('庫房赤字！調整稅率、拍賣土地或暫緩劃區。');
  else if (finance.treasury < 300_000) tips.push('庫房緊張：可「賣地」應急，或暂緩大規模劃區。');
  if (clock.weather === 'storm') tips.push('八號風球！渡輪停航、工程停工，開發會暫時放緩。');
  if (tips.length === 0) tips.push('城市運作暢順：保持分區需求平衡，逐步升級公共服務與交通。');
  return tips.slice(0, 4);
}

/** 市民三項需求的平均值（0..100） */
function averageNeeds(state: GameState): { food: number; goods: number; leisure: number } {
  if (!state.citizens.length) return { food: 0, goods: 0, leisure: 0 };
  let food = 0;
  let goods = 0;
  let leisure = 0;
  for (const citizen of state.citizens) {
    food += citizen.needs?.food ?? 0;
    goods += citizen.needs?.goods ?? 0;
    leisure += citizen.needs?.leisure ?? 0;
  }
  const n = state.citizens.length;
  return { food: food / n, goods: goods / n, leisure: leisure / n };
}

/** 主要問題 chips（最多 4 個） */
function problemChips(state: GameState): { text: string; tone: 'bad' | 'warn' }[] {
  const { stats, finance, clock } = state;
  const chips: { text: string; tone: 'bad' | 'warn' }[] = [];
  const hasMarket = state.buildings.some((b) => BUILDINGS[b.key]?.service?.kind === 'market');
  if (stats.population > 0 && stats.foodStored < Math.max(1, stats.foodPerDay) * 2) {
    chips.push({ text: '食品不足', tone: 'bad' });
  }
  if (stats.population > 0 && !hasMarket) chips.push({ text: '沒有零售點', tone: 'bad' });
  if (stats.powerCoverage < 0.6) chips.push({ text: '供電不足', tone: 'warn' });
  if (stats.waterCoverage < 0.6) chips.push({ text: '供水不足', tone: 'warn' });
  if (stats.unemployed > Math.max(3, Math.round(stats.employed * 0.08))) {
    chips.push({ text: `失業 ${stats.unemployed} 人`, tone: 'warn' });
  }
  if (stats.homeless > 0) chips.push({ text: `無家 ${stats.homeless} 人`, tone: 'bad' });
  if (stats.transitCoverage < 0.4 && stats.population >= 100) chips.push({ text: '交通覆蓋不足', tone: 'warn' });
  if (stats.avgCommute > 40) chips.push({ text: '通勤太遠', tone: 'warn' });
  if (finance.salaryTaxRate > 0.18 || finance.profitTaxRate > 0.22 || finance.ratesRate > 0.1) {
    chips.push({ text: '稅率偏重', tone: 'warn' });
  }
  if (clock.weather === 'storm') chips.push({ text: '8 號風球', tone: 'bad' });
  if (finance.treasury < 0) chips.push({ text: '庫房赤字', tone: 'bad' });
  return chips.slice(0, 4);
}

export function createInfoPanel(container: HTMLElement, store: GameStore, actions: GameActions): InfoPanelView {
  const root = document.createElement('aside');
  root.className = 'info-panel';
  root.id = 'info-panel';
  root.innerHTML = `
    <div class="panel-glow" aria-hidden="true"></div>
    <header class="panel-head">
      <div class="panel-heading">
        ${sealHtml('城', 'panel-seal')}
        <div class="panel-heading-text">
          <h2 class="panel-title">城事</h2>
          <small class="panel-sub">CITY REPORT · 維港脈搏</small>
        </div>
      </div>
      <button type="button" class="collapse-btn" data-act="collapse" data-panel="info" title="收合面板">${ico('chevronRight')}</button>
    </header>
    <div class="info-scroll">
      <section class="info-view" data-view="overview">
        <div class="city-hero">
          <div class="hero-text">
            <span class="hero-label">CITY STATUS</span>
            <b class="hero-city" data-k="cityName">維港之城</b>
            <span class="hero-date" data-k="date"></span>
            <span class="hero-map" data-k="mapSize"></span>
            <span class="hero-existing" data-k="existingCount" hidden></span>
            <div class="hero-quick">
              <button type="button" data-act="hero-utility" title="公用設施面板">${ico('gauge')}公用</button>
              <button type="button" data-act="hero-trade" title="機場／碼頭貿易（Y）">${ico('plane')}貿易</button>
              <button type="button" data-act="hero-underground" title="地下管網（U）">${ico('pipe')}管網</button>
            </div>
          </div>
          <div class="happy-dial tone-ok" data-k="dial" role="img" aria-label="幸福度">
            <div class="dial-face"><b data-k="happyBig">70</b><span>幸福度</span></div>
          </div>
        </div>

        <div class="section-label">
          <span>分區需求 RCI+F</span>
          <button type="button" class="zone-toggle mini" data-act="toggle-zones" title="顯示／隱藏分區色塊（L）">${ico('layers')}<span>色塊</span></button>
        </div>
        <div class="zoning-panel" data-k="zoningPanel"></div>

        <div class="stat-grid">
          <div class="stat-card"><span>人口</span><b data-k="pop">0</b><small data-k="households">住戶 0</small></div>
          <div class="stat-card"><span>就業</span><b data-k="employed">0</b><small data-k="jobs">職位 0</small></div>
          <div class="stat-card"><span>失業</span><b data-k="unemployed">0</b><small>待業市民</small></div>
          <div class="stat-card"><span>無家</span><b data-k="homeless">0</b><small>露宿人口</small></div>
          <div class="stat-card wide"><span>食品</span><b data-k="food">0</b><small data-k="foodRate">日耗 0</small><small class="food-mainland" data-k="mainlandFood"></small></div>
          <div class="stat-card"><span>物流在途</span><b data-k="transit">0</b><small>貨運單位</small></div>
        </div>

        <div class="section-label">市民需求</div>
        <div class="needs">
          <div class="need-head"><span>${ico('food')}食品</span><b data-k="needFood">—</b></div>
          <div class="metric-bar"><i data-k="needFoodBar" class="tone-bad"></i></div>
          <div class="need-head"><span>${ico('goods')}日用品</span><b data-k="needGoods">—</b></div>
          <div class="metric-bar"><i data-k="needGoodsBar" class="tone-bad"></i></div>
          <div class="need-head"><span>${ico('spark')}消閒</span><b data-k="needLeisure">—</b></div>
          <div class="metric-bar"><i data-k="needLeisureBar" class="tone-bad"></i></div>
        </div>
        <div class="problem-chips" data-k="problems"></div>

        <div class="section-label">城市指標</div>
        <div class="metrics">
          <div class="metric-head"><span>${ico('power')}供電覆蓋</span><b data-k="powerVal">0%</b></div>
          <div class="metric-bar"><i data-k="powerBar" class="tone-bad"></i></div>
          <div class="metric-head"><span>${ico('water')}供水覆蓋</span><b data-k="waterVal">0%</b></div>
          <div class="metric-bar"><i data-k="waterBar" class="tone-bad"></i></div>
          <div class="metric-head"><span>${ico('mtr')}交通覆蓋</span><b data-k="transitVal">0%</b></div>
          <div class="metric-bar"><i data-k="transitBar" class="tone-bad"></i></div>
          <div class="metric-kv">
            <div><span>平均通勤</span><b data-k="commute">—</b></div>
            <div><span>每日載客</span><b data-k="ridership">0</b></div>
            <div><span>颱風信號</span><b data-k="typhoon">—</b></div>
            <div><span>季節</span><b data-k="season">春</b></div>
          </div>
        </div>

        <div class="section-label">全城庫存</div>
        <div class="res-wrap" data-k="resWrap"></div>

        <div class="section-label">城中紀要 <span class="mini" data-k="logCount"></span></div>
        <ul class="log-feed" data-k="logFeed"></ul>

        <div class="tip-card">
          <div class="tips-head"><span class="seal seal-gold">諫</span><b>城規建言</b></div>
          <ul class="tips" data-k="tips"></ul>
        </div>
      </section>

      <section class="info-view info-selected" data-view="building" hidden></section>
    </div>
  `;
  container.appendChild(root);

  const overview = qs<HTMLElement>(root, '[data-view="overview"]')!;
  const selected = qs<HTMLElement>(root, '[data-view="building"]')!;

  const cityNameEl = qs<HTMLElement>(root, '[data-k="cityName"]')!;
  const dateEl = qs<HTMLElement>(root, '[data-k="date"]')!;
  const mapSizeEl = qs<HTMLElement>(root, '[data-k="mapSize"]')!;
  const existingCountEl = qs<HTMLElement>(root, '[data-k="existingCount"]')!;
  const mainlandFoodEl = qs<HTMLElement>(root, '[data-k="mainlandFood"]')!;
  const dialEl = qs<HTMLElement>(root, '[data-k="dial"]')!;
  const happyBigEl = qs<HTMLElement>(root, '[data-k="happyBig"]')!;
  const popEl = qs<HTMLElement>(root, '[data-k="pop"]')!;
  const householdsEl = qs<HTMLElement>(root, '[data-k="households"]')!;
  const employedEl = qs<HTMLElement>(root, '[data-k="employed"]')!;
  const jobsEl = qs<HTMLElement>(root, '[data-k="jobs"]')!;
  const unemployedEl = qs<HTMLElement>(root, '[data-k="unemployed"]')!;
  const homelessEl = qs<HTMLElement>(root, '[data-k="homeless"]')!;
  const foodEl = qs<HTMLElement>(root, '[data-k="food"]')!;
  const foodRateEl = qs<HTMLElement>(root, '[data-k="foodRate"]')!;
  const transitEl = qs<HTMLElement>(root, '[data-k="transit"]')!;
  const powerVal = qs<HTMLElement>(root, '[data-k="powerVal"]')!;
  const powerBar = qs<HTMLElement>(root, '[data-k="powerBar"]')!;
  const waterVal = qs<HTMLElement>(root, '[data-k="waterVal"]')!;
  const waterBar = qs<HTMLElement>(root, '[data-k="waterBar"]')!;
  const transitVal = qs<HTMLElement>(root, '[data-k="transitVal"]')!;
  const transitBar = qs<HTMLElement>(root, '[data-k="transitBar"]')!;
  const commuteEl = qs<HTMLElement>(root, '[data-k="commute"]')!;
  const ridershipEl = qs<HTMLElement>(root, '[data-k="ridership"]')!;
  const typhoonEl = qs<HTMLElement>(root, '[data-k="typhoon"]')!;
  const seasonEl = qs<HTMLElement>(root, '[data-k="season"]')!;
  const needFoodEl = qs<HTMLElement>(root, '[data-k="needFood"]')!;
  const needFoodBar = qs<HTMLElement>(root, '[data-k="needFoodBar"]')!;
  const needGoodsEl = qs<HTMLElement>(root, '[data-k="needGoods"]')!;
  const needGoodsBar = qs<HTMLElement>(root, '[data-k="needGoodsBar"]')!;
  const needLeisureEl = qs<HTMLElement>(root, '[data-k="needLeisure"]')!;
  const needLeisureBar = qs<HTMLElement>(root, '[data-k="needLeisureBar"]')!;
  const problemsEl = qs<HTMLElement>(root, '[data-k="problems"]')!;
  const zoningPanel = qs<HTMLElement>(root, '[data-k="zoningPanel"]')!;
  const zoneToggleMini = qs<HTMLElement>(root, '.section-label [data-act="toggle-zones"]');
  const resWrap = qs<HTMLElement>(root, '[data-k="resWrap"]')!;
  const logCountEl = qs<HTMLElement>(root, '[data-k="logCount"]')!;
  const logFeed = qs<HTMLElement>(root, '[data-k="logFeed"]')!;
  const tipsEl = qs<HTMLElement>(root, '[data-k="tips"]')!;

  // ── 拆除二次確認 ──
  let pendingDemolish: number | null = null;
  let pendingTimer = 0;
  const clearPending = (): void => {
    pendingDemolish = null;
    if (pendingTimer) window.clearTimeout(pendingTimer);
    pendingTimer = 0;
  };

  const offClick = delegate(root, 'click', '[data-act]', (node) => {
    if (node.dataset.act === 'hero-utility') {
      toggleUtilityPanel(store, actions);
      return;
    }
    if (node.dataset.act === 'hero-trade') {
      toggleTradePanel(store, actions);
      return;
    }
    if (node.dataset.act === 'hero-underground') {
      toggleUnderground(store, actions);
      return;
    }
    switch (node.dataset.act) {
      case 'enter': {
        const id = Number(node.dataset.id);
        if (Number.isFinite(id)) actions.enterBuilding(id);
        break;
      }
      case 'demolish': {
        const id = Number(node.dataset.id);
        if (!Number.isFinite(id)) return;
        pendingDemolish = id;
        if (pendingTimer) window.clearTimeout(pendingTimer);
        pendingTimer = window.setTimeout(() => {
          pendingDemolish = null;
          pendingTimer = 0;
          store.bumpUI();
        }, 4500);
        store.bumpUI();
        break;
      }
      case 'demolish-confirm': {
        const id = Number(node.dataset.id);
        clearPending();
        if (Number.isFinite(id)) actions.demolishBuilding(id);
        break;
      }
      case 'demolish-cancel':
        clearPending();
        store.bumpUI();
        break;
      case 'toggle-zones':
        actions.toggleZones();
        break;
      case 'deselect':
        actions.selectBuilding(null);
        break;
      default:
        break;
    }
  });

  // ── 概況（逐幀更新，全部先比對） ──
  let lastCity = '';
  let lastDate = '';
  let lastExistingCount = -1;
  let lastMainlandFood = -1;
  let lastHappy = Number.NaN;
  let lastTone = '';
  let lastResSig = '';
  let lastLogSig = '';
  let lastTipsSig = '';
  let lastMetricsSig = '';
  let lastNeedsSig = '';
  let lastProblemsSig = '';
  let lastZoningSig = '';

  const renderZoning = (state: GameState): void => {
    const { stats } = state;
    const zs = zoneStats(state);
    const demandRows = ZONE_ORDER.map((zone) => {
      const def = ZONES[zone];
      const demand = Math.max(-1, Math.min(1, zoneDemandOf(state, zone)));
      const level = Math.round(demand * 100);
      const width = Math.max(1.5, Math.abs(demand) * 50);
      const style = demand >= 0 ? `left:50%;width:${width}%` : `left:${50 - width}%;width:${width}%`;
      const tone = demand >= 0.2 ? 'high' : demand <= -0.2 ? 'low' : 'mid';
      return `
        <div class="demand-row tone-${tone}" style="--zone:${def.colorHex}">
          <span class="dr-name"><i class="dr-short">${def.short}</i>${esc(def.name)}</span>
          <span class="dr-track"><span class="dr-mid"></span><i class="dr-fill${demand >= 0 ? ' pos' : ' neg'}" style="${style}"></i></span>
          <b class="dr-val">${level > 0 ? '+' : ''}${level}</b>
        </div>`;
    }).join('');

    const demandTop = [...ZONE_ORDER].sort((a, b) => zoneDemandOf(state, b) - zoneDemandOf(state, a))[0];
    const over = ZONE_ORDER.find((zone) => zoneDemandOf(state, zone) <= -0.3);
    // 糧食緊張：農業需求高或存量少於 3 日 → 最優先顯示
    const foodDays = stats.foodPerDay > 0 ? stats.foodStored / stats.foodPerDay : Infinity;
    const foodTight =
      zoneDemandOf(state, 'farmland') > 0.4 || (stats.foodPerDay > 0 && foodDays < 3);
    const advice = foodTight
      ? '糧食緊張：多劃農業區（N）或建食品廠，否則會出現糧食短缺警告。'
      : over
        ? `${ZONES[over].name}供過於求：暫緩劃該區，先改善交通與公共服務。`
        : demandTop && zoneDemandOf(state, demandTop) >= 0.25
          ? `${ZONES[demandTop].name}需求高：多劃${ZONES[demandTop].name}，帶動開發商起樓。`
          : '各區需求平穩：按人口增長逐步擴張分區，並保持服務覆蓋。';

    const zoneRows = ZONE_ORDER.map((zone) => {
      const def = ZONES[zone];
      const info = zs.perZone[zone];
      const detail = info.housing > 0 ? `住宅 ${num(info.housing)} 人` : info.jobs > 0 ? `職位 ${num(info.jobs)} 個` : '農地';
      return `
        <div class="zone-stat" style="--zone:${def.colorHex}" title="${esc(def.name)}：${detail}">
          <i class="zs-dot" aria-hidden="true">${def.short}</i>
          <span class="zs-name">${esc(def.name)}</span>
          <b class="zs-val">${num(info.tiles)} 格 · ${num(info.buildings)} 棟</b>
        </div>`;
    }).join('');

    const services: { key: string; label: string; value: number; color: string }[] = [
      { key: 'police', label: '警力覆蓋', value: stats.policeCoverage, color: '#4f8fd0' },
      { key: 'fire', label: '消防覆蓋', value: stats.fireCoverage, color: '#e2584a' },
      { key: 'school', label: '教育覆蓋', value: stats.schoolCoverage, color: '#5cff9d' },
      { key: 'hospital', label: '醫療覆蓋', value: stats.hospitalCoverage, color: '#e8b04a' },
    ];
    const serviceRows = services
      .map((svc) => {
        const pctValue = Math.max(0, Math.min(1, svc.value));
        const tone = ratioTone(pctValue);
        return `
          <div class="svc-row">
            <span class="svc-tag" style="--svc:${svc.color}">${esc(svc.label.slice(0, 2))}</span>
            <span class="svc-name">${esc(svc.label)}</span>
            <span class="svc-bar"><i class="tone-${tone}" style="width:${Math.max(2, Math.round(pctValue * 100))}%"></i></span>
            <b class="svc-val">${Math.round(pctValue * 100)}%</b>
          </div>`;
      })
      .join('');

    const land = Math.max(0, Math.min(100, zs.landValue ?? stats.landValue ?? 0));
    const cityScore = Math.max(0, Math.min(100, zs.cityScore ?? land));
    const landTone = ratioTone(land / 100);

    setHtml(
      zoningPanel,
      `
      <div class="demand-list">${demandRows}</div>
      <p class="demand-advice${foodTight ? ' warn' : ''}">${ico(foodTight ? 'warn' : 'info')}${esc(advice)}</p>
      <div class="zoning-grid">
        <div class="zoning-col">
          <div class="zoning-title">分區統計</div>
          ${zoneRows}
        </div>
        <div class="zoning-col">
          <div class="zoning-title">服務覆蓋</div>
          ${serviceRows}
        </div>
      </div>
      <div class="land-value">
        <div class="lv-head"><span>地價指數</span><b>${Math.round(land)}<em>/100</em></b></div>
        <div class="metric-bar"><i class="tone-${landTone}" style="width:${Math.max(2, land)}%"></i></div>
        <div class="lv-meta">
          <span>自動開發 <b>${num(zs.autoBuildings)}</b> 棟</span>
          <span>城市發展分數 <b>${Math.round(cityScore)}</b></span>
        </div>
      </div>
    `,
    );
  };

  const updateOverview = (state: GameState): void => {
    const { clock, stats, finance } = state;
    if (state.cityName !== lastCity) {
      lastCity = state.cityName;
      setText(cityNameEl, state.cityName || '維港之城');
    }
    const date = `${formatShortDateHK(clock)} · ${formatMoneyShort(finance.treasury)}`;
    if (date !== lastDate) {
      lastDate = date;
      setText(dateEl, date);
    }
    setText(
      mapSizeEl,
      `地圖 ${state.width}×${state.height} · ${num(state.width * state.height)} 格${
        state.gameMode === 'starter' ? ' · 已有城鎮' : ' · 由零開始'
      }`,
    );
    const existingCount = state.buildings.reduce((count, building) => (building.existing ? count + 1 : count), 0);
    if (existingCount !== lastExistingCount) {
      lastExistingCount = existingCount;
      setHidden(existingCountEl, existingCount === 0);
      setText(existingCountEl, `現有樓宇 ${num(existingCount)} 棟（可拆卸）`);
    }
    const mainlandFood = Math.round(state.stats.mainlandFoodPerDay ?? state.mainland?.foodPerDay ?? 0);
    if (mainlandFood !== lastMainlandFood) {
      lastMainlandFood = mainlandFood;
      setHidden(mainlandFoodEl, mainlandFood <= 0);
      setText(mainlandFoodEl, `內地支援 +${num(mainlandFood)}/日`);
    }

    const happiness = Math.round(stats.happiness);
    const tone = happinessTone(happiness);
    if (happiness !== lastHappy || tone !== lastTone) {
      lastHappy = happiness;
      lastTone = tone;
      setText(happyBigEl, String(happiness));
      dialEl.classList.remove('tone-bad', 'tone-ok', 'tone-good');
      dialEl.classList.add(`tone-${tone}`);
      setCssVar(dialEl, '--p', `${Math.max(0, Math.min(100, happiness))}`);
    }

    setText(popEl, num(stats.population));
    setText(householdsEl, `住戶 ${num(stats.households)}`);
    setText(employedEl, num(stats.employed));
    setText(jobsEl, `職位 ${num(stats.jobs)}`);
    setText(unemployedEl, num(stats.unemployed));
    setText(homelessEl, num(stats.homeless));
    setText(foodEl, num(stats.foodStored));
    const foodDays = stats.foodPerDay > 0 ? Math.floor(stats.foodStored / stats.foodPerDay) : 0;
    setText(foodRateEl, `日耗 ${num(stats.foodPerDay)} · 可撐 ${foodDays} 日`);
    setText(transitEl, num(stats.goodsInTransit));

    const zoningSig = ZONE_ORDER.map((zone) => Math.round(zoneDemandOf(state, zone) * 100)).join(',') +
      '|' + ZONE_ORDER.map((zone) => `${stats.zoneTiles?.[zone] ?? 0}:${stats.zoneBuildings?.[zone] ?? 0}`).join(',') +
      '|' + [stats.policeCoverage, stats.fireCoverage, stats.schoolCoverage, stats.hospitalCoverage, stats.landValue]
        .map((v) => Math.round(v * 100)).join(',') +
      '|' + state.buildings.length +
      '|' + Math.round(stats.foodStored) + ':' + Math.round(stats.foodPerDay);
    if (zoningSig !== lastZoningSig) {
      lastZoningSig = zoningSig;
      renderZoning(state);
    }
    setClass(zoneToggleMini, 'active', state.ui.showZones);

    const needs = averageNeeds(state);
    const needsSig = `${Math.round(needs.food)}|${Math.round(needs.goods)}|${Math.round(needs.leisure)}`;
    if (needsSig !== lastNeedsSig) {
      lastNeedsSig = needsSig;
      const setNeed = (value: number, text: HTMLElement, bar: HTMLElement): void => {
        const v = Math.max(0, Math.min(100, value));
        setText(text, `${Math.round(v)} / 100`);
        bar.style.width = `${Math.max(2, v)}%`;
        bar.className = `tone-${ratioTone(v / 100)}`;
      };
      setNeed(needs.food, needFoodEl, needFoodBar);
      setNeed(needs.goods, needGoodsEl, needGoodsBar);
      setNeed(needs.leisure, needLeisureEl, needLeisureBar);
    }

    const problems = problemChips(state);
    const problemsSig = problems.map((p) => p.text).join('|');
    if (problemsSig !== lastProblemsSig) {
      lastProblemsSig = problemsSig;
      setHtml(
        problemsEl,
        problems.length
          ? problems.map((p) => `<span class="problem-chip ${p.tone === 'warn' ? 'warn' : ''}">${esc(p.text)}</span>`).join('')
          : '<span class="problem-chip ok">暫無重大問題</span>',
      );
    }

    const metricsSig = [
      Math.round(stats.powerCoverage * 100),
      Math.round(stats.waterCoverage * 100),
      Math.round(stats.transitCoverage * 100),
      Math.round(stats.avgCommute),
      Math.round(stats.ridership),
      stats.typhoonSignal,
      clock.season,
    ].join('|');
    if (metricsSig !== lastMetricsSig) {
      lastMetricsSig = metricsSig;
      const setMetric = (bar: HTMLElement, val: HTMLElement, value: number): void => {
        const pctValue = Math.max(0, Math.min(1, value));
        setText(val, pct(pctValue));
        bar.style.width = `${Math.max(2, pctValue * 100)}%`;
        bar.className = `tone-${ratioTone(pctValue)}`;
      };
      setMetric(powerBar, powerVal, stats.powerCoverage);
      setMetric(waterBar, waterVal, stats.waterCoverage);
      setMetric(transitBar, transitVal, stats.transitCoverage);
      setText(commuteEl, stats.avgCommute > 0 ? formatMinutes(stats.avgCommute) : '—');
      setText(ridershipEl, `${num(stats.ridership)} 人次`);
      const signal = clock.weather === 'storm' ? Math.max(8, stats.typhoonSignal) : stats.typhoonSignal;
      setText(typhoonEl, signal > 0 ? `${signal} 號風球` : '無');
      setClass(typhoonEl, 'danger', signal >= 8);
      setText(seasonEl, `${seasonNameHK(clock.season)} · ${WEATHER_INFO[clock.weather].name}`);
    }

    // 全城庫存
    const totals = inventoryTotals(state);
    const resEntries = (Object.entries(totals) as [ResourceKey, number][])
      .filter(([key, value]) => RESOURCES[key] && value > 0.5)
      .sort((a, b) => (RESOURCES[a[0]]?.price ?? 0) * b[1] - (RESOURCES[b[0]]?.price ?? 0) * a[1])
      .slice(0, 8);
    const resSig = resEntries.map(([k, v]) => `${k}:${Math.round(v)}`).join(',');
    if (resSig !== lastResSig) {
      lastResSig = resSig;
      setHtml(
        resWrap,
        resEntries.length
          ? resourceChips(Object.fromEntries(resEntries) as Partial<Record<ResourceKey, number>>)
          : '<span class="muted">倉庫未有存貨，等待生產與物流運轉</span>',
      );
    }

    // 城中紀要（最近 8 條）
    const recent = state.log.slice(-8).reverse();
    const logSig = recent.map((entry) => entry.id).join(',');
    if (logSig !== lastLogSig) {
      lastLogSig = logSig;
      setText(logCountEl, `${state.log.length} 則`);
      setHtml(
        logFeed,
        recent.length
          ? recent
              .map(
                (entry) =>
                  `<li class="log-item ${entry.kind}"><span class="log-date">${displayYear(entry.year)}/${entry.month}/${entry.day}</span>` +
                  `<span class="log-text">${esc(entry.text)}</span></li>`,
              )
              .join('')
          : '<li class="log-item info"><span class="log-text muted">城中未有紀要</span></li>',
      );
    }

    // 建言
    const tips = buildTips(state);
    const tipsSig = tips.join('|');
    if (tipsSig !== lastTipsSig) {
      lastTipsSig = tipsSig;
      setHtml(tipsEl, tips.map((tip) => `<li>${esc(tip)}</li>`).join(''));
    }
  };

  // ── 選取建築 ──
  let lastSelectedId = -2;
  let lastSelSig = '';
  let lastProgWidth = -1;
  let lastAutoOpenId = -1;

  const selectionSig = (state: GameState, b: Building, def: BuildingDef): string => {
    const inv = Object.entries(b.inventory)
      .filter(([, value]) => (value ?? 0) > 0.05)
      .map(([key, value]) => `${key}:${Math.round((value ?? 0) * 10)}`)
      .join(',');
    return [
      b.id,
      def.key,
      b.existing ? 1 : 0,
      b.connected ? 1 : 0,
      b.active ? 1 : 0,
      b.level,
      b.workers.length,
      b.residents.length,
      b.workers.slice(0, MAX_NAMES).join('.'),
      b.residents.slice(0, MAX_NAMES).join('.'),
      inv,
      Math.round(b.incomeThisMonth),
      Math.round(b.expenseThisMonth),
      pendingDemolish === b.id ? 1 : 0,
      state.finance.treasury < 0 ? 1 : 0,
    ].join('|');
  };

  const renderSelected = (state: GameState, b: Building, def: BuildingDef): void => {
    const status: string[] = [];
    if (b.connected) status.push('<span class="pill ok">臨路連通</span>');
    else if (def.needsRoad === false) status.push('<span class="pill">無需臨路</span>');
    else status.push('<span class="pill warn">未接道路</span>');
    if (def.workers > 0) {
      status.push(
        `<span class="pill${b.workers.length >= def.workers ? ' ok' : b.workers.length > 0 ? '' : ' warn'}">員工 ${b.workers.length}/${def.workers}</span>`,
      );
    }
    if (def.housing > 0) status.push(`<span class="pill">居民 ${b.residents.length}/${def.housing}</span>`);
    if (def.production || def.service || def.storage) {
      status.push(`<span class="pill ${b.active ? 'ok' : 'warn'}">${b.active ? '營運中' : '停擺'}</span>`);
    }
    if (b.level > 1) status.push(`<span class="pill">第 ${b.level} 級</span>`);
    if (b.existing) {
      status.push('<span class="pill existing">現有樓宇</span>');
    }
    if (b.auto || b.zone) {
      const zoneDef = b.zone ? ZONES[b.zone] : null;
      status.push(
        `<span class="pill zone-pill" style="--zone:${zoneDef?.colorHex ?? '#24e0ff'}">${zoneDef ? esc(zoneDef.name) : ''}自動開發</span>`,
      );
    }

    const notes = defNoteRows(def)
      .map((rowItem) => `<div class="note-row"><span>${esc(rowItem.label)}</span><b>${esc(rowItem.value)}</b></div>`)
      .join('');

    const residents =
      b.residents.length > 0
        ? b.residents
            .slice(0, MAX_NAMES)
            .map((id) => personPill(citizenName(state, id), citizenDetail(state, id)))
            .join('')
        : '';
    const workers =
      b.workers.length > 0
        ? b.workers
            .slice(0, MAX_NAMES)
            .map((id) => personPill(citizenName(state, id), citizenDetail(state, id)))
            .join('')
        : '';

    const progress =
      def.production && b.productionProgress > 0
        ? `<div class="prog-row"><span>生產進度</span><div class="prog-bar"><i data-k="prog"></i></div></div>`
        : '';

    const demolishArea =
      pendingDemolish === b.id
        ? `<div class="confirm-inline"><span>確定拆卸此建築？</span>` +
          `<button type="button" class="danger" data-act="demolish-confirm" data-id="${b.id}">確定拆卸</button>` +
          `<button type="button" data-act="demolish-cancel">取消</button></div>`
        : `<button type="button" class="danger" data-act="demolish" data-id="${b.id}">${ico('hammer')}拆卸</button>`;

    setHtml(
      selected,
      `
      <div class="sel-head">
        <span class="sel-icon" style="--c:${hexColor(def.color)}">${ico('door')}</span>
        <div class="sel-title">
          <b>${esc(def.name)}</b>
          <div class="sel-meta">
            <span class="badge">${esc(CATEGORY_INFO[def.category].name)}</span>
            ${
              b.auto || b.zone
                ? `<span class="badge zone-badge" style="--zone:${(b.zone ? ZONES[b.zone] : null)?.colorHex ?? '#24e0ff'}">${b.zone ? esc(ZONES[b.zone].name) : ''}自動開發</span>`
                : ''
            }
            <small>${def.size[0]}×${def.size[1]} 格 · 座落 (${b.x + 1}, ${b.y + 1})</small>
          </div>
        </div>
      </div>
      <p class="sel-desc">${esc(def.desc)}</p>
      ${
        b.existing
          ? `<p class="sel-existing-note">${ico('info')}開局已有的真實樓宇：已有居民／員工運作，可拆卸（退還 0%）；重建後會變成新樓。</p>`
          : ''
      }
      <div class="status-row">${status.join('')}</div>
      ${progress}
      <div class="section-label">庫存</div>
      <div class="res-wrap">${resourceChips(b.inventory)}</div>
      <div class="finance-line">
        <span>本月收入 <b class="positive">${formatMoney(b.incomeThisMonth)}</b></span>
        <span>本月支出 <b class="negative">${formatMoney(b.expenseThisMonth)}</b></span>
      </div>
      <div class="def-notes">${notes}</div>
      ${
        residents
          ? `<div class="section-label">居民 <span class="mini">${b.residents.length}/${def.housing}</span></div><div class="people">${residents}</div>`
          : ''
      }
      ${
        workers
          ? `<div class="section-label">員工 <span class="mini">${b.workers.length}/${def.workers}</span></div><div class="people">${workers}</div>`
          : ''
      }
      <div class="sel-actions">
        <button type="button" class="primary" data-act="enter" data-id="${b.id}">${ico('door')}進入室內</button>
        ${demolishArea}
      </div>
      <div class="sel-foot"><button type="button" class="link" data-act="deselect">取消選取</button></div>
    `,
    );
    lastProgWidth = -1;
  };

  const updateSelected = (state: GameState): void => {
    const id = state.ui.selectedId;
    const building = id != null ? state.buildings.find((b) => b.id === id) : undefined;
    if (!building) {
      lastAutoOpenId = -1;
      if (lastSelectedId !== -1) {
        lastSelectedId = -1;
        lastSelSig = '';
        setHidden(selected, true);
        setHidden(overview, false);
      }
      return;
    }

    // 桌面版：選中另一棟建築而城事面板收起了，自動打開一次
    if (getUiMode() === 'desktop' && !state.ui.showStats && building.id !== lastAutoOpenId) {
      lastAutoOpenId = building.id;
      state.ui.showStats = true;
      store.bumpUI();
    }

    const def = BUILDINGS[building.key];
    if (!def) return;
    setHidden(overview, true);
    setHidden(selected, false);
    const sig = selectionSig(state, building, def);
    if (sig !== lastSelSig) {
      lastSelSig = sig;
      lastSelectedId = building.id;
      renderSelected(state, building, def);
    }
    if (def.production) {
      const bar = selected.querySelector<HTMLElement>('[data-k="prog"]');
      if (bar) {
        const width = Math.round(Math.max(0, Math.min(1, building.productionProgress)) * 100);
        if (width !== lastProgWidth) {
          lastProgWidth = width;
          bar.style.width = `${width}%`;
        }
      }
    }
  };

  const update = (state: GameState): void => {
    // 桌面以 showStats 控制面板顯示；手機以底部 sheet class 控制，
    // 因此這裡持續做差異更新（內容只會在面板可見時才被看到）。
    updateOverview(state);
    updateSelected(state);
  };

  return {
    update,
    destroy(): void {
      offClick();
      clearPending();
      root.remove();
    },
  };
}
