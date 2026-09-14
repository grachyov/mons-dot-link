import { isAuthProfileResponse, type AuthMethodKey } from "@mons/shared/auth";
import { AuthApiFailure } from "./authErrors.ts";
import type { LinkInput } from "./authIdentity.ts";
import { cleanString, hashMethodValue } from "./authPolicy.ts";
import type {
  CanonicalAuthMethodSnapshot,
  CanonicalAuthOperationSnapshot,
} from "./profileCanonicalD1.ts";

const AUTH_OP_REPLAY_TTL_MS = 10 * 60 * 1_000;

export type VerifyOperationMeta = {
  methodValue: string;
  methodValueHash: string;
  intentId?: string;
};

type AuthOperationContext = {
  kind: "unlink" | "verify";
  method: AuthMethodKey;
  loginUid: string;
  meta?: VerifyOperationMeta | null;
};

export function createVerifyOperationMeta(
  input: LinkInput,
): VerifyOperationMeta {
  return {
    methodValue:
      input.method === "apple" || input.method === "x"
        ? "redacted"
        : input.methodValueRaw,
    methodValueHash: hashMethodValue(input.method, input.normalizedMethodValue),
    ...(input.intentId ? { intentId: input.intentId } : {}),
  };
}

export function readVerifyOperationMeta(value: unknown): {
  methodValueHash: string;
  intentId: string;
} {
  const fields =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    methodValueHash: cleanString(fields.methodValueHash),
    intentId: cleanString(fields.intentId),
  };
}

export function assertAuthOperationContext(
  operation: CanonicalAuthOperationSnapshot,
  expected: AuthOperationContext,
): void {
  const storedMeta = readVerifyOperationMeta(operation.meta);
  const expectedMeta = readVerifyOperationMeta(expected.meta);
  if (
    operation.loginUid !== expected.loginUid ||
    operation.kind !== expected.kind ||
    operation.method !== expected.method ||
    (expected.kind === "verify" &&
      expected.meta !== undefined &&
      (storedMeta.methodValueHash !== expectedMeta.methodValueHash ||
        storedMeta.intentId !== expectedMeta.intentId))
  ) {
    throw new AuthApiFailure(403, "permission-denied", "op-context-mismatch");
  }
}

export function isAuthOperationReplayExpired(
  operation: Pick<CanonicalAuthOperationSnapshot, "updatedAtMs">,
  nowMs: number,
): boolean {
  return nowMs - operation.updatedAtMs > AUTH_OP_REPLAY_TTL_MS;
}

export function matchesVerifiedAuthMethod(
  method: AuthMethodKey,
  normalizedValue: string,
  expectedHash: string,
): boolean {
  return Boolean(
    expectedHash && hashMethodValue(method, normalizedValue) === expectedHash,
  );
}

export function canCompleteVerifyOperation(
  operation: CanonicalAuthOperationSnapshot,
  method: Pick<CanonicalAuthMethodSnapshot, "method" | "normalizedValue">,
): boolean {
  return (
    operation.kind === "verify" &&
    (operation.status === "started" || operation.status === "failed") &&
    operation.method === method.method &&
    matchesVerifiedAuthMethod(
      method.method,
      method.normalizedValue,
      readVerifyOperationMeta(operation.meta).methodValueHash,
    )
  );
}

export function verifyReplayState(
  operation: CanonicalAuthOperationSnapshot,
  nowMs: number,
): "completed" | "incomplete" | null {
  if (
    operation.kind !== "verify" ||
    isAuthOperationReplayExpired(operation, nowMs)
  )
    return null;
  if (
    operation.status === "success" &&
    isAuthProfileResponse(operation.result)
  ) {
    return "completed";
  }
  return operation.status === "started" || operation.status === "failed"
    ? "incomplete"
    : null;
}
