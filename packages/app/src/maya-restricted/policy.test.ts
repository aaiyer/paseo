import { describe, expect, test, vi } from "vitest";
import type { CommandCenterContribution } from "@/command-center/contributions";
import { createCommandCenterRegistry } from "@/command-center/registry";
import {
  filterMayaRestrictedCommandRegistration,
  isMayaRestrictedServerInfo,
  isMayaRestrictedShortcutActionAllowed,
  resolveMayaRestrictedAppComposition,
  resolveMayaRestrictedRouteRedirect,
} from "./policy";

function action(id: string): CommandCenterContribution {
  return {
    id,
    group: "test",
    groupRank: 0,
    rank: 0,
    keywords: [],
    visibility: "always",
    run: vi.fn(),
    presentation: { kind: "action", title: id },
  };
}

describe("Maya restricted app policy", () => {
  test("recognizes only the internal restricted profile marker", () => {
    expect(
      isMayaRestrictedServerInfo({
        serverId: "maya",
        hostname: null,
        version: null,
        profile: "maya-restricted",
      }),
    ).toBe(true);
    expect(isMayaRestrictedServerInfo({ serverId: "other", hostname: null, version: null })).toBe(
      false,
    );
  });

  test("retains plain Codex, terminal, and read navigation commands and cannot invoke denied actions", () => {
    const history = action("history");
    const settings = action("settings");
    const rootRegistration = {
      owner: { sourceId: "root", token: Symbol("root") },
      contributions: [history, settings, action("schedules"), action("add-project")],
    };
    const filteredRoot = filterMayaRestrictedCommandRegistration(rootRegistration);
    expect(filteredRoot.contributions.map(({ id }) => id)).toEqual(["history"]);

    const newAgent = action("tab:new-agent");
    const newTerminal = action("tab:new-terminal");
    const gitPush = action("git:push");
    const workspaceRegistration = {
      owner: { sourceId: "workspace", token: Symbol("workspace") },
      contributions: [newAgent, newTerminal, gitPush],
    };
    const filteredWorkspace = filterMayaRestrictedCommandRegistration(workspaceRegistration);
    expect(filteredWorkspace.contributions.map(({ id }) => id)).toEqual([
      "tab:new-agent",
      "tab:new-terminal",
    ]);

    for (const retained of [...filteredRoot.contributions, ...filteredWorkspace.contributions]) {
      retained.run();
    }
    expect(history.run).toHaveBeenCalledTimes(1);
    expect(newAgent.run).toHaveBeenCalledTimes(1);
    expect(newTerminal.run).toHaveBeenCalledTimes(1);
    expect(settings.run).not.toHaveBeenCalled();
    expect(gitPush.run).not.toHaveBeenCalled();
    expect(filteredRoot.contributions).not.toContain(settings);
    expect(filteredWorkspace.contributions).not.toContain(gitPush);

    const registry = createCommandCenterRegistry(filterMayaRestrictedCommandRegistration);
    registry.replace(rootRegistration);
    registry.replace(workspaceRegistration);
    expect(registry.getSnapshot().contributions.map(({ id }) => id)).toEqual([
      "root:history",
      "workspace:tab:new-agent",
      "workspace:tab:new-terminal",
    ]);
    for (const contribution of registry.getSnapshot().contributions) contribution.run();
    expect(settings.run).not.toHaveBeenCalled();
    expect(newTerminal.run).toHaveBeenCalledTimes(2);
    expect(gitPush.run).not.toHaveBeenCalled();
  });

  test("guards direct denied routes while retaining registered workspace, agent, and history routes", () => {
    const restrictedServerIds = ["maya"];
    for (const pathname of [
      "/h/maya",
      "/h/maya/workspace/registered",
      "/h/maya/agent/thread",
      "/h/maya/sessions",
      "/sessions",
    ]) {
      expect(resolveMayaRestrictedRouteRedirect({ pathname, restrictedServerIds })).toBeNull();
    }
    for (const pathname of [
      "/h/maya/settings",
      "/h/maya/open-project",
      "/h/maya/plugin/github/pull-request",
    ]) {
      expect(resolveMayaRestrictedRouteRedirect({ pathname, restrictedServerIds })).toBe("/h/maya");
    }
    for (const pathname of ["/settings", "/new", "/open-project", "/schedules", "/pair-scan"]) {
      expect(resolveMayaRestrictedRouteRedirect({ pathname, restrictedServerIds })).toBeNull();
    }
    expect(
      resolveMayaRestrictedRouteRedirect({ pathname: "/h/ordinary/settings", restrictedServerIds }),
    ).toBeNull();
  });

  test("retains terminal creation but denies mutation, provider-mode, browser, voice, and dictation shortcuts", () => {
    expect(
      isMayaRestrictedShortcutActionAllowed({
        kind: "dispatch",
        action: { id: "message-input.send" },
      }),
    ).toBe(true);
    expect(
      isMayaRestrictedShortcutActionAllowed({
        kind: "dispatch",
        action: { id: "workspace.terminal.new" },
      }),
    ).toBe(true);
    for (const id of [
      "message-input.dictation-toggle",
      "message-input.voice-toggle",
      "message-input.mode-cycle",
      "workspace.browser.new",
      "workspace.new",
      "worktree.new",
      "workspace.archive",
      "workspace.pin",
    ]) {
      expect(isMayaRestrictedShortcutActionAllowed({ kind: "dispatch", action: { id } })).toBe(
        false,
      );
    }
    expect(isMayaRestrictedShortcutActionAllowed({ kind: "open-project-picker" })).toBe(false);
  });

  test("leaves the ordinary upstream command registry unchanged", () => {
    const deniedOnlyInRestrictedMode = action("git:push");
    const registry = createCommandCenterRegistry();
    registry.replace({
      owner: { sourceId: "workspace", token: Symbol("workspace") },
      contributions: [
        action("tab:new-agent"),
        action("tab:new-terminal"),
        deniedOnlyInRestrictedMode,
      ],
    });
    expect(registry.getSnapshot().contributions.map(({ id }) => id)).toEqual([
      "workspace:git:push",
      "workspace:tab:new-agent",
      "workspace:tab:new-terminal",
    ]);
  });

  test("projects the complete AppContainer and CommandCenter composition from the routed server", () => {
    expect(resolveMayaRestrictedAppComposition(false)).toEqual({
      offerLinks: true,
      openProjectEvents: true,
      pluginCommands: true,
      projectMutation: true,
      providerSettings: true,
      setupAndDiagnostics: true,
      downloads: true,
      selectedWorkspaceTerminal: true,
      threadAndReadSurfaces: true,
    });
    expect(resolveMayaRestrictedAppComposition(true)).toEqual({
      offerLinks: false,
      openProjectEvents: false,
      pluginCommands: false,
      projectMutation: false,
      providerSettings: false,
      setupAndDiagnostics: false,
      downloads: false,
      selectedWorkspaceTerminal: true,
      threadAndReadSurfaces: true,
    });

    expect(
      resolveMayaRestrictedRouteRedirect({
        pathname: "/h/ordinary/settings",
        restrictedServerIds: ["maya"],
      }),
    ).toBeNull();
    expect(
      resolveMayaRestrictedRouteRedirect({
        pathname: "/h/maya/settings",
        restrictedServerIds: ["maya"],
      }),
    ).toBe("/h/maya");
  });
});
