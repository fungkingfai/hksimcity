# 《維港之城》Round 5 規格：地下管網（ROUND5_UTILITIES.md）

> 文件版本：1.0（2026-10-24）｜撰寫：game-designer
> 專案：`hk-city/`｜用途：Round 5 新增「水／污水／電力地下管網」玩法規格；供 Lead／systems-dev／ui-dev／citizens-dev／economy-dev 實作。
> 依據：`src/sim/transit.ts`（交通結算模式）、`src/sim/stats.ts`（`powerCoverage`／`waterCoverage` 現有語義）、`src/core/types.ts`（`UtilityDef`）、`src/core/config.ts`（`powerPlant`／`waterworks` utility 22／18 半徑）、`docs/GAME_DESIGN_HK.md`、`docs/REAL_GEO_DATA.md`。
> 標記：**MVP（Round 5 必須）**｜**P2（可延後）**｜**設計值（可平衡調整）**。

---

## 1. 設計目標

1. **保留策略、簡化模擬**：玩家要規劃「水源 → 主幹管 → 用戶」「污水 → 污水廠」「發電廠 → 變電站 → 用戶」，但唔需要逐戶接駁或流體力學。
2. **與現有玩法過渡**：現時 `powerPlant`／`waterworks` 用「半徑＋容量」直接覆蓋；Round 5 改為 **建築要有管網接駁**，半徑只用作「源頭服務範圍／加壓」；starter 預建完整管網、empty 完全冇。
3. **三網同構、不同後果**：水（供應／壓力）、污水（流量／污染）、電（容量／過載）共用一套管網 BFS＋容量分配，但後果與污染不同。
4. **地下層可視化**：`U` 打開地下層，顯示管線走向、流量、壓力、污染熱點；不做 3D 挖掘動畫。

---

## 2. 現狀與過渡方案

| 現狀（Round 4） | Round 5 目標 |
|---|---|
| `powerPlant` `utility:{kind:'power', radius:22, capacity:1600}` | 發電廠仍是電源；容量 1,600 單位，經電纜送到用戶；**半徑改為「可接駁電纜範圍提示」**，唔再直接供電 |
| `waterworks` `utility:{kind:'water', radius:18, capacity:2000}` | 水務設施仍是水源；容量 2,000 單位，經水管送到用戶；**新增水塘／海水取水概念**（見 §9） |
| `stats.powerCoverage/waterCoverage`（半徑人口加權） | 改為 **管網接駁人口加權**；語義同名，UI 文案改「管網覆蓋率」 |
| 玩家唔需要鋪管 | 玩家要鋪水管／污水管／電纜；成本 $/格、維護 $/格/月；可只鋪主幹，建築自動接駁鄰格管線 |

**過渡策略（MVP）**：一次性切換，不保留半徑供電／供水（避免兩套制並存）。
- Starter：`starter-town.ts` 預建主幹管網＋接駁全部 34 棟 auto 建築＋10 項設施，玩家入場即正常。
- Empty：零管網；玩家由第一個水務設施／發電廠開始，手動接駁。
- 舊存檔（v5）不兼容（save v6）。

---

## 3. 資料模型與資料契約

### 3.1 Tile 新欄位（MVP）

```ts
export interface Tile {
  // ...原有 terrain／elevation／variant／buildingId／road／sidewalk／zone／density／buildingHeight
  /** 地下管線（true = 該格有；三者可重疊，代表同一 trench 內不同管） */
  waterPipe?: boolean;   // 食水管
  sewagePipe?: boolean;  // 污水管
  powerLine?: boolean;   // 電纜
  /** P2：管線老化／破損狀態（0..255），用於漏水／停電事件 */
  pipeHealth?: number;
}
```

- 管線**不佔建築 footprint**，可鋪在道路、行人路、空地（不可鋪水域、山地、濕地、沙灘，除非 P2 海底管道）。
- 三種管可同格（同一 trench），渲染時以顏色區分（水藍／污水褐／電黃）。
- 建築接駁：footprint **正交外側任一格**有對應管線 → 已接駁（與道路連通同一判定方式）。

### 3.2 GameState 新欄位（MVP）

```ts
export interface UtilitiesState {
  /** 每格管線已存在於 Tile；呢個只存「源頭／網絡版本／結算結果」 */
  version: number;
  /** 每日結算結果（runtime；可存檔但可重算） */
  water: { supply: number; demand: number; pressure: number; coverage: number; shortage: number };
  sewage: { capacity: number; load: number; backlog: number; pollution: number; coverage: number };
  power: { supply: number; demand: number; load: number; coverage: number; blackout: number };
  /** 最近一次結算日；避免重算 */
  lastDay: number;
}

export interface GameState {
  // ...原有
  utilities: UtilitiesState;
}
```

- **唔建議**在 `GameState` 存 360,000 格管網 array；管網以 `Tile` 稀疏布林值表示，save v6 以 bit 打包（和 road／sidewalk／zone 一樣）。
- 網絡連通／流量用「每日一次 BFS from sources」計算，結果放 `utilities.*`（runtime，唔需每幀）。
- P2：`waterQuality`（污染度）、`pipeHealth` 陣列、`pumpCurves`。

### 3.3 BuildingDef／Building 新欄位（MVP）

```ts
export interface UtilitySourceDef {
  kind: 'water' | 'sewage' | 'power';
  /** 每日容量（單位） */
  capacity: number;
  /** 是否要臨水／臨海（水務、污水廠） */
  needsWaterSource?: boolean;
  /** 供電／供水會消耗其他公用（例如污水廠耗電） */
  consumes?: { kind: 'power' | 'water'; amountPerDay: number };
  /** 污染半徑／噪音（污水廠） */
  pollutionRadius?: number;
}

export interface UtilityDemandDef {
  water?: number;    // 每日單位
  sewage?: number;
  power?: number;
}

export interface BuildingDef {
  // ...原有
  utilitySource?: UtilitySourceDef;    // 取代 utility 的半徑覆蓋（向後兼容：utility 仍可存在，但 Round5 只讀 utilitySource）
  utilityDemand?: UtilityDemandDef;    // 建築每日需求
}
```

- `Building` 唔需要加持久欄位；接駁狀態每日由 footprint 鄰格推導（`connectedWater`／`connectedSewage`／`powered` 可放 runtime cache 或 `stats`）。
- P2：`Building.utilityPriority`（醫院／水廠優先）、`Building.utilityStatus` for UI。

### 3.4 GameActions／UIState（MVP）

```ts
export type UndergroundLayer = 'none' | 'water' | 'sewage' | 'power' | 'all';

export interface GameActions {
  // ...原有
  /** 管網工具：'pipe:water' | 'pipe:sewage' | 'pipe:power' | 'pipe:demolish' */
  setUtilityTool(tool: string | null): void;   // 或沿用 setTool()
  /** 地下層檢視 */
  setUndergroundLayer(layer: UndergroundLayer): void;
  /** 打開公用設施面板 */
  toggleUtilities(): void;
}

export interface UIState {
  // ...原有
  showUtilities: boolean;          // 公用設施／管網面板
  undergroundLayer: UndergroundLayer;
  showUnderground: boolean;        // U 鍵開關
  utilityTab: 'water' | 'sewage' | 'power'; // 面板分頁
}
```

- **工具字串**沿用 `ui.tool`：`'pipe:water'`／`'pipe:sewage'`／`'pipe:power'`；`'pipe:demolish'`（只拆管，同 `demolish` 分開，避免誤拆建築）。
- 快捷鍵：**U** 地下層開關；**1/2/3** 在水務面板切水／污水／電（非全局）；**Esc** 取消。
- Save v6：`Tile` 新 bit（bit3 waterPipe、bit4 sewagePipe、bit5 powerLine）加入 `packTile`；`UtilitiesState` 存入 state。

---

## 4. 玩家工具與鋪設規則

| 工具 | 成本／格 | 維護／格／月 | 可鋪地形 | 接駁規則 |
|---|---|---|---|---|
| 食水管 `pipe:water` | **$600** | $0.6 | 可建地＋道路／行人路 | 建築 footprint 正交外側有水管 → 接駁 |
| 污水管 `pipe:sewage` | **$800** | $0.8 | 同上 | 建築污水需接污水管，管道要連到污水廠 |
| 電纜 `pipe:power` | **$500** | $0.5 | 同上 | 建築用電需接電纜，電纜要連到發電廠／變電站 |
| 拆除管 `pipe:demolish` | 退款 30% | — | 任何有管格 | 可只拆其中一種（按地下層 tab 決定） |

- **拖曳鋪設**：同道路；可穿過建築底格（隧道式），但唔可以穿水域／山地／濕地／沙灘（P2 海底管道）。
- **建築接駁**：建築只認 footprint 外側正交格；同一格多管可同時接駁。
- **源頭接駁**：水務設施要鄰接水管、污水廠鄰接污水管、發電廠／變電站鄰接電纜；源頭自身都要接駁，否則容量不計。
- **拆除源頭／管道**：即時重算；斷水斷電會在下次每日結算反映，UI 立刻顯示警告。
- **成本平衡**：以 480／600 地圖計，一個 10×10 小區主幹管網約 60–100 格 → $36k–$80k，佔後期庫房很小；維護 $36–$80/月，唔會拖垮玩家（設計值）。

---

## 5. 公用設施建築與數值（新增／調整）

### 5.1 新增 ploppable 建築（MVP）

| key | 名稱 | 尺寸 | 造價 | 維護/月 | 工人 | 解鎖 | 功能 | 放置限制 |
|---|---|---|---|---|---|---|---|---|
| `sewagePlant` | 污水處理廠 | 3×3 | $3,500,000 | $28,000 | 16 | 140 | 污水源：capacity **1,500**；處理效率 0.9；耗電 150 | 臨水、臨路 |
| `substation` | 變電站 | 2×2 | $2,200,000 | $12,000 | 6 | 160 | 電源中繼：capacity **1,200**；把發電廠電力送入電纜網；自身耗電 0 | 臨路 |
| `waterTower` | 水塔 | 2×2 | $1,200,000 | $8,000 | 2 | 100 | 儲水 **600**；半徑 20 內 +15% 壓力 | 臨路 |
| `pumpingStation` | 抽水站 | 2×2 | $900,000 | $6,000 | 4 | 110 | P2：半徑 18 內 +20% 壓力、耗電 30 | 臨路、臨水 |
| `waterIntake` | 海水／水塘取水口 | 2×2 | $1,600,000 | $10,000 | 4 | 90 | 只可選水塘／海邊；為水務設施提供 +30% 容量（P2） | 臨水 |

### 5.2 現有建築調整（MVP）

| 建築 | 現值 | Round 5 調整 |
|---|---|---|
| `powerPlant` | utility power radius 22／capacity 1,600 | 保留 capacity 1,600；改為 `utilitySource:{kind:'power',capacity:1600}`；**要接電纜**才供電；污染半徑 6 不變 |
| `waterworks` | utility water radius 18／capacity 2,000 | 保留 capacity 2,000；改為 `utilitySource:{kind:'water',capacity:2000,needsWaterSource:true}`；**要接水管**；水塘／海邊 +20%（P2） |
| 其他 32 種 | — | 加 `utilityDemand`（見 §5.3），默認 0（公共設施可設優先級） |

### 5.3 需求係數（設計值，MVP）

| 類別 | 食水／日 | 污水／日 | 電力／日 |
|---|---|---|---|
| 住宅（每人） | 1.0 | 0.8 | 1.0 |
| 商業（每工人） | 0.5 | 0.5 | 1.2 |
| 工業（每工人） | 1.2 | 1.2 | 2.5 |
| 物流（每工人） | 0.4 | 0.4 | 1.0 |
| 公共（醫院／學校） | 每建築 40 | 每建築 40 | 每建築 60 |
| 交通站點 | 每站 10 | 每站 10 | 每站 25 |
| 污水廠 | — | — | 150（自身） |
| 水務設施 | — | — | 80（泵水） |

> 以上用「單位」而非真實立方米；1 單位 ≈ 100 人日常用量。容量 2,000 的水務設施 ≈ 2,000 人；1,500 污水廠 ≈ 1,875 人（污水係數 0.8）；1,600 發電廠 ≈ 1,000 人＋工業（設計值）。

---

## 6. 網絡計算（每日一次）

### 6.1 接駁與分量（BFS）

```
對每個 utility kind（water／sewage／power）：
  1. sources = 有 utilitySource.kind === kind、active、connected（臨路）的建築
  2. 把 sources 鄰接的管線格加入 BFS queue
  3. BFS 沿同類管線格擴散（4 鄰接；不可穿水域／山地）
  4. 得到多個「網絡分量」；每分量記錄：水源容量總和、管線格、接駁建築
  5. 每棟建築：footprint 正交外側有同類管 → 屬於對應分量（若無 → 未接駁）
```

### 6.2 水：容量＋壓力

```
waterSupply = Σ(分量內水務設施 capacity × staffing × weather)
waterDemand = Σ(接駁建築 utilityDemand.water)
ratio = waterDemand > 0 ? clamp(waterSupply / waterDemand, 0, 1) : 1
pressure = clamp(ratio × (0.7 + 0.3 × pressureBonus), 0, 1)
  pressureBonus = 1 + 0.15（水塔半徑內）＋0.2（抽水站，P2）
waterCoverage = 接駁人口 / 總人口（唔理 ratio）   // stats.waterCoverage
shortage = max(0, waterDemand - waterSupply)
```

- `ratio < 0.6`：缺水 → 建築效率 ×0.5、住戶幸福 −6、火災風險事件 +；`ratio < 0.25` → 制水（每 3 日一次，幸福 −10，人口遷出風險）。
- 水壓不足（pressure <0.5）：高層住宅（私人屋苑／豪宅）效率再 ×0.8；P2 分區加壓。

### 6.3 污水：流量＋污染

```
sewageLoad = Σ(接駁建築 utilityDemand.sewage)
sewageCapacity = Σ(污水廠 capacity × 0.9)
load = sewageLoad / max(1, sewageCapacity)
若污水廠／污水管網絡接唔通 → backlog += sewageLoad
pollution = clamp((load - 0.8) × 0.6 + backlog / max(1, sewageLoad × 7), 0, 1)
```

- `load > 1` → 污水倒灌：附近住戶幸福 −8、daily 污染事件（污染半徑 8 格）、醫院需求上升。
- 污水廠 `pollutionRadius` 8 格內住宅幸福 −3（可接受設施）；未有污水廠 → 全城污染 +0.05/日（MVP 提示「請建污水處理廠」）。
- `stats.sewageCoverage` = 接駁人口比例。

### 6.4 電力：容量＋過載

```
powerSupply = Σ(發電廠 capacity + 變電站 capacity) × staffing
powerDemand = Σ(接駁建築 utilityDemand.power)
load = powerDemand / max(1, powerSupply)
powerCoverage = 接駁人口 / 總人口
```

- `load > 1`：輪流停電（每區 1 日隨機 30% 建築停電）；`load > 1.25` → 大停電事件（幸福 −8、工業停產 2 日）。
- 發電廠／變電站自身要接電纜；變電站要接發電廠同一分量（否則容量不計）。
- 污染：發電廠半徑 6 內住宅幸福 −4（不變）。

### 6.5 成本與維護（每月）

- 管線維護：`Σ(管線格 × 單價)`；水源／污水廠／變電站維護照 `upkeep`。
- 計入 `finance.expenseBreakdown.infrastructure`（現有分類）；月報表加「公用設施」一行（P2）。
- 缺水／停電／污水倒灌時，工業生產下降 → 利得稅減少（自然懲罰）。

---

## 7. UI：地下層與公用設施面板

### 7.1 地下層（`U` 開關）

- 相機保持城市視角，地面變半透明；管線以霓虹線條顯示：
  - 食水管：`#24e0ff` 青；污水管：`#b07a4a` 褐；電纜：`#ffd166` 金；
  - 流量／負荷：綠（正常）→黃（>80%）→紅（>100%）；未接駁建築紅框。
- 分層 toggle：水／污水／電／全部；只顯示選中層。
- Hover 管格：顯示「食水管 · 連往 中環水務設施 · 流量 68%」。
- 地下層時 minimap 不變（P2 加管網 overlay）。

### 7.2 公用設施面板（`showUtilities`）

```
┌──────────────────────────────────────────────┐
│ 公用設施                     [水] [污水] [電] │
├──────────────────────────────────────────────┤
│ 食水：供應 2,000 / 需求 1,640  覆蓋 82% 壓力 78% │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░  正常                    │
│ 污水：容量 1,500 / 流量 1,312   負荷 87%      │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░  接近上限                  │
│ 電力：供應 1,600 / 需求 1,420   負載 89%      │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░  正常                    │
├──────────────────────────────────────────────┤
│ 未接駁建築：3 棟（住宅 2、工廈 1）  [定位]     │
│ 警示：污水廠未接駁（污水管斷開）              │
│ [鋪設水管] [鋪設污水管] [鋪設電纜]             │
└──────────────────────────────────────────────┘
```

- 面板內按鈕直接切換 `ui.tool` 並收起面板；「定位」把鏡頭飛到第一個未接駁建築。
- 建築卡（城事面板）加「公用」區塊：水／污水／電 接駁狀態與負荷。
- Toast：新接駁成功、缺水、污水倒灌、停電、管線被拆。

### 7.3 快捷鍵

`U` 地下層開關；`1/2/3` 在公用設施面板切水／污水／電；`Esc` 取消工具；`P` 回市中心不變。

---

## 8. 失敗與後果（平衡）

| 情況 | 後果 | 玩家對策 |
|---|---|---|
| 未接駁食水 | 建築效率 ×0.5、住戶幸福 −6、火災風險 + | 鋪水管、接駁水務設施 |
| 食水供應不足（ratio<0.6） | 效率 ×0.5、幸福 −6；<0.25 制水 | 加建水務設施／水塔 |
| 未接駁污水 | 污水 backlog、污染上升、幸福 −4 | 鋪污水管、建污水廠 |
| 污水超載（load>1） | 倒灌：幸福 −8、污染事件、醫院需求 | 加建污水廠／減少工業 |
| 未接駁電力 | 效率 ×0.4、幸福 −4 | 鋪電纜、接發電廠 |
| 電力超載（load>1.25） | 大停電：工業停產 2 日、幸福 −8 | 加建發電廠／變電站 |
| 管線被拆／源頭拆 | 下一個 daily 立刻短缺；UI 紅警示 | 重鋪或重建 |
| 颱風 | 水務／污水廠效率 ×0.7 1 日；電廠停機 20% 機會 | 備用變電站／水塔 |

---

## 9. 600 地圖／水塘／土地利用的影響

- **水塘作為水源**：Round 5 真實數據加入水塘水面（船灣、萬宜、大潭、城門等）；`waterworks` 若在**水塘或海邊 12 格內**，容量 +20%（P2，MVP 先做「臨水」提示）。
- **海水化淡（P2）**：海邊 `waterIntake` + 高耗電，可無視水塘位置，作後期選項。
- **水塘唔做游泳／康樂**：保持郊野公園視覺；P2 可加水塘觀光。
- **土地利用**：`fertile`／`reclaimed`／`urban` 由真實土地利用數據細分 → 農業區只可 fertile／grass；填海區地價較高；可建地比例由 22.4% 微調（600 地圖更精細海岸線後以 QA 實測為準）。
- **600 地圖**：`GRID=600×600`（360,000 格）、tile 112m、`MAP_SCALE=6.25`、`WORLD_SPAN=1200`、`GAME_VERSION=6`；管網 BFS 要限制在「有管線格」與源頭半徑，唔可以每日掃 360,000 格（用 sparse set＋管線 index）。

---

## 10. 資料契約摘要（給 Lead）

| 項目 | 建議 | MVP？ |
|---|---|---|
| `Tile.waterPipe/sewagePipe/powerLine?: boolean` | 管線存在；save v6 sparse bit 3/4/5 | ✅ |
| `Tile.pipeHealth?: number` | 老化／破損 | P2 |
| `GameState.utilities: UtilitiesState` | 每日結算結果（supply／demand／pressure／coverage／backlog／pollution） | ✅ |
| `BuildingDef.utilitySource`（kind／capacity／needsWaterSource／consumes／pollutionRadius） | 取代 utility 半徑直接供電 | ✅ |
| `BuildingDef.utilityDemand`（water／sewage／power） | 每類建築需求 | ✅ |
| `BuildingDef.utility` | 保留欄位但 Round5 不再直接用；由 utilitySource 取代 | 過渡 |
| 新 ploppable：`sewagePlant`、`substation`、`waterTower` | 見 §5.1 | ✅ |
| `pumpingStation`、`waterIntake`、海水化淡 | 加壓／取水 | P2 |
| `GameActions.setUndergroundLayer()`／`toggleUtilities()`／`setTool('pipe:*')` | 工具與檢視 | ✅ |
| `UIState.showUtilities`／`undergroundLayer`／`showUnderground`／`utilityTab` | 面板狀態 | ✅ |
| `stats.waterSupply/waterDemand/waterPressure/sewageCapacity/sewageLoad/sewageBacklog/powerSupply/powerDemand/powerLoad` | UI／警報 | ✅（可放 utilities，stats 只給 summary） |
| Save v6 | `packTile` 加 bit3/4/5；`utilities` 入 state；舊 v5 拒絕 | ✅ |
| 管線老化／漏水／污染擴散網格 | 事件與維修 | P2 |

---

*文件結束。與 `GAME_DESIGN_HK.md`（Round 5 章節）、`UI_SPEC_HK.md`（地下層 UI）、`ROUND5_TRANSIT_LINES.md`、`ROUND5_AIRPORT_PORT.md` 一併使用。*
