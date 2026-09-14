import {
  parseAutomatchRuntimeControlRow,
  prepareAutomatchRuntimeControlRead,
} from "./automatchD1.ts";
import {
  assertGameSessionResourceAvailable,
  assertNoGameSessionResourceTransition,
  prepareGameSessionResourceTransitionRead,
} from "./gameSessionTransitions.ts";
import {
  InviteSourceFailure,
  parseInviteSourceControlRow,
  prepareInviteSourceControlRead,
  readInviteSourceSnapshot,
} from "./inviteSourceD1.ts";
export function createInviteSourceReader(
  env: Pick<Env, "PROFILE_GAMES_DB">,
): (inviteId: string) => Promise<unknown> {
  const db = env.PROFILE_GAMES_DB;
  return async (inviteId) => {
    const session = db.withSession("first-primary");
    const [modeRows, controlRows, transitionRows] = await session.batch([
      prepareAutomatchRuntimeControlRead(session),
      prepareInviteSourceControlRead(session),
      prepareGameSessionResourceTransitionRead(session, inviteId),
    ]);
    const mode = parseAutomatchRuntimeControlRow(modeRows.results[0]);
    const control = parseInviteSourceControlRow(controlRows.results[0]);
    if (mode.backend !== "d1" && control.backend === "d1") {
      throw new InviteSourceFailure("invite-source-session-backend-conflict");
    }
    if (control.backend !== "d1") {
      throw new InviteSourceFailure("invite-source-not-activated");
    }
    assertNoGameSessionResourceTransition(transitionRows.results[0]);
    const snapshot = await readInviteSourceSnapshot(db, inviteId);
    await assertGameSessionResourceAvailable(db, inviteId);
    return snapshot.value;
  };
}
