import { create } from "zustand";
import type { CanonicalProject, ProjectBundle } from "@aivs/schemas";

export type WorkspacePage = "create" | "story" | "characters" | "scenes" | "storyboard" | "jobs";

export interface PendingAgentProduction {
  project_id: string;
  mode: "fast" | "storyboard";
  resolution: string;
}

interface StudioState {
  bundle?: ProjectBundle;
  page: WorkspacePage;
  dirty: boolean;
  selectedShotId?: string;
  pendingAgentProduction?: PendingAgentProduction;
  setBundle: (bundle?: ProjectBundle) => void;
  setPage: (page: WorkspacePage) => void;
  updateCanonical: (update: (canonical: CanonicalProject) => CanonicalProject) => void;
  setSelectedShotId: (id?: string) => void;
  setPendingAgentProduction: (request?: PendingAgentProduction) => void;
  markSaved: () => void;
}

export const useStudioStore = create<StudioState>((set) => ({
  page: "create",
  dirty: false,
  setBundle: (bundle) => set({ bundle, page: bundle?.canonical ? "story" : "create", dirty: false }),
  setPage: (page) => set({ page }),
  updateCanonical: (update) => set((state) => {
    if (!state.bundle?.canonical) return state;
    return { bundle: { ...state.bundle, canonical: update(state.bundle.canonical) }, dirty: true };
  }),
  setSelectedShotId: (selectedShotId) => set({ selectedShotId }),
  setPendingAgentProduction: (pendingAgentProduction) => set({ pendingAgentProduction }),
  markSaved: () => set({ dirty: false }),
}));
