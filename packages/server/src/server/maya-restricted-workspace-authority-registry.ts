import type { FileHandle } from "node:fs/promises";

export interface MayaRestrictedGitLaunchContext {
  readonly rootHandle: FileHandle;
  readonly gitDirectoryHandle: FileHandle;
  readonly commonDirectoryHandle: FileHandle;
}

export interface MayaRestrictedWorkspaceAuthorityBinding {
  readonly cacheKey: string;
  readonly gitLaunchContext: MayaRestrictedGitLaunchContext | null;
  validateGitAssociation(): Promise<void>;
}

const bindings = new Map<string, MayaRestrictedWorkspaceAuthorityBinding>();
const releaseListeners = new Set<(cacheKey: string) => void>();

export function registerMayaRestrictedWorkspaceAuthorityBinding(
  accessPath: string,
  binding: MayaRestrictedWorkspaceAuthorityBinding,
): () => void {
  if (bindings.has(accessPath)) {
    throw new Error("workspace authority access path is already registered");
  }
  bindings.set(accessPath, binding);
  return () => {
    if (bindings.get(accessPath) !== binding) return;
    bindings.delete(accessPath);
    for (const listener of releaseListeners) listener(binding.cacheKey);
  };
}

export function resolveMayaRestrictedWorkspaceAuthorityBinding(
  accessPath: string,
): MayaRestrictedWorkspaceAuthorityBinding | null {
  return bindings.get(accessPath) ?? null;
}

export function onMayaRestrictedWorkspaceAuthorityReleased(
  listener: (cacheKey: string) => void,
): () => void {
  releaseListeners.add(listener);
  return () => releaseListeners.delete(listener);
}
