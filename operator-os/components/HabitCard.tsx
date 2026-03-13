"use client";

import { calculateCurrentStreak } from "@/lib/streaks";
import { HabitDefinition } from "@/lib/types";
import { useStore } from "@/stores/useStore";

interface HabitCardProps {
  habit: HabitDefinition;
  color: string;
}

export function HabitCard({ habit, color }: HabitCardProps) {
  const selectedDate = useStore((state) => state.selectedDate);
  const logs = useStore((state) => state.dailyLogs);
  const setHabit = useStore((state) => state.setHabit);
  const value = logs[selectedDate]?.habits[habit.id];
  const streak = calculateCurrentStreak(logs, habit.id, selectedDate);

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[var(--white)]">{habit.label}</div>
          <div className="mt-1 text-xs text-[var(--muted)]">
            {habit.points} pts{habit.target ? ` | target ${habit.target}` : ""}
          </div>
        </div>
        {streak > 1 ? (
          <div className="text-xs font-semibold tracking-[0.1em]" style={{ color }}>
            {streak}D
          </div>
        ) : null}
      </div>

      <div className="mt-3">
        {habit.type === "check" ? (
          <button
            onClick={() => setHabit(habit.id, value === true ? false : true)}
            className={`w-full rounded-md border px-3 py-2 text-sm font-semibold tracking-[0.08em] ${
              value === true
                ? "border-transparent text-[var(--bg)]"
                : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--white)]"
            }`}
            style={value === true ? { backgroundColor: color } : undefined}
          >
            {value === true ? "COMPLETE" : "MARK COMPLETE"}
          </button>
        ) : habit.type === "number" ? (
          <input
            type="number"
            min={0}
            value={typeof value === "number" ? value : ""}
            onChange={(event) => setHabit(habit.id, Number(event.target.value || 0))}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--white)] outline-none focus:border-[var(--border-active)]"
            placeholder={`Enter value ${habit.target ? `(target ${habit.target})` : ""}`}
          />
        ) : (
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((rating) => (
              <button
                key={rating}
                onClick={() => setHabit(habit.id, rating)}
                className={`h-9 w-9 rounded-md border text-sm ${
                  value === rating
                    ? "border-transparent text-[var(--bg)]"
                    : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--white)]"
                }`}
                style={value === rating ? { backgroundColor: color } : undefined}
              >
                {rating}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
