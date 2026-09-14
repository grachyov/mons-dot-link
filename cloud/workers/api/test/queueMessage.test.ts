import assert from "node:assert/strict";
import test from "node:test";
import { ackQueueMessage, retryQueueMessage } from "../src/queueMessage.ts";

function fixture() {
  const operations: unknown[] = [];
  const message: Message<unknown> = {
    id: "message-1",
    attempts: 4,
    timestamp: new Date(0),
    body: { kind: "example" },
    ack: () => operations.push("ack"),
    retry: (options) => operations.push({ retry: options }),
  };
  const logger = {
    info: (entry: string) => operations.push({ info: JSON.parse(entry) }),
    error: (entry: string) => operations.push({ error: JSON.parse(entry) }),
  };
  return { message, logger, operations };
}

test("acknowledges before logging the requested severity and message context", () => {
  const { message, logger, operations } = fixture();
  ackQueueMessage(message, {
    entry: { event: "example_invalid_message", kind: "example" },
    level: "error",
    logger,
  });
  assert.deepEqual(operations, [
    "ack",
    {
      error: {
        event: "example_invalid_message",
        kind: "example",
        messageId: "message-1",
        attempts: 4,
      },
    },
  ]);
});

test("retries with the exact delay before logging", () => {
  const { message, logger, operations } = fixture();
  retryQueueMessage(message, 300, {
    entry: { event: "example_frozen", reason: "writes-disabled" },
    level: "info",
    logger,
  });
  assert.deepEqual(operations, [
    { retry: { delaySeconds: 300 } },
    {
      info: {
        event: "example_frozen",
        reason: "writes-disabled",
        messageId: "message-1",
        attempts: 4,
      },
    },
  ]);
});

test("propagates settlement failures without reporting a successful outcome", () => {
  const { message, logger, operations } = fixture();
  const error = new Error("settlement-unavailable");
  const fail = () => {
    throw error;
  };
  message.ack = fail;
  message.retry = fail;
  const log = { entry: { event: "example" }, level: "info" as const, logger };
  assert.throws(
    () => ackQueueMessage(message, log),
    (value) => value === error,
  );
  assert.throws(
    () => retryQueueMessage(message, 60, log),
    (value) => value === error,
  );
  assert.deepEqual(operations, []);
});

test("leaves logging failures to the handler's existing exception boundary", () => {
  const { message, operations } = fixture();
  const error = new Error("logger-unavailable");
  const logger = {
    info: () => {
      throw error;
    },
    error: () => {
      throw error;
    },
  };
  assert.throws(
    () =>
      ackQueueMessage(message, {
        entry: { event: "example_processed" },
        level: "info",
        logger,
      }),
    (value) => value === error,
  );
  assert.deepEqual(operations, ["ack"]);
});
