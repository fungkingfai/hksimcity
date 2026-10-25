# 《維港之城》Round 6 GitHub Issues 規格（ROUND6_ISSUES.md）

> 文件版本：1.0（2026-10-25）｜撰寫：game-designer
> 專案：`hk-city/`（GitHub：`fungkingfai/hksimcity`）｜用途：Round 6 四個玩法 issue（#4 深圳河邊境、#5 地下／地上鐵路、#6 內地糧食支援、#7 現有樓群真化）的玩法／資料契約／數值／驗收規格；另記錄 #1／#2／#3／#8 修復。
> 依據：GitHub issues #1–#8 內容；`src/core/types.ts`（`RailGrade`／`Tile.rail`／`Building.existing`／`RailNetworkSnapshot`／`MainlandState`／`BorderCrossingState`）、`src/core/config.ts`（`RAIL_INFO`／`RAIL_CONFIG`／`RAIL_TOOLS`／`BORDER_CONFIG`／`borderGate` 建築）、`src/sim/placement.ts`、`src/sim/trade.ts`、`src/world/worldgen.ts`、`src/world/hk-map-data-types.ts`、`src/core/save.ts`、`docs/ROUND5_*`、`docs/GAME_DESIGN_HK.md`、`docs/UI_SPEC_HK.md`。
> 標記：**MVP**｜**P2（可延後）**｜**設計值（可平衡調整）**｜**WIP（code 骨架已加、sim/UI 未實作）**。

---

## 0. Issue 狀態總表

| # | 標題 | 狀態 | 本文件 |
|---|---|---|---|
| 1 | 電車站不能在港島區域建立 | **已修（Lead）**：`placement.ts` 移除「只限港島」規則，任何貼路可建地都可建電車站 | §1.1 |
| 2 | 貨櫃碼頭不應只起在葵涌 | **已修（Lead）**：`requiredRegion='containerPort'` 移除；任何臨水＋貼路可建；葵涌區仍有吞吐加成（區外 ×0.9） | §1.2 |
| 3 | 香港島對面三條路通往大海 | **已修（Lead/world-dev）**：`worldgen.ts` 隧道只喺維港設計 y 48–64 且兩端都係陸地才鋪，唔會再把外海長水域當隧道 | §1.3 |
| 8 | 手機版無法開始遊戲 | **已修（Lead/ui-dev）**：開始畫面／手機版流程修復；QA 需在 iPhone 尺寸回歸 | §1.4 |
| 4 | 深圳河及道路連接 | **Round 6 規格（WIP）** | §3 |
| 5 | 港鐵地下／地上鐵路規劃 | **Round 6 規格（WIP）** | §2 |
| 6 | 內地公路／鐵路糧食支援 | **Round 6 規格（WIP）** | §4 |
| 7 | 已有城鎮樓群應為真正建築 | **Round 6 規格（WIP）** | §5 |

> **Code 現況（2026-10-25）**：`config.ts`／`types.ts` 已有 Round 6 型別與數值骨架（`RailGrade`、`Tile.rail`、`RAIL_INFO`、`RAIL_CONFIG`、`RAIL_TOOLS`、`BORDER_CONFIG`、`roadBorderGate`／`railBorderGate`、`MainlandState`、`RailNetworkSnapshot`、`Building.existing`）；`placement.ts`／`trade.ts`／`worldgen.ts` 已有 #1／#2／#3 修復；但 **rail sim/UI、border gate 放置、mainland 糧食結算、existing buildings 生成、save v7 尚未實作**。`hk-map-data.generated.ts` 仍係 Round 5 版本，未含 `landuse`／`roadHint`／`borderCrossings`／`shenzhenRiver`（型別已預留）。

---

## 1. 已修 Issues（記錄）

### 1.1 #1 電車站限制
- 舊：`specialPlacementRule` 只准 `region === 'hongKongIsland'` 建 `tramStop`。
- 新：移除該限制；電車站只需臨路、可建地、符合一般放置規則。
- 影響：電車可在九龍／新界（如玩家想擴展）；不影響原有港島電車覆蓋公式。
- 驗收：在杏花邨、觀塘、沙田各建一個電車站，均成功；電車覆蓋率正常。

### 1.2 #2 貨櫃碼頭只限葵涌
- 舊：`containerPort`／`portGate`／`portYard` 有 `requiredRegion:'containerPort'`，只可在葵涌。
- 新：移除 requiredRegion；任何**臨水＋貼路**可建；葵涌真實碼頭區仍有吞吐加成；區外 `TRADE_CONFIG.port.offRegionPenalty=0.9`（= -10%）。
- 影響：玩家可在維港兩岸／其他港口建碼頭；葵涌仍是效率最高選址（真實地理優勢）。
- 驗收：在葵涌以外（例如屯門／將軍澳）臨水建 containerPort＋閘口＋堆場 → 可運作、吞吐 ×0.9；葵涌 ×1.0。

### 1.3 #3 三條路通往大海
- 舊：`buildStarterRoads` 掃描整條 column 的水域，最長一段就當「海峽」鋪隧道，導致外海出現三條路。
- 新：只喺設計 y 48–64（維港）搜尋，且要求隧道兩端都係非水地、長度 3–60 格；唔符合就唔鋪。
- 影響：唔會再有「三條路通往南中國海」；維港隧道仍可正常生成（紅／西／東隧）。
- 驗收：starter 全圖截圖——三條隧道只跨維港，南面外海冇路；市民仍可過海。

### 1.4 #8 手機版無法開始遊戲
- 已由 Lead／ui-dev 修（開始畫面 CTA／手機版流程）。
- QA 驗收：iPhone 13（Playwright）／Android 細屏：可揀「已有城鎮／由零開始」、開始遊戲、入場、開面板；冇 console error。
- 文檔：`UI_SPEC_HK.md` §16／§21 已列手機開局回歸。

---

## 2. Issue #5：港鐵地下／地上鐵路規劃（WIP）

### 2.1 設計目標

1. 玩家可以自己**規劃鐵路走線**（地面／高架／地下三種 grade），唔再只係「起一個 mtrStation 就有覆蓋」。
2. 鐵路要**接駁成網**：至少 2 個站連通才有正常效益；孤立站覆蓋 ×0.35。
3. **地下層（U）** 要顯示地下鐵路；地面／高架有不同視覺（軌道／橋墩），可跨海／穿山。
4. 與現有 `mtrStation`／`transit`（港鐵覆蓋）／巴士小巴路線／颱風／save v7 整合。

### 2.2 三種鐵路 Grade（✅ 數值已在 `config.ts`）

| Grade | 名稱 | 每格造價 | 每格維護/月 | 可跨水 | 視覺 |
|---|---|---|---|---|---|
| `surface` | 地面鐵路 | **$18,000** | $2.2 | ❌ | 地面道碴＋雙軌；沿地勢起伏 |
| `elevated` | 高架鐵路 | **$65,000** | $5.5 | ✅ | 高架橋面＋橋墩；可跨海／跨谷 |
| `underground` | 地下鐵路 | **$42,000** | $3.8 | ✅ | 只喺地下層（U）顯示；地面見通風井／出口 |

- `RAIL_TOOLS = ['rail:surface','rail:elevated','rail:underground','rail:remove']`。
- 最長一次過鋪設 **80 格**（`RAIL_CONFIG.maxPlanLength`）；可分段鋪。
- 拆除：`rail:remove`，退款 30%；可選 grade，只拆對應 grade。

### 2.3 鋪設與接駁規則（MVP）

| 規則 | 內容 |
|---|---|
| 可鋪地形 | 可建地（grass／urban／reclaimed／fertile／forest／hill）＋道路格；`surface` 不可鋪水域／山地；`elevated`／`underground` 可跨水域／山地 |
| 不可鋪 | 建築 footprint 內（地面／高架）；地下可在建築下方穿過（唔影響 building） |
| 道路關係 | MVP：rail 唔可以與 road 同格（避免平交道口）；高架可跨過 road（唔同格） |
| 車站接駁 | `mtrStation`（`railStation:true`）footprint **正交外側**有同 grade 或任何 rail 格 → 已接駁；站與站之間要有連續 rail 連通 |
| 網絡 | 每日一次 BFS：rail 格＋已接駁車站 → 連通分量；分量內 ≥2 個站＝有效鐵路網 |
| 過海 | `elevated`／`underground` 可跨維港；`surface` 不可以；跨海隧道要連續 grading |
| 邊境鐵路 | 可連到 `railBorderGate`（見 §3），把內地鐵路接入網絡（P2） |

- **MVP 簡化**：唔做坡度、轉彎半徑、列車班次表；以「rail 格網絡」為單位。
- **P2**：地面／高架轉乘站、列車擁塞、號誌、平交道口。

### 2.4 鐵路網計算與營運（MVP）

```
每日 tickRail(state)：
  1. 掃描全部 Tile.rail（grade）＋ railStation building → BFS（4 鄰接）
  2. 每個連通分量：stations、tiles、gradeCounts
  3. connectedStations = 分量內 ≥2 站的車站總數
  4. isolatedStations = stations - connectedStations
  5. 總長 totalLength = Σ rail tile（所有 grade）
  6. upkeep = Σ(grade tile × RAIL_INFO.upkeep) + stations × RAIL_CONFIG.stationUpkeep
              + Σ mtrStation building upkeep（已有 totalUpkeep）
  7. ridership = (connectedStations × 220 + totalLength × 2.5) × demandFactor × weatherFactor
       demandFactor = clamp(在職人口 / 600, 0.5, 1.4)
       weatherFactor = 1（晴）／0.9（雨）／surface 0（8 號）／elevated 0.5／underground 0.9
  8. revenue = ridership × RAIL_CONFIG.farePerRide(8) × CONCESSION_RATIO(0.9)
  9. mtr 覆蓋率：以 connectedStations 計；isolated 站半徑覆蓋 ×0.35
```

- **與現有 transit.ts 整合**：`computeTransitCoverage` 的 mtr 模式：
  - 有 rail network（connectedStations ≥2）→ mtr 容量／覆蓋用 connectedStations；isolated 站只按 `isolatedStationCoverage=0.35` 折減。
  - 冇 rail network（玩家未鋪軌）→ 保持現狀（mtrStation 半徑運作），避免舊存檔／新手即刻失效；**新局 starter 預設有軌**（見下）。
- **票價**：`farePerRide=8`，併入 `finance.incomeBreakdown.fares`；`transit.byMode.mtr` 加上鐵路 ridership。
- **颱風**：8 號風球 surface 停駛、elevated 50%、underground 90%；黑雨 elevated 80%、surface 60%。
- **轉乘**：P2；MVP 只計「同站接駁」：mtrStation 附近 4 格內有 busStop／minibusStop → 該站 ridership +10%。

### 2.5 地下層（U）與視覺

- `U` 鍵切換地下層：現有 pipe 圖層加 **rail** 圖層；`underground` rail 只在地下層顯示，地面顯示出口／通風井（低調）。
- `surface` rail：地面雙軌＋訊號燈；`elevated`：高架橋面＋橋墩（可跨海）。
- 列車：`VehicleKind='mtr'` 沿 rail 行走（視覺）；MVP 可用現有 mtr 車輛路徑近似，P2 才做逐列車。
- 地下層 UI：
  - 左側圖例：地面（灰）／高架（白）／地下（金）／未接駁站（紅圈）；
  - hover rail 格：grade、連通分量、每日乘客、維護；
  - 鐵路網面板：connected／isolated stations、total length、gradeCounts、ridership、upkeep。

### 2.6 UI 流程（MVP）

1. 建造面板 →「交通」分類 → 新增「**鐵路**」區塊：三個 grade 按鈕＋拆除。
2. 選 grade → 地圖拖曳鋪軌（最長 80 格）；成本即時預覽；放開完成。
3. 車站（`mtrStation`）要貼近 rail（正交外側）；放置時若 4 鄰無 rail → 提示「車站未接駁鐵路（覆蓋 ×0.35）」。
4. 交通面板加「**鐵路**」tab：網絡長度、connected／isolated stations、grade breakdown、每日乘客、維護費、每月盈虧。
5. `U` 地下層可睇 underground rail；地面／高架正常顯示。
6. 拆除：`rail:remove` 拖曳；拆站後網絡即時重算。

**Wireframe（交通面板鐵路 tab）**

```
┌────────────────────────────────────────────┐
│ 港鐵鐵路網                      [鋪軌]      │
│ 總長 48 格 · 車站 6（接駁 5／孤立 1）        │
│ 地面 22 / 高架 10 / 地下 16                 │
│ 每日乘客 2,640 · 車費收入 $19,008/日        │
│ 每月維護 $1,540（軌）＋$48,000（站）        │
│ 8 號風球：地面停駛、高架 50%、地下 90%      │
└────────────────────────────────────────────┘
```

### 2.7 資料契約（#5）

| 項目 | 建議 | 狀態 |
|---|---|---|
| `Tile.rail?: RailGrade` | 軌道 grade；`undefined`＝冇軌 | ✅ 已加 |
| `GameState.railNetwork?: RailNetworkSnapshot` | 每日快照（gradeCounts／components／connected／isolated／ridership／upkeep） | ✅ 型別已加，sim 未做 |
| `BuildingDef.railStation?: boolean` | mtrStation=true | ✅ 已加 |
| `GameActions` | `setTool('rail:surface'|'rail:elevated'|'rail:underground'|'rail:remove')`；`toggleUnderground()`（U）；`openRailPanel()`／`setTransitTab('rail')` | 待加 |
| `UIState` | 加 `showRailPanel?: boolean`、`railPlanGrade?: RailGrade`；`showUnderground` 已有 | 待加 |
| `GameStats` | `railStations?`、`railLength?`（已加）；建議加 `railRidership`、`railUpkeep` | 部分已加 |
| `sim/rail.ts`（新） | `tickRail(state)`／`computeRailNetwork(state)`；由 `simulation.ts` 每日呼叫 | 待做 |
| Save v7 | `railEdits:[index,gradeCode,...]`（0 無、1 surface、2 elevated、3 underground）；舊 v6 拒絕 | 待做 |
| `mtrStation` 建築 | `transit.radius=14`、capacity=900、fare=8 保留作無軌 fallback | ✅ |

### 2.8 MVP／P2

- **MVP**：三 grade 工具、成本、rail 格、BFS 網絡、站接駁、connected／isolated、ridership／fare／upkeep、U 圖層、鐵路 tab、save v7。
- **P2**：平交道口／轉彎限制、列車班次與擠迫、號誌、跨站轉乘優惠、高架站／地下站模型分流、邊境鐵路直通車。

---

## 3. Issue #4：深圳河與邊境通道（WIP）

### 3.1 地理與地圖位置

- 香港北面以**深圳河**為界；深圳河由西（深圳灣）向東（羅湖／文錦渡／沙頭角）流，北岸是深圳。
- 600×600、112m/tile 下（實測換算，設計座標 = 96 制）：

| 通道 | 類型 | 600 格座標（約） | 設計座標（96） | 備註 |
|---|---|---|---|---|
| **羅湖** | 鐵路 | tile (282,130) | (44.7, 20.4) | 東鐵綫過境；railBorderGate |
| **落馬洲** | 道路（＋P2 鐵路） | tile (241,155) | (38.1, 24.4) | 落馬洲支線／管制站 |
| **文錦渡** | 道路 | tile (291,127) | (46.1, 19.9) | 貨車口岸 |
| **深圳灣** | 道路 | tile (128,153) | (20.1, 24.1) | 西部通道 |
| **沙頭角** | 道路（P2） | tile (371,113) | (58.9, 17.7) | 可延後 |
| 深圳河中心 | 水域 | tile ≈ (289,138) | ≈ (45.8, 21.7) | 河寬 2–4 格（設計） |

- 世界生成：北面邊界加**深圳河**水域帶＋北岸深圳城市遠景（render-only，玩家不可進入／不可建）。
- 玩家不可穿過深圳河：除咗邊境口岸外，road／rail 都不能跨河；`surface` rail 不可跨河，`elevated`／`underground` 可（邊境鐵路 P2）。
- 地圖數據：`MapData.borderCrossings`（name／x／y／kind）＋`shenzhenRiver`（設計座標 ring）＋`landuse`／`roadHint`（見 §5）；`tools/build-hk-data.py` 要重生 600 版數據。
- **WIP 注意**：`hk-map-data.generated.ts` 目前未含呢兩個欄位；型別已預留（`hk-map-data-types.ts`），要 Lead/world-dev 用工具重生。

### 3.2 邊境口岸建築（✅ config 已有）

| key | 名稱 | 尺寸 | 造價 | 維護/月 | 工人 | 解鎖 | 接駁 | 食物支援 |
|---|---|---|---|---|---|---|---|---|
| `roadBorderGate` | 道路口岸 | 3×2 | **$8,000,000** | $60,000 | 40 | 300 | 4 鄰有 road 並連到市區路網 | **60 food/日** |
| `railBorderGate` | 鐵路口岸 | 3×2 | **$9,000,000** | $70,000 | 60 | 400 | 4 鄰有 rail 並接入鐵路網 | **120 food/日** |

- 放置限制（MVP）：必須在指定邊境通道 **`BORDER_CONFIG.placementRadius=5` 格內**、南岸（香港側）、可建地、臨路（`needsRoad:true`）；`railBorderGate` 另外要 4 鄰有 rail。
- 一個通道只可建一個同類口岸（MVP）；P2 可升級／多口岸。
- 接駁判定（`BORDER_CONFIG.linkRadius=1`）：
  - 道路口岸：4 鄰有 road，且 BFS 連到 spawn／市區路網；
  - 鐵路口岸：4 鄰有 rail，且屬 `railNetwork` 其中一個有 ≥1 mtrStation 的分量（P2 可放寬）。
- 未接駁 → `foodPerDay=0`，UI 紅字「口岸未接駁」。

### 3.3 北岸深圳視覺（MVP）

- 深圳河以北：非玩家可建區；render 用低細節深圳天際線（玻璃幕牆＋貨櫃場＋山），色調灰藍，與香港霓虹對比。
- 邊境檢查站模型：道路口岸＝檢查亭＋車龍閘口；鐵路口岸＝貨運場＋龍門吊＋軌道。
- 地圖 label：深圳河、羅湖、落馬洲、文錦渡、深圳灣（可加「深圳」label 在北岸）。
- minimap：深圳河以北用暗色（非可玩區）＋邊境點標記；hover 顯示口岸。

### 3.4 資料契約（#4）

| 項目 | 建議 | 狀態 |
|---|---|---|
| `BuildingDef.borderGate?: 'road'|'rail'` | 口岸種類 | ✅ 已加 |
| 新 building key | `roadBorderGate`／`railBorderGate`（3×2） | ✅ config 已加 |
| `MapData.borderCrossings` | `{name,x,y,kind}[]`（設計座標） | ✅ 型別已加，data 未生 |
| `MapData.shenzhenRiver` | 河流 ring（設計座標）＋北岸 | ✅ 型別已加，data 未生 |
| 放置規則 | `specialPlacementRule`：borderGate 必須喺對應 crossing 5 格內；railGate 要 rail 接駁 | 待做 |
| `GameActions` | 用現有 `setTool(buildingKey)`；新增 `openTradePanel('mainland')`（P2） | 部分 |
| `UIState` | `tradeTab:'airport'|'port'|'mainland'` | 待加 |
| Save v7 | 口岸係 Building，照 state 存；borderCrossings 由 map data 重生 | 待做 |
| 驗收 | 4 個通道各有正確口岸可建；未接駁 food=0；接駁後 food>0 | — |

### 3.5 MVP／P2

- **MVP**：深圳河＋北岸視覺、羅湖（rail）／落馬洲／文錦渡／深圳灣（road）4 個通道、兩種口岸建築、放置半徑、接駁判定。
- **P2**：沙頭角、深圳灣鐵路、口岸升級／排隊、跨境貨車龍、邊境 24 小時通關事件。

---

## 4. Issue #6：內地公路／鐵路糧食支援（WIP）

### 4.1 玩法定位

香港一直靠內地公路及鐵路供應糧食。Round 6 讓玩家選擇：
- **道路口岸**（較便宜、60 food/日、受邊境擠塞／天氣影響大）；
- **鐵路口岸**（較貴、120 food/日、較穩定、可配合鐵路網）；
- 兩者都補貼價（`BORDER_CONFIG.foodImportCost=0`），但**不可完全取代本地農業**：上限為全城每日糧食需求的 **40%**。

### 4.2 數值與公式（✅ `BORDER_CONFIG` 骨架）

```
localSupply  = 本地農田／食品廠每日產出（food）
demand       = 人口 × 0.5（FOOD_PER_CITIZEN_PER_DAY）
importCap    = demand × 0.40
rawImport    = roadLinks × 60 + railLinks × 120
importPerDay = min(rawImport, importCap)
  roadLinks = 已接駁道路口岸數；railLinks = 已接駁鐵路口岸數
```

- 食物入賬：`stats.foodStored += importPerDay`（或入倉庫 inventory；MVP 直接入全城庫存，避免物流瓶頸）；
- `stats.mainlandFoodPerDay = importPerDay`；`MainlandState.foodPerDay`；
- 進口成本 0（政府補貼）；維護費由口岸建築 upkeep 承擔（道路 $60k／鐵路 $70k/月）。
- 平衡：
  - 道路口岸 60/日 ≈ 120 人需求；2 個道路口岸 ≈ 240 人；
  - 鐵路口岸 120/日 ≈ 240 人；1 鐵路＋1 道路 ≈ 360 人；
  - 40% cap：人口 1,200 → demand 600/日 → 進口上限 240/日；仍需本地農業／食品廠提供 360/日。
  - 成本：$8–9M 造價＋$60–70k/月 → 對應節省農地（農田 $700/格）與食品廠維護；後期糧食安全保險。
- 天氣／事件：
  - 8 號風球／黑雨：道路口岸進口 ×0.5（貨車停駛），鐵路 ×0.9；
  - 邊境擠塞（P2）：道路口岸 ×0.6 一日，機率每日 2%；
  - 內地供應緊張（P2）：全口岸 ×0.8 一日，機率 1%。
- 與本地農業平衡：本地 farm 約 24 food/日；食品廠加工本地農產；進口主要補缺口，唔會令農業完全無用（40% cap＋進口成本／維護費）。

### 4.3 UI

- 貿易面板（`Y`）加「**內地**」tab／card：
  - 每日糧食支援、道路／鐵路口岸數、接駁狀態、佔需求百分比；
  - 每個口岸：名稱、位置、連接狀態、food/日、維護費；
  - 未接駁紅字「未接駁道路／鐵路」；
  - 天氣事件提示。
- 城事面板「食品」卡加「內地支援 +XX/日」；hover 顯示本地 vs 進口比例。
- 地圖：口岸建築有 badge；深圳河以北暗色＋北岸深圳天際線。

### 4.4 資料契約（#6）

| 項目 | 建議 | 狀態 |
|---|---|---|
| `BORDER_CONFIG` | `roadFoodPerDay=60`、`railFoodPerDay=120`、`foodImportCost=0`、`placementRadius=5`、`linkRadius=1` | ✅ 已加 |
| `MainlandState` | `roadLinks`／`railLinks`／`foodPerDay`／`lastImportDay`／`crossings[]` | ✅ 型別已加，sim 未做 |
| `BorderCrossingState` | name／kind／x／y／connected／buildingId／foodPerDay | ✅ 型別已加 |
| `GameStats.mainlandFoodPerDay?` | UI 顯示 | ✅ 已加 |
| `sim/mainland.ts`（新） | `tickMainland(state)`：掃 border gate、判定接駁、計 import cap、加 foodStored、寫 MainlandState | 待做 |
| `GameActions`／`UIState` | `openTradePanel('mainland')`；`tradeTab` | 待加 |
| Save v7 | `mainland` 快照入 state（可重算但存快照供 UI） | 待做 |

### 4.5 MVP／P2

- **MVP**：4 通道、2 種口岸、60／120 food/日、40% cap、天氣係數、貿易面板內地 tab。
- **P2**：邊境擠塞／供應緊張事件、口岸升級、貨車龍視覺、進口 goods／electronics。

---

## 5. Issue #7：已有城鎮現有樓群真正化（WIP）

### 5.1 問題與目標

- 現況：starter 只有 34 棟 auto＋10 設施；地圖上 ~4,089 座 density 樓群只係 render 裝飾，冇 `Building`、冇居民／職位、冇道路接駁，玩家覺得「假」。
- 目標：把 spawn 附近 **250–500 座** density 樓群變成真正 `Building`：
  - `existing:true`（新欄位，已加）、`zone` 合理、有人住／有人返工；
  - 道路由真實土地利用 `roadHint` 生成，並接入 starter 連通道路網；
  - render 的 faux density 樓群在已建格自動隱藏（`tile.buildingId>=0` 已有判定）；
  - **empty 模式完全不變**（0 建築）；
  - starter 人口／就業／收入重新平衡。

### 5.2 資料需求（WIP）

`MapData` 新增（型別已預留）：
- `landuse?: string`：土地利用 class 0..92（規劃署 LUHK 2020；600×600；base64）。
- `roadHint?: string`：每格 1 bit 道路 hint（landuse 41/42；base64；360,000 bits ≈ 45KB）。
- 用途：
  - roadHint=1 → worldgen/starter 生成「現有街道」；
  - landuse class → 決定 existing building 類型／zone（住宅／商業／工業／政府／鄉村）。
- **工具**：`tools/build-hk-data.py` 要加 600×600 re-gen（W/H/TILE_M 參數化）、讀土地利用＋道路網（OSM／規劃署），輸出 `landuse`／`roadHint`／`borderCrossings`／`shenzhenRiver`；原始數據授權見 `REAL_GEO_DATA.md`。
- **未生數據前**：MVP 可以用 density＋height＋`HK_REGIONS` 分類作 fallback（只住宅／商業／工業三類），roadHint 用 density 門檻＋道路網格近似；文件列明 fallback。

### 5.3 生成流程（MVP）

```
ensureStarterExistingBuildings(state):
  1. 中心 = state.spawn（中環 259,299）；半徑 120 格
  2. 掃描 Tile（density≥28 && buildingHeight≥4 && terrain 可建 && 冇 buildingId／road）
  3. 分數 = density×0.6 + min(height,200)/200×0.4；取前 250–400 格（cap 500）
  4. 聚類／抽樣：每 2×2 或 1×1 一個 building，避免重疊；優先近 spawn／近 roadHint
  5. 類型映射（height／density／region）：
       bh≥120 & density≥140 & skyline → officeTower（商業，jobs 80）
       bh≥60 → publicHousing（住宅，housing 40）／privateTower（P2）
       bh 25–60 → tongLau（住宅，housing 18）或 officeTower（商業 jobs 24）
       bh<25 → subdividedFlat（住宅 housing 8）／industrialBuilding（工業 jobs 20）
     landuse fallback：住宅→residential、商業→commercial、工業→industrial
  6. 道路：由 roadHint bit 生成道路（貼 existing building），未接駁就 BFS 連到最近 starter 道路
  7. 建立 Building { existing:true, zone, level:1–3, residents:[], workers:[], builtOnDay:0, inventory:{} }
  8. 設 tile.buildingId、tile.zone（可保留）
  9. 重新計算所有建築的 connected（貼路）
  10. 唔可以覆蓋 spawn 半徑 8 格內的 starter 設施／道路
```

- **道路**：`roadHint` 生成嘅道路要同 starter 既有道路同一連通分量；如果 roadHint 不足，用「每 3 格網格＋BFS」補；唔可以生成斷開路段（重用 Round 4 的 `connectedComponent` 思路）。
- **faux skyline**：render `terrain.ts` 的 density 樓群已有 `if (tile.road || tile.buildingId >= 0) continue`；existing building 設定 buildingId 後自動隱藏；`showcaseCity` 仍只 starter 顯示，empty 完全冇。
- **P2**：現有樓宇外觀用專門 existing 模型（舊唐樓／公屋）／可升級／重建。

### 5.4 人口／就業／收入平衡（建議值）

| 項目 | 現況（Round 5） | Round 6 建議 |
|---|---|---|
| 現有樓群 | 0 棟（只 render） | **250–400 棟**（hard cap 500） |
| 住宅 existing | — | 約 45%（110–180 棟），housing 8–40 |
| 商業 existing | — | 約 30%（75–120 棟），jobs 8–80 |
| 工業 existing | — | 約 25%（60–100 棟），jobs 10–40 |
| `STARTER_TOWN.targetPopulation` | 145 | **520（建議 450–650）**；warm-up 15 日 |
| starter 初始就業 | ~40–80 | **300–400**（現有商業／工業＋原有 34 棟） |
| 收入 | $6.5M 起 | 目標每月淨 +$0.3–1.0M；稅收（薪俸／利得／差餉）足以支撐 existing 維護 |
| 現有樓宇維護 | — | 全額 upkeep；如太重可乘 `existingUpkeepRatio=0.6`（設計值，economy-dev 調） |
| 可拆／可升級 | — | 可以拆（退款 0% 或 30%？建議 0% 顯示「現有樓宇」）；P2 可升級 |

- **注意**：現有樓宇太多會令 starter 太強／太逼；hard cap 500、只 spawn 半徑 120 格、只取 density≥28；`empty` 完全唔生成。
- **收入平衡**：如果 existing 全部入 `totalUpkeep`，每月 upkeep 可能 $2–5M；starter $6.5M 會好快破產 → 建議 `existingUpkeepRatio=0.6`，或只計 60% existing 入 upkeep；稅收亦要按實際就業計。**需 economy-dev 用模擬調**。

### 5.5 UI

- 選中 existing 建築：建築卡顯示 badge「**現有樓宇**」＋「現有 · 可拆卸／重建（P2 升級）」；`existing:true` 時分區工具唔可以覆蓋其 footprint。
- 地圖 hover：existing 建築用較淡 outline；拆除工具 hover 顯示「拆卸現有樓宇（不退款）」。
- 城事面板：顯示「現有樓宇 312 棟 · 居民 520 · 職位 380」。
- 開局畫面 starter 卡：「中環已發展區：312 棟現有樓宇」。
- empty 完全唔顯示現有樓宇。

### 5.6 效能與資料契約

| 項目 | 建議 |
|---|---|
| 上限 | 250–400 目標、hard cap **500**；只 spawn 半徑 120 格 |
| render | existing 建築用正常 building mesh；faux density 在 buildingId≥0 隱藏；遠景保持 density instanced |
| save | existing 建築隨 `state.buildings` 存（state 已含 buildings）；v7 唔需要額外 existing 陣列 |
| `Building.existing?: boolean` | ✅ 已加 |
| `STARTER_TOWN` | `targetPopulation` 145→**520**（建議）；warm-up 10→**15**（建議） |
| `BuildingDef.existing` | 唔需要；用現有 auto defs＋level |
| `GameActions` | 拆 existing 用現有 `demolish`；P2 `upgradeExisting(id)` |
| `UIState` | 唔需要新 flag（現有 selectedId／info-panel） |
| Save v7 | state.buildings 照存；existing 由 new-game 生成，不需另存 |

---

## 6. 共通資料契約摘要（Round 6）

| 類別 | 新增／修改 | MVP？ |
|---|---|---|
| `Tile` | `rail?: RailGrade`（已加）；`landuse`／`roadHint` 唔入 Tile（map data 生成時用） | ✅ |
| `GameState` | `railNetwork?`（已加）、`mainland?`（已加）；existing 建築在 `buildings` | ✅ |
| `Building` | `existing?: boolean`（已加） | ✅ |
| `BuildingDef` | `railStation?`、`borderGate?`（已加） | ✅ |
| 新 building key | `roadBorderGate`、`railBorderGate`（已加） | ✅ |
| `GameActions` | 加 `setTransitTab('rail')`／`openTradePanel('mainland')`／`toggleUnderground`（已有 U）；rail tool 用 `setTool('rail:*')` | 待加 |
| `UIState` | 加 `railPlanGrade?`、`tradeTab?`；`showUnderground` 已有 | 待加 |
| Save | **v7**：`railEdits`（index＋grade）＋原有 tileEdits／state；舊 v6 拒絕 | 待做 |
| CSS／UI | 鐵路 tab、鐵路工具卡、深圳河／口岸 label、existing badge、內地 tab | 待做 |

---

## 7. 驗收 Checklist（Round 6）

### 7.1 #5 鐵路
- [ ] 建造面板「交通 → 鐵路」有地面／高架／地下／拆除；拖曳最多 80 格；成本正確。
- [ ] 地面不可跨水；高架／地下可跨維港；地下只喺 U 層顯示。
- [ ] mtrStation 4 鄰有 rail 才接駁；connected／isolated 統計正確；孤立站覆蓋 ×0.35。
- [ ] 鐵路網長度、每日乘客、車費收入、維護費喺交通面板鐵路 tab 正確。
- [ ] 8 號風球：地面停駛、高架 50%、地下 90%；黑雨對應折減。
- [ ] Save v7 儲存 railEdits；讀檔後軌道／網絡重算一致；v6 舊檔拒絕。
- [ ] 無 rail 的舊存檔仍可用 mtrStation 半徑 fallback。

### 7.2 #4 深圳河／口岸
- [ ] 地圖北面有深圳河＋北岸深圳遠景；玩家不可建／穿越。
- [ ] 羅湖（鐵路）、落馬洲／文錦渡／深圳灣（道路）4 個通道；口岸只可在通道 5 格內建。
- [ ] 道路口岸需道路連通；鐵路口岸需 rail 連網；未接駁 food=0＋紅字。
- [ ] 口岸視覺／label／minimap 正確；北岸唔會誤生成可建地。

### 7.3 #6 內地糧食
- [ ] 道路口岸 60 food/日、鐵路口岸 120 food/日；接駁後 `stats.mainlandFoodPerDay` 正確。
- [ ] 進口上限 = 需求 ×40%；唔會完全取代本地農業。
- [ ] 8 號風球道路 ×0.5、鐵路 ×0.9；UI 顯示比例／事件。
- [ ] 貿易面板內地 tab；城事食品卡顯示本地＋進口。

### 7.4 #7 existing buildings
- [ ] starter spawn 半徑 120 內生成 250–400 棟 `existing:true` 真正 buildings，有道路接駁。
- [ ] faux density 樓群在 buildingId≥0 格隱藏；空曠格仍保留遠景。
- [ ] existing 居民／職位可運作；starter 人口約 520（建議）、就業 300–400、收支平衡。
- [ ] 可選中／拆卸 existing；UI badge「現有樓宇」；empty 模式完全冇 existing。
- [ ] 效能：starter 正常 60fps；hard cap 500。
- [ ] 道路由 roadHint 生成且與 starter 同一連通分量（唔可以斷開）。

### 7.5 已修 regressions
- [ ] 電車站可喺九龍／新界建（#1）；貨櫃碼頭可喺非葵涌臨水建、吞吐 ×0.9（#2）；南面外海冇三條路（#3）；手機可開始遊戲（#8）。

---

## 8. 風險與待辦

| 風險 | 說明 | 對策 |
|---|---|---|
| 數據未重生 | `borderCrossings`／`landuse`／`roadHint` 未喺 generated data；#4/#6/#7 部分要 fallback | Lead/world-dev 先重生 600 data；fallback 用 density＋height |
| Rail 同 mtr 覆蓋雙重計算 | `tickTransit` 用 mtrStation 半徑；`tickRail` 又計一次 | 有 rail network 時 mtr 覆蓋只用 connectedStations，isolated ×0.35；無 rail 保持 fallback |
| Existing 令 starter 爆人口／爆 upkeep | 250–400 棟 → 住宅／職位大增 | cap 500、target 450–650、existing upkeep ratio 0.6；economy-dev 調 |
| Existing 道路斷開 | roadHint 可能斷開 | 生成後 BFS 連到 starter 路網；不連通就補路 |
| 效能 | 500 existing buildings＋rail＋terrain 360k | 上限 500、instanced fade／LOD、rail 只用 tile 資料唔加 mesh 每個 |
| 深圳河資料版權／位置 | 河流 polygon／土地利用數據 | 用政府開放數據（規劃署 LUHK／地政總署）；授權見 `REAL_GEO_DATA.md` |
| 舊存檔 | v6 唔識 railEdits | Save v7；明確提示重新開局 |
| UI 容量 | 鐵路 tab、內地 tab、existing badge | 手機版簡化，tab 收納 |

---

*文件結束。與 `GAME_DESIGN_HK.md` §19、`UI_SPEC_HK.md` §23、`ROUND5_UTILITIES.md`、`ROUND5_TRANSIT_LINES.md`、`ROUND5_AIRPORT_PORT.md`、`REAL_GEO_DATA.md` 一併使用。*
