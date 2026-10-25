/**
 * 左側「建造」面板（霓虹港風 · 分區玩法）：
 *  - 分區 ZONING：住宅區(Z)／商業區(C)／工業區(V)／農業區(N) 4 個彩色刷子（每格造價＋需求），
 *    取消分區(M)、馬路(R，已整合行人路)、拆卸(X)
 *  - 建築分頁：只顯示 13 種 ploppable（公共／交通／休憩／物流／公用），
 *    住宅／商業／工業／農田由開發商按分區自動興建，不再手動放置
 *  - 分區色塊顯示開關（L）
 */

import {
  BORDER_CONFIG,
  BUILDINGS,
  CATEGORY_INFO,
  DEMOLISH_REFUND_RATE,
  PLOPPABLE_BUILDINGS,
  PLOPPABLE_CATEGORIES,
  RAIL_CONFIG,
  RAIL_INFO,
  RESOURCES,
  ROAD_COST,
  ROAD_GRADE_INFO,
  TERRAIN_INFO,
  TRANSIT_INFO,
  ZONES,
  ZONE_ORDER,
  formatMoney,
  formatMoneyShort,
  zoneOfTool,
  zoneTool,
} from '../core/config';
import type { BuildingCategory, BuildingDef, GameActions, GameState, ZoneType } from '../core/types';
import type { GameStore } from '../core/store';
import { clamp, delegate, esc, hexColor, num, qs, qsa, setClass, setHidden, setText } from './dom';
import { buildingGlyph, ico, sealHtml } from './icons';
import { toggleUnderground, toggleUtilityPanel } from './round5-helpers';
import { roadGradeOf } from './round8-helpers';

export interface BuildPanelView {
  update(state: GameState): void;
  destroy(): void;
}

type CategoryEntry = [BuildingCategory, { name: string; order: number; color: string }];

/** 只保留可手動放置建築的分類（順序跟 PLOPPABLE_CATEGORIES） */
const CATEGORIES: CategoryEntry[] = PLOPPABLE_CATEGORIES.map((key) => [
  key,
  { ...CATEGORY_INFO[key], name: key === 'industrial' ? '公用' : CATEGORY_INFO[key].name },
]);

const ZONE_ICONS: Record<ZoneType, 'zoneResidential' | 'zoneCommercial' | 'zoneIndustrial' | 'zoneFarmland'> = {
  residential: 'zoneResidential',
  commercial: 'zoneCommercial',
  industrial: 'zoneIndustrial',
  farmland: 'zoneFarmland',
};

const ZONE_KEYS: Record<ZoneType, string> = {
  residential: 'Z',
  commercial: 'C',
  industrial: 'V',
  farmland: 'N',
};

function buildingsOf(category: BuildingCategory): BuildingDef[] {
  return PLOPPABLE_BUILDINGS.filter((def) => def.category === category).sort(
    (a, b) => a.unlockPop - b.unlockPop || a.cost - b.cost,
  );
}

/** 卡片副標：一眼看出用途 */
function cardSubtitle(def: BuildingDef): string {
  const bits: string[] = [];
  if (['airportTerminal', 'airCargoTerminal'].includes(def.key)) bits.push('只限機場區');
  if (def.borderGate) bits.push(def.borderGate === 'road' ? '邊境道路口岸' : '邊境鐵路口岸');
  if (['containerPort', 'portGate', 'portYard'].includes(def.key)) bits.push('臨水 · 貼路（葵涌加成）');
  if (def.utility) {
    const utilityName =
      def.utility.kind === 'power' ? '供電' : def.utility.kind === 'sewage' ? '污水處理' : '供水';
    bits.push(utilityName, def.utility.source ? `容量 ${num(def.utility.capacity)}` : `半徑 ${def.utility.radius}`);
  }
  if (def.transit) bits.push(`${TRANSIT_INFO[def.transit.mode].name}站`, `半徑 ${def.transit.radius}`);
  if (def.service) {
    const kind = def.service.kind;
    const label =
      kind === 'school'
        ? '教育'
        : kind === 'hospital'
          ? '醫療'
          : kind === 'police'
            ? '治安'
            : kind === 'fire'
              ? '消防'
              : kind === 'park' || kind === 'promenade'
                ? '休憩'
                : kind === 'office'
                  ? '寫字樓'
                  : '服務';
    bits.push(label);
    if (def.service.radius && !def.utility) bits.push(`半徑 ${def.service.radius}`);
  }
  if (def.storage) bits.push(`庫容 ${def.storage.capacity}`);
  if (def.production) bits.push(`${RESOURCES[def.production.output]?.name ?? ''} ${def.production.amountPerDay}/日`);
  return bits.slice(0, 2).join(' · ') || (def.needsWater ? '需臨水' : '城市設施');
}

function acceptedLabel(def: BuildingDef): string {
  if (!def.storage) return '';
  if (def.storage.accepted === 'all') return '所有貨物';
  return def.storage.accepted.map((key) => RESOURCES[key]?.name ?? key).join('、');
}

function row(label: string, value: string): string {
  return `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
}

/** hover 說明：可手動放置的建築 */
function buildTip(def: BuildingDef): string {
  const rows: string[] = [];
  rows.push(row('造價', formatMoney(def.cost)));
  rows.push(row('維護', `每月 ${formatMoney(def.upkeep)}`));
  rows.push(row('佔地', `${def.size[0]} × ${def.size[1]} 格`));
  if (def.workers > 0) rows.push(row('職位', `${def.workers} 個`));
  if (def.transit) {
    rows.push(row('交通', `${TRANSIT_INFO[def.transit.mode].name} · 半徑 ${def.transit.radius} 格`));
    rows.push(row('運力', `每日 ${num(def.transit.capacity)} 人次 · 車費 $${def.transit.fare}`));
  }
  if (['airportTerminal', 'airCargoTerminal'].includes(def.key)) rows.push(row('位置限制', '只限機場區'));
  if (def.borderGate) {
    rows.push(row('位置限制', `只限邊境通道 ${BORDER_CONFIG.placementRadius} 格內；${def.borderGate === 'road' ? '需貼路' : '需貼鐵路軌'}`));
  }
  if (['containerPort', 'portGate', 'portYard'].includes(def.key)) rows.push(row('位置限制', '臨水＋貼路；葵涌區有吞吐加成'));
  if (def.utility) {
    const utilityLabel =
      def.utility.kind === 'power' ? '供電' : def.utility.kind === 'sewage' ? '污水處理' : '供水';
    rows.push(
      row(
        utilityLabel,
        `半徑 ${def.utility.radius} 格 · 容量 ${num(def.utility.capacity)} 人${def.utility.source ? ' · 供應源' : ''}`,
      ),
    );
  }
  if (def.storage) rows.push(row('庫存', `容量 ${def.storage.capacity}（${acceptedLabel(def)}）`));
  if (def.production) {
    const prod = def.production;
    let line = `${RESOURCES[prod.output]?.name ?? prod.output} ${prod.amountPerDay}/日`;
    if (prod.input) {
      line += `（耗 ${RESOURCES[prod.input.resource]?.name ?? prod.input.resource} ${prod.input.amountPerDay}/日）`;
    }
    rows.push(row('產出', line));
    if (prod.allowedTerrain?.length) {
      rows.push(row('地勢', `限 ${prod.allowedTerrain.map((t) => TERRAIN_INFO[t]?.name ?? t).join('、')}`));
    }
  }
  if (def.service) {
    const svc = def.service;
    if (svc.radius) rows.push(row('服務', `半徑 ${svc.radius} 格`));
    if (svc.happiness) rows.push(row('幸福', `周邊 +${svc.happiness}`));
    if (svc.incomePerDay) rows.push(row('收入', `約 ${formatMoney(svc.incomePerDay)}/日`));
    if (svc.capacity) rows.push(row('容量', `${num(svc.capacity)} 人`));
    if (svc.consumes) {
      rows.push(row('消耗', `${RESOURCES[svc.consumes.resource]?.name ?? svc.consumes.resource} ${svc.consumes.amountPerDay}/日`));
    }
    if (svc.taxBonus) rows.push(row('稅收', `效率 +${Math.round(svc.taxBonus * 100)}%`));
  }
  if (def.needsWater) rows.push(row('選址', '需臨水而建'));
  if (def.needsRoad === false) rows.push(row('道路', '不需臨路'));
  if (def.unlockPop > 0) rows.push(row('解鎖', `人口達 ${num(def.unlockPop)}`));

  return `
    <div class="tip-head">
      <span class="tip-icon" style="--c:${hexColor(def.color)}">${buildingGlyph(def.key, def.name)}</span>
      <div class="tip-title"><b>${esc(def.name)}</b><em>可手動建造 · ${def.size[0]}×${def.size[1]} 格</em></div>
    </div>
    <p class="tip-desc">${esc(def.desc)}</p>
    <dl class="tip-rows">${rows.join('')}</dl>
    ${def.unlockPop > 0 ? `<p class="tip-lock">${ico('lock')} 人口 ${num(def.unlockPop)} 解鎖</p>` : ''}
  `;
}

function zoneTip(zone: ZoneType): string {
  const def = ZONES[zone];
  return `
    <div class="tip-head">
      <span class="tip-icon zone" style="--c:${def.colorHex}">${ico(ZONE_ICONS[zone])}</span>
      <div class="tip-title"><b>${esc(def.name)}</b><em>分區刷子 · 每格 ${formatMoney(def.costPerTile)}</em></div>
    </div>
    <p class="tip-desc">${esc(def.desc)}</p>
    <dl class="tip-rows">
      ${row('造價', `每格 ${formatMoney(def.costPerTile)}`)}
      ${row('快捷鍵', ZONE_KEYS[zone])}
      ${row('發展', '開發商按需求自動興建')}
    </dl>
    <p class="tip-note">${ico('info')} ${esc(def.hint)}</p>
  `;
}

function toolTip(tool: string, grade: keyof typeof ROAD_GRADE_INFO = 'surface'): string {
  if (tool === 'road') {
    const gradeInfo = ROAD_GRADE_INFO[grade] ?? ROAD_GRADE_INFO.surface;
    return `
      <div class="tip-head">
        <span class="tip-icon tool">${ico('road')}</span>
        <div class="tip-title"><b>道路</b><em>工程 · ${esc(gradeInfo.label)} ${formatMoney(gradeInfo.cost)}/格</em></div>
      </div>
      <p class="tip-desc">由起點拖到終點<b>自動鋪路</b>；道路已整合行人路。拖曳期間按 <b>M</b> 升高架、<b>N</b> 升隧道，再按 M／N 返回地面。高架／隧道可跨水穿山。</p>
      <dl class="tip-rows">
        ${row('操作', '按住左鍵由起點拖到終點')}
        ${row('目前等級', `${gradeInfo.label} · ${formatMoney(gradeInfo.cost)}/格`)}
        ${row('地面道路', `$${formatMoney(ROAD_GRADE_INFO.surface.cost)}/格`)}
        ${row('高架橋', `$${formatMoney(ROAD_GRADE_INFO.elevated.cost)}/格 · 可跨水穿山`)}
        ${row('隧道', `$${formatMoney(ROAD_GRADE_INFO.tunnel.cost)}/格 · 可跨水穿山`)}
        ${row('快捷鍵', 'R 道路 · 拖曳時 M 高架 / N 隧道')}
        ${row('取消', '右鍵或 Esc')}
      </dl>
    `;
  }
  if (tool === 'dezone') {
    return `
      <div class="tip-head">
        <span class="tip-icon tool">${ico('eraser')}</span>
        <div class="tip-title"><b>取消分區</b><em>分區工具 · 清除色塊</em></div>
      </div>
      <p class="tip-desc">清除格上的分區顏色，退還一半劃區費。已建成的建築不受影響；若想清拆建築請用「拆卸」。</p>
      <dl class="tip-rows">
        ${row('操作', '按住左鍵拖曳清除')}
        ${row('快捷鍵', 'M')}
        ${row('取消', '右鍵或 Esc')}
      </dl>
    `;
  }
  return `
    <div class="tip-head">
      <span class="tip-icon tool danger">${ico('hammer')}</span>
      <div class="tip-title"><b>拆卸</b><em>工程 · 退還 ${Math.round(DEMOLISH_REFUND_RATE * 100)}%</em></div>
    </div>
    <p class="tip-desc">拆去建築、馬路或分區。建築拆卸後退還三成造價；道路與分區不設退還。</p>
    <dl class="tip-rows">
      ${row('操作', '點擊要拆卸的建築或道路')}
      ${row('快捷鍵', 'X')}
      ${row('取消', '右鍵或 Esc')}
    </dl>
  `;
}

/** hover 說明：鐵路工具 */
function railTip(grade: 'surface' | 'elevated' | 'underground' | 'remove'): string {
  if (grade === 'remove') {
    return `
      <div class="tip-head">
        <span class="tip-icon tool danger">${ico('hammer')}</span>
        <div class="tip-title"><b>拆除鐵路</b><em>鐵路工具 · 退還 30%</em></div>
      </div>
      <p class="tip-desc">拆除地面／高架／地下鐵路軌道，退還三成造價；已接駁的車站會即時重新計算鐵路網。</p>
      <dl class="tip-rows">
        ${row('操作', '拖曳或點擊要拆除的鐵路')}
        ${row('取消', '右鍵或 Esc')}
      </dl>`;
  }
  const info = RAIL_INFO[grade];
  return `
    <div class="tip-head">
      <span class="tip-icon tool" style="color:${info.color}">${ico(grade === 'surface' ? 'rail' : grade === 'elevated' ? 'railElevated' : 'railUnderground')}</span>
      <div class="tip-title"><b>${info.name}</b><em>鐵路工具 · ${formatMoneyShort(info.cost)}/格</em></div>
    </div>
    <p class="tip-desc">${info.description}</p>
    <dl class="tip-rows">
      ${row('造價', `${formatMoney(info.cost)} / 格`)}
      ${row('維護', `$${info.upkeep}/格 / 月`)}
      ${row('跨水', info.overWater ? '可以（跨海／穿山）' : '不可跨水／山地')}
      ${row('最長', `一次過 ${RAIL_CONFIG.maxPlanLength} 格（可分段）`)}
      ${grade === 'underground' ? row('圖層', '按 U 地下層顯示') : ''}
      ${row('取消', '右鍵或 Esc')}
    </dl>`;
}

export function createBuildPanel(container: HTMLElement, store: GameStore, actions: GameActions): BuildPanelView {
  const root = document.createElement('aside');
  root.className = 'build-panel';
  root.id = 'build-panel';
  root.innerHTML = `
    <div class="panel-glow" aria-hidden="true"></div>
    <header class="panel-head">
      <div class="panel-heading">
        ${sealHtml('建', 'panel-seal')}
        <div class="panel-heading-text">
          <h2 class="panel-title">建造</h2>
          <small class="panel-sub">BUILD · 分區城市建設</small>
        </div>
      </div>
      <div class="panel-head-actions">
        <button type="button" class="zone-toggle icon-only" data-act="toggle-underground" title="地下管網（U）" aria-label="地下管網">
          ${ico('pipe')}
        </button>
        <button type="button" class="zone-toggle icon-only" data-act="toggle-utility" title="公用設施面板" aria-label="公用設施面板">
          ${ico('gauge')}
        </button>
        <button type="button" class="zone-toggle" data-act="toggle-zones" title="顯示／隱藏分區色塊（L）" aria-label="顯示分區色塊">
          ${ico('layers')}<span>分區</span>
        </button>
        <button type="button" class="collapse-btn" data-act="collapse" data-panel="build" title="收合面板">${ico('chevronLeft')}</button>
      </div>
    </header>

    <div class="build-body-scroll">
    <div class="zone-block">
      <div class="tools-label"><span>分區 ZONING</span><span class="tools-pop" data-k="demandHint">按需求劃區</span></div>
      <div class="zone-grid">
        ${ZONE_ORDER.map((zone) => {
          const def = ZONES[zone];
          return `
            <button type="button" class="zone-brush" data-act="zone" data-zone="${zone}" data-tip="z:${zone}"
              style="--zone:${def.colorHex}" title="${esc(def.name)} · 每格 ${formatMoney(def.costPerTile)}（${ZONE_KEYS[zone]}）">
              <span class="zb-top">
                <span class="zb-icon">${ico(ZONE_ICONS[zone])}</span>
                <kbd>${ZONE_KEYS[zone]}</kbd>
              </span>
              <b class="zb-name">${esc(def.name)}</b>
              <span class="zb-cost">${formatMoneyShort(def.costPerTile)}/格</span>
              <span class="zb-demand" data-k="demand-${zone}">需求 —</span>
            </button>`;
        }).join('')}
      </div>
      <div class="tool-row zone-tools">
        <button type="button" class="tool-card" data-act="tool" data-tool="road" data-tip="tool:road">
          <span class="tool-ico">${ico('road')}</span>
          <span class="tool-meta"><b>道路</b><small>拖曳自動鋪路 · ${formatMoneyShort(ROAD_COST)}/格起</small></span>
          <kbd>R</kbd>
        </button>
        <button type="button" class="tool-card" data-act="tool" data-tool="dezone" data-tip="tool:dezone">
          <span class="tool-ico">${ico('eraser')}</span>
          <span class="tool-meta"><b>取消分區</b><small>清除色塊 · 退 50%</small></span>
          <kbd>M</kbd>
        </button>
        <button type="button" class="tool-card tool-danger" data-act="tool" data-tool="demolish" data-tip="tool:demolish">
          <span class="tool-ico">${ico('hammer')}</span>
          <span class="tool-meta"><b>拆卸</b><small>退還 ${Math.round(DEMOLISH_REFUND_RATE * 100)}%</small></span>
          <kbd>X</kbd>
        </button>
      </div>
    </div>

    <div class="rail-block">
      <div class="tools-label">
        <span>鐵路 RAIL</span>
        <span class="tools-right"><span class="tools-pop">地面 · 高架 · 地下</span>
          <button type="button" class="rail-collapse" data-act="rail-toggle" title="收起／展開鐵路工具" aria-expanded="true">${ico('chevronLeft')}</button>
        </span>
      </div>
      <div class="rail-grid">
        ${(['surface', 'elevated', 'underground'] as const)
          .map((grade) => {
            const info = RAIL_INFO[grade];
            const icon = grade === 'surface' ? 'rail' : grade === 'elevated' ? 'railElevated' : 'railUnderground';
            return `
              <button type="button" class="rail-card" data-act="tool" data-tool="rail:${grade}" data-tip="r:${grade}"
                style="--rail:${info.color}" title="${info.name} · ${formatMoney(info.cost)}/格 · 維護 $${info.upkeep}/月">
                <span class="rail-ico">${ico(icon)}</span>
                <span class="rail-meta"><b>${info.name}</b><small>${formatMoneyShort(info.cost)}/格 · $${info.upkeep}/月</small></span>
                <em class="rail-badge">${info.overWater ? '可跨水' : '不可跨水'}</em>
              </button>`;
          })
          .join('')}
        <button type="button" class="rail-card danger" data-act="tool" data-tool="rail:remove" data-tip="r:remove"
          title="拆除鐵路（退還 30%）">
          <span class="rail-ico">${ico('hammer')}</span>
          <span class="rail-meta"><b>拆除鐵路</b><small>退還 30% 造價</small></span>
        </button>
      </div>
      <p class="rail-hint">地圖拖曳鋪軌（最長一次過 ${RAIL_CONFIG.maxPlanLength} 格）· 地下鐵路按 <kbd>U</kbd> 顯示 · mtrStation 要貼近軌道先接駁</p>
    </div>

    <div class="build-tabs-wrap">
      <div class="tools-label"><span>公共建築 · 手動建造</span><span class="tools-pop" data-k="plopCount"></span></div>
      <div class="category-tabs" role="tablist" aria-label="可手動建造的建築分類">
        ${CATEGORIES.map(
          ([key, info]) =>
            `<button type="button" role="tab" data-act="category" data-cat="${key}" data-tab="${key}" style="--cat:${info.color}">${esc(info.name)}</button>`,
        ).join('')}
    </div>
    </div>

    <div class="build-scroll">
      <div class="build-list" data-k="list"></div>
    </div>

    </div>

    <div class="build-tools">
      <button type="button" class="cancel-tool" data-act="tool" data-tool="none" hidden>
        ${ico('close')}<span>取消工具</span><kbd>Esc</kbd>
      </button>
      <p class="tools-hint" data-k="hint">選擇分區刷子或馬路，在地圖上拖曳</p>
    </div>
  `;
  container.appendChild(root);

  const listEl = qs<HTMLElement>(root, '[data-k="list"]')!;
  const demandHintEl = qs<HTMLElement>(root, '[data-k="demandHint"]')!;
  const plopCountEl = qs<HTMLElement>(root, '[data-k="plopCount"]')!;
  const hintEl = qs<HTMLElement>(root, '[data-k="hint"]')!;
  const cancelBtn = qs<HTMLElement>(root, '.cancel-tool')!;
  const tabButtons = qsa<HTMLElement>(root, '[data-tab]');
  const roadBtn = qs<HTMLElement>(root, '[data-tool="road"]')!;
  const dezoneBtn = qs<HTMLElement>(root, '[data-tool="dezone"]')!;
  const demolishBtn = qs<HTMLElement>(root, '[data-tool="demolish"]')!;
  const zoneToggleBtn = qs<HTMLElement>(root, '[data-act="toggle-zones"]')!;
  const undergroundBtn = qs<HTMLElement>(root, '[data-act="toggle-underground"]')!;
  const utilityBtn = qs<HTMLElement>(root, '[data-act="toggle-utility"]')!;
  const railButtons = Array.from(root.querySelectorAll<HTMLElement>('[data-tool^="rail:"]'));
  const railBlock = qs<HTMLElement>(root, '.rail-block')!;
  const railToggleBtn = qs<HTMLElement>(root, '[data-act="rail-toggle"]')!;
  let railCollapsed = false;
  const zoneButtons = new Map<ZoneType, { btn: HTMLElement; demand: HTMLElement }>();
  for (const zone of ZONE_ORDER) {
    const btn = qs<HTMLElement>(root, `[data-zone="${zone}"]`);
    const demand = qs<HTMLElement>(root, `[data-k="demand-${zone}"]`);
    if (btn && demand) zoneButtons.set(zone, { btn, demand });
  }

  /** 若存檔／舊局留下的 buildCategory 不是 ploppable 分類，退回公共 */
  const ensureCategory = (state: GameState): BuildingCategory => {
    const category = state.ui.buildCategory;
    if (PLOPPABLE_CATEGORIES.includes(category)) return category;
    state.ui.buildCategory = CATEGORIES[0]?.[0] ?? 'civic';
    return state.ui.buildCategory;
  };
  ensureCategory(store.state);

  // ── hover 說明框 ──
  const tip = document.createElement('div');
  tip.className = 'build-tooltip';
  tip.setAttribute('aria-hidden', 'true');
  container.appendChild(tip);
  const tipCache = new Map<string, string>();
  let tipKey = '';

  const positionTip = (card: HTMLElement): void => {
    const rect = card.getBoundingClientRect();
    const height = tip.offsetHeight || 260;
    const top = clamp(rect.top - 10, 76, Math.max(76, window.innerHeight - height - 14));
    tip.style.top = `${top}px`;
    tip.style.left = `${Math.min(rect.right + 12, window.innerWidth - 330)}px`;
  };

  const showTip = (card: HTMLElement, key: string): void => {
    if (!key) return;
    let html = tipCache.get(key);
    if (!html) {
      if (key.startsWith('tool:')) html = toolTip(key.slice(5), roadGradeOf(store.state));
      else if (key.startsWith('r:')) html = railTip(key.slice(2) as 'surface' | 'elevated' | 'underground' | 'remove');
      else if (key.startsWith('z:')) html = zoneTip(key.slice(2) as ZoneType);
      else html = buildTip(BUILDINGS[key.slice(2)]);
      tipCache.set(key, html);
    }
    tip.innerHTML = html;
    tip.classList.add('show');
    positionTip(card);
    if (window.innerWidth > 760 && window.innerWidth < 980) {
      const rect = card.getBoundingClientRect();
      const h = tip.offsetHeight || 260;
      tip.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 330))}px`;
      tip.style.top = `${Math.min(window.innerHeight - h - 10, rect.bottom + 10)}px`;
    }
  };

  const hideTip = (): void => {
    tipKey = '';
    tip.classList.remove('show');
  };

  const offMove = delegate(root, 'pointermove', '[data-tip]', (card) => {
    const key = card.dataset.tip ?? '';
    if (key === tipKey) return;
    tipKey = key;
    showTip(card, key);
  });
  const offLeave = delegate(root, 'pointerleave', '[data-tip]', () => hideTip());
  const onRootLeave = (): void => hideTip();
  root.addEventListener('pointerleave', onRootLeave);
  const onListScroll = (): void => hideTip();
  listEl.addEventListener('scroll', onListScroll, { passive: true });

  // ── 點擊 ──
  const offClick = delegate(root, 'click', '[data-act]', (node) => {
    const act = node.dataset.act;
    if (act === 'category') {
      const cat = node.dataset.cat as BuildingCategory | undefined;
      if (!cat) return;
      store.state.ui.buildCategory = cat;
      store.bumpUI();
      hideTip();
      return;
    }
    if (act === 'zone') {
      const zone = node.dataset.zone as ZoneType | undefined;
      if (!zone) return;
      const tool = zoneTool(zone);
      actions.setTool(store.state.ui.tool === tool ? null : tool);
      return;
    }
    if (act === 'build') {
      const key = node.dataset.key;
      if (!key) return;
      const def = BUILDINGS[key];
      if (!def) return;
      if (store.state.stats.population < def.unlockPop) {
        store.toast(`人口達到 ${num(def.unlockPop)} 後解鎖「${def.name}」`, 'warn');
        return;
      }
      actions.setTool(store.state.ui.tool === key ? null : key);
      return;
    }
    if (act === 'rail-toggle') {
      railCollapsed = !railCollapsed;
      setClass(railBlock, 'collapsed', railCollapsed);
      railToggleBtn.setAttribute('aria-expanded', String(!railCollapsed));
      setClass(railToggleBtn, 'collapsed', railCollapsed);
      return;
    }
    if (act === 'toggle-zones') {
      actions.toggleZones();
      return;
    }
    if (act === 'toggle-underground') {
      toggleUnderground(store, actions);
      return;
    }
    if (act === 'toggle-utility') {
      toggleUtilityPanel(store, actions);
      return;
    }
    if (act === 'tool') {
      const tool = node.dataset.tool ?? '';
      if (tool === 'none') {
        actions.setTool(null);
        return;
      }
      actions.setTool(store.state.ui.tool === tool ? null : tool);
    }
  });

  // ── 更新（差異比對） ──
  const cardMap = new Map<string, HTMLElement>();
  let lastCategory: BuildingCategory | null = null;
  let lastUnlockSig = '';
  let lastRenderedCategory: BuildingCategory | null = null;
  let lastTool = '';
  const lastZoneTone: Record<ZoneType, string> = {
    residential: '',
    commercial: '',
    industrial: '',
    farmland: '',
  };

  const popUnlockSig = (state: GameState): string => {
    let sig = '';
    for (const def of PLOPPABLE_BUILDINGS) sig += state.stats.population >= def.unlockPop ? '1' : '0';
    sig += `|${Math.floor(state.finance.treasury / 20000)}`;
    return sig;
  };

  const renderList = (state: GameState): void => {
    const category = state.ui.buildCategory;
    const population = state.stats.population;
    const defs = buildingsOf(category);
    cardMap.clear();
    listEl.innerHTML = defs
      .map((def) => {
        const locked = population < def.unlockPop;
        const active = store.state.ui.tool === def.key;
        const poor = !locked && state.finance.treasury < def.cost;
        const side = locked
          ? `<span class="b-lock" title="人口 ${num(def.unlockPop)} 解鎖">${ico('lock')}${num(def.unlockPop)}</span>`
          : `<span class="b-cost${poor ? ' poor' : ''}" title="${poor ? '庫房不足，仍可先選取查看' : ''}">${formatMoneyShort(def.cost)}</span>${poor ? '<span class="b-short">庫房不足</span>' : ''}`;
        return `
          <button type="button" class="build-card${locked ? ' locked' : ''}${active ? ' active' : ''}"
            data-act="build" data-key="${def.key}" data-tip="b:${def.key}"
            aria-pressed="${active}" ${locked ? 'aria-disabled="true"' : ''}>
            <span class="b-icon" style="--c:${hexColor(def.color)}">${buildingGlyph(def.key, def.name)}</span>
            <span class="b-main">
              <span class="b-name">${esc(def.name)}</span>
              <small>${esc(cardSubtitle(def))}</small>
            </span>
            <span class="b-side">${side}</span>
          </button>`;
      })
      .join('');
    for (const card of qsa<HTMLElement>(listEl, '.build-card')) {
      const key = card.dataset.key;
      if (key) cardMap.set(key, card);
    }
    lastRenderedCategory = category;
  };

  const zoneDemandOf = (state: GameState, zone: ZoneType): number =>
    state.stats?.zoneDemand?.[zone] ?? state.zoneDemand?.[zone] ?? 0;

  const update = (state: GameState): void => {
    const ui = state.ui;
    const category = ensureCategory(state);

    if (category !== lastCategory) {
      lastCategory = category;
      for (const tab of tabButtons) setClass(tab, 'active', tab.dataset.tab === category);
    }

    const unlockSig = popUnlockSig(state);
    if (lastRenderedCategory !== category || unlockSig !== lastUnlockSig) {
      lastUnlockSig = unlockSig;
      renderList(state);
    } else {
      for (const [key, card] of cardMap) setClass(card, 'active', ui.tool === key);
    }

    // 分區刷子：啟用 / 需求顯示
    const activeZone = zoneOfTool(ui.tool);
    for (const zone of ZONE_ORDER) {
      const refs = zoneButtons.get(zone);
      if (!refs) continue;
      setClass(refs.btn, 'active', activeZone === zone);
      const demand = zoneDemandOf(state, zone);
      const level = Math.round(demand * 100);
      const tone = demand >= 0.2 ? 'high' : demand <= -0.2 ? 'low' : 'mid';
      if (tone !== lastZoneTone[zone]) {
        lastZoneTone[zone] = tone;
        setClass(refs.demand, 'high', tone === 'high');
        setClass(refs.demand, 'low', tone === 'low');
      }
      setText(refs.demand, `需求 ${level > 0 ? '+' : ''}${level}%`);
      refs.btn.title = `${ZONES[zone].name} · 每格 ${formatMoney(ZONES[zone].costPerTile)}（${ZONE_KEYS[zone]}）· 需求 ${level > 0 ? '+' : ''}${level}%`;
    }
    setText(plopCountEl, `${PLOPPABLE_BUILDINGS.length} 種`);
    setClass(zoneToggleBtn, 'active', ui.showZones);
    setClass(undergroundBtn, 'active', Boolean(ui.showUnderground));
    setClass(utilityBtn, 'active', Boolean(ui.showUtilityPanel));

    setClass(roadBtn, 'active', ui.tool === 'road');
    setClass(dezoneBtn, 'active', ui.tool === 'dezone');
    setClass(demolishBtn, 'active', ui.tool === 'demolish');
    for (const btn of railButtons) setClass(btn, 'active', ui.tool === btn.dataset.tool);
    setClass(railBlock, 'collapsed', railCollapsed);
    setHidden(cancelBtn, !ui.tool);

    let hint = '選擇分區刷子或馬路，在地圖上拖曳';
    if (ui.tool) {
      const zone = zoneOfTool(ui.tool);
      if (zone) hint = `劃分${ZONES[zone].name}：拖曳連續劃區 · 每格 ${formatMoney(ZONES[zone].costPerTile)} · 右鍵取消`;
      else if (ui.tool === 'road') {
        const grade = roadGradeOf(state);
        const gradeInfo = ROAD_GRADE_INFO[grade] ?? ROAD_GRADE_INFO.surface;
        hint = `道路（${gradeInfo.label} · ${formatMoney(gradeInfo.cost)}/格）：由起點拖到終點自動鋪路 · 拖曳時 M 高架 / N 隧道（再按返回地面）· 右鍵取消`;
      }
      else if (ui.tool === 'dezone') hint = '取消分區：拖曳清除色塊（退 50%）· 右鍵取消';
      else if (ui.tool === 'demolish') hint = '拆卸：點擊建築／道路 · 建築退還 30%';
      else if (ui.tool.startsWith('rail:')) {
        const grade = ui.tool.slice(5);
        hint =
          grade === 'remove'
            ? `拆除鐵路：拖曳／點擊軌道 · 退還 30% · 車站會即時重算`
            : `鋪設${RAIL_INFO[grade as 'surface' | 'elevated' | 'underground']?.name ?? '鐵路'}：拖曳連續鋪軌 · ${
                RAIL_INFO[grade as 'surface' | 'elevated' | 'underground']?.overWater ? '可跨水／穿山' : '不可跨水'
              } · 右鍵取消`;
      } else hint = `放置「${BUILDINGS[ui.tool]?.name ?? ''}」· 點擊地圖放置`;
    }
    setText(hintEl, hint);

    const tool = ui.tool ?? '';
    if (tool !== lastTool) {
      lastTool = tool;
      hideTip();
    }
  };

  return {
    update,
    destroy(): void {
      offClick();
      offMove();
      offLeave();
      root.removeEventListener('pointerleave', onRootLeave);
      listEl.removeEventListener('scroll', onListScroll);
      root.remove();
      tip.remove();
    },
  };
}
