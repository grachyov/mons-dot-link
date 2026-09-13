import type { EventMutation } from "../../../runtime/eventCommands.js";
import type {
  TransactionDecision,
  TransactionResult,
} from "../../../runtime/transactions.js";
import { STATE_EFFECTS_FIELD } from "./stateCompatibility.ts";
import { isEventPrizeId } from "@mons/shared/event-prizes";
import type {
  EventJsonRecord,
  EventPrizeAssignmentRecord,
  EventSnapshot,
  ProfileEventPrizePageQuery,
  ProfileEventPrizeSnapshot,
} from "../../../runtime/eventReads.js";

export type {
  EventJsonRecord,
  EventPrizeAssignmentRecord,
  EventSnapshot,
  ProfileEventPrizeSnapshot,
} from "../../../runtime/eventReads.js";

const MAX_EVENT_TRANSACTION_ATTEMPTS = 12;
const EVENT_WRITE_ADMISSION_TTL_MS = 5 * 60 * 1_000;
const EVENT_STATUSES = new Set(["scheduled", "active", "ended", "dismissed"]);
const UTF8_ENCODER = new TextEncoder();

export type EventD1Connection = Pick<D1Database, "batch" | "prepare">;
export type ConditionalSnapshot<T> =
  { notModified: true; revision: number } | { notModified: false; snapshot: T };
export type EventStorageMode = "frozen" | "d1";

export type EventRuntimeControl = {
  freezeGeneration: number;
  storageMode: EventStorageMode;
  updatedAtMs: number;
};

export type EventWriteAdmission = {
  admissionId: string;
  expiresAtMs: number;
  freezeGeneration: number;
};

export type EventLeaseGuard = {
  eventId: string;
  lockId: string;
  ownerUid: string;
};

type EventTransitionIntentBase = {
  canonicalUpdates: Record<string, unknown>;
  createdAtMs: number;
  eventId: string;
  expectedRevision: number;
  [STATE_EFFECTS_FIELD]: Record<string, unknown>;
  transitionId: string;
  updatedAtMs: number;
};

export type EventInviteSourceMutation = {
  current: {
    inviteId: string;
    value: Record<string, unknown> | null;
    revision: number;
  };
  value: Record<string, unknown>;
};

export type EventTransitionIntent = EventTransitionIntentBase &
  (
    | { schemaVersion: 1 }
    | {
        schemaVersion: 2;
        sourceEpoch: number;
        payloadDigest: string;
        inviteMutations: EventInviteSourceMutation[];
      }
  );

export type EventOutboxRecord = Record<string, unknown>;

export class EventD1Failure extends Error {
  constructor(message = "event-d1-unavailable", options?: ErrorOptions) {
    super(message, options);
  }
}

export class EventD1Conflict extends EventD1Failure {
  constructor(message = "event-d1-conflict", options?: ErrorOptions) {
    super(message, options);
  }
}

export class EventWritesDisabled extends EventD1Failure {
  constructor() {
    super("event-writes-disabled");
  }
}

type EventRow = {
  event_id: string;
  pending_transition_id: string | null;
  record_json: string | null;
  revision: number;
  start_at_ms: number;
  status: string;
  updated_at_ms: number;
};

type AssignmentRow = {
  assignment_json: string;
  event_id: string;
  profile_id: string;
};

type RuntimeControlRow = {
  freeze_generation: number;
  storage_mode: string;
  updated_at_ms: number;
};

type DecodedEventRow = {
  event: EventJsonRecord;
  pendingTransitionId: string | null;
  revision: number;
};

type EventMutationState = {
  current: EventJsonRecord | null;
  next: EventJsonRecord | null;
  originalSelections: Readonly<Record<string, string>> | null;
  pendingTransitionId: string | null;
  revision: number;
  selections: Record<string, string> | null;
  selectionsChanged: boolean;
};

type ProfilePrizeMutationState = {
  originalPrizes: Readonly<Record<string, EventPrizeAssignmentRecord>>;
  prizes: Record<string, EventPrizeAssignmentRecord>;
  revision: number;
};

type ProfilePrizeAssignmentSnapshot = {
  assignment: EventPrizeAssignmentRecord | null;
  eventId: string;
  profileId: string;
  revision: number;
};

type StoredEventSnapshot = EventSnapshot & {
  pendingTransitionId: string | null;
};

type EventMutationOptions = {
  admission: EventWriteAdmission;
  allowStoredProfilePrizeAssignment?: boolean;
  eventLease?: EventLeaseGuard;
  eventSnapshot?: StoredEventSnapshot;
  expectedEventRevisions?: Readonly<Record<string, number>>;
  expectedRecords?: {
    progress?: Readonly<Record<string, unknown>>;
    dead?: Readonly<Record<string, unknown>>;
    profileGame?: Readonly<Record<string, unknown>>;
    telegram?: Readonly<Record<string, unknown>>;
  };
  expectedProfilePrizeRevisions?: Readonly<Record<string, number>>;
  expectedTelegramStateRevisions?: Readonly<Record<string, number>>;
  now?: () => number;
  profilePrizeSnapshot?: ProfilePrizeAssignmentSnapshot;
  transition?: { eventId: string; transitionId: string };
};

type PublicEventMutationOptions = Omit<
  EventMutationOptions,
  "allowStoredProfilePrizeAssignment" | "eventSnapshot" | "profilePrizeSnapshot"
>;

type EventMutationResult = {
  eventRevisions: Record<string, number>;
  profilePrizeRevisions: Record<string, number>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) || 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      !hasControlCharacter(key) && isJsonValue(entry, depth + 1),
  );
}

function exactKey(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value) return "";
  const bytes = UTF8_ENCODER.encode(value).byteLength;
  return bytes > 0 &&
    bytes <= 768 &&
    ![".", "#", "$", "/", "[", "]"].some((character) =>
      value.includes(character),
    ) &&
    !hasControlCharacter(value)
    ? value
    : "";
}

function safeInteger(value: unknown, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new EventD1Failure("invalid-event-integer");
  }
  return value;
}

function nullableInteger(value: unknown, minimum = 0): number | null {
  return value === null || value === undefined
    ? null
    : safeInteger(value, minimum);
}

function cloneJson<T>(value: T): T {
  if (!isJsonValue(value)) throw new EventD1Failure("invalid-event-json");
  return structuredClone(value);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (!jsonValuesEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key]),
    )
  );
}

function encodeJson(value: unknown): string {
  if (!isJsonValue(value)) throw new EventD1Failure("invalid-event-json");
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new EventD1Failure("invalid-event-json", { cause: error });
  }
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") throw new EventD1Failure();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isJsonValue(parsed)) throw new EventD1Failure();
    return parsed;
  } catch (error) {
    if (error instanceof EventD1Failure) throw error;
    throw new EventD1Failure("invalid-event-json", { cause: error });
  }
}

export function validateEventAggregate(
  eventId: string,
  value: unknown,
): EventJsonRecord {
  const normalizedEventId = exactKey(eventId);
  if (!normalizedEventId || !isRecord(value) || !isJsonValue(value)) {
    throw new EventD1Failure("invalid-event-record");
  }
  if (
    value.eventId !== normalizedEventId ||
    !EVENT_STATUSES.has(String(value.status)) ||
    !Number.isSafeInteger(value.startAtMs) ||
    Number(value.startAtMs) < 0 ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    Number(value.updatedAtMs) < 0 ||
    !isRecord(value.participants) ||
    !isRecord(value.rounds)
  ) {
    throw new EventD1Failure("invalid-event-record");
  }
  if (Object.keys(value.participants).length > 32) {
    throw new EventD1Failure("invalid-event-record");
  }
  for (const [profileId, participant] of Object.entries(value.participants)) {
    if (!exactKey(profileId) || !isRecord(participant)) {
      throw new EventD1Failure("invalid-event-record");
    }
  }
  for (const round of Object.values(value.rounds)) {
    if (!isRecord(round)) throw new EventD1Failure("invalid-event-record");
  }
  return cloneJson(value);
}

function parseStoredEventPrizeAssignment(
  profileId: string,
  eventId: string,
  value: unknown,
): EventPrizeAssignmentRecord {
  const normalizedProfileId = exactKey(profileId);
  const normalizedEventId = exactKey(eventId);
  const prizeId = isRecord(value) ? exactKey(value.prizeId) : "";
  if (
    !normalizedProfileId ||
    !normalizedEventId ||
    !prizeId ||
    !isRecord(value) ||
    !isJsonValue(value) ||
    value.profileId !== normalizedProfileId ||
    value.eventId !== normalizedEventId ||
    (value.place !== 1 && value.place !== 2 && value.place !== 3) ||
    !Number.isSafeInteger(value.assignedAtMs) ||
    Number(value.assignedAtMs) < 0
  ) {
    throw new EventD1Failure("invalid-event-prize-assignment");
  }
  return cloneJson(value) as EventPrizeAssignmentRecord;
}

export function validateEventPrizeAssignment(
  profileId: string,
  eventId: string,
  value: unknown,
): EventPrizeAssignmentRecord {
  const assignment = parseStoredEventPrizeAssignment(profileId, eventId, value);
  if (!isEventPrizeId(assignment.eventId, assignment.prizeId)) {
    throw new EventD1Failure("invalid-event-prize-assignment");
  }
  return assignment;
}

function parseStoredPrizeSelection(value: unknown): string {
  const prizeId = exactKey(value);
  if (!prizeId) {
    throw new EventD1Failure("invalid-event-prize-selection");
  }
  return prizeId;
}

function validatePrizeSelection(eventId: string, value: unknown): string {
  const prizeId = parseStoredPrizeSelection(value);
  if (!isEventPrizeId(eventId, prizeId)) {
    throw new EventD1Failure("invalid-event-prize-selection");
  }
  return prizeId;
}

function decodeEventRow(row: EventRow): DecodedEventRow {
  const event = validateEventAggregate(
    row.event_id,
    decodeJson(row.record_json),
  );
  if (
    event.status !== row.status ||
    event.startAtMs !== row.start_at_ms ||
    event.updatedAtMs !== row.updated_at_ms
  ) {
    throw new EventD1Failure("event-row-mismatch");
  }
  return {
    event,
    pendingTransitionId: row.pending_transition_id,
    revision: safeInteger(row.revision, 1),
  };
}

async function readEventRecord(
  db: EventD1Connection,
  eventId: string,
): Promise<DecodedEventRow | null> {
  const normalizedEventId = exactKey(eventId);
  if (!normalizedEventId) throw new EventD1Failure("invalid-event-id");
  const row = await db
    .prepare(
      `SELECT event_id, status, start_at_ms, updated_at_ms, revision,
              pending_transition_id, record_json
       FROM event_records WHERE event_id = ?`,
    )
    .bind(normalizedEventId)
    .first<EventRow>();
  return row ? decodeEventRow(row) : null;
}

async function readSelections(
  db: EventD1Connection,
  eventId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .prepare(
      `SELECT profile_id, prize_id FROM event_prize_selections
       WHERE event_id = ? ORDER BY profile_id`,
    )
    .bind(eventId)
    .all<{ prize_id: string; profile_id: string }>();
  return selectionsFromRows(eventId, rows.results);
}

export async function readEvent(
  db: EventD1Connection,
  eventId: string,
): Promise<EventJsonRecord | null> {
  return (await readEventRecord(db, eventId))?.event ?? null;
}

export async function readEventPrizeSelections(
  db: EventD1Connection,
  eventId: string,
): Promise<Record<string, string>> {
  const normalizedEventId = exactKey(eventId);
  if (!normalizedEventId) throw new EventD1Failure("invalid-event-id");
  return readSelections(db, normalizedEventId);
}

function selectionsFromRows(
  eventId: string,
  rows: Array<{ prize_id: string; profile_id: string }>,
): Record<string, string> {
  const selections: Record<string, string> = {};
  for (const row of rows) {
    const profileId = exactKey(row.profile_id);
    if (!profileId) throw new EventD1Failure();
    selections[profileId] = parseStoredPrizeSelection(row.prize_id);
  }
  return selections;
}

export async function readEventSnapshot(
  db: EventD1Connection,
  eventId: string,
): Promise<EventSnapshot> {
  const result = await readEventSnapshotIfChanged(db, eventId);
  if (result.notModified) throw new EventD1Failure();
  return result.snapshot;
}

export async function readEventSnapshotIfChanged(
  db: EventD1Connection,
  eventId: string,
  knownRevision: number | null = null,
): Promise<ConditionalSnapshot<EventSnapshot>> {
  const result = await readStoredEventSnapshotIfChanged(
    db,
    eventId,
    knownRevision,
  );
  if (result.notModified) return result;
  const {
    event,
    eventId: storedEventId,
    prizeSelections,
    revision,
  } = result.snapshot;
  return {
    notModified: false,
    snapshot: { event, eventId: storedEventId, prizeSelections, revision },
  };
}

async function readStoredEventSnapshotIfChanged(
  db: EventD1Connection,
  eventId: string,
  knownRevision: number | null = null,
): Promise<ConditionalSnapshot<StoredEventSnapshot>> {
  const normalizedEventId = exactKey(eventId);
  if (!normalizedEventId) throw new EventD1Failure("invalid-event-id");
  if (knownRevision !== null) safeInteger(knownRevision);
  const results = await db.batch([
    db
      .prepare(
        `SELECT event_id, status, start_at_ms, updated_at_ms, revision,
                pending_transition_id,
                CASE WHEN revision = ? THEN NULL ELSE record_json END AS record_json
         FROM event_records WHERE event_id = ?`,
      )
      .bind(knownRevision, normalizedEventId),
    db
      .prepare(
        `SELECT profile_id, prize_id FROM event_prize_selections
         WHERE event_id = CASE WHEN EXISTS (
           SELECT 1 FROM event_records WHERE event_id = ? AND revision = ?
         ) THEN NULL ELSE ? END ORDER BY profile_id`,
      )
      .bind(normalizedEventId, knownRevision, normalizedEventId),
  ]);
  const row = results[0].results[0] as EventRow | undefined;
  if (!row) {
    if (knownRevision === 0) return { notModified: true, revision: 0 };
    return {
      notModified: false,
      snapshot: {
        event: null,
        eventId: normalizedEventId,
        pendingTransitionId: null,
        prizeSelections: {},
        revision: 0,
      },
    };
  }
  if (knownRevision !== null && row.revision === knownRevision) {
    if (
      exactKey(row.event_id) !== normalizedEventId ||
      !EVENT_STATUSES.has(row.status)
    ) {
      throw new EventD1Failure("event-row-mismatch");
    }
    safeInteger(row.start_at_ms);
    safeInteger(row.updated_at_ms);
    return { notModified: true, revision: safeInteger(row.revision, 1) };
  }
  const state = decodeEventRow(row);
  return {
    notModified: false,
    snapshot: {
      event: state.event,
      eventId: normalizedEventId,
      pendingTransitionId: state.pendingTransitionId,
      prizeSelections: selectionsFromRows(
        normalizedEventId,
        results[1].results as Array<{ prize_id: string; profile_id: string }>,
      ),
      revision: state.revision,
    },
  };
}

export async function listEventAggregates(
  db: EventD1Connection,
  input: {
    limit?: number;
    status?: "scheduled" | "active" | "ended" | "dismissed";
  } = {},
): Promise<Record<string, EventJsonRecord>> {
  const limit = Math.min(safeInteger(input.limit ?? 1_000, 1), 1_000);
  const rows = input.status
    ? await db
        .prepare(
          `SELECT event_id, status, start_at_ms, updated_at_ms, revision,
                  pending_transition_id, record_json
           FROM event_records WHERE status = ?
           ORDER BY start_at_ms, event_id LIMIT ?`,
        )
        .bind(input.status, limit)
        .all<EventRow>()
    : await db
        .prepare(
          `SELECT event_id, status, start_at_ms, updated_at_ms, revision,
                  pending_transition_id, record_json
           FROM event_records ORDER BY updated_at_ms, event_id LIMIT ?`,
        )
        .bind(limit)
        .all<EventRow>();
  return Object.fromEntries(
    rows.results.map((row) => [row.event_id, decodeEventRow(row).event]),
  );
}

export async function readProfileEventPrizes(
  db: EventD1Connection,
  profileId: string,
): Promise<ProfileEventPrizeSnapshot> {
  const result = await readProfileEventPrizesIfChanged(db, profileId);
  if (result.notModified) throw new EventD1Failure();
  return result.snapshot;
}

export async function readProfileEventPrizesIfChanged(
  db: EventD1Connection,
  profileId: string,
  knownRevision: number | null = null,
): Promise<ConditionalSnapshot<ProfileEventPrizeSnapshot>> {
  const normalizedProfileId = exactKey(profileId);
  if (!normalizedProfileId) throw new EventD1Failure("invalid-profile-id");
  if (knownRevision !== null) safeInteger(knownRevision);
  const results = await db.batch([
    db
      .prepare(
        `SELECT profile_id, event_id, assignment_json
         FROM profile_event_prizes
         WHERE profile_id = CASE WHEN EXISTS (
           SELECT 1 FROM profile_event_prize_revisions
           WHERE profile_id = ? AND revision = ?
         ) THEN NULL ELSE ? END ORDER BY event_id`,
      )
      .bind(normalizedProfileId, knownRevision, normalizedProfileId),
    db
      .prepare(
        `SELECT revision FROM profile_event_prize_revisions
         WHERE profile_id = ?`,
      )
      .bind(normalizedProfileId),
  ]);
  const revisionRow = results[1].results[0] as { revision: number } | undefined;
  const revision = revisionRow ? safeInteger(revisionRow.revision, 1) : 0;
  if (revisionRow && knownRevision === revision) {
    return { notModified: true, revision };
  }
  const prizes: Record<string, EventPrizeAssignmentRecord> = {};
  for (const row of results[0].results as AssignmentRow[]) {
    prizes[row.event_id] = parseStoredEventPrizeAssignment(
      normalizedProfileId,
      row.event_id,
      decodeJson(row.assignment_json),
    );
  }
  if (knownRevision === revision) return { notModified: true, revision };
  return {
    notModified: false,
    snapshot: { prizes, profileId: normalizedProfileId, revision },
  };
}

export async function readProfileEventPrizeAssignment(
  db: EventD1Connection,
  profileId: string,
  eventId: string,
): Promise<EventPrizeAssignmentRecord | null> {
  const normalizedProfileId = exactKey(profileId);
  if (!normalizedProfileId) throw new EventD1Failure("invalid-profile-id");
  const normalizedEventId = exactKey(eventId);
  if (!normalizedEventId) throw new EventD1Failure("invalid-event-id");
  const row = await db
    .prepare(
      `SELECT assignment_json FROM profile_event_prizes
       WHERE profile_id = ? AND event_id = ?`,
    )
    .bind(normalizedProfileId, normalizedEventId)
    .first<{ assignment_json: string }>();
  return row
    ? parseStoredEventPrizeAssignment(
        normalizedProfileId,
        normalizedEventId,
        decodeJson(row.assignment_json),
      )
    : null;
}

export async function listProfileEventPrizeAssignments(
  db: EventD1Connection,
  profileId: string,
  query: ProfileEventPrizePageQuery = {},
): Promise<Record<string, EventPrizeAssignmentRecord>> {
  const normalizedProfileId = exactKey(profileId);
  if (!normalizedProfileId) throw new EventD1Failure("invalid-profile-id");
  const startAt = typeof query.startAt === "string" ? query.startAt : "";
  const limit = safeInteger(query.limit || 100, 1);
  const ascii = /^[\x20-\x7e]*$/;
  let rows = ascii.test(startAt)
    ? (
        await db
          .prepare(
            `SELECT profile_id, event_id, assignment_json
             FROM profile_event_prizes
             WHERE profile_id = ? AND event_id >= ?
             ORDER BY event_id LIMIT ?`,
          )
          .bind(normalizedProfileId, startAt, limit)
          .all<AssignmentRow>()
      ).results
    : null;
  // Existing recovery cursors use JavaScript's UTF-16 ordering.
  if (rows === null || rows.some((row) => !ascii.test(row.event_id))) {
    const stored = await db
      .prepare(
        `SELECT profile_id, event_id, assignment_json
         FROM profile_event_prizes WHERE profile_id = ?`,
      )
      .bind(normalizedProfileId)
      .all<AssignmentRow>();
    rows = stored.results
      .filter((row) => row.event_id >= startAt)
      .sort((left, right) =>
        left.event_id < right.event_id
          ? -1
          : left.event_id > right.event_id
            ? 1
            : 0,
      )
      .slice(0, limit);
  }
  return Object.fromEntries(
    rows.map((row) => [
      row.event_id,
      parseStoredEventPrizeAssignment(
        normalizedProfileId,
        row.event_id,
        decodeJson(row.assignment_json),
      ),
    ]),
  );
}

function parseRuntimeControl(
  row: RuntimeControlRow | null,
): EventRuntimeControl {
  if (!row) throw new EventD1Failure("event-runtime-control-unavailable");
  if (row.storage_mode !== "frozen" && row.storage_mode !== "d1") {
    throw new EventD1Failure("invalid-event-runtime-control");
  }
  return {
    freezeGeneration: safeInteger(row.freeze_generation),
    storageMode: row.storage_mode,
    updatedAtMs: safeInteger(row.updated_at_ms),
  };
}

export async function readEventRuntimeControl(
  db: EventD1Connection,
): Promise<EventRuntimeControl> {
  const row = await db
    .prepare(
      "SELECT storage_mode, freeze_generation, updated_at_ms FROM event_runtime_control WHERE singleton = 1",
    )
    .first<RuntimeControlRow>();
  return parseRuntimeControl(row);
}

export async function assertEventWritesAllowed(
  db: EventD1Connection,
): Promise<void> {
  if ((await readEventRuntimeControl(db)).storageMode === "frozen") {
    throw new EventWritesDisabled();
  }
}

export async function acquireEventWriteAdmission(
  db: EventD1Connection,
  input: {
    admissionId?: string;
    nowMs?: number;
    ttlMs?: number;
  } = {},
): Promise<EventWriteAdmission> {
  const admissionId = exactKey(
    input.admissionId || `ewa_${crypto.randomUUID()}`,
  );
  const nowMs = safeInteger(input.nowMs ?? Date.now());
  const ttlMs = safeInteger(input.ttlMs ?? EVENT_WRITE_ADMISSION_TTL_MS, 1);
  if (!admissionId || nowMs + ttlMs > Number.MAX_SAFE_INTEGER) {
    throw new EventD1Failure("invalid-event-write-admission");
  }
  const result = await db
    .prepare(
      `INSERT INTO event_write_admissions (
         admission_id, freeze_generation, created_at_ms, expires_at_ms
       )
       SELECT ?, freeze_generation, ?, ?
       FROM event_runtime_control
       WHERE singleton = 1 AND storage_mode = 'd1'
       RETURNING freeze_generation`,
    )
    .bind(admissionId, nowMs, nowMs + ttlMs)
    .all<{ freeze_generation: number }>();
  const freezeGeneration = result.results[0]?.freeze_generation;
  if (freezeGeneration === undefined) throw new EventWritesDisabled();
  return {
    admissionId,
    expiresAtMs: nowMs + ttlMs,
    freezeGeneration: safeInteger(freezeGeneration),
  };
}

export async function releaseEventWriteAdmission(
  db: EventD1Connection,
  admission: Pick<EventWriteAdmission, "admissionId">,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM event_write_admissions WHERE admission_id = ?")
    .bind(exactKey(admission.admissionId))
    .run();
  return result.meta.changes === 1;
}

function guardStatement(
  db: EventD1Connection,
  failurePredicate: string,
  values: unknown[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO event_transaction_guards (singleton)
       SELECT 0 WHERE ${failurePredicate}`,
    )
    .bind(...values);
}

function eventWriteAdmissionGuard(
  db: EventD1Connection,
  admission: EventWriteAdmission,
): D1PreparedStatement {
  return guardStatement(
    db,
    `NOT EXISTS (
       SELECT 1
       FROM event_write_admissions AS admission
       JOIN event_runtime_control AS control ON control.singleton = 1
       WHERE admission.admission_id = ?
         AND admission.freeze_generation = ?
         AND admission.freeze_generation = control.freeze_generation
         AND admission.expires_at_ms > CAST(
           (julianday('now') - 2440587.5) * 86400000 AS INTEGER
         )
         AND control.storage_mode = 'd1'
     )`,
    [admission.admissionId, admission.freezeGeneration],
  );
}

function eventLeaseGuard(
  db: EventD1Connection,
  lease: EventLeaseGuard,
): D1PreparedStatement {
  const eventId = exactKey(lease.eventId);
  const lockId = exactKey(lease.lockId);
  const ownerUid = exactKey(lease.ownerUid);
  if (!eventId || !lockId || !ownerUid) {
    throw new EventD1Failure("invalid-event-lease-guard");
  }
  return guardStatement(
    db,
    `NOT EXISTS (
       SELECT 1 FROM event_leases
       WHERE event_id = ? AND lease_id = ? AND owner_uid = ?
         AND expires_at_ms > CAST(
           (julianday('now') - 2440587.5) * 86400000 AS INTEGER
         )
     )`,
    [eventId, lockId, ownerUid],
  );
}

function isConstraintFailure(error: unknown): boolean {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : "";
  return /constraint|event_transaction_guards|event transition|event pending|foreign key/i.test(
    message,
  );
}

function setNested(
  root: Record<string, unknown>,
  parts: readonly string[],
  value: unknown,
): void {
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const existing = current[part];
    if (!isRecord(existing)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  const key = parts.at(-1);
  if (!key) throw new EventD1Failure("invalid-event-path");
  if (value === null) delete current[key];
  else current[key] = cloneJson(value);
}

async function getEventMutationState(
  db: EventD1Connection,
  states: Map<string, EventMutationState>,
  eventId: string,
): Promise<EventMutationState> {
  let state = states.get(eventId);
  if (!state) {
    const stored = await readEventRecord(db, eventId);
    state = {
      current: stored?.event ?? null,
      next: stored ? cloneJson(stored.event) : null,
      originalSelections: null,
      pendingTransitionId: stored?.pendingTransitionId ?? null,
      revision: stored?.revision ?? 0,
      selections: null,
      selectionsChanged: false,
    };
    states.set(eventId, state);
  }
  return state;
}

async function ensureSelections(
  db: EventD1Connection,
  eventId: string,
  state: EventMutationState,
): Promise<Record<string, string>> {
  if (state.selections === null) {
    state.originalSelections = await readSelections(db, eventId);
    state.selections = { ...state.originalSelections };
  }
  return state.selections;
}

async function readProfilePrizeMutationState(
  db: EventD1Connection,
  profileId: string,
): Promise<ProfilePrizeMutationState> {
  const snapshot = await readProfileEventPrizes(db, profileId);
  return {
    originalPrizes: snapshot.prizes,
    prizes: { ...snapshot.prizes },
    revision: snapshot.revision,
  };
}

async function readProfilePrizeAssignmentSnapshot(
  db: EventD1Connection,
  profileId: string,
  eventId: string,
): Promise<ProfilePrizeAssignmentSnapshot> {
  const normalizedProfileId = exactKey(profileId);
  if (!normalizedProfileId) throw new EventD1Failure("invalid-profile-id");
  const row = await db
    .prepare(
      `SELECT
         (SELECT assignment_json FROM profile_event_prizes
          WHERE profile_id = ? AND event_id = ?) AS assignment_json,
         (SELECT revision FROM profile_event_prize_revisions
          WHERE profile_id = ?) AS revision`,
    )
    .bind(normalizedProfileId, eventId, normalizedProfileId)
    .first<{ assignment_json: string | null; revision: number | null }>();
  if (!row) throw new EventD1Failure();
  return {
    assignment:
      row.assignment_json === null
        ? null
        : parseStoredEventPrizeAssignment(
            normalizedProfileId,
            eventId,
            decodeJson(row.assignment_json),
          ),
    eventId,
    profileId: normalizedProfileId,
    revision: row.revision === null ? 0 : safeInteger(row.revision, 1),
  };
}

function eventRevisionGuard(
  db: EventD1Connection,
  eventId: string,
  expectedRevision: number,
): D1PreparedStatement {
  return expectedRevision === 0
    ? guardStatement(
        db,
        "EXISTS (SELECT 1 FROM event_records WHERE event_id = ?)",
        [eventId],
      )
    : guardStatement(
        db,
        `NOT EXISTS (
           SELECT 1 FROM event_records WHERE event_id = ? AND revision = ?
         )`,
        [eventId, expectedRevision],
      );
}

function eventMutationGuard(
  db: EventD1Connection,
  eventId: string,
  state: EventMutationState,
): D1PreparedStatement {
  if (state.revision === 0) return eventRevisionGuard(db, eventId, 0);
  return guardStatement(
    db,
    `NOT EXISTS (
       SELECT 1 FROM event_records
       WHERE event_id = ? AND revision = ? AND pending_transition_id IS ?
     )`,
    [eventId, state.revision, state.pendingTransitionId],
  );
}

function profileRevisionGuard(
  db: EventD1Connection,
  profileId: string,
  expectedRevision: number,
): D1PreparedStatement {
  return expectedRevision === 0
    ? guardStatement(
        db,
        `EXISTS (
           SELECT 1 FROM profile_event_prize_revisions WHERE profile_id = ?
         )`,
        [profileId],
      )
    : guardStatement(
        db,
        `NOT EXISTS (
           SELECT 1 FROM profile_event_prize_revisions
           WHERE profile_id = ? AND revision = ?
         )`,
        [profileId, expectedRevision],
      );
}

function recordJsonGuard(
  db: EventD1Connection,
  table:
    | "event_progress_outboxes"
    | "event_profile_game_projection_outboxes"
    | "event_telegram_projection_outboxes",
  recordId: string,
  expected: unknown,
  status?: "dead" | "pending",
): D1PreparedStatement {
  const keyColumn =
    table === "event_progress_outboxes" ? "outbox_id" : "event_id";
  const statusPredicate = status ? " AND status = ?" : "";
  const keyValues = status ? [recordId, status] : [recordId];
  return expected === null
    ? guardStatement(
        db,
        `EXISTS (
           SELECT 1 FROM ${table}
           WHERE ${keyColumn} = ?${statusPredicate}
         )`,
        keyValues,
      )
    : guardStatement(
        db,
        `NOT EXISTS (
           SELECT 1 FROM ${table}
           WHERE ${keyColumn} = ?${statusPredicate} AND record_json = ?
         )`,
        [...keyValues, encodeJson(expected)],
      );
}

function telegramStateRevisionGuard(
  db: EventD1Connection,
  eventId: string,
  expectedRevision: number,
): D1PreparedStatement {
  return expectedRevision === 0
    ? guardStatement(
        db,
        "EXISTS (SELECT 1 FROM event_telegram_projection_state WHERE event_id = ?)",
        [eventId],
      )
    : guardStatement(
        db,
        `NOT EXISTS (
           SELECT 1 FROM event_telegram_projection_state
           WHERE event_id = ? AND revision = ?
         )`,
        [eventId, expectedRevision],
      );
}

function eventRecordStatement(
  db: EventD1Connection,
  eventId: string,
  state: EventMutationState,
  pendingTransitionId: string | null,
): D1PreparedStatement {
  if (!state.next) {
    return db
      .prepare("DELETE FROM event_records WHERE event_id = ?")
      .bind(eventId);
  }
  const event = validateEventAggregate(eventId, state.next);
  return db
    .prepare(
      `INSERT INTO event_records (
         event_id, status, start_at_ms, updated_at_ms, revision,
         pending_transition_id, record_json
       ) VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (event_id) DO UPDATE SET
         status = excluded.status,
         start_at_ms = excluded.start_at_ms,
         updated_at_ms = excluded.updated_at_ms,
         revision = event_records.revision + 1,
         pending_transition_id = excluded.pending_transition_id,
         record_json = excluded.record_json`,
    )
    .bind(
      eventId,
      event.status,
      event.startAtMs,
      event.updatedAtMs,
      pendingTransitionId,
      encodeJson(event),
    );
}

async function commitEventMutationsInternal(
  db: EventD1Connection,
  changes: readonly EventMutation[],
  options: EventMutationOptions,
): Promise<EventMutationResult> {
  const now = options.now || Date.now;
  const nowMs = safeInteger(now());
  const eventStates = new Map<string, EventMutationState>();
  const profileStates = new Map<string, ProfilePrizeMutationState>();
  const eventSnapshot = options.eventSnapshot;
  if (eventSnapshot) {
    if (
      changes.length !== 1 ||
      !("eventId" in changes[0]) ||
      changes[0].eventId !== eventSnapshot.eventId
    )
      throw new EventD1Failure("invalid-event-snapshot-scope");
    eventStates.set(eventSnapshot.eventId, {
      current: eventSnapshot.event,
      next: cloneJson(eventSnapshot.event),
      originalSelections: eventSnapshot.prizeSelections,
      pendingTransitionId: eventSnapshot.pendingTransitionId,
      revision: eventSnapshot.revision,
      selections: { ...eventSnapshot.prizeSelections },
      selectionsChanged: false,
    });
  }
  const snapshot = options.profilePrizeSnapshot;
  if (snapshot) {
    if (
      changes.length !== 1 ||
      changes[0].kind !== "profile-prize" ||
      changes[0].profileId !== snapshot.profileId ||
      changes[0].eventId !== snapshot.eventId
    )
      throw new EventD1Failure("invalid-profile-prize-snapshot-scope");
    const originalPrizes =
      snapshot.assignment === null
        ? {}
        : { [snapshot.eventId]: snapshot.assignment };
    profileStates.set(snapshot.profileId, {
      originalPrizes,
      prizes: Object.assign(Object.create(null), originalPrizes),
      revision: snapshot.revision,
    });
  }
  const progressUpdates = new Map<string, unknown>();
  const progressDeadUpdates = new Map<string, unknown>();
  const profileProjectionUpdates = new Map<string, unknown>();
  const telegramProjectionUpdates = new Map<string, unknown>();
  const telegramStateUpdates = new Map<
    string,
    { generation?: unknown; state?: unknown }
  >();

  for (const change of changes) {
    for (const key of ["eventId", "profileId", "outboxId"] as const)
      if (key in change && !exactKey(change[key as keyof typeof change]))
        throw new EventD1Failure("invalid-event-path");
    if (
      "roundKey" in change &&
      change.roundKey !== null &&
      !exactKey(change.roundKey)
    )
      throw new EventD1Failure("invalid-event-path");
    if ("matchKey" in change && !exactKey(change.matchKey))
      throw new EventD1Failure("invalid-event-path");
    const { value } = change;
    switch (change.kind) {
      case "event":
      case "event-field":
      case "event-participant":
      case "event-disqualification":
      case "event-round":
      case "event-match-status": {
        const eventId = exactKey(change.eventId);
        if (!eventId) throw new EventD1Failure("invalid-event-path");
        const state = await getEventMutationState(db, eventStates, eventId);
        if (change.kind === "event") {
          if (value === null)
            throw new EventD1Failure("event-deletion-unsupported");
          state.next = validateEventAggregate(eventId, value);
        } else {
          if (!state.next) throw new EventD1Conflict("event-not-found");
          if (change.kind === "event-round")
            setNested(state.next, ["rounds", exactKey(change.roundKey)], value);
          if (change.kind === "event-match-status")
            setNested(
              state.next,
              [
                "rounds",
                exactKey(change.roundKey),
                "matches",
                exactKey(change.matchKey),
                "status",
              ],
              value,
            );
          if (change.kind === "event-field")
            setNested(state.next, [change.field], value);
          if (change.kind === "event-participant")
            setNested(
              state.next,
              ["participants", exactKey(change.profileId)],
              value,
            );
          if (change.kind === "event-disqualification")
            setNested(
              state.next,
              change.roundKey === null
                ? ["thirdPlaceMatch", "winnerDisqualified"]
                : [
                    "rounds",
                    exactKey(change.roundKey),
                    "matches",
                    exactKey(change.matchKey),
                    "winnerDisqualified",
                  ],
              value,
            );
        }
        break;
      }
      case "prize-selections":
      case "prize-selection": {
        const eventId = exactKey(change.eventId);
        if (!eventId) throw new EventD1Failure("invalid-event-path");
        const state = await getEventMutationState(db, eventStates, eventId);
        if (!state.next) throw new EventD1Conflict("event-not-found");
        const selections = await ensureSelections(db, eventId, state);
        if (change.kind === "prize-selections") {
          const replacement = value === null ? {} : value;
          if (!isRecord(replacement))
            throw new EventD1Failure("invalid-event-prize-selections");
          state.selections = Object.fromEntries(
            Object.entries(replacement).map(([profileId, prizeId]) => {
              const key = exactKey(profileId);
              if (!key)
                throw new EventD1Failure("invalid-event-prize-selection");
              return [key, validatePrizeSelection(eventId, prizeId)];
            }),
          );
        } else {
          const profileId = exactKey(change.profileId);
          if (!profileId) throw new EventD1Failure("invalid-event-path");
          if (value === null) delete selections[profileId];
          else selections[profileId] = validatePrizeSelection(eventId, value);
        }
        state.selectionsChanged = true;
        break;
      }
      case "profile-prizes":
      case "profile-prize": {
        const profileId = exactKey(change.profileId);
        if (!profileId) throw new EventD1Failure("invalid-event-path");
        let state = profileStates.get(profileId);
        if (!state) {
          state = await readProfilePrizeMutationState(db, profileId);
          profileStates.set(profileId, state);
        }
        if (change.kind === "profile-prizes") {
          const replacement = value === null ? {} : value;
          if (!isRecord(replacement))
            throw new EventD1Failure("invalid-profile-event-prizes");
          state.prizes = Object.fromEntries(
            Object.entries(replacement).map(([eventId, assignment]) => [
              eventId,
              validateEventPrizeAssignment(profileId, eventId, assignment),
            ]),
          );
        } else {
          const eventId = exactKey(change.eventId);
          if (!eventId) throw new EventD1Failure("invalid-event-path");
          if (value === null) delete state.prizes[eventId];
          else
            state.prizes[eventId] = options.allowStoredProfilePrizeAssignment
              ? parseStoredEventPrizeAssignment(profileId, eventId, value)
              : validateEventPrizeAssignment(profileId, eventId, value);
        }
        break;
      }
      case "progress-outbox":
        progressUpdates.set(exactKey(change.outboxId), value);
        break;
      case "progress-dead":
        progressDeadUpdates.set(exactKey(change.outboxId), value);
        break;
      case "progress-dispatched": {
        const outboxId = exactKey(change.outboxId);
        const current = await readEventProgressOutbox(db, outboxId);
        if (!current) throw new EventD1Conflict("event-progress-not-found");
        progressUpdates.set(outboxId, {
          ...cloneJson(current),
          lastQueuedAtMs: value,
        });
        break;
      }
      case "profile-game-outbox":
        profileProjectionUpdates.set(exactKey(change.eventId), value);
        break;
      case "profile-game-outbox-field":
      case "profile-game-outbox-cleanup": {
        const eventId = exactKey(change.eventId);
        const stored = profileProjectionUpdates.has(eventId)
          ? profileProjectionUpdates.get(eventId)
          : await readEventProfileGameProjectionOutbox(db, eventId);
        const next = isRecord(stored) ? cloneJson(stored) : {};
        setNested(
          next,
          change.kind === "profile-game-outbox-field"
            ? [change.field]
            : ["cleanupOwnerProfileIds", exactKey(change.profileId)],
          value,
        );
        profileProjectionUpdates.set(eventId, next);
        break;
      }
      case "telegram-outbox":
        telegramProjectionUpdates.set(exactKey(change.eventId), value);
        break;
      case "telegram-state":
      case "telegram-generation": {
        const eventId = exactKey(change.eventId);
        const update = telegramStateUpdates.get(eventId) || {};
        if (change.kind === "telegram-state") update.state = value;
        else
          update.generation = change.increment
            ? { increment: change.value }
            : change.value;
        telegramStateUpdates.set(eventId, update);
        break;
      }
    }
  }

  if (options.transition) {
    const transitionEventId = exactKey(options.transition.eventId);
    const transitionId = exactKey(options.transition.transitionId);
    if (!transitionEventId || !transitionId) {
      throw new EventD1Failure("invalid-event-transition");
    }
    const state = await getEventMutationState(
      db,
      eventStates,
      transitionEventId,
    );
    if (state.pendingTransitionId !== transitionId) {
      throw new EventD1Conflict("event-transition-not-owned");
    }
  }

  const guards: D1PreparedStatement[] = [];
  const mutations: D1PreparedStatement[] = [];
  const eventRevisions: Record<string, number> = {};
  const profilePrizeRevisions: Record<string, number> = {};

  guards.push(eventWriteAdmissionGuard(db, options.admission));
  if (options.eventLease) {
    guards.push(eventLeaseGuard(db, options.eventLease));
  }

  for (const [eventId, state] of eventStates) {
    if (
      state.pendingTransitionId &&
      (options.transition?.eventId !== eventId ||
        options.transition.transitionId !== state.pendingTransitionId)
    ) {
      throw new EventD1Conflict("event-transition-pending");
    }
    const expected =
      options.expectedEventRevisions?.[eventId] ?? state.revision;
    if (expected !== state.revision) throw new EventD1Conflict();
    guards.push(eventMutationGuard(db, eventId, state));
    const transitionApplies = options.transition?.eventId === eventId;
    if (transitionApplies) {
      guards.push(
        guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM event_transition_intents
             WHERE transition_id = ? AND event_id = ?
               AND expected_revision = ? AND status = 'pending'
           )`,
          [options.transition!.transitionId, eventId, expected],
        ),
      );
    }
    mutations.push(
      eventRecordStatement(
        db,
        eventId,
        state,
        transitionApplies ? null : state.pendingTransitionId,
      ),
    );
    if (state.selectionsChanged) {
      const originalSelections = state.originalSelections || {};
      const selections = state.selections || {};
      for (const profileId of Object.keys(originalSelections)) {
        if (!Object.hasOwn(selections, profileId)) {
          mutations.push(
            db
              .prepare(
                "DELETE FROM event_prize_selections WHERE event_id = ? AND profile_id = ?",
              )
              .bind(eventId, profileId),
          );
        }
      }
      for (const [profileId, prizeId] of Object.entries(selections)) {
        if (
          Object.hasOwn(originalSelections, profileId) &&
          originalSelections[profileId] === prizeId
        ) {
          continue;
        }
        mutations.push(
          db
            .prepare(
              `INSERT INTO event_prize_selections (
                 event_id, profile_id, prize_id, updated_at_ms
               ) VALUES (?, ?, ?, ?)
               ON CONFLICT (event_id, profile_id) DO UPDATE SET
                 prize_id = excluded.prize_id,
                 updated_at_ms = excluded.updated_at_ms`,
            )
            .bind(eventId, profileId, prizeId, nowMs),
        );
      }
    }
    eventRevisions[eventId] = state.revision + 1;
  }

  for (const [profileId, state] of profileStates) {
    const expected =
      options.expectedProfilePrizeRevisions?.[profileId] ?? state.revision;
    if (expected !== state.revision) throw new EventD1Conflict();
    guards.push(profileRevisionGuard(db, profileId, expected));
    for (const eventId of Object.keys(state.originalPrizes)) {
      if (!Object.hasOwn(state.prizes, eventId)) {
        mutations.push(
          db
            .prepare(
              "DELETE FROM profile_event_prizes WHERE profile_id = ? AND event_id = ?",
            )
            .bind(profileId, eventId),
        );
      }
    }
    for (const [eventId, assignment] of Object.entries(state.prizes)) {
      if (
        Object.hasOwn(state.originalPrizes, eventId) &&
        jsonValuesEqual(state.originalPrizes[eventId], assignment)
      ) {
        continue;
      }
      mutations.push(
        db
          .prepare(
            `INSERT INTO profile_event_prizes (
               profile_id, event_id, assignment_json, updated_at_ms
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT (profile_id, event_id) DO UPDATE SET
               assignment_json = excluded.assignment_json,
               updated_at_ms = excluded.updated_at_ms`,
          )
          .bind(profileId, eventId, encodeJson(assignment), nowMs),
      );
    }
    mutations.push(
      db
        .prepare(
          `INSERT INTO profile_event_prize_revisions (
             profile_id, revision, updated_at_ms
           ) VALUES (?, 1, ?)
           ON CONFLICT (profile_id) DO UPDATE SET
             revision = profile_event_prize_revisions.revision + 1,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(profileId, nowMs),
    );
    profilePrizeRevisions[profileId] = state.revision + 1;
  }

  for (const [outboxId, raw] of progressUpdates) {
    if (Object.hasOwn(options.expectedRecords?.progress || {}, outboxId)) {
      guards.push(
        recordJsonGuard(
          db,
          "event_progress_outboxes",
          outboxId,
          options.expectedRecords!.progress![outboxId],
          "pending",
        ),
      );
    }
    if (raw === null) {
      mutations.push(
        db
          .prepare(
            `DELETE FROM event_progress_outboxes
             WHERE outbox_id = ? AND status = 'pending'`,
          )
          .bind(outboxId),
      );
      continue;
    }
    const record = validateEventProgressOutbox(outboxId, raw);
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_progress_outboxes (
             outbox_id, event_id, status, run_at_ms, last_queued_at_ms,
             record_json
           ) VALUES (?, ?, 'pending', ?, ?, ?)
           ON CONFLICT (status, outbox_id) DO UPDATE SET
             event_id = excluded.event_id,
             status = 'pending',
             run_at_ms = excluded.run_at_ms,
             last_queued_at_ms = excluded.last_queued_at_ms,
             record_json = CASE
               WHEN json_extract(excluded.record_json, '$.reason') IN ('event-prize-announcement', 'sunday-mons-reminder')
               THEN json_set(excluded.record_json, '$.firstQueuedAtMs', MIN(
                 json_extract(event_progress_outboxes.record_json, '$.firstQueuedAtMs'),
                 json_extract(excluded.record_json, '$.firstQueuedAtMs')
               ))
               ELSE excluded.record_json
             END`,
        )
        .bind(
          outboxId,
          record.eventId,
          record.runAtMs,
          record.lastQueuedAtMs,
          encodeJson(record),
        ),
    );
  }

  for (const [outboxId, raw] of progressDeadUpdates) {
    if (Object.hasOwn(options.expectedRecords?.dead || {}, outboxId)) {
      guards.push(
        recordJsonGuard(
          db,
          "event_progress_outboxes",
          outboxId,
          options.expectedRecords!.dead![outboxId],
          "dead",
        ),
      );
    }
    if (raw === null) {
      mutations.push(
        db
          .prepare(
            "DELETE FROM event_progress_outboxes WHERE outbox_id = ? AND status = 'dead'",
          )
          .bind(outboxId),
      );
      continue;
    }
    if (!isRecord(raw) || !isJsonValue(raw)) {
      throw new EventD1Failure("invalid-event-progress-dead-letter");
    }
    const original = isRecord(raw.originalRecord) ? raw.originalRecord : null;
    const eventId = original ? exactKey(original.eventId) : "";
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_progress_outboxes (
             outbox_id, event_id, status, run_at_ms, last_queued_at_ms,
             record_json
           ) VALUES (?, (
             SELECT event_id FROM event_records WHERE event_id = ?
           ), 'dead', NULL, ?, ?)
           ON CONFLICT (status, outbox_id) DO UPDATE SET
             event_id = excluded.event_id,
             status = 'dead',
             run_at_ms = NULL,
             last_queued_at_ms = excluded.last_queued_at_ms,
             record_json = excluded.record_json`,
        )
        .bind(
          outboxId,
          eventId || null,
          safeInteger(raw.deadAtMs),
          encodeJson(raw),
        ),
    );
  }

  for (const [eventId, raw] of profileProjectionUpdates) {
    if (Object.hasOwn(options.expectedRecords?.profileGame || {}, eventId)) {
      guards.push(
        recordJsonGuard(
          db,
          "event_profile_game_projection_outboxes",
          eventId,
          options.expectedRecords!.profileGame![eventId],
        ),
      );
    }
    if (raw === null) {
      mutations.push(
        db
          .prepare(
            "DELETE FROM event_profile_game_projection_outboxes WHERE event_id = ?",
          )
          .bind(eventId),
      );
      continue;
    }
    const record = validateProjectionOutbox("profile-game", eventId, raw);
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_profile_game_projection_outboxes (
             event_id, request_id, status, last_queued_at_ms, record_json
           ) VALUES (?, ?, 'pending', ?, ?)
           ON CONFLICT (event_id) DO UPDATE SET
             request_id = excluded.request_id,
             status = 'pending',
             last_queued_at_ms = excluded.last_queued_at_ms,
             record_json = excluded.record_json`,
        )
        .bind(
          eventId,
          record.requestId,
          record.lastQueuedAtMs,
          encodeJson(record.raw),
        ),
    );
  }

  for (const [eventId, raw] of telegramProjectionUpdates) {
    if (Object.hasOwn(options.expectedRecords?.telegram || {}, eventId)) {
      guards.push(
        recordJsonGuard(
          db,
          "event_telegram_projection_outboxes",
          eventId,
          options.expectedRecords!.telegram![eventId],
        ),
      );
    }
    if (raw === null) {
      mutations.push(
        db
          .prepare(
            "DELETE FROM event_telegram_projection_outboxes WHERE event_id = ?",
          )
          .bind(eventId),
      );
      continue;
    }
    const record = validateProjectionOutbox("telegram", eventId, raw);
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_telegram_projection_outboxes (
             event_id, request_id, status, first_queued_at_ms, updated_at_ms,
             record_json
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (event_id) DO UPDATE SET
             request_id = excluded.request_id,
             status = excluded.status,
             first_queued_at_ms = excluded.first_queued_at_ms,
             updated_at_ms = excluded.updated_at_ms,
             record_json = excluded.record_json`,
        )
        .bind(
          eventId,
          record.requestId,
          record.status,
          record.firstQueuedAtMs,
          record.updatedAtMs,
          encodeJson(record.raw),
        ),
    );
  }

  for (const [eventId, update] of telegramStateUpdates) {
    const current = await readEventTelegramProjectionState(db, eventId);
    const currentRevision = current?.revision || 0;
    const expectedRevision =
      options.expectedTelegramStateRevisions?.[eventId] ?? currentRevision;
    if (expectedRevision !== currentRevision) throw new EventD1Conflict();
    guards.push(telegramStateRevisionGuard(db, eventId, expectedRevision));
    let generation = current?.generation || 0;
    let state = current?.state || {};
    if (update.generation !== undefined) {
      const increment = isRecord(update.generation)
        ? update.generation.increment
        : undefined;
      generation =
        increment === undefined
          ? safeInteger(update.generation)
          : generation + safeInteger(increment);
    }
    if (update.state !== undefined) {
      if (update.state === null) {
        mutations.push(
          db
            .prepare(
              "DELETE FROM event_telegram_projection_state WHERE event_id = ?",
            )
            .bind(eventId),
        );
        continue;
      }
      if (!isRecord(update.state) || !isJsonValue(update.state)) {
        throw new EventD1Failure("invalid-event-telegram-projection-state");
      }
      state = cloneJson(update.state);
    }
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_telegram_projection_state (
             event_id, generation, revision, state_json, updated_at_ms
           ) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT (event_id) DO UPDATE SET
             generation = excluded.generation,
             revision = event_telegram_projection_state.revision + 1,
             state_json = excluded.state_json,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(eventId, generation, encodeJson(state), nowMs),
    );
  }

  if (options.transition) {
    mutations.push(
      db
        .prepare(
          `DELETE FROM event_transition_intents
           WHERE transition_id = ? AND event_id = ? AND status = 'pending'`,
        )
        .bind(options.transition.transitionId, options.transition.eventId),
    );
  }
  if (mutations.length === 0) return { eventRevisions, profilePrizeRevisions };
  try {
    await db.batch([...guards, ...mutations]);
  } catch (error) {
    if (isConstraintFailure(error)) {
      throw new EventD1Conflict("event-d1-conflict", { cause: error });
    }
    throw error;
  }
  return { eventRevisions, profilePrizeRevisions };
}

export function commitEventMutations(
  db: EventD1Connection,
  changes: readonly EventMutation[],
  options: PublicEventMutationOptions,
): Promise<EventMutationResult> {
  return commitEventMutationsInternal(db, changes, options);
}
export async function readEventLease(
  db: EventD1Connection,
  eventId: string,
): Promise<EventLeaseRecord | null> {
  const row = await db
    .prepare(
      `SELECT lease_id, owner_uid, acquired_at_ms, refreshed_at_ms,
                expires_at_ms FROM event_leases WHERE event_id = ?`,
    )
    .bind(eventId)
    .first<{
      acquired_at_ms: number;
      expires_at_ms: number;
      lease_id: string;
      owner_uid: string;
      refreshed_at_ms: number;
    }>();
  return row
    ? {
        lockId: row.lease_id,
        ownerUid: row.owner_uid,
        acquiredAtMs: row.acquired_at_ms,
        refreshedAtMs: row.refreshed_at_ms,
        expiresAtMs: row.expires_at_ms,
      }
    : null;
}
export async function readEventSyncThrottle(
  db: EventD1Connection,
  eventId: string,
): Promise<EventSyncThrottleRecord | null> {
  const row = await db
    .prepare(
      `SELECT owner_uid, token, started_at_ms
         FROM event_sync_throttles WHERE event_id = ?`,
    )
    .bind(eventId)
    .first<{ owner_uid: string; started_at_ms: number; token: string }>();
  return row
    ? {
        ownerUid: row.owner_uid,
        token: row.token,
        startedAtMs: row.started_at_ms,
      }
    : null;
}
export type EventLeaseRecord = {
  lockId: string;
  ownerUid: string;
  acquiredAtMs: number;
  refreshedAtMs: number;
  expiresAtMs: number;
  ownerId?: string;
};
export type EventSyncThrottleRecord = {
  ownerUid: string;
  token: string;
  startedAtMs: number;
};
async function transactEventValue<T>(
  db: EventD1Connection,
  updater: (current: T | null) => TransactionDecision<T>,
  load: () => Promise<{
    value: T | null;
    mutation: (value: T | null) => EventMutation;
    options?: Partial<EventMutationOptions>;
  }>,
  options: {
    admission: EventWriteAdmission;
    eventLease?: EventLeaseGuard;
    signal?: AbortSignal;
    now?: () => number;
    allowStoredProfilePrizeAssignment?: boolean;
  },
): Promise<TransactionResult<T>> {
  for (let attempt = 0; attempt < MAX_EVENT_TRANSACTION_ATTEMPTS; attempt++) {
    options.signal?.throwIfAborted();
    const loaded = await load();
    options.signal?.throwIfAborted();
    const decision = updater(loaded.value);
    options.signal?.throwIfAborted();
    if ("commit" in decision)
      return {
        committed: false,
        decision: decision.decision,
        value: loaded.value,
      };
    try {
      await commitEventMutationsInternal(
        db,
        [loaded.mutation(decision.value)],
        { ...options, ...loaded.options },
      );
      return {
        committed: true,
        decision: decision.decision,
        value: decision.value,
      };
    } catch (error) {
      if (error instanceof EventD1Conflict) {
        options.signal?.throwIfAborted();
        continue;
      }
      throw error;
    }
  }
  throw new EventD1Conflict();
}
type EventTransactionOptions = {
  admission: EventWriteAdmission;
  eventLease?: EventLeaseGuard;
  signal?: AbortSignal;
  now?: () => number;
};
export function transactEventPrizeSelection(
  db: EventD1Connection,
  eventId: string,
  profileId: string,
  updater: (current: string | null) => TransactionDecision<string>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const result = await readStoredEventSnapshotIfChanged(db, eventId);
      if (result.notModified) throw new EventD1Failure();
      const snapshot = result.snapshot;
      return {
        value: snapshot.prizeSelections[profileId] ?? null,
        mutation: (value: string | null): EventMutation => ({
          kind: "prize-selection",
          eventId,
          profileId,
          value,
        }),
        options: {
          eventSnapshot: snapshot,
          expectedEventRevisions: { [eventId]: snapshot.revision },
        },
      };
    },
    options,
  );
}
function transactProfileEventPrizeInternal(
  db: EventD1Connection,
  profileId: string,
  eventId: string,
  updater: (
    current: EventPrizeAssignmentRecord | null,
  ) => TransactionDecision<EventPrizeAssignmentRecord>,
  options: EventTransactionOptions & {
    allowStoredProfilePrizeAssignment?: boolean;
  },
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const snapshot = await readProfilePrizeAssignmentSnapshot(
        db,
        profileId,
        eventId,
      );
      return {
        value: cloneJson(snapshot.assignment),
        mutation: (
          value: EventPrizeAssignmentRecord | null,
        ): EventMutation => ({
          kind: "profile-prize",
          eventId,
          profileId,
          value,
        }),
        options: {
          profilePrizeSnapshot: snapshot,
          expectedProfilePrizeRevisions: { [profileId]: snapshot.revision },
        },
      };
    },
    options,
  );
}
export function transactProfileEventPrize(
  db: EventD1Connection,
  profileId: string,
  eventId: string,
  updater: (
    current: EventPrizeAssignmentRecord | null,
  ) => TransactionDecision<EventPrizeAssignmentRecord>,
  options: EventTransactionOptions,
) {
  return transactProfileEventPrizeInternal(
    db,
    profileId,
    eventId,
    updater,
    options,
  );
}
export function transactStoredProfileEventPrize(
  db: EventD1Connection,
  profileId: string,
  eventId: string,
  updater: (
    current: EventPrizeAssignmentRecord | null,
  ) => TransactionDecision<EventPrizeAssignmentRecord>,
  options: EventTransactionOptions & { eventLease: EventLeaseGuard },
) {
  if (!options.eventLease || options.eventLease.eventId !== eventId)
    throw new EventD1Failure("invalid-event-lease");
  return transactProfileEventPrizeInternal(db, profileId, eventId, updater, {
    ...options,
    allowStoredProfilePrizeAssignment: true,
  });
}

export async function readEventProgressDeadOutbox(
  db: EventD1Connection,
  outboxId: string,
): Promise<EventOutboxRecord | null> {
  const row = await db
    .prepare(
      "SELECT record_json FROM event_progress_outboxes WHERE outbox_id = ? AND status = 'dead'",
    )
    .bind(outboxId)
    .first<{ record_json: string }>();
  return row ? (decodeJson(row.record_json) as EventOutboxRecord) : null;
}
export function transactEventProgressOutbox(
  db: EventD1Connection,
  outboxId: string,
  updater: (
    current: EventOutboxRecord | null,
  ) => TransactionDecision<EventOutboxRecord>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const value = await readEventProgressOutbox(db, outboxId);
      return {
        value,
        mutation: (value: EventOutboxRecord | null): EventMutation => ({
          kind: "progress-outbox",
          outboxId,
          value,
        }),
        options: { expectedRecords: { progress: { [outboxId]: value } } },
      };
    },
    options,
  );
}
export function transactEventProgressDeadOutbox(
  db: EventD1Connection,
  outboxId: string,
  updater: (
    current: EventOutboxRecord | null,
  ) => TransactionDecision<EventOutboxRecord>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const value = await readEventProgressDeadOutbox(db, outboxId);
      return {
        value,
        mutation: (value: EventOutboxRecord | null): EventMutation => ({
          kind: "progress-dead",
          outboxId,
          value,
        }),
        options: { expectedRecords: { dead: { [outboxId]: value } } },
      };
    },
    options,
  );
}
export function transactEventProfileGameProjectionOutbox(
  db: EventD1Connection,
  eventId: string,
  updater: (
    current: EventOutboxRecord | null,
  ) => TransactionDecision<EventOutboxRecord>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const value = await readEventProfileGameProjectionOutbox(db, eventId);
      return {
        value,
        mutation: (value: EventOutboxRecord | null): EventMutation => ({
          kind: "profile-game-outbox",
          eventId,
          value,
        }),
        options: { expectedRecords: { profileGame: { [eventId]: value } } },
      };
    },
    options,
  );
}
export function transactEventTelegramProjectionOutbox(
  db: EventD1Connection,
  eventId: string,
  updater: (
    current: EventOutboxRecord | null,
  ) => TransactionDecision<EventOutboxRecord>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const value = await readEventTelegramProjectionOutbox(db, eventId);
      return {
        value,
        mutation: (value: EventOutboxRecord | null): EventMutation => ({
          kind: "telegram-outbox",
          eventId,
          value,
        }),
        options: { expectedRecords: { telegram: { [eventId]: value } } },
      };
    },
    options,
  );
}
export function transactEventTelegramProjectionState(
  db: EventD1Connection,
  eventId: string,
  updater: (
    current: EventOutboxRecord | null,
  ) => TransactionDecision<EventOutboxRecord>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const current = await readEventTelegramProjectionState(db, eventId);
      return {
        value: current?.state || null,
        mutation: (value: EventOutboxRecord | null): EventMutation => ({
          kind: "telegram-state",
          eventId,
          value,
        }),
        options: {
          expectedTelegramStateRevisions: { [eventId]: current?.revision || 0 },
        },
      };
    },
    options,
  );
}
async function transactEventCoordination<
  T extends EventLeaseRecord | EventSyncThrottleRecord,
>(
  db: EventD1Connection,
  kind: "lease" | "throttle",
  eventId: string,
  updater: (current: T | null) => TransactionDecision<T>,
  options: { admission: EventWriteAdmission },
): Promise<TransactionResult<T>> {
  const runMutation = async (
    statement: D1PreparedStatement,
  ): Promise<D1Result> => {
    try {
      const results = await db.batch([
        eventWriteAdmissionGuard(db, options.admission),
        statement,
      ]);
      return results[1];
    } catch (error) {
      if (isConstraintFailure(error)) {
        throw new EventD1Conflict("event-d1-conflict", { cause: error });
      }
      throw error;
    }
  };
  eventId = exactKey(eventId);
  if (!eventId) throw new EventD1Failure("invalid-event-path");
  for (
    let attempt = 0;
    attempt < MAX_EVENT_TRANSACTION_ATTEMPTS;
    attempt += 1
  ) {
    const current = (await (kind === "lease"
      ? readEventLease(db, eventId)
      : readEventSyncThrottle(db, eventId))) as T | null;
    const decision = updater(current);
    if ("commit" in decision) {
      return {
        committed: false,
        decision: decision.decision,
        value: current,
      };
    }
    if (kind === "lease") {
      const currentRecord: Record<string, unknown> | null = isRecord(current)
        ? current
        : null;
      if (decision.value === null) {
        if (!currentRecord) {
          return { committed: true, decision: decision.decision, value: null };
        }
        const result = await runMutation(
          db
            .prepare(
              `DELETE FROM event_leases
             WHERE event_id = ? AND lease_id = ? AND owner_uid = ?
               AND expires_at_ms = ?`,
            )
            .bind(
              eventId,
              currentRecord.lockId,
              currentRecord.ownerUid,
              currentRecord.expiresAtMs,
            ),
        );
        if (result.meta.changes === 1) {
          return { committed: true, decision: decision.decision, value: null };
        }
        continue;
      }
      const next: Record<string, unknown> | null = isRecord(decision.value)
        ? decision.value
        : null;
      const lockId = next ? exactKey(next.lockId) : "";
      const ownerUid = next ? exactKey(next.ownerUid) : "";
      if (!next || !lockId || !ownerUid) {
        throw new EventD1Failure("invalid-event-lease");
      }
      const acquiredAtMs = safeInteger(next.acquiredAtMs);
      const refreshedAtMs = safeInteger(next.refreshedAtMs);
      const expiresAtMs = safeInteger(next.expiresAtMs, refreshedAtMs + 1);
      const statement = currentRecord
        ? db
            .prepare(
              `UPDATE event_leases SET
                 lease_id = ?, owner_uid = ?, acquired_at_ms = ?,
                 refreshed_at_ms = ?, expires_at_ms = ?
               WHERE event_id = ? AND lease_id = ? AND owner_uid = ?
                 AND expires_at_ms = ?`,
            )
            .bind(
              lockId,
              ownerUid,
              acquiredAtMs,
              refreshedAtMs,
              expiresAtMs,
              eventId,
              currentRecord.lockId,
              currentRecord.ownerUid,
              currentRecord.expiresAtMs,
            )
        : db
            .prepare(
              `INSERT INTO event_leases (
                 event_id, lease_id, owner_uid, acquired_at_ms,
                 refreshed_at_ms, expires_at_ms
               ) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (event_id) DO NOTHING`,
            )
            .bind(
              eventId,
              lockId,
              ownerUid,
              acquiredAtMs,
              refreshedAtMs,
              expiresAtMs,
            );
      const result = await runMutation(statement);
      if (result.meta.changes === 1) {
        return {
          committed: true,
          decision: decision.decision,
          value: cloneJson(next) as T,
        };
      }
      continue;
    }
    const currentRecord: Record<string, unknown> | null = isRecord(current)
      ? current
      : null;
    if (decision.value === null) {
      const result = currentRecord
        ? await runMutation(
            db
              .prepare(
                `DELETE FROM event_sync_throttles
               WHERE event_id = ? AND token = ? AND started_at_ms = ?`,
              )
              .bind(eventId, currentRecord.token, currentRecord.startedAtMs),
          )
        : null;
      if (!result || result.meta.changes === 1) {
        return { committed: true, decision: decision.decision, value: null };
      }
      continue;
    }
    const next: Record<string, unknown> | null = isRecord(decision.value)
      ? decision.value
      : null;
    const ownerUid = next ? exactKey(next.ownerUid) : "";
    const token = next ? exactKey(next.token) : "";
    if (!next || !ownerUid || !token) {
      throw new EventD1Failure("invalid-event-sync-throttle");
    }
    const startedAtMs = safeInteger(next.startedAtMs);
    const statement = currentRecord
      ? db
          .prepare(
            `UPDATE event_sync_throttles
             SET owner_uid = ?, token = ?, started_at_ms = ?
             WHERE event_id = ? AND token = ? AND started_at_ms = ?`,
          )
          .bind(
            ownerUid,
            token,
            startedAtMs,
            eventId,
            currentRecord.token,
            currentRecord.startedAtMs,
          )
      : db
          .prepare(
            `INSERT INTO event_sync_throttles (
               event_id, owner_uid, token, started_at_ms
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT (event_id) DO NOTHING`,
          )
          .bind(eventId, ownerUid, token, startedAtMs);
    const result = await runMutation(statement);
    if (result.meta.changes === 1) {
      return {
        committed: true,
        decision: decision.decision,
        value: cloneJson(next) as T,
      };
    }
  }
  throw new EventD1Conflict();
}

export function transactEventLease(
  db: EventD1Connection,
  key: string,
  updater: (
    current: EventLeaseRecord | null,
  ) => TransactionDecision<EventLeaseRecord>,
  options: { admission: EventWriteAdmission },
) {
  return transactEventCoordination(db, "lease", key, updater, options);
}
export function transactEventSyncThrottle(
  db: EventD1Connection,
  eventId: string,
  updater: (
    current: EventSyncThrottleRecord | null,
  ) => TransactionDecision<EventSyncThrottleRecord>,
  options: { admission: EventWriteAdmission },
) {
  return transactEventCoordination(db, "throttle", eventId, updater, options);
}
function validateTransitionIntent(
  value: EventTransitionIntent,
): EventTransitionIntent {
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    !exactKey(value.transitionId) ||
    !exactKey(value.eventId) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 1 ||
    !isRecord(value[STATE_EFFECTS_FIELD]) ||
    !isRecord(value.canonicalUpdates) ||
    !Number.isSafeInteger(value.createdAtMs) ||
    value.createdAtMs < 0 ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs ||
    !isJsonValue(value)
  ) {
    throw new EventD1Failure("invalid-event-transition");
  }
  if (
    value.schemaVersion === 2 &&
    (!Number.isSafeInteger(value.sourceEpoch) ||
      value.sourceEpoch < 1 ||
      typeof value.payloadDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.payloadDigest) ||
      !Array.isArray(value.inviteMutations) ||
      value.inviteMutations.length > 32 ||
      value.inviteMutations.some(
        (mutation) =>
          !isRecord(mutation) ||
          !isRecord(mutation.current) ||
          !exactKey(mutation.current.inviteId) ||
          !Number.isSafeInteger(mutation.current.revision) ||
          mutation.current.revision < 0 ||
          (mutation.current.value === null
            ? mutation.current.revision !== 0
            : !isRecord(mutation.current.value) ||
              mutation.current.revision < 1) ||
          !isRecord(mutation.value),
      ) ||
      new Set(value.inviteMutations.map(({ current }) => current.inviteId))
        .size !== value.inviteMutations.length)
  ) {
    throw new EventD1Failure("invalid-event-transition");
  }
  return cloneJson(value);
}

export async function createEventTransitionIntent(
  db: EventD1Connection,
  rawIntent: EventTransitionIntent,
  options: { admission: EventWriteAdmission },
): Promise<void> {
  const intent = validateTransitionIntent(rawIntent);
  const encoded = encodeJson(intent);
  try {
    await db.batch([
      eventWriteAdmissionGuard(db, options.admission),
      eventRevisionGuard(db, intent.eventId, intent.expectedRevision),
      guardStatement(
        db,
        `EXISTS (
           SELECT 1 FROM event_records
           WHERE event_id = ? AND pending_transition_id IS NOT NULL
             AND pending_transition_id != ?
         )`,
        [intent.eventId, intent.transitionId],
      ),
      db
        .prepare(
          `INSERT INTO event_transition_intents (
             transition_id, event_id, expected_revision, status, intent_json,
             attempts, last_error, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, 'pending', ?, 0, NULL, ?, ?)
           ON CONFLICT (transition_id) DO NOTHING`,
        )
        .bind(
          intent.transitionId,
          intent.eventId,
          intent.expectedRevision,
          encoded,
          intent.createdAtMs,
          intent.updatedAtMs,
        ),
      guardStatement(
        db,
        `NOT EXISTS (
           SELECT 1 FROM event_transition_intents
           WHERE transition_id = ? AND event_id = ?
             AND expected_revision = ? AND status = 'pending'
             AND intent_json = ?
         )`,
        [intent.transitionId, intent.eventId, intent.expectedRevision, encoded],
      ),
      db
        .prepare(
          `UPDATE event_records SET pending_transition_id = ?
           WHERE event_id = ? AND revision = ?`,
        )
        .bind(intent.transitionId, intent.eventId, intent.expectedRevision),
    ]);
  } catch (error) {
    if (isConstraintFailure(error)) {
      throw new EventD1Conflict("event-transition-conflict", { cause: error });
    }
    throw error;
  }
}

function parseTransitionRow(row: {
  intent_json: string;
}): EventTransitionIntent {
  return validateTransitionIntent(
    decodeJson(row.intent_json) as EventTransitionIntent,
  );
}

export async function readEventTransitionIntent(
  db: EventD1Connection,
  transitionId: string,
): Promise<EventTransitionIntent | null> {
  const row = await db
    .prepare(
      `SELECT intent_json FROM event_transition_intents
       WHERE transition_id = ? AND status = 'pending'`,
    )
    .bind(exactKey(transitionId))
    .first<{ intent_json: string }>();
  return row ? parseTransitionRow(row) : null;
}

export async function listPendingEventTransitionIntents(
  db: EventD1Connection,
  limit = 100,
): Promise<Array<EventTransitionIntent & { attempts: number }>> {
  safeInteger(limit, 1);
  const rows = await db
    .prepare(
      `SELECT intent_json, attempts FROM event_transition_intents
       WHERE status = 'pending'
       ORDER BY updated_at_ms, transition_id LIMIT ?`,
    )
    .bind(Math.min(limit, 100))
    .all<{ attempts: number; intent_json: string }>();
  return rows.results.map((row) => ({
    ...parseTransitionRow(row),
    attempts: safeInteger(row.attempts),
  }));
}

export async function recordEventTransitionAttempt(
  db: EventD1Connection,
  input: { error?: string | null; nowMs: number; transitionId: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE event_transition_intents
       SET attempts = attempts + 1, last_error = ?, updated_at_ms = ?
       WHERE transition_id = ? AND status = 'pending'`,
    )
    .bind(
      input.error?.slice(0, 1024) || null,
      safeInteger(input.nowMs),
      exactKey(input.transitionId),
    )
    .run();
  return result.meta.changes === 1;
}

function validateEventProgressOutbox(
  outboxId: string,
  value: unknown,
): EventOutboxRecord & {
  eventId: string;
  lastQueuedAtMs: number;
  runAtMs: number | null;
} {
  if (!exactKey(outboxId) || !isRecord(value) || !isJsonValue(value)) {
    throw new EventD1Failure("invalid-event-progress-outbox");
  }
  const eventId = exactKey(value.eventId);
  const runAtMs = nullableInteger(value.runAtMs);
  const lastQueuedAtMs = safeInteger(value.lastQueuedAtMs);
  if (!eventId || value.schemaVersion !== 1) {
    throw new EventD1Failure("invalid-event-progress-outbox");
  }
  return { ...cloneJson(value), eventId, runAtMs, lastQueuedAtMs };
}

export async function readEventProgressOutbox(
  db: EventD1Connection,
  outboxId: string,
): Promise<EventOutboxRecord | null> {
  const row = await db
    .prepare(
      `SELECT record_json FROM event_progress_outboxes
       WHERE outbox_id = ? AND status = 'pending'`,
    )
    .bind(exactKey(outboxId))
    .first<{ record_json: string }>();
  return row ? (decodeJson(row.record_json) as EventOutboxRecord) : null;
}

export async function listDueEventProgressOutboxes(
  db: EventD1Connection,
  beforeMs: number,
  limit = 100,
): Promise<Array<{ outboxId: string; record: EventOutboxRecord }>> {
  const rows = await db
    .prepare(
      `SELECT outbox_id, record_json FROM event_progress_outboxes
       WHERE status = 'pending' AND last_queued_at_ms <= ?
       ORDER BY last_queued_at_ms, outbox_id LIMIT ?`,
    )
    .bind(safeInteger(beforeMs), Math.min(safeInteger(limit, 1), 100))
    .all<{ outbox_id: string; record_json: string }>();
  return rows.results.map((row) => ({
    outboxId: row.outbox_id,
    record: decodeJson(row.record_json) as EventOutboxRecord,
  }));
}

function validateProjectionOutbox(
  kind: "profile-game" | "telegram",
  eventId: string,
  value: unknown,
): EventOutboxRecord & {
  raw: EventOutboxRecord;
  status: "dead" | "pending";
  firstQueuedAtMs?: number;
  lastQueuedAtMs?: number;
  requestId: string;
  updatedAtMs?: number;
} {
  if (!exactKey(eventId) || !isRecord(value) || !isJsonValue(value)) {
    throw new EventD1Failure("invalid-event-projection-outbox");
  }
  const raw = cloneJson(value);
  if (kind === "telegram" && value.status === "dead") {
    const deadAtMs = safeInteger(value.deadAtMs);
    return {
      raw,
      status: "dead",
      requestId: exactKey(value.requestId) || eventId,
      firstQueuedAtMs: deadAtMs,
      updatedAtMs: deadAtMs,
    };
  }
  const requestId = exactKey(value.requestId);
  if (!requestId || value.schemaVersion !== 1 || value.status !== "pending") {
    throw new EventD1Failure("invalid-event-projection-outbox");
  }
  if (kind === "profile-game") {
    return {
      raw,
      status: "pending",
      requestId,
      lastQueuedAtMs: safeInteger(value.lastQueuedAtMs),
    };
  }
  const updatedAtMs = safeInteger(value.updatedAtMs);
  return {
    raw,
    status: "pending",
    requestId,
    firstQueuedAtMs: safeInteger(value.firstQueuedAtMs ?? updatedAtMs),
    updatedAtMs,
  };
}

export async function readEventProfileGameProjectionOutbox(
  db: EventD1Connection,
  eventId: string,
): Promise<EventOutboxRecord | null> {
  return readProjectionOutbox(
    db,
    "event_profile_game_projection_outboxes",
    eventId,
  );
}

export async function readEventTelegramProjectionOutbox(
  db: EventD1Connection,
  eventId: string,
): Promise<EventOutboxRecord | null> {
  return readProjectionOutbox(
    db,
    "event_telegram_projection_outboxes",
    eventId,
  );
}

async function readProjectionOutbox(
  db: EventD1Connection,
  table:
    | "event_profile_game_projection_outboxes"
    | "event_telegram_projection_outboxes",
  eventId: string,
): Promise<EventOutboxRecord | null> {
  const row = await db
    .prepare(
      `SELECT record_json FROM ${table}
       WHERE event_id = ? AND status = 'pending'`,
    )
    .bind(exactKey(eventId))
    .first<{ record_json: string }>();
  return row ? (decodeJson(row.record_json) as EventOutboxRecord) : null;
}

export async function listDueEventProfileGameProjectionOutboxes(
  db: EventD1Connection,
  beforeMs: number,
  limit = 100,
): Promise<Array<{ eventId: string; record: EventOutboxRecord }>> {
  return listProjectionOutboxes(
    db,
    "event_profile_game_projection_outboxes",
    "last_queued_at_ms",
    beforeMs,
    limit,
  );
}

export async function listDueEventTelegramProjectionOutboxes(
  db: EventD1Connection,
  beforeMs: number,
  limit = 100,
): Promise<Array<{ eventId: string; record: EventOutboxRecord }>> {
  return listProjectionOutboxes(
    db,
    "event_telegram_projection_outboxes",
    "updated_at_ms",
    beforeMs,
    limit,
  );
}

async function listProjectionOutboxes(
  db: EventD1Connection,
  table:
    | "event_profile_game_projection_outboxes"
    | "event_telegram_projection_outboxes",
  timestampColumn: "last_queued_at_ms" | "updated_at_ms",
  beforeMs: number,
  limit: number,
): Promise<Array<{ eventId: string; record: EventOutboxRecord }>> {
  const rows = await db
    .prepare(
      `SELECT event_id, record_json FROM ${table}
       WHERE status = 'pending' AND ${timestampColumn} <= ?
       ORDER BY ${timestampColumn}, event_id LIMIT ?`,
    )
    .bind(safeInteger(beforeMs), Math.min(safeInteger(limit, 1), 100))
    .all<{ event_id: string; record_json: string }>();
  return rows.results.map((row) => ({
    eventId: row.event_id,
    record: decodeJson(row.record_json) as EventOutboxRecord,
  }));
}

export async function readEventTelegramProjectionState(
  db: EventD1Connection,
  eventId: string,
): Promise<{
  generation: number;
  revision: number;
  state: EventJsonRecord;
} | null> {
  const row = await db
    .prepare(
      `SELECT generation, revision, state_json
       FROM event_telegram_projection_state WHERE event_id = ?`,
    )
    .bind(exactKey(eventId))
    .first<{ generation: number; revision: number; state_json: string }>();
  if (!row) return null;
  const state = decodeJson(row.state_json);
  if (!isRecord(state)) throw new EventD1Failure();
  return {
    generation: safeInteger(row.generation),
    revision: safeInteger(row.revision, 1),
    state,
  };
}

export function transactEventRecord(
  db: EventD1Connection,
  eventId: string,
  updater: (
    current: EventJsonRecord | null,
  ) => TransactionDecision<EventJsonRecord>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const result = await readStoredEventSnapshotIfChanged(db, eventId);
      if (result.notModified) throw new EventD1Failure();
      const snapshot = result.snapshot;
      return {
        value: cloneJson(snapshot.event),
        mutation: (value: EventJsonRecord | null): EventMutation => ({
          kind: "event",
          eventId,
          value: value!,
        }),
        options: {
          eventSnapshot: snapshot,
          expectedEventRevisions: { [eventId]: snapshot.revision },
        },
      };
    },
    options,
  );
}
export function transactEventField<
  K extends import("../../../runtime/eventCommands.js").EventField,
>(
  db: EventD1Connection,
  eventId: string,
  field: K,
  updater: (
    current:
      import("../../../runtime/eventCommands.js").EventFieldValues[K] | null,
  ) => TransactionDecision<
    import("../../../runtime/eventCommands.js").EventFieldValues[K]
  >,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const result = await readStoredEventSnapshotIfChanged(db, eventId);
      if (result.notModified) throw new EventD1Failure();
      const snapshot = result.snapshot;
      return {
        value: cloneJson(snapshot.event?.[field] ?? null) as
          | import("../../../runtime/eventCommands.js").EventFieldValues[K]
          | null,
        mutation: (
          value:
            | import("../../../runtime/eventCommands.js").EventFieldValues[K]
            | null,
        ): EventMutation =>
          ({ kind: "event-field", eventId, field, value }) as EventMutation,
        options: {
          eventSnapshot: snapshot,
          expectedEventRevisions: { [eventId]: snapshot.revision },
        },
      };
    },
    options,
  );
}
export function transactEventPrizeSelections(
  db: EventD1Connection,
  eventId: string,
  updater: (
    current: Record<string, string> | null,
  ) => TransactionDecision<Record<string, string>>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const result = await readStoredEventSnapshotIfChanged(db, eventId);
      if (result.notModified) throw new EventD1Failure();
      const snapshot = result.snapshot;
      return {
        value: cloneJson(snapshot.prizeSelections),
        mutation: (value: Record<string, string> | null): EventMutation => ({
          kind: "prize-selections",
          eventId,
          value,
        }),
        options: {
          eventSnapshot: snapshot,
          expectedEventRevisions: { [eventId]: snapshot.revision },
        },
      };
    },
    options,
  );
}
export function transactEventTelegramProjectionGeneration(
  db: EventD1Connection,
  eventId: string,
  updater: (current: number | null) => TransactionDecision<number>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const current = await readEventTelegramProjectionState(db, eventId);
      return {
        value: current?.generation || 0,
        mutation: (value: number | null): EventMutation => ({
          kind: "telegram-generation",
          eventId,
          value: value!,
        }),
        options: {
          expectedTelegramStateRevisions: { [eventId]: current?.revision || 0 },
        },
      };
    },
    options,
  );
}
