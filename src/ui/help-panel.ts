/**
 * 說明書／新手指引：霓虹港風「城市規劃手冊」（分區玩法）。
 *
 *  - 新手指引（showTutorial）：分區六步上手、操作要訣
 *  - 說明（showHelp）：分區、道路工具、13 種公共建築、需求與服務、
 *    開局模式、交通、財政、天氣表、快捷鍵、手機手勢、存檔
 */

import {
  CATEGORY_INFO,
  FESTIVAL_COOLDOWN_DAYS,
  GRID_HEIGHT,
  GRID_WIDTH,
  FESTIVAL_COST,
  LAND_SALE_AMOUNT,
  LAND_SALE_COOLDOWN_DAYS,
  PLOPPABLE_BUILDINGS,
  PLOPPABLE_CATEGORIES,
  SEASON_INFO,
  START_TREASURY,
  STARTER_TOWN,
  WEATHER_EFFECT,
  WEATHER_INFO,
  ZONES,
  ZONE_ORDER,
  formatMoney,
} from '../core/config';
import { getUiMode } from '../core/device';
import type { BuildingCategory, GameActions, GameState, ZoneType } from '../core/types';
import type { GameStore } from '../core/store';
import { delegate, esc, num } from './dom';
import { ico } from './icons';
import { createOverlayHost, modalShell, restoreInfoPanel } from './overlay';

export interface HelpPanelView {
  update(state: GameState): void;
  destroy(): void;
}

type HelpKey = 'help' | 'tutorial';

/** 分區玩法新手指引（UI 文案；config 的 TUTORIAL_STEPS 仍為舊版） */
const MAP_W = GRID_WIDTH;
const MAP_H = GRID_HEIGHT;
const MAP_CELLS = GRID_WIDTH * GRID_HEIGHT;
const MAP_LABEL = `${MAP_W}×${MAP_H}`;

const ZONING_TUTORIAL_STEPS: { title: string; text: string }[] = [
  {
    title: '歡迎來到維港之城',
    text: `你是香港城市規劃師。這一代玩法改為分區城市建造：你負責鋪馬路、劃分區，開發商會按需求與環境自動起樓。目標是建成宜居、繁榮、可持續的國際都會。地圖 ${MAP_LABEL}（約 ${num(MAP_CELLS)} 格，約舊版 10 倍面積）：可用右下小地圖或按 O 睇全圖、P 返市中心。`,
  },
  {
    title: '第一步：鋪馬路',
    text: '選擇「馬路」（R）沿著市中心拖曳鋪設。道路已整合行人路，市民步行、貨車送貨、巴士行駛都靠它；分區必須連接馬路才會開發。',
  },
  {
    title: '第二步：劃住宅區',
    text: '用「住宅區」刷子（Z）沿馬路劃地，每格 $1,200。看城事面板的 RCI+F 需求條：住宅需求高時，開發商會自動興建唐樓、公屋、居屋甚至豪宅。',
  },
  {
    title: '第三步：商業、工業與農業區',
    text: '用商業（C）、工業（V）、農業（N）刷子平衡需求：商業提供就業與零售，工業提供職位與物流，農業供應食品。供過於求時需求變負數，就要暫緩該區。',
  },
  {
    title: '第四步：公共設施',
    text: '建造面板只列 13 種可手動建造的公共建築：發電廠、水務設施、警署、消防局、學校、醫院、港鐵站、巴士總站、電車站、渡輪碼頭、公園、海濱長廊、貨櫃碼頭。',
  },
  {
    title: '第五步：需求、服務與財政',
    text: '看需求條與警／消／校／醫覆蓋調整規劃；在財政面板調整薪俸稅、利得稅與差餉。留意天文台警告：颱風會令渡輪停航、地盤停工。',
  },
];

function keyRow(key: string, desc: string): string {
  return `<div class="ctrl"><kbd>${esc(key)}</kbd><span>${esc(desc)}</span></div>`;
}

function weatherTable(): string {
  const rows = (Object.keys(WEATHER_INFO) as (keyof typeof WEATHER_INFO)[])
    .map((weather) => {
      const info = WEATHER_INFO[weather];
      const effect = WEATHER_EFFECT[weather];
      const happy = effect.happiness > 0 ? `+${effect.happiness}` : String(effect.happiness);
      return `<tr>
        <td><span class="wx-name wx-${weather}">${info.emoji} ${esc(info.name)}</span></td>
        <td>${Math.round(effect.farm * 100)}%</td>
        <td>${Math.round(effect.move * 100)}%</td>
        <td>${Math.round(effect.transit * 100)}%</td>
        <td class="${effect.happiness < 0 ? 'negative' : 'positive'}">${happy}</td>
        <td>${esc(info.hint)}</td>
      </tr>`;
    })
    .join('');
  return `
    <table class="mini-table weather-table">
      <thead><tr><th>天氣</th><th>農作</th><th>移動</th><th>交通</th><th>幸福</th><th>說明</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function zoneTable(): string {
  return ZONE_ORDER.map(
    (zone) =>
      `<tr>
        <td><span class="zone-name" style="--zone:${ZONES[zone].colorHex}"><i>${ZONES[zone].short}</i>${esc(ZONES[zone].name)}</span></td>
        <td>${formatMoney(ZONES[zone].costPerTile)}／格</td>
        <td class="zone-desc">${esc(ZONES[zone].hint)}</td>
      </tr>`,
  ).join('');
}

function ploppableCounts(): string {
  const counts = new Map<BuildingCategory, number>();
  for (const def of PLOPPABLE_BUILDINGS) counts.set(def.category, (counts.get(def.category) ?? 0) + 1);
  return PLOPPABLE_CATEGORIES.map((key) => {
    const name = key === 'industrial' ? '公用設施' : CATEGORY_INFO[key].name;
    return `${name} ${counts.get(key) ?? 0}`;
  }).join(' · ');
}

export function createHelpPanel(container: HTMLElement, store: GameStore, actions: GameActions): HelpPanelView {
  const closeHelp = (): void => {
    store.state.ui.showHelp = false;
    store.state.ui.showTutorial = false;
    restoreInfoPanel(store);
    store.bumpUI();
  };
  const host = createOverlayHost(container, actions, closeHelp);
  let current: HelpKey | null = null;

  const openHelp = (): void => {
    store.state.ui.showTutorial = false;
    store.state.ui.showHelp = true;
    store.bumpUI();
  };

  const openTutorial = (): void => {
    store.state.ui.showHelp = false;
    store.state.ui.showTutorial = true;
    store.bumpUI();
  };

  const offClick = delegate(host.layer, 'click', '[data-act]', (node) => {
    switch (node.dataset.act) {
      case 'open-help':
        openHelp();
        break;
      case 'open-tutorial':
        openTutorial();
        break;
      default:
        break;
    }
  });

  const renderTutorial = (state: GameState): void => {
    const body = `
      <div class="tutorial-hero">
        <span class="tutorial-seal" aria-hidden="true">港</span>
        <div class="tutorial-lead">
          <h3>歡迎來到${esc(state.cityName || '維港之城')}</h3>
          <p>你劃地，開發商起樓。由一條馬路、一塊住宅區開始，把維港兩岸建成宜居、繁榮的國際都會。</p>
        </div>
      </div>

      <ol class="tutorial-steps">
        ${ZONING_TUTORIAL_STEPS.map(
          (step, index) => `
          <li>
            <span class="step-no">${String(index + 1).padStart(2, '0')}</span>
            <div class="step-text"><b>${esc(step.title)}</b><p>${esc(step.text)}</p></div>
          </li>`,
        ).join('')}
      </ol>

      <h3 class="section-title">操作要訣</h3>
      <div class="ctrl-grid">
        ${keyRow('左鍵拖曳', '鋪路／劃區／建造')}
        ${keyRow('雙擊建築', '進入室內參觀')}
        ${keyRow('Z / C / V / N', '住／商／工／農分區')}
        ${keyRow('R / M / X', '馬路／取消分區／拆卸')}
        ${keyRow('右鍵', '取消工具／拖曳旋轉')}
        ${keyRow('L', '分區色塊開關')}
        ${keyRow('O / P', '全圖／返回市中心')}
        ${keyRow('空白鍵', '暫停／繼續')}
        ${keyRow('1 / 2 / 3', '調整遊戲速度')}
      </div>

      <div class="tutorial-tip">
        ${ico('layers')}
        <span>貼士：先劃住宅區吸引人口，再按需求條補商業／工業／農業區；公共設施（警／消／校／醫、發電廠、水務、交通）會提升地價與發展分數，讓開發商興建更高級建築。<b>人口過千時要預留足夠農業區（約每 50 人 1 座農田）或食品廠，否則會出現糧食短缺警告。</b></span>
      </div>
    `;
    host.show(
      modalShell({
        key: 'tutorial',
        badge: '引',
        title: '新手指引',
        subtitle: '分區城市建造 · 你劃地，開發商起樓',
        body,
        footer: `<button type="button" class="link" data-act="open-help">查看完整說明</button>
                 <button type="button" class="primary" data-act="close">開始規劃</button>`,
      }),
    );
  };

  const renderHelp = (state: GameState): void => {
    const isMobile = getUiMode() === 'mobile';
    const body = `
      <div class="help-intro">
        <p><b>《維港之城》</b>是以 three.js 打造的香港分區城市建造模擬：鋪馬路、劃分區，開發商按 RCI+F 需求與環境自動起樓；你再以公共設施、交通與稅收政策塑造城市。<b>你不再直接興建住宅或商店</b>，而是規劃土地，讓城市自然生長。</p>
        <p class="mini">目前城市：${esc(state.cityName || '維港之城')} · 地圖 ${state.width}×${state.height}（約 ${num(state.width * state.height)} 格）· 可手動建造建築 ${num(PLOPPABLE_BUILDINGS.length)} 種（${esc(ploppableCounts())}）</p>
      </div>

      <div class="help-grid">
        <section class="help-block">
          <h3>${ico('layers')}分區玩法 RCI+F</h3>
          <ul>
            <li><b>住宅區（Z）</b>：開發商興建劏房、唐樓、公屋、居屋、私人屋苑與豪宅。</li>
            <li><b>商業區（C）</b>：便利店、茶餐廳、街市、超市、酒樓、商場與商廈。</li>
            <li><b>工業區（V）</b>：貨倉、進口商行、食品廠、工廈、石礦場。</li>
            <li><b>農業區（N）</b>：只可劃在農地／平地，自動興建農田供應食品。</li>
            <li>需求以 <b>−60%～+90%</b> 顯示：正值代表需求高、會自動開發；負值代表供過於求，開發商會暫停。</li>
            <li>分區必須連接馬路；供電／供水／治安／消防／教育／醫療與地價會影響開發等級與速度。</li>
            <li><b>人口過千時要預留足夠農業區（約每 50 人 1 座農田）或食品廠</b>，否則會出現糧食短缺警告。</li>
          </ul>
          <table class="mini-table zone-table">
            <thead><tr><th>分區</th><th>造價</th><th>說明</th></tr></thead>
            <tbody>${zoneTable()}</tbody>
          </table>
        </section>

        <section class="help-block">
          <h3>${ico('road')}道路與工具</h3>
          <ul>
            <li><b>馬路（R）</b>：$15,000／格，<b>已整合行人路</b>；拖曳連續鋪設。</li>
            <li><b>取消分區（M）</b>：清除分區色塊，已建成建築不受影響。</li>
            <li><b>拆卸（X）</b>：拆除建築（退還 30%）、道路或分區。</li>
            <li><b>分區色塊（L）</b>：顯示／隱藏分區顏色，方便規劃。</li>
            <li>住宅／商業／工業建築由開發商自動興建，玩家不能手動放置。</li>
          </ul>
        </section>

        <section class="help-block">
          <h3>${ico('map')}地圖與導航</h3>
          <ul>
            <li>大地圖 <b>${state.width}×${state.height}</b>（約 ${num(state.width * state.height)} 格）——面積約為舊版地圖的 10 倍，zoom out 範圍已加大。</li>
            <li><b>小地圖（Minimap）</b>：桌面右下／手機右下角；顯示水域、道路、四色分區、建築、城市中心與鏡頭視野框。</li>
            <li>在小地圖<b>點擊或拖曳</b>可即時跳到該位置；標題列可摺疊。</li>
            <li><b>全圖（O）</b>拉遠至全地圖 overview；<b>市中心（P）</b>返回開局市中心。</li>
            <li>小地圖工具列另有「全圖／市中心／分區色塊（L）」按鈕。</li>
          </ul>
        </section>

        <section class="help-block">
          <h3>${ico('city')}公共建築（可手動建造）</h3>
          <ul>
            <li><b>公用</b>：發電廠、水務設施——以半徑與容量提供全城水電。</li>
            <li><b>公共</b>：學校、醫院、警署、消防局——提升服務覆蓋、幸福與地價。</li>
            <li><b>交通</b>：港鐵站、巴士總站、電車站、渡輪碼頭——縮短通勤、帶來車費收入。</li>
            <li><b>物流</b>：貨櫃碼頭——進口日用品，支撐街市與超市。</li>
            <li><b>休憩</b>：公園、海濱長廊——提升周邊幸福度與地價。</li>
          </ul>
        </section>

        <section class="help-block">
          <h3>${ico('chart')}需求、服務與地價</h3>
          <ul>
            <li>城事面板的 <b>RCI+F 需求條</b>：住／商／工／農四區需求，正值多劃、負值暫緩。</li>
            <li><b>分區統計</b>：已劃格數、已建棟數、自動開發棟數；<b>服務覆蓋</b>：警力／消防／教育／醫療。</li>
            <li><b>地價指數（0–100）</b>：已發展建築的平均地價（含景觀）；<b>城市發展分數</b>再綜合公用設施、服務、交通、幸福與地價，分數越高開發商越會建高級建築。</li>
          </ul>
        </section>

        <section class="help-block">
          <h3>${ico('sprout')}開局模式</h3>
          <ul>
            <li><b>已有城鎮（starter，新手推薦）</b>：中環起步城鎮，預載道路、分區、約 ${STARTER_TOWN.targetPopulation} 名居民與公共設施，庫房 ${formatMoney(STARTER_TOWN.treasury)}。</li>
            <li><b>由零開始（empty，挑戰）</b>：空曠香港地圖、5 名市民、庫房 ${formatMoney(START_TREASURY)}，由第一條馬路開始。</li>
            <li>開局畫面可輸入地圖種子（選填）；存檔面板「另起新局」亦可在兩種模式間切換。</li>
          </ul>
        </section>

        <section class="help-block">
          <h3>${ico('mtr')}公共交通</h3>
          <ul>
            <li><b>港鐵站</b>、<b>巴士總站</b>、<b>電車站</b>、<b>渡輪碼頭</b>各有服務半徑與每日運力。</li>
            <li>市民按住所與工作地點自動選擇最快通勤方式（港鐵 ×4.2、渡輪 ×3.0、巴士 ×2.2、電車 ×1.6、步行 ×1.0）。</li>
            <li>颱風時渡輪停航；運力不足會拉長通勤、降低幸福與地價。</li>
          </ul>
        </section>

        <section class="help-block">
          <h3>${ico('chart')}香港財政</h3>
          <ul>
            <li><b>薪俸稅</b>（0–20%）、<b>利得稅</b>（0–25%）、<b>差餉</b>（0–12%）；另有車費、服務收入與<b>賣地</b>（每 ${LAND_SALE_COOLDOWN_DAYS} 日一次，${formatMoney(LAND_SALE_AMOUNT)}）。</li>
            <li>支出：建築維護、公務員薪酬、社會福利、基建與<b>維港煙花匯演</b>（${formatMoney(FESTIVAL_COST)}，每 ${FESTIVAL_COOLDOWN_DAYS} 日一次）。</li>
            <li>稅率越高收入越多，但市民幸福度下降；庫房長期赤字會拖累城市。</li>
          </ul>
        </section>

        <section class="help-block">
          <h3>${ico('sun')}天氣與季節</h3>
          <p class="mini">一年 12 個月、每月 7 日；${(Object.keys(SEASON_INFO) as (keyof typeof SEASON_INFO)[])
            .map((season) => `${SEASON_INFO[season].emoji}${SEASON_INFO[season].name}（${SEASON_INFO[season].months}）`)
            .join(' · ')}</p>
          ${weatherTable()}
        </section>

        <section class="help-block">
          <h3>${ico('compass')}操作方式${isMobile ? '（手機）' : '（電腦）'}</h3>
          <div class="ctrl-grid">
            ${
              isMobile
                ? [
                    keyRow('單指拖曳', '平移地圖'),
                    keyRow('雙指捏合', '縮放／旋轉視角'),
                    keyRow('點擊／拖曳', '鋪路、劃區、建造'),
                    keyRow('雙擊建築', '進入室內'),
                    keyRow('底部導覽', '建造／城事／財政／交通／存檔／說明'),
                    keyRow('面板標題 ×', '收起底部面板'),
                  ].join('')
                : [
                    keyRow('左鍵拖曳', '連續鋪路／劃區'),
                    keyRow('左鍵點擊', '放置建築／選取'),
                    keyRow('雙擊建築', '進入建築室內'),
                    keyRow('右鍵點擊', '取消目前工具'),
                    keyRow('右鍵拖曳', '旋轉視角'),
                    keyRow('Shift／中鍵拖曳', '平移視角'),
                    keyRow('滾輪', '縮放遠近'),
                    keyRow('WASD／方向鍵', '平移視角'),
                    keyRow('Q／E', '旋轉視角'),
                  ].join('')
            }
          </div>
        </section>

        <section class="help-block">
          <h3>${ico('book')}快捷鍵</h3>
          <table class="mini-table key-table">
            <tbody>
              <tr><td><kbd>空白鍵</kbd></td><td>暫停／繼續</td></tr>
              <tr><td><kbd>0</kbd> <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></td><td>暫停／一倍／二倍／三倍速</td></tr>
              <tr><td><kbd>R</kbd></td><td>馬路工具（含行人路）</td></tr>
              <tr><td><kbd>Z</kbd> <kbd>C</kbd> <kbd>V</kbd> <kbd>N</kbd></td><td>住宅區／商業區／工業區／農業區</td></tr>
              <tr><td><kbd>M</kbd></td><td>取消分區工具</td></tr>
              <tr><td><kbd>X</kbd></td><td>拆卸工具</td></tr>
              <tr><td><kbd>L</kbd></td><td>顯示／隱藏分區色塊</td></tr>
              <tr><td><kbd>O</kbd></td><td>全圖 overview</td></tr>
              <tr><td><kbd>P</kbd></td><td>返回市中心</td></tr>
              <tr><td><kbd>B</kbd></td><td>展開／收起建造面板</td></tr>
              <tr><td><kbd>G</kbd> <kbd>J</kbd></td><td>城事／統計面板</td></tr>
              <tr><td><kbd>F</kbd></td><td>財政面板</td></tr>
              <tr><td><kbd>T</kbd></td><td>交通面板</td></tr>
              <tr><td><kbd>H</kbd></td><td>說明手冊</td></tr>
              <tr><td><kbd>Esc</kbd></td><td>關閉視窗／取消工具／離開室內</td></tr>
            </tbody>
          </table>
        </section>

        <section class="help-block">
          <h3>${ico('scroll')}存檔</h3>
          <ul>
            <li>運作期間每 60 秒自動存檔；另設 3 個手動存檔格。</li>
            <li>可匯出／匯入 JSON；「另起新局」可選已有城鎮或由零開始，並輸入地圖種子。</li>
            <li>存檔保存在瀏覽器本機；讀檔後會回到城市模式。</li>
          </ul>
        </section>
      </div>
      <div class="help-note">${ico('info')}<span>本作所有圖像由程式即時繪製（three.js / CSS），離線亦可遊玩。</span></div>
    `;
    host.show(
      modalShell({
        key: 'help',
        badge: '書',
        title: '城市規劃手冊',
        subtitle: '分區 · 道路 · 公共設施 · 需求 · 財政 · 操作',
        body,
        footer: `<button type="button" class="link" data-act="open-tutorial">重看新手指引</button>
                 <button type="button" class="primary" data-act="close">閱畢，返回城市</button>`,
      }),
    );
  };

  const update = (state: GameState): void => {
    const next: HelpKey | null = state.ui.showTutorial ? 'tutorial' : state.ui.showHelp ? 'help' : null;

    if (!next) {
      if (current) {
        current = null;
        host.hide();
      }
      return;
    }
    if (next === current) return;
    current = next;
    if (next === 'tutorial') renderTutorial(state);
    else renderHelp(state);
  };

  return {
    update,
    destroy(): void {
      offClick();
      host.destroy();
    },
  };
}
