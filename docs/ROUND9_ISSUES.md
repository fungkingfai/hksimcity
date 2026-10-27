# 《維港之城》Round 9 GitHub Issues 規格（ROUND9_ISSUES.md，v0.9.0）

> 文件版本：1.0（2026-10-27）｜撰寫：game-designer
> 專案：`hk-city/`（GitHub：`fungkingfai/hksimcity`）｜用途：Round 9（v0.9.0）GitHub issues **#17–#20** 的玩法／UX／資料規格、契約、驗收、風險；供 Lead／world-dev／systems-dev／render-dev／ui-dev／QA。
> 依據：GitHub issues #17–#20；HKO 1961–2020 表 6a；`docs/ROUND8_ISSUES.md`、`docs/GAME_DESIGN_HK.md`、`docs/UI_SPEC_HK.md`；`src/world/existing-city.ts`、`src/render/roads.ts`、`src/render/terrain.ts`、`src/sim/time.ts`、`src/sim/trade.ts`、`src/sim/stats.ts`、`src/core/config.ts` 的 `WEATHER_WEIGHTS`／`TRADE_CONFIG`。
> 版本：目標 **v0.9.0／`GAME_VERSION=9`／save v9**（現時 code v0.8.0／GAME_VERSION=8）。
> 標記：**MVP**｜**P2**｜**設計值**｜**現況**。

---

## 0. Issue 狀態與 MVP 範圍

| # | 標題 | 類型 | 本文件 | MVP |
|---|---|---|---|---|
| 17 | 有些區域道路互相連成片，應該係規劃街區、道路包圍街區 | 世界生成／道路 | §1 | block grid＋3 層道路＋existing 300–500 棟 |
| 18 | 天氣警報應參考香港天文台數據（颱風密度／級數） | 模擬／UI | §2 | HKO 月表＋1/3/8/9/10＋暴雨＋轉換＋影響 |
| 19 | 飛機沒有飛；機場飛機應該密集飛 | Render／玩法 | §3 | 航班動畫＋密度跟客流／貨運＋颱風停飛 |
| 20 | 用 CSDI 3D-BIT00 提供大量香港特色建築 | 資料／render | §4 | 抽取 80–150 座高樓 3DS → landmark LOD；sim 用現有 key |

---

## 1. #17 規劃街區（Block Grid）

### 1.1 問題

- Round 8 `existing-city.ts` 用 roadHint components 抽樣鋪路，再 densify；玩家見到「道路互相連成片」，冇清楚街區（block）邊界。
- Issue 期望：**道路包圍街區**，街區內有建築／後巷，唔好成個區域都係馬路。

### 1.2 街區模型（MVP）

| 概念 | 尺寸（tile，112m/tile） | 實際大小 | 用途 |
|---|---|---|---|
| `superblock` 大街區 | 10×10 | ≈1.12km × 1.12km | 新市鎮／工業區／大型屋邨 |
| `block` 標準街區 | 6×6 | ≈670m × 670m | 住宅／商業混合（最常見） |
| `pocket` 小街區 | 4×4 | ≈450m × 450m | 舊區／鄉村／高密度舊樓 |

- 道路層級（沿用 Round 8 `Tile.roadClass`）：
  - **arterial 主幹道**：沿 block 邊界，闊 3.2，兩邊行人路；包圍 superblock；
  - **street 街區路**：block 之間，闊 2.2，單邊行人路；包圍每個 block；
  - **alley 後巷**：block 內部，闊 1.4、冇標線、冇行人路（或單邊窄），只作建築後門／消防通道。
- **道路包圍街區**：arterial／street 形成閉合框；block 內部只有 alley，唔可以有一條 street 直接穿過 block。
- `Tile.blockId?: number`（Round 9 新欄位）標記 block 內部格；`Tile.roadClass` 標記道路；建築 `Building.blockId?`（可選，統計用）。

### 1.3 生成規則（MVP）

1. **主幹骨架**：以 spawn 為中心，沿 roadHint 最大 component／地形平坦走廊，每隔 **8–12 tile** 放 arterial（南北／東西），形成 superblock 框；cap 12–18 條。
2. **街區切割**：superblock 內按 landuse 切 `block`（6×6）或 `pocket`（4×4）；邊界街 street；block 內部 alley 由 block 中心十字或 T 形連到街（唔可以穿出 block 外）。
3. **block landuse**：由該 block 內 landuse 多數票決定：
   - residential（1/2/3）→ 住宅 block；
   - commercial（11）→ 商業 block；
   - industrial（21/22/23）→ 工業 block；
   - open space（32）／GIC（31）→ 公園／設施 block；
   - 其他 → 混合／保留空地。
4. **密度**：block 內平均 `density`（0..255）分 3 級：高 ≥140、中 70–139、低 <70。
5. **建築數量**：
   - 每個 block 生成 `clamp(round(blockArea / 12 × densityFactor), 2, 14)` 棟；
   - densityFactor：高 1.3、中 1.0、低 0.7；
   - 全 starter 目標 **300–500 棟**（issue #17；現時 572 → 下調）；
   - 高密度 block 可出 2×2 公屋／商廈，低密度 1×1 唐樓／村屋。
6. **貼路**：每棟 building footprint 正交外側要有 street 或 alley；arterial 兩旁可放商業（frontage），但唔可以塞滿。
7. **道路總量**：arterial 220–320 格、street 800–1,100 格、alley 400–600 格；全 starter 道路 **1,400–2,000 格**（比 Round 8 的 1,900–2,400 再收緊；唔好再現「連成片」）。
8. **連通**：生成後 BFS；arterial＋street 必須同一 component；alley 可以係 cul-de-sac（死胡同）但要接入 street；existing building 貼路率 ≥95%。
9. **避開**：深圳參考區、水域、山地、spawn 20 格、機場／碼頭／鐵路預留區。
10. **地形**：沿海／山邊 block 可削角（唔規則），但 blockId 仍然連續；斜坡 block 用梯級 street。

### 1.4 對其他系統的影響

| 系統 | 影響 |
|---|---|
| 交通 | block 內 alley 只限慢車／緊急車輛；巴士／小巴只行 arterial／street，站點放 block 角位（arterial×street 交界）；行人路沿 arterial／street |
| 管網 | 水管／污水／電纜沿 street／arterial 鋪，block 內 alley 只鋪分支；utility 接駁建築要經 alley 分支（唔可以穿 block 中心） |
| 分區 | 玩家新劃分區不受 block grid 限制；blockId 只影響 existing city 生成／UI 統計 |
| 鐵路 | 鐵路可穿 block（地下／高架）或沿 arterial；mtrStation 放在 block 角 |
| 機場／碼頭 | 唔套用 block grid；保留大型設施區域 |
| Render | block 邊界 overlay（debug／規劃模式，P2）；現有 building 按 block 排列，唔再貼到成排 arbitrary |
| UI | 城事／世界統計顯示「街區 N 個 · 道路 X 格 · 現有樓宇 Y 棟」；blockId 用 hover debug（P2） |

### 1.5 資料契約（#17）

| 項目 | 建議 | 狀態 |
|---|---|---|
| `Tile.blockId?: number` | block 內部格；道路格 = -1／undefined | 待加 |
| `Tile.roadClass` | arterial／street／alley（Round 8 已定） | 待加（Round8） |
| `Building.blockId?: number` | 統計／debug | 待加（optional） |
| `GameState.existingCity?: ExistingCityStats` | blocks／roads／buildings／facilities／components | 待加（可在 runtime） |
| `existing-city.ts` options | `blockSizes`／`targetBuildings:300–500`／`roadBudget:1400–2000` | 待改 |
| `GAME_VERSION` | **9**（v0.9.0）；save v9（若 block 資料要存） | 待 Lead |
| UI | 城事顯示 block 統計；debug overlay（P2） | 待做 |

### 1.6 驗收（#17）

- [ ] starter 生成街區：arterial 220–320、street 800–1,100、alley 400–600，總道路 ≤2,000 格；每條 street／arterial 形成閉合 block 邊界；alley 只在 block 內。
- [ ] existing building 300–500 棟；每棟貼 street／alley（≥95%）；block 內建築排列整齊，唔會「成條街都係樓」。
- [ ] 道路唔會再「互相連成片」：arterial 之間有 block，唔係全部 1 格密路。
- [ ] 交通：巴士只行 arterial／street；站點在 block 角；市民可通勤。
- [ ] 管網：水管／污水／電纜沿道路，block 內 alley 有分支；utility 接駁正常。
- [ ] 1920×1080 aerial screenshot `round9-block-grid.png`（before v0.8.0 vs after）；block 邊界清晰。
- [ ] `tsc`、existing-city tests、starter 60fps；save v9 讀寫一致。

### 1.7 MVP／P2

- MVP：block grid 生成、3 層道路、300–500 棟、貼路、交通／管網適配、統計、save v9。
- P2：玩家規劃街區工具（畫 block 邊界）、block 高度／地積比、街道家具、block 內公園／學校自動配置、debug overlay。

---

## 2. #18 HKO 颱風／暴雨天氣系統

### 2.1 HKO 1961–2020 表 6a（月平均發出信號日數）

> 來源：香港天文台「1961-2020 年香港天文台發出熱帶氣旋警告信號的月平均日數」<https://www.hko.gov.hk/tc/informtc/tcStatTable6a.htm>（2026-10 抓取）。「-」＝無記錄。

| 月份 | 一號或以上 | 三號或以上 | 八號或以上 | 九號或十號 |
|---|---|---|---|---|
| 1–3 月 | – | – | – | – |
| 4 月 | 0.18 | 0.07 | – | – |
| 5 月 | 0.48 | 0.32 | 0.08 | 0.02 |
| 6 月 | 1.98 | 0.97 | 0.20 | 0.02 |
| 7 月 | 3.85 | 2.23 | 0.60 | 0.08 |
| 8 月 | 3.75 | 1.80 | 0.67 | 0.17 |
| 9 月 | 4.17 | 2.18 | 0.62 | 0.10 |
| 10 月 | 2.53 | 1.57 | 0.22 | 0.05 |
| 11 月 | 0.53 | 0.22 | 0.03 | – |
| 12 月 | 0.03 | 0.03 | – | – |
| **年值** | **17.52** | **9.38** | **2.42** | **0.43** |

### 2.2 由 HKO 表 → 遊戲機率（設計值）

遊戲 1 個月＝7 日；為保留 HKO 每月信號日數比例，**每月事件機率 ≈ HKO 月日數 / 7**（一個月 7 格日）；每日最多一個 active TC；事件可以跨 1–3 遊戲日。

| 月份 | p(1+ 信號) | p(3+) | p(8+) | p(9/10) | 條件升級（3+→8+→9/10） |
|---|---|---|---|---|---|
| 4 | 2.6% | 1.0% | 0% | 0% | 3+ 39%→8+ 0 |
| 5 | 6.9% | 4.6% | 1.1% | 0.3% | 3+ 67%→8+ 25%→9/10 25% |
| 6 | 28.3% | 13.9% | 2.9% | 0.3% | 3+ 49%→8+ 21%→9/10 10% |
| 7 | 55.0% | 31.9% | 8.6% | 1.1% | 3+ 58%→8+ 27%→9/10 13% |
| 8 | 53.6% | 25.7% | 9.6% | 2.4% | 3+ 48%→8+ 37%→9/10 25% |
| 9 | 59.6% | 31.1% | 8.9% | 1.4% | 3+ 52%→8+ 28%→9/10 16% |
| 10 | 36.1% | 22.4% | 3.1% | 0.7% | 3+ 62%→8+ 14%→9/10 23% |
| 11 | 7.6% | 3.1% | 0.4% | 0% | 3+ 42%→8+ 14% |
| 12 | 0.4% | 0.4% | 0% | 0% | 3+ 100% |

- 年值對照：預期 1+ 信號 ≈17.5 日／遊戲年、8+ ≈2.4 日；與 HKO 年度值一致。
- 風季（7–9 月）1+ 信號日多，1–3 月幾乎冇；與香港一致。
- **暴雨**：獨立於信號；每遊戲日：
  - 黃雨：rain 或 storm 時 25%／12%；
  - 紅雨：黃雨持續 + 強度 ≥0.6 時 18%；
  - 黑雨：紅雨 + 強度 ≥0.85 時 10%；
  - 8+ 信號時黑雨機率 +10%；暴雨可同風球並存。
- RNG：以 `state.seed`＋`clock.totalDays`＋月／日 deterministic；不可 save-scum？可接受；測試用固定 seed。

### 2.3 信號級數與定義（HKO）

| 信號 | 名稱 | 風力／意義 | 遊戲效果 |
|---|---|---|---|
| 1 | 一號戒備信號 | 熱帶氣旋進入 800km 範圍 | 戶外活動提示；渡輪可能加班；無停航 |
| 3 | 三號強風信號 | 持續風力 41–62 km/h | 巴士／小巴減班 20%；渡輪部分停航；地盤暫停戶外吊運；學校課外活動取消 |
| 8NE | 八號東北烈風或暴風信號 | 風力 63–117 km/h，東北方向 | 渡輪全停；巴士／小巴停駛或只維持主幹；地盤停工；機場關閉；碼頭停裝卸；商店關門；市民回家 |
| 8NW | 八號西北烈風或暴風信號 | 同上，西北 | 同上（風向影響雨帶／航班） |
| 8SE | 八號東南烈風或暴風信號 | 同上，東南 | 同上 |
| 8SW | 八號西南烈風或暴風信號 | 同上，西南 | 同上 |
| 9 | 九號烈風或暴風風力增強信號 | 風力進一步增強 | 8 號效果＋公共交通完全停駛、市民留家、緊急服務有限 |
| 10 | 十號颶風信號 | 持續風力 ≥118 km/h | 9 號效果＋全市停工、停課、停市；建築損毀事件、山泥傾瀉風險 |
| 黃雨 | 黃色暴雨警告 | 每小時雨量 30mm+ | 低窪地區水浸提示；交通慢駛 10% |
| 紅雨 | 紅色暴雨警告 | 50mm+ | 學校停課；部分道路水浸；交通 −25%；地盤停工 |
| 黑雨 | 黑色暴雨警告 | 70mm+ | 全市停工停課；交通 −40%；水浸／山泥傾瀉事件；機場／碼頭受影響 |

### 2.4 天氣系統 transition（MVP）

```
狀態機（每日 roll，或 clock 過日）：
  idle  --p(1+)--> signal1（1–2 遊戲日）
  signal1 --p(3+|1+)--> signal3（1–2 日）
  signal3 --p(8+|3+)--> signal8_{NE|NW|SE|SW}（0.5–1.5 日）
  signal8 --p(9/10|8+)--> signal9 或 signal10（0.25–0.75 日）
  signal8/9/10 --> 降級 signal3 --> signal1 --> idle（每級 0.5–1 日）
  任何時候可並存 rainstorm warning；暴雨警告 3–9 遊戲小時
  8+ 信號期間唔會再開新 TC；同一時間只有一個 active TC
```

- 風向：8 號方向影響雨帶／航班跑道（NE／SE 較多雨；NW／SW 較乾）；遊戲用方向修飾機場／碼頭效率 ±5%。
- 預報：發出前 1 遊戲日有「天文台預告」log；信號升級／降級有 toast；topbar 信號 icon＋顏色（1 黃、3 橙、8 紅、9/10 紫黑）。
- 與現有 `Weather='storm'` 的關係：
  - `Weather` 保留（render 用 storm 雨／風）；
  - 新增 `TyphoonSignal`／`TyphoonState`；`Weather='storm'` 只在信號 8+ 時使用；1／3 信號用 `rain`／`cloudy` + wind strength；
  - `stats.typhoonSignal` 由 0/1/3/8 擴展到 0/1/3/8/9/10（8 加方向可由 `typhoon.direction` 提供）。
- 持續時間：1 信號 1–2 日、3 信號 1–2 日、8 信號 0.5–1.5 日、9/10 0.25–0.75 日；整體事件 2–5 遊戲日（唔會一個月全部落雨）。
- 影響：
  - 交通：按信號級數逐步停駛（見表）；MTR 地下段 8+ 仍可維持 70–90%（P2 分 grade）；渡輪 8+ 全停；機場 8+ 關閉；貨櫃碼頭 8+ 停裝卸。
  - 機場：8+ 取消所有航班（#19）；1/3 延誤 10–30%。
  - 碼頭：8+ 停裝卸；之後 1 日效率 ×0.7。
  - 地盤／工業：8+ 停工；戶外建築 production ×0。
  - 市民：8+ 幸福 −8、留家；9/10 −15；暴雨紅／黑 −3／−6；學校停課。
  - 災害：8+ 每日 5% 棚架／招牌損毀；黑雨／9+ 每日 3% 山泥傾瀉（山邊建筑受損）；10 號 10% 停電。
  - 經濟：機場／碼頭收入 0；零售／服務收入 −30%；維修支出 +。
- UI：
  - Topbar 天氣 chip 顯示信號（1/3/8NE/9/10）＋暴雨顏色；
  - 天氣面板（P2）詳細：HKO 來源、信號定義、預報、影響清單；
  - log／toast 用 HKO 正式文案：「天文台發出八號東北烈風或暴風信號」；
  - 教學提示：8 號風球停工停課、留家。
- 資料來源（文件引用）：
  - HKO 表 6a：<https://www.hko.gov.hk/tc/informtc/tcStatTable6a.htm>
  - HKO 警告定義：<https://www.hko.gov.hk/tc/wservice/warning/details.htm>
  - MTR 颱風安排：<https://www.mtr.com.hk/ch/customer/main/typhoon_readiness.html>
  - 颱風交通指南：<https://www.fortress.com.hk/zh-hk/promotion/buying-guides/typhoon-transport-services>

### 2.5 資料契約（#18）

| 項目 | 建議 | 狀態 |
|---|---|---|
| `TyphoonSignal = 0|1|3|8|9|10` | 信號級數 | 待加 |
| `TyphoonDirection = 'NE'|'NW'|'SE'|'SW'` | 8 號方向 | 待加 |
| `RainstormWarning = 'none'|'amber'|'red'|'black'` | 暴雨 | 待加 |
| `TyphoonState` | `{ signal, direction, rainstorm, issuedAt, expectedEndAt, activeTcId, forecastNext }` | 待加 |
| `GameState.typhoon?: TyphoonState` | 當前事件 | 待加 |
| `GameStats.typhoonSignal` | 已存在（0/1/3/8）；擴展 9/10＋方向 | 改 |
| `GameStats.rainstormWarning` | 暴雨級別 | 待加 |
| `GameActions` | 冇玩家操作（自動）；可 `dismissTyphoonToast()`（P2） | P2 |
| `UIState` | `showWeatherPanel?: boolean`（P2）；topbar 用 stats | 待加 |
| `sim/typhoon.ts`（新） | `tickTyphoon(state)`：HKO 機率、狀態機、影響 flags | 待做 |
| `HKO_TYPHOON_TABLE` | config 常數：12 個月的 4 個日數＋派生機率 | 待加 |
| Save | **v9**：`typhoon` 入 state；舊 v8 拒絕／遷移 | 待做 |
| Render | storm 雨／風已有；8+ 燈光／旗／UI | P2 |

### 2.6 驗收（#18）

- [ ] HKO 月表 12 個月數值正確（chart 對照）；每月 p(1+)／p(8+) 符合 §2.2。
- [ ] 固定 seed：1–3 月幾乎冇 TC；7–9 月頻密；8+ 信號會出現 NE／NW／SE／SW；9/10 罕見。
- [ ] 狀態機 1→3→8→9/10→降級，冇跳級（除非直接 8？HKO 可以 3→8；MVP 不可 1→8）；8+ 唔會同時有第二個 TC。
- [ ] 暴雨黃／紅／黑可獨立並存；暴雨／風球同時影響疊加正確。
- [ ] 交通／機場／碼頭／地盤／市民效果符合 §2.4；topbar 文案／toast 正確。
- [ ] Save v9 保存／讀取後信號／暴雨／剩餘時間一致；重新載入唔會重置。
- [ ] Playwright screenshot `round9-typhoon-signal8.png`、`round9-rainstorm-black.png`；`tsc`／typhoon tests 通過。

### 2.7 MVP／P2

- MVP：HKO 表、1/3/8（4 方向）/9/10、暴雨 3 級、狀態機、基本影響、UI topbar／toast、save v9。
- P2：天氣面板詳細、風向影響航班跑道、MTR 分段停駛、災害事件動畫、預報 24 小時、歷史統計。

---

## 3. #19 機場航班／飛機動畫

### 3.1 問題

- 現時機場只有 **2 架靜態飞机**（`terrain.ts` airportDecor planes），唔會飛；玩家期望機場飛機密集起降，密度跟旅客量／貨運量。
- 需保持效能（instanced／LOD），唔可以每班機一個 mesh／材質。

### 3.2 航班資料模型（MVP）

```ts
export type FlightKind = 'arrival' | 'departure';
export interface AirportFlight {
  id: number;
  kind: FlightKind;
  airline: 'cathay' | 'hke' | 'cargo' | 'generic'; // 塗裝
  aircraft: 'narrow' | 'wide' | 'cargo';
  runway: 0 | 1;             // 赤鱲角雙跑道
  gate: number;              // 0..N
  passengers: number;
  cargoTons: number;
  /** render 用世界座標／高度／航向 */
  x: number; y: number; z: number; heading: number;
  /** 0..1 航段進度（approach／landing／taxi／takeoff／climb） */
  phase: 'approach' | 'landing' | 'taxi' | 'takeoff' | 'climb';
  progress: number;
  delayMinutes: number;
}

export interface AirTrafficState {
  flightsPerDay: number;
  activeFlights: AirportFlight[];
  lastScheduleDay: number;
  grounded: boolean;         // 8 號風球
}
```

- `GameState.airTraffic?: AirTrafficState`（runtime；可重生）；`GameStats.airportFlights?`／`activeAircraft?`。
- 航班量：
  ```
  passengers = state.stats.airportPassengers (trade.ts 已算)
  cargoTons  = state.stats.airCargoTons
  flightsPerDay = clamp(ceil(passengers / 180) + ceil(cargoTons / 40), 0, 320)
  ```
  （180 人／窄體、330／廣體；40 噸／貨機；由 trade.ts 更新）。
- 密度：機場畫面同時最多 **12–20 架**（視乎 LOD）；航班按每日 schedule 均勻分佈（06:00–24:00）；8 號風球 grounded → 0 active、飛機停泊。
- 航線／航道：
  - 2 條跑道（赤鱲角真實雙跑道）；arrival 由南／西南海面進場，final approach 對齊跑道；departure 起飛後爬升向東／北；
  - MVP 用 Catmull-Rom／二次曲線控制點；每班機有 approach path→landing→taxi（縮短）→gate；departure gate→taxi→takeoff→climb；
  - 唔需要真實 ATC；航班延誤由天氣／容量決定。
- 飛機模型／塗裝：
  - 3 種 shared geometry：narrow（A320 類）、wide（B777 類）、cargo（貨機）；
  - 3–4 個 shared material 塗裝：國泰綠白、HK Express 紫白、貨機灰、generic；
  - 用 InstancedMesh 或 per-flight `Object3D` clone shared geometry（draw calls ≤8）；夜間導航燈（紅／綠）用 shared small mesh；
  - LOD：距離 >250 世界單位用 1 個 box + 翼；<250 用完整模型；>600 唔 render。
- 效能上限：
  - 活動航班 ≤20；aircraft draw calls ≤8（3 機型×塗裝 batch）；每幀只 update transform，唔重建 geometry；
  - 機場關閉時 hide 全部；empty 模式只有玩家建機場先有。
- 颱風：signal ≥8 → grounded，航班取消，飛機停留 gate（或消失）；1/3 信號延誤 10–30%；暴雨延誤 10%。
- UI：機場面板顯示 flights/day、active aircraft、grounded 提示；hover 飛機顯示航班（P2）。
- 與 trade.ts 整合：`tickTrade` 已算 passengers/cargo；新增 `tickAirTraffic` 用 stats；render 由 `terrain.ts` airportDecor 改為獨立 `render/air-traffic.ts`。

### 3.3 資料契約（#19）

| 項目 | 建議 | 狀態 |
|---|---|---|
| `AirportFlight`／`AirTrafficState` | 航班 runtime | 待加 |
| `GameState.airTraffic?` | runtime；save 可唔存（重生） | 待加 |
| `GameStats.airportFlights?`／`activeAircraft?` | UI | 待加 |
| `render/air-traffic.ts`（新） | 3 機型 shared geometry／材質、LOD、航道 | 待做 |
| `sim/trade.ts` | 已算 passengers/cargo；加 flightsPerDay | 改 |
| `tickAirTraffic(state)` | schedule／spawn／update | 待做 |
| `UIState` | 機場面板已有（`showTradePanel`），加 flights 顯示 | 改 |
| Save | 唔需要存 active flights（重生）；v9 可存 seed／lastScheduleDay（optional） | P2 |
| 颱風 | signal≥8 grounded；1/3 delay | 待做 |

### 3.4 驗收（#19）

- [ ] 機場有客運／貨運大樓時，飛機按客流／貨運量起降；flights/day 顯示與 trade 數字一致。
- [ ] 同時最多 12–20 架；arrival approach→landing→gate、departure gate→takeoff→climb；2 條跑道都有使用。
- [ ] 8 號風球：全部停飛、飛機停留 gate；1/3 信號延誤；暴雨延誤。
- [ ] 3 種機型＋3–4 塗裝；夜間導航燈；LOD 正常；aircraft draw calls ≤8。
- [ ] 1920×1080 screenshot `round9-airport-traffic.png`（日／夜、8 號停飛）；`tsc`／render tests 通過；60fps。
- [ ] 機場面板顯示 flights/day／active aircraft；hover 航班（P2）。

### 3.5 MVP／P2

- MVP：航班資料、密度、2 跑道、3 機型／塗裝、LOD、颱風停飛、面板數字、截圖。
- P2：航班 schedule 表、延誤原因、航空公司品牌、跑道燈光、ATC 語音、乘客上落機動畫、機場快線接駁。

---

## 4. #20 CSDI 3D-BIT00 香港特色建築

### 4.1 資料集

- 來源：**LandsD 3D Spatial Data（3D-BIT00）**，經 CSDI Portal 開放：
  - <https://portal.csdi.gov.hk/geoportal/#metadataInfoPanel>
  - 3DS tiles：`...dataset_id=landsd_rcd_1637306559892_42396&format=geojson&layer_name=b1000_Tile`
  - Individualised models：`...dataset_id=landsd_rcd_1671676915450_88604&format=geojson&layer_name=Individualised_models`
- 規格（issue／Lead）：
  - 全港 3DS tiles 約 **2,054 個**，每個 **750m × 600m**；
  - 真實 HK1980 座標，含 Building ID；
  - 檔案為 ZIP（3DS + metadata），可 HTTP Range 讀 central directory，**唔需要下載全部**；
  - 3DS 幾何 chunk：`0x4110` vertex list、`0x4120` face list。
- 目標：由 3D-BIT00 抽取 **80–150 座**香港特色高樓（中環／尖沙咀／觀塘／銅鑼灣／旺角等），作為 landmark 3D 模型；**唔改模擬玩法**，sim 統計用現有 BuildingDef key。

### 4.2 抽取流程（離線工具 `tools/fetch-3d-bit00.mjs` 或 Python）

```
1. 讀 CSDI b1000_Tile metadata（GeoJSON）：2,054 tiles，HK1980 bbox＋tile id
2. 按 spawn／landmark 區選 tile（中環、尖沙咀、觀塘、銅鑼灣、旺角、荃灣、沙田）
3. HTTP Range：下載每個選中 ZIP 的 central directory／EOCD，只 extract 目標 3DS entry
4. parse 3DS：
   - 0x4110：vertex list（x,y,z，tile local coord）
   - 0x4120：face indices
   - 0x4160：local transform（可選）
5. 篩選：高度 ≥80m、footprint ≥400m²、非住宅屋苑（優先地標／商廈／酒店）
6. 座標：tile local → HK1980 → 96 design（同 worldgen designToTile）；記錄 building id
7. 簡化：頂點焊接、face 合併、LOD0 ≤8k tris、LOD1 ≤1.5k tris、LOD2 box
8. 輸出 `src/world/hk-3d-landmarks.generated.ts`（或 GLB）
   - { id, name?, sourceTile, buildingId, x, y, height, footprint, lods: [...] }
9. 授權註明：CSDI／LandsD 3D-BIT00，data.gov.hk 條款
```

- 座標：3D-BIT00 tile 750×600m 內 relative；用 tile HK1980 原點＋offset；再 `HK1980 → design 96`（同 `tools/build-hk-data.py` 公式）。
- 放置規則：
  - 只放喺地圖陸地、非深圳參考區、非水域；
  - 優先中環（IFC／中銀／滙豐）、尖沙咀（ICC 對岸）、觀塘、銅鑼灣、旺角；
  - 避免覆蓋 player 可建區？landmark 只作視覺，唔佔 tile（或放在 tile.density 高但 buildingId=-1 的格）；
  - 與 existing building 重疊：如果該格已有 `Building`，skip 3D landmark（或 landmark 只作遠景）；
  - cap **120 座**；每座有 LOD0/1/2；總 tris ≤1.2M（目標 ≤600k）。
- Sim stats：
  - 沿用現有 key：根據高度／用途映射 `officeTower`／`privateEstate`／`publicHousing`／`hotel`（如有）等；`stats` 顯示「3D 地標 N 座」；
  - 不新增 BuildingDef、不新增 gameplay 收入；可作旅遊吸引力（P2）；
  - 如果 landmark 要可選／可拆，才需要 `Building.existing=true`；MVP 只視覺。
- Render：
  - 獨立 `render/landmarks3d.ts`；3 LOD groups；distance >800 用 LOD2／hide；frustum culled；
  - 材質：shared vertex-colored／貼圖 atlas；玻璃幕牆用 emissive 夜光（低強度）；≤8 draw calls；
  - 只在 starter + 玩家建成機場？→ 全域 show；empty 都可見（地理 landmark 唔算人造城市建設）？Issue 想「大量香港特色建築」，建議 **所有模式都顯示地標**（唔影響 empty 0 建築規則，因為只視覺）；如果 empty 要完全乾淨，可 `empty` 都顯示山頂／地標（現有 HK_LANDMARKS 已顯示）；文件列兩種，建議 always show。
- 授權／來源標註：
  - 遊戲 credits／README：資料來源 CSDI／LandsD 3D-BIT00；
  - 原始 3DS 不入 repo；只 commit 簡化後的 generated 檔；
  - data.gov.hk 條款：<https://data.gov.hk/en/terms-and-conditions>。

### 4.3 資料契約（#20）

| 項目 | 建議 | 狀態 |
|---|---|---|
| `src/world/hk-3d-landmarks.generated.ts` | `Landmark3D[]`（id／name／design x,y／height／lods） | 待生成 |
| `Landmark3D` type | `{ id, name, x, y, height, footprint, sourceTile, buildingId, lods }` | 待加 |
| `MapData.landmarks3d?` | 可選：generated 分開檔，唔入 MapData | 建議分開 |
| `GameState.landmarks3d?` | runtime placement（可重生，唔存 save） | P2 |
| `GameStats.landmark3dCount?` | UI／統計 | 待加 |
| `render/landmarks3d.ts` | 3 LOD＋instancing／merged geometry | 待做 |
| `tools/fetch-3d-bit00.mjs`（新） | Range ZIP／3DS parser／simplify／output | 待做 |
| Sim BuildingDef | 唔新增；映射現有 key（officeTower 等） | ✅ 設計 |
| Save v9 | 唔需要存 3D landmark（generated 重生）；只 commit 生成檔 | P2 |
| Credits | CSDI／LandsD 3D-BIT00 來源標註 | 待做 |

### 4.4 效能與 LOD

| 項目 | 目標 |
|---|---|
| 3D landmark 數量 | 80–150（cap 120） |
| 總 tris | ≤600k（LOD0）；LOD1 ≤150k；LOD2 box |
| Draw calls | ≤8（merged by material／LOD） |
| 視距 | >800 世界單位 hide／LOD2；中景 LOD1；近景 LOD0 |
| 材質 | shared vertex colors＋emissive windows；唔好每座樓一個 material |
| 陰影 | LOD0 近景才 castShadow；其餘 off |
| Load | 生成檔 ≤2MB；首次解碼 ≤20ms |
| 其他 | 不影響 sim／pathfinding；landmark 只視覺 |

### 4.5 驗收（#20）

- [ ] 工具可以只下載選中 tiles（Range），生成 80–150 座 landmark；輸出檔可 commit；原始數據不入 repo。
- [ ] 中環／尖沙咀／觀塘 landmark 位置正確（對照真實座標）；唔會喺深圳／水域／地圖外。
- [ ] 3 級 LOD、draw calls ≤8、總 tris ≤600k；starter overview 60fps；夜間玻璃發光正常。
- [ ] Sim stats 顯示 3D 地標 N 座；唔新增 BuildingDef／收入；empty 模式仍為 0 建築（3D landmark 只視覺，可選擇隱藏）。
- [ ] 授權註明；`tsc`／render tests；截圖 `round9-3d-bit00-landmarks.png`（中環天際線）。
- [ ] 與現有 6 個 HK_LANDMARKS（山頂／大佛／摩天輪等）唔重複／可共存。

### 4.6 MVP／P2

- MVP：Range 抽取工具、80–120 座 landmark、3 LOD、render、位置驗證、授權、stats。
- P2：更多 landmark、可選 landmark 遊覽、旅遊吸引力加成、interior 地標、動畫（摩天輪／渡輪）。

---

## 5. 共通契約與版本（v0.9.0）

| 項目 | 內容 |
|---|---|
| `GAME_VERSION` | **9**（v0.9.0；現時 8，待 Lead bump） |
| Save v9 | `typhoon`（signal／direction／rainstorm／時間）＋UIState 新 flags；airport flights 不必存（重生）；3D landmark 由 generated 重生；舊 v8 拒絕／遷移 |
| `Tile` | `blockId?: number`（#17）；`roadClass`／`roadGrade`（Round 8 已有） |
| `GameState` | `typhoon?: TyphoonState`、`airTraffic?: AirTrafficState`、`landmarks3d?`（P2） |
| `GameStats` | `typhoonSignal`（擴展 9/10＋方向）、`rainstormWarning`、`airportFlights?`、`activeAircraft?`、`landmark3dCount?` |
| `GameActions` | 冇新玩家 action（天氣自動）；機場／3D 只顯示；面板 toggle（`showWeatherPanel` P2） |
| `UIState` | `showWeatherPanel?`（P2）；topbar 用 stats |
| Render | `air-traffic.ts`、`landmarks3d.ts`、topbar 信號 chip、block debug overlay（P2） |
| 文件 | 全部 Round 9 docs 標 **v0.9.0**；`ROUND9_ISSUES.md` 主規格 |

---

## 6. 驗收汇总與截圖

| # | tsc/tests | Playwright | Screenshot |
|---|---|---|---|
| 17 | existing-city tests | 1920×1080 | `round9-block-grid.png`（before/after） |
| 18 | typhoon tests | 1280×800 | `round9-typhoon-signal8.png`、`round9-rainstorm-black.png` |
| 19 | render/trade tests | 1280×800、1920×1080 | `round9-airport-traffic.png`（日／夜／8 號） |
| 20 | parser/render tests | 1920×1080 | `round9-3d-bit00-landmarks.png` |

---

## 7. 風險與 MVP／P2 總表

| 風險 | 影響 | 對策 |
|---|---|---|
| HKO 機率太密／太疏 | 風季太多或太少風球 | 用 §2.2 月度機率＋年度 17.52 日對照；QA 用固定 seed 統計；可調 `HKO_SCALE` |
| 8 號風球太頻密影響遊戲節奏 | 每次事件 2–5 日、玩家停擺 | 每月最多 1 個 active TC；8 號持續 0.5–1.5 日；提供預告 1 日 |
| 天氣影響疊加（風＋黑雨） | 經濟／幸福崩潰 | 影響 cap（交通 −60%、幸福 −15）；分開顯示 |
| 街區生成太規則 | 玩家覺得唔自然 | block 尺寸 3 種＋landuse／地形削角；保留 roadHint 真實走向 |
| existing 300–500 棟少過 Round 8 572 | 城市感覺變空 | 高密度 block 提高每 block 棟數；補 landmark／3D 建築；QA 視覺對照 |
| 飛機 draw calls／效能 | FPS 下降 | ≤20 架、shared geometry／material、LOD、≤8 draws |
| CSDI 3D-BIT00 下載／授權 | 地圖檔太大、授權問題 | Range ZIP、只做 80–120 座、簡化 LOD、不入 repo 原始；標註來源 |
| 3D landmark 座標錯 | 建築落海／落深圳 | 用 HK1980→design 同一轉換；bbox 檢查、QA 對照 |
| Save v9 兼容 | 舊檔讀取 | v8 拒絕並提示；typhoon 狀態可重生；UI 新 flags default |
| 版本混亂 | code v8 vs docs v9 | 文件標 target；Lead bump |

- **MVP**：#17 block grid＋3 層道路＋300–500 棟；#18 HKO 表＋信號＋暴雨＋影響；#19 航班動畫＋密度＋颱風；#20 3D-BIT00 80–120 座 landmark＋LOD。
- **P2**：玩家規劃街區工具、天氣面板／預報、航空公司 schedule、3D landmark 遊覽／旅遊加成、MTR 分段停駛、災害動畫。

---

*文件結束。與 `GAME_DESIGN_HK.md` §21、`UI_SPEC_HK.md` §25、`ROUND8_ISSUES.md`、`REAL_GEO_DATA.md` 一併使用；版本目標 **v0.9.0／save v9**。*
