/**
 * 財政面板：霓虹港風「香港財政」。
 *
 *  - 庫房結餘、上月收支、本月累計
 *  - 三條稅率滑桿：薪俸稅 0–20%、利得稅 0–25%、差餉 0–12%
 *  - 本月分類收入／支出（incomeBreakdown／expenseBreakdown）
 *  - 賣地 $250 萬（15 日冷卻）、維港煙花匯演 $80 萬（20 日冷卻）
 *  - 近月收支歷史 bar chart
 */

import {
  BASE_MONTHLY_SALARY,
  BUILDINGS,
  DEFAULT_PROFIT_TAX_RATE,
  DEFAULT_RATES_RATE,
  DEFAULT_SALARY_TAX_RATE,
  FESTIVAL_COOLDOWN_DAYS,
  FESTIVAL_COST,
  LAND_SALE_AMOUNT,
  LAND_SALE_COOLDOWN_DAYS,
  formatMoney,
  formatMoneyShort,
} from '../core/config';
import type { ExpenseKind, GameActions, GameState, IncomeKind } from '../core/types';
import type { GameStore } from '../core/store';
import { delegate, esc, num, qs, setHidden, setText } from './dom';
import { cooldownLeft, formatMonthLabel } from './format';
import { ico, sealHtml } from './icons';
import { createOverlayHost, modalShell, restoreInfoPanel, ratioBar, signedMoney } from './overlay';

export interface FinancePanelView {
  update(state: GameState): void;
  destroy(): void;
}

const INCOME_NAMES: Record<IncomeKind, string> = {
  salaryTax: '薪俸稅',
  profitTax: '利得稅',
  rates: '差餉',
  landSale: '賣地收入',
  fares: '車費收入',
  service: '服務收入',
  other: '其他收入',
};

const EXPENSE_NAMES: Record<ExpenseKind, string> = {
  upkeep: '建築維護',
  civilService: '公務員薪酬',
  welfare: '社會福利',
  infrastructure: '基建工程',
  festival: '節慶活動',
  other: '其他支出',
};

const INCOME_ORDER: IncomeKind[] = ['salaryTax', 'profitTax', 'rates', 'landSale', 'fares', 'service', 'other'];
const EXPENSE_ORDER: ExpenseKind[] = ['upkeep', 'civilService', 'welfare', 'infrastructure', 'festival', 'other'];

/** 稅率每 +1% 幸福 −0.3；回傳「−0.9」等顯示字串 */
function taxImpact(diffPct: number): string {
  if (Math.abs(diffPct) < 0.01) return '±0';
  const value = -diffPct * 0.3;
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}

interface TaxRow {
  kind: 'salary' | 'profit' | 'rates';
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  scale: [string, string, string];
}

function taxRows(state: GameState): TaxRow[] {
  const f = state.finance;
  return [
    {
      kind: 'salary',
      label: '薪俸稅',
      hint: '受僱市民月薪 × 稅率',
      value: f.salaryTaxRate * 100,
      min: 0,
      max: 20,
      step: 1,
      scale: ['0% 輕稅', '10% 標準', '20% 重稅'],
    },
    {
      kind: 'profit',
      label: '利得稅',
      hint: '商業／工業／物流利潤 × 稅率',
      value: f.profitTaxRate * 100,
      min: 0,
      max: 25,
      step: 0.5,
      scale: ['0%', '16.5% 標準', '25%'],
    },
    {
      kind: 'rates',
      label: '差餉',
      hint: '物業估值 × 差餉率',
      value: f.ratesRate * 100,
      min: 0,
      max: 12,
      step: 0.5,
      scale: ['0%', '5% 標準', '12%'],
    },
  ];
}

/** 稅率顯示：15% / 16.5% */
function taxLabel(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

/** 稅率的預設值（百分比） */
function defaultTaxPct(kind: 'salary' | 'profit' | 'rates'): number {
  if (kind === 'salary') return DEFAULT_SALARY_TAX_RATE * 100;
  if (kind === 'profit') return DEFAULT_PROFIT_TAX_RATE * 100;
  return DEFAULT_RATES_RATE * 100;
}

/** 粗略估算目前稅率下的月收入（港幣） */
function estimateMonthlyTax(state: GameState, kind: 'salary' | 'profit' | 'rates', pct: number): number {
  const f = state.finance;
  const rate = pct / 100;
  if (kind === 'salary') return state.stats.employed * BASE_MONTHLY_SALARY * rate;
  const currentRate = kind === 'profit' ? f.profitTaxRate : f.ratesRate;
  const actual = kind === 'profit' ? f.incomeBreakdown.profitTax ?? 0 : f.incomeBreakdown.rates ?? 0;
  if (currentRate <= 0.0001) return 0;
  return (actual / currentRate) * rate;
}

function totalOf<T extends string>(breakdown: Partial<Record<T, number>>, order: T[]): number {
  return order.reduce((sum, key) => sum + (breakdown[key] ?? 0), 0);
}

function breakdownRows<T extends string>(
  breakdown: Partial<Record<T, number>>,
  order: T[],
  names: Record<T, string>,
  tone: 'cyan' | 'pink',
): string {
  const total = totalOf(breakdown, order);
  const rows = order
    .map((key) => ({ key, value: Math.max(0, breakdown[key] ?? 0) }))
    .filter((entry) => entry.value > 0.5)
    .map(
      (entry) =>
        `<div class="bk-row">
          <span class="bk-name">${esc(names[entry.key])}</span>
          ${ratioBar(entry.value, total, tone)}
          <b class="bk-value">${formatMoney(entry.value)}</b>
        </div>`,
    );
  if (!rows.length) return '<p class="muted center">本月尚未有記錄</p>';
  return rows.join('');
}

export function createFinancePanel(container: HTMLElement, store: GameStore, actions: GameActions): FinancePanelView {
  const closeFinance = (): void => {
    store.state.ui.showFinance = false;
    restoreInfoPanel(store);
    store.bumpUI();
  };
  const host = createOverlayHost(container, actions, closeFinance);
  let lastSig = '';
  let sliderBusy = false;

  const upkeepOf = (state: GameState): number =>
    state.buildings.reduce((sum, b) => sum + (BUILDINGS[b.key]?.upkeep ?? 0), 0);

  const signature = (state: GameState): string => {
    const f = state.finance;
    return [
      Math.round(f.treasury),
      Math.round(f.lastMonthIncome),
      Math.round(f.lastMonthExpense),
      Math.round(f.incomeThisMonth),
      Math.round(f.expenseThisMonth),
      totalOf(f.incomeBreakdown, INCOME_ORDER).toFixed(0),
      totalOf(f.expenseBreakdown, EXPENSE_ORDER).toFixed(0),
      f.history.length,
      f.history.length ? Math.round(f.history[f.history.length - 1].balance) : 0,
      f.lastFestivalDay,
      f.lastLandSaleDay,
      f.landSales,
      state.clock.totalDays,
      state.buildings.length,
      state.stats.population,
    ].join('|');
  };

  const offInput = delegate(host.layer, 'input', '[data-act="tax"]', (node) => {
    const input = node as HTMLInputElement;
    const kind = input.dataset.kind as 'salary' | 'profit' | 'rates' | undefined;
    if (!kind) return;
    const raw = Number(input.value);
    if (!Number.isFinite(raw)) return;
    const min = Number(input.min);
    const max = Number(input.max);
    const ratio = max > min ? (raw - min) / (max - min) : 0;
    input.style.setProperty('--fill', `${Math.round(ratio * 100)}%`);
    const label = input.closest('.tax-row')?.querySelector<HTMLElement>(`[data-k="taxLabel-${kind}"]`);
    if (label) label.textContent = taxLabel(raw);
    actions.setTaxRate(kind, raw / 100);
  });

  const markBusy = (busy: boolean): void => {
    sliderBusy = busy;
  };
  const offPointerDown = delegate(host.layer, 'pointerdown', '[data-act="tax"]', () => markBusy(true));
  const onPointerUp = (): void => markBusy(false);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  const offClick = delegate(host.layer, 'click', '[data-act]', (node) => {
    switch (node.dataset.act) {
      case 'sell-land':
        actions.sellLand();
        break;
      case 'festival':
        actions.holdFestival();
        break;
      default:
        break;
    }
  });

  const render = (state: GameState): void => {
    const f = state.finance;
    const upkeep = upkeepOf(state);
    const treasury = f.treasury;
    const balance = f.lastMonthIncome - f.lastMonthExpense;
    const landCooldown = cooldownLeft(state.clock.totalDays, f.lastLandSaleDay, LAND_SALE_COOLDOWN_DAYS);
    const festivalCooldown = cooldownLeft(state.clock.totalDays, f.lastFestivalDay, FESTIVAL_COOLDOWN_DAYS);
    const canLand = landCooldown <= 0;
    const canFestival = festivalCooldown <= 0 && treasury >= FESTIVAL_COST;
    const incomeTotal = totalOf(f.incomeBreakdown, INCOME_ORDER);
    const expenseTotal = totalOf(f.expenseBreakdown, EXPENSE_ORDER);

    // 警告
    const warnings: string[] = [];
    if (treasury < 0) {
      warnings.push(
        `<div class="fin-warning bad">${ico('warn')}<span><b>庫房赤字！</b> 立即調整稅率、拍賣土地或拆卸高維護建築，否則城市發展停滯。</span></div>`,
      );
    } else if (balance < 0) {
      warnings.push(
        `<div class="fin-warning warn">${ico('warn')}<span>上月收支為負（${formatMoney(balance)}），留意稅基與經常性開支。</span></div>`,
      );
    }
    if (state.clock.weather === 'storm') {
      warnings.push(
        `<div class="fin-warning info">${ico('storm')}<span>颱風來襲：工程停工、渡輪停航，本月收入可能受壓。</span></div>`,
      );
    }

    // 稅率滑桿
    const taxBlock = taxRows(state)
      .map((row) => {
        const fill = row.max > row.min ? ((row.value - row.min) / (row.max - row.min)) * 100 : 0;
        return `
          <div class="tax-row">
            <div class="tax-head">
              <div class="tax-title"><b>${row.label}</b><em>${row.hint}</em></div>
              <span class="tax-value" data-k="taxLabel-${row.kind}">${taxLabel(row.value)}</span>
            </div>
            <input class="tax-slider" type="range" min="${row.min}" max="${row.max}" step="${row.step}" value="${row.value}"
              data-act="tax" data-kind="${row.kind}" style="--fill:${fill}%" aria-label="${row.label}" />
            <div class="tax-scale"><span>${row.scale[0]}</span><span>${row.scale[1]}</span><span>${row.scale[2]}</span></div>
            <div class="tax-meta">
              <span>預估月收 <b>${formatMoneyShort(estimateMonthlyTax(state, row.kind, row.value))}</b></span>
              <span class="tax-impact${Math.abs(row.value - defaultTaxPct(row.kind)) > 0.01 ? ' changed' : ''}">幸福影響 ${taxImpact(row.value - defaultTaxPct(row.kind))}</span>
            </div>
          </div>`;
      })
      .join('');

    // 歷史圖表
    const history = f.history.slice(-8);
    const maxBar = Math.max(1, ...history.map((r) => Math.max(r.income, r.expense)));
    const chart = history.length
      ? history
          .map((record) => {
            const incH = Math.max(2, Math.round((record.income / maxBar) * 100));
            const expH = Math.max(2, Math.round((record.expense / maxBar) * 100));
            return `
              <div class="chart-col" title="${formatMonthLabel(record.year, record.month)}：收入 ${formatMoney(record.income)} · 支出 ${formatMoney(record.expense)}">
                <div class="chart-bars">
                  <i class="bar-income" style="height:${incH}%"></i>
                  <i class="bar-expense" style="height:${expH}%"></i>
                </div>
                <span class="chart-label">${record.month}月</span>
                <em class="chart-net ${record.balance >= 0 ? 'positive' : 'negative'}">${formatMoneyShort(record.balance)}</em>
              </div>`;
          })
          .join('')
      : '<p class="muted center chart-empty">尚未結算月報；每過一個月會自動記錄。</p>';

    const body = `
      <div class="finance-hero">
        <div class="fin-treasury${treasury < 0 ? ' negative' : ''}">
          <span class="fin-label">庫房結餘</span>
          <b class="fin-amount">${formatMoney(treasury)}</b>
          <span class="fin-sub">${treasury < 0 ? '入不敷支，亟需開源節流' : `每月經常性開支約 ${formatMoneyShort(upkeep)}`}</span>
        </div>
        <div class="fin-cards">
          <div class="fin-card"><span>上月收入</span><b class="positive">${signedMoney(f.lastMonthIncome, formatMoney)}</b></div>
          <div class="fin-card"><span>上月支出</span><b class="negative">${formatMoney(-Math.abs(f.lastMonthExpense))}</b></div>
          <div class="fin-card"><span>上月盈餘</span><b class="${balance >= 0 ? 'positive' : 'negative'}">${signedMoney(balance, formatMoney)}</b></div>
          <div class="fin-card"><span>本月累計</span><b class="${f.incomeThisMonth - f.expenseThisMonth >= 0 ? 'positive' : 'negative'}">${formatMoneyShort(f.incomeThisMonth - f.expenseThisMonth)}</b></div>
        </div>
      </div>
      ${warnings.join('')}

      <div class="fin-block">
        <div class="block-head"><h3>${ico('chart')}稅率</h3><span class="mini">薪俸稅 · 利得稅 · 差餉</span></div>
        ${taxBlock}
        <p class="hint">稅率越高，庫房收入越多，但市民與企業的幸福度下降。庫房赤字時可先加稅或賣地應急。</p>
      </div>

      <div class="fin-grid">
        <div class="fin-block">
          <div class="block-head"><h3>本月收入</h3><b class="positive">${formatMoney(incomeTotal)}</b></div>
          ${breakdownRows(f.incomeBreakdown, INCOME_ORDER, INCOME_NAMES, 'cyan')}
        </div>
        <div class="fin-block">
          <div class="block-head"><h3>本月支出</h3><b class="negative">${formatMoney(expenseTotal)}</b></div>
          ${breakdownRows(f.expenseBreakdown, EXPENSE_ORDER, EXPENSE_NAMES, 'pink')}
        </div>
      </div>

      <div class="fin-grid">
        <div class="fin-block fin-measure">
          <div class="block-head"><h3>${ico('land')}拍賣土地</h3></div>
          <p class="hint">拍賣一幅政府土地，即時為庫房進帳 ${formatMoney(LAND_SALE_AMOUNT)}。每 ${LAND_SALE_COOLDOWN_DAYS} 日可賣一次。</p>
          <button type="button" class="fin-action" data-act="sell-land" ${canLand ? '' : 'disabled'}>
            ${canLand ? `拍賣土地（+${formatMoneyShort(LAND_SALE_AMOUNT)}）` : `冷卻中 · 尚餘 ${landCooldown} 日`}
          </button>
          <div class="fin-kv"><span>累計售出</span><b>${num(f.landSales)} 幅</b></div>
        </div>
        <div class="fin-block fin-measure">
          <div class="block-head"><h3>${ico('fireworks')}維港煙花匯演</h3></div>
          <p class="hint">舉辦煙花匯演振奮人心，全城幸福度提升，花費 ${formatMoney(FESTIVAL_COST)}。每 ${FESTIVAL_COOLDOWN_DAYS} 日可辦一次。</p>
          <button type="button" class="fin-action" data-act="festival" ${canFestival ? '' : 'disabled'}>
            ${festivalCooldown > 0 ? `冷卻中 · 尚餘 ${festivalCooldown} 日` : `舉辦煙花匯演（${formatMoneyShort(FESTIVAL_COST)}）`}
          </button>
          <div class="fin-kv"><span>上次舉辦</span><b>${f.lastFestivalDay < 0 ? '從未舉辦' : `第 ${num(f.lastFestivalDay)} 日`}</b></div>
        </div>
      </div>

      <div class="fin-block">
        <div class="block-head"><h3>近月收支</h3><span class="chart-legend"><i class="lg-income"></i>收入<i class="lg-expense"></i>支出</span></div>
        <div class="fin-chart">${chart}</div>
        ${
          history.length
            ? `<div class="history-table-wrap">
                <table class="mini-table history-table">
                  <thead><tr><th>年月</th><th>收入</th><th>支出</th><th>盈餘</th><th>人口</th><th>幸福</th></tr></thead>
                  <tbody>${history
                    .slice()
                    .reverse()
                    .map(
                      (record) =>
                        `<tr><td>${formatMonthLabel(record.year, record.month)}</td>` +
                        `<td class="positive">${formatMoney(record.income)}</td>` +
                        `<td class="negative">${formatMoney(record.expense)}</td>` +
                        `<td class="${record.balance >= 0 ? 'positive' : 'negative'}">${formatMoney(record.balance)}</td>` +
                        `<td>${num(record.population)}</td><td>${Math.round(record.happiness)}</td></tr>`,
                    )
                    .join('')}</tbody>
                </table>
              </div>`
            : ''
        }
      </div>
      <p class="modal-foot-note">${ico('info')}每月自動結算；車費收入由交通系統入帳，服務收入來自街市、超市、酒樓等。</p>
    `;

    host.show(
      modalShell({
        key: 'finance',
        badge: '財',
        title: '香港財政',
        subtitle: '稅收 · 開支 · 賣地 · 煙花匯演',
        body,
      }),
    );
  };

  const update = (state: GameState): void => {
    const ui = state.ui;
    if (!ui.showFinance) {
      host.hide();
      lastSig = '';
      return;
    }
    if (sliderBusy) return;
    const sig = signature(state);
    if (sig !== lastSig) {
      lastSig = sig;
      render(state);
    }
  };

  return {
    update,
    destroy(): void {
      offClick();
      offInput();
      offPointerDown();
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      host.destroy();
    },
  };
}
