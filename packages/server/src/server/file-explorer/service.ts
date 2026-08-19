import { constants, promises as fs, type BigIntStats } from "fs";
import type { FileHandle } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { expandUserPath, resolvePathFromBase } from "../path-utils.js";
import { runGitCommand } from "../../utils/run-git-command.js";

export type ExplorerEntryKind = "file" | "directory";
export type ExplorerFileKind = "text" | "image" | "binary";
export type ExplorerEncoding = "utf-8" | "base64" | "none";

export interface ListDirectoryParams {
  root: string;
  relativePath?: string;
}

export interface ReadFileParams {
  root: string;
  relativePath: string;
}

export interface WriteFileParams extends ReadFileParams {
  content: string;
  expectedModifiedAt: string;
  expectedRevision?: string;
}

export type ExplorerFileVersion =
  | {
      status: "ready";
      cwd: string;
      path: string;
      size: number;
      modifiedAt: string;
      revision: string;
    }
  | { status: "missing"; cwd: string; path: string }
  | { status: "error"; cwd: string; path: string; error: string };

export type ExplorerFileWriteResult =
  | { status: "written"; modifiedAt: string; size: number; revision: string }
  | { status: "conflict"; version: ExplorerFileVersion }
  | { status: "error"; error: string };

export interface FileExplorerEntry {
  name: string;
  path: string;
  kind: ExplorerEntryKind;
  size: number;
  modifiedAt: string;
}

export interface FileExplorerDirectory {
  path: string;
  entries: FileExplorerEntry[];
}

export interface FileExplorerFile {
  path: string;
  kind: ExplorerFileKind;
  encoding: ExplorerEncoding;
  content?: string;
  mimeType?: string;
  size: number;
  modifiedAt: string;
  revision: string;
}

export interface FileExplorerFileBytes {
  path: string;
  kind: ExplorerFileKind;
  encoding: "utf-8" | "binary";
  bytes: Uint8Array;
  mimeType: string;
  size: number;
  modifiedAt: string;
  revision: string;
}

export interface FileExplorerFileStream {
  path: string;
  kind: ExplorerFileKind;
  encoding: "utf-8" | "binary";
  mimeType: string;
  size: number;
  modifiedAt: string;
  revision: string;
  chunks: AsyncIterable<Uint8Array>;
}

const TEXT_MIME_TYPES: Record<string, string> = {
  ".json": "application/json",
};

const DEFAULT_TEXT_MIME_TYPE = "text/plain";
const FILE_TYPE_SAMPLE_BYTES = 8192;
export const FILE_EXPLORER_STREAM_CHUNK_BYTES = 256 * 1024;
export const MAX_EDITABLE_FILE_BYTES = 1024 * 1024;
export const MAX_DIRECTORY_ENTRIES = 1024;
export const DIRECTORY_ENTRY_OPEN_CONCURRENCY = 16;
const READ_FILE_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
const READ_DIRECTORY_OPEN_FLAGS =
  process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const ACCESS_OUTSIDE_WORKSPACE_MESSAGE = "Access outside of workspace is not allowed";
let beforeScopedReadOpenForTest: (() => Promise<void>) | null = null;
let directoryEntryOpenHookForTest: ((phase: "opened" | "closed") => Promise<void> | void) | null =
  null;

/** Deterministic race seam for production read-path regression tests only. */
export function installFileExplorerBeforeReadOpenHookForTest(
  hook: () => Promise<void>,
): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("file explorer read hook is test-only");
  }
  if (beforeScopedReadOpenForTest) throw new Error("file explorer read hook is already installed");
  beforeScopedReadOpenForTest = hook;
  return () => {
    if (beforeScopedReadOpenForTest === hook) beforeScopedReadOpenForTest = null;
  };
}

/** Deterministic entry-handle lifetime seam for bounded-concurrency regression tests only. */
export function installDirectoryEntryOpenHookForTest(
  hook: (phase: "opened" | "closed") => Promise<void> | void,
): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("directory entry open hook is test-only");
  }
  if (directoryEntryOpenHookForTest) {
    throw new Error("directory entry open hook is already installed");
  }
  directoryEntryOpenHookForTest = hook;
  return () => {
    if (directoryEntryOpenHookForTest === hook) directoryEntryOpenHookForTest = null;
  };
}

function fileRevision(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}`;
}

function matchesExpectedRevision(
  stats: BigIntStats,
  expectedModifiedAt: string,
  expectedRevision?: string,
): boolean {
  return expectedRevision
    ? fileRevision(stats) === expectedRevision
    : stats.mtime.toISOString() === expectedModifiedAt;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

interface ScopedPathParams {
  root: string;
  relativePath?: string;
}

interface ScopedPath {
  requestedPath: string;
  resolvedPath: string;
}

interface EntryPayloadParams {
  root: string;
  targetPath: string;
  name: string;
  kind: ExplorerEntryKind;
}

export async function listDirectoryEntries({
  root,
  relativePath = ".",
}: ListDirectoryParams): Promise<FileExplorerDirectory> {
  const opened = await openScopedPathForRead({
    root,
    relativePath,
    kind: "directory",
  });

  try {
    const stats = await opened.handle.stat();
    if (!stats.isDirectory()) {
      throw new Error("Requested path is not a directory");
    }

    const descriptorPath = descriptorPathFor(opened.handle);
    const dirents = await fs.readdir(descriptorPath, { withFileTypes: true });
    if (dirents.length > MAX_DIRECTORY_ENTRIES) {
      throw new Error(`Directory contains more than ${MAX_DIRECTORY_ENTRIES} entries`);
    }

    const entriesWithNulls = await mapWithConcurrency(
      dirents,
      DIRECTORY_ENTRY_OPEN_CONCURRENCY,
      async (dirent) => {
        const targetPath = path.join(opened.scoped.requestedPath, dirent.name);
        const kind: ExplorerEntryKind = dirent.isDirectory() ? "directory" : "file";
        try {
          return await buildDescriptorBoundEntryPayload({
            root,
            descriptorPath,
            targetPath,
            name: dirent.name,
            kind,
          });
        } catch (error) {
          // Directories can contain dangling links (e.g. AGENTS.md -> CLAUDE.md).
          // Skip entries whose targets disappeared instead of failing the whole listing.
          if (isMissingEntryError(error) || isOutsideWorkspaceError(error)) {
            return null;
          }
          throw error;
        }
      },
    );
    const entries = entriesWithNulls.filter((entry): entry is FileExplorerEntry => entry !== null);

    entries.sort((a, b) => {
      const modifiedComparison =
        new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
      if (modifiedComparison !== 0) {
        return modifiedComparison;
      }
      return a.name.localeCompare(b.name);
    });

    return {
      path: normalizeRelativePath({ root, targetPath: opened.scoped.requestedPath }),
      entries,
    };
  } finally {
    await opened.handle.close();
  }
}

export async function readExplorerFile({
  root,
  relativePath,
}: ReadFileParams): Promise<FileExplorerFile> {
  const file = await readExplorerFileBytes({ root, relativePath });

  if (file.kind === "image") {
    return {
      path: file.path,
      kind: file.kind,
      encoding: "base64",
      content: Buffer.from(file.bytes).toString("base64"),
      mimeType: file.mimeType,
      size: file.size,
      modifiedAt: file.modifiedAt,
      revision: file.revision,
    };
  }

  if (file.kind === "binary") {
    return {
      path: file.path,
      kind: file.kind,
      encoding: "none",
      mimeType: file.mimeType,
      size: file.size,
      modifiedAt: file.modifiedAt,
      revision: file.revision,
    };
  }

  return {
    path: file.path,
    kind: file.kind,
    encoding: "utf-8",
    content: Buffer.from(file.bytes).toString("utf-8"),
    mimeType: file.mimeType,
    size: file.size,
    modifiedAt: file.modifiedAt,
    revision: file.revision,
  };
}

export async function readExplorerFileBytes({
  root,
  relativePath,
}: ReadFileParams): Promise<FileExplorerFileBytes> {
  const opened = await openScopedPathForRead({ root, relativePath, kind: "file" });
  const { handle } = opened;

  try {
    const stats = await handle.stat({ bigint: true });

    if (!stats.isFile()) {
      throw new Error("Requested path is not a file");
    }

    const ext = path.extname(opened.actualPath).toLowerCase();
    const basePayload = {
      path: normalizeRelativePath({ root, targetPath: opened.scoped.requestedPath }),
      size: Number(stats.size),
      modifiedAt: stats.mtime.toISOString(),
      revision: fileRevision(stats),
    };

    const buffer = await handle.readFile();
    if (ext in IMAGE_MIME_TYPES) {
      return {
        ...basePayload,
        kind: "image",
        encoding: "binary",
        bytes: buffer,
        mimeType: IMAGE_MIME_TYPES[ext],
      };
    }

    if (isLikelyBinary(buffer) || !isValidUtf8(buffer)) {
      return {
        ...basePayload,
        kind: "binary",
        encoding: "binary",
        bytes: buffer,
        mimeType: "application/octet-stream",
      };
    }

    return {
      ...basePayload,
      kind: "text",
      encoding: "utf-8",
      bytes: buffer,
      mimeType: textMimeTypeForExtension(ext),
    };
  } finally {
    await handle.close();
  }
}

export async function streamExplorerFile(
  { root, relativePath }: ReadFileParams,
  consume: (file: FileExplorerFileStream) => Promise<void>,
): Promise<void> {
  const opened = await openScopedPathForRead({ root, relativePath, kind: "file" });
  const { handle } = opened;

  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) {
      throw new Error("Requested path is not a file");
    }

    const advertisedSize = Number(stats.size);
    const advertisedRevision = fileRevision(stats);
    const ext = path.extname(opened.actualPath).toLowerCase();
    const isImage = ext in IMAGE_MIME_TYPES;
    const isBinary = isImage || (await isFileHandleBinary(handle, advertisedSize));
    let kind: ExplorerFileKind = "text";
    let mimeType = textMimeTypeForExtension(ext);
    if (isImage) {
      kind = "image";
      mimeType = IMAGE_MIME_TYPES[ext];
    } else if (isBinary) {
      kind = "binary";
      mimeType = "application/octet-stream";
    }

    await consume({
      path: normalizeRelativePath({ root, targetPath: opened.scoped.requestedPath }),
      kind,
      encoding: isBinary ? "binary" : "utf-8",
      mimeType,
      size: advertisedSize,
      modifiedAt: stats.mtime.toISOString(),
      revision: advertisedRevision,
      chunks: readFileHandleChunks(handle, advertisedSize, advertisedRevision),
    });
  } finally {
    await handle.close();
  }
}

async function isFileHandleBinary(handle: FileHandle, advertisedSize: number): Promise<boolean> {
  if (advertisedSize === 0) return false;

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let position = 0;
  let suspiciousBytes = 0;
  while (position < advertisedSize) {
    const block = Buffer.allocUnsafe(
      Math.min(FILE_EXPLORER_STREAM_CHUNK_BYTES, advertisedSize - position),
    );
    const { bytesRead } = await handle.read(block, 0, block.byteLength, position);
    if (bytesRead === 0) {
      throw new Error("File changed during transfer");
    }
    const bytes = block.subarray(0, bytesRead);
    for (const byte of bytes) {
      if (byte === 0) return true;
      const isControl = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13;
      if (isControl || byte === 127) suspiciousBytes += 1;
    }
    try {
      decoder.decode(bytes, { stream: true });
    } catch {
      return true;
    }
    position += bytesRead;
  }

  try {
    decoder.decode();
  } catch {
    return true;
  }
  return suspiciousBytes / advertisedSize > 0.3;
}

async function* readFileHandleChunks(
  handle: FileHandle,
  advertisedSize: number,
  advertisedRevision: string,
): AsyncIterable<Uint8Array> {
  let position = 0;
  while (position < advertisedSize) {
    const chunk = Buffer.allocUnsafe(
      Math.min(FILE_EXPLORER_STREAM_CHUNK_BYTES, advertisedSize - position),
    );
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) {
      throw new Error("File changed during transfer");
    }
    position += bytesRead;
    yield chunk.subarray(0, bytesRead);
  }

  const finalStats = await handle.stat({ bigint: true });
  if (fileRevision(finalStats) !== advertisedRevision) {
    throw new Error("File changed during transfer");
  }
}

export async function getExplorerFileVersion({
  root,
  relativePath,
}: ReadFileParams): Promise<ExplorerFileVersion> {
  const cwd = expandUserPath(root);
  try {
    const filePath = await resolveScopedPath({ root, relativePath });
    const stats = await fs.stat(filePath.resolvedPath, { bigint: true });
    if (!stats.isFile()) {
      return { status: "error", cwd, path: relativePath, error: "Requested path is not a file" };
    }
    return {
      status: "ready",
      cwd,
      path: normalizeRelativePath({ root, targetPath: filePath.requestedPath }),
      size: Number(stats.size),
      modifiedAt: stats.mtime.toISOString(),
      revision: fileRevision(stats),
    };
  } catch (error) {
    if (isMissingEntryError(error)) {
      return { status: "missing", cwd, path: relativePath };
    }
    return {
      status: "error",
      cwd,
      path: relativePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function resolveExplorerFilePath({
  root,
  relativePath,
}: ReadFileParams): Promise<string> {
  return (await resolveScopedPath({ root, relativePath })).resolvedPath;
}

export async function writeExplorerFile({
  root,
  relativePath,
  content,
  expectedModifiedAt,
  expectedRevision,
}: WriteFileParams): Promise<ExplorerFileWriteResult> {
  const encoded = Buffer.from(content, "utf8");
  if (encoded.byteLength > MAX_EDITABLE_FILE_BYTES) {
    return { status: "error", error: "File is too large to edit" };
  }

  let filePath: ScopedPath;
  let currentMode = 0o600;
  try {
    filePath = await resolveScopedPath({ root, relativePath });
    const handle = await openFileForRead(filePath.resolvedPath);
    try {
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile()) {
        return { status: "error", error: "Requested path is not a file" };
      }
      if (stats.size > BigInt(MAX_EDITABLE_FILE_BYTES)) {
        return { status: "error", error: "File is too large to edit" };
      }
      const current = await handle.readFile();
      if (isLikelyBinary(current) || !isValidUtf8(current)) {
        return { status: "error", error: "Binary files cannot be edited" };
      }
      currentMode = Number(stats.mode);
      const modifiedAt = stats.mtime.toISOString();
      if (!matchesExpectedRevision(stats, expectedModifiedAt, expectedRevision)) {
        return {
          status: "conflict",
          version: {
            status: "ready",
            cwd: expandUserPath(root),
            path: normalizeRelativePath({ root, targetPath: filePath.requestedPath }),
            size: Number(stats.size),
            modifiedAt,
            revision: fileRevision(stats),
          },
        };
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissingEntryError(error)) {
      return {
        status: "conflict",
        version: { status: "missing", cwd: expandUserPath(root), path: relativePath },
      };
    }
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }

  const temporaryPath = path.join(
    path.dirname(filePath.resolvedPath),
    `.${path.basename(filePath.resolvedPath)}.paseo-${randomUUID()}.tmp`,
  );
  let temporaryHandle: FileHandle | null = null;
  try {
    temporaryHandle = await fs.open(temporaryPath, "wx", currentMode);
    if (process.platform !== "win32") {
      await temporaryHandle.chmod(currentMode & 0o7777);
    }
    await temporaryHandle.writeFile(encoded);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;
    const latestStats = await fs.stat(filePath.resolvedPath, { bigint: true });
    if (!matchesExpectedRevision(latestStats, expectedModifiedAt, expectedRevision)) {
      return {
        status: "conflict",
        version: {
          status: "ready",
          cwd: expandUserPath(root),
          path: normalizeRelativePath({ root, targetPath: filePath.requestedPath }),
          size: Number(latestStats.size),
          modifiedAt: latestStats.mtime.toISOString(),
          revision: fileRevision(latestStats),
        },
      };
    }
    await fs.rename(temporaryPath, filePath.resolvedPath);
    const stats = await fs.stat(filePath.resolvedPath, { bigint: true });
    return {
      status: "written",
      modifiedAt: stats.mtime.toISOString(),
      size: Number(stats.size),
      revision: fileRevision(stats),
    };
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

export async function getDownloadableFileInfo({ root, relativePath }: ReadFileParams): Promise<{
  path: string;
  absolutePath: string;
  fileName: string;
  mimeType: string;
  size: number;
}> {
  const filePath = await resolveScopedPath({ root, relativePath });
  const handle = await openFileForRead(filePath.resolvedPath);

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw new Error("Requested path is not a file");
    }

    const ext = path.extname(filePath.resolvedPath).toLowerCase();
    let mimeType = "application/octet-stream";
    if (ext in IMAGE_MIME_TYPES) {
      mimeType = IMAGE_MIME_TYPES[ext];
    } else {
      const sample = Buffer.alloc(FILE_TYPE_SAMPLE_BYTES);
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
      const chunk = bytesRead < sample.length ? sample.subarray(0, bytesRead) : sample;
      if (!isLikelyBinary(chunk)) {
        mimeType = textMimeTypeForExtension(ext);
      }
    }

    return {
      path: normalizeRelativePath({ root, targetPath: filePath.requestedPath }),
      absolutePath: filePath.resolvedPath,
      fileName: path.basename(filePath.requestedPath),
      mimeType,
      size: stats.size,
    };
  } finally {
    await handle.close();
  }
}

export interface ExplorerCreateEntryParams {
  root: string;
  parentPath: string;
  name: string;
  kind: ExplorerEntryKind;
}

export interface ExplorerRenameEntryParams {
  root: string;
  relativePath: string;
  name: string;
}

export type ExplorerEntryMutationResult =
  | { status: "ok"; path: string }
  | { status: "error"; error: string };

export async function createExplorerEntry({
  root,
  parentPath,
  name,
  kind,
}: ExplorerCreateEntryParams): Promise<ExplorerEntryMutationResult> {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName === "." || trimmedName === "..") {
    return { status: "error", error: "Invalid name" };
  }
  if (trimmedName.includes("/") || trimmedName.includes("\\")) {
    return { status: "error", error: "Name cannot contain path separators" };
  }

  try {
    const parent = await resolveScopedPath({ root, relativePath: parentPath });
    const parentStats = await fs.stat(parent.resolvedPath);
    if (!parentStats.isDirectory()) {
      return { status: "error", error: "Parent path is not a directory" };
    }
    const targetPath = path.join(parent.resolvedPath, trimmedName);
    if (kind === "directory") {
      await fs.mkdir(targetPath);
    } else {
      const handle = await fs.open(targetPath, "wx", 0o644);
      await handle.close();
    }
    return {
      status: "ok",
      path: normalizeRelativePath({
        root,
        targetPath: path.join(parent.requestedPath, trimmedName),
      }),
    };
  } catch (error) {
    if (isEntryExistsError(error)) {
      return { status: "error", error: `"${trimmedName}" already exists` };
    }
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function duplicateExplorerEntry({
  root,
  relativePath,
}: ReadFileParams): Promise<ExplorerEntryMutationResult> {
  try {
    const source = await resolveScopedPath({ root, relativePath });
    const realRoot = await fs.realpath(expandUserPath(root));
    if (source.resolvedPath === realRoot) {
      return { status: "error", error: "Cannot duplicate the workspace root" };
    }

    const stats = await fs.lstat(source.requestedPath);
    const sourceName = path.basename(source.requestedPath);
    const extension = stats.isDirectory() ? "" : path.extname(sourceName);
    const baseName = extension ? sourceName.slice(0, -extension.length) : sourceName;
    let targetPath = "";
    for (let copyNumber = 1; ; copyNumber += 1) {
      const suffix = copyNumber === 1 ? " copy" : ` copy ${copyNumber}`;
      targetPath = path.join(
        path.dirname(source.requestedPath),
        `${baseName}${suffix}${extension}`,
      );
      try {
        await fs.lstat(targetPath);
      } catch (error) {
        if (isMissingEntryError(error)) {
          break;
        }
        throw error;
      }
    }

    await fs.cp(source.requestedPath, targetPath, {
      recursive: stats.isDirectory(),
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    return { status: "ok", path: normalizeRelativePath({ root, targetPath }) };
  } catch (error) {
    if (isMissingEntryError(error)) {
      return { status: "error", error: "File or folder no longer exists" };
    }
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function renameExplorerEntry({
  root,
  relativePath,
  name,
}: ExplorerRenameEntryParams): Promise<ExplorerEntryMutationResult> {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName === "." || trimmedName === "..") {
    return { status: "error", error: "Invalid name" };
  }
  if (trimmedName.includes("/") || trimmedName.includes("\\")) {
    return { status: "error", error: "Name cannot contain path separators" };
  }

  try {
    const source = await resolveScopedPath({ root, relativePath });
    const realRoot = await fs.realpath(expandUserPath(root));
    if (source.resolvedPath === realRoot) {
      return { status: "error", error: "Cannot rename the workspace root" };
    }

    const targetPath = path.join(path.dirname(source.requestedPath), trimmedName);
    const sourceStats = await fs.lstat(source.requestedPath);
    const targetStats = await fs.lstat(targetPath).catch((error: unknown) => {
      if (isMissingEntryError(error)) {
        return null;
      }
      throw error;
    });
    if (
      targetStats &&
      (targetStats.dev !== sourceStats.dev || targetStats.ino !== sourceStats.ino)
    ) {
      return { status: "error", error: `"${trimmedName}" already exists` };
    }

    const sourcePath = normalizeRelativePath({ root, targetPath: source.requestedPath });
    const renamedPath = normalizeRelativePath({ root, targetPath });
    if (sourcePath === renamedPath) {
      return { status: "ok", path: renamedPath };
    }
    const repository = await runGitCommand(["rev-parse", "--is-inside-work-tree"], {
      cwd: realRoot,
      acceptExitCodes: [0, 128],
    });
    const tracked =
      repository.exitCode === 0
        ? await runGitCommand(["ls-files", "-z", "--", sourcePath], { cwd: realRoot })
        : null;
    if (tracked?.stdout) {
      await runGitCommand(["mv", "--", sourcePath, renamedPath], { cwd: realRoot });
    } else {
      await fs.rename(source.requestedPath, targetPath);
    }
    return { status: "ok", path: renamedPath };
  } catch (error) {
    if (isEntryExistsError(error)) {
      return { status: "error", error: `"${trimmedName}" already exists` };
    }
    if (isMissingEntryError(error)) {
      return { status: "error", error: "File or folder no longer exists" };
    }
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function deleteExplorerEntry({
  root,
  relativePath,
}: ReadFileParams): Promise<ExplorerEntryMutationResult> {
  try {
    const scoped = await resolveScopedPath({ root, relativePath });
    const realRoot = await fs.realpath(expandUserPath(root));
    if (scoped.resolvedPath === realRoot) {
      return { status: "error", error: "Cannot delete the workspace root" };
    }
    // Remove the requested path, not the realpath: deleting a symlink must
    // remove the link, never its target. lstat keeps the same guarantee.
    const stats = await fs.lstat(scoped.requestedPath);
    await fs.rm(scoped.requestedPath, {
      recursive: stats.isDirectory(),
      force: false,
    });
    return {
      status: "ok",
      path: normalizeRelativePath({ root, targetPath: scoped.requestedPath }),
    };
  } catch (error) {
    if (isMissingEntryError(error)) {
      return { status: "error", error: "File or folder no longer exists" };
    }
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

function isEntryExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

async function resolveScopedPath({
  root,
  relativePath = ".",
}: ScopedPathParams): Promise<ScopedPath> {
  const normalizedRoot = expandUserPath(root);
  const requestedPath = resolvePathFromBase(normalizedRoot, relativePath);
  const relative = path.relative(normalizedRoot, requestedPath);

  if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error(ACCESS_OUTSIDE_WORKSPACE_MESSAGE);
  }

  const realRoot = await fs.realpath(normalizedRoot);

  try {
    const realPath = await fs.realpath(requestedPath);
    const realRelative = path.relative(realRoot, realPath);
    if (realRelative !== "" && (realRelative.startsWith("..") || path.isAbsolute(realRelative))) {
      throw new Error(ACCESS_OUTSIDE_WORKSPACE_MESSAGE);
    }
    return { requestedPath, resolvedPath: realPath };
  } catch (error) {
    if (isMissingEntryError(error)) {
      return { requestedPath, resolvedPath: requestedPath };
    }
    throw error;
  }
}

async function openFileForRead(filePath: string): Promise<FileHandle> {
  return fs.open(filePath, READ_FILE_OPEN_FLAGS);
}

interface OpenedScopedPath {
  scoped: ScopedPath;
  handle: FileHandle;
  actualPath: string;
}

async function openScopedPathForRead(input: {
  root: string;
  relativePath: string;
  kind: ExplorerEntryKind;
}): Promise<OpenedScopedPath> {
  const scoped = await resolveScopedPath(input);
  const hook = beforeScopedReadOpenForTest;
  beforeScopedReadOpenForTest = null;
  await hook?.();
  let handle: FileHandle;
  try {
    handle = await fs.open(
      scoped.requestedPath,
      input.kind === "directory" ? READ_DIRECTORY_OPEN_FLAGS : READ_FILE_OPEN_FLAGS,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOTDIR" || code === "ELOOP") {
      try {
        const [realRoot, currentTarget] = await Promise.all([
          fs.realpath(expandUserPath(input.root)),
          fs.realpath(scoped.requestedPath),
        ]);
        requirePathWithinRoot(realRoot, currentTarget);
      } catch (validationError) {
        if (isOutsideWorkspaceError(validationError)) throw validationError;
      }
    }
    throw error;
  }
  try {
    const actualPath = await validateOpenedPathWithinRoot(handle, input.root);
    return { scoped, handle, actualPath };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function descriptorPathFor(handle: FileHandle): string {
  if (process.platform !== "linux") {
    throw new Error("descriptor-bound workspace reads require Linux");
  }
  return `/proc/self/fd/${handle.fd}`;
}

async function validateOpenedPathWithinRoot(handle: FileHandle, root: string): Promise<string> {
  const realRoot = await fs.realpath(expandUserPath(root));
  if (process.platform === "linux") {
    const actualPath = await fs.realpath(descriptorPathFor(handle));
    requirePathWithinRoot(realRoot, actualPath);
    return actualPath;
  }
  throw new Error("descriptor-bound workspace reads require Linux");
}

function requirePathWithinRoot(realRoot: string, targetPath: string): void {
  const relative = path.relative(realRoot, targetPath);
  if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error(ACCESS_OUTSIDE_WORKSPACE_MESSAGE);
  }
}

async function buildDescriptorBoundEntryPayload({
  root,
  descriptorPath,
  targetPath,
  name,
  kind,
}: EntryPayloadParams & { descriptorPath: string }): Promise<FileExplorerEntry> {
  const handle = await fs.open(path.join(descriptorPath, name), constants.O_RDONLY);
  let hookOpened = false;
  try {
    const hook = directoryEntryOpenHookForTest;
    if (hook) {
      hookOpened = true;
      await hook("opened");
    }
    await validateOpenedPathWithinRoot(handle, root);
    const stats = await handle.stat();
    return {
      name,
      path: normalizeRelativePath({ root, targetPath }),
      kind,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  } finally {
    await handle.close();
    if (hookOpened) await directoryEntryOpenHookForTest?.("closed");
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await map(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function isMissingEntryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function isOutsideWorkspaceError(error: unknown): boolean {
  return error instanceof Error && error.message === ACCESS_OUTSIDE_WORKSPACE_MESSAGE;
}

function normalizeRelativePath({ root, targetPath }: { root: string; targetPath: string }): string {
  const normalizedRoot = expandUserPath(root);
  const normalizedTarget = expandUserPath(targetPath);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function textMimeTypeForExtension(ext: string): string {
  return TEXT_MIME_TYPES[ext] ?? DEFAULT_TEXT_MIME_TYPE;
}

function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }

  let suspicious = 0;
  for (let idx = 0; idx < buffer.length; idx += 1) {
    const byte = buffer[idx];
    if (byte === 0) {
      return true;
    }

    const isControl =
      byte < 32 &&
      byte !== 9 && // tab
      byte !== 10 && // newline
      byte !== 13; // carriage return

    if (isControl || byte === 127) {
      suspicious += 1;
    }
  }

  return suspicious / buffer.length > 0.3;
}

function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}
