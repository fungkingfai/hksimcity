/**
 * 香港版 UI 時間／數字顯示工具（只供 src/ui 使用）。
 *
 * 注意：不 import `core/format.ts`（Lead 維護中，與新 config 的 WEEKDAY_NAMES 尚未對齊），
 * 所有日期文字集中在這裡，方便統一成香港寫法：
 *   2026年3月1日 星期日
 */

import { DAYS_PER_MONTH, SEASON_INFO, START_YEAR, WEEKDAY_NAMES } from '../core/config';
import type { GameClock, Season } from '../core/types';

/** 顯示年份（2026 年起） */
export function displayYear(year: number): number {
  return START_YEAR + year - 1;
}

/** 完整日期：2026年3月1日（星期日） */
export function formatDateHK(clock: GameClock): string {
  const weekday = WEEKDAY_NAMES[clock.weekday] ?? '';
  return `${displayYear(clock.year)}年${clock.month}月${clock.day}日（${weekday}）`;
}

/** 短日期：2026年3月1日 */
export function formatShortDateHK(clock: GameClock): string {
  return `${displayYear(clock.year)}年${clock.month}月${clock.day}日`;
}

/** 手機頂欄用超短日期：2月5日（四） */
export function formatDateCompactHK(clock: GameClock): string {
  const weekday = (WEEKDAY_NAMES[clock.weekday] ?? '').replace('星期', '');
  return `${clock.month}月${clock.day}日（${weekday}）`;
}

/** 月日：3月1日 */
export function formatMonthDayHK(clock: GameClock): string {
  return `${clock.month}月${clock.day}日`;
}

/** 24 小時制時鐘：06:30 */
export function formatClockHK(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 季節中文名（春／夏／秋／冬） */
export function seasonNameHK(season: Season): string {
  return SEASON_INFO[season]?.name ?? '';
}

/** 月份標籤：2026年3月 */
export function formatMonthLabel(year: number, month: number): string {
  return `${displayYear(year)}年${month}月`;
}

/** 第幾日（1 起）→ 日期（用於 log 時間戳） */
export function logDateLabel(year: number, month: number, day: number): string {
  return `${displayYear(year)}/${month}/${day}`;
}

/** 本月已過日數（1..DAYS_PER_MONTH；用作賣地／煙花冷卻估算） */
export function daysIntoMonth(clock: GameClock): number {
  return (clock.totalDays - 1) % DAYS_PER_MONTH + 1;
}

/** 距離冷卻尚餘日數（0 = 可再用） */
export function cooldownLeft(totalDays: number, lastDay: number, cooldown: number): number {
  return Math.max(0, cooldown - (totalDays - lastDay));
}

/** 百分比字串（0..1） */
export function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

/** 每分鐘格式（平均通勤時間）：28 分鐘 */
export function formatMinutes(minutes: number): string {
  return `${Math.max(0, Math.round(minutes))} 分鐘`;
}
