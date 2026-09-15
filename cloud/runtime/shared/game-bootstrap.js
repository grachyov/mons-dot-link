"use strict";

const {
  INVITE_METADATA_MAX_MESSAGE_BYTES,
  isReadInviteMetadataResponse,
} = require("./invite-metadata");
const {
  MATCH_SYNC_MAX_MESSAGE_BYTES,
  isMatchSyncSnapshot,
} = require("./match-sync");
const { selectInviteMatch } = require("./rematches");

const GAME_BOOTSTRAP_MAX_RESPONSE_BYTES =
  INVITE_METADATA_MAX_MESSAGE_BYTES + MATCH_SYNC_MAX_MESSAGE_BYTES + 4096;

function isReadGameBootstrapResponse(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 6 ||
    !Object.keys(value).every((key) =>
      [
        "ok",
        "schemaVersion",
        "metadata",
        "viewer",
        "match",
        "hasPendingProposal",
      ].includes(key),
    ) ||
    value.ok !== true ||
    value.schemaVersion !== 1 ||
    typeof value.hasPendingProposal !== "boolean" ||
    !isReadInviteMetadataResponse({
      ok: true,
      snapshot: value.metadata,
      viewer: value.viewer,
    }) ||
    !isMatchSyncSnapshot(value.match) ||
    value.match.inviteId !== value.metadata.inviteId ||
    value.match.hostPlayerId !== value.metadata.hostId ||
    value.match.guestPlayerId !== value.metadata.guestId
  ) {
    return false;
  }
  const selection = selectInviteMatch(
    value.metadata.inviteId,
    value.metadata,
    value.viewer.actorUid,
    { preferApproved: !value.hasPendingProposal },
  );
  return (
    selection.matchId === value.match.matchId &&
    selection.hasPendingProposal === value.hasPendingProposal
  );
}

module.exports = {
  GAME_BOOTSTRAP_MAX_RESPONSE_BYTES,
  isReadGameBootstrapResponse,
};
