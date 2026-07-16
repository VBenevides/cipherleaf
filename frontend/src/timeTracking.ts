export interface UTCDateRange {
  startUTC: string;
  endUTC: string;
}

export const TIME_TRACKING_TABS = ["week", "month", "dashboard", "clients", "projects", "tags"] as const;
export type TimeTrackingTab = (typeof TIME_TRACKING_TABS)[number];
export type DashboardPreset = "current-week" | "last-week" | "current-month" | "last-month";

export function initialTimeTrackingTab(): TimeTrackingTab {
  return "week";
}

export function dashboardPresetRange(preset: DashboardPreset, now: Date): UTCDateRange {
  if (preset === "current-week") return localWeekRange(now);
  if (preset === "last-week") return localWeekRange(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7));
  if (preset === "current-month") return localMonthRange(now);
  return localMonthRange(new Date(now.getFullYear(), now.getMonth() - 1, 1));
}

export function localWeekRange(reference: Date): UTCDateRange {
  const weekday = reference.getDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const start = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() - daysSinceMonday);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  return utcRange(start, end);
}

export function localWeekDates(reference: Date): Date[] {
  const weekday = reference.getDay();
  const start = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() - ((weekday + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function formatLocalDate(date: Date): string {
  return localDateKey(date).replace(/-/g, "/");
}

export function formatLocalDateTime(date: Date): string {
  return `${formatLocalDate(date)}, ${date.toLocaleTimeString("en-US")}`;
}

export function localMonthRange(reference: Date): UTCDateRange {
  const start = new Date(reference.getFullYear(), reference.getMonth(), 1);
  const end = new Date(reference.getFullYear(), reference.getMonth() + 1, 1);
  return utcRange(start, end);
}

export function localMonthGrid(reference: Date): Date[] {
  const first = new Date(reference.getFullYear(), reference.getMonth(), 1);
  const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() - first.getDay());
  const last = new Date(reference.getFullYear(), reference.getMonth() + 1, 0);
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + (6 - last.getDay()));
  const days: Date[] = [];
  for (let day = start; day <= end; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) days.push(day);
  return days;
}

export function inclusiveLocalDateRange(startDate: string, endDate: string): UTCDateRange {
  const start = parseLocalDate(startDate);
  const selectedEnd = parseLocalDate(endDate);
  if (selectedEnd < start) {
    throw new Error("End date must not be before start date");
  }
  const end = new Date(selectedEnd.getFullYear(), selectedEnd.getMonth(), selectedEnd.getDate() + 1);
  return utcRange(start, end);
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return `${minutes}m`;
}

export function runningElapsedSeconds(startedAtUTC: string, now = new Date()): number {
  const started = new Date(startedAtUTC);
  if (!Number.isFinite(started.getTime()) || !Number.isFinite(now.getTime())) {
    return 0;
  }
  return Math.max(0, Math.floor((now.getTime() - started.getTime()) / 1000));
}

export function formatRunningDuration(startedAtUTC: string, now = new Date()): string {
  return formatDuration(runningElapsedSeconds(startedAtUTC, now));
}

export function localDateTimeValue(utc: string): string {
  const date = new Date(utc);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function localDateTimeToUTC(value: string): string {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new Error("Date and time are required");
  return date.toISOString();
}

function parseLocalDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error("Date must use YYYY-MM-DD");
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) {
    throw new Error("Date is invalid");
  }
  return date;
}

function utcRange(start: Date, end: Date): UTCDateRange {
  return { startUTC: start.toISOString(), endUTC: end.toISOString() };
}
