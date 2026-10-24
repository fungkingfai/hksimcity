import { chromium } from 'playwright';
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:800,height:550},locale:'zh-TW'});
await page.goto('http://127.0.0.1:5273/?lite=1',{waitUntil:'domcontentloaded',timeout:120000});
await page.waitForFunction(()=>Boolean(window.__HK_CITY__),null,{timeout:180000});
await page.evaluate(()=>{const {actions,store}=window.__HK_CITY__;actions.startGame('empty',20261021);const s=store.state;s.ui.showTutorial=false;s.ui.showStats=false;store.bumpUI();});
await page.waitForTimeout(1500);
const out=await page.evaluate(()=>{
 const view=window.__HK_CITY__.view;
 const rows=[];
 view.cityScene.traverse(o=>{
   if(!o.isInstancedMesh) return;
   const col=o.material?.color?.getHexString?.()??'';
   const count=o.count;
   if(!count) return;
   rows.push({name:o.name||'(unnamed)',count,color:col,instColor:!!o.instanceColor,mat:o.material?.type,renderOrder:o.renderOrder,visible:o.visible});
 });
 return rows.sort((a,b)=>b.count-a.count).slice(0,35);
});
console.log(JSON.stringify(out,null,0).slice(0,4000));
await browser.close();process.exit(0);
