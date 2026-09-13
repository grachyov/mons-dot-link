import assert from "node:assert/strict";
import test from "node:test";
import {
  collectSuccessfulClaims,
  sendQueueTasks,
} from "../src/projectionSweep.ts";

test("projection batches preserve task order and await each send", async () => {
  const tasks = Array.from({ length: 201 }, (_, id) => ({ id }));
  const batches: MessageSendRequest<{ id: number }>[][] = [];
  let sending = false;
  const queue = {
    async sendBatch(messages) {
      assert.equal(sending, false);
      sending = true;
      await Promise.resolve();
      batches.push(Array.from(messages));
      sending = false;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  } satisfies Pick<Queue<{ id: number }>, "sendBatch">;

  await sendQueueTasks(queue, tasks);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 1],
  );
  assert.deepEqual(
    batches.flat(),
    tasks.map((body) => ({ body })),
  );

  await sendQueueTasks(queue, []);
  assert.equal(batches.length, 3);
});

test("projection batching stops after a failed send and preserves its error", async () => {
  const failure = new Error("queue-unavailable");
  const batches: number[][] = [];
  const queue = {
    async sendBatch(messages) {
      batches.push(Array.from(messages, ({ body }) => body));
      if (batches.length === 2) throw failure;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  } satisfies Pick<Queue<number>, "sendBatch">;

  await assert.rejects(
    sendQueueTasks(
      queue,
      Array.from({ length: 201 }, (_, id) => id),
    ),
    (error) => error === failure,
  );
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100],
  );
});

test("projection claims continue sequentially after errors and retain the first failure", async () => {
  const failure = new Error("claim-unavailable");
  const visited: number[] = [];
  let claiming = false;
  const result = await collectSuccessfulClaims(
    [1, 2, 3, 4, 5],
    async (item) => {
      assert.equal(claiming, false);
      claiming = true;
      visited.push(item);
      await Promise.resolve();
      claiming = false;
      if (item === 2) throw failure;
      if (item === 4) throw "later-failure";
      return item !== 1;
    },
    "projection-claim-failed",
  );

  assert.deepEqual(visited, [1, 2, 3, 4, 5]);
  assert.deepEqual(result.claimed, [3, 5]);
  assert.equal(result.failure, failure);
});

test("projection claims use the caller's fallback for non-Error failures", async () => {
  const result = await collectSuccessfulClaims(
    [1, 2, 3],
    async (item) => {
      if (item === 1) throw "unavailable";
      if (item === 2) throw new Error("later-failure");
      return true;
    },
    "profile-game-projection-claim-failed",
  );

  assert.deepEqual(result.claimed, [3]);
  assert.equal(result.failure?.message, "profile-game-projection-claim-failed");
});
