import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { openMayaRestrictedWorkspaceAuthority } from "../server/maya-restricted-mode.js";
import { runGitCommand } from "./run-git-command.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/bwrap"))(
  "Maya restricted Git read policy",
  () => {
    test("does not execute repository fsmonitor or external/textconv diff helpers", async () => {
      const root = mkdtempSync(join(tmpdir(), "paseo-restricted-git-policy-"));
      roots.push(root);
      git(root, "init", "-q");
      git(root, "config", "user.name", "Test");
      git(root, "config", "user.email", "test@example.invalid");
      writeFileSync(join(root, "tracked.txt"), "before\n");
      git(root, "add", "tracked.txt");
      git(root, "commit", "-qm", "initial");

      const fsmonitorMarker = join(root, "fsmonitor.marker");
      const externalMarker = join(root, "external.marker");
      const textconvMarker = join(root, "textconv.marker");
      const externalHelperRoot = mkdtempSync(join(tmpdir(), "paseo-restricted-git-helper-"));
      roots.push(externalHelperRoot);
      const filterMarker = join(externalHelperRoot, "filter.marker");
      const helper = (name: string, marker: string, output = "") => {
        const helperPath = join(root, name);
        writeFileSync(
          helperPath,
          `#!/bin/sh\nprintf invoked >${JSON.stringify(marker)}\n${output}`,
        );
        chmodSync(helperPath, 0o755);
        return helperPath;
      };
      const fsmonitor = helper("fsmonitor.sh", fsmonitorMarker, "printf 'token\\n'\n");
      const external = helper("external.sh", externalMarker);
      const textconv = helper("textconv.sh", textconvMarker, 'cat "$1"\n');
      const filterHelper = join(externalHelperRoot, "filter.sh");
      writeFileSync(
        filterHelper,
        `#!/bin/sh\nprintf invoked >${JSON.stringify(filterMarker)}\ncat\n`,
      );
      chmodSync(filterHelper, 0o755);
      git(root, "config", "core.fsmonitor", fsmonitor);
      git(root, "config", "diff.external", external);
      git(root, "config", "diff.evil.textconv", textconv);
      git(root, "config", "filter.evil.clean", filterHelper);
      git(root, "config", "filter.evil.smudge", filterHelper);
      git(root, "config", "filter.evil.required", "false");
      writeFileSync(join(root, ".gitattributes"), "tracked.txt diff=evil filter=evil\n");
      writeFileSync(join(root, "tracked.txt"), "after\n");

      // Prove the planted ordinary Git configuration is executable before the
      // restricted authority overlay suppresses it.
      git(root, "status", "--porcelain");
      git(root, "diff");
      expect(() =>
        execFileSync("git", ["-c", "diff.external=", "diff", "--no-ext-diff", "--textconv"], {
          cwd: root,
        }),
      ).not.toThrow();
      expect(
        [fsmonitorMarker, externalMarker, textconvMarker].map((path) => {
          try {
            return execFileSync("test", ["-f", path]).length === 0;
          } catch {
            return false;
          }
        }),
      ).toEqual([true, true, true]);
      rmSync(fsmonitorMarker, { force: true });
      rmSync(externalMarker, { force: true });
      rmSync(textconvMarker, { force: true });
      rmSync(filterMarker, { force: true });

      const authority = await openMayaRestrictedWorkspaceAuthority(root);
      try {
        await runGitCommand(["status", "--porcelain"], {
          cwd: authority.rootAccessPath,
        });
        await runGitCommand(["diff"], { cwd: authority.rootAccessPath });
        await expect(
          runGitCommand(["diff", "--textconv"], {
            cwd: authority.rootAccessPath,
          }),
        ).rejects.toThrow("executable diff helpers are disabled");
        for (const marker of [fsmonitorMarker, externalMarker, textconvMarker]) {
          expect(() => execFileSync("test", ["-e", marker])).toThrow();
        }
        expect(existsSync(filterMarker)).toBe(false);
      } finally {
        await authority.release();
      }
    });
  },
);
