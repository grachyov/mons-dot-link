import { normalizeRecordKey } from "@mons/shared/ids";
import {
  GAME_BOOTSTRAP_MAX_RESPONSE_BYTES,
  isReadGameBootstrapResponse,
  type ReadGameBootstrapResponse,
} from "@mons/shared/game-bootstrap";
import type { AuthTokenProvider } from "./authApi";

const GAME_BOOTSTRAP_API_ROOT = "https://api.mons.link";
export const GAME_BOOTSTRAP_REQUEST_TIMEOUT_MS = 10_000;

export class GameBootstrapApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: string, status?: number, retryAfterMs?: number) {
    super(code);
    this.name = "GameBootstrapApiError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function bootstrapPath(
  inviteId: string,
  selection: "current" | "approved",
): string {
  if (!inviteId || normalizeRecordKey(inviteId) !== inviteId) {
    throw new GameBootstrapApiError("invalid-invite");
  }
  return `/invites/${encodeURIComponent(inviteId)}/bootstrap${selection === "approved" ? "?selection=approved" : ""}`;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("Retry-After");
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
}

async function readResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    Number(response.headers.get("Content-Length")) >
      GAME_BOOTSTRAP_MAX_RESPONSE_BYTES ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new GameBootstrapApiError("invalid-response");
  }
  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > GAME_BOOTSTRAP_MAX_RESPONSE_BYTES) {
        throw new GameBootstrapApiError("invalid-response");
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode()) as unknown;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new GameBootstrapApiError("invalid-response");
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export async function readGameBootstrapViaApi(
  inviteId: string,
  tokenProvider?: AuthTokenProvider,
  options: { signal?: AbortSignal; selection?: "current" | "approved" } = {},
): Promise<ReadGameBootstrapResponse> {
  const path = bootstrapPath(inviteId, options.selection ?? "current");
  if (options.signal?.aborted) throw new GameBootstrapApiError("aborted");
  const controller = new AbortController();
  const deadline = Date.now() + GAME_BOOTSTRAP_REQUEST_TIMEOUT_MS;
  let rejectCancellation: (error: Error) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (code: string) => {
    rejectCancellation(new GameBootstrapApiError(code));
    controller.abort();
  };
  const onAbort = () => cancel("aborted");
  const timer = setTimeout(
    () => cancel("timeout"),
    GAME_BOOTSTRAP_REQUEST_TIMEOUT_MS,
  );
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const assertCurrent = () => {
    if (controller.signal.aborted) throw new GameBootstrapApiError("aborted");
    if (Date.now() >= deadline) {
      controller.abort();
      throw new GameBootstrapApiError("timeout");
    }
    tokenProvider?.assertCurrentUser?.();
  };
  const run = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      assertCurrent();
      const token = tokenProvider ? await tokenProvider(attempt === 1) : null;
      assertCurrent();
      const response = await fetch(`${GAME_BOOTSTRAP_API_ROOT}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      try {
        assertCurrent();
      } catch (error) {
        void response.body?.cancel().catch(() => undefined);
        throw error;
      }
      if (response.status === 401 && tokenProvider && attempt === 0) {
        void response.body?.cancel().catch(() => undefined);
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new GameBootstrapApiError(
          `http-${response.status}`,
          response.status,
          retryAfterMs(response),
        );
      }
      const payload = await readResponse(response, controller.signal);
      assertCurrent();
      if (
        !isReadGameBootstrapResponse(payload) ||
        payload.metadata.inviteId !== inviteId
      ) {
        throw new GameBootstrapApiError("invalid-response");
      }
      return payload;
    }
    throw new GameBootstrapApiError("unauthenticated", 401);
  };
  try {
    return await Promise.race([run(), cancellation]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
