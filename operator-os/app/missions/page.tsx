"use client";

import { FormEvent, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Heatmap } from "@/components/Heatmap";
import { MissionCard } from "@/components/MissionCard";
import { DOMAIN_ORDER } from "@/lib/constants";
import { DomainId } from "@/lib/types";
import { useStore } from "@/stores/useStore";

export default function MissionsPage() {
  const missions = useStore((state) => state.missions.filter((mission) => !mission.archived));
  const addMission = useStore((state) => state.addMission);

  const [label, setLabel] = useState("");
  const [target, setTarget] = useState<number>(0);
  const [unit, setUnit] = useState("");
  const [domain, setDomain] = useState<DomainId>("build");

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!label.trim() || target <= 0) return;

    addMission({
      label: label.trim(),
      target,
      current: 0,
      unit: unit.trim() || "units",
      domain,
    });

    setLabel("");
    setTarget(0);
    setUnit("");
  };

  return (
    <AppShell>
      <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <h2 className="text-sm tracking-[0.16em] text-[var(--white)]">MISSIONS</h2>
        <p className="mt-2 text-xs text-[var(--muted)]">Long-range targets tracked with visible progress.</p>
      </section>

      <section className="space-y-3">
        {missions.map((mission) => (
          <MissionCard key={mission.id} mission={mission} />
        ))}
      </section>

      <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <h3 className="text-xs tracking-[0.18em] text-[var(--muted)]">ADD MISSION</h3>
        <form onSubmit={onSubmit} className="mt-3 grid gap-2 md:grid-cols-2">
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Mission label"
            className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--white)] outline-none focus:border-[var(--border-active)]"
          />
          <input
            type="number"
            min={1}
            value={target || ""}
            onChange={(event) => setTarget(Number(event.target.value || 0))}
            placeholder="Target"
            className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--white)] outline-none focus:border-[var(--border-active)]"
          />
          <input
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            placeholder="Unit (days, $, lbs)"
            className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--white)] outline-none focus:border-[var(--border-active)]"
          />
          <select
            value={domain}
            onChange={(event) => setDomain(event.target.value as DomainId)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--white)] outline-none focus:border-[var(--border-active)]"
          >
            {DOMAIN_ORDER.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-md px-3 py-2 text-sm font-semibold tracking-[0.1em] text-[var(--bg)] md:col-span-2"
            style={{ backgroundColor: "var(--purple)" }}
          >
            ADD MISSION
          </button>
        </form>
      </section>

      <Heatmap />
    </AppShell>
  );
}
