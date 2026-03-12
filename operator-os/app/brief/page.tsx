"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ResetOverlay } from "@/components/ResetOverlay";
import { ScriptureCard } from "@/components/ScriptureCard";
import { DOMAIN_ORDER, RESET_PROMPTS, SCRIPTURES } from "@/lib/constants";
import { calculateScores, completionSummary } from "@/lib/scoring";
import { getDayPart, shiftDate, todayISO } from "@/lib/time";
import { useStore } from "@/stores/useStore";

function scriptureForDate(date: string) {
  const hash = new Date(`${date}T12:00:00`).getTime();
  return SCRIPTURES[Math.abs(Math.floor(hash / 86_400_000)) % SCRIPTURES.length];
}

function randomResetPrompt(date: string) {
  const seed = new Date(`${date}T12:00:00`).getDate();
  return RESET_PROMPTS[seed % RESET_PROMPTS.length];
}

export default function BriefPage() {
  const hydrated = useStore((state) => state.hydrated);
  const selectedDate = useStore((state) => state.selectedDate);
  const logs = useStore((state) => state.dailyLogs);
  const wins = useStore((state) => state.wins);
  const setObjective = useStore((state) => state.setObjective);
  const setWinField = useStore((state) => state.setWinField);
  const [dismissedDate, setDismissedDate] = useState<string | null>(null);

  const today = todayISO();
  const activeDate = selectedDate || today;
  const dayPart = getDayPart();
  const scripture = scriptureForDate(activeDate);
  const todayLog = logs[activeDate];
  const todayHabits = todayLog?.habits ?? {};
  const score = calculateScores(todayHabits);
  const momentum = completionSummary(todayHabits);
  const winEntry = wins[activeDate];

  const showReset = useMemo(() => {
    if (!hydrated || dismissedDate === today) return false;
    const yesterday = shiftDate(today, -1);
    const yesterdayHabits = logs[yesterday]?.habits ?? {};
    const yesterdayCount = completionSummary(yesterdayHabits).completed;
    return yesterdayCount === 0;
  }, [dismissedDate, hydrated, logs, today]);

  const heading = useMemo(() => {
    if (dayPart === "morning") return "MORNING BRIEF";
    if (dayPart === "afternoon") return "MOMENTUM CHECK";
    return "EVENING DEBRIEF";
  }, [dayPart]);

  return (
    <>
      {showReset ? <ResetOverlay prompt={randomResetPrompt(today)} onDismiss={() => setDismissedDate(today)} /> : null}

      <AppShell>
        <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <h2 className="text-sm tracking-[0.18em] text-[var(--white)]">{heading}</h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
            {dayPart === "morning"
              ? "Set your top 3 priorities before noon."
              : dayPart === "afternoon"
                ? `You have completed ${momentum.completed} of ${momentum.total} habits today.`
                : "Close the day with reflection and gratitude."}
          </p>
        </section>

        <ScriptureCard verse={scripture.text} reference={scripture.ref} />

        <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <h3 className="text-xs tracking-[0.2em] text-[var(--muted)]">TOP 3 OBJECTIVES</h3>
          <div className="mt-3 space-y-2">
            {[0, 1, 2].map((idx) => (
              <label key={idx} className="flex items-center gap-2">
                <span className="text-xs text-[var(--muted)]">{idx + 1}</span>
                <input
                  value={todayLog?.objectives[idx] ?? ""}
                  onChange={(event) => setObjective(idx as 0 | 1 | 2, event.target.value)}
                  placeholder={`Objective ${idx + 1}`}
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--white)] outline-none focus:border-[var(--border-active)]"
                />
              </label>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <h3 className="text-xs tracking-[0.2em] text-[var(--muted)]">DOMAIN STATUS</h3>
          <div className="mt-3 space-y-3">
            {DOMAIN_ORDER.map((domain) => {
              const percent = score.domainScores[domain.id].percent;
              return (
                <div key={domain.id}>
                  <div className="mb-1 flex items-center justify-between text-[10px] tracking-[0.1em]">
                    <span className="text-[var(--text)]">{domain.label}</span>
                    <span className="text-[var(--muted)]">{Math.round(percent)}%</span>
                  </div>
                  <div className="h-1 overflow-hidden rounded bg-[var(--dim)]">
                    <div
                      className="h-full transition-all duration-500"
                      style={{ width: `${Math.max(0, Math.min(100, percent))}%`, backgroundColor: domain.color }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {dayPart === "evening" ? (
          <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <h3 className="text-xs tracking-[0.2em] text-[var(--muted)]">EVENING DEBRIEF</h3>
            <div className="mt-3 space-y-3">
              <textarea
                rows={2}
                value={winEntry?.win ?? ""}
                onChange={(event) => setWinField("win", event.target.value)}
                placeholder="What went well today?"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--white)] outline-none focus:border-[var(--border-active)]"
              />
              <textarea
                rows={2}
                value={winEntry?.lesson ?? ""}
                onChange={(event) => setWinField("lesson", event.target.value)}
                placeholder="What did I learn?"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--white)] outline-none focus:border-[var(--border-active)]"
              />
              <textarea
                rows={2}
                value={winEntry?.courage ?? ""}
                onChange={(event) => setWinField("courage", event.target.value)}
                placeholder="Where did I show courage?"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--white)] outline-none focus:border-[var(--border-active)]"
              />
            </div>
            <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--bg)] p-3">
              <div className="text-xs tracking-[0.16em] text-[var(--muted)]">SCORE SUMMARY</div>
              <div className="mt-1 text-xl font-semibold text-[var(--white)]">{Math.round(score.overallScore)}%</div>
              <div className="text-xs font-semibold tracking-[0.1em]" style={{ color: score.rank.color }}>
                {score.rank.label}
              </div>
            </div>
          </section>
        ) : null}
      </AppShell>
    </>
  );
}
