import { resolve } from "node:path";
import type pino from "pino";
import type { WorkspaceDescriptorPayload } from "../../messages.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
} from "../../workspace-git-service.js";
import {
  openMayaRestrictedWorkspaceAuthority,
  type MayaRestrictedWorkspaceAuthority,
} from "../../maya-restricted-mode.js";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";

const WORKSPACE_GIT_WATCH_REMOVED_STATE_KEY = "__removed__";

interface WorkspaceGitWatchTarget {
  workspaceIds: Set<string>;
}

interface WorkspaceGitWatchState {
  cwd: string;
  latestDescriptorStateKey: string | null;
  lastBranchName: string | null;
}

export interface WorkspaceGitObserverMetrics {
  watchedDirectoryCount: number;
  workspaceRecordCount: number;
  subscriptionCount: number;
}

/**
 * Observes a workspace's git state on disk (via WorkspaceGitService) and drives the
 * live update fan-out: branch-change notifications, workspace-card refreshes, and
 * checkout status updates. It owns the per-cwd watch targets and the WorkspaceGitService
 * subscription handles. Filesystem subscriptions are keyed by cwd while descriptor and
 * branch state remain keyed by workspace id, so same-directory workspace records share one
 * watch without sharing identity or teardown lifetime.
 *
 * Branch changes reach `onBranchChanged` from two paths that share `lastBranchName`: the
 * on-disk snapshot listener (handleBranchSnapshot) and the workspace-emit loop's Git runtime
 * projection (recordDescriptorState). Both stay inside this module so the shared state is coherent.
 */
export interface WorkspaceGitObserverService {
  syncObservers(workspaces: Iterable<WorkspaceDescriptorPayload>): void;
  syncMayaRestrictedObservers(workspaces: Iterable<WorkspaceDescriptorPayload>): Promise<void>;
  syncObserverForWorkspace(workspace: PersistedWorkspaceRecord): Promise<void>;
  warmGitData(workspace: PersistedWorkspaceRecord): Promise<void>;
  // Check-and-record dedupe gate: returns true when the descriptor state is unchanged
  // for this workspace, and otherwise advances the recorded state key as a side effect.
  shouldSkipUpdate(workspaceId: string, workspace: WorkspaceDescriptorPayload | null): boolean;
  recordDescriptorState(workspaceId: string, workspace: WorkspaceDescriptorPayload | null): void;
  handleBranchSnapshot(cwd: string, branchName: string | null): void;
  getMetrics(): WorkspaceGitObserverMetrics;
  removeForWorkspaceId(workspaceId: string): void;
  dispose(): void;
}

export function createWorkspaceGitObserverService(deps: {
  workspaceGitService: Pick<WorkspaceGitService, "registerWorkspace">;
  describeWorkspaceRecordWithGitData: (
    workspace: PersistedWorkspaceRecord,
  ) => Promise<WorkspaceDescriptorPayload>;
  emitWorkspaceUpdateForCwd: (cwd: string) => Promise<void>;
  emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
  emitStatusUpdate: (cwd: string, snapshot: WorkspaceGitRuntimeSnapshot) => void;
  onBranchChanged?: (
    workspaceId: string,
    oldBranch: string | null,
    newBranch: string | null,
  ) => void;
  logger: pino.Logger;
  openMayaRestrictedWorkspaceAuthority?: typeof openMayaRestrictedWorkspaceAuthority;
}): WorkspaceGitObserverService {
  const {
    workspaceGitService,
    describeWorkspaceRecordWithGitData,
    emitWorkspaceUpdateForCwd,
    emitWorkspaceUpdateForWorkspaceId,
    emitStatusUpdate,
    onBranchChanged,
    logger,
  } = deps;
  const openRestrictedAuthority =
    deps.openMayaRestrictedWorkspaceAuthority ?? openMayaRestrictedWorkspaceAuthority;

  const watchTargets = new Map<string, WorkspaceGitWatchTarget>();
  const workspaceStates = new Map<string, WorkspaceGitWatchState>();
  const subscriptions = new Map<
    string,
    { unsubscribe: () => void; authority: MayaRestrictedWorkspaceAuthority | null }
  >();

  function descriptorStateKey(workspace: WorkspaceDescriptorPayload | null): string {
    if (!workspace) {
      return WORKSPACE_GIT_WATCH_REMOVED_STATE_KEY;
    }
    return JSON.stringify([
      workspace.name,
      workspace.diffStat ? [workspace.diffStat.additions, workspace.diffStat.deletions] : null,
    ]);
  }

  function rememberDescriptorState(
    workspaceId: string,
    workspace: WorkspaceDescriptorPayload | null,
  ): void {
    const state = workspaceStates.get(workspaceId);
    if (!state) {
      return;
    }
    state.latestDescriptorStateKey = descriptorStateKey(workspace);
    const currentBranch = workspace?.gitRuntime?.currentBranch;
    if (currentBranch !== undefined) {
      state.lastBranchName = currentBranch;
    }
  }

  function removeForCwd(cwd: string): void {
    const normalizedCwd = resolve(cwd);
    const target = watchTargets.get(normalizedCwd);
    for (const workspaceId of target?.workspaceIds ?? []) {
      workspaceStates.delete(workspaceId);
    }
    watchTargets.delete(normalizedCwd);
    const subscription = subscriptions.get(normalizedCwd);
    subscription?.unsubscribe();
    subscriptions.delete(normalizedCwd);
    if (subscription?.authority) {
      void subscription.authority.release().catch((error) => {
        logger.warn(
          { err: error, cwd: normalizedCwd },
          "Failed to release Maya workspace observer authority",
        );
      });
    }
  }

  function removeForWorkspaceId(workspaceId: string): void {
    const state = workspaceStates.get(workspaceId);
    if (!state) {
      return;
    }
    workspaceStates.delete(workspaceId);
    const target = watchTargets.get(state.cwd);
    target?.workspaceIds.delete(workspaceId);
    if (target?.workspaceIds.size === 0) {
      removeForCwd(state.cwd);
    }
  }

  function handleBranchSnapshot(cwd: string, branchName: string | null): void {
    const target = watchTargets.get(resolve(cwd));
    if (!target) {
      return;
    }

    for (const workspaceId of target.workspaceIds) {
      const state = workspaceStates.get(workspaceId);
      if (!state) {
        continue;
      }
      const previousBranchName = state.lastBranchName;
      if (branchName === previousBranchName) {
        continue;
      }
      state.lastBranchName = branchName;
      onBranchChanged?.(workspaceId, previousBranchName, branchName);
    }
  }

  function syncObserver(
    cwd: string,
    options: { isGit: boolean; workspaceId: string },
    authority: MayaRestrictedWorkspaceAuthority | null = null,
  ): void {
    const normalizedCwd = resolve(cwd);
    const currentState = workspaceStates.get(options.workspaceId);
    if (currentState && currentState.cwd !== normalizedCwd) {
      removeForWorkspaceId(options.workspaceId);
    }
    if (!options.isGit) {
      removeForWorkspaceId(options.workspaceId);
      return;
    }

    const target = watchTargets.get(normalizedCwd) ?? {
      workspaceIds: new Set<string>(),
    };
    watchTargets.set(normalizedCwd, target);
    target.workspaceIds.add(options.workspaceId);
    if (!workspaceStates.has(options.workspaceId)) {
      workspaceStates.set(options.workspaceId, {
        cwd: normalizedCwd,
        latestDescriptorStateKey: null,
        lastBranchName: null,
      });
    }

    if (subscriptions.has(normalizedCwd)) {
      if (authority) void authority.release();
      return;
    }

    let subscription: ReturnType<WorkspaceGitService["registerWorkspace"]>;
    try {
      subscription = workspaceGitService.registerWorkspace({ cwd: normalizedCwd }, (snapshot) => {
        const currentSubscription = subscriptions.get(normalizedCwd);
        if (currentSubscription?.authority) {
          void emitRestrictedSnapshot(normalizedCwd, snapshot, currentSubscription);
          return;
        }
        handleBranchSnapshot(normalizedCwd, snapshot.git.currentBranch ?? null);
        void emitWorkspaceUpdateForCwd(normalizedCwd).catch((error) => {
          logger.warn(
            { err: error, cwd: normalizedCwd },
            "Failed to emit workspace update after git branch snapshot",
          );
        });
        emitStatusUpdate(normalizedCwd, snapshot);
      });
    } catch (error) {
      removeForWorkspaceId(options.workspaceId);
      if (authority) void authority.release();
      throw error;
    }
    subscriptions.set(normalizedCwd, { unsubscribe: subscription.unsubscribe, authority });
  }

  async function emitRestrictedSnapshot(
    cwd: string,
    snapshot: WorkspaceGitRuntimeSnapshot,
    subscription: {
      unsubscribe: () => void;
      authority: MayaRestrictedWorkspaceAuthority | null;
    },
  ): Promise<void> {
    const authority = subscription.authority;
    if (!authority || subscriptions.get(cwd) !== subscription) return;
    if (!(await authority.isCurrent())) {
      removeForCwd(cwd);
      return;
    }
    handleBranchSnapshot(cwd, snapshot.git.currentBranch ?? null);
    try {
      await emitWorkspaceUpdateForCwd(cwd);
    } catch (error) {
      logger.warn({ err: error, cwd }, "Failed to emit workspace update after git branch snapshot");
    }
    if (subscriptions.get(cwd) === subscription) emitStatusUpdate(cwd, snapshot);
  }

  function syncObservers(workspaces: Iterable<WorkspaceDescriptorPayload>): void {
    for (const workspace of workspaces) {
      syncObserver(workspace.workspaceDirectory, {
        isGit: workspace.workspaceKind !== "directory",
        workspaceId: workspace.id,
      });
      rememberDescriptorState(workspace.id, workspace);
    }
  }

  async function syncMayaRestrictedObservers(
    workspaces: Iterable<WorkspaceDescriptorPayload>,
  ): Promise<void> {
    for (const workspace of workspaces) {
      const isGit = workspace.workspaceKind !== "directory";
      const cwd = resolve(workspace.workspaceDirectory);
      if (!isGit) {
        syncObserver(cwd, { isGit, workspaceId: workspace.id });
        rememberDescriptorState(workspace.id, workspace);
        continue;
      }

      const existingSubscription = subscriptions.get(cwd);
      if (existingSubscription && !existingSubscription.authority) removeForCwd(cwd);
      const existing = subscriptions.get(cwd)?.authority;
      if (existing) {
        if (existing.workspaceId !== workspace.id || !(await existing.isCurrent())) {
          removeForCwd(cwd);
          throw new Error("workspace observer authority no longer matches the catalog");
        }
        syncObserver(cwd, { isGit, workspaceId: workspace.id });
        rememberDescriptorState(workspace.id, workspace);
        continue;
      }

      const authority = await openRestrictedAuthority(cwd);
      if (authority.workspaceId !== workspace.id) {
        await authority.release();
        throw new Error("workspace observer authority does not match the catalog");
      }
      syncObserver(cwd, { isGit, workspaceId: workspace.id }, authority);
      rememberDescriptorState(workspace.id, workspace);
    }
  }

  async function syncObserverForWorkspace(workspace: PersistedWorkspaceRecord): Promise<void> {
    const descriptor = await describeWorkspaceRecordWithGitData(workspace);
    syncObservers([descriptor]);
  }

  return {
    syncObservers,
    syncMayaRestrictedObservers,
    syncObserverForWorkspace,

    async warmGitData(workspace) {
      await syncObserverForWorkspace(workspace);
      await emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
    },

    shouldSkipUpdate(workspaceId, workspace) {
      const state = workspaceStates.get(workspaceId);
      if (!state) {
        return false;
      }
      const nextStateKey = descriptorStateKey(workspace);
      if (state.latestDescriptorStateKey === nextStateKey) {
        return true;
      }
      state.latestDescriptorStateKey = nextStateKey;
      return false;
    },

    recordDescriptorState(workspaceId, nextWorkspace) {
      const state = workspaceStates.get(workspaceId);
      const newBranchName = nextWorkspace?.gitRuntime?.currentBranch;
      if (state && onBranchChanged && newBranchName !== undefined) {
        if (newBranchName !== state.lastBranchName) {
          onBranchChanged(workspaceId, state.lastBranchName, newBranchName);
        }
      }
      rememberDescriptorState(workspaceId, nextWorkspace);
    },

    handleBranchSnapshot,

    getMetrics() {
      return {
        watchedDirectoryCount: watchTargets.size,
        workspaceRecordCount: workspaceStates.size,
        subscriptionCount: subscriptions.size,
      };
    },

    removeForWorkspaceId,

    dispose() {
      for (const cwd of [...subscriptions.keys()]) removeForCwd(cwd);
      watchTargets.clear();
      workspaceStates.clear();
    },
  };
}
