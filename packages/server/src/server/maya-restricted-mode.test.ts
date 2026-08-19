import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { SessionInboundMessageSchema, type SessionInboundMessage } from "./messages.js";
import {
  evaluateMayaRestrictedSessionMessage,
  MAYA_RESTRICTED_ALLOWED_SESSION_MESSAGE_TYPES,
  openMayaRestrictedWorkspaceAuthority,
} from "./maya-restricted-mode.js";
import {
  installFileExplorerBeforeReadOpenHookForTest,
  listDirectoryEntries,
  readExplorerFile,
} from "./file-explorer/service.js";
import {
  installAfterMayaAuthorityValidationHookForTest,
  runGitCommand,
} from "../utils/run-git-command.js";

const PINNED_UPSTREAM_INBOUND_TYPES = [
  "hub.execution.agent.create.request",
  "hub.execution.agent.validate.request",
  "hub.execution.control.request",
  "browser.automation.execute.response",
  "voice_audio_chunk",
  "abort_request",
  "audio_played",
  "fetch_agents_request",
  "fetch_agent_history_request",
  "fetch_recent_provider_sessions_request",
  "fetch_workspaces_request",
  "project.list.request",
  "fetch_agent_request",
  "delete_agent_request",
  "archive_agent_request",
  "close_items_request",
  "update_agent_request",
  "project.rename.request",
  "project.icon.set.request",
  "project.remove.request",
  "workspace.title.set.request",
  "workspace.pin.set.request",
  "workspace.recovery.inspect.request",
  "workspace.recovery.restore.request",
  "set_voice_mode",
  "send_agent_message_request",
  "wait_for_finish_request",
  "daemon.get_status.request",
  "daemon.get_pairing_offer.request",
  "daemon.config.reload.request",
  "hub.management.daemon.connect.request",
  "hub.management.daemon.get_status.request",
  "hub.management.daemon.disconnect.request",
  "diagnostics.request",
  "plugin.catalog.get.request",
  "plugin.list.request",
  "plugin.logs.get.request",
  "plugin.directory.install.request",
  "plugin.directory.inspect.request",
  "plugin.reload.request",
  "plugin.enable.request",
  "plugin.disable.request",
  "plugin.remove.request",
  "plugin.rpc.invoke.request",
  "agent.skills.get_status.request",
  "agent.skills.reconcile.request",
  "agent.skills.uninstall.request",
  "agent.skills.save_selection.request",
  "agent.skills.import_legacy_selection.request",
  "get_daemon_config_request",
  "set_daemon_config_request",
  "read_project_config_request",
  "write_project_config_request",
  "dictation_stream_start",
  "dictation_stream_chunk",
  "dictation_stream_finish",
  "dictation_stream_cancel",
  "create_agent_request",
  "list_provider_models_request",
  "list_provider_modes_request",
  "list_provider_features_request",
  "list_available_providers_request",
  "get_providers_snapshot_request",
  "refresh_providers_snapshot_request",
  "provider_diagnostic_request",
  "provider.usage.list.request",
  "resume_agent_request",
  "import_agent_request",
  "refresh_agent_request",
  "cancel_agent_request",
  "shutdown_server_request",
  "restart_server_request",
  "daemon.update.request",
  "fetch_agent_timeline_request",
  "agent.timeline.list_prompts.request",
  "agent.provider_subagents.list.request",
  "agent.provider_subagents.timeline.get.request",
  "agent.timeline.set_subscription.request",
  "agent.fork_context.request",
  "set_agent_mode_request",
  "set_agent_model_request",
  "set_agent_thinking_request",
  "set_agent_feature_request",
  "agent.config.apply.request",
  "agent.detach.request",
  "agent.rewind.request",
  "agent_permission_response",
  "checkout_status_request",
  "subscribe_checkout_diff_request",
  "unsubscribe_checkout_diff_request",
  "checkout_commit_request",
  "checkout_merge_request",
  "checkout_merge_from_base_request",
  "checkout_pull_request",
  "checkout_push_request",
  "checkout.refresh.request",
  "checkout.discard_changes.request",
  "checkout_pr_create_request",
  "checkout_pr_merge_request",
  "checkout.forge.set_auto_merge.request",
  "checkout.github.set_auto_merge.request",
  "checkout.commits.list.request",
  "checkout.commits.file_diff.request",
  "checkout.forge.get_check_details.request",
  "checkout.github.get_check_details.request",
  "checkout_pr_status_request",
  "pull_request_timeline_request",
  "checkout_switch_branch_request",
  "checkout.rename_branch.request",
  "stash_save_request",
  "stash_pop_request",
  "stash_list_request",
  "validate_branch_request",
  "branch_suggestions_request",
  "forge.search.request",
  "github_search_request",
  "directory_suggestions_request",
  "paseo_worktree_list_request",
  "paseo_worktree_archive_request",
  "create_paseo_worktree_request",
  "workspace_setup_status_request",
  "list_available_editors_request",
  "open_in_editor_request",
  "open_project_request",
  "project.add.request",
  "project.create_directory.request",
  "workspace.github.search_repositories.request",
  "project.github.clone.request",
  "archive_workspace_request",
  "workspace.create.request",
  "workspace.clear_attention.request",
  "file_explorer_request",
  "fs.file.subscribe.request",
  "fs.file.unsubscribe.request",
  "fs.file.write.request",
  "fs.entry.create.request",
  "fs.entry.rename.request",
  "fs.entry.duplicate.request",
  "fs.entry.delete.request",
  "project_icon_request",
  "project.icon.get.request",
  "file_download_token_request",
  "file.upload.request",
  "clear_agent_attention",
  "client_heartbeat",
  "ping",
  "list_commands_request",
  "register_push_token",
  "push.unregister.request",
  "list_terminals_request",
  "subscribe_terminals_request",
  "unsubscribe_terminals_request",
  "create_terminal_request",
  "terminal.rename.request",
  "start_workspace_script_request",
  "workspace.script.list.request",
  "workspace.script.start.request",
  "workspace.script.stop.request",
  "subscribe_terminal_request",
  "unsubscribe_terminal_request",
  "terminal_input",
  "kill_terminal_request",
  "capture_terminal_request",
  "chat/create",
  "chat/list",
  "chat/inspect",
  "chat/delete",
  "chat/post",
  "chat/read",
  "chat/wait",
  "schedule/create",
  "schedule/list",
  "schedule/inspect",
  "schedule/logs",
  "schedule/pause",
  "schedule/resume",
  "schedule/delete",
  "schedule/run-once",
  "schedule/update",
  "loop/run",
  "loop/list",
  "loop/inspect",
  "loop/logs",
  "loop/stop",
] as const;

const PINNED_ALLOWED_TYPES = [
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
  "workspace.clear_attention.request",
  "file_explorer_request",
  "fs.file.subscribe.request",
  "fs.file.unsubscribe.request",
  "list_terminals_request",
  "subscribe_terminals_request",
  "unsubscribe_terminals_request",
  "create_terminal_request",
  "terminal.rename.request",
  "subscribe_terminal_request",
  "unsubscribe_terminal_request",
  "terminal_input",
  "kill_terminal_request",
  "capture_terminal_request",
  "clear_agent_attention",
  "client_heartbeat",
  "ping",
  "list_commands_request",
] as const;

const WORKSPACES = [
  { workspaceId: "registered", cwd: "/srv/maya/worktree", archivedAt: null },
  {
    workspaceId: "archived",
    cwd: "/srv/maya/archived",
    archivedAt: "2026-08-18T00:00:00Z",
  },
];

function parseMessage(input: unknown): SessionInboundMessage {
  return SessionInboundMessageSchema.parse(input);
}

function evaluate(input: unknown) {
  return evaluateMayaRestrictedSessionMessage(parseMessage(input), WORKSPACES);
}

describe("Maya restricted mode", () => {
  test("pins the complete upstream inbound vocabulary", () => {
    const upstreamTypes = SessionInboundMessageSchema.options.map(
      (schema) => schema.shape.type.value,
    );
    expect(upstreamTypes).toEqual(PINNED_UPSTREAM_INBOUND_TYPES);
  });

  test("pins the complete allowlist", () => {
    expect(MAYA_RESTRICTED_ALLOWED_SESSION_MESSAGE_TYPES).toEqual(PINNED_ALLOWED_TYPES);
  });

  test.each([
    {
      type: "checkout_commit_request",
      cwd: "/srv/maya/worktree",
      requestId: "git",
    },
    {
      type: "workspace.script.start.request",
      workspaceId: "registered",
      scriptName: "x",
      requestId: "script",
    },
    { type: "schedule/list", requestId: "schedule" },
    { type: "set_daemon_config_request", requestId: "config", config: {} },
    { type: "plugin.list.request", requestId: "plugin" },
    {
      type: "hub.execution.control.request",
      requestId: "hub",
      executionId: "x",
      action: "interrupt",
    },
    {
      type: "workspace.create.request",
      source: { kind: "directory", path: "/srv/maya/worktree", projectId: "x" },
      requestId: "workspace",
    },
    {
      type: "fs.file.write.request",
      cwd: "/srv/maya/worktree",
      path: "x",
      content: "x",
      expectedModifiedAt: "x",
      requestId: "file",
    },
    { type: "chat/list", requestId: "chat" },
    { type: "loop/list", requestId: "loop" },
  ])("denies authority-bearing $type", (message) => {
    expect(evaluate(message)).toMatchObject({ allowed: false });
  });

  test("allows only exact registered workspace read paths", () => {
    expect(
      evaluate({
        type: "file_explorer_request",
        cwd: "/srv/maya/worktree",
        path: "docs",
        mode: "list",
        requestId: "ok",
      }),
    ).toEqual({ allowed: true, reason: "allowed" });
    expect(
      evaluate({
        type: "file_explorer_request",
        cwd: "/srv/maya/worktree/..",
        path: ".",
        mode: "list",
        requestId: "escape",
      }),
    ).toMatchObject({ allowed: false });
    expect(
      evaluate({
        type: "checkout_status_request",
        cwd: "/srv/maya/archived",
        requestId: "archived",
      }),
    ).toMatchObject({ allowed: false });
  });

  test("allows only a fixed Codex agent in a pre-registered workspace", () => {
    const base = {
      type: "create_agent_request",
      config: { provider: "codex", cwd: "/srv/maya/worktree", title: "work" },
      workspaceId: "registered",
      requestId: "create",
    };
    expect(evaluate(base)).toEqual({ allowed: true, reason: "allowed" });
    expect(evaluate({ ...base, workspaceId: "missing" })).toMatchObject({
      allowed: false,
    });
    expect(evaluate({ ...base, config: { ...base.config, cwd: "/tmp" } })).toMatchObject({
      allowed: false,
    });
    expect(evaluate({ ...base, config: { ...base.config, model: "mutable" } })).toMatchObject({
      allowed: false,
    });
    expect(
      evaluate({
        ...base,
        worktree: { mode: "branch-off", newBranch: "escape" },
      }),
    ).toMatchObject({ allowed: false });
  });

  test("preserves native approvals but rejects unbound terminal close and provider widening", () => {
    expect(
      evaluate({
        type: "cancel_agent_request",
        agentId: "agent",
        turnId: "turn-1",
        requestId: "cancel",
      }),
    ).toEqual({ allowed: true, reason: "allowed" });
    expect(
      evaluate({
        type: "cancel_agent_request",
        agentId: "agent",
        requestId: "missing-turn",
      }),
    ).toMatchObject({ allowed: false });
    expect(
      evaluate({
        type: "agent_permission_response",
        agentId: "agent",
        requestId: "approval",
        response: { behavior: "allow" },
      }),
    ).toEqual({ allowed: true, reason: "allowed" });
    expect(
      evaluate({
        type: "agent_permission_response",
        agentId: "agent",
        requestId: "deny",
        response: { behavior: "deny", interrupt: true, message: "cancel" },
      }),
    ).toEqual({ allowed: true, reason: "allowed" });
    expect(
      evaluate({
        type: "agent_permission_response",
        agentId: "agent",
        requestId: "permissions",
        response: { behavior: "allow", updatedPermissions: [{ path: "/" }] },
      }),
    ).toMatchObject({ allowed: false });
    expect(
      evaluate({
        type: "agent_permission_response",
        agentId: "agent",
        requestId: "input",
        response: { behavior: "allow", updatedInput: { command: "widen" } },
      }),
    ).toMatchObject({ allowed: false });
    expect(
      evaluate({
        type: "agent_permission_response",
        agentId: "agent",
        requestId: "action",
        response: { behavior: "allow", selectedActionId: "allow_always" },
      }),
    ).toMatchObject({ allowed: false });
    expect(
      evaluate({
        type: "close_items_request",
        agentIds: [],
        terminalIds: ["terminal"],
        requestId: "close",
      }),
    ).toMatchObject({ allowed: false });
    expect(
      evaluate({
        type: "provider_diagnostic_request",
        provider: "codex",
        requestId: "provider",
      }),
    ).toMatchObject({ allowed: false });
  });

  test("allows only the exact registered terminal selection without command authority", () => {
    const base = {
      type: "create_terminal_request",
      cwd: "/srv/maya/worktree",
      workspaceId: "registered",
      requestId: "terminal",
    };
    expect(evaluate(base)).toEqual({ allowed: true, reason: "allowed" });
    expect(evaluate({ ...base, cwd: "/srv/maya/other" })).toMatchObject({
      allowed: false,
    });
    expect(evaluate({ ...base, workspaceId: "archived" })).toMatchObject({
      allowed: false,
    });
    expect(evaluate({ ...base, workspaceId: undefined })).toMatchObject({
      allowed: false,
    });
    expect(evaluate({ ...base, command: "/bin/sh" })).toMatchObject({
      allowed: false,
    });
    expect(evaluate({ ...base, args: ["-c", "id"] })).toMatchObject({
      allowed: false,
    });
    expect(evaluate({ ...base, agentId: "agent" })).toMatchObject({
      allowed: false,
    });

    for (const type of [
      "list_terminals_request",
      "subscribe_terminals_request",
      "unsubscribe_terminals_request",
    ] as const) {
      expect(
        evaluate({
          type,
          cwd: base.cwd,
          workspaceId: base.workspaceId,
          requestId: "list",
        }),
      ).toEqual({ allowed: true, reason: "allowed" });
      expect(evaluate({ type, cwd: base.cwd, requestId: "unbound" })).toMatchObject({
        allowed: false,
      });
    }
  });

  test("future message types hit the default deny", () => {
    const future = {
      type: "future.authority.request",
    } as unknown as SessionInboundMessage;
    expect(evaluateMayaRestrictedSessionMessage(future, WORKSPACES)).toMatchObject({
      allowed: false,
    });
  });

  test("the production file reader rejects traversal and symlink escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "maya-restricted-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "maya-restricted-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "secret");
      await symlink(outside, path.join(root, "escape"), "dir");
      await expect(readExplorerFile({ root, relativePath: "../secret.txt" })).rejects.toThrow(
        "Access outside of workspace is not allowed",
      );
      await expect(
        readExplorerFile({
          root,
          relativePath: path.join(outside, "secret.txt"),
        }),
      ).rejects.toThrow("Access outside of workspace is not allowed");
      await expect(readExplorerFile({ root, relativePath: "escape/secret.txt" })).rejects.toThrow(
        "Access outside of workspace is not allowed",
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  test.skipIf(process.platform !== "linux")(
    "descriptor-bound reads reject an intermediate symlink swap without exposing outside data",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "maya-restricted-race-root-"));
      const outside = await mkdtemp(path.join(tmpdir(), "maya-restricted-race-outside-"));
      const intermediate = path.join(root, "inside");
      let restoreHook = () => {};
      try {
        await mkdir(intermediate);
        await writeFile(path.join(intermediate, "document.txt"), "safe");
        await writeFile(path.join(outside, "document.txt"), "outside-secret");
        await writeFile(path.join(outside, "outside-name.txt"), "outside-listing");

        restoreHook = installFileExplorerBeforeReadOpenHookForTest(async () => {
          await rm(intermediate, { recursive: true });
          await symlink(outside, intermediate, "dir");
        });
        await expect(
          readExplorerFile({ root, relativePath: "inside/document.txt" }),
        ).rejects.toThrow("Access outside of workspace is not allowed");

        restoreHook();
        await rm(intermediate);
        await mkdir(intermediate);
        await writeFile(path.join(intermediate, "safe-name.txt"), "safe");
        restoreHook = installFileExplorerBeforeReadOpenHookForTest(async () => {
          await rm(intermediate, { recursive: true });
          await symlink(outside, intermediate, "dir");
        });
        await expect(listDirectoryEntries({ root, relativePath: "inside" })).rejects.toThrow(
          "Access outside of workspace is not allowed",
        );
      } finally {
        restoreHook();
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          rm(outside, { recursive: true, force: true }),
        ]);
      }
    },
  );

  test.skipIf(process.platform !== "linux")(
    "binds a linked worktree Git directory across initial and mid-command .git redirection",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "maya-restricted-gitdir-"));
      const repository = path.join(root, "repository");
      const selected = path.join(root, "selected");
      const sibling = path.join(root, "sibling");
      let authority: Awaited<ReturnType<typeof openMayaRestrictedWorkspaceAuthority>> | null = null;
      let restoreHook = () => {};
      try {
        execFileSync("git", ["init", "--initial-branch=main", repository]);
        execFileSync("git", ["-C", repository, "config", "user.name", "Paseo Test"]);
        execFileSync("git", ["-C", repository, "config", "user.email", "paseo@example.invalid"]);
        await writeFile(path.join(repository, "tracked.txt"), "base\n");
        execFileSync("git", ["-C", repository, "add", "tracked.txt"]);
        execFileSync("git", ["-C", repository, "commit", "-m", "base"]);
        execFileSync("git", ["-C", repository, "branch", "selected"]);
        execFileSync("git", ["-C", repository, "branch", "sibling"]);
        execFileSync("git", ["-C", repository, "worktree", "add", selected, "selected"]);
        execFileSync("git", ["-C", repository, "worktree", "add", sibling, "sibling"]);

        const selectedLink = await readFile(path.join(selected, ".git"), "utf8");
        const siblingLink = await readFile(path.join(sibling, ".git"), "utf8");
        authority = await openMayaRestrictedWorkspaceAuthority(selected);

        await writeFile(path.join(selected, ".git"), siblingLink);
        await expect(
          runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd: authority.rootAccessPath,
          }),
        ).rejects.toThrow("Git directory identity changed");

        await writeFile(path.join(selected, ".git"), selectedLink);
        restoreHook = installAfterMayaAuthorityValidationHookForTest(async () => {
          await authority?.release();
          authority = null;
          await rename(selected, `${selected}-replaced`);
          await mkdir(selected);
          await writeFile(path.join(selected, ".git"), siblingLink);
        });
        const result = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: authority.rootAccessPath,
        });
        expect(result.stdout.trim()).toBe("selected");
        expect(result.stdout).not.toContain("sibling");
      } finally {
        restoreHook();
        if (authority) {
          await authority.release();
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "linux")(
    "rejects linked-worktree Git indirection FIFOs without blocking authority admission",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "maya-restricted-git-fifo-"));
      const repository = path.join(root, "repository");
      const selected = path.join(root, "selected");
      try {
        execFileSync("git", ["init", "--initial-branch=main", repository]);
        execFileSync("git", ["-C", repository, "config", "user.name", "Paseo Test"]);
        execFileSync("git", ["-C", repository, "config", "user.email", "paseo@example.invalid"]);
        execFileSync("git", ["-C", repository, "commit", "--allow-empty", "-m", "base"]);
        execFileSync("git", ["-C", repository, "branch", "selected"]);
        execFileSync("git", ["-C", repository, "worktree", "add", selected, "selected"]);
        const dotGit = await readFile(path.join(selected, ".git"), "utf8");
        const gitDirectory = path.resolve(selected, dotGit.trim().slice("gitdir: ".length));

        for (const name of ["commondir", "gitdir"]) {
          const indirection = path.join(gitDirectory, name);
          const contents = await readFile(indirection);
          await rm(indirection);
          execFileSync("/usr/bin/mkfifo", [indirection]);
          await expect(
            Promise.race([
              openMayaRestrictedWorkspaceAuthority(selected).then(async (opened) => {
                await opened.release();
                throw new Error("FIFO authority admission unexpectedly succeeded");
              }),
              new Promise<never>((_resolve, reject) =>
                setTimeout(() => reject(new Error("FIFO authority admission blocked")), 1_000),
              ),
            ]),
          ).rejects.toThrow("Git path indirection is unsafe");
          await rm(indirection);
          await writeFile(indirection, contents);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
