// Name of the mount manifest inside a workspace entry (workspace-fs/entry.ts). Kept apart from
// the filesystem code so the store's mount checks (store/sql/workspaces.ts) can refuse a mount of
// this name without loading it. The name is visible (no leading dot): search tools skip hidden
// files by default, and agents are pointed at this file.
export const MANIFEST_NAME = "cove-workspace.json";
