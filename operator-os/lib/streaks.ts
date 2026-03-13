import { HABIT_BY_ID } from "@/lib/constants";
import { DailyLog } from "@/lib/types";
import { shiftDate, todayISO } from "@/lib/time";

function habitDoneOnDate(log: DailyLog | undefined, habitId: string): boolean {
  if (!log) return false;

  const habit = HABIT_BY_ID[habitId];
  if (!habit) return false;
  const value = log.habits[habitId];

  if (habit.type === "check") return value === true;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

export function calculateCurrentStreak(
  logsByDate: Record<string, DailyLog>,
  habitId: string,
  endDate: string = todayISO(),
): number {
  let cursor = endDate;
  let streak = 0;

  while (habitDoneOnDate(logsByDate[cursor], habitId)) {
    streak += 1;
    cursor = shiftDate(cursor, -1);
  }

  return streak;
}
