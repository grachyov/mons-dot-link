import assert from "node:assert/strict";
import test from "node:test";
import {
  ProfileWritesDisabledFailure,
  authErrorResponse,
  toAuthApiFailure,
} from "../src/authErrors.ts";

test("disabled profile writes retain their DB cause without changing the public response", async () => {
  const cause = new Error("CHECK constraint failed: singleton = 1");
  const failure = new ProfileWritesDisabledFailure({ cause });
  const response = authErrorResponse(toAuthApiFailure(failure), {
    Vary: "Origin",
  });

  assert.equal(failure.cause, cause);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(response.headers.get("Vary"), "Origin");
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "unavailable",
    message: "profile-writes-disabled",
  });
});

test("permanent DB failures retain the generic unavailable response", async () => {
  const failure = new Error("canonical-profile-corruption", {
    cause: new Error("FOREIGN KEY constraint failed"),
  });
  const response = authErrorResponse(toAuthApiFailure(failure), {});

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), null);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "unavailable",
    message: "auth-service-unavailable",
  });
});
