"use client";

import { AppShell } from "@/components/AppShell";
import { DomainSelector } from "@/components/DomainSelector";
import { HabitCard } from "@/components/HabitCard";
import { DOMAIN_ORDER, HABITS_BY_DOMAIN } from "@/lib/constants";
import { calculateDomainScore, calculateScores, completionSummary } from "@/lib/scoring";
import { useStore } from "@/stores/useStore";

export default function TrackPage() {
  const activeDomain = useStore((state) => state.activeDomain);
  const selectedDate = useStore((state) => state.selectedDate);
  const logs = useStore((state) => state.dailyLogs);
  const habits = logs[selectedDate]?.habits ?? {};

  const domain = DOMAIN_ORDER.find((item) => item.id === activeDomain) ?? DOMAIN_ORDER[0];
  const domainHabits = HABITS_BY_DOMAIN[domain.id];
  const domainScore = calculateDomainScore(domain.id, habits);
  const score = calculateScores(habits);
  const momentum = completionSummary(habits);

  return (
    <AppShell>
      <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <h2 className="text-sm tracking-[0.16em] text-[var(--white)]">TRACK</h2>
        <p className="mt-2 text-xs text-[var(--muted)]">
          You&apos;ve completed {momentum.completed} of {momentum.total} habits today.
        </p>
        <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg)] p-3">
          <div className="text-xs tracking-[0.12em] text-[var(--muted)]">RANK</div>
          <div className="mt-1 text-sm font-semibold" style={{ color: score.rank.color }}>
            {score.rank.label} ({Math.round(score.overallScore)}%)
          </div>
        </div>
      </section>

      <DomainSelector />

      <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <div className="text-xs tracking-[0.16em] text-[var(--muted)]">{domain.label}</div>
        <p className="mt-2 text-sm italic leading-relaxed text-[var(--text)]">{domain.identity}</p>
        <div className="mt-2 text-xs tracking-[0.1em]" style={{ color: domain.color }}>
          DOMAIN SCORE {Math.round(domainScore.percent)}%
        </div>
      </section>

      <section className="space-y-3">
        {domainHabits.map((habit) => (
          <HabitCard key={habit.id} habit={habit} color={domain.color} />
        ))}
      </section>
    </AppShell>
  );
}
