#!/usr/bin/env python3
"""Build real 3D landmark models from CSDI 3D-BIT00 (LandsD) for Round 9 (#20).

CSDI 3D-BIT00 provides one 3DS ZIP per 750m x 600m tile. Each ZIP contains
~2,000 small per-building .3ds files (plus .att metadata); vertices are already
in HK1980 Grid metres (x=E, y=N, z=height above HKPD). Downloading a full tile
ZIP is 0.5-3GB, so this tool uses HTTP Range requests:

  1. download the CSDI tile-index GeoJSON (cached in tools/data/csdi-3d-b1000.geojson)
  2. for selected HK tiles, fetch the ZIP tail/central directory
  3. fetch a selection of individual .3ds entries by Range
  4. parse chunk 0x4110 vertices / 0x4120 faces
  5. keep tallest / most distinctive buildings, convert HK1980 -> relative
     game-world units, and write src/world/hk-3d-landmarks.generated.ts

Source: CSDI / Lands Department "3D-BIT00" (3D Building Information Model)
https://portal.csdi.gov.hk/geoportY...
Run: python3 tools/build-3d-landmarks.py
"""
import json, math, os, re, struct, sys, time, urllib.request, zlib
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE=os.path.join(ROOT,'tools','data','csdi-3d-b1000.geojson')
OUT=os.path.join(ROOT,'src','world','hk-3d-landmarks.generated.ts')
TILE_INDEX_URL='https://portal.csdi.gov.hk/csdi-webpage/file-api?dataset_id=landsd_rcd_1637306559892_42396&format=geojson&layer_name=b1000_Tile'
E0=798275.0; NTOP=857600.0; TILE_M=112.0
WORLD_PER_M=2.0/TILE_M  # TILE=2 world units for 112m
# selected HK 1980 coords (Central, TST, Causeway Bay, Mong Kok, Kwun Tong,
# Sha Tin, Tsuen Wan, Chek Lap Kok, Tai Po, Aberdeen)
TARGETS=[(833900,815900),(836100,817700),(837900,816600),(835500,820500),
         (841700,818600),(842600,824000),(830000,821200),(812000,815400),
         (836400,830000),(834000,811500)]
MAX_MODELS_PER_TILE=16
MIN_HEIGHT=50.0
MAX_FACES=1100
CANDIDATES_PER_TILE=36

def log(*a): print(*a, flush=True)

def http_range(url, a, b):
    req=urllib.request.Request(url, headers={'Range':f'bytes={a}-{b}','User-Agent':'hksimcity-3d-build/1.0'})
    with urllib.request.urlopen(req, timeout=120) as r: return r.read()

def load_index():
    if os.path.exists(CACHE):
        return json.load(open(CACHE))
    log('download CSDI 3D-BIT00 tile index ...')
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    req=urllib.request.Request(TILE_INDEX_URL, headers={'User-Agent':'hksimcity-3d-build/1.0'})
    with urllib.request.urlopen(req, timeout=180) as r: raw=r.read()
    open(CACHE,'wb').write(raw)
    return json.loads(raw)

def find_sheet(index, E, N):
    for f in index['features']:
        p=f['properties']
        if p['Min_x'] <= E <= p['Max_x'] and p['Min_y'] <= N <= p['Max_y']:
            return p
    return None

def zip_entries(url):
    # central directory is at end; 700KB tail is plenty for ~2k entries
    total=None
    req=urllib.request.Request(url, headers={'Range':'bytes=-700000','User-Agent':'hksimcity-3d-build/1.0'})
    with urllib.request.urlopen(req, timeout=180) as r:
        data=r.read(); total=int(r.headers.get('Content-Range','').split('/')[-1] or 0)
    i=data.rfind(b'PK\x05\x06')
    if i<0: return [], total
    eocd=data[i:]
    n=struct.unpack('<H',eocd[10:12])[0]
    cd_size=struct.unpack('<I',eocd[12:16])[0]
    cd_off=struct.unpack('<I',eocd[16:20])[0]
    cd=http_range(url, cd_off, cd_off+cd_size-1)
    entries=[]; pos=0
    for _ in range(n):
        if cd[pos:pos+4]!=b'PK\x01\x02': break
        method=struct.unpack('<H',cd[pos+10:pos+12])[0]
        csize=struct.unpack('<I',cd[pos+20:pos+24])[0]
        usize=struct.unpack('<I',cd[pos+24:pos+28])[0]
        fnlen=struct.unpack('<H',cd[pos+28:pos+30])[0]
        extra=struct.unpack('<H',cd[pos+30:pos+32])[0]
        cmt=struct.unpack('<H',cd[pos+32:pos+34])[0]
        off=struct.unpack('<I',cd[pos+42:pos+46])[0]
        name=cd[pos+46:pos+46+fnlen].decode('utf-8','replace')
        entries.append((name,off,csize,usize,method))
        pos+=46+fnlen+extra+cmt
    return entries,total

def fetch_entry(url, e):
    name,off,csize,usize,method=e
    hdr=http_range(url, off, off+29)
    if hdr[:4]!=b'PK\x03\x04': raise ValueError('bad local header')
    fnlen=struct.unpack('<H',hdr[26:28])[0]; extra=struct.unpack('<H',hdr[28:30])[0]
    start=off+30+fnlen+extra
    data=http_range(url, start, start+csize-1)
    return data if method==0 else zlib.decompress(data,-15)

def parse_3ds(raw):
    """Tolerant scan for 3DS vertex (0x4110) / face (0x4120) chunks.

    3D-BIT00 .3ds files appear to be a concatenation of multiple chunk blocks;
    scanning byte-wise for well-formed chunk lengths is more reliable than
    walking the top-level chunk (which may not contain the whole file)."""
    verts=[]; faces=[]; base=0
    n=len(raw); i=0
    while i+8 <= n:
        if raw[i:i+2]==b'\x10\x41':
            ln=struct.unpack('<I',raw[i+2:i+6])[0]
            cnt=struct.unpack('<H',raw[i+6:i+8])[0]
            if cnt>0 and ln>=8+cnt*12 and i+ln<=n:
                vs=struct.unpack('<'+'f'*(cnt*3),raw[i+8:i+8+cnt*12])
                base=len(verts)//3
                verts.extend(vs)
                i+=ln
                continue
        elif raw[i:i+2]==b'\x20\x41':
            ln=struct.unpack('<I',raw[i+2:i+6])[0]
            cnt=struct.unpack('<H',raw[i+6:i+8])[0]
            if cnt>0 and ln>=8+cnt*8 and i+ln<=n:
                npv=len(verts)//3
                off=i+8
                for _ in range(cnt):
                    a,b,c=struct.unpack('<HHH',raw[off:off+6]); off+=8
                    if a+base<npv and b+base<npv and c+base<npv:
                        faces.extend((base+a,base+b,base+c))
                i+=ln
                continue
        i+=1
    if not verts or not faces: return None
    xs=verts[0::3]; ys=verts[1::3]; zs=verts[2::3]
    return verts,faces,min(xs),max(xs),min(ys),max(ys),min(zs),max(zs)

def decimate(verts, faces, max_faces=MAX_FACES):
    """Vertex-clustering decimation; returns compact (verts, faces) or None."""
    if not verts or not faces: return None
    xs=verts[0::3]; ys=verts[1::3]; zs=verts[2::3]
    extent=max(max(xs)-min(xs), max(ys)-min(ys), max(zs)-min(zs), 1.0)
    best=None
    for div in (10, 14, 20, 28, 40, 56, 80):
        cell=extent/div
        clusters={}
        newv=[]
        remap=[0]*(len(verts)//3)
        for i in range(0,len(verts),3):
            key=(round(verts[i]/cell), round(verts[i+1]/cell), round(verts[i+2]/cell))
            j=clusters.get(key)
            if j is None:
                j=len(newv)//3; clusters[key]=j
                newv.extend((round(verts[i],2),round(verts[i+1],2),round(verts[i+2],2)))
            remap[i//3]=j
        nf=[]; seen=set()
        for k in range(0,len(faces),3):
            try: a,b,c=remap[faces[k]],remap[faces[k+1]],remap[faces[k+2]]
            except IndexError: continue
            if a==b or b==c or a==c: continue
            key=(min(a,b,c),sorted((a,b,c))[1],max(a,b,c))
            if key in seen: continue
            seen.add(key); nf.extend((a,b,c))
        cand=(newv,nf)
        if len(nf)//3 <= max_faces:
            return cand
        if best is None or len(nf) < len(best[1]):
            best=cand
    return best

def main():
    index=load_index()
    out=[]; seen=set()
    for E,N in TARGETS:
        p=find_sheet(index,E,N)
        if not p:
            log('no tile for',E,N); continue
        sheet=p['SHEETNO']; url=p.get('Format_3DS')
        log(f'tile {sheet} @ {E},{N}')
        try: entries,total=zip_entries(url)
        except Exception as ex: log('  zip error',ex); continue
        ds=[e for e in entries if e[0].endswith('.3ds')]
        ds.sort(key=lambda e:e[2], reverse=True)
        chosen=ds[:CANDIDATES_PER_TILE*2]
        cands=[]
        def work(e):
            try:
                raw=fetch_entry(url,e)
                if not raw.startswith(b'MM'): return None
                geo=parse_3ds(raw)
                if not geo: return None
                verts,faces,x0,x1,y0,y1,z0,z1=geo
                h=z1-z0; area=(x1-x0)*(y1-y0)
                if h<MIN_HEIGHT or area<20 or area>30000: return None
                d=decimate(verts,faces)
                if not d: return None
                vv,ff=d
                if len(ff)//3 > MAX_FACES or len(ff)//3 < 6: return None
                return {'sheet':sheet,'heightM':round(h,1),'area':round(area,1),
                        'cx':(x0+x1)/2,'cy':(y0+y1)/2,'z0':z0,'verts':vv,'tris':ff}
            except Exception:
                return None
        with ThreadPoolExecutor(max_workers=6) as ex:
            futs=[ex.submit(work,e) for e in chosen]
            for f in as_completed(futs):
                try:
                    r=f.result()
                    if r: cands.append(r)
                except Exception: pass
        cands.sort(key=lambda m: m['heightM'], reverse=True)
        for m in cands[:MAX_MODELS_PER_TILE]:
            cx=m['cx']; cy=m['cy']; z0=m['z0']
            key=(sheet,round(cx,1),round(cy,1))
            if key in seen: continue
            seen.add(key)
            vv=[]
            for i in range(0,len(m['verts']),3):
                vv.append(round((m['verts'][i]-cx)*WORLD_PER_M,3))
                vv.append(round((m['verts'][i+2]-z0)*WORLD_PER_M,3))
                vv.append(round(-(m['verts'][i+1]-cy)*WORLD_PER_M,3))
            out.append({'sheet':sheet,'heightM':m['heightM'],'xTile':round((cx-E0)/TILE_M),
                        'yTile':round((NTOP-cy)/TILE_M),'verts':vv,'tris':m['tris']})
        log('  candidates',len(cands),'models',len([o for o in out if o['sheet']==sheet]),'total',len(out))
    # sort tallest first; cap to 110 models
    out.sort(key=lambda m:m['heightM'], reverse=True)
    out=out[:120]
    # re-id
    for i,m in enumerate(out): m['id']=i
    log('final models',len(out))
    if not out:
        log('ERROR no models'); sys.exit(1)
    # write TS module
    lines=['// AUTO-GENERATED by tools/build-3d-landmarks.py',
           '// Source: CSDI / Lands Department 3D-BIT00 (3D Building Information Model)',
           '// https://portal.csdi.gov.hk/  (Real HK1980 geometry, simplified per landmark)',
           '// Do not edit by hand.',
           'import type { Landmark3DModel } from "./hk-3d-landmarks-types";','',
           'export const LANDMARK_3D_MODELS: Landmark3DModel[] = [']
    for m in out:
        lines.append('  {id:%d,sheet:%r,heightM:%s,xTile:%s,yTile:%s,verts:[%s],tris:[%s]},' % (
            m['id'],m['sheet'],m['heightM'],m['xTile'],m['yTile'],
            ','.join(str(v) for v in m['verts']),','.join(str(v) for v in m['tris'])))
    lines.append('];')
    open(OUT,'w').write('\n'.join(lines)+'\n')
    log('wrote',OUT,os.path.getsize(OUT))

if __name__=='__main__': main()
