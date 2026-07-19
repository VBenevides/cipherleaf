import { useEffect, useRef, useState } from "react";

type ThemedDatePickerProps = {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  withTime?: boolean;
};

function dateValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return dateValue(date) === value.slice(0, 10) ? date : null;
}

function displayDate(value: string, withTime: boolean): string {
  const date = parseDate(value);
  if (!date) return withTime ? "Select date and time" : "Select date";
  if (!withTime) return date.toLocaleDateString();
  const [hours = "00", minutes = "00"] = value.slice(11, 16).split(":");
  date.setHours(Number(hours), Number(minutes));
  return date.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

export function ThemedDatePicker({ ariaLabel, value, onChange, withTime = false }: ThemedDatePickerProps) {
  const picker = useRef<HTMLDivElement>(null);
  const selected = parseDate(value);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => selected ?? new Date());
  const [time, setTime] = useState(() => value.slice(11, 16) || "00:00");

  useEffect(() => { if (selected) setMonth(selected); }, [value]);
  useEffect(() => { if (withTime) setTime(value.slice(11, 16) || "00:00"); }, [value, withTime]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!picker.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = new Date(first.getFullYear(), first.getMonth(), first.getDate() - first.getDay());
  const days = Array.from({ length: 42 }, (_, index) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index));
  const selectDate = (date: Date) => {
    const selectedTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : "00:00";
    onChange(withTime ? `${dateValue(date)}T${selectedTime}` : dateValue(date));
    if (!withTime) setOpen(false);
  };

  return <div ref={picker} className="themed-date-picker">
    <button type="button" className="themed-date-picker-trigger" aria-label={ariaLabel} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((current) => !current)}>{displayDate(value, withTime)}</button>
    {open && <div className="themed-date-picker-popover" role="dialog" aria-label={ariaLabel}>
      <div className="themed-date-picker-header">
        <button type="button" aria-label="Previous month" onClick={() => setMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}>‹</button>
        <strong>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</strong>
        <button type="button" aria-label="Next month" onClick={() => setMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}>›</button>
      </div>
      <div className="themed-date-picker-weekdays" aria-hidden="true">{Array.from({ length: 7 }, (_, day) => <span key={day}>{new Date(2023, 0, day + 1).toLocaleDateString(undefined, { weekday: "narrow" })}</span>)}</div>
      <div className="themed-date-picker-days">{days.map((date) => <button type="button" key={dateValue(date)} className={`${date.getMonth() === month.getMonth() ? "" : "outside"} ${selected && dateValue(date) === dateValue(selected) ? "selected" : ""}`} aria-label={date.toLocaleDateString(undefined, { dateStyle: "full" })} onClick={() => selectDate(date)}>{date.getDate()}</button>)}</div>
      {withTime && <label className="themed-date-picker-time">Time<input type="text" inputMode="numeric" maxLength={5} placeholder="HH:MM" value={time} onChange={(event) => { const next = event.target.value; setTime(next); if (/^([01]\d|2[0-3]):[0-5]\d$/.test(next)) onChange(`${dateValue(selected ?? month)}T${next}`); }} /></label>}
    </div>}
  </div>;
}
