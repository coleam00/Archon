import type { StateCreator } from "zustand";

export interface ModalsSlice {
  // Agent Template Modals
  isCreateAgentModalOpen: boolean;
  isEditAgentModalOpen: boolean;
  editingAgentSlug: string | null;
  openCreateAgentModal: () => void;
  closeCreateAgentModal: () => void;
  openEditAgentModal: (slug: string) => void;
  closeEditAgentModal: () => void;

  // Step Template Modals
  isCreateStepModalOpen: boolean;
  isEditStepModalOpen: boolean;
  editingStepSlug: string | null;
  openCreateStepModal: () => void;
  closeCreateStepModal: () => void;
  openEditStepModal: (slug: string) => void;
  closeEditStepModal: () => void;

  // Workflow Template Modals
  isCreateWorkflowModalOpen: boolean;
  isEditWorkflowModalOpen: boolean;
  editingWorkflowSlug: string | null;
  openCreateWorkflowModal: () => void;
  closeCreateWorkflowModal: () => void;
  openEditWorkflowModal: (slug: string) => void;
  closeEditWorkflowModal: () => void;

  // Coding Standards Modals (optional)
  isCreateStandardModalOpen: boolean;
  isEditStandardModalOpen: boolean;
  editingStandardSlug: string | null;
  openCreateStandardModal: () => void;
  closeCreateStandardModal: () => void;
  openEditStandardModal: (slug: string) => void;
  closeEditStandardModal: () => void;

  // Utility
  closeAllModals: () => void;
}

/**
 * Modals Slice
 *
 * Manages modal visibility and editing context for Context Hub.
 * Enables opening modals from anywhere without prop drilling.
 *
 * Persisted: NO (modals should not persist across page reloads)
 *
 * @example
 * ```typescript
 * // Open modal from anywhere
 * const openEditAgentModal = useContextHubStore((s) => s.openEditAgentModal);
 * openEditAgentModal(agentSlug);
 *
 * // Subscribe to modal state
 * const isEditAgentModalOpen = useContextHubStore((s) => s.isEditAgentModalOpen);
 * const editingAgentSlug = useContextHubStore((s) => s.editingAgentSlug);
 * ```
 */
export const createModalsSlice: StateCreator<ModalsSlice, [], [], ModalsSlice> = (set) => ({
  // Agent Template Modals - Initial state
  isCreateAgentModalOpen: false,
  isEditAgentModalOpen: false,
  editingAgentSlug: null,

  // Agent Template Modals - Actions
  openCreateAgentModal: () => set({ isCreateAgentModalOpen: true }),
  closeCreateAgentModal: () => set({ isCreateAgentModalOpen: false }),
  openEditAgentModal: (slug) =>
    set({
      isEditAgentModalOpen: true,
      editingAgentSlug: slug,
    }),
  closeEditAgentModal: () =>
    set({
      isEditAgentModalOpen: false,
      editingAgentSlug: null,
    }),

  // Step Template Modals - Initial state
  isCreateStepModalOpen: false,
  isEditStepModalOpen: false,
  editingStepSlug: null,

  // Step Template Modals - Actions
  openCreateStepModal: () => set({ isCreateStepModalOpen: true }),
  closeCreateStepModal: () => set({ isCreateStepModalOpen: false }),
  openEditStepModal: (slug) =>
    set({
      isEditStepModalOpen: true,
      editingStepSlug: slug,
    }),
  closeEditStepModal: () =>
    set({
      isEditStepModalOpen: false,
      editingStepSlug: null,
    }),

  // Workflow Template Modals - Initial state
  isCreateWorkflowModalOpen: false,
  isEditWorkflowModalOpen: false,
  editingWorkflowSlug: null,

  // Workflow Template Modals - Actions
  openCreateWorkflowModal: () => set({ isCreateWorkflowModalOpen: true }),
  closeCreateWorkflowModal: () => set({ isCreateWorkflowModalOpen: false }),
  openEditWorkflowModal: (slug) =>
    set({
      isEditWorkflowModalOpen: true,
      editingWorkflowSlug: slug,
    }),
  closeEditWorkflowModal: () =>
    set({
      isEditWorkflowModalOpen: false,
      editingWorkflowSlug: null,
    }),

  // Coding Standards Modals - Initial state
  isCreateStandardModalOpen: false,
  isEditStandardModalOpen: false,
  editingStandardSlug: null,

  // Coding Standards Modals - Actions
  openCreateStandardModal: () => set({ isCreateStandardModalOpen: true }),
  closeCreateStandardModal: () => set({ isCreateStandardModalOpen: false }),
  openEditStandardModal: (slug) =>
    set({
      isEditStandardModalOpen: true,
      editingStandardSlug: slug,
    }),
  closeEditStandardModal: () =>
    set({
      isEditStandardModalOpen: false,
      editingStandardSlug: null,
    }),

  // Utility
  closeAllModals: () =>
    set({
      // Agent modals
      isCreateAgentModalOpen: false,
      isEditAgentModalOpen: false,
      editingAgentSlug: null,
      // Step modals
      isCreateStepModalOpen: false,
      isEditStepModalOpen: false,
      editingStepSlug: null,
      // Workflow modals
      isCreateWorkflowModalOpen: false,
      isEditWorkflowModalOpen: false,
      editingWorkflowSlug: null,
      // Standards modals
      isCreateStandardModalOpen: false,
      isEditStandardModalOpen: false,
      editingStandardSlug: null,
    }),
});
