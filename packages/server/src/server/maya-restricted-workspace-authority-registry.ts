import type { FileHandle } from "node:fs/promises";

export interface MayaRestrictedGitLaunchContext {
  readonly rootHandle: FileHandle;
  readonly gitDirectoryHandle: FileHandle;
  readonly commonDirectoryHandle: FileHandle;
}

export interface MayaRestrictedWorkspaceAuthorityBinding {
  readonly cacheKey: string;
  readonly cwd: string;
  readonly rootAccessPath: string;
  readonly gitLaunchContext: MayaRestrictedGitLaunchContext | null;
  validateGitAssociation(): Promise<void>;
}

const bindingsByPath = new Map<string, MayaRestrictedWorkspaceAuthorityBinding>();
const releaseListeners = new Set<(cacheKey: string) => void>();

export function registerMayaRestrictedWorkspaceAuthorityBinding(
  binding: MayaRestrictedWorkspaceAuthorityBinding,
): () => void {
  if (bindingsByPath.has(binding.cwd) || bindingsByPath.has(binding.rootAccessPath)) {
    throw new Error("workspace authority path is already registered");
  }
  bindingsByPath.set(binding.cwd, binding);
  bindingsByPath.set(binding.rootAccessPath, binding);
  return () => {
    if (bindingsByPath.get(binding.rootAccessPath) !== binding) return;
    bindingsByPath.delete(binding.cwd);
    bindingsByPath.delete(binding.rootAccessPath);
    for (const listener of releaseListeners) listener(binding.cacheKey);
  };
}

export function resolveMayaRestrictedWorkspaceAuthorityBinding(
  path: string,
): MayaRestrictedWorkspaceAuthorityBinding | null {
  return bindingsByPath.get(path) ?? null;
}

export function onMayaRestrictedWorkspaceAuthorityReleased(
  listener: (cacheKey: string) => void,
): () => void {
  releaseListeners.add(listener);
  return () => releaseListeners.delete(listener);
}
