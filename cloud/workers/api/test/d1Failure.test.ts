import assert from "node:assert/strict";
import test from "node:test";
import { classifyD1Failure } from "../src/d1Failure.ts";

test("only explicit guard signatures and username ownership are conflicts", () => {
  const cases = [
    [
      "UNIQUE constraint failed: event_transaction_guards.singleton",
      "event-conflict",
    ],
    [
      "NOT NULL constraint failed: profile_transaction_guards.singleton",
      "profile-conflict",
    ],
    [
      "UNIQUE constraint failed: profile_records.username_key",
      "username-conflict",
    ],
    ["CHECK constraint failed: singleton = 1", "guard"],
    ["CHECK constraint failed: singleton=1", "guard"],
    ["UNIQUE constraint failed: profile_records.profile_id", "integrity"],
    ["UNIQUE constraint failed: event_records.event_id", "integrity"],
    ["FOREIGN KEY constraint failed", "integrity"],
    ["CHECK constraint failed: revision > 0", "integrity"],
    [
      "NOT NULL constraint failed: profile_transaction_guards.other",
      "integrity",
    ],
  ] as const;
  for (const [message, expected] of cases) {
    for (const suffix of [
      "",
      ": SQLITE_CONSTRAINT",
      ": SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
    ]) {
      const failure = new Error(`D1_ERROR: ${message}${suffix}`);
      assert.equal(classifyD1Failure(failure), expected);
      assert.equal(
        classifyD1Failure(
          new Error("database unavailable", { cause: failure }),
        ),
        expected,
      );
    }
  }
});

test("trigger failures are integrity failures and unrelated errors stay unknown", () => {
  assert.equal(
    classifyD1Failure(
      new Error(
        "D1_ERROR: profile merge depth exceeded: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
      ),
    ),
    "integrity",
  );
  for (const error of [
    null,
    "constraint",
    new Error("Network connection lost."),
    new Error(
      "message containing UNIQUE constraint failed: event_transaction_guards.singleton",
    ),
  ]) {
    assert.equal(classifyD1Failure(error), "unknown");
  }
  assert.equal(
    classifyD1Failure(
      new Error(
        "UNIQUE constraint failed: event_transaction_guards.singleton, other.column",
      ),
    ),
    "integrity",
  );
});

test("cause inspection terminates on cycles and excessive depth", () => {
  const cycle = new Error("cycle");
  cycle.cause = cycle;
  assert.equal(classifyD1Failure(cycle), "unknown");
  let error = new Error(
    "UNIQUE constraint failed: event_transaction_guards.singleton",
  );
  for (let index = 0; index < 8; index++) {
    error = new Error("wrapper", { cause: error });
  }
  assert.equal(classifyD1Failure(error), "unknown");
});
