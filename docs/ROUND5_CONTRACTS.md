# Round 5 資料契約與分工（Lead 定稿）

> 第五輪玩家要求：600×600 更精細海岸線、水塘／土地利用補水面、機場／貨櫃碼頭玩法、
> 水／污水／電力地下管網、巴士／小巴路線管理。
> 本檔係 **跨 Agent 契約**；`core/types.ts`／`core/config.ts`／`core/new-game.ts`／
> `src/main.ts` 由 Lead 擁有。其他 Agent 如需改契約，先通知 Lead。

## 0. 里程碑

| 階段 | 內容 | 負責 |
|---|---|---|
| A | 600×600 真實地圖＋水塘 polygon＋土地利用 raster；切換 config／worldgen／save v6 | Lead＋world-dev |
| B | 地下管網：types/config/placement/sim/UI/starter/save | Lead＋systems-dev＋ui-dev＋buildings-dev |
| C | 巴士／小巴路線：資料模型、sim、車輛、UI、站點模型 | Lead＋transport-dev＋ui-dev＋buildings-dev |
| D | 機場／貨櫃碼頭：建築、region 規則、貿易 sim、UI、視覺 gate | Lead＋systems-dev＋ui-dev＋buildings-dev＋world-dev |
| E | 整合：starter/empty、教學、文件、QA 全綠、deploy | Lead＋citizens-dev＋game-designer |

功能實作順序：A（背景）→ B → C → D；B/C/D 可在契約鎖定後並行，但會 overlap
`types.ts`／`config.ts`／`save.ts`／`main.ts`／UI，必須由 Lead 先加好契約／骨架。

---

## 1. 600×600 地圖＋水塘／土地利用（world-dev task-25）

- 範圍不變：HK1980 **E 798,275–865,475、N 790,400–857,600**；**600×600、每格 112m**。
- `src/world/hk-map-data.generated.ts` 欄位不變（format `hk-map-data-v1`，width/heightTiles 變 600，資料長度 360,000）。
- 新增輸入：
  - `tools/data/impounding-reservoirs.geojson`：水務署 17 個官方水塘多邊形 → 任何子取樣命中 → water、elevation=0。
  - `tools/data/landuse2020-10m.raw.z`：規劃署 2020 土地利用 10m raster（zlib raw、6375×4800、origin E800000/N848000、10m）；value mapping 見 world-dev 訊息。
  - terrain override：91/92→water、62/74→wetland、61→fertile、71/72/73→forest/grass、43/44→reclaimed/urban、已發展 class→urban；0/海用 DTM landf。
- 切換（Lead）：`GRID_WIDTH/HEIGHT=600`、`MAP_SCALE=6.25`、`WORLD_SPAN=1200`、`GAME_VERSION=6`；save v6；tests/UI 文字 480→600；render LOD/camera 跟 MAP_SCALE。
- 舊 480 存檔拒絕（尺寸不符）。

---

## 2. 地下公用設施（水／污水／電力）

### 2.1 原則
玩家真正**鋪設地下管道／電纜**（不是只用道路／半徑），有地下層 view、工具、成本、
接駁規則、容量與故障後果。但**不做流體模擬**：以 BFS 連通＋容量池＋距離衰減代替。

### 2.2 Tile 新欄位（`core/types.ts`）
```ts
export interface Tile {
  // ...原有...
  waterPipe?: boolean;   // 食水管
  sewerPipe?: boolean;   // 污水管
  powerCable?: boolean;  // 電力電纜
}
```
- 管道可鋪在任何可建地（terrain buildable 或 road）；不可鋪 water/mountain/sand/wetland。
- 可鋪在建築腳下（retrofit）；可與道路／分區／建築共存。
- 拆路唔會拆管（獨立圖層）；拆建築唔會拆管。

### 2.3 新公用設施建築（`config.ts`）
沿用 `UtilityDef`，新增 `source?: boolean`（預設 false；source=true 才是供應源）：
| key | 名稱 | size | cost | upkeep | capacity | 水源/臨水 | 解鎖 |
|---|---|---|---|---|---|---|---|
| `powerPlant`（現有） | 發電廠 | 3×3 | 5.0M | 50k | **power 1600** | — | 180 |
| `waterworks`（現有） | 水務設施 | 2×2 | 2.6M | 22k | **water 2000** | 需臨水 | 90 |
| `waterTower`（新） | 水塔 | 1×1 | 420k | 6k | water 800 | — | 120 |
| `desalPlant`（新） | 海水化淡廠 | 3×3 | 9.5M | 165k | water 5000 | 需臨海 | 800 |
| `sewagePlant`（新） | 污水處理廠 | 3×2 | 3.4M | 42k | sewage 2200 | 需臨水 | 200 |
| `sewageOutfall`（新） | 排污口 | 1×1 | 520k | 5k | sewage 1400 | 需臨水 | 80 |

- 以上全部 `ploppable: true`、`needsRoad: true`（水塘除外？水塔 needsRoad true）、`utilitySource`。
- 新增 pipe 工具常數 `PIPE_INFO`（cost/upkeep/refund/color）。

### 2.4 GameState／Snapshot（`core/types.ts`）
```ts
export type UtilityServiceKind = 'water' | 'sewage' | 'power';

export interface UtilityNetworkStat {
  capacity: number;       // 全城供應容量（PE/kW）
  demand: number;         // 全城需求
  supplied: number;       // 實際供應（min(capacity,demand)）
  coverage: number;       // 0..1 人口加權有接駁且獲供應比率
  connectedBuildings: number;
  unconnectedBuildings: number;
  sources: number;
  shortage: number;       // 0..1 = 1 - supplyRatio
}
export interface UtilitySnapshot {
  revision: number;
  water: UtilityNetworkStat;
  sewage: UtilityNetworkStat & { treated: number; overflow: number };
  power: UtilityNetworkStat;
  pipeCounts: { water: number; sewer: number; power: number };
}
export interface GameState {
  // ...
  utilities?: UtilitySnapshot; // 每日／放置後重算；hydrate 後重算
  nextTransitLineId?: number;
  transitLines?: TransitLine[];
  trade?: TradeState;
}
```
- 需求（PE）按建築類別＋人口／工人：住宅 1.0 PE/人（水）／0.9（污水）／0.35（電）；
  商業 0.6／0.5／0.5；工業 1.5／1.8／1.2；物流碼頭 2.0／1.2／0.8；公共 0.5／0.5／0.6（按工人）。
- 每格管／電纜接駁：建築 footprint 任一格或四鄰有同類 pipe/cable；BFS 由 source 的相鄰管道出發。
- source 本身要 active（道路連通）＋至少一個相鄰管道；玩家要從廠房拉管。
- 容量不足：供應比例分配，全部 connected 建築獲 `supplyRatio` 服務係數；
  完全未接駁建築該服務係數 = 0.25（有同類 source 時）／0.55（全城未有該 source，self-supply bootstrap）。
- 污水：`coverage` 以接駁及處理比率；`overflow = max(0,demand-capacity)/demand`；
  overflow >0 時全城健康／幸福每日扣分（systems-dev 定值）。
- 每格成本：water $900、sewer $1,200、power $800；月維護 $1.4／$1.8／$1.1；拆卸退 25%。
- UI 地下層模式時游標工具：`pipe:water`／`pipe:sewer`／`pipe:power`／`pipe:remove`。

### 2.5 Actions／UIState（`core/types.ts`）
```ts
interface UIState {
  showUnderground?: boolean;     // 地下管網圖層
  showUtilityPanel?: boolean;    // 公用設施面板
}
interface GameActions {
  toggleUnderground?(): void;
}
```
- applyToolAt 新增 pipe 工具分支（main.ts Lead 實作；systems-dev 提供 placePipe/removePipe）。
- 快捷鍵 `U` 切換地下層；建造面板「公用」分類顯示 pipe 工具 + 新 utility 建築。
- 地下層顯示：3D 管道（3 色、發光）、地面淡化、建築半透明；UI 面板顯示 capacity/demand/coverage/quality/overflow/pipe 長度＋維護費；每座廠房點選卡顯示負載。
- 移動端：地下層 toggle 在 mobile-bar；工具列簡化。

### 2.6 Sim 模組（systems-dev）
新增 `src/sim/utilities.ts`：
```ts
export function computeUtilitySnapshot(state: GameState, force?: boolean): UtilitySnapshot;
export function utilityFactorFor(state: GameState, b: Building, kind: UtilityServiceKind): number;
export function placePipe(state: GameState, x: number, y: number, kind: 'water'|'sewer'|'power'): PlaceResult;
export function removePipe(state: GameState, x: number, y: number, kind: 'water'|'sewer'|'power'): PlaceResult;
export function pipeUpkeepMonthly(state: GameState): number;
```
- `stats.ts`：powerCoverage／waterCoverage 改用 snapshot；新增 `stats.sewageCoverage?`、`stats.waterQuality?`。
- `production.ts`：utilityFactor 改由 utilities.ts 提供（remove/舊半徑 fallback）。
- `finance.ts`：每月加 pipe upkeep 入 infrastructure expense。
- `simulation.ts`：每日 call computeUtilitySnapshot；低覆蓋／overflow warning；故障事件（可延後）。
- `placement.ts`：pipe 工具 validation、pipe placement 更新 worldRevision；**TileIndex 已存在**，pipe 不影響 zone/road/building index，但 revision 要 bump。
- `save.ts`：packTile 擴充 bit5–7 = water/sewer/power；v6；hydrate 後 `utilities=undefined` 再重算。

### 2.7 Starter／empty
- starter：`core/starter-town.ts` 在道路下鋪齊三種管（水塘隧道水面除外），並確保 powerPlant/waterworks/sewagePlant 有相鄰管；服務設施加入 sewagePlant。
- empty：0 管；玩家自行建。
- 教學／UI 提示：先建發電廠/水務/污水廠，再拉管到建築。

---

## 3. 巴士／小巴路線（transport-dev + ui-dev）

### 3.1 建築（`config.ts`，buildings-dev 做模型）
| key | 名稱 | size | cost | upkeep | 解鎖 |
|---|---|---|---|---|---|
| `busStop`（新） | 巴士站 | 1×1 | 60k | 800 | 20 |
| `minibusStop`（新） | 小巴站 | 1×1 | 40k | 600 | 20 |
| `busTerminus`（現有） | 巴士總站 | 2×2 | 1.3M | 12k | 80 |
| `minibusDepot`（新） | 小巴車廠 | 2×2 | 800k | 8k | 80 |

### 3.2 路線資料（`core/types.ts`）
```ts
export type TransitLineMode = 'bus' | 'minibus';
export interface TransitLine {
  id: number;
  mode: TransitLineMode;
  name: string;              // 自訂，UI 預設 e.g. 「巴士 1 號線」
  color: string;             // #rrggbb
  stopIds: number[];         // Building id（同 mode 的站）；≥2
  loop: boolean;
  vehicleCount: number;      // 1..12
  fare: number;              // HKD 3..12
  createdDay: number;
  ridershipToday: number;
  faresThisMonth: number;
  lastMonthRidership: number;
}
interface GameState { transitLines?: TransitLine[]; nextTransitLineId?: number; }
```
- 巴士線需要至少 1 座 `busTerminus`；小巴線需要至少 1 座 `minibusDepot`（可共用總站？MVP：各自需要）。
- 站點：`busStop` 可為任何巴士線站；`busTerminus` 亦可作站；小巴站對小巴線。
- 路線必須：stopIds ≥2、無重複、同 mode、每站 active 且貼路、站與站之間有道路 path。
- 建線成本：`車數 × 車價`（雙層巴士 $1.2M、小巴 $350k）＋一次性開線費 $50k；寫入 infrastructure。
- 每日營運成本：巴士 $1,050/車/日、小巴 $620/車/日（finance：transit expense / infrastructure）；票價收入寫 transit.faresThisMonth + finance fares。
- 每日載客（MVP）：對每線計 potential：
  - 站點 3 格內住宅居民 ×0.55 + 就業職位 ×0.75（cap by 車隊容量）
  - 容量 = vehicleCount × (bus 130 | minibus 19) × 6 班/日 × 天氣係數
  - 票價吸引力：fare≤6 全額、每 +$1 扣 8%；班距：headway = 2×路線長/車速/車數（分鐘），>12 分鐘吸引力跌。
  - ridership = min(potential × attractiveness, capacity × 0.9)；收入 = ridership × fare。
- `transit.byMode.bus` 加總巴士+小巴載客；`transit.dailyRidership/faresThisMonth` 更新。
- 乘客行為（完整 A* 通勤）可延後；MVP 以可達性＋容量估算；transport-dev 可選加市民搭車視覺。
- 車輛：`Vehicle.lineId?: number`；每線 spawn bus/minibus 沿 stop 間道路 path 循環；line vehicleCount 控制實際車輛數；停用線移除車輛。

### 3.3 Actions／UIState
```ts
export interface TransitLineInput { mode; stopIds: number[]; loop: boolean; vehicleCount: number; fare: number; name?: string; color?: string; }
interface GameActions {
  createTransitLine?(input: TransitLineInput): { ok: boolean; reason?: string; id?: number };
  updateTransitLine?(id: number, patch: Partial<Pick<TransitLine,'vehicleCount'|'fare'|'name'|'color'|'loop'>>): { ok:boolean; reason?:string };
  deleteTransitLine?(id: number): boolean;
}
UIState { showTransit?: boolean; selectedLineId?: number | null; lineEditor?: boolean; }
```
- UI：交通面板加「路線管理」列表（按盈虧排序、紅色虧損線）；「＋新增路線」→ 編輯模式（點站、Undo、完成、取消）；線詳情改車數／票價 slider、改名／顏色、刪線；地圖高亮選中路線（世界 overlay）；手機版簡化。
- 快捷鍵 `B` 開／關路線面板（或編輯模式）。

---

## 4. 機場／貨櫃碼頭（systems-dev + transport-dev + ui-dev）

### 4.1 建築／規則
| key | 名稱 | size | cost | upkeep | workers | 解鎖 | 限制 |
|---|---|---|---|---|---|---|---|
| `airportTerminal`（新） | 機場客運大樓 | 4×3 | 12M | 120k | 180 | 500 | 必須在機場 region |
| `airCargoTerminal`（新） | 空運貨運站 | 3×2 | 4.5M | 40k | 90 | 350 | 機場 region |
| `containerPort`（現有） | 貨櫃碼頭 | 4×3 | 8M | 80k | 30 | 300 | 保持臨水＋道路；在貨櫃碼頭 region 有 throughput bonus |
| `portGate`（新） | 碼頭閘口 | 2×2 | 900k | 8k | 12 | 150 | 貨櫃碼頭 region；提升 port capacity |
| `portYard`（新） | 貨櫃堆場 | 3×2 | 1.4M | 12k | 10 | 200 | 貨櫃碼頭 region；提升 capacity |

- placement.ts：`AIRPORT_BUILDINGS` 必須在 `HK_REGIONS` kind='airport' 的設計座標框內；`PORT_BUILDINGS` 在 'containerPort' 框內（containerPort 若唔在框內仍可建但吞吐 ×0.7？MVP：限制在框內；現有 verify 可能在任何水邊建 containerPort，需要 update tests）。
- render：機場跑道／貨櫃碼頭視覺由 starter-only 改為 **starter 或場內有對應營運建築**；empty 玩家建成後會出現。

### 4.2 Sim（systems-dev 新增 `src/sim/trade.ts`）
```ts
export interface TradeFacilityState { level: number; capacity: number; throughput: number; revenueToday: number; jobs: number; }
export interface TradeState {
  airport: { passengerCapacity: number; passengers: number; cargoCapacity: number; cargo: number; revenueToday: number; jobs: number };
  port: { teuCapacity: number; throughput: number; revenueToday: number; jobs: number };
  lastUpdatedDay: number;
}
```
- 每日：
  - 機場客運 capacity = 9000×客運大樓數（level 升級可 ×1.5）；demand = 800 + 0.25×人口 + 0.6×商業就業；passengers=min(cap,demand×weather)；
    revenue = passengers × $120 + cargo × $180；jobs 由 buildings 計；tourism 令商業需求 +0.05、幸福 +1。
  - 空運貨運 capacity=400 噸/日/貨運站；cargo=min(cap,工業產出×0.2)；revenue × $250/噸。
  - 貨櫃碼頭 throughput = min(cap, (goods消費+出口需求))；TEU cap = 45×containerPort 數 + 30×portGate + 400×portYard? 用簡化：capacity = 45 + 30×gate + 100×yard（每碼頭）；
    revenue=TEU×$280；jobs。
  - 稅收或直接收入入 finance.incomeBreakdown.other（trade）；寫 stats。
  - 加 `stats.airportPassengers?`、`stats.portThroughput?`、`stats.tradeRevenue?`。
- 失敗：容量不足=排隊（收益封頂），機場 8 格無交通 → demand ×0.7；噪音（機場 25 格內住宅地價 −25%、幸福 −8）。
- 升級：每座 airportTerminal/containerPort 可升級 level 1–3（成本 6M/4M）；`upgradeTradeFacility(kind)` 或 `upgradeBuilding(id)` action（MVP：action upgradeTradeBuilding(id)）。

### 4.3 UI
- 建造面板「交通」「物流」加入新機場／碼頭建築；region 無效時提示。
- 頂欄或城事面板新增「航空／海運」卡：機場客流/容量、貨運噸數、碼頭 TEU/容量、每日收入、就業、擴建按鈕、連接道路/交通警告。
- 快捷鍵 `Y` 開貿易面板；手機版 mobile-bar。
- 地圖 highlight region（點建築時）。

---

## 5. 存檔 v6（Lead）

- `GAME_VERSION=6`；compact 存檔：
  - `packTile` bits：bit0 road、bit1 sidewalk、bits2–4 zone、**bit5 waterPipe、bit6 sewerPipe、bit7 powerCable**。
  - `tileEdits` 有 pipe 都要存；hydrate 還原 pipe，並 `utilities=undefined` 重算。
  - GameState 新欄位（transitLines/trade）照舊 state JSON 存放；hydrate 時補 default。
- 舊 480×480 v5 存檔尺寸不符 → 拒絕（提示重新開局）。

---

## 6. 檔案擁有權（避免衝突）

| 區域 | Owner |
|---|---|
| `core/types.ts`、`core/config.ts`、`core/new-game.ts`、`core/store.ts`、`src/main.ts`、`core/save.ts`、`core/starter-town.ts`、`world/worldgen.ts` | **Lead** |
| `tools/build-hk-data.py`、`world/hk-map-data*` | world-dev（task-25） |
| `sim/utilities.ts`、`sim/trade.ts`、`sim/stats.ts`、`sim/production.ts`、`sim/placement.ts`、`sim/finance.ts`、`sim/simulation.ts` | systems-dev |
| `sim/transit.ts`、`sim/vehicles.ts`、`sim/citizen-common.ts`（commute 部分） | transport-dev |
| `ui/transit-panel.ts`、`ui/build-panel.ts`、`ui/help-panel.ts`、`ui/topbar.ts`、`ui/mobile-bar.ts`、`ui/info-panel.ts`、`ui/css/*` | ui-dev |
| `render/underground.ts`（新）、`render/roads.ts`（route overlay 可新增檔案）、`render/terrain.ts`（gate） | world-dev（另行通知） |
| `render/buildings.ts`、`render/interior.ts`、新 3D 模型 | buildings-dev／interiors-dev |
| `transport` 車輛渲染 | transport-dev |
| `docs/*` | game-designer |
| tests/scripts/QA | Lead＋citizens-dev |

**Rules**：唔好改別人檔案；需要新 type/action 先在 task 或訊息提出，由 Lead 加。
QA 期間 Lead 會跑 `tsc`／`npm test`／verify／UI／mobile；任何 agent 完成一階段要 send_message Lead 並保持 tsc 0 error。

---

## 7. 平衡／風險

- 新系統（管網＋路線＋機場碼頭）維護費會令細城市破產 → 人口 <300 時新增維護費 50% 折扣（finance 處理）。
- 地圖 600×600 令 pathfinding cache、sim 掃描成本上升 → systems-dev 現有 typed tile index 要按面積調整。
- 地下管網 save、TileIndex、starter 預建管係最大風險；先做最小可用（水＋電＋污水三種、BFS、容量、UI 圖層），事件（爆管／污染）可第二階段加。
- 舊 verify／UI／mobile 腳本預期 480 及舊行為，切 600/管網後必須由 Lead 更新；所有 agent 唔好改 tests/scripts。

---

*Created by Lead, Round 5. 任何契約變更要先通知 Lead。*
