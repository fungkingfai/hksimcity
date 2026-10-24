import { chromium } from 'playwright';
import fs from 'node:fs';
const browser = await chromium.launch({ args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport:{width:1400,height:860}, locale:'zh-TW' });
const errors=[]; page.on('pageerror',e=>errors.push(String(e).slice(0,200))); page.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,200));});
const t0=Date.now();
await page.goto('http://127.0.0.1:5273/?lite=1',{waitUntil:'domcontentloaded',timeout:120000});
await page.waitForFunction(()=>Boolean(window.__HK_CITY__),null,{timeout:180000});
const loadMs=Date.now()-t0;
await page.waitForTimeout(2500);
const st=await page.evaluate(()=>{
  const {store,actions}=window.__HK_CITY__;
  actions.startGame('starter',20261021);
  const s=store.state; s.ui.showTutorial=false; s.ui.showStats=false;
  const eastNames=['杏花邨','柴灣','小西灣'];
  const places=window.__HK_CITY__.BUILDINGS? null:null;
  return {mode:s.gameMode,w:s.width,h:s.height,spawn:s.spawn,buildings:s.buildings.length,pop:s.stats.population,zones:s.tiles.filter(t=>t.zone).length,roads:s.tiles.filter(t=>t.road).length,demand:s.stats.zoneDemand};
});
await page.waitForTimeout(3000);
const info=await page.evaluate(()=>{const r=window.__HK_CITY__.view.renderer.info; return {draw:r.render.calls,tris:r.render.triangles};});
// overview
await page.evaluate(()=>{const {actions,store}=window.__HK_CITY__; actions.fitMap(); document.querySelectorAll('.toast').forEach(n=>n.remove());});
await page.waitForTimeout(3500);
let cdp=await page.context().newCDPSession(page);
let {data}=await cdp.send('Page.captureScreenshot',{format:'png'});
fs.writeFileSync('/tmp/realmap-overview.png',Buffer.from(data,'base64'));
// east HK close-up (Heng Fa Chuen / Chai Wan): design (63,60) -> tile ~(316,300)
await page.evaluate(()=>{
  const {view,store}=window.__HK_CITY__;
  const st=store.state;
  const T=2;
  view.target.set((316+0.5)*T-(st.width*T)/2,0,(303+0.5)*T-(st.height*T)/2);
  view.distance=110; view.pitch=0.9; view.yaw=-0.72;
});
await page.waitForTimeout(3000);
({data}=await cdp.send('Page.captureScreenshot',{format:'png'}));
fs.writeFileSync('/tmp/realmap-east.png',Buffer.from(data,'base64'));
// empty mode overview
await page.evaluate(()=>{const {actions,store}=window.__HK_CITY__; actions.startGame('empty',20261021); const s=store.state;s.ui.showTutorial=false;s.ui.showStats=false;window.__HK_CITY__.store.bumpUI(); actions.fitMap();});
await page.waitForTimeout(3000);
const empty=await page.evaluate(()=>{const s=window.__HK_CITY__.store.state;return {buildings:s.buildings.length,roads:s.tiles.filter(t=>t.road).length,zones:s.tiles.filter(t=>t.zone).length};});
({data}=await cdp.send('Page.captureScreenshot',{format:'png'}));
fs.writeFileSync('/tmp/realmap-empty.png',Buffer.from(data,'base64'));
console.log(JSON.stringify({loadMs,st,info,empty,errors:errors.slice(0,8)}));
await browser.close(); process.exit(0);
