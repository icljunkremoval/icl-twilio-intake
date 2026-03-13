export type DomainId = "body" | "spirit" | "flight" | "range" | "build";

export type HabitType = "check" | "number" | "rating";

export type HabitValue = boolean | number | null;

export interface HabitDefinition {
  id: string;
  label: string;
  type: HabitType;
  points: number;
  target?: number;
  notes?: string;
}

export interface DomainDefinition {
  id: DomainId;
  label: string;
  shortLabel: string;
  color: string;
  icon: string;
  identity: string;
}

export interface DailyLog {
  date: string;
  objectives: [string, string, string];
  habits: Record<string, HabitValue>;
  updatedAt: string;
}

export interface WinEntry {
  date: string;
  win: string;
  lesson: string;
  courage: string;
  gratitude: string;
  reflection: string;
  updatedAt: string;
}

export interface Mission {
  id: string;
  label: string;
  target: number;
  current: number;
  unit: string;
  domain: DomainId;
  archived?: boolean;
}
