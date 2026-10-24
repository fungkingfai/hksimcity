/**
 * 《維港之城》展示截圖腳本：建立一座具規模的示範香港城市，拍下
 * 城市全景、夜景、颱風、雨景、寒潮、室內、財政、交通、存檔、地圖全景，
 * 輸出到 docs/screenshots/。
 *
 * 用法：node scripts/capture-showcase.mjs [url]
 * 建議先啟動 dev server（5273）或 preview（4273）；腳本會自動用 ?lite=1。
 */

import { chromium } from 'playwright';
import fs from 'node:fs';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5273/';
const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}lite=1`;
const outDir = 'docs/screenshots';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1, locale: 'zh-TW' });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

const wait = (ms) => page.waitForTimeout(ms);
const ev = (fn, arg) => page.evaluate(fn, arg);
let cdp;
const snap = async (name, ms = 2200) => {
  if (!cdp) cdp = await page.context().newCDPSession(page);
  await wait(ms);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, 'base64'));
  process.stderr.write(`saved ${outDir}/${name}.png\n`);
};

const result = { ok: false, shots: [], errors, summary: null };

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__HK_CITY__), { timeout: 90000 });
  await page.addStyleTag({ content: '.toast{display:none!important}' });
  await wait(2500);

  // ── 0. 開局模式選擇畫面 ──
  await snap('start', 1800);

  // ── 0b. 「由零開始」完全空地圖（304×304；零道路／零建築／零分區） ──
  await ev(() => {
    const { actions, store } = window.__HK_CITY__;
    actions.startGame('empty', 20261021);
    store.state.ui.showTutorial = false;
    store.state.ui.showStartScreen = false;
    store.state.ui.showStats = false;
    store.bumpUI();
    actions.fitMap();
    document.querySelectorAll('.toast').forEach((n) => n.remove());
  });
  await wait(3500);
  await snap('empty', 2500);

  // ── 建立示範城市 ──
  const summary = await ev(async () => {
    const BUILDINGS = window.__HK_CITY__.BUILDINGS;
    const { store, actions, simulation, ctx, view } = window.__HK_CITY__;
    actions.newGame(20261021);
    const st = store.state;
    st.ui.showTutorial = false;
    st.ui.showStats = true;
    st.finance.treasury = 60_000_000;
    store.bumpUI();
    const W = st.width;
    const H = st.height;
    const idx = (x, y) => y * W + x;
    const okTerrain = new Set(['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill']);
    const sx = st.spawn?.x ?? W >> 1;
    const sy = st.spawn?.y ?? H >> 1;
    let base = null;
    let bestScore = -Infinity;
    for (let y = 4; y + 22 < H - 4; y++) {
      for (let x = 4; x + 22 < W - 4; x++) {
        let okCount = 0;
        let blocked = false;
        for (let dy = 0; dy < 22 && !blocked; dy++) {
          for (let dx = 0; dx < 22; dx++) {
            const t = st.tiles[(y + dy) * W + x + dx];
            if (t.buildingId >= 0) {
              blocked = true;
              break;
            }
            if (okTerrain.has(t.terrain)) okCount++;
          }
        }
        if (blocked || okCount < 360) continue;
        const dist = Math.hypot(x + 11 - sx, y + 11 - sy);
        const score = okCount - dist * 2.5;
        if (score > bestScore) {
          bestScore = score;
          base = { x, y };
        }
      }
    }
    if (!base) return { error: 'no base' };
    // 放寬：允許範圍內有少量不可建格（道路只鋪可建格、建築只放可建格）
    const bx = base.x;
    const by = base.y;

    // 拆除範圍內預置道路，重新規劃
    for (let y = by; y < by + 22; y++) {
      for (let x = bx; x < bx + 22; x++) {
        const t = st.tiles[y * W + x];
        if (t.road || t.sidewalk) {
          st.tiles[y * W + x].road = false;
          st.tiles[y * W + x].sidewalk = false;
        }
      }
    }
    st.buildings.length = 0;
    st.vehicles.length = 0;
    st.carts.length = 0;

    // 道路網：三橫三直 ＋ 行人路
    const roads = [];
    for (const ry of [by + 5, by + 10, by + 15]) for (let x = bx + 1; x <= bx + 20; x++) roads.push([x, ry]);
    for (const rx of [bx + 5, bx + 11, bx + 17]) for (let y = by + 1; y <= by + 20; y++) roads.push([rx, y]);
    for (const [x, y] of roads) {
      const t = st.tiles[y * W + x];
      if (!t.road && t.buildingId < 0 && okTerrain.has(t.terrain)) {
        t.road = true;
        t.sidewalk = true;
      }
    }
    // 行人專用路（沿 x=bx+8 及 y=by+8 的內街）
    for (let y = by + 1; y <= by + 20; y++) {
      const t = st.tiles[y * W + bx + 8];
      if (!t.road && t.buildingId < 0 && okTerrain.has(t.terrain)) t.sidewalk = true;
    }

    const inserted = {};
    // 直接建立建築（展示用）：先扣格、後建 Building
    const placeDirect = (key, x, y) => {
      const def = BUILDINGS[key];
      if (!def) return false;
      const [w, h] = def.size;
      if (x < 0 || y < 0 || x + w > W || y + h > H) return false;
      const buildable = new Set(['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill']);
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const t = st.tiles[(y + dy) * W + x + dx];
          if (t.buildingId >= 0 || t.road || t.sidewalk || !buildable.has(t.terrain)) return false;
        }
      }
      const b = {
        id: st.nextBuildingId++,
        key,
        x,
        y,
        w,
        h,
        active: true,
        connected: true,
        workers: [],
        residents: [],
        inventory: {},
        productionProgress: 0,
        level: 1,
        builtOnDay: 1,
        incomeThisMonth: 0,
        expenseThisMonth: 0,
        auto: Boolean(def.zone),
        zone: def.zone,
      };
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const t = st.tiles[(y + dy) * W + x + dx];
          t.buildingId = b.id;
          if (def.zone) t.zone = def.zone;
        }
      }
      st.buildings.push(b);
      inserted[key] = (inserted[key] ?? 0) + 1;
      return true;
    };

    // 住宅（北面兩排）
    placeDirect('publicHousing', bx + 1, by + 1);
    placeDirect('publicHousing', bx + 3, by + 1);
    placeDirect('hOSFlat', bx + 5, by + 1);
    placeDirect('privateEstate', bx + 8, by + 1);
    placeDirect('luxuryTower', bx + 11, by + 1);
    placeDirect('privateEstate', bx + 14, by + 1);
    placeDirect('hOSFlat', bx + 17, by + 1);
    for (let x = bx + 1; x <= bx + 20; x += 2) {
      if (x < bx + 1) continue;
      placeDirect('tongLau', x, by + 3);
      placeDirect('tongLau', x, by + 4);
    }
    placeDirect('tongLau', bx + 2, by + 7);
    placeDirect('subdividedFlat', bx + 3, by + 7);
    placeDirect('tongLau', bx + 2, by + 8);
    placeDirect('subdividedFlat', bx + 3, by + 8);

    // 商業（沿主幹道）
    placeDirect('chaChaanTeng', bx + 6, by + 6);
    placeDirect('chaChaanTeng', bx + 7, by + 6);
    placeDirect('convenienceStore', bx + 9, by + 6);
    placeDirect('convenienceStore', bx + 10, by + 6);
    placeDirect('wetMarket', bx + 12, by + 6);
    placeDirect('supermarket', bx + 14, by + 6);
    placeDirect('shoppingMall', bx + 17, by + 6);
    placeDirect('restaurant', bx + 1, by + 6);
    placeDirect('officeTower', bx + 19, by + 6);
    placeDirect('officeTower', bx + 19, by + 9);
    placeDirect('officeTower', bx + 1, by + 12);
    placeDirect('officeTower', bx + 2, by + 12);

    // 工業／物流（南面）
    placeDirect('industrialBuilding', bx + 6, by + 11);
    placeDirect('industrialBuilding', bx + 8, by + 11);
    placeDirect('foodFactory', bx + 12, by + 11);
    placeDirect('warehouse', bx + 14, by + 11);
    placeDirect('importFirm', bx + 16, by + 11);
    placeDirect('quarry', bx + 19, by + 12);
    placeDirect('powerPlant', bx + 18, by + 15);
    placeDirect('waterworks', bx + 13, by + 15);
    placeDirect('farm', bx + 1, by + 17);
    placeDirect('farm', bx + 3, by + 17);
    placeDirect('farm', bx + 6, by + 17);
    placeDirect('farm', bx + 8, by + 17);
    placeDirect('farm', bx + 1, by + 19);
    placeDirect('farm', bx + 3, by + 19);

    // 公共設施
    placeDirect('school', bx + 12, by + 17);
    placeDirect('hospital', bx + 15, by + 17);
    placeDirect('policeStation', bx + 9, by + 13);
    placeDirect('fireStation', bx + 11, by + 13);
    placeDirect('park', bx + 5, by + 13);
    placeDirect('park', bx + 2, by + 14);
    placeDirect('promenade', bx + 6, by + 19);

    // 交通
    placeDirect('mtrStation', bx + 3, by + 11);
    placeDirect('busTerminus', bx + 20, by + 3);
    placeDirect('tramStop', bx + 5, by + 8);
    // 渡輪碼頭／海濱：在基地附近找臨水可建處
    const nearWater = (x, y, w, h) => {
      for (let dy = -1; dy <= h; dy++) {
        for (let dx = -1; dx <= w; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          if (st.tiles[yy * W + xx].terrain === 'water') return true;
        }
      }
      return false;
    };
    let pierPlaced = false;
    let promPlaced = 0;
    for (let r = 2; r <= 14 && !pierPlaced; r++) {
      for (let dy = -r; dy <= r && !pierPlaced; dy++) {
        for (let dx = -r; dx <= r && !pierPlaced; dx++) {
          const fx = bx + 10 + dx;
          const fy = by + 10 + dy;
          if (nearWater(fx, fy, 3, 2) && placeDirect('ferryPier', fx, fy)) pierPlaced = true;
        }
      }
    }
    for (let r = 0; r <= 14 && promPlaced < 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const fx = bx + 10 + dx;
          const fy = by + 10 + dy;
          if (nearWater(fx, fy, 1, 1) && placeDirect('promenade', fx, fy)) promPlaced++;
        }
      }
    }

    // 分區色塊：按方位劃分未發展土地（展示用）
    for (let dy = -13; dy <= 13; dy++) {
      for (let dx = -13; dx <= 13; dx++) {
        const x = bx + 11 + dx;
        const y = by + 10 + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const t = st.tiles[y * W + x];
        if (t.buildingId >= 0 || t.road) continue;
        if (t.zone) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (d > 11) continue;
        if (dy < -2) t.zone = 'residential';
        else if (dy < 2) t.zone = 'commercial';
        else if (dy < 7) t.zone = 'industrial';
        else if (t.terrain === 'fertile' || t.terrain === 'grass') t.zone = 'farmland';
      }
    }

    // 人口與就業（展示用，直接設定居民數以觸發解鎖與視覺）
    st.stats.population = 420;
    st.citizens = [];
    st.nextCitizenId = 1;
    // 快速跑 30 日，讓市民遷入／就業／生產／交通運作
    st.clock.paused = false;
    st.clock.speed = 3;
    for (let i = 0; i < 30; i++) simulation.update(st, 10, ctx);
    st.clock.speed = 0;
    st.clock.paused = true;
    st.ui.speed = 0;
    st.ui.paused = true;
    store.bumpUI();
    st.stats.population = st.citizens.length;
    return {
      base: { bx, by },
      buildings: st.buildings.length,
      citizens: st.citizens.length,
      inserted,
      treasury: Math.round(st.finance.treasury),
      weather: st.clock.weather,
      day: st.clock.totalDays,
    };
  });
  result.summary = summary;
  process.stderr.write(`city: ${JSON.stringify(summary)}\n`);
  await wait(4000);

  // 鏡頭對準示範城市
  const frame = async (opts = {}) => {
    await ev((o) => {
      const { store, view } = window.__HK_CITY__;
      const st = store.state;
      const TILE = 2;
      const b = window.__SHOWCASE_BASE__ ?? { bx: st.spawn.x - 10, by: st.spawn.y - 10 };
      view.target.set(
        (b.bx + 10.5) * TILE - (st.width * TILE) / 2,
        0,
        (b.by + 10.5) * TILE - (st.height * TILE) / 2,
      );
      view.distance = o.distance ?? 66;
      view.pitch = o.pitch ?? 0.92;
      view.yaw = o.yaw ?? -0.72;
    }, opts);
  };
  // 把基地寫進全域以便 frame()
  await ev((base) => {
    window.__SHOWCASE_BASE__ = base;
  }, summary.base);

  // 1) 白天城市全景
  await ev(async () => {
    const deriveClockFields = window.__HK_CITY__.deriveClockFields;
    const st = window.__HK_CITY__.store.state;
    const heroDay = (5 - 1) * 7 + 6;
    st.clock.minutes = (heroDay - 1) * 1440 + 10 * 60 + 30;
    deriveClockFields(st.clock);
    st.clock.weather = 'clear';
    st.clock.weatherIntensity = 0;
    st.clock.weatherMinutesLeft = 100000;
    st.clock.warning = null;
    st.clock.tempC = 27;
    st.clock.paused = false;
    st.clock.speed = 1;
    window.__HK_CITY__.actions.closeOverlays();
  });
  await frame({ distance: 115, pitch: 0.95, yaw: -0.68 });
  await page.waitForTimeout(2500);
  await snap('hero', 2500);

  // 2) 街道近景
  await frame({ distance: 40, pitch: 0.86, yaw: -0.85 });
  await snap('city', 2200);

  // 2b) 分區玩法總覽（分區色塊＋需求面板）
  await ev(() => {
    const { store } = window.__HK_CITY__;
    const st = store.state;
    st.ui.showStats = true;
    st.ui.showZones = true;
    st.ui.buildCategory = 'civic';
    window.__HK_CITY__.store.bumpUI();
  });
  await frame({ distance: 78, pitch: 0.98, yaw: -0.72 });
  await snap('zoning', 2800);

  // 3) 夜景（霓虹）
  await ev(async () => {
    const deriveClockFields = window.__HK_CITY__.deriveClockFields;
    const st = window.__HK_CITY__.store.state;
    const dayStart = Math.floor(st.clock.minutes / 1440) * 1440;
    st.clock.minutes = dayStart + 21 * 60 + 15;
    deriveClockFields(st.clock);
    st.clock.weather = 'clear';
    st.clock.weatherMinutesLeft = 100000;
  });
  await frame({ distance: 72, pitch: 0.9, yaw: -0.6 });
  await snap('night', 3200);

  // 4) 颱風
  await ev(async () => {
    const deriveClockFields = window.__HK_CITY__.deriveClockFields;
    const st = window.__HK_CITY__.store.state;
    const dayStart = Math.floor(st.clock.minutes / 1440) * 1440;
    st.clock.minutes = dayStart + 15 * 60;
    deriveClockFields(st.clock);
    st.clock.weather = 'storm';
    st.clock.weatherMinutesLeft = 100000;
    st.clock.weatherIntensity = 1;
    st.clock.tempC = 26;
    window.__HK_CITY__.store.bumpUI();
  });
  await frame({ distance: 80, pitch: 0.9, yaw: -0.75 });
  await wait(1800);
  // 八號風球全屏警示（保留下來作為另一張功能截圖）
  const hasAlert = await ev(() => Boolean(document.querySelector('.typhoon-alert .ta-box')));
  if (hasAlert) await snap('typhoon-alert', 600);
  await ev(() => {
    document.querySelector('[data-act="dismiss-typhoon-alert"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await wait(1200);
  await snap('typhoon', 2400);

  // 5) 雨天
  await ev(async () => {
    const deriveClockFields = window.__HK_CITY__.deriveClockFields;
    const st = window.__HK_CITY__.store.state;
    const dayStart = Math.floor(st.clock.minutes / 1440) * 1440;
    st.clock.minutes = dayStart + 14 * 60 + 20;
    deriveClockFields(st.clock);
    st.clock.weather = 'rain';
    st.clock.weatherIntensity = 1;
    st.clock.weatherMinutesLeft = 100000;
    st.clock.warning = '黃色暴雨警告信號 — 低窪地區可能水浸';
    window.__HK_CITY__.store.bumpUI();
  });
  await snap('rain', 2800);

  // 6) 寒潮（冬 + 雪）
  await ev(async () => {
    const deriveClockFields = window.__HK_CITY__.deriveClockFields;
    const st = window.__HK_CITY__.store.state;
    const winterDay = (12 - 1) * 7 + 5;
    st.clock.minutes = (winterDay - 1) * 1440 + 9 * 60;
    deriveClockFields(st.clock);
    st.clock.weather = 'snow';
    st.clock.weatherIntensity = 1;
    st.clock.weatherMinutesLeft = 100000;
    st.clock.tempC = 3;
    window.__HK_CITY__.store.bumpUI();
  });
  await snap('snow', 2800);
  await ev(async () => {
    const deriveClockFields = window.__HK_CITY__.deriveClockFields;
    const st = window.__HK_CITY__.store.state;
    const heroDay = (5 - 1) * 7 + 6;
    st.clock.minutes = (heroDay - 1) * 1440 + 16 * 60;
    deriveClockFields(st.clock);
    st.clock.weather = 'clear';
    st.clock.weatherIntensity = 0;
    st.clock.weatherMinutesLeft = 100000;
    st.clock.tempC = 27;
    window.__HK_CITY__.store.bumpUI();
  });

  // 7) 室內（茶餐廳）
  const interiorKey = await ev(() => {
    const { store, actions } = window.__HK_CITY__;
    const st = store.state;
    const b =
      st.buildings.find((x) => x.key === 'chaChaanTeng') ??
      st.buildings.find((x) => x.key === 'wetMarket') ??
      st.buildings.find((x) => x.key === 'publicHousing') ??
      st.buildings[0];
    if (!b) return null;
    actions.enterBuilding(b.id);
    return b.key;
  });
  await wait(3000);
  await snap('interior', 2800);
  await ev(() => window.__HK_CITY__.actions.exitInterior());

  // 8) 財政面板
  await ev(() => window.__HK_CITY__.actions.toggleFinance());
  await snap('finance', 2200);
  await ev(() => window.__HK_CITY__.actions.closeOverlays());

  // 9) 交通面板
  await ev(() => window.__HK_CITY__.actions.toggleTransit());
  await snap('transit', 2000);
  await ev(() => window.__HK_CITY__.actions.closeOverlays());

  // 10) 存檔面板
  await ev(() => window.__HK_CITY__.actions.toggleSavePanel());
  await snap('save', 2000);
  await ev(() => window.__HK_CITY__.actions.closeOverlays());

  // 11) 全地圖俯瞰（白天、收起雙側面板，方便看清香港地圖）
  await ev(() => {
    const { store, view, deriveClockFields } = window.__HK_CITY__;
    const st = store.state;
    const dayStart = Math.floor(st.clock.minutes / 1440) * 1440;
    st.clock.minutes = dayStart + 11 * 60;
    if (deriveClockFields) deriveClockFields(st.clock);
    st.clock.weather = 'clear';
    st.clock.weatherIntensity = 0;
    st.clock.weatherMinutesLeft = 100000;
    st.clock.warning = null;
    st.clock.paused = true;
    st.clock.speed = 0;
    const hud = document.querySelector('.hud');
    hud?.classList.add('is-build-collapsed', 'is-info-collapsed');
    store.bumpUI();
    // 304×304 大地圖：用 fitMap 拉遠至全圖 overview
    view.target.set(0, 0, 0);
    view.distance = 1560;
    view.pitch = 1.3;
    view.yaw = -0.35;
  });
  await snap('map', 3200);

  // 12) 真實東區：杏花邨／柴灣／小西灣 existing 高樓群（starter 模式）
  await ev(() => {
    const { actions, store, view } = window.__HK_CITY__;
    actions.startGame('starter', 20261021);
    const st = store.state;
    st.ui.showTutorial = false;
    st.ui.showStartScreen = false;
    st.ui.showStats = false;
    st.ui.paused = true;
    st.clock.paused = true;
    document.querySelectorAll('.toast').forEach((n) => n.remove());
    const dayStart = Math.floor(st.clock.minutes / 1440) * 1440;
    st.clock.minutes = dayStart + 15 * 60;
    st.clock.weather = 'clear';
    st.clock.weatherIntensity = 0;
    window.__HK_CITY__.deriveClockFields(st.clock);
    const T = 2;
    const tile = { x: 395, y: 379 };
    view.target.set((tile.x + 0.5) * T - (st.width * T) / 2, 0, (tile.y + 0.5) * T - (st.height * T) / 2);
    view.distance = 240;
    view.pitch = 1.02;
    view.yaw = -0.82;
    store.bumpUI();
  });
  await snap('east', 3200);

  // 13) 地下管網（starter 已有預建管道）
  await ev(() => {
    const { actions, store } = window.__HK_CITY__;
    actions.toggleUnderground?.();
    store.bumpUI();
  });
  await snap('underground', 2800);

  // 14) 公用設施面板
  await ev(() => {
    const { actions, store } = window.__HK_CITY__;
    actions.toggleUnderground?.();
    actions.toggleUtilityPanel?.();
    store.bumpUI();
  });
  await snap('utility', 2400);

  // 15) 交通／路線面板
  await ev(() => {
    const { actions, store } = window.__HK_CITY__;
    actions.toggleUtilityPanel?.();
    actions.toggleTransit?.();
    store.bumpUI();
  });
  await snap('transit', 2400);

  // 16) 貿易面板
  await ev(() => {
    const { actions, store } = window.__HK_CITY__;
    actions.toggleTransit?.();
    actions.toggleTradePanel?.();
    store.bumpUI();
  });
  await snap('trade', 2400);

  result.ok = errors.length === 0;
  result.shots = fs.readdirSync(outDir).filter((f) => f.endsWith('.png'));
} catch (err) {
  result.error = String(err);
  result.errors = errors;
  process.stderr.write(`error: ${String(err)}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
