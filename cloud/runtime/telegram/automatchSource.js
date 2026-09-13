"use strict";

const TELEGRAM_AUTOMATCH_VERSION = 2;
const TELEGRAM_AUTOMATCH_ROOT = "telegramAutomatches";
const TELEGRAM_AUTOMATCH_PROJECTION_OUTBOX_ROOT =
  "telegramProjectionOutbox/automatch";

const buildAutomatchTelegramProjectionChanges = ({
  inviteId,
  requestId,
  timestamp,
}) => [
  {
    kind: "telegram-outbox",
    inviteId,
    value: {
      schemaVersion: 1,
      status: "pending",
      requestId,
      updatedAtMs: timestamp,
    },
  },
];

const buildPendingAutomatchTelegramSource = ({
  inviteId,
  waitingText,
  canceledText,
  timestamp,
}) => ({
  version: TELEGRAM_AUTOMATCH_VERSION,
  generation: 1,
  lifecycle: "pending",
  waitingText,
  canceledText,
  waitingInstanceKey: `waiting:${inviteId}`,
  createdAtMs: timestamp,
  updatedAtMs: timestamp,
});

const buildMatchedAutomatchTelegramChanges = ({
  inviteId,
  matchedText,
  timestamp,
  generation,
}) => {
  return [
    {
      kind: "telegram-source-merge",
      inviteId,
      value: {
        lifecycle: "matched",
        matchedText,
        matchedInstanceKey: `matched:${inviteId}`,
        updatedAtMs: timestamp,
        generation,
      },
    },
  ];
};

const buildAutomatchTelegramLifecycleChanges = ({
  inviteId,
  lifecycle,
  timestamp,
  generation,
}) => {
  return [
    {
      kind: "telegram-source-merge",
      inviteId,
      value: {
        lifecycle,
        updatedAtMs: timestamp,
        generation,
      },
    },
  ];
};

module.exports = {
  TELEGRAM_AUTOMATCH_ROOT,
  TELEGRAM_AUTOMATCH_PROJECTION_OUTBOX_ROOT,
  TELEGRAM_AUTOMATCH_VERSION,
  buildAutomatchTelegramProjectionChanges,
  buildAutomatchTelegramLifecycleChanges,
  buildMatchedAutomatchTelegramChanges,
  buildPendingAutomatchTelegramSource,
};
