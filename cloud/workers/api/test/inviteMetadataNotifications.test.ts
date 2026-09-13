import assert from "node:assert/strict";
import test from "node:test";
import { notifyInviteSourceChanged } from "../src/inviteWagersNotifications.ts";
import { notifyInviteMetadataChanged } from "../src/inviteMetadataNotifications.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

test("metadata notifications validate and deduplicate explicit invite identities", async () => {
  const calls: string[] = [];
  const env = {
    ...TELEGRAM_TEST_ENV,
    INVITE_REACTIONS: {
      getByName: (id: string) => ({
        notifyMetadataChanged: async () => {
          calls.push(id);
        },
      }),
    },
  } as unknown as Env;
  await notifyInviteMetadataChanged(env, [
    "manual",
    "auto_pending",
    "event_invite",
    "manual",
    "",
    "invalid/key",
    " padded ",
  ]);
  assert.deepEqual(calls, ["manual", "auto_pending", "event_invite"]);
});

test("committed source updates notify metadata once per invite", async () => {
  const notices: string[] = [];
  const env = {
    ...TELEGRAM_TEST_ENV,
    INVITE_REACTIONS: {
      getByName: (id: string) => ({
        notifyMetadataChanged: async (incoming: string) => {
          assert.equal(incoming, id);
          notices.push(id);
        },
        notifyWagersChanged: async () =>
          assert.fail("metadata already invalidates wagers"),
      }),
    },
  } as unknown as Env;
  await notifyInviteSourceChanged(env, {
    metadataInviteIds: ["manual", "manual", "joined"],
    wagerInviteIds: ["joined"],
  });
  assert.deepEqual(notices, ["manual", "joined"]);
});

test("unconfirmed changes skip metadata and notification failure cannot reject committed work", async () => {
  let notices = 0;
  const env = {
    ...TELEGRAM_TEST_ENV,
    INVITE_REACTIONS: {
      getByName: () => ({
        notifyMetadataChanged: async () => {
          notices++;
        },
        notifyWagersChanged: async () => undefined,
      }),
    },
  } as unknown as Env;
  await notifyInviteSourceChanged(env, {
    metadataInviteIds: [],
    wagerInviteIds: ["manual"],
  });
  assert.equal(notices, 0);
  let failures = 0;
  const unavailable = {
    ...env,
    INVITE_REACTIONS: {
      getByName: () => ({
        notifyMetadataChanged: async () => {
          throw new Error("unavailable");
        },
      }),
    },
  } as unknown as Env;
  await notifyInviteMetadataChanged(unavailable, ["manual"], {
    logFailure: () => {
      failures++;
    },
  });
  assert.equal(failures, 1);
});

test("notification deadline prevents a stuck room from holding a committed mutation", async () => {
  const env = {
    ...TELEGRAM_TEST_ENV,
    INVITE_REACTIONS: {
      getByName: () => ({
        notifyMetadataChanged: () => new Promise<void>(() => undefined),
      }),
    },
  } as unknown as Env;
  let failures = 0;
  await notifyInviteMetadataChanged(env, ["manual"], {
    timeoutMs: 1,
    logFailure: () => {
      failures++;
    },
  });
  assert.equal(failures, 1);
});
