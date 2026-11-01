import type { SaveSlot, Snapshot } from "./types";

const SAVES_KEY = "amehare.saves.v1";
const GLOBALS_KEY = "amehare.globals.v1";

export interface Globals {
  vars: Record<number, number>;
  strs: Record<number, string>;
}

export class SaveStore {
  private slots: Record<number, SaveSlot> = {};

  constructor() {
    this.reload();
  }

  reload(): void {
    try {
      const raw = localStorage.getItem(SAVES_KEY);
      this.slots = raw ? (JSON.parse(raw) as Record<number, SaveSlot>) : {};
      for (const [k, s] of Object.entries(this.slots)) {
        if (s.snapshot?.version !== 2) delete this.slots[Number(k)];
      }
    } catch {
      this.slots = {};
    }
  }

  get(slot: number): SaveSlot | null {
    return this.slots[slot] ?? null;
  }

  put(slot: number, snapshot: Snapshot): SaveSlot {
    const savedAt = Date.now();
    const meta = {
      slot,
      savedAt,
      chapter: snapshot.chapter,
      location: snapshot.location,
      image: snapshot.bg ?? "",
    };
    const s: SaveSlot = { meta, snapshot: { ...snapshot, savedAt } };
    this.slots[slot] = s;
    this.persist();
    return s;
  }

  remove(slot: number): void {
    delete this.slots[slot];
    this.persist();
  }

  all(): SaveSlot[] {
    return Object.values(this.slots).sort((a, b) => b.meta.savedAt - a.meta.savedAt);
  }

  dateParts(slot: number): { month: number; day: number; hour: number; minute: number } {
    const s = this.slots[slot];
    if (!s) return { month: 0, day: 0, hour: 0, minute: 0 };
    const d = new Date(s.meta.savedAt);
    return {
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
    };
  }

  loadGlobals(): Globals | null {
    try {
      const raw = localStorage.getItem(GLOBALS_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as Globals;
    } catch {
      return null;
    }
  }

  saveGlobals(g: Globals): void {
    try {
      localStorage.setItem(GLOBALS_KEY, JSON.stringify(g));
    } catch {
      /* quota */
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(SAVES_KEY, JSON.stringify(this.slots));
    } catch {
      /* quota */
    }
  }
}
