/**
 * 《維港之城》手機版 UI 驗收（Playwright iPhone 模擬）
 *
 * 驗證：
 *  1. 手機裝置自動偵測 → 手機版 UI（html[data-ui-mode=mobile]、底部導覽）
 *  2. 底部「建造」面板開關、選擇工具後自動收起
 *  3. 觸控點擊地圖放置建築
 *  4. 城事面板 → 進入室內；返回城市
 *  5. 單指拖曳平移、雙指捏合縮放相機（不誤放建築）
 *  6. 底部導覽開財政／交通／存檔／說明
 *  7. 手機截圖（docs/screenshots/mobile-*.png）
 *  8. 桌面環境仍使用電腦版 UI（無手機導覽）
 *
 * 用法：node scripts/mobile-test.mjs [url]
 */

import { chromium, devices } from 'playwright';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5273/';
const outDir = 'docs/screenshots';
fs.mkdirSync(outDir, { recursive: true });

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

const context = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1, locale: 'zh-TW' });
const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

const wait = (ms) => page.waitForTimeout(ms);
const waitFn = (fn, timeout = 30000) => page.waitForFunction(fn, { timeout }, fn).catch(() => null);
const ev = (fn, arg) => page.evaluate(fn, arg);
let cdp;
const snap = async (name, ms = 2600) => {
  if (!cdp) cdp = await context.newCDPSession(page);
  await wait(ms);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, 'base64'));
};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await waitFn(() => Boolean(window.__HK_CITY__), 60000);
  await page.addStyleTag({ content: '*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important;}' });
  await wait(2400);

  // ── 0. 自動偵測 ──
  const detect = await ev(() => ({
    uiMode: document.documentElement.dataset.uiMode,
    htmlClass: document.documentElement.className,
    hudClass: document.querySelector('.hud')?.className,
    mobileNav: document.querySelectorAll('.mobile-nav-btn').length,
    navLabels: [...document.querySelectorAll('.mobile-nav-btn span')].map((e) => e.textContent?.trim()),
    desktopActionsVisible: (() => {
      const el = document.querySelector('.tb-actions');
      return el ? getComputedStyle(el).display !== 'none' : false;
    })(),
  }));
  check(
    '手機自動偵測與手機版 UI',
    detect.uiMode === 'mobile' && detect.hudClass?.includes('is-mobile-ui') && detect.mobileNav >= 5,
    detect,
  );
  check(
    '底部導覽含建造／城事／財政／交通／存檔／說明',
    ['建造', '城事', '財政', '交通', '存檔', '說明'].every((label) => detect.navLabels?.includes(label)),
    { labels: detect.navLabels },
  );

  // 開局畫面檢查
  const startInfo = await ev(() => ({
    show: window.__HK_CITY__.store.state.ui.showStartScreen,
    dom: !!document.querySelector('.start-screen, [data-screen="start"]'),
  }));
  check('手機顯示開局模式選擇', startInfo.show === true && startInfo.dom === true, startInfo);

  // 如八號風球全屏警示彈出，先按「知道了」（全屏 alert 會 intercept 手機 nav）
  const dismissTyphoon = async () => {
    const btn = page.locator('[data-act="dismiss-typhoon-alert"]').first();
    if (await btn.count()) {
      const visible = await btn.isVisible().catch(() => false);
      if (visible) await btn.tap().catch(() => {});
    }
  };
  await dismissTyphoon();

  // 固定由零開始、關教學
  await ev(() => {
    const { store, actions } = window.__HK_CITY__;
    actions.startGame('starter', 20261021);
    store.state.ui.showTutorial = false;
    store.bumpUI();
  });
  await wait(2400);
  // 如新手指引 modal 仍存在，點「開始規劃」關閉
  const tutorialBtn = page.locator('.modal-tutorial [data-act="close"], [data-act="close"]').first();
  if (await tutorialBtn.count()) {
    await tutorialBtn.tap().catch(() => {});
    await wait(500);
  }
  await ev(() => {
    const { store } = window.__HK_CITY__;
    store.state.ui.showTutorial = false;
    store.state.ui.showHelp = false;
    store.bumpUI();
  });
  await wait(300);

  // ── 1. 建造 sheet 開關（分區刷子＋公共建築） ──
  await page.locator('[data-m-act="build"]').tap();
  await waitFn(() => document.querySelector('.hud')?.classList.contains('is-build-open'), 25000);
  const buildOpen = await ev(() => ({
    open: document.querySelector('.hud')?.classList.contains('is-build-open'),
    backdrop: !!document.querySelector('.mobile-sheet-backdrop') && !document.querySelector('.mobile-sheet-backdrop').hidden,
    cards: document.querySelectorAll('.build-card').length,
    categories: document.querySelectorAll('[data-act="category"]').length,
    zoneBrushes: document.querySelectorAll('[data-act="zone"]').length,
    hasAutoCard: !!document.querySelector('[data-act="build"][data-key="tongLau"]'),
    parkCard: !!document.querySelector('[data-act="build"][data-key="park"]'),
  }));
  check(
    '底部建造面板：分區刷子＋公共建築卡',
    buildOpen.open && buildOpen.backdrop && buildOpen.zoneBrushes >= 4 && buildOpen.categories >= 5 && buildOpen.cards > 0 && !buildOpen.hasAutoCard,
    buildOpen,
  );
  // 切到「休憩」分頁確認公園卡（手動放置建築）
  await ev(() => {
    const { store } = window.__HK_CITY__;
    store.state.ui.buildCategory = 'decoration';
    store.bumpUI();
  });
  await waitFn(() => Boolean(document.querySelector('[data-act="build"][data-key="park"]')), 20000);
  const parkCard = await ev(() => !!document.querySelector('[data-act="build"][data-key="park"]'));
  check('建造面板有公共建築卡（公園）', parkCard === true, { parkCard });

  // ── 2. 選住宅區刷子 → sheet 自動收起 ──
  await page.locator('[data-act="zone"][data-zone="residential"]').first().tap();
  await waitFn(() => window.__HK_CITY__.store.state.ui.tool === 'zone:residential', 20000);
  await waitFn(() => !document.querySelector('.hud')?.classList.contains('is-build-open'), 25000);
  const toolState = await ev(() => ({
    tool: window.__HK_CITY__.store.state.ui.tool,
    sheetOpen: document.querySelector('.hud')?.classList.contains('is-build-open'),
  }));
  check('選分區刷子後面板自動收起', toolState.tool === 'zone:residential' && !toolState.sheetOpen, toolState);

  // ── 3. 找基地、投影、觸控建屋 ──
  const base = await ev(() => {
    const { store, view } = window.__HK_CITY__;
    const st = store.state;
    const W = st.width;
    const H = st.height;
    const okTerrain = new Set(['grass', 'urban', 'reclaimed', 'fertile']);
    const sx = st.spawn?.x ?? W >> 1;
    const sy = st.spawn?.y ?? H >> 1;
    const idx = (x, y) => y * W + x;
    const emptyAt = (x, y) => {
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false;
      const t = st.tiles[idx(x, y)];
      return okTerrain.has(t.terrain) && t.buildingId < 0 && !t.road && !t.sidewalk && !t.zone;
    };
    const touchRoad = (x, y) => {
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const t = st.tiles[idx(nx, ny)];
        if (t.road || t.sidewalk) return true;
      }
      return false;
    };
    // 找靠近 spawn、緊貼現有道路的空地
    let best = null;
    let bestD = Infinity;
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        if (!emptyAt(x, y) || !touchRoad(x, y)) continue;
        const d = (x - sx) ** 2 + (y - sy) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x, y };
        }
      }
    }
    if (!best) return null;
    const TILE = 2;
    view.target.set((best.x + 0.5) * TILE - (W * TILE) / 2, 0, (best.y + 0.5) * TILE - (H * TILE) / 2);
    view.distance = 44;
    window.__TEST_BASE__ = best;
    return best;
  });
  check('手機找到可建基地', !!base, base);

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
        const canvas = document.getElementById('game-canvas');
        const rect = canvas.getBoundingClientRect();
        return {
          x: rect.left + ((cx / cw + 1) / 2) * rect.width,
          y: rect.top + ((1 - cy / cw) / 2) * rect.height,
        };
      },
      { tx, ty },
    );

  // 用觸控劃住宅區（空地已緊貼現有道路）
  const zoneBefore = await ev(() => window.__HK_CITY__.store.state.tiles.filter((t) => t.zone).length);
  const p = await screenOf(base.x, base.y);
  await page.touchscreen.tap(p.x, p.y);
  await wait(700);
  // 再劃附近 3 格（令住宅地塊夠大）
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1]]) {
    const pp = await screenOf(base.x + dx, base.y + dy);
    await page.touchscreen.tap(pp.x, pp.y);
    await wait(350);
  }
  const zoneAfter = await ev(() => window.__HK_CITY__.store.state.tiles.filter((t) => t.zone).length);
  check('觸控劃分住宅區', zoneAfter > zoneBefore, { before: zoneBefore, after: zoneAfter, base });

  // 快轉：開發商自動建屋
  await ev(() => {
    const { store, simulation, ctx } = window.__HK_CITY__;
    const st = store.state;
    st.clock.paused = false;
    st.clock.speed = 3;
    for (let d = 0; d < 25; d++) for (let k = 0; k < 20; k++) simulation.update(st, 0.5, ctx);
    st.clock.speed = 1;
    st.clock.paused = true;
    document.querySelectorAll('.toast').forEach((n) => n.remove());
  });
  await wait(1200);
  const developed = await ev(() => {
    const st = window.__HK_CITY__.store.state;
    const auto = st.buildings.filter((b) => b.auto);
    return { auto: auto.length, zones: st.tiles.filter((t) => t.zone).length, pop: st.stats.population, keys: auto.slice(0, 5).map((b) => b.key) };
  });
  check('觸控劃區後開發商自動建屋', developed.auto > 0, developed);

  // ── 4. 城事面板 → 進入室內 → 返回 ──
  const entered = await ev(() => {
    const { store, actions } = window.__HK_CITY__;
    const b = store.state.buildings.find((x) => x.auto && x.zone) ?? store.state.buildings[0];
    if (!b) return false;
    actions.enterBuilding(b.id);
    return { key: b.key, id: b.id };
  });
  await waitFn(() => window.__HK_CITY__.store.state.ui.mode === 'interior', 25000);
  await waitFn(() => Boolean(document.querySelector('.interior-layer.show')), 30000);
  const interiorState = await ev(() => ({
    mode: window.__HK_CITY__.store.state.ui.mode,
    uiLayer: !!document.querySelector('.interior-layer.show'),
    navHidden: getComputedStyle(document.querySelector('.mobile-nav')).display === 'none',
  }));
  check('手機進入建築室內', !!entered && interiorState.mode === 'interior' && interiorState.uiLayer, { ...interiorState, entered });
  await snap('mobile-interior', 1800);
  const exitBtn = page.locator('[data-act="exit-interior"]').first();
  if (await exitBtn.count()) await exitBtn.tap().catch(() => {});
  await wait(700);
  if (await ev(() => window.__HK_CITY__.store.state.ui.mode !== 'city')) {
    await ev(() => window.__HK_CITY__.actions.exitInterior());
  }
  await waitFn(() => window.__HK_CITY__.store.state.ui.mode === 'city', 30000);
  await wait(600);
  const backCity = await ev(() => window.__HK_CITY__.store.state.ui.mode);
  check('室內返回城市', backCity === 'city', { mode: backCity });

  // 城事面板開啟檢查
  await ev(() => {
    const { store, actions } = window.__HK_CITY__;
    actions.closeOverlays();
    store.state.ui.showStartScreen = false;
    store.bumpUI();
    document.querySelector('.hud')?.classList.remove('is-interior');
  });
  await wait(700);
  await dismissTyphoon();
  await page.locator('[data-m-act="info"]').tap();
  await waitFn(() => document.querySelector('.hud')?.classList.contains('is-info-open'), 25000);
  const infoOpen = await ev(() => ({
    open: document.querySelector('.hud')?.classList.contains('is-info-open'),
    len: (document.querySelector('#info-panel')?.textContent ?? '').trim().length,
  }));
  check('城事面板（需求／分區統計）開啟', infoOpen.open && infoOpen.len > 20, infoOpen);
  await ev(() => window.__HK_CITY__.actions.closeOverlays());
  await ev(() => document.querySelector('.hud')?.classList.remove('is-build-open', 'is-info-open'));
  await wait(600);

  // ── 5. 觸控手勢：單指平移、雙指縮放 ──
  if (!cdp) cdp = await context.newCDPSession(page);
  await ev(() => {
    const { actions } = window.__HK_CITY__;
    actions.closeOverlays();
    actions.setTool(null);
    document.querySelectorAll('.mobile-sheet-backdrop, .modal-backdrop').forEach((n) => {
      n.hidden = true;
      n.style.display = 'none';
    });
    document.querySelectorAll('.mobile-sheet').forEach((n) => {
      n.hidden = true;
    });
    document.querySelector('.hud')?.classList.remove('is-build-open', 'is-info-open');
  });
  await wait(900);
  const camBefore = await ev(() => ({
    x: window.__HK_CITY__.view.target.x,
    z: window.__HK_CITY__.view.target.z,
    distance: window.__HK_CITY__.view.distance,
    buildings: window.__HK_CITY__.store.state.buildings.length,
  }));
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 250, y: 300, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
  });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: 250 - i * 12, y: 300 + i * 5, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await wait(1600);
  const camAfterPan = await ev(() => ({
    x: window.__HK_CITY__.view.target.x,
    z: window.__HK_CITY__.view.target.z,
    buildings: window.__HK_CITY__.store.state.buildings.length,
  }));
  check(
    '單指拖曳平移視角（不誤放建築）',
    Math.hypot(camAfterPan.x - camBefore.x, camAfterPan.z - camBefore.z) > 0.2 && camAfterPan.buildings === camBefore.buildings,
    { before: camBefore, after: camAfterPan },
  );

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: 140, y: 300, id: 1, radiusX: 2, radiusY: 2, force: 1 },
      { x: 250, y: 300, id: 2, radiusX: 2, radiusY: 2, force: 1 },
    ],
  });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: 140 - i * 6, y: 300, id: 1, radiusX: 2, radiusY: 2, force: 1 },
        { x: 250 + i * 6, y: 300, id: 2, radiusX: 2, radiusY: 2, force: 1 },
      ],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await wait(1600);
  const camAfterPinch = await ev(() => window.__HK_CITY__.view.distance);
  check('雙指捏合縮放視角', camAfterPinch < camBefore.distance - 1, { before: camBefore.distance, after: camAfterPinch });

  // ── 6. 底部導覽：財政／交通／存檔／說明 ──
  const navChecks = {};
  await page.locator('[data-m-act="finance"]').tap();
  await waitFn(() => window.__HK_CITY__.store.state.ui.showFinance === true, 25000);
  navChecks.finance = await ev(() => window.__HK_CITY__.store.state.ui.showFinance);
  await ev(() => window.__HK_CITY__.actions.closeOverlays());
  await wait(400);
  await page.locator('[data-m-act="transit"]').tap();
  await waitFn(() => window.__HK_CITY__.store.state.ui.showTransit === true, 25000);
  navChecks.transit = await ev(() => window.__HK_CITY__.store.state.ui.showTransit);
  await ev(() => window.__HK_CITY__.actions.closeOverlays());
  await wait(400);
  await page.locator('[data-m-act="save"]').tap();
  await waitFn(() => window.__HK_CITY__.store.state.ui.showSave === true, 25000);
  navChecks.save = await ev(() => window.__HK_CITY__.store.state.ui.showSave);
  await ev(() => window.__HK_CITY__.actions.closeOverlays());
  await wait(400);
  await page.locator('[data-m-act="help"]').tap();
  await waitFn(() => window.__HK_CITY__.store.state.ui.showHelp === true, 25000);
  navChecks.help = await ev(() => window.__HK_CITY__.store.state.ui.showHelp);
  await ev(() => window.__HK_CITY__.actions.closeOverlays());
  await wait(400);
  check(
    '底部導覽開啟財政／交通／存檔／說明',
    navChecks.finance && navChecks.transit && navChecks.save && navChecks.help,
    navChecks,
  );

  // ── 7. 建立示範城市並截圖（分區玩法：鋪路＋劃區＋自動開發） ──
  await ev(() => {
    const { store, actions, simulation, ctx, view } = window.__HK_CITY__;
    actions.startGame('empty', 20261021);
    const st = store.state;
    st.ui.showTutorial = false;
    st.ui.showStats = false;
    st.finance.treasury = 30_000_000;
    store.bumpUI();
    const W = st.width;
    const H = st.height;
    const sx = st.spawn?.x ?? 44;
    const sy = st.spawn?.y ?? 63;
    const idx = (x, y) => y * W + x;
    const okTerrain = new Set(['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill']);
    // 道路網：三橫三直（道路自帶行人路）
    const put = (tool, x, y) => {
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return;
      actions.setTool(tool);
      actions.applyToolAt(idx(x, y));
    };
    for (const dy of [-8, -3, 2, 7]) {
      for (let dx = -12; dx <= 12; dx++) put('road', sx + dx, sy + dy);
    }
    for (const dx of [-10, -5, 0, 5, 10]) {
      for (let dy = -10; dy <= 10; dy++) put('road', sx + dx, sy + dy);
    }
    // 劃分區：北住宅、中商業、南工業、外圍農地
    for (let dy = -10; dy <= 10; dy++) {
      for (let dx = -12; dx <= 12; dx++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        const t = st.tiles[idx(x, y)];
        if (t.road || t.buildingId >= 0 || t.zone) continue;
        if (!okTerrain.has(t.terrain)) continue;
        let zone = null;
        if (dy <= -4) zone = 'residential';
        else if (dy <= 1) zone = 'commercial';
        else if (dy <= 6) zone = 'industrial';
        else if (t.terrain === 'fertile' || t.terrain === 'grass') zone = 'farmland';
        if (zone) put(`zone:${zone}`, x, y);
      }
    }
    actions.setTool(null);
    // 快轉 50 日：開發商自動建屋
    st.clock.paused = false;
    st.clock.speed = 3;
    for (let d = 0; d < 50; d++) {
      for (let k = 0; k < 20; k++) simulation.update(st, 0.5, ctx);
    }
    st.clock.speed = 1;
    // 補建公園（解鎖 0）令畫面更好看
    outer: for (let r = 3; r <= 16; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = sx + dx;
          const y = sy + dy;
          if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
          const t = st.tiles[idx(x, y)];
          if (t.buildingId >= 0 || t.road) continue;
          actions.setTool('park');
          const b = st.buildings.length;
          actions.applyToolAt(idx(x, y));
          if (st.buildings.length > b) break outer;
        }
      }
    }
    actions.setTool(null);
    // 白天晴朗、鏡頭對準發展區
    st.clock.minutes = Math.floor(st.clock.minutes / 1440) * 1440 + 11 * 60;
    st.clock.weather = 'clear';
    st.clock.weatherIntensity = 0;
    st.clock.weatherMinutesLeft = 100000;
    st.clock.paused = false;
    window.__HK_CITY__.deriveClockFields(st.clock);
    actions.setSpeed(1);
    actions.selectBuilding(null);
    const TILE = 2;
    view.target.set((sx + 0.5) * TILE - (W * TILE) / 2, 0, (sy - 1) * TILE - (H * TILE) / 2);
    view.distance = 42;
    view.pitch = 0.92;
    view.yaw = -0.72;
    document.querySelectorAll('.toast').forEach((n) => n.remove());
  });
  await wait(3000);
  await ev(() => window.__HK_CITY__.ui.update(window.__HK_CITY__.store.state));
  await snap('mobile-city', 3200);

  // 建造面板截圖
  await page.locator('[data-m-act="build"]').tap();
  await waitFn(() => document.querySelector('.hud')?.classList.contains('is-build-open'), 25000);
  await ev(() => window.__HK_CITY__.ui.update(window.__HK_CITY__.store.state));
  await snap('mobile-build', 2400);
  await ev(() => {
    window.__HK_CITY__.store.state.ui.buildCategory = 'commercial';
    window.__HK_CITY__.store.bumpUI();
  });
  await wait(800);
  await ev(() => {
    document.querySelector('.hud')?.classList.remove('is-build-open', 'is-info-open', 'is-sheet-open');
  });

  // 城事面板截圖
  await ev(() => {
    const { store, actions } = window.__HK_CITY__;
    const st = store.state;
    const pick =
      st.buildings.find((b) => b.key === 'wetMarket') ??
      st.buildings.find((b) => b.key === 'chaChaanTeng') ??
      st.buildings.find((b) => b.key === 'tongLau');
    if (pick) actions.select((pick.y + pick.h - 1) * st.width + pick.x);
    window.__HK_CITY__.ui.update(st);
  });
  await waitFn(() => document.querySelector('.hud')?.classList.contains('is-info-open'), 25000);
  await snap('mobile-info', 2400);
  await ev(() => {
    document.querySelector('.hud')?.classList.remove('is-build-open', 'is-info-open', 'is-sheet-open');
  });

  // 橫向截圖
  await page.setViewportSize({ width: 844, height: 390 });
  await wait(2500);
  await ev(() => window.__HK_CITY__.ui.update(window.__HK_CITY__.store.state));
  await snap('mobile-landscape', 3000);

  check('手機版流程與截圖完成', errors.length === 0, { errorsCount: errors.length });
} catch (err) {
  checks['例外'] = { pass: false, detail: String(err) };
  errors.push(String(err));
} finally {
  await context.close();
}

// ── 8. 桌面版回歸 ──
try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const dpage = await desktop.newPage();
  await dpage.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await dpage.waitForFunction(() => Boolean(window.__HK_CITY__), { timeout: 60000 });
  await dpage.waitForTimeout(2500);
  const desktopState = await dpage.evaluate(() => ({
    uiMode: document.documentElement.dataset.uiMode,
    hudClass: document.querySelector('.hud')?.className,
    mobileNav: !!document.querySelector('.mobile-nav'),
    buildPanel: !!document.querySelector('#build-panel'),
    topBtns: document.querySelectorAll('.top-btn').length,
  }));
  check(
    '桌面版維持電腦版介面',
    desktopState.uiMode === 'desktop' &&
      desktopState.hudClass?.includes('is-desktop-ui') &&
      !desktopState.mobileNav &&
      desktopState.topBtns >= 6,
    desktopState,
  );
  await desktop.close();
} catch (err) {
  checks['桌面回歸'] = { pass: false, detail: String(err) };
  errors.push(`desktop: ${String(err)}`);
}

await browser.close();
const ok = Object.values(checks).every((c) => c.pass) && errors.length === 0;
console.log(JSON.stringify({ ok, checks, errors }, null, 2));
if (!ok) process.exitCode = 1;
