"use client";

import { useRouter } from "next/navigation";

interface ResetOverlayProps {
  prompt: string;
  onDismiss: () => void;
}

export function ResetOverlay({ prompt, onDismiss }: ResetOverlayProps) {
  const router = useRouter();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-6">
      <div className="w-full max-w-lg rounded-lg border border-[var(--gold)] bg-[var(--bg-card)] p-6">
        <div className="text-center text-2xl text-[var(--gold)]">◇</div>
        <h2 className="mt-3 text-center text-base font-semibold tracking-[0.2em] text-[var(--gold)]">
          RESET PROTOCOL
        </h2>
        <p className="mt-4 text-center text-sm leading-relaxed text-[var(--white)]">{prompt}</p>
        <p className="mt-4 text-center text-xs leading-relaxed text-[var(--muted)]">
          You did not log yesterday. That is okay. The chain does not define you, but showing up today does.
        </p>
        <button
          onClick={() => {
            onDismiss();
            router.push("/track");
          }}
          className="mt-6 w-full rounded-md px-4 py-3 text-sm font-semibold tracking-[0.15em] text-[var(--bg)]"
          style={{ backgroundColor: "var(--gold)" }}
        >
          I&apos;M HERE. LET&apos;S GO.
        </button>
      </div>
    </div>
  );
}
