# 《維港之城》真實地理數據（REAL_GEO_DATA.md）

> 文件版本：1.0（2026-10-24）｜撰寫：game-designer
> 專案：`hk-city/`《維港之城》｜用途：記錄 Round 4「真實香港地理 480×480 地圖」的**資料來源、生成流程、投影與座標、地形／密度分類規則、授權與限制**。
> 相關文件：`docs/LARGE_MAP_NOTES.md`（480 地圖實作與效能）、`docs/GAME_DESIGN_HK.md`（§2 地圖）、`docs/UI_SPEC_HK.md`（§5 minimap）、`tools/README.md`（原始下載步驟，Lead 維護）。
> **本文件只寫 docs/，不改 code／README。** 所有數據統計由 `src/world/hk-map-data.generated.ts` 解碼核對（2026-10-24 版本）。

---

## 1. 資料來源（✅ 已用於生成）

| 資料 | 提供者 | 格式／解像度 | 用途 | 下載位置 |
|---|---|---|---|---|
| **DTM 5m**（數碼地形模型） | 地政總署（Lands Department） | ASC 網格，5 m | 海岸線、高程、山脈、平地 | <https://www.landsd.gov.hk/landsd_psi_data/SMO/data/Whole_HK_DTM_5m.zip> |
| DTM 資料集頁 | data.gov.hk | — | 授權與版本查詢 | <https://data.gov.hk/en-data/dataset/hk-landsd-openmap-5m-grid-dtm> |
| **Building Outlines（公共）** | 地政總署 via CSDI | GeoJSON；含 `Shape_Area`、`TopHeight`、`Storeys` | 每格建築密度／平均高度 | <https://static.csdi.gov.hk/csdi-webpage/download/51d63757e2675874af80eef94afb6a35/geojson> |
| CSDI Portal | 空間數據共享平台 | — | 資料集搜尋／metadata | <https://portal.csdi.gov.hk/geoportal/> |
| **HK1980 Grid 投影** | EPSG | EPSG:2326 | 經緯度 → 格網座標 | <https://epsg.io/2326> |
| 香港地名／地標／隧道位置 | 公開地理資料（人手整理） | 經緯度清單 | labels／landmarks／tunnels／spawn | 見 `tools/build-hk-data.py` 的 `PLACES`／`LANDMARKS`／`TUNNELS` |

> 原始數據約 100–400MB（DTM zip＋建築 GeoJSON zip），**只需離線下載一次**；生成後的 `src/world/hk-map-data.generated.ts`（約 1MB）已 commit，CI 不需要原始數據。

---

## 2. 生成流程（✅ `tools/build-hk-data.py`）

```
# 1. 下載（一次）
curl -L -o /tmp/dtm.zip https://www.landsd.gov.hk/landsd_psi_data/SMO/data/Whole_HK_DTM_5m.zip
curl -L -o /tmp/csdi.geojson \
  https://static.csdi.gov.hk/csdi-webpage/download/51d63757e2675874af80eef94afb6a35/geojson

# 2. 生成（約 40 秒；Python 3，無第三方依賴）
python3 tools/build-hk-data.py

# 3. Commit 生成檔
git add src/world/hk-map-data.generated.ts
```

腳本輸出 `src/world/hk-map-data.generated.ts`：

- `terrainRle`：480×480 地形（10 種 `TerrainType`，RLE＋base64）
- `elevation`：高程 byte（0..255；water=0）
- `density`：每格建築覆蓋率 0..255
- `buildingHeight`：每格平均建築高度 0..255（≈0..500m）
- `labels`（69 個）、`landmarks`（6 個）、`tunnels`（3 條）、`regions`（15 個）、`spawn`
- 全部座標已轉成 **96×96 設計座標**（renderer 再乘 `state.width/96`）

執行日誌（生成時）：DTM 聚合 → 建築密度 → 地形分類 → 水塘／河流補回 → 輸出＋預覽 PPM。

---

## 3. 地圖範圍、投影與解析度

| 項目 | 值 |
|---|---|
| 地圖 | **480×480 格＝230,400 格** |
| 每格實際距離 | **140 m**（`tileMeters: 140.0`） |
| 地圖覆蓋 | 67.2 km × 67.2 km（覆蓋全港＋部分深圳／珠三角水域） |
| HK1980 東界 `e0` | **798,275 m**（E 由 798,275 至 865,475） |
| HK1980 北界 `nTop` | **857,600 m**（N 由 790,400 至 857,600） |
| 投影 | EPSG:2326（HK1980 Grid，Transverse Mercator；腳本內置公式） |
| DTM 原始網格 | 5 m；XLL/YLL 799,997.5，CELL 5.0，12,751×9,601 |
| DTM 取樣 | stride 7（約 35 m），每格 4×4 取樣平均 |

**座標換算**

```
tileX = floor((E - E0) / TILE_M)
tileY = floor((NTOP - N) / TILE_M)
designX = (tileX + 0.5) / (480/96) - 0.5      // 96×96 設計座標
```

- worldgen 仍用 96 設計座標放地名／地標／隧道／spawn；renderer 用 `state.width/96 = 5×` 換算到 480 地圖。
- **spawn** = 中環，格座標 **(259, 299)**；`HK_SPAWN_DESIGN` 由 `DATA.spawn` 反算。
- 三條過海隧道（設計 x）：西隧 49.4、紅隧 54.4、東隧 59.8；實際格 x 由 renderer/worldgen 換算。

---

## 4. 地形分類規則（`classify()`）

1. **水域**：DTM 有效樣本中陸地比例 `landf < 0.42` → `water`（elevation=0）。全圖水域約 **75.6%**（含南海、維港、內灣）。
2. **山地**：`hmax ≥ 400m` → `mountain`；`hmax ≥ 180m` 或平均 ≥130m → `hill`。
3. **林地**：平均 ≥55m 或 `hmax ≥ 240m` → `forest`。
4. **沙灘**：`hmax < 4m`、`landf < 0.7`、建築覆蓋 <0.02 → `sand`（極少，46 格）。
5. **市區**：建築覆蓋率 `cov ≥ 0.028` 且非 mountain／hill → `urban`。
6. **濕地**：高程 byte <14、隨機遮罩 78%、位於米埔等濕地經緯度框 → `wetland`。
7. **農地**：高程 <46、密度 <12、位於新界農地經緯度框 → `fertile`。
8. **填海地**：高程 <40、位於填海區框（啟德／西九／東涌／將軍澳／葵涌等）→ `reclaimed`。
9. **水塘／河流補回**：DTM 水面高程常 >0，腳本用 9 個真實水塘橢圓＋2 條河流曲線額外 carve 成 `water`（大潭、船灣、萬宜、城門河等）。
10. **elevation byte**：`max(mean, hmax×0.55)` → `(e/650×255)` clamp 1..255；render 用來做山形與雪線。

**生成後實際分佈（解碼 `terrainRle` 統計）**

| 地形 | 格數 | 佔比 |
|---|---|---|
| water | 174,175 | 75.6% |
| hill | 17,255 | 7.5% |
| urban | 12,081 | 5.2% |
| grass | 10,466 | 4.5% |
| forest | 8,784 | 3.8% |
| mountain | 3,927 | 1.7% |
| reclaimed | 1,529 | 0.7% |
| fertile | 1,506 | 0.7% |
| wetland | 631 | 0.3% |
| sand | 46 | 0.02% |
| **可建**（grass／urban／reclaimed／fertile／forest／hill） | **51,561** | **22.4%** |

> **山多平地少**：可建地只有 22.4%，其中真正平坦（grass／urban／reclaimed／fertile）更少；這是香港真實地理，也是玩法核心壓力。文件與 UI 要避免寫「可建地 45%／52%」的舊數字。

---

## 5. 建築密度與高度（density / buildingHeight）

**由 342,233 個真實建築輪廓聚合：**

1. 讀取 `Building_Outline_Public_*_Building_converted.geojson` 的 footprint（GeoJSON polygon）。
2. 用 `Shape_Area`（m²，上限 60,000 m²）作建築面積；無則用經緯度 bbox 換算。
3. 建築高度 `h`：`TopHeight`（米）優先；否則 `Storeys × 3.2m`；皆無則 12m。
4. 將 footprint bbox 映射到 tile：每格累加 `per_area = area/(ntx×nty)`、`per_hv = per_area × h`。
5. `density = clamp(cov/0.5 × 255, 0, 255)`，其中 `cov = 累加面積 / 140²`（覆蓋率 50% 對應 255）。
6. `buildingHeight = avg_h / 500 × 255`（0..500m → 0..255）。

**統計（生成檔）**

- `density > 0`：**21,146 格（9.2%）**，最高 255。
- `buildingHeight > 0`：22,017 格。
- Render 門檻：`density ≥ 28 且 buildingHeight ≥ 4m` 才生成樓群；按 `density`／`bh` 分 3 種 InstancedMesh（`tower` 住宅塔樓／`block` 低層／`office` 玻璃商廈）。
- Starter 模式 render 約 **4,089 座現有樓群**（中環、尖沙咀、旺角、觀塘、荃灣、沙田、將軍澳、東涌、**杏花邨／柴灣／小西灣**等）；empty 模式**不顯示**（`showcaseCity=false`）。

> `density`／`buildingHeight` **只作 render 與統計提示，不影響模擬**（不影響人口、稅收、地價、開發）；模擬仍以玩家的分區／建築為準。

---

## 6. 真實地名、地標、區塊、隧道

| 類別 | 數量 | 內容（節錄） | 用途 |
|---|---|---|---|
| `labels` 地名 | **69** | 中環、金鐘、灣仔、銅鑼灣、北角、鰂魚涌、太古、西灣河、筲箕灣、**杏花邨、柴灣、小西灣**、堅尼地城、香港大學、香港仔、鴨脷洲、赤柱、石澳、山頂、數碼港、尖沙咀、旺角、深水埗、九龍塘、黃大仙、觀塘、藍田、油塘、紅磡、土瓜灣、啟德、西九龍、荃灣、葵涌、青衣、沙田、馬鞍山、大埔、上水、粉嶺、元朗、天水圍、屯門、東涌、大澳、愉景灣、長洲、南丫島、坪洲、西貢、將軍澳、赤鱲角、香港國際機場、大帽山、鳳凰山、太平山、獅子山、大老山、青山、米埔、維多利亞港、吐露港、城門河、大潭水塘、船灣淡水湖、萬宜水庫、香港仔避風塘等 | 3D 地名 LOD 標籤、minimap 方向感、教學 |
| `landmarks` 地標 | **6** | 山頂凌霄閣、天壇大佛、中環摩天輪、尖沙咀鐘樓、會展中心、青馬大橋 | render 地標模型（starter 才顯示） |
| `regions` 區塊 | **15** | 中環天際線、灣仔銅鑼灣、鰂魚涌太古、**杏花邨柴灣**、尖沙咀天際線、紅磡九龍城、觀塘商廈、荃灣樓群、沙田樓群、將軍澳新市鎮、東涌新市鎮、天水圍元朗、**赤鱲角機場（雙跑道）**、機場跑道、**葵涌貨櫃碼頭（真實位置）** | 樓群密度／skyline、機場／碼頭 render |
| `tunnels` 隧道 | **3** | 西區海底隧道、紅磡海底隧道、東區海底隧道 | starter 預置過海道路（empty 冇） |
| `spawn` | 1 | 中環 (259, 299) | 開局鏡頭中心 |

- **地名 LOD**：TOP 16（中環、尖沙咀、旺角、觀塘、荃灣、沙田、屯門、元朗、大埔、將軍澳、東涌、維多利亞港、大帽山、太平山、獅子山、赤鱲角）任何距離都顯示；major 34 個在中景顯示；其餘 minor 只在近景顯示。
- **機場**：按真實赤鱲角緯度經度位置生成雙跑道、客運大樓、飛機（starter 才顯示）。
- **貨櫃碼頭**：葵涌真實位置（設計 x 44.6–49.4、y 48.2–51.8），starter 才顯示貨櫃堆。

---

## 7. 授權與合規

- 原始數據版權屬**香港特別行政區政府**（地政總署／CSDI）；使用須遵守 data.gov.hk 與 CSDI 的開放數據授權條款：<https://data.gov.hk/en/terms-and-conditions>。
- 遊戲內只使用**聚合後的低解析度資料**（每格 140m 的 terrain／density／height byte 與地名座標），不重製原始 DTM／建築輪廓。
- 地名、地標名稱屬公共資料；建築樓群為**程序化重新生成**，不是逐棟複製真實建築模型。
- 生成檔可 commit；**原始 100–400MB 數據不入 repo**。`tools/README.md` 已記錄下載步驟（Lead 維護，文件不重複改寫）。

---

## 8. 已知限制

| 限制 | 說明 | 影響／對策 |
|---|---|---|
| **140m 解析度** | 每格 140m，街道、單棟樓不可見；真正市區街道紋理靠玩家道路 | 設計上以「分區＋道路」呈現，不追求 1:1 街道 |
| **DTM 不含水塘水面** | 水塘高程 >0，會被當成山地／林地 | 腳本用 9 個水塘橢圓＋2 條河流補回 water；仍可能有小水塘缺失 |
| **建築輪廓 bbox 近似** | 用 footprint 外接矩形攤分到格，非精確 rasterize | 高密度區 density 會略擴散；只影響視覺 |
| **山多平地少** | 可建地 22.4%，香港島／九龍核心更少 | 玩法壓力；starter 用 spawn 連通分量確保有平地；empty 要沿平地發展 |
| **地圖拉伸／邊界** | 67.2km 方形含大量海域（75.6% water），維港比例與現實一致但視覺上「海很多」 | 無邊海面 render 隱藏地圖邊界；minimap 可看全圖 |
| **數據版本** | 生成檔註明 `Building_Outline_Public_v20261020`；DTM 版本由下載日決定 | 重建時記錄版本；遊戲數值不受影響 |
| **只作視覺** | density／height 不進模擬 | 玩家不會因為「呢度本身有樓」而自動獲得人口／稅收；要自己劃區 |

---

## 9. 與文件其他章節的關係

| 文件 | 相關章節 |
|---|---|
| `LARGE_MAP_NOTES.md` | 480 實作、render/效能、minimap、save v5、文件 vs 程式碼不一致 |
| `GAME_DESIGN_HK.md` | §0.2 地圖摘要、§2.1–2.4 地圖規格、§3.1 density/height 視覺、§12 save v5、§15 契約 |
| `UI_SPEC_HK.md` | §5.1 minimap（480 canvas／真實地形）、開局畫面「CSDI 真實地理」badge、§13 save v5 |
| `ZONING_GAMEPLAY.md` | 真實地形對分區開發影響、starter 連通道路、empty 沿平地發展 |

---

*文件結束。數據統計以 2026-10-24 的 `hk-map-data.generated.ts` 解碼為準；下載步驟見 `tools/README.md`；原始數據授權見 data.gov.hk。*
