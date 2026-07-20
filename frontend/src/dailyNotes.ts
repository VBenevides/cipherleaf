import { formatLocalTime } from "./timeTracking.ts";

export function formatDailyTitle(date: Date, format: string): string {
  const values: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    MM: String(date.getMonth() + 1).padStart(2, "0"),
    DD: String(date.getDate()).padStart(2, "0"),
  };
  return (format || "YYYY-MM-DD").replace(/YYYY|MM|DD/g, (token) => values[token]);
}

export function renderNoteTemplate(template: string, title: string, date: Date): string {
  return template
    .split("{{title}}").join(title)
    .split("{{date}}").join(formatDailyTitle(date, "YYYY-MM-DD"))
    .split("{{time}}").join(formatLocalTime(date));
}
