interface ScriptureCardProps {
  verse: string;
  reference: string;
}

export function ScriptureCard({ verse, reference }: ScriptureCardProps) {
  return (
    <section className="rounded-lg border border-[var(--gold)]/60 bg-[var(--bg-card)] p-4">
      <div className="text-[10px] tracking-[0.2em] text-[var(--gold)]">DAILY SCRIPTURE</div>
      <blockquote className="mt-2 text-sm italic leading-relaxed text-[var(--white)]">&quot;{verse}&quot;</blockquote>
      <div className="mt-2 text-xs tracking-[0.12em] text-[var(--gold)]">{reference}</div>
    </section>
  );
}
