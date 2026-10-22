/**
 * 無頭瀏覽器截圖工具（Lead／QA 用）— 使用 CDP captureScreenshot 避免
 * 軟體 WebGL 低幀率時 Playwright 等待穩定畫面而 timeout。
 *
 * 用法：
 *   node scripts/shot.mjs [url] [輸出檔] [寬] [高] [等待毫秒]
 */

import { chromium } from 'playwright';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5273/';
const out = process.argv[3] ?? '/tmp/hk-city.png';
const width = Number(process.argv[4] ?? 1600);
const height = Number(process.argv[5] ?? 900);
const settle = Number(process.argv[6] ?? 3500);

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

const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const messages = [];
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') messages.push(`[${msg.type()}] ${msg.text()}`);
});
page.on('pageerror', (err) => messages.push(`[pageerror] ${err.message}`));

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => Boolean(window.__HK_CITY__), { timeout: 40000 });
  await page.waitForTimeout(settle);
  const info = await page.evaluate(() => {
    const st = window.__HK_CITY__?.store.state;
    return {
      cityName: st?.cityName,
      tiles: st?.tiles?.length,
      buildings: st?.buildings?.length,
      citizens: st?.citizens?.length,
      vehicles: st?.vehicles?.length,
      treasury: st?.finance?.treasury,
      clock: st ? `${st.clock.year}/${st.clock.month}/${st.clock.day} ${st.clock.hour}:${st.clock.minute}` : null,
      weather: st?.clock?.weather,
      season: st?.clock?.season,
      seed: st?.seed,
    };
  });
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(data, 'base64'));
  console.log(JSON.stringify({ ok: true, out, info, messages: messages.slice(0, 10) }, null, 2));
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: String(err), out, messages: messages.slice(0, 10) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
