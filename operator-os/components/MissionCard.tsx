"use client";

import { DOMAIN_ORDER } from "@/lib/constants";
import { Mission } from "@/lib/types";
import { useStore } from "@/stores/useStore";

interface MissionCardProps {
  mission: Mission;
}

export function MissionCard({ mission }: MissionCardProps) {
  const updateMission = useStore((state) => state.updateMission);
  const domain = DOMAIN_ORDER.find((item) => item.id === mission.domain);
  const color = domain?.color ?? "var(--white)";
  const pct = mission.target > 0 ? Math.min((mission.current / mission.target) * 100, 100) : 0;

  return (
    <article className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--white)]">{mission.label}</h3>
          <div className="mt-1 text-xs text-[var(--muted)]">
            {mission.current.toLocaleString()} / {mission.target.toLocaleString()} {mission.unit}
          </div>
        </div>
        <div className="text-xs font-semibold tracking-[0.1em]" style={{ color }}>
          {Math.round(pct)}%
        </div>
      </div>

      <div className="mt-3 h-2 rounded bg-[var(--dim)]">
        <div className="h-full rounded transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>

      <label className="mt-3 block text-xs text-[var(--muted)]">Update current value</label>
      <input
        type="number"
        min={0}
        value={mission.current}
        onChange={(event) => updateMission(mission.id, Number(event.target.value || 0))}
        className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--white)] outline-none focus:border-[var(--border-active)]"
      />
    </article>
  );
}
