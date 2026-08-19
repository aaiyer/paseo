import type pino from "pino";
import type {
  CaptureTerminalRequest,
  CreateTerminalRequest,
  KillTerminalRequest,
  ListTerminalsRequest,
  RenameTerminalRequest,
  SessionInboundMessage,
  SessionOutboundMessage,
  SubscribeTerminalRequest,
  SubscribeTerminalsRequest,
  TerminalInput,
  UnsubscribeTerminalRequest,
  UnsubscribeTerminalsRequest,
} from "../server/messages.js";
import { killTerminalsForWorkspace as killWorkspaceTerminals } from "../server/workspace-archive-service.js";
import {
  TerminalStreamOpcode,
  decodeTerminalResizePayload,
  encodeTerminalStreamFrame,
  type TerminalStreamFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { TerminalOutputCoalescer } from "./terminal-output-coalescer.js";
import {
  MAX_CLIENT_BUFFERED_BYTES,
  MAX_TERMINAL_OUTPUT_FRAME_BYTES,
  encodeLegacyTerminalSnapshotFrame,
  encodeTerminalRestoreFrame,
  resolveRestoreAfterOutputOverflow,
  resolveTerminalRestoreSnapshotOptions,
  resolveTerminalSubscriptionSnapshotMode,
  type TerminalRestoreOptions,
} from "./terminal-restore.js";
import type { TerminalSession } from "./terminal.js";
import type { TerminalManager, TerminalsChangedEvent } from "./terminal-manager.js";
import { applyTerminalSize } from "./terminal-size-ownership.js";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";
import { terminalSubscriptionKey } from "@getpaseo/protocol/terminal-subscription-key";
import type { MayaRestrictedWorkspaceAuthority } from "../server/maya-restricted-mode.js";

const MAX_TERMINAL_STREAM_SLOTS = 256;
const MAX_RESTRICTED_PENDING_BINARY_FRAMES = 64;
const MAX_RESTRICTED_PENDING_OUTPUT_FRAMES = 64;
const MAX_RESTRICTED_PENDING_OUTPUT_BYTES = 1024 * 1024;
export const MAYA_RESTRICTED_TERMINAL_AUTHORITY_DIAGNOSTIC =
  "maya_restricted_terminal_authority_drift";

interface BufferedTerminalOutput {
  data: string;
  revision?: number;
}

interface ActiveTerminalStream {
  terminalId: string;
  slot: number;
  generation: number;
  unsubscribe: () => void;
  needsSnapshot: boolean;
  snapshotInFlight: boolean;
  readyRevision?: number;
  restore?: TerminalRestoreOptions;
  bufferedOutputs: BufferedTerminalOutput[];
  outputBytesSinceSnapshot: number;
  restrictedEmissionTail: Promise<void>;
  restrictedPendingOutputFrames: number;
  restrictedPendingOutputBytes: number;
  outputCoalescer: TerminalOutputCoalescer;
}

interface SnapshotSendResult {
  shouldContinue: boolean;
  replayRevision?: number;
}

export interface TerminalSessionControllerOptions {
  terminalManager: TerminalManager | null;
  emit: (msg: SessionOutboundMessage) => void;
  emitBinary: (frame: Uint8Array) => void;
  hasBinaryChannel: () => boolean;
  isPathWithinRoot: (rootPath: string, candidatePath: string) => boolean;
  sessionLogger: pino.Logger;
  listTerminalWorkspaceRefs?: () => Promise<readonly TerminalWorkspaceRef[]>;
  listTerminalWorkspaceRoots?: () => Promise<readonly string[]>;
  // Whether the connected client can reflow restored snapshots. When true the
  // daemon attaches per-row soft-wrap flags to snapshots; otherwise it omits them
  // so old (strict-schema) clients still parse the snapshot.
  clientSupportsWrapReflow?: () => boolean;
  // Current max bytes queued on the client's transport(s) but not yet sent.
  // Drives the snapshot catch-up fallback: a keeping-up client reports ~0 and
  // keeps streaming; a backed-up client trips the snapshot path. Defaults to a
  // constant 0 (no backpressure signal) so callers without a transport always
  // stream.
  // Bytes queued on the client transport but not yet sent, or null when the
  // transport exposes no backpressure signal (e.g. the multiplexed relay socket).
  getClientBufferedAmount?: () => number | null;
}

interface TerminalWorkspaceRef {
  workspaceId: string;
  cwd: string;
}

export interface TerminalSessionControllerMetrics {
  directorySubscriptionCount: number;
  streamSubscriptionCount: number;
}

type TerminalDispatchableMessage =
  | SubscribeTerminalsRequest
  | UnsubscribeTerminalsRequest
  | ListTerminalsRequest
  | CreateTerminalRequest
  | SubscribeTerminalRequest
  | UnsubscribeTerminalRequest
  | TerminalInput
  | KillTerminalRequest
  | CaptureTerminalRequest
  | RenameTerminalRequest;

const TERMINAL_MESSAGE_TYPES: ReadonlySet<TerminalDispatchableMessage["type"]> = new Set([
  "subscribe_terminals_request",
  "unsubscribe_terminals_request",
  "list_terminals_request",
  "create_terminal_request",
  "subscribe_terminal_request",
  "unsubscribe_terminal_request",
  "terminal_input",
  "kill_terminal_request",
  "capture_terminal_request",
  "terminal.rename.request",
]);

export class TerminalSessionController {
  private readonly terminalManager: TerminalManager | null;
  private readonly emit: (msg: SessionOutboundMessage) => void;
  private readonly emitBinary: (frame: Uint8Array) => void;
  private readonly hasBinaryChannel: () => boolean;
  private readonly isPathWithinRoot: (rootPath: string, candidatePath: string) => boolean;
  private readonly sessionLogger: pino.Logger;
  private readonly listTerminalWorkspaceRefs: () => Promise<readonly TerminalWorkspaceRef[]>;
  private readonly listTerminalWorkspaceRoots: () => Promise<readonly string[]>;
  private readonly clientSupportsWrapReflow: () => boolean;
  private readonly getClientBufferedAmount: () => number | null;
  private readonly terminalSizeOwner = {};

  // A subscription is scoped to a (cwd, workspaceId) pair, keyed by
  // terminalSubscriptionKey: two workspaces sharing a cwd subscribe and unsub
  // independently, and each only receives its own workspace's terminals. The
  // workspaceId is absent for old clients, which key to the cwd alone.
  private readonly subscribedDirectories = new Map<
    string,
    { cwd: string; workspaceId: string | undefined; generation: number }
  >();
  private unsubscribeTerminalsChanged: (() => void) | null = null;
  private readonly exitSubscriptions = new Map<string, () => void>();
  private readonly restrictedTerminalAuthorities = new Map<
    string,
    MayaRestrictedWorkspaceAuthority
  >();
  private readonly restrictedDirectoryAuthorities = new Map<
    string,
    MayaRestrictedWorkspaceAuthority
  >();
  private readonly activeStreams = new Map<number, ActiveTerminalStream>();
  private readonly idToSlot = new Map<string, number>();
  private nextSlot = 0;
  private nextStreamGeneration = 1;
  private nextDirectoryGeneration = 1;
  private nextTerminalAdmissionGeneration = 1;
  private readonly terminalAdmissionGenerations = new Map<string, number>();
  private restrictedBinaryTail: Promise<void> = Promise.resolve();
  private restrictedPendingBinaryFrames = 0;

  constructor(options: TerminalSessionControllerOptions) {
    this.terminalManager = options.terminalManager;
    this.emit = options.emit;
    this.emitBinary = options.emitBinary;
    this.hasBinaryChannel = options.hasBinaryChannel;
    this.isPathWithinRoot = options.isPathWithinRoot;
    this.sessionLogger = options.sessionLogger;
    this.listTerminalWorkspaceRefs = options.listTerminalWorkspaceRefs ?? (async () => []);
    this.listTerminalWorkspaceRoots =
      options.listTerminalWorkspaceRoots ??
      (async () => (await this.listTerminalWorkspaceRefs()).map((workspace) => workspace.cwd));
    this.clientSupportsWrapReflow = options.clientSupportsWrapReflow ?? (() => false);
    this.getClientBufferedAmount = options.getClientBufferedAmount ?? (() => 0);
  }

  start(): void {
    if (!this.terminalManager) {
      return;
    }
    this.unsubscribeTerminalsChanged = this.terminalManager.subscribeTerminalsChanged((event) => {
      void this.handleTerminalsChanged(event);
    });
  }

  getMetrics(): TerminalSessionControllerMetrics {
    return {
      directorySubscriptionCount: this.subscribedDirectories.size,
      streamSubscriptionCount: this.activeStreams.size,
    };
  }

  dispatch(
    msg: SessionInboundMessage,
    options: {
      mayaRestrictedMode?: boolean;
      workspaceAuthority?: MayaRestrictedWorkspaceAuthority | null;
    } = {},
  ): Promise<void> | undefined {
    if (!isTerminalMessage(msg)) {
      return undefined;
    }
    switch (msg.type) {
      case "subscribe_terminals_request":
        return this.handleSubscribeTerminalsRequest(msg, options);
      case "unsubscribe_terminals_request":
        return this.handleUnsubscribeTerminalsRequest(msg, options);
      case "list_terminals_request":
        return this.handleListTerminalsRequest(msg, options);
      case "create_terminal_request":
        return this.handleCreateTerminalRequest(msg, options);
      case "subscribe_terminal_request":
        return this.handleSubscribeTerminalRequest(msg, options.mayaRestrictedMode === true);
      case "unsubscribe_terminal_request":
        this.handleUnsubscribeTerminalRequest(msg);
        return undefined;
      case "terminal_input":
        return this.handleTerminalInput(msg, options.mayaRestrictedMode === true);
      case "kill_terminal_request":
        return this.handleKillTerminalRequest(msg, options.mayaRestrictedMode === true);
      case "capture_terminal_request":
        return this.handleCaptureTerminalRequest(msg, options.mayaRestrictedMode === true);
      case "terminal.rename.request":
        return this.handleRenameTerminalRequest(msg, options.mayaRestrictedMode === true);
      default:
        return undefined;
    }
  }

  async handleBinaryFrame(frame: TerminalStreamFrame, mayaRestrictedMode = false): Promise<void> {
    if (!mayaRestrictedMode) {
      await this.processBinaryFrame(frame, false);
      return;
    }
    if (this.restrictedPendingBinaryFrames >= MAX_RESTRICTED_PENDING_BINARY_FRAMES) {
      const activeStream = this.activeStreams.get(frame.slot);
      const terminal = activeStream
        ? this.terminalManager?.getTerminal(activeStream.terminalId)
        : undefined;
      if (terminal) {
        await this.terminateRestrictedTerminalAndWait(
          terminal,
          "Terminal input authority queue exceeded its bound",
        );
      }
      return;
    }
    this.restrictedPendingBinaryFrames += 1;
    const operation = this.restrictedBinaryTail.then(() => this.processBinaryFrame(frame, true));
    this.restrictedBinaryTail = operation
      .catch((error) => {
        this.sessionLogger.warn(
          { err: error },
          "Failed to process restricted terminal binary frame",
        );
      })
      .finally(() => {
        this.restrictedPendingBinaryFrames -= 1;
      });
    await operation;
  }

  private async processBinaryFrame(
    frame: TerminalStreamFrame,
    mayaRestrictedMode: boolean,
  ): Promise<void> {
    const activeStream = this.activeStreams.get(frame.slot);
    if (!activeStream || !this.terminalManager) {
      return;
    }
    const terminal = this.terminalManager.getTerminal(activeStream.terminalId);
    if (!terminal) {
      this.detachStream(activeStream.terminalId, { emitExit: true });
      return;
    }
    if (mayaRestrictedMode && !(await this.validateRestrictedTerminalAuthority(terminal))) {
      await this.terminateRestrictedTerminalAndWait(
        terminal,
        "Terminal workspace authority is unavailable",
      );
      return;
    }
    if (
      this.activeStreams.get(frame.slot) !== activeStream ||
      this.activeStreams.get(frame.slot)?.generation !== activeStream.generation ||
      this.idToSlot.get(terminal.id) !== frame.slot ||
      this.terminalManager.getTerminal(activeStream.terminalId) !== terminal
    ) {
      return;
    }

    switch (frame.opcode) {
      case TerminalStreamOpcode.Input: {
        if (frame.payload.byteLength === 0) {
          return;
        }
        const text = Buffer.from(frame.payload).toString("utf8");
        if (!text) {
          return;
        }
        terminal.send({ type: "input", data: text });
        return;
      }

      case TerminalStreamOpcode.Resize: {
        const resize = decodeTerminalResizePayload(frame.payload);
        if (!resize) {
          return;
        }
        applyTerminalSize(terminal, this.terminalSizeOwner, resize);
        return;
      }

      default:
        return;
    }
  }

  killTerminalForClose(terminalId: string): {
    terminalId: string;
    success: boolean;
  } {
    if (!this.terminalManager) {
      return { terminalId, success: false };
    }
    this.killTracked(terminalId, { emitExit: true });
    return { terminalId, success: true };
  }

  async killTerminalsForWorkspace(workspaceId: string): Promise<void> {
    return killWorkspaceTerminals(
      {
        detachTerminalStream: (terminalId, options) => void this.detachStream(terminalId, options),
        sessionLogger: this.sessionLogger,
        terminalManager: this.terminalManager,
      },
      workspaceId,
    );
  }

  async dispose(): Promise<void> {
    if (this.unsubscribeTerminalsChanged) {
      this.unsubscribeTerminalsChanged();
      this.unsubscribeTerminalsChanged = null;
    }
    this.subscribedDirectories.clear();
    this.terminalAdmissionGenerations.clear();

    for (const unsubscribeExit of this.exitSubscriptions.values()) {
      unsubscribeExit();
    }
    this.exitSubscriptions.clear();

    for (const terminalId of Array.from(this.idToSlot.keys())) {
      this.detachStream(terminalId, { emitExit: false });
    }
    const releases: Promise<void>[] = [];
    for (const authority of this.restrictedTerminalAuthorities.values()) {
      releases.push(authority.release());
    }
    this.restrictedTerminalAuthorities.clear();
    for (const authority of this.restrictedDirectoryAuthorities.values()) {
      releases.push(authority.release());
    }
    this.restrictedDirectoryAuthorities.clear();
    await Promise.all(releases);
  }

  private async replaceRestrictedDirectoryAuthority(
    key: string,
    authority: MayaRestrictedWorkspaceAuthority,
    subscription: {
      cwd: string;
      workspaceId: string | undefined;
      generation: number;
    },
  ): Promise<void> {
    const previous = this.restrictedDirectoryAuthorities.get(key);
    const retained = authority.retain();
    if (this.restrictedDirectoryAuthorities.get(key) === previous) {
      this.restrictedDirectoryAuthorities.delete(key);
    }
    await previous?.release();
    if (this.subscribedDirectories.get(key) !== subscription) {
      await retained.release();
      return;
    }
    this.restrictedDirectoryAuthorities.set(key, retained);
  }

  private async releaseRestrictedDirectoryAuthority(key: string): Promise<void> {
    const authority = this.restrictedDirectoryAuthorities.get(key);
    if (!authority) return;
    this.restrictedDirectoryAuthorities.delete(key);
    await authority.release();
  }

  private async bindRestrictedTerminalAuthority(
    terminal: TerminalSession,
    authority: MayaRestrictedWorkspaceAuthority,
  ): Promise<void> {
    if (terminal.cwd !== authority.cwd || terminal.workspaceId !== authority.workspaceId) {
      throw new Error("terminal identity does not match selected workspace authority");
    }
    if (!(await authority.isCurrent())) {
      throw new Error("terminal workspace authority changed during admission");
    }
    const previous = this.restrictedTerminalAuthorities.get(terminal.id);
    if (previous === authority) return;
    this.restrictedTerminalAuthorities.set(terminal.id, authority.retain());
    await previous?.release();
  }

  private async validateRestrictedTerminalAuthority(terminal: TerminalSession): Promise<boolean> {
    const authority = this.restrictedTerminalAuthorities.get(terminal.id);
    if (!authority) return false;
    if (
      terminal.cwd !== authority.cwd ||
      terminal.workspaceId !== authority.workspaceId ||
      !(await authority.isCurrent())
    ) {
      this.restrictedTerminalAuthorities.delete(terminal.id);
      await authority.release();
      return false;
    }
    return true;
  }

  private async ensureRestrictedTerminalAuthority(terminal: TerminalSession): Promise<boolean> {
    return this.validateRestrictedTerminalAuthority(terminal);
  }

  private async terminateRestrictedTerminalAndWait(
    terminal: TerminalSession,
    reason: string,
  ): Promise<string> {
    this.sessionLogger.warn(
      {
        event: MAYA_RESTRICTED_TERMINAL_AUTHORITY_DIAGNOSTIC,
        terminalId: terminal.id,
        cwd: terminal.cwd,
        workspaceId: terminal.workspaceId,
        reason,
      },
      "Maya restricted terminal authority drifted; terminating terminal",
    );
    this.detachStream(terminal.id, { emitExit: true });
    await this.terminalManager?.killTerminalAndWait(terminal.id);
    const authority = this.restrictedTerminalAuthorities.get(terminal.id);
    if (authority) {
      this.restrictedTerminalAuthorities.delete(terminal.id);
      await authority.release();
    }
    return reason;
  }

  private ensureExitSubscription(terminal: TerminalSession): void {
    if (this.exitSubscriptions.has(terminal.id)) {
      return;
    }
    const unsubscribeExit = terminal.onExit(() => {
      this.handleTerminalExited(terminal.id);
    });
    this.exitSubscriptions.set(terminal.id, unsubscribeExit);
  }

  private handleTerminalExited(terminalId: string): void {
    const unsubscribeExit = this.exitSubscriptions.get(terminalId);
    if (unsubscribeExit) {
      unsubscribeExit();
      this.exitSubscriptions.delete(terminalId);
    }
    const authority = this.restrictedTerminalAuthorities.get(terminalId);
    if (authority) {
      this.restrictedTerminalAuthorities.delete(terminalId);
      void authority.release();
    }
    this.detachStream(terminalId, { emitExit: true });
  }

  private emitTerminalsChangedSnapshot(input: {
    cwd: string;
    terminals: Array<{
      id: string;
      name: string;
      workspaceId: string;
      title?: string;
      activity: TerminalActivity | null;
    }>;
  }): void {
    this.emit({
      type: "terminals_changed",
      payload: {
        cwd: input.cwd,
        terminals: input.terminals,
      },
    });
  }

  private toTerminalInfo(
    terminal: Pick<TerminalSession, "id" | "name" | "workspaceId" | "getTitle" | "getActivity">,
  ): {
    id: string;
    name: string;
    workspaceId: string;
    title?: string;
    activity: TerminalActivity | null;
  } {
    const title = terminal.getTitle();
    const activity = terminal.getActivity();
    return {
      id: terminal.id,
      name: terminal.name,
      workspaceId: terminal.workspaceId,
      ...(title ? { title } : {}),
      activity,
    };
  }

  private async handleTerminalsChanged(event: TerminalsChangedEvent): Promise<void> {
    // A terminal can live in a subdirectory of a subscribed workspace root (an
    // agent can open one there). Deliver the change to every subscribed root at
    // or above the terminal's cwd, keyed by that root, carrying the full
    // aggregated list — so the client's cache replacement doesn't drop the
    // terminals that live directly at the root.
    const matchingSubscriptions = Array.from(this.subscribedDirectories.values()).filter(
      (subscription) => this.isPathWithinRoot(subscription.cwd, event.cwd),
    );
    for (const subscription of matchingSubscriptions) {
      await this.emitTerminalsSnapshotForSubscription(subscription);
    }
  }

  private async handleSubscribeTerminalsRequest(
    msg: SubscribeTerminalsRequest,
    options: {
      mayaRestrictedMode?: boolean;
      workspaceAuthority?: MayaRestrictedWorkspaceAuthority | null;
    },
  ): Promise<void> {
    const subscription = {
      cwd: msg.cwd,
      workspaceId: msg.workspaceId,
      generation: this.nextDirectoryGeneration,
    };
    this.nextDirectoryGeneration += 1;
    const key = terminalSubscriptionKey(msg.cwd, msg.workspaceId);
    this.subscribedDirectories.set(key, subscription);
    if (options.mayaRestrictedMode) {
      const authority = options.workspaceAuthority;
      if (!authority || msg.workspaceId !== authority.workspaceId || msg.cwd !== authority.cwd) {
        throw new Error("terminal directory subscription lacks selected workspace authority");
      }
      await this.replaceRestrictedDirectoryAuthority(key, authority, subscription);
      if (this.subscribedDirectories.get(key) !== subscription) return;
    }
    await this.emitTerminalsSnapshotForSubscription(subscription);
  }

  private async handleUnsubscribeTerminalsRequest(
    msg: UnsubscribeTerminalsRequest,
    options: {
      mayaRestrictedMode?: boolean;
      workspaceAuthority?: MayaRestrictedWorkspaceAuthority | null;
    },
  ): Promise<void> {
    const key = terminalSubscriptionKey(msg.cwd, msg.workspaceId);
    if (options.mayaRestrictedMode) {
      const authority = options.workspaceAuthority;
      if (!authority || msg.workspaceId !== authority.workspaceId || msg.cwd !== authority.cwd) {
        throw new Error("terminal directory unsubscription lacks selected workspace authority");
      }
    }
    this.subscribedDirectories.delete(key);
    await this.releaseRestrictedDirectoryAuthority(key);
  }

  private async emitTerminalsSnapshotForSubscription(subscription: {
    cwd: string;
    workspaceId: string | undefined;
    generation: number;
  }): Promise<void> {
    const key = terminalSubscriptionKey(subscription.cwd, subscription.workspaceId);
    if (!this.terminalManager || !this.subscribedDirectories.has(key)) {
      return;
    }
    try {
      const restrictedAuthority = this.restrictedDirectoryAuthorities.get(key);
      if (restrictedAuthority && !(await restrictedAuthority.isCurrent())) {
        const terminals = await this.getTerminalsForWorkspaceRoot(
          subscription.cwd,
          subscription.workspaceId,
        );
        for (const terminal of terminals) {
          await this.terminateRestrictedTerminalAndWait(
            terminal,
            "Terminal workspace authority is unavailable",
          );
        }
        this.subscribedDirectories.delete(key);
        await this.releaseRestrictedDirectoryAuthority(key);
        return;
      }
      const terminals = await this.getTerminalsForWorkspaceRoot(
        subscription.cwd,
        subscription.workspaceId,
      );
      for (const terminal of terminals) {
        this.ensureExitSubscription(terminal);
        if (restrictedAuthority) {
          try {
            await this.bindRestrictedTerminalAuthority(terminal, restrictedAuthority);
          } catch (error) {
            await this.terminateRestrictedTerminalAndWait(
              terminal,
              "Terminal workspace authority is unavailable",
            );
            throw error;
          }
        }
      }
      if (this.subscribedDirectories.get(key) !== subscription) {
        return;
      }
      if (restrictedAuthority && !(await restrictedAuthority.isCurrent())) {
        if (this.subscribedDirectories.get(key) !== subscription) return;
        for (const terminal of terminals) {
          await this.terminateRestrictedTerminalAndWait(
            terminal,
            "Terminal workspace authority is unavailable",
          );
        }
        this.subscribedDirectories.delete(key);
        await this.releaseRestrictedDirectoryAuthority(key);
        return;
      }
      if (this.subscribedDirectories.get(key) !== subscription) {
        return;
      }
      this.emitTerminalsChangedSnapshot({
        cwd: subscription.cwd,
        terminals: terminals.map((terminal) => this.toTerminalInfo(terminal)),
      });
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, cwd: subscription.cwd },
        "Failed to emit initial terminal snapshot",
      );
    }
  }

  private async handleListTerminalsRequest(
    msg: ListTerminalsRequest,
    options: {
      mayaRestrictedMode?: boolean;
      workspaceAuthority?: MayaRestrictedWorkspaceAuthority | null;
    },
  ): Promise<void> {
    if (!this.terminalManager) {
      this.emit({
        type: "list_terminals_response",
        payload: {
          ...(msg.cwd ? { cwd: msg.cwd } : {}),
          terminals: [],
          requestId: msg.requestId,
        },
      });
      return;
    }

    try {
      if (options.mayaRestrictedMode) {
        const authority = options.workspaceAuthority;
        if (
          !authority ||
          !msg.cwd ||
          msg.cwd !== authority.cwd ||
          msg.workspaceId !== authority.workspaceId
        ) {
          throw new Error("terminal listing lacks selected workspace authority");
        }
      }
      const terminals =
        typeof msg.cwd === "string"
          ? await this.getTerminalsForWorkspaceRoot(msg.cwd, msg.workspaceId)
          : await this.getAllTerminalSessions();
      for (const terminal of terminals) {
        this.ensureExitSubscription(terminal);
        if (options.mayaRestrictedMode && options.workspaceAuthority) {
          await this.bindRestrictedTerminalAuthority(terminal, options.workspaceAuthority);
        }
      }
      this.emit({
        type: "list_terminals_response",
        payload: {
          ...(msg.cwd ? { cwd: msg.cwd } : {}),
          terminals: terminals.map((terminal) => this.toTerminalInfo(terminal)),
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.sessionLogger.error({ err: error, cwd: msg.cwd }, "Failed to list terminals");
      this.emit({
        type: "list_terminals_response",
        payload: {
          ...(msg.cwd ? { cwd: msg.cwd } : {}),
          terminals: [],
          requestId: msg.requestId,
        },
      });
    }
  }

  private async getAllTerminalSessions(): Promise<TerminalSession[]> {
    if (!this.terminalManager) {
      return [];
    }
    const directories = this.terminalManager.listDirectories();
    const manager = this.terminalManager;
    const terminalsByDirectory = await Promise.all(
      directories.map((cwd) => manager.getTerminals(cwd)),
    );
    return terminalsByDirectory.flat();
  }

  private async getTerminalsForWorkspaceRoot(
    cwd: string,
    workspaceId?: string,
  ): Promise<TerminalSession[]> {
    if (!this.terminalManager) {
      return [];
    }

    const terminals = await this.terminalManager.getTerminals(cwd, {
      workspaceId,
    });
    const workspaceRoots = await this.listTerminalWorkspaceRoots();
    if (workspaceRoots.length === 0) {
      return terminals;
    }

    return terminals.filter((terminal) =>
      this.terminalBelongsToRoot(cwd, terminal.cwd, workspaceRoots),
    );
  }

  private terminalBelongsToRoot(
    rootCwd: string,
    terminalCwd: string,
    workspaceRoots: readonly string[],
  ): boolean {
    const ownerRoot = this.resolveTerminalOwnerRoot(terminalCwd, workspaceRoots);
    if (!ownerRoot) {
      return this.isPathWithinRoot(rootCwd, terminalCwd);
    }
    return this.isSamePath(rootCwd, ownerRoot);
  }

  private resolveTerminalOwnerRoot(
    terminalCwd: string,
    workspaceRoots: readonly string[],
  ): string | null {
    let ownerRoot: string | null = null;
    for (const workspaceRoot of workspaceRoots) {
      if (!this.isPathWithinRoot(workspaceRoot, terminalCwd)) {
        continue;
      }
      if (!ownerRoot || workspaceRoot.length > ownerRoot.length) {
        ownerRoot = workspaceRoot;
      }
    }
    return ownerRoot;
  }

  private isSamePath(firstPath: string, secondPath: string): boolean {
    return (
      this.isPathWithinRoot(firstPath, secondPath) && this.isPathWithinRoot(secondPath, firstPath)
    );
  }

  private async handleCreateTerminalRequest(
    msg: CreateTerminalRequest,
    options: {
      mayaRestrictedMode?: boolean;
      workspaceAuthority?: MayaRestrictedWorkspaceAuthority | null;
    },
  ): Promise<void> {
    if (!this.terminalManager) {
      this.emit({
        type: "create_terminal_response",
        payload: {
          terminal: null,
          error: "Terminal manager not available",
          requestId: msg.requestId,
        },
      });
      return;
    }

    try {
      if (options.mayaRestrictedMode) {
        const authority = options.workspaceAuthority;
        if (
          !authority ||
          msg.cwd !== authority.cwd ||
          msg.workspaceId !== authority.workspaceId ||
          msg.agentId !== undefined ||
          msg.command !== undefined ||
          msg.args !== undefined
        ) {
          throw new Error("terminal creation lacks exact selected workspace authority");
        }
      }
      if (msg.agentId) {
        this.emit({
          type: "create_terminal_response",
          payload: {
            terminal: null,
            error: `Agent-backed terminals are no longer supported for agent ${msg.agentId}`,
            requestId: msg.requestId,
          },
        });
        return;
      }

      const sandboxBinding = options.mayaRestrictedMode
        ? await options.workspaceAuthority?.terminalSandboxBinding()
        : undefined;
      if (options.mayaRestrictedMode && !sandboxBinding) {
        throw new Error("terminal creation lacks selected workspace sandbox authority");
      }

      const workspaceId = msg.workspaceId ?? (await this.resolveLegacyTerminalWorkspaceId(msg.cwd));
      if (!workspaceId) {
        this.emit({
          type: "create_terminal_response",
          payload: {
            terminal: null,
            error: "workspaceId is required",
            requestId: msg.requestId,
          },
        });
        return;
      }

      const session = await this.terminalManager.createTerminal({
        cwd: msg.cwd,
        workspaceId,
        name: msg.name,
        command: msg.command,
        args: msg.args,
        rows: msg.size?.rows,
        cols: msg.size?.cols,
        ...(sandboxBinding ? { mayaRestrictedSandbox: sandboxBinding } : {}),
      });
      this.ensureExitSubscription(session);
      if (options.mayaRestrictedMode && options.workspaceAuthority) {
        try {
          await this.bindRestrictedTerminalAuthority(session, options.workspaceAuthority);
        } catch (error) {
          await this.terminateRestrictedTerminalAndWait(
            session,
            "Terminal workspace authority changed during creation",
          );
          throw error;
        }
      }
      this.emit({
        type: "create_terminal_response",
        payload: {
          terminal: {
            id: session.id,
            name: session.name,
            cwd: session.cwd,
            workspaceId: session.workspaceId,
            ...(session.getTitle() ? { title: session.getTitle() } : {}),
            activity: session.getActivity(),
          },
          error: null,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.sessionLogger.error({ err: error, cwd: msg.cwd }, "Failed to create terminal");
      this.emit({
        type: "create_terminal_response",
        payload: {
          terminal: null,
          error: (error as Error).message,
          requestId: msg.requestId,
        },
      });
    }
  }

  private async resolveLegacyTerminalWorkspaceId(cwd: string): Promise<string | null> {
    const workspaceRefs = await this.listTerminalWorkspaceRefs();
    if (workspaceRefs.length === 0) {
      return null;
    }

    const exactMatch = workspaceRefs.find((workspace) => this.isSamePath(workspace.cwd, cwd));
    if (exactMatch) {
      return exactMatch.workspaceId;
    }

    const ownerRoot = this.resolveTerminalOwnerRoot(
      cwd,
      workspaceRefs.map((workspace) => workspace.cwd),
    );
    if (!ownerRoot) {
      return null;
    }

    return (
      workspaceRefs.find((workspace) => this.isSamePath(workspace.cwd, ownerRoot))?.workspaceId ??
      null
    );
  }

  private async handleRenameTerminalRequest(
    msg: RenameTerminalRequest,
    mayaRestrictedMode: boolean,
  ): Promise<void> {
    const respond = (success: boolean, error: string | null): void => {
      this.emit({
        type: "terminal.rename.response",
        payload: { requestId: msg.requestId, success, error },
      });
    };

    const title = msg.title.trim();
    if (title.length === 0) {
      respond(false, "Title is required");
      return;
    }
    if (title.length > 200) {
      respond(false, "Title is too long");
      return;
    }
    if (!this.terminalManager) {
      respond(false, "Terminal manager not available");
      return;
    }

    if (mayaRestrictedMode) {
      const session = this.terminalManager.getTerminal(msg.terminalId);
      if (!session || !(await this.ensureRestrictedTerminalAuthority(session))) {
        const error = session
          ? await this.terminateRestrictedTerminalAndWait(
              session,
              "Terminal workspace authority is unavailable",
            )
          : "Terminal not found";
        respond(false, error);
        return;
      }
    }

    const renamed = this.terminalManager.setTerminalTitle(msg.terminalId, title);
    respond(renamed, renamed ? null : "Terminal not found");
  }

  private async handleSubscribeTerminalRequest(
    msg: SubscribeTerminalRequest,
    mayaRestrictedMode: boolean,
  ): Promise<void> {
    const admissionGeneration = this.nextTerminalAdmissionGeneration;
    this.nextTerminalAdmissionGeneration += 1;
    this.terminalAdmissionGenerations.set(msg.terminalId, admissionGeneration);
    if (!this.terminalManager) {
      this.emit({
        type: "subscribe_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          error: "Terminal manager not available",
          requestId: msg.requestId,
        },
      });
      return;
    }

    const session = this.terminalManager.getTerminal(msg.terminalId);
    if (!session) {
      this.emit({
        type: "subscribe_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          error: "Terminal not found",
          requestId: msg.requestId,
        },
      });
      return;
    }
    if (mayaRestrictedMode && !(await this.ensureRestrictedTerminalAuthority(session))) {
      const error = await this.terminateRestrictedTerminalAndWait(
        session,
        "Terminal workspace authority is unavailable",
      );
      this.emit({
        type: "subscribe_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          error,
          requestId: msg.requestId,
        },
      });
      return;
    }
    if (this.terminalAdmissionGenerations.get(msg.terminalId) !== admissionGeneration) return;
    this.ensureExitSubscription(session);

    if (msg.restore?.size) {
      applyTerminalSize(session, this.terminalSizeOwner, {
        ...msg.restore.size,
        intent: "claim",
      });
    }

    const slot = this.bindActiveStream(session, { restore: msg.restore });
    if (this.terminalAdmissionGenerations.get(msg.terminalId) !== admissionGeneration) {
      this.detachStream(msg.terminalId, { emitExit: false });
      return;
    }
    if (slot === null) {
      this.sessionLogger.warn(
        {
          terminalId: msg.terminalId,
          activeTerminalStreamCount: this.activeStreams.size,
        },
        "Terminal stream slot exhaustion",
      );
      this.emit({
        type: "subscribe_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          error: "No terminal stream slots available",
          requestId: msg.requestId,
        },
      });
      return;
    }

    this.emit({
      type: "subscribe_terminal_response",
      payload: {
        terminalId: msg.terminalId,
        slot,
        error: null,
        requestId: msg.requestId,
      },
    });

    const activeStream = this.activeStreams.get(slot);
    if (activeStream) {
      void this.trySendSnapshot(activeStream);
    }
  }

  private handleUnsubscribeTerminalRequest(msg: UnsubscribeTerminalRequest): void {
    this.terminalAdmissionGenerations.set(msg.terminalId, this.nextTerminalAdmissionGeneration);
    this.nextTerminalAdmissionGeneration += 1;
    this.detachStream(msg.terminalId, { emitExit: false });
  }

  private async handleTerminalInput(
    msg: TerminalInput,
    mayaRestrictedMode: boolean,
  ): Promise<void> {
    if (!this.terminalManager) {
      return;
    }
    const session = this.terminalManager.getTerminal(msg.terminalId);
    if (!session) {
      this.sessionLogger.warn({ terminalId: msg.terminalId }, "Terminal not found for input");
      return;
    }
    if (mayaRestrictedMode && !(await this.ensureRestrictedTerminalAuthority(session))) {
      await this.terminateRestrictedTerminalAndWait(
        session,
        "Terminal workspace authority is unavailable",
      );
      return;
    }
    this.ensureExitSubscription(session);

    if (msg.message.type === "resize") {
      applyTerminalSize(session, this.terminalSizeOwner, msg.message);
      return;
    }

    session.send(msg.message);
  }

  private killTracked(terminalId: string, options?: { emitExit: boolean }): void {
    this.detachStream(terminalId, { emitExit: options?.emitExit ?? true });
    this.terminalManager?.killTerminal(terminalId);
  }

  private async handleKillTerminalRequest(
    msg: KillTerminalRequest,
    mayaRestrictedMode: boolean,
  ): Promise<void> {
    if (mayaRestrictedMode) {
      const terminal = this.terminalManager?.getTerminal(msg.terminalId);
      if (!terminal || !(await this.ensureRestrictedTerminalAuthority(terminal))) {
        const error = terminal
          ? await this.terminateRestrictedTerminalAndWait(
              terminal,
              "Terminal workspace authority is unavailable",
            )
          : "Terminal not found";
        this.emit({
          type: "kill_terminal_response",
          payload: {
            terminalId: msg.terminalId,
            success: false,
            error,
            requestId: msg.requestId,
          },
        });
        return;
      }
    }
    const result = this.killTerminalForClose(msg.terminalId);
    this.emit({
      type: "kill_terminal_response",
      payload: {
        terminalId: result.terminalId,
        success: result.success,
        error: result.success ? null : "Terminal not found",
        requestId: msg.requestId,
      },
    });
  }

  private async handleCaptureTerminalRequest(
    msg: CaptureTerminalRequest,
    mayaRestrictedMode: boolean,
  ): Promise<void> {
    if (!this.terminalManager) {
      this.emit({
        type: "capture_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          lines: [],
          totalLines: 0,
          requestId: msg.requestId,
        },
      });
      return;
    }

    const session = this.terminalManager.getTerminal(msg.terminalId);
    if (!session) {
      this.emit({
        type: "capture_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          lines: [],
          totalLines: 0,
          requestId: msg.requestId,
        },
      });
      return;
    }
    if (mayaRestrictedMode && !(await this.ensureRestrictedTerminalAuthority(session))) {
      const error = await this.terminateRestrictedTerminalAndWait(
        session,
        "Terminal workspace authority is unavailable",
      );
      this.emit({
        type: "capture_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          lines: [],
          totalLines: 0,
          error,
          requestId: msg.requestId,
        },
      });
      return;
    }

    this.ensureExitSubscription(session);

    try {
      const capture = await this.terminalManager.captureTerminal(msg.terminalId, {
        start: msg.start,
        end: msg.end,
        stripAnsi: msg.stripAnsi,
      });
      this.emit({
        type: "capture_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          lines: capture.lines,
          totalLines: capture.totalLines,
          error: null,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, terminalId: msg.terminalId },
        "Failed to capture terminal",
      );
      this.emit({
        type: "capture_terminal_response",
        payload: {
          terminalId: msg.terminalId,
          lines: [],
          totalLines: 0,
          error: (error as Error).message,
          requestId: msg.requestId,
        },
      });
    }
  }

  private bindActiveStream(
    terminal: TerminalSession,
    options?: { restore?: TerminalRestoreOptions },
  ): number | null {
    if (!this.hasBinaryChannel()) {
      return null;
    }

    const existingSlot = this.idToSlot.get(terminal.id);
    if (typeof existingSlot === "number") {
      const existingStream = this.activeStreams.get(existingSlot);
      if (existingStream) {
        existingStream.needsSnapshot = true;
        existingStream.restore = options?.restore;
        return existingSlot;
      }
      this.idToSlot.delete(terminal.id);
    }

    const slot = this.allocateSlot();
    if (slot === null) {
      return null;
    }

    const activeStream: ActiveTerminalStream = {
      terminalId: terminal.id,
      slot,
      generation: this.nextStreamGeneration,
      unsubscribe: () => {},
      needsSnapshot: true,
      snapshotInFlight: false,
      readyRevision: undefined,
      restore: options?.restore,
      bufferedOutputs: [],
      outputBytesSinceSnapshot: 0,
      restrictedEmissionTail: Promise.resolve(),
      restrictedPendingOutputFrames: 0,
      restrictedPendingOutputBytes: 0,
      outputCoalescer: new TerminalOutputCoalescer({
        timers: { setTimeout, clearTimeout },
        onFlush: ({ payload }) => {
          if (this.activeStreams.get(slot) !== activeStream) {
            return;
          }
          activeStream.outputBytesSinceSnapshot += payload.byteLength;
          // Catch up via a snapshot only when the client is BOTH far behind in
          // produced output AND actually backed up on the wire. A client that
          // keeps draining reports ~0 buffered, so it streams continuously even
          // past the byte threshold. outputBytesSinceSnapshot keeps accumulating
          // in that case — it's harmless, it only gates the snapshot decision at
          // the instant backpressure appears, and trySendSnapshot resets it to 0.
          // A null reading means the transport exposes no backpressure signal
          // (e.g. the multiplexed relay socket); there we can't tell a slow client
          // from a fast one, so fall back unconditionally at the byte threshold to
          // keep a slow relay client from falling unboundedly behind.
          const clientBufferedAmount = this.getClientBufferedAmount();
          if (
            activeStream.outputBytesSinceSnapshot > MAX_TERMINAL_OUTPUT_FRAME_BYTES &&
            (clientBufferedAmount === null || clientBufferedAmount > MAX_CLIENT_BUFFERED_BYTES)
          ) {
            activeStream.restore = resolveRestoreAfterOutputOverflow(activeStream.restore);
            activeStream.needsSnapshot = true;
            void this.trySendSnapshot(activeStream);
            return;
          }
          const encoded = encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Output,
            slot,
            payload,
          });
          if (this.restrictedTerminalAuthorities.has(terminal.id)) {
            if (
              activeStream.restrictedPendingOutputFrames >= MAX_RESTRICTED_PENDING_OUTPUT_FRAMES ||
              activeStream.restrictedPendingOutputBytes + encoded.byteLength >
                MAX_RESTRICTED_PENDING_OUTPUT_BYTES
            ) {
              void this.terminateRestrictedTerminalAndWait(
                terminal,
                "Terminal output authority queue exceeded its bound",
              );
              return;
            }
            activeStream.restrictedPendingOutputFrames += 1;
            activeStream.restrictedPendingOutputBytes += encoded.byteLength;
            activeStream.restrictedEmissionTail = activeStream.restrictedEmissionTail
              .then(async () => {
                if (
                  this.activeStreams.get(slot) !== activeStream ||
                  !(await this.validateRestrictedTerminalAuthority(terminal))
                ) {
                  if (this.activeStreams.get(slot) === activeStream) {
                    await this.terminateRestrictedTerminalAndWait(
                      terminal,
                      "Terminal workspace authority is unavailable",
                    );
                  }
                  return;
                }
                if (this.activeStreams.get(slot) === activeStream) this.emitBinary(encoded);
              })
              .catch(async (error) => {
                this.sessionLogger.warn(
                  { err: error, terminalId: terminal.id },
                  "Failed to validate restricted terminal output authority",
                );
                if (this.activeStreams.get(slot) === activeStream) {
                  await this.terminateRestrictedTerminalAndWait(
                    terminal,
                    "Terminal workspace authority is unavailable",
                  );
                }
              })
              .finally(() => {
                activeStream.restrictedPendingOutputFrames -= 1;
                activeStream.restrictedPendingOutputBytes -= encoded.byteLength;
              });
            return;
          }
          this.emitBinary(encoded);
        },
      }),
    };
    this.nextStreamGeneration += 1;

    this.activeStreams.set(slot, activeStream);
    this.idToSlot.set(terminal.id, slot);

    activeStream.unsubscribe = terminal.subscribe(
      (message) => {
        if (this.activeStreams.get(slot) !== activeStream) {
          return;
        }
        if (message.type === "snapshot" || message.type === "snapshotReady") {
          activeStream.readyRevision = message.revision;
          activeStream.outputCoalescer.flush();
          activeStream.needsSnapshot = true;
          void this.trySendSnapshot(activeStream);
          return;
        }
        if (message.type === "titleChange") {
          return;
        }
        if (message.data.length === 0) {
          return;
        }
        if (activeStream.needsSnapshot || activeStream.snapshotInFlight) {
          activeStream.bufferedOutputs.push({
            data: message.data,
            revision: message.revision,
          });
          return;
        }
        activeStream.outputCoalescer.handle(message.data);
      },
      {
        initialSnapshot: resolveTerminalSubscriptionSnapshotMode(options?.restore),
      },
    );
    return slot;
  }

  private async trySendSnapshot(activeStream: ActiveTerminalStream): Promise<void> {
    if (
      this.activeStreams.get(activeStream.slot) !== activeStream ||
      !activeStream.needsSnapshot ||
      activeStream.snapshotInFlight
    ) {
      return;
    }

    const terminalManager = this.terminalManager;
    if (!terminalManager) {
      this.detachStream(activeStream.terminalId, { emitExit: true });
      return;
    }
    const terminal = terminalManager.getTerminal(activeStream.terminalId);
    if (!terminal) {
      this.detachStream(activeStream.terminalId, { emitExit: true });
      return;
    }
    if (
      this.restrictedTerminalAuthorities.has(terminal.id) &&
      !(await this.validateRestrictedTerminalAuthority(terminal))
    ) {
      await this.terminateRestrictedTerminalAndWait(
        terminal,
        "Terminal workspace authority is unavailable",
      );
      return;
    }
    if (activeStream.restore && activeStream.readyRevision === undefined) {
      return;
    }

    activeStream.outputCoalescer.flush();
    activeStream.snapshotInFlight = true;
    try {
      const restore = activeStream.restore;
      const snapshotResult = restore
        ? await this.emitRestoreSnapshot(activeStream, terminalManager, restore)
        : await this.emitLegacySnapshot(activeStream, terminalManager);
      if (!snapshotResult.shouldContinue) {
        return;
      }
      this.replayTerminalOutputAfterSnapshot(activeStream, terminal, snapshotResult.replayRevision);
      activeStream.needsSnapshot = false;
      activeStream.outputBytesSinceSnapshot = 0;
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, terminalId: activeStream.terminalId },
        "Failed to pull terminal snapshot",
      );
      activeStream.needsSnapshot = true;
    } finally {
      activeStream.snapshotInFlight = false;
    }
  }

  private async emitLegacySnapshot(
    activeStream: ActiveTerminalStream,
    terminalManager: TerminalManager,
  ): Promise<SnapshotSendResult> {
    const snapshot = await terminalManager.getTerminalState(activeStream.terminalId, {
      includeWrapFlags: this.clientSupportsWrapReflow(),
    });
    if (this.activeStreams.get(activeStream.slot) !== activeStream) {
      return { shouldContinue: false };
    }
    const terminal = terminalManager.getTerminal(activeStream.terminalId);
    if (
      terminal &&
      this.restrictedTerminalAuthorities.has(terminal.id) &&
      !(await this.validateRestrictedTerminalAuthority(terminal))
    ) {
      await this.terminateRestrictedTerminalAndWait(
        terminal,
        "Terminal workspace authority is unavailable",
      );
      return { shouldContinue: false };
    }
    if (this.activeStreams.get(activeStream.slot) !== activeStream) {
      return { shouldContinue: false };
    }
    if (!snapshot) {
      this.detachStream(activeStream.terminalId, { emitExit: true });
      return { shouldContinue: false };
    }

    this.emitBinary(
      encodeLegacyTerminalSnapshotFrame({
        slot: activeStream.slot,
        snapshot,
      }),
    );
    // The snapshot frame went out-of-band; keep the replay that follows on the
    // coalescer's trailing path so it doesn't flush back-to-back with it.
    activeStream.outputCoalescer.markFlushed();
    return { shouldContinue: true, replayRevision: snapshot.revision };
  }

  private async emitRestoreSnapshot(
    activeStream: ActiveTerminalStream,
    terminalManager: TerminalManager,
    restore: TerminalRestoreOptions,
  ): Promise<SnapshotSendResult> {
    const snapshotOptions = resolveTerminalRestoreSnapshotOptions(restore);
    if (snapshotOptions === null) {
      return { shouldContinue: true };
    }

    const snapshot = await terminalManager.getTerminalState(activeStream.terminalId, {
      ...snapshotOptions,
      includeWrapFlags: this.clientSupportsWrapReflow(),
    });
    if (this.activeStreams.get(activeStream.slot) !== activeStream) {
      return { shouldContinue: false };
    }
    const terminal = terminalManager.getTerminal(activeStream.terminalId);
    if (
      terminal &&
      this.restrictedTerminalAuthorities.has(terminal.id) &&
      !(await this.validateRestrictedTerminalAuthority(terminal))
    ) {
      await this.terminateRestrictedTerminalAndWait(
        terminal,
        "Terminal workspace authority is unavailable",
      );
      return { shouldContinue: false };
    }
    if (this.activeStreams.get(activeStream.slot) !== activeStream) {
      return { shouldContinue: false };
    }
    if (!snapshot) {
      this.detachStream(activeStream.terminalId, { emitExit: true });
      return { shouldContinue: false };
    }

    this.emitBinary(
      encodeTerminalRestoreFrame({
        slot: activeStream.slot,
        snapshot,
      }),
    );
    // The restore frame went out-of-band; keep the replay that follows on the
    // coalescer's trailing path so it doesn't flush back-to-back with it.
    activeStream.outputCoalescer.markFlushed();
    return { shouldContinue: true, replayRevision: snapshot.revision };
  }

  private replayTerminalOutputAfterSnapshot(
    activeStream: ActiveTerminalStream,
    terminal: TerminalSession,
    replayRevision: number | undefined,
  ): void {
    const replayPreamble = terminal.getReplayPreamble();
    if (replayPreamble.length > 0) {
      activeStream.outputCoalescer.handle(replayPreamble);
    }

    const bufferedOutputs = activeStream.bufferedOutputs.splice(
      0,
      activeStream.bufferedOutputs.length,
    );
    for (const output of bufferedOutputs) {
      if (
        replayRevision !== undefined &&
        output.revision !== undefined &&
        output.revision <= replayRevision
      ) {
        continue;
      }
      activeStream.outputCoalescer.handle(output.data);
    }
  }

  private allocateSlot(): number | null {
    for (let attempt = 0; attempt < MAX_TERMINAL_STREAM_SLOTS; attempt += 1) {
      const slot = (this.nextSlot + attempt) % MAX_TERMINAL_STREAM_SLOTS;
      if (this.activeStreams.has(slot)) {
        continue;
      }
      this.nextSlot = (slot + 1) % MAX_TERMINAL_STREAM_SLOTS;
      return slot;
    }
    return null;
  }

  private detachStream(terminalId: string, options?: { emitExit: boolean }): boolean {
    const slot = this.idToSlot.get(terminalId);
    if (typeof slot !== "number") {
      return false;
    }
    const activeStream = this.activeStreams.get(slot);
    if (!activeStream) {
      this.idToSlot.delete(terminalId);
      return false;
    }
    activeStream.outputCoalescer.flush();
    activeStream.bufferedOutputs.length = 0;
    this.activeStreams.delete(slot);
    this.idToSlot.delete(terminalId);
    try {
      activeStream.unsubscribe();
    } catch (error) {
      this.sessionLogger.warn({ err: error }, "Failed to unsubscribe terminal stream");
    }
    if (options?.emitExit) {
      this.emit({
        type: "terminal_stream_exit",
        payload: {
          terminalId: activeStream.terminalId,
        },
      });
    }
    return true;
  }
}

function isTerminalMessage(msg: SessionInboundMessage): msg is TerminalDispatchableMessage {
  return TERMINAL_MESSAGE_TYPES.has(msg.type as TerminalDispatchableMessage["type"]);
}
