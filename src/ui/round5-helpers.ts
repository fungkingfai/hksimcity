/**
 * Round 5 UI 共用小工具（地下管網／路線／貿易）。
 *
 * Round 5 的 GameActions 新方法全部係 optional：main.ts 未接好時，
 * 所有 toggle 都 fallback 直接改 state.ui + bumpUI，令 UI 可以先交付。
 */

import type { GameActions, PipeKind, TransitLineMode } from '../core/types';
import type { GameStore } from '../core/store';

export type PipeToolKind = PipeKind | 'remove';

export const PIPE_TOOL: Record<PipeToolKind, string> = {
  water: 'pipe:water',
  sewer: 'pipe:sewer',
  power: 'pipe:power',
  remove: 'pipe:remove',
};

export function pipeKindOfTool(tool: string | null): PipeToolKind | null {
  if (!tool || !tool.startsWith('pipe:')) return null;
  const kind = tool.slice(5) as PipeToolKind;
  return kind in PIPE_TOOL ? kind : null;
}

/** U：地下管網圖層開關 */
export function toggleUnderground(store: GameStore, actions: GameActions): void {
  if (typeof actions.toggleUnderground === 'function') {
    actions.toggleUnderground();
    return;
  }
  const ui = store.state.ui;
  ui.showUnderground = !ui.showUnderground;
  if (!ui.showUnderground && ui.tool?.startsWith('pipe:')) ui.tool = null;
  store.bumpUI();
}

/** 公用設施面板開關 */
export function toggleUtilityPanel(store: GameStore, actions: GameActions): void {
  if (typeof actions.toggleUtilityPanel === 'function') {
    actions.toggleUtilityPanel();
    return;
  }
  const ui = store.state.ui;
  ui.showUtilityPanel = !ui.showUtilityPanel;
  store.bumpUI();
}

/** 機場／碼頭貿易面板開關 */
export function toggleTradePanel(store: GameStore, actions: GameActions): void {
  if (typeof actions.toggleTradePanel === 'function') {
    actions.toggleTradePanel();
    return;
  }
  const ui = store.state.ui;
  ui.showTradePanel = !ui.showTradePanel;
  store.bumpUI();
}

/**
 * 進入地下層並切換到指定 pipe 工具（公用設施面板會自動收起讓玩家畫管）。
 * 直接改 state：toggleUnderground action 會順便開公用面板，呢度唔想再彈返。
 */
export function activatePipeTool(store: GameStore, actions: GameActions, kind: PipeToolKind): void {
  const ui = store.state.ui;
  ui.showUnderground = true;
  ui.showUtilityPanel = false;
  store.bumpUI();
  actions.setTool(PIPE_TOOL[kind]);
}

/** 建線模式（Phase B） */
export function beginTransitLine(store: GameStore, actions: GameActions, mode: TransitLineMode): void {
  if (typeof actions.beginLineEditor === 'function') {
    actions.beginLineEditor(mode);
    return;
  }
  const ui = store.state.ui;
  ui.lineEditorActive = true;
  ui.lineDraft = { mode, stopIds: [] };
  ui.showTransit = true;
  store.bumpUI();
}
