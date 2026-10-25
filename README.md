# 維港之城 · Victoria Harbour City

> 以 **three.js + TypeScript + Vite** 打造的**香港風格城市建造模擬遊戲**，
> 玩法參考 **SimCity / Cities: Skylines 2 的分區式城市建造**：
> 你只需要鋪馬路（已整合行人路）、劃分**住宅／商業／工業／農業區**，
> 開發商便會按 **RCI+F 需求** 與公共服務（警力／消防／教育／醫療／交通）自動興建唐樓、公屋、屋苑、
> 茶餐廳、街市、超市、商廈、商場、工廈、貨倉與農田；公共設施與交通由你親自規劃。
> 在 **600×600（360,000 格；每格 112m，約舊版 39 倍面積）香港大地圖** 上發展城市——地圖地形參考 **香港地理空間數據共享平台（CSDI）、地政總署 DTM 5m／建築物輪廓、規劃署土地利用及水務署水塘開放數據**，擁有更精細的海岸線、真實水塘水面、維港、山脈、離島與市區分佈：
> 看市民搭港鐵返工、貨車送貨、維港煙花綻放；**每一棟建築都可以走進去**，
> 還有四季、颱風與天文台警告。可以選擇「**已有城鎮**」（預建中環起步城鎮）或「**由零開始**」（完全空地：零道路／零建築／零分區、5 名市民）兩種開局。
> 大地圖導航：右下 **minimap** 點擊跳轉、`O` 全圖 overview、`P` 返回市中心。

🌐 **進入遊戲**
- **線上（Cloudflare Workers，已上線）**：<https://hksimcity.fungkingfai.workers.dev/>
- **GitHub 原始碼**：<https://github.com/fungkingfai/hksimcity>（push 後 Cloudflare Workers Builds 自動部署）
  - CI 注意：Cloudflare Builds 只執行 `npx wrangler deploy`、冇獨立 build step，因此 repo 用 `postinstall`（`scripts/ci-build.mjs`）自動建置 `dist/`，同時 commit 已建置的 `dist/` 作 fallback。
- 本機：`npm run dev` → <http://127.0.0.1:5273>（區網：`http://<你的IP>:5273`）
- 生產建置預覽：`npm run build && npm run preview` → <http://127.0.0.1:4273>

```bash
npm install
npm run dev        # 開發伺服器：http://127.0.0.1:5273（區網：http://<你的IP>:5273）
npm run build      # 型別檢查 + 生產建置（輸出 dist/）
npm run preview    # 預覽生產建置：http://127.0.0.1:4273
```

> 需要支援 WebGL 的瀏覽器（Chrome／Edge／Firefox／Safari）。手機／平板會自動切換手機版介面。

![維港全景](docs/screenshots/hero.png)

| 選擇開局模式（600×600 真實地理大地圖） | 由零開始：完全空地圖 |
|---|---|
| ![開局](docs/screenshots/start.png) | ![空地圖](docs/screenshots/empty.png) |
| **分區式城市規劃** | **全港大地圖 overview** |
| ![分區](docs/screenshots/zoning.png) | ![全圖](docs/screenshots/map.png) |
| **走進建築室內** | **財政月報** |
|---|---|
| ![室內](docs/screenshots/interior.png) | ![財政](docs/screenshots/finance.png) |
| **維港夜景** | **颱風襲港** |
| ![夜景](docs/screenshots/night.png) | ![颱風](docs/screenshots/typhoon.png) |
| **交通面板** | **存檔系統** |
| ![交通](docs/screenshots/transit.png) | ![存檔](docs/screenshots/save.png) |
| **雨天** | **寒潮雪景** |
| ![雨天](docs/screenshots/rain.png) | ![雪景](docs/screenshots/snow.png) |
| **全港地圖** | **街道細節** |
| ![地圖](docs/screenshots/map.png) | ![城市](docs/screenshots/city.png) |

| 手機城市畫面 | 手機營造面板 |
|---|---|
| ![手機城市](docs/screenshots/mobile-city.png) | ![手機營造](docs/screenshots/mobile-build.png) |

## 遊戲特色

| 系統 | 內容 |
|---|---|
| 🗺️ **香港地圖（600×600 真實地理）** | 360,000 格、每格 112m＝舊版 96×96 的約 39 倍面積。**DTM 5m** 重新以 land fraction 細化海岸線；**規劃署 2020 土地利用 10m raster** refine 林地／農地／濕地／市區；**水務署 17 個官方水塘多邊形** 補回船灣淡水湖、萬宜水庫、大欖涌、城門、石壁、大潭、香港仔、薄扶林、九龍水塘群等水面。**342,233 個真實建築物輪廓** 轉化為每格密度與高度，驅動 333 棟真正可運作現有樓宇＋60 座現有公共設施（中環 CBD、尖沙咀、觀塘、荃灣、沙田、將軍澳、東涌等）。三條過海隧道（starter） |
| 💧 **地下公用設施管網** | 真正鋪設 **食水管／污水管／電力電纜**（地下層 `U`、每格成本／月維護）：發電廠、水務設施、污水處理廠、水塔、海水化淡廠、排污口；BFS 接駁、容量池、距離／容量短缺、水質與污水溢出後果；公用設施面板顯示供應／需求／覆蓋／接駁；starter 預建管網 |
| 🚌 **巴士／小巴路線管理** | 巴士總站／小巴車廠＋巴士站／小巴站；交通面板「路線管理」建線（地圖點站、Undo、完成）、車數／票價／班次／顏色、每日載客與盈虧；紅綠 Van／雙層巴士載客量、颱風停駛；路線 overlay 與車輛行駛 |
| ✈️ **機場／貨櫃碼頭貿易** | 赤鱲角機場區建客運大樓／空運貨運站；葵涌貨櫃碼頭區建貨櫃碼頭／閘口／堆場；客流、貨運噸數、TEU 吞吐、收入、就業、道路／交通接駁、噪音；設施升級；`Y` 貿易面板 |
| 🏙️ **真實現有樓群（Issue #7）** | starter 開局由土地用途、roadHint 道路、DTM 密度生成 **333 棟真正可運作 existing 樓宇**（住宅／商業／工業／公共設施 60 座），全部貼主道路網絡（components=1、100% 連通），有居民／職位／可拆卸；唔再係裝飾 faux skyline；empty 模式完全不變 |
| 🌉 **深圳河與邊境口岸（Issue #4／#6）** | 地圖北面加入真實深圳河（616 格水面）＋深圳市區意象；羅湖（鐵路）／落馬洲／文錦渡／沙頭角（道路）4 個邊境口岸，接駁道路／鐵路後內地每日供應 **60（道路）／120（鐵路）food**；貿易面板「內地供應」顯示 |
| 🚄 **港鐵地下／地上鐵路規劃（Issue #5）** | 三種鋪軌工具：地面 $18k／高架 $65k（可跨水）／地下 $42k（可過海穿山），鋪設 mtrStation 連成鐵路網；鐵路網面板（總長／接駁站／孤立站／乘客／維護）；地下軌只喺 `U` 圖層顯示；列車按網絡行駛；save v8 `railEdits`／`roadGradeEdits` |
| 🛣️ **道路拉線／高架／隧道（#11）** | 道路工具改為 **拖曳起點→終點** 自動鋪 L 形路徑（預覽綠/紅、放開才扣錢）；拖曳時 **M＝高架橋（$75k/格，可跨海）**、**N＝隧道（$60k/格，可穿山過海）**、再按返回地面；render 高架橋面＋柱、隧道入口＋U 層隧道管；save v8 `roadGradeEdits` |
| 🏘️ **現有道路密度優化（#10）** | starter 道路由 9,700+ 格減至 **3,322 格**（主幹＋1,780 格窄街）；窄街 render 0.52 tile 深灰、無標線；道路 components=1、existing 樓 100% 貼主路網；市中心唔再一片黑 |
| 🧩 **管網分層＋流水（#12）** | 地下管網可獨立顯示 **食水（藍）／污水（黃綠）／電力（黃）** 三層；公用面板 eye chips＋「流水動畫」toggle；U 層關閉全隱藏；流動光點沿管移動（≤4 draws） |
| 👁️ **顯示／隱藏建築圖層（#13）** | topbar 建築 toggle＋快捷 **B**；隱藏所有現有／玩家建築（LOD＋正常＋ghost），保留地形／道路／標籤，方便規劃；UIState 持久化 |
| 🚧 **深圳市參考區（#14）** | 深圳市範圍只作參考：placement／分區／道路／管道／鐵路／拆卸全部拒絕；render 斜線 hatch overlay＋邊界＋「深圳市（參考）· 不可建設」label；hover 加強 |
| 🚢 **渡輪航道修正（#16）** | 渡輪改用 **水域 BFS 完整 path**（每格必須水、3–400 格），逐格推進、每次驗證航道；唔會再出現船喺馬路／陸上行；7 個 ferry tests |
| 🗂️ **建造面板重新設計（#9）／城事縮退修正（#15）** | 建造面板 header 固定＋內容獨立滾動＋rail 區可摺疊＋公共建築 tabs sticky，1280×800 全 26 種可達；城事「›」縮退持久（同步 `ui.showStats`），handle 可展開 |
| 🧭 **分區式城市規劃** | 鋪馬路（**車道＋行人路整合**）→ 劃分**住宅區／商業區／工業區／農業區**（Z／C／V／N）→ 開發商按需求自動建屋；可取消分區、重新規劃；分區色塊可顯示／隱藏（L） |
| 📈 **RCI+F 需求平衡** | 住宅／商業／工業／農業四條需求條（−60%～+90%）；需求受就業、空置、幸福、失業、食品、貨運影響；供應過剩時開發商暫停建屋 |
| 🏗️ **自動開發 19 種建築** | 住宅：劏房→唐樓→公屋→居屋→私人屋苑→豪宅；商業：便利店→茶餐廳→街市→超市→酒樓→商廈→商場；工業：貨倉→進口商行→食品廠→工廈→石礦場；農業：農田。按地塊發展分數（供電／供水／警／消／校／醫／交通／幸福／地價）決定等級 |
| 🏛️ **13 種公共設施（手動放置）** | 學校、醫院、警署、消防局、發電廠、水務設施、公園、海濱長廊、港鐵站、巴士總站、電車站、渡輪碼頭、貨櫃碼頭 |
| 👥 **香港市民** | 陳志明、Karen 黃等香港姓名；住戶、就業、通勤、購物、消閒、幸福度；遷入速度跟隨住宅需求 |
| 🚌 **交通工具** | 雙層巴士、小巴、紅的士、叮叮電車、天星小輪、私家車、電單車、貨車／客貨 van；港鐵站／巴士總站／電車站／渡輪碼頭提供通勤覆蓋與車費收入 |
| 🚚 **物流系統** | 進口商行／貨櫃碼頭 → 貨倉 → 街市／超市／便利店 → 市民；農田 → 食品；石礦場 → 工廈 → 電子產品；貨車沿道路送貨 |
| 💰 **財政系統** | 薪俸稅、利得稅、差餉三條稅率滑桿；賣地收入、車費、零售服務收入；維護費、公務員薪酬、福利開支；分類月報表與歷史走勢 |
| 🌦️ **天氣系統** | 晝夜（城市霓虹與萬家燈火）、春夏秋冬、晴／陰／雨／颱風（八號風球、渡輪停航、地盤停工）／霧／雪（寒潮，大帽山結霜），天文台警告實時顯示 |
| 🚪 **可進入建築** | 雙擊或點「進入建築」即可走進室內；32 種建築各有香港室內場景（唐樓鐵閘碌架床、劏房板間房、茶餐廳卡位、港鐵月台、貨櫃碼頭吊機……），並顯示住客／員工、庫存、服務與本月帳目 |
| 🚩 **兩種開局模式** | **已有城鎮**（港島北岸中環／灣仔一帶：連通優先道路網、均衡四區、約 150 名居民、預建地下管網＋污水處理，適合新手）／**由零開始**（**完全空地圖**：零道路、零建築、零分區、零管網；5 名市民＋$800 萬，由第一條路開始） |
| 🧭 **大地圖導航** | 右下 **minimap**（600×600 概覽：真實水陸、道路、四色分區、existing 樓群、鏡頭視野框；點擊／拖曳跳轉）、`O` 全圖 overview、`P` 返回市中心；手機版可摺疊小地圖 |
| 💾 **存檔系統** | 自動存檔 ＋ 3 個手動存檔格 ＋ JSON 匯出／匯入；**v8 精簡存檔**（種子＋稀疏道路／分區／管道／鐵路／道路 grade 變更；完整 360k 格 JSON 會超出 localStorage）；重新整理頁面自動接續 |
| 🎨 **介面** | 霓虹港風：深藍夜色、霓虹粉／青／金、港鐵紅、玻璃面板；建造／城事／財政／交通／存檔／教學面板 |
| 📱 **手機／桌面雙介面** | 自動偵測裝置；手機底部導覽＋底部面板＋觸控手勢（單指平移、雙指縮放／旋轉、點擊建造、連點進屋） |

## 操作

| 操作 | 說明 |
|---|---|
| 左鍵 | 建造／劃區／選取（道路與分區刷子可按住拖曳連續繪製） |
| 雙擊建築 | 進入建築室內 |
| 右鍵拖曳 | 旋轉視角；右鍵點擊取消工具 |
| 中鍵拖曳 / Shift＋左鍵 | 平移視角 |
| 滾輪 | 縮放 |
| WASD / 方向鍵 | 平移 |
| Q / E | 旋轉 |
| 空白鍵 | 暫停／繼續 |
| 1 / 2 / 3 / 0 | 倍速 / 暫停 |
| **Z / C / V / N** | 住宅區 / 商業區 / 工業區 / 農業區刷子 |
| **M** | 取消分區（退 50%）；道路工具拖曳時＝切換高架橋 |
| **R / X** | 馬路（含行人路） / 拆卸工具 |
| **L** | 顯示／隱藏分區色塊 |
| **O / P** | 全圖 overview / 返回市中心 |
| 點擊 minimap | 跳轉至該區（拖曳連續移動） |
| **N** | 農業區刷子；道路工具拖曳時＝切換隧道 |
| **B** | 顯示／隱藏建築圖層 |
| **U** | 地下層（水／污水／電／鐵路／道路隧道） |
| F / T / J / H / Esc | 財政 / 交通 / 城事 / 說明 / 取消 |

**手機操作**：單指點擊建造／選取；單指拖曳平移；雙指捏合縮放；雙指旋轉；連點同一建築兩次進入室內；底部導覽切換面板。亦可用 `?ui=mobile` 或 `?ui=desktop` 強制指定介面。

**新手五步（分區玩法）**：鋪馬路（已含行人路）→ 劃住宅區（Z）→ 劃商業區（C）／工業區（V）／農業區（N）→ 建公共設施（警署、消防局、學校、醫院、發電廠、水務）→ 看 RCI+F 需求條平衡城市、調稅率與擴展交通。

## 截圖

| **真實 600×600 全港 overview** | **東區：杏花邨／柴灣／小西灣** |
|---|---|
| ![地圖](docs/screenshots/map.png) | ![東區](docs/screenshots/east.png) |
| **地下管網（U）** | **公用設施面板** |
| ![地下管網](docs/screenshots/underground.png) | ![公用設施](docs/screenshots/utility.png) |
| **巴士／小巴路線 overlay** | **交通／路線管理面板** |
| ![路線](docs/screenshots/transit-route.png) | ![路線管理](docs/screenshots/transit-lines.png) |
| **機場／貨櫃碼頭貿易面板** | **水塘（船灣淡水湖）** |
| ![貿易](docs/screenshots/trade.png) | ![水塘](docs/screenshots/reservoir.png) |
|---|---|
| **現有樓群真樓（overview LOD）** | **中環現有真樓＋玩家城市** |
|---|---|
| ![現有樓群 overview](docs/screenshots/existing-overview.png) | ![現有樓群中環](docs/screenshots/existing-central.png) |
| **港鐵地面／高架軌** | **地下鐵路（U 層）** |
|---|---|
| ![鐵路軌](docs/screenshots/rail-kinds.png) | ![地下鐵路](docs/screenshots/rail-underground.png) |
| **MTR 列車** | **深圳河＋北岸深圳** |
|---|---|
| ![MTR 列車](docs/screenshots/mtr-train.png) | ![深圳河](docs/screenshots/shenzhen-border.png) |
| **邊境口岸（落馬洲）** | **U 層地下管網＋鐵路 overview** |
|---|---|
| ![邊境口岸](docs/screenshots/border-gates.png) | ![U 層](docs/screenshots/underground-overview.png) |
| **建造面板重新設計（#9）** | **城事縮退持久（#15）** |
|---|---|
| ![建造面板](docs/screenshots/build-panel.png) | ![城事縮退](docs/screenshots/info-collapsed.png) |
| **現有道路密度／窄街（#10）** | **顯示／隱藏建築（#13）** |
|---|---|
| ![窄街](docs/screenshots/roads-local.png) | ![隱藏建築](docs/screenshots/buildings-hidden.png) |
| **管網三層：食水** | **管網三層：污水** |
|---|---|
| ![食水](docs/screenshots/pipe-water.png) | ![污水](docs/screenshots/pipe-sewage.png) |
| **道路拉線預覽（#11）** | **高架橋跨海** |
|---|---|
| ![道路拉線](docs/screenshots/road-drag-preview.png) | ![高架橋](docs/screenshots/road-elevated.png) |
| **隧道（#11）** | **深圳市參考區（#14）** |
|---|---|
| ![隧道](docs/screenshots/road-tunnel.png) | ![深圳市參考區](docs/screenshots/shenzhen-overlay.png) |
| **走進建築室內（機場離境大堂）** | **維港夜景** |
| ![室內](docs/screenshots/interior.png) | ![夜景](docs/screenshots/night.png) |
| **颱風襲港** | **寒潮雪景** |
| ![颱風](docs/screenshots/typhoon.png) | ![雪景](docs/screenshots/snow.png) |
| **由零開始：完全空地圖** | **開局：600×600 真實地理** |
| ![空地圖](docs/screenshots/empty.png) | ![開局](docs/screenshots/start.png) |

> 更多截圖（市區、分區、財務、暴雨、存檔、手機版）見 [`docs/screenshots/`](docs/screenshots/)。

## 開發

```bash
npm run dev        # 開發伺服器（5273）
npm run build      # tsc --noEmit + vite build（CI 由 postinstall 自動執行）
npm run preview    # 預覽生產建置（4273）
npm test           # vitest 單元／整合測試
npm run shot       # 無頭瀏覽器截圖
npm run verify     # Playwright 全流程驗收（600 真實地圖、兩種開局、地下管網、巴士路線、機場貨櫃碼頭、分區、物流、財政、天氣、室內、存檔）
npm run verify:ui  # 真實滑鼠／鍵盤 UI 驗收
npm run verify:mobile  # 手機介面與觸控驗收
```

## 專案結構

```
src/
  core/      型別、香港建築／資源資料表（config）、狀態管理、存檔、開新局、格式化
  world/     真實地理數據（hk-map-data.generated.ts）＋世界生成
             border.ts（深圳河／口岸）、existing-city.ts（現有樓群生成）
  sim/       模擬：時間天氣、市民、人口、物流、生產、公用管網（utilities.ts）、
             巴士小巴路線（transit.ts／vehicles.ts）、港鐵鐵路（rail.ts）、機場碼頭貿易（trade.ts）、
             內地糧食支援（mainland.ts）、財政、統計、尋路
  render/    three.js：城市視圖、地形、道路、建築、市民、車輛、環境、地下管網、路線 overlay、室內、模型庫
  ui/        DOM 介面：頂欄、建造、城事、財政、交通／路線、公用設施、貿易、存檔／教學、室內、手機版
  main.ts    組裝 actions、主迴圈、存檔排程
tools/       真實地理數據離線生成腳本（DTM 5m／建築輪廓／水塘／土地利用）＋tools/data
docs/        研究、GDD、技術架構、多 Agent 開發報告、截圖
tests/       vitest 單元與整合測試
scripts/     截圖與自動驗收工具
```

## 文件

- [遊戲設計文件](docs/GAME_DESIGN_HK.md) — 玩法、香港建築數據、物流、交通、財政、天氣、室內、教學
- [真實地理數據與大地圖技術說明](docs/LARGE_MAP_NOTES.md)（Round 4/5）+ [數據生成工具](tools/README.md)
- [Round 5 資料契約](docs/ROUND5_CONTRACTS.md)｜[地下管網規格](docs/ROUND5_UTILITIES.md)｜[巴士小巴路線](docs/ROUND5_TRANSIT_LINES.md)｜[機場碼頭](docs/ROUND5_AIRPORT_PORT.md)
- [Round 6 GitHub issues 規格](docs/ROUND6_ISSUES.md)（#4 深圳河／#5 鐵路／#6 內地糧食／#7 現有樓群）
- [分區玩法規格](docs/ZONING_GAMEPLAY.md) — RCI+F 需求公式、發展分數、19 種自動建築、starter／empty 開局、平衡數據
- [同類遊戲與香港參考研究](docs/RESEARCH_HK.md) — SimCity / Cities: Skylines / 香港城市與交通資料
- [UI 規格](docs/UI_SPEC_HK.md) — 桌面／手機版面、分區刷子、需求條、開局畫面
- [技術架構與 Agent 分工](docs/ARCHITECTURE.md)
- [多 Agent 開發報告](docs/TEAM_REPORT.md)

## 已知限制

- 建築外觀固定朝向（渡輪碼頭依水域轉向），未做 LOD；上千棟建築時可再優化 draw call。
- 港鐵為地下化服務，戶外只渲染車站出入口，不渲染列車（統計與車費照常結算）。
- 地圖地形／建築密度／水塘／土地利用由真實地理數據離線預處理（DTM 5m、每格 112m、建築輪廓、WSD 水塘、PlanD LUHK 2020），遊玩時唔需要下載數據；首次載入需建立 600×600 地形與約 4,000 座現有樓群，約需數秒至十數秒（顯示載入畫面）。
- 存檔 **v8** 與舊版 96×96／304×304／480×480 存檔不相容（舊存檔會被忽略，請重新開局）。
- 真實地形可建地約佔全圖 **21.7%**（香港山多平地少）；建議沿平地／海旁發展。地名標籤與地標已對應真實位置。
- 公用設施由舊版「半徑覆蓋」改為**真正地下管網**：開局（empty）要先建發電廠／水務設施／污水處理廠，再鋪設三種管道到建築；starter 已預建。
- starter 由 600 地圖 real data 生成 **572 棟現有樓宇**（existing，可拆卸）＋60 座現有公共設施；佢哋用既有設施、唔佔新管網容量；玩家重建後會變新樓。
- 深圳河北岸深圳市區係以公開邊界座標＋noise 近似合成（DTM／土地利用只覆蓋香港），外觀為概念性深圳城市帶。
- 「由零開始」模式完全冇道路、建築、分區、地標、機場、貨櫃碼頭等人造物（只保留自然地形、樹木與海面船隻）。
- 市民路徑行走於道路／行人路（道路已整合行人路），未模擬行人穿越建築的捷徑；人口上限 1600。
- 分區自動開發上限 1,200 棟（一般城市數百棟）；拆掉自動建築後分區保留，會重新發展。
- 高人口需要足夠農業區：約每 50 人 1 座農田（1600 人約需 30 座農田／120 格農業區）或食品廠；城事面板會在糧食緊張時提示。
- 效能：1600 人時 simulation 平均約 0.3–0.7ms/幀（logistics 由 22.25ms 優化至 ~0.02–0.04ms），60fps 安全；每遊戲日一次的世界結算會有約 25–32ms 的單幀尖峰（屬預期）。
- 存檔使用 localStorage，瀏覽器清除網站資料會遺失存檔；建議定期匯出 JSON。
- 無 GPU／軟件 WebGL 環境會自動啟用「輕量模式」`?lite=1`（關陰影、降解析度）以維持操作流暢；可用 `?lite=0` 強制全效果。

## 授權

MIT
