import type { TelegramDesired } from "./desiredStateCore.js";
export type EventTelegramProjectionOperation = {
  channel: "upcoming" | "reminder" | "started" | "ended";
  generation?: string;
  ifMissing: "send" | "skip" | null;
  instanceKey: string;
  messageKey: string;
  operation: "send" | "edit";
  sourceRevision: string;
  text: string;
};

export type EventTelegramProjection =
  | { action: "skip"; reason: string }
  | { action: "unchanged"; signature: string }
  | {
      action: "project";
      operations: EventTelegramProjectionOperation[];
      signature: string;
      state: Record<string, unknown>;
    };

export const EVENT_TELEGRAM_DELIVERY_VERSION: 2;
export const EVENT_TELEGRAM_PROJECTION_GUARD_FIELD: "eventTelegramProjectionGuard";
export const EVENT_TELEGRAM_PROJECTION_LOCK_ROOT: "eventTelegramProjectionLocks";
export const EVENT_TELEGRAM_PROJECTION_ROOT: "eventTelegramProjections";

export function isV2TelegramEvent(eventData: unknown): boolean;
export function buildEventSignature(eventData: unknown, nowMs?: number): string;
export function buildEventTelegramProjection(input: {
  eventId: string;
  eventData: unknown;
  endedMatchResults?: Record<string, unknown>;
  state?: unknown;
  upcomingMessage?: unknown;
  reminderMessage?: unknown;
  nowMs?: number;
}): EventTelegramProjection;
export type EventTelegramProjectionGuard = {
  eventId: string;
  generation?: number;
  lockId: string;
  lockRoot: string;
  ownerUid: string;
};
export type EventTelegramDesiredChange = {
  messageKey: string;
  value: TelegramDesired & {
    eventTelegramProjectionGuard?: EventTelegramProjectionGuard & {
      messageKey: string;
    };
  };
};
export type EventTelegramProjectionChanges = {
  eventId: string;
  state: Record<string, unknown>;
  desired: EventTelegramDesiredChange[];
};
export function buildEventTelegramProjectionChanges(input: {
  eventId: string;
  projection: EventTelegramProjection;
}): EventTelegramProjectionChanges | null;
export function addEventTelegramProjectionGuard(input: {
  changes: EventTelegramProjectionChanges;
  guard?: EventTelegramProjectionGuard | null;
}): EventTelegramProjectionChanges;
export function buildEventTelegramDispatches(input: {
  eventId: string;
  desiredChanges: EventTelegramDesiredChange[];
}): Array<{ generation: string; messageKey: string; revision: string }>;
export function loadEndedMatchResults(
  eventData: unknown,
  dependencies: { readRatingUpdate(operationId: string): Promise<unknown> },
): Promise<Record<string, unknown>>;
export function parseProjectionState(value: unknown): Record<string, unknown>;
export function buildStartedState(
  eventId: string,
  eventData: unknown,
  rawState?: unknown,
): Record<string, unknown>;
export function buildEndedState(
  eventId: string,
  eventData: unknown,
  resultsByKey?: Record<string, unknown>,
): Record<string, unknown>;
export function renderUpcomingMessage(
  eventId: string,
  eventData: unknown,
  nowMs?: number,
  heading?: "sunday mons soon" | "join sunday mons" | "upcoming event",
): string | null;
export function renderStartedMessage(
  eventId: string,
  matchLines?: string[],
  heading?: "event started" | "sunday mons starting now!",
): string;
export function renderEndedMessage(
  eventId: string,
  matchLines?: string[],
  placementLines?: string[],
  heading?: "event complete" | "good games",
): string;
export function formatPtEtUtcLine(startAtMs: number): string;
