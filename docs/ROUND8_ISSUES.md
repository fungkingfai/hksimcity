# 《維港之城》Round 8 GitHub Issues 規格（ROUND8_ISSUES.md，v0.8.0）

> 文件版本：1.0（2026-10-25）｜撰寫：game-designer
> 專案：`hk-city/`（GitHub：`fungkingfai/hksimcity`）｜用途：Round 8（v0.8.0）GitHub issues **#9–#16** 的 UX／玩法規格、資料契約、驗收清單、風險；供 Lead／ui-dev／world-dev／systems-dev／QA 實作。
> 依據：GitHub issues #9–#16 內容；`src/core/types.ts`（`RoadGrade`／`UIState.roadGrade`／`showBuildings`／`pipeLayers`／`pipeFlow`／`GameActions.applyRoadPath` 等骨架）、`src/core/config.ts`（`ROAD_GRADE_INFO`、`RAIL_INFO`、`RAIL_CONFIG`）、`src/world/existing-city.ts`（現有樓群／道路生成）、`src/world/border.ts`（`isShenzhenSideTile`）、`src/render/underground.ts`、`src/render/roads.ts`、`src/render/vehicles.ts`、`src/sim/vehicles.ts`（`isWaterLine`）、`src/ui/build-panel.ts`／`ui.ts`／`info-panel.ts`／CSS。
> 版本：**v0.8.0**（`GAME_VERSION=8`、save **v8**）。本文件描述 Round 8 目標；**2026-10-25 已全部實作並通過 QA**（詳見 TEAM_REPORT／README）。
> 標記：**MVP**｜**P2**｜**設計值**｜**現況**。

---

## 0. Issue 狀態總表

| # | 標題 | 類型 | 本文件 | MVP 範圍 |
|---|---|---|---|---|
| 9 | 左邊建造面板不能顯示全部內容 | UX／版面 | §1 | 全高 panel＋scroll＋sticky tabs＋rail compact |
| 10 | 已有城鎮分區馬路太多太密 | 世界生成／道路 | §2 | 道路 hierarchy＋總量 1,900–2,400 格（由 5,200 減） |
| 11 | 道路拉線＋高架／隧道（M／N） | 玩法／UX | §3 | drag L 形路＋grade 切換＋save v8 |
| 12 | 地下管網三層分開顯示＋流動 | UI／render | §4 | 三層 eye toggle＋U＋流動動畫 |
| 13 | 顯示／隱藏建築圖層 | UI／render | §5 | topbar toggle＋`B`＋persist |
| 14 | 深圳市參考區不可建設 | 世界／規則 | §6 | placement／zoning／road／pipe／rail 全 block＋overlay |
| 15 | 城事縮退按鈕冇反應 | Bug／UX | §7 | `infoCollapsed` state＋class sync＋persist |
| 16 | 船有時在陸上行 | Bug／render／sim | §8 | water BFS path＋clearance＋render 水面高度 |

---

## 1. #9 左建造面板重新設計

### 1.1 問題

- 桌面 `.build-panel` 固定 `width:336px`、`max-height: calc(100% - topbar - warning - 24px)`；內容順序：分區刷、道路／工具、rail 區、分類 tabs、建築卡；`build-scroll` 只包部分內容。
- 視窗 1280×800 時，分區＋rail＋公共建築卡超出高度；視窗 457×1078（窄 desktop）更嚴重（issue 截圖）。
- 手機版 bottom sheet 同桌面 panel 用同一 DOM，class 狀態容易衝突（`is-build-open`／`is-build-collapsed`）。

### 1.2 目標版面（MVP）

```
┌──────────────────────────────┐  ← .build-panel（topbar 下、左側）
│ 分區（Z C V N M X R）        │  ← fixed header（唔 scroll）
│ [住宅][商業][工業][農業]      │
├──────────────────────────────┤
│ 鐵路（compact 2×2 chips）    │  ← 可摺疊 section（default 收起）
│ [地面][高架][地下][拆除]      │
├──────────────────────────────┤
│ 公共建築 tabs（sticky）      │  ← category tabs 固定在 scroll 頂
│ 公共 · 交通 · 休憩 · 物流 · 公用 │
│ ┌─ scroll body（唯一 scroll）─┐│
│ │ building cards...           ││
│ │ ...                         ││
│ └─────────────────────────────┘│
└──────────────────────────────┘
```

### 1.3 CSS／DOM 規格

| 項目 | 規格 |
|---|---|
| Panel | `display:flex; flex-direction:column; min-height:0; width:336px`（≥1440px：360px；1280–1439：336px；1024–1279：300px） |
| 高度 | `top: calc(var(--topbar-h) + var(--warning-h,0px) + 10px); max-height: calc(100% - var(--topbar-h) - var(--warning-h,0px) - 24px); overflow:hidden` |
| Header | 分區＋道路工具 fixed（`flex:0 0 auto`）；唔參與 scroll |
| Rail section | compact 2×2 chip（高 30–34px，icon＋名＋$/格）；default 摺疊；標題「鐵路」＋chevron；展開後佔 ≤96px |
| Category tabs | `position:sticky; top:0; z-index:2; background`；分頁切換唔重設 scroll？→ 切換分類時 scroll body 回到頂 |
| Build scroll | `flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain`；只有呢層 scroll |
| 底部 | 可選 `flex:0 0 auto` 的提示／取消工具列；唔好同 minimap 重疊 |
| 窄 desktop（≤980px） | panel 變左側 drawer（`is-build-open`），寬 min(86vw, 360px)，overlay 點擊關閉；`Esc` 關閉 |
| 手機（≤768px 或 pointer coarse） | 用現有 bottom sheet（`is-sheet-open`），sheet 內同樣 sticky tabs＋唯一 scroll；高度 70dvh；唔用 desktop panel |
| 457×1078 | 視為 drawer（寬 457 ≤980）：panel 寬 min(90vw, 420px)，全高可 scroll；所有 tabs 可橫向 scroll（5 個 tab 唔好變 4 欄爆版） |
| 1280×800 | 336px panel；分區＋rail＋tabs＋scroll；最底 building card 可見或可 scroll；唔會蓋 topbar／bottom hint |

### 1.4 驗收（#9）

- [ ] Playwright **1280×800**：開建造面板，見到分區、rail 摺疊 chip、5 個公共建築 tabs、scroll body；滾到底可選最後一張卡；screenshot `round8-build-panel-1280x800.png`。
- [ ] Playwright **457×1078**：drawer 模式，panel 可 scroll，tabs 可橫向 scroll，唔會溢出／遮住 topbar；screenshot `round8-build-panel-457x1078.png`。
- [ ] 手機 390×844（touch）：bottom sheet 可開關、sticky tabs、scroll 正常；screenshot `round8-build-panel-mobile.png`。
- [ ] 鍵盤／滑鼠 hover tooltip 正常；切換分類 scroll 回頂；rail 摺疊狀態同 `ui.buildCategory` 持久（P2）。
- [ ] `tsc --noEmit`、既有 UI tests 通過；無 horizontal overflow（`scrollWidth <= clientWidth`）。

### 1.5 MVP／P2

- **MVP**：上述 panel 結構、rail compact、sticky tabs、唯一 scroll、1280×800／457×1078 驗收。
- **P2**：使用者自訂面板寬度、rail 區記住展開狀態、面板內搜尋、快捷鍵跳分類。

---

## 2. #10 現有城鎮道路密度／窄街分級

### 2.1 問題

- `starter-town.ts` 呼叫 `generateExistingBuildings(state, { maxBuildings:900, maxRoads:5200, maxFacilities:60 })`。
- `existing-city.ts` 用 `roadHint` 4-neigh components，揀最大 component 直接全鋪，再 `densifySelectedRoads` 補窿；結果大量 1 格密路，行人路視覺變成棋盤，issue 截圖「馬路太多太密」。
- 現有樓群 572 棟（v0.7.0）；要保留數量同「貼路」，但道路要減同分級。

### 2.2 道路 hierarchy（MVP）

| class | 名稱 | 生成來源 | 目標格數（全 starter 現有區） | 寬度（世界單位） | 行人路 | 顏色 | 車速係數 |
|---|---|---|---|---|---|---|---|
| `arterial` | 主幹道 | roadHint component ≥80 格、top 8–12 條 | **300–420** | 3.2 | 兩邊 | `#3a404a`（深瀝青） | 1.0 |
| `street` | 窄街 | component 20–79 格、住宅／商業 landuse | **900–1,200** | 2.2 | 一邊 | `#454b55` | 0.85 |
| `alley` | 巷道 | component <20 格、工業／鄉村／後巷 | **500–700** | 1.4 | 冇（或單邊窄） | `#4c5158` | 0.65 |

- **總量目標 1,900–2,400 格**（由現時 cap 5,200 減約 55–60%）；`maxRoads` default 由 5,200 → **2,400**。
- 道路 class 存 `Tile.roadClass?: 'arterial' | 'street' | 'alley'`（Round 8 新欄位；save v8 用 sparse tileEdits 擴充）。
- 所有道路仍然 `tile.road=true`；building `connected` 貼任何 class 都算（建築貼路規則不變）。
- 生成規則：
  1. 先抽 roadHint 最大 components（≥80）做 arterial skeleton；長度 cap 420、最多 12 條；
  2. 再抽 medium components 做 street；沿 landuse 住宅／商業／工業分佈；cap 1,200；
  3. 最後喺 existing building 附近（1 格內）補 alley 連接，cap 700；alley 唔可以取代 street；
  4. **唔可以**在 spawn 20 格內、深圳側、水域／山地、建築 footprint 生成；
  5. 生成後 BFS 檢查全區道路連通；唔連通就補 street connector（唔補 alley）；
  6. 每棟 existing building 至少 1 格正交貼路（可 alley）；唔貼路就唔生成該建築（或補 alley）。
- 交通影響：
  - 路徑權重：arterial 1.0、street 1.4、alley 2.2（alley 慢）；
  - 巴士／小巴路線只在 arterial／street 行走（MVP 限制；路線站要貼 arterial／street）；
  - 貨車可入 alley 但速度低；緊急車輛（消防／救護）alley 速度 ×0.7。
- Render：
  - 路面幾何按 class 寬度；arterial 有雙白線／黃線；street 單虛線；alley 冇標線；
  - 行人路：arterial 兩邊、street 一邊、alley 可冇；
  - 路口／斑馬線只喺 arterial×street 交界；
  - 車道偏移沿用香港靠左。
- 效能：道路 mesh 仍以 InstancedMesh；3 個 class 最多 3 個 draw call；road rebuild 只喺道路／class 改變時。

### 2.3 資料契約（#10）

| 項目 | 建議 | 狀態 |
|---|---|---|
| `Tile.roadClass?: 'arterial'|'street'|'alley'` | 道路 hierarchy | 待加 |
| `existing-city.ts` options | `maxRoads` default 5,200→2,400；`roadClassTargets` | 待改 |
| `starter-town.ts` call | `maxRoads: 2400`、`maxBuildings: 900` 保留 | 待改 |
| `render/roads.ts` | 按 roadClass 寬度／顏色／標線；roadClassInstanced | 待改 |
| `sim/pathfinding`／vehicles | roadClass 權重 | 待改 |
| Save v8 | sparse tileEdits 加 roadClass bits（/或 roadGradeEdits 同層） | 待做 |

### 2.4 驗收（#10）

- [ ] starter 現有區道路格 ≤2,400（QA 統計 `existingStats.roads`）；arterial 300–420、street 900–1,200、alley 500–700。
- [ ] 572 棟 existing 樓宇 ≥95% 貼路；道路 components = 1（或 connectRoads 後 =1）。
- [ ] 視覺：主幹道明顯較闊、窄街較窄、巷道最少標線；screenshot `round8-existing-roads-before-after.png`（before 用 v0.7.0 cap 5,200）。
- [ ] 建築「貼路」規則仍成立（任何 class）；巴士路線仍可運作（只行 arterial／street）。
- [ ] 60fps（starter 視角）無惡化；道路 tris／draw calls 唔高過 v0.7.0 +10%。

### 2.5 MVP／P2

- MVP：3 class、目標格數、生成規則、render 寬度、貼路檢查、save v8。
- P2：路口轉向限制、巴士專線、巷道只准行人（唔入車）、道路升級／降級工具。

---

## 3. #11 道路拉線＋高架／隧道（M／N）

### 3.1 問題與目標

- 現時只可逐格鋪路；香港多穿山隧道／跨海橋，玩家想「起點→終點拉一條路」，並用 **M／N** 切換高架／隧道。
- 目標：drag 起點→終點，L 形自動路徑，preview 成本／合法性，M 高架、N 隧道；release 才扣錢；ESC／右鍵取消。

### 3.2 工具與狀態（MVP）

| 項目 | 內容 |
|---|---|
| 工具 | `ui.tool='road'`；`ui.roadGrade: 'surface'|'elevated'|'tunnel'`（已預留） |
| 起點 | 左鍵按下（必須可建／已有道路／合法 endpoint） |
| 終點 | 拖到目標格放開；或 click start → click end（mobile） |
| 路徑 | **L 形**：預設比較 dx／dy，|dx|≥|dy| 先橫後豎，否則先豎後橫；拖曳中 **Shift** 切換另一種 L；唔支援曲線（P2） |
| Grade 切換 | 拖曳中按住左鍵再按 **M**：surface→elevated（再按 M 返回 surface）；**N**：surface→tunnel（再按 N 返回 surface）；同一時間只一個 grade；UI hint 即時更新。**非拖曳時 M／N 仍係 dezone／農業區快捷，只有道路 drag 進行中先 context 優先** |
| Preview | 路徑格半透明色：合法綠／非法紅；顯示「N 格 × $X = $Y」；invalid cell 顯示原因（水域／山／建築／深圳區） |
| 確認 | 放開左鍵 → validate → 扣錢 → 鋪路；成本不足 → 紅色 toast，唔鋪 |
| 取消 | 拖曳中 **ESC**／右鍵 → 取消；取消唔扣錢 |
| 長度 | 最長 **120 格**（超過截斷或拒絕，MVP 拒絕並提示） |

### 3.3 Grade 規則（✅ `ROAD_GRADE_INFO` 已有數值）

| Grade | 造價/格 | 可跨水 | 可穿山 | 可穿建築 | Render |
|---|---|---|---|---|---|
| `surface` 地面 | **$15,000** | ❌ | ❌ | ❌ | 普通路面貼地 |
| `elevated` 高架 | **$75,000** | ✅ | ✅（跨谷） | ❌ | 橋面＋橋墩，離地 ~1.2 世界單位 |
| `tunnel` 隧道 | **$60,000** | ✅ | ✅ | ❌（MVP；P2 可穿建築） | 地面只顯示隧道口／通風井；地下層（U）顯示管道；車輛喺隧道高度行 |

- 合法性：
  - `surface`：只可建在可建地（grass／urban／reclaimed／fertile／forest／hill）＋道路格；不可水／山／建築；
  - `elevated`／`tunnel`：可跨水域／山地；不可跨建築 footprint（MVP）；跨海要連續隧道／橋，唔可以中途落水；
  - 全部 grade 不可入深圳參考區、不可超地圖邊界；
  - 終點要接現有道路或可建地（MVP：可接現有 road 任何 grade；否則要貼地）。
- 成本：`length × ROAD_GRADE_INFO[grade].cost`；拆除退款 30%；`ROAD_UPKEEP=0`（暫不變）。
- 與 worldgen 隧道兼容：
  - 現有 `HK_TUNNELS` 預置過海道路（tile.road=true on water）→ 遷移為 `roadGrade='tunnel'`（或 save 載入時自動判定 water+road = tunnel）；
  - 舊 v7 save 冇 roadGrade → 讀檔時 water+road 自動 tunnel、其餘 surface；
  - render 隧道沿用現有 tunnel deck／portal，只顯示入口，唔好當普通路浮水。
- 載具高度：
  - `Vehicle` 行 `elevated` 時 `y = roadSurfaceY + 1.2`；`tunnel` 時 `y = tunnelY`（地下，render 隱藏或只喺 portal 附近過渡）；
  - 巴士／小巴／貨車 pathfinding 要識 grade（成本權重：高架 1.0、隧道 1.1、地面 1.0）；MVP 只影響 render 高度，唔影響路徑（除非隧道唔通行人？）。
- 隧道視覺：地面用隧道口牌＋斜坡入口；U 地下層可睇 tunnel 管道；P2 隧道內部 view。

### 3.4 UI flow（MVP）

1. 建造面板「道路」區：grade chips〔地面 $15k〕〔高架 $75k〕〔隧道 $60k〕；選 grade。
2. 地圖左鍵按下起點 → 拖到終點（preview L 形）；拖曳中按 **M** = 高架、**N** = 隧道；UI hint 顯示「放開鋪設 · M 高架 · N 隧道 · Esc 取消」；Shift 切 L 方向。
3. 放開：合法 → 扣錢＋鋪路＋toast「已鋪 23 格高架道路（$1,725,000）」；非法 → toast 原因＋保留 preview 供調整。
4. 右鍵／ESC 取消；成本不足唔鋪。
5. **Mobile**：tap 起點 → tap 終點（兩點 preview）；底部 action bar 顯示 grade chips＋M／N toggle＋確認／取消；tap 確認才鋪；手勢唔用 drag 以免同 pan 衝突。
6. 滑鼠 hover 現有道路：顯示 grade、長度、維護。

```
道路  [地面] [高架] [隧道]    拖曳：起點 → 終點
預覽：23 格 · 高架 · $1,725,000      [M] 高架  [N] 隧道
Shift：切換 L 方向 · ESC／右鍵：取消
```

### 3.5 資料契約（#11）

| 項目 | 建議 | 狀態 |
|---|---|---|
| `Tile.roadGrade?: RoadGrade` | surface／elevated／tunnel | 待加（`RoadGrade` 型別已加） |
| `Tile.roadClass?` | #10 用；道路 grade 同 class 可共存 | 待加 |
| `UIState.roadGrade` | 已加；預設 surface | ✅ 型別已加 |
| `GameActions.applyRoadPath(from,to,grade?)` | 已預留；main 未實作 | 待做 |
| `GameActions.setRoadGrade(grade)` | 選 grade | 待加 |
| `save v8` | `roadGradeEdits:[index,code,...]`（0 surface、1 elevated、2 tunnel）＋roadClass bits；舊 v7 拒絕 | 待做 |
| `Vehicle` render | `elevated` +1.2、`tunnel` 地下；載具 path 不變 | 待做 |
| worldgen 隧道 | `HK_TUNNELS` 道路 → roadGrade tunnel；舊檔 hydrate 自動判定 | 待做 |
| UIState | `roadDrag?: {from,to,grade,corner}`（runtime 可不存） | P2 |

### 3.6 驗收（#11）

- [ ] 拖曳起點→終點鋪出 L 形路；`|dx|≥|dy|` 先橫後豎，Shift 可切換；超過 120 格拒絕。
- [ ] 拖曳中按 M 變高架、N 變隧道，再按返回地面；preview 顏色／成本即時更新。
- [ ] 高架／隧道可跨維港／山；地面唔可以跨水／山；跨建築全部拒絕（MVP）。
- [ ] 放開才扣錢；ESC／右鍵取消不扣錢；成本不足 toast。
- [ ] Save v8 `roadGradeEdits`；讀檔後 grade 正確；v7 舊檔 water+road 自動 tunnel。
- [ ] 載具喺高架／隧道 render 高度正確；隧道只顯示入口；U 層顯示隧道管。
- [ ] Mobile：tap start→tap end 可鋪；底部 grade／M／N 可操作；screenshot `round8-road-drag-elevated.png`、`round8-road-drag-tunnel.png`。
- [ ] `tsc --noEmit`、道路 tests 通過；starter 過海路線仍可行。

### 3.7 MVP／P2

- MVP：drag／tap L 路、M／N、3 grade、成本、save v8、render 高度、現有隧道遷移。
- P2：曲線／斜路、交流道、隧道內部、跨建築隧道、道路 grade 升級工具、行人天橋。

---

## 4. #12 地下管網三層分開顯示＋流動

### 4.1 問題

- 現時 `ui.showUnderground` 一開就顯示三種管道（`render/underground.ts` 3 個 InstancedMesh 全開），冇 eye toggle；`UIState.pipeLayers`／`pipeFlow` 已有骨架但未接 UI。
- 玩家想分開睇食水／污水／電力，並見到「流動」方向（source→user）。

### 4.2 規格（MVP）

| 項目 | 內容 |
|---|---|
| 圖層 | 水（青 #24e0ff）／污水（褐 #b07a4a）／電（金 #ffd166）三層獨立 |
| Toggle | 地下工具列（`underground-bar`）加三個 eye chip（水／污水／電）＋「全部」；`UIState.pipeLayers` 控制 |
| U 快捷 | `U` 開／關地下層；打開時預設三層全開（或記住上次）；關閉時保存狀態 |
| 工具聯動 | 選 `pipe:water` → 自動開水層、其他層可保留；選污水／電同理；唔會因為隱藏層而禁止鋪設（提示「圖層已隱藏」） |
| 流動動畫 | 每層加 flow overlay：沿管道方向 UV 捲動（dash／光點）；方向由 source BFS parent（水：水廠→用戶；污水：用戶→污水廠；電：電廠→用戶）；`UIState.pipeFlow` toggle；P2 可加快／暫停 |
| 視覺 | 未接駁建築紅框；source 白／金色光環；hover 管格顯示「食水管 · 中環水務 · 68%」 |
| UI | eye chip 細、可鍵盤 focus；「全部」一鍵；流動 toggle 在右側；手機底部工具列同樣有 chips（橫向 scroll） |
| 效能 | 每層 ≤5 draw calls（管道 mesh、flow overlay、節點／source markers、hover highlight、未接駁標記）；三層合共 ≤15；flow 用 shader offset，唔每幀重建 geometry；只在 revision／layer 改變時 rebuild |
| Save | UIState.pipeLayers／pipeFlow 持久（save v8）；讀檔後套用 |

### 4.3 資料契約（#12）

| 項目 | 建議 | 狀態 |
|---|---|---|
| `UIState.pipeLayers` | `{water:boolean; sewage:boolean; power:boolean}`（已加） | ✅ 型別已加 |
| `UIState.pipeFlow` | boolean（已加） | ✅ 型別已加 |
| `GameActions.setPipeLayer(kind,on)` | 已預留；未實作 | 待做 |
| `GameActions.togglePipeFlow()` | 已預留；未實作 | 待做 |
| `render/underground.ts` | per-layer meshes visible；flow overlay | 待改 |
| `ui/underground-bar.ts` | eye chips＋flow toggle | 待改 |
| Save v8 | UIState 已入 state；唔需額外欄位 | 待做 |

### 4.4 驗收（#12）

- [ ] U 開地下層；三層 eye chip 可獨立開關；全部關 → 空白（保留提示）。
- [ ] 選水管工具自動開水層；污水／電工具同理；隱藏層唔會阻止鋪設但提示。
- [ ] 流動動畫沿 source→user 方向；toggle 可暫停；效能 ≤5 draws/層。
- [ ] 手機工具列 chips 可橫向 scroll；U 可關閉；screenshot `round8-pipe-layers.png`。
- [ ] Save v8 讀檔後圖層狀態保留；`tsc`／render tests 通過。

### 4.5 MVP／P2

- MVP：三層 eye toggle、流動、U、工具聯動、save、效能上限。
- P2：流向箭頭 tooltip、流量粗細、圖層透明度 slider、鍵盤 1/2/3 toggle。

---

## 5. #13 顯示／隱藏建築圖層

### 5.1 問題

- 規劃時建築遮住道路／地形；玩家想一鍵隱藏所有建築。
- `UIState.showBuildings` 骨架已有，但 topbar／快捷未接；render 未隱藏。

### 5.2 規格（MVP）

| 項目 | 內容 |
|---|---|
| Toggle | Topbar 加眼睛 icon（`showBuildings`），title「顯示／隱藏建築（B）」；手機 topbar／選單同步 |
| 快捷 | **`B` = 建築圖層開關**；**建造面板快捷改為 `Tab`**（因為 B 現時開建造面板，需遷移；文件同 help panel 更新） |
| 行為 | `showBuildings=false` → 隱藏所有 building mesh（player auto／ploppable／existing／室內建築外觀？室內模式不受影響）；保留 terrain／road／zones／vehicles／minimap 地形；minimap 建築點同時隱藏（可選） |
| Empty | 冇建築，toggle 顯示 icon 但 disabled／no-op |
| Interior | 室內模式強制顯示該建築，toggle 唔影響室內 |
| 選取 | 隱藏時點擊格選唔到建築（toast「建築圖層已隱藏，按 B 顯示」）；hover 唔顯示 building tooltip |
| Persist | `UIState.showBuildings` 存 save v8；新局 default true；讀檔套用 |
| Render | `render/buildings.ts` / terrain existing layers / rail stations? → group visible false；唔重建 geometry；draw calls 降到接近 0 |

### 5.3 資料契約（#13）

| 項目 | 建議 | 狀態 |
|---|---|---|
| `UIState.showBuildings` | 已加 | ✅ 型別已加 |
| `GameActions.toggleBuildings()` | 已預留；未實作 | 待做 |
| Topbar / mobile bar | eye icon | 待做 |
| Render | buildings group／existing layers visible；minimap dots | 待改 |
| Save v8 | UIState 已存 | 待做 |
| Help / shortcuts | B 改建築圖層、Tab 開建造面板 | 待改 |

### 5.4 驗收（#13）

- [ ] Topbar eye／`B` 可隱藏／顯示所有建築；道路、地形、分區仍可見；再按恢復。
- [ ] 隱藏時無法選取建築；interior／empty 不受影響。
- [ ] Save v8 後 reload 保留狀態；新局 default 顯示。
- [ ] Screenshot `round8-building-layer-off.png`（同一角度 before/after）。
- [ ] 快捷鍵 `B`／`Tab` 喺 help panel 更新；無同其他快捷衝突。

### 5.5 MVP／P2

- MVP：toggle、快捷、render hide、save、interior/empty 特例。
- P2：只隱藏某些類型（住宅／工商／existing）、半透明 ghost mode、圖層快捷 1/2/3。

---

## 6. #14 深圳市參考區不可建設

### 6.1 問題

- 深圳河北岸係深圳市，屬參考區；現時只有 `existing-city` 用 `isShenzhenSideTile` 避開，玩家仍可用道路／分區／建築／管網／鐵路伸延過去。
- 需在**所有工具** block，並有清楚視覺／提示。

### 6.2 範圍與判定

- 判定：`world/border.ts` 已有 `isShenzhenSideTile(tx,ty,w,h)`（用 `shenzhenRiver` centerline＋河闊 cache mask）；同時 `isShenzhenSideDesign` 可用。
- 範圍：深圳河中心線以北（河闊/2 以北）全部 tile；包括北岸陸地、深圳城市視覺；**不包括**香港側口岸。
- 效能：helper 已 cache mask；placement/zoning 每格 O(1)；唔可以每 frame 重算 polygon。
- 視覺：
  - 地圖北岸 overlay：淡紅／暗灰斜線（reference zone），邊界線（深圳河）；
  - 地圖 label「深圳（參考區）」＋口岸名；
  - minimap 北岸暗色；
  - hover 顯示「深圳市 · 參考區 · 不可建設」。
- 玩家提示：
  - 道路／分區／建築／管網／鐵路工具 hover 深圳區 → 紅色 preview＋toast「深圳屬參考區，不可建設」；
  - 放置建築失敗 reason；分區刷唔改變 tile；拖曳 path 截斷／拒絕；
  - 邊境口岸只可喺香港側 5 格內（已有規則），唔可以起喺北岸。
- Empty：一樣顯示深圳河＋參考區；empty 由零開始都唔可以建北岸。

### 6.3 實作檢查點（MVP）

| 工具／系統 | 檢查 |
|---|---|
| placement | `canPlaceBuilding`／`canAutoPlaceBuilding`：目標 / footprint 任何格 `isShenzhenSideTile` → reject reason |
| zoning | `paintZone`／drag：tile check；skipped tiles 顯示紅 preview |
| road | 逐格 `applyToolAt`／`applyRoadPath`：路徑任何格深圳 → 拒絕 |
| pipe／rail | 同上；管線／軌道唔可以入深圳 |
| existing-city | 已 skip；保留 |
| border gate | 只可香港側；已用 placementRadius |
| 邊界視覺 | render overlay＋label＋minimap |
| UIState | 唔需要新 flag；可用 `ui.hover`/tooltip |
| 存檔 | 深圳 mask 由 map data 重生，唔需存 |

### 6.4 驗收（#14）

- [ ] 用道路／分區／建築／管網／鐵路工具嘗試喺深圳河以北操作 → 全部拒絕＋提示。
- [ ] 香港側口岸半徑內可建口岸；北岸不可。
- [ ] 視覺：北岸 overlay、邊界、label、minimap 暗色；hover tooltip；screenshot `round8-shenzhen-reference.png`。
- [ ] Empty 模式一樣 block；existing-city 仍只生成香港側。
- [ ] 效能：mask O(1)，starter 操作無 lag；ta 過。

### 6.5 MVP／P2

- MVP：block 全部工具、overlay、label、提示、minimap。
- P2：深圳遠景動畫、跨境鐵路／道路視覺接入、參考區資訊面板。

---

## 7. #15 城事面板縮退持久

### 7.1 根因（現況）

- 桌面 `ui.ts` 的 `update()` 每次 `if (!mobileUi) { setClass(hud,'is-info-hidden',!showStats); if (showStats) hud.classList.remove('is-info-collapsed'); }` → 玩家按 collapse 後，下一幀 `showStats` 仍 true，class 被移除，面板即刻彈回。
- `showStats` 只控制「面板存在」，冇「collapsed」state；collapse click 用 `setPanelOpen('info', false)` 只 toggle class，冇寫入 state；reset 又強制 `showStats=true`。
- 手機版用底部 sheet class，唔受影響。

### 7.2 規格（MVP）

| 項目 | 內容 |
|---|---|
| State | `UIState.infoCollapsed?: boolean`（新）；`showStats` 代表面板啟用，`infoCollapsed` 代表收合 |
| Collapse | 按 chevron → `infoCollapsed=true`；面板只留 44px handle（標題／箭頭），內容隱藏；class `is-info-collapsed` |
| Expand | 按 handle／箭頭 → `infoCollapsed=false`；恢復 |
| Sync | `update()` 只跟 state 設 class，**唔可以**自動 remove；`showStats=false` 時整個面板 hidden（維持） |
| Reset | 新局 default `false`（展開）；讀檔沿用 save 值；`reset` 事件唔強制展開（只 set showStats=true if default） |
| 快捷 | 可選 `I` 收合／展開（P2）；Esc 先收合再關？MVP 只用滑鼠 handle |
| Mobile | bottom sheet 用現有 class，唔受 infoCollapsed 影響 |
| Persist | save v8 UIState 存入；reload 保留 |
| 無障礙 | handle 是 button、aria-expanded、44×44；鍵盤 focus |

### 7.3 資料契約（#15）

| 項目 | 建議 | 狀態 |
|---|---|---|
| `UIState.infoCollapsed` | boolean | 待加 |
| `ui.ts` class sync | 用 state，不自動 remove | 待改 |
| `info-panel.ts` | collapse button 寫 state；handle 顯示 | 待改 |
| Save v8 | UIState 已存 | 待做 |
| Reset | 新局 default false；讀檔保留 | 待改 |

### 7.4 驗收（#15）

- [ ] 桌面 1280×800：按城事 chevron → 收合；再按 handle → 展開；唔會自動彈回。
- [ ] 收合後仍然見到 handle／標題；hover 有提示；鍵盤 focus 可見。
- [ ] Save v8 reload 保留收合狀態；新局預設展開；`showStats` 關閉時面板隱藏，重開時 collapsed 狀態保留。
- [ ] 手機 sheet 不受影響；screenshot `round8-city-collapse.png`。
- [ ] `tsc`、UI tests 通過。

### 7.5 MVP／P2

- MVP：state、class sync、persist、新局 default。
- P2：快捷鍵、拖拽調整高度、雙擊 handle 全屏、記住 scroll 位置。

---

## 8. #16 船在陸上行

### 8.1 根因分析（現況）

1. `findFerryRoute` 用 `piers → pierWaterTiles` 取碼頭附近水域格，再 `isWaterLine(state,a,b)` 驗證兩點直線；
2. `isWaterLine` 只沿中心線每 **0.5 格**取整數 tile 檢查，**冇 hull clearance**；一條斜線可以「擦過」半島／防波堤而 sample 落在水面（或者反過來 endpoints 係水但中間擦過陸地邊緣）；
3. ferry `path` 只有 `[a,b]` 兩點；renderer 會將船由 a 直線移動到 b，船身寬 **1.24 格、長 2.6 格**，轉向／靠岸時 hull 會 overhang 陸地；
4. 冇「全段水域 BFS」；颱風後／填海後地圖改變亦唔會重新 validate；
5. render `ferry` 用 `WATER_SURFACE_Y`，但如果 path 中段跨過 land tile，船可視上就係陸上。

### 8.2 規格（MVP）

| 項目 | 內容 |
|---|---|
| 水域 path | 新 `findWaterPath(state, from, to)`：以 water tile 4-neigh BFS（可 8-neigh 但 corner 要兩側都水）由 A 碼頭水域到 B 碼頭水域；路徑長 ≥3；冇 path → 唔生成 ferry |
| Clearance | 對 path 每格檢查「船體半寬 1 格」內全部 water（或 `terrain='water'`）；碼頭格本身可為水；唔夠位 → 換另一對碼頭／唔生成 |
| 驗證 | spawn 前 validate 全 path；每當 terrain／building 改變（填海／碼頭重建）標記 ferry route 需重算；hydrate 後重算；唔合法 ferry 即時移除 |
| Path | `Vehicle.path` = BFS 水域 path（tile sequence，不只是一頭一尾）；renderer 沿 path 平滑移動，唔切角 |
| 高度 | ferry `y = WATER_SURFACE_Y`（已有），唔用 roadSurfaceY；船底最低點高於水面；浪花只喺水格 |
| 視覺 | 船身唔可以覆蓋 land：clearance 檢查已保證；hover ferry 顯示「渡輪 · 維港航線」 |
| 測試 | 單元：合成地圖（A/B 水但中間有 1 格陸地）→ no path；真實維港 → path 存在；地圖加防波堤 → ferry 消失；Playwright screenshot `round8-ferry-water.png` |

### 8.3 資料契約（#16）

| 項目 | 建議 | 狀態 |
|---|---|---|
| `sim/vehicles.ts` | `findWaterPath`／`validateFerryPath`／clearance | 待改 |
| `Vehicle.path` | 多點水 path（已有 path 陣列） | 待改 |
| `render/vehicles.ts` | ferry 沿 path 插值；WATER_SURFACE_Y；唔切角 | 待改 |
| `render/water` | 無邊海面已存在；唔需新欄位 | ✅ |
| save | ferry path 入 state.vehicles（已存） | ✅ |
| 測試 | water path unit＋Playwright | 待加 |

### 8.4 驗收（#16）

- [ ] 合成地圖：兩個碼頭之間有陸地 → 唔生成 ferry；全水 → 生成且 path 全部水格。
- [ ] 真實 600 維港：ferry 只喺水上行；船身唔 overhang 陸地；截圖 `round8-ferry-water.png`。
- [ ] 填海／拆碼頭後 ferry validate 重算；唔合法即移除／重找航線。
- [ ] Render 高度正確（WATER_SURFACE_Y），唔會忽高忽低。
- [ ] `tsc`／vehicles tests／Playwright 通過；無 console error。
- [ ] 效能：BFS 只在 spawn／地圖變更時做，唔係每 frame。

### 8.5 MVP／P2

- MVP：water BFS、clearance、render path、validate、測試。
- P2：渡輪班次表、航線玩家設定、夜航燈光、更多船種。

---

## 9. 共通契約與版本（v0.8.0 / save v8）

| 項目 | 內容 |
|---|---|
| `GAME_VERSION` | **8**（v0.8.0；現時 7，待 Lead bump） |
| Save v8 | `tileEdits` 擴充 roadClass／roadGrade bits **或** `roadGradeEdits:[index,code]`；新增 UIState `showBuildings`／`pipeLayers`／`pipeFlow`／`infoCollapsed`／`roadGrade`；舊 v7 拒絕 |
| `Tile` | `roadGrade?: RoadGrade`（surface/elevated/tunnel）、`roadClass?: RoadClass`（arterial/street/alley） |
| `UIState` | 已有 `showBuildings`／`pipeLayers`／`pipeFlow`／`roadGrade`；新增 `infoCollapsed`；`roadDrag?`（runtime） |
| `GameActions` | 已有 `applyRoadPath?`／`toggleBuildings?`／`setPipeLayer?`／`togglePipeFlow?`；新增 `setRoadGrade()`；main 全部未接 |
| Render | roads（grade/class 寬度）、vehicles（高架／隧道高度）、underground（三層＋flow）、buildings（visible） |
| UI | build panel 重新排版、road grade chips、pipe eye chips、building eye、city collapse state、Shenzhen overlay |
| 版本檔頭 | 所有 Round 8 docs 標 **v0.8.0**；`package.json` 版本由 Lead 更新 |
| 兼容 | v7 舊檔：water+road → tunnel、其他 surface；UIState 新 flags default；v6 及以前拒絕 |

---

## 10. 驗收汇总（每 issue）

| # | tsc/tests | Playwright 尺寸 | Screenshot |
|---|---|---|---|
| 9 | UI tests | 1280×800、457×1078、390×844 | `round8-build-panel-1280x800.png`、`...-457x1078.png`、`...-mobile.png` |
| 10 | existing-city tests | 1920×1080 | `round8-existing-roads-before-after.png` |
| 11 | road tests | 1280×800、390×844 | `round8-road-drag-elevated.png`、`round8-road-drag-tunnel.png` |
| 12 | render/UI tests | 1280×800、390×844 | `round8-pipe-layers.png` |
| 13 | UI tests | 1280×800 | `round8-building-layer-off.png` |
| 14 | placement tests | 1280×800 | `round8-shenzhen-reference.png` |
| 15 | UI tests | 1280×800、390×844 | `round8-city-collapse.png` |
| 16 | vehicles/render tests | 1280×800 | `round8-ferry-water.png` |

---

## 11. 風險與 MVP／P2 總表

| 風險 | 影響 | 對策 |
|---|---|---|
| B 快捷衝突（現時 B = 建造面板） | 玩家混亂 | B 改建築圖層；建造面板改 `Tab`；help／教學更新；P2 提供設定 |
| RoadGrade 舊存檔遷移 | v7 過海道路冇 grade | hydrate：water+road → tunnel；其餘 surface；save v8 |
| 道路密度減少影響建築貼路 | 572 棟 existing 可能唔夠路 | 生成後逐棟檢查貼路；唔貼就補 alley；目標 ≥95% |
| 高架／隧道穿越規則太寬鬆 | 玩家可亂跨建築 | MVP 禁止跨建築；P2 再放寬 |
| 管網 flow 動畫效能 | 3 層 flow 加 draw calls | ≤5 draws/層；shader offset 唔 rebuild；隱藏層 skip |
| 深圳 mask 每 frame 掃描 | 卡頓 | 已有 cache mask；Z 值 O(1)；只喺邊界 overlay 用 texture |
| infoCollapsed 與 showStats 混淆 | 再次 bug | 兩個獨立 state；class 只跟 state；QA 覆蓋 reload／reset |
| ferry path BFS 成本 | 600 地圖水 BFS 每次 spawn | 只在 spawn／地圖變更；cache；最多幾條航線 |
| 版本混亂 | docs v0.8 vs code v0.7 | 文件標 target；Lead bump 後更新 |

- **MVP**：#9 面板、#10 道路 hierarchy、#11 drag＋M/N＋save v8、#12 三層 eye＋flow、#13 B toggle、#14 深圳 block、#15 collapse state、#16 water BFS。
- **P2**：曲線道路／交流道、道路 grade 升級、管網透明度／箭頭、建築 ghost、深圳動畫、面板自訂、渡輪航線編輯。

---

*文件結束。與 `GAME_DESIGN_HK.md` §20、`UI_SPEC_HK.md` §24、`ROUND6_ISSUES.md`、`REAL_GEO_DATA.md` 一併使用；版本目標 **v0.8.0**。*
