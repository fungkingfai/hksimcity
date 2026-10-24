# 《維港之城》大地圖改版筆記（LARGE_MAP_NOTES.md，Round 4）

> 文件版本：2.0（2026-10-24）｜撰寫：game-designer
> 專案：`hk-city/`｜用途：記錄 Round 3（304 程序化）→ **Round 4（480×480 真實地理）** 的實作對照、效能、導航、存檔與已知限制；供 Lead／world-dev／ui-dev／systems-dev／QA 查閱。
> 相關文件：`REAL_GEO_DATA.md`（數據來源與生成流程）、`GAME_DESIGN_HK.md`（§2 地圖／§12 存檔）、`UI_SPEC_HK.md`（§5 minimap）、`ZONING_GAMEPLAY.md`（真實地形與分區）。
> 標記：**✅ 已實作（依 `src/` 核對）**｜**⚠️ 文件規格**｜**📌 已知限制／不一致**。

---

## 1. 三輪地圖演進（摘要）

| 項目 | Round 2（96×96） | Round 3（304×304） | **Round 4（480×480）** |
|---|---|---|---|
| 地圖 | 96×96＝9,216 格 | 304×304＝92,416 格 | **480×480＝230,400 格**（約 96 版 25 倍面積） |
| 地理來源 | 程序化香港輪廓 | 96 設計座標 ×3.17 程序化 | **CSDI／地政總署真實數據**：DTM 5m＋342,233 個建築輪廓 |
| 每格實際距離 | — | — | **140m**（涵蓋 67.2km×67.2km） |
| 可建面積 | ≥45% | ≥52% | **22.4%**（山多平地少，香港真實比例） |
| 世界尺寸 | 192 | 608 | **960 世界單位**（`WORLD_SPAN=960`） |
| 樓群 | 假樓群 backdrop | 假樓群 | **真實密度樓群 ~4,089 座**（3 InstancedMesh） |
| 開局 | 中環空地 | starter 棋盤／empty 小街區 | starter **連通優先道路網**＋均衡四區；empty **完全 0/0/0** |
| 導航 | 滑鼠 | minimap＋O/P | minimap **480 canvas**＋真實地形；O/P 不變 |
| 存檔 | v2 | v4 compact | **v5 compact**（格式同 v4，版本／尺寸更新） |
| 地形 render | — | terrain 588k tris | **starter overview 1.327M tris／402 calls**；empty 1.032M／37 calls |

---

## 2. 480 地圖尺度與座標（✅ 已實作）

| 常數／概念 | 值 | 說明 |
|---|---|---|
| `GRID_WIDTH`／`GRID_HEIGHT` | **480／480** | 230,400 格 |
| `GAME_VERSION` | **5** | save v5 |
| `TILE_SIZE` | 2 | 每格 2 世界單位 |
| `WORLD_SPAN` | **960** | 480×2 |
| `MAP_SCALE` | **5**（480/96） | 渲染霧、天空、相機距離、裝飾密度換算 |
| `HK_DESIGN_SIZE` | 96 | worldgen 設計座標基準（真實數據也先轉 96 設計座標） |
| 每格實際距離 | **140m** | `tileMeters=140.0` |
| 地圖範圍 | HK1980 E 798,275–865,475、N 790,400–857,600 | EPSG:2326 |
| spawn | **(259, 299)**（中環） | `DATA.spawn`；`HK_SPAWN_DESIGN` 由 `state.width/96` 反算 |
| 過海隧道 | 西隧／紅隧／東隧（設計 x 49.4／54.4／59.8） | 只限 starter；empty 完全冇道路 |

**世界生成（✅）**

- `generateRealWorld(seed, options)` 解碼 `hk-map-data.generated.ts`：
  - `terrainRle` → 10 種地形；`elevation`（water=0，陸地 0.3 + byte/255×0.62）；
  - `density` → `Tile.density`（0..255，0 時 undefined）；
  - `buildingHeight` → `Tile.buildingHeight`（byte → 0..500m，>2m 才寫入）；
  - `labels`／`landmarks`／`tunnels`／`regions` 轉設計座標 export（`HK_PLACES`／`HK_LANDMARKS`／`HK_TUNNELS`／`HK_REGIONS`）。
- starter 才加 3 條過海隧道＋入口引道；empty 模式**零道路**。
- 可建地 22.4%（grass／urban／reclaimed／fertile／forest／hill），真正平坦地（grass／urban／reclaimed／fertile）更少；**唔可以再寫「可建 ≥45%／52%」**。

---

## 3. 真實地形分類與限制（🔗 詳見 `REAL_GEO_DATA.md`）

- DTM 5m（35m 取樣、4×4/tile）→ 水域／山／林地／平地；建築輪廓 → density／height。
- 水塘水面 DTM 不含，腳本用 9 個水塘橢圓＋2 條河流（城門河等）補回 water。
- 實際分佈：water **75.6%**、hill 7.5%、urban 5.2%、grass 4.5%、forest 3.8%、mountain 1.7%、reclaimed／fertile 各 0.7%。
- density >0 的格 21,146（9.2%）；render 門檻 `density ≥ 28 且 bh ≥ 4m`。
- **只作視覺／統計**：density／buildingHeight 不影響人口、稅收、地價或分區開發；玩家仍然要自己劃區。

---

## 4. starter／empty（✅ 已實作）

### 4.1 starter：連通優先道路網

Round 4 真實海岸線＋山地令「隨機鋪街」易斷開（QA 修好之前 9 個路網分量嘅 P0）。`starter-town.ts` 改為：

1. spawn 若不可建（貼海）→ 找最近可建格作城鎮中心。
2. `connectedComponent(spawn, ROAD_RADIUS=14)`：先取 spawn 所屬可建地**連通分量**。
3. `buildConnectedRoads()`：以 **GRID_STEP=3** 的節點格網生長道路，只鋪在同一分量內；再用 BFS 連接孤立節點 → **保證全鎮同一路網**。
4. `fillZones()`：只在道路可達（BFS 路距 ≤2）的格劃區；按方位分住宅／商業／工業；農田只可 grass／fertile，並最少補到 24 格。
5. 公共設施 **10 項**（全部貼近市中心／住宅、連通路網）：發電廠、水務設施、警署、消防局、**學校×2**、公園、巴士總站、港鐵站、**醫院**。
6. 自動建築 **34 棟**：公共屋邨×3、唐樓×5、劏房×3、便利店×3、茶餐廳×3、街市×2、超市、商廈、貨倉×2、進口商行、食品廠、工廈×2、**農田×7**。
7. 倉庫起始庫存：**食品 520、日用品 180**；店舖食品 80、日用品 50。
8. 庫房 **$6,500,000**；warm-up **10 日**；config `targetPopulation=120`，**QA 實測開局約 146 人**（健康增長，非 bug）。

> 驗收重點：全鎮道路同一分量、公共設施覆蓋住宅、市民可通勤、農田有工人；不再出現「斷開街網」或「服務覆蓋 0%」。

### 4.2 empty：完全 0/0/0

- `generateRealWorld({starterRoads:false})` → **零道路、零建築、零分區、零隧道**；**唔會**顯示真實樓群／地標／機場／貨櫃碼頭（render `showcaseCity=false`）。
- 保留：真實地形、山脈、海岸、樹木、海面船隻；5 名市民（設計要求；📌 seeding 仍未見於 `createGameState`，見 §8）。
- 庫房 **$8,000,000**；玩法提示「沿平地發展、先鋪路再劃區」；大地圖靠 minimap O/P 導航。

---

## 5. Render：真實樓群、雪線、海面、地名 LOD（✅ 已實作）

| 項目 | 行為 |
|---|---|
| 真實密度樓群 | `showcaseCity`（starter）才生成；用 `tile.density`＋`tile.buildingHeight`；門檻 density≥28／bh≥4；分 **3 個 InstancedMesh**：`tower` 住宅塔樓／`block` 低層／`office` 玻璃商廈；約 **4,089 座**（總 3 draw calls） |
| 樓宇高度 | `bh` 0..500m → hUnits（1.1–27），skyline 區＋高樓 → office；高密度市區再加一幢矮鄰樓 |
| **白色階梯修正** | 雪線改為 **elevation ≥ 0.8**（0.8–0.92 漸變）；只在 `weather='snow'` 或冬季 `tempC ≤ 6°C` 上雪；低地另有霜 `snowCover()`（12°C 以下）；不再出現全圖白色階梯 |
| 無邊海面 | 地圖外圍加 `terrain-outer-sea`（aOuter=1、aDeep=0），與地圖邊緣水面同色，隱藏 480 地圖邊界 |
| 地名 LOD | TOP 16（中環、尖沙咀、旺角、觀塘、荃灣、沙田、屯門、元朗、大埔、將軍澳、東涌、維多利亞港、大帽山、太平山、獅子山、赤鱲角）任何距離顯示；major 34 個中景；其餘近景；`aMajor` attribute＋smoothstep |
| 機場／貨櫃碼頭 | 真實 position（赤鱲角雙跑道、葵涌貨櫃碼頭）只在 starter 顯示；empty 隱藏 |
| minimap 地形 | 480 canvas、用 `Tile.terrain` 真地形底色＋道路／分區／建築點／視野框；250ms 節流、地形 offscreen 快取 |

**效能（Lead 實測）**

| 場景 | 三角形 | Draw calls | 備註 |
|---|---|---|---|
| starter overview（O 全圖） | **1.327M** | **402** | 真實樓群＋地形＋道路 |
| empty overview（O 全圖） | **1.032M** | **37** | 完全空地圖、無樓群 |
| sim 正常幀 | — | — | 304 舊版約 0.23ms；480 版以 QA 實測為準 |
| 首次 worldgen | — | — | 480×480 解碼＋生成，**約 1.5–2 秒**（boot screen「正在生成 480×480 香港地圖」） |

---

## 6. Minimap（480 版）

- 位置：桌面畫布右下；手機 132px 預設收起；canvas 內部解析度 = `state.width×state.height`（480×480）。
- 地形底色 offscreen 快取（seed／尺寸不變就唔重畫）；每 250ms 或狀態變更重畫；道路淺灰、四色分區半透明、建築點（auto 分區色／ploppable 分類色＋白點）、spawn 粉紅點、鏡頭視野框青色。
- 點擊／拖曳 → `actions.focusTile(tx, ty)`；按鈕：全圖 `fitMap()`（O）、市中心 `focusTile(spawn)`（P）、分區 `toggleZones()`（L）。
- 室內模式／開局畫面隱藏；地圖 480 下 minimap 是唯一可靠 overview。

---

## 7. 存檔 v5（✅ `core/save.ts`）

- `GAME_VERSION=5`；格式沿用 v4 compact：`hk-city-compact`、seed＋`tileEdits`（road｜sidewalk<<1｜zone<<2）＋`state:Omit<GameState,'tiles'>`＋info 快照；大小約 80–140KB。
- 還原：用 seed 重新 `generateWorld(seed,480,480,{starterRoads: gameMode==='starter'})` → 套 sparse edits → 重建 `buildingId` → 補 spawn／gameMode。
- 只接受 **480×480、version 5**；96×96（v2）／304×304（v4）舊存檔拒絕（提示重新開局）。
- 存檔列表用 `info` 快照，不重新解碼 480 地圖（避免 1–2 秒卡）。
- 📌 `save.ts` 檔頭註解仍寫「v4（304×304）」——純註解，實際用 config 5／480；已列入 §8。

---

## 8. 文件 vs 程式碼不一致／待辦（給 Lead）

| # | 項目 | 文件現況 | 程式碼現況 | 建議 |
|---|---|---|---|---|
| 1 | **empty 5 名市民** | 文件／UI 文案寫 5 名 | `createGameState('empty')` 的 `citizens=[]`，未見初始 seeding | new-game 補 5 名，或改文案 |
| 2 | **save.ts 檔頭** | doc 用 v5／480 | 檔頭註解仍寫 v4／304×304、compact 描述 | 更新註解（實際 GAME_VERSION=5、GRID=480） |
| 3 | **worldgen 舊註解** | — | 仍保留 legacy 96 設計 path／LEGACY_TUNNELS 與部分舊註解（真實分支已用 `generateRealWorld`） | 清理或標明 legacy |
| 4 | **zoning.ts 檔頭** | doc 用 15／6／1,200 | 檔頭仍寫 2／5／420、0.45 門檻（Round 3 遺留） | systems-dev 更新註解 |
| 5 | **starter 人數** | config `targetPopulation=120` | QA 實測約 **146 人**（warm-up 自然遷入） | 文件寫「目標 120、實測約 146」；如要精準可調 immigration cap |
| 6 | **可建比例** | 舊文件曾寫 ≥45%／52% | 真實數據 **22.4%**；worldgen 真實分支唔會再補到 52% | 文件已改 22.4%；舊驗收條件要下調 |
| 7 | **density/height** | 文件寫「只作 visual」 | `Tile.density/buildingHeight` 只被 render 讀，sim 未使用 | 正確；UI 不應把 density 當人口／稅收 |
| 8 | **minimap 狀態** | UI_SPEC 寫 runtime＋showZones | 無 `ui.showMinimap` flag | 文件已按實作寫，不需新 state |

---

## 9. 已知限制（Round 4）

| 限制 | 影響 | 對策 |
|---|---|---|
| 140m 解析度 | 街道／單棟樓不可見 | 以分區＋道路呈現城市紋理 |
| 可建地 22.4% | 玩家可發展空間少、山邊／海邊限制多 | starter 連通分量保證平地；empty 教學沿平地發展 |
| 地圖 75.6% 水域 | 視覺「海很多」、跨島交通需求大 | 無邊海面 render；渡輪／港鐵／隧道 |
| 真實數據版本 | 重建時可能與 2026-10 版本有差異 | 生成檔 commit；記錄版本 |
| 首次載入 1.5–2s | 480 解碼＋生成 | boot screen；存檔列表不重建地形 |
| 舊存檔不兼容 | v5 只接受 480×480 | 明確提示重新開局 |

---

## 10. 文件更新索引（Round 4）

| 文件 | 已更新章節 |
|---|---|
| `REAL_GEO_DATA.md`（新） | 資料來源／URL、生成流程、投影與範圍、terrain 分類、density／height、地名／地標／隧道、授權、限制 |
| `GAME_DESIGN_HK.md` | §0.2 480×480／CSDI；§2.1 尺度＋140m；§2.2 設計座標 ×5；§2.4 真實 spawn／隧道；§3.1 density 樓群；§10 minimap 480；§12 save v5；§13 平衡（22.4% 可建）；§15 契約；§16 分工；§17 DoD；附錄 A/C/D |
| `UI_SPEC_HK.md` | §5 版面／§5.1 minimap 480＋真實地形；§7.6 開局 CSDI badge／empty 完全空地；§8 地圖規模；§13 save v5；§16 手機；§21 驗收 |
| `ZONING_GAMEPLAY.md` | 真實地形對分區影響（22.4% 可建、山多平地少）、starter 連通道路／服務、empty 沿平地教學、density/height 只是 visual、save v5 |
| 本文件 | Round 4 技術對照、效能、已知限制、不一致清單 |

---

*文件結束。數據細節見 `REAL_GEO_DATA.md`；數值以 `src/core/config.ts` 為最終依據；效能數字為 Lead 於 480 starter / empty 實測。*
