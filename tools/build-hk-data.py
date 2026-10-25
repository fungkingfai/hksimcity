#!/usr/bin/env python3
"""Build real-geography game data for 《維港之城》 from CSDI/LandsD/WSD/PlanD open data.

Inputs (download URLs documented in repo tools/README):
- DTM 5m ASC (LandsD): Whole_HK_DTM_5m.zip
- Building outlines GeoJSON (LandsD via CSDI): zip containing Building_Outline_..._Building_converted.geojson

Outputs src/world/hk-map-data.generated.ts:
- 600x600 grid (112m/tile, same HK1980 bounds): terrain code / elevation / building density
- real-coordinate labels, landmarks, tunnels, spawn
This script is run offline; generated data is committed so CI does not need the 400MB sources.
"""
import zipfile, json, math, sys, time, os, base64, zlib, struct
from array import array

W = H = 600
TILE_M = 112.0
SPAN = W * TILE_M
E0 = 798275.0
NTOP = 857600.0
XLL, YLL, CELL, NCOLS, NROWS = 799997.5, 799997.5, 5.0, 12751, 9601
TOPY = YLL + NROWS * CELL

# 規劃署 2020 土地利用 10m raster（repo tools/data；由 Lead 提供）
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LU_PATH = os.environ.get('HK_LANDUSE_RAWZ', os.path.join(_REPO_ROOT, 'tools', 'data', 'landuse2020-10m.raw.z'))
LU_E0, LU_N0, LU_RES, LU_COLS, LU_ROWS = 800000.0, 848000.0, 10.0, 6375, 4800
# 水務署 Impounding Reservoirs 官方多邊形（repo tools/data）
RES_PATH = os.environ.get('HK_RESERVOIRS_GEOJSON', os.path.join(_REPO_ROOT, 'tools', 'data', 'impounding-reservoirs.geojson'))

# terrain codes match TerrainType ordering in game data builder
WATER, SAND, GRASS, FERTILE, WETLAND, FOREST, HILL, MOUNTAIN, URBAN, RECLAIMED = range(10)

# ----------------------------- projection (HK1980 Grid) -----------------------------
a = 6378137.0
f = 1 / 298.257222101
e2 = f * (2 - f)
ep2 = e2 / (1 - e2)
LAT0 = math.radians(22 + 18/60 + 43.68/3600)
LON0 = math.radians(114 + 10/60 + 42.8/3600)
FE, FN = 836694.05, 819069.8

def merid(lat):
    e4 = e2*e2; e6 = e4*e2
    return a*((1-e2/4-3*e4/64-5*e6/256)*lat
             -(3*e2/8+3*e4/32+45*e6/1024)*math.sin(2*lat)
             +(15*e4/256+45*e6/1024)*math.sin(4*lat)
             -(35*e6/3072)*math.sin(6*lat))
M0 = merid(LAT0)
def hk1980(lat_deg, lon_deg):
    lat = math.radians(lat_deg); lon = math.radians(lon_deg)
    sl, cl, tl = math.sin(lat), math.cos(lat), math.tan(lat)
    N = a/math.sqrt(1-e2*sl*sl); T = tl*tl; C = ep2*cl*cl; A = (lon-LON0)*cl
    M = merid(lat)
    E = FE + N*(A+(1-T+C)*A**3/6+(5-18*T+T*T+72*C-58*ep2)*A**5/120)
    Nn = FN + (M-M0) + N*tl*(A*A/2+(5-T+9*C+4*C*C)*A**4/24+(61-58*T+T*T+600*C-330*ep2)*A**6/720)
    return E, Nn
def tile_of(E, N):
    x = int(math.floor((E - E0) / TILE_M))
    y = int(math.floor((NTOP - N) / TILE_M))
    return x, y
def tile_center(x, y):
    return E0 + (x+0.5)*TILE_M, NTOP - (y+0.5)*TILE_M
def design_coord(x, y):
    # inverse of worldgen toDesign(): renderer multiplies by W/96
    sx = W/96.0
    return (x+0.5)/sx - 0.5, (y+0.5)/sx - 0.5

# ----------------------------- DTM aggregation -----------------------------
def build_dtm():
    """DTM 5m → 每格（112m）約 4–5×4–5 子取樣：sum / count / land fraction / min / max。"""
    t0 = time.time()
    z = zipfile.ZipFile(os.environ.get('HK_DTM_ZIP', '/tmp/dtm.zip'))
    sums = [0.0]*(W*H)
    cnt  = [0]*(W*H)
    land = [0]*(W*H)
    mx   = [0.0]*(W*H)
    mn   = [9999.0]*(W*H)
    rows_done = 0
    stride = 5  # 25m sampling: 112m tile ≈ 4–5 samples per axis（符合 3×3/5×5 子取樣要求）
    cols = []
    for c in range(0, NCOLS, stride):
        E = XLL + (c+0.5)*CELL
        x = int((E - E0)//TILE_M)
        if 0 <= x < W:
            cols.append((c, x))
    with z.open('Whole_HK_DTM_5m.asc') as f:
        for _ in range(6): f.readline()
        for r in range(NROWS):
            line = f.readline()
            ys = line.split()
            if not ys: continue
            N = TOPY - (r+0.5)*CELL
            y = int((NTOP - N)//TILE_M)
            rows_done += 1
            if 0 <= y < H:
                base = y*W
                for c, x in cols:
                    v = ys[c]
                    val = int(v)
                    if val <= -1000: continue
                    idx = base + x
                    cnt[idx] += 1
                    sums[idx] += val
                    if val > 0:
                        land[idx] += 1
                        if val > mx[idx]: mx[idx] = val
                        if val < mn[idx]: mn[idx] = val
            if rows_done % 1200 == 0:
                print(f'  dtm rows {rows_done}/{NROWS} ({time.time()-t0:.0f}s)', flush=True)
    print(f'  dtm done {time.time()-t0:.1f}s', flush=True)
    return sums, cnt, land, mx, mn

# ----------------------------- buildings -----------------------------
def build_density():
    t0 = time.time()
    z = zipfile.ZipFile(os.environ.get('HK_BUILDINGS_ZIP', '/tmp/csdi.geojson'))
    name = 'Building_Outline_Public_v20261020_Building_converted.geojson'
    density = [0.0]*(W*H)
    height_vol = [0.0]*(W*H)
    counts = [0]*(W*H)
    tile_area = TILE_M*TILE_M
    nfeat = 0
    buf = []
    in_feat = False
    with z.open(name) as f:
        for raw in f:
            line = raw.decode('utf8', 'replace')
            if not in_feat:
                if line.startswith('\t\t{') and line.strip() == '{':
                    in_feat = True; buf = [line]
                continue
            buf.append(line)
            if line.startswith('\t\t}') and not line.startswith('\t\t\t') and line.strip() in ('},', '}'):
                in_feat = False
                feat = ''.join(buf).strip()
                if feat.endswith(','):
                    feat = feat[:-1]
                try:
                    obj = json.loads(feat)
                except Exception:
                    continue
                geom = obj.get('geometry')
                if not geom: continue
                props = obj.get('properties') or {}
                coords = geom.get('coordinates')
                if not coords: continue
                xs=[]; ys=[]
                def walk(c):
                    if isinstance(c, (list, tuple)):
                        if c and isinstance(c[0], (int, float)):
                            xs.append(c[0]); ys.append(c[1])
                        else:
                            for cc in c: walk(cc)
                walk(coords)
                if not xs: continue
                lon0, lon1 = min(xs), max(xs)
                lat0, lat1 = min(ys), max(ys)
                latc = (lat0+lat1)/2
                try:
                    E, N = hk1980(latc, (lon0+lon1)/2)
                except Exception:
                    continue
                # footprint area from Shape_Area (m^2), fallback bbox
                try:
                    area = float(props.get('Shape_Area') or 0.0)
                except Exception:
                    area = 0.0
                if area <= 0.0:
                    wm = max(0.0, (lon1-lon0)*111320.0*math.cos(math.radians(latc)))
                    hm = max(0.0, (lat1-lat0)*110574.0)
                    area = wm*hm
                if area <= 0: continue
                area = min(area, 60000.0)
                # height: TopHeight (m above sea) or Storeys*3
                h = 0.0
                try:
                    th = props.get('TopHeight'); bh = props.get('BaseHeight')
                    if th is not None and float(th) > 0:
                        h = float(th)
                    else:
                        st = props.get('Storeys')
                        if st is not None and float(st) > 0:
                            h = float(st)*3.2
                except Exception:
                    h = 0.0
                if h <= 0: h = 12.0
                xa, ya = tile_of(*hk1980(lat0, lon0))
                xb, yb = tile_of(*hk1980(lat1, lon1))
                xs_t = sorted([xa, xb]); ys_t = sorted([ya, yb])
                x0t, x1t = max(0, xs_t[0]), min(W-1, xs_t[1])
                y0t, y1t = max(0, ys_t[0]), min(H-1, ys_t[1])
                if x1t < x0t or y1t < y0t:
                    x0t = x1t = max(0, min(W-1, xa)); y0t = y1t = max(0, min(H-1, ya))
                ntx = x1t-x0t+1; nty = y1t-y0t+1
                per_area = area/(ntx*nty)
                per_hv = per_area*h
                for yy in range(y0t, y1t+1):
                    base = yy*W
                    for xx in range(x0t, x1t+1):
                        density[base+xx] += per_area
                        height_vol[base+xx] += per_hv
                        counts[base+xx] += 1
                nfeat += 1
                if nfeat % 50000 == 0:
                    print(f'  buildings {nfeat} ({time.time()-t0:.0f}s)', flush=True)
    print(f'  buildings done {nfeat} ({time.time()-t0:.1f}s)', flush=True)
    return density, height_vol, counts

# ----------------------------- landuse raster (PlanD 2020 LUHK 10m) -----------------------------
LU_URBAN = {1,2,11,21,22,23,31,41,42,51,52,53,54}
LU_GREEN = {32}          # open space / recreation（低密度時當草地）
LU_TRACK_CLASSES = [1,2,3,11,21,22,23,31,32,41,42,43,44,51,52,53,54,61,62,71,72,73,74,81,83,91,92]
LU_CLASS_INDEX = {c: i for i, c in enumerate(LU_TRACK_CLASSES)}

def load_landuse():
    """讀 600×600 每格 4×4 土地利用樣本；回傳 (counts[classIdx][tileIdx], valid[tileIdx])。"""
    t0 = time.time()
    raw = zlib.decompress(open(LU_PATH, 'rb').read())
    if len(raw) != LU_COLS*LU_ROWS:
        raise SystemExit(f'landuse raster size mismatch: {len(raw)} != {LU_COLS*LU_ROWS}')
    ncls = len(LU_TRACK_CLASSES)
    counts = [array('H', [0])* (W*H) for _ in range(ncls)]
    valid = [0]*(W*H)
    grid = 4  # 每格 4×4 = 16 個 10m 像素樣本（112m≈11.2px）
    for ty in range(H):
        for tx in range(W):
            i = ty*W + tx
            n = 0
            for sy in range(grid):
                for sx in range(grid):
                    E = E0 + (tx + (sx+0.5)/grid) * TILE_M
                    N = NTOP - (ty + (sy+0.5)/grid) * TILE_M
                    col = int((E - LU_E0)//LU_RES)
                    row = int((LU_N0 - N)//LU_RES)
                    if 0 <= col < LU_COLS and 0 <= row < LU_ROWS:
                        val = raw[row*LU_COLS+col]
                        ci = LU_CLASS_INDEX.get(val)
                        if ci is not None:
                            counts[ci][i] += 1
                            n += 1
            valid[i] = n if n > 0 else grid*grid
    print(f'  landuse done {time.time()-t0:.1f}s', flush=True)
    return counts, valid

# ----------------------------- classification -----------------------------
# 土地利用 value → terrain 融合（見 tools/README.md 對照表）
LU_URBAN = {1,2,11,21,22,23,31,41,42,51,52,53,54}
LU_CLASSES_ALL = [1,2,3,11,21,22,23,31,32,41,42,43,44,51,52,53,54,61,62,71,72,73,74,81,83,91,92]

def classify(sums, cnt, land, mx, mn, dens, hvol, counts, lu_counts, lu_valid):
    terrain = bytearray(W*H)  # default WATER=0
    elev = bytearray(W*H)
    density = bytearray(W*H)
    heights = bytearray(W*H)
    def fcls(cls, i):
        ci = LU_CLASS_INDEX.get(cls)
        if ci is None:
            return 0.0
        tot = lu_valid[i]
        return lu_counts[ci][i] / tot if tot else 0.0
    for i in range(W*H):
        c = cnt[i]
        cov = dens[i] / (TILE_M*TILE_M)
        if c == 0:
            terrain[i] = WATER
            elev[i] = 0
            continue
        landf = land[i] / c
        mean = sums[i] / c
        hmax = mx[i]
        # density / height bytes（600 格重新聚合）
        density[i] = min(255, int(round(min(1.2, cov) / 0.5 * 255)))
        if dens[i] > 1.0:
            avg_h = hvol[i] / dens[i]
            heights[i] = max(1, min(255, int(round(avg_h / 500.0 * 255))))
        # ── 水域：海岸 land fraction + 水塘/河溪土地利用 ──
        l91 = fcls(91, i)
        l92 = fcls(92, i)
        if landf < 0.2 or l91 >= 0.35 or (l92 >= 0.15 and mean < 160):
            terrain[i] = WATER
            elev[i] = 0
            continue
        e = max(mean, hmax*0.55)
        ev = max(1, int(round(min(255, (e/650.0)*255))))
        # ── 海岸過渡（0.2 ≤ landf < 0.55）：沙灘 / 填海邊界 ──
        if landf < 0.55:
            if cov >= 0.02 or fcls(43, i) >= 0.15 or fcls(44, i) >= 0.15:
                terrain[i] = RECLAIMED
            else:
                terrain[i] = SAND
            elev[i] = ev
            continue
        # ── 陸地：DTM 自然基底（山勢優先，override landuse） ──
        # >120m 或 hmax>170m → hill；>380m 或 mean>300m → mountain
        if hmax >= 400 or mean >= 380:
            t = MOUNTAIN
        elif mean >= 120 or hmax >= 180:
            t = HILL
        elif mean >= 55 or hmax >= 240:
            t = FOREST
        else:
            t = GRASS
        # ── 土地利用 refine（唔可以將 DTM 嘅山/hill 降級做草地／森林） ──
        built = sum(fcls(cl, i) for cl in LU_URBAN)
        airport_port = fcls(43, i) >= 0.25 or fcls(44, i) >= 0.25
        if airport_port:
            t = RECLAIMED
        elif built >= 0.3 and e < 320 and not (t in (MOUNTAIN, HILL) and e > 260):
            # 市區：以真實 density 支持；鄉村聚落/低密度綠化地當草地
            if density[i] >= 8 or built >= 0.5:
                t = URBAN
            else:
                t = GRASS
        elif (fcls(62, i) >= 0.25 or fcls(74, i) >= 0.25) and e < 60:
            t = WETLAND
        elif fcls(61, i) >= 0.3 and t in (GRASS, SAND) and e < 220:
            t = FERTILE
        elif t in (MOUNTAIN, HILL):
            # 高山保留 DTM 地貌；badland/岩石山脊可再細分
            if fcls(81, i) >= 0.5 and mean >= 250:
                t = MOUNTAIN
        else:
            # 低地自然植被：woodland → forest；shrub/grass → 依 DTM 決定
            if fcls(71, i) >= 0.3:
                t = FOREST
            elif fcls(72, i) >= 0.3:
                t = FOREST if mean >= 140 else GRASS
            elif fcls(73, i) >= 0.3:
                t = GRASS
            if fcls(81, i) >= 0.4:
                t = MOUNTAIN if mean >= 250 else HILL
            if fcls(83, i) >= 0.3:
                t = SAND if e < 40 else HILL
            if fcls(32, i) >= 0.4 and density[i] < 6:
                t = GRASS
        if t == URBAN and e > 320:
            t = GRASS
        terrain[i] = t
        elev[i] = max(1, ev)
    return terrain, elev, density, heights


def smooth_natural(terrain, passes=1):
    """3×3 多數濾波：只平滑自然地貌（避免海岸/林地邊界出現椒鹽 noise）；
    water / urban / reclaimed 保持原狀，唔會侵蝕海岸線或水塘。"""
    natural = {SAND, GRASS, FERTILE, WETLAND, FOREST, HILL, MOUNTAIN}
    for _ in range(passes):
        nxt = bytearray(terrain)
        for y in range(1, H-1):
            for x in range(1, W-1):
                i = y*W + x
                t = terrain[i]
                if t not in natural:
                    continue
                cnts = {}
                for dy in (-1, 0, 1):
                    base = i + dy*W
                    for dx in (-1, 0, 1):
                        nt = terrain[base+dx]
                        if nt in natural:
                            cnts[nt] = cnts.get(nt, 0) + 1
                best = max(cnts, key=cnts.get)
                if best != t and cnts[best] >= 6:
                    nxt[i] = best
        terrain = nxt
    return terrain


# ----------------------------- reservoirs / rivers -----------------------------
def load_reservoirs():
    """官方水務署 Impounding Reservoirs 多邊形（WGS84 lon/lat）。"""
    obj = json.load(open(RES_PATH))
    out = []
    for feat in obj.get('features', []):
        geom = feat.get('geometry') or {}
        props = feat.get('properties') or {}
        name = props.get('CHINESE_NAME') or props.get('NAME') or '水塘'
        polys = []
        if geom.get('type') == 'Polygon':
            polys.append(geom.get('coordinates') or [])
        elif geom.get('type') == 'MultiPolygon':
            for poly in geom.get('coordinates') or []:
                if poly:
                    polys.append(poly)
        out.append((name, polys))
    return out


def point_in_rings(px, py, rings):
    inside = False
    for ring in rings:
        n = len(ring)
        if n < 3:
            continue
        for k in range(n):
            x1, y1 = ring[k]
            x2, y2 = ring[(k+1) % n]
            if (y1 > py) != (y2 > py):
                xi = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
                if px < xi:
                    inside = not inside
    return inside


# 官方 WSD「Impounding Reservoirs」只有 17 個主要水塘；以下小型水塘用近似橢圓補回
# （黃泥涌／流水響／鶴藪不在官方 17 個 impounding reservoirs 名單，但現實地圖係水域；
#  以圓心＋半徑 rasterize 補底，避免細水塘喺 112m 格消失。）
RESERVOIR_FALLBACK = [
    ("黃泥涌水塘", 22.2559, 114.1889, 140.0, 110.0),
    ("流水響水塘", 22.4972, 114.1566, 230.0, 170.0),
    ("鶴藪水塘", 22.4939, 114.1712, 230.0, 180.0),
]


def rasterize_reservoirs(terrain, elev):
    """官方水塘 polygon + 小型水塘 fallback → tile water。
    回傳 (per-name tile 數, union water tiles, 由陸地新轉 water 的 tiles)。"""
    reservoirs = load_reservoirs()
    per = {}
    union = set()
    total_new = 0
    for name, polys in reservoirs:
        rings_tile = []
        for poly in polys:
            for ring in poly:
                pts = []
                for lonlat in ring:
                    if not isinstance(lonlat, (list, tuple)) or len(lonlat) < 2:
                        continue
                    lon, lat = lonlat[0], lonlat[1]
                    try:
                        E, N = hk1980(lat, lon)
                    except Exception:
                        continue
                    pts.append(((E - E0) / TILE_M, (NTOP - N) / TILE_M))
                if len(pts) >= 3:
                    rings_tile.append(pts)
        if not rings_tile:
            per[name] = 0
            continue
        allpts = [p for r in rings_tile for p in r]
        minx = max(0, int(min(p[0] for p in allpts)) - 1)
        maxx = min(W-1, int(max(p[0] for p in allpts)) + 1)
        miny = max(0, int(min(p[1] for p in allpts)) - 1)
        maxy = min(H-1, int(max(p[1] for p in allpts)) + 1)
        cnt = 0
        for ty in range(miny, maxy+1):
            for tx in range(minx, maxx+1):
                hit = False
                for sy in (0.16, 0.5, 0.84):
                    for sx in (0.16, 0.5, 0.84):
                        if point_in_rings(tx+sx, ty+sy, rings_tile):
                            hit = True
                            break
                    if hit:
                        break
                if hit:
                    i = ty*W + tx
                    if terrain[i] != WATER:
                        total_new += 1
                    if i not in union:
                        union.add(i)
                    terrain[i] = WATER
                    elev[i] = 0
                    cnt += 1
        per[name] = cnt
    # 小型水塘 fallback（橢圓）
    for name, lat, lon, rx, ry in RESERVOIR_FALLBACK:
        E, N = hk1980(lat, lon)
        cx, cy = tile_of(E, N)
        rxt = max(0.7, rx / TILE_M)
        ryt = max(0.7, ry / TILE_M)
        cnt = 0
        for dy in range(-int(ryt)-1, int(ryt)+2):
            for dx in range(-int(rxt)-1, int(rxt)+2):
                if (dx/rxt)**2 + (dy/ryt)**2 > 1.0:
                    continue
                xx, yy = cx+dx, cy+dy
                if not (0 <= xx < W and 0 <= yy < H):
                    continue
                i = yy*W + xx
                if i not in union:
                    union.add(i)
                if terrain[i] != WATER:
                    total_new += 1
                terrain[i] = WATER
                elev[i] = 0
                cnt += 1
        per[name] = per.get(name, 0) + cnt
    return per, len(union), total_new


def carve_rivers(terrain, elev):
    """主要河流/明渠：112m tile 下一格闊已足夠（約 112m）。"""
    RIVERS = [
        ((22.382, 114.192), (22.418, 114.204), 0),   # 城門河（沙田）
        ((22.393, 113.972), (22.378, 113.965), 0),   # 元朗／錦田河
        ((22.445, 114.160), (22.468, 114.175), 0),   # 大埔河
        ((22.372, 113.972), (22.390, 113.962), 0),   # 屯門河
    ]
    pts_all = []
    for p0, p1, width in RIVERS:
        pts = []
        for la, lo in (p0, p1):
            E, N = hk1980(la, lo)
            pts.append(tile_of(E, N))
        for k in range(len(pts)-1):
            x0, y0 = pts[k]
            x1, y1 = pts[k+1]
            steps = max(abs(x1-x0), abs(y1-y0), 1)
            for s in range(steps+1):
                x = round(x0 + (x1-x0)*s/steps)
                y = round(y0 + (y1-y0)*s/steps)
                for dy in range(-width, width+1):
                    for dx in range(-width, width+1):
                        xx, yy = x+dx, y+dy
                        if 0 <= xx < W and 0 <= yy < H:
                            i = yy*W + xx
                            terrain[i] = WATER
                            elev[i] = 0
                            pts_all.append(i)
    return pts_all


# ----------------------------- places / landmarks / tunnels -----------------------------
PLACES = [
 ("中環",22.2819,114.1582,'district'),("金鐘",22.2796,114.1652,'district'),("灣仔",22.2775,114.1735,'district'),
 ("銅鑼灣",22.2800,114.1840,'district'),("天后",22.2825,114.1920,'district'),("北角",22.2910,114.2000,'district'),
 ("鰂魚涌",22.2880,114.2130,'district'),("太古",22.2860,114.2180,'district'),("西灣河",22.2830,114.2220,'district'),
 ("筲箕灣",22.2790,114.2290,'district'),("杏花邨",22.2775,114.2385,'district'),("柴灣",22.2645,114.2370,'district'),
 ("小西灣",22.2630,114.2510,'district'),("堅尼地城",22.2810,114.1280,'district'),("香港大學",22.2830,114.1350,'district'),
 ("香港仔",22.2480,114.1550,'district'),("鴨脷洲",22.2430,114.1550,'district'),("赤柱",22.2190,114.2190,'district'),
 ("石澳",22.2300,114.2450,'district'),("山頂",22.2710,114.1500,'district'),("數碼港",22.2620,114.1300,'district'),
 ("尖沙咀",22.2960,114.1720,'district'),("旺角",22.3190,114.1690,'district'),("深水埗",22.3300,114.1620,'district'),
 ("九龍塘",22.3370,114.1760,'district'),("黃大仙",22.3420,114.1950,'district'),("觀塘",22.3120,114.2260,'district'),
 ("藍田",22.3090,114.2350,'district'),("油塘",22.2970,114.2370,'district'),("紅磡",22.3030,114.1830,'district'),
 ("土瓜灣",22.3160,114.1900,'district'),("啟德",22.3300,114.2050,'district'),("西九龍",22.3050,114.1600,'district'),
 ("荃灣",22.3710,114.1130,'district'),("葵涌",22.3580,114.1300,'district'),("青衣",22.3450,114.1000,'district'),
 ("沙田",22.3830,114.1880,'district'),("馬鞍山",22.4250,114.2310,'district'),("大埔",22.4500,114.1700,'district'),
 ("上水",22.5050,114.1280,'district'),("粉嶺",22.4920,114.1430,'district'),("元朗",22.4450,114.0320,'district'),
 ("天水圍",22.4600,114.0020,'district'),("屯門",22.3900,113.9700,'district'),("東涌",22.2890,113.9420,'district'),
 ("大澳",22.2530,113.8520,'district'),("愉景灣",22.3030,114.0160,'district'),("長洲",22.2100,114.0300,'island'),
 ("南丫島",22.2000,114.1300,'island'),("坪洲",22.2900,114.0400,'island'),("西貢",22.3820,114.2710,'district'),
 ("將軍澳",22.3070,114.2600,'district'),("西貢市",22.3820,114.2720,'district'),("赤鱲角",22.3080,113.9180,'island'),
 ("香港國際機場",22.3080,113.9180,'landmark'),("大帽山",22.4100,114.1240,'mountain'),("鳳凰山",22.2550,113.9530,'mountain'),
 ("太平山",22.2710,114.1500,'mountain'),("獅子山",22.3520,114.1710,'mountain'),("大老山",22.3610,114.2180,'mountain'),
 ("青山",22.3850,113.9550,'mountain'),("米埔",22.4900,114.0400,'landmark'),("維多利亞港",22.2930,114.1700,'water'),
 ("吐露港",22.4300,114.1900,'water'),("城門河",22.3900,114.1950,'water'),("大潭水塘",22.2530,114.2100,'water'),
 ("船灣淡水湖",22.4700,114.2400,'water'),("萬宜水庫",22.3700,114.3500,'water'),("香港仔避風塘",22.2480,114.1520,'water'),
]
LANDMARKS = [
 ("山頂凌霄閣",22.2710,114.1500,'peakTower'),("天壇大佛",22.2540,113.9050,'buddha'),
 ("中環摩天輪",22.2850,114.1610,'ferrisWheel'),("尖沙咀鐘樓",22.2940,114.1690,'clockTower'),
 ("會展中心",22.2830,114.1740,'convention'),("青馬大橋",22.3510,114.0240,'bigBridge'),
]
# 三條過海隧道：用真實隧道登陸點附近經度（設計 x 座標會由 tile 換算）
TUNNELS = [
 ("西區海底隧道",114.1450),
 ("紅磡海底隧道",114.1780),
 ("東區海底隧道",114.2160),
]
# 市區天際線／新市鎮／機場／貨櫃碼頭區塊：經緯度 box -> 設計座標
REGIONS = [
 ("中環天際線",22.276,22.289,114.148,114.171,'skyline'),
 ("灣仔銅鑼灣",22.274,22.289,114.171,114.192,'skyline'),
 ("鰂魚涌太古",22.280,22.293,114.204,114.222,'skyline'),
 ("杏花邨柴灣",22.260,22.284,114.229,114.253,'skyline'),
 ("尖沙咀天際線",22.288,22.306,114.160,114.181,'skyline'),
 ("紅磡九龍城",22.300,22.318,114.181,114.199,'newTown'),
 ("觀塘商廈",22.303,22.319,114.214,114.235,'skyline'),
 ("荃灣樓群",22.362,22.380,114.100,114.122,'newTown'),
 ("沙田樓群",22.372,22.392,114.178,114.203,'newTown'),
 ("將軍澳新市鎮",22.296,22.319,114.247,114.272,'newTown'),
 ("東涌新市鎮",22.278,22.305,113.930,113.965,'newTown'),
 ("天水圍元朗",22.432,22.475,113.980,114.045,'newTown'),
 ("赤鱲角機場",22.298,22.324,113.895,113.945,'airport'),
 ("機場跑道",22.302,22.320,113.870,113.920,'runway'),
 ("葵涌貨櫃碼頭",22.330,22.352,114.112,114.145,'containerPort'),
]

def bounds_design(lat0,lat1,lon0,lon1):
    pts=[(lat0,lon0),(lat0,lon1),(lat1,lon0),(lat1,lon1)]
    xs=[];ys=[]
    for la,lo in pts:
        E,N=hk1980(la,lo); x,y=tile_of(E,N); dx,dy=design_coord(x,y); xs.append(dx); ys.append(dy)
    return min(xs),min(ys),max(xs),max(ys)

# ----------------------------- Border / Shenzhen River (Issue #4) -----------------------------
# 深圳河邊界（WGS84 lat, lon，西→東）。公開資料近似：串連后海灣→落馬洲→羅湖→文錦渡→
# 沙頭角→大鵬灣；真河位置會喺 tile 層用平滑曲線 rasterize。唔會影響香港島／九龍海岸。
BORDER_POINTS = [
    (22.508, 113.945), (22.512, 113.975), (22.509, 114.000), (22.505, 114.030),
    (22.507, 114.083),  # 落馬洲
    (22.516, 114.100), (22.531, 114.113),  # 羅湖
    (22.535, 114.135),  # 文錦渡
    (22.540, 114.156), (22.543, 114.178), (22.545, 114.200),
    (22.545, 114.223),  # 沙頭角
    (22.548, 114.250), (22.545, 114.275),
]
BORDER_CROSSINGS = [
    ("羅湖", 22.531, 114.113, 'rail'),
    ("落馬洲", 22.507, 114.083, 'road'),
    ("文錦渡", 22.535, 114.135, 'road'),
    ("沙頭角", 22.545, 114.223, 'road'),
]
BORDER_RIVER_HALF = 1.0      # 河寬約 2 tiles（112m grid）
BORDER_LAND_X_MARGIN = 2     # 深圳市區合成範圍左右 margin（tiles）


def _design_float(tx, ty):
    """tile 浮點座標 → 96 設計座標（同 design_coord 對整數 tile 一致）。"""
    sx = W / 96.0
    sy = H / 96.0
    return (tx + 0.5) / sx - 0.5, (ty + 0.5) / sy - 0.5


def border_polyline_tiles():
    """BORDER_POINTS → tile 座標折線（於相鄰點間插值，令河岸彎曲平滑）。"""
    base = []
    for lat, lon in BORDER_POINTS:
        E, N = hk1980(lat, lon)
        base.append(((E - E0) / TILE_M, (NTOP - N) / TILE_M))
    out = []
    for k in range(len(base) - 1):
        x0, y0 = base[k]
        x1, y1 = base[k + 1]
        steps = max(1, int(abs(x1 - x0) + abs(y1 - y0)))
        for s in range(steps):
            t = s / steps
            out.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
    out.append(base[-1])
    return out


def _border_y_at(poly, x):
    """以折線分段線性內插：給定 tile x（可浮點）→ 邊界河中心 tile y。"""
    if x <= poly[0][0]:
        return poly[0][1]
    for k in range(len(poly) - 1):
        x0, y0 = poly[k]
        x1, y1 = poly[k + 1]
        if x <= x1:
            t = 0.0 if x1 == x0 else (x - x0) / (x1 - x0)
            return y0 + (y1 - y0) * t
    return poly[-1][1]


def _hash01(x, y, salt=0):
    """deterministic 0..1 hash（同 game rng 無關，只作世界生成）。"""
    h = (x * 73856093) ^ (y * 19349663) ^ ((salt + 1) * 83492791)
    h &= 0x7fffffff
    h = (h ^ (h >> 13)) * 1274126177
    h &= 0x7fffffff
    return h / 0x7fffffff


# 深圳市區／口岸附近土地利用（landuse class）
SHENZHEN_LU = {
    'urbanCore': 11,   # commercial/business（羅湖、福田口岸一帶）
    'residential': 1,
    'industrial': 21,
    'woodland': 71,
    'grass': 73,
}


def build_landuse_layers(lu_counts, lu_valid):
    """由 LU samples 聚合出每格 majority landuse + 道路 hint bit（LU 41/42）。"""
    n = W * H
    landuse = bytearray(n)
    road_hint = bytearray(n)
    for i in range(n):
        tot = lu_valid[i]
        if tot <= 0:
            continue
        best_cls = 0
        best_n = 0
        road_samples = 0
        ci_41 = LU_CLASS_INDEX.get(41)
        ci_42 = LU_CLASS_INDEX.get(42)
        if ci_41 is not None:
            road_samples += lu_counts[ci_41][i]
        if ci_42 is not None:
            road_samples += lu_counts[ci_42][i]
        for ci, cls in enumerate(LU_TRACK_CLASSES):
            v = lu_counts[ci][i]
            if v > best_n:
                best_n = v
                best_cls = cls
        landuse[i] = best_cls
        # 16 樣本中 >=2 個係道路／鐵路 → 視為道路 hint（避免單點 noise）
        if road_samples >= 2:
            road_hint[i] = 1
    return landuse, road_hint


def apply_border_and_shenzhen(terrain, elev, density, heights, landuse, road_hint):
    """深圳河 + 北岸深圳市區 + 邊境通道；只改動現時空資料（water）嘅北面 strip
    及河兩岸 buffer，唔會影響香港島／九龍海岸。回傳 (crossings, river_ring_design, stats)。"""
    poly = border_polyline_tiles()
    if not poly:
        return [], [], {}
    x_min = max(0, int(poly[0][0]) - BORDER_LAND_X_MARGIN)
    x_max = min(W - 1, int(poly[-1][0]) + BORDER_LAND_X_MARGIN)
    # 深圳市區合成只喺「有陸地」嘅口路段（西面后海灣／東面大鵬灣保持海，
    # 避免將真實海灣填成陸地；唔影響香港島海岸）
    land_x_min = tile_of(*hk1980(22.510, 114.030))[0] - 3
    land_x_max = tile_of(*hk1980(22.545, 114.250))[0] + 3
    land_x_min = max(0, land_x_min)
    land_x_max = min(W - 1, land_x_max)
    river_tiles = 0
    shenzhen_tiles = 0
    shenzhen_urban = 0
    for y in range(H):
        for x in range(x_min, x_max + 1):
            if not (0 <= y < H):
                continue
            i = y * W + x
            by = _border_y_at(poly, x + 0.5)
            d = by - (y + 0.5)  # >0 = 河北岸（深圳方向）
            # 河：河中心 ± 1 tile（約 2 tiles 闊）→ water；只喺邊界走廊內覆蓋
            if abs(d) <= BORDER_RIVER_HALF:
                terrain[i] = WATER
                elev[i] = 0
                density[i] = 0
                heights[i] = 0
                landuse[i] = 92  # stream/nullah class
                river_tiles += 1
                continue
            if d <= BORDER_RIVER_HALF:
                continue
            if not (land_x_min <= x <= land_x_max):
                continue
            # 左右海岸用 noise 侵蝕，避免出現直線邊界（同真實海灣／深圳海岸更似）
            edge = min(x - land_x_min, land_x_max - x)
            if edge < 8:
                r_edge = _hash01(x, y, 9)
                if r_edge < (8 - edge) / 8.0 * 0.8:
                    continue
            # 北岸：只有原本冇 DTM 資料（海/NODATA）嘅格才合成深圳市區/郊野
            if terrain[i] != WATER:
                continue
            dist = d
            # 口岸附近密度較高
            near_cross = min(abs(x + 0.5 - cx) for cx in [((hk1980(lat, lon)[0] - E0) / TILE_M) for _, lat, lon, _k in BORDER_CROSSINGS])
            r1 = _hash01(x, y, 4)
            r2 = _hash01(x, y, 12)
            if dist <= 12 and near_cross <= 30:
                # 深圳市核心（羅湖／福田／皇崗一帶）
                terrain[i] = URBAN
                landuse[i] = SHENZHEN_LU['urbanCore'] if r1 < 0.6 else SHENZHEN_LU['residential']
                elev[i] = max(1, int(2 + r1 * 3))
                density[i] = 120 + int(r1 * 70)
                heights[i] = 100 + int(r1 * 120)
                shenzhen_urban += 1
            elif dist <= 45 and near_cross <= 55:
                # 深圳市區帶：住宅／工業／少量綠化
                if r2 < 0.55:
                    terrain[i] = URBAN
                    landuse[i] = SHENZHEN_LU['residential'] if r1 < 0.55 else (SHENZHEN_LU['industrial'] if r1 < 0.78 else SHENZHEN_LU['urbanCore'])
                    elev[i] = max(1, int(2 + r1 * 6))
                    density[i] = 55 + int(r1 * 95)
                    heights[i] = 45 + int(r1 * 130)
                    shenzhen_urban += 1
                else:
                    terrain[i] = GRASS if r2 < 0.75 else FOREST
                    landuse[i] = SHENZHEN_LU['grass'] if r2 < 0.75 else SHENZHEN_LU['woodland']
                    elev[i] = max(1, int(3 + r1 * 10))
                    density[i] = 0
                    heights[i] = 0
            elif dist <= 70 and near_cross <= 70:
                # 市郊過渡：低層／村屋 + 農地／林地
                if r2 < 0.22:
                    terrain[i] = URBAN
                    landuse[i] = SHENZHEN_LU['residential']
                    elev[i] = max(1, int(2 + r1 * 5))
                    density[i] = 30 + int(r1 * 50)
                    heights[i] = 25 + int(r1 * 60)
                    shenzhen_urban += 1
                else:
                    terrain[i] = GRASS if r2 < 0.7 else FOREST
                    landuse[i] = SHENZHEN_LU['grass'] if r2 < 0.7 else SHENZHEN_LU['woodland']
                    elev[i] = max(1, int(4 + r1 * 20))
                    density[i] = 0
                    heights[i] = 0
            else:
                # 深圳市郊／丘陵（梧桐山、塘朗山方向）
                hillside = dist > 50 and r1 > 0.55 and (x > 300 or x < 240)
                if hillside:
                    terrain[i] = HILL if r1 > 0.8 else FOREST
                    elev[i] = max(1, int(30 + r1 * 90))
                else:
                    terrain[i] = FOREST if r1 < 0.55 else GRASS
                    elev[i] = max(1, int(5 + r1 * 25))
                landuse[i] = SHENZHEN_LU['woodland'] if r1 < 0.55 else SHENZHEN_LU['grass']
                density[i] = 0
                heights[i] = 0
            shenzhen_tiles += 1
    # ── 道路／鐵路 hint：每個口岸向北 + 向南各延伸（俾 worldgen 駁路／鋪軌）──
    crossings = []
    for name, lat, lon, kind in BORDER_CROSSINGS:
        E, N = hk1980(lat, lon)
        cx = (E - E0) / TILE_M
        cy = (NTOP - N) / TILE_M
        # 口岸 anchor：河嘅南岸（香港側）最近可建陸地
        ax = int(round(cx))
        ay = int(round(cy + BORDER_RIVER_HALF + 2))
        for r in range(0, 14):
            found = None
            for dy in range(-r, r + 1):
                for dx in (-r, 0, r):
                    xx, yy = ax + dx, ay + dy
                    if not (0 <= xx < W and 0 <= yy < H):
                        continue
                    if terrain[yy * W + xx] != WATER:
                        found = (xx, yy)
                        break
                if found:
                    break
            if found:
                ax, ay = found
                break
        # 道路 hint：anchor 向北過河（for bridge/tunnel）＋向南接香港路網
        for step in range(0, 26):
            yy = ay - step
            if 0 <= yy < H:
                ii = yy * W + min(W - 1, max(0, ax))
                road_hint[ii] = 1
        for step in range(0, 43):
            yy = ay + step
            if 0 <= yy < H:
                ii = yy * W + min(W - 1, max(0, ax))
                road_hint[ii] = 1
        dx, dy = _design_float(cx, cy)
        crossings.append([name, round(dx, 3), round(dy, 3), kind, ax, ay])
    # ── 深圳河 polygon ring（設計座標；左右岸 offset）──
    ring = []
    bank = 0.9
    for k in range(len(poly) - 1):
        x0, y0 = poly[k]
        x1, y1 = poly[k + 1]
        dx = x1 - x0
        dy = y1 - y0
        ln = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / ln, dx / ln
        ring.append((x0 + nx * bank, y0 + ny * bank))
    for k in range(len(poly) - 1, 0, -1):
        x0, y0 = poly[k]
        x1, y1 = poly[k - 1]
        dx = x1 - x0
        dy = y1 - y0
        ln = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / ln, dx / ln
        ring.append((x0 + nx * bank, y0 + ny * bank))
    river_ring_design = []
    for tx, ty in ring:
        ddx, ddy = _design_float(tx, ty)
        river_ring_design.append([round(ddx, 3), round(ddy, 3)])
    stats = {
        'riverTiles': river_tiles,
        'shenzhenLandTiles': shenzhen_tiles,
        'shenzhenUrbanTiles': shenzhen_urban,
        'crossings': crossings,
    }
    return crossings, river_ring_design, stats


def snap_land(x, y, terrain, maxr=6):
    """把 label／spawn 由水面 snap 到最近陸地格（保持 96 設計座標系不變）。"""
    if 0 <= x < W and 0 <= y < H and terrain[y*W+x] != WATER:
        return x, y
    for r in range(1, maxr+1):
        for dy in range(-r, r+1):
            for dx in range(-r, r+1):
                if max(abs(dx), abs(dy)) != r:
                    continue
                xx, yy = x+dx, y+dy
                if 0 <= xx < W and 0 <= yy < H and terrain[yy*W+xx] != WATER:
                    return xx, yy
    return x, y


def build_labels(terrain=None):
    labels=[]
    for name,lat,lon,kind in PLACES:
        E,N=hk1980(lat,lon); x,y=tile_of(E,N)
        if terrain is not None and kind not in ('water',):
            x, y = snap_land(x, y, terrain)
        if 0<=x<W and 0<=y<H:
            dx,dy=design_coord(x,y)
            labels.append([name,round(dx,3),round(dy,3),kind])
    lm=[]
    for name,lat,lon,kind in LANDMARKS:
        E,N=hk1980(lat,lon); x,y=tile_of(E,N)
        if 0<=x<W and 0<=y<H:
            dx,dy=design_coord(x,y)
            lm.append([name,round(dx,3),round(dy,3),kind])
    tun=[]
    for name,lon in TUNNELS:
        E,N=hk1980(22.293,lon)
        x,y=tile_of(E,N); dx,dy=design_coord(x,y)
        tun.append([name,round(dx,3),round(dy,3)])
    regions=[]
    for name,la0,la1,lo0,lo1,kind in REGIONS:
        x0,y0,x1,y1=bounds_design(la0,la1,lo0,lo1)
        regions.append([name,round(x0,2),round(y0,2),round(x1,2),round(y1,2),kind])
    return labels,lm,tun,regions

# ----------------------------- encode / output -----------------------------
def rle_bytes(data):
    out = bytearray()
    n = len(data); i=0
    while i < n:
        v=data[i]; j=i+1
        while j<n and data[j]==v and j-i < 255: j+=1
        out.append(v); out.append(j-i)
        i=j
    return bytes(out)

def b64(b):
    return base64.b64encode(b).decode('ascii')

def main():
    t0=time.time()
    print('building DTM aggregate (600x600, 112m/tile, stride=5)...', flush=True)
    sums,cnt,land,mx,mn = build_dtm()
    print('building building density...', flush=True)
    dens,hvol,counts = build_density()
    print('loading landuse raster (PlanD 2020 LUHK 10m)...', flush=True)
    lu_counts, lu_valid = load_landuse()
    print('classifying...', flush=True)
    terrain, elev, density, heights = classify(sums,cnt,land,mx,mn,dens,hvol,counts,lu_counts,lu_valid)
    print('smoothing natural terrain...', flush=True)
    terrain = smooth_natural(terrain, passes=2)
    print('rasterising official reservoirs (WSD 17 polygons)...', flush=True)
    res_per, res_union, res_new = rasterize_reservoirs(terrain, elev)
    print('carving rivers...', flush=True)
    river_tiles = carve_rivers(terrain, elev)
    print('aggregating landuse + roadHint...', flush=True)
    landuse, road_hint = build_landuse_layers(lu_counts, lu_valid)
    print('Shenzhen River / border crossings / north bank (Issue #4)...', flush=True)
    border_crossings_raw, shenzhen_river, border_stats = apply_border_and_shenzhen(
        terrain, elev, density, heights, landuse, road_hint
    )
    print('labels/landmarks/tunnels/regions...', flush=True)
    labels,lm,tun,regions = build_labels(terrain)
    # 追加深圳地名標籤（設計座標，向東／北顯示）
    for name, lat, lon, kind in [('深圳市', 22.540, 114.060, 'district'), ('深圳河', 22.520, 114.100, 'water')]:
        E, N = hk1980(lat, lon)
        tx, ty = tile_of(E, N)
        dx, dy = design_coord(tx, ty)
        labels.append([name, round(dx, 3), round(dy, 3), kind])
    # spawn：中環，若落水則 snap 到最近陸地
    E,N=hk1980(22.2819,114.1582)
    sx,sy=tile_of(E,N)
    sx,sy=snap_land(sx,sy,terrain)
    spawn=(sx,sy)
    # ── stats ──
    from collections import Counter
    cc=Counter(terrain)
    names=['water','sand','grass','fertile','wetland','forest','hill','mountain','urban','reclaimed']
    total=W*H
    buildable_terrains=(URBAN,RECLAIMED,GRASS,FOREST,HILL,FERTILE)
    buildable=sum(cc[t] for t in buildable_terrains)
    print('tile stats (600x600 =', total, 'tiles, 112m/tile):', flush=True)
    for k in range(10):
        v=cc.get(k,0)
        print(f'  {names[k]:<9} {v:>7} ({v/total*100:5.2f}%)')
    print(f'  buildable (urban/reclaimed/grass/forest/hill/fertile): {buildable} ({buildable/total*100:.1f}%)')
    print(f'  reservoirs: official polygon union = {res_union} water tiles ({res_new} newly converted from land)', flush=True)
    for name,cntt in sorted(res_per.items(), key=lambda kv:-kv[1]):
        print(f'    - {name}: {cntt} tiles')
    EXPECTED_RES = ['大欖涌水塘','船灣淡水湖','萬宜水庫','城門水塘','大潭篤水塘','大潭上水塘','大潭中水塘',
                    '大潭副水塘','石壁水塘','香港仔上水塘','香港仔下水塘','薄扶林水塘','黃泥涌水塘',
                    '九龍水塘','九龍副水塘','九龍接收水塘','石梨貝水塘','下城門水塘','流水響水塘','鶴藪水塘']
    missing = [n for n in EXPECTED_RES if res_per.get(n, 0) <= 0]
    print('    expected reservoirs missing:', missing if missing else 'none', flush=True)
    print(f'  river/stream tiles: {len(set(river_tiles))}; labels {len(labels)}, landmarks {len(lm)}, regions {len(regions)}, tunnels {len(tun)}')
    print('  border (Issue #4):', flush=True)
    for c in border_stats.get('crossings', []):
        print(f"    - {c[0]} ({c[3]}) tile=({c[4]},{c[5]}) design=({c[1]},{c[2]})")
    print(f"    river water tiles: {border_stats.get('riverTiles', 0)}; Shenzhen land tiles: {border_stats.get('shenzhenLandTiles', 0)} "
          f"(urban {border_stats.get('shenzhenUrbanTiles', 0)})")
    lu_hint = sum(1 for b in road_hint if b)
    lu_counts_stat = Counter(landuse)
    print('  landuse (majority / tile) top:', ', '.join(f'{k}:{v}' for k, v in lu_counts_stat.most_common(10)))
    print(f'  roadHint tiles: {lu_hint}')
    dens_n=sum(1 for b in density if b>0)
    print(f'  density>0 tiles: {dens_n}; height>0 tiles: {sum(1 for b in heights if b>0)}')
    lu_tot=[(cls, sum(lu_counts[i])) for i,cls in enumerate(LU_TRACK_CLASSES)]
    lu_tot.sort(key=lambda kv:-kv[1])
    print('  landuse sample stats (top 12):', ', '.join(f'{cls}:{n}' for cls,n in lu_tot[:12]))
    # ── write generated.ts ──
    # roadHint：每格 1 bit（LSB-first；tile i → byte i>>3, bit i&7）
    hint_bytes = bytearray((W * H + 7) // 8)
    for i, v in enumerate(road_hint):
        if v:
            hint_bytes[i >> 3] |= 1 << (i & 7)
    # border centreline（設計座標；每 2 個採樣點存一次）
    border_poly = border_polyline_tiles()
    centerline_design = []
    for k in range(0, len(border_poly), 2):
        tx, ty = border_poly[k]
        ddx, ddy = _design_float(tx, ty)
        centerline_design.append([round(ddx, 3), round(ddy, 3)])
    border_crossings = [
        {'name': c[0], 'x': c[1], 'y': c[2], 'kind': c[3]} for c in border_crossings_raw
    ]
    obj = {
      'format':'hk-map-data-v1','width':W,'heightTiles':H,'tileMeters':TILE_M,
      'e0':E0,'nTop':NTOP,'terrainRle':b64(rle_bytes(terrain)),
      'elevation':b64(bytes(elev)),'density':b64(bytes(density)),'buildingHeight':b64(bytes(heights)),
      'labels':labels,'landmarks':lm,'tunnels':tun,'regions':regions,
      'spawn':{'x':spawn[0],'y':spawn[1]},
      'landuse': b64(bytes(landuse)),
      'roadHint': b64(bytes(hint_bytes)),
      'borderCrossings': border_crossings,
      'shenzhenRiver': shenzhen_river,
      'border': {'riverWidthTiles': 2, 'centerline': centerline_design},
    }
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    outdir=os.path.join(root,'src','world')
    os.makedirs(outdir,exist_ok=True)
    path=os.path.join(outdir,'hk-map-data.generated.ts')
    with open(path,'w') as f:
        f.write('// AUTO-GENERATED by tools/build-hk-data.py — from CSDI/LandsD/WSD/PlanD open data (DTM 5m + Building Outlines + Impounding Reservoirs + LUHK 2020 10m).\n')
        f.write('// Do not edit by hand. Regenerate with: python3 tools/build-hk-data.py\n')
        f.write('import type { MapData } from "./hk-map-data-types";\n\n')
        f.write('export const HK_MAP_DATA: MapData = ')
        f.write(json.dumps(obj, ensure_ascii=False, separators=(',',':')))
        f.write(';\n')
    size=os.path.getsize(path)
    print(f'wrote {path} {size} bytes ({size/1024/1024:.2f} MB); spawn tile {spawn}; total {round(time.time()-t0,1)}s', flush=True)
    preview_png(terrain, elev, labels, spawn, '/tmp/hk-map-600-preview.png')
    preview_shenzhen(terrain, elev, landuse, border_crossings_raw, border_polyline_tiles(), '/tmp/hk-map-600-shenzhen.png')
    print('preview /tmp/hk-map-600-preview.png + /tmp/hk-map-600-shenzhen.png', flush=True)


# ----------------------------- preview PNG (pure python, no PIL) -----------------------------
PREVIEW_COLORS = {
    WATER:(34,74,110), SAND:(222,206,158), GRASS:(122,156,86), FERTILE:(168,184,92),
    WETLAND:(88,118,96), FOREST:(72,108,62), HILL:(132,130,98), MOUNTAIN:(152,142,120),
    URBAN:(176,168,158), RECLAIMED:(196,186,166),
}

def _png_chunk(typ, data):
    return struct.pack('>I', len(data)) + typ + data + struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff)

def write_png(path, width, height, rgb):
    raw = bytearray()
    stride = width*3
    for y in range(height):
        raw.append(0)
        raw += rgb[y*stride:(y+1)*stride]
    png = b'\x89PNG\r\n\x1a\n'
    png += _png_chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
    png += _png_chunk(b'IDAT', zlib.compress(bytes(raw), 6))
    png += _png_chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)

def preview_shenzhen(terrain, elev, landuse, crossings, border_poly, path, scale=3):
    """北面邊界 preview：深圳河 + 深圳市區 + 4 個邊境通道標記。"""
    y0, y1 = 0, 270
    x0, x1 = 60, 520
    cw = (x1 - x0) * scale
    ch = (y1 - y0) * scale
    rgb = bytearray(cw * ch * 3)
    for yy in range(y0, y1):
        for xx in range(x0, x1):
            i = yy * W + xx
            r, g, b = PREVIEW_COLORS.get(terrain[i], (0, 0, 0))
            if terrain[i] == WATER:
                # 深圳河用較亮青藍，同海分開
                if 55 <= landuse[i] <= 92:
                    r, g, b = (38, 150, 190)
            else:
                e = elev[i] / 255.0
                k = 0.62 + 0.45 * e
                r = int(r * k); g = int(g * k); b = int(b * k)
            for sy in range(scale):
                base = ((yy - y0) * scale + sy) * cw
                for sx in range(scale):
                    di = (base + (xx - x0) * scale + sx) * 3
                    rgb[di] = min(255, r); rgb[di + 1] = min(255, g); rgb[di + 2] = min(255, b)
    # 邊界線（黃）＋口岸標記（紅=道路、藍=鐵路）
    for tx, ty in border_poly:
        xx, yy = int(tx), int(ty)
        if x0 <= xx < x1 and y0 <= yy < y1:
            px = (xx - x0) * scale
            py = (yy - y0) * scale
            for sy in range(scale):
                di = ((py + sy) * cw + px) * 3
                rgb[di] = 240; rgb[di + 1] = 220; rgb[di + 2] = 80
    for name, dx, dy, kind, ax, ay in crossings:
        color = (230, 70, 70) if kind == 'road' else (70, 140, 240)
        if x0 <= ax < x1 and y0 <= ay < y1:
            px = (ax - x0) * scale
            py = (ay - y0) * scale
            rad = scale * 2
            for sy in range(-rad, rad + 1):
                for sx in range(-rad, rad + 1):
                    if sx * sx + sy * sy > rad * rad:
                        continue
                    xx2 = px + sx; yy2 = py + sy
                    if 0 <= xx2 < cw and 0 <= yy2 < ch:
                        di = (yy2 * cw + xx2) * 3
                        rgb[di] = color[0]; rgb[di + 1] = color[1]; rgb[di + 2] = color[2]
    write_png(path, cw, ch, rgb)
    print('shenzhen preview', path, flush=True)


def preview_png(terrain, elev, labels, spawn, path, scale=2):
    """600×600 → 1200×1200 PNG（地形色 + 高程陰影 + 水塘深藍 + label 白點 + spawn 紅點）。"""
    small = bytearray(W*H*3)
    for i, t in enumerate(terrain):
        r, g, b = PREVIEW_COLORS.get(t, (0, 0, 0))
        if t != WATER:
            e = elev[i]/255.0
            k = 0.62 + 0.45*e
            r = int(r*k); g = int(g*k); b = int(b*k)
        else:
            # 水塘/河溪比海略深藍
            if elev[i] == 0 and t == WATER:
                pass
        small[i*3], small[i*3+1], small[i*3+2] = min(255, r), min(255, g), min(255, b)
    # 內陸水域（水塘／河溪）用青藍色標示，方便核對 17+ 個水塘都有 rasterize 到
    for i in range(W*H):
        if terrain[i] != WATER:
            continue
        x = i % W; y = i // W
        if 1 <= x < W-1 and 1 <= y < H-1:
            land_nei = 0
            for dy in (-1,0,1):
                for dx in (-1,0,1):
                    if terrain[(y+dy)*W + x+dx] != WATER:
                        land_nei += 1
            if land_nei >= 4:
                small[i*3] = 24
                small[i*3+1] = 136
                small[i*3+2] = 170
    # label 白點 / spawn 紅點
    def plot(px, py, color, r=1):
        for dy in range(-r, r+1):
            for dx in range(-r, r+1):
                xx, yy = px+dx, py+dy
                if 0 <= xx < W and 0 <= yy < H:
                    i = (yy*W+xx)*3
                    small[i], small[i+1], small[i+2] = color
    for name, dx, dy, kind in labels:
        tx = int(round((dx + 0.5)*(W/96.0) - 0.5))
        ty = int(round((dy + 0.5)*(H/96.0) - 0.5))
        plot(tx, ty, (255,255,255), 1)
    plot(spawn[0], spawn[1], (255,60,60), 2)
    # nearest upscale
    bw, bh = W*scale, H*scale
    big = bytearray(bw*bh*3)
    for y in range(bh):
        sy = y//scale
        row = sy*W*3
        for x in range(bw):
            sx = x//scale
            si = row + sx*3
            di = (y*bw + x)*3
            big[di] = small[si]; big[di+1] = small[si+1]; big[di+2] = small[si+2]
    write_png(path, bw, bh, big)


if __name__=='__main__':
    main()
