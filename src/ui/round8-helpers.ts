/**
 * Round 8 UI helpers（issues #11–#15）：建築圖層、管網分層、流水動畫、道路 grade。
 *
 * Round 8 的 UIState／GameActions 欄位都係 optional：Lead/main 未接好時，
 * 呢度 fallback 直接改 state.ui + bumpUI，令 UI 可以先行交付。
 */

import type { GameActions, GameState, RoadGrade } from '../core/types';
import type { GameStore } from '../core/store';

export type PipeLayerKind = 'water' | 'sewage' | 'power';

interface Round8UI {
  showBuildings?: boolean;
  pipeLayers?: { water: boolean; sewage: boolean; power: boolean };
  pipeFlow?: boolean;
  roadGrade?: RoadGrade;
}

interface Round8Actions {
  toggleBuildings?(): void;
  setPipeLayer?(kind: PipeLayerKind, on: boolean): void;
  togglePipeFlow?(): void;
}

const ui8 = (state: GameState): Round8UI => state.ui as unknown as Round8UI;
const act8 = (actions: GameActions): Round8Actions => actions as unknown as Round8Actions;

/** 建築圖層預設顯示 */
export function showBuildings(state: GameState): boolean {
  return ui8(state).showBuildings !== false;
}

/** 管網分層預設全開 */
export function pipeLayerOn(state: GameState, kind: PipeLayerKind): boolean {
  return ui8(state).pipeLayers?.[kind] !== false;
}

/** 流水動畫預設開啟 */
export function pipeFlowOn(state: GameState): boolean {
  return ui8(state).pipeFlow !== false;
}

/** 道路 grade（預設地面） */
export function roadGradeOf(state: GameState): RoadGrade {
  return ui8(state).roadGrade ?? 'surface';
}

export function toggleBuildings(store: GameStore, actions: GameActions): void {
  const fn = act8(actions).toggleBuildings;
  if (typeof fn === 'function') {
    fn.call(actions);
    return;
  }
  const ui = ui8(store.state);
  ui.showBuildings = !showBuildings(store.state);
  store.bumpUI();
}

export function setPipeLayer(
  store: GameStore,
  actions: GameActions,
  kind: PipeLayerKind,
  on: boolean,
): void {
  const fn = act8(actions).setPipeLayer;
  if (typeof fn === 'function') {
    fn.call(actions, kind, on);
    return;
  }
  const ui = ui8(store.state);
  const layers = ui.pipeLayers ?? { water: true, sewage: true, power: true };
  ui.pipeLayers = { ...layers, [kind]: on };
  store.bumpUI();
}

export function togglePipeFlow(store: GameStore, actions: GameActions): void {
  const fn = act8(actions).togglePipeFlow;
  if (typeof fn === 'function') {
    fn.call(actions);
    return;
  }
  const ui = ui8(store.state);
  ui.pipeFlow = !pipeFlowOn(store.state);
  store.bumpUI();
}

/** 道路拖曳時 M／N 切 grade；再按同一 grade 返回地面 */
export function cycleRoadGrade(store: GameStore, grade: Exclude<RoadGrade, 'surface'>): void {
  const ui = ui8(store.state);
  const current = roadGradeOf(store.state);
  ui.roadGrade = current === grade ? 'surface' : grade;
  store.bumpUI();
}
