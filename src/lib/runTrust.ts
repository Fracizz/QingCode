/**
 * @deprecated Prefer `workspaceTrust` — kept as a thin re-export for existing imports.
 */
export {
  RUN_TRUST_STORAGE_KEY,
  RUN_TRUST_CHANGED_EVENT,
  WORKSPACE_TRUST_STORAGE_KEY,
  WORKSPACE_TRUST_CHANGED_EVENT,
  normalizeProjectPath,
  getWorkspaceTrust,
  isProjectTrusted,
  isProjectRestricted,
  trustProject,
  restrictProject,
  untrustProject,
  pushTrustedRootsToNative,
  ensureWorkspaceTrust,
  type WorkspaceTrustLevel,
} from './workspaceTrust'
