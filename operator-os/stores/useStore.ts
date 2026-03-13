"use client";

import { create } from "zustand";
import { DEFAULT_MISSIONS } from "@/lib/constants";
import { savePersistedState, loadPersistedState } from "@/lib/storage";
import { DailyLog, DomainId, HabitValue, Mission, WinEntry } from "@/lib/types";
import { todayISO } from "@/lib/time";

interface PersistedState {
  selectedDate: string;
  activeDomain: DomainId;
  dailyLogs: Record<string, DailyLog>;
  wins: Record<string, WinEntry>;
  missions: Mission[];
}

interface OperatorStore extends PersistedState {
  hydrated: boolean;
  hydrate: () => void;
  setSelectedDate: (date: string) => void;
  setActiveDomain: (domain: DomainId) => void;
  setObjective: (index: 0 | 1 | 2, value: string) => void;
  setHabit: (habitId: string, value: HabitValue) => void;
  setWinField: (field: keyof Omit<WinEntry, "date" | "updatedAt">, value: string) => void;
  addMission: (mission: Omit<Mission, "id">) => void;
  updateMission: (id: string, current: number) => void;
}

function createDailyLog(date: string): DailyLog {
  return {
    date,
    objectives: ["", "", ""],
    habits: {},
    updatedAt: new Date().toISOString(),
  };
}

function createWinEntry(date: string): WinEntry {
  return {
    date,
    win: "",
    lesson: "",
    courage: "",
    gratitude: "",
    reflection: "",
    updatedAt: new Date().toISOString(),
  };
}

const defaultState: PersistedState = {
  selectedDate: todayISO(),
  activeDomain: "body",
  dailyLogs: {},
  wins: {},
  missions: DEFAULT_MISSIONS,
};

function persist(slice: OperatorStore) {
  const payload: PersistedState = {
    selectedDate: slice.selectedDate,
    activeDomain: slice.activeDomain,
    dailyLogs: slice.dailyLogs,
    wins: slice.wins,
    missions: slice.missions,
  };
  savePersistedState(payload);
}

export const useStore = create<OperatorStore>((set, get) => ({
  ...defaultState,
  hydrated: false,

  hydrate: () => {
    const restored = loadPersistedState<PersistedState>();
    if (restored) {
      set({ ...restored, hydrated: true });
      return;
    }
    set({ hydrated: true });
  },

  setSelectedDate: (date) => {
    set({ selectedDate: date });
    persist(get());
  },

  setActiveDomain: (domain) => {
    set({ activeDomain: domain });
    persist(get());
  },

  setObjective: (index, value) => {
    const date = get().selectedDate;
    const existing = get().dailyLogs[date] ?? createDailyLog(date);
    const updated: DailyLog = {
      ...existing,
      objectives: existing.objectives.map((item, idx) => (idx === index ? value : item)) as [
        string,
        string,
        string,
      ],
      updatedAt: new Date().toISOString(),
    };
    set((state) => ({ dailyLogs: { ...state.dailyLogs, [date]: updated } }));
    persist(get());
  },

  setHabit: (habitId, value) => {
    const date = get().selectedDate;
    const existing = get().dailyLogs[date] ?? createDailyLog(date);
    const updated: DailyLog = {
      ...existing,
      habits: { ...existing.habits, [habitId]: value },
      updatedAt: new Date().toISOString(),
    };
    set((state) => ({ dailyLogs: { ...state.dailyLogs, [date]: updated } }));
    persist(get());
  },

  setWinField: (field, value) => {
    const date = get().selectedDate;
    const existing = get().wins[date] ?? createWinEntry(date);
    const updated: WinEntry = {
      ...existing,
      [field]: value,
      updatedAt: new Date().toISOString(),
    };
    set((state) => ({ wins: { ...state.wins, [date]: updated } }));
    persist(get());
  },

  addMission: (mission) => {
    const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `mission-${Date.now()}`;
    set((state) => ({ missions: [...state.missions, { ...mission, id }] }));
    persist(get());
  },

  updateMission: (id, current) => {
    set((state) => ({
      missions: state.missions.map((mission) => (mission.id === id ? { ...mission, current } : mission)),
    }));
    persist(get());
  },
}));
