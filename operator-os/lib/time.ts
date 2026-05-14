export type DayPart = "morning" | "afternoon" | "evening";

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function shiftDate(isoDate: string, deltaDays: number) {
  const date = new Date(`${isoDate}T12:00:00`);
  date.setDate(date.getDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

export function formatDisplayDate(isoDate: string) {
  const date = new Date(`${isoDate}T12:00:00`);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function getDayPart(now = new Date()): DayPart {
  const hour = now.getHours();
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

export function getWeekDates(anchorIso: string): string[] {
  const anchor = new Date(`${anchorIso}T12:00:00`);
  const day = anchor.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() + mondayOffset);

  return Array.from({ length: 7 }, (_, idx) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + idx);
    return d.toISOString().slice(0, 10);
  });
}
