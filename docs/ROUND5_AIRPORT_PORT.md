# 《維港之城》Round 5 規格：機場與貨櫃碼頭（ROUND5_AIRPORT_PORT.md）

> 文件版本：1.0（2026-10-24）｜撰寫：game-designer
> 專案：`hk-city/`｜用途：Round 5 新增「機場／貨櫃碼頭」玩法規格；供 Lead／systems-dev／logistics-dev／transport-dev／ui-dev／economy-dev 實作。
> 依據：`src/core/config.ts`（`containerPort` 4×3、$8M、upkeep $80k、workers 30、goods 45/day、`ploppable`、需臨水；機場真實位置/雙跑道在 `HK_REGIONS` visual）、`src/sim/logistics.ts`（貨物進出口尚未有正式出口收入）、`src/core/types.ts`（`Building`／`GameState`）、`docs/REAL_GEO_DATA.md`、`docs/ROUND5_TRANSIT_LINES.md`。
> 標記：**MVP**｜**P2**｜**設計值**。

---

## 1. 設計目標

1. **基礎設施＝大生意**：機場與貨櫃碼頭是後期大型投資，帶來巨額收入、就業、旅遊與貿易，但同時有噪音、污染、交通擠塞與颱風風險。
2. **唔止一座建築**：玩家要建**複合設施**（客運大樓＋貨運站／貨櫃場＋龍門吊＋閘口），再連接道路、簽航線／船線合約，才能產生流量。
3. **MVP 可玩、P2 可深**：MVP 每個設施 1–2 種建築＋簡單合約；P2 才做擴建、多客運大樓、航空公司／船公司動態。
4. **與真實香港位置一致**：機場只在赤鱲角（真實雙跑道視覺）；貨櫃碼頭只在葵青（西岸港口）；「機場／碼頭」唔可以周圍起。

---

## 2. 機場（Airport）

### 2.1 新增建築（MVP）

| key | 名稱 | 尺寸 | 造價 | 維護/月 | 工人 | 解鎖 | 功能 | 放置限制 |
|---|---|---|---|---|---|---|---|---|
| `airportTerminal` | 客運大樓 | 5×5 | **$28,000,000** | $260,000 | 180 | 1200 | 機位（gates）**24**；每日最多 240 班客機；旅遊收入 | 赤鱲角機場區內、臨路 |
| `airportCargoTerminal` | 貨運站 | 4×4 | **$16,000,000** | $140,000 | 80 | 900 | 貨運容量 **600 噸/日**；進出口 goods／electronics | 赤鱲角機場區內、臨路 |
| `airportTower` | 控制塔 | 2×2 | $6,000,000 | $40,000 | 12 | 1200 | P2：全機場效率 +10%；MVP 可選裝飾 | 機場區內 |
| `airportHotel` | 機場酒店 | 3×3 | $8,000,000 | $60,000 | 40 | 1100 | P2：旅遊收入 +15%、住客 | 機場區內、臨路 |

- 機場區判定：`HK_REGIONS` kind `'airport'`（赤鱲角真實位置）；`airportTerminal`／`airportCargoTerminal` 必須在此區內、臨路。
- 跑道是 map 視覺（真實雙跑道）；**玩家唔可以建跑道**（MVP）；P2 可擴建第三跑道（超大型工程）。
- 現有機場視覺在 `starter` 及 `empty` 都會顯示（真實地理的一部分）？→ **Round 5 規則：機場視覺 always 顯示（真實地理），但只有玩家建成客運／貨運設施後才有機場玩法與流量**。若 Lead 想 empty 完全無人造物，可 gate 機場視覺；文件建議「機場視覺 always（因為係地理），但設施／航班要玩家投資」。

### 2.2 航線／合約（MVP）

```ts
export type AirRouteType = 'passenger' | 'cargo';
export interface AirRoute {
  id: number;
  type: AirRouteType;
  destination: string;      // 東京、新加坡、曼谷、上海、台北、首爾、倫敦
  flightsPerDay: number;    // 客運 2–24；貨運 1–12
  aircraftSize: 'narrow' | 'wide'; // 窄體 180 人／廣體 330 人（貨運 40/80 噸）
  feePerFlight: number;     // 玩家可調 landing fee $4,000–$20,000
  status: 'active' | 'paused';
  /** 結算 */
  passengersToday: number;
  cargoToday: number;
  revenueToday: number;
}
```

- 客運航線需求：`demand = cityPopulation × tourismAttractiveness × destinationFactor`；`tourismAttractiveness` 由幸福、酒店（P2）、地標、維港景觀決定。MVP 簡化：`demandPerFlight = min(aircraftSeats, population × 0.06 × destinationFactor)`。
- 貨運航線：`cargoTons = flights × aircraftTons × loadFactor`；進口 goods／electronics（供應鏈）＋出口多餘 electronics（收入）。
- 簽約／開關：玩家在「機場面板」新增航線（選目的地、班次、機型、收費）；可暫停／刪除；機位上限 = 客運大樓 gates×10 班/日。
- 航空公司：P2 加入 3 間虛構航空公司合約（國泰風格、廉航風格、貨運風格），各有票價／班次偏好；MVP 用「自由航線」。
- 颱風：8 號風球機場關閉（航班取消、收入歸零、旅客滯留幸福 −2）；P2 航班延誤連鎖。

### 2.3 機場經濟（MVP）

```
客運收入 = 乘客 × (機票分成 $120 + 零售 $60) × 0.9
貨運收入 = 噸數 × 貨種單價（goods $1,200/噸、electronics $6,000/噸）× 0.25（機場處理費）
機場營運成本 = 客運大樓 upkeep + 貨運站 upkeep + 航線變動成本（$2,000/班）
旅遊業收入 = 乘客 × tourismSpend（$80–$200，視幸福／酒店）
就業 = 客運 180 + 貨運 80 + 間接（酒店／物流）
噪音 = 客運大樓半徑 30 內住宅幸福 −6、地價 −10%；貨運站半徑 25 內 −4
道路流量：機場每日貨車／的士流量 → 附近道路擠塞（P2 實作；MVP 用吞吐量扣減）
```

- 平衡例子：客運 24 gates × 10 班 = 240 班/日 × 平均 120 乘客 = 28,800 乘客/日；收入 28,800 × $180 × 0.9 ≈ **$4.67M/日**？太大 → 調整：`機票分成 $12 + 零售 $8 = $20/乘客` → 28,800×$20×0.9 = $518k/日（≈$3.6M/月），相對 $28M 造價＋$260k/月維護，回本約 8–10 個月，配合 1,200 解鎖合理。設計值：**客運 $20/乘客、貨運處理費 goods $900/噸、electronics $4,500/噸**。
- 貨運：600 噸/日 × $900 = $540k/日（若全部 goods）；實際混合 70% goods／30% electronics ≈ 600×(0.7×900+0.3×4500)=600×$1,980=$1.19M/日 → 太大；調整貨運處理費 **goods $120/噸、electronics $600/噸** → 600×(0.7×120+0.3×600)=600×$264=$158k/日（≈$1.1M/月），合理。
- 旅遊收入：乘客 × $30–$80（幸福／酒店加成）→ 28,800×$40 ≈ $1.15M/日 太大；改為乘客 × $3–$8 → $86k–$230k/日（≈$0.6–$1.6M/月）；與機場收入合計約 $2.5–4M/月，對應 $28M+$16M 投資，回本 10–15 月。

### 2.4 機場失敗狀態

| 情況 | 後果 |
|---|---|
| 未建客運／貨運大樓 | 冇航班、冇收入（機場只係視覺） |
| 未接路 | 客運／貨運設施唔營運；航線暫停 |
| 機位不足 | 新增航線 disabled；提示「機位已滿，請擴建客運大樓（P2）」 |
| 颱風 8 號 | 航班取消、收入 0、旅客滯留幸福 −2 |
| 噪音抗議 | 半徑 30 內住宅 ≥50 戶 → 每日 2% 機會「機場噪音抗議」：幸福 −3、機場收入 −20% 1 日 |
| 航線蝕錢 | 面板紅字顯示；可減班／加價／停航 |
| 貨運艙位不足 | 出口 electronics 滯留；倉庫滿 → 出口收入減少 |

---

## 3. 貨櫃碼頭（Container Port）

### 3.1 新增建築（MVP）

| key | 名稱 | 尺寸 | 造價 | 維護/月 | 工人 | 解鎖 | 功能 | 放置限制 |
|---|---|---|---|---|---|---|---|---|
| `containerYard` | 貨櫃場 | 5×5 | $6,000,000 | $60,000 | 40 | 300 | 儲存 **1,500 TEU**；吞吐緩衝 | 葵青/西岸港口區、臨路 |
| `gantryCrane` | 龍門吊 | 2×2 | $8,000,000 | $50,000 | 20 | 350 | 每座吞吐 **600 TEU/日**；最多 6 座 | 貨櫃場相鄰／港口區 |
| `portGate` | 碼頭閘口 | 2×2 | $4,000,000 | $30,000 | 12 | 320 | 貨車吞吐 **900 架次/日**；閘口擠塞管理 | 港口區、臨路 |
| `containerPort`（現有） | 貨櫃碼頭 | 4×3 | $8,000,000 | $80,000 | 30 | 300 | 碼頭核心；提供基本進口 goods 45/日 | 西岸、臨水、臨路 |

- **複合設施**：碼頭吞吐量 = `min(龍門吊總容量, 貨櫃場容量, 閘口容量, 道路連通)`；只有碼頭而無吊機／閘口 → 吞吐 = 25% 基礎值（MVP 向後兼容）。
- 1 TEU ≈ **8 goods 單位**（MVP 換算）；電子產品另計（1 TEU = 1 goods 當量但價值 ×5）。
- 碼頭區判定：`HK_REGIONS` `'containerPort'`（葵青真實位置）＋ x 以西海岸；`needsWater`。

### 3.2 船線合約（MVP）

```ts
export interface PortLane {
  id: number;
  destination: string;      // 深圳、廣州、上海、新加坡、東京、洛杉磯、鹿特丹
  direction: 'import' | 'export' | 'both';
  teuPerDay: number;        // 10–150 TEU/日（受吞吐量限制）
  feePerTeu: number;        // 玩家可調 $80–$400
  cargoType: 'goods' | 'electronics' | 'mixed';
  status: 'active' | 'paused';
  teuToday: number;
  revenueToday: number;
}
```

- 進口：goods／electronics 入貨倉（現有 logistics）；出口：多餘 electronics／goods 換收入。
- 玩家在「貨櫃碼頭面板」簽船線（目的地、方向、TEU/日、處理費）；吞吐量不足 → 實際 TEU = min(合約需求, 吞吐能力)，顯示「碼頭擠塞」。
- 颱風：8 號風球碼頭停裝卸（現有規則），收入 0；復工後 1 日效率 ×0.7。

### 3.3 碼頭經濟（MVP）

```
吞吐能力 = min(吊機容量合計, 貨櫃場容量, 閘口容量, 道路容量)
實際吞吐 = min(Σ 船線需求, 吞吐能力)
處理收入 = 實際吞吐 TEU × feePerTeu（$80–$400，預設 $200）
進口貨值 = 進口 TEU × 8 × 資源參考價（goods $120／electronics $900）→ 入庫，不直接變現金
出口收入 = 出口 TEU × 8 × 資源價 × 0.6 → 現金
營運成本 = 建築 upkeep + 每 TEU 處理成本 $40
就業 = 碼頭 30 + 吊機 20×N + 貨櫃場 40 + 閘口 12
污染/噪音：貨櫃場半徑 20 內住宅幸福 −3；龍門吊半徑 12 內 −2
```

- 平衡例子：1 碼頭＋2 吊機＋1 貨櫃場＋1 閘口 → 吞吐 min(1200,1500,900,道路) = 900 TEU/日；船線需求 600 → 收入 600×$200 = $120k/日（≈$840k/月）；成本 upkeep ≈$80k+$100k+$60k+$30k=$270k/月＋處理 600×$40×30=$720k/月 → 淨約 **−$150k/月**？→ 調整處理成本 $10/TEU → $180k/月，淨 **+$390k/月**，回本約 4–5 年（含 $26M 投資）→ 可接受但偏慢；建議 `feePerTeu` 預設 $300 → 收入 $1.26M/月，淨 +$810k/月，回本約 2.7 年。文件用預設 $250–$300，玩家可調。
- 與現有 `containerPort` 45 goods/日 的關係：MVP 保留基礎進口；當有吊機／閘口／船線時，基礎值併入吞吐計算（避免雙重）。

### 3.4 碼頭失敗狀態

| 情況 | 後果 |
|---|---|
| 未建吊機／閘口 | 吞吐 = 25% 基礎值；提示「碼頭未完全運作」 |
| 船線需求 > 吞吐 | 擠塞：排隊、實際吞吐封頂、延誤成本 $/TEU |
| 未接路 | 閘口停擺、碼頭吞吐 = 0 |
| 8 號風球 | 停裝卸、收入 0、復工後一日 ×0.7 |
| 出口貨源不足 | 出口 TEU 下降（與物流／工廈產量掛鈎） |
| 噪音抗議 | 貨櫃場半徑 20 住宅 ≥40 戶 → 每日 1.5% 機會抗議：幸福 −2、碼頭收入 −10% 1 日 |

---

## 4. 解鎖、成本與平衡

| 設施 | 解鎖人口 | 造價 | 維護/月 | 回本目標 |
|---|---|---|---|---|
| `containerPort`（現有） | 300 | $8M | $80k | 物流樞紐，靠船線收入 |
| `containerYard` | 300 | $6M | $60k | 3–4 年 |
| `portGate` | 320 | $4M | $30k | 3–4 年（吞吐瓶頸） |
| `gantryCrane` | 350 | $8M/座 | $50k/座 | 每座 600 TEU/日 × $250 ≈ $150k/日，回本 <1 年（所以限制最多 6 座） |
| `airportCargoTerminal` | 900 | $16M | $140k | 4–6 年 |
| `airportTerminal` | 1200 | $28M | $260k | 5–8 年 |

- 解鎖與人口上限 1,600：機場在 1,200 解鎖＝後期目標；MVP 只做 1 客運＋1 貨運，P2 擴建。
- 全部屬 `ploppable`：玩家手動放置；**唔可以由分區自動開發**。
- 空間：機場用赤鱲角真實區塊；碼頭用葵青真實區塊；兩個都係大型 footprint，需要預留土地。
- 600 地圖：機場雙跑道、葵青碼頭位置更精細；可建地 22% 下，大型設施要揀填海／平地（機場島、葵青填海）。

---

## 5. 交通、噪音與土地利用

- **道路接駁**：客運大樓、貨運站、碼頭閘口、貨櫃場都要臨路；道路容量不足 → 吞吐量下降（P2 用貨車流量模擬；MVP 用固定上限）。
- **機場交通**：機場道路每日貨車／的士流量大；P2 可建機場快線／巴士線（配合 ROUND5_TRANSIT_LINES）。
- **噪音污染**：
  - 機場客運大樓半徑 30、貨運站半徑 25；貨櫃場半徑 20、龍門吊半徑 12。
  - 半徑內住宅幸福 −（機場 −6／貨運 −4／貨櫃場 −3／吊機 −2）；地價 −10%（機場）／−5%（貨櫃場）。
  - 住宅區太近會觸發「噪音抗議」事件（§2.4／§3.4）。
- **土地利用**：真實土地利用數據（住宅／商業／工業／農地）影響初始地價／可建性；機場島與葵青填海地地價低但只適合基建。
- **旅遊**：機場客運＋維港地標＋酒店（P2）→ tourismAttractiveness；沒有機場時旅遊收入只靠地標／渡輪。

---

## 6. 資料契約摘要（給 Lead）

| 項目 | 建議 | MVP？ |
|---|---|---|
| 新 building key | `airportTerminal`、`airportCargoTerminal`、`containerYard`、`gantryCrane`、`portGate` | ✅ |
| `BuildingDef` | `airport?: {type:'terminal'|'cargo'; gates?:number; cargoTons?:number}`；`port?: {type:'yard'|'crane'|'gate'; capacity:number}` | ✅ |
| `GameState.airport` | `{ routes: AirRoute[]; flightsToday; passengersToday; cargoToday; revenueToday; noise }` | ✅ |
| `GameState.port` | `{ lanes: PortLane[]; teuToday; throughput; queue; revenueToday }` | ✅ |
| `nextAirRouteId`／`nextPortLaneId` | 遞增 id | ✅ |
| `GameActions` | `openAirportPanel()`、`addAirRoute(patch)`、`updateAirRoute(id,patch)`、`deleteAirRoute(id)`；`openPortPanel()`、`addPortLane(patch)`、`updatePortLane(id,patch)`、`deletePortLane(id)` | ✅ |
| `UIState` | `showAirport`、`showPort`、`airportTab:'routes'|'cargo'|'stats'`、`portTab:'lanes'|'throughput'|'stats'` | ✅ |
| `GameStats` | `airPassengers`、`airCargoTons`、`tourismIncome`、`portTeu`、`portRevenue`、`tradeIncome`、`noisePollution` | ✅ |
| `ExpenseKind` | 加 `airportOps`／`portOps`（或入 `infrastructure`） | P2 |
| Save v6 | airport／port／routes／lanes 入 state | ✅ |
| 航空公司合約、多客運大樓、第三跑道、機場快線、貨櫃碼頭自動化 | 後期擴建 | P2 |

---

## 7. 風險與取捨

| 風險 | 對策 |
|---|---|
| 收入過大（機場／碼頭後期印鈔） | 高造價＋高維護＋處理成本；收入曲線 cap；MVP 上限 1 客運＋1 貨運＋6 吊機 |
| 與物流重複計算 | 機場貨運／碼頭進出口入現有 goods／electronics 庫存；收入只計「處理費／出口」，不重複貨值 |
| 空間不足 | 只可在真實機場／葵青區建；其他區放置拒絕並提示 |
| 噪音令住宅區無法發展 | 半徑／地價懲罰要 UI 顯示；玩家可選擇遠離或接受 |
| 效能 | 機場／碼頭設施數量少（≤20 座），每日結算唔構成負擔 |
| 颱風 | 停航停裝卸；玩家要備庫存（燃油／藥品舊版已移除，現在是 goods／food） |

---

*文件結束。與 `ROUND5_UTILITIES.md`、`ROUND5_TRANSIT_LINES.md`、`GAME_DESIGN_HK.md`（Round 5 章節）、`UI_SPEC_HK.md`（機場／碼頭面板）一併使用。*
