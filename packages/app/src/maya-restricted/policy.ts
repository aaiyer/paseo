import { MAYA_RESTRICTED_PROFILE } from "@getpaseo/protocol/messages";
import type { CommandCenterRegistration } from "@/command-center/contributions";
import type { DaemonServerInfo } from "@/stores/session-store";

const RETAINED_COMMANDS = new Set([
  "root:history",
  "root:sidebar-grouping",
  "workspace:tab:new-agent",
  "workspace:tab:new-terminal",
]);

const RETAINED_HOST_PATHS = ["/workspace/", "/agent/", "/sessions"] as const;
export interface MayaRestrictedAppComposition {
  readonly offerLinks: boolean;
  readonly openProjectEvents: boolean;
  readonly pluginCommands: boolean;
  readonly projectMutation: boolean;
  readonly providerSettings: boolean;
  readonly setupAndDiagnostics: boolean;
  readonly downloads: boolean;
  readonly selectedWorkspaceTerminal: boolean;
  readonly threadAndReadSurfaces: boolean;
}

export function resolveMayaRestrictedAppComposition(
  mayaRestricted: boolean,
): MayaRestrictedAppComposition {
  const ordinaryOnly = !mayaRestricted;
  return {
    offerLinks: ordinaryOnly,
    openProjectEvents: ordinaryOnly,
    pluginCommands: ordinaryOnly,
    projectMutation: ordinaryOnly,
    providerSettings: ordinaryOnly,
    setupAndDiagnostics: ordinaryOnly,
    downloads: ordinaryOnly,
    selectedWorkspaceTerminal: true,
    threadAndReadSurfaces: true,
  };
}

export function isMayaRestrictedServerInfo(
  serverInfo: DaemonServerInfo | null | undefined,
): boolean {
  return serverInfo?.profile === MAYA_RESTRICTED_PROFILE;
}

export function filterMayaRestrictedCommandRegistration(
  registration: CommandCenterRegistration,
): CommandCenterRegistration {
  return {
    ...registration,
    contributions: registration.contributions.filter((contribution) =>
      RETAINED_COMMANDS.has(`${registration.owner.sourceId}:${contribution.id}`),
    ),
  };
}

export function resolveMayaRestrictedRouteRedirect(input: {
  pathname: string;
  restrictedServerIds: readonly string[];
}): string | null {
  const routeMatch = /^\/h\/([^/]+)(.*)$/.exec(input.pathname);
  if (routeMatch) {
    const [, encodedServerId, suffix] = routeMatch;
    let serverId: string;
    try {
      serverId = decodeURIComponent(encodedServerId);
    } catch {
      return null;
    }
    if (!input.restrictedServerIds.includes(serverId)) return null;
    if (suffix === "" || RETAINED_HOST_PATHS.some((prefix) => suffix.startsWith(prefix))) {
      return null;
    }
    return `/h/${encodeURIComponent(serverId)}`;
  }

  // A global route has no routed server authority. A connected restricted
  // session must not disable an ordinary server's app surface.
  return null;
}

export function isMayaRestrictedShortcutActionAllowed(action: {
  kind: string;
  action?: { id?: string };
  route?: string;
}): boolean {
  switch (action.kind) {
    case "none":
    case "navigate-workspace":
    case "navigate-last-workspace":
    case "router-back":
    case "command-center-toggle":
      return true;
    case "router-push":
    case "router-replace":
      return action.route === "/sessions" || action.route?.includes("/sessions") === true;
    case "dispatch":
      return [
        "agent.interrupt",
        "message-input.focus",
        "message-input.send",
        "workspace.agent.new",
        "workspace.terminal.new",
        "workspace.tab.target.agent",
        "workspace.tab.target.changes",
        "workspace.tab.target.files",
        "workspace.tab.close-current",
        "workspace.tab.navigate-index",
        "workspace.tab.navigate-relative",
        "workspace.pane.focus.left",
        "workspace.pane.focus.right",
        "workspace.pane.focus.up",
        "workspace.pane.focus.down",
        "workspace.explorer.maximize.toggle",
        "workspace.focus.toggle",
        "sidebar.toggle.right",
      ].includes(action.action?.id ?? "");
    default:
      return false;
  }
}
