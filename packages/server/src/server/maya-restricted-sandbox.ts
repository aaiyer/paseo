import path from "node:path";

export const MAYA_RESTRICTED_BWRAP = "/usr/bin/bwrap";

export interface MayaRestrictedSandboxBinding {
  source?: string;
  fileDescriptor?: number;
  destination: string;
  writable: boolean;
}

function destinationParents(destination: string): string[] {
  const normalized = path.posix.normalize(destination);
  if (!normalized.startsWith("/") || normalized === "/") {
    throw new Error("restricted sandbox destination must be an absolute non-root path");
  }
  const parents: string[] = [];
  let current = path.posix.dirname(normalized);
  while (current !== "/") {
    parents.push(current);
    current = path.posix.dirname(current);
  }
  return parents.reverse();
}

/**
 * Builds the one Maya restricted mount/network profile. The namespace starts
 * empty: host homes, service state, Maya data, Paseo state, and every sibling
 * checkout are absent unless they are the exact selected binding.
 */
export function buildMayaRestrictedSandboxArgs(input: {
  cwd: string;
  bindings: readonly MayaRestrictedSandboxBinding[];
  command: string;
  args: readonly string[];
}): string[] {
  const directories = new Set<string>(["/usr", "/proc", "/dev", "/tmp"]);
  for (const binding of input.bindings) {
    const hasSource = binding.source !== undefined;
    const hasFileDescriptor = binding.fileDescriptor !== undefined;
    if (
      hasSource === hasFileDescriptor ||
      (binding.source !== undefined && !binding.source.startsWith("/")) ||
      (binding.fileDescriptor !== undefined &&
        (!Number.isSafeInteger(binding.fileDescriptor) || binding.fileDescriptor < 0)) ||
      !binding.destination.startsWith("/")
    ) {
      throw new Error("restricted sandbox bindings must use absolute paths");
    }
    for (const parent of destinationParents(binding.destination)) directories.add(parent);
    directories.add(binding.destination);
  }
  for (const parent of destinationParents(input.cwd)) directories.add(parent);

  const result = ["--die-with-parent", "--new-session", "--unshare-all", "--tmpfs", "/"];
  for (const directory of [...directories].sort((left, right) => left.length - right.length)) {
    result.push("--dir", directory);
  }
  result.push(
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  );
  for (const binding of input.bindings) {
    if (binding.fileDescriptor !== undefined) {
      result.push(
        binding.writable ? "--bind-fd" : "--ro-bind-fd",
        String(binding.fileDescriptor),
        binding.destination,
      );
    } else {
      result.push(binding.writable ? "--bind" : "--ro-bind", binding.source!, binding.destination);
    }
  }
  result.push("--chdir", input.cwd, input.command, ...input.args);
  return result;
}
