# 《維港之城》Round 5 規格：巴士／小巴路線管理（ROUND5_TRANSIT_LINES.md）

> 文件版本：1.0（2026-10-24）｜撰寫：game-designer
> 專案：`hk-city/`｜用途：Round 5 新增「巴士／小巴路線」玩法規格；供 Lead／transport-dev／systems-dev／ui-dev／citizen-dev 實作。
> 依據：`src/sim/transit.ts`（現有 4 模式覆蓋、`TRANSIT_MODES`、`AVG_WAIT_MINUTES`、`CONCESSION_RATIO=0.9`、`WEEKDAY_PARTICIPATION=0.72`、`TRIPS_PER_COMMUTER=2.1`、`MIN_CAPACITY_COVERAGE_DISCOUNT=0.6`）、`src/ui/transit-panel.ts`（交通面板現有 4 模式概況）、`src/core/config.ts`（`TRANSIT_INFO`／`TRANSIT_SPEED`／`busTerminus` 半徑 10、capacity 500、fare $5）、`docs/GAME_DESIGN_HK.md`、`docs/ROUND5_UTILITIES.md`。
> 標記：**MVP**｜**P2**｜**設計值**。

---

## 1. 設計目標

1. **路線是玩家畫的**：不再只是「建一個巴士總站就有覆蓋」；玩家要選站點、定線、定班次／車數／票價。
2. **香港特色**：專營巴士（雙層、固定路線、八達通）／綠色專線小巴（固定路線、16–19 座）／紅色小巴（彈性路線、可加價）；過海隧道線有隧道費。
3. **與現有系統共存**：現有 4 模式（港鐵／巴士／電車／渡輪）的「站點半徑＋capacity」仍然有效；新路線在此之上提供**額外容量、較少候車、車費收入與擠迫管理**。MVP 不做雙重計算。
4. **可解釋**：每條線的乘客、收入、成本、等候時間、擠迫率都能在面板看到；錯誤狀態要講原因。

---

## 2. 新增站點建築（MVP）

| key | 名稱 | 尺寸 | 造價 | 維護/月 | 工人 | 解鎖 | 功能 |
|---|---|---|---|---|---|---|---|
| `busStop` | 巴士站 | 1×1 | $60,000 | $400 | 0 | 30 | 巴士路線停站；無獨立覆蓋（併入路線） |
| `minibusStop` | 小巴站 | 1×1 | $35,000 | $250 | 0 | 25 | 小巴路線停站 |
| `minibusTerminus` | 小巴總站 | 2×2 | $280,000 | $2,000 | 2 | 40 | 小巴路線起訖；capacity 120；另有小量覆蓋 r4 |
| `busTerminus`（現有） | 巴士總站 | 2×2 | $1,300,000 | $12,000 | 10 | 80 | 巴士路線起訖；capacity 500、r10（現有覆蓋照舊） |

- 站點要臨路（`needsRoad:true`）；總站另需 2×2 空地。
- `BusStop`／`MinibusStop` 是 **building def**（可入室內：站牌＋候車亭），唔佔用現有 32 種的模型？→ 新增 3 個 key（32→35，另有管網／機場碼頭建築，最終 key 數由 Lead 定）。
- 站點本身**唔產生被動收入**；收入來自路線（見 §4）。
- 現有 `busTerminus` 的 generic 覆蓋保留；當玩家建立路線後，`bus` 模式的 capacity 由「總站 capacity＋路線車隊 capacity」合併，避免重複。

---

## 3. 路線資料模型（MVP）

```ts
export type LineMode = 'bus' | 'minibus';
export type MinibusKind = 'green' | 'red';
export type VehicleType = 'doubleDecker' | 'minibus19';

export interface TransitLineStop {
  /** 站點 building id */
  buildingId: number;
  /** 順序（0 起） */
  order: number;
}

export interface TransitLine {
  id: number;
  mode: LineMode;
  /** 綠 Van／紅 Van；巴士固定 'green' */
  kind: MinibusKind;
  name: string;            // 「1A 中環—銅鑼灣」／「44A 上水—屯門」
  color: string;           // 霓虹色；UI 路線帶
  stops: number[];         // building id 順序（2–12 個）
  loop: boolean;           // 循環線（終點＝起點）
  vehicles: number;        // 車數（1–20）
  vehicleType: VehicleType;
  fare: number;            // 每程車費 $（巴士 4–9、小巴 3–8）
  active: boolean;         // 停駛／營運
  // 每日結算（runtime；可存檔但可重算）
  ridership: number;
  revenueToday: number;
  costToday: number;
  profitToday: number;
  waitMinutes: number;
  loadFactor: number;      // 載客率 0..1+
  lastDay: number;
}
```

- `stops` 只存 building id；名字在 UI 由建築 key＋位置生成（「中環．巴士站」）。
- 路線「雙向」：MVP 預設雙向（去程及回程同一站序），`loop=true` 則循環；P2 可逐方向設定。
- 路線顏色：8 色霓虹 palette（`#ff3d7f`／`#24e0ff`／`#ffd166`／`#a45bff`／`#5cff9d`／`#ff7a3d`／`#4fa3c9`／`#e060a0`）。
- 命名：自動「{路線編號} {起站}—{終站}」，玩家可改；路線編號由玩家輸入（1A、5B、44A…），重複要提示。

### 3.1 路線有效條件（建立時檢查，錯誤要有原因）

| 檢查 | 條件 | 錯誤文案 |
|---|---|---|
| 站點數量 | ≥ 2 站（循環線 ≥3） | 「最少要 2 個站」 |
| 站點模式 | 全部係同模式站點（巴士站／巴士總站／小巴站／小巴總站） | 「呢個站唔啱呢條線」 |
| 重複站 | 同一站不可重複（循環線起終點除外） | 「站點重複」 |
| 道路連通 | 連續兩站之間有道路連通（BFS） | 「兩站之間冇道路連通」 |
| 車數 | 1–20 | 「車數超出上限」 |
| 票價 | 巴士 $3–$10、小巴 $2–$9 | 「票價超出範圍」 |
| 過海 | 站點跨越維港兩岸 → 需隧道可達 | 「過海路線要經隧道／渡輪」 |

---

## 4. 營運經濟與班次（MVP）

### 4.1 班次與容量

```
serviceSpanMinutes = 18 × 60 = 1080       // 06:00–24:00
roundTripMinutes   = max(20, 2 × 站距總和 × 4.0 + 站數 × 1.2)
tripsPerVehicle    = floor(serviceSpanMinutes / roundTripMinutes)
fleetCapacity      = vehicles × tripsPerVehicle × vehicleSeats
  vehicleSeats = 130（雙層巴士）／19（小巴）
headwayMinutes     = roundTripMinutes / max(1, vehicles)   // 雙向
waitMinutes        = clamp(headwayMinutes / 2, 2, 40)
loadFactor         = ridership / max(1, fleetCapacity)
```

- 等候時間納入市民模式選擇（取代/調整 `AVG_WAIT_MINUTES.bus`）；班次太疏 → 市民會改用港鐵／步行。
- 載客率 > 1 → 擠迫：乘客滿意度下降、路線收入仍以實際載客（capacity）封頂。

### 4.2 乘客需求（MVP）

```
lineServedResidents = Σ(stop 半徑內住宅人口，站點半徑 = 3 格)
lineServedJobs      = Σ(stop 半徑內職位，半徑 = 3 格)
capture             = 0.45（普通線）／0.60（過海／特快，P2）
baseRiders          = min(lineServedResidents, lineServedJobs) × capture
                    × WEEKDAY_PARTICIPATION(0.72) × TRIPS_PER_COMMUTER(2.1)
demandFactor        = 1 + (營業日/假日修正) + 天氣修正（颱風 ×0.35）
ridership           = min(baseRiders × demandFactor, fleetCapacity × 1.1)
```

- 只在**兩端都有站點覆蓋**（住宅＋就業）時才有通勤客流；純住宅線客流低（可做接駁線，靠轉乘）。
- 市民實際選線：MVP 用「站點覆蓋 union」計入 `bus`／`minibus` 模式的覆蓋率；P2 才逐人選線。
- 紅 Van：`capture` 0.35、票價可自由調（每 +$1 → 客流 −8%）；彈性路線 P2。

### 4.3 收入與成本

```
revenue = ridership × fare × CONCESSION_RATIO(0.9)
cost    = vehicles × vehicleDailyCost + 過海隧道 toll × trips × vehicles
  vehicleDailyCost：雙層巴士 $1,200／日；小巴 $300／日（含司機燃油）
  tunnel toll：$150／程（過海線）；非過海線 0
profit  = revenue − cost
```

- 盈虧例子（平衡）：
  - 巴士線 4 站、vehicles=4、roundTrip=60min → trips/vehicle=18、fleet cap=9,360；客流 900 → revenue 900×$5×0.9=$4,050/日；cost 4×$1,200=$4,800/日 → **蝕 $750/日**（要加密客源或減車）。
  - vehicles=2 → fleet cap=4,680、客流 900 → revenue $4,050；cost $2,400 → **賺 $1,650/日**（但等候 15 分鐘、載客率高）。
  - 小巴線 vehicles=6、trips 30、cap=3,420；客流 260 → revenue 260×$4×0.9=$936；cost 6×$300=$1,800 → **蝕**；vehicles=3 → cost $900 → 賺 $36（小巴要靠高周轉）。
- 平衡目標：每條線每日利潤 −$1,500～+$6,000；玩家要靠「車數 vs 等候時間 vs 載客率」取捨。
- 收入計入 `finance.incomeBreakdown.fares`；成本計入新增 `ExpenseKind='transitOps'`（P2 或先入 `infrastructure`）。

### 4.4 與現有 transit.ts 的整合

- 現有 `tickTransit` 以站點半徑＋capacity 計 bus 模式 ridership；Round 5：
  - 若城市有 **active bus lines**：bus 模式 capacity = `Σ busTerminus capacity × 0.4`（最後一哩接駁）＋ `Σ line fleetCapacity × 0.6`；ridership 按比例分攤到線（MVP 用線需求總和歸一）。
  - 車費收入：線收入用 §4.3；generic 部分保留 `transit.faresThisMonth` 但**唔重複計**（由 systems 決定 split，文件建議 30/70）。
  - `TransitState.byMode.bus` 保持總數；新增 `lines` 統計見 §6。
- 站點半徑：巴士總站 r10 保留作「接駁覆蓋」；新巴士站／小巴站唔提供被動覆蓋，只供路線使用。

---

## 5. 操作流程與 UI wireframe

### 5.1 建線流程（MVP）

1. 交通面板（`T`）→「路線」tab →「新增路線」。
2. 選模式（巴士／綠色小巴／紅色小巴）＋輸入路線編號；自動命名可改。
3. 地圖進入「選站模式」：點擊合資格站點 → 加入順序；重複／模式不符即時 toast；**Undo**（Ctrl+Z 或面板按鈕）／清除。
4. 完成 → 檢查有效條件 → 設定車數／票價 → 確認建立。
5. 路線出現在列表＋地圖上有顏色虛線／站點光環；可改名、改車數／票價、停駛、刪線（二次確認）。
6. 刪線：車輛即時釋放；該線客流回到 generic bus 覆蓋（或消失）。

### 5.2 交通面板「路線」tab wireframe

```
┌──────────────────────────────────────────────────────────────┐
│ 交通 · 路線                                    [+ 新增路線]   │
├──────────────────────────────────────────────────────────────┤
│ 1A 中環—銅鑼灣   [巴士] 4 站  4 車  $5   載客 86%   +$1,650/日 │
│ ████████████████████████░░░░  顏色帶 #ff3d7f      [編輯][停駛] │
│ 44A 上水—屯門    [小巴] 6 站  3 車  $4   載客 42%   −$180/日  │
│ ████████░░░░░░░░░░░░░░░░░░░  顏色帶 #24e0ff      [編輯][停駛] │
├──────────────────────────────────────────────────────────────┤
│ 合計：路線 2 · 車隊 7 · 載客 1,240 人/日 · 收入 $5,900/日      │
│ [路線總覽] [站點列表] [營運報表]                              │
└──────────────────────────────────────────────────────────────┘
```

- 「編輯」打開建線流程（保留原路線 id）；「停駛」保留路線但 vehicles=0／active=false。
- 地圖上：選中路線高亮站點與虛線；hover 站點顯示「1A、44A」。
- P2：路線圖（拓撲圖）、時段班次、雙向不同站序、轉乘優惠。

### 5.3 錯誤狀態與文案

| 情況 | UI |
|---|---|
| 少於 2 站 | 完成按鈕 disabled＋「最少 2 個站」 |
| 重複站 | toast「呢個站已經喺路線入面」 |
| 模式不符 | toast「巴士線唔可以停小巴站」 |
| 無道路連通 | 完成時擋住＋「XX 站同 YY 站之間冇道路」 |
| 車數 0 | 「最少 1 架車」 |
| 票價超範圍 | 滑桿限制＋提示 |
| 路線蝕錢 | 列表紅字＋「考慮減車／加價／縮短路線」 |

### 5.4 快捷鍵（MVP）

`T` 交通面板；`N` 新增路線（面板內）；`Ctrl+Z` Undo 選站；`Esc` 取消建線；`Enter` 完成（≥2 站）；`Del` 刪除選中站（建線中）。

---

## 6. 市民選線與香港特色

- **市民選線**：MVP 沿用 `pickCommuteMode`；路線提供 `bus`／`minibus` 覆蓋加成（站點 union）與 `waitMinutes`；P2 才逐人比對 home／work 站點與路線。 
- **八達通**：票價收入已用 `CONCESSION_RATIO=0.9`（小童／長者優惠）；P2 加轉乘折扣。
- **綠 Van**：固定路線、固定票價、班次密；`capture` 較高、車輛成本低。
- **紅 Van**：可自訂票價（±$1 客流彈性）、路線可 P2 彈性；「亡命小巴」只作新聞文案（車速不模擬）。
- **過海線**：站點跨維港 → 需隧道道路連通；每程隧道費 $150；票價可 +$1–2；颱風/黑雨時班次減少。
- **專營巴士**：雙層 130 人；可設「特快線」（P2，停站少 → roundTrip 短、capture 高）。
- 路線顏色與霓虹港風一致；地圖上車輛按路線顏色行駛（P2；MVP 用既有巴士／小巴車輛視覺）。

---

## 7. 資料契約摘要（給 Lead）

| 項目 | 建議 | MVP？ |
|---|---|---|
| `BuildingDef.transit` 擴充 | `stopType?: 'stop'|'terminus'`；`vehicleCapacity?` | ✅ |
| 新 building key | `busStop`、`minibusStop`、`minibusTerminus` | ✅ |
| `TransitLine`／`TransitLineStop` types | 見 §3 | ✅ |
| `GameState.transitLines: TransitLine[]`、`nextLineId` | 路線資料 | ✅ |
| `GameState.ui`：`showTransit` 已有 | 加 `transitTab:'overview'|'lines'|'stops'`、`lineDraft`、`selectedLineId` | ✅ |
| `GameActions` | `openLineBuilder(mode)`、`addLineStop(buildingId)`、`undoLineStop()`、`finishLine(config)`、`cancelLineBuilder()`、`updateLine(id, patch)`、`deleteLine(id)`、`toggleLineActive(id)`、`setTransitTab(tab)` | ✅ |
| `TransitState` 擴充 | `linesRidership`、`linesRevenueToday`、`linesCostToday`、`linesProfitToday`、`routeCount` | ✅ |
| `GameStats` 擴充 | `busLines`、`minibusLines`、`lineRiders`、`lineRevenue`、`lineOpex`、`avgLineLoad` | ✅ |
| `ExpenseKind` | 加 `transitOps`（P2；MVP 可入 `infrastructure`） | P2 |
| Save v6 | `transitLines`、`nextLineId` 入 state | ✅ |
| 紅 Van 彈性路線／雙向站序／轉乘／路線圖 | 進階路線編輯 | P2 |

---

## 8. 平衡與風險

| 風險 | 說明 | 對策 |
|---|---|---|
| 與現有 bus 覆蓋雙重計算 | 現有 `tickTransit` 已算 bus ridership | MVP 明確 split（見 §4.4）：有線時 generic 只佔 30–40%；避免收入翻倍 |
| 玩家亂畫長線 | 站距長 → roundTrip 長 → 班次疏、載客率低 | UI 顯示預計等候與盈虧；錯誤提示 |
| 路線太多 UI 爆炸 | 12 條以上列表長 | 摺疊、篩選（巴士／小巴）、搜尋 |
| 紅 Van 票價失控 | 票價高 → 客流跌 | 顯示需求彈性；P2 才做 |
| 存檔體積 | 路線資料細（< 2KB） | 直接存 JSON；save v6 |
| 效能 | 每線每日結算 O(線×站) | 每日一次；上限 30 條線 |

---

*文件結束。與 `ROUND5_UTILITIES.md`、`ROUND5_AIRPORT_PORT.md`、`GAME_DESIGN_HK.md`（Round 5 章節）、`UI_SPEC_HK.md`（交通面板／路線 UI）一併使用。*
