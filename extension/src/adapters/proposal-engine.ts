// Proposal engine barrel: the provider-agnostic core shared by BOTH adapters -
// building edit/nav/memory proposal previews, applying them (commit/PR), and the
// repo memory + recent-activity context.
//
// The implementation now lives in focused modules (proposal-nav / proposal-edit
// / proposal-memory / proposal-apply / proposal-shared) and repo-context. This
// file re-exports the public surface so the adapters, the service worker, and
// the tests that import from "./proposal-engine" keep working unchanged - and so
// a single bundle shares one repo-context instance (the memory/activity caches).

export { anchorFromFind, toHistory } from "./proposal-shared";
export { buildNavProposalPreview } from "./proposal-nav";
export { buildEditProposalPreview, buildCreatePageProposalPreview } from "./proposal-edit";
export { mergeMemoryEntry, buildMemoryProposalPreview } from "./proposal-memory";
export { applyPendingProposal } from "./proposal-apply";
export {
  MEMORY_PATH,
  invalidateCachesAfterApply,
  getRepoMemory,
  getRecentActivity,
  formatMemoryBlock,
  formatActivityBlock,
} from "./repo-context";
