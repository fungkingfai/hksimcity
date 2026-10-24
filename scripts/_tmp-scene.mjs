import { chromium } from 'playwright';
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:900,height:600},locale:'zh-TW'});
await page.goto('http://127.0.0.1:5273/?lite=1',{waitUntil:'domcontentloaded',timeout:120000});
await page.waitForFunction(()=>Boolean(window.__HK_CITY__),null,{timeout:180000});
await page.evaluate(()=>{const {actions,store}=window.__HK_CITY__;actions.startGame('empty',20261021);const s=store.state;s.ui.showTutorial=false;s.ui.showStats=false;store.bumpUI();});
await page.waitForTimeout(2000);
const out=await page.evaluate(()=>{
 const {store,view}=window.__HK_CITY__;
 const s=store.state;
 // cluster approx tile around (330,330); world coords:
 const T=2; const wx=330.5*T-(s.width*T)/2; const wz=335*T-(s.height*T)/2;
 const objs=[];
 view.cityScene.traverse(o=>{
   if(o.isInstancedMesh){
     const m=o.instanceMatrix; o.geometry.computeBoundingSphere?.();
     // sample first instance pos
     let near=0, sampleY=0;
     for(let i=0;i<Math.min(o.count,200);i++){
       const arr=m.array; const x=arr[i*16+12], y=arr[i*16+13], z=arr[i*16+14];
       if(Math.hypot(x-wx,z-wz)<120){near++; sampleY=y;}
     }
     const col=o.material?.color?.getHexString?.()??'';
     if(near>0) objs.push({name:o.name||'(unnamed)',count:o.count,near,color:col,type:o.material?.type});
   }
 });
 return {wx,wz,objs:objs.slice(0,30)};
});
console.log(JSON.stringify(out,null,1));
await browser.close();process.exit(0);
