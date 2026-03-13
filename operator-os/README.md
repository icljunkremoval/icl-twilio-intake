# Operator OS

Operator OS is a dark-mode personal command center PWA designed for high-discipline daily execution.

## Stack

- Next.js (App Router, TypeScript)
- Tailwind CSS
- Zustand (local-first persistence)
- PWA shell (manifest + service worker)

## Implemented Screens

- `/brief` — Morning/Afternoon/Evening briefing with scripture, objectives, status bars, and reset protocol overlay
- `/track` — Domain habit logger with scoring and streak visibility
- `/wins` — Daily reflection/wisdom log
- `/missions` — Long-term mission progress + weekly domain heatmap

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:3000` and you will be redirected to `/brief`.

## Build

```bash
npm run lint
npm run build
```

## Notes

- App state persists in browser `localStorage` for offline-first behavior.
- API routes are currently placeholders for Supabase integration.
- Initial Supabase schema is included in `supabase/migrations`.
