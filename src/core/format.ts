/**
 * 時間／日期顯示工具（香港版，供 UI 使用）。
 */

import { MONTHS_PER_YEAR, SEASON_INFO, START_YEAR, WEEKDAY_NAMES } from './config';
import type { GameClock, Season } from './types';

/** 時段名稱（供頂欄顯示），例如 6 時 → 清晨、14 時 → 下午 */
export function shichenName(hour: number): string {
  if (hour < 5) return '深夜';
  if (hour < 8) return '清晨';
  if (hour < 11) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 21) return '黃昏';
  return '晚上';
}

/** 24 小時制時鐘，例如 06:30 */
export function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 顯示年份（2026 年起） */
export function displayYear(year: number): number {
  return START_YEAR + year - 1;
}

/** 例如：2026年3月1日（星期日）06:30 */
export function formatGameDate(clock: GameClock): string {
  return `${displayYear(clock.year)}年${clock.month}月${clock.day}日（${weekdayName(clock)}）`;
}

/** 短日期，例如：2026年3月7日 */
export function formatShortDate(clock: GameClock): string {
  return `${displayYear(clock.year)}年${clock.month}月${clock.day}日`;
}

export function seasonName(season: Season): string {
  return SEASON_INFO[season].name;
}

/** 一年中的第幾天（1-based），供季節曲線使用 */
export function dayOfYear(clock: GameClock): number {
  return (clock.month - 1) * 7 + clock.day;
}

export function monthName(month: number): string {
  return `${month}月`;
}

export function weekdayName(clock: GameClock): string {
  return WEEKDAY_NAMES[clock.weekday ?? clock.totalDays % 7] ?? '';
}

export function yearProgress(clock: GameClock): number {
  const totalDays = MONTHS_PER_YEAR * 7;
  return ((clock.month - 1) * 7 + (clock.day - 1)) / totalDays;
}

/** 是否週末（星期六／日）——市民放假、商業興旺 */
export function isWeekend(clock: GameClock): boolean {
  const weekday = clock.weekday ?? 0;
  return weekday === 0 || weekday === 6;
}
