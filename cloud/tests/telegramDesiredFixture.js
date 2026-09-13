"use strict";
const core = require("../runtime/telegram/desiredStateCore");
const {
  TELEGRAM_MESSAGE_ROOT,
  validateTelegramMessageKey,
  buildTelegramSendDesired,
  buildTelegramEditDesired,
  buildTelegramDeleteDesired,
} = core;
const buildDesiredUpdates = (messageKey, desired) => ({
  [`${TELEGRAM_MESSAGE_ROOT}/${validateTelegramMessageKey(messageKey)}/desired`]:
    desired,
});

const buildTelegramSendUpdates = ({ messageKey, ...desiredInput }) =>
  buildDesiredUpdates(messageKey, buildTelegramSendDesired(desiredInput));

const buildTelegramEditUpdates = ({ messageKey, ...desiredInput }) =>
  buildDesiredUpdates(messageKey, buildTelegramEditDesired(desiredInput));

const buildTelegramDeleteUpdates = ({ messageKey, ...desiredInput }) =>
  buildDesiredUpdates(messageKey, buildTelegramDeleteDesired(desiredInput));

module.exports = {
  ...core,
  buildTelegramSendUpdates,
  buildTelegramEditUpdates,
  buildTelegramDeleteUpdates,
};
