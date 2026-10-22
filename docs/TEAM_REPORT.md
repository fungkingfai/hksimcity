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
