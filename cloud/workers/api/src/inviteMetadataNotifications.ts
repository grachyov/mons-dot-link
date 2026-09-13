import { normalizeRecordKey } from "@mons/shared/ids";
import {
  notifyInviteRooms,
  type InviteRoomNotificationOptions,
} from "./inviteRoomNotifications.ts";

export function notifyInviteMetadataChanged(
  env: Env,
  inviteIds: readonly string[],
  options: InviteRoomNotificationOptions = {},
): Promise<void> {
  return notifyInviteRooms(
    env,
    [...new Set(inviteIds)].filter((id) => normalizeRecordKey(id) === id),
    "notifyMetadataChanged",
    "invite_metadata_notify_failed",
    options,
  );
}
