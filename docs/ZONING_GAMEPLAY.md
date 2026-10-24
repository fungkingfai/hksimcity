# 《維港之城》分區玩法規格（ZONING_GAMEPLAY.md）

> 文件版本：1.0（2026-10-22）｜撰寫：game-designer
> 專案：`hk-city/`（《維港之城》，three.js + TypeScript 城市建造）
> 用途：第二輪改版「分區玩法」（SimCity／Cities: Skylines 2 式）的**唯一玩法規格**；`GAME_DESIGN_HK.md`、`UI_SPEC_HK.md` 已同步改版。
> 依據：`src/core/types.ts`、`src/core/config.ts`（`ZONES`／`AUTO_DEVELOP`／`STARTER_TOWN`／19 種 auto 建築／13 種 ploppable 建築）、`src/core/starter-town.ts`、`src/core/new-game.ts`、`src/world/worldgen.ts`、`docs/GAME_DESIGN_HK.md`、`docs/UI_SPEC_HK.md`。
> 標記：**✅ config 已有**｜**⚠️ 待實作（sim／UI／placement）**｜**🕒 v1.1**。

---

## 0. 改版摘要（與上一版最大分別）

| 項目 | 舊版（手動建築） | 新版（分區玩法） |
|---|---|---|
| 玩家操作 | 逐棟選建築、逐棟放 | **鋪路＋劃 4 色分區**，開發商自動起樓 |
| 住宅／商業／工業／農業 | 玩家直接建 | **自動開發**（19 種建築池，按需求＋發展分數＋權重） |
| 公共設施／交通／休憩／地標 | 玩家建 | **仍然玩家手動放置**（13 種 ploppable：警／消／校／醫／發電廠／水務／公園／海濱／港鐵／巴士／電車／渡輪／貨櫃碼頭） |
| 行人路 | 獨立工具（$5,000/格） | **道路整合行人路**：鋪馬路即自帶行人路，取消行人路工具 |
| 開局 | 空地圖＋6 市民 | **兩種模式**：已有城鎮（starter，中環**連通優先道路網**＋34 棟 auto＋10 設施）／由零開始（empty，**完全空地**＋$800 萬＋5 市民） |
| 地理 | 程序化 | **CSDI／地政總署真實數據**（DTM 5m＋342,233 建築輪廓）；可建地 22.4%、水域 75.6% |
| 真實樓群 | 無 | `Tile.density/buildingHeight` 驅動 ~4,089 座現有樓群（starter 才顯示；只視覺） |
| 地圖 | 96×96（9,216 格） | **480×480（230,400 格，面積約 10 倍；`MAP_SCALE=5`）** |
| 導航 | 滑鼠平移 | **minimap（480×480 右下）＋O 全圖／P 市中心**；相機 zoom out ≈1,300 |
| 存檔 | v2 完整 JSON | **v5 compact**（seed＋sparse tileEdits，80–140KB；舊 96×96 不兼容） |
| 核心決策 | 起哪一棟樓 | **劃多少、劃哪裡、先起哪項公共設施**（需求條＋發展分數） |

> 一句話：**玩家是城市規劃師，不是建築商**——你決定土地用途與公共投資，樓宇由市場按需求興建。

---

## 1. 核心循環（分區版）

### 1.1 四層循環

| 層級 | 時間尺度 | 玩家在做什麼 | 系統結算 |
|---|---|---|---|
| **秒級** | 每幀 | 鋪路、刷分區、看需求條、看發展分數、擺公共設施 | 市民／車輛移動、分區色塊預覽、hover 發展分數 |
| **日級** | 30 秒（1×） | 看 RCI+F 需求條、補路、補區、補警／消／校／醫 | **需求更新（每日）→ 自動開發（每日最多 15 棟、每區 6 棟；全城上限 1,200）**、人口／就業／幸福 |
| **月級** | 3.5 分鐘 | 看月報表、調稅率、決定賣地／煙花、補交通 | 稅收、開支、車費、服務收入、月報表 |
| **年級** | 42 分鐘 | 擴張新市鎮、過海發展、追成就 | 四季、颱風季、公屋輪候、地價上升 |

### 1.2 正回饋鏈

```
鋪路（自帶行人路） ─→ 劃住宅區 ─→ 開發商起唐樓/劏房 ─→ 人口↑ ─→ 勞動力↑
   ↑                                                        │
   │                                                        ↓
幸福↑ ←─ 公園/學校/醫院 ←─ 稅收＋車費 ←─ 商業區（便利店/茶餐廳/街市）←─ 需求↑
   │                                                        │
   │                                                        ↓
   └──────── 劃更多分區／起公共設施 ←──── 工業區提供職位＋貨物 ←── 農業區供食品
```

- **需求（RCI+F）** 是油門：需求 ≥ 0.12 開發商才會起樓；需求負數＝供過於求，暫停開發。
- **發展分數（devScore 0–100）** 是品質門檻：供電、供水、警、消、校、醫、交通、幸福、地價愈高，才會出現更高級建築（唐樓→公屋→居屋→私人屋苑→豪宅）。
- **服務覆蓋** 是雙重限制：它既影響 devScore（決定了不起得起高級樓），也影響市民幸福（住了豪宅但無醫院，一樣會搬走）。
- **土地** 是長期上限：分區格數有限、地價隨發展上升、賣地可換一次性現金。

### 1.3 與舊版最大的心態轉變

舊版玩家問「我下一個起咩？」；新版玩家問「**呢一區應該劃住宅定商業？要先起警署定巴士站？**」——玩家管的是**土地與公共投資**，不是逐棟樓。

---

## 2. 操作與工具

### 2.1 建造工具列（只保留 4 類）

| 工具 | key／識別 | 造價 | 行為 |
|---|---|---|---|
| **道路** | `'road'` | **$15,000／格** | 拖曳鋪馬路；**馬路自帶行人路**（`Tile.sidewalk=true`）；不可鋪水域／山地／濕地／沙灘 |
| **分區（4 刷子）** | `'zone:residential'`／`'zone:commercial'`／`'zone:industrial'`／`'zone:farmland'` | 見 §3.1 | 拖曳或點擊刷分區；只可刷在可建、非道路、無建築的格；農業區只可刷在農地／平地 |
| **取消分區** | `'dezone'` | 免費 | 清除空格的分區；有自動建築的格會跳過（提示先拆樓） |
| **拆除** | `'demolish'` | 退還 30% | 拆道路／自動建築／手動建築；拆道路後重算連通性 |

> **已取消**：獨立「行人路」工具（`SIDEWALK_COST` 保留在 config 但 v2 不再使用）；舊版逐棟放住宅／商業／工業建築。

### 2.2 手動置建築（13 種 ploppable）

- 建造面板只顯示 `PLOPPABLE_BUILDINGS`（`ploppable:true`）：公共設施、交通、休憩、貨櫃碼頭。
- 放置規則：需臨路（除公園／海濱長廊）、需臨水（渡輪碼頭、海濱長廊）、只可在港島（電車站）、只可在西岸（貨櫃碼頭）、地形限制。
- 手動建築**不可被開發商取代**；玩家可拆（退款 30%）。

### 2.3 分區刷法

- 點擊單格或按住拖曳連續刷；刷子大小 1×1（v1），🕒 v1.1 可加 3×3／5×5 方形刷。
- 刷區時 hover 顯示：分區色、每格造價、目前 devScore（0–100）、可否刷（地形／道路／建築原因）。
- 分區色塊由 `UIState.showZones` 控制顯示（快捷 **`L`**）；建築上以半透明分區色 tint。
- 分區成本即時從庫房扣，並記入 `expenseBreakdown.infrastructure`；dezone 免費。
- **農田只在 `fertile`／`grass`**；住宅／商業／工業可刷在 `grass`／`urban`／`reclaimed`／`fertile`／`forest`／`hill`（森林需清林、造價倍率見地形），但坡度／濕地／沙灘不可。

### 2.4 道路整合行人路

- 鋪馬路時：該格 `road=true`、`sidewalk=true`；世界生成亦會在馬路兩側預置行人路格。
- 市民尋路可走 road 或 sidewalk；貨車只可走 road。
- 建築連通：`connected = footprint 正交外側有 road 或 sidewalk`；收發貨需 `roadConnected`（臨 road）。
- 分區開發條件：**分區格必須正交鄰接道路**（不接受只鄰接行人路），確保貨車可達。
- 刪除道路該格同時刪行人路；`ROAD_UPKEEP=0`。

### 2.5 開局模式（`GameState.gameMode`）

| 模式 | `gameMode` | 內容 | 適合 |
|---|---|---|---|
| **已有城鎮** | `'starter'` | 中環 spawn（格 **259,299**／設計 51.4,59.4）預建：**連通優先道路網（BFS 分量、全鎮同一路網）**＋四色分區＋**10 項公共設施（學校×2、醫院）＋34 棟自動建築（7 農田、倉庫食品 520）**；庫房 **$6,500,000**；warm-up 10 日、目標 120／實測約 **146 人** | 新手／想看玩法 |
| **由零開始** | `'empty'` | **完全空地圖**：零道路／零建築／零分區、無地標／機場／貨櫃碼頭等任何人造構築物；只有自然地形、樹木、海面船隻；5 名市民（設計）、庫房 **$8,000,000** | 挑戰／舊玩家 |

- 開局選擇畫面由 `UIState.showStartScreen` 控制；選完寫入 `gameMode`，存檔保留。
- 兩種模式**用同一張香港地圖**（中環 spawn），只是一個已發展、一個未發展。

---

## 3. 分區資料與需求（RCI+F）

### 3.1 分區資料表（✅ `ZONES`）

| 分區 | key | 中文 | 每格造價 | 解鎖 | 顏色（UI） | 說明 |
|---|---|---|---|---|---|---|
| 住宅區 | `residential` | 住宅區 | **$1,200／格** | 0 | `#35d07f` 綠 | 劏房→唐樓→公屋→居屋→私人屋苑→豪宅 |
| 商業區 | `commercial` | 商業區 | **$1,500／格** | 0 | `#2fb7ff` 藍 | 便利店→茶餐廳→街市→超市→酒樓→商廈→商場 |
| 工業區 | `industrial` | 工業區 | **$1,500／格** | 0 | `#ffb02e` 橙 | 貨倉→進口商行→食品廠→工廈→石礦場 |
| 農業區 | `farmland` | 農業區 | **$700／格** | 0 | `#9bd44a` 黃綠 | 只可劃在農地／平地；自動建農田 |

> 分區工具 key 用 `zoneTool(zone)` 產生：`zone:residential` 等；`zoneOfTool()` 解析；`'dezone'` 取消分區。

### 3.2 需求（`GameState.zoneDemand`，-1..1）

需求記錄在 `GameState.zoneDemand`（`spawn` 時全 0），每次 `newDay` 更新一次，平滑逼近；同時寫入 `stats.zoneDemand`（UI 用）。

**輸入指標**

| 指標 | 定義 |
|---|---|
| `jobVacancy` | `max(0, jobs − employed) / max(1, jobs)`（職位空缺率） |
| `unemploymentRate` | `unemployed / max(1, employed + unemployed)` |
| `homelessRate` | `homeless / max(1, population)` |
| `housingVacancy` | `max(0, housingCapacity − population) / max(1, housingCapacity)` |
| `happinessFactor` | `clamp((happiness − 50) / 50, −1, 1)` |
| `landValueFactor` | `clamp((landValue − 50) / 50, −1, 1)` |
| `populationFactor` | `clamp(population / 1000, 0, 1)` |
| `shoppingUnmet` | `clamp(1 − commercialServiceCapacity / max(1, population × 0.12), 0, 1)` |
| `goodsUnmet` | `clamp(1 − goodsStockDays / 6, 0, 1)`（日用品可撐日數） |
| `foodUnmet` | `clamp(1 − foodDays / 8, 0, 1)`（食品可撐日數） |
| `residentialOversupply` | `clamp((zoneTiles.residential − population/12) / max(1, population/12), 0, 1)` |
| `commercialOversupply` | `clamp((zoneTiles.commercial − population/40) / max(1, population/40), 0, 1)` |
| `industrialOversupply` | `clamp((zoneTiles.industrial − population/35) / max(1, population/35), 0, 1)` |
| `farmlandOversupply` | `clamp((zoneTiles.farmland − population/60) / max(1, population/60), 0, 1)` |
| `taxPenalty` | 薪俸稅超 15% 部分 ×2＋利得稅超 16.5% 部分 ×1.5，clamp 0..0.15 |

**需求公式（建議，數值可平衡）**

```
residentialRaw = 0.34*jobVacancy + 0.22*unemploymentRate + 0.14*homelessRate
               + 0.14*happinessFactor + 0.08*landValueFactor
               - 0.38*residentialOversupply - taxPenalty
commercialRaw  = 0.30*shoppingUnmet + 0.22*populationFactor + 0.16*goodsUnmet
               + 0.12*happinessFactor + 0.10*landValueFactor
               - 0.40*commercialOversupply - taxPenalty
industrialRaw  = 0.34*unemploymentRate + 0.24*(1 − jobVacancy)
               + 0.16*goodsUnmet + 0.10*transitCoverage + 0.10*landValueFactor
               - 0.40*industrialOversupply - taxPenalty
farmlandRaw    = 0.46*foodUnmet + 0.20*(1 − clamp(foodDays/10, 0, 1))
               + 0.12*fertileAvailability + 0.10*populationFactor
               - 0.35*farmlandOversupply

// 每日平滑（避免需求跳動）
zoneDemand[z] += clamp(raw − zoneDemand[z], −0.10, +0.10)
zoneDemand[z]  = clamp(zoneDemand[z], −1, +1)
```

- `fertileAvailability`：spawn 半徑 20 內未被佔用的農地格比例（0..1）。
- **解讀**：需求 > 0.12 = 開發商有興趣；0～0.12 = 觀望；負數 = 供過於求（不再開發）；< −0.35 持續 3 日 = 顯示「供應過剩」提示。
- 需求條 UI 顯示 −1..1（中間 0）；負數用灰色／向下箭頭，正數用分區色。

### 3.3 需求對開發的影響

| 需求值 | 該區每日最多新增 | 備註 |
|---|---|---|
| < 0.12 | 0 | 不開發；UI「需求不足」 |
| 0.12–0.35 | 1 棟 | 正常 |
| 0.35–0.65 | 3–6 棟（480 地圖：每區上限 6） | 需求旺 |
| > 0.65 | 6 棟（受 `maxBuildingsPerZonePerDay` 限制） | 全城每日上限 15 棟（480 地圖放大） |
| ≤ −0.35 連續 3 日 | 0 棟＋提示 | 供應過剩，考慮 dezone 或等人口消化 |

---

## 4. 發展分數（devScore）與建築等級

### 4.1 公式（✅ `AUTO_DEVELOP.developmentScore` 權重）

```
devScore = clamp(
    base 18
  + powerWeight     14 × powerCoverageAtTile
  + waterWeight     12 × waterCoverageAtTile
  + policeWeight     8 × policeCoverageAtTile
  + fireWeight       8 × fireCoverageAtTile
  + schoolWeight    10 × schoolCoverageAtTile
  + hospitalWeight   8 × hospitalCoverageAtTile
  + transitWeight   10 × transitCoverageAtTile
  + happinessWeight 12 × (stats.happiness / 100)
  + landValueWeight 10 × (stats.landValue / 100),
  0, 100)
```

- **`*CoverageAtTile`**：以該分區格為中心，檢查各服務建築半徑是否覆蓋（0 = 無、0.5 = 覆蓋但容量不足、1 = 覆蓋且容量足夠）；不是用全城平均覆蓋率。
- **容量不足**：醫院／學校等 `capacity` 用「服務人口 / capacity」計算；超過容量 → 覆蓋值 0.5。
- **landValue**：由系統每日計算（0–100）：基礎 50＋交通可達＋公園／海濱／商場覆蓋＋低污染＋豪宅數量－工業污染；詳見 §6.4。
- devScore **每日或每次開發前**重算一次；UI hover 分區格顯示。

### 4.2 典型分數（給平衡參考）

| 情境 | 供電/水 | 警/消 | 校/醫 | 交通 | 幸福 | 地價 | devScore | 可出現建築 |
|---|---|---|---|---|---|---|---|---|
| 只有道路＋分區 | 0/0 | 0/0 | 0/0 | 0 | 70 | 50 | **≈31** | 劏房、便利店、貨倉、農田、進口商行 |
| ＋發電廠＋水務 | 1/1 | 0/0 | 0/0 | 0 | 70 | 50 | **≈57** | 唐樓、茶餐廳、工廈、食品廠、石礦場 |
| ＋警署＋消防局 | 1/1 | 1/1 | 0/0 | 0 | 70 | 55 | **≈75** | 公共屋邨、街市、超市、商廈、酒樓 |
| ＋學校＋醫院 | 1/1 | 1/1 | 1/1 | 0 | 75 | 60 | **≈94** | 居屋苑、商場、私人屋苑（豪宅仍需地價/全覆蓋） |
| 全部＋港鐵＋高地價 | 1/1 | 1/1 | 1/1 | 1 | 80 | 80 | **≈100** | 豪宅 |

> 注意：上表為「全覆蓋」的理想值；實際遊戲中覆蓋率通常 0.6–0.9，豪宅要到人口 800＋高地價＋全服務才會出現。`minDevScore` 是門檻不是保證：同分區內按 `weight` 加權抽選，低級建築仍會出現。

### 4.3 密度與等級節奏

| 分區 | 低級（minDevScore 0–20） | 中級（20–50） | 高級（50–70） | 頂級（70+） |
|---|---|---|---|---|
| 住宅 | 劏房（0，w3）、唐樓（10，w4） | 公共屋邨（30，w3） | 居屋苑（50，w2） | 私人屋苑（65，w2）、豪宅（85，w1） |
| 商業 | 便利店（0，w3）、茶餐廳（5，w3） | 街市（20，w2）、超市（35，w2）、酒樓（50，w2） | 商廈（55，w2） | 商場（70，w1） |
| 工業 | 貨倉（0，w3）、進口商行（5，w2） | 食品廠（20，w2）、石礦場（30，w1） | 工廈（35，w3） | — |
| 農業 | 農田（0，w1） | — | — | — |

- **自動建築用盡分區格**時，玩家要擴區（住宅區 1×1 建築多、2×2 建築需要連續格）；建議每塊分區 ≥ 4×4 連續格，方便高級建築 2×2 落位。
- 高級建築出現後，低級建築**不會自動消失**（v1 不做升級／重建）；玩家可拆遷（退款 30%）再等開發商重建；🕒 v1.1 加 `Building.level` 升級。

---

## 5. 自動開發：19 種建築池

### 5.1 建築池（✅ config `zone`／`weight`／`minDevScore`）

| key | 名稱 | 分區 | weight | minDevScore | unlockPop | 尺寸 | 造價 | 維護/月 | 工人 | 住房／產出 |
|---|---|---|---|---|---|---|---|---|---|---|
| `subdividedFlat` | 劏房 | residential | 3 | 0 | 0 | 1×1 | $90,000 | $400 | 0 | 住 6 |
| `tongLau` | 唐樓 | residential | 4 | 10 | 0 | 1×1 | $180,000 | $800 | 0 | 住 12 |
| `publicHousing` | 公共屋邨 | residential | 3 | 30 | 90 | 2×2 | $900,000 | $6,000 | 0 | 住 60 |
| `hOSFlat` | 居屋苑 | residential | 2 | 50 | 220 | 2×2 | $1,200,000 | $8,000 | 0 | 住 48 |
| `privateEstate` | 私人屋苑 | residential | 2 | 65 | 400 | 2×2 | $2,400,000 | $16,000 | 0 | 住 80 |
| `luxuryTower` | 豪宅 | residential | 1 | 85 | 800 | 2×2 | $4,000,000 | $30,000 | 0 | 住 40 |
| `convenienceStore` | 便利店 | commercial | 3 | 0 | 10 | 1×1 | $160,000 | $1,500 | 3 | 零售 r4／$900 |
| `chaChaanTeng` | 茶餐廳 | commercial | 3 | 5 | 20 | 1×1 | $220,000 | $2,000 | 6 | 餐飲 r6／$2,500 |
| `wetMarket` | 街市 | commercial | 2 | 20 | 40 | 2×2 | $450,000 | $5,000 | 10 | 零售 r9／$2,200 |
| `supermarket` | 超市 | commercial | 2 | 35 | 150 | 2×2 | $1,000,000 | $10,000 | 12 | 零售 r12／$5,000 |
| `restaurant` | 酒樓 | commercial | 2 | 50 | 300 | 2×2 | $1,600,000 | $15,000 | 20 | 餐飲 r10／$9,000 |
| `officeTower` | 商廈 | commercial | 2 | 55 | 160 | 2×2 | $1,800,000 | $20,000 | 40 | 稅收 +15%（無幸福） |
| `shoppingMall` | 商場 | commercial | 1 | 70 | 350 | 3×2 | $3,200,000 | $30,000 | 25 | 零售 r16／$14,000 |
| `warehouse` | 貨倉 | industrial | 3 | 0 | 30 | 2×2 | $500,000 | $4,000 | 6 | 儲存 600 |
| `importFirm` | 進口商行 | industrial | 2 | 5 | 0 | 2×2 | $240,000 | $2,500 | 5 | 日用品 10/日 |
| `foodFactory` | 食品廠 | industrial | 2 | 20 | 90 | 2×2 | $900,000 | $8,000 | 10 | 食品 16/日（耗日用品 3） |
| `quarry` | 石礦場 | industrial | 1 | 30 | 30 | 2×2 | $600,000 | $6,000 | 6 | 建材 12/日；只可丘陵／平地／市區地 |
| `industrialBuilding` | 工廈 | industrial | 3 | 35 | 70 | 2×2 | $1,100,000 | $10,000 | 14 | 電子 6/日（耗建材 5） |
| `farm` | 農田 | farmland | 1 | 0 | 0 | 2×2 | $150,000 | $1,500 | 4 | 食品 24/日；農地／平地 |

> 合計 **19 種自動建築**（住宅 6＋商業 7＋工業 5＋農業 1）。全部由開發商出資興建：**玩家不用付造價**，但玩家要付分區成本及公共設施；建築的維護費由開發商承擔（不計入 `totalUpkeep`，只計玩家手動置建築）——這一點是與舊版最大分別，systems-dev 要分清。

### 5.2 開發演算法（建議 `sim/zoning.ts`）

```
每 AUTO_DEVELOP.intervalDays（1 日）執行一次：
  globalBudget = AUTO_DEVELOP.maxBuildingsPerDay            // 5
  for zone of ZONE_ORDER.split:
      if zoneDemand[zone] < AUTO_DEVELOP.minDemand (0.12) → continue
      zoneBudget = AUTO_DEVELOP.maxBuildingsPerZonePerDay    // 2
      candidates = zoneBuildingDefs(zone).filter(d =>
          d.unlockPop <= stats.population &&
          d.minDevScore <= devScoreAt(eligibleTile) &&
          footprintFits(eligibleTile, d.size, zone) &&
          terrainAllows(d, eligibleTile))
      if candidates.length === 0 → continue
      while zoneBudget-- > 0 && globalBudget-- > 0 && totalAuto < maxAutoBuildings (1,200):
          pick = weightedRandom(candidates, d.weight)      // 用 seed+day 決定性抽樣
          placeAutoBuilding(pick, eligibleTile, zone)       // 佔格、zone、auto=true
          emit log/toast「發展商在深水埗建成唐樓」           // 1 日最多 5 條，避免洗版
```

**eligibleTile 條件**

1. 該格 `zone === zone`、`buildingId < 0`、`!road`。
2. 建築 footprint（w×h）全部格：`zone === zone`、無建築、非道路。
3. footprint 正交外側至少一格 `road === true`。
4. 地形符合 `production.allowedTerrain`（農田／石礦場）或一般可建地。
5. devScore 以 footprint 中心格計算。

**抽選權重**：`weight` 1–4；同分區內高 weight 較常出現；用 `mulberry32(seed + totalDays*7919 + zoneIndex*104729 + attempt)` 決定性抽樣，存檔不變。

### 5.3 自動建築的營運

- 自動建築 `auto=true`、`zone` 記錄來源；`connected` 由路網決定；工人／居民由人口系統照常分配。
- **維護費不計入玩家支出**（開發商承擔）；但玩家仍收稅（薪俸／利得／差餉）。
- 自動建築可被拆除（退款 30%）；拆後該格保留分區，開發商可再建。
- **荒廢**：自動建築連續 `AUTO_DEVELOP.abandonDays=8` 日無道路連通 → 停工（`active=false`）→ 第 8 日自動拆卸（不退款），log 提示「XX 大廈荒廢，發展商收回土地」。
- **上限**：全城自動建築 `maxAutoBuildings=**1,200**`（480 地圖；實測高密度約 152 棟）；到頂後不再開發（UI 提示「土地飽和」）。

### 5.4 玩家可見回饋

- 每日開發在城事面板顯示「發展商動態」：最近 3 棟自動建築（區、名稱、位置）。
- 建造面板「區域」tab 顯示每個分區：已劃格數、已建棟數、需求值、下一級建築門檻。
- 分區 hover：`住宅區 ｜ devScore 57 ｜ 下一級：公共屋邨（30）｜ 需求 0.42`。

---

## 6. 服務覆蓋、公共設施與平衡

### 6.1 13 種手動置建築（✅ `ploppable:true`）

| key | 名稱 | 尺寸 | 造價 | 維護/月 | 解鎖 | 服務／效果 | 放置限制 |
|---|---|---|---|---|---|---|---|
| `powerPlant` | 發電廠 | 3×3 | $5,000,000 | $50,000 | 180 | 電力 r22、容量 1,600 人 | 臨路 |
| `waterworks` | 水務設施 | 2×2 | $2,600,000 | $22,000 | 90 | 食水 r18、容量 2,000 人 | 臨路 |
| `policeStation` | 警署 | 2×2 | $1,800,000 | $18,000 | 120 | 治安 r12、幸福 +4、稅收 +5%、容量 300 | 臨路 |
| `fireStation` | 消防局 | 2×2 | $1,700,000 | $16,000 | 120 | 消防 r12、幸福 +3、容量 300 | 臨路 |
| `school` | 學校 | 2×2 | $1,600,000 | $14,000 | 100 | 教育 r10、幸福 +6、學位 400 | 臨路 |
| `hospital` | 醫院 | 3×2 | $4,500,000 | $45,000 | 220 | 醫療 r16、幸福 +8、病床 500、耗日用品 2 | 臨路 |
| `park` | 公園 | 2×2 | $350,000 | $3,000 | 0 | 休憩 r7、幸福 +5 | 免路 |
| `promenade` | 海濱長廊 | 1×1 | $180,000 | $1,000 | 0 | 休憩 r5、幸福 +4 | 免路、臨水 |
| `mtrStation` | 港鐵站 | 2×2 | $4,000,000 | $40,000 | 180 | 交通 r14、容量 900、車費 $8 | 臨路 |
| `busTerminus` | 巴士總站 | 2×2 | $1,300,000 | $12,000 | 80 | 交通 r10、容量 500、車費 $5 | 臨路 |
| `tramStop` | 電車站 | 1×1 | $450,000 | $4,000 | 40 | 交通 r6、容量 300、車費 $3 | 臨路、只限港島 |
| `ferryPier` | 渡輪碼頭 | 3×2 | $1,200,000 | $11,000 | 150 | 交通 r12、容量 400、車費 $4 | 臨路、臨水 |
| `containerPort` | 貨櫃碼頭 | 4×3 | $8,000,000 | $80,000 | 300 | 日用品 45/日（地標） | 臨路、臨水、只限西岸 |

> 合計 **13 種手動置建築**。這些是玩家唯一直接花錢興建的建築；它們**不計入自動開發池**，不會被開發商取替。

### 6.2 服務覆蓋計算

```
對每個服務建築：
  coverageCapacity = def.service.capacity ?? Infinity
  servedPop = Σ(半徑內住宅人口)
  coverageAtTile = servedPop <= capacity ? 1 : 0.5（超載）
  若多個同類建築重疊，取最高 coverage；全市 stats 覆蓋率 = 加權平均。
```

- 警／消／校／醫同時影響 **devScore** 與 **幸福**；交通主要影響 devScore＋通勤＋車費；公園／海濱影響幸福＋地價；公用設施（電／水）影響 devScore＋生產效率。
- 服務容量不足 → 覆蓋值 0.5；UI 顯示「學校學位不足」「醫院病床不足」。

### 6.3 地價（`stats.landValue`，0–100）

```
landValue = clamp(50
  + 8 × transitCoverage
  + 6 × parkPromenadeCoverage
  + 4 × (shoppingMallCount > 0 ? 1 : 0)
  + 6 × (lowPollutionRatio)           // 工業／發電廠少
  + 4 × (luxuryTowerRatio)
  - 10 × (industrialPollutionRatio)
  - 6 × (typhoonDamageRecent ? 1 : 0)
  , 0, 100)
```

- 地價影響：devScore（10 權重）、差餉收入、賣地價格（v1.1）、市民幸福（輕微）。
- 工業區／發電廠周邊地價下降；豪宅在海景／山景地段額外加成（+10）。

### 6.4 平衡目標（480×480 真實地理；可建 22.4%）

| 人口 | 預期分區格 | 預期自動建築 | 必備公共設施 | devScore 目標 |
|---|---|---|---|---|
| 0–120 | 住宅 30–50、商業 15–25、工業 15–25、農業 15–30 | 25–50 棟 | 警、消、公園、（starter 已有） | 40–55 |
| 120–300 | 住宅 120–200、商業 50–90、工業 50–90 | 120–220 棟 | 加學校、醫院、水務、巴士 | 55–75 |
| 300–600 | 住宅 350–550、商業 150–250、工業 150–250 | 350–600 棟 | 加港鐵、發電廠、渡輪 | 75–90 |
| 600–1,600 | 住宅 800+、商業 400+、工業 400+ | 800–1,200 棟（上限） | 豪宅條件：全覆蓋＋高地價 | 90–100 |

- 自動建築每日上限 **15 棟**（每區 6）：人口 1,600 需約 80 遊戲日才建滿 1,200 棟——刻意讓後期仍有「等發展」的節奏。
- 需求 pipeline 的「已劃未開發」門檻按 `AREA_SCALE = MAP_SCALE² = 25` 放大，避免 480 地圖正常大小的分區被誤判過度供應。
- **真實地形限制**：可建地只有 22.4%、水域 75.6%；山多平地少 → 玩家要沿平地／走廊發展，道路連通比 304 版更重要。
- 若玩家投訴「起得太慢」→ 先看需求是否 < 0.12（供應過剩）或 devScore 不夠（缺服務）。

## 7. 新舊開局模式規格

### 7.1 已有城鎮（starter）— 新手推薦

**預建內容（✅ `src/core/starter-town.ts`，Round 4 真實地理／連通優先）**

- 位置：中環 spawn（格 **259,299**；設計 51.4,59.4）；若 spawn 貼海／不可建，會找最近可建格作城鎮中心。真實地形數據見 `REAL_GEO_DATA.md`。
- **連通優先道路網**：先取 spawn 所屬可建地**連通分量**（BFS，半徑 14），再以 **GRID_STEP=3** 節點格網生長道路，只鋪同一分量內；BFS 連接孤立節點 → **全鎮同一路網**（修好 Round 3「9 個斷開路網分量」P0）。
- 分區：只在道路可達（BFS 路距 ≤2）的格劃區；北／東住宅、中央商業、南面工業、周邊農地（grass／fertile，最少 24 格）；四區均衡。
- 公共設施 **10 項**（貼近市中心／住宅、連通路網）：發電廠、水務設施、警署、消防局、**學校×2**、公園、巴士總站、港鐵站、**醫院**。
- 自動建築 **34 棟**：公共屋邨×3、唐樓×5、劏房×3、便利店×3、茶餐廳×3、街市×2、超市、商廈、貨倉×2、進口商行、食品廠、工廈×2、**農田×7**。
- 倉庫起始庫存：**食品 520、日用品 180**；店舖食品 80、日用品 50。
- 庫房：**$6,500,000**；warm-up **10 日**；config `targetPopulation=120`，**QA 實測開局約 146 人**。
- 玩家一入場：需求條有數字、有樓、有車、有收入；可以直接擴區或重建。

**Starter 模式驗收**：全鎮同一路網、公共設施覆蓋住宅、市民可通勤、農田有工人；10 秒內看到城市運作；120 秒內可刷第一塊新住宅區並看到開發商起樓。

### 7.2 由零開始（empty）— 挑戰

- **完全空地圖**：`generateRealWorld(seed, { starterRoads:false })` → **零道路（連隧道都冇）、零建築、零分區**；render `showcaseCity=false` → 唔顯示真實樓群／地標／機場／貨櫃碼頭；只有真實地形、山脈、海岸、樹木、海面船隻。
- 市民：**5 名**（設計要求；📌 `createGameState('empty')` 仍未見 seeding，需 new-game 補上——見 §9.1）。
- 庫房：**$8,000,000**。
- 玩家第一步：鋪路→劃住宅區→等唐樓／劏房→劃商業區→等便利店；農業區可同時劃（農田 0 門檻、免臨路）。
- **沿平地發展**：可建地只有 22.4%，山多平地少；唔好一開始就向山地／海邊亂刷，優先用 spawn 周邊平地。
- 冇公共設施時 devScore ≈31，只會出低級建築；要盡快起公園（0 解鎖、免路）＋發電廠／水務（人口 180／90 解鎖）。
- 大地圖導航：用 minimap 或 **O** 拉遠睇全圖、**P** 回中環市中心；empty 初期城市只佔地圖一小角是正常的。

### 7.3 開局選擇畫面（`showStartScreen`）

- 首次載入（未載入存檔）顯示全屏選擇：
  - 左卡「已有城鎮」（推薦）：中環起步、$650 萬、預建城市、10 日 warm-up；
  - 右卡「由零開始」：空地圖、$800 萬、5 市民、挑戰。
- 兩卡都有「這模式適合誰」與截圖／示意圖（CSS 自繪）；畫面顯示 **480×480 · 230,400 格 · CSDI 真實地理** badge；empty 卡寫「完全空地」、starter 卡寫「預建中環城鎮」。
- 選擇後寫入 `gameMode`、關閉 `showStartScreen`、儲存；「新遊戲」可重選。

---

## 8. 玩家 10 分鐘體驗流程（分區版）

### 8.1 Starter 模式（預設）

| 時間 | 玩家動作 | 預期結果／提示 |
|---|---|---|
| 0:00–0:30 | 睇開局畫面（480×480・CSDI badge）→選「已有城鎮」 | 中環城市已有樓、有車、有需求條；minimap 右下 |
| 0:30–1:30 | 觀察需求條：住宅正、商業正、工業微負；按 **L** 開分區色塊；按 **O/P** 試 minimap 導航 | 明白顏色＝分區、需求條＝市場、大地圖可一鍵 overview |
| 1:30–3:00 | 在城市邊緣鋪 6–10 格路（$90,000–$150,000），刷 3×3 住宅區（$10,800） | 2–3 日後開發商起唐樓／劏房，人口上升 |
| 3:00–4:30 | 刷商業區 2×3（$9,000）；睇便利店／茶餐廳自動出現 | 商業需求被消化，收入上升 |
| 4:30–6:00 | 人口 90 解鎖公共屋邨；起警署（$1,800,000）或消防局（$1,700,000）提升 devScore | 需求條上升、可出更高級樓 |
| 6:00–8:00 | 起學校（$1,600,000）／公園（$350,000）／擴工業區 | 幸福與 devScore 上升；工業區出工廈 |
| 8:00–10:00 | 人口 180 解鎖港鐵站；規劃過海（維港對岸）／起港鐵站 | 通勤改善、車費收入、為豪宅鋪路 |

### 8.2 Empty 模式

| 時間 | 玩家動作 | 預期結果／提示 |
|---|---|---|
| 0:00–0:30 | 選「由零開始」；完全空地圖、5 名市民在 spawn 等待 | 零道路／零建築／零分區、庫房 $8,000,000；minimap 所見全是大自然 |
| 0:30–1:30 | 鋪 8 格路＋刷 2×3 住宅區（$7,200） | 1–2 日後劏房／唐樓出現（devScore ≈31） |
| 1:30–3:00 | 刷 2×2 商業區＋2×2 農業區（$6,000＋$2,800） | 便利店／茶餐廳＋農田出現，食品供應 |
| 3:00–4:30 | 起公園（$350,000，0 解鎖）＋儲錢等發電廠 | 幸福上升；留意人口 90 水務、180 發電廠 |
| 4:30–6:30 | 人口 30 貨倉／石礦場；人口 40 街市／電車站（港島） | 物流與食品穩定 |
| 6:30–8:30 | 人口 70 工廈；人口 80 巴士總站；人口 90 水務設施 | 職位與通勤；食水覆蓋 |
| 8:30–10:00 | 人口 100 學校；人口 120 警署／消防局；首次擴區到海旁 | devScore 進入 55+；平穩過渡 |

> 檢查點：10 分鐘內最少一次「需求不足／供應過剩」提示、一次自動建築落成 log、一次公共設施提升 devScore 的 visible 變化。

---

## 9. 給實作 Agent 的分工與注意

| Agent | 工作 | 注意事項 |
|---|---|---|
| **systems-dev（核心）** | 新增 `src/sim/zoning.ts`：需求公式（§3.2）、devScore（§4.1）、自動開發（§5.2）、荒廢（§5.3）、`stats.zoneDemand/zoneTiles/zoneBuildings/landValue/policeCoverage/fireCoverage/schoolCoverage/hospitalCoverage`、每日 caps、deterministic RNG | 唔可以每幀掃全地圖；每日一次；`GameState.zoneDemand` 與 `stats.zoneDemand` 同步；存檔兼容 |
| **placement／buildings-dev** | `zone:*`／`dezone` 工具、分區成本、農田限制、拆遷自動建築、道路自帶行人路、取消行人路工具；`Building.auto/zone` | 分區不可刷在道路／建築；拆樓退款 30%；`SIDEWALK_COST` 不再用 |
| **world-dev** | **480×480 真實地理**（CSDI DTM＋建築輪廓）、`MAP_SCALE=5`；中環 spawn（259,299）＋ starter 連通道路／3 隧道；minimap 480／地形／真實樓群渲染；地名 LOD | 水域 75.6%、可建 22.4%；雪線 0.8；無邊海面；empty 視覺 gate（`showcaseCity`） |
| **citizens-dev** | 人口遷入／就業／無家影響需求輸入；自動住宅入住；devScore 用 `stats.happiness` | 住宅容量＝auto＋手動住宅總和；`homeless`、`jobs` 要準 |
| **economy-dev** | 分區成本入 `expenseBreakdown.infrastructure`；auto 建築維護費不計玩家支出；差餉／利得照收；landValue 計算（可放 systems） | 唔好把 auto upkeep 計入 `totalUpkeep` |
| **ui-dev** | 建造面板改「區域（4 刷子）＋道路＋拆除」；ploppable 建築卡；需求條（RCI+F）；開局模式畫面；分區 overlay 開關；hover devScore；快捷鍵更新 | 需求條 −1..1 中間 0；負數灰色；見 `UI_SPEC_HK.md` §7／§8 |
| **logistics-dev** | auto 工業建築（貨倉／進口商行／食品廠／工廈／石礦場）照常生產；貨車由 zone 建築收貨 | 早期直送（無貨倉）仍有效 |
| **new-game／save** | `createGameState` 已補齊新欄位；starter 呼叫 `buildStarterTown`＋warm-up 10 日；存檔 **v5** compact | 📌 empty **5 名市民仍未 seeding**；`starter-town.ts` 已 rebalance（**34 auto／10 設施／7 農田／倉庫食品 520**、連通道路） |
| **ui-dev（導航）** | **minimap 480×480 真實地形**（右下、視野框、點擊跳轉、O/P/L、手機 132px 可摺疊）；相機 zoom out ~1,300 | 250ms 節流、地形快取；不要在每幀掃 230,400 格 |

### 9.1 現階段實作缺口（2026-10-22 檢查）

- `src/core/new-game.ts` 的 `createGameState()` 尚未填 `gameMode`、`zoneDemand`、`spawn`（有 `spawn`）、`vehicles`、`transit`、`nextVehicleId` 及新 `stats` 欄位 → **會 type error／undefined**，new-game 負責人要補。
- `src/sim/zoning.ts` 未存在 → systems-dev 要新建。
- `placement.ts` 仍有獨立 `sidewalk` 工具與 `SIDEWALK_COST` → 要改為道路自帶行人路＋zone 工具。
- `simulation.ts` 未見 `zone*` 呼叫 → 要加每日 `tickZoning`。
- `starter-town.ts` 已 rebalance（**34 棟 auto＋10 服務**，含 7 農田、倉庫食品 520、學校×2、醫院、**連通道路網**），可作 starter 模式基礎。
- `save.ts` 已改 **v5** compact（seed＋sparse tileEdits）；`ui/minimap.ts` 已存在；`new-game.ts` 已支援 starter/empty，但 empty 5 市民 seeding 仍缺；`world/hk-map-data.generated.ts` 為真實地理數據。

---

## 10. FAQ（給玩家與 QA）

| 問題 | 答案 |
|---|---|
| 為何劃了區但唔起樓？ | ① 需求 < 0.12（供過於求）② 分區格未接馬路 ③ devScore 未夠（缺電／水／警／消／校／醫／交通）④ 建築池未解鎖（人口未夠）⑤ 已到每日 15 棟／全城 1,200 棟上限 |
| 為何需求係負數？ | 該區供應過剩（分區太多、人口未跟上）；等人口增長或 dezone；負數持續 3 日會提示 |
| 為何只起劏房／便利店？ | devScore 太低（約 31）；先起公園、發電廠、水務、警署、消防局、學校，devScore 上升才出高級建築 |
| 為何豪宅咁難出？ | 豪宅 `minDevScore=85`＋人口 800＋高地價；要全服務覆蓋＋高地價＋幸福 ≥ 75 |
| 行人路去咗邊？ | 已整合到馬路：鋪路就自帶行人路，不再需要獨立工具 |
| 自動建築要唔要我俾錢？ | 唔使；開發商出資，你只俾分區（$1,200–$1,500/格）＋公共設施。但你收唔到佢嘅維護費（亦唔使俾） |
| 可唔可以拆自動建築？ | 可以，退款 30%；拆後分區保留，開發商可再建 |
| 為何有樓荒廢？ | 連續 8 日無道路連通 → 自動拆卸（不退款）；檢查道路有無被拆 |
| 舊版手動起樓仲有冇？ | 冇；只有 13 種公共／交通／休憩／地標可手動放。想「自己起樓」的感覺，可用 dezone／拆樓引導開發商重建 |
| 兩種開局分別？ | starter＝中環已有城鎮、$650 萬、10 日 warm-up；empty＝**完全空地圖**、$800 萬、5 市民（設計） |
| 地圖太大點算？ | 用右下 minimap 點擊／拖曳跳轉；**O** 拉遠睇全圖、**P** 回中環市中心；分區色塊 **L** 可快速睇城市範圍 |
| 為何 empty 冇隧道／地標？ | empty 是「完全空地」，所有人造構築物都隱藏；只有自然地形／樹木／海面船隻，過海要靠玩家自己建渡輪碼頭／港鐵站 |
| 存檔點解咁細？ | v5 只記 seed＋稀疏道路／分區變更，地形由 seed＋真實生成檔重新解碼；約 80–140KB，舊 96×96／304×304 檔不兼容 |

---

## 11. 驗收清單（Definition of Done）

- [ ] 分區工具 4 種（住宅／商業／工業／農業）可拖曳刷、扣錢、dezone 免費、農田只可農地／平地。
- [ ] 道路自帶行人路；行人路工具已移除；貨車只行道路、市民可行道路／行人路。
- [ ] 需求（RCI+F）每日更新、−1..1、平滑、UI 四條需求條即時反映。
- [ ] devScore 0–100、按 §4.1 計算、hover 分區格顯示、影響建築等級。
- [ ] 19 種 auto 建築按 zone／weight／minDevScore／unlockPop 自動開發；每日 **15** 棟、每區 **6** 棟、全城 **1,200** 棟。
- [ ] 荒廢機制：8 日無路自動拆卸。
- [ ] 13 種 ploppable 可手動放置；服務覆蓋影響 devScore 與幸福。
- [ ] 兩種開局模式可選；starter 有 **34 棟 auto＋10 服務（學校×2、醫院）＋連通道路網**、倉庫食品 520；empty 為完全空地（零道路／建築／分區／地標）＋$800 萬＋5 市民。
- [ ] 地圖 **480×480（230,400 格；每格 140m；可建 22.4%）**；minimap 480 真實地形（右下、視野框、點擊跳轉、O/P/L、手機可摺疊）；相機 zoom out ≈1,300。
- [ ] 存檔 **v5** compact（80–140KB）；舊 96×96／304×304 檔拒絕並提示；density／buildingHeight 只作視覺。
- [ ] 分區 overlay（G）可開關；建築有分區 tint。
- [ ] 城事面板顯示分區供需、發展商動態、地價、服務覆蓋率。
- [ ] 存檔保存 `gameMode`、`zoneDemand`、tile.zone、Building.auto/zone、新 stats。
- [ ] 首 10 分鐘可完成「鋪路→劃住宅→看到自動建築→劃商業→起公共設施→需求上升」。
- [ ] 無 console error；`npx tsc --noEmit` 通過；60fps（人口 800–1,200、auto 建築 1,200；terrain 588k tris、sim ≈0.23ms）。

---

*文件結束。玩法數值以 `src/core/config.ts`（`ZONES`／`AUTO_DEVELOP`／`STARTER_TOWN`）為最終依據；介面見 `docs/UI_SPEC_HK.md`；整體 GDD 見 `docs/GAME_DESIGN_HK.md`。*
