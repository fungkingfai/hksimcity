/**
 * 大地圖 Minimap（480×480 真實香港地理）。
 *
 * - Canvas 2D 概覽：真實海岸線／地形底色（CSDI／地政總署數據，含建築密度陰影）、
 *   道路、四色分區（半透明）、建築點、城市（spawn）位置、目前鏡頭視野框。
 * - 效能：
 *   1) 地形底圖用 ImageData + Uint32Array 一次畫好（480²=230k 像素），只在 seed／尺寸變更時重建；
 *   2) 道路／分區 overlay 合併成「內容層 canvas」，只在 `ui.revision`／showZones 變更時重建（230k 單次掃描）；
 *   3) 每 ~250ms 只做 drawImage(內容層) + 建築點 + 視野框，唔會每幀全畫 230k 格；
 *   4) 摺疊／室內／開局畫面時完全停止重繪。
 * - 點擊／拖曳 minimap → `actions.focusTile(tx, ty)`；「全圖」→ `actions.fitMap()`；
 *   「市中心」→ focusTile(spawn)；分區色塊 toggle → `actions.toggleZones()`。
 * - 鏡頭視野框：優先用 `CityView.getCameraInfo()`（Lead 提供），否則 runtime fallback。
 * - 桌面右下浮動可摺疊；手機縮成 152px 可摺疊小地圖（預設收起）。
 */

import { BUILDINGS, CATEGORY_INFO, TILE_SIZE, ZONES } from '../core/config';
import { getUiMode } from '../core/device';
import type { GameActions, GameState, TerrainType, ZoneType } from '../core/types';
import type { GameStore } from '../core/store';
import { clamp, delegate, num, qs, setClass, setText } from './dom';
import { ico } from './icons';

export interface MinimapView {
  update(state: GameState): void;
  destroy(): void;
}

/** 小地圖地形配色（比 3D 鮮明，方便辨識水域／陸地） */
const TERRAIN_MM: Record<TerrainType, [number, number, number]> = {
  water: [18, 58, 88],
  sand: [176, 158, 116],
  mountain: [74, 70, 62],
  hill: [112, 108, 76],
  forest: [44, 78, 52],
  grass: [62, 96, 66],
  fertile: [108, 118, 58],
  wetland: [58, 84, 76],
  urban: [70, 76, 88],
  reclaimed: [82, 88, 80],
};

const ROAD_RGB: [number, number, number] = [226, 219, 200];
/** CSDI 建築物輪廓密度：把已建成市區微微提亮（真實城市紋理） */
const DENSITY_RGB: [number, number, number] = [216, 208, 188];

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16) || 0,
    parseInt(value.slice(2, 4), 16) || 0,
    parseInt(value.slice(4, 6), 16) || 0,
  ];
}

const ZONE_RGB: Record<ZoneType, [number, number, number]> = {
  residential: hexToRgb(ZONES.residential.colorHex),
  commercial: hexToRgb(ZONES.commercial.colorHex),
  industrial: hexToRgb(ZONES.industrial.colorHex),
  farmland: hexToRgb(ZONES.farmland.colorHex),
};

/** 兩個 RGB 按 alpha 混合後回傳 ABGR（canvas ImageData little-endian） */
function blendRgb(dst: number, src: [number, number, number], alpha: number): number {
  const dr = dst & 0xff;
  const dg = (dst >> 8) & 0xff;
  const db = (dst >> 16) & 0xff;
  const r = Math.round(dr * (1 - alpha) + src[0] * alpha);
  const g = Math.round(dg * (1 - alpha) + src[1] * alpha);
  const b = Math.round(db * (1 - alpha) + src[2] * alpha);
  return (0xff << 24) | (b << 16) | (g << 8) | r;
}

function rgbToAbgr(rgb: [number, number, number]): number {
  return (0xff << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0];
}

const ROAD_ABGR = rgbToAbgr(ROAD_RGB);

interface ViewInfo {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

interface ViewLike {
  getCameraInfo?: () => { cx: number; cy: number; radius: number; aspect?: number } | null;
  target?: { x: number; z: number };
  distance?: number;
  pitch?: number;
  cityCamera?: { aspect?: number };
}

const FOV_RAD = (46 * Math.PI) / 180;

/** 讀取目前鏡頭中心（格座標）與概略視野半徑（格） */
function readViewInfo(state: GameState): ViewInfo | null {
  const view = (window as unknown as { __HK_CITY__?: { view?: ViewLike } }).__HK_CITY__?.view;
  if (!view) return null;
  const tile = TILE_SIZE;

  let cx = 0;
  let cy = 0;
  let radius = 0;
  let aspect = 1.7;

  const direct = typeof view.getCameraInfo === 'function' ? view.getCameraInfo() : null;
  if (direct && Number.isFinite(direct.cx) && Number.isFinite(direct.cy)) {
    cx = direct.cx;
    cy = direct.cy;
    radius = direct.radius;
    aspect = direct.aspect ?? window.innerWidth / Math.max(1, window.innerHeight);
  } else if (view.target && typeof view.distance === 'number') {
    cx = (view.target.x + (state.width * tile) / 2) / tile;
    cy = (view.target.z + (state.height * tile) / 2) / tile;
    const sinPitch = Math.max(0.35, Math.sin(view.pitch ?? 0.95));
    radius = (view.distance * Math.tan(FOV_RAD / 2)) / sinPitch / tile;
    aspect = view.cityCamera?.aspect ?? window.innerWidth / Math.max(1, window.innerHeight);
  } else {
    return null;
  }

  const ry = Math.max(3, Math.min(900, radius));
  const rx = Math.max(3, Math.min(1400, ry * Math.max(1, Math.min(2.6, aspect))));
  return { cx, cy, rx, ry };
}

export function createMinimap(container: HTMLElement, store: GameStore, actions: GameActions): MinimapView {
  const mobile = getUiMode() === 'mobile';
  const root = document.createElement('aside');
  root.className = `minimap${mobile ? ' is-mobile-mini collapsed' : ''}`;
  root.innerHTML = `
    <header class="mm-head">
      <span class="mm-title">${ico('map')}<b>地圖</b></span>
      <span class="mm-scale" data-k="mmScale">480×480</span>
      <button type="button" class="mm-collapse" data-act="mm-toggle" title="展開／收起小地圖" aria-label="展開或收起小地圖">${ico('chevronRight')}</button>
    </header>
    <div class="mm-body">
      <canvas class="mm-canvas" data-k="mmCanvas" width="480" height="480" aria-label="大地圖概覽"></canvas>
      <span class="mm-hint" data-k="mmHint">點擊／拖曳跳轉</span>
    </div>
    <div class="mm-tools">
      <button type="button" class="mm-btn" data-act="mm-fit" title="拉遠至全圖（O）">${ico('target')}<span>全圖</span><kbd>O</kbd></button>
      <button type="button" class="mm-btn" data-act="mm-center" title="返回市中心（P）">${ico('compass')}<span>市中心</span><kbd>P</kbd></button>
      <button type="button" class="mm-btn mm-zones" data-act="mm-zones" title="顯示／隱藏分區色塊（L）">${ico('layers')}<span>分區</span></button>
    </div>
  `;
  container.appendChild(root);

  const scaleEl = qs<HTMLElement>(root, '[data-k="mmScale"]')!;
  const hintEl = qs<HTMLElement>(root, '[data-k="mmHint"]')!;
  const canvas = qs<HTMLCanvasElement>(root, '[data-k="mmCanvas"]')!;
  const zoneBtn = qs<HTMLElement>(root, '.mm-zones')!;
  const collapseBtn = qs<HTMLElement>(root, '.mm-collapse')!;
  const ctx = canvas.getContext('2d');

  let expanded = !mobile;
  let baseCanvas: HTMLCanvasElement | null = null;
  let baseU32: Uint32Array | null = null;
  let baseKey = '';
  let contentCanvas: HTMLCanvasElement | null = null;
  let contentCtx: CanvasRenderingContext2D | null = null;
  let contentImage: ImageData | null = null;
  let contentU32: Uint32Array | null = null;
  let contentW = 0;
  let contentH = 0;
  let contentRevision = -1;
  let contentShowZones: boolean | null = null;
  let contentKey = '';
  let lastContentRebuild = -Infinity;
  let lastDraw = -Infinity;
  let dragging = false;
  let lastFocusAt = 0;

  /** 效能數據（測試／QA 可讀 window.__MINIMAP_PERF__） */
  const perf = { baseMs: 0, rebuildMs: 0, drawMs: 0, tiles: 0, revision: -1, contentAgeMs: 0 };

  const rebuildBase = (state: GameState): void => {
    const t0 = performance.now();
    const w = state.width;
    const h = state.height;
    if (!baseCanvas) baseCanvas = document.createElement('canvas');
    baseCanvas.width = w;
    baseCanvas.height = h;
    const bctx = baseCanvas.getContext('2d');
    if (!bctx) return;
    const img = bctx.createImageData(w, h);
    const u32 = new Uint32Array(img.data.buffer);
    for (let i = 0; i < state.tiles.length; i++) {
      const tile = state.tiles[i];
      const rgb = TERRAIN_MM[tile.terrain] ?? TERRAIN_MM.grass;
      // 海拔微調明暗，山脈更立體；水域保持暗藍
      const shade = tile.terrain === 'water' ? 1 : 0.86 + tile.elevation * 0.36;
      let r = Math.min(255, Math.round(rgb[0] * shade));
      let g = Math.min(255, Math.round(rgb[1] * shade));
      let b = Math.min(255, Math.round(rgb[2] * shade));
      // CSDI 建築物輪廓密度：真實市區微微提亮，形成城市紋理
      const density = tile.density ?? 0;
      if (density > 0 && tile.terrain !== 'water') {
        const k = Math.min(0.5, (density / 255) * 0.5);
        r = Math.min(255, Math.round(r * (1 - k) + DENSITY_RGB[0] * k));
        g = Math.min(255, Math.round(g * (1 - k) + DENSITY_RGB[1] * k));
        b = Math.min(255, Math.round(b * (1 - k) + DENSITY_RGB[2] * k));
      }
      u32[i] = (0xff << 24) | (b << 16) | (g << 8) | r;
    }
    bctx.putImageData(img, 0, 0);
    baseU32 = u32;
    baseKey = `${state.seed}|${w}|${h}`;
    perf.baseMs = performance.now() - t0;
    perf.tiles = state.tiles.length;
  };

  /** 道路／分區 overlay 合併到內容層（只在 revision／showZones 變更時重建；重用 buffer） */
  const rebuildContent = (state: GameState): void => {
    if (!baseU32) return;
    const t0 = performance.now();
    const w = state.width;
    const h = state.height;
    if (!contentCanvas) {
      contentCanvas = document.createElement('canvas');
      contentCtx = contentCanvas.getContext('2d');
    }
    if (!contentCtx) return;
    if (contentCanvas.width !== w || contentCanvas.height !== h) {
      contentCanvas.width = w;
      contentCanvas.height = h;
      contentImage = null;
    }
    if (!contentImage || contentW !== w || contentH !== h) {
      contentImage = contentCtx.createImageData(w, h);
      contentU32 = new Uint32Array(contentImage.data.buffer);
      contentW = w;
      contentH = h;
    }
    const out = contentU32!;
    out.set(baseU32);

    const zoneAlpha = state.ui.showZones ? 0.58 : 0.24;
    const tiles = state.tiles;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      if (tile.road) {
        // 2×2 backing pixels：480 大地圖縮到 172px 顯示時仍可見
        const x = i % w;
        const y = (i / w) | 0;
        out[i] = ROAD_ABGR;
        if (x + 1 < w) out[i + 1] = ROAD_ABGR;
        if (y + 1 < h) {
          out[i + w] = ROAD_ABGR;
          if (x + 1 < w) out[i + w + 1] = ROAD_ABGR;
        }
      } else {
        const zone = tile.zone;
        if (zone) out[i] = blendRgb(out[i], ZONE_RGB[zone], zoneAlpha);
      }
    }
    contentCtx.putImageData(contentImage, 0, 0);
    contentRevision = state.ui.revision;
    contentShowZones = state.ui.showZones;
    contentKey = baseKey;
    lastContentRebuild = performance.now();
    perf.rebuildMs = performance.now() - t0;
    perf.revision = state.ui.revision;
  };

  const draw = (state: GameState): void => {
    if (!ctx) return;
    const t0 = performance.now();
    const w = state.width;
    const h = state.height;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    if (contentCanvas) ctx.drawImage(contentCanvas, 0, 0);

    // 建築點：自動開發用分區色、手動 ploppable 用分類色（最小 2px 可見）
    for (const building of state.buildings) {
      const def = BUILDINGS[building.key];
      const zone = building.zone ?? def?.zone;
      const color = zone
        ? ZONES[zone]?.colorHex ?? '#24e0ff'
        : def
          ? CATEGORY_INFO[def.category]?.color ?? '#ffd166'
          : '#ffd166';
      ctx.fillStyle = color;
      ctx.fillRect(building.x, building.y, Math.max(2, building.w), Math.max(2, building.h));
      if (!zone) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(building.x, building.y, 2, 2);
      }
    }

    // 城市中心（spawn）
    const sx = clamp(Math.round(state.spawn.x), 0, w - 1);
    const sy = clamp(Math.round(state.spawn.y), 0, h - 1);
    const spawnR = Math.max(3, w * 0.0075);
    ctx.save();
    ctx.shadowColor = '#ff3d7f';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#ff3d7f';
    ctx.beginPath();
    ctx.arc(sx + 0.5, sy + 0.5, spawnR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx + 0.5, sy + 0.5, spawnR * 0.45, 0, Math.PI * 2);
    ctx.stroke();

    // 鏡頭視野框
    const view = readViewInfo(state);
    if (view) {
      const x1 = clamp(view.cx - view.rx, 0, w);
      const y1 = clamp(view.cy - view.ry, 0, h);
      const x2 = clamp(view.cx + view.rx, 0, w);
      const y2 = clamp(view.cy + view.ry, 0, h);
      const fw = Math.max(3, x2 - x1);
      const fh = Math.max(3, y2 - y1);
      ctx.strokeStyle = 'rgba(36,224,255,0.95)';
      ctx.lineWidth = 3;
      ctx.strokeRect(x1 + 1.5, y1 + 1.5, fw - 3, fh - 3);
      if (fw > 16 && fh > 16) {
        ctx.fillStyle = 'rgba(36,224,255,0.9)';
        ctx.fillRect(clamp(Math.round(view.cx) - 2, x1 + 2, x2 - 4), clamp(Math.round(view.cy) - 2, y1 + 2, y2 - 4), 4, 4);
      }
    }

    perf.drawMs = performance.now() - t0;
    perf.contentAgeMs = Math.round(performance.now() - lastContentRebuild);
    (window as unknown as { __MINIMAP_PERF__?: typeof perf }).__MINIMAP_PERF__ = { ...perf };
  };

  const setExpanded = (next: boolean): void => {
    expanded = next;
    root.classList.toggle('collapsed', !expanded);
    setClass(collapseBtn, 'expanded', expanded);
    if (expanded) lastDraw = -Infinity;
  };

  const jumpTo = (event: PointerEvent): void => {
    const state = store.state;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const tx = clamp(Math.floor(((event.clientX - rect.left) / rect.width) * state.width), 0, state.width - 1);
    const ty = clamp(Math.floor(((event.clientY - rect.top) / rect.height) * state.height), 0, state.height - 1);
    actions.focusTile(tx, ty);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    lastFocusAt = performance.now();
    try {
      canvas.setPointerCapture?.(event.pointerId);
    } catch {
      /* 合成事件／部分瀏覽器沒有 active pointer，可忽略 */
    }
    jumpTo(event);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;
    const now = performance.now();
    if (now - lastFocusAt < 80) return;
    lastFocusAt = now;
    jumpTo(event);
  };
  const onPointerUp = (event: PointerEvent): void => {
    dragging = false;
    try {
      if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onPointerLeave = (): void => {
    dragging = false;
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);

  const offClick = delegate(root, 'click', '[data-act]', (node) => {
    switch (node.dataset.act) {
      case 'mm-toggle':
        setExpanded(!expanded);
        break;
      case 'mm-fit':
        actions.fitMap();
        break;
      case 'mm-center': {
        const spawn = store.state.spawn;
        actions.focusTile(spawn.x, spawn.y);
        break;
      }
      case 'mm-zones':
        actions.toggleZones();
        break;
      default:
        break;
    }
  });

  const update = (state: GameState): void => {
    // 室內／開局畫面：完全停止繪製
    if (state.ui.mode === 'interior' || state.ui.showStartScreen) {
      if (!root.hidden) root.hidden = true;
      return;
    }
    if (root.hidden) root.hidden = false;

    setClass(zoneBtn, 'active', state.ui.showZones);

    if (!expanded) return;
    const now = performance.now();
    if (now - lastDraw < 250) return;
    lastDraw = now;

    const key = `${state.seed}|${state.width}|${state.height}`;
    if (!baseCanvas || key !== baseKey) {
      rebuildBase(state);
      contentRevision = -1;
      lastContentRebuild = -Infinity;
    }
    const zonesChanged = contentShowZones !== state.ui.showZones;
    const contentStale =
      !contentCanvas ||
      contentRevision !== state.ui.revision ||
      zonesChanged ||
      contentKey !== baseKey;
    // 230k overlay 重建約 3–5ms：revision 連續變更（劃區）時最多 2 次/秒；
    // 分區色塊 toggle 則即時重建。
    if (contentStale && (zonesChanged || now - lastContentRebuild >= 500)) {
      rebuildContent(state);
    }
    draw(state);

    setText(scaleEl, `${state.width}×${state.height}`);
    scaleEl.title = `地圖 ${state.width}×${state.height} · ${num(state.width * state.height)} 格`;
    setText(hintEl, '點擊／拖曳跳轉');
  };

  lastDraw = -Infinity;

  return {
    update,
    destroy(): void {
      offClick();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      root.remove();
    },
  };
}
