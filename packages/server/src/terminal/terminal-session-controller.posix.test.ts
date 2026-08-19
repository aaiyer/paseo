import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { SessionOutboundMessage } from "../server/messages.js";
import type { MayaRestrictedWorkspaceAuthority } from "../server/maya-restricted-mode.js";
import { isSameOrDescendantPath } from "../server/path-utils.js";
import { TerminalSessionController } from "./terminal-session-controller.js";
import { createTerminalManager } from "./terminal-manager.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/bwrap"))(
  "Maya restricted terminal production authority",
  () => {
    test("kills and reaps the real sandbox on identity drift before releasing its authority", async () => {
      const parent = mkdtempSync(join(tmpdir(), "paseo-terminal-controller-posix-"));
      roots.push(parent);
      const workspace = join(parent, "workspace");
      const displaced = join(parent, "displaced");
      mkdirSync(workspace);
      const initial = statSync(workspace, { bigint: true });
      let references = 1;
      const authority: MayaRestrictedWorkspaceAuthority = {
        cwd: workspace,
        workspaceId: "workspace",
        rootAccessPath: workspace,
        retain() {
          references += 1;
          return this;
        },
        async release() {
          references -= 1;
        },
        async isCurrent() {
          try {
            const current = statSync(workspace, { bigint: true });
            return current.dev === initial.dev && current.ino === initial.ino;
          } catch {
            return false;
          }
        },
        async terminalSandboxBinding() {
          return { workspaceRoot: workspace, rootDevice: initial.dev, rootInode: initial.ino };
        },
      };
      const manager = createTerminalManager();
      const emitted: SessionOutboundMessage[] = [];
      const controller = new TerminalSessionController({
        terminalManager: manager,
        emit: (message) => emitted.push(message),
        emitBinary: vi.fn(),
        hasBinaryChannel: () => true,
        isPathWithinRoot: isSameOrDescendantPath,
        sessionLogger: pino({ level: "silent" }),
      });
      controller.start();
      await controller.dispatch(
        {
          type: "create_terminal_request",
          cwd: workspace,
          workspaceId: "workspace",
          requestId: "create",
        },
        { mayaRestrictedMode: true, workspaceAuthority: authority },
      );
      const created = emitted.find((message) => message.type === "create_terminal_response");
      if (!created || created.payload.terminal === null)
        throw new Error("terminal was not created");
      const terminalId = created.payload.terminal.id;
      const token = `paseo-terminal-descendant-${process.pid}-${Date.now()}`;
      await controller.dispatch(
        {
          type: "terminal_input",
          terminalId,
          message: {
            type: "input",
            data: `setsid /bin/sh -c '/bin/sleep 60' ${token} & echo ready > ready\r`,
          },
        },
        { mayaRestrictedMode: true },
      );
      await waitFor(() => existsSync(join(workspace, "ready")), "sandbox did not reach readiness");
      await waitFor(() => {
        try {
          return execFileSync("pgrep", ["-f", token]).toString().trim().length > 0;
        } catch {
          return false;
        }
      }, "sandbox descendant did not start");

      renameSync(workspace, displaced);
      mkdirSync(workspace);
      await controller.dispatch(
        {
          type: "terminal_input",
          terminalId,
          message: { type: "input", data: "printf exposed > replacement.txt\r" },
        },
        { mayaRestrictedMode: true },
      );
      await waitFor(() => manager.getTerminal(terminalId) === undefined, "terminal was not reaped");
      await waitFor(() => {
        try {
          execFileSync("pgrep", ["-f", token]);
          return false;
        } catch {
          return true;
        }
      }, "sandbox descendant survived terminal EOF");

      expect(existsSync(join(workspace, "replacement.txt"))).toBe(false);
      expect(references).toBe(1);
      controller.dispose();
      manager.killAll();
    });
  },
);
