import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
} from "./authHttp.ts";
import {
  GameBootstrapRateLimitFailure,
  readAuthenticatedGameBootstrap,
  type GameBootstrapDependencies,
} from "./gameBootstrap.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import {
  verifySessionRequest,
  type SessionIdentity,
  type WorkerExecutionContext,
} from "./sessionAuth.ts";

const GAME_BOOTSTRAP_ROUTE_PATTERN = /^\/invites\/([^/]+)\/bootstrap$/;

export type GameBootstrapRouteDependencies = GameBootstrapDependencies & {
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
    const body = await readAuthenticatedGameBootstrap(
      {
        inviteId,
        selection: preferApproved ? "approved" : "current",
        identity,
        signal: request.signal,
      },
      env,
      { ...dependencies, measure },
    );
    return finish(authJsonResponse(body, 200, corsHeaders));
  } catch (error) {
    if (error instanceof GameBootstrapRateLimitFailure)
      corsHeaders["Retry-After"] = String(error.retryAfterMs / 1000);
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
