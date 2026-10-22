/**
 * 《維港之城》真實滑鼠／鍵盤 UI 驗收（Playwright）
 *
 * 驗證：頂欄、財政面板（三稅率滑桿、賣地）、建造面板（分類／建築卡）、
 * 真實滑鼠在 3D 地圖上建屋、雙擊進入室內／返回、交通面板、存檔面板、說明、
 * 暫停／倍速快捷鍵。
 *
 * 用法：node scripts/ui-click-test.mjs [url]
 */

import { chromium } from 'playwright';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5273/';
const withLite = (u) => `${u}${u.includes('?') ? '&' : '?'}lite=1`;
const checks = {};
const errors = [];
const check = (name, pass, detail) => {
  checks[name] = { pass: Boolean(pass), detail };
};

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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'zh-TW' });
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

const wait = (ms) => page.waitForTimeout(ms);
const waitFn = (fn, timeout = 30000) => page.waitForFunction(fn, { timeout }, fn).catch(() => null);
const ev = (fn, arg) => page.evaluate(fn, arg);
let cdp;
const snap = async (path, ms = 2600) => {
  await wait(ms);
  if (!cdp) cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path, Buffer.from(data, 'base64'));
};

try {
  await page.goto(withLite(url), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitFn(() => Boolean(window.__HK_CITY__), 60000);
  await page.addStyleTag({ content: '*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important;}' });
  await waitFn(() => Boolean(document.querySelector('[data-k="cityName"]')), 30000);

  // 固定開新局、關教學
  await ev(() => {
    const { store, actions } = window.__HK_CITY__;
    actions.startGame('starter', 20261021);
    store.state.ui.showTutorial = false;
    store.state.ui.showStats = true;
    store.bumpUI();
  });
  await wait(2600);

  // ── 1. 頂欄 ──
  const topbar = await ev(() => ({
    city: document.querySelector('[data-k="cityName"]')?.textContent?.trim(),
    date: document.querySelector('[data-k="dateText"]')?.textContent?.trim(),
    weather: document.querySelector('[data-k="wxName"]')?.textContent?.trim(),
    money: document.querySelector('[data-k="money"]')?.textContent?.trim(),
    pop: document.querySelector('[data-k="pop"]')?.textContent?.trim(),
    speedBtns: document.querySelectorAll('[data-act="speed"]').length,
    topBtns: document.querySelectorAll('.top-btn').length,
  }));
  check(
    '頂欄顯示城市／日期／天氣／庫房',
    topbar.city === '維港之城' && /2026年/.test(topbar.date ?? '') && (topbar.money ?? '').startsWith('$'),
    topbar,
  );
  check('頂欄按鈕齊全', topbar.topBtns >= 6 && topbar.speedBtns >= 4, topbar);

  // ── 2. 財政面板＋稅率滑桿＋賣地 ──
  await page.locator('[data-act="finance"]').first().click();
  await waitFn(() => window.__HK_CITY__.store.state.ui.showFinance, 30000);
  await waitFn(() => Boolean(document.querySelector('[data-act="tax"]')), 30000);
  const financeOpen = await ev(() => window.__HK_CITY__.store.state.ui.showFinance);
  check('財政面板開啟', financeOpen === true, { financeOpen });

  const sliders = await ev(() => ({
    salary: !!document.querySelector('[data-act="tax"][data-kind="salary"]'),
    profit: !!document.querySelector('[data-act="tax"][data-kind="profit"]'),
    rates: !!document.querySelector('[data-act="tax"][data-kind="rates"]'),
  }));
  check('三稅率滑桿齊全（薪俸／利得／差餉）', sliders.salary && sliders.profit && sliders.rates, sliders);
  if (sliders.salary) {
    await ev(() => {
      const input = document.querySelector('[data-act="tax"][data-kind="salary"]');
      input.value = '18';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await wait(500);
    const rate = await ev(() => window.__HK_CITY__.store.state.finance.salaryTaxRate);
    check('薪俸稅滑桿可調整', Math.abs(rate - 0.18) < 0.011, { rate });
  }

  // 賣地
  await waitFn(() => Boolean(document.querySelector('.fin-action[data-act="sell-land"]')), 30000);
  const landBefore = await ev(() => ({
    treasury: window.__HK_CITY__.store.state.finance.treasury,
    btn: !!document.querySelector('.fin-action[data-act="sell-land"]'),
    disabled: document.querySelector('.fin-action[data-act="sell-land"]')?.hasAttribute('disabled'),
  }));
  if (landBefore.btn && !landBefore.disabled) {
    await page.locator('.fin-action[data-act="sell-land"]').first().click();
    await wait(400);
    const landAfter = await ev(() => ({
      treasury: window.__HK_CITY__.store.state.finance.treasury,
      sales: window.__HK_CITY__.store.state.finance.landSales,
    }));
    check(
      '賣地按鈕入帳',
      landAfter.treasury > landBefore.treasury && landAfter.sales >= 1,
      { before: landBefore.treasury, after: landAfter.treasury },
    );
  } else {
    check('賣地按鈕入帳', false, landBefore);
  }
  await ev(() => window.__HK_CITY__.actions.closeOverlays());
  await waitFn(() => !document.querySelector('.modal-backdrop'), 20000);
  await wait(300);

  // ── 3. 建造面板＋分區刷子＋真實滑鼠劃區／鋪路／建公共設施 ──
  const base = await ev(() => {
    const { store, view } = window.__HK_CITY__;
    const st = store.state;
    const W = st.width;
    const H = st.height;
    const idx = (x, y) => y * W + x;
    const buildable = new Set(['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill']);
    const emptyAt = (x, y) => {
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false;
      const t = st.tiles[idx(x, y)];
      return buildable.has(t.terrain) && t.buildingId < 0 && !t.road && !t.sidewalk && !t.zone;
    };
    const touchStreet = (x, y) => {
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const t = st.tiles[idx(nx, ny)];
        if (t.road || t.sidewalk) return true;
      }
      return false;
    };
    const sx = st.spawn.x;
    const sy = st.spawn.y;
    const spots = [];
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        if (!emptyAt(x, y) || !touchStreet(x, y)) continue;
        spots.push({ x, y, d: (x - sx) ** 2 + (y - sy) ** 2 });
      }
    }
    spots.sort((a, b) => a.d - b.d);
    if (!spots.length) return null;
    const best = spots[0];
    view.target.set((best.x + 0.5) * 2 - (W * 2) / 2, 0, (best.y + 0.5) * 2 - (H * 2) / 2);
    view.distance = 46;
    view.pitch = 0.85;
    document.querySelector('.hud')?.classList.add('is-build-collapsed', 'is-info-collapsed');
    st.ui.showStats = false;
    store.bumpUI();
    window.__TEST_BASE__ = best;
    return { best, spots: spots.slice(0, 12).map((s) => ({ x: s.x, y: s.y })) };
  });
  check('找到可建基地', !!base, base);
  await wait(1500);

  const screenOf = async (tx, ty) =>
    ev(
      ({ tx, ty }) => {
        const { view, store } = window.__HK_CITY__;
        const st = store.state;
        const TILE = 2;
        const wx = (tx + 0.5) * TILE - (st.width * TILE) / 2;
        const wz = (ty + 0.5) * TILE - (st.height * TILE) / 2;
        const wy = 0.3;
        const cam = view.cityCamera;
        const e = cam.matrixWorldInverse.elements;
        const vx = e[0] * wx + e[4] * wy + e[8] * wz + e[12];
        const vy = e[1] * wx + e[5] * wy + e[9] * wz + e[13];
        const vz = e[2] * wx + e[6] * wy + e[10] * wz + e[14];
        const p = cam.projectionMatrix.elements;
        const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12];
        const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13];
        const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
        const ndcX = cx / cw;
        const ndcY = cy / cw;
        const canvas = document.getElementById('game-canvas');
        const rect = canvas.getBoundingClientRect();
        return {
          x: rect.left + ((ndcX + 1) / 2) * rect.width,
          y: rect.top + ((1 - ndcY) / 2) * rect.height,
        };
      },
      { tx, ty },
    );

  // 分區刷子（Z 住宅區）＋真實滑鼠劃區
  await page.keyboard.press('KeyZ');
  await waitFn(() => window.__HK_CITY__.store.state.ui.tool === 'zone:residential', 20000);
  const zoneBefore = await ev(() => window.__HK_CITY__.store.state.tiles.filter((t) => t.zone).length);
  for (const spot of base.spots.slice(0, 5)) {
    const p = await screenOf(spot.x, spot.y);
    await page.mouse.click(p.x, p.y);
    await wait(300);
  }
  const zoneAfter = await ev(() => window.__HK_CITY__.store.state.tiles.filter((t) => t.zone).length);
  check('分區刷子真實滑鼠劃區', zoneAfter > zoneBefore, { before: zoneBefore, after: zoneAfter });

  // 道路工具（R）＋整合行人路
  await page.keyboard.press('KeyR');
  await waitFn(() => window.__HK_CITY__.store.state.ui.tool === 'road', 20000);
  const roadBefore = await ev(() => {
    const st = window.__HK_CITY__.store.state;
    return {
      roads: st.tiles.filter((t) => t.road).length,
      bad: st.tiles.filter((t) => t.road && t.sidewalk !== true).length,
    };
  });
  for (const spot of base.spots.slice(5, 8)) {
    const p = await screenOf(spot.x, spot.y);
    await page.mouse.click(p.x, p.y);
    await wait(320);
  }
  const roadInfo = await ev(() => {
    const st = window.__HK_CITY__.store.state;
    const roads = st.tiles.filter((t) => t.road);
    return { roads: roads.length, bad: roads.filter((t) => t.sidewalk !== true).length };
  });
  check(
    '真實滑鼠鋪路（整合行人路）',
    roadInfo.roads > roadBefore.roads && roadInfo.bad === roadBefore.bad,
    { before: roadBefore, ...roadInfo },
  );

  // 快轉 25 日：開發商自動建屋
  await page.evaluate(() => {
    const { store, simulation, ctx } = window.__HK_CITY__;
    const st = store.state;
    st.clock.paused = false;
    st.clock.speed = 3;
    for (let d = 0; d < 25; d++) for (let k = 0; k < 20; k++) simulation.update(st, 0.5, ctx);
    st.clock.speed = 1;
    document.querySelectorAll('.toast').forEach((n) => n.remove());
  });
  await wait(1500);
  const developed = await ev(() => {
    const st = window.__HK_CITY__.store.state;
    return {
      auto: st.buildings.filter((b) => b.auto).length,
      zones: st.tiles.filter((t) => t.zone).length,
      population: st.stats.population,
      demand: st.stats.zoneDemand,
    };
  });
  check('開發商自動建屋（分區玩法）', developed.auto > 0, developed);

  // 建造面板（只列 13 種 ploppable）＋真實滑鼠放公園
  await ev(() => {
    document.querySelector('.hud')?.classList.remove('is-build-collapsed');
  });
  await waitFn(() => document.querySelectorAll('.build-card').length > 0, 30000);
  const buildPanel = await ev(() => ({
    buildOpen: !!document.querySelector('#build-panel'),
    categories: document.querySelectorAll('[data-act="category"]').length,
    cards: document.querySelectorAll('.build-card').length,
    zoneBrushes: document.querySelectorAll('[data-act="zone"]').length,
    hasAutoCard: !!document.querySelector('[data-act="build"][data-key="tongLau"]'),
  }));
  check(
    '建造面板：區域刷子＋公共建築卡、無自動建築卡',
    buildPanel.buildOpen && buildPanel.categories >= 5 && buildPanel.cards > 0 && buildPanel.zoneBrushes >= 4 && !buildPanel.hasAutoCard,
    buildPanel,
  );
  // 切到「休憩」分頁，選公園卡（手動放置建築）
  await ev(() => {
    const { store } = window.__HK_CITY__;
    store.state.ui.buildCategory = 'decoration';
    store.bumpUI();
  });
  await waitFn(() => Boolean(document.querySelector('[data-act="build"][data-key="park"]')), 20000);
  const parkCard = await ev(() => !!document.querySelector('[data-act="build"][data-key="park"]'));
  check('建造面板有公共建築卡（公園）', parkCard === true, { parkCard });
  await ev(() => {
    document.querySelector('[data-act="build"][data-key="park"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await waitFn(() => window.__HK_CITY__.store.state.ui.tool === 'park', 20000);
  await ev(() => {
    document.querySelector('.hud')?.classList.add('is-build-collapsed', 'is-info-collapsed');
  });
  await wait(300);
  // 找多個 2×2 空位（貼近道路、未劃區），再揀一個喺畫面內嘅放公園
  const parkSpots = await ev(() => {
    const st = window.__HK_CITY__.store.state;
    const W = st.width;
    const H = st.height;
    const base = window.__TEST_BASE__;
    const sx = base?.x ?? st.spawn.x;
    const sy = base?.y ?? st.spawn.y;
    const size = window.__HK_CITY__.BUILDINGS.park.size ?? [2, 2];
    const w = size[0] ?? 2;
    const h = size[1] ?? 2;
    const buildable = new Set(['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill']);
    const freeAt = (x, y) => {
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 1 || yy < 1 || xx >= W - 1 || yy >= H - 1) return false;
          const t = st.tiles[yy * W + xx];
          if (!buildable.has(t.terrain) || t.buildingId >= 0 || t.road || t.sidewalk || t.zone) return false;
        }
      }
      return true;
    };
    const nearRoad = (x, y) => {
      for (let dy = -1; dy <= h; dy++) {
        for (let dx = -1; dx <= w; dx++) {
          if ((dx >= 0 && dx < w && dy >= 0 && dy < h)) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const t = st.tiles[yy * W + xx];
          if (t.road || t.sidewalk) return true;
        }
      }
      return false;
    };
    const spots = [];
    for (let r = 0; r <= 12 && spots.length < 40; r++) {
      for (let dy = -r; dy <= r && spots.length < 40; dy++) {
        for (let dx = -r; dx <= r && spots.length < 40; dx++) {
          const x = sx + dx;
          const y = sy + dy;
          if (!freeAt(x, y) || !nearRoad(x, y)) continue;
          if (!spots.some((p) => p.x === x && p.y === y)) spots.push({ x, y });
        }
      }
    }
    return spots;
  });
  const beforePark = await ev(() => window.__HK_CITY__.store.state.buildings.length);
  let parkPoint = null;
  let elementAtPark = null;
  const canvasRect = await ev(() => {
    const c = document.getElementById('game-canvas');
    const r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  for (const spot of parkSpots) {
    const point = await screenOf(spot.x, spot.y);
    if (point.x < canvasRect.left + 20 || point.x > canvasRect.right - 20 || point.y < canvasRect.top + 70 || point.y > canvasRect.bottom - 20) continue;
    const el = await ev(({ x, y }) => {
      const e = document.elementFromPoint(x, y);
      return e ? e.id || e.className || e.tagName : null;
    }, point);
    if (el !== 'game-canvas') continue;
    parkPoint = point;
    elementAtPark = el;
    await page.mouse.click(point.x, point.y);
    await wait(1100);
    break;
  }
  const afterPark = await ev(() => window.__HK_CITY__.store.state.buildings.length);
  const parkDebug = await ev(() => {
    const st = window.__HK_CITY__.store.state;
    const spot = window.__TEST_BASE__;
    return {
      tool: st.ui.tool,
      lastLog: st.log.slice(-4).map((l) => l.text),
      toasts: [...document.querySelectorAll('.toast')].map((n) => n.textContent).slice(-3),
      treasury: Math.round(st.finance.treasury),
    };
  });
  check('真實滑鼠在 3D 地圖放置公共設施', afterPark > beforePark, { before: beforePark, after: afterPark, spot: parkSpots[0] ?? null, point: parkPoint, elementAtPark, ...parkDebug });

  // ── 4. 雙擊進入自動開發建築室內／返回城市 ──
  const target = await ev(() => {
    const { store, view } = window.__HK_CITY__;
    const st = store.state;
    const b = st.buildings.find((x) => x.auto && x.zone) ?? st.buildings[0];
    if (!b) return null;
    const W = st.width;
    view.target.set((b.x + b.w / 2) * 2 - (W * 2) / 2, 0, (b.y + b.h / 2) * 2 - (st.height * 2) / 2);
    view.distance = 34;
    view.pitch = 0.86;
    return { x: b.x + Math.floor(b.w / 2), y: b.y + Math.floor(b.h / 2), key: b.key };
  });
  check('找到自動開發建築', !!target, target);
  await wait(1200);
  const p3 = await screenOf(target.x, target.y);
  await page.mouse.dblclick(p3.x, p3.y);
  await waitFn(() => window.__HK_CITY__.store.state.ui.mode === 'interior', 25000);
  await wait(1200);
  const interior = await ev(() => ({
    mode: window.__HK_CITY__.store.state.ui.mode,
    id: window.__HK_CITY__.store.state.ui.interiorId,
    exitBtn: !!document.querySelector('[data-act="exit-interior"]'),
  }));
  check('雙擊進入建築室內', interior.mode === 'interior', interior);
  if (interior.exitBtn) {
    await ev(() => {
      document.querySelector('[data-act="exit-interior"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFn(() => window.__HK_CITY__.store.state.ui.mode === 'city', 20000);
  } else {
    await ev(() => window.__HK_CITY__.actions.exitInterior());
  }
  const backToCity = await ev(() => window.__HK_CITY__.store.state.ui.mode);
  check('室內返回城市', backToCity === 'city', { mode: backToCity });

  // ── 5. 交通面板 ──
  await page.locator('[data-act="transit"]').first().click();
  await waitFn(() => window.__HK_CITY__.store.state.ui.showTransit, 20000);
  await wait(600);
  const transitOpen = await ev(() => window.__HK_CITY__.store.state.ui.showTransit);
  check('交通面板開啟', transitOpen === true, { transitOpen });
  await page.keyboard.press('Escape');
  await wait(300);

  // ── 6. 存檔面板：手動存檔 ──
  await page.locator('[data-act="save"]').first().click();
  await waitFn(() => window.__HK_CITY__.store.state.ui.showSave, 20000);
  await wait(500);
  await waitFn(() => Boolean(document.querySelector('[data-act="save-slot"][data-slot="1"]')), 30000);
  const saveBtnVisible = await ev(() => {
    const btn = document.querySelector('[data-act="save-slot"][data-slot="1"]');
    if (!btn) return false;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  });
  await wait(800);
  const saveState = await ev(() => ({
    open: window.__HK_CITY__.store.state.ui.showSave,
    slot1: window.__HK_CITY__.actions.getSaves()[1],
  }));
  check(
    '存檔面板與手動存檔',
    saveState.open === true && saveBtnVisible && saveState.slot1 && !saveState.slot1.empty,
    saveState,
  );
  await page.keyboard.press('Escape');
  await wait(300);

  // ── 7. 說明面板 ──
  await page.locator('[data-act="help"]').first().click();
  await waitFn(() => window.__HK_CITY__.store.state.ui.showHelp, 20000);
  await wait(500);
  const helpOpen = await ev(() => window.__HK_CITY__.store.state.ui.showHelp);
  check('說明面板開啟', helpOpen === true, { helpOpen });
  await page.keyboard.press('Escape');
  await wait(300);

  // ── 8. 暫停與倍速快捷鍵 ──
  await page.locator('[data-act="speed"][data-speed="2"]').first().click({ timeout: 30000 });
  await wait(400);
  const speed2 = await ev(() => window.__HK_CITY__.store.state.clock.speed);
  await page.keyboard.press('Space');
  await wait(300);
  const paused = await ev(() => window.__HK_CITY__.store.state.clock.paused);
  await page.keyboard.press('Space');
  await wait(300);
  const resumed = await ev(() => !window.__HK_CITY__.store.state.clock.paused);
  check('倍速與暫停快捷鍵', speed2 === 2 && paused === true && resumed === true, { speed2, paused, resumed });

  await snap('/tmp/hk-ui-final.png', 2200);
  check('無 console／page 錯誤', errors.length === 0, { errors: errors.slice(0, 6) });
} catch (err) {
  checks['執行例外'] = { pass: false, detail: String(err) };
  errors.push(String(err));
  await snap('/tmp/hk-ui-error.png', 200).catch(() => {});
} finally {
  await browser.close();
}

const result = { ok: Object.values(checks).every((c) => c.pass), checks, errors };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
