import assert from "node:assert/strict";
import test from "node:test";
import { handleAuthRecoveryMessage } from "../src/authRecovery.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const task = { kind: "auth-profile-recovery", profileId: "profile-1" };

function fixture(body: unknown = task) {
  const operations: unknown[] = [];
  const message: Message<unknown> = {
    id: "auth-recovery-message",
    attempts: 3,
    timestamp: new Date(0),
    body,
    ack: () => operations.push("ack"),
    retry: (options) => operations.push({ retry: options }),
  };
  const logger = {
    info: (entry: string) => operations.push({ info: JSON.parse(entry) }),
    error: (entry: string) => operations.push({ error: JSON.parse(entry) }),
  };
  return { message, logger, operations };
}

test("acknowledges and reports invalid auth recovery tasks without recovering", async () => {
  const { message, logger, operations } = fixture({ ...task, extra: true });
  await handleAuthRecoveryMessage(
    message,
    TELEGRAM_TEST_ENV,
    async () => {
      assert.fail("invalid task must not start recovery");
    },
    logger,
  );
  assert.deepEqual(operations, [
    "ack",
    {
      error: {
        event: "auth_recovery_queue_invalid_message",
        messageId: message.id,
        attempts: 3,
      },
    },
  ]);
});

test("preserves recovered and pending auth recovery outcomes", async () => {
  for (const recovered of [true, false]) {
    const { message, logger, operations } = fixture();
    await handleAuthRecoveryMessage(
      message,
      TELEGRAM_TEST_ENV,
      async (profileId) => {
        assert.equal(profileId, task.profileId);
        assert.deepEqual(operations, []);
        return recovered;
      },
      logger,
    );
    assert.deepEqual(operations, [
      recovered ? "ack" : { retry: { delaySeconds: 60 } },
      {
        info: {
          event: recovered
            ? "auth_recovery_queue_processed"
            : "auth_recovery_queue_retrying",
          profileId: task.profileId,
          messageId: message.id,
          attempts: 3,
        },
      },
    ]);
  }
});

test("retries auth recovery failures with their cause and message identity", async () => {
  for (const error of [new Error("profile-db-unavailable"), null]) {
    const { message, logger, operations } = fixture();
    await handleAuthRecoveryMessage(
      message,
      TELEGRAM_TEST_ENV,
      async () => {
        throw error;
      },
      logger,
    );
    assert.deepEqual(operations, [
      { retry: { delaySeconds: 60 } },
      {
        error: {
          event: "auth_recovery_queue_failed",
          profileId: task.profileId,
          code: error instanceof Error ? error.message : "unknown",
          messageId: message.id,
          attempts: 3,
        },
      },
    ]);
  }
});
