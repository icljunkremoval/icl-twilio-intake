"use client";

import { DOMAIN_ORDER } from "@/lib/constants";
import { calculateDomainScore } from "@/lib/scoring";
import { getWeekDates } from "@/lib/time";
import { useStore } from "@/stores/useStore";

export function Heatmap() {
  const selectedDate = useStore((state) => state.selectedDate);
  const setSelectedDate = useStore((state) => state.setSelectedDate);
  const logs = useStore((state) => state.dailyLogs);
  const week = getWeekDates(selectedDate);

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
      <h3 className="text-xs tracking-[0.2em] text-[var(--muted)]">WEEKLY HEATMAP</h3>
      <div className="mt-3 grid gap-2">
        {DOMAIN_ORDER.map((domain) => (
          <div key={domain.id} className="grid grid-cols-[72px_1fr] items-center gap-2">
            <div className="text-[10px] tracking-[0.1em] text-[var(--muted)]">{domain.label}</div>
            <div className="grid grid-cols-7 gap-1">
              {week.map((date) => {
                const habits = logs[date]?.habits ?? {};
                const pct = calculateDomainScore(domain.id, habits).percent;
                const alpha = Math.max(0.1, Math.min(1, pct / 100));

                return (
                  <button
                    key={`${domain.id}-${date}`}
                    title={`${domain.label} ${date}: ${Math.round(pct)}%`}
                    onClick={() => setSelectedDate(date)}
                    className="h-7 rounded-sm border border-[var(--border)]"
                    style={{ backgroundColor: domain.color, opacity: alpha }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
