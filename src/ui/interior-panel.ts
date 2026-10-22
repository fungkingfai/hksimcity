/**
 * 《維港之城》— 室內模式資訊面板（interiors-dev）
 *
 * 玩家進入任何建築室內時，畫面下方顯示這棟建築的「體檢報告」：
 *   - 建築名／類型／座標／落成日期／等級
 *   - 營運狀態：道路連通、營運中、工人／居民、庫存、生產進度
 *   - 香港資源庫存（食品 food／日用品 goods／電子產品 electronics／建材 materials）
 *   - 本月帳目（收入／支出／淨額）
 *   - 服務狀態與覆蓋：服務半徑內建築數與受惠居民（街市／學校／醫院／警署／
 *     消防局／公園／海濱）、公用設施（電力／食水）覆蓋、公共交通（港鐵／巴士／
 *     電車／渡輪）票價與容量、颱風停航提示
 *   - 居民／員工名單：姓名、年齡、月薪、通勤方式（港鐵／巴士／電車／渡輪／步行）
 *   - 「返回城市」與「拆除此建築」按鈕
 *
 * 對外簽名與舊版一致（ui.ts 不需修改）：
 *   createInteriorPanel(container, store, actions): InteriorPanelView
 *   InteriorPanelView { update(state), destroy() }
 *
 * 註：本檔只依賴 core/config、core/types、core/store 的型別，不依賴 ui/icons 或
 * ui/dom；DOM class 沿用 src/ui/css/interior.css 既有命名（由 ui-dev 重繪霓虹港風）。
 */

import {
  BUILDINGS,
  CATEGORY_INFO,
  RESOURCE_KEYS,
  RESOURCES,
  SERVICE_NAMES,
  TRANSIT_INFO,
  formatMoney,
  formatMoneyShort,
} from '../core/config';
import type { Building, BuildingDef, Citizen, GameActions, GameState } from '../core/types';
import type { GameStore } from '../core/store';

export interface InteriorPanelView {
  update(state: GameState): void;
  destroy(): void;
}

/** 列表最多顯示幾個人名（其餘以 +N 表示）。 */
const MAX_NAMES = 8;

// ─────────────────────────── 小工具 ───────────────────────────

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hexColor(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`;
}

function dateLabel(state: GameState): string {
  const c = state.clock;
  return `${c.year}年${c.month}月${c.day}日`;
}

function amount(value: number): string {
  const v = Math.round(value * 10) / 10;
  return v.toLocaleString('zh-HK');
}

const COMMUTE_LABEL: Record<string, { name: string; emoji: string }> = {
  mtr: { name: '港鐵', emoji: '🚇' },
  bus: { name: '巴士', emoji: '🚌' },
  tram: { name: '電車', emoji: '🚋' },
  ferry: { name: '渡輪', emoji: '⛴️' },
  walk: { name: '步行', emoji: '🚶' },
};

function commuteLabel(mode: string): string {
  const info = COMMUTE_LABEL[mode];
  return info ? `${info.emoji}${info.name}` : mode;
}

function citizenById(state: GameState, id: number): Citizen | undefined {
  return state.citizens.find((c) => c.id === id);
}

/** 姓名＋年齡＋月薪＋通勤方式的小名牌。 */
function personPill(state: GameState, id: number): string {
  const c = citizenById(state, id);
  if (!c) {
    return `<span class="person" title="已遷出"><span class="muted">（已遷出）</span></span>`;
  }
  const salary = c.workId >= 0 && c.salary > 0 ? `${formatMoneyShort(c.salary)}/月` : '待業';
  const sub = `${c.age} 歲 · ${salary} · ${commuteLabel(c.commuteMode)}`;
  return `<span class="person" title="${esc(c.name)} · ${esc(sub)}">${esc(c.name)}<small>${esc(sub)}</small></span>`;
}

/** 資源小章（沿用 .res-chip CSS；色由 --res 提供）。 */
function resourceChip(key: string, value: number): string {
  const def = RESOURCES[key as keyof typeof RESOURCES];
  if (!def) return '';
  return (
    `<span class="res-chip" style="--res:${def.color}" title="${esc(def.name)}">` +
    `<i class="res-sq">${esc(def.short)}</i><b>${amount(value)}</b><em>${esc(def.name)}</em></span>`
  );
}

function resourceChips(inventory: Partial<Record<string, number>>): string {
  const chips = RESOURCE_KEYS.map((key) => resourceChip(key, inventory[key] ?? 0)).join('');
  return chips || `<span class="muted">空空如也</span>`;
}

function noteRow(label: string, value: string): string {
  return `<div class="note-row"><span>${esc(label)}</span><b>${value}</b></div>`;
}

// ─────────────────────────── 資料整理 ───────────────────────────

/** 建築中心格座標。 */
function center(b: Building): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function distance(a: Building, b: Building): number {
  const ca = center(a);
  const cb = center(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}

/** 服務／公用設施／交通覆蓋：半徑內的建築數與居民數。 */
function coverageInfo(state: GameState, building: Building, def: BuildingDef): { radius: number; buildings: number; population: number } | null {
  const radius = def.service?.radius ?? def.utility?.radius ?? def.transit?.radius;
  if (!radius) return null;
  let buildings = 0;
  let population = 0;
  for (const other of state.buildings) {
    if (other.id === building.id) continue;
    if (distance(building, other) > radius) continue;
    buildings += 1;
    population += other.residents.length;
  }
  return { radius, buildings, population };
}

/** 服務狀態 pill。 */
function statusPills(state: GameState, building: Building, def: BuildingDef): string {
  const pills: string[] = [];
  if (building.connected) pills.push('<span class="pill ok">道路連通</span>');
  else if (def.needsRoad === false) pills.push('<span class="pill">無需臨路</span>');
  else pills.push('<span class="pill warn">未連道路</span>');
  if (def.workers > 0) {
    const enough = building.workers.length >= def.workers;
    pills.push(
      `<span class="pill${enough ? ' ok' : building.workers.length > 0 ? '' : ' warn'}">職員 ${building.workers.length}/${def.workers}</span>`,
    );
  }
  if (def.housing > 0) {
    pills.push(`<span class="pill">住戶 ${building.residents.length}/${def.housing}</span>`);
  }
  if (def.production || def.service || def.storage || def.utility) {
    pills.push(`<span class="pill ${building.active ? 'ok' : 'warn'}">${building.active ? '營運中' : '停擺'}</span>`);
  }
  const transit = def.transit;
  if (transit && transit.mode === 'ferry' && state.transit.suspended) {
    pills.push('<span class="pill warn">颱風停航</span>');
  }
  if (def.utility) {
    pills.push(`<span class="pill">${def.utility.kind === 'power' ? '供電中' : '供水正常'}</span>`);
  }
  return pills.join('');
}

/** 定義資料列（產出／投入／服務／倉儲／交通／公用）。 */
function defRows(def: BuildingDef, state: GameState): string {
  const rows: string[] = [];
  rows.push(noteRow('用途', `${esc(CATEGORY_INFO[def.category].name)} · ${def.size[0]}×${def.size[1]} 格`));
  rows.push(noteRow('每月維護', formatMoney(def.upkeep)));
  if (def.housing > 0) rows.push(noteRow('可住人口', `${def.housing} 人`));
  if (def.workers > 0) rows.push(noteRow('職位', `${def.workers} 個`));
  if (def.production) {
    const prod = def.production;
    const out = `${RESOURCES[prod.output]?.name ?? prod.output} ${prod.amountPerDay}/日`;
    rows.push(noteRow('每日產出', esc(out)));
    if (prod.input) rows.push(noteRow('每日投入', esc(`${RESOURCES[prod.input.resource]?.name ?? prod.input.resource} ${prod.input.amountPerDay}`)));
  }
  if (def.storage) {
    const accepted =
      def.storage.accepted === 'all'
        ? '全部資源'
        : def.storage.accepted.map((k) => RESOURCES[k]?.name ?? k).join('、');
    rows.push(noteRow('倉儲', `容量 ${def.storage.capacity} · ${esc(accepted)}`));
  }
  const service = def.service;
  if (service) {
    const bits = [`${SERVICE_NAMES[service.kind] ?? service.kind}`];
    if (service.radius) bits.push(`半徑 ${service.radius} 格`);
    if (service.happiness) bits.push(`民心 +${service.happiness}`);
    if (service.capacity) bits.push(`容量 ${service.capacity}`);
    if (service.incomePerDay) bits.push(`收入 ${formatMoneyShort(service.incomePerDay)}/日`);
    if (service.consumes) {
      bits.push(`消耗 ${RESOURCES[service.consumes.resource]?.name ?? service.consumes.resource} ${service.consumes.amountPerDay}/日`);
    }
    rows.push(noteRow('服務', esc(bits.join(' · '))));
  }
  const transit = def.transit;
  if (transit) {
    const info = TRANSIT_INFO[transit.mode];
    rows.push(
      noteRow(
        '公共交通',
        esc(`${info.emoji}${info.name} · 半徑 ${transit.radius} 格 · 每程 ${formatMoney(transit.fare)} · 每日容量 ${transit.capacity}`),
      ),
    );
    if (transit.mode === 'ferry' && state.transit.suspended) {
      rows.push(noteRow('颱風安排', '八號風球 · 渡輪停航'));
    }
  }
  if (def.utility) {
    const util = def.utility;
    rows.push(noteRow(util.kind === 'power' ? '供電' : '供水', `半徑 ${util.radius} 格 · 供應容量 ${util.capacity} 人`));
  }
  if (def.needsWater) rows.push(noteRow('選址', '需臨水而建'));
  return rows.join('');
}

/** 服務覆蓋列。 */
function coverageRows(state: GameState, building: Building, def: BuildingDef): string {
  const rows: string[] = [];
  const info = coverageInfo(state, building, def);
  if (info) {
    rows.push(noteRow('服務覆蓋', `${info.radius} 格內 ${info.buildings} 棟建築 · ${info.population} 名居民`));
  }
  if (def.service?.kind === 'school') rows.push(noteRow('學額', `已收 ${Math.min(def.service.capacity ?? 0, info?.population ?? 0)} 名學生`));
  if (def.service?.kind === 'hospital') rows.push(noteRow('病床', `已用 ${Math.min(def.service.capacity ?? 0, Math.round((info?.population ?? 0) * 0.06))} 張`));
  return rows.join('');
}

// ─────────────────────────── 面板主體 ───────────────────────────

export function createInteriorPanel(container: HTMLElement, _store: GameStore, actions: GameActions): InteriorPanelView {
  const layer = document.createElement('div');
  layer.className = 'interior-layer';
  layer.innerHTML = '';
  container.appendChild(layer);

  let currentId: number | null = null;
  let lastSig = '';
  let pendingDemolish: number | null = null;
  let pendingTimer = 0;
  let lastProgWidth = -1;

  const clearPending = (): void => {
    pendingDemolish = null;
    if (pendingTimer) window.clearTimeout(pendingTimer);
    pendingTimer = 0;
  };

  const onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const node = target?.closest<HTMLElement>('[data-act]');
    if (!node) return;
    const act = node.dataset.act;
    if (act === 'exit-interior') {
      actions.exitInterior();
      return;
    }
    if (act === 'demolish-interior') {
      const id = Number(node.dataset.id);
      if (!Number.isFinite(id)) return;
      pendingDemolish = id;
      lastSig = '';
      if (pendingTimer) window.clearTimeout(pendingTimer);
      pendingTimer = window.setTimeout(() => {
        pendingDemolish = null;
        pendingTimer = 0;
        lastSig = '';
      }, 4500);
      return;
    }
    if (act === 'demolish-interior-confirm') {
      const id = Number(node.dataset.id);
      clearPending();
      lastSig = '';
      if (Number.isFinite(id)) actions.demolishBuilding(id);
      return;
    }
    if (act === 'demolish-interior-cancel') {
      clearPending();
      lastSig = '';
    }
  };
  layer.addEventListener('click', onClick);

  const hide = (): void => {
    if (currentId === null) return;
    currentId = null;
    lastSig = '';
    pendingDemolish = null;
    layer.classList.remove('show');
    layer.innerHTML = '';
  };

  const signature = (state: GameState, building: Building, def: BuildingDef): string => {
    const inv = RESOURCE_KEYS.map((key) => `${key}:${Math.round((building.inventory[key] ?? 0) * 10)}`).join(',');
    return [
      building.id,
      def.key,
      state.clock.day,
      state.clock.month,
      state.clock.weather,
      state.transit.suspended ? 1 : 0,
      building.connected ? 1 : 0,
      building.active ? 1 : 0,
      building.workers.join('.'),
      building.residents.join('.'),
      inv,
      Math.round(building.incomeThisMonth),
      Math.round(building.expenseThisMonth),
      pendingDemolish === building.id ? 1 : 0,
    ].join('|');
  };

  const render = (state: GameState, building: Building, def: BuildingDef): void => {
    const cat = CATEGORY_INFO[def.category];
    const residents = building.residents;
    const workers = building.workers;
    const shownResidents = residents.slice(0, MAX_NAMES).map((id) => personPill(state, id)).join('');
    const shownWorkers = workers.slice(0, MAX_NAMES).map((id) => personPill(state, id)).join('');
    const moreResidents = residents.length > MAX_NAMES ? `<span class="muted">＋${residents.length - MAX_NAMES} 人</span>` : '';
    const moreWorkers = workers.length > MAX_NAMES ? `<span class="muted">＋${workers.length - MAX_NAMES} 人</span>` : '';
    const net = building.incomeThisMonth - building.expenseThisMonth;
    const progress = def.production
      ? `<div class="prog-row"><span>生產進度</span><div class="prog-bar"><i data-k="prog"></i></div></div>`
      : '';
    const demolishArea =
      pendingDemolish === building.id
        ? `<div class="confirm-inline"><span>確定拆除？</span>` +
          `<button type="button" class="danger" data-act="demolish-interior-confirm" data-id="${building.id}">確定拆除</button>` +
          `<button type="button" data-act="demolish-interior-cancel">取消</button></div>`
        : `<button type="button" class="danger-outline" data-act="demolish-interior" data-id="${building.id}">拆除此建築</button>`;

    const peopleCols =
      def.housing > 0 || def.workers > 0
        ? `
          ${
            def.housing > 0
              ? `<div class="section-label">住戶 <span class="mini">${residents.length}/${def.housing}</span></div>
                 <div class="people">${shownResidents || '<span class="muted">尚無住戶</span>'}${moreResidents}</div>`
              : ''
          }
          ${
            def.workers > 0
              ? `<div class="section-label">職員 <span class="mini">${workers.length}/${def.workers}</span></div>
                 <div class="people">${shownWorkers || '<span class="muted">尚無職員</span>'}${moreWorkers}</div>`
              : ''
          }
        `
        : `<div class="section-label">人煙</div><div class="people"><span class="muted">此處無人常駐</span></div>`;

    layer.innerHTML = `
      <div class="interior-plaque" aria-hidden="true">
        <span>${esc(def.name)}</span>
        <small>${esc(cat.name)} · 室內</small>
      </div>
      <div class="interior-card">
        <header class="interior-head">
          <div class="interior-title">
            <span class="interior-seal" style="--c:${hexColor(def.color)}">${esc(def.name.slice(0, 1))}</span>
            <div class="interior-title-text">
              <b>${esc(def.name)}</b>
              <div class="interior-meta-line">
                <span class="badge">${esc(cat.name)}</span>
                <small>${building.w}×${building.h} 格 · ${esc(dateLabel(state))} · Lv.${building.level}</small>
              </div>
            </div>
          </div>
          <div class="interior-actions">
            <button type="button" class="primary" data-act="exit-interior">← 返回城市<kbd>Esc</kbd></button>
          </div>
        </header>

        <div class="interior-body">
          <div class="interior-main">
            <p class="interior-desc">${esc(def.desc)}</p>
            <div class="status-row">${statusPills(state, building, def)}</div>
            <div class="def-notes">${defRows(def, state)}${coverageRows(state, building, def)}</div>
            ${progress}
          </div>

          <div class="interior-col">
            <div class="section-label">室內庫存</div>
            <div class="res-wrap">${resourceChips(building.inventory)}</div>
            <div class="section-label">本月帳目</div>
            <div class="finance-line finance-line-col">
              <span>收入 <b>${formatMoney(building.incomeThisMonth)}</b></span>
              <span>支出 <b>${formatMoney(building.expenseThisMonth)}</b></span>
              <span>淨額 <b class="${net >= 0 ? 'ok' : 'warn'}">${formatMoney(net)}</b></span>
            </div>
            ${
              def.production || def.storage
                ? `<div class="section-label">物流狀態</div>
                   <div class="finance-line finance-line-col">
                     <span>生產進度 <b>${Math.round(building.productionProgress * 100)}%</b></span>
                     <span>庫存上限 <b>${def.storage ? def.storage.capacity : '—'}</b></span>
                   </div>`
                : ''
            }
          </div>

          <div class="interior-col interior-people-col">
            ${peopleCols}
            <div class="section-label">社區</div>
            <div class="finance-line finance-line-col">
              <span>人口 <b>${state.stats.population} 人</b></span>
              <span>失業 <b>${state.stats.unemployed} 人</b></span>
              <span>幸福度 <b>${Math.round(state.stats.happiness)}</b></span>
            </div>
          </div>
        </div>

        <footer class="interior-foot">
          <span class="interior-note">${esc(def.name)} · 室內參觀（${esc(cat.name)}）</span>
          ${demolishArea}
        </footer>
      </div>
    `;
    lastProgWidth = -1;
    layer.classList.add('show');
  };

  const update = (state: GameState): void => {
    if (state.ui.mode !== 'interior' || state.ui.interiorId == null) {
      hide();
      return;
    }
    const id = state.ui.interiorId;
    const building = state.buildings.find((b) => b.id === id);
    const def = building ? BUILDINGS[building.key] : undefined;
    if (!building || !def) {
      hide();
      return;
    }
    currentId = id;
    const sig = signature(state, building, def);
    if (sig !== lastSig) {
      lastSig = sig;
      render(state, building, def);
    }
    if (def.production) {
      const bar = layer.querySelector<HTMLElement>('[data-k="prog"]');
      if (bar) {
        const width = Math.round(Math.max(0, Math.min(1, building.productionProgress)) * 100);
        if (width !== lastProgWidth) {
          lastProgWidth = width;
          bar.style.width = `${width}%`;
        }
      }
    }
  };

  return {
    update,
    destroy(): void {
      layer.removeEventListener('click', onClick);
      clearPending();
      layer.remove();
    },
  };
}
