import type { ReadGameBootstrapResponse } from "@mons/shared/game-bootstrap";
import { readPendingRematchEnd } from "../connection/rematchEndDelivery";
import { subscribeToNavigationState } from "../navigation/appNavigation";
import {
  getCurrentRouteState,
  type RouteState,
} from "../navigation/routeState";
import {
  sessionAuth,
  type InitialGameSessionOwner,
  type SessionAuth,
  type SessionUser,
} from "../session/sessionAuth";
import { createUserBoundAuthTokenProvider } from "./authApi";
import {
  GameBootstrapApiError,
  readGameBootstrapViaApi,
} from "./gameBootstrapApi";

type Selection = "current" | "approved";
type InitialGameBootstrap = {
  promise: Promise<ReadGameBootstrapResponse>;
  abort: () => void;
};
type Dependencies = {
  auth: Pick<
    SessionAuth,
    | "currentUser"
    | "authStateReady"
    | "signInAnonymously"
    | "onAuthStateChanged"
    | "prepareInitialGame"
  >;
  read: typeof readGameBootstrapViaApi;
  route: () => RouteState;
  subscribeRoute: (listener: (route: RouteState) => void) => () => void;
  selection: (inviteId: string, user: Pick<SessionUser, "uid">) => Selection;
};

export function createInitialGameBootstrap(dependencies: Dependencies) {
  let initial:
    | (InitialGameBootstrap & {
        inviteId: string;
        user: SessionUser | null;
        selection: Selection | null;
        isOwnedBy: (user: SessionUser) => boolean;
        cleanup: () => void;
      })
    | null = null;
  let started = false;

  const ensureUser = async () => {
    await dependencies.auth.authStateReady();
    if (!dependencies.auth.currentUser) {
      await dependencies.auth.signInAnonymously();
    }
    const user = dependencies.auth.currentUser;
    if (!user) throw new Error("authentication-required");
    return user;
  };

  return {
    start(route: RouteState): void {
      if (started) return;
      started = true;
      if (route.mode !== "invite" || !route.inviteId) {
        void ensureUser().catch(() => undefined);
        return;
      }
      const inviteId = route.inviteId;
      const controller = new AbortController();
      let owner: InitialGameSessionOwner | null = null;
      const isOwnedBy = (user: SessionUser) =>
        owner === null ||
        (owner.sessionId === user.sessionId &&
          owner.generation === user.generation);
      const preparation = dependencies.auth.prepareInitialGame(inviteId, {
        selectionForUid: (uid) => dependencies.selection(inviteId, { uid }),
        signal: controller.signal,
        onSessionBound: (session) => {
          owner ??= session;
        },
      });
      let explicitGameError = false;
      let unsubscribeAuth = () => {};
      let unsubscribeRoute = () => {};
      const cleanup = () => {
        unsubscribeAuth();
        unsubscribeRoute();
      };
      const abort = () => {
        controller.abort();
        cleanup();
        if (initial === request) initial = null;
      };
      const matchesRoute = (target: RouteState) =>
        target.mode === "invite" && target.inviteId === inviteId;
      const request: NonNullable<typeof initial> = {
        inviteId,
        user: dependencies.auth.currentUser,
        selection: null,
        isOwnedBy,
        abort,
        cleanup,
        promise: preparation
          .then(async ({ user, selection, bootstrap }) => {
            if (
              controller.signal.aborted ||
              !matchesRoute(dependencies.route())
            ) {
              throw new Error("initial-game-bootstrap-canceled");
            }
            if (!isOwnedBy(user))
              throw new Error("initial-game-bootstrap-changed");
            request.user = user;
            request.selection = selection;
            const tokenProvider = createUserBoundAuthTokenProvider(
              user,
              () => dependencies.auth.currentUser,
            );
            tokenProvider.assertCurrentUser();
            if (bootstrap && !bootstrap.ok) {
              explicitGameError = true;
              throw new GameBootstrapApiError(
                `http-${bootstrap.status}`,
                bootstrap.status,
                bootstrap.retryAfterMs,
              );
            }
            const result =
              bootstrap ??
              (await dependencies.read(inviteId, tokenProvider, {
                signal: controller.signal,
                selection: request.selection,
              }));
            tokenProvider.assertCurrentUser();
            if (
              controller.signal.aborted ||
              !matchesRoute(dependencies.route())
            ) {
              throw new Error("initial-game-bootstrap-canceled");
            }
            return result;
          })
          .catch((error: unknown) => {
            if (!explicitGameError || controller.signal.aborted) abort();
            throw error;
          }),
      };
      initial = request;
      unsubscribeAuth = dependencies.auth.onAuthStateChanged((user) => {
        if (
          (request.user && user !== request.user) ||
          (user && !isOwnedBy(user))
        )
          abort();
        else request.user = user;
      });
      unsubscribeRoute = dependencies.subscribeRoute((target) => {
        if (!matchesRoute(target)) abort();
      });
      void request.promise.catch(() => undefined);
    },
    take(
      inviteId: string,
      user: SessionUser,
      selection: Selection = "current",
    ): InitialGameBootstrap | null {
      const request = initial;
      if (!request) return null;
      const selected =
        request.selection ?? dependencies.selection(inviteId, user);
      if (
        request.inviteId !== inviteId ||
        dependencies.auth.currentUser !== user ||
        !request.isOwnedBy(user) ||
        (request.user !== null && request.user !== user) ||
        selected !== selection ||
        dependencies.route().mode !== "invite" ||
        dependencies.route().inviteId !== inviteId
      ) {
        request.abort();
        return null;
      }
      initial = null;
      request.cleanup();
      return {
        abort: request.abort,
        promise: request.promise.then((result) => {
          if (request.user !== user || !request.isOwnedBy(user)) {
            throw new Error("initial-game-bootstrap-changed");
          }
          if (request.selection !== selection)
            throw new GameBootstrapApiError(
              "initial-game-bootstrap-selection-changed",
            );
          return result;
        }),
      };
    },
  };
}

export function getInitialGameBootstrapSelection(
  inviteId: string,
  user: Pick<SessionUser, "uid">,
): Selection {
  try {
    return readPendingRematchEnd(
      { inviteId, loginUid: user.uid },
      window.sessionStorage,
    )
      ? "approved"
      : "current";
  } catch {
    return "current";
  }
}

const initialGameBootstrap = createInitialGameBootstrap({
  auth: sessionAuth,
  read: readGameBootstrapViaApi,
  route: getCurrentRouteState,
  subscribeRoute: subscribeToNavigationState,
  selection: getInitialGameBootstrapSelection,
});

export const startInitialGameBootstrap = initialGameBootstrap.start;
export const takeInitialGameBootstrap = initialGameBootstrap.take;
