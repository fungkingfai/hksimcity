/**
 * 遊戲狀態容器 + 事件匯流排。
 *
 * 任何模組可以讀 store.state；寫入狀態請經由 main.ts 建立的 actions 或
 * simulation。事件用途：
 *   - 'tick'   每個渲染影格（不帶 payload）
 *   - 'reset'  換局／讀檔後，渲染器需要重建所有場景物件
 *   - 'enter'  進入建築室內（payload: buildingId）
 *   - 'exit'   離開室內
 *   - 'select' 選取變更（payload: buildingId | null）
 *   - 'toast'  顯示浮動提示（payload: { text, kind }）
 *   - 'log'    新增歷史紀錄（payload: LogEntry）
 *   - 'focus'  鏡頭跳轉（payload: FocusPayload）
 */

import type { GameState, LogEntry, LogKind } from './types';

export type StoreEvent = 'tick' | 'reset' | 'enter' | 'exit' | 'select' | 'toast' | 'log' | 'ui' | 'focus';

/** 鏡頭跳轉（minimap／快捷鍵）：mode='map' 拉遠睇全圖，mode='tile' 飛到指定格 */
export interface FocusPayload {
  x: number;
  y: number;
  mode: 'tile' | 'map';
}

export interface ToastPayload {
  text: string;
  kind: LogKind;
}

type Handler = (payload?: unknown) => void;

const MAX_LOG = 120;

export class GameStore {
  state: GameState;
  private listeners = new Map<StoreEvent, Set<Handler>>();

  constructor(state: GameState) {
    this.state = state;
  }

  on(event: StoreEvent, handler: Handler): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  emit(event: StoreEvent, payload?: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[store] listener for "${event}" failed`, err);
      }
    }
  }

  toast(text: string, kind: LogKind = 'info'): void {
    this.emit('toast', { text, kind } satisfies ToastPayload);
  }

  log(text: string, kind: LogKind = 'info'): void {
    const { clock } = this.state;
    const entry: LogEntry = {
      id: this.state.nextLogId++,
      year: clock.year,
      month: clock.month,
      day: clock.day,
      text,
      kind,
    };
    this.state.log.push(entry);
    if (this.state.log.length > MAX_LOG) this.state.log.splice(0, this.state.log.length - MAX_LOG);
    this.emit('log', entry);
    this.bumpUI();
  }

  bumpUI(): void {
    this.state.ui.revision++;
    this.emit('ui');
  }

  /** 換局或讀檔：替換整個 state 並讓渲染器重建 */
  setState(state: GameState): void {
    this.state = state;
    this.emit('reset', state);
    this.bumpUI();
  }
}
