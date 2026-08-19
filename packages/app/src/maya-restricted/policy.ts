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
const DENIED_GLOBAL_PATHS = [
  "/welcome",
  "/settings",
  "/new",
  "/open-project",
  "/schedules",
  "/pair-scan",
] as const;

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

  if (input.restrictedServerIds.length === 0) return null;
  if (
    !DENIED_GLOBAL_PATHS.some(
      (prefix) => input.pathname === prefix || input.pathname.startsWith(`${prefix}/`),
    )
  ) {
    return null;
  }
  return `/h/${encodeURIComponent(input.restrictedServerIds[0])}`;
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
