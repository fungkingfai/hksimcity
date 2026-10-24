# tools — 真實香港地理數據生成

`build-hk-data.py` 由香港公開地理空間數據離線生成 `src/world/hk-map-data.generated.ts`（遊戲 480×480 地圖）。

## 資料來源
- **DTM 5m**（地政總署數碼地形模型，5 米網格 ASC）：
  <https://www.landsd.gov.hk/landsd_psi_data/SMO/data/Whole_HK_DTM_5m.zip>
  （data.gov.hk 資料集：`hk-landsd-openmap-5m-grid-dtm`）
- **Building Outlines（公共）**：CSDI Portal／地政總署建築物輪廓 GeoJSON（含 footprint、TopHeight、Storeys）：
  下載頁：<https://portal.csdi.gov.hk/geoportal/#metadataInfoPanel>
  直接下載：<https://static.csdi.gov.hk/csdi-webpage/download/51d63757e2675874af80eef94afb6a35/geojson>
  （zip 內 `Building_Outline_Public_*_Building_converted.geojson`（腳本現用 v20261020 版本，更新數據時要改檔名））
- 經緯度→HK1980 Grid 轉換：EPSG:2326 Transverse Mercator 公式（腳本內置）。

## 離線生成步驟
```bash
# 1. 下載原始數據（約 100MB；只需做一次）
curl -L -o /tmp/dtm.zip https://www.landsd.gov.hk/landsd_psi_data/SMO/data/Whole_HK_DTM_5m.zip
curl -L -o /tmp/csdi.zip \
  https://static.csdi.gov.hk/csdi-webpage/download/51d63757e2675874af80eef94afb6a35/geojson

# 2. 生成（約 40 秒）
python3 tools/build-hk-data.py

# 3. 提交生成檔（CI 不需要原始 300MB 數據）
git add src/world/hk-map-data.generated.ts
```

## 生成內容
`src/world/hk-map-data.generated.ts`（約 1MB）：
- `terrainRle`：每格地形（water/sand/grass/fertile/wetland/forest/hill/mountain/urban/reclaimed）
- `elevation`：DTM 高程（0..255）
- `density`：每格建築物覆蓋率（來自 342,233 個建築輪廓，0..255）
- `buildingHeight`：每格平均建築高度（TopHeight/Storeys，0..255 ≈ 0..500m）
- `labels`／`landmarks`／`tunnels`／`regions`／`spawn`：真實座標轉 96 設計座標
- 地圖範圍：HK1980 E 798,275–865,475、N 790,400–857,600；每格 140m；480×480

> 原始數據版權屬香港特別行政區政府（地政總署／CSDI），使用須遵守 data.gov.hk 及 CSDI 開放數據授權條款。
