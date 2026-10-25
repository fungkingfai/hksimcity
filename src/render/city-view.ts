/**
 * 城市視圖：three.js 場景、鏡頭控制、滑鼠／鍵盤互動、室內模式切換。
 *
 * 本檔由 Lead 維護（整合層）。各渲染模組只負責自己的 group：
 *   terrain / roads / buildings / citizens / environment / interior
 */

import * as THREE from 'three';
import { BUILDINGS, MAP_SCALE, ROAD_COST, TERRAIN_INFO, ZONES, zoneOfTool } from '../core/config';
import { isMobileUi } from '../core/device';
import type { GameActions, GameState, RoadGrade } from '../core/types';
import type { FocusPayload, GameStore as Store } from '../core/store';
import { buildingAnchor, TILE, tileWorld, worldToTileIndex } from './coords';
import { createTerrainView, type TerrainView } from './terrain';
import { createRoadsView, type RoadsView } from './roads';
import { createBuildingsView, type BuildingsView } from './buildings';
import { createCitizensView, type CitizensView } from './citizens';
import { createVehiclesView, type VehiclesView } from './vehicles';
import { createEnvironmentView, type EnvironmentView } from './environment';
import { createZonesView, type ZonesView } from './zones';
import { createUndergroundView, type UndergroundView } from './underground';
import { createTransitOverlayView, type TransitOverlayView } from './transit-overlay';
import { createRailView, type RailView } from './rail';
import { createInteriorView, type InteriorView } from './interior';
import { canPlaceBuilding, roadPathBetween } from '../sim/placement';
import { createShenzhenOverlayView, type ShenzhenOverlayView } from './shenzhen-overlay';
import { isShenzhenSideTile } from '../world/border';
import { canPlaceRail, railToolGrade } from '../sim/rail';

export interface CityViewOptions {
  container: HTMLElement;
  store: Store;
  actions: GameActions;
}

const MIN_DISTANCE = 16;
/** 304×304 大地圖：zoom out 上限與 far plane 按 MAP_SCALE 放大 */
const MAX_DISTANCE = 260 * MAP_SCALE;
const MIN_PITCH = 0.32;
const MAX_PITCH = 1.35;


/** 偵測是否軟件 WebGL（SwiftShader／llvmpipe）或無頭環境，決定輕量模式 */
function detectLiteMode(renderer: THREE.WebGLRenderer): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const forced = params.get('lite');
    if (forced === '1') return true;
    if (forced === '0') return false;
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '') : '';
    if (/swiftshader|llvmpipe|softpipe|software/i.test(name)) return true;
    if (typeof navigator !== 'undefined' && (navigator as Navigator & { webdriver?: boolean }).webdriver) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export class CityView {
  private store: Store;
  private actions: GameActions;
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private canvas: HTMLCanvasElement;
  private cityScene!: THREE.Scene;
  private cityCamera: THREE.PerspectiveCamera;
  private interior: InteriorView | null = null;

  private terrain!: TerrainView;
  private roads!: RoadsView;
  private buildings!: BuildingsView;
  private citizens!: CitizensView;
  private vehicles!: VehiclesView;
  private environment!: EnvironmentView;
  private zones!: ZonesView;
  private underground!: UndergroundView;
  private transitOverlay!: TransitOverlayView;
  private rail!: RailView;
  private shenzhenOverlay!: ShenzhenOverlayView;
  /** #11：道路拖曳預覽（L 形路徑） */
  private roadDrag: { start: number; grade: RoadGrade } | null = null;
  private lastRoadPreviewSig = '';
  private roadPreview!: THREE.InstancedMesh;
  private roadPreviewMat!: THREE.MeshBasicMaterial;
  private roadPreviewGeo!: THREE.PlaneGeometry;

  private target = new THREE.Vector3(0, 0, 0);
  private yaw = -Math.PI / 4;
  private pitch = 0.85;
  private distance = 90;
  /** 軟件 WebGL／低階裝置的輕量渲染模式 */
  private liteMode = false;

  private hover = -1;
  private hoverMesh!: THREE.Mesh;
  private selectionRing!: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.3);

  private pointer = new THREE.Vector2();
  private dragging = false;
  private dragButton = -1;
  private dragStart = new THREE.Vector2();
  private dragLast = new THREE.Vector2();
  private dragDistance = 0;
  private lastPaintTile = -1;

  // ── 手機觸控手勢（僅手機 UI 使用；電腦路徑完全不受影響） ──
  private touchUi = false;
  private touchPointers = new Map<number, { x: number; y: number }>();
  private touchStart = { x: 0, y: 0, t: 0 };
  private touchDragLast = new THREE.Vector2();
  private touchMoved = false;
  private touchHadPinch = false;
  private pinch: { distance: number; angle: number; centerX: number; centerY: number } | null = null;
  private lastTouchAt = 0;
  private lastTapAt = 0;
  private lastTapPos = new THREE.Vector2();

  private keys = new Set<string>();
  private resizeObserver: ResizeObserver;
  private lastTime = performance.now();
  private disposed = false;

  constructor(opts: CityViewOptions) {
    this.store = opts.store;
    this.actions = opts.actions;
    this.container = opts.container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // 效能分級：軟件 WebGL（無頭測試／超低階裝置）自動用「輕量模式」，
    // 關閉陰影、降低渲染解析度，讓無 GPU 環境仍可流暢操作／截圖。
    // 可用 ?lite=1 / ?lite=0 強制開關。
    this.liteMode = detectLiteMode(this.renderer);
    this.renderer.setPixelRatio(this.liteMode ? 0.4 : Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = !this.liteMode;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    (window as unknown as Record<string, unknown>).__HK_LITE__ = this.liteMode;
    this.renderer.domElement.id = 'game-canvas';
    this.container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.cityCamera = new THREE.PerspectiveCamera(46, 1, 0.1, 600 * MAP_SCALE);
    this.touchUi = isMobileUi();
    if (this.touchUi) {
      // 手機：鏡頭稍遠、俯視角稍高，方便看到整個城市
      this.distance = 110;
      this.pitch = 0.9;
      // 手機 GPU 效能有限：限制渲染解析度（輕量模式已用更低解析度）
      if (!this.liteMode) this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    }
    this.rebuild(this.store.state);
    this.resize();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);

    this.bindEvents();
    this.applyCamera();
  }

  /** 鏡頭飛到指定格 */
  focusTile(tx: number, ty: number): void {
    const state = this.store.state;
    const { x, z } = tileWorld(
      Math.max(0, Math.min(state.width - 1, Math.round(tx))),
      Math.max(0, Math.min(state.height - 1, Math.round(ty))),
      state.width,
      state.height,
    );
    this.target.set(x, 0, z);
    this.distance = Math.min(this.distance, 90);
    this.pitch = Math.max(this.pitch, 0.78);
  }

  /** UI minimap 用：鏡頭中心（格座標）＋概略視野半徑（格） */
  getCameraInfo(): { cx: number; cy: number; radius: number; aspect: number } {
    const state = this.store.state;
    const T = 2;
    const cx = (this.target.x + (state.width * T) / 2) / T;
    const cy = (this.target.z + (state.height * T) / 2) / T;
    const sinP = Math.max(0.35, Math.sin(this.pitch));
    const radius = (this.distance * Math.tan((46 * Math.PI) / 180 / 2)) / sinP / T;
    return { cx, cy, radius, aspect: this.cityCamera.aspect };
  }

  /** 拉遠至全圖 overview（304×304 大地圖用） */
  fitMap(): void {
    const state = this.store.state;
    this.target.set(0, 0, 0);
    this.distance = MAX_DISTANCE * 0.92;
    this.pitch = Math.min(1.32, Math.max(1.12, this.pitch));
    this.yaw = -Math.PI / 4;
  }

  // ───────────────────────── 場景重建 ─────────────────────────

  rebuild(state: GameState): void {
    if (this.terrain) this.terrain.dispose();
    if (this.roads) this.roads.dispose();
    if (this.buildings) this.buildings.dispose();
    if (this.citizens) this.citizens.dispose();
    if (this.vehicles) this.vehicles.dispose();
    if (this.environment) this.environment.dispose();
    if (this.zones) this.zones.dispose();
    if (this.underground) this.underground.dispose();
    if (this.transitOverlay) this.transitOverlay.dispose();
    if (this.rail) this.rail.dispose();
    if (this.shenzhenOverlay) this.shenzhenOverlay.dispose();
    if (this.interior) {
      this.interior.dispose();
      this.interior = null;
    }

    this.cityScene = new THREE.Scene();
    this.environment = createEnvironmentView(this.cityScene, state);
    this.terrain = createTerrainView(state);
    this.roads = createRoadsView(state);
    this.buildings = createBuildingsView(state);
    this.citizens = createCitizensView(state);
    this.vehicles = createVehiclesView(state);
    this.zones = createZonesView(state);
    this.underground = createUndergroundView(state);
    this.transitOverlay = createTransitOverlayView(state);
    this.rail = createRailView(state);
    this.shenzhenOverlay = createShenzhenOverlayView(state);
    this.cityScene.add(
      this.terrain.group,
      this.roads.group,
      this.buildings.group,
      this.vehicles.group,
      this.zones.group,
      this.citizens.group,
      this.underground.group,
      this.transitOverlay.group,
      this.rail.group,
      this.shenzhenOverlay.group,
    );

    // 輕量模式：隱藏細小花草／碎石等裝飾 InstancedMesh，降低 fill-rate 負擔
    if (this.liteMode) {
      const hideNames = new Set([
        'terrain-grass',
        'terrain-flower',
        'terrain-shrub',
        'terrain-reed',
        'terrain-rock',
        'terrain-crag',
      ]);
      this.terrain.group.traverse((obj) => {
        if (hideNames.has(obj.name)) obj.visible = false;
      });
    }

    // 手機：降低陰影貼圖解析度，節省 GPU（視覺差異在手機上不明顯）
    if (this.touchUi) {
      this.cityScene.traverse((obj) => {
        const light = obj as THREE.DirectionalLight;
        if (light.isDirectionalLight && light.castShadow) {
          light.shadow.mapSize.set(1024, 1024);
        }
      });
    }

    // 懸停格高亮
    const hoverGeo = new THREE.PlaneGeometry(TILE * 0.96, TILE * 0.96);
    const hoverMat = new THREE.MeshBasicMaterial({ color: 0xfff3d0, transparent: true, opacity: 0.22, depthWrite: false });
    this.hoverMesh = new THREE.Mesh(hoverGeo, hoverMat);
    this.hoverMesh.rotation.x = -Math.PI / 2;
    this.hoverMesh.position.y = 0.42;
    this.hoverMesh.visible = false;
    this.cityScene.add(this.hoverMesh);

    // #11：道路拉線 L 路徑預覽（單一 InstancedMesh；最多 1 draw）
    const previewGeo = new THREE.PlaneGeometry(TILE * 0.94, TILE * 0.94);
    previewGeo.rotateX(-Math.PI / 2);
    const previewMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.roadPreviewGeo = previewGeo;
    this.roadPreviewMat = previewMat;
    this.roadPreview = new THREE.InstancedMesh(previewGeo, previewMat, 1300);
    this.roadPreview.name = 'road-path-preview';
    this.roadPreview.count = 0;
    this.roadPreview.visible = false;
    this.roadPreview.frustumCulled = false;
    this.roadPreview.renderOrder = 6;
    this.cityScene.add(this.roadPreview);
    this.roadDrag = null;

    // 選取建築光環
    const ringGeo = new THREE.RingGeometry(0.82, 1, 40);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xf3c969, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
    this.selectionRing = new THREE.Mesh(ringGeo, ringMat);
    this.selectionRing.rotation.x = -Math.PI / 2;
    this.selectionRing.visible = false;
    this.cityScene.add(this.selectionRing);

    // 鏡頭初始對準世界生成建議的市中心（例如中環／旺角）
    const spawn = state.spawn ?? { x: Math.floor(state.width / 2), y: Math.floor(state.height / 2) };
    const spawnWorld = tileWorld(spawn.x, spawn.y, state.width, state.height);
    this.target.set(spawnWorld.x, 0, spawnWorld.z);
    this.hover = -1;
  }

  // ───────────────────────── 主迴圈 ─────────────────────────

  /** 即時設定建築圖層可見性（UI toggle 用；唔使等下一 frame） */
  setBuildingsVisible(visible: boolean): void {
    this.buildings.group.visible = visible;
  }

  frame(): void {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const state = this.store.state;

    this.updateKeyboardPan(dt);
    this.applyCamera();

    this.environment.update(state, dt, this.activeCamera());
    this.terrain.update(state, dt);
    this.roads.update(state, dt);
    this.buildings.group.visible = state.ui.showBuildings !== false;
    this.buildings.update(state, dt, this.activeCamera(), this.distance);
    this.shenzhenOverlay.update(state, dt, this.hover);
    this.vehicles.update(state, dt);
    this.zones.update(state, dt);
    this.underground.update(state, dt);
    this.transitOverlay.update(state, dt);
    this.rail.update(state, dt);
    this.citizens.update(state, dt);
    this.updateGhostAndHighlights(state);

    if (state.ui.mode === 'interior' && this.interior) {
      this.interior.update(state, dt);
      this.renderer.render(this.interior.scene, this.interior.camera);
    } else {
      this.renderer.render(this.cityScene, this.cityCamera);
    }
  }

  private activeCamera(): THREE.Camera {
    return this.interior && this.store.state.ui.mode === 'interior' ? this.interior.camera : this.cityCamera;
  }

  private applyCamera(): void {
    const cp = Math.cos(this.pitch);
    this.cityCamera.position.set(
      this.target.x + this.distance * cp * Math.sin(this.yaw),
      this.target.y + this.distance * Math.sin(this.pitch),
      this.target.z + this.distance * cp * Math.cos(this.yaw),
    );
    this.cityCamera.lookAt(this.target);
  }

  private updateGhostAndHighlights(state: GameState): void {
    const tool = state.ui.tool;
    const inCity = state.ui.mode === 'city';
    const railGrade = railToolGrade(tool);
    // rail:* 工具：用 canPlaceRail 決定綠色／紅色 ghost（唔用 BUILDINGS[tool]）
    let railValid: boolean | null = null;
    if (railGrade && this.hover >= 0) {
      const hx = this.hover % state.width;
      const hy = Math.floor(this.hover / state.width);
      railValid = canPlaceRail(state, hx, hy, railGrade).ok;
    }
    // 依工具改變 hover 顏色：分區刷子顯示對應分區色、拆卸/取消分區紅色
    const hoverMat = this.hoverMesh?.material as THREE.MeshBasicMaterial | undefined;
    if (hoverMat) {
      const zone = zoneOfTool(tool);
      if (railGrade) hoverMat.color.setHex(railValid ? 0x7fd6a0 : 0xd46060);
      else if (zone) hoverMat.color.setHex(ZONES[zone].color);
      else if (tool === 'dezone' || tool === 'demolish') hoverMat.color.setHex(0xff5a5a);
      else hoverMat.color.setHex(0xfff3d0);
      hoverMat.opacity = zone ? 0.35 : railGrade ? 0.42 : 0.22;
    }
    this.hoverMesh.visible = inCity && this.hover >= 0;
    if (this.hover >= 0 && inCity) {
      const { x, z } = tileWorld(this.hover % state.width, Math.floor(this.hover / state.width), state.width, state.height);
      this.hoverMesh.position.set(x, 0.42, z);
    }

    // 選取光環
    const selected = state.ui.selectedId != null ? state.buildings.find((b) => b.id === state.ui.selectedId) : null;
    this.selectionRing.visible = inCity && !!selected;
    if (selected) {
      const cx = (selected.x + selected.w / 2) * TILE - (state.width * TILE) / 2;
      const cz = (selected.y + selected.h / 2) * TILE - (state.height * TILE) / 2;
      this.selectionRing.position.set(cx, 0.44, cz);
      const scale = Math.max(selected.w, selected.h) * TILE * 0.72;
      this.selectionRing.scale.setScalar(scale);
    }

    // #11：道路拖曳預覽（M／N 改 grade 或 hover 移動時更新）
    if (this.roadDrag) {
      const grade = state.ui.roadGrade ?? this.roadDrag.grade;
      const sig = `${this.roadDrag.start}|${this.hover}|${grade}`;
      if (sig !== this.lastRoadPreviewSig) {
        this.lastRoadPreviewSig = sig;
        this.updateRoadPreview(state, this.hover);
      }
    }

    // 建造幽靈
    const valid = railGrade ? (railValid ?? false) : tool ? this.isToolValidAt(state, this.hover) : false;
    this.buildings.setPreview(state, inCity ? tool : null, this.hover, valid);
    // rail 工具：hoverMesh 已作綠／紅 ghost；再顯示一盞細 pad 令 hover 更清楚
    // （hoverMesh 本身係半透明平面，足夠顯示單格；唔另加 geometry）
  }

  private isToolValidAt(state: GameState, tileIndex: number): boolean {
    if (tileIndex < 0) return false;
    const tool = state.ui.tool;
    if (!tool) return false;
    const tile = state.tiles[tileIndex];
    const terrainInfo = TERRAIN_INFO[tile.terrain];
    if (tool === 'demolish') return tile.buildingId >= 0 || tile.road || !!tile.sidewalk;
    if (tool === 'road') {
      return (
        !tile.road &&
        tile.buildingId < 0 &&
        !!terrainInfo?.buildable &&
        state.finance.treasury >= ROAD_COST
      );
    }
    if (tool === 'dezone') {
      return !!tile.zone;
    }
    const zone = zoneOfTool(tool);
    if (zone) {
      if (!terrainInfo?.buildable || tile.road || tile.buildingId >= 0) return false;
      if (tile.zone === zone) return false;
      if (state.finance.treasury < ZONES[zone].costPerTile) return false;
      if (zone === 'farmland' && tile.terrain !== 'fertile' && tile.terrain !== 'grass') return false;
      return true;
    }
    const def = BUILDINGS[tool];
    if (!def) return false;
    const anchor = buildingAnchor(state, tool, def.size[0], def.size[1], tileIndex % state.width, Math.floor(tileIndex / state.width));
    return canPlaceBuilding(state, tool, anchor.x, anchor.y).ok;
  }

  // ───────────────────────── 事件綁定 ─────────────────────────

  private bindEvents(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    this.canvas.addEventListener('pointermove', this.onPointerMove, { passive: false });
    this.canvas.addEventListener('pointerup', this.onPointerUp, { passive: false });
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('dblclick', this.onDoubleClick);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

    this.unsubs = [
      this.store.on('reset', () => {
        this.rebuild(this.store.state);
        this.lastTime = performance.now();
      }),
      this.store.on('enter', (payload) => {
        const id = typeof payload === 'number' ? payload : this.store.state.ui.interiorId;
        if (id != null) this.openInterior(id);
      }),
      this.store.on('exit', () => this.closeInterior()),
      this.store.on('focus', (payload) => {
        const p = payload as FocusPayload | undefined;
        if (!p) return;
        if (p.mode === 'map') this.fitMap();
        else this.focusTile(p.x, p.y);
      }),
    ];
  }

  private unsubs: (() => void)[] = [];

  private onPointerDown = (e: PointerEvent): void => {
    if (this.touchUi && e.pointerType === 'touch') {
      this.onTouchStart(e);
      return;
    }
    // 觸控後瀏覽器補發的相容滑鼠事件忽略，避免重複點擊
    if (this.touchUi && e.pointerType === 'mouse' && performance.now() - this.lastTouchAt < 700) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.dragging = true;
    this.dragButton = e.button;
    this.dragStart.set(e.clientX, e.clientY);
    this.dragLast.copy(this.dragStart);
    this.dragDistance = 0;
    this.lastPaintTile = -1;
    // #11：道路工具 = 起點→終點拉線（唔再逐格刷）
    if (e.button === 0 && !e.shiftKey && this.store.state.ui.tool === 'road') {
      const tile = this.pickTile(e.clientX, e.clientY);
      if (tile >= 0) {
        this.hover = tile;
        this.roadDrag = { start: tile, grade: this.store.state.ui.roadGrade ?? 'surface' };
        this.updateRoadPreview(this.store.state, tile);
      }
      return;
    }
    if (e.button === 0 && !e.shiftKey && this.isPaintTool(this.store.state.ui.tool)) {
      this.paintRoadAt(e.clientX, e.clientY);
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.touchUi && e.pointerType === 'touch') {
      this.onTouchMove(e);
      return;
    }
    if (this.touchUi && e.pointerType === 'mouse' && performance.now() - this.lastTouchAt < 700) return;
    this.updatePointer(e.clientX, e.clientY);
    this.updateHover();
    if (!this.dragging) return;
    if (this.roadDrag) {
      this.updateRoadPreview(this.store.state, this.hover);
      return;
    }
    const dx = e.clientX - this.dragLast.x;
    const dy = e.clientY - this.dragLast.y;
    this.dragLast.set(e.clientX, e.clientY);
    this.dragDistance += Math.abs(dx) + Math.abs(dy);

    if (this.dragButton === 2) {
      // 右鍵拖曳：旋轉視角
      this.yaw -= dx * 0.006;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.005, MIN_PITCH, MAX_PITCH);
      return;
    }
    if (this.dragButton === 1 || (this.dragButton === 0 && e.shiftKey)) {
      // 中鍵 / Shift+左鍵：平移
      this.pan(dx, dy);
      return;
    }
    if (this.dragButton === 0 && this.isPaintTool(this.store.state.ui.tool) && this.dragDistance > 4) {
      this.paintRoadAt(e.clientX, e.clientY);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.touchUi && e.pointerType === 'touch') {
      this.onTouchEnd(e);
      return;
    }
    if (this.touchUi && e.pointerType === 'mouse' && performance.now() - this.lastTouchAt < 700) return;
    const wasDragging = this.dragging;
    this.dragging = false;
    this.dragButton = -1;
    if (this.roadDrag) {
      if (wasDragging) this.finishRoadDrag(this.store.state);
      else this.clearRoadPreview();
      return;
    }
    if (!wasDragging) return;
    if (this.dragDistance < 7) {
      if (e.button === 0) this.clickAt(e.clientX, e.clientY);
      else if (e.button === 2) {
        // 右鍵點擊：取消工具
        if (this.store.state.ui.tool) this.actions.setTool(null);
      }
    }
    this.dragDistance = 0;
  };

  private onPointerLeave = (): void => {
    if (this.touchUi) return;
    this.hover = -1;
    this.hoverMesh.visible = false;
    if (this.roadDrag && !this.dragging) this.clearRoadPreview();
  };

  // ───────────────────────── 手機觸控手勢 ─────────────────────────

  private onTouchStart(e: PointerEvent): void {
    e.preventDefault();
    this.lastTouchAt = performance.now();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 部分瀏覽器在多指情況下不支援 capture */
    }
    this.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.updatePointer(e.clientX, e.clientY);
    this.updateHover();

    if (this.touchPointers.size === 1) {
      this.touchStart = { x: e.clientX, y: e.clientY, t: performance.now() };
      this.touchDragLast.set(e.clientX, e.clientY);
      this.touchMoved = false;
      this.touchHadPinch = false;
      this.pinch = null;
      this.dragDistance = 0;
    } else if (this.touchPointers.size === 2) {
      this.touchHadPinch = true;
      this.touchMoved = true;
      this.pinch = this.computePinch();
    }
  }

  private onTouchMove(e: PointerEvent): void {
    if (!this.touchPointers.has(e.pointerId)) return;
    e.preventDefault();
    this.lastTouchAt = performance.now();
    this.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const points = [...this.touchPointers.values()];

    if (points.length >= 2) {
      const next = this.computePinch();
      const prev = this.pinch;
      if (!prev) {
        this.pinch = next;
        return;
      }
      // 雙指縮放（捏合）
      const ratio = prev.distance / Math.max(1, next.distance);
      this.distance = THREE.MathUtils.clamp(this.distance * ratio, MIN_DISTANCE, MAX_DISTANCE);
      // 雙指旋轉
      const deltaAngle = Math.atan2(Math.sin(next.angle - prev.angle), Math.cos(next.angle - prev.angle));
      this.yaw -= deltaAngle;
      // 雙指中心拖曳 → 平移
      this.pan(next.centerX - prev.centerX, next.centerY - prev.centerY);
      this.pinch = next;
      return;
    }

    if (points.length === 1) {
      const dx = e.clientX - this.touchDragLast.x;
      const dy = e.clientY - this.touchDragLast.y;
      this.touchDragLast.set(e.clientX, e.clientY);
      this.dragDistance += Math.abs(dx) + Math.abs(dy);
      if (this.dragDistance > 8) this.touchMoved = true;
      this.pan(dx, dy);
      this.updatePointer(e.clientX, e.clientY);
      this.updateHover();
    }
  }

  private onTouchEnd(e: PointerEvent): void {
    if (!this.touchPointers.has(e.pointerId)) return;
    e.preventDefault();
    this.lastTouchAt = performance.now();
    this.touchPointers.delete(e.pointerId);

    if (this.touchPointers.size === 0) {
      const duration = performance.now() - this.touchStart.t;
      const travel = Math.hypot(e.clientX - this.touchStart.x, e.clientY - this.touchStart.y);
      const tapped = !this.touchHadPinch && !this.touchMoved && duration < 650 && travel < 12;
      if (tapped) this.handleTouchTap(e.clientX, e.clientY);
      this.pinch = null;
      this.touchMoved = false;
      this.touchHadPinch = false;
      this.dragDistance = 0;
    } else if (this.touchPointers.size === 1) {
      // 雙指結束後剩下一指：重新當作單指拖曳起點
      const only = [...this.touchPointers.values()][0];
      this.touchDragLast.set(only.x, only.y);
      this.touchStart = { x: only.x, y: only.y, t: performance.now() };
      this.touchMoved = true;
      this.touchHadPinch = true;
      this.pinch = null;
    }
  }

  private onPointerCancel = (e: PointerEvent): void => {
    if (this.roadDrag) this.clearRoadPreview();
    if (!this.touchUi) return;
    this.touchPointers.delete(e.pointerId);
    if (this.touchPointers.size === 0) {
      this.pinch = null;
      this.touchMoved = false;
      this.touchHadPinch = false;
    }
  };

  private computePinch(): { distance: number; angle: number; centerX: number; centerY: number } {
    const pts = [...this.touchPointers.values()];
    const a = pts[0];
    const b = pts[1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return {
      distance: Math.hypot(dx, dy),
      angle: Math.atan2(dy, dx),
      centerX: (a.x + b.x) / 2,
      centerY: (a.y + b.y) / 2,
    };
  }

  /** 手機點擊：單擊建造／選取；雙擊進入建築 */
  private handleTouchTap(x: number, y: number): void {
    const now = performance.now();
    const isDouble =
      now - this.lastTapAt < 360 && Math.hypot(x - this.lastTapPos.x, y - this.lastTapPos.y) < 36;
    this.lastTapAt = isDouble ? 0 : now;
    this.lastTapPos.set(x, y);

    const state = this.store.state;
    if (isDouble && !state.ui.tool && state.ui.mode === 'city') {
      const tile = this.pickTile(x, y);
      if (tile >= 0) {
        const buildingId = state.tiles[tile].buildingId;
        if (buildingId >= 0) {
          this.actions.enterBuilding(buildingId);
          return;
        }
      }
      return;
    }

    this.clickAt(x, y);
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.distance = THREE.MathUtils.clamp(this.distance * (e.deltaY > 0 ? 1.1 : 0.9), MIN_DISTANCE, MAX_DISTANCE);
  };

  private onDoubleClick = (e: MouseEvent): void => {
    if (this.touchUi) return; // 手機以自訂雙擊手勢處理
    const tile = this.pickTile(e.clientX, e.clientY);
    if (tile < 0) return;
    const state = this.store.state;
    const buildingId = state.tiles[tile].buildingId;
    if (buildingId >= 0) this.actions.enterBuilding(buildingId);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    this.keys.add(e.code);
    // #11：M／N 由 UI（ui/round8-helpers cycleRoadGrade）處理，city-view 只跟隨
    // state.ui.roadGrade 更新預覽；避免雙重 handler 互相 cycle 抵銷。
    if (e.code === 'Space') {
      e.preventDefault();
      this.actions.togglePause();
    } else if (e.code === 'Digit1') this.actions.setSpeed(1);
    else if (e.code === 'Digit2') this.actions.setSpeed(2);
    else if (e.code === 'Digit3') this.actions.setSpeed(3);
    else if (e.code === 'Digit0') this.actions.setSpeed(0);
    else if (e.code === 'Escape') {
      if (this.roadDrag) {
        this.clearRoadPreview();
        return;
      }
      if (this.store.state.ui.mode === 'interior') this.actions.exitInterior();
      else {
        this.actions.closeOverlays();
        this.actions.setTool(null);
      }
    } else if (e.code === 'KeyQ') this.yaw += 0.12;
    else if (e.code === 'KeyE') this.yaw -= 0.12;
    else if (e.code === 'KeyF') this.actions.toggleFinance();
    else if (e.code === 'KeyT') this.actions.toggleTransit();
    else if (e.code === 'KeyC') this.actions.toggleStats();
    else if (e.code === 'KeyH') this.actions.toggleHelp();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private updateKeyboardPan(dt: number): void {
    if (this.store.state.ui.mode === 'interior') return;
    let mx = 0;
    let mz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mz -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mz += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (!mx && !mz) return;
    const speed = this.distance * 0.55 * dt;
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.target.addScaledVector(right, mx * speed);
    this.target.addScaledVector(forward, -mz * speed);
    this.clampTarget();
  }

  private pan(dx: number, dy: number): void {
    const scale = this.distance * 0.0018;
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.target.addScaledVector(right, -dx * scale);
    this.target.addScaledVector(forward, dy * scale);
    this.clampTarget();
  }

  private clampTarget(): void {
    const state = this.store.state;
    const halfW = (state.width * TILE) / 2 + 10;
    const halfH = (state.height * TILE) / 2 + 10;
    this.target.x = THREE.MathUtils.clamp(this.target.x, -halfW, halfW);
    this.target.z = THREE.MathUtils.clamp(this.target.z, -halfH, halfH);
  }

  private updatePointer(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }

  private pickTile(clientX: number, clientY: number): number {
    this.updatePointer(clientX, clientY);
    this.raycaster.setFromCamera(this.pointer, this.cityCamera);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, point)) return -1;
    return worldToTileIndex(this.store.state, point.x, point.z);
  }

  private updateHover(): void {
    this.raycaster.setFromCamera(this.pointer, this.cityCamera);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, point)) {
      this.hover = -1;
      return;
    }
    this.hover = worldToTileIndex(this.store.state, point.x, point.z);
  }

  private clickAt(clientX: number, clientY: number): void {
    const state = this.store.state;
    const tile = this.pickTile(clientX, clientY);
    if (tile < 0) return;
    if (state.ui.tool) {
      this.actions.applyToolAt(tile);
    } else {
      this.actions.select(tile);
    }
  }

  // ───────────────────── #11 道路拉線預覽 ─────────────────────

  private roadPreviewColor(grade: RoadGrade, ok: boolean): number {
    if (!ok) return 0xd46060;
    if (grade === 'elevated') return 0x7fd6e0;
    if (grade === 'tunnel') return 0xffc866;
    return 0x7fd6a0;
  }

  /** 預覽用簡單合法性（同 sim placeRoad 規則一致；唔扣錢／唔 mutate state）。 */
  private roadPreviewOk(state: GameState, tx: number, ty: number, grade: RoadGrade): boolean {
    if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) return false;
    if (isShenzhenSideTile(tx, ty, state.width, state.height)) return false;
    const tile = state.tiles[ty * state.width + tx];
    if (tile.buildingId >= 0) return false;
    if (tile.road) return (tile.roadGrade ?? 'surface') !== grade;
    if (grade === 'surface') return TERRAIN_INFO[tile.terrain]?.buildable === true;
    return true; // 高架／隧道可跨水／山／沙
  }

  private updateRoadPreview(state: GameState, endTile: number): void {
    if (!this.roadDrag || !this.roadPreview) return;
    const from = this.roadDrag.start;
    const to = endTile >= 0 ? endTile : from;
    const x0 = from % state.width;
    const y0 = Math.floor(from / state.width);
    const x1 = to % state.width;
    const y1 = Math.floor(to / state.width);
    const grade = state.ui.roadGrade ?? this.roadDrag.grade;
    const path = roadPathBetween(state, x0, y0, x1, y1);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const count = Math.min(path.length, 1300);
    for (let i = 0; i < count; i++) {
      const p = path[i];
      const ok = this.roadPreviewOk(state, p.x, p.y, grade);
      const d = tileWorld(p.x, p.y, state.width, state.height);
      dummy.position.set(d.x, grade === 'elevated' ? 2.72 : 0.44, d.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      this.roadPreview.setMatrixAt(i, dummy.matrix);
      color.setHex(this.roadPreviewColor(grade, ok));
      this.roadPreview.setColorAt(i, color);
    }
    this.roadPreview.count = count;
    this.roadPreview.visible = count > 0;
    this.roadPreview.instanceMatrix.needsUpdate = true;
    if (this.roadPreview.instanceColor) this.roadPreview.instanceColor.needsUpdate = true;
  }

  private clearRoadPreview(): void {
    this.roadDrag = null;
    this.lastRoadPreviewSig = '';
    if (this.roadPreview) {
      this.roadPreview.count = 0;
      this.roadPreview.visible = false;
    }
  }

  /** 放開滑鼠：套用 L 形道路（優先用 main.ts applyRoadPath）。 */
  private finishRoadDrag(state: GameState): void {
    if (!this.roadDrag) return;
    const from = this.roadDrag.start;
    const to = this.hover >= 0 ? this.hover : from;
    const grade = state.ui.roadGrade ?? this.roadDrag.grade;
    const apply = this.actions.applyRoadPath;
    if (typeof apply === 'function') {
      apply(from, to, grade);
    } else {
      // 舊版 fallback：逐格鋪（只支援 surface）
      const x0 = from % state.width;
      const y0 = Math.floor(from / state.width);
      const x1 = to % state.width;
      const y1 = Math.floor(to / state.width);
      state.ui.roadGrade = grade;
      for (const p of roadPathBetween(state, x0, y0, x1, y1)) {
        this.actions.applyToolAt(p.y * state.width + p.x);
      }
    }
    this.clearRoadPreview();
  }

  /** 可拖曳連續鋪設的工具（道路／行人路） */
  private isPaintTool(tool: string | null): boolean {
    return tool === 'sidewalk' || tool === 'dezone' || zoneOfTool(tool) !== null;
  }

  private paintRoadAt(clientX: number, clientY: number): void {
    const tile = this.pickTile(clientX, clientY);
    if (tile < 0 || tile === this.lastPaintTile) return;
    this.lastPaintTile = tile;
    this.actions.applyToolAt(tile);
  }

  // ───────────────────────── 室內模式 ─────────────────────────

  private openInterior(buildingId: number): void {
    if (this.interior) {
      this.interior.dispose();
      this.interior = null;
    }
    this.interior = createInteriorView(this.store.state, buildingId);
    if (this.interior) {
      this.resizeInteriorCamera();
      this.lastTime = performance.now();
    }
  }

  private closeInterior(): void {
    if (this.interior) {
      this.interior.dispose();
      this.interior = null;
    }
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.cityCamera.aspect = w / h;
    this.cityCamera.updateProjectionMatrix();
    this.resizeInteriorCamera();
  }

  private resizeInteriorCamera(): void {
    if (!this.interior) return;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.interior.camera.aspect = w / h;
    this.interior.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    for (const unsub of this.unsubs) unsub();
    this.terrain?.dispose();
    this.roads?.dispose();
    this.buildings?.dispose();
    this.citizens?.dispose();
    this.vehicles?.dispose();
    this.zones?.dispose();
    this.underground?.dispose();
    this.transitOverlay?.dispose();
    this.rail?.dispose();
    this.shenzhenOverlay?.dispose();
    this.roadPreviewGeo?.dispose();
    this.roadPreviewMat?.dispose();
    this.environment?.dispose();
    this.interior?.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
