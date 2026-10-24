# tools — 真實香港地理數據生成

`build-hk-data.py` 由香港公開地理空間數據離線生成 `src/world/hk-map-data.generated.ts`（遊戲 **600×600 地圖，每格 112m**；範圍不變：HK1980 Grid E 798,275–865,475、N 790,400–857,600）。

## 資料來源

| 數據 | 用途 | 來源 |
|---|---|---|
| **DTM 5m**（地政總署數碼地形模型，5 米網格 ASC） | 高程、land fraction（海岸線） | <https://www.landsd.gov.hk/landsd_psi_data/SMO/data/Whole_HK_DTM_5m.zip>（data.gov.hk：`hk-landsd-openmap-5m-grid-dtm`） |
| **Building Outlines（公共）**（地政總署／CSDI 建築物輪廓 GeoJSON，含 footprint、TopHeight、Storeys） | 建築密度／高度 | CSDI Portal：<https://portal.csdi.gov.hk/geoportal/#metadataInfoPanel>；下載：<https://static.csdi.gov.hk/csdi-webpage/download/51d63757e2675874af80eef94afb6a35/geojson>（zip 內 `Building_Outline_Public_*_Building_converted.geojson`，現用 v20261020） |
| **Impounding Reservoirs**（水務署官方水塘多邊形，17 個） | 水塘水域 rasterize | data.gov.hk「Impounding Reservoirs」dataset（WSD）＋ CSDI file-api；已存 `tools/data/impounding-reservoirs.geojson`（props：`INSTALLATION_ID`、`NAME`、`CHINESE_NAME`、`CAPACITY` 等） |
| **2020 Raster Grids on Land Utilization（10m）**（規劃署土地利用 raster） | 林地／農地／濕地／市區／機場／碼頭分類 | data.gov.hk／CSDI dataset `pland_rcd_1634282545137_98227`；已存 `tools/data/landuse2020-10m.raw.z` |

`tools/data/landuse2020-10m.raw.z` 規格（Lead 由官方數據轉檔）：
- `zlib.decompress()` 後 = **30,600,000 bytes = 6375 × 4800**，每 pixel 10m，row-major、top-left 開始。
- pixel (col,row) 中心：`E = 800000 + (col+0.5)*10`、`N = 848000 - (row+0.5)*10`（HK1980 Grid）。
- value → 土地用途：`0` 無資料/海（用 DTM land mask 決定）；`1` Private Residential、`2` Public Residential、`3` Rural Settlement、`11` Commercial/Business、`21` Industrial、`22` Industrial Estates/Science Parks、`23` Warehouse/Open Storage、`31` Government/Institutional/Community、`32` Open Space/Recreation、`41` Roads & Transport、`42` Railways、`43` Airport、`44` Port Facilities、`51` Cemeteries、`52` Utilities、`53` Vacant/Construction、`54` Others、`61` Agricultural Land、`62` Fish Ponds/Gei Wais、`71` Woodland、`72` Shrubland、`73` Grassland、`74` Mangrove/Swamp、`81` Badland、`83` Rocky Shore、`91` Reservoirs、`92` Streams/Nullahs。

## 離線生成步驟
```bash
# 1. 下載原始數據（約 100MB；只需做一次；repo 已有水塘／土地利用檔）
curl -L -o /tmp/dtm.zip https://www.landsd.gov.hk/landsd_psi_data/SMO/data/Whole_HK_DTM_5m.zip
curl -L -o /tmp/csdi.zip \
  https://static.csdi.gov.hk/csdi-webpage/download/51d63757e2675874af80eef94afb6a35/geojson

# 2. 生成（600×600，約 2 分鐘）
python3 tools/build-hk-data.py

# 3. 提交生成檔（CI 不需要原始 DTM／建築物數據）
git add src/world/hk-map-data.generated.ts
```

腳本可用環境變數覆寫輸入路徑：`HK_DTM_ZIP`、`HK_BUILDINGS_ZIP`、`HK_LANDUSE_RAWZ`、`HK_RESERVOIRS_GEOJSON`。

## 生成內容
`src/world/hk-map-data.generated.ts`（約 1.5MB）：
- `terrainRle`：每格地形（water/sand/grass/fertile/wetland/forest/hill/mountain/urban/reclaimed）
- `elevation`：DTM 高程（0..255；海／水塘 = 0）
- `density`：每格建築物覆蓋率（342,233 個建築輪廓聚合，0..255）
- `buildingHeight`：每格平均建築高度（TopHeight/Storeys，0..255 ≈ 0..500m）
- `labels`／`landmarks`／`tunnels`／`regions`／`spawn`：真實座標轉 **96 設計座標**（renderer 按 600/96 換算）
- 地圖：600×600、每格 112m、範圍 E 798,275–865,475／N 790,400–857,600
- 分類優先級：DTM 山勢（>120m → hill、>380m／mean>300m → mountain）**override** landuse；landuse 只用於低地 refine；水塘用 WSD 官方 17 個多邊形 rasterize（另加 黃泥涌／流水響／鶴藪 小型水塘近似橢圓補底）→ water + elevation 0。

> 原始數據版權屬香港特別行政區政府（地政總署／水務署／規劃署／CSDI）。使用須遵守 data.gov.hk 及 CSDI 開放數據授權條款；發佈或展示地圖時請標明資料來源（「資料來源：香港特別行政區政府 data.gov.hk／CSDI」）。
