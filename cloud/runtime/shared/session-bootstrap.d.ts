import type { ReadGameBootstrapResponse } from "./game-bootstrap";
import type { SessionTokenResponse } from "./session-auth";

export type SessionBootstrapTarget = {
  inviteId: string;
  selection: "current" | "approved";
};

export type SessionBootstrapFailure = {
  ok: false;
  status: 403 | 404 | 409 | 429 | 503;
  retryAfterMs?: number;
};

export type SessionBootstrapResult =
  ReadGameBootstrapResponse | SessionBootstrapFailure;

export type SessionBootstrap = SessionBootstrapTarget & {
  result: SessionBootstrapResult;
};

export type SessionBootstrapResponse = SessionTokenResponse & {
  gameBootstrap: SessionBootstrap;
};

export const SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES: number;
export const SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS: 25000;
export function isSessionBootstrapTarget(
  value: unknown,
): value is SessionBootstrapTarget;
export function isSessionBootstrapFailure(
  value: unknown,
): value is SessionBootstrapFailure;
export function isSessionBootstrap(value: unknown): value is SessionBootstrap;
export function isSessionBootstrapResponse(
  value: unknown,
): value is SessionBootstrapResponse;
