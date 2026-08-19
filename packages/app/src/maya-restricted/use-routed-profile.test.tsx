// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { resolveMayaRestrictedAppComposition } from "./policy";
import { useMayaRestrictedRoutedServer } from "./use-routed-profile";

const fixture = vi.hoisted(() => ({
  pathname: "/sessions",
  sessions: {
    ordinary: { serverInfo: { serverId: "ordinary", hostname: null, version: null } },
    maya: {
      serverInfo: {
        serverId: "maya",
        hostname: null,
        version: null,
        profile: "maya-restricted" as const,
      },
    },
  },
}));

vi.mock("expo-router", () => ({ usePathname: () => fixture.pathname }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: { sessions: typeof fixture.sessions }) => unknown) =>
    selector({ sessions: fixture.sessions }),
}));

describe("routed Maya restricted production composition", () => {
  beforeEach(() => {
    fixture.pathname = "/sessions";
  });

  test("keeps a global sessions route ordinary in a mixed connection set", () => {
    const { result } = renderHook(() =>
      resolveMayaRestrictedAppComposition(useMayaRestrictedRoutedServer()),
    );
    expect(result.current).toMatchObject({
      offerLinks: true,
      openProjectEvents: true,
      pluginCommands: true,
      projectMutation: true,
    });
  });

  test("projects restricted surfaces only for the actively routed Maya server", () => {
    fixture.pathname = "/h/maya/sessions";
    const { result } = renderHook(() =>
      resolveMayaRestrictedAppComposition(useMayaRestrictedRoutedServer()),
    );
    expect(result.current).toEqual({
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
  });
});
