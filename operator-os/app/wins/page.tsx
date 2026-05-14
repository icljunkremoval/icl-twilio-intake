"use client";

import { AppShell } from "@/components/AppShell";
import { useStore } from "@/stores/useStore";

const fields: {
  key: "win" | "lesson" | "courage" | "gratitude" | "reflection";
  label: string;
  placeholder: string;
  color: string;
}[] = [
  { key: "win", label: "TODAY'S WIN", placeholder: "What win matters most today?", color: "var(--teal)" },
  { key: "lesson", label: "LESSON LEARNED", placeholder: "What did I learn?", color: "var(--blue)" },
  { key: "courage", label: "COURAGE MOMENT", placeholder: "Where did I show courage?", color: "var(--red)" },
  { key: "gratitude", label: "GRATITUDE", placeholder: "3 things I am grateful for", color: "var(--gold)" },
  { key: "reflection", label: "OPEN REFLECTION", placeholder: "Anything else to capture?", color: "var(--purple)" },
];

export default function WinsPage() {
  const selectedDate = useStore((state) => state.selectedDate);
  const wins = useStore((state) => state.wins[selectedDate]);
  const setWinField = useStore((state) => state.setWinField);

  return (
    <AppShell>
      <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <h2 className="text-sm tracking-[0.16em] text-[var(--white)]">WISDOM LOG</h2>
        <p className="mt-2 text-xs text-[var(--muted)]">
          Reflection is optional. Save what matters. Entries auto-save as you type.
        </p>
      </section>

      <section className="space-y-3">
        {fields.map((field) => (
          <article key={field.key} className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <h3 className="text-xs tracking-[0.18em]" style={{ color: field.color }}>
              {field.label}
            </h3>
            <textarea
              rows={2}
              value={wins?.[field.key] ?? ""}
              onChange={(event) => setWinField(field.key, event.target.value)}
              placeholder={field.placeholder}
              className="mt-2 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--white)] outline-none focus:border-[var(--border-active)]"
            />
          </article>
        ))}
      </section>
    </AppShell>
  );
}
