import {
  listDueEventProgressOutboxes,
  listDueEventProfileGameProjectionOutboxes,
  listDueEventTelegramProjectionOutboxes,
  type EventD1Connection,
} from "./eventD1.ts";

export type EventOutboxReads = {
  listDueEventProgressOutboxes(
    beforeMs: number,
    limit?: number,
  ): Promise<Array<{ outboxId: string; record: unknown }>>;
  listDueEventProfileGameProjectionOutboxes(
    beforeMs: number,
    limit?: number,
  ): Promise<Array<{ eventId: string; record: unknown }>>;
  listDueEventTelegramProjectionOutboxes(
    beforeMs: number,
    limit?: number,
  ): Promise<Array<{ eventId: string; record: unknown }>>;
};

export function createEventOutboxReadRepository(
  db: EventD1Connection,
): EventOutboxReads {
  return {
    listDueEventProgressOutboxes: (beforeMs, limit) =>
      listDueEventProgressOutboxes(db, beforeMs, limit),
    listDueEventProfileGameProjectionOutboxes: (beforeMs, limit) =>
      listDueEventProfileGameProjectionOutboxes(db, beforeMs, limit),
    listDueEventTelegramProjectionOutboxes: (beforeMs, limit) =>
      listDueEventTelegramProjectionOutboxes(db, beforeMs, limit),
  };
}
