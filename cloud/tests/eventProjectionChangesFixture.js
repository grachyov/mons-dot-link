"use strict";

const core = require("../runtime/telegram/eventProjectionCore");

const statePrefix = "eventTelegramProjections/";
const messagePrefix = "telegramMessages/";
const desiredSuffix = "/desired";

const desiredChanges = (updates) =>
  Object.entries(updates).map(([path, value]) => ({
    messageKey:
      path.startsWith(messagePrefix) && path.endsWith(desiredSuffix)
        ? path.slice(messagePrefix.length, -desiredSuffix.length)
        : "",
    value,
  }));

const toUpdates = (changes) =>
  changes
    ? {
        [`${statePrefix}${changes.eventId}`]: changes.state,
        ...Object.fromEntries(
          changes.desired.map(({ messageKey, value }) => [
            `${messagePrefix}${messageKey}${desiredSuffix}`,
            value,
          ]),
        ),
      }
    : {};

const splitEventTelegramProjectionUpdates = ({ eventId, updates }) => {
  const statePath = `${statePrefix}${eventId}`;
  if (!Object.hasOwn(updates, statePath)) {
    throw new TypeError("event Telegram projection state update is required");
  }
  return {
    stateUpdates: { [statePath]: updates[statePath] },
    desiredUpdates: Object.fromEntries(
      Object.entries(updates).filter(([path]) => path !== statePath),
    ),
  };
};

module.exports = {
  ...core,
  buildEventTelegramProjectionUpdates(input) {
    return toUpdates(core.buildEventTelegramProjectionChanges(input));
  },
  addEventTelegramProjectionGuard({ updates, guard }) {
    if (!guard) return updates;
    const statePath = `${statePrefix}${guard.eventId}`;
    const changes = {
      eventId: guard.eventId,
      state: updates[statePath] || {},
      desired: desiredChanges(
        Object.fromEntries(
          Object.entries(updates).filter(([path]) => path !== statePath),
        ),
      ),
    };
    const guarded = toUpdates(
      core.addEventTelegramProjectionGuard({ changes, guard }),
    );
    return Object.fromEntries(
      Object.entries(guarded).filter(([path]) => Object.hasOwn(updates, path)),
    );
  },
  splitEventTelegramProjectionUpdates,
  buildEventTelegramDispatches({ eventId, desiredUpdates }) {
    return core.buildEventTelegramDispatches({
      eventId,
      desiredChanges: desiredChanges(desiredUpdates),
    });
  },
};
