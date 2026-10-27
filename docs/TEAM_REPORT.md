# 維港之城 — 多 Agent 開發報告

本專案由 **Team Lead + 8 名 Agent** 協作完成，全程使用共享檔案系統、任務看板
（`team_task_*`）與 Agent 間即時訊息溝通，把中國古城版引擎分支成**香港版**城市建造遊戲。

> 專案：`hk-city/`（《維港之城》Victoria Harbour City）
> 日期：2026-10-21 ~ 10-22
> 線上遊玩：<https://victoria-harbour-city.changeable-citron.workers.dev/>（Cloudflare Workers 靜態資產；`wrangler deploy --temporary` 臨時預覽帳戶）
> 技術：three.js + TypeScript + Vite，瀏覽器單機遊戲（桌面＋手機）

## 1. 團隊組成與任務

| Agent | 角色 | 任務（任務板 id） | 主要交付檔案 |
|---|---|---|---|
| **Lead** | 架構／整合／驗收 | 專案分支、香港版核心型別與資料表（96×96 地圖、資源、32 種建築、稅制、交通、天氣）、時間與模擬主迴圈、main／city-view 整合、存檔、測試、Playwright 驗收、文件與部署 | `src/core/**`、`src/main.ts`、`src/sim/time.ts`、`src/sim/simulation.ts`、`src/render/city-view.ts`、`tests/**`、`scripts/**` |
| **game-designer** | 遊戲設計 | 上網研究同類遊戲＋香港參考資料、撰寫香港版 GDD 與 UI 規格（task-1） | `docs/RESEARCH_HK.md`、`docs/GAME_DESIGN_HK.md`、`docs/UI_SPEC_HK.md` |
| **world-dev** | 世界／環境 | 香港地圖世界生成（維港／港島／九龍／新界／大嶼山／離島／填海／過海隧道）、地形視覺、道路＋行人路、日夜四季六種天氣（task-2） | `src/world/worldgen.ts`、`src/render/{terrain,roads,environment,world-utils,world-geometry}.ts` |
| **buildings-dev** | 建築外觀 | 32 種香港建築程序化模型（唐樓／公屋／商廈／茶餐廳／霓虹招牌／港鐵站出入口…）、霓虹材質、夜間燈火、建造預覽（task-3） | `src/render/buildings.ts`、`src/render/models/{building-prototypes,materials,hk-parts}.ts` |
| **interiors-dev** | 室內場景 | 32 種可進入的香港室內（唐樓鐵閘碌架床、劏房、茶餐廳卡位、港鐵月台、貨櫃碼頭…）＋室內資訊面板（task-4） | `src/render/interior.ts`、`src/render/models/interior-parts.ts`、`src/ui/interior-panel.ts` |
| **citizens-dev** | 市民系統 | 香港市民姓名／住戶／就業／通勤／購物／消閒／幸福度、人口遷入遷出、行人視覺與物流貨車渲染（task-5） | `src/sim/{citizen-common,citizens,population}.ts`、`src/render/citizens.ts` |
| **transport-dev** | 交通系統 | 港鐵／巴士／電車／渡輪站點覆蓋、通勤選擇、載客與車費收入、9 種交通工具（雙層巴士／小巴／的士／叮叮／天星小輪／私家車／電單車…）模擬與渲染（task-6） | `src/sim/{transit,vehicles}.ts`、`src/render/vehicles.ts` |
| **systems-dev** | 物流／財政 | 物流（進口商行／貨櫃碼頭→貨倉→零售→市民）、生產鏈、道路／行人路擺放規則、尋路、香港稅制（薪俸稅／利得稅／差餉）、賣地、月報表、公用設施與交通覆蓋統計（task-7） | `src/sim/{logistics,logistics-inventory,pathfinding,placement,production,finance,stats}.ts` |
| **ui-dev** | 使用者介面 | 霓虹港風桌面＋手機介面：頂欄、建造面板、城事、財政（三稅率滑桿／賣地／煙花）、交通面板、存檔／教學、手機底部導覽與觸控手勢（task-8） | `src/ui/**`、`src/styles.css` |

寫入範圍以任務板 `write_scopes` 協調；Agent 之間以 `send_message` 對齊跨系統介面
（例如 citizens-dev ↔ transport-dev 對齊 `pickCommuteMode`／通勤統計；systems-dev ↔
transport-dev 對齊車費入帳；interiors-dev ↔ ui-dev 對齊室內面板介面；buildings-dev ↔
interiors-dev 共用材質庫而不互相覆寫）。Lead 在開發中途同步最終 config 數值與新增建築，
確保各 Agent 交付一致。

## 2. 協作流程

1. **Lead 先定契約**：把 `huaxia-city` 分支成 `hk-city` 後，先重寫 `src/core/types.ts`
   （香港資源、32 種建築分類、交通／車輛／公用設施、6 種天氣、香港稅制、新 UI 狀態）與
   `src/core/config.ts`（96×96 地圖、32 種建築數據、農田／進口商行、地形、天氣、香港姓名、
   地名、霓虹招牌、街道名），再寫 `docs/ARCHITECTURE.md` 作為全體協作契約，並建立
   `docs/ARCHITECTURE.md` 的模組介面與驗收標準。
2. **任務板分工**：把工作拆成 8 個 disjoint 任務（game-designer + 7 開發），在
   `team_task_create` 寫明交付、write scopes 與驗收；Agent 以 `team_task_update` claim，
   完成後標記 complete 並向 Lead 回報。
3. **平行開發**：8 名 Agent 同時開工。Lead 同時完成 core／main／city-view／時間／模擬主迴圈，
   並在整合期持續跑 `npx tsc --noEmit` 追蹤錯誤、按檔案歸類後通知對應 Agent。
4. **中途校準**：Lead 發現早期食物／日用品供應鏈缺口，追加 `farm`（農田）與 `importFirm`
   （進口商行）兩種建築並調整解鎖人口，即時通知 buildings-dev／interiors-dev／systems-dev／
   citizens-dev／ui-dev／game-designer 對齊（總數由 30 種增至 32 種）。
5. **整合與驗收**：全部 Agent 回報後，Lead 依序整合 world → roads → buildings → interiors →
   citizens → vehicles → systems → UI，修正型別與介面、跑 `tsc`／`vitest`／`vite build`、
   Playwright 全流程驗收、真實滑鼠 UI 測試、手機模擬、截圖與文件收尾。

## 3. 關鍵設計決策

- **香港地圖，不是換皮**：96×96 地圖按香港地理生成：新界（大帽山、沙田、西貢）→ 獅子山 →
  九龍半島（啟德）→ 維多利亞港 → 香港島（太平山）→ 南區及離島；西面大嶼山／赤鱲角／東涌；
  預設中環起步點、三條過海隧道、填海地（西九／啟德／東涌／將軍澳）。
- **公屋／居屋／私人屋苑／唐樓／劏房／豪宅**六級住宅，對應香港房屋階梯；住房吸引力、
  人口遷入與幸福度都按樓型分級。
- **交通＝經濟系統**：站點（港鐵／巴士／電車／渡輪）提供通勤覆蓋、縮短通勤時間、
  帶來車費收入；通勤方式影響市民就業與幸福；颱風令渡輪停航、車速下降。
- **物流真實庫存**：貨物只會移轉不會憑空產生；生產者→貨倉→零售→市民，貨車沿道路行駛、
  抵達才入庫、在途預留；早期（未有貨倉）支援生產者直送零售，避免卡關。
- **財政有香港味道**：薪俸稅／利得稅／差餉三條稅率、賣地收入、車費、零售服務收入；
  分類月報表與歷史走勢，破產警告。
- **天氣有後果**：晴／陰／雨／颱風／霧／雪＋天文台警告；颱風停工停航、霧令交通變慢、
  寒潮令氣溫急降；數據驅動環境視覺。
- **可進入室內**：每棟建築以 `building.key`／`interior` 生成室內 three.js 場景，進出即建立／
  釋放；室內同步顯示住客／員工、庫存、服務與本月帳目。
- **存檔即 state**：JSON 完整序列化（version 2，含車輛／交通／新稅制）；自動存檔 + 3 手動格 +
  JSON 匯出／匯入。

## 4. 驗收結果

> 由 Lead 於整合後執行 `npm run build`、`npm test`、Playwright 全流程驗收（`scripts/verify-hk.mjs`）、
> 真實滑鼠／鍵盤 UI 驗收（`scripts/ui-click-test.mjs`）、iPhone 模擬手機驗收（`scripts/mobile-test.mjs`）、
> 生產建置 preview 冒煙測試（`npx vite preview` + `scripts/shot.mjs`）與截圖（`scripts/capture-showcase.mjs`）。

| 驗收項目 | 結果 |
|---|---|
| `npx tsc --noEmit` | ✅ **0 錯誤**（全專案，32 個模組） |
| `npm test`（vitest） | ✅ **26 / 26 通過**（2 個測試檔：core、simulation 整合） |
| `npm run build` | ✅ 通過（JS 1.15 MB／gzip 338 KB、CSS 96.6 KB；three.js chunk 大小警告不影響功能） |
| Playwright 全流程 `npm run verify` | ✅ **34 / 34 checks**：香港地圖（96×96、維港、山地、填海、可建 53%）、預設道路、真實建村（道路＋行人路＋唐樓＋劏房＋農田＋進口商行）、市民遷入（59 人）、就業、農田食品、進口商行日用品、物流補貨、月結算財政、市民走動、商業／交通設施解鎖、零售有貨、物流鏈、交通工具（7–10 架）、公共交通站點與載客（覆蓋 0.42、載客 76、車費 $1,872）、颱風警告停航、冬季寒潮雪景、進入室內、**32 種建築全部可進入室內**、財政面板、交通面板、存檔／讀檔、跨頁面重載持久化、時間流逝、渲染負載 |
| 真實 UI 互動 `npm run verify:ui` | ✅ **17 / 17 checks**：頂欄、財政面板、三稅率滑桿（薪俸 18%）、賣地入帳、建造面板 7 分類／建築卡、真實滑鼠鋪路＋在 3D 地圖建屋、雙擊進入室內／返回、交通面板、存檔面板＋手動存檔、說明面板、倍速／暫停快捷鍵、無 console error |
| 手機版 `npm run verify:mobile` | ✅ **14 / 14 checks**：iPhone 13 自動切換手機 UI、底部 6 導覽、建造 sheet 開關與自動收起、觸控點擊建屋、城事面板、進入室內／返回、單指平移、雙指縮放、財政／交通／存檔／說明、桌面版回歸、安全區 |
| 生產建置進入遊戲 | ✅ `npm run build` → `npm run preview`（4273）：載入 96×96 地圖、無 console error、教學／頂欄／建造面板正常 |
| 線上部署 | ✅ Cloudflare Workers（`wrangler deploy --temporary`）：<https://victoria-harbour-city.changeable-citron.workers.dev/> 回傳 200，靜態資產 3 個檔案上傳成功 |
| 渲染負載 | ✅ 輕量模式（SwiftShader）下 213 draw calls / 343k triangles（17 棟建築、84 市民）；硬件 GL 實測約 **54fps @1280×800**（100–139 draw calls、588–766k triangles）；`Simulation.update` ~1.5ms/幀（400 市民）、`tickVehicles` 0.14ms、`tickLogistics` 0.15ms |
| 存檔持久化 | ✅ 手動存檔於頁面重載後可讀取並還原（建築 16 棟、市民 83 人、道路 143 格完全一致） |
| 展示截圖 | ✅ `docs/screenshots/`：hero（維港全景）、city、night（霓虹夜景）、typhoon（八號風球）、rain、snow（寒潮）、interior（可進入室內）、finance、transit、save、map（全港地圖）、mobile-city／build／info／landscape／interior |

## 5. 已知限制與後續

- **無 GPU／軟件 WebGL 環境**會自動啟用「輕量模式」（`?lite=1`：關陰影、降解析度）；正常桌面 GPU 為全效果。
- 港鐵為地下化服務，戶外只渲染車站出入口與室內月台列車，不渲染地面列車（統計與車費照常結算）。
- 市區有程序化「現有樓群」天際線裝飾（spawn 周邊已淨空、建造時按格隱藏），未做 LOD；上千棟建築時可再優化 draw call。
- 建築外觀固定朝向：一般面向最近道路／行人路，渡輪碼頭／貨櫃碼頭／海濱長廊自動向水。
- 地區規劃限制：電車站只限香港島、貨櫃碼頭只限西岸港口、豪宅需海景／山景、學校／醫院不可貼近發電廠（GDD §2.6）。
- 市民路徑行走於道路／行人路，未模擬行人穿越建築的捷徑；人口上限 1600（效能考量）。
- 中期失業率可能偏高（職位需玩家主動建商廈／工廈／商場），已透過日誌提示。
- 存檔使用 localStorage，瀏覽器清除網站資料會遺失存檔；建議定期匯出 JSON。
- 可於日後加入：山頂纜車、機場航班、颱風災後維修費、貸款、成就系統、雲端存檔。

---

# 第二輪改版：分區式玩法（Round 2）

> 玩家試玩後提出 4 點回饋；Lead 重開任務板，把「逐棟建屋」改為 **SimCity / Cities: Skylines 2 式分區玩法**。
> 日期：2026-10-22 晚上（約 1.5 小時完成＋驗收）。

## R2.1 玩家回饋與對應

| # | 玩家回饋 | 對應改動 | 負責 |
|---|---|---|---|
| 1 | 道路應整合行人及行車路；玩法要似 Cities: Skylines 2／SimCity，以平衡居住、商業、工業、農田、交通、警力、消防、教育為主 | 道路工具自動包含行人路，移除獨立行人路工具；新增 **RCI+F 需求系統＋分區規劃**，公共服務（警／消／校／醫／交通）影響發展分數與幸福度 | Lead、systems-dev、world-dev、ui-dev、citizens-dev |
| 2 | 建築應分成居住／商業／工業／農田區，因應環境自動產出，玩家只需分配區域 | `Tile.zone`＋19 種自動開發建築池（按需求、發展分數、地塊大小加權）；玩家只保留 13 種公共設施／交通／地標手動放置 | Lead、systems-dev、buildings/世界層不變 |
| 3 | 地區的中文字倒轉了 | 修正 `createLabelAtlas` CanvasTexture 的 UV 對應（billboard 底部頂點錯用 v1）；任何鏡頭角度皆正向 | world-dev |
| 4 | 一開始建築物太多，玩家難起步；可分「已有建築運作」或「由頭開始」版本 | 新增開局模式選擇畫面：**已有城鎮**（中環預建道路／分區／約 120–150 居民＋基本公共設施）／**由零開始**（空地圖＋5 市民＋$800 萬） | Lead（starter-town）、ui-dev（start screen） |

## R2.2 團隊分工（任務板 task-10 ~ task-14）

| Agent | 任務 | 交付檔案 |
|---|---|---|
| **Lead** | task-10~14 整合：核心契約（ZoneType／Tile.zone／GameState.zoneDemand／gameMode／GameStats 新欄位／GameActions startGame）、config 分區資料＋19 auto／13 ploppable 標記、`new-game` 兩模式、`starter-town` 預建城鎮、`save` v3、`main` actions（分區／開局／warm-up）、`city-view`（拖曳劃區／hover／zones overlay）、`simulation` 接線、測試／驗收腳本、文件與部署 | `src/core/**`、`src/main.ts`、`src/render/city-view.ts`、`src/sim/{simulation,time}.ts`、`tests/**`、`scripts/**` |
| **systems-dev** | task-10 分區自動開發系統：`computeZoneDemand`、`tickZoning`（每日開發／荒廢／上限 420／bootstrap）、`zoneStats`、`developmentScore`；`placement` 的 `paintZone/eraseZone/placeAutoBuilding` 與手動放置限制；`stats` 需求／服務覆蓋／地價；另優化 `logistics`／`pathfinding` 效能（22.25ms→0.02ms/幀 @1600 人） | `src/sim/{zoning,placement,stats,logistics,pathfinding}.ts` |
| **ui-dev** | task-11 分區 UI：開局模式畫面、4 色分區刷子（Z/C/V/N）＋取消分區、建造面板只列 13 種公共建築、RCI+F 需求條、分區統計、服務覆蓋、地價、分區 overlay toggle、教學／幫助／存檔新局模式、手機版 | `src/ui/**`、`src/styles.css` |
| **world-dev** | task-12 修正中文地名倒轉；新增分區色塊 overlay（4 InstancedMesh，≤4 draw calls，日夜可讀） | `src/render/{environment,zones}.ts` |
| **citizens-dev** | task-14 移民速度與住宅需求掛鈎、幸福加入四項服務覆蓋、糧食優先就業、農田通勤放寬；兩種開局／60 日／1600 人平衡與效能驗證 | `src/sim/{population,citizens,citizen-common}.ts` |
| **game-designer** | task-13 文件改版：新增 `ZONING_GAMEPLAY.md`（494 行），更新 GDD／UI_SPEC 為分區玩法、兩種開局、建築 auto/ploppable 表、快捷鍵 | `docs/{ZONING_GAMEPLAY,GAME_DESIGN_HK,UI_SPEC_HK}.md` |

## R2.3 平衡與效能實測（真模組、seed 20261021）

| 情境 | 結果 |
|---|---|
| **starter warm-up**（10 個遊戲日） | 人口 **146–148**、幸福 70–72、失業 ~9–11%、糧食 1.4 日（之後農田自動補上） |
| **starter 60 日不操作** | 人口 468（住宅床位上限）、幸福 77–82、糧食 4.7→6.1 日、失業 0、警100／消97／校59／醫100／電100／水100／交99、庫房 $12.2M |
| **empty 30 日（均衡 R/C/I/F＋道路）** | 人口 ~208–234、自動建築 51–53、住宅/商業/工業 34/9-10/4、需求 -0.6..+0.9 |
| **empty 積極玩家 60 日** | d10 90 → d15 139 → d20 201 → d30 364（測試 AI 用盡住宅地塊停止，真玩家可續擴） |
| **過度劃區** | 額外 400 格住宅 → 住宅需求 -0.6、開發暫停（供需平衡生效） |
| **高密度 1600 人** | 優化前 `tickLogistics` **22.25ms/幀** → 優化後 ~0.02ms；sim 平均 0.36ms、p95 1ms（跨日結算尖峰 max ~32ms，每遊戲日一次） |
| **auto 建築上限** | 高密度城市 210–283 座，未觸及 420 上限 → 維持設定 |

## R2.4 第二輪驗收

> 最終數字見下方「第二輪驗收結果」；驗收腳本已改為分區玩法（`scripts/verify-hk.mjs` 28 checks、
> `scripts/ui-click-test.mjs`、`scripts/mobile-test.mjs`）。

- [x] `npx tsc --noEmit` 0 error
- [x] `npm test` 26/26（simulation 測試改為分區整合：道路整合行人路、劃區規則、自動開發、需求平衡、颱風、存檔 round-trip、建築 auto/ploppable 分類）
- [x] `npm run build` 成功
- [x] Playwright 全流程 `scripts/verify-hk.mjs`：**27 / 27 checks** 全綠（兩種開局、道路整合行人路、四區劃分、開發商自動建屋、需求平衡、公共設施與服務覆蓋、颱風停航、雪景、32 種室內、存檔跨頁面、分區 overlay）
- [x] 真實 UI 點擊 `scripts/ui-click-test.mjs`：**21 / 21 checks** 全綠（開局畫面、財政三稅率／賣地、分區刷子真實滑鼠劃區、拖曳鋪路、公共設施放置、雙擊進入自動建築室內、頂欄／交通／存檔／說明、倍速快捷鍵、無 console error）
- [x] 手機版 `scripts/mobile-test.mjs`：**17 / 17 checks** 全綠（iPhone 13 直向／橫向、手機開局畫面、分區刷子與底部 sheet、觸控劃區＋自動建屋、城事需求面板、進入室內／返回、單指平移、雙指縮放、桌面版回歸）
- [x] 線上部署冒煙測試：載入 starter 城鎮（146 人／50 棟／156 格分區）、empty 模式鋪路劃區 20 日（187 人／39 棟自動建築）、無 console error；已更新截圖 `start.png`、`zoning.png` 及手機截圖
- [x] 兩種開局模式可選；starter warm-up 後人口 ≥120、empty 由 5 市民開始
- [x] 自動開發四類分區建築、需求條與服務覆蓋上 UI、過量劃區需求回落
- [x] 32 種建築仍可進入室內；存檔跨頁面保留分區／自動建築
- [x] 地圖中文地名正向（world-dev 4 個 yaw 角度＋近景截圖驗證）
- [x] 分區色塊 overlay（白天＋夜晚截圖）與 start screen 截圖
- [x] 1600 人 simulation 平均 <1ms/幀（logistics 優化）
- [x] 重新部署 Cloudflare：<https://victoria-harbour-city.changeable-citron.workers.dev/>

---

# 第三輪改版：304×304 大地圖＋完全空地開局（Round 3）

> 玩家第三輪回饋：①「試試將地圖整大 10 倍，而家好細」；②「由零開始應該是一間屋都無，全部空地」；
> ③ 用 GitHub token push 到 <https://github.com/fungkingfai/hksimcity>，讓 Cloudflare `hksimcity.fungkingfai.workers.dev` 同步更新。
> 日期：2026-10-22 深夜 ~ 10-23 凌晨。

## R3.1 改動總覽

| 項目 | 改動 |
|---|---|
| **地圖 ×10 面積** | `GRID_WIDTH/GRID_HEIGHT: 96 → 304`（92,416 格，面積 ×10.03）；新增 `MAP_SCALE=304/96≈3.1667`、`WORLD_SPAN=608`；worldgen 沿用 96 設計座標、以 `sx/sy` 換算（地理特徵線性放大 ×3.17，維港／河流較寬） |
| **完全空地 empty 模式** | `generateWorld(...,{starterRoads: gameMode==='starter'})`：empty 模式**零道路、零隧道、零建築、零分區**；強制 render gate 關閉**所有靜態人造物**（fake 市區樓群、地標、機場跑道／客運大樓、貨櫃碼頭貨櫃、人造菜田、城市霓虹燈光），只保留自然地形／樹木／沙灘／濕地與海面動態船隻；玩家起第一棟樓後城市燈光自動亮返；5 名市民＋$800 萬（首次 tick 進場） |
| **starter 城鎮 rebalance** | 更密集道路網＋更大 R/C/I 區（北住宅、中商業、南工業）；30 棟 auto 建築（含 7 農田、2 貨倉、寫字樓、工廈）；9 種公共設施（加醫院）；倉庫預放食品 520／日用品 180；starter 貨幣 $650 萬 |
| **大地圖相機／導航** | 相機 far 600 → 1,900、zoom out 上限 260 → 823、`fitMap()` 距離 ≈757；新增 `GameActions.focusTile/fitMap`＋`StoreEvent 'focus'`；`CityView.getCameraInfo()` 供 minimap 視野框 |
| **Minimap（新）** | 右下 304×304 Canvas：水陸地形 offscreen 快取、道路、四色分區、建築點、城市標記、鏡頭視野框；點擊／拖曳跳轉（80ms throttle）、全圖 / 市中心 / 分區 toggle、可摺疊；手機 46px 圓形收起／152px 展開；`O` 全圖、`P` 返回市中心 |
| **存檔 v4（compact）** | 存檔只記 `seed + gameMode + 稀疏 tileEdits(road/sidewalk/zone) + state(不含 tiles) + info 快照`；載入時以 seed 重新 generateWorld 再套 sparse edits＋重建 buildingId；約 **78–136KB**（完整 92k 格 JSON 會超過 localStorage 5MB 配額）；只接受 304×304，舊 96×96 存檔會被忽略；`GAME_VERSION=4` |
| **開發速率按地圖放大** | `AUTO_DEVELOP.maxBuildingsPerDay 5→15`、`maxBuildingsPerZonePerDay 2→6`、`maxAutoBuildings 420→1200` |
| **世界／渲染縮放（world-dev）** | terrain tris **3.43M → 588k（-83%）**；empty overview **495k tris / 37–47 calls**；starter ~**705k tris / 444–454 calls**；天空球 unit sphere 自適應 camera.far、雲／霧／雨雪／星星／鳥／燈光半徑 ×3.17；`fogRange` 近遠 ×3.17；地名 billboard 尺寸 ×4.9；樹木／假樓群密度按 `1/(kx*ky)` 歸一（榕樹 4181→495、假樓群回落至 ~96 地圖水平） |
| **sim 縮放（systems-dev）** | Weighted A*（長途 15.9→**1.79ms**）、cache 上限按面積 16k→52k＋增量 `notifyRoadAdded()`；zoning 每日 survey O(92k)（tickZoning 11.4→**2.4–3.1ms**）；stats 每幀 92k 掃描清零（**0.03–0.05ms**）；logistics 貨車速度 ×MAP_SCALE＋3.5ms 搜尋預算（**0.00–0.02ms/幀**） |
| **市民（citizens-dev）** | `walkNetworkSignature` 由每 5 分鐘全掃 92k tiles 改為 `worldRevisionOf()` O(1) 簽章（重算 54→3 次/600 幀）＋修正 stale walk-component cache（新路即日影響就業／通勤） |

## R3.2 效能與平衡實測（304 地圖）

| 情境 | 數據 |
|---|---|
| 首次生成 | worldgen 304 ≈ 1.3–2s（node bench 1.5s；瀏覽器 boot 有載入畫面） |
| starter warm-up（10 日） | pop **146–148**、建築 49–50（auto 41–44）、道路 424、幸福 70–73、倉庫食品充足 |
| starter 實時 +20 日 | pop **569–573**、建築 98–127（auto 89–118）、normal frame **avg 0.23ms / p95 0.34 / p99 3.62ms**；跨日結算 ~6.8ms |
| empty 60 日（自鋪路＋四區） | pop **368**、auto 116（R/C/I/F=68/16/20/11）、normal frame avg 0.21ms |
| 800 人受控 | normal frame ~0.1–0.3ms；tickZoning 每日 2.43ms；貨車長途 path 145 格正常 |
| empty 確認 | createGameState 後 **buildings=0 / roads=0 / zones=0**；spawn 附近 67% 可建，玩家可立即鋪路 |
| 邊界／離島 | 最北／最南／最東及 3 個離島皆可鋪路、長距離 path 優雅返回 null、無 crash |

## R3.3 第二輪遺留問題處理

- 地價、失業、糧食：starter 加大 C/I 區＋農田＋食品儲備後，warm-up 糧食 1.9 日→充足；中期失業由 ~28% 改善（更多商業／工業職位）。
- 高人口 p95：normal frame 全部 <3ms；跨日結算 6.8–9ms 屬每遊戲日一次尖峰（報告註明預期）。
- 舊存檔：v4 與 96×96 不相容，UI 會顯示空存檔格（不再讀取舊資料）。

## R3.4 驗收與部署

- [x] `npx tsc --noEmit` 0 error
- [x] `npm test` 26/26（304 地圖測試已更新，timeout 放寬至 30s）
- [x] `npm run build` 成功
- [x] Playwright 全流程 `scripts/verify-hk.mjs`：**28 / 28 checks** 全綠（304×304 地圖、starter/empty 兩種開局、empty 完全零道路／建築／分區、工業區自動建築 API、開發商住宅／商業／農田自動建屋、道路整合行人路、分區需求平衡、公共設施與服務覆蓋、颱風／雪、32 種室內、compact 存檔跨頁面、渲染負載 799 calls / 711k tris）
- [x] 真實 UI 點擊 `scripts/ui-click-test.mjs`：**21 / 21 checks** 全綠（empty 開局→真實滑鼠鋪路／劃區、開發商建屋、公共設施放置、雙擊入室內、財政／交通／存檔／說明、倍速快捷鍵）
- [x] 手機版 `scripts/mobile-test.mjs`：**17 / 17 checks** 全綠（iPhone 13、手機開局畫面、分區刷子 sheet、觸控劃區＋自動建屋、城事需求面板、入室內／返回、單指平移、雙指縮放、桌面回歸）
- [x] 截圖：start（304 開局畫面）、empty（完全空地圖）、zoning（starter 分區城市）、map（304 全圖 overview）、hero/city/night/weather/interior/finance/transit/save、mobile-*
- [x] GitHub push：<https://github.com/fungkingfai/hksimcity>（main；token 只經 `~/.config/huaxia/github-pat` 讀取，未寫入會話／repo）
- [x] GitHub push：<https://github.com/fungkingfai/hksimcity>（main；token 由 `~/.config/huaxia/github-pat` 讀取，未寫入會話／repo）
- [x] **Cloudflare `hksimcity.fungkingfai.workers.dev` 已上線**：<https://hksimcity.fungkingfai.workers.dev/>（HTTP 200；304×304、starter 52 棟／146 人、minimap 正常、empty 模式 0 道路／0 建築／0 分區、無 console error）。部署除錯：Cloudflare Workers Builds 只執行 `npx wrangler deploy` 而無 build step，首次 build 因 `dist` 不存在失敗（`assets.directory ... /opt/buildhome/repo/dist`）；修正為 commit `scripts/ci-build.mjs`＋`postinstall` 自動 `npm run build`，並把建置好的 `dist/` 一併 commit 作 fallback，push 後自動部署成功。

---

# 第四輪改版：真實香港地理數據 480×480 大地圖（Round 4）

> 玩家第五輪要求：參考 CSDI／香港地理空間數據「盡可能修正地形、建築物等設計，特別是杏花邨、柴灣等地方；可以再加大地圖大小」。
> 日期：2026-10-24。

## R4.1 資料來源與生成

| 資料 | 用途 | 來源 |
|---|---|---|
| **DTM 5m**（LandsD 數碼地形模型） | 真實海岸線、山脈高程、平地／山地分佈 | `https://www.landsd.gov.hk/landsd_psi_data/SMO/data/Whole_HK_DTM_5m.zip`（data.gov.hk `hk-landsd-openmap-5m-grid-dtm`） |
| **Building Outlines（公共）** | 342,233 個真實建築輪廓 → 每格 building density／平均高度 | CSDI Portal（metadataInfoPanel）／`https://static.csdi.gov.hk/csdi-webpage/download/51d63757e2675874af80eef94afb6a35/geojson` |

- `tools/build-hk-data.py`（離線，約 40–65 秒）讀取上述數據，用 HK1980 Grid（EPSG:2326 TM 公式）換算，輸出 `src/world/hk-map-data.generated.ts`（約 0.97MB：terrain RLE、elevation/density/buildingHeight base64、69 個真實地名、6 個地標、15 個市區／機場／貨櫃區塊、3 條隧道、spawn）。
- 地圖：**480×480 格、每格 140m**（67.2km 見方，範圍 HK1980 E 798,275–865,475、N 790,400–857,600），`MAP_SCALE=5`、`WORLD_SPAN=960`、`GAME_VERSION=5`。
- 真實地形統計：水域 75.6%、可建 22.4%（urban 5.2%、hill 7.5%、grass 4.5%、forest 3.8%、fertile 0.7%、reclaimed 0.7%）；符合香港「山多平地少」。
- Empty 模式：`starterRoads:false` → **0 道路／0 建築／0 分區／0 隧道**，render 亦隱藏所有假樓群、地標、機場、貨櫃碼頭、霓虹；只保留真實自然地形、樹木、海面船隻與地名。
- Starter：spawn 中環 (259,299)，**連通優先道路網**（BFS 分量＋格網生長，修復 Round 3 真實地形下 9 個斷開路網造成失業 35%／農田缺工／服務覆蓋 0% 的 P0），均衡四區＋34 棟 auto＋10 公共設施（含 2 學校、醫院）＋7 農田＋倉庫食品 520；QA warm-up 約 146 人、幸福 70、失業 <10%、糧食充足、警/消/校/醫覆蓋 79–100%。

## R4.2 渲染（world-dev）

- **以真實 density／buildingHeight 驅動現有樓群**：starter 模式按每格密度與高度生成約 **4,089 座**樓（3 個 InstancedMesh：tower/block/office），**杏花邨／柴灣／小西灣高層住宅群**、中環 CBD 商廈、尖沙咀／觀塘／荃灣／沙田／將軍澳／東涌新市鎮樓群真實分佈；empty 完全不生成。
- **白色階梯 bug 修正**：根因真實 DTM 高程（0.3–0.92）撞舊雪線 0.55，冬季把山腰染白；新雪線 elevation ≥0.8（≈550m）且只在 `weather==='snow'` 或冬季 ≤6°C 生效。
- **無邊海面**：4 塊巨型外框 quads 共用原水 shader，消除 overview 方形／菱形硬邊與 z-fighting；水面 detail scale 按 MAP_SCALE 修正摩爾紋。
- **69 個真實地名 LOD**：螢幕空間固定大小、TOP 16（中環／尖沙咀／維港／大帽山等）overview 顯示，major/minor 中近景才顯示；杏花邨／柴灣／小西灣／太古／筲箕灣清晰正向。
- **地標／機場／碼頭**：凌霄閣、天壇大佛、青馬大橋、摩天輪、鐘樓、會展按真實位置，scale ×1.7；赤鱲角兩條東西向跑道＋客運大樓／飛機；葵涌貨櫃碼頭按真實 region。
- **道路視覺**：電車走廊／紅白磚人行道改用真實的港島北岸／九龍舊區設計座標；3 條隧道入口牌對應新位置。
- 效能：starter overview **1.327M tris / 402 calls**；empty overview **1.032M tris / 37 calls**；render raw terrain 1.164M tris（water 348k、trees ~450k、buildings density 3 InstancedMesh）。

## R4.3 Sim／UI／QA 適配

- systems-dev：`placement.ts` 新增 230,400 格 typed TileIndex（zone/road/building Uint8Array 增量維護）；pathfinding 快取按面積升至 82k 條／1.0M 點；zoning survey 改用 typed index（每日 13.8→0.19–1.05ms）；logistics 街口送貨 cache；stats zoneTiles typed index＋景觀 cache。480 starter normal frame avg 0.20ms/p99 2.99ms；1000 人 avg 0.44/p95 1.41/p99 5.79ms。
- ui-dev：全 UI 304→480、CSDI 數據來源 badge／說明書；minimap 重構為 480 canvas＋真實 density 紋理＋500ms throttle（overlay 2.8ms、每 250ms draw <1ms）；手機 minimap 照舊可摺疊。
- citizens-dev QA：starter 146 人／empty 60 日 398 人；東區（杏花邨／柴灣／小西灣）真實地形可劃區、自動建屋、市民入住 ✓；效能 800–1000 人達標；世界生成 0.2–1.0s；save/load 正常。

## R4.4 驗收（Round 4）

- [x] `npx tsc --noEmit` 0 error
- [x] `npm test` 26/26（測試更新為 480 真實地圖；精簡存檔體積 <2MB）
- [x] `npm run build` 成功
- [x] Playwright 全流程 `scripts/verify-hk.mjs`：**28 / 28 checks**（480 真實地圖、兩種開局、empty 0 路 0 樓、四區自動建屋、道路整合行人路、需求平衡、公共設施、颱風／雪、32 種室內、compact 存檔跨頁面、渲染負載 ~1.19M tris / 568 calls）
- [x] 真實 UI 點擊 `scripts/ui-click-test.mjs`：**21 / 21 checks**（empty 開局真實地形鋪路／劃區、開發商建屋、公共設施、室內、面板、存檔）
- [x] 手機版 `scripts/mobile-test.mjs`：**17 / 17 checks**（iPhone 13、真實地圖、minimap、觸控劃區＋自動建屋、室內、手勢）
- [x] 線上部署（GitHub push 後 Cloudflare Workers Builds 自動部署）：<https://hksimcity.fungkingfai.workers.dev/> HTTP 200；線上實測 starter **480×480、45 棟、145 人、minimap、CSDI badge**；empty **0 路／0 樓／0 分區**；無 console error
- [x] 截圖：`docs/screenshots/` 已更新 21 張（start／empty／zoning／map／east 杏花邨柴灣／hero／city／night／rain／snow／typhoon／interior／finance／transit／save／mobile-*）
- [x] 截圖：real480 系列（overview／central／east 杏花邨柴灣／airport／container／night／empty）＋遊戲內 showcase 更新

---

# 第五輪改版：600×600 真實地圖、水塘／土地利用、地下管網、巴士路線、機場碼頭（Round 5）

> 玩家第六輪要求：1) 加大至 600×600（更精細海岸線）2) 用水塘／土地利用數據補水面 3) 加入機場／貨櫃碼頭玩法 4) 加入電線及水管／水及污水系統建設（SimCity 式地下層管理）5) 加入巴士小巴路線管理。日期：2026-10-24。

## R5.1 600×600 真實地圖＋水塘／土地利用

- `tools/build-hk-data.py` 由 480×480／140m 升級 **600×600／112m**（範圍不變，HK1980 E 798,275–865,475、N 790,400–857,600）；DTM 5m 以 stride=5（≈4–5×4–5 子取樣）算 mean/min/max/land fraction，海岸線以 land fraction 細化。
- **規劃署 2020 LUHK 10m raster**（data.gov.hk／CSDI）4×4 samples/tile refine 林地、農地、濕地、市區、機場、碼頭；**DTM 山勢優先**（hmax≥400m／mean≥380m→mountain；mean≥120m／hmax≥180m→hill），避免 landuse 蓋過山勢（修正過一次 hill 28,442／mountain 5,866）。
- **水務署 17 個官方水塘 GeoJSON polygon**（CSDI file-api）rasterize：2,386 water tiles（765 由陸轉水），包括船灣淡水湖 1,061、萬宜 655、大欖涌 221、石壁 102、城門 83、大潭、香港仔、薄扶林、九龍水塘群等；黃泥涌／流水響／鶴藪以近似橢圓補底。
- 最終 terrain（360,000 格）：water 75.3%、hill 7.9%、mountain 1.6%、urban 4.6%、forest 3.3%、grass 4.4%、fertile 1.0%、wetland 0.6%、reclaimed 0.5%、sand 0.7%；**可建 21.7%**；density>0 30,447 格；labels 69、landmarks 6、regions 15、tunnels 3、spawn (324,373) 中環；generated data 1.45MB。
- Render 600：修正 waterDepth BFS bug、深海改單一大平面＋近岸 per-tile 水 shader（水 tris 542k→~90k）；starter overview **1.22M tris／438 calls**、empty **839k／37**；水塘、海岸線、赤鱲角、葵涌視覺正常；Playwright SwiftShader 1400×860 穩定無 crash。

## R5.2 地下公用設施管網（SimCity 式）

- `Tile.waterPipe/sewerPipe/powerCable`；玩家用地下層工具（`U`）逐格鋪設食水管 $900／污水管 $1,200／電力電纜 $800，月維護 $1.4／$1.8／$1.1／格，拆退 25%；不可鋪水域／山／沙／濕地，可鋪道路及建築腳下。
- 新設施：水塔（$420k／800 PE）、海水化淡廠（$9.5M／5,000 PE）、污水處理廠（$3.4M／2,200 PE）、排污口（$520k／1,400 PE）；原有發電廠（1,600）、水務設施（2,000）改為管網供應源，`utility.source=true`。
- `sim/utilities.ts`：BFS 由 active＋相鄰管道 source 出發；建築 footprint／四鄰接駁；容量池＋缺口比例；服務係數：冇 source 0.55 / 未接駁 0.25 / 容量不足 0.5+0.5×ratio；污水溢出、水質（排污口 -0.15／個）；`state.utilities` snapshot 每日 force 重算（BFS ~0.6ms、cached 0.001ms）。
- `stats` 水／電 coverage 改讀管網、新增 sewageCoverage／waterQuality；production 生產效率用 utilityFactor；finance 月結加管線維護（人口<300 新系統維護 50% 折）；simulation 每日計算＋警告；placement 加機場／碼頭 region 限制。
- Starter 預建道路三管＋公用設施接駁（實測 water/sewage/power coverage 1.0）；empty 由零開始。UI：U 地下工具列＋公用設施面板（容量／需求／覆蓋／短缺／水質／管道長度／維護）、建造「公用」6 卡、手機導覽。
- 存檔 v6：tileEdits pipe bits（bit5–7）＋新 state 欄位；hydrate 重算 utilities。舊 96／304／480 存檔拒絕。

## R5.3 巴士／小巴路線管理

- 新建築：`busStop` 1×1 $60k、`minibusStop` 1×1 $40k、`minibusDepot` 2×2 $800k；`busTerminus` 可作巴士站；小巴線需車廠。
- `TransitLine`：mode bus/minibus、stopIds（站點建築 id）、loop、vehicleCount 1–12、fare $3–20、顏色／名稱、每日 ridership／faresThisMonth。
- 開線流程：交通面板「路線管理」→ 新增巴士／小巴線 → 地圖／站點清單點站 → 完成（`createTransitLine`；主線成本＝車數×車價＋$50k，巴士 $1.2M/車、小巴 $350k/車）；改車數／票價／暫停／刪線（退 50% 車輛）。
- 每日結算 `tickTransitLines`（tickTransit 內 idempotent）：站 3 格住宅×0.55＋就業×0.75、票價／班距／天氣／假日吸引力、容量、收入/成本入帳（70/30 split 與舊巴士半徑避免 double count）；路線 overlay 沿道路彩色 ribbon＋站點環，只在交通面板／建線模式顯示；每線按車數 spawn 巴士／小巴（lineId、颱風停駛）。
- UI：路線列表（載客／淨收入紅綠）、建線編輯器（草稿 chips／Undo／車數／票價／循環）、線詳情；測試 24 個。

## R5.4 機場／貨櫃碼頭貿易

- 新建築：`airportTerminal` 4×3 $12M（赤鱲角機場區）、`airCargoTerminal` 3×2 $4.5M（機場區）、`portGate` 2×2 $900k、`portYard` 3×2 $1.4M（葵涌貨櫃碼頭區）；`containerPort` 限碼頭區。Region 限制由 `placement.regionKindAt` 檢查。
- `sim/trade.ts` 每日結算：機場客流 = 800 + 0.25×人口 + 0.6×商業就業（cap 9,000/客運大樓；天氣；8 格無公共交通 ×0.7），客流×$120＋貨運噸×$250；碼頭 TEU capacity=45×碼頭 level + 30×閘口 + 100×堆場（區外 ×0.7），TEU×$280；收入入 finance other，jobs/噪音；facility level 1–3 升級（機場 $6M/$12M、碼頭 $4M/$8M）。
- Render：機場跑道／客運大樓／貨櫃碼頭 decorative 改為 starter 或場內有對應建築才顯示（empty 玩家建成後出現）；機場雙跑道、葵涌貨櫃堆場視覺。
- UI：Y／城事／手機開貿易面板（機場客流／貨運、碼頭 TEU、收入、就業、噪音、使用率、逐座升級）；建造面板新增機場／碼頭卡及地區限制提示。

## R5.5 驗收（Round 5）

- `npx tsc --noEmit`：**0 error**
- `npm test`：**61 / 61**（4 files；新增 utilities 10、transit-lines 24、core pipe save roundtrip）
- `npm run build`：成功
- Playwright `scripts/verify-hk.mjs`：**34 / 34 checks**（600×600、水塘/山、starter 管網覆蓋、empty 0/0/0、分區、管網工具鋪設/拆除、地下/公用/貿易面板 toggle、starter 巴士路線開通、貿易狀態、天氣、室內 32、存檔 v6 跨頁面）
- 手機 `mobile-test.mjs`：**17 / 17**；桌面 UI `ui-click-test.mjs`：**21 / 21**
- 線上部署：GitHub push 後 Cloudflare Workers Builds 自動部署（詳見 README 網址）
- 截圖：`docs/screenshots/`（600 overview、東區、水塘、機場、碼頭、地下管網、路線、公用面板、貿易面板、mobile）

---

# 第六輪改版：處理 GitHub issues #1–#8（Round 6）

> 玩家要求：讀取並處理 `fungkingfai/hksimcity` 全部 issues、更新版本、建立 git 版本 tag。
> 日期：2026-10-25。版本：**GAME_VERSION 7／package 0.7.0／git tag v0.7.0**。

## R6.1 Issue 對應與處理

| Issue | 問題 | 實作 |
|---|---|---|
| **#8** | 手機版無法開始遊戲 | 開局畫面重構：`.ss-frame` flex column、內容 `.ss-scroll` 可滾動、**「開始規劃」CTA 固定 footer（100dvh + safe-area）**；iPhone 13 390×664 實測 CTA 永遠可見可點；seed 區改 `<details>`；手機資訊密度降低 |
| **#1** | 電車站只限港島 | 移除 `placement.ts` 港島 region 檢查；任何貼路可建地都可建電車站；UI/help 文案清理 |
| **#2** | 貨櫃碼頭只限葵涌 | 移除 `containerPort`／`portGate`／`portYard` 的 `requiredRegion`；任何臨水＋貼路可建；葵涌只保留吞吐加成（off-region ×0.9）；UI 文案更新 |
| **#3** | 三條道路通往南中國海 | `worldgen.ts` 隧道生成限定喺維港水域（design y 48–64）、兩端必須陸地、長度 3–60；實測只剩 3 條真實過海隧道（334–369），冇外海道路 |
| **#4** | 深圳河及道路連接 | generator 加入 **深圳河 616 water tiles**＋北岸合成深圳市區（23,812 tiles）；**4 個邊境通道**（羅湖 rail、落馬洲/文錦渡/沙頭角 road）；starter 自動放置 4 個口岸並接駁主道路（components=1）；render 海岸過渡／低對比 |
| **#5** | 港鐵地下／地上鐵路規劃 | 新增 `Tile.rail` 三 grade（surface/elevated/underground）＋`sim/rail.ts`（造價/地形/跨海、BFS 鐵路網、接駁站、孤立站 ×0.35、乘客/收入/維護/颱風）；`rail:*` 工具＋`U` 圖層；render 軌道（surface 枕木鋼軌／elevated 橋柱／underground 黃色隧道）＋3 卡 MTR 列車；save v7 `railEdits` |
| **#6** | 內地公路／鐵路糧食支援 | `sim/mainland.ts`：道路口岸 60 food/日、鐵路口岸 120/日；接駁道路/鐵路 component >20 判定；食物依次入倉庫/市場/餐廳，滿倉 pending 翌日；天氣係數；weather/log/stats；貿易面板「內地供應」 |
| **#7** | starter 現有樓群應為真建築非裝飾 | generator 加 `landuse`／`roadHint`；`existing-city.ts` 由真實土地用途＋道路＋密度生成 **572 棟 existing 真 `Building`**（住宅/商業/工業/農地，1–2×1–2、level、existing:true）＋**60 座現有公共設施**；道路以 main component 合併（**components=1、100% 連通**）；seed 400 現有居民；faux skyline 停用；render 距離 LOD（遠景有高度深色 box、近景完整模型），draw 1160→83 overview、tris 1.98M；選中/info 保留 |

## R6.2 版本／存檔

- `GAME_VERSION` **6 → 7**；`package.json` **0.7.0**。
- compact 存檔新增 `railEdits`（tileIndex + grade code）；`tileEdits` 保留道路/行人路/分區/管道；hydrate 後 `state.railNetwork` 重算。
- 同尺寸 v6 存檔可升級（rail/border/mainland 預設空，world data 會重生）；舊 96／304／480 存檔仍拒絕。

## R6.3 驗收（Round 6）

- `npx tsc --noEmit`：**0 error**；`npm test`：**89 / 89**（7 files，新增 rail 18、mainland 7、round6 3）；`npm run build` 成功。
- Playwright `verify-hk.mjs`：**36 / 36 checks**，starter 現有樓群/口岸/內地糧食、鐵路工具、管網、巴士線、貿易、天氣、室內、v7 存檔；render **322 draws／2.03M tris**（after verification city）。
- 手機 `mobile-test.mjs`：**17 / 17**；桌面 UI `ui-click-test.mjs`：**21 / 21**（最終回歸）。
- 版本 tag：`v0.7.0`；GitHub push 後 Cloudflare Workers Builds 自動部署。
- 截圖：`docs/screenshots/` 更新（existing 真樓 overview/central、rail surface/elevated/underground、rail ghost、深圳河／口岸、MTR 列車、U 層、empty）。

---

# 第七輪改版：處理 GitHub issues #9–#16（Round 8）

> 玩家第二輪 issues。版本：**GAME_VERSION 8／package 0.8.0／git tag v0.8.0**。

## R8.1 Issue 對應與處理

| Issue | 問題 | 實作 |
|---|---|---|
| **#9** | 左邊建造面板不能顯示全部內容 | build panel 重構：header 固定、`.build-body-scroll` 整體可滾動（自訂青→粉 scrollbar）、rail 區可摺疊、公共建築 tabs sticky；1280×800／457×1078 實測 26 種公共建築全部可達 |
| **#10** | 現有城市馬路太多太密 | existing-city road cap 收緊；starter 總路 **3,322 格**（原 9,700+），主幹 45%＋**1,780 格 localRoad 窄街**；render 窄街 0.52 tile 深灰、無標線／路緣／燈；道路 components=1、333 棟 existing 100% 貼主路網；overview 83 draws／1.69M tris |
| **#11** | 道路要可由起點拉至終點、穿山穿海（M 高架／N 隧道） | `RoadGrade` surface/elevated/tunnel；`placeRoad(...,grade)`（elevated $75k、tunnel $60k，可跨水／山、可升級）；`roadPathBetween` L 形；city-view 拖曳 start→end 預覽（綠/紅）、release `applyRoadPath`；M/N 切 grade；render 高架橋面＋柱、隧道走線＋入口龍門＋U 層隧道管；save `roadGradeEdits` |
| **#12** | 地下管網要分開食水／污水／電力層，並看到流動 | `ui.pipeLayers {water,sewage,power}` 三層獨立 toggle；`ui.pipeFlow` 流動光點（沿管移動、按種類上色，≤4 draws）；U 層工具列＋公用面板 eye chips＋流水 toggle；U 關閉全隱藏 |
| **#13** | 多一層顯示／不顯示建築，方便規劃 | topbar 新增建築 toggle、快捷鍵 **B**（原建造面板改 Tab）；`ui.showBuildings=false` 隱藏 buildings group（normal+LOD+ghost），道路／地形／標籤保留；UIState 持久化 |
| **#14** | 深圳市區域只作參考、不能建設 | placement／zoning／road／pipe／rail／demolish 全部以 `isShenzhenSideTile` 拒絕（reason「深圳市範圍只作參考，不可建設」）；render 斜線 hatch overlay＋琥珀邊界＋label「深圳市（參考）· 不可建設」；hover 加強 |
| **#15** | 城事面板縮退按鈕無反應 | 根因 `ui.ts update()` 每幀因 `showStats=true` 移除 collapsed class；修正 collapse/expand 同步 `state.ui.showStats`＋bumpUI，update 只跟 state；收起持久、handle 展開正常 |
| **#16** | 船有時在陸上行 | 根因 ferry 只用兩點直線＋`isWaterLine` 0.5 格取樣漏判窄陸地；改 **水域 BFS 完整 path**（每格 water、3–400 格）、逐格推進、每次 update 全 path validate、失效回收重派；7 個 ferry tests（陸地屏障不得 spawn、20 日航行 0 次偏離水域） |

## R8.2 版本／存檔

- `GAME_VERSION` **7 → 8**；`package.json` **0.8.0**；git tag **v0.8.0**。
- compact 存檔新增 `roadGradeEdits`（[tileIndex, gradeCode]；surface/elevated/tunnel）＋既有 `railEdits`；UIState 新增 `showBuildings`／`pipeLayers`／`pipeFlow`／`roadGrade`，經 state 自動保存。
- 同尺寸 v7 存檔可升級（新欄位 default）；舊 96／304／480 存檔仍拒絕。

## R8.3 驗收（Round 8）

- tsc **0 error**；vitest **102 / 102**（9 files；新增 ferry 7、round8 6）；`npm run build` 成功。
- Playwright `verify-hk.mjs`：**42 / 42 checks**（Round 8 追加：#9 scroll、#11 高架跨水、#12 分層、#13 建築圖層、#14 深圳、#15 collapse）。
- `mobile-test.mjs` **17 / 17**；`ui-click-test.mjs` **21 / 21**（最終回歸；B 快捷鍵語義已更新）。
- 1600×960 lite 穩定性：starter + U 層＋flow＋road 工具 20 秒，crashed=false、console errors=0。
- render：overview 83 draws／1.69M tris；central 399／1.73M；U 層 423／1.82M；buildings-hidden 74／1.64M。
- 截圖：`docs/screenshots/`（build-panel、info-collapsed、pipe-layers-ui、roads-local、buildings-hidden、pipe-water/sewage/power、shenzhen-overlay、road-drag-preview、road-elevated、road-tunnel）。

---

# 第八輪改版：處理 GitHub issues #17–#20（Round 9）

> 版本：**GAME_VERSION 9／package 0.9.0／git tag v0.9.0**。

| Issue | 問題 | 實作 |
|---|---|---|
| **#17** | 現有城市道路仍互相連成片；應道路包圍規劃街區 | `existing-city.ts` 改 **planned block grid**（3×3 block＋1 格路；每 4 block 主幹）；starter 總路 **3,020 格**、components=1、existing-city 樓 100% 貼主路網；render localRoad 窄街；前後截圖對比 |
| **#18** | 天氣警報應參考天文台颱風密度/級數 | 新增 `sim/hko-climate.ts` 嵌入 HKO 1961–2020 表 6a；weather roll 按月份抽 **1／3／8（四方向）／9／10 號風球**＋黃/紅/黑暴雨、山泥傾瀉；1/3 號影響較輕、8+ 渡輪停航；`clock.typhoonSignal/typhoonName/rainstorm`；城事「天文台氣候」卡＋HKO source |
| **#19** | 機場飛機沒有飛 | 新增 `render/airport-traffic.ts`：10 架飛機同時（6 stand＋4–6 approach/takeoff）、3 塗裝、跑道/ILS/導航燈；跟旅客量、8 號風球停飛；≤5 draws |
| **#20** | 按 CSDI 3D-BIT00 提供大量香港特色建築 | 新增 `tools/build-3d-landmarks.py`：HTTP Range 下載 3D-BIT00 tile ZIP central directory → 抽 3DS 高樓 → parse 0x4110/0x4120 → 簡化幾何；生成 **81 座真實 landmark**（CSDI/LandsD，HK1980）；`world/hk-3d-landmarks.ts` 放 existing 樓；`render/models/hk-3d-landmarks.ts` custom geometry＋夜窗；UI badge |

## 版本／存檔
- GAME_VERSION **9**；package **0.9.0**；save **v9**（沿用 compact＋`roadGradeEdits`；clock typhoon 狀態隨 state 保存；3D landmark 由種子重生）。
- 新增測試 `tests/round9.test.ts`（規劃街區、HKO 數據、3D landmark 存檔）＋`tests/hko-weather.test.ts`。

## 驗收（最終）
- tsc **0 error**；vitest **115 / 115**；build OK。
- Playwright verify：**47 / 47 checks**；mobile **17/17**、UI **21/21**（回歸）。
- Render：starter overview ~149 draws／1.81M tris、central 320／1.88M；airport 近景 64 draws／1.82M；3D landmark 81 座各 1 draw（遠景 LOD +0）；draw/tris 全部 ≤750／2.3M。
- 截圖：`docs/screenshots/`（roads-before/after、airport-day/landing/takeoff/night/typhoon、3d-landmarks-day/night/starter、hko-sig8/9/10、hko-card、3d-badge）。
