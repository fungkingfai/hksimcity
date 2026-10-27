/**
 * 《維港之城》— 核心型別定義（全體 Agent 的共同契約）
 *
 * 任何模組都只可透過本檔的型別溝通世界狀態。
 * 修改此檔（或 core/config.ts）屬 Lead 權限；其他 Agent 如需新欄位請透過
 * 任務看板／訊息向 Lead 提出，不要自行改動共用型別。
 *
 * 香港版與舊版（華夏古城）的差異：
 *  - 資源改為食品／日用品／電子產品／建材，食水與電力改用「公用設施覆蓋」服務。
 *  - 建築分類改為住宅／商業／工業／物流／公共／交通／裝飾。
 *  - 新增交通系統（港鐵／巴士／電車／渡輪）、車輛（Vehicle）、公共交通統計。
 *  - 天氣新增颱風（storm）與大霧（fog），保留晴／陰／雨／雪。
 *  - 財政改為薪俸稅／利得稅／差餉／賣地收入／車費收入。
 *  - 地圖為香港：維港、港島、九龍、新界、離島、填海區。
 */

// ─────────────────────────── 基礎列舉 ───────────────────────────

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

/** 天氣：晴／陰／雨／颱風／霧／雪（寒潮） */
export type Weather = 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog' | 'snow';

/**
 * 地形：
 *  grass     平地（新界鄉郊、可建）
 *  urban     已發展市區地（港島／九龍舊區、可建）
 *  reclaimed 填海地（西九／啟德／東涌、可建）
 *  fertile   農地（新界農田、可耕）
 *  wetland   濕地／魚塘（米埔、不可建）
 *  forest    林地（可建，需清林）
 *  hill      丘陵（可建，造價較高）
 *  mountain  山地（不可建）
 *  water     水域（維港／河／水塘，不可建，可建碼頭／渡輪碼頭）
 *  sand      沙灘（不可建）
 */
export type TerrainType =
  | 'grass'
  | 'urban'
  | 'reclaimed'
  | 'fertile'
  | 'wetland'
  | 'forest'
  | 'hill'
  | 'mountain'
  | 'water'
  | 'sand';

/**
 * 物流資源：
 *  food        食品（農田／魚塘／食品廠）
 *  goods       日用品（貨櫃碼頭進口）
 *  electronics 電子產品（工廈以建材生產）
 *  materials   建材（石礦場）
 */
export type ResourceKey = 'food' | 'goods' | 'electronics' | 'materials';

/** 公用設施：食水、污水、電力（地下管網：管道／電纜接駁 + 容量池） */
export type UtilityKind = 'water' | 'sewage' | 'power';
/** 可鋪設的地下管線種類 */
export type PipeKind = 'water' | 'sewer' | 'power';

/** 鐵路等級：地面／高架／地下（issue #5） */
export type RailGrade = 'surface' | 'elevated' | 'underground';

/** 公共交通模式 */
export type TransitMode = 'mtr' | 'bus' | 'tram' | 'ferry';

/** 車輛種類（交通／物流車輛的視覺與行為） */
export type VehicleKind =
  | 'bus' // 雙層巴士
  | 'minibus' // 小巴
  | 'taxi' // 的士
  | 'tram' // 電車（叮叮）
  | 'mtr' // 港鐵列車（只在鐵路走廊行走）
  | 'ferry' // 渡輪（天星小輪）
  | 'truck' // 貨車（物流）
  | 'van' // 客貨車（物流）
  | 'car' // 私家車
  | 'motorcycle'; // 電單車

export type BuildingCategory =
  | 'residential' // 住宅
  | 'commercial' // 商業
  | 'industrial' // 工業
  | 'logistics' // 物流
  | 'civic' // 公共設施
  | 'transport' // 交通
  | 'decoration'; // 裝飾／休憩

export type LogKind = 'info' | 'good' | 'warn' | 'bad';

export type ServiceKind =
  | 'market' // 零售（街市／超市／便利店：向市民供貨並帶來商稅）
  | 'restaurant' // 餐飲（茶餐廳：消耗食品、提供收入與幸福）
  | 'school'
  | 'hospital'
  | 'police'
  | 'fire'
  | 'park'
  | 'promenade'
  | 'office' // 商廈寫字樓（提供職位與利得稅加成，無社區服務）
  | 'water' // 水務設施（公用設施覆蓋）
  | 'power'; // 發電廠（公用設施覆蓋）

export type BuildMode = 'city' | 'interior';

/**
 * 分區（SimCity / Cities: Skylines 式玩法）：
 * 玩家只劃分區，開發商按需求／環境自動興建對應建築。
 *  residential 住宅區／commercial 商業區／industrial 工業區／farmland 農業區
 */
export type ZoneType = 'residential' | 'commercial' | 'industrial' | 'farmland';

/** Round 8／issue #11：道路等級（地面／高架／隧道） */
export type RoadGrade = 'surface' | 'elevated' | 'tunnel';

/** 開局模式：starter＝已有一定規模的城鎮；empty＝由零開始 */
export type NewGameMode = 'starter' | 'empty';

// ─────────────────────────── 地圖 ───────────────────────────

export interface Tile {
  terrain: TerrainType;
  /** 0..1 視覺／邏輯高度 */
  elevation: number;
  /** 每格固定視覺變化種子 0..1 */
  variant: number;
  /** 佔用此格的建築 id，-1 表示無 */
  buildingId: number;
  /** 是否有馬路（車道） */
  road: boolean;
  /** 是否有行人路（人行道）。道路整合行人路，鋪路時自動包含 */
  sidewalk?: boolean;
  /** 分區（null／undefined = 未分區） */
  zone?: ZoneType | null;
  /** 真實建築覆蓋率 0..255（CSDI 建築物輪廓數據；只用於 render／統計提示，不影響模擬） */
  density?: number;
  /** 真實平均建築高度（米；render 用嚟決定遠景樓宇高度） */
  buildingHeight?: number;
  /** 地下食水管（獨立圖層；可與道路／分區／建築共存） */
  waterPipe?: boolean;
  /** 地下污水管 */
  sewerPipe?: boolean;
  /** 地下電力電纜 */
  powerCable?: boolean;
  /** 鐵路軌（地面／高架／地下；Round 6 MTR 規劃） */
  rail?: RailGrade;
  /** Round 8／issue #11：道路等級（undefined = surface） */
  roadGrade?: RoadGrade;
  /** Round 8／issue #10：現有城市窄街（render 用；唔需要存檔） */
  localRoad?: boolean;
}

// ─────────────────────────── 建築 ───────────────────────────

export interface BuildingProduction {
  output: ResourceKey;
  /** 每「日」產量（滿工人時） */
  amountPerDay: number;
  input?: { resource: ResourceKey; amountPerDay: number };
  /** 可蓋的地形；不填代表只能蓋在一般可建地 */
  allowedTerrain?: TerrainType[];
  /** 季節產量倍率 */
  seasonBonus?: Partial<Record<Season, number>>;
  /** 天氣產量倍率（颱風可設 storm: 0 停工） */
  weatherBonus?: Partial<Record<Weather, number>>;
}

export interface BuildingService {
  kind: ServiceKind;
  /** 服務半徑（格） */
  radius?: number;
  /** 每日消耗 */
  consumes?: { resource: ResourceKey; amountPerDay: number };
  /** 對周邊幸福度加成（點） */
  happiness?: number;
  /** 每日收入（港幣） */
  incomePerDay?: number;
  /** 稅收效率加成（如警署、商廈帶動） */
  taxBonus?: number;
  /** 服務容量（學校學位、醫院病床等，用於 UI 顯示與過載懲罰） */
  capacity?: number;
}

/** 公共交通站點定義（港鐵站／巴士總站／電車站／渡輪碼頭） */
export interface TransitDef {
  mode: TransitMode;
  /** 服務半徑（格） */
  radius: number;
  /** 每日載客容量 */
  capacity: number;
  /** 每程車費（港幣） */
  fare: number;
  /** 是否需臨水（渡輪碼頭） */
  needsWater?: boolean;
}

/** 公用設施定義（發電廠／水務設施） */
export interface UtilityDef {
  kind: UtilityKind;
  /** 服務半徑（格；管網模式保留作 UI／舊徑相容） */
  radius: number;
  /** 供應容量（人口當量 PE／電力單位；不足會停電／缺水） */
  capacity: number;
  /** 是否供應源（true = 發電廠／水廠／污水廠；false／undefined = 舊式／需求端） */
  source?: boolean;
}

export interface BuildingDef {
  key: string;
  name: string;
  desc: string;
  category: BuildingCategory;
  /** [寬, 高]（格） */
  size: [number, number];
  cost: number;
  /** 每月維護費（港幣） */
  upkeep: number;
  /** 需要工人數 */
  workers: number;
  /** 可住人口 */
  housing: number;
  /** 倉儲容量；accepted 為可存資源（'all' = 全部物流資源） */
  storage?: { capacity: number; accepted: ResourceKey[] | 'all' };
  production?: BuildingProduction;
  service?: BuildingService;
  /** 公共交通站點（交通類建築） */
  transit?: TransitDef;
  /** 公用設施（發電廠／水務設施） */
  utility?: UtilityDef;
  /** 解鎖所需人口 */
  unlockPop: number;
  /** UI／霓虹主題色 */
  color: number;
  /** 建造是否需臨水 */
  needsWater?: boolean;
  /** 建造是否需臨路（預設住宅／商業／公共／交通為 true） */
  needsRoad?: boolean;
  /** 室內場景樣式 key（interiors 模組依此生成室內；不填用 category 預設） */
  interior?: string;
  /** 自動開發：所屬分區（有值＝由分區自動興建，玩家不可手動放置） */
  zone?: ZoneType;
  /** 自動開發權重（同分區內較高較易出現） */
  weight?: number;
  /** 自動開發所需最低發展分數 0..100（環境／服務／需求） */
  minDevScore?: number;
  /** 玩家可手動放置的地標／公共設施（true＝出現在建造面板） */
  ploppable?: boolean;
  /** 只可建於指定真實地理區塊（機場／貨櫃碼頭） */
  requiredRegion?: 'airport' | 'containerPort';
  /** 貿易設施角色（機場／碼頭營運結算用） */
  tradeRole?: 'airportPassenger' | 'airportCargo' | 'portTerminal' | 'portGate' | 'portYard';
  /** 路線站點種類（巴士／小巴站；有值即可以作為路線站） */
  stopMode?: 'bus' | 'minibus';
  /** 鐵路站（mtrStation；只要有鐵路軌相鄰即可納入鐵路網，issue #5） */
  railStation?: boolean;
  /** 邊境口岸種類（道路／鐵路；issue #4/#6） */
  borderGate?: BorderCrossingKind;
}

export interface Building {
  id: number;
  key: string;
  /** 左上角格座標 */
  x: number;
  y: number;
  w: number;
  h: number;
  active: boolean;
  /** 是否連通道路 */
  connected: boolean;
  /** 工人 citizen id */
  workers: number[];
  /** 居民 citizen id */
  residents: number[];
  /** 本地庫存（生產暫存／倉儲／零售貨架） */
  inventory: Partial<Record<ResourceKey, number>>;
  /** 生產進度 0..1 */
  productionProgress: number;
  /** 建築升級等級（1 起） */
  level: number;
  /** 建造時的遊戲日（絕對日數） */
  builtOnDay: number;
  /** 本月累計收入／支出（港幣） */
  incomeThisMonth: number;
  expenseThisMonth: number;
  /** 由分區自動開發（true）或玩家手動放置（false） */
  auto?: boolean;
  /** 自動開發建築所屬分區 */
  zone?: ZoneType;
  /** 是否為開局已有的真實樓宇（issue #7；existing 建築可有人運作） */
  existing?: boolean;
  /** Round 9／issue #20：CSDI 3D-BIT00 真實模型 index（render 用；undefined = 普通 prototype） */
  model3d?: number;
  /** 公用設施接駁狀態（由 sim/utilities.ts 每日更新；只作 UI／視覺） */
  powered?: boolean;
  watered?: boolean;
  sewered?: boolean;
}

// ─────────────────────────── 市民 ───────────────────────────

export type CitizenState = 'home' | 'walking' | 'working' | 'shopping' | 'idle';

export interface CitizenNeeds {
  /** 0..100，越高越滿足 */
  food: number;
  goods: number;
  /** 消閒／文化（公園、海濱、商場） */
  leisure: number;
}

export interface Citizen {
  id: number;
  name: string;
  age: number;
  gender: 'male' | 'female';
  /** 家（建築 id） */
  homeId: number;
  /** 工作（建築 id），-1 失業 */
  workId: number;
  /** 0..100 */
  happiness: number;
  /** 私人錢財（港幣） */
  money: number;
  /** 每月薪金（港幣；受僱時由工作建築決定） */
  salary: number;
  state: CitizenState;
  /** 世界格座標（浮點，供渲染，由 sim 更新） */
  x: number;
  y: number;
  /** 正在走的路徑（格 index 陣列） */
  path: number[];
  /** 沿路徑的進度（0..path.length-1） */
  pathProgress: number;
  /** 目前要去的建築 id，-1 無 */
  targetId: number;
  /** 通勤方式（用於統計與票價收入；'walk' 為步行） */
  commuteMode: TransitMode | 'walk';
  /** 髮色／衣色種子 0..1 */
  look: number;
  needs: CitizenNeeds;
}

// ─────────────────────────── 物流 ───────────────────────────

/** 物流貨運（貨車／客貨車沿道路移動，抵達才入庫） */
export interface Cart {
  id: number;
  resource: ResourceKey;
  amount: number;
  capacity: number;
  fromId: number;
  toId: number;
  x: number;
  y: number;
  path: number[];
  pathProgress: number;
  /** 是否由倉庫往零售／由生產者往倉庫 */
  phase: 'pickup' | 'deliver';
  /** 視覺車種：貨車或客貨車 */
  vehicleKind: 'truck' | 'van';
  /** 已送達後待移除 */
  done: boolean;
}

// ─────────────────────────── 交通／車輛 ───────────────────────────

export interface Vehicle {
  id: number;
  kind: VehicleKind;
  /** 世界格座標（浮點） */
  x: number;
  y: number;
  /** 面向（弧度） */
  angle: number;
  /** 沿道路／航道的路徑（格 index）；空 = 靜止 */
  path: number[];
  pathProgress: number;
  /** 移動速度（格／遊戲分鐘的視覺係數，由渲染層換算） */
  speed: number;
  /** 車身顏色 */
  color: number;
  /** 載客（巴士／小巴／港鐵／渡輪）或載貨量（貨車） */
  load: number;
  /** 物流車輛：攜帶的貨物 */
  cargo?: { resource: ResourceKey; amount: number; fromId: number; toId: number };
  /** 所屬巴士／小巴路線（Round 5，optional；唔影響舊存檔） */
  lineId?: number;
  /** 由交通系統管理（true）還是由物流系統管理（false） */
  transit: boolean;
  done: boolean;
}

// ─────────────────────────── 公共交通統計 ───────────────────────────

export interface TransitState {
  /** 每日總載客量（統計） */
  dailyRidership: number;
  /** 本月車費收入（港幣） */
  faresThisMonth: number;
  /** 颱風期間是否停航／停駛（渡輪） */
  suspended: boolean;
  /** 各模式的每日載客量（統計用） */
  byMode: Record<TransitMode, number>;
}

// ─────────────────────────── 地下公用設施（Round 5） ───────────────────────────

/** 網絡供應統計（水／污水／電力同構） */
export interface UtilityNetworkStat {
  /** 全城供應容量（人口當量 PE／電力單位） */
  capacity: number;
  /** 全城需求 */
  demand: number;
  /** 實際供應（min(capacity,demand)） */
  supplied: number;
  /** 人口加權覆蓋率 0..1（已接駁且獲供應） */
  coverage: number;
  /** 已接駁建築數 */
  connectedBuildings: number;
  /** 未接駁建築數 */
  unconnectedBuildings: number;
  /** 供應源建築數 */
  sources: number;
  /** 短缺比例 0..1（1 - supplyRatio） */
  shortage: number;
}

export interface UtilitySnapshot {
  /** 計算時的 worldRevision（快取簽章） */
  revision: number;
  water: UtilityNetworkStat;
  sewage: UtilityNetworkStat & {
    /** 已處理量 */
    treated: number;
    /** 未處理溢出比例 0..1 */
    overflow: number;
  };
  power: UtilityNetworkStat;
  pipeCounts: { water: number; sewer: number; power: number };
  /** 食水水質 0..1（污染源／排污口附近會下降） */
  waterQuality: number;
  /** 每月管線維護費（港幣） */
  pipeUpkeep: number;
}

// ─────────────────────────── 港鐵鐵路網（Round 6） ───────────────────────────

export interface RailNetworkSnapshot {
  /** worldRevision／railRevision 簽章 */
  revision: number;
  /** 各 grade 的軌道格數 */
  gradeCounts: Record<RailGrade, number>;
  totalLength: number;
  /** 連通分量數 */
  components: number;
  /** 最大分量長度 */
  largestComponent: number;
  /** 全部 mtrStation 數 */
  stations: number;
  /** 已接駁鐵路軌（同分量有 2+ 站）的車站數 */
  connectedStations: number;
  /** 孤立（未接軌／單站）車站數 */
  isolatedStations: number;
  /** 鐵路網每日乘客 */
  ridership: number;
  /** 每月維護費 */
  upkeep: number;
}

// ─────────────────────────── 內地邊境支援（Round 6） ───────────────────────────

export type BorderCrossingKind = 'road' | 'rail';

export interface BorderCrossingState {
  name: string;
  kind: BorderCrossingKind;
  x: number;
  y: number;
  /** 是否有玩家道路／鐵路接駁到城市 */
  connected: boolean;
  buildingId: number;
  foodPerDay: number;
}

export interface MainlandState {
  roadLinks: number;
  railLinks: number;
  foodPerDay: number;
  lastImportDay: number;
  crossings: BorderCrossingState[];
}

// ─────────────────────────── 巴士／小巴路線（Round 5） ───────────────────────────

export type TransitLineMode = 'bus' | 'minibus';

/** 玩家建立的巴士／小巴路線 */
export interface TransitLine {
  id: number;
  mode: TransitLineMode;
  name: string;
  /** #rrggbb */
  color: string;
  /** 站點（BusStop／MinibusStop／BusTerminus／MinibusDepot 的 building id，順序） */
  stopIds: number[];
  /** 循環線（true）或雙向（false） */
  loop: boolean;
  /** 車隊數量 1..12 */
  vehicleCount: number;
  /** 票價（港幣） */
  fare: number;
  createdDay: number;
  /** 最近一日載客量 */
  ridershipToday: number;
  /** 本月車費收入 */
  faresThisMonth: number;
  /** 上月總載客量 */
  lastMonthRidership: number;
  /** 是否停駛 */
  suspended?: boolean;
}

export interface TransitLineInput {
  mode: TransitLineMode;
  stopIds: number[];
  loop: boolean;
  vehicleCount: number;
  fare: number;
  name?: string;
  color?: string;
}

// ─────────────────────────── 機場／貨櫃碼頭（Round 5） ───────────────────────────

export interface AirportState {
  passengerCapacity: number;
  passengers: number;
  cargoCapacity: number;
  cargo: number;
  revenueToday: number;
  jobs: number;
  /** 最近一日噪音投訴（0..1） */
  noiseComplaints: number;
}

export interface PortState {
  teuCapacity: number;
  throughput: number;
  revenueToday: number;
  jobs: number;
}

export interface TradeState {
  airport: AirportState;
  port: PortState;
  lastUpdatedDay: number;
}

// ─────────────────────────── 時間 ───────────────────────────

export interface GameClock {
  /** 自開局起的絕對遊戲分鐘 */
  minutes: number;
  /** 絕對天數（1 起） */
  totalDays: number;
  day: number; // 1..DAYS_PER_MONTH
  month: number; // 1..12
  year: number; // 1 起
  hour: number; // 0..23
  minute: number; // 0..59
  /** 星期（0 = 星期日） */
  weekday: number;
  season: Season;
  weather: Weather;
  /** 距離下次天氣變化的遊戲分鐘 */
  weatherMinutesLeft: number;
  /** 氣溫（攝氏） */
  tempC: number;
  /** 天文台警告：酷熱／寒冷／暴雨／颱風信號等顯示文字 */
  warning: string | null;
  /** 天氣強度 0..1（雨／雪／颱風） */
  weatherIntensity: number;
  /** Round 9／issue #18：HKO 熱帶氣旋警告信號（0 = 無） */
  typhoonSignal?: 0 | 1 | 3 | 8 | 9 | 10;
  /** 信號名稱（HKO 用語，例如「八號東北烈風或暴風信號」） */
  typhoonName?: string | null;
  /** 八號信號方向（NE/NW/SE/SW；其他信號為 null） */
  typhoonDirection?: 'NE' | 'NW' | 'SE' | 'SW' | null;
  /** Round 9／issue #18：暴雨警告（黃／紅／黑） */
  rainstorm?: 'amber' | 'red' | 'black' | null;
  paused: boolean;
  /** 0=暫停, 1,2,3 = 倍速 */
  speed: number;
}

// ─────────────────────────── 財政 ───────────────────────────

export interface MonthRecord {
  year: number;
  month: number;
  income: number;
  expense: number;
  balance: number;
  population: number;
  happiness: number;
  /** 各項收入明細（UI 月報用） */
  incomeByKind?: Partial<Record<IncomeKind, number>>;
}

/** 財政收入分類（香港稅制） */
export type IncomeKind =
  | 'salaryTax' // 薪俸稅
  | 'profitTax' // 利得稅
  | 'rates' // 差餉
  | 'landSale' // 賣地
  | 'fares' // 車費收入
  | 'service' // 服務收入（街市／商場等）
  | 'other';

/** 財政支出分類 */
export type ExpenseKind =
  | 'upkeep' // 建築維護
  | 'civilService' // 公務員薪酬
  | 'welfare' // 社會福利
  | 'infrastructure' // 基建
  | 'festival' // 節慶／煙花
  | 'other';

export interface Finance {
  treasury: number;
  /** 薪俸稅率 0..0.2 */
  salaryTaxRate: number;
  /** 利得稅率 0..0.25 */
  profitTaxRate: number;
  /** 差餉率 0..0.12 */
  ratesRate: number;
  /** 本月累計 */
  incomeThisMonth: number;
  expenseThisMonth: number;
  /** 本月分類累計（UI 用） */
  incomeBreakdown: Partial<Record<IncomeKind, number>>;
  expenseBreakdown: Partial<Record<ExpenseKind, number>>;
  lastMonthIncome: number;
  lastMonthExpense: number;
  history: MonthRecord[];
  totalIncome: number;
  totalExpense: number;
  /** 上次舉辦節慶（煙花匯演）的絕對日 */
  lastFestivalDay: number;
  /** 上次賣地的絕對日 */
  lastLandSaleDay: number;
  /** 已賣出的土地數量 */
  landSales: number;
}

// ─────────────────────────── 其他狀態 ───────────────────────────

export interface LogEntry {
  id: number;
  year: number;
  month: number;
  day: number;
  text: string;
  kind: LogKind;
}

export interface GameStats {
  population: number;
  households: number;
  jobs: number;
  employed: number;
  unemployed: number;
  homeless: number;
  /** 平均幸福度 0..100 */
  happiness: number;
  /** 食品庫存與每日需求 */
  foodStored: number;
  foodPerDay: number;
  /** 上月淨收益（港幣） */
  netIncome: number;
  /** 物流中的貨物量 */
  goodsInTransit: number;
  /** 公用設施覆蓋率 0..1（以人口加權） */
  powerCoverage: number;
  waterCoverage: number;
  /** 公共交通可達率 0..1（以就業人口加權） */
  transitCoverage: number;
  /** 每日公共交通載客量 */
  ridership: number;
  /** 平均通勤時間（遊戲分鐘，估算值） */
  avgCommute: number;
  /** 目前颱風信號（0 = 無，1/3/8） */
  typhoonSignal: number;
  /** 分區需求（-1..1；負數＝供過於求） */
  zoneDemand: Record<ZoneType, number>;
  /** 各分區已劃格數 */
  zoneTiles: Record<ZoneType, number>;
  /** 各分區已建成建築數 */
  zoneBuildings: Record<ZoneType, number>;
  /** 服務覆蓋率 0..1（人口加權） */
  policeCoverage: number;
  fireCoverage: number;
  schoolCoverage: number;
  hospitalCoverage: number;
  /** 平均發展分數 0..100（地價／環境） */
  landValue: number;
  /** 污水處理覆蓋率 0..1（Round 5） */
  sewageCoverage?: number;
  /** 食水水質 0..1（Round 5） */
  waterQuality?: number;
  /** 機場每日客流（Round 5） */
  airportPassengers?: number;
  /** 貨櫃碼頭每日吞吐（TEU，Round 5） */
  portThroughput?: number;
  /** 貿易設施每日收入（港幣，Round 5） */
  tradeRevenue?: number;
  /** 鐵路網：已接駁車站數（Round 6） */
  railStations?: number;
  /** 鐵路網總長（格，Round 6） */
  railLength?: number;
  /** 內地糧食進口（每日，Round 6） */
  mainlandFoodPerDay?: number;
}

export interface UIState {
  /** 目前建造工具：建築 key / 'road' / 'sidewalk' / 'demolish' / null */
  tool: string | null;
  selectedId: number | null;
  hover: number;
  speed: number;
  paused: boolean;
  mode: BuildMode;
  interiorId: number | null;
  buildCategory: BuildingCategory;
  showFinance: boolean;
  showHelp: boolean;
  showSave: boolean;
  showTutorial: boolean;
  /** 交通面板 */
  showTransit: boolean;
  /** 城事／統計面板 */
  showStats: boolean;
  /** 顯示分區色塊 */
  showZones: boolean;
  /** 首次載入顯示開局模式選擇畫面 */
  showStartScreen: boolean;
  /** 遞增，方便 UI 偵測變更 */
  revision: number;
  /** 地下管網圖層（Round 5） */
  showUnderground?: boolean;
  /** 公用設施面板（Round 5） */
  showUtilityPanel?: boolean;
  /** 機場／碼頭貿易面板（Round 5） */
  showTradePanel?: boolean;
  /** 交通面板選中的路線 */
  selectedLineId?: number | null;
  /** 是否正在建線模式 */
  lineEditorActive?: boolean;
  /** 建線草稿（UI／main 共用） */
  lineDraft?: { mode: TransitLineMode; stopIds: number[] } | null;
  /** Round 8／issue #13：顯示建築物圖層 */
  showBuildings?: boolean;
  /** Round 8／issue #12：地下管網分層顯示 */
  pipeLayers?: { water: boolean; sewage: boolean; power: boolean };
  /** Round 8／issue #12：管網流動動畫 */
  pipeFlow?: boolean;
  /** Round 8／issue #11：道路工具目前等級 */
  roadGrade?: RoadGrade;
}

export interface GameState {
  version: number;
  seed: number;
  cityName: string;
  width: number;
  height: number;
  /** 開局鏡頭中心（格座標，由世界生成提供，例如中環／尖沙咀） */
  spawn: { x: number; y: number };
  tiles: Tile[];
  buildings: Building[];
  citizens: Citizen[];
  carts: Cart[];
  vehicles: Vehicle[];
  transit: TransitState;
  /** 地下公用設施快照（每日／放置後重算；hydrate 後重算） */
  utilities?: UtilitySnapshot;
  /** 巴士／小巴路線 */
  transitLines?: TransitLine[];
  nextTransitLineId?: number;
  /** 機場／貨櫃碼頭營運狀態 */
  trade?: TradeState;
  /** 港鐵鐵路網快照（每日重算） */
  railNetwork?: RailNetworkSnapshot;
  /** 內地邊境支援快照 */
  mainland?: MainlandState;
  /** 開局模式（starter／empty） */
  gameMode: NewGameMode;
  /** 分區需求 -1..1（residential／commercial／industrial／farmland） */
  zoneDemand: Record<ZoneType, number>;
  clock: GameClock;
  finance: Finance;
  stats: GameStats;
  ui: UIState;
  log: LogEntry[];
  nextBuildingId: number;
  nextCitizenId: number;
  nextCartId: number;
  nextVehicleId: number;
  nextLogId: number;
  /** 建立時間／存檔時間（ms epoch） */
  createdAt: number;
  savedAt: number;
}

// ─────────────────────────── 擺放結果 ───────────────────────────

export interface PlaceResult {
  ok: boolean;
  reason?: string;
  cost: number;
}

// ─────────────────────────── 模擬 Context ───────────────────────────

export interface SimContext {
  toast(text: string, kind?: LogKind): void;
  log(text: string, kind?: LogKind): void;
}

// ─────────────────────────── 主程式 Actions（UI → 遊戲） ───────────────────────────

export interface GameActions {
  setTool(tool: string | null): void;
  /** 對指定格執行目前工具（道路／行人路／建築／拆除） */
  applyToolAt(tileIndex: number): void;
  /** Round 8／issue #11：由起點到終點拉起一條 L 形道路 */
  applyRoadPath?(fromTile: number, toTile: number, grade?: RoadGrade): void;
  /** Round 8／issue #13：顯示／隱藏建築圖層 */
  toggleBuildings?(): void;
  /** Round 8／issue #12：管網分層 */
  setPipeLayer?(kind: 'water' | 'sewage' | 'power', on: boolean): void;
  togglePipeFlow?(): void;
  select(tileIndex: number): void;
  selectBuilding(id: number | null): void;
  enterBuilding(id: number): void;
  exitInterior(): void;
  setSpeed(speed: number): void;
  togglePause(): void;
  /** 調整稅率：薪俸稅／利得稅／差餉 */
  setTaxRate(kind: 'salary' | 'profit' | 'rates', rate: number): void;
  /** 舉辦節慶（維港煙花匯演） */
  holdFestival(): void;
  /** 拍賣一幅土地，換取一次性收入 */
  sellLand(): void;
  demolishBuilding(id: number): void;
  saveGame(slot: number): boolean;
  loadGame(slot: number): boolean;
  deleteSave(slot: number): void;
  getSaves(): SaveSlotInfo[];
  exportSave(): void;
  importSave(file: File): Promise<boolean>;
  newGame(seed?: number, mode?: NewGameMode): void;
  /** 由開局畫面選擇模式並開始遊戲 */
  startGame(mode: NewGameMode, seed?: number): void;
  /** 顯示／隱藏分區色塊 */
  toggleZones(): void;
  /** 鏡頭飛到指定格（minimap／導航用） */
  focusTile(x: number, y: number): void;
  /** 鏡頭拉遠至全圖 overview */
  fitMap(): void;
  toggleFinance(): void;
  toggleTransit(): void;
  toggleStats(): void;
  toggleHelp(): void;
  toggleSavePanel(): void;
  closeOverlays(): void;
  /** 地下管網圖層（Round 5） */
  toggleUnderground?(): void;
  /** 公用設施面板 */
  toggleUtilityPanel?(): void;
  /** 機場／碼頭貿易面板 */
  toggleTradePanel?(): void;
  /** 進入建線模式（選站） */
  beginLineEditor?(mode: TransitLineMode): void;
  /** 建線模式中加入／移除站點（building id；再點同一站 = 移除） */
  toggleLineStop?(buildingId: number): void;
  /** 完成建線（建立 TransitLine） */
  finishLineEditor?(): void;
  /** 取消建線 */
  cancelLineEditor?(): void;
  /** 建立巴士／小巴路線 */
  createTransitLine?(input: TransitLineInput): { ok: boolean; reason?: string; id?: number };
  /** 修改路線（車數／票價／名稱／顏色／循環） */
  updateTransitLine?(
    id: number,
    patch: Partial<Pick<TransitLine, 'vehicleCount' | 'fare' | 'name' | 'color' | 'loop' | 'suspended'>>,
  ): { ok: boolean; reason?: string };
  /** 刪除路線 */
  deleteTransitLine?(id: number): boolean;
  /** 升級機場／貨櫃碼頭建築 */
  upgradeTradeBuilding?(buildingId: number): { ok: boolean; reason?: string; cost?: number };
}

// ─────────────────────────── 存檔 ───────────────────────────

export interface SaveSlotInfo {
  slot: number;
  empty: boolean;
  cityName: string;
  population: number;
  treasury: number;
  dateLabel: string;
  savedAt: number;
}
