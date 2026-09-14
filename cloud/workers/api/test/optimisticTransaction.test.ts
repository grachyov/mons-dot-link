import assert from "node:assert/strict";
import test from "node:test";
import { runOptimisticTransaction } from "../src/optimisticTransaction.ts";

test("conflicts reread state and recompute the decision before committing", async () => {
  let reads = 0;
  const writes: Array<{ version: number; value: unknown }> = [];
  const result = await runOptimisticTransaction({
    maxAttempts: 3,
    read: async () => ({ record: { count: ++reads }, version: reads }),
    decide: (current) => ({
      value: { count: current!.count + 1 },
      decision: `increment-${current!.count}`,
    }),
    write: async (current, value) => {
      writes.push({ version: current!.version, value });
      return { applied: writes.length === 2, value: { count: 3 } };
    },
    conflictError: () => new Error("exhausted"),
  });
  assert.deepEqual(writes, [
    { version: 1, value: { count: 2 } },
    { version: 2, value: { count: 3 } },
  ]);
  assert.deepEqual(result, {
    committed: true,
    decision: "increment-2",
    value: { count: 3 },
  });
  assert.equal(reads, 2);
});

test("a logical abort after a conflict returns the freshly read record", async () => {
  let reads = 0;
  let writes = 0;
  const result = await runOptimisticTransaction({
    maxAttempts: 3,
    read: async () => ({ record: { count: ++reads }, version: reads }),
    decide: (current) =>
      current!.count === 1
        ? { value: { count: 2 } }
        : { commit: false, decision: "already-applied" },
    write: async () => {
      writes++;
      return { applied: false, value: null };
    },
    conflictError: () => new Error("exhausted"),
  });
  assert.deepEqual(result, {
    committed: false,
    decision: "already-applied",
    value: { count: 2 },
  });
  assert.equal(writes, 1);
});

test("deletion commits the adapter's null value", async () => {
  const result = await runOptimisticTransaction({
    maxAttempts: 3,
    read: async () => ({ record: { count: 1 }, version: 4 }),
    decide: () => ({ value: null, decision: "deleted" }),
    write: async (current, value) => {
      assert.equal(current?.version, 4);
      assert.equal(value, null);
      return { applied: true, value: null };
    },
    conflictError: () => new Error("exhausted"),
  });
  assert.deepEqual(result, {
    committed: true,
    decision: "deleted",
    value: null,
  });
});

for (const maxAttempts of [12, 25]) {
  test(`exhaustion stops after exactly ${maxAttempts} conflicts`, async () => {
    let reads = 0;
    let decisions = 0;
    let writes = 0;
    const failure = new Error("domain-conflict");
    await assert.rejects(
      runOptimisticTransaction({
        maxAttempts,
        read: async () => {
          reads++;
          return null;
        },
        decide: () => {
          decisions++;
          return { value: {} };
        },
        write: async () => {
          writes++;
          return { applied: false, value: null };
        },
        conflictError: () => failure,
      }),
      (error) => error === failure,
    );
    assert.equal(reads, maxAttempts);
    assert.equal(decisions, maxAttempts);
    assert.equal(writes, maxAttempts);
  });
}

for (const stage of ["read", "decide", "write"] as const) {
  test(`${stage} failures propagate without retrying`, async () => {
    const calls: string[] = [];
    const failure = new Error(`domain-${stage}-failure`);
    const enter = (currentStage: typeof stage) => {
      calls.push(currentStage);
      if (stage === currentStage) throw failure;
    };
    await assert.rejects(
      runOptimisticTransaction({
        maxAttempts: 25,
        read: async () => {
          enter("read");
          return null;
        },
        decide: () => {
          enter("decide");
          return { value: {} };
        },
        write: async () => {
          enter("write");
          return { applied: true, value: {} };
        },
        conflictError: () => new Error("unexpected-exhaustion"),
      }),
      (error) => error === failure,
    );
    assert.deepEqual(
      calls,
      ["read", "decide", "write"].slice(
        0,
        ["read", "decide", "write"].indexOf(stage) + 1,
      ),
    );
  });
}
