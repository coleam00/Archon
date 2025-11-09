import type { StateCreator } from "zustand";
import type { ConfiguredRepository } from "../../types/repository";

export type ModalsSlice = {
  // Modal visibility
  showAddRepoModal: boolean;
  showEditRepoModal: boolean;
  showCreateWorkOrderModal: boolean;

  // Modal context (which item is being edited)
  editingRepository: ConfiguredRepository | null;
  preselectedRepositoryId: string | undefined;

  // Actions
  openAddRepoModal: () => void;
  closeAddRepoModal: () => void;
  openEditRepoModal: (repository: ConfiguredRepository) => void;
  closeEditRepoModal: () => void;
  openCreateWorkOrderModal: (repositoryId?: string) => void;
  closeCreateWorkOrderModal: () => void;
  closeAllModals: () => void;
};

/**
 * Modals Slice
 *
 * Manages modal visibility and context (which repository is being edited, etc.).
 * Enables opening modals from anywhere without prop drilling.
 *
 * Persisted: NO (modals should not persist across page reloads)
 *
 * Note: Form state (repositoryUrl, selectedSteps, etc.) can be added to this slice
 * if centralized validation/submission logic is desired. For simple forms that
 * reset on close, local useState in the modal component is cleaner.
 *
 * @example
 * ```typescript
 * // Open modal from anywhere
 * const openEditRepoModal = useAgentWorkOrdersStore((s) => s.openEditRepoModal);
 * openEditRepoModal(repository);
 *
 * // Subscribe to modal state
 * const showEditRepoModal = useAgentWorkOrdersStore((s) => s.showEditRepoModal);
 * const editingRepository = useAgentWorkOrdersStore((s) => s.editingRepository);
 * ```
 */
export const createModalsSlice: StateCreator<ModalsSlice, [], [], ModalsSlice> = (set) => ({
  // Initial state
  showAddRepoModal: false,
  showEditRepoModal: false,
  showCreateWorkOrderModal: false,
  editingRepository: null,
  preselectedRepositoryId: undefined,

  // Actions
  openAddRepoModal: () => set({ showAddRepoModal: true }),

  closeAddRepoModal: () => set({ showAddRepoModal: false }),

  openEditRepoModal: (repository) =>
    set({
      showEditRepoModal: true,
      editingRepository: repository,
    }),

  closeEditRepoModal: () =>
    set({
      showEditRepoModal: false,
      editingRepository: null,
    }),

  openCreateWorkOrderModal: (repositoryId) =>
    set({
      showCreateWorkOrderModal: true,
      preselectedRepositoryId: repositoryId,
    }),

  closeCreateWorkOrderModal: () =>
    set({
      showCreateWorkOrderModal: false,
      preselectedRepositoryId: undefined,
    }),

  closeAllModals: () =>
    set({
      showAddRepoModal: false,
      showEditRepoModal: false,
      showCreateWorkOrderModal: false,
      editingRepository: null,
      preselectedRepositoryId: undefined,
    }),
});
