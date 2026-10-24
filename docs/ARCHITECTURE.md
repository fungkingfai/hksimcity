# 《維港之城》(hk-city) — 技術架構與多 Agent 分工

> 本文件是全體 Agent 的協作契約。開始工作前必讀 `src/core/types.ts`、`src/core/config.ts`
> 與本文件。專案根目錄：`/home/fung/Documents/deepseek-harness/default-workspace/hk-city`
> 基礎引擎由 `huaxia-city/`（中國古城版）分支而來；技術骨架保留，世界／建築／室內／
> 市民／交通／經濟全部改造成香港版本。

## 1. 專案目標（香港版 SimCity）

以 **three.js + TypeScript + Vite** 製作**香港風格及香港地圖**的城市建造模擬遊戲，必須包含：

- 香港地圖：維多利亞港、香港島、九龍半島、新界、大嶼山／離島、填海區、太平山／獅子山／大帽山。
- 道路網（**車道＋行人路整合**）；不同地形（平地／市區地／填海地／農地／濕地／林地／丘陵／山地／水域／沙灘）。
- **分區式玩法（Round 2）**：玩家鋪路＋劃住宅／商業／工業／農業區，開發商按 RCI+F 需求與服務覆蓋自動建屋；
  另有兩種開局模式（已有城鎮／由零開始）與分區色塊 overlay。詳見 §8。
- 32 種香港建築（19 種由分區自動開發、13 種由玩家手動放置）：唐樓、劏房、公屋、居屋、私人屋苑、豪宅、
  茶餐廳、便利店、街市、超市、商場、酒樓、商廈、工廈、食品廠、石礦場、發電廠、水務設施、貨櫃碼頭、
  貨倉、學校、醫院、警署、消防局、公園、海濱長廊、港鐵站、巴士總站、電車站、渡輪碼頭。
- 市民個體模擬（香港姓名、住戶、就業、通勤、購物、幸福度、移民）。
- 不同交通工具：雙層巴士、小巴、的士、電車（叮叮）、天星小輪、貨車、客貨車、私家車、電單車。
- 物流系統：貨櫃碼頭進口 → 貨倉 → 街市／超市／便利店 → 市民；石礦場 → 工廈 → 電子產品；
  農地／食品廠 → 食品；貨車沿道路運送。
- 財政系統：薪俸稅、利得稅、差餉、賣地收入、車費收入、服務收入；維護費、公務員薪酬、福利。
- 日夜、春夏秋冬、晴／陰／雨／颱風／霧／雪天氣，颱風有天文台警告與停航停工效果。
- **每一棟建築都可以進入室內**（29 種不同室內場景）。
- 網站入口（Vite 建置＋preview）＋存檔系統（自動存檔、3 個手動存檔、JSON 匯出／匯入）。
- 桌面版＋手機版介面。

## 2. 快速指令

```bash
npm install          # 已安裝（node_modules 由 huaxia-city 複製）
npm run dev          # 開發伺服器（由 Lead 統一用 5273 埠啟動，Agent 不要自行啟動）
npx tsc --noEmit     # 型別檢查（Agent 收工前必須執行；整合期間其他 Agent 的檔案可能仍有錯，
                     #  只修自己範圍，其餘在回報中列出）
npm run build        # tsc + vite build（Lead 整合時執行）
npm test             # vitest（Lead／QA 負責更新）
```

## 3. 檔案地圖與負責 Agent

| 路徑 | 負責 Agent | 說明 |
|---|---|---|
| `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `wrangler.jsonc` | Lead | 建置設定與品牌 |
| `src/main.ts`, `src/render/city-view.ts`, `src/render/coords.ts` | Lead | 主迴圈、Actions、鏡頭／輸入／室內切換、整合 |
| `src/core/**`（types/config/store/save/new-game/starter-town/device/format/rng） | Lead | 型別、資料表、存檔、兩種開局（starter-town 預建城鎮）、事件 |
| `src/sim/zoning.ts` | systems-dev | RCI+F 需求、發展分數、開發商自動建屋、荒廢清拆、`zoneStats`（Round 2 新增） |
| `src/render/zones.ts` | world-dev | 分區色塊 overlay（4 個 InstancedMesh，≤4 draw calls，Round 2 新增） |
| `src/ui/start-screen.ts` | ui-dev | 開局模式選擇畫面（starter／empty＋seed，Round 2 新增） |
| `src/sim/time.ts`, `src/sim/simulation.ts` | Lead | 時間／天氣推進、模擬主迴圈整合 |
| `src/world/**` | world-dev | 香港地圖世界生成（維港／山脈／離島／填海／市區） |
| `src/render/terrain.ts`, `roads.ts`, `environment.ts`, `world-utils.ts`, `world-geometry.ts` | world-dev | 地形／道路＋行人路／日夜四季天氣視覺／遠景 |
| `src/render/buildings.ts`, `src/render/models/building-prototypes.ts`, `src/render/models/hk-parts.ts`, `src/render/models/materials.ts`, `src/render/models/geometry-utils.ts` | buildings-dev | 29 種香港建築外觀、霓虹招牌、街燈、預覽幽靈 |
| `src/render/interior.ts`, `src/render/models/interior-parts.ts`, `src/ui/interior-panel.ts` | interiors-dev | 29 種可進入室內場景＋室內資訊面板 |
| `src/render/citizens.ts`, `src/sim/citizens.ts`, `src/sim/population.ts`, `src/sim/citizen-common.ts` | citizens-dev | 香港市民行為、人口、行人渲染 |
| `src/sim/transit.ts`, `src/sim/vehicles.ts`, `src/render/vehicles.ts` | transport-dev | 公共交通（港鐵／巴士／電車／渡輪）、車輛生成與渲染 |
| `src/sim/logistics.ts`, `logistics-inventory.ts`, `pathfinding.ts`, `placement.ts`, `production.ts`, `finance.ts`, `stats.ts` | systems-dev | 物流、道路／行人路尋路、擺放拆除、生產、香港財政、統計 |
| `src/ui/**`, `src/styles.css` | ui-dev | 全部 DOM 介面、霓虹港風視覺、手機版 |
| `docs/**` | game-designer（Lead 可修 README） | 研究、GDD、UI 規格 |
| `tests/**`, `scripts/**` | Lead／QA | 測試與自動驗收 |

**硬規則**

1. 只修改自己負責的檔案。需要改別人的檔或 `core/`、`main.ts` 時，先私訊 Lead。
2. 不可新增 npm 依賴（需要時告知 Lead）。
3. 不可啟動 dev server（Lead 統一管理 5273 埠）；收工前執行 `npx tsc --noEmit`。
4. 保持既有函式簽名與對外介面（見 §5）；擴充時只加欄位／新函式，不要破壞呼叫端。
5. 不要改 `src/core/types.ts` 與 `src/core/config.ts`（Lead 專屬）。需要新欄位先問 Lead。
6. 完成後把任務標記 complete，並用 `send_message` 向 lead 回報：改了哪些檔、完成功能、
   整合注意事項、未完成事項。
7. 效能：大量物件用 `InstancedMesh`／共用 geometry/material；避免每幀重建幾何；目標 60fps。
8. 語言：程式註解與 UI 文字用**繁體中文（香港用語）**；變數／型別用英文。不可用簡體。

## 4. 核心資料模型（摘要）

- `GameState`：`tiles[]`、`buildings[]`、`citizens[]`、`carts[]`、`vehicles[]`、`transit`、
  `clock`、`finance`、`stats`、`ui`、`log[]`、各種 `next*Id`。
- `Tile`：`terrain`（grass/urban/reclaimed/fertile/wetland/forest/hill/mountain/water/sand）、
  `elevation`、`variant`、`buildingId`（-1 = 無）、`road`、`sidewalk`。
- 地圖 `width=96, height=96`，`tileIndex = y*width + x`。世界座標置中：
  格中心 = `(x+0.5)*TILE - width*TILE/2`（`TILE=2`），一律用 `src/render/coords.ts`。
- 建築尺寸以格為單位（1x1、2x2、3x2、4x3…），(x,y) 為左上角。
- `Building`：`workers[]`、`residents[]`、`inventory`（物流資源）、`connected`、`level` 等。
- `GameClock`：`minutes` 絕對遊戲分鐘；`day/month/year/hour/weekday/season/weather/tempC/warning`。
  1 天 = 1440 遊戲分鐘 = 30 真實秒（1 倍速）；1 月 = 7 日；1 年 = 12 月（約 42 分鐘）。
- `finance`：`treasury`、`salaryTaxRate`（0..0.2）、`profitTaxRate`（0..0.25）、
  `ratesRate`（0..0.12）、`incomeBreakdown`／`expenseBreakdown`（分類月報）、`history`。
- `transit`：`dailyRidership`、`faresThisMonth`、`suspended`、`byMode`。
- `stats` 每幀由 `sim/stats.ts` 更新：人口／就業／幸福度／食品／公用設施覆蓋率／交通覆蓋率等。
- `ui`：`tool`（建築 key／'road'／'sidewalk'／'demolish'／null）、`selectedId`、`mode`
  （'city' | 'interior'）、`interiorId`、`speed`、`paused`、各面板開關。
- 事件（`GameStore`）：`tick/reset/enter/exit/select/toast/log/ui`。UI 每幀輪詢 `ui.update(state)`；
  離散事件用 `store.on()`。

### 4.1 香港資源與生產鏈

| 資源 | 來源 | 用途 |
|---|---|---|
| 食品 food | 農地產出（`config` 暫無農田建築 → v1 由食品廠＋貨櫃碼頭進口）、食品廠 | 市民食用、茶餐廳／酒樓消耗 |
| 日用品 goods | 貨櫃碼頭進口 | 市民消費、醫院消耗 |
| 電子產品 electronics | 工廈（建材→電子） | 市民消費、出口 |
| 建材 materials | 石礦場 | 工廈原料 |

> 物流：生產者 → 貨倉／街市／超市（storage）→ 零售服務（market）→ 市民。
> 市民購物時扣店舖庫存、付錢（零售價），零售收入計入建築 `incomeThisMonth` 與服務收入。

### 4.2 公用設施與交通

- 發電廠／水務設施以 `utility` 定義（`radius`、`capacity`）提供覆蓋；`stats.powerCoverage`／
  `waterCoverage` 以人口加權，低覆蓋扣幸福度。
- 港鐵站／巴士總站／電車站／渡輪碼頭以 `transit` 定義（`mode`、`radius`、`capacity`、`fare`）；
  市民 `commuteMode` 依住所最近站點選擇；`transit.byMode` 統計載客；車費計入財政。
- 颱風（weather==='storm'）時 `transit.suspended = true`：渡輪停航、戶外交通變慢。

## 5. 模組契約

### 5.1 渲染模組（各自建立 Group，CityView 負責加入場景與更新順序）

```ts
// terrain.ts / roads.ts
createTerrainView(state): TerrainView
createRoadsView(state): RoadsView
interface XxxView { group: THREE.Group; update(state, dt): void; dispose(): void }

// environment.ts（燈光、天空、雨雪颱風霧、星辰、霓虹反光；本身加入 scene）
createEnvironmentView(scene, state): EnvironmentView
interface EnvironmentView { update(state, dt, camera): void; dispose(): void }

// buildings.ts
createBuildingsView(state): BuildingsView
interface BuildingsView {
  group; update(state, dt): void;
  setPreview(state, tool, hover, valid): void;  // 建造幽靈
  dispose(): void;
}
// 所有可點擊 mesh 必須設 userData.buildingId

// citizens.ts
createCitizensView(state): CitizensView // group/update/dispose

// vehicles.ts（transport-dev）
createVehiclesView(state): VehiclesView // group/update/dispose

// interior.ts
createInteriorView(state, buildingId): InteriorView | null
interface InteriorView { scene; camera; update(state, dt): void; dispose(): void }
```

`CityView` 每幀依序呼叫：`environment.update → terrain.update → roads.update →
buildings.update → vehicles.update → citizens.update → 室內或城市 render`。
所有 Group 位置使用 `coords.ts`，地面 y≈0.3，地形頂部約 y=0.3~0.6，建築模型從 y≈0.28 往上長。

### 5.2 模擬模組

```ts
// simulation.ts（Lead）
class Simulation { update(state, realDt, ctx) }  // 順序：clock → citizens → logistics → vehicles
//                                               → newDay: connectivity/production/population/
//                                                 transit/finance/stats → newMonth: finance
// time.ts（Lead）
advanceClock(state, gameMinutes, ctx): { newDay, newMonth, newYear }
// production.ts（systems-dev）
tickProduction(state, ctx): void            // 每日
// population.ts（citizens-dev）
tickPopulation(state, ctx): void            // 每日
// logistics.ts（systems-dev）
tickLogistics(state, gameMinutes, ctx): void
// transit.ts（transport-dev）
tickTransit(state, ctx): void               // 每日：覆蓋率、載客、車費收入
// finance.ts（systems-dev）
tickDailyFinance(state, ctx): void
monthlyFinance(state, ctx): void
// stats.ts（systems-dev）
updateStats(state): void
// placement.ts（systems-dev）
canPlaceBuilding(state, key, x, y): PlaceResult
placeBuilding(state, key, x, y): PlaceResult
placeRoad(state, x, y): PlaceResult
placeSidewalk(state, x, y): PlaceResult
demolishAt(state, x, y)
updateConnectedBuildings(state)
```

### 5.3 交通模組（transport-dev）

```ts
// sim/transit.ts
transitCoverage(state): { mode: TransitMode; coverage: number }[]  // 每日更新
tickTransit(state, ctx): void        // 每日結算載客、車費、颱風停航
pickCommuteMode(state, home, work): TransitMode | 'walk'
// sim/vehicles.ts
tickVehicles(state, gameMinutes): void  // 每幀移動車輛、生成／回收
spawnTrafficVehicle(state, kind): void
// render/vehicles.ts
createVehiclesView(state): VehiclesView
```

### 5.4 市民（citizens-dev）

- `tickCitizens(state, gameMinutes, ctx)`：市民狀態機（家→工作→購物→消閒→回家）。
- 市民在**行人路／道路**上行走（`isPassableTile`）；通勤方式用 `commuteMode`，
  再乘 `TRANSIT_SPEED` 加快移動；搭車市民每日乘車時記入統計（由 transit 模組結算）。
- 需求 `needs.food/goods/leisure`：到零售店購物、到公園／海濱／商場獲得消閒。
- 香港姓名（`SURNAMES`／`GIVEN_NAMES`／`ENGLISH_NAMES`），性別、年齡、月薪 `salary`。
- `render/citizens.ts`：行人模型（西裝、校服、師奶、長者、情侶等套色）、
  **物流貨車**（carts → truck/van）也在此渲染或交給 vehicles-dev？→ 貨車在 citizens.ts 由
  citizens-dev 依 `state.carts` 渲染（保留原設計）；transport-dev 只負責交通車輛。

### 5.5 室內（interiors-dev）

- `createInteriorView(state, buildingId)`：依 `BUILDINGS[key].interior` 生成室內（29 種）。
- 室內要能回答：這棟建築現在運作得如何、住著／工作著誰、庫存多少、本月帳目。
- `ui/interior-panel.ts`：`createInteriorPanel(...)` 由 `ui.ts` 呼叫（保持原簽名，見檔案）。
- 室內亦要顯示日夜（窗光）與天氣（雨聲視覺）差異。

## 6. 整合流程（Lead）

1. Lead 先完成核心契約（types/config）、main.ts／city-view.ts 骨架、時間與模擬主迴圈、存檔版本升級。
2. 各 Agent 平行開發期間，Lead 保持 `npx tsc --noEmit` 追蹤錯誤、必要時協調介面。
3. Agent 全部回報後，Lead 依序整合：world → roads → buildings → interiors → citizens →
   vehicles → systems → UI，修正型別與介面，跑 `npm run build`、`npm test`、Playwright 驗收
   （`scripts/verify-hk.mjs`）與截圖。
4. 產出 README、TEAM_REPORT、部署設定（Cloudflare Workers 靜態資產）。

## 7. 驗收標準（全體以這個為準）

- `npx tsc --noEmit` 0 錯誤、`npm run build` 成功。
- 開新局：香港地圖正確呈現（維港兩岸、山脈、離島、填海區），有預設市中心與起始道路。
- 可鋪道路與行人路；可建 29 種建築（依人口解鎖）；建築需臨路／臨水規則正確。
- 市民遷入、就業、通勤、購物；可見行人在行人路行走、車輛在馬路行駛（≥6 種交通工具）。
- 物流：貨櫃碼頭→貨倉→街市→市民；缺貨時市民幸福度下降並有提示。
- 財政：薪俸稅／利得稅／差餉可調；月度報表有分類收入支出；破產警告。
- 晝夜、四季、天氣（晴／陰／雨／颱風／霧／雪）有視覺與玩法效果；颱風有警告與停航。
- 可進入全部 29 種建築室內，室內有內容；存檔／讀檔／匯出／匯入可用。
- 手機版可玩（底部導覽、觸控手勢）。
- Playwright 全流程驗收通過，截圖存 `docs/screenshots/`。

## 8. 第二輪改版：分區式玩法（Round 2）

玩家回饋後把「逐棟建屋」改為 **SimCity / Cities: Skylines 2 式分區玩法**，並修正地名方向、
整合道路與行人路、加入兩種開局。核心契約仍以 `src/core/types.ts`／`config.ts` 為準。

### 8.1 資料模型（Lead 定義）

| 型別 | 新增欄位 |
|---|---|
| `ZoneType` | `'residential' \| 'commercial' \| 'industrial' \| 'farmland'` |
| `Tile` | `zone?: ZoneType \| null`（分區） |
| `Building` | `auto?: boolean`（開發商自動開發）、`zone?: ZoneType`（所屬分區） |
| `GameState` | `gameMode: 'starter' \| 'empty'`、`zoneDemand: Record<ZoneType, number>` |
| `GameStats` | `zoneDemand`、`zoneTiles`、`zoneBuildings`、`policeCoverage`、`fireCoverage`、`schoolCoverage`、`hospitalCoverage`、`landValue` |
| `UIState` | `showZones`（分區色塊）、`showStartScreen`（開局模式畫面） |
| `BuildingDef` | `zone?`、`weight?`、`minDevScore?`、`ploppable?`（19 auto＋13 ploppable） |
| `GameActions` | `startGame(mode, seed?)`、`newGame(seed?, mode?)`、`toggleZones()` |

`config.ts`：`ZONES`（名稱／顏色／每格造價／說明）、`ZONE_ORDER`、`zoneTool()/zoneOfTool()`、
`AUTO_DEVELOP`（每日檢討、每區上限、需求門檻、荒廢日數、上限 420）、`zoneBuildingDefs()`、
`PLOPPABLE_BUILDINGS`、`STARTER_TOWN`（starter 庫房／warm-up 日數）。

### 8.2 玩法與工具

- 工具字串：`road`（道路，**自帶行人路**）、`zone:<ZoneType>`、`dezone`（取消分區，退 50%）、`demolish`。
- 住宅／商業／工業區可劃在任何可建地；農業區只可劃在 `fertile/grass`；不可劃在道路／建築格。
- 自動開發每日一次：已劃區格需臨路（農田例外）、footprint 需全在分區內（農田容許部分覆蓋）、
  按 `minDevScore`＋weight 抽選建築；每區每日 2 棟、全城 5 棟、上限 420；連續 8 日無路／取消分區會清拆。
- 需求公式（`computeZoneDemand`）：住宅睇職位空缺／失業／空置／幸福；商業睇人口／商業職位；
  工業睇人口／失業／貨運；農業睇存糧日數。供應過剩（大量未開發分區）會壓低需求至 -0.6。
- 玩家手動放置（13 種）：發電廠、水務、學校、醫院、警署、消防局、公園、海濱長廊、港鐵站、
  巴士總站、電車站、渡輪碼頭、貨櫃碼頭（保留解鎖人口、地形／臨路／臨水／地區規則）。
- 市民：遷入速度讀 `stats.zoneDemand.residential`；幸福度加入四項服務覆蓋（各 ±2，合共 ±8）。

### 8.3 整合點（Lead 負責）

- `simulation.ts` 每日 `tickZoning(state, ctx)`（在 `updateConnectedBuildings` 之後、生產／人口之前）。
- `main.ts`：分區工具 → `paintZone/eraseZone`（拖曳失敗提示節流）；`startGame(mode, seed)`；
  starter 模式建立 state 後 `warmUpStarterTown()` 跑 10 個遊戲日，令市民遷入、建築運作。
- `city-view.ts`：分區工具納入繪製工具（拖曳連續劃區）、hover 以分區色顯示、
  整合 `createZonesView(state)`（update/dispose）。
- `save.ts` v3：normalize `tile.zone`、`building.auto/zone`、`gameMode`、`zoneDemand`、
  新 stats 欄位、`ui.showZones/showStartScreen`（讀檔時關閉開局畫面）。
- `core/starter-town.ts`：中環 spawn 附近棋盤道路、四色分區（農業區 2×2 地塊）、
  21 棟 auto 建築、13 種公共設施、倉庫預放食品；`new-game.ts` 的 `createGameState(seed, mode)` 呼叫。

### 8.4 Round 2 驗收重點

- 兩種開局：starter 預建城市（warm-up 後人口約 120–150）／empty 空地圖 5 市民。
- 分區刷子劃區→開發商自動建屋：30 日內住宅／商業／工業皆有自動建築，人口 ≥100。
- 需求條與服務覆蓋在 UI 顯示；過量劃區令需求回落，開發暫停（供需平衡）。
- 道路全部整合行人路（新鋪道路 `road && sidewalk`）；UI 不再出現獨立行人路工具。
- 地圖中文地名任何鏡頭角度皆正向（修正 CanvasTexture flipY 與 billboard UV 對應）。
- 32 種建築仍全部可進入室內；存檔跨頁面保留分區與自動建築。
- 1600 人壓力測試：simulation 平均 <1ms/幀（logistics 由 22.25ms 優化至 ~0.02ms）。

## 9. 第四輪改版：真實香港地理數據 480×480（Round 4）

玩家要求參考 CSDI／香港地理空間數據修正地形與建築設計（尤其杏花邨、柴灣）並再加大地圖。

### 9.1 真實地理數據

- `tools/build-hk-data.py`（離線）讀取：
  - LandsD **DTM 5m**（`Whole_HK_DTM_5m.zip`）：真實海岸線、高程；
  - CSDI／LandsD **Building Outlines**（CSDI metadataInfoPanel 下載 zip 內 `Building_Outline_Public_*_Building_converted.geojson`）：342,233 個建築輪廓、`Shape_Area`／`TopHeight`／`Storeys`。
- 經 HK1980 Grid（EPSG:2326 Transverse Mercator）換算成 480×480 ×140m 地圖，輸出：
  - `src/world/hk-map-data.generated.ts`（約 0.97MB）：terrain RLE、elevation、density、buildingHeight（base64）、69 真實地名、6 地標、15 個市區／機場／貨櫃／新市鎮區塊、3 過海隧道、spawn。
  - 型別：`src/world/hk-map-data-types.ts`。
- 資料授權：香港特別行政區政府（地政總署／CSDI）開放數據，使用須遵守 data.gov.hk／CSDI 條款；原始 300MB 數據不入 repo，只 commit 生成檔。

### 9.2 世界生成／資料模型

- `worldgen.ts`：`generateWorld()` 在 480×480 走 `generateRealWorld()`；其他尺寸保留程序化 fallback（測試用）。
- `Tile` 新增 `density?: number`（0..255，真實建築覆蓋率）與 `buildingHeight?: number`（米）；**只供 render 使用**，不參與 sim。
- Empty 模式 `starterRoads:false`：0 道路／建築／分區／隧道；starter 由 `core/starter-town.ts` 以 **連通優先 BFS 道路網** 建立（中環 spawn 259,299）。
- 存檔 v5：`seed + gameMode + 稀疏 tileEdits + state（不含 tiles）`；hydrate 時由生成檔重新建地形；舊 96／304 存檔不相容。

### 9.3 渲染

- 真實 density／height 驅動 starter 現有樓群（約 4,089 座、3 InstancedMesh；杏花邨／柴灣／小西灣高樓群）；empty 完全隱藏假樓群與所有人造地標。
- 雪線修正（elevation ≥0.8，只 snow／冬季 ≤6°C）；無邊海面 4 巨型外框 quads；地名 billboard 螢幕空間尺寸＋3 層 LOD；赤鱲角雙跑道；葵涌貨櫃碼頭按真實區塊；道路電車走廊／紅白磚用真實座標。

### 9.4 480 地圖契約／限制

| 項目 | 數值 |
|---|---|
| `GRID_WIDTH/HEIGHT` | 480×480（230,400 格） |
| 每格 | 140m（HK1980 範圍 E 798,275–865,475、N 790,400–857,600） |
| `MAP_SCALE` / `WORLD_SPAN` | 5 / 960 |
| 相機 | MIN 16、MAX 1,300、far 3,000、fitMap ≈1,196 |
| 可建土地 | 22.4%（真實香港山多平地少） |
| 存檔 | v5 compact，約 80–140KB（視建築/市民數） |
| 效能 | starter overview 1.33M tris／402 calls；empty 1.03M／37；sim normal <3ms（1000 人 <8ms） |
| 已知限制 | 140m 解析度（小型海灣/街道以格簡化）；DTM 水塘水面高程>0，水塘用曲線補；舊存檔不相容 |
