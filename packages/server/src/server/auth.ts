import { compare, compareSync, hashSync } from "bcryptjs";
import { timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { RequestHandler } from "express";

export const DAEMON_PASSWORD_BCRYPT_COST = 12;
const AUTH_MAX_PENDING = 4;
const AUTH_MAX_ATTEMPTS_PER_WINDOW = 8;
const AUTH_ATTEMPT_WINDOW_MS = 10_000;
const AUTH_MAX_TRACKED_PEERS = 1024;
const BCRYPT_MODULE_PATH = createRequire(import.meta.url).resolve("bcryptjs");
const BCRYPT_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { compareSync } = require(workerData.bcryptModulePath);
parentPort.on("message", ({ id, token, password }) => {
  try {
    parentPort.postMessage({ id, valid: compareSync(token, password) });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

export type BoundedPasswordVerificationResult = "authorized" | "invalid" | "busy" | "rate_limited";

interface PasswordWorkerResponse {
  id: number;
  valid?: boolean;
  error?: string;
}

interface PendingPasswordVerification {
  resolve: (result: BoundedPasswordVerificationResult) => void;
}

interface PeerAttemptWindow {
  startedAt: number;
  attempts: number;
}

/** Fixed-capacity, off-main-thread verifier shared by HTTP and WebSocket ingress. */
export class BoundedDaemonPasswordVerifier {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingPasswordVerification>();
  private readonly peerAttempts = new Map<string, PeerAttemptWindow>();
  private disposed = false;

  async verify(input: {
    password: string | undefined;
    token: string | null;
    peer: string;
  }): Promise<BoundedPasswordVerificationResult> {
    if (!input.password) return "authorized";
    if (!this.admitPeer(input.peer)) return "rate_limited";
    if (input.token === null) return "invalid";
    if (this.disposed || this.pending.size >= AUTH_MAX_PENDING) return "busy";

    const worker = this.ensureWorker();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      try {
        worker.postMessage({ id, token: input.token, password: input.password });
      } catch {
        this.pending.delete(id);
        resolve("busy");
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    const worker = this.worker;
    this.worker = null;
    void worker?.terminate();
    this.resolveAllPending("busy");
    this.peerAttempts.clear();
  }

  private admitPeer(peer: string): boolean {
    const now = Date.now();
    const existing = this.peerAttempts.get(peer);
    if (!existing || now - existing.startedAt >= AUTH_ATTEMPT_WINDOW_MS) {
      if (!existing && this.peerAttempts.size >= AUTH_MAX_TRACKED_PEERS) {
        const oldest = this.peerAttempts.keys().next().value as string | undefined;
        if (oldest !== undefined) this.peerAttempts.delete(oldest);
      }
      this.peerAttempts.set(peer, { startedAt: now, attempts: 1 });
      return true;
    }
    existing.attempts += 1;
    return existing.attempts <= AUTH_MAX_ATTEMPTS_PER_WINDOW;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(BCRYPT_WORKER_SOURCE, {
      eval: true,
      workerData: { bcryptModulePath: BCRYPT_MODULE_PATH },
    });
    worker.unref();
    worker.on("message", (message: PasswordWorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message.error ? "invalid" : message.valid ? "authorized" : "invalid");
    });
    worker.on("error", () => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.resolveAllPending("busy");
    });
    worker.on("exit", () => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.resolveAllPending("busy");
    });
    this.worker = worker;
    return worker;
  }

  private resolveAllPending(result: BoundedPasswordVerificationResult): void {
    for (const pending of this.pending.values()) pending.resolve(result);
    this.pending.clear();
  }
}

export interface DaemonAuthConfig {
  password?: string;
}

export interface BearerAuthRejectContext {
  path: string;
  method: string;
  hasToken: boolean;
}

interface BearerValidationInput {
  password: string | undefined;
  token: string | null;
}

export function isBearerTokenValid(input: BearerValidationInput): boolean {
  return isBearerTokenValidSync(input);
}

export async function isBearerTokenValidAsync(input: BearerValidationInput): Promise<boolean> {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  return compare(input.token, input.password);
}

export function isBearerTokenValidSync(input: BearerValidationInput): boolean {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  return compareSync(input.token, input.password);
}

export function hashDaemonPassword(password: string): string {
  return hashSync(password, DAEMON_PASSWORD_BCRYPT_COST);
}

export function extractHttpBearerToken(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const [scheme, ...tokenParts] = value.trim().split(/\s+/);
  if (scheme !== "Bearer" || tokenParts.length !== 1) {
    return null;
  }
  return tokenParts[0] ?? null;
}

export function extractWsBearerProtocol(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  for (const protocol of value.split(",")) {
    const trimmed = protocol.trim();
    const segments = trimmed.split(".");
    if (segments[0] === "paseo" && segments[1] === "bearer" && segments.length >= 3) {
      return trimmed;
    }
  }

  return null;
}

export function extractWsBearerToken(protocol: string | null): string | null {
  if (!protocol) {
    return null;
  }
  const segments = protocol.split(".");
  if (segments[0] !== "paseo" || segments[1] !== "bearer" || segments.length < 3) {
    return null;
  }
  return segments.slice(2).join(".");
}

export function createRequireBearerMiddleware(
  auth: DaemonAuthConfig | undefined,
  verifier: BoundedDaemonPasswordVerifier,
  onReject?: (context: BearerAuthRejectContext) => void,
): RequestHandler {
  const password = auth?.password;
  return (req, res, next) => {
    if (!password || shouldBypassBearerAuth(req.method, req.path)) {
      next();
      return;
    }

    void (async () => {
      try {
        const token = extractHttpBearerToken(req.header("authorization"));
        const verification = await verifier.verify({
          password,
          token,
          peer: req.socket.remoteAddress ?? "unknown",
        });
        if (verification !== "authorized") {
          onReject?.({
            path: req.path,
            method: req.method,
            hasToken: token !== null,
          });
          res.status(401).json({ error: "Unauthorized" });
          return;
        }

        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

// Routes that authenticate via their own capability and therefore must not be
// gated a second time behind the daemon password.
const BEARER_AUTH_BYPASS_PATHS = new Set([
  // Unauthenticated liveness probe.
  "/api/health",
  // Guarded by a single-use download token (crypto-random UUID, 60s TTL,
  // consumed on first use) that is only ever issued over the
  // already-authenticated WebSocket. The token IS the capability for this
  // route. Requiring the daemon password on top of it breaks browser and
  // Electron downloads: those trigger the download via an anchor navigation,
  // which cannot attach an `Authorization` header. The download endpoint still
  // rejects requests without a valid token (400/403), so dropping the bearer
  // here does not make the route unauthenticated.
  "/api/files/download",
  // The daemon injects its own agents' Paseo MCP connections at this endpoint
  // (and connects its own per-client MCP client here). Those connections cannot
  // carry the daemon password — it is only known in plaintext when set via env,
  // never when set via the app — so the route authenticates them with a
  // per-daemon-run capability token instead (see isAgentMcpRequestAuthorized).
  // The token is injected only into local agent configs/sessions and never sent
  // to remote clients, and the route still rejects callers presenting neither
  // the token nor a valid daemon password, so dropping the global bearer here
  // does not make the endpoint unauthenticated.
  "/mcp/agents",
]);

export function shouldBypassBearerAuth(method: string, path: string): boolean {
  if (method === "OPTIONS") {
    return true;
  }
  return BEARER_AUTH_BYPASS_PATHS.has(path);
}

/**
 * Authorizes a request to the Agent MCP endpoint (/mcp/agents), which is exempt
 * from the global daemon-password middleware. Accepts either the per-daemon-run
 * capability token the daemon injects into its own agents' configs and MCP
 * client, or a valid daemon-password bearer (so existing password-authenticated
 * callers keep working). When no daemon password is configured the endpoint is
 * open, matching the global middleware's behavior.
 */
export async function isAgentMcpRequestAuthorized(input: {
  password: string | undefined;
  capabilityToken: string | null;
  authorizationHeader: string | undefined;
  verifier: BoundedDaemonPasswordVerifier;
  peer: string;
}): Promise<boolean> {
  if (!input.password) {
    return true;
  }
  const token = extractHttpBearerToken(input.authorizationHeader);
  if (input.capabilityToken !== null && token !== null) {
    // Constant-time compare; length-guard first because timingSafeEqual throws
    // on differing buffer lengths.
    const provided = Buffer.from(token);
    const expected = Buffer.from(input.capabilityToken);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return true;
    }
  }
  return (
    (await input.verifier.verify({
      password: input.password,
      token,
      peer: input.peer,
    })) === "authorized"
  );
}
