"use client";

import { DOMAIN_ORDER } from "@/lib/constants";
import { useStore } from "@/stores/useStore";

export function DomainSelector() {
  const activeDomain = useStore((state) => state.activeDomain);
  const setActiveDomain = useStore((state) => state.setActiveDomain);

  return (
    <div className="grid grid-cols-5 gap-2">
      {DOMAIN_ORDER.map((domain) => {
        const active = domain.id === activeDomain;
        return (
          <button
            key={domain.id}
            onClick={() => setActiveDomain(domain.id)}
            className={`rounded-md border px-2 py-2 text-xs tracking-[0.12em] transition ${
              active
                ? "border-[var(--border-active)] bg-[var(--bg-hover)] text-[var(--white)]"
                : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]"
            }`}
            style={active ? { boxShadow: `inset 0 0 0 1px ${domain.color}` } : undefined}
          >
            <div style={{ color: domain.color }}>{domain.icon}</div>
            <div className="mt-1">{domain.label}</div>
          </button>
        );
      })}
    </div>
  );
}
