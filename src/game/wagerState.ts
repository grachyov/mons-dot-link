import type { MatchWagerState } from "../connection/connectionModels";

type WagerStateListener = (state: MatchWagerState | null) => void;

let currentMatchId: string | null = null;
let currentState: MatchWagerState | null = null;
let currentStateMatchId: string | null = null;
let hasConfirmedSnapshot = false;

const listeners = new Set<WagerStateListener>();

const notify = () => {
  const snapshot = currentState;
  listeners.forEach((listener) => listener(snapshot));
};

export const setCurrentWagerMatch = (matchId: string | null) => {
  if (currentMatchId === matchId) return;
  currentMatchId = matchId;
  if (matchId !== currentStateMatchId) {
    currentState = null;
    currentStateMatchId = null;
    hasConfirmedSnapshot = false;
  }
  notify();
};

export const setWagerState = (
  matchId: string | null,
  state: MatchWagerState | null,
) => {
  if (!matchId || (currentMatchId && matchId !== currentMatchId)) {
    return;
  }
  currentState = state;
  currentStateMatchId = matchId;
  notify();
};

export const syncCurrentWagerMatchState = (
  matchId: string | null,
  state: MatchWagerState | null,
  confirmed = false,
) => {
  currentMatchId = matchId;
  hasConfirmedSnapshot = matchId !== null && confirmed;
  if (!matchId) {
    currentState = null;
    currentStateMatchId = null;
    notify();
    return;
  }
  currentState = state;
  currentStateMatchId = matchId;
  notify();
};

export const getWagerState = () => currentState;

export const hasConfirmedWagerSnapshot = () => hasConfirmedSnapshot;

export const subscribeToWagerState = (listener: WagerStateListener) => {
  listeners.add(listener);
  listener(currentState);
  return () => {
    listeners.delete(listener);
  };
};

export const resetWagerStore = () => {
  currentMatchId = null;
  currentState = null;
  currentStateMatchId = null;
  hasConfirmedSnapshot = false;
  notify();
};
