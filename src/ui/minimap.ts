/**
 * 大地圖 Minimap（304×304）。
 *
 * - Canvas 2D 概覽：水域／陸地底色（offscreen 快取，只在地圖 seed／尺寸變更時重建）、
 *   道路、四色分區（半透明）、建築點、城市（spawn）位置、目前鏡頭視野框。
 * - 點擊／拖曳 minimap → `actions.focusTile(tx, ty)`；「全圖」→ `actions.fitMap()`；
 *   「市中心」→ focusTile(spawn)；分區色塊 toggle → `actions.toggleZones()`。
 * - 每 ~250ms 或地圖狀態變更才重畫，避免每幀全畫 92,000 格。
 * - 桌面右下浮動可摺疊；手機縮成 132px 可摺疊小地圖（預設收起）。
 *
 * 鏡頭視野框：優先呼叫 `window.__HK_CITY__.view.getCameraInfo()`（若 Lead 提供）；
 * 否則唯讀 runtime fallback（target / distance / pitch / cityCamera.aspect）；
 * 兩者皆無時只畫地圖內容，不畫視野框。
 */

import { BUILDINGS, CATEGORY_INFO, TILE_SIZE, ZONES } from '../core/config';
import { getUiMode } from '../core/device';
import type { GameActions, GameState, TerrainType } from '../core/types';
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

  const ry = Math.max(3, Math.min(600, radius));
  const rx = Math.max(3, Math.min(900, ry * Math.max(1, Math.min(2.6, aspect))));
  return { cx, cy, rx, ry };
}

export function createMinimap(container: HTMLElement, store: GameStore, actions: GameActions): MinimapView {
  const mobile = getUiMode() === 'mobile';
  const root = document.createElement('aside');
  root.className = `minimap${mobile ? ' is-mobile-mini collapsed' : ''}`;
  root.innerHTML = `
    <header class="mm-head">
      <span class="mm-title">${ico('map')}<b>地圖</b></span>
      <span class="mm-scale" data-k="mmScale">304×304</span>
      <button type="button" class="mm-collapse" data-act="mm-toggle" title="展開／收起小地圖" aria-label="展開或收起小地圖">${ico('chevronRight')}</button>
    </header>
    <div class="mm-body">
      <canvas class="mm-canvas" data-k="mmCanvas" width="304" height="304" aria-label="大地圖概覽"></canvas>
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
  let baseKey = '';
  let lastDraw = -Infinity;
  let dragging = false;
  let lastFocusAt = 0;

  const rebuildBase = (state: GameState): void => {
    const w = state.width;
    const h = state.height;
    if (!baseCanvas) baseCanvas = document.createElement('canvas');
    baseCanvas.width = w;
    baseCanvas.height = h;
    const bctx = baseCanvas.getContext('2d');
    if (!bctx) return;
    const img = bctx.createImageData(w, h);
    const data = img.data;
    for (let i = 0; i < state.tiles.length; i++) {
      const tile = state.tiles[i];
      const rgb = TERRAIN_MM[tile.terrain] ?? TERRAIN_MM.grass;
      // 海拔微調明暗，山脈更立體；水域保持暗藍
      const shade = tile.terrain === 'water' ? 1 : 0.86 + tile.elevation * 0.36;
      const o = i * 4;
      data[o] = Math.min(255, Math.round(rgb[0] * shade));
      data[o + 1] = Math.min(255, Math.round(rgb[1] * shade));
      data[o + 2] = Math.min(255, Math.round(rgb[2] * shade));
      data[o + 3] = 255;
    }
    bctx.putImageData(img, 0, 0);
    baseKey = `${state.seed}|${w}|${h}`;
  };

  const draw = (state: GameState): void => {
    if (!ctx) return;
    const w = state.width;
    const h = state.height;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    if (baseCanvas) ctx.drawImage(baseCanvas, 0, 0);

    // 分區四色（半透明；3D 分區色塊關閉時轉暗，方便仍可導航）
    ctx.globalAlpha = state.ui.showZones ? 0.58 : 0.24;
    for (let i = 0; i < state.tiles.length; i++) {
      const zone = state.tiles[i].zone;
      if (!zone) continue;
      ctx.fillStyle = ZONES[zone]?.colorHex ?? '#24e0ff';
      ctx.fillRect(i % w, Math.floor(i / w), 1, 1);
    }
    ctx.globalAlpha = 1;

    // 道路（淺灰）
    ctx.fillStyle = '#ded7c4';
    ctx.globalAlpha = 0.92;
    for (let i = 0; i < state.tiles.length; i++) {
      if (!state.tiles[i].road) continue;
      ctx.fillRect(i % w, Math.floor(i / w), 1, 1);
    }
    ctx.globalAlpha = 1;

    // 建築點：自動開發用分區色、手動 ploppable 用分類色
    for (const building of state.buildings) {
      const def = BUILDINGS[building.key];
      const zone = building.zone ?? def?.zone;
      const color = zone
        ? ZONES[zone]?.colorHex ?? '#24e0ff'
        : def
          ? CATEGORY_INFO[def.category]?.color ?? '#ffd166'
          : '#ffd166';
      ctx.fillStyle = color;
      ctx.fillRect(building.x, building.y, Math.max(1, building.w), Math.max(1, building.h));
      if (!zone) {
        // 公共建築加白點，方便在密集市區中辨認
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(building.x, building.y, 1, 1);
      }
    }

    // 城市中心（spawn）
    const sx = clamp(Math.round(state.spawn.x), 0, w - 1);
    const sy = clamp(Math.round(state.spawn.y), 0, h - 1);
    ctx.save();
    ctx.shadowColor = '#ff3d7f';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#ff3d7f';
    ctx.beginPath();
    ctx.arc(sx + 0.5, sy + 0.5, Math.max(2.2, w / 152), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(sx + 0.5, sy + 0.5, Math.max(1, w / 300), 0, Math.PI * 2);
    ctx.stroke();

    // 鏡頭視野框
    const view = readViewInfo(state);
    if (view) {
      const x1 = clamp(view.cx - view.rx, 0, w);
      const y1 = clamp(view.cy - view.ry, 0, h);
      const x2 = clamp(view.cx + view.rx, 0, w);
      const y2 = clamp(view.cy + view.ry, 0, h);
      const fw = Math.max(2, x2 - x1);
      const fh = Math.max(2, y2 - y1);
      ctx.strokeStyle = 'rgba(36,224,255,0.95)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x1 + 1, y1 + 1, fw - 2, fh - 2);
      // 鏡頭中心點
      if (fw > 12 && fh > 12) {
        ctx.fillStyle = 'rgba(36,224,255,0.9)';
        ctx.fillRect(clamp(Math.round(view.cx) - 1, x1 + 2, x2 - 3), clamp(Math.round(view.cy) - 1, y1 + 2, y2 - 3), 2, 2);
      }
    }
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

  // 收起時也保持拖曳狀態一致
  const update = (state: GameState): void => {
    // 3D 室內模式隱藏小地圖（CSS 亦已處理）
    if (state.ui.mode === 'interior') {
      if (!root.hidden) root.hidden = true;
      return;
    }
    if (root.hidden) root.hidden = false;

    // 按鈕 active 狀態（收起時亦可更新）
    setClass(zoneBtn, 'active', state.ui.showZones);

    if (!expanded) return;
    const now = performance.now();
    if (now - lastDraw < 250) return;
    lastDraw = now;

    const key = `${state.seed}|${state.width}|${state.height}`;
    if (!baseCanvas || key !== baseKey) rebuildBase(state);
    draw(state);
    setText(scaleEl, `${state.width}×${state.height}`);
    scaleEl.title = `地圖 ${state.width}×${state.height} · ${num(state.width * state.height)} 格`;
    setText(hintEl, '點擊／拖曳跳轉');
  };

  // 展開時立即畫一次
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
