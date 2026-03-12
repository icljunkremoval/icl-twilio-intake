"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/brief", label: "BRIEF" },
  { href: "/track", label: "TRACK" },
  { href: "/wins", label: "WINS" },
  { href: "/missions", label: "MISSIONS" },
];

export function TabBar() {
  const pathname = usePathname();

  return (
    <nav className="sticky bottom-0 z-30 border-t border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur">
      <div className="mx-auto grid max-w-5xl grid-cols-4 gap-2 px-4 py-3">
        {tabs.map((tab) => {
          const active = pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`rounded-md border px-2 py-2 text-center text-xs font-semibold tracking-[0.18em] transition ${
                active
                  ? "border-[var(--border-active)] bg-[var(--bg-card)] text-[var(--white)]"
                  : "border-transparent text-[var(--muted)] hover:border-[var(--border)] hover:text-[var(--text)]"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
