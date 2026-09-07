import { create } from "zustand";
import type { CanonicalProject, ProjectBundle } from "@aivs/schemas";

export type WorkspacePage = "create" | "story" | "characters" | "scenes" | "props" | "storyboard" | "jobs";

export interface PendingAgentProduction {
  project_id: string;
  mode: "fast" | "storyboard";
  resolution: string;
}

interface StudioState {
  bundle?: ProjectBundle;
  page: WorkspacePage;
  dirty: boolean;
  revision: number;
  selectedShotId?: string;
  pendingAgentProduction?: PendingAgentProduction;
  setBundle: (bundle?: ProjectBundle) => void;
  setPage: (page: WorkspacePage) => void;
  updateCanonical: (update: (canonical: CanonicalProject) => CanonicalProject) => void;
  setSelectedShotId: (id?: string) => void;
  setPendingAgentProduction: (request?: PendingAgentProduction) => void;
  markSaved: (revision?: number) => void;
}

export const useStudioStore = create<StudioState>((set) => ({
  page: "create",
  dirty: false,
  revision: 0,
  setBundle: (bundle) => set((state) => ({ bundle, page: bundle?.canonical ? "story" : "create", dirty: false, revision: state.revision + 1 })),
  setPage: (page) => set({ page }),
  updateCanonical: (update) => set((state) => {
    if (!state.bundle?.canonical) return state;
    return { bundle: { ...state.bundle, canonical: update(state.bundle.canonical) }, dirty: true, revision: state.revision + 1 };
  }),
  setSelectedShotId: (selectedShotId) => set({ selectedShotId }),
  setPendingAgentProduction: (pendingAgentProduction) => set({ pendingAgentProduction }),
  markSaved: (revision) => set((state) => revision === undefined || state.revision === revision ? { dirty: false } : state),
}));
