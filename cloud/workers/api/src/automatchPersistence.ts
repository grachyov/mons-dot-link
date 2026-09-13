import { AuthApiFailure } from "./authErrors.ts";
import {
  acquireAutomatchWriteAdmission,
  automatchAdmissionGuardStatements,
  createAutomatchD1Store,
  readAutomatchRuntimeControl,
  releaseAutomatchWriteAdmission,
  type AutomatchWriteAdmission,
} from "./automatchD1.ts";
import {
  createGameSessionTransitions,
  gameSessionResourceGuardStatements,
  type GameSessionLeaseProof,
} from "./gameSessionTransitions.ts";
import type { GameSessionMutationLockStore } from "./gameplayCoordinationD1.ts";
import type {
  MatchStatePort,
  TransactionDecision,
} from "./repositoryContracts.ts";
import type { GameSessionPort } from "./gameSessionContracts.ts";
import type { PrepareMatchPresentations } from "./matchPresentationRegistry.ts";
import {
  acquireInviteSourceAdmission,
  createInviteSourceD1Store,
  InviteSourceFailure,
  readInviteSourceControl,
  releaseInviteSourceAdmission,
  type InviteSourceAdmission,
} from "./inviteSourceD1.ts";

export class AutomatchPersistenceFrozen extends AuthApiFailure {
  constructor() {
    super(503, "unavailable", "automatch-persistence-frozen");
  }
}

export function createAutomatchPersistence(
  db: D1Database,
  raw: MatchStatePort,
  {
    now = Date.now,
    onCommitted,
    prepareMatchPresentations,
  }: {
    now?: () => number;
    onCommitted?: (inviteId: string) => Promise<void>;
    prepareMatchPresentations?: PrepareMatchPresentations;
  } = {},
) {
  const held = new Map<string, GameSessionLeaseProof>();
  const store = createAutomatchD1Store(db, { now });
  const inviteStore = createInviteSourceD1Store(db, { now });
  const reader = createGameSessionTransitions({
    db,
    state: raw,
    store,
    now,
    onCommitted,
    prepareMatchPresentations,
  });

  const control = async () => {
    const value = await readAutomatchRuntimeControl(db);
    if (value.backend !== "d1") {
      throw new AuthApiFailure(
        503,
        "unavailable",
        "automatch-persistence-backend-retired",
      );
    }
    return value;
  };

  const write = async <T>(
    kind: string,
    work: (
      admission: AutomatchWriteAdmission,
      inviteAdmission: InviteSourceAdmission,
    ) => Promise<T>,
  ): Promise<T> => {
    if ((await control()).state === "frozen") {
      throw new AutomatchPersistenceFrozen();
    }
    const admission = await acquireAutomatchWriteAdmission(db, kind, {
      now,
    }).catch((error: unknown) => {
      if (
        error instanceof Error &&
        error.message === "automatch-writes-frozen"
      ) {
        throw new AutomatchPersistenceFrozen();
      }
      throw error;
    });
    let inviteAdmission: InviteSourceAdmission | undefined;
    try {
      inviteAdmission = await acquireInviteSourceAdmission(db, kind, { now });
      if (inviteAdmission.backend !== "d1") {
        throw new InviteSourceFailure("invite-source-backend-retired");
      }
      return await work(admission, inviteAdmission);
    } finally {
      try {
        if (inviteAdmission) {
          await releaseInviteSourceAdmission(db, inviteAdmission);
        }
      } finally {
        await releaseAutomatchWriteAdmission(db, admission);
      }
    }
  };

  const recoverResources = async (
    keys: readonly string[],
    signal?: AbortSignal,
  ) => {
    await control();
    signal?.throwIfAborted();
    const pending = await db
      .withSession("first-primary")
      .prepare(
        `SELECT MIN(resource_key) AS resource_key
        FROM game_session_transition_resources
        WHERE resource_key IN (SELECT value FROM json_each(?))
        GROUP BY transition_id`,
      )
      .bind(JSON.stringify([...new Set(keys)]))
      .all<{ resource_key: string }>();
    if (!pending.results.length) return false;
    return write(
      "session-transition-recovery",
      async (admission, inviteAdmission) => {
        const transitions = createGameSessionTransitions({
          db,
          state: raw,
          store,
          now,
          onCommitted,
          prepareMatchPresentations,
          writeGuards: () => automatchAdmissionGuardStatements(db, admission),
          inviteAdmission,
        });
        for (const { resource_key } of pending.results) {
          await transitions.recoverResource(resource_key, signal);
        }
        return true;
      },
    );
  };
  const recover = (key: string, signal?: AbortSignal) =>
    recoverResources([key], signal);

  const readResource = async <T>(
    key: string,
    work: () => Promise<T>,
    signal?: AbortSignal,
    receipt = false,
  ): Promise<T> => {
    const mode = await control();
    if (receipt && mode.state === "active") await recover(key, signal);
    await reader.assertResourceAvailable(key);
    const value = await work();
    await reader.assertResourceAvailable(key);
    return value;
  };
  const transactProjection = (
    method:
      | "transactAutomatchTelegramSource"
      | "transactAutomatchTelegramOutbox"
      | "transactAutomatchProfileOutbox",
    inviteId: string,
    update: (current: unknown) => TransactionDecision<unknown>,
    signal?: AbortSignal,
  ) =>
    write("automatch-persistence-transaction", async (admission) => {
      const guarded = createAutomatchD1Store(db, {
        now,
        writeGuards: () => [
          ...automatchAdmissionGuardStatements(db, admission),
          ...gameSessionResourceGuardStatements(db, [inviteId]),
        ],
      });
      return guarded[method](inviteId, update, signal);
    });
  const client: GameSessionPort = {
    readInviteMetadata: (inviteId, signal) =>
      readResource(
        inviteId,
        async () => {
          if ((await readInviteSourceControl(db)).backend !== "d1")
            throw new InviteSourceFailure("invite-source-backend-retired");
          return (await inviteStore.read(inviteId, signal)).value;
        },
        signal,
      ),
    readAutomatchEntry: (inviteId, signal) =>
      readResource(
        inviteId,
        () => store.readAutomatchEntry(inviteId, signal),
        signal,
      ),
    listAutomatchEntriesByLogin: async (uid, limit, signal) => {
      await control();
      return store.listAutomatchEntriesByLogin(uid, limit, signal);
    },
    readFirstAutomatchEntry: async (signal) => {
      await control();
      return store.readFirstAutomatchEntry(signal);
    },
    readMutationReceipt: (operationId, signal) =>
      readResource(
        `gameplay-operation:${operationId}`,
        () => store.readMutationReceipt(operationId, signal),
        signal,
        true,
      ),
    readAutomatchTelegramSource: (inviteId, signal) =>
      readResource(
        inviteId,
        () => store.readAutomatchTelegramSource(inviteId, signal),
        signal,
      ),
    readAutomatchTelegramOutbox: (inviteId, signal) =>
      readResource(
        inviteId,
        () => store.readAutomatchTelegramOutbox(inviteId, signal),
        signal,
      ),
    readAutomatchProfileOutbox: (inviteId, signal) =>
      readResource(
        inviteId,
        () => store.readAutomatchProfileOutbox(inviteId, signal),
        signal,
      ),
    transactAutomatchTelegramSource: (inviteId, update, signal) =>
      transactProjection(
        "transactAutomatchTelegramSource",
        inviteId,
        update,
        signal,
      ),
    transactAutomatchTelegramOutbox: (inviteId, update, signal) =>
      transactProjection(
        "transactAutomatchTelegramOutbox",
        inviteId,
        update,
        signal,
      ),
    transactAutomatchProfileOutbox: (inviteId, update, signal) =>
      transactProjection(
        "transactAutomatchProfileOutbox",
        inviteId,
        update,
        signal,
      ),
    listDueAutomatchTelegramOutboxes: async (atMs, limit, signal) => {
      await control();
      return store.listDueAutomatchTelegramOutboxes(atMs, limit, signal);
    },
    listDueAutomatchProfileOutboxes: async (atMs, limit, signal) => {
      await control();
      return store.listDueAutomatchProfileOutboxes(atMs, limit, signal);
    },
    listMalformedAutomatchProfileOutboxes: async (limit, signal) => {
      await control();
      return store.listMalformedAutomatchProfileOutboxes(limit, signal);
    },
    commitSessionChanges: (changes, signal) =>
      write(
        "automatch-persistence-patch",
        async (admission, inviteAdmission) => {
          const guards = () => automatchAdmissionGuardStatements(db, admission);
          if (
            changes.some((change) => change.kind.startsWith("invite-")) &&
            !changes.some(
              (change) =>
                !change.kind.startsWith("invite-") &&
                change.kind !== "match-create",
            )
          )
            throw new InviteSourceFailure("invite-source-transition-required");
          if (
            changes.some(
              (change) =>
                change.kind.startsWith("invite-") ||
                change.kind === "match-create",
            )
          ) {
            return createGameSessionTransitions({
              db,
              state: raw,
              store,
              now,
              onCommitted,
              prepareMatchPresentations,
              writeGuards: guards,
              inviteAdmission,
            }).commit(changes, [...held.values()], signal);
          }
          const resources = changes.map((change) =>
            change.kind === "mutation-receipt"
              ? `gameplay-operation:${change.operationId}`
              : "inviteId" in change
                ? change.inviteId
                : "",
          );
          const guarded = createAutomatchD1Store(db, {
            now,
            writeGuards: () => [
              ...guards(),
              ...gameSessionResourceGuardStatements(db, resources),
            ],
          });
          const nowMs = now();
          for (let attempt = 0; attempt < 25; attempt++) {
            if (
              await guarded.commit(
                await guarded.prepareChanges(changes, nowMs, signal),
                signal,
              )
            )
              return;
          }
          throw new Error("automatch-patch-contention");
        },
      ),
  };

  return {
    client,
    async recoverLogins(loginUids: readonly string[], signal?: AbortSignal) {
      await recoverResources(
        loginUids.map((uid) => `automatch-login:${uid}`),
        signal,
      );
    },
    async writesEnabled() {
      const inviteControl = await readInviteSourceControl(db);
      if (inviteControl.backend !== "d1") {
        throw new InviteSourceFailure("invite-source-backend-retired");
      }
      return (
        (await control()).state === "active" && inviteControl.state === "active"
      );
    },
    async readQueuedByLogins(
      loginUids: readonly string[],
      signal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
      await control();
      const rows = await store.listEntriesByLogins(loginUids, 2, signal);
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },
    async expireReceipts(cutoffMs: number, limit: number): Promise<number> {
      const mode = await control();
      if (mode.state === "frozen") return 0;
      return write("session-receipt-expiry", (admission) =>
        createAutomatchD1Store(db, {
          now,
          writeGuards: () => automatchAdmissionGuardStatements(db, admission),
        }).expireReceipts(cutoffMs, limit),
      );
    },
    async sweep(limit = 10) {
      const mode = await control();
      if (mode.state === "frozen") {
        return { recovered: 0, failed: 0 };
      }
      return write("session-transition-sweep", (admission, inviteAdmission) =>
        createGameSessionTransitions({
          db,
          state: raw,
          store,
          now,
          onCommitted,
          prepareMatchPresentations,
          writeGuards: () => automatchAdmissionGuardStatements(db, admission),
          inviteAdmission,
        }).sweep(limit),
      );
    },
    decorateLocks(
      base: GameSessionMutationLockStore,
    ): GameSessionMutationLockStore {
      return {
        async acquire(lock, ownerId, nowMs) {
          await recover(lock.lockId);
          await base.acquire(lock, ownerId, nowMs);
          held.set(lock.lockId, { ...lock, ownerId });
        },
        refresh: (lock, ownerId, nowMs) => base.refresh(lock, ownerId, nowMs),
        async release(lock, ownerId) {
          try {
            await base.release(lock, ownerId);
          } finally {
            if (held.get(lock.lockId)?.ownerId === ownerId)
              held.delete(lock.lockId);
          }
        },
        deleteExpired: (nowMs) => base.deleteExpired(nowMs),
      };
    },
  };
}

export type AutomatchPersistence = ReturnType<
  typeof createAutomatchPersistence
>;
