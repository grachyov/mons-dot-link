import type { GameplayRepository } from "./gameplayRepository.ts";
import type { MatchStatePairRequest } from "./matchStateTypes.ts";

export async function readGameplayMatchPair(
  repository: Pick<GameplayRepository, "readMatchPair">,
  request: Omit<MatchStatePairRequest, "epoch">,
  signal?: AbortSignal,
): Promise<[unknown, unknown]> {
  const pair = await repository.readMatchPair(request, signal);
  return [pair.playerMatch, pair.opponentMatch];
}
