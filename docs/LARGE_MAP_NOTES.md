# 《維港之城》304×304 大地圖改版筆記（LARGE_MAP_NOTES.md）

> 文件版本：1.0（2026-10-22）｜撰寫：game-designer
> 專案：`hk-city/`｜用途：記錄第三輪改版（304×304 大地圖、完全空地 empty、minimap 導航、save v4、AUTO_DEVELOP 放大）的設計與實作對照；供 Lead／world-dev／ui-dev／systems-dev／QA 查閱。
> 相關文件：`GAME_DESIGN_HK.md`（§2 地圖、§12 存檔、§13 平衡）、`UI_SPEC_HK.md`（§5／§6 minimap、§附錄 A 快捷鍵）、`ZONING_GAMEPLAY.md`（§3–§7 分區開發與開局）。
> 標記：**✅ 已實作（依 `src/` 核對）**｜**⚠️ 文件規格（待實作／待確認）**｜**📌 已知限制／不一致**。

---

## 1. 改版摘要（Round 2 96×96 → Round 3 304×304）

| 項目 | Round 2（96×96） | Round 3（304×304） |
|---|---|---|
| 地圖 | 96×96＝9,216 格 | **304×304＝92,416 格**（面積約 10 倍，線性 ×3.1667） |
| 世界尺寸 | 192×192 世界單位 | **608×608**（`WORLD_SPAN=GRID_WIDTH×TILE_SIZE`） |
| 地理特徵 | 以 96 設計座標繪製 | 同一設計座標**線性 ×3.17** 縮放；河流／維港在格數上約闊 3.17 倍 |
| empty 模式 | 有預置 spawn 小街區／隧道 | **完全空地**：零道路、零建築、零分區、無人造地標／機場／貨櫃碼頭；只有自然地形、樹木、海面船隻 |
| 導航 | 滑鼠平移／縮放 | 新增 **minimap（右下 304×304）＋快捷 O 全圖／P 市中心**；相機 zoom out 範圍 ×3.17 |
| 存檔 | v2 完整 `GameState` JSON | **v4 精簡格式**：seed＋稀疏道路／分區變更，約 80–140KB；96×96 舊檔不兼容 |
| 自動開發 | 每日 5 棟、每區 2、上限 420 | **每日 15 棟、每區 6、上限 1,200**（面積 ×10 同步放大） |
| 效能 | 96 地形 | terrain tris 3.43M→**588k**；empty overview 495k tris／37 calls；starter ≈705k tris／444–454 calls；sim 正常幀平均 **≈0.23ms**（304 starter 573 人）；首次 worldgen **1.5–2 秒**（載入畫面） |

---

## 2. 地圖尺度與座標系（✅ 已實作）

| 常數／概念 | 值 | 說明 |
|---|---|---|
| `GRID_WIDTH`／`GRID_HEIGHT` | **304／304** | `config.ts` |
| 總格數 | **92,416** | 約 96×96 的 10 倍面積 |
| `TILE_SIZE` | 2 | 每格 2 世界單位 |
| `WORLD_SPAN` | **608** | 304×2；渲染、相機、霧、天空以此換算 |
| `MAP_SCALE` | **304/96 ≈ 3.1667** | 渲染模組用它換算霧、天空、相機距離、裝飾密度 |
| `HK_DESIGN_SIZE` | **96** | worldgen 仍以 96×96 設計座標繪製香港地理，再線性縮放至 304 |
| 設計座標 → 格座標 | `tile = design × (304/96)` | 地名、山脈、隧道、填海區、spawn 全部沿用設計座標 |
| spawn | 設計 **(44, 63)**（中環） | 換算格座標約 **(139, 199)**；由 `HK_SPAWN_DESIGN` 提供 |
| 過海隧道 | 設計 x≈33／52／70 | 換算格座標約 x≈104／164／221；只存在於 starter 模式 |

> 📌 **地圖「拉伸」**：地理特徵是按 96 設計座標**等比例放大**（不是重新繪製 304 版本），所以維港、河流會比 96 版闊約 3.17 倍；這是刻意選擇（保留香港輪廓、節省 worldgen 重寫成本），不是 bug。設計文件中的座標（例如山脈 y 範圍、地名錨點）預設都是**設計座標**，實作時要乘 `MAP_SCALE`。

---

## 3. 世界生成與 empty 模式（✅ 已實作）

### 3.1 worldgen 縮放

- `generateWorld(seed, width, height, options)` 仍以 `HK_DESIGN_SIZE=96` 的設計座標畫海岸線、山脈、填海、地名；輸出時按 `width/96`、`height/96` 縮放。
- 渲染裝飾密度歸一：樹木／花草／貨櫃／菜田等「逐格機率」裝飾乘 `1/(kx×ky)`（`deco = min(1, 1/(kx*ky))`），令全圖裝飾總數與 96 地圖相若，避免 304 地圖爆 draw call。
- 地名標籤、隧道、填海區、機場、貨櫃碼頭都用同一套設計座標資料（`HK_PLACES`／`HK_TUNNELS`／`HK_REGIONS`／`HK_LANDMARKS`）。

### 3.2 empty 模式（由零開始）

- `createGameState(seed, mode='empty')` → `generateWorld(..., { starterRoads: mode === 'starter' })`。
- `starterRoads:false` 時**不預置**：spawn 小街區、行人路、3 條過海隧道、隧道引道。
- 渲染層 `showcaseCity = state.gameMode === 'starter'` 控制以下人造物**只在 starter 顯示**（empty 全部隱藏）：
  - 市區遠景假樓群（backdrop skyline）；
  - 貨櫃碼頭貨櫃堆；
  - 機場／跑道／客運大樓／飛機；
  - 山頂凌霄閣、天壇大佛、鐘樓、會展等 `HK_LANDMARKS`；
  - 「市區農田」裝飾。
- empty 保留：自然地形、山脈、海岸、樹林、海面船隻（漁船／貨輪／天星小輪式裝飾，純視覺）。
- empty 起始：**5 名市民（設計要求）＋ $8,000,000**；畫面提示「先鋪路再劃分區」。
- 📌 **注意（與程式碼不一致，見 §9）**：目前 `createGameState('empty')` 的 `citizens = []`，`population.ts` 亦只在有住宅空位時才遷入，**未見「5 名市民」初始寫入**；UI 文案（start-screen／help-panel／save-panel）已寫 5 名，需補 seeding 或改文案。

### 3.3 starter 模式（已有城鎮）

- 仍然預建：棋盤道路＋四色分區＋公共設施＋自動建築；`STARTER_TOWN` 數值不變（$6,500,000、warm-up 10 日、目標人口 120）。
- Round 3 rebalance（✅ 已實作於 `starter-town.ts`）：
  - 公共設施 **9 項**（新增醫院）：發電廠、水務、警署、消防局、學校、公園、巴士總站、港鐵站、醫院；
  - 自動建築 **30 棟**：公共屋邨×2、唐樓×4、劏房×2、便利店×3、茶餐廳×3、街市、超市、商廈、貨倉×2、進口商行、食品廠、工廈×2、**農田×7**；
  - 倉庫起始庫存：**食品 520、日用品 180**；街市／超市／便利店起始 食品 80、日用品 50；
  - 商業／工業分區加大、農田分區目標 ≥48 格（避免新手缺糧、失業）。

---

## 4. 相機與渲染（✅ 已實作）

| 項目 | 值／行為 |
|---|---|
| 相機 FOV | 46° |
| 最近距離 `MIN_DISTANCE` | 16 |
| 最遠距離 `MAX_DISTANCE` | **260 × MAP_SCALE ≈ 823**（96 版約 260） |
| far plane | 600 × MAP_SCALE ≈ **1,900** |
| 初始距離 | 桌面 90；手機 110（俯角 0.9） |
| `fitMap()`（O） | 目標置中、距離 = MAX×0.92≈**757**、pitch 1.12–1.32、yaw −45° |
| `focusTile(x,y)` | minimap 點擊／P 市中心；距離夾到 ≤90、pitch ≥0.78 |
| 霧／天空 | `world-utils.fogRange()` 用 `scale=MAP_SCALE` 換算，保持視覺密度 |
| 陰影 | `sunLight.shadow.camera.far` 已加大至 420；lit 模式仍受效能限制 |
| 裝飾密度 | 逐格機率 ×`deco`（≈1/(kx·ky)），全圖總數與 96 版相若 |

**效能（Lead 實測，供 QA 對照）**

| 場景 | 三角形 | Draw calls | 備註 |
|---|---|---|---|
| terrain（304） | **588k**（優化前 3.43M） | — | 地形合併＋LOD／密度歸一 |
| empty overview（O 全圖） | **495k** | **37** | 完全空地圖拉遠 |
| starter（正常遊玩） | **≈705k** | **444–454** | 預建城市＋道路＋建築 |
| sim 正常幀 | — | — | 平均 **≈0.23ms**（304 starter、573 人） |
| 首次 worldgen | — | — | **1.5–2 秒**（index.html boot screen「正在生成 304×304 香港地圖…」） |

---

## 5. Minimap 導航（✅ 已實作）

| 項目 | 規格 |
|---|---|
| 位置 | 桌面：畫布**右下角**浮動；手機：**132px** 小地圖，預設**收起** |
| 畫布 | 304×304（canvas 內部解析度 = 地圖格數），顯示水域／陸地、道路、四色分區、建築點、spawn（粉紅點）、鏡頭視野框（青色） |
| 快取 | 地形底色用 offscreen canvas，只在 seed／尺寸變更時重建；每 **250ms** 或狀態變更才重畫（避免每幀掃 92,416 格） |
| 點擊／拖曳 | 轉算格座標 → `actions.focusTile(tx, ty)`；拖曳節流 80ms |
| 按鈕 | **全圖**（`actions.fitMap()`，快捷 O）、**市中心**（`focusTile(spawn)`，快捷 P）、**分區**（`actions.toggleZones()`，快捷 L） |
| 摺疊 | 標題列 chevron；收起後只留標題／比例；`hud.is-interior` 與開局畫面時隱藏 |
| 視野框 | 由 `city-view.getCameraInfo()`（cx/cy/radius/aspect）計算；無資料時只畫地圖內容 |
| 比例字 | 顯示「304×304」，title 顯示「92,416 格」 |

> 快捷鍵以實作為準：**O = 全圖、P = 市中心、L = 分區色塊開關**（見 §9 不一致清單）。

---

## 6. 存檔 v4：精簡格式（✅ 已實作）

- `GAME_VERSION=4`；localStorage key 前綴 `victoria-harbour.save.`；slot 0 自動＋slot 1–3 手動。
- **格式**：`{ format:'hk-city-compact', version:4, seed, width:304, height:304, gameMode, tileEdits:number[], info:{slot,cityName,population,treasury,dateLabel,savedAt}, state: Omit<GameState,'tiles'> }`
- **稀疏格編碼**：只序列化有道路／行人路／分區的格；`packed = road|sidewalk<<1|zoneCode<<2`（zone 0=null／1 住／2 商／3 工／4 農），`tileEdits = [tileIndex, packed, ...]` 成對。
- **還原**：用 `seed` 重新 `generateWorld(seed, 304, 304, { starterRoads: gameMode==='starter' })` → 套用 sparse edits → 重建所有 `tile.buildingId`（由 buildings 反推）→ 補回 `spawn`／`gameMode`。
- **大小**：約 **80–140KB**（視道路／分區數量）；完整 92,416 格 JSON 會超過 localStorage 配額，故不可行。
- **兼容性**：只接受 304×304；96×96 舊存檔／匯入會拒絕（提示重新開局）。`version > GAME_VERSION` 只警告並嘗試載入。
- **存檔列表**：用 `info` 快照（城市名／人口／庫房／日期），**不重新生成 304×304 地形**，避免開面板時卡 1–2 秒。
- 📌 注意：`tileEdits` 只記 road／sidewalk／zone；**地形不會被玩家改變**（v3 未有填海工具），所以重新生成安全；日後若加地形改造，需要把地形變更也納入 sparse diff。

---

## 7. AUTO_DEVELOP 與分區 pipeline 縮放（✅ config；⚠️ 部分註解未同步）

| 常數 | Round 2（96） | Round 3（304） |
|---|---|---|
| `maxBuildingsPerZonePerDay` | 2 | **6** |
| `maxBuildingsPerDay` | 5 | **15** |
| `maxAutoBuildings` | 420 | **1,200** |
| `minDemand`／`overSupplyDemand` | 0.12／−0.35 | 不變 |
| `abandonDays` | 8 | 不變 |
| devScore 權重 | 不變 | 不變 |

- 分區需求 pipeline 以 **`AREA_SCALE = MAP_SCALE² ≈ 10.03`** 放大（`sim/zoning.ts`）：已劃未開發格數的「過度供應」門檻乘 10，避免 304 地圖正常大小的分區被誤判為過度劃區。
- 實際開發用**內部較低門檻 0.05**＋「某區 0 棟而需求為正」bootstrap；`AUTO_DEVELOP.minDemand=0.12` 主要作 UI 提示／顯示。
- 需求平滑：每日向目標值收斂 45%；需求下限 −0.6（避免死鎖）。
- 每區候選地塊上限 4,000、每建築最多試 50 個 anchor（避免 304 地圖一次掃幾萬格）。
- 📌 `sim/zoning.ts` 的檔頭註解仍寫「每日每區 2、全城 5、上限 420」及「需求 >0.45 每區 2 座」——與 config 新值不符；以 config 為準，建議 systems-dev 更新註解。

---

## 8. 載入、效能與已知限制

| 項目 | 內容 |
|---|---|
| 首次載入 | index.html boot screen：「正在生成 304×304 香港地圖（約 92,000 格）……」；worldgen **1.5–2 秒**，完成後 fade out |
| 存檔面板 | 用 `info` 快照，不重建地形（避免 1–2 秒卡頓） |
| 地圖拉伸 | 地理特徵按 96 設計座標等比例放大，維港／河流比真實比例闊；視覺可接受，但玩家會覺得「海很闊」 |
| empty 無隧道 | empty 模式沒有預置過海隧道（屬人造構築物），初期不能駕車過海；市民可搭渡輪／港鐵（站點需玩家建） |
| 舊存檔 | 96×96 v2 存檔不兼容，載入／匯入會明確提示 |
| 手機效能 | minimap 132px 預設收起；pixelRatio 上限 1.75；liteMode 自動降質 |
| 自動建築上限 1,200 | 實測高密度城市約 152 棟；上限預留擴充，不會即時觸頂 |

---

## 9. 文件 vs 程式碼不一致／待辦（給 Lead）

| # | 項目 | 文件現況 | 程式碼現況 | 建議 |
|---|---|---|---|---|
| 1 | **empty 5 名市民** | 文件／UI 文案寫 5 名 | `createGameState('empty')` 的 `citizens=[]`，未見初始 seeding | new-game 補 5 名初始市民（或改文案） |
| 2 | **分區快捷鍵** | 舊文件寫 Z/X/C/V、G overlay、B dezone | 實作：**Z 住、C 商、V 工、N 農、M dezone、X 拆除、L overlay、O 全圖、P 市中心、B 建造面板、G/J 統計** | UI_SPEC／GDD 已按實作更新（見 §10） |
| 3 | **zoning.ts 檔頭註解** | — | 仍寫 2／5／420、0.45 門檻 | systems-dev 更新註解（config 已是 6／15／1,200） |
| 4 | **需求公式** | `ZONING_GAMEPLAY.md` §3.2 為設計建議公式 | `sim/zoning.ts` 有另一套實作（職位／存糧／pipeline、內部 0.05 門檻、平滑 45%） | 文件已標「建議公式」；實作以 `zoning.ts` 為準，必要時同步文件 |
| 5 | **minimap 狀態** | UI_SPEC 說「跟 `ui.showZones`」 | minimap 無自己的 UIState flag；用 runtime + `showZones` | 文件已按實作寫（不需要新 state） |
| 6 | **相機 far/zoom** | GDD 舊版寫距離 14–170 | `MIN_DISTANCE=16`、`MAX_DISTANCE=260×MAP_SCALE≈823`、far≈1,900 | 文件已更新 |

---

## 10. 文件更新索引（第三輪）

| 文件 | 已更新章節 |
|---|---|
| `GAME_DESIGN_HK.md` | §0.2 地圖／開局摘要；§1.3–1.5 完全空地 empty；§2.1 304 尺度；§2.2 設計座標註記；§2.4 隧道／spawn 換算；§3.4 開發速率；§10.2 minimap 版面；§12 存檔 v4；§13.2–13.4 AUTO_DEVELOP／預期；§15 契約；§16 分工；§17 DoD；附錄 A/C/D |
| `UI_SPEC_HK.md` | §5 版面（minimap）；§5.1 minimap 元件；§5.2 相機 zoom out；§7.6 開局畫面 304 badge／empty 文案；§13 存檔 v4；§16 手機 minimap；§21 驗收；附錄 A 快捷鍵（O/P/L/Z/C/V/N/M/X） |
| `ZONING_GAMEPLAY.md` | §0 摘要；§1.3 完全空地；§3 需求 pipeline ×AREA_SCALE；§5.2 每日 15／每區 6／1,200；§7 starter rebalance；§8 10 分鐘流程加 minimap；§9 分工（minimap／save v4／empty seeding）；§11 DoD |
| 本文件 | 以上全部技術對照 |

---

*文件結束。數值以 `src/core/config.ts` 為最終依據；效能數字為 Lead 於 304 starter（573 人）實測。*
