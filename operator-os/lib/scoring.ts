import { DOMAIN_ORDER, HABITS_BY_DOMAIN } from "@/lib/constants";
import { DomainId, HabitDefinition, HabitValue } from "@/lib/types";

export interface DomainScoreResult {
  earned: number;
  possible: number;
  percent: number;
}

export interface ScoreResult {
  overallScore: number;
  domainScores: Record<DomainId, DomainScoreResult>;
  rank: {
    label: "OPERATOR" | "LOCKED IN" | "ON TRACK" | "BUILDING" | "RESET";
    color: string;
    symbol: string;
  };
}

export function calculateHabitPoints(habit: HabitDefinition, value: HabitValue): number {
  if (value === null || value === undefined) {
    return 0;
  }

  if (habit.type === "check") {
    return value === true ? habit.points : 0;
  }

  if (habit.type === "number") {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return 0;
    }
    const target = habit.target ?? 1;
    return habit.points * Math.min(numeric / target, 1);
  }

  const rating = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(rating) || rating <= 0) {
    return 0;
  }
  return habit.points * Math.min(rating / 5, 1);
}

export function calculateDomainScore(
  domainId: DomainId,
  habits: Record<string, HabitValue>,
): DomainScoreResult {
  const defs = HABITS_BY_DOMAIN[domainId];
  const possible = defs.reduce((sum, habit) => sum + habit.points, 0);
  const earned = defs.reduce((sum, habit) => sum + calculateHabitPoints(habit, habits[habit.id]), 0);
  const percent = possible > 0 ? (earned / possible) * 100 : 0;

  return { earned, possible, percent };
}

export function rankForScore(score: number): ScoreResult["rank"] {
  if (score >= 90) return { label: "OPERATOR", color: "var(--red)", symbol: "FIRE" };
  if (score >= 75) return { label: "LOCKED IN", color: "var(--teal)", symbol: "BOLT" };
  if (score >= 60) return { label: "ON TRACK", color: "var(--gold)", symbol: "UP" };
  if (score >= 40) return { label: "BUILDING", color: "var(--blue)", symbol: "BLOCK" };
  return { label: "RESET", color: "var(--muted)", symbol: "DIAMOND" };
}

export function calculateScores(habits: Record<string, HabitValue>): ScoreResult {
  const domainScores = DOMAIN_ORDER.reduce(
    (acc, domain) => ({
      ...acc,
      [domain.id]: calculateDomainScore(domain.id, habits),
    }),
    {} as Record<DomainId, DomainScoreResult>,
  );

  const total = DOMAIN_ORDER.reduce((sum, domain) => sum + domainScores[domain.id].percent, 0);
  const overallScore = total / DOMAIN_ORDER.length;

  return {
    overallScore,
    domainScores,
    rank: rankForScore(overallScore),
  };
}

export function completionSummary(habits: Record<string, HabitValue>) {
  const totals = Object.values(HABITS_BY_DOMAIN).flat();
  const completed = totals.filter((habit) => calculateHabitPoints(habit, habits[habit.id]) > 0).length;
  return { completed, total: totals.length };
}
