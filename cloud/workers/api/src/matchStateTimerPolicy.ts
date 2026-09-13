import {
  MATCH_TIMER_TERMINAL,
  parseStrictMatchTimer,
} from "@mons/shared/timers";
import { AuthApiFailure } from "./authErrors.ts";
import type { MatchTimerStartCandidate } from "./gameplayCoordinationD1.ts";
import type { MatchTimerGameState, MatchTimerRecord } from "./matchTimer.ts";
import {
  canonicalMatchStateJson,
  isCommittedMatchStateClaim,
} from "./matchStateLogic.ts";
import type {
  MatchStateClaimTimerRequest,
  MatchStatePair,
  MatchStateRecord,
} from "./matchStateTypes.ts";

export type TimerPair = {
  pair: MatchStatePair;
  player: MatchTimerRecord;
  opponent: MatchTimerRecord;
  game: MatchTimerGameState;
};

function fail(message: string): never {
  throw new AuthApiFailure(409, "failed-precondition", message);
}

function sameGameFields(
  left: MatchTimerRecord,
  right: MatchTimerRecord,
): boolean {
  return (
    left.color === right.color &&
    left.fen === right.fen &&
    left.flatMovesString === right.flatMovesString &&
    left.status === right.status
  );
}

export function timerTerminal(pair: TimerPair): boolean {
  return (
    pair.player.status === "surrendered" ||
    pair.opponent.status === "surrendered" ||
    pair.player.timer === MATCH_TIMER_TERMINAL ||
    pair.opponent.timer === MATCH_TIMER_TERMINAL ||
    pair.game.winner !== undefined
  );
}

export function assertTimerTurn(pair: TimerPair, claim = false): void {
  if (timerTerminal(pair)) fail("game is already over.");
  if (!pair.game.historyValid) fail("something is wrong with the moves.");
  if (pair.game.activeColor !== pair.opponent.color) {
    fail(
      claim
        ? "can't claim timer victory on your own turn."
        : "can't start a timer on your own turn.",
    );
  }
}

export function decideMatchStateTimerStartCommit(
  initial: TimerPair,
  fresh: TimerPair,
  marker: MatchTimerStartCandidate,
): { changed: boolean; playerMatch: MatchStateRecord; timer: string } {
  assertTimerTurn(fresh);
  if (
    !sameGameFields(initial.player, fresh.player) ||
    !sameGameFields(initial.opponent, fresh.opponent) ||
    initial.game.turnNumber !== fresh.game.turnNumber ||
    marker.turnNumber > fresh.game.turnNumber
  )
    fail("game state changed.");
  const parsedMarker = parseStrictMatchTimer(marker.timer);
  if (
    marker.turnNumber !== fresh.game.turnNumber ||
    parsedMarker?.turnNumber !== marker.turnNumber
  ) {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "gameplay-service-unavailable",
    );
  }
  const freshTimer = parseStrictMatchTimer(fresh.player.timer);
  if (freshTimer && freshTimer.turnNumber > fresh.game.turnNumber)
    fail("game state changed.");
  return {
    changed: fresh.player.timer !== marker.timer,
    playerMatch: { ...fresh.pair.playerMatch, timer: marker.timer },
    timer: marker.timer,
  };
}

export function decideMatchStateTimerClaim(
  current: TimerPair,
  input: MatchStateClaimTimerRequest,
  nowMs: number,
): {
  changed: boolean;
  playerMatch: MatchStateRecord;
  claim: MatchStateRecord;
  claimedAtMs: number;
} {
  const existing = current.pair.claim;
  const replay = current.player.timer === MATCH_TIMER_TERMINAL;
  if (!replay) {
    assertTimerTurn(current, true);
    if (!current.player.timer) fail("could not find an existing timer.");
    const timer = parseStrictMatchTimer(current.player.timer);
    if (!timer) fail("wrong timer format.");
    if (timer.turnNumber !== current.game.turnNumber)
      fail("can't claim this timer anymore, it's turn is over.");
    if (timer.targetTimestamp > nowMs)
      fail(`can't claim yet, ${timer.targetTimestamp - nowMs} ms remaining`);
    if (existing?.status === "claimed") {
      if (
        !isCommittedMatchStateClaim(existing, input.inviteId) ||
        existing.playerId !== input.playerId ||
        existing.opponentId !== input.opponentId ||
        existing.timer !== current.player.timer ||
        existing.turnNumber !== current.game.turnNumber
      )
        fail("game state changed.");
    } else if (
      existing?.status === "pending" &&
      typeof existing.expiresAtMs === "number" &&
      existing.expiresAtMs > nowMs
    )
      fail("game state changed.");
  }
  const claimedAtMs =
    existing &&
    isCommittedMatchStateClaim(existing, input.inviteId) &&
    existing.playerId === input.playerId &&
    existing.opponentId === input.opponentId
      ? Number(existing.claimedAtMs)
      : nowMs;
  const claim: MatchStateRecord = {
    status: "claimed",
    playerId: input.playerId,
    opponentId: input.opponentId,
    inviteId: input.inviteId,
    timer:
      replay && existing && isCommittedMatchStateClaim(existing, input.inviteId)
        ? existing.timer
        : current.player.timer,
    turnNumber: current.game.turnNumber,
    claimedAtMs,
    expiresAtMs: null,
  };
  return {
    changed:
      !replay ||
      canonicalMatchStateJson(existing) !== canonicalMatchStateJson(claim),
    playerMatch: {
      ...current.pair.playerMatch,
      timer: MATCH_TIMER_TERMINAL,
    },
    claim,
    claimedAtMs,
  };
}
