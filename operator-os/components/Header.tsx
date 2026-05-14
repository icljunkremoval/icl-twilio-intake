"use client";

import { KEY_STREAK_HABITS } from "@/lib/constants";
import { calculateScores } from "@/lib/scoring";
import { calculateCurrentStreak } from "@/lib/streaks";
import { formatDisplayDate } from "@/lib/time";
import { useStore } from "@/stores/useStore";
import { ScoreGauge } from "@/components/ScoreGauge";
import { StreakBadge } from "@/components/StreakBadge";

export function Header() {
  const selectedDate = useStore((state) => state.selectedDate);
  const logs = useStore((state) => state.dailyLogs);
  const log = logs[selectedDate];
  const score = calculateScores(log?.habits ?? {});

  return (
    <header className="space-y-4 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs tracking-[0.2em] text-[var(--muted)]">OPERATOR OS</div>
          <h1 className="mt-1 text-lg font-semibold tracking-[0.1em] text-[var(--white)]">
            GOOD MORNING, COMMANDER
          </h1>
          <div className="mt-1 text-xs text-[var(--text)]">{formatDisplayDate(selectedDate)}</div>
        </div>
      </div>

      <ScoreGauge score={score.overallScore} label={score.rank.label} color={score.rank.color} />

      <div className="grid grid-cols-3 gap-2">
        {KEY_STREAK_HABITS.map((habit) => (
          <StreakBadge
            key={habit.id}
            label={habit.label}
            color={habit.color}
            days={calculateCurrentStreak(logs, habit.id, selectedDate)}
          />
        ))}
      </div>
    </header>
  );
}
