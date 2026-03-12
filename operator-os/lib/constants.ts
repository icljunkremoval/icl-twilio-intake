import { DomainDefinition, HabitDefinition, DomainId, Mission } from "@/lib/types";

export const DOMAIN_ORDER: DomainDefinition[] = [
  {
    id: "body",
    label: "BODY",
    shortLabel: "Fitness",
    color: "var(--red)",
    icon: "◆",
    identity: "I am a disciplined athlete who protects his body.",
  },
  {
    id: "spirit",
    label: "SPIRIT",
    shortLabel: "Personal/Faith",
    color: "var(--gold)",
    icon: "✦",
    identity: "I live anchored in faith, gratitude, and presence.",
  },
  {
    id: "flight",
    label: "FLIGHT",
    shortLabel: "Aviation",
    color: "var(--teal)",
    icon: "▲",
    identity: "I train daily for mastery and command in the cockpit.",
  },
  {
    id: "range",
    label: "RANGE",
    shortLabel: "Firearms",
    color: "var(--blue)",
    icon: "◎",
    identity: "I build precision through calm repetition and discipline.",
  },
  {
    id: "build",
    label: "BUILD",
    shortLabel: "Business",
    color: "var(--purple)",
    icon: "■",
    identity: "I execute revenue-producing actions that compound over time.",
  },
];

export const HABITS_BY_DOMAIN: Record<DomainId, HabitDefinition[]> = {
  body: [
    { id: "training_session", label: "Training Session", type: "check", points: 10 },
    { id: "smoothie_collagen", label: "Smoothie + Collagen", type: "check", points: 5 },
    { id: "morning_supplements", label: "Morning Supplements", type: "check", points: 5 },
    { id: "night_stack", label: "Night Stack (Mag)", type: "check", points: 5 },
    { id: "sleep_hours", label: "Sleep Hours", type: "number", points: 8, target: 7 },
    { id: "sleep_quality", label: "Sleep Quality", type: "rating", points: 5, target: 5 },
    { id: "water_120", label: "Water 120+ oz", type: "check", points: 3 },
    { id: "no_alcohol", label: "No Alcohol", type: "check", points: 10 },
    { id: "protein_180", label: "Protein 180g+", type: "check", points: 5 },
    { id: "compex_session", label: "Compex Session", type: "check", points: 3 },
  ],
  spirit: [
    { id: "prayer_devotion", label: "Prayer / Devotion", type: "check", points: 10 },
    { id: "brain_dump", label: "Brain Dump Journal", type: "check", points: 8 },
    { id: "gratitude_three", label: "Gratitude (3 things)", type: "check", points: 5 },
    { id: "church", label: "Church", type: "check", points: 10 },
    { id: "no_screens_prebed", label: "No Screens 30m Pre-Bed", type: "check", points: 5 },
    { id: "meaningful_connection", label: "Meaningful Connection", type: "check", points: 8 },
  ],
  flight: [
    { id: "ground_school", label: "Ground School 30m", type: "check", points: 10 },
    { id: "study_minutes", label: "Study Minutes", type: "number", points: 5, target: 30 },
    { id: "faa_questions", label: "FAA Practice Qs", type: "check", points: 5 },
  ],
  range: [
    { id: "range_session", label: "Range Session", type: "check", points: 10 },
    { id: "dry_fire", label: "Dry Fire Practice", type: "check", points: 5 },
    { id: "accuracy_percent", label: "Accuracy %", type: "number", points: 8, target: 95 },
  ],
  build: [
    { id: "revenue_action", label: "Revenue Action", type: "check", points: 10 },
    { id: "lead_generation", label: "Lead Generation", type: "check", points: 8 },
    { id: "content_marketing", label: "Content / Marketing", type: "check", points: 5 },
  ],
};

export const ALL_HABITS: HabitDefinition[] = Object.values(HABITS_BY_DOMAIN).flat();

export const HABIT_BY_ID: Record<string, HabitDefinition> = ALL_HABITS.reduce(
  (acc, habit) => ({ ...acc, [habit.id]: habit }),
  {} as Record<string, HabitDefinition>,
);

export const KEY_STREAK_HABITS = [
  { id: "no_alcohol", label: "Sober", color: "var(--red)" },
  { id: "training_session", label: "Training", color: "var(--teal)" },
  { id: "study_minutes", label: "Study", color: "var(--gold)" },
] as const;

export const SCRIPTURES = [
  { ref: "Joshua 1:9", text: "Be strong and courageous. Do not be afraid; do not be discouraged." },
  { ref: "Philippians 4:13", text: "I can do all this through Him who gives me strength." },
  { ref: "Proverbs 16:3", text: "Commit to the Lord whatever you do, and He will establish your plans." },
  { ref: "Romans 5:3-4", text: "Suffering produces perseverance; perseverance, character; and character, hope." },
  { ref: "Jeremiah 29:11", text: "For I know the plans I have for you, declares the Lord." },
  { ref: "Isaiah 40:31", text: "Those who hope in the Lord will renew their strength; they will soar on wings like eagles." },
  { ref: "Psalm 23:1", text: "The Lord is my shepherd, I lack nothing." },
];

export const RESET_PROMPTS = [
  "Take a walk. Drink water. Call a friend. Pray.",
  "You do not have to win today. You just have to show up.",
  "The man you are becoming requires the discomfort you are feeling right now.",
  "Step outside. Move your body. The mind follows the body.",
  "Open your journal. Write one sentence. Momentum starts with a single word.",
];

export const DEFAULT_MISSIONS: Mission[] = [
  { id: "mission-muscle", label: "+5 lbs Lean Muscle", target: 5, current: 0, unit: "lbs", domain: "body" },
  { id: "mission-pilot", label: "Private Pilot License", target: 100, current: 0, unit: "%", domain: "flight" },
  { id: "mission-sober", label: "30-Day Sober Challenge", target: 30, current: 0, unit: "days", domain: "spirit" },
  {
    id: "mission-revenue",
    label: "$4M Ecosystem Revenue",
    target: 4_000_000,
    current: 0,
    unit: "$",
    domain: "build",
  },
];
