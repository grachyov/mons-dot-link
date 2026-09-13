import type {
  GameSessionChange,
  SessionTimestamp,
  SessionCounter,
} from "../gameSessionChanges.js";
export const TELEGRAM_AUTOMATCH_ROOT: "telegramAutomatches";
export const TELEGRAM_AUTOMATCH_PROJECTION_OUTBOX_ROOT: "telegramProjectionOutbox/automatch";
export const TELEGRAM_AUTOMATCH_VERSION: 2;

export interface AutomatchTelegramSourceInput {
  inviteId: string;
  timestamp: SessionTimestamp;
}

export function buildAutomatchTelegramProjectionChanges(input: {
  inviteId: string;
  requestId: string;
  timestamp: SessionTimestamp;
}): GameSessionChange[];
export function buildPendingAutomatchTelegramSource(
  input: AutomatchTelegramSourceInput & {
    waitingText: string;
    canceledText: string;
  },
): Record<string, unknown>;
export function buildMatchedAutomatchTelegramChanges(
  input: AutomatchTelegramSourceInput & {
    matchedText: string;
    generation: SessionCounter;
  },
): GameSessionChange[];
export function buildAutomatchTelegramLifecycleChanges(
  input: AutomatchTelegramSourceInput & {
    lifecycle: "canceled" | "matched";
    generation: SessionCounter;
  },
): GameSessionChange[];
