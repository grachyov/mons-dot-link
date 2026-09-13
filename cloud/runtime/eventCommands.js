"use strict";
const EFFECT_KINDS = new Set([
  "invite",
  "match-creation",
  "match-terminal-timer",
  "match-timer-start-cleanup",
  "match-timer-claim",
]);
const isEventMutation = (command) => !EFFECT_KINDS.has(command.kind);
const eventField = (eventId, field, value) => ({
  kind: "event-field",
  eventId,
  field,
  value,
});
const eventCommandIdentity = (command) =>
  JSON.stringify([
    command.kind,
    command.eventId,
    command.profileId,
    command.outboxId,
    command.inviteId,
    command.playerId,
    command.matchId,
    command.field,
    command.roundKey,
    command.matchKey,
  ]);
const mergeEventPlans = (...plans) => {
  const commands = new Map();
  for (const command of plans.flat())
    commands.set(eventCommandIdentity(command), command);
  return [...commands.values()];
};
const getEventField = (plan, eventId, field) =>
  plan.findLast(
    (command) =>
      command.kind === "event-field" &&
      command.eventId === eventId &&
      command.field === field,
  )?.value;
module.exports = {
  getEventField,
  isEventMutation,
  eventField,
  mergeEventPlans,
  eventCommandIdentity,
};
