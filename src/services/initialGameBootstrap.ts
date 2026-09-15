import type { ReadGameBootstrapResponse } from "@mons/shared/game-bootstrap";
import { readPendingRematchEnd } from "../connection/rematchEndDelivery";
import { subscribeToNavigationState } from "../navigation/appNavigation";
import {
  getCurrentRouteState,
  type RouteState,
} from "../navigation/routeState";
import {
  sessionAuth,
  type SessionAuth,
  type SessionUser,
} from "../session/sessionAuth";
import { createUserBoundAuthTokenProvider } from "./authApi";
import { readGameBootstrapViaApi } from "./gameBootstrapApi";

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
  >;
  read: typeof readGameBootstrapViaApi;
  route: () => RouteState;
  subscribeRoute: (listener: (route: RouteState) => void) => () => void;
  selection: (inviteId: string, user: SessionUser) => Selection;
};

export function createInitialGameBootstrap(dependencies: Dependencies) {
  let initial:
    | (InitialGameBootstrap & {
        inviteId: string;
        user: SessionUser | null;
        selection: Selection | null;
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
      const userPromise = ensureUser();
      if (route.mode !== "invite" || !route.inviteId) {
        void userPromise.catch(() => undefined);
        return;
      }
      const inviteId = route.inviteId;
      const controller = new AbortController();
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
        user: null,
        selection: null,
        abort,
        cleanup,
        promise: userPromise
          .then(async (user) => {
            if (
              controller.signal.aborted ||
              !matchesRoute(dependencies.route())
            ) {
              throw new Error("initial-game-bootstrap-canceled");
            }
            request.user = user;
            request.selection = dependencies.selection(inviteId, user);
            const tokenProvider = createUserBoundAuthTokenProvider(
              user,
              () => dependencies.auth.currentUser,
            );
            const result = await dependencies.read(inviteId, tokenProvider, {
              signal: controller.signal,
              selection: request.selection,
            });
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
            abort();
            throw error;
          }),
      };
      initial = request;
      unsubscribeAuth = dependencies.auth.onAuthStateChanged((user) => {
        if (request.user && user !== request.user) abort();
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
          if (request.user !== user || request.selection !== selection) {
            throw new Error("initial-game-bootstrap-changed");
          }
          return result;
        }),
      };
    },
  };
}

export function getInitialGameBootstrapSelection(
  inviteId: string,
  user: SessionUser,
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
