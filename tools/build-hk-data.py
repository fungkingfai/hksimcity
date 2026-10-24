#!/usr/bin/env python3
"""Build real-geography game data for 《維港之城》 from CSDI/LandsD open data.

Inputs (download URLs documented in repo tools/README):
- DTM 5m ASC (LandsD): Whole_HK_DTM_5m.zip
- Building outlines GeoJSON (LandsD via CSDI): zip containing Building_Outline_..._Building_converted.geojson

Outputs src/world/hk-map-data.generated.ts:
- 480x480 grid: terrain code / elevation / building density
- real-coordinate labels, landmarks, tunnels, spawn
This script is run offline; generated data is committed so CI does not need the 400MB sources.
"""
import zipfile, json, math, sys, time, os, base64, zlib, struct

W = H = 480
TILE_M = 140.0
SPAN = W * TILE_M
E0 = 798275.0
NTOP = 857600.0
XLL, YLL, CELL, NCOLS, NROWS = 799997.5, 799997.5, 5.0, 12751, 9601
TOPY = YLL + NROWS * CELL

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
    t0 = time.time()
    z = zipfile.ZipFile(os.environ.get('HK_DTM_ZIP', '/tmp/dtm.zip'))
    sums = [0.0]*(W*H)
    cnt  = [0]*(W*H)
    land = [0]*(W*H)
    mx   = [0.0]*(W*H)
    rows_done = 0
    stride = 7  # 35m sampling; 4x4 samples/tile
    # precompute x for sampled cols
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
            if rows_done % 1200 == 0:
                print(f'  dtm rows {rows_done}/{NROWS} ({time.time()-t0:.0f}s)', flush=True)
    print(f'  dtm done {time.time()-t0:.1f}s', flush=True)
    return sums, cnt, land, mx

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

# ----------------------------- classification -----------------------------
def in_box(lat, lon, box):
    la0, la1, lo0, lo1 = box
    return la0 <= lat <= la1 and lo0 <= lon <= lo1

FARMLAND = [
    (22.40, 22.53, 113.98, 114.10),   # Yuen Long / Kam Tin / Sheung Shui / Fanling
    (22.43, 22.50, 114.06, 114.13),   # Tai Po / Fanling east
]
WETLAND_BOXES = [
    (22.47, 22.53, 113.98, 114.06),   # Mai Po / Deep Bay
    (22.43, 22.47, 114.02, 114.06),   # Nam Sang Wai
    (22.24, 22.27, 113.84, 113.87),   # Tai O
]
RECLAIMED_BOXES = [
    (22.29, 22.32, 114.14, 114.18),   # West Kowloon
    (22.30, 22.33, 114.19, 114.23),   # Kai Tak
    (22.28, 22.31, 114.25, 114.29),   # Tseung Kwan O
    (22.26, 22.30, 113.92, 113.96),   # Tung Chung
    (22.27, 22.29, 114.23, 114.25),   # Heng Fa Chuen
]

def classify(sums, cnt, land, mx, dens, hvol, counts):
    terrain = bytearray(W*H)  # default WATER=0
    elev = bytearray(W*H)
    density = bytearray(W*H)
    heights = bytearray(W*H)
    for i in range(W*H):
        c = cnt[i]
        if c == 0:
            terrain[i] = WATER
            continue
        landf = land[i]/c
        mean = sums[i]/c
        hmax = mx[i]
        y = i//W; x = i%W
        E, N = tile_center(x,y)
        # approximate lat/lon from E,N ? use inverse not implemented; use design grid mapping via known affine
        # For polygons we instead classify using precomputed lat/lon masks below; skip here.
        cov = dens[i]/ (TILE_M*TILE_M)
        if cov > 1.2: cov = 1.2
        density[i] = min(255, int(round(cov/0.5*255)))
        if dens[i] > 1.0:
            avg_h = hvol[i]/dens[i]
            heights[i] = max(1, min(255, int(round(avg_h/500.0*255))))
        else:
            heights[i] = 0
        if landf < 0.42:
            terrain[i] = WATER
            elev[i] = 0
            continue
        m = max(0.0, mean)
        # base natural terrain
        if hmax >= 400:
            t = MOUNTAIN
        elif hmax >= 180 or m >= 130:
            t = HILL
        elif m >= 55 or hmax >= 240:
            t = FOREST
        else:
            t = GRASS
        if hmax < 4 and landf < 0.7 and cov < 0.02:
            t = SAND
        # built-up urban: building coverage
        if cov >= 0.028 and t not in (MOUNTAIN, HILL):
            t = URBAN
        # elevation byte (0..255) from mean/max; sea 0; mountains bright
        e = max(m, hmax*0.55)
        ev = int(round(min(255, (e/650.0)**1.0*255)))
        elev[i] = max(1, ev)
        terrain[i] = t
    # region overrides via lat/lon: build mapping from tile center -> lat/lon by inverse approximation
    # Use TM inverse not available; approximate with linear fit from 4 known points
    # fit lon = a*E + b*N + c ; lat = d*E + e*N + f from forward points at corners
    pts = [(22.15,113.8),(22.57,113.8),(22.15,114.45),(22.57,114.45),(22.3,114.17),(22.4,114.2)]
    A=[]; blon=[]; blat=[]
    for la,lo in pts:
        E,N=hk1980(la,lo); A.append([E,N,1.0]); blon.append(lo); blat.append(la)
    # solve normal equations 3x3
    import copy
    def solve(A,b):
        n=len(A); M=[A[i][:]+[b[i]] for i in range(n)]
        for col in range(n):
            p=max(range(col,n), key=lambda r: abs(M[r][col]))
            M[col],M[p]=M[p],M[col]
            if abs(M[col][col])<1e-9: continue
            for r in range(n):
                if r!=col:
                    f=M[r][col]/M[col][col]
                    for k in range(col,n+1): M[r][k]-=f*M[col][k]
        return [M[i][n]/M[i][i] if abs(M[i][i])>1e-9 else 0 for i in range(n)]
    # least squares normal equations
    def lstsq(A,b):
        n=len(A); m=3
        AtA=[[sum(A[k][i]*A[k][j] for k in range(n)) for j in range(m)] for i in range(m)]
        Atb=[sum(A[k][i]*b[k] for k in range(n)) for i in range(m)]
        return solve(AtA,Atb)
    clon=lstsq(A,blon); clat=lstsq(A,blat)
    for i in range(W*H):
        if terrain[i]==WATER: continue
        x=i%W; y=i//W
        E,N=tile_center(x,y)
        lon=clon[0]*E+clon[1]*N+clon[2]
        lat=clat[0]*E+clat[1]*N+clat[2]
        t=terrain[i]
        # 低窪地區才可做濕地／農地／填海（避免把山地畫成矩形色塊）
        uneven = ((x*37 + y*73) % 100)
        if elev[i] < 14 and uneven < 78 and any(in_box(lat,lon,b) for b in WETLAND_BOXES):
            t=WETLAND
        elif elev[i] < 46 and density[i] < 12 and any(in_box(lat,lon,b) for b in FARMLAND):
            if t in (GRASS,SAND): t=FERTILE
        if elev[i] < 40 and any(in_box(lat,lon,b) for b in RECLAIMED_BOXES):
            if t not in (MOUNTAIN,HILL,WETLAND): t=RECLAIMED
        terrain[i]=int(t)
    return terrain, elev, density, heights

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

def build_labels(tunnels_road=None):
    labels=[]
    for name,lat,lon,kind in PLACES:
        E,N=hk1980(lat,lon); x,y=tile_of(E,N)
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
    print('building DTM aggregate...', flush=True)
    sums,cnt,land,mx = build_dtm()
    print('building density...', flush=True)
    dens, hvol, counts = build_density()
    print('classifying...', flush=True)
    terrain, elev, density, heights = classify(sums,cnt,land,mx,dens,hvol,counts)
    # 水塘／河流（DTM 水面高程 >0，唔會當海；用真實座標橢圓補回）
    RESERVOIRS = [
      (22.470,114.242,2200,1600), (22.372,114.352,2200,1500), (22.412,114.038,1100,800),
      (22.402,114.148,900,700), (22.352,114.152,520,360), (22.230,113.900,850,650),
      (22.255,114.200,650,450), (22.253,114.160,380,280), (22.403,114.075,450,360),
    ]
    RIVERS = [((22.382,114.192),(22.418,114.204),1), ((22.393,113.972),(22.378,113.965),1)]
    def carve_world(points, width_tiles):
        # rasterise polyline in tile space
        pts=[]
        for la,lo in points:
            E,N=hk1980(la,lo); pts.append(tile_of(E,N))
        for k in range(len(pts)-1):
            x0,y0=pts[k]; x1,y1=pts[k+1]
            steps=max(abs(x1-x0),abs(y1-y0),1)
            for s in range(steps+1):
                x=round(x0+(x1-x0)*s/steps); y=round(y0+(y1-y0)*s/steps)
                for dy in range(-width_tiles,width_tiles+1):
                    for dx in range(-width_tiles,width_tiles+1):
                        xx,yy=x+dx,y+dy
                        if 0<=xx<W and 0<=yy<H:
                            i=yy*W+xx; terrain[i]=WATER; elev[i]=0
    for la,lo,rx,ry in RESERVOIRS:
        E,N=hk1980(la,lo); cx,cy=tile_of(E,N)
        rxt=rx/TILE_M; ryt=ry/TILE_M
        for dy in range(-int(ryt)-1,int(ryt)+2):
            for dx in range(-int(rxt)-1,int(rxt)+2):
                if (dx/rxt)**2+(dy/ryt)**2 <= 1.0:
                    xx,yy=cx+dx,cy+dy
                    if 0<=xx<W and 0<=yy<H:
                        i=yy*W+xx
                        if terrain[i] not in (WATER,MOUNTAIN):
                            terrain[i]=WATER; elev[i]=0
    for p0,p1,wd in RIVERS:
        carve_world([p0,p1],wd)
    # starter roads / tunnels rasterization done in game worldgen using terrain; labels here
    labels,lm,tun,regions = build_labels(None)
    spawn = None
    E,N=hk1980(22.2819,114.1582)
    spawn=(tile_of(E,N))
    print('tile stats:', flush=True)
    from collections import Counter
    cc=Counter(terrain)
    names=['water','sand','grass','fertile','wetland','forest','hill','mountain','urban','reclaimed']
    for k,v in cc.most_common(): print(' ',names[k],v)
    print('spawn tile',spawn,'total',W*H)
    obj = {
      'format':'hk-map-data-v1','width':W,'heightTiles':H,'tileMeters':TILE_M,
      'e0':E0,'nTop':NTOP,'terrainRle':b64(rle_bytes(terrain)),
      'elevation':b64(bytes(elev)),'density':b64(bytes(density)),'buildingHeight':b64(bytes(heights)),
      'labels':labels,'landmarks':lm,'tunnels':tun,'regions':regions,
      'spawn':{'x':spawn[0],'y':spawn[1]},
    }
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    outdir=os.path.join(root,'src','world')
    os.makedirs(outdir,exist_ok=True)
    path=os.path.join(outdir,'hk-map-data.generated.ts')
    with open(path,'w') as f:
        f.write('// AUTO-GENERATED by tools/build-hk-data.py — from CSDI/LandsD open data (DTM 5m + Building Outlines).\n')
        f.write('// Do not edit by hand. Regenerate with: python3 tools/build-hk-data.py\n')
        f.write('import type { MapData } from "./hk-map-data-types";\n\n')
        f.write('export const HK_MAP_DATA: MapData = ')
        f.write(json.dumps(obj, ensure_ascii=False))
        f.write(';\n')
    print('wrote',path,os.path.getsize(path),'bytes; total',round(time.time()-t0,1),'s')
    # preview bmp
    preview(terrain, elev, labels, spawn, '/tmp/hk-map-preview.ppm')
    sys.exit(0)

def preview(terrain, elev, labels, spawn, path):
    colors={WATER:(40,90,140),SAND:(220,205,160),GRASS:(120,160,90),FERTILE:(160,180,90),WETLAND:(90,120,100),FOREST:(80,120,70),HILL:(130,130,100),MOUNTAIN:(150,140,120),URBAN:(170,160,150),RECLAIMED:(190,180,160)}
    with open(path,'wb') as f:
        f.write(f'P6\n{W} {H}\n255\n'.encode())
        buf=bytearray()
        for i,t in enumerate(terrain):
            r,g,b=colors.get(t,(0,0,0))
            if t==WATER: e=0
            else:
                e=elev[i]/255
                r=int(r*(0.65+0.45*e)); g=int(g*(0.65+0.45*e)); b=int(b*(0.65+0.45*e))
            buf += bytes([min(255,r),min(255,g),min(255,b)])
        f.write(buf)
    print('preview',path)
if __name__=='__main__':
    main()
