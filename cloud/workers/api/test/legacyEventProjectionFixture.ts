import { isSafeRecordKey } from "../src/recordKeys.ts";
import { STATE_FAILURE_MESSAGES } from "../src/stateCompatibility.ts";
import {
  EVENT_TELEGRAM_PROJECTION_OUTBOX_ROOT,
  EVENT_TELEGRAM_PROJECTION_GENERATION_ROOT,
} from "../src/eventTelegramProjectionProducer.ts";
export function getEventTelegramProjectionOutboxPath(eventId: string): string {
  if (!isSafeRecordKey(eventId)) {
    throw new TypeError(STATE_FAILURE_MESSAGES.invalidEventId);
  }
  return `${EVENT_TELEGRAM_PROJECTION_OUTBOX_ROOT}/${eventId}`;
}

export function getEventTelegramProjectionGenerationPath(
  eventId: string,
): string {
  if (!isSafeRecordKey(eventId)) {
    throw new TypeError(STATE_FAILURE_MESSAGES.invalidEventId);
  }
  return `${EVENT_TELEGRAM_PROJECTION_GENERATION_ROOT}/${eventId}`;
}
