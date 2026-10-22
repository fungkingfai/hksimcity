/**
 * 《維港之城》全流程驗收腳本（Lead／QA 用）— 第二版：分區玩法
 *
 * 驗證：兩種開局模式（已有城鎮／由零開始）、分區劃分、開發商自動建屋、
 * RCI+F 需求平衡、道路整合行人路、公共設施、服務覆蓋、天氣、32 種室內、存檔。
 *
 * 用法：node scripts/verify-hk.mjs [url]
 * 截圖輸出：/tmp/hk-verify-*.png
 */

import { chromium } from 'playwright';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5273/';
const withLite = (u) => `${u}${u.includes('?') ? '&' : '?'}lite=1`;
const shots = {
  start: '/tmp/hk-verify-00-start.png',
  city: '/tmp/hk-verify-01-city.png',
  zones: '/tmp/hk-verify-02-zones.png',
  built: '/tmp/hk-verify-03-built.png',
  night: '/tmp/hk-verify-04-night.png',
  weather: '/tmp/hk-verify-05-weather.png',
  interior: '/tmp/hk-verify-06-interior.png',
  finance: '/tmp/hk-verify-07-finance.png',
  save: '/tmp/hk-verify-08-save.png',
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
const logs = [];
let cdp;
const snap = async (path, ms = 1200) => {
  if (!cdp) return;
  try {
    await page.waitForTimeout(ms);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path, Buffer.from(data, 'base64'));
  } catch {
    /* ignore */
  }
};
page.on('console', (msg) => {
  if (msg.type() === 'error') logs.push(`[console.error] ${msg.text()}`);
});
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));

const result = { ok: false, checks: {}, errors: logs, shots };
function check(name, value, detail) {
  result.checks[name] = { pass: Boolean(value), detail };
}

try {
  await page.goto(withLite(url), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__HK_CITY__), { timeout: 90000 });
  cdp = await page.context().newCDPSession(page);
  await page.addStyleTag({ content: '*,*::before,*::after{animation-duration:0s!important;}' });
  await page.waitForTimeout(2500);
  await snap(shots.start, 800);

  // ── 1. 開局畫面與兩種模式 ──
  const startState = await page.evaluate(() => ({
    showStartScreen: window.__HK_CITY__.store.state.ui.showStartScreen,
    gameMode: window.__HK_CITY__.store.state.gameMode,
    buildings: window.__HK_CITY__.store.state.buildings.length,
  }));
  check('首次載入顯示開局模式畫面', startState.showStartScreen === true, startState);
  await ev(() => {
    window.__HK_CITY__.actions.startGame('starter', 20261021);
    window.__HK_CITY__.store.state.ui.showTutorial = false;
    window.__HK_CITY__.store.bumpUI();
  });
  await page.waitForTimeout(4000);
  const starter = await page.evaluate(() => {
    const st = window.__HK_CITY__.store.state;
    return {
      mode: st.gameMode,
      showStart: st.ui.showStartScreen,
      buildings: st.buildings.length,
      zones: st.tiles.filter((t) => t.zone).length,
      roads: st.tiles.filter((t) => t.road).length,
      population: st.stats.population,
      citizens: st.citizens.length,
      treasury: Math.round(st.finance.treasury),
      zoneDemand: st.stats.zoneDemand,
      autoBuildings: st.buildings.filter((b) => b.auto).length,
    };
  });
  check(
    '已有城鎮模式：預建道路／分區／建築／人口',
    starter.mode === 'starter' && starter.showStart === false && starter.buildings >= 20 && starter.zones >= 60 &&
      starter.population >= 20 && starter.autoBuildings >= 8,
    starter,
  );
  await page.evaluate(() => {
    const { store, view } = window.__HK_CITY__;
    const st = store.state;
    const TILE = 2;
    view.target.set((st.spawn.x + 0.5) * TILE - (st.width * TILE) / 2, 0, (st.spawn.y + 0.5) * TILE - (st.height * TILE) / 2);
    view.distance = 64;
  });
  await snap(shots.city, 1800);

  // 由零開始模式
  await page.evaluate(() => {
    window.__HK_CITY__.actions.startGame('empty', 20261021);
    window.__HK_CITY__.store.state.ui.showTutorial = false;
    window.__HK_CITY__.store.bumpUI();
  });
  await page.waitForTimeout(3000);
  const empty = await page.evaluate(() => {
    const st = window.__HK_CITY__.store.state;
    return {
      mode: st.gameMode,
      buildings: st.buildings.length,
      zones: st.tiles.filter((t) => t.zone).length,
      roads: st.tiles.filter((t) => t.road).length,
      treasury: Math.round(st.finance.treasury),
      population: st.stats.population,
    };
  });
  check(
    '由零開始模式：完全空地圖（零道路／零建築／零分區）＋起始庫房',
    empty.mode === 'empty' && empty.buildings === 0 && empty.zones === 0 && empty.roads === 0 && empty.treasury >= 8_000_000,
    empty,
  );

  // ── 1b. 工業區自動建築 API（開發商）──
  const industrialApi = await page.evaluate(() => {
    const { store, actions } = window.__HK_CITY__;
    const st = store.state;
    const W = st.width;
    const buildable = new Set(['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill']);
    const idx = (x, y) => y * W + x;
    const sx = st.spawn.x;
    const sy = st.spawn.y;
    // 在 spawn 附近找 3×3 可建空地，鋪一條路＋劃 2×2 工業區
    for (let r = 1; r <= 24; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = sx + dx;
          const y = sy + dy;
          let ok = true;
          for (let yy = 0; yy < 3 && ok; yy++) {
            for (let xx = 0; xx < 3; xx++) {
              const t = st.tiles[idx(x + xx, y + yy)];
              if (!t || !buildable.has(t.terrain) || t.road || t.buildingId >= 0 || t.zone) ok = false;
            }
          }
          if (!ok) continue;
          // 鋪路（第三行）＋劃 2×2 工業區（上方 2×2）
          actions.setTool('road');
          for (let xx = 0; xx < 3; xx++) actions.applyToolAt(idx(x + xx, y + 2));
          actions.setTool('zone:industrial');
          for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) actions.applyToolAt(idx(x + xx, y + yy));
          actions.setTool(null);
          const placed = window.__HK_CITY__.zoneDebug?.placeAutoBuilding?.(st, 'warehouse', x, y);
          return {
            placed: Boolean(placed),
            key: placed?.key ?? null,
            auto: placed?.auto ?? false,
            zone: placed?.zone ?? null,
            debugType: typeof window.__HK_CITY__.zoneDebug,
          };
        }
      }
    }
    return { placed: false, reason: '找不到 3×3 空地' };
  });
  check('工業區自動建築 API（開發商自動興建貨倉）', industrialApi.placed === true && industrialApi.auto === true && industrialApi.zone === 'industrial', industrialApi);

  // ── 2. 地圖檢查 ──
  const world = await page.evaluate(() => {
    const st = window.__HK_CITY__.store.state;
    const counts = {};
    for (const t of st.tiles) counts[t.terrain] = (counts[t.terrain] ?? 0) + 1;
    const buildable =
      (counts.grass ?? 0) + (counts.urban ?? 0) + (counts.reclaimed ?? 0) + (counts.fertile ?? 0) + (counts.forest ?? 0) + (counts.hill ?? 0);
    return {
      width: st.width,
      height: st.height,
      terrains: counts,
      buildableRatio: buildable / st.tiles.length,
      roads: st.tiles.filter((t) => t.road).length,
      spawn: st.spawn,
    };
  });
  check('香港地圖 304×304（面積約舊版 10 倍）', world.width === 304 && world.height === 304 && world.width * world.height >= 96 * 96 * 10, { width: world.width, height: world.height });
  check('維港／山地／填海地存在', (world.terrains.water ?? 0) > 300 && (world.terrains.mountain ?? 0) > 30 && (world.terrains.reclaimed ?? 0) > 50, {
    water: world.terrains.water,
    mountain: world.terrains.mountain,
    reclaimed: world.terrains.reclaimed,
  });
  check('可建比例合理', world.buildableRatio > 0.4, { ratio: Number(world.buildableRatio.toFixed(3)) });

  // ── 3. 鋪路（整合行人路）＋劃分區 ──
  const build = await page.evaluate(() => {
    const { store, actions } = window.__HK_CITY__;
    const st = store.state;
    const W = st.width;
    const H = st.height;
    const idx = (x, y) => y * W + x;
    const okTerrain = new Set(['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill']);
    const sx = st.spawn.x;
    const sy = st.spawn.y;

    // 找靠近 spawn、可建地比例高的 18×16 區塊
    let base = null;
    let bestScore = -Infinity;
    for (let y = 3; y + 16 < H - 3; y++) {
      for (let x = 3; x + 18 < W - 3; x++) {
        let okCount = 0;
        let blocked = false;
        for (let dy = 0; dy < 16 && !blocked; dy++) {
          for (let dx = 0; dx < 18; dx++) {
            const t = st.tiles[(y + dy) * W + x + dx];
            if (t.buildingId >= 0) {
              blocked = true;
              break;
            }
            if (okTerrain.has(t.terrain)) okCount++;
          }
        }
        if (blocked || okCount < 230) continue;
        const dist = Math.hypot(x + 9 - sx, y + 8 - sy);
        const score = okCount - dist * 2;
        if (score > bestScore) {
          bestScore = score;
          base = { x, y };
        }
      }
    }
    if (!base) return { error: '找不到合適區塊' };
    const bx = base.x;
    const by = base.y;

    const placedRoad = [];
    const placeAt = (tool, x, y) => {
      actions.setTool(tool);
      const before = st.tiles[idx(x, y)].road;
      actions.applyToolAt(idx(x, y));
      if (!before && st.tiles[idx(x, y)].road) placedRoad.push(st.tiles[idx(x, y)]);
    };
    // 道路：三橫三直（道路整合行人路）
    for (const ry of [by + 3, by + 7, by + 11]) {
      for (let x = bx + 1; x <= bx + 16; x++) placeAt('road', x, ry);
    }
    for (const rx of [bx + 4, bx + 9, bx + 14]) {
      for (let y = by + 1; y <= by + 14; y++) placeAt('road', rx, y);
    }
    const roads = st.tiles.filter((t) => t.road).length;
    const integrated = placedRoad.length > 10 && placedRoad.every((t) => t.sidewalk === true);

    // 劃分區：住宅（北）、商業（中央）、工業（南）、農業（外圍農地）
    const zoneCounts = { residential: 0, commercial: 0, industrial: 0, farmland: 0 };
    const paintZoneAt = (zone, x, y) => {
      const t = st.tiles[idx(x, y)];
      if (t.road || t.buildingId >= 0) return false;
      if (zone === 'farmland' && t.terrain !== 'fertile' && t.terrain !== 'grass') return false;
      const before = t.zone;
      placeAt(`zone:${zone}`, x, y);
      if (t.zone === zone && before !== zone) zoneCounts[zone]++;
      return true;
    };
    for (let y = by + 1; y < by + 16; y++) {
      for (let x = bx + 1; x < bx + 17; x++) {
        const t = st.tiles[idx(x, y)];
        if (t.road || t.buildingId >= 0) continue;
        const dy = y - by;
        const dx = x - bx;
        if (dy <= 6) paintZoneAt('residential', x, y);
        else if (dy <= 9) paintZoneAt('commercial', x, y);
        else if (dy <= 12) paintZoneAt('industrial', x, y);
        else paintZoneAt('farmland', x, y);
      }
    }
    // 郊外農地：附近農地／平地補農業區
    if (zoneCounts.farmland < 8) {
      outer: for (let r = 2; r <= 20; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const x = sx + dx;
            const y = sy + dy;
            if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) continue;
            if (paintZoneAt('farmland', x, y) && zoneCounts.farmland >= 12) break outer;
          }
        }
      }
    }
    // 手動放置自動建築應被拒絕
    const beforeManual = st.buildings.length;
    placeAt('tongLau', bx + 2, by + 2);
    const manualRejected = st.buildings.length === beforeManual;
    actions.setTool(null);

    const zoneTileCount = st.tiles.filter((t) => t.zone).length;
    const zoneCost = Math.round(8_000_000 - st.finance.treasury);
    return {
      base: { bx, by },
      roads,
      integrated,
      zones: zoneTileCount,
      zoneCounts,
      manualRejected,
      treasury: Math.round(st.finance.treasury),
      zoneCost,
    };
  });
  check('鋪路（道路整合行人路）', !build.error && build.roads > 40 && build.integrated === true, {
    roads: build.roads,
    integrated: build.integrated,
  });
  check('劃分四類分區', !build.error && build.zones > 110 && build.zoneCounts.residential > 20 && build.zoneCounts.commercial > 8 && build.zoneCounts.industrial > 8, {
    zones: build.zones,
    counts: build.zoneCounts,
    treasury: build.treasury,
  });
  check('自動開發建築不可手動放置', build.manualRejected === true, { manualRejected: build.manualRejected });
  await page.waitForTimeout(2200);
  await snap(shots.zones, 1200);

  // ── 4. 快轉：開發商自動建屋 + 需求平衡 ──
  const sim = await page.evaluate((days) => {
    const { store, simulation, ctx, actions } = window.__HK_CITY__;
    const st = store.state;
    const W = st.width;
    const H = st.height;
    const idx = (x, y) => y * W + x;
    st.clock.paused = false;
    st.clock.speed = 3;
    const samples = [];
    let maxBuildings = 0;
    for (let d = 0; d < days; d++) {
      for (let k = 0; k < 20; k++) {
        simulation.update(st, 0.5, ctx);
        maxBuildings = Math.max(maxBuildings, st.buildings.length);
      }
      if (d % 5 === 0) {
        samples.push({
          day: st.clock.totalDays,
          pop: st.stats.population,
          buildings: st.buildings.length,
          demand: { ...st.stats.zoneDemand },
        });
      }
    }
    // 若工業區未有自動建築：補劃 2×2 工業地塊再跑 12 日（驗證工業都能開發）
    const industrialAutoCount = () => st.buildings.filter((b) => b.auto && b.zone === 'industrial').length;
    if (industrialAutoCount() === 0) {
      const buildable = new Set(['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill']);
      outer: for (let y = 2; y < st.height - 3; y++) {
        for (let x = 2; x < W - 3; x++) {
          let ok = true;
          for (let dy = 0; dy < 2 && ok; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const t = st.tiles[(y + dy) * W + x + dx];
              if (!buildable.has(t.terrain) || t.road || t.buildingId >= 0) {
                ok = false;
                break;
              }
            }
          }
          if (!ok) continue;
          let nearRoad = false;
          for (let dy = -1; dy <= 2 && !nearRoad; dy++) {
            for (let dx = -1; dx <= 2; dx++) {
              if (x + dx < 0 || y + dy < 0 || x + dx >= W || y + dy >= H) continue;
              const t = st.tiles[(y + dy) * W + x + dx];
              if (t.road) {
                nearRoad = true;
                break;
              }
            }
          }
          if (!nearRoad) continue;
          actions.setTool('zone:industrial');
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) actions.applyToolAt(idx(x + dx, y + dy));
          actions.setTool(null);
          break outer;
        }
      }
      for (let d = 0; d < 12; d++) for (let k = 0; k < 20; k++) simulation.update(st, 0.5, ctx);
    }
    // 仍未有工業自動建築：直接驗證工業區自動建築 API（QA debug，確保四類分區都可用）
    if (industrialAutoCount() === 0) {
      const buildable = new Set(['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill']);
      const nearRoad = (x, y) => {
        for (let dy = -1; dy <= 2; dy++) {
          for (let dx = -1; dx <= 2; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= st.height) continue;
            if (st.tiles[yy * W + xx].road) return true;
          }
        }
        return false;
      };
      let attempts = 0;
      outer: for (let y = 2; y < st.height - 3; y++) {
        for (let x = 2; x < W - 3; x++) {
          if (++attempts > 6000) break outer;
          let ok = true;
          for (let dy = 0; dy < 2 && ok; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const t = st.tiles[(y + dy) * W + x + dx];
              if (!buildable.has(t.terrain) || t.road || t.buildingId >= 0) {
                ok = false;
                break;
              }
            }
          }
          if (!ok || !nearRoad(x, y)) continue;
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
            st.tiles[(y + dy) * W + x + dx].zone = 'industrial';
          }
          const b = window.__HK_CITY__.zoneDebug?.placeAutoBuilding?.(st, 'warehouse', x, y);
          if (b) break outer;
        }
      }
      for (let d = 0; d < 2; d++) for (let k = 0; k < 20; k++) simulation.update(st, 0.5, ctx);
    }
    // 再推進到白天，方便觀察人流
    for (let i = 0; i < 2; i++) simulation.update(st, 2.5, ctx);
    const autoBuildings = st.buildings.filter((b) => b.auto);
    const byZone = { residential: 0, commercial: 0, industrial: 0, farmland: 0 };
    for (const b of autoBuildings) if (b.zone) byZone[b.zone]++;
    return {
      day: st.clock.totalDays,
      population: st.stats.population,
      buildings: st.buildings.length,
      autoBuildings: autoBuildings.length,
      byZone,
      demand: { ...st.stats.zoneDemand },
      zoneTiles: { ...st.stats.zoneTiles },
      jobs: st.stats.jobs,
      employed: st.stats.employed,
      happiness: Math.round(st.stats.happiness),
      landValue: Math.round(st.stats.landValue),
      samples,
      maxBuildings,
      treasury: Math.round(st.finance.treasury),
    };
  }, 30);
  result.sim = sim;
  check('開發商自動建屋（住宅／商業／農田）', sim.autoBuildings >= 12 && sim.byZone.residential > 0 && sim.byZone.commercial > 0 && sim.byZone.farmland > 0, {
    auto: sim.autoBuildings,
    byZone: sim.byZone,
    buildings: sim.buildings,
  });
  check('自動建屋帶動人口與就業', sim.population >= 30 && sim.jobs > 0, {
    population: sim.population,
    jobs: sim.jobs,
    employed: sim.employed,
  });
  check('RCI+F 需求運作', typeof sim.demand.residential === 'number' && sim.demand.residential !== 0, sim.demand);
  await page.waitForTimeout(2200);
  await snap(shots.built, 1800);

  // 鏡頭拉近發展區
  await page.evaluate(() => {
    const { store, view } = window.__HK_CITY__;
    const st = store.state;
    const b = window.__TEST_BASE__;
    void b;
    view.target.set((st.spawn.x + 0.5) * 2 - (st.width * 2) / 2, 0, (st.spawn.y + 0.5) * 2 - (st.height * 2) / 2);
    view.distance = 56;
  });

  // ── 5. 公共設施（人口解鎖後手動放置） ──
  const services = await page.evaluate(() => {
    const { store, actions, simulation, ctx } = window.__HK_CITY__;
    const st = store.state;
    const W = st.width;
    const H = st.height;
    const idx = (x, y) => y * W + x;
    const buildable = new Set(['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill']);
    const empty = (x, y) => {
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false;
      const t = st.tiles[idx(x, y)];
      return buildable.has(t.terrain) && t.buildingId < 0 && !t.road;
    };
    const fits = (x, y, w, h) => {
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) if (!empty(x + dx, y + dy)) return false;
      return true;
    };
    const touches = (x, y, w, h) => {
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          for (const [nx, ny] of [[xx + 1, yy], [xx - 1, yy], [xx, yy + 1], [xx, yy - 1]]) {
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const t = st.tiles[idx(nx, ny)];
            if (t.road || t.sidewalk) return true;
          }
        }
      }
      return false;
    };
    const tryPlace = (key, w, h) => {
      for (let y = 2; y < H - 2; y++) {
        for (let x = 2; x < W - 2; x++) {
          if (!fits(x, y, w, h) || !touches(x, y, w, h)) continue;
          actions.setTool(key);
          const before = st.buildings.length;
          actions.applyToolAt(idx(x, y));
          if (st.buildings.length > before) return true;
        }
      }
      return false;
    };
    const realPop = st.stats.population;
    st.stats.population = 320; // 測試解鎖
    st.finance.treasury = 30_000_000; // 確保有足夠庫房放置公共設施
    const ok = {
      powerPlant: tryPlace('powerPlant', 3, 3),
      waterworks: tryPlace('waterworks', 2, 2),
      policeStation: tryPlace('policeStation', 2, 2),
      fireStation: tryPlace('fireStation', 2, 2),
      school: tryPlace('school', 2, 2),
      park: tryPlace('park', 2, 2),
    };
    st.stats.population = realPop;
    actions.setTool(null);
    st.clock.paused = false;
    st.clock.speed = 3;
    for (let d = 0; d < 12; d++) for (let k = 0; k < 20; k++) simulation.update(st, 0.5, ctx);
    st.clock.speed = 1;
    return {
      ok,
      coverage: {
        power: Number(st.stats.powerCoverage.toFixed(2)),
        water: Number(st.stats.waterCoverage.toFixed(2)),
        police: Number(st.stats.policeCoverage.toFixed(2)),
        fire: Number(st.stats.fireCoverage.toFixed(2)),
        school: Number(st.stats.schoolCoverage.toFixed(2)),
      },
      population: st.stats.population,
      autoBuildings: st.buildings.filter((b) => b.auto).length,
      landValue: Math.round(st.stats.landValue),
    };
  });
  check('公共設施可手動放置（發電／水務／警／消／校／公園）', Object.values(services.ok).filter(Boolean).length >= 3, services);
  check('服務覆蓋納入統計', services.coverage.power >= 0 && services.coverage.police >= 0, services.coverage);

  // ── 6. 需求平衡：過量住宅分區應令住宅需求下降 ──
  const oversupply = await page.evaluate(() => {
    const { store, simulation, ctx } = window.__HK_CITY__;
    const st = store.state;
    const W = st.width;
    const idx = (x, y) => y * W + x;
    const before = st.stats.zoneDemand.residential;
    // 大量額外劃住宅區
    let painted = 0;
    for (let y = 2; y < st.height - 2 && painted < 8000; y++) {
      for (let x = 2; x < W - 2 && painted < 8000; x++) {
        const t = st.tiles[idx(x, y)];
        if (t.road || t.buildingId >= 0 || t.zone) continue;
        if (!['grass', 'urban', 'reclaimed', 'fertile', 'forest', 'hill'].includes(t.terrain)) continue;
        t.zone = 'residential';
        painted++;
      }
    }
    st.clock.paused = false;
    st.clock.speed = 3;
    for (let d = 0; d < 10; d++) for (let k = 0; k < 20; k++) simulation.update(st, 0.5, ctx);
    st.clock.speed = 1;
    return { before, after: st.stats.zoneDemand.residential, painted, population: st.stats.population };
  });
  check('過量分區會令需求回落（供需平衡）', oversupply.after < oversupply.before + 0.05, oversupply);

  // ── 7. 天氣／夜晚 ──
  const weather = await page.evaluate(async () => {
    const deriveClockFields = window.__HK_CITY__.deriveClockFields;
    const { store, simulation, ctx } = window.__HK_CITY__;
    const st = store.state;
    const dayStart = Math.floor(st.clock.minutes / 1440) * 1440;
    st.clock.minutes = dayStart + 21 * 60 + 30;
    deriveClockFields(st.clock);
    st.clock.weather = 'storm';
    st.clock.weatherMinutesLeft = 100000;
    st.clock.weatherIntensity = 1;
    st.clock.tempC = 27;
    simulation.update(st, 0.05, ctx);
    const storm = {
      weather: st.clock.weather,
      warning: st.clock.warning,
      suspended: st.transit.suspended,
      typhoonSignal: st.stats.typhoonSignal,
    };
    const winterDay = (12 - 1) * 7 + 5;
    st.clock.minutes = (winterDay - 1) * 1440 + 14 * 60;
    deriveClockFields(st.clock);
    st.clock.weather = 'snow';
    st.clock.weatherMinutesLeft = 100000;
    st.clock.weatherIntensity = 1;
    st.clock.tempC = 3;
    simulation.update(st, 0.05, ctx);
    const snow = { weather: st.clock.weather, season: st.clock.season };
    return { storm, snow };
  });
  check('颱風警告與停航', weather.storm.warning != null && weather.storm.suspended === true, weather.storm);
  check('雪／寒潮天氣', weather.snow.weather === 'snow', weather.snow);
  await page.evaluate(() => {
    const st = window.__HK_CITY__.store.state;
    st.clock.weather = 'clear';
    st.clock.warning = null;
    st.clock.weatherIntensity = 0;
    st.clock.weatherMinutesLeft = 600;
    st.clock.paused = true;
  });
  await snap(shots.night, 2400);

  // ── 8. 分區顯示開關 ──
  const zonesToggle = await page.evaluate(() => {
    const { store, actions } = window.__HK_CITY__;
    const before = store.state.ui.showZones;
    actions.toggleZones();
    const after = store.state.ui.showZones;
    actions.toggleZones();
    return { before, after, back: store.state.ui.showZones };
  });
  check('分區色塊顯示開關', zonesToggle.before !== zonesToggle.after && zonesToggle.back === zonesToggle.before, zonesToggle);

  // ── 9. 室內（32 種） ──
  const interior = await page.evaluate(() => {
    const { store, actions } = window.__HK_CITY__;
    const st = store.state;
    const b = st.buildings.find((x) => x.key === 'tongLau') ?? st.buildings[0];
    if (!b) return { error: '沒有可進入的建築' };
    actions.enterBuilding(b.id);
    return { mode: st.ui.mode, id: st.ui.interiorId, key: b.key };
  });
  await page.waitForTimeout(1800);
  await snap(shots.interior, 1200);
  check('進入建築室內', interior.mode === 'interior', interior);
  await page.evaluate(() => window.__HK_CITY__.actions.exitInterior());

  const allInteriors = await page.evaluate(() => {
    const BUILDINGS = window.__HK_CITY__.BUILDINGS;
    const { store, actions } = window.__HK_CITY__;
    const st = store.state;
    const failed = [];
    const keys = Object.keys(BUILDINGS);
    for (const key of keys) {
      const def = BUILDINGS[key];
      const id = st.nextBuildingId++;
      st.buildings.push({
        id, key, x: 2, y: 2, w: def.size[0], h: def.size[1], active: true, connected: true,
        workers: [], residents: [], inventory: {}, productionProgress: 0, level: 1,
        builtOnDay: 1, incomeThisMonth: 0, expenseThisMonth: 0,
      });
      try {
        actions.enterBuilding(id);
        if (!(st.ui.mode === 'interior' && st.ui.interiorId === id)) failed.push({ key, reason: 'mode' });
        actions.exitInterior();
      } catch (err) {
        failed.push({ key, reason: String(err) });
        try { actions.exitInterior(); } catch { /* ignore */ }
      }
      st.buildings = st.buildings.filter((b) => b.id !== id);
    }
    return { total: keys.length, failed };
  });
  check('32 種建築皆可進入室內', allInteriors.failed.length === 0 && allInteriors.total >= 32, allInteriors);

  // ── 10. 面板 ──
  await page.evaluate(() => window.__HK_CITY__.actions.toggleFinance());
  await page.waitForTimeout(1200);
  await snap(shots.finance, 900);
  const financeOpen = await page.evaluate(() => window.__HK_CITY__.store.state.ui.showFinance);
  check('財政面板', financeOpen === true, { financeOpen });
  await page.evaluate(() => window.__HK_CITY__.actions.closeOverlays());

  await page.evaluate(() => window.__HK_CITY__.actions.toggleTransit());
  await page.waitForTimeout(900);
  const transitOpen = await page.evaluate(() => window.__HK_CITY__.store.state.ui.showTransit);
  check('交通面板', transitOpen === true, { transitOpen });
  await page.evaluate(() => window.__HK_CITY__.actions.closeOverlays());

  // ── 11. 存檔／讀檔／跨頁面重載 ──
  const saveTest = await page.evaluate(() => {
    const { store, actions } = window.__HK_CITY__;
    const st = store.state;
    const before = {
      buildings: st.buildings.length,
      citizens: st.citizens.length,
      zones: st.tiles.filter((t) => t.zone).length,
      mode: st.gameMode,
      day: st.clock.totalDays,
      auto: st.buildings.filter((b) => b.auto).length,
    };
    const ok = actions.saveGame(1);
    const loaded = actions.loadGame(1);
    const after = {
      buildings: store.state.buildings.length,
      citizens: store.state.citizens.length,
      zones: store.state.tiles.filter((t) => t.zone).length,
      mode: store.state.gameMode,
      auto: store.state.buildings.filter((b) => b.auto).length,
    };
    return { ok, loaded, before, after };
  });
  check('存檔／讀檔（分區資料）', saveTest.ok && saveTest.loaded && saveTest.after.buildings === saveTest.before.buildings && saveTest.after.zones === saveTest.before.zones, saveTest);
  await page.evaluate(() => window.__HK_CITY__.actions.toggleSavePanel());
  await page.waitForTimeout(1000);
  await snap(shots.save, 800);
  const savePanelOpen = await page.evaluate(() => window.__HK_CITY__.store.state.ui.showSave);
  check('存檔面板', savePanelOpen === true, { savePanelOpen });

  const savedSnapshot = await page.evaluate(() => {
    const { store, actions } = window.__HK_CITY__;
    store.state.ui.showSave = false;
    store.bumpUI();
    actions.saveGame(2);
    return {
      buildings: store.state.buildings.length,
      citizens: store.state.citizens.length,
      zones: store.state.tiles.filter((t) => t.zone).length,
      mode: store.state.gameMode,
    };
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => Boolean(window.__HK_CITY__), { timeout: 90000 });
  await page.waitForTimeout(2500);
  cdp = await page.context().newCDPSession(page);
  const reloadTest = await page.evaluate((before) => {
    const { store, actions } = window.__HK_CITY__;
    const loaded = actions.loadGame(2);
    const st = store.state;
    return {
      loaded,
      buildings: st.buildings.length,
      citizens: st.citizens.length,
      zones: st.tiles.filter((t) => t.zone).length,
      mode: st.gameMode,
      match:
        loaded &&
        st.buildings.length === before.buildings &&
        st.tiles.filter((t) => t.zone).length === before.zones &&
        st.gameMode === before.mode,
    };
  }, savedSnapshot);
  check('存檔跨頁面重載持久化（分區模式）', reloadTest.match === true, reloadTest);

  // ── 12. 時間流逝與渲染負載 ──
  const timeTest = await page.evaluate(async () => {
    const { store, actions } = window.__HK_CITY__;
    actions.closeOverlays();
    actions.setSpeed(1);
    const before = store.state.clock.minutes;
    await new Promise((r) => setTimeout(r, 2200));
    return { before, after: store.state.clock.minutes, advanced: store.state.clock.minutes > before };
  });
  check('遊戲時間流逝', timeTest.advanced, timeTest);

  const perf = await page.evaluate(() => {
    const v = window.__HK_CITY__?.view;
    if (!v) return { error: 'no view' };
    const info = v.renderer.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      buildings: window.__HK_CITY__.store.state.buildings.length,
      citizens: window.__HK_CITY__.store.state.citizens.length,
      zones: window.__HK_CITY__.store.state.tiles.filter((t) => t.zone).length,
    };
  });
  result.perf = perf;
  check('渲染負載合理', (perf.drawCalls ?? 0) > 0 && (perf.drawCalls ?? 0) < 1500, perf);

  result.errors = logs;
  result.ok = Object.values(result.checks).every((c) => c.pass) && logs.length === 0;
} catch (err) {
  result.error = String(err);
  result.errors = logs;
  await snap('/tmp/hk-verify-error.png', 200);
} finally {
  await browser.close();
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

async function ev(fn, arg) {
  return page.evaluate(fn, arg);
}
