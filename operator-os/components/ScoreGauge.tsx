interface ScoreGaugeProps {
  score: number;
  label: string;
  color: string;
}

export function ScoreGauge({ score, label, color }: ScoreGaugeProps) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3">
      <div className="text-[10px] tracking-[0.2em] text-[var(--muted)]">TODAY SCORE</div>
      <div className="mt-1 flex items-end justify-between">
        <div className="text-2xl font-bold text-[var(--white)]">{Math.round(score)}%</div>
        <div className="text-xs font-semibold tracking-[0.12em]" style={{ color }}>
          {label}
        </div>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-[var(--dim)]">
        <div
          className="h-full transition-all duration-500 ease-out"
          style={{ width: `${Math.max(0, Math.min(100, score))}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}
