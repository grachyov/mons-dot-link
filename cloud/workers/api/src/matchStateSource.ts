import type { MatchStateJson } from "./matchStateTypes.ts";
import type { MatchStatePort } from "./repositoryContracts.ts";
import { registerMatchStateRoutes } from "./matchStateD1.ts";
import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import {
  readCurrentMatchState,
  readMatchStateRecord,
} from "./matchStateRouting.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "./matchStateRpc.ts";
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";

export function createMatchStateSource(env: Env): MatchStatePort {
  return {
    async readMatchRecord(input, signal) {
      signal?.throwIfAborted();
      if (
        !isCanonicalLoginUid(input.playerId) ||
        !isSafeRecordKey(input.matchId)
      )
        throw new Error("match-state-invalid-read-target");
      const value = await readMatchStateRecord(env, input, { signal });
      return value as MatchStateJson;
    },
    async readMatchPair(input, signal) {
      signal?.throwIfAborted();
      return readCurrentMatchState(env, async (control) =>
        unwrapMatchStateRpc(
          await getMatchStateRpc(env, input.inviteId).readCanonicalMatchPair({
            ...input,
            epoch: control.epoch,
          }),
        ),
      );
    },
    async createMatchRecords(input, signal) {
      signal?.throwIfAborted();
      const control = await requireActiveDurableMatchState(
        env.PROFILE_GAMES_DB,
      );
      unwrapMatchStateRpc(
        await getMatchStateRpc(env, input.inviteId).createCanonicalMatch({
          inviteId: input.inviteId,
          epoch: control.epoch,
          records: input.records,
        }),
      );
      await registerMatchStateRoutes(
        env.PROFILE_GAMES_DB,
        input.records.map((row) => ({
          actorUid: row.playerId,
          matchId: row.matchId,
          inviteId: input.inviteId,
          kind: "durable" as const,
          epoch: control.epoch,
        })),
        control.epoch,
      );
    },
    async applyMatchEventEffects(input, signal) {
      signal?.throwIfAborted();
      const control = await requireActiveDurableMatchState(
        env.PROFILE_GAMES_DB,
      );
      unwrapMatchStateRpc(
        await getMatchStateRpc(
          env,
          input.inviteId,
        ).applyCanonicalMatchEventEffects({ ...input, epoch: control.epoch }),
      );
      if (input.creations?.length) {
        await registerMatchStateRoutes(
          env.PROFILE_GAMES_DB,
          input.creations.map((row) => ({
            actorUid: row.playerId,
            matchId: row.matchId,
            inviteId: input.inviteId,
            kind: "durable" as const,
            epoch: control.epoch,
          })),
          control.epoch,
        );
      }
    },
  };
}
