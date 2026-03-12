interface StreakBadgeProps {
  label: string;
  days: number;
  color: string;
}

export function StreakBadge({ label, days, color }: StreakBadgeProps) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2">
      <div className="text-[10px] tracking-[0.18em] text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-sm font-semibold" style={{ color }}>
        {days} DAY{days === 1 ? "" : "S"}
      </div>
    </div>
  );
}
