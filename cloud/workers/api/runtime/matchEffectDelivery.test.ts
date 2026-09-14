import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { createMatchEffectDelivery } from "../src/matchEffectsDispatcher.ts";
import type { MatchStateEffect } from "../src/matchStateTypes.ts";
import { buildEventProgressPlan } from "../src/eventProgressCodec.ts";
import {
  acquireEventWriteAdmission,
  commitEventMutations,
  readEventProgressOutbox,
  releaseEventWriteAdmission,
} from "../src/eventD1.ts";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};

const effect: MatchStateEffect = {
  effectId: "timer:invite:match",
  inviteId: "invite",
  matchId: "match",
  playerId: "host",
  opponentId: "guest",
  epoch: 2,
  claimedAtMs: 100,
  eventId: "event",
  sourceKey: "timer:invite:match",
  reason: "timer-claimed",
  nextAtMs: 100,
  attempts: 0,
};

function environment(onDispatch: () => Promise<void>) {
  let dispatched = 0;
  const value: Env = {
    ...testEnv,
    EVENT_PROGRESS_WORKFLOW: {
      create: async () => {
        throw new Error("unexpected-workflow-create");
      },
      createBatch: async () => {
        dispatched++;
        await onDispatch();
        return [];
      },
      get: async () => {
        throw new Error("workflow-not-found");
      },
      deleteBatch: async () => ({ deleted: [], errors: [] }),
    },
  };
  return {
    deliver: createMatchEffectDelivery(value),
    dispatched: () => dispatched,
  };
}

async function timerCount() {
  return testEnv.PROFILE_GAMES_DB.prepare(
    "SELECT COUNT(*) AS count FROM match_timer_starts WHERE match_id = 'match'",
  ).first<number>("count");
}

async function admissionCount() {
  return testEnv.EVENT_DB.prepare(
    "SELECT COUNT(*) AS count FROM event_write_admissions",
  ).first<number>("count");
}

beforeAll(async () => {
  await applyStrictMatchStateTestMigrations(
    testEnv.PROFILE_GAMES_DB,
    testEnv.TEST_D1_MIGRATIONS,
  );
  await applyEventTestMigrations(
    testEnv.EVENT_DB,
    testEnv.TEST_EVENT_D1_MIGRATIONS,
  );
  await applyRetiredProfileMigrations(
    testEnv.PROFILE_DB,
    testEnv.TEST_PROFILE_D1_MIGRATIONS,
    "a".repeat(64),
  );
  const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
  try {
    await commitEventMutations(
      testEnv.EVENT_DB,
      [
        {
          kind: "event",
          eventId: "event",
          value: {
            schemaVersion: 2,
            eventId: "event",
            status: "active",
            createdAtMs: 100,
            updatedAtMs: 100,
            startAtMs: 100,
            createdByProfileId: "profile",
            createdByLoginUid: "host",
            createdByUsername: "ivan",
            participants: {},
            rounds: {},
          },
        },
      ],
      { admission },
    );
  } finally {
    await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
  }
});

beforeEach(async () => {
  await testEnv.EVENT_DB.batch([
    testEnv.EVENT_DB.prepare(
      "DROP TRIGGER IF EXISTS keep_match_effect_admission",
    ),
    testEnv.EVENT_DB.prepare("DELETE FROM event_write_admissions"),
    testEnv.EVENT_DB.prepare("DELETE FROM event_progress_outboxes"),
  ]);
  await testEnv.PROFILE_DB.prepare(
    "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
  ).run();
  await testEnv.PROFILE_GAMES_DB.batch([
    testEnv.PROFILE_GAMES_DB.prepare("DELETE FROM match_timer_starts"),
    testEnv.PROFILE_GAMES_DB.prepare(
      `INSERT INTO match_timer_starts (player_id, match_id, timer, turn_number, updated_at_ms)
       VALUES ('host', 'match', '1;100', 1, 100), ('guest', 'match', '1;100', 1, 100)`,
    ),
  ]);
});

it("commits the event outbox and releases its admission before Workflow dispatch", async () => {
  const plan = await buildEventProgressPlan(
    { eventId: "event", sourceKey: effect.sourceKey, reason: effect.reason },
    effect.claimedAtMs,
  );
  const f = environment(async () => {
    expect(await timerCount()).toBe(0);
    expect(
      await readEventProgressOutbox(testEnv.EVENT_DB, plan.outboxId),
    ).toEqual(plan.outbox);
    expect(await admissionCount()).toBe(1);
  });
  await f.deliver(effect);
  expect(f.dispatched()).toBe(1);
  expect(await admissionCount()).toBe(0);
});

it("retains the committed outbox without dispatch when admission release is unconfirmed", async () => {
  await testEnv.EVENT_DB.prepare(
    `CREATE TRIGGER keep_match_effect_admission BEFORE DELETE ON event_write_admissions
     BEGIN SELECT RAISE(IGNORE); END`,
  ).run();
  const f = environment(async () => {});
  await expect(f.deliver(effect)).rejects.toThrow(
    "match-event-admission-release-unconfirmed",
  );
  expect(f.dispatched()).toBe(0);
  expect(await timerCount()).toBe(0);
  expect(await admissionCount()).toBe(1);
  expect(
    await testEnv.EVENT_DB.prepare(
      "SELECT COUNT(*) AS count FROM event_progress_outboxes",
    ).first<number>("count"),
  ).toBe(1);
});

it("keeps timer markers when canonical profile writes are frozen", async () => {
  await testEnv.PROFILE_DB.prepare(
    "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
  ).run();
  const f = environment(async () => {});
  await expect(f.deliver(effect)).rejects.toThrow("profile-writes-disabled");
  expect(await timerCount()).toBe(2);
  expect(await admissionCount()).toBe(0);
  expect(f.dispatched()).toBe(0);
});

it("cleans non-event timer markers without creating an event outbox or Workflow", async () => {
  const f = environment(async () => {});
  await f.deliver({ ...effect, eventId: null });
  expect(await timerCount()).toBe(0);
  expect(await admissionCount()).toBe(0);
  expect(f.dispatched()).toBe(0);
  expect(
    await testEnv.EVENT_DB.prepare(
      "SELECT COUNT(*) AS count FROM event_progress_outboxes",
    ).first<number>("count"),
  ).toBe(0);
});
