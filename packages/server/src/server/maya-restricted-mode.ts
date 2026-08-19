import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import type { SessionInboundMessage } from "./messages.js";
import { registerMayaRestrictedWorkspaceAuthorityBinding } from "./maya-restricted-workspace-authority-registry.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";

export const MAYA_RESTRICTED_ALLOWED_SESSION_MESSAGE_TYPES = [
  "fetch_agents_request",
  "fetch_agent_history_request",
  "fetch_workspaces_request",
  "project.list.request",
  "fetch_agent_request",
  "delete_agent_request",
  "archive_agent_request",
  "close_items_request",
  "update_agent_request",
  "send_agent_message_request",
  "wait_for_finish_request",
  "create_agent_request",
  "list_provider_models_request",
  "list_provider_modes_request",
  "list_available_providers_request",
  "get_providers_snapshot_request",
  "refresh_providers_snapshot_request",
  "provider_diagnostic_request",
  "provider.usage.list.request",
  "cancel_agent_request",
  "fetch_agent_timeline_request",
  "agent.timeline.list_prompts.request",
  "agent.timeline.set_subscription.request",
  "agent_permission_response",
  "checkout_status_request",
  "subscribe_checkout_diff_request",
  "unsubscribe_checkout_diff_request",
  "checkout.commits.list.request",
  "checkout.commits.file_diff.request",
  "checkout.refresh.request",
  "workspace_setup_status_request",
  "workspace.clear_attention.request",
  "file_explorer_request",
  "fs.file.subscribe.request",
  "fs.file.unsubscribe.request",
  "clear_agent_attention",
  "client_heartbeat",
  "ping",
  "list_commands_request",
] as const satisfies readonly SessionInboundMessage["type"][];

export interface MayaRestrictedModeDecision {
  allowed: boolean;
  reason: string;
}

type RestrictedWorkspace = Pick<PersistedWorkspaceRecord, "workspaceId" | "cwd" | "archivedAt">;

const ALLOWED = { allowed: true, reason: "allowed" } as const;
const MAYA_WORKSPACE_IDENTITY_DOMAIN = "maya-paseo-workspace-identity-v1";
const MAX_GIT_LINK_BYTES = 4096;
const OPEN_DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const OPEN_FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
let nextAuthorityCacheId = 1;
const activeAuthorities = new Map<string, OpenMayaRestrictedWorkspaceAuthority>();
const authorityOpenPromises = new Map<string, Promise<OpenMayaRestrictedWorkspaceAuthority>>();

export interface MayaRestrictedWorkspaceAuthority {
  readonly cwd: string;
  readonly workspaceId: string;
  readonly rootAccessPath: string;
  retain(): MayaRestrictedWorkspaceAuthority;
  release(): Promise<void>;
  isCurrent(): Promise<boolean>;
}

class OpenMayaRestrictedWorkspaceAuthority implements MayaRestrictedWorkspaceAuthority {
  private references = 1;
  private unregisterBinding: (() => void) | null = null;

  constructor(
    readonly cwd: string,
    readonly workspaceId: string,
    readonly rootAccessPath: string,
    private readonly rootHandle: FileHandle,
    private readonly dotGitHandle: FileHandle | null,
    private readonly gitDirectoryHandle: FileHandle,
    private readonly commonDirectoryHandle: FileHandle,
  ) {}

  activateBinding(): void {
    if (this.unregisterBinding) throw new Error("workspace authority is already active");
    const cacheId = nextAuthorityCacheId;
    nextAuthorityCacheId += 1;
    this.unregisterBinding = registerMayaRestrictedWorkspaceAuthorityBinding({
      cacheKey: `maya-restricted:${this.workspaceId}:${cacheId}`,
      cwd: this.cwd,
      rootAccessPath: this.rootAccessPath,
      gitLaunchContext: {
        rootHandle: this.rootHandle,
        gitDirectoryHandle: this.gitDirectoryHandle,
        commonDirectoryHandle: this.commonDirectoryHandle,
      },
      validateGitAssociation: () => this.validateGitAssociation(),
    });
    activeAuthorities.set(this.cwd, this);
  }

  retain(): MayaRestrictedWorkspaceAuthority {
    if (this.references === 0) throw new Error("workspace authority is closed");
    this.references += 1;
    return this;
  }

  async release(): Promise<void> {
    if (this.references === 0) return;
    this.references -= 1;
    if (this.references !== 0) return;
    this.unregisterBinding?.();
    this.unregisterBinding = null;
    if (activeAuthorities.get(this.cwd) === this) activeAuthorities.delete(this.cwd);
    await closeUniqueHandles([
      this.rootHandle,
      this.dotGitHandle,
      this.gitDirectoryHandle,
      this.commonDirectoryHandle,
    ]);
  }

  async isCurrent(): Promise<boolean> {
    try {
      await this.validateGitAssociation();
      return true;
    } catch {
      return false;
    }
  }

  async validateGitAssociation(): Promise<void> {
    const currentRoot = await fs.realpath(this.cwd);
    const [boundRoot, currentRootMetadata, boundRootMetadata] = await Promise.all([
      fs.realpath(this.rootAccessPath),
      fs.lstat(currentRoot, { bigint: true }),
      this.rootHandle.stat({ bigint: true }),
    ]);
    if (
      currentRoot !== this.cwd ||
      boundRoot !== this.cwd ||
      !sameFile(currentRootMetadata, boundRootMetadata)
    ) {
      throw new Error("workspace root association changed");
    }

    const currentDotGit = path.join(this.cwd, ".git");
    const currentDotGitMetadata = await fs.lstat(currentDotGit, {
      bigint: true,
    });
    const gitDirectoryAccessPath = `/proc/self/fd/${this.gitDirectoryHandle.fd}`;
    const boundGitDirectoryMetadata = await this.gitDirectoryHandle.stat({
      bigint: true,
    });
    if (this.dotGitHandle === null) {
      if (
        !currentDotGitMetadata.isDirectory() ||
        !sameFile(currentDotGitMetadata, boundGitDirectoryMetadata)
      ) {
        throw new Error("workspace Git directory association changed");
      }
    } else {
      const boundDotGitMetadata = await this.dotGitHandle.stat({
        bigint: true,
      });
      if (
        !currentDotGitMetadata.isFile() ||
        !sameFile(currentDotGitMetadata, boundDotGitMetadata)
      ) {
        throw new Error("workspace .git association changed");
      }
      const selectedGitDirectory = await readBoundedGitPathHandle(
        this.dotGitHandle,
        "gitdir: ",
        this.rootAccessPath,
      );
      await requireDirectoryIdentity(selectedGitDirectory, boundGitDirectoryMetadata);

      const backpointerHandle = await fs.open(
        path.join(gitDirectoryAccessPath, "gitdir"),
        OPEN_FILE_FLAGS,
      );
      try {
        const selectedDotGit = await readBoundedGitPathHandle(
          backpointerHandle,
          "",
          gitDirectoryAccessPath,
        );
        await requireFileIdentity(selectedDotGit, boundDotGitMetadata);
      } finally {
        await backpointerHandle.close();
      }
    }

    const commonDirectoryMetadata = await this.commonDirectoryHandle.stat({
      bigint: true,
    });
    const commondirPath = path.join(gitDirectoryAccessPath, "commondir");
    try {
      const commondirHandle = await fs.open(commondirPath, OPEN_FILE_FLAGS);
      try {
        const selectedCommonDirectory = await readBoundedGitPathHandle(
          commondirHandle,
          "",
          gitDirectoryAccessPath,
        );
        await requireDirectoryIdentity(selectedCommonDirectory, commonDirectoryMetadata);
      } finally {
        await commondirHandle.close();
      }
    } catch (error) {
      if (this.dotGitHandle !== null || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      if (!sameFile(boundGitDirectoryMetadata, commonDirectoryMetadata)) {
        throw new Error("main worktree common directory association changed");
      }
    }
  }
}

function sameFile(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function closeUniqueHandles(handles: Array<FileHandle | null>): Promise<void> {
  const unique = new Map<number, FileHandle>();
  for (const handle of handles) {
    if (handle) unique.set(handle.fd, handle);
  }
  await Promise.allSettled([...unique.values()].map((handle) => handle.close()));
}

async function requireDirectoryIdentity(
  directory: string,
  expected: { dev: bigint; ino: bigint },
): Promise<void> {
  const metadata = await fs.lstat(directory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !sameFile(metadata, expected)) {
    throw new Error("Git directory identity changed");
  }
}

async function requireFileIdentity(
  file: string,
  expected: { dev: bigint; ino: bigint },
): Promise<void> {
  const metadata = await fs.lstat(file, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || !sameFile(metadata, expected)) {
    throw new Error("Git file identity changed");
  }
}

function denied(reason: string): MayaRestrictedModeDecision {
  return { allowed: false, reason };
}

function isActiveWorkspaceCwd(cwd: string, workspaces: readonly RestrictedWorkspace[]): boolean {
  return workspaces.some((workspace) => workspace.archivedAt === null && workspace.cwd === cwd);
}

function isActiveWorkspaceId(
  workspaceId: string,
  workspaces: readonly RestrictedWorkspace[],
): boolean {
  return workspaces.some(
    (workspace) => workspace.archivedAt === null && workspace.workspaceId === workspaceId,
  );
}

function evaluateRegisteredCwd(
  cwd: string,
  workspaces: readonly RestrictedWorkspace[],
): MayaRestrictedModeDecision {
  return isActiveWorkspaceCwd(cwd, workspaces)
    ? ALLOWED
    : denied("cwd is not an active pre-registered workspace");
}

export function isMayaRestrictedWorkspaceReadRequest(
  message: SessionInboundMessage,
): message is Extract<
  SessionInboundMessage,
  {
    type:
      | "checkout_status_request"
      | "subscribe_checkout_diff_request"
      | "checkout.commits.list.request"
      | "checkout.commits.file_diff.request"
      | "checkout.refresh.request"
      | "file_explorer_request"
      | "fs.file.subscribe.request";
  }
> {
  switch (message.type) {
    case "checkout_status_request":
    case "subscribe_checkout_diff_request":
    case "checkout.commits.list.request":
    case "checkout.commits.file_diff.request":
    case "checkout.refresh.request":
    case "file_explorer_request":
    case "fs.file.subscribe.request":
      return true;
    default:
      return false;
  }
}

/** Opens and binds the exact host-catalog identity used by downstream readers. */
async function openFreshMayaRestrictedWorkspaceAuthority(
  cwd: string,
): Promise<OpenMayaRestrictedWorkspaceAuthority> {
  if (process.platform !== "linux") throw new Error("Maya restricted mode requires Linux");
  const expectedRoot = path.resolve(cwd);
  const rootHandle = await fs.open(expectedRoot, OPEN_DIRECTORY_FLAGS);
  let dotGitHandle: FileHandle | null = null;
  let gitDirectoryHandle: FileHandle | null = null;
  let commonDirectoryHandle: FileHandle | null = null;
  try {
    const rootAccessPath = `/proc/self/fd/${rootHandle.fd}`;
    const [root, rootMetadata] = await Promise.all([
      fs.realpath(rootAccessPath),
      rootHandle.stat({ bigint: true }),
    ]);
    if (root !== expectedRoot || !rootMetadata.isDirectory()) {
      throw new Error("workspace root is not the canonical directory");
    }

    const dotGit = path.join(rootAccessPath, ".git");
    const dotGitMetadata = await fs.lstat(dotGit, { bigint: true });
    let commonDirectory: string;
    if (dotGitMetadata.isDirectory() && !dotGitMetadata.isSymbolicLink()) {
      gitDirectoryHandle = await fs.open(dotGit, OPEN_DIRECTORY_FLAGS);
      commonDirectory = `/proc/self/fd/${gitDirectoryHandle.fd}`;
      commonDirectoryHandle = gitDirectoryHandle;
    } else if (dotGitMetadata.isFile() && !dotGitMetadata.isSymbolicLink()) {
      dotGitHandle = await fs.open(dotGit, OPEN_FILE_FLAGS);
      const gitDirectory = await readBoundedGitPathHandle(dotGitHandle, "gitdir: ", rootAccessPath);
      gitDirectoryHandle = await fs.open(gitDirectory, OPEN_DIRECTORY_FLAGS);
      const gitDirectoryAccessPath = `/proc/self/fd/${gitDirectoryHandle.fd}`;
      const commondirHandle = await fs.open(
        path.join(gitDirectoryAccessPath, "commondir"),
        OPEN_FILE_FLAGS,
      );
      try {
        commonDirectory = await readBoundedGitPathHandle(
          commondirHandle,
          "",
          gitDirectoryAccessPath,
        );
      } finally {
        await commondirHandle.close();
      }
    } else {
      throw new Error("workspace .git entry is unsafe");
    }

    commonDirectoryHandle ??= await fs.open(commonDirectory, OPEN_DIRECTORY_FLAGS);
    const commonDirectoryAccessPath = `/proc/self/fd/${commonDirectoryHandle.fd}`;
    const [canonicalCommonDirectory, commonMetadata, finalRoot, finalRootMetadata] =
      await Promise.all([
        fs.realpath(commonDirectoryAccessPath),
        commonDirectoryHandle.stat({ bigint: true }),
        fs.realpath(rootAccessPath),
        rootHandle.stat({ bigint: true }),
      ]);
    if (!commonMetadata.isDirectory()) throw new Error("Git common directory is unsafe");
    if (
      finalRoot !== root ||
      !finalRootMetadata.isDirectory() ||
      finalRootMetadata.dev !== rootMetadata.dev ||
      finalRootMetadata.ino !== rootMetadata.ino
    ) {
      throw new Error("workspace root changed during identity validation");
    }

    const digest = createHash("sha256");
    for (const field of [
      MAYA_WORKSPACE_IDENTITY_DOMAIN,
      root,
      `${rootMetadata.dev}:${rootMetadata.ino}`,
      canonicalCommonDirectory,
      `${commonMetadata.dev}:${commonMetadata.ino}`,
    ]) {
      digest.update(field);
      digest.update("\0");
    }
    if (!gitDirectoryHandle) throw new Error("workspace Git directory is absent");
    const authority = new OpenMayaRestrictedWorkspaceAuthority(
      root,
      `wks_${digest.digest("hex").slice(0, 16)}`,
      rootAccessPath,
      rootHandle,
      dotGitHandle,
      gitDirectoryHandle,
      commonDirectoryHandle,
    );
    await authority.validateGitAssociation();
    authority.activateBinding();
    return authority;
  } catch (error) {
    await closeUniqueHandles([rootHandle, dotGitHandle, gitDirectoryHandle, commonDirectoryHandle]);
    throw error;
  }
}

export async function openMayaRestrictedWorkspaceAuthority(
  cwd: string,
): Promise<MayaRestrictedWorkspaceAuthority> {
  const expectedRoot = path.resolve(cwd);
  const existing = activeAuthorities.get(expectedRoot);
  if (existing) {
    existing.retain();
    try {
      await existing.validateGitAssociation();
      return existing;
    } catch (error) {
      await existing.release();
      throw error;
    }
  }

  const pending = authorityOpenPromises.get(expectedRoot);
  if (pending) {
    const authority = await pending;
    authority.retain();
    return authority;
  }

  const opening = openFreshMayaRestrictedWorkspaceAuthority(expectedRoot);
  authorityOpenPromises.set(expectedRoot, opening);
  try {
    return await opening;
  } finally {
    if (authorityOpenPromises.get(expectedRoot) === opening) {
      authorityOpenPromises.delete(expectedRoot);
    }
  }
}

/** Recomputes the exact host-catalog identity from the live checkout. */
export async function deriveMayaRestrictedWorkspaceId(cwd: string): Promise<string> {
  const authority = await openMayaRestrictedWorkspaceAuthority(cwd);
  try {
    return authority.workspaceId;
  } finally {
    await authority.release();
  }
}

async function readBoundedGitPathHandle(
  handle: FileHandle,
  prefix: string,
  relativeTo: string,
): Promise<string> {
  const metadata = await handle.stat({ bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size === 0n ||
    metadata.size > BigInt(MAX_GIT_LINK_BYTES)
  ) {
    throw new Error("Git path indirection is unsafe");
  }
  const bytes = Buffer.alloc(Number(metadata.size));
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
  if (bytesRead !== bytes.length) throw new Error("Git path indirection changed while reading");
  const raw = bytes.toString("utf8");
  if (raw.includes("\0")) throw new Error("Git path indirection is malformed");
  const value = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (value.includes("\n") || !value.startsWith(prefix) || value.length === prefix.length) {
    throw new Error("Git path indirection is malformed");
  }
  const target = value.slice(prefix.length);
  return fs.realpath(path.isAbsolute(target) ? target : `${relativeTo}/${target}`);
}

export async function acquireMayaRestrictedWorkspaceReadAuthority(
  message: SessionInboundMessage,
  workspaces: readonly RestrictedWorkspace[],
): Promise<MayaRestrictedWorkspaceAuthority | null> {
  if (!isMayaRestrictedWorkspaceReadRequest(message)) return null;
  const workspace = workspaces.find(
    (candidate) => candidate.archivedAt === null && candidate.cwd === message.cwd,
  );
  if (!workspace) throw new Error("cwd is not an active pre-registered workspace");
  const authority = await openMayaRestrictedWorkspaceAuthority(message.cwd);
  try {
    if (authority.workspaceId !== workspace.workspaceId) {
      throw new Error("workspace filesystem identity no longer matches the catalog");
    }
    return authority;
  } catch (error) {
    await authority.release();
    throw error;
  }
}

function hasOnlyCodexProviders(providers: readonly string[] | undefined): boolean {
  return providers === undefined || providers.every((provider) => provider === "codex");
}

/**
 * Maya's downstream Paseo build is a Codex workbench, not a host authority.
 * This is deliberately a small allowlist: every unlisted current or future
 * message fails closed. Workspaces are populated only by Maya's trusted host
 * integration; no client RPC may create or register one.
 */
export function evaluateMayaRestrictedSessionMessage(
  message: SessionInboundMessage,
  workspaces: readonly RestrictedWorkspace[],
): MayaRestrictedModeDecision {
  switch (message.type) {
    case "fetch_agents_request":
    case "fetch_agent_history_request":
    case "fetch_workspaces_request":
    case "project.list.request":
    case "fetch_agent_request":
    case "delete_agent_request":
    case "archive_agent_request":
    case "update_agent_request":
    case "wait_for_finish_request":
    case "list_available_providers_request":
    case "provider.usage.list.request":
    case "fetch_agent_timeline_request":
    case "agent.timeline.list_prompts.request":
    case "agent.timeline.set_subscription.request":
    case "workspace_setup_status_request":
    case "workspace.clear_attention.request":
    case "fs.file.unsubscribe.request":
    case "clear_agent_attention":
    case "ping":
      return ALLOWED;

    case "cancel_agent_request":
      return message.turnId?.trim()
        ? ALLOWED
        : denied("cancellation requires the active nonempty turn id");

    case "close_items_request":
      return message.terminalIds.length === 0 ? ALLOWED : denied("terminal lifecycle is disabled");

    case "agent_permission_response":
      if (message.response.behavior === "allow") {
        if (message.response.updatedInput !== undefined) {
          return denied("approval input rewriting is disabled");
        }
        if (message.response.updatedPermissions !== undefined) {
          return denied("persistent permission widening is disabled");
        }
      }
      if (message.response.selectedActionId !== undefined) {
        return denied("authority-changing approval actions are disabled");
      }
      return ALLOWED;

    case "send_agent_message_request":
      return (message.attachments?.length ?? 0) === 0 && (message.images?.length ?? 0) === 0
        ? ALLOWED
        : denied("client-provided file and image attachments are disabled");

    case "create_agent_request": {
      if (!message.workspaceId || !isActiveWorkspaceId(message.workspaceId, workspaces)) {
        return denied("agent creation requires an active pre-registered workspace");
      }
      const workspace = workspaces.find(
        (candidate) =>
          candidate.archivedAt === null && candidate.workspaceId === message.workspaceId,
      );
      if (message.config.provider !== "codex" || message.config.cwd !== workspace?.cwd) {
        return denied("agent provider and cwd must match the registered Codex workspace");
      }
      if (
        message.env !== undefined ||
        message.callerAgentId !== undefined ||
        message.worktreeName !== undefined ||
        message.outputSchema !== undefined ||
        message.git !== undefined ||
        message.worktree !== undefined ||
        message.autoArchive !== undefined ||
        (message.images?.length ?? 0) !== 0 ||
        (message.attachments?.length ?? 0) !== 0 ||
        message.config.modeId !== undefined ||
        message.config.model !== undefined ||
        message.config.thinkingOptionId !== undefined ||
        message.config.featureValues !== undefined ||
        message.config.providerOptions !== undefined ||
        message.config.toolPolicy !== undefined ||
        message.config.systemPrompt !== undefined ||
        message.config.mcpServers !== undefined
      ) {
        return denied("agent authority overrides are disabled");
      }
      return ALLOWED;
    }

    case "list_provider_models_request":
    case "list_provider_modes_request":
      if (message.provider !== "codex") {
        return denied("only the Codex provider is enabled");
      }
      return message.cwd === undefined ? ALLOWED : evaluateRegisteredCwd(message.cwd, workspaces);

    case "get_providers_snapshot_request":
      return message.cwd === undefined ? ALLOWED : evaluateRegisteredCwd(message.cwd, workspaces);

    case "refresh_providers_snapshot_request":
      if (!hasOnlyCodexProviders(message.providers)) {
        return denied("only the Codex provider is enabled");
      }
      return message.cwd === undefined ? ALLOWED : evaluateRegisteredCwd(message.cwd, workspaces);

    case "provider_diagnostic_request":
      return message.provider === "codex" ? ALLOWED : denied("only the Codex provider is enabled");

    case "checkout_status_request":
    case "subscribe_checkout_diff_request":
    case "checkout.commits.list.request":
    case "checkout.commits.file_diff.request":
    case "checkout.refresh.request":
    case "file_explorer_request":
    case "fs.file.subscribe.request":
      return evaluateRegisteredCwd(message.cwd, workspaces);

    case "unsubscribe_checkout_diff_request":
      return ALLOWED;

    case "client_heartbeat":
      return message.focusedTerminalId === null ? ALLOWED : denied("terminal focus is disabled");

    case "list_commands_request":
      return message.draftConfig === undefined
        ? ALLOWED
        : denied("draft provider configuration is disabled");

    default:
      return denied("message type is not enabled in Maya restricted mode");
  }
}
