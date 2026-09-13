import { readGameplayMatchPair } from "./gameplayMatchReads.ts";
import {
  buildHistoricalMatchPair,
  classifyTransitionHistoricalMatchPair,
  HISTORICAL_MATCH_ARCHIVE_VERSION,
  type HistoricalMatchDescriptor,
} from "./historicalMatches.ts";
import { createEventLockManagerCore } from "../../../runtime/events/lockManagerCore.js";
import {
  createGameplayRepository,
  createRatingRepository,
  type GameplayRepository,
  type RatingProfileGameProjectionRepository,
} from "./gameplayRepository.ts";
import { createEventGameplayRepository } from "./eventRepository.ts";
import type { EventStore } from "./eventStoreContracts.ts";
import type { EventOutboxReads } from "./eventOutboxReadRepository.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import {
  parseAutomatchProfileGameProjectionOutbox,
  parseEventProfileGameProjectionOutbox,
  salvageHistoricalMatchDescriptors,
  type AutomatchProfileGameProjectionOutbox,
} from "./profileGameProjectionOutbox.ts";
import {
  createEventProfileGameProjectionRuntime,
  createProfileGameProjectionRuntime,
  type EventProfileGameProjectionRuntime,
  type ProfileGameProjectionRuntime,
} from "./profileGameProjectionRepository.ts";
import {
  parseProfileGameProjectionTask,
  PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
  type AutomatchProfileGameProjectionTask,
  type EventProfileGameProjectionTask,
  type ProfileLinkProfileGameProjectionTask,
  type ProfileGameProjectionTask,
} from "./profileGameProjectionTasks.ts";
import {
  createProfileLinkProjectionRuntime,
  type ProfileLinkProjectionSummary,
} from "./profileLinkProfileGameProjection.ts";
import {
  createProfileGameProjectionLockStore,
  ProfileGameProjectionLockFailure,
  type ProfileGameProjectionLock,
  type ProfileGameProjectionLockStore,
} from "./profileGameProjectionLocksD1.ts";
import {
  createProfileLinkCatchupStore,
  type ProfileLinkCatchupStore,
} from "./profileLinkCatchupD1.ts";
import { PROFILE_BACKGROUND_SWEEP_LIMIT } from "./profileBackgroundLimits.ts";
import {
  claimAndEnqueueProjectionTasks,
  sendQueueTasks,
} from "./projectionSweep.ts";
import {
  infrastructureRetryDelaySeconds as profileGameProjectionRetryDelaySeconds,
  MAX_INFRASTRUCTURE_RETRY_DELAY_SECONDS as MAX_PROFILE_GAME_PROJECTION_RETRY_DELAY_SECONDS,
} from "./queueRetry.ts";

const PROFILE_GAME_PROJECTION_SWEEP_LIMIT = PROFILE_BACKGROUND_SWEEP_LIMIT;
const PROFILE_GAME_PROJECTION_SWEEP_CONCURRENCY = 10;
const PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS = 5 * 60 * 1_000;
const HISTORICAL_MATCH_ARCHIVE_BATCH_SIZE = 5;

async function archiveHistoricalDescriptor(
  descriptor: HistoricalMatchDescriptor,
  inviteId: string,
  state: ProfileGameProjectionState,
  runtime: ProfileGameProjectionRuntime,
): Promise<"archived" | "unready" | "unavailable"> {
  const alreadyArchived = runtime.hasHistoricalMatch
    ? await runtime.hasHistoricalMatch(inviteId, descriptor.matchId)
    : false;
  let hostMatch: unknown;
  let guestMatch: unknown;
  try {
    [hostMatch, guestMatch] = await readGameplayMatchPair(state, {
      inviteId,
      matchId: descriptor.matchId,
      playerId: descriptor.hostPlayerId,
      opponentId: descriptor.guestPlayerId,
    });
  } catch (error) {
    if (alreadyArchived) return "archived";
    throw error;
  }
  if (hostMatch == null && guestMatch == null && alreadyArchived)
    return "archived";
  const input = {
    matchId: descriptor.matchId,
    hostPlayerId: descriptor.hostPlayerId,
    guestPlayerId: descriptor.guestPlayerId,
    hostMatch,
    guestMatch,
  };
  const result =
    descriptor.source === "transition"
      ? classifyTransitionHistoricalMatchPair(input)
      : { status: "ready" as const, pair: buildHistoricalMatchPair(input) };
  if (result.status !== "ready") return result.status;
  const pair = result.pair;
  if (!pair) return "unavailable";
  if (!runtime.archiveHistoricalMatch) {
    throw new Error("historical-match-archive-unavailable");
  }
  await runtime.archiveHistoricalMatch({
    finalizedAtMs: descriptor.finalizedAtMs,
    inviteId,
    pair,
    source: descriptor.source,
  });
  return "archived";
}

async function settleHistoricalDescriptor(
  task: AutomatchProfileGameProjectionTask,
  descriptor: HistoricalMatchDescriptor,
  state: ProfileGameProjectionState,
  retryNotBeforeMs?: number,
): Promise<boolean> {
  const result = await state.transactAutomatchProfileOutbox(
    task.inviteId,
    (current) => {
      const record = toRecord(current);
      const outbox = parseAutomatchProfileGameProjectionOutbox(current);
      if (!record || !outbox || outbox.requestId !== task.requestId) {
        return { commit: false, decision: "superseded" };
      }
      const historicalMatches = {
        ...(toRecord(record.historicalMatches) || {}),
      };
      const stored = outbox.historicalMatches?.find(
        ({ matchId }) => matchId === descriptor.matchId,
      );
      if (
        !stored ||
        stored.finalizedAtMs !== descriptor.finalizedAtMs ||
        stored.hostPlayerId !== descriptor.hostPlayerId ||
        stored.guestPlayerId !== descriptor.guestPlayerId ||
        stored.source !== descriptor.source ||
        stored.retryNotBeforeMs !== descriptor.retryNotBeforeMs
      ) {
        return { commit: false, decision: "changed" };
      }
      if (retryNotBeforeMs === undefined)
        delete historicalMatches[descriptor.matchId];
      else
        historicalMatches[descriptor.matchId] = {
          ...toRecord(historicalMatches[descriptor.matchId]),
          retryNotBeforeMs,
        };
      const next = { ...record };
      if (Object.keys(historicalMatches).length > 0) {
        next.historicalMatches = historicalMatches;
      } else {
        delete next.historicalMatches;
      }
      return {
        value: next,
        decision: retryNotBeforeMs === undefined ? "settled" : "deferred",
      };
    },
  );
  return result.committed;
}

function archiveRetryIsPending(
  outbox: AutomatchProfileGameProjectionOutbox,
  nowMs: number,
): boolean {
  const retry = outbox.archiveRetry;
  const descriptors = outbox.historicalMatches || [];
  return Boolean(
    retry &&
    retry.requestId === outbox.requestId &&
    retry.notBeforeMs > nowMs &&
    descriptors.length > 0 &&
    descriptors.every(
      ({ retryNotBeforeMs }) =>
        retryNotBeforeMs !== undefined && retryNotBeforeMs >= retry.notBeforeMs,
    ),
  );
}

async function finishAutomatchProjectionBatch(
  task: AutomatchProfileGameProjectionTask,
  state: ProfileGameProjectionState,
  nowMs: number,
): Promise<"continued" | "deferred" | "projected" | "superseded"> {
  const result = await state.transactAutomatchProfileOutbox(
    task.inviteId,
    (current) => {
      const outbox = parseAutomatchProfileGameProjectionOutbox(current);
      if (!outbox || outbox.requestId !== task.requestId)
        return { commit: false, decision: "superseded" };
      const descriptors = outbox.historicalMatches || [];
      if (descriptors.length === 0)
        return { value: null, decision: "projected" };
      if (
        descriptors.some(
          ({ retryNotBeforeMs }) => (retryNotBeforeMs || 0) <= nowMs,
        )
      )
        return { commit: false, decision: "continued" };
      return {
        value: {
          ...toRecord(current),
          lastQueuedAtMs: nowMs,
          archiveRetry: {
            requestId: task.requestId,
            notBeforeMs: Math.min(
              ...descriptors.map(({ retryNotBeforeMs }) => retryNotBeforeMs!),
            ),
          },
        },
        decision: "deferred",
      };
    },
  );
  if (result.decision === "continued") return "continued";
  if (!result.committed) return "superseded";
  return result.decision === "deferred" ? "deferred" : "projected";
}

type ProfileGameProjectionLogger = Pick<Console, "error" | "info">;
type ProfileLinkProjectionResult = Pick<
  ProfileLinkProjectionSummary,
  "didHitInviteCap" | "nextMatchCursor"
>;
type ProfileGameProjectionState = Pick<
  GameplayRepository,
  | "readInviteMetadata"
  | "readAutomatchEntry"
  | "readMatchPair"
  | "readMatchRecord"
  | "readAutomatchProfileOutbox"
  | "transactAutomatchProfileOutbox"
  | "listDueAutomatchProfileOutboxes"
  | "listMalformedAutomatchProfileOutboxes"
>;

type EventProfileProjectionState = Pick<
  EventStore,
  | "readEventProfileGameProjectionOutbox"
  | "transactEventProfileGameProjectionOutbox"
  | "transactEventLease"
>;

type ProfileLinkProjectionJobs = Pick<
  ProfileLinkCatchupStore,
  "read" | "listDue" | "claimDispatch" | "advance" | "settle" | "settleMissing"
>;

export type ProfileGameProjectionDependencies = {
  forwardEventTasks?: boolean;
  createLocks?: (env: Env) => ProfileGameProjectionLockStore;
  createProfileLinkJobs?: (env: Env) => ProfileLinkProjectionJobs;
  createEventRuntime?: (env: Env) => EventProfileGameProjectionRuntime;
  createRating?: (env: Env) => RatingProfileGameProjectionRepository;
  createStateRepository?: (
    env: Env,
  ) => ProfileGameProjectionState &
    EventProfileProjectionState &
    Pick<EventOutboxReads, "listDueEventProfileGameProjectionOutboxes">;
  createRequestId?: () => string;
  createRuntime?: (env: Env) => ProfileGameProjectionRuntime;
  logger?: ProfileGameProjectionLogger;
  now?: () => number;
  processProfileLink?: (input: {
    cleanupProfileIds: string[];
    loginUid: string;
    matchCursor: string | null;
    profileId: string;
    sourceUpdatedAtMs: number;
    withInviteProjectionLock<T>(
      inviteId: string,
      work: () => Promise<T>,
    ): Promise<T>;
  }) => Promise<ProfileLinkProjectionResult | null>;
};

type AutomatchSweepCandidate = {
  lastQueuedAtMs: number;
  task: AutomatchProfileGameProjectionTask;
};

type AutomatchSweepEntry =
  | { kind: "candidate"; value: AutomatchSweepCandidate }
  | { inviteId: string; kind: "invalid" };

type EventSweepCandidate = {
  lastQueuedAtMs: number;
  task: EventProfileGameProjectionTask;
};

type EventSweepEntry =
  | { kind: "candidate"; value: EventSweepCandidate }
  | { eventId: string; kind: "invalid" };

export type ProfileGameProjectionSweepResult = {
  automatch: number;
  event: number;
  profile: number;
  rating: number;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validRatingProjectionRecord(
  operationId: string,
  update: Awaited<
    ReturnType<RatingProfileGameProjectionRepository["readRatingUpdate"]>
  >,
): update is NonNullable<typeof update> & { completedAtMs: number } {
  return Boolean(
    update &&
    update.profileGameProjectionVersion ===
      PROFILE_GAME_PROJECTION_SCHEMA_VERSION &&
    Number.isSafeInteger(update.completedAtMs) &&
    (update.completedAtMs || 0) > 0 &&
    isSafeRecordKey(update.inviteId) &&
    isSafeRecordKey(update.matchId) &&
    operationId === `${update.inviteId}__${update.matchId}`,
  );
}

export async function settleAutomatchProfileGameProjectionOutbox(
  task: AutomatchProfileGameProjectionTask,
  state: ProfileGameProjectionState,
): Promise<boolean> {
  const result = await state.transactAutomatchProfileOutbox(
    task.inviteId,
    (current) => {
      const outbox = parseAutomatchProfileGameProjectionOutbox(current);
      if (!outbox || outbox.requestId !== task.requestId) {
        return { commit: false, decision: "stale" };
      }
      return { value: null, decision: "cleared" };
    },
  );
  return result.committed;
}

export async function processAutomatchProfileGameProjection(
  task: AutomatchProfileGameProjectionTask,
  state: ProfileGameProjectionState,
  runtime: ProfileGameProjectionRuntime,
  locks: ProfileGameProjectionLockStore,
  ownerId: string = crypto.randomUUID(),
  now: () => number = Date.now,
  logger: ProfileGameProjectionLogger = console,
): Promise<"continued" | "deferred" | "projected" | "stale" | "superseded"> {
  const initialOutbox = parseAutomatchProfileGameProjectionOutbox(
    await state.readAutomatchProfileOutbox(task.inviteId),
  );
  if (!initialOutbox || initialOutbox.requestId !== task.requestId)
    return "stale";
  if (archiveRetryIsPending(initialOutbox, now())) return "deferred";
  const lock: ProfileGameProjectionLock = {
    scope: "invite",
    resourceId: task.inviteId,
    requestId: task.requestId,
  };
  await locks.acquire(lock, ownerId, now());
  try {
    const outbox = parseAutomatchProfileGameProjectionOutbox(
      await state.readAutomatchProfileOutbox(task.inviteId),
    );
    if (!outbox || outbox.requestId !== task.requestId) return "stale";
    if (archiveRetryIsPending(outbox, now())) return "deferred";
    await runtime.recomputeInviteProjection(task.inviteId, outbox.reason, {
      eventTimestampMs: outbox.sourceUpdatedAtMs,
    });
    const batchNowMs = now();
    const descriptors = (outbox.historicalMatches || [])
      .filter(({ retryNotBeforeMs }) => (retryNotBeforeMs || 0) <= batchNowMs)
      .slice(0, HISTORICAL_MATCH_ARCHIVE_BATCH_SIZE);
    let firstArchiveFailure: unknown;
    let archiveFailed = false;
    for (const descriptor of descriptors) {
      try {
        const status = await archiveHistoricalDescriptor(
          descriptor,
          task.inviteId,
          state,
          runtime,
        );
        const retryNotBeforeMs =
          status === "archived"
            ? undefined
            : now() + PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS;
        if (
          !(await settleHistoricalDescriptor(
            task,
            descriptor,
            state,
            retryNotBeforeMs,
          ))
        ) {
          return "superseded";
        }
        if (status !== "archived")
          logger.info(
            JSON.stringify({
              event: "historical_match_archive_descriptor_deferred",
              inviteId: task.inviteId,
              matchId: descriptor.matchId,
              requestId: task.requestId,
              reason: status,
              retryNotBeforeMs,
            }),
          );
      } catch (error) {
        logger.error(
          JSON.stringify({
            event: "historical_match_archive_descriptor_failed",
            inviteId: task.inviteId,
            matchId: descriptor.matchId,
            requestId: task.requestId,
            code: error instanceof Error ? error.message : "unknown",
          }),
        );
        if (!archiveFailed) {
          archiveFailed = true;
          firstArchiveFailure = error;
        }
      }
    }
    if (archiveFailed) throw firstArchiveFailure;
    return await finishAutomatchProjectionBatch(task, state, now());
  } finally {
    await locks.release(lock, ownerId);
  }
}

export async function settleEventProfileGameProjectionOutbox(
  task: EventProfileGameProjectionTask,
  state: EventProfileProjectionState,
): Promise<boolean> {
  const result = await state.transactEventProfileGameProjectionOutbox(
    task.eventId,
    (current) => {
      const outbox = parseEventProfileGameProjectionOutbox(current);
      if (!outbox || outbox.requestId !== task.requestId) {
        return { commit: false, decision: "stale" };
      }
      return { value: null, decision: "cleared" };
    },
  );
  return result.committed;
}

export async function processEventProfileGameProjection(
  task: EventProfileGameProjectionTask,
  state: EventProfileProjectionState,
  runtime: EventProfileGameProjectionRuntime,
  ownerId: string = crypto.randomUUID(),
  now: () => number = Date.now,
): Promise<"missing" | "projected" | "stale" | "superseded"> {
  const initialOutbox = parseEventProfileGameProjectionOutbox(
    await state.readEventProfileGameProjectionOutbox(task.eventId),
  );
  if (!initialOutbox || initialOutbox.requestId !== task.requestId) {
    return "stale";
  }
  const lockManager = createEventLockManagerCore({
    lockKind: "profile-game-projection",
    createLockId: () => crypto.randomUUID(),
    includeLegacyOwnerId: true,
    transactEventLease: state.transactEventLease,
    now,
  });
  const lock = await lockManager.acquireEventLock(task.eventId, ownerId);
  if (!lock) throw new Error("profile-game-projection-lock-busy");
  const stopHeartbeat = lockManager.startEventLockHeartbeat(lock);
  try {
    const outbox = parseEventProfileGameProjectionOutbox(
      await state.readEventProfileGameProjectionOutbox(task.eventId),
    );
    if (!outbox || outbox.requestId !== task.requestId) {
      return "stale";
    }
    const result = await runtime.reconcileEventProjection(
      task.eventId,
      outbox.cleanupOwnerProfileIds,
      {
        assertCanCommit: async () => {
          if (!(await lockManager.isEventLockStillOwned(lock))) {
            throw new Error("profile-game-projection-lock-lost");
          }
        },
      },
    );
    return (await settleEventProfileGameProjectionOutbox(task, state))
      ? result.status
      : "superseded";
  } finally {
    stopHeartbeat();
    await lockManager.releaseEventLock(lock);
  }
}

export async function processProfileLinkProfileGameProjection(
  task: ProfileLinkProfileGameProjectionTask,
  jobs: ProfileLinkProjectionJobs,
  process: (input: {
    cleanupProfileIds: string[];
    loginUid: string;
    matchCursor: string | null;
    profileId: string;
    sourceUpdatedAtMs: number;
    withInviteProjectionLock<T>(
      inviteId: string,
      work: () => Promise<T>,
    ): Promise<T>;
  }) => Promise<ProfileLinkProjectionResult | null>,
  locks: ProfileGameProjectionLockStore,
  ownerId: string = crypto.randomUUID(),
  now: () => number = Date.now,
): Promise<"continued" | "missing" | "projected" | "stale" | "superseded"> {
  const initialJob = await jobs.read(task.loginUid);
  if (!initialJob || initialJob.requestId !== task.requestId) {
    return "stale";
  }
  const lock: ProfileGameProjectionLock = {
    scope: "profile-link",
    resourceId: task.loginUid,
    requestId: task.requestId,
  };
  await locks.acquire(lock, ownerId, now());
  try {
    const job = await jobs.read(task.loginUid);
    if (!job || job.requestId !== task.requestId) {
      return "stale";
    }
    const projection = await process({
      cleanupProfileIds: job.cleanupProfileIds,
      loginUid: task.loginUid,
      matchCursor: job.matchCursor,
      profileId: job.profileId,
      sourceUpdatedAtMs: job.sourceUpdatedAtMs,
      withInviteProjectionLock: async (inviteId, work) => {
        const inviteOwnerId = crypto.randomUUID();
        const inviteLock: ProfileGameProjectionLock = {
          scope: "invite",
          resourceId: inviteId,
        };
        await locks.acquire(inviteLock, inviteOwnerId, now());
        try {
          return await work();
        } finally {
          await locks.release(inviteLock, inviteOwnerId);
        }
      },
    });
    if (!projection) {
      return (await jobs.settleMissing(
        task.loginUid,
        task.requestId,
        job.matchCursor,
      ))
        ? "missing"
        : "superseded";
    }
    if (projection.didHitInviteCap && !projection.nextMatchCursor) {
      throw new Error("profile-link-profile-game-projection-no-progress");
    }
    if (projection.nextMatchCursor) {
      const continued = await jobs.advance(
        task.loginUid,
        task.requestId,
        job.matchCursor,
        projection.nextMatchCursor,
        now(),
      );
      return continued ? "continued" : "superseded";
    }
    return (await jobs.settle(task.loginUid, task.requestId, job.matchCursor))
      ? "projected"
      : "superseded";
  } finally {
    await locks.release(lock, ownerId);
  }
}

function automatchSweepEntries(value: unknown): AutomatchSweepEntry[] {
  const records = toRecord(value) || {};
  return Object.entries(records).map(([inviteId, raw]) => {
    const outbox = parseAutomatchProfileGameProjectionOutbox(raw);
    return outbox && isSafeRecordKey(inviteId)
      ? {
          kind: "candidate",
          value: {
            lastQueuedAtMs: outbox.lastQueuedAtMs,
            task: {
              kind: "automatch-profile-game-projection",
              inviteId,
              requestId: outbox.requestId,
            },
          },
        }
      : { inviteId, kind: "invalid" };
  });
}

function eventSweepEntries(value: unknown): EventSweepEntry[] {
  const records = toRecord(value) || {};
  return Object.entries(records).map(([eventId, raw]) => {
    const outbox = parseEventProfileGameProjectionOutbox(raw);
    return outbox && isSafeRecordKey(eventId)
      ? {
          kind: "candidate",
          value: {
            lastQueuedAtMs: outbox.lastQueuedAtMs,
            task: {
              kind: "event-profile-game-projection",
              eventId,
              requestId: outbox.requestId,
            },
          },
        }
      : { eventId, kind: "invalid" };
  });
}

async function claimAutomatchSweepCandidate(
  state: ProfileGameProjectionState,
  candidate: AutomatchSweepCandidate,
  nowMs: number,
): Promise<boolean> {
  const result = await state.transactAutomatchProfileOutbox(
    candidate.task.inviteId,
    (current) => {
      const outbox = parseAutomatchProfileGameProjectionOutbox(current);
      if (
        !outbox ||
        outbox.requestId !== candidate.task.requestId ||
        outbox.lastQueuedAtMs !== candidate.lastQueuedAtMs ||
        outbox.lastQueuedAtMs > nowMs
      ) {
        return { commit: false, decision: "not-due" };
      }
      return {
        value: { ...toRecord(current), lastQueuedAtMs: nowMs },
        decision: "claimed",
      };
    },
  );
  return result.committed;
}

async function claimEventSweepCandidate(
  state: EventProfileProjectionState,
  candidate: EventSweepCandidate,
  nowMs: number,
): Promise<boolean> {
  const result = await state.transactEventProfileGameProjectionOutbox(
    candidate.task.eventId,
    (current) => {
      const outbox = parseEventProfileGameProjectionOutbox(current);
      if (
        !outbox ||
        outbox.requestId !== candidate.task.requestId ||
        outbox.lastQueuedAtMs !== candidate.lastQueuedAtMs ||
        outbox.lastQueuedAtMs > nowMs
      ) {
        return { commit: false, decision: "not-due" };
      }
      return {
        value: { ...toRecord(current), lastQueuedAtMs: nowMs },
        decision: "claimed",
      };
    },
  );
  return result.committed;
}

type InvalidEventSweepResult =
  | { kind: "changed" }
  | { kind: "removed" }
  | { kind: "repaired"; task: EventProfileGameProjectionTask };

function salvageEventCleanupOwnerProfileIds(value: unknown): string[] {
  return Array.from(
    new Set(
      Object.entries(
        toRecord(toRecord(value)?.cleanupOwnerProfileIds) || {},
      ).flatMap(([profileId, included]) =>
        included === true && isSafeRecordKey(profileId) ? [profileId] : [],
      ),
    ),
  );
}

async function repairInvalidEventSweepEntry(
  state: EventProfileProjectionState,
  eventId: string,
  nowMs: number,
  createRequestId: () => string,
): Promise<InvalidEventSweepResult> {
  const safeEventId = isSafeRecordKey(eventId);
  const requestId = safeEventId ? createRequestId() : "";
  const result = await state.transactEventProfileGameProjectionOutbox(
    eventId,
    (current) => {
      if (
        current === null ||
        current === undefined ||
        (parseEventProfileGameProjectionOutbox(current) &&
          isSafeRecordKey(eventId))
      ) {
        return { commit: false, decision: "changed" };
      }
      if (!safeEventId) {
        return { value: null, decision: "removed-invalid" };
      }
      const cleanupOwnerProfileIds =
        salvageEventCleanupOwnerProfileIds(current);
      return {
        value: {
          schemaVersion: PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
          status: "pending",
          requestId,
          lastQueuedAtMs: nowMs,
          cleanupOwnerProfileIds: Object.fromEntries(
            cleanupOwnerProfileIds.map((profileId) => [profileId, true]),
          ),
        },
        decision: "repaired-invalid",
      };
    },
  );
  if (!result.committed) {
    return { kind: "changed" };
  }
  return safeEventId
    ? {
        kind: "repaired",
        task: {
          kind: "event-profile-game-projection",
          eventId,
          requestId,
        },
      }
    : { kind: "removed" };
}

type InvalidAutomatchSweepResult =
  | { kind: "changed" }
  | { kind: "removed" }
  | { kind: "repaired"; task: AutomatchProfileGameProjectionTask };

async function repairInvalidAutomatchSweepEntry(
  state: ProfileGameProjectionState,
  inviteId: string,
  nowMs: number,
  createRequestId: () => string,
): Promise<InvalidAutomatchSweepResult> {
  const safeInviteId = isSafeRecordKey(inviteId);
  const requestId = safeInviteId ? createRequestId() : "";
  const result = await state.transactAutomatchProfileOutbox(
    inviteId,
    (current) => {
      const record = toRecord(current);
      if (
        current === null ||
        current === undefined ||
        (record &&
          parseAutomatchProfileGameProjectionOutbox(current) &&
          isSafeRecordKey(inviteId))
      ) {
        return { commit: false, decision: "changed" };
      }
      if (!safeInviteId) {
        return { value: null, decision: "removed-invalid" };
      }
      const sourceUpdatedAtMs = record?.sourceUpdatedAtMs;
      const historicalMatches = salvageHistoricalMatchDescriptors(current);
      return {
        value: {
          schemaVersion: PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
          status: "pending",
          requestId,
          reason:
            typeof record?.reason === "string" && record.reason.trim()
              ? record.reason.trim()
              : "automatch-queue",
          sourceUpdatedAtMs:
            typeof sourceUpdatedAtMs === "number" &&
            Number.isFinite(sourceUpdatedAtMs) &&
            sourceUpdatedAtMs >= 0
              ? Math.floor(sourceUpdatedAtMs)
              : nowMs,
          lastQueuedAtMs: nowMs,
          ...(historicalMatches.length > 0
            ? {
                historicalMatches: Object.fromEntries(
                  historicalMatches.map((descriptor) => [
                    descriptor.matchId,
                    {
                      finalizedAtMs: descriptor.finalizedAtMs,
                      guestPlayerId: descriptor.guestPlayerId,
                      hostPlayerId: descriptor.hostPlayerId,
                      source: descriptor.source,
                      ...(descriptor.retryNotBeforeMs === undefined
                        ? {}
                        : { retryNotBeforeMs: descriptor.retryNotBeforeMs }),
                    },
                  ]),
                ),
              }
            : {}),
        },
        decision: "repaired-invalid",
      };
    },
  );
  if (!result.committed) {
    return { kind: "changed" };
  }
  return safeInviteId
    ? {
        kind: "repaired",
        task: {
          kind: "automatch-profile-game-projection",
          inviteId,
          requestId,
        },
      }
    : { kind: "removed" };
}

export async function processRatingProfileGameProjection(
  operationId: string,
  rating: RatingProfileGameProjectionRepository,
  runtime: ProfileGameProjectionRuntime,
  now: () => number,
  locks: ProfileGameProjectionLockStore,
  ownerId: string = crypto.randomUUID(),
): Promise<"dead" | "done" | "stale"> {
  const update = await rating.readRatingUpdate(operationId);
  if (!update || update.profileGameProjectionState !== "pending") {
    return "stale";
  }
  if (!validRatingProjectionRecord(operationId, update)) {
    await rating.markRatingProfileGameProjection(
      operationId,
      "dead",
      now(),
      "invalid-record",
    );
    return "dead";
  }
  if (
    update.historicalMatchArchiveVersion !== undefined &&
    update.historicalMatchArchiveVersion !== HISTORICAL_MATCH_ARCHIVE_VERSION
  ) {
    throw new Error("historical-match-archive-version-unsupported");
  }
  if (
    update.historicalMatchArchiveVersion === HISTORICAL_MATCH_ARCHIVE_VERSION &&
    !update.historicalMatchPair
  ) {
    throw new Error("historical-match-pair-missing");
  }
  const lock: ProfileGameProjectionLock = {
    scope: "invite",
    resourceId: update.inviteId,
  };
  await locks.acquire(lock, ownerId, now());
  try {
    if (update.status !== "done") {
      throw new Error("profile-game-projection-rating-pending");
    }
    await runtime.recomputeInviteProjection(
      update.inviteId,
      "invite-match-rating-updated",
      {
        eventTimestampMs: update.completedAtMs,
        latestMatchIdHint: update.matchId,
      },
    );
    if (update.historicalMatchPair) {
      if (!runtime.archiveHistoricalMatch) {
        throw new Error("historical-match-archive-unavailable");
      }
      await runtime.archiveHistoricalMatch({
        finalizedAtMs: update.completedAtMs,
        inviteId: update.inviteId,
        pair: update.historicalMatchPair,
        source: "rating",
      });
    }
  } finally {
    await locks.release(lock, ownerId);
  }
  await rating.markRatingProfileGameProjection(operationId, "done", now());
  return "done";
}

export async function handleProfileGameProjectionMessage(
  message: Message<unknown>,
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<void> {
  const logger = dependencies.logger || console;
  const task = parseProfileGameProjectionTask(message.body);
  if (!task) {
    message.ack();
    logger.error(
      JSON.stringify({
        event: "profile_game_projection_queue_invalid_message",
      }),
    );
    return;
  }
  const now = dependencies.now || Date.now;
  const taskContext = {
    kind: task.kind,
    ...("eventId" in task ? { eventId: task.eventId } : {}),
    ...("inviteId" in task ? { inviteId: task.inviteId } : {}),
    ...("requestId" in task ? { requestId: task.requestId } : {}),
    ...("operationId" in task ? { operationId: task.operationId } : {}),
  };
  try {
    if (
      task.kind === "event-profile-game-projection" &&
      dependencies.forwardEventTasks
    ) {
      await env.EVENT_PROFILE_GAME_PROJECTION_QUEUE.send(task);
      message.ack();
      logger.info(
        JSON.stringify({
          event: "profile_game_projection_queue_processed",
          ...taskContext,
          status: "forwarded",
        }),
      );
      return;
    }
    const ownerId = crypto.randomUUID();
    const state = (
      dependencies.createStateRepository ||
      ((workerEnv: Env) => createEventGameplayRepository(workerEnv))
    )(env);
    const runtime = (
      dependencies.createRuntime || createProfileGameProjectionRuntime
    )(env);
    const locks = (
      dependencies.createLocks ||
      ((workerEnv: Env) =>
        createProfileGameProjectionLockStore(workerEnv.PROFILE_GAMES_DB))
    )(env);
    let status: string;
    if (task.kind === "automatch-profile-game-projection") {
      status = await processAutomatchProfileGameProjection(
        task,
        state,
        runtime,
        locks,
        ownerId,
        now,
        logger,
      );
      if (status === "continued") {
        await env.PROFILE_GAME_PROJECTION_QUEUE.send(task);
      }
    } else if (task.kind === "profile-link-profile-game-projection") {
      status = await processProfileLinkProfileGameProjection(
        task,
        (
          dependencies.createProfileLinkJobs ||
          ((workerEnv: Env) =>
            createProfileLinkCatchupStore(workerEnv.PROFILE_DB))
        )(env),
        async (input) => {
          if (dependencies.processProfileLink) {
            return dependencies.processProfileLink(input);
          }
          const linkLogger = {
            error(event: string, context?: unknown) {
              logger.error(JSON.stringify({ event, context }));
            },
            info(event: string, context?: unknown) {
              logger.info(JSON.stringify({ event, context }));
            },
          };
          return createProfileLinkProjectionRuntime(env, {
            logger: linkLogger,
            now,
            projection: runtime,
            state,
            withInviteProjectionLock: input.withInviteProjectionLock,
          }).process(input);
        },
        locks,
        ownerId,
        now,
      );
      if (status === "continued") {
        await env.PROFILE_GAME_PROJECTION_QUEUE.send(task);
      }
    } else if (task.kind === "event-profile-game-projection") {
      status = await processEventProfileGameProjection(
        task,
        state,
        (
          dependencies.createEventRuntime ||
          createEventProfileGameProjectionRuntime
        )(env),
        ownerId,
        now,
      );
    } else {
      status = await processRatingProfileGameProjection(
        task.operationId,
        (
          dependencies.createRating ||
          ((workerEnv: Env) =>
            createRatingRepository(
              workerEnv,
              createGameplayRepository(workerEnv),
            ))
        )(env),
        runtime,
        now,
        locks,
        ownerId,
      );
    }
    message.ack();
    logger.info(
      JSON.stringify({
        event: "profile_game_projection_queue_processed",
        ...taskContext,
        status,
      }),
    );
  } catch (error) {
    message.retry({
      delaySeconds: profileGameProjectionRetryDelaySeconds(message.attempts),
    });
    logger.error(
      JSON.stringify({
        event: "profile_game_projection_queue_failed",
        ...taskContext,
        status: "retrying",
        ...(error instanceof ProfileGameProjectionLockFailure
          ? { lockScope: error.scope }
          : {}),
        code: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
}

async function handleProjectionQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  forwardEventTasks: boolean,
): Promise<void> {
  const state = createEventGameplayRepository(env);
  const rating = createRatingRepository(env, state);
  const runtime = createProfileGameProjectionRuntime(env, { state });
  const eventRuntime = createEventProfileGameProjectionRuntime(env, { state });
  const locks = createProfileGameProjectionLockStore(env.PROFILE_GAMES_DB);
  for (const message of batch.messages) {
    if (
      !forwardEventTasks &&
      parseProfileGameProjectionTask(message.body)?.kind !==
        "event-profile-game-projection"
    ) {
      message.ack();
      console.error(
        JSON.stringify({
          event: "event_profile_game_projection_queue_invalid_message",
        }),
      );
      continue;
    }
    await handleProfileGameProjectionMessage(message, env, {
      forwardEventTasks,
      createLocks: () => locks,
      createEventRuntime: () => eventRuntime,
      createRating: () => rating,
      createStateRepository: () => state,
      createRuntime: () => runtime,
    });
  }
}

export async function handleProfileGameProjectionQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  await handleProjectionQueue(batch, env, true);
}

export async function handleEventProfileGameProjectionQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  await handleProjectionQueue(batch, env, false);
}

async function sendProfileGameProjectionTasks(
  queue: Queue<ProfileGameProjectionTask>,
  tasks: ProfileGameProjectionTask[],
): Promise<void> {
  return sendQueueTasks(queue, tasks);
}

async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (index < items.length) {
        const current = index++;
        await worker(items[current]);
      }
    },
  );
  await Promise.all(runners);
}

export async function sweepRatingProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<number> {
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const rating = (
    dependencies.createRating ||
    ((workerEnv: Env) =>
      createRatingRepository(workerEnv, createGameplayRepository(workerEnv)))
  )(env);
  const nowMs = now();
  const records = await rating.listDueRatingProfileGameProjections(
    nowMs,
    PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
  );
  const tasks: ProfileGameProjectionTask[] = [];
  let firstFailure: unknown;
  await forEachConcurrent(
    records,
    PROFILE_GAME_PROJECTION_SWEEP_CONCURRENCY,
    async (record) => {
      try {
        const claimed = await rating.claimRatingProfileGameProjection(
          record.operationId,
          record.updateTime,
          nowMs,
        );
        if (!claimed) {
          return;
        }
        if (
          record.version !== PROFILE_GAME_PROJECTION_SCHEMA_VERSION ||
          !isSafeRecordKey(record.inviteId) ||
          !isSafeRecordKey(record.matchId) ||
          record.operationId !== `${record.inviteId}__${record.matchId}`
        ) {
          await rating.markRatingProfileGameProjection(
            record.operationId,
            "dead",
            now(),
            "invalid-recovery-marker",
          );
          return;
        }
        tasks.push({
          kind: "rating-profile-game-projection",
          operationId: record.operationId,
        });
      } catch (error) {
        firstFailure ||= error;
        logger.error(
          JSON.stringify({
            event: "profile_game_projection_recovery_record_failed",
            operationId: record.operationId,
          }),
        );
      }
    },
  );
  await sendProfileGameProjectionTasks(
    env.PROFILE_GAME_PROJECTION_QUEUE,
    tasks,
  );
  if (firstFailure) {
    throw firstFailure;
  }
  return tasks.length;
}

export async function sweepAutomatchProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<number> {
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const createRequestId =
    dependencies.createRequestId || (() => crypto.randomUUID());
  const nowMs = now();
  const dueBeforeMs = nowMs - PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS;
  const state = (
    dependencies.createStateRepository ||
    ((workerEnv: Env) => createGameplayRepository(workerEnv))
  )(env);
  const [dueValue, malformedValue] = await Promise.all([
    state.listDueAutomatchProfileOutboxes(
      dueBeforeMs,
      PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
    ),
    state.listMalformedAutomatchProfileOutboxes(
      PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
    ),
  ]);
  const entries = [
    ...automatchSweepEntries(dueValue),
    ...automatchSweepEntries(malformedValue),
  ];
  const invalidInviteIds = entries.flatMap((entry) =>
    entry.kind === "invalid" ? [entry.inviteId] : [],
  );
  let invalidFailure: Error | null = null;
  const repairedTasks: AutomatchProfileGameProjectionTask[] = [];
  let invalidRemoved = 0;
  for (const inviteId of invalidInviteIds) {
    try {
      const result = await repairInvalidAutomatchSweepEntry(
        state,
        inviteId,
        nowMs,
        createRequestId,
      );
      if (result.kind === "repaired") {
        repairedTasks.push(result.task);
      } else if (result.kind === "removed") {
        invalidRemoved++;
      }
    } catch (error) {
      invalidFailure ||=
        error instanceof Error
          ? error
          : new Error("profile-game-projection-invalid-record-failed");
    }
  }
  if (repairedTasks.length > 0 || invalidRemoved > 0) {
    logger.error(
      JSON.stringify({
        event: "profile_game_projection_invalid_outboxes_recovered",
        repaired: repairedTasks.length,
        removed: invalidRemoved,
      }),
    );
  }
  const candidates = entries.flatMap((entry) =>
    entry.kind === "candidate" ? [entry.value] : [],
  );
  const { sentCount, claimFailure } = await claimAndEnqueueProjectionTasks({
    candidates,
    claim: (candidate) => claimAutomatchSweepCandidate(state, candidate, nowMs),
    toTask: ({ task }) => task,
    queue: env.PROFILE_GAME_PROJECTION_QUEUE,
    initialTasks: repairedTasks,
    fallbackErrorMessage: "profile-game-projection-claim-failed",
  });
  if (claimFailure) {
    throw claimFailure;
  }
  if (invalidFailure) {
    throw invalidFailure;
  }
  return sentCount;
}

export async function sweepEventProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<number> {
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const createRequestId =
    dependencies.createRequestId || (() => crypto.randomUUID());
  const nowMs = now();
  const dueBeforeMs = nowMs - PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS;
  const state = (
    dependencies.createStateRepository ||
    ((workerEnv: Env) => createEventGameplayRepository(workerEnv))
  )(env);
  const records = await state.listDueEventProfileGameProjectionOutboxes(
    dueBeforeMs,
    PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
  );
  const entries = eventSweepEntries(
    Object.fromEntries(records.map(({ eventId, record }) => [eventId, record])),
  );
  const invalidEventIds = Array.from(
    new Set(
      entries.flatMap((entry) =>
        entry.kind === "invalid" ? [entry.eventId] : [],
      ),
    ),
  );
  const failures: Error[] = [];
  const repairedTasks: EventProfileGameProjectionTask[] = [];
  let invalidRemoved = 0;
  for (const eventId of invalidEventIds) {
    try {
      const result = await repairInvalidEventSweepEntry(
        state,
        eventId,
        nowMs,
        createRequestId,
      );
      if (result.kind === "repaired") {
        repairedTasks.push(result.task);
      } else if (result.kind === "removed") {
        invalidRemoved += 1;
      }
    } catch (error) {
      failures.push(
        error instanceof Error
          ? error
          : new Error("event-profile-game-invalid-record-failed"),
      );
    }
  }
  if (repairedTasks.length > 0 || invalidRemoved > 0) {
    logger.error(
      JSON.stringify({
        event: "event_profile_game_projection_invalid_outboxes_recovered",
        repaired: repairedTasks.length,
        removed: invalidRemoved,
      }),
    );
  }
  const candidateByEventId = new Map<string, EventSweepCandidate>();
  for (const entry of entries) {
    if (entry.kind === "candidate") {
      candidateByEventId.set(entry.value.task.eventId, entry.value);
    }
  }
  const { sentCount, claimFailure } = await claimAndEnqueueProjectionTasks({
    candidates: Array.from(candidateByEventId.values()),
    claim: (candidate) => claimEventSweepCandidate(state, candidate, nowMs),
    toTask: ({ task }) => task,
    queue: env.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
    initialTasks: repairedTasks,
    fallbackErrorMessage: "profile-game-projection-claim-failed",
  });
  if (claimFailure) {
    failures.push(claimFailure);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "event-profile-game-projection-sweep-failed",
    );
  }
  return sentCount;
}

export async function sweepProfileLinkProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<number> {
  const nowMs = (dependencies.now || Date.now)();
  const jobs = (
    dependencies.createProfileLinkJobs ||
    ((workerEnv: Env) => createProfileLinkCatchupStore(workerEnv.PROFILE_DB))
  )(env);
  const candidates = await jobs.listDue(
    nowMs - PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS,
    PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
  );
  const { sentCount, claimFailure } = await claimAndEnqueueProjectionTasks({
    candidates,
    claim: (job) =>
      jobs.claimDispatch(
        job.loginUid,
        job.requestId,
        job.lastQueuedAtMs,
        nowMs,
      ),
    toTask: ({ loginUid, requestId }): ProfileGameProjectionTask => ({
      kind: "profile-link-profile-game-projection",
      loginUid,
      requestId,
    }),
    queue: env.PROFILE_GAME_PROJECTION_QUEUE,
    fallbackErrorMessage: "profile-game-projection-claim-failed",
  });
  if (claimFailure) throw claimFailure;
  return sentCount;
}

export async function sweepProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<ProfileGameProjectionSweepResult> {
  const locks = (
    dependencies.createLocks ||
    ((workerEnv: Env) =>
      createProfileGameProjectionLockStore(workerEnv.PROFILE_GAMES_DB))
  )(env);
  const [automatch, event, profile, rating, cleanup] = await Promise.allSettled(
    [
      sweepAutomatchProfileGameProjections(env, dependencies),
      sweepEventProfileGameProjections(env, dependencies),
      sweepProfileLinkProfileGameProjections(env, dependencies),
      sweepRatingProfileGameProjections(env, dependencies),
      locks.deleteExpired((dependencies.now || Date.now)()),
    ],
  );
  if (cleanup.status === "rejected") {
    (dependencies.logger || console).error(
      JSON.stringify({
        event: "profile_game_projection_lock_cleanup_failed",
        lockScope: "cleanup",
        code:
          cleanup.reason instanceof Error ? cleanup.reason.message : "unknown",
      }),
    );
  }
  const failures = [automatch, event, profile, rating, cleanup].flatMap(
    (result) => (result.status === "rejected" ? [result.reason] : []),
  );
  if (
    failures.length > 0 ||
    automatch.status === "rejected" ||
    event.status === "rejected" ||
    profile.status === "rejected" ||
    rating.status === "rejected"
  ) {
    throw new AggregateError(failures, "profile-game-projection-sweep-failed");
  }
  return {
    automatch: automatch.value,
    event: event.value,
    profile: profile.value,
    rating: rating.value,
  };
}

export async function handleProfileGameProjectionSweep(
  _controller: ScheduledController,
  env: Env,
): Promise<void> {
  const enqueued = await sweepProfileGameProjections(env);
  console.info(
    JSON.stringify({
      event: "profile_game_projection_sweep_completed",
      enqueued:
        enqueued.automatch +
        enqueued.event +
        enqueued.profile +
        enqueued.rating,
      automatchEnqueued: enqueued.automatch,
      eventEnqueued: enqueued.event,
      profileEnqueued: enqueued.profile,
      ratingEnqueued: enqueued.rating,
    }),
  );
}

export {
  MAX_PROFILE_GAME_PROJECTION_RETRY_DELAY_SECONDS,
  PROFILE_GAME_PROJECTION_SWEEP_CONCURRENCY,
  PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS,
  PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
  automatchSweepEntries,
  claimAutomatchSweepCandidate,
  claimEventSweepCandidate,
  eventSweepEntries,
  profileGameProjectionRetryDelaySeconds,
  repairInvalidEventSweepEntry,
  salvageEventCleanupOwnerProfileIds,
  repairInvalidAutomatchSweepEntry,
  sendProfileGameProjectionTasks,
  validRatingProjectionRecord,
};
