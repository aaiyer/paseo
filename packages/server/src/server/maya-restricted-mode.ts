import type { SessionInboundMessage } from "./messages.js";
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

type RestrictedWorkspace = Pick<
  PersistedWorkspaceRecord,
  "workspaceId" | "cwd" | "archivedAt"
>;

const ALLOWED = { allowed: true, reason: "allowed" } as const;

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
      return message.terminalIds.length === 0
        ? ALLOWED
        : denied("terminal lifecycle is disabled");

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
      return message.cwd === undefined
        ? ALLOWED
        : evaluateRegisteredCwd(message.cwd, workspaces);

    case "get_providers_snapshot_request":
      return message.cwd === undefined
        ? ALLOWED
        : evaluateRegisteredCwd(message.cwd, workspaces);

    case "refresh_providers_snapshot_request":
      if (!hasOnlyCodexProviders(message.providers)) {
        return denied("only the Codex provider is enabled");
      }
      return message.cwd === undefined
        ? ALLOWED
        : evaluateRegisteredCwd(message.cwd, workspaces);

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
      return message.focusedTerminalId === null
        ? ALLOWED
        : denied("terminal focus is disabled");

    case "list_commands_request":
      return message.draftConfig === undefined
        ? ALLOWED
        : denied("draft provider configuration is disabled");

    default:
      return denied("message type is not enabled in Maya restricted mode");
  }
}
