import {
  GAME_BOOTSTRAP_MAX_RESPONSE_BYTES,
  isReadGameBootstrapResponse,
  type ReadGameBootstrapResponse,
} from "@mons/shared/game-bootstrap";
import { selectInviteMatch } from "@mons/shared/rematches";
import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
} from "./authHttp.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import {
  normalizeInviteMetadata,
  type InviteMetadataReadResult,
} from "./inviteMetadata.ts";
import { resolveInviteReadRole } from "./inviteReadRoute.ts";
import type { MatchSyncReadResult } from "./matchSync.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import {
  verifySessionRequest,
  type SessionIdentity,
  type WorkerExecutionContext,
} from "./sessionAuth.ts";

const GAME_BOOTSTRAP_ROUTE_PATTERN = /^\/invites\/([^/]+)\/bootstrap$/;

export type GameBootstrapRouteDependencies = {
  repository?: GameplayRepository;
  room?: {
    readMetadata(inviteId: string): Promise<InviteMetadataReadResult>;
    readMatches(
      inviteId: string,
      matchId: string,
      options?: { fresh?: boolean },
    ): Promise<MatchSyncReadResult>;
  };
  verifyIdentity?: (
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext,
  ) => Promise<SessionIdentity>;
  now?: () => number;
  logFailure?: () => void;
};

export function isGameBootstrapPath(pathname: string): boolean {
  return GAME_BOOTSTRAP_ROUTE_PATTERN.test(pathname);
}

function readRoute(request: Request) {
  const url = new URL(request.url);
  const match = GAME_BOOTSTRAP_ROUTE_PATTERN.exec(url.pathname);
  let inviteId = "";
  try {
    inviteId = match ? decodeURIComponent(match[1]) : "";
  } catch {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-invite-id");
  }
  const selection = url.searchParams.get("selection") ?? "current";
  if (
    !isSafeRecordKey(inviteId) ||
    inviteId !== inviteId.trim() ||
    url.searchParams.size > 1 ||
    (url.searchParams.size === 1 && !url.searchParams.has("selection")) ||
    (selection !== "current" && selection !== "approved")
  ) {
    throw new AuthApiFailure(
      400,
      "invalid-argument",
      "invalid-bootstrap-request",
    );
  }
  return { inviteId, preferApproved: selection === "approved" };
}

function requireMetadata(read: InviteMetadataReadResult) {
  if (read.status === "missing") {
    throw new AuthApiFailure(404, "not-found", "invite-not-found");
  }
  if (read.status !== "ok") {
    throw new AuthApiFailure(409, "failed-precondition", "invite-invalid");
  }
  return read;
}

function sameMetadata(
  first: Extract<InviteMetadataReadResult, { status: "ok" }>,
  second: Extract<InviteMetadataReadResult, { status: "ok" }>,
): boolean {
  return (
    first.passwordProtected === second.passwordProtected &&
    Object.entries(first.snapshot).every(
      ([key, value]) =>
        key === "revision" ||
        second.snapshot[key as keyof typeof second.snapshot] === value,
    ) &&
    Object.keys(first.automatchOperationIds).length ===
      Object.keys(second.automatchOperationIds).length &&
    Object.entries(first.automatchOperationIds).every(
      ([uid, operationId]) => second.automatchOperationIds[uid] === operationId,
    )
  );
}

export async function handleGameBootstrapRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: GameBootstrapRouteDependencies = {},
): Promise<Response> {
  const now = dependencies.now || Date.now;
  const startedAt = now();
  const timings = new Map<string, number>();
  const measure = async <T>(
    name: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    request.signal.throwIfAborted();
    const started = now();
    try {
      const value = await work();
      request.signal.throwIfAborted();
      return value;
    } finally {
      timings.set(
        name,
        (timings.get(name) ?? 0) + Math.max(0, now() - started),
      );
    }
  };
  const finish = (response: Response): Response => {
    timings.set("total", Math.max(0, now() - startedAt));
    response.headers.set(
      "Server-Timing",
      Array.from(
        timings,
        ([name, duration]) => `${name};dur=${duration.toFixed(1)}`,
      ).join(", "),
    );
    return response;
  };
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = {
      ...getAuthCorsHeaders(request),
      "Access-Control-Expose-Headers": "Retry-After, Server-Timing",
    };
    const origin = corsHeaders["Access-Control-Allow-Origin"];
    if (origin) corsHeaders["Timing-Allow-Origin"] = origin;
    const { inviteId, preferApproved } = readRoute(request);
    if (request.method === "OPTIONS")
      return finish(authPreflightResponse(corsHeaders));
    if (request.method !== "GET") {
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    }
    const identity = await measure("auth", () =>
      (dependencies.verifyIdentity || verifySessionRequest)(request, env, ctx),
    );
    const limited = await env.MATCH_SYNC_RATE_LIMITER.limit({
      key: `game-bootstrap:read:identity:${identity.uid}`,
    });
    if (!limited.success) {
      return finish(
        authJsonResponse(
          { ok: false, error: "resource-exhausted", message: "rate-limited" },
          429,
          { ...corsHeaders, "Retry-After": "60" },
        ),
      );
    }
    const repository = dependencies.repository || createGameplayRepository(env);
    let metadata = requireMetadata(
      await measure("admission", async () =>
        normalizeInviteMetadata(
          inviteId,
          await repository.readInviteMetadata(inviteId, request.signal),
        ),
      ),
    );
    const roles = new Map<string, ReturnType<typeof resolveInviteReadRole>>();
    const resolveRole = (source: typeof metadata) => {
      const key = JSON.stringify([
        source.snapshot.hostId,
        source.snapshot.guestId,
        source.passwordProtected,
      ]);
      let role = roles.get(key);
      if (!role) {
        role = measure("role", () =>
          resolveInviteReadRole(
            { inviteId, identity, repository },
            source.snapshot,
            source.passwordProtected,
          ),
        );
        roles.set(key, role);
      }
      return role;
    };
    let role = await resolveRole(metadata);
    const room = dependencies.room || env.INVITE_REACTIONS.getByName(inviteId);
    let fresh = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const selected = selectInviteMatch(
        inviteId,
        metadata.snapshot,
        role.actorUid,
        { preferApproved },
      );
      const read = await measure("match", () =>
        room.readMatches(inviteId, selected.matchId, { fresh }),
      );
      if (read.status === "missing") {
        metadata = requireMetadata(
          await measure("match", () => room.readMetadata(inviteId)),
        );
        role = await resolveRole(metadata);
        fresh = true;
        continue;
      }
      if (read.status !== "ok") {
        throw new AuthApiFailure(409, "failed-precondition", "match-invalid");
      }
      if (!fresh && !sameMetadata(metadata, read.metadata)) {
        fresh = true;
        continue;
      }
      metadata = read.metadata;
      role = await resolveRole(metadata);
      const current = selectInviteMatch(
        inviteId,
        metadata.snapshot,
        role.actorUid,
        { preferApproved },
      );
      if (current.matchId !== selected.matchId) {
        fresh = true;
        continue;
      }
      const body: ReadGameBootstrapResponse = {
        ok: true,
        schemaVersion: 1,
        metadata: metadata.snapshot,
        viewer: {
          role: role.role,
          actorUid: role.actorUid,
          automatchOperationId:
            metadata.automatchOperationIds[identity.uid] ?? null,
        },
        match: read.snapshot,
        hasPendingProposal: current.hasPendingProposal,
      };
      if (
        !isReadGameBootstrapResponse(body) ||
        body.metadata.inviteId !== inviteId ||
        body.match.matchId !== current.matchId ||
        new TextEncoder().encode(JSON.stringify(body)).byteLength >
          GAME_BOOTSTRAP_MAX_RESPONSE_BYTES
      ) {
        throw new AuthApiFailure(
          503,
          "unavailable",
          "game-bootstrap-unavailable",
        );
      }
      request.signal.throwIfAborted();
      return finish(authJsonResponse(body, 200, corsHeaders));
    }
    throw new AuthApiFailure(
      503,
      "unavailable",
      "game-bootstrap-kept-changing",
    );
  } catch (error) {
    if (error instanceof AuthApiFailure)
      return finish(authErrorResponse(error, corsHeaders));
    (
      dependencies.logFailure ||
      (() => console.error({ event: "game_bootstrap_failure" }))
    )();
    return finish(
      authErrorResponse(
        new AuthApiFailure(503, "unavailable", "game-bootstrap-unavailable"),
        corsHeaders,
      ),
    );
  }
}
