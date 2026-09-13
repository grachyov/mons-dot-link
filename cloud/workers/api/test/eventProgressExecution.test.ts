import assert from "node:assert/strict";
import test from "node:test";
import { createEventProgressWorkExecutor } from "../src/eventProgressExecution.ts";

test("same-workflow work waits for every preceding operation without blocking other IDs", async () => {
  const execute = createEventProgressWorkExecutor();
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const calls: string[] = [];
  const a = execute("same", async () => {
    calls.push("first");
    await first.promise;
  });
  const b = execute("same", async () => {
    calls.push("second");
    secondStarted.resolve();
    await second.promise;
  });
  await execute("other", async () => {
    calls.push("other");
  });
  assert.deepEqual(calls, ["first", "other"]);
  first.resolve();
  await a;
  await secondStarted.promise;
  const c = execute("same", async () => {
    calls.push("third");
  });
  await Promise.resolve();
  assert.deepEqual(calls, ["first", "other", "second"]);
  second.resolve();
  await Promise.all([b, c]);
  assert.deepEqual(calls, ["first", "other", "second", "third"]);
});

test("a failed workflow operation reports its error while queued and later work execute freshly", async () => {
  const execute = createEventProgressWorkExecutor();
  const release = Promise.withResolvers<void>();
  const failure = new Error("first-failed");
  const first = execute("same", async () => {
    await release.promise;
    throw failure;
  });
  const rejected = assert.rejects(first, (error) => error === failure);
  const calls: string[] = [];
  const second = execute("same", async () => {
    calls.push("queued");
  });
  release.resolve();
  await Promise.all([rejected, second]);
  await execute("same", async () => {
    calls.push("later");
  });
  assert.deepEqual(calls, ["queued", "later"]);
});
