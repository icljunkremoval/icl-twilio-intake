"use client";

import { getWeekDates, formatDisplayDate, shiftDate } from "@/lib/time";
import { useStore } from "@/stores/useStore";

export function WeekNav() {
  const selectedDate = useStore((state) => state.selectedDate);
  const setSelectedDate = useStore((state) => state.setSelectedDate);
  const weekDates = getWeekDates(selectedDate);

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3">
      <div className="mb-3 flex items-center justify-between">
        <button
          className="rounded-md border border-[var(--border)] px-3 py-1 text-xs tracking-[0.15em] text-[var(--muted)] hover:text-[var(--white)]"
          onClick={() => setSelectedDate(shiftDate(selectedDate, -7))}
        >
          PREV
        </button>
        <div className="text-xs tracking-[0.2em] text-[var(--muted)]">{formatDisplayDate(selectedDate)}</div>
        <button
          className="rounded-md border border-[var(--border)] px-3 py-1 text-xs tracking-[0.15em] text-[var(--muted)] hover:text-[var(--white)]"
          onClick={() => setSelectedDate(shiftDate(selectedDate, 7))}
        >
          NEXT
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {weekDates.map((date) => {
          const active = date === selectedDate;
          return (
            <button
              key={date}
              onClick={() => setSelectedDate(date)}
              className={`rounded-md border px-2 py-2 text-center text-xs tracking-[0.08em] ${
                active
                  ? "border-[var(--border-active)] bg-[var(--bg-hover)] text-[var(--white)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]"
              }`}
            >
              {new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" }).slice(0, 1)}
              <div className="mt-1 text-[10px]">{date.slice(-2)}</div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
