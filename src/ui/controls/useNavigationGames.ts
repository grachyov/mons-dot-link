import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { AuthStatus } from "../../connection/authModels";
import {
  createEmptyNavigationGamesSnapshot,
  createNavigationGamesController,
  type NavigationGamesClient,
} from "./navigationGamesController";

export const useNavigationGames = ({
  profileId,
  authStatus,
  isOpen,
  client,
}: {
  profileId: string;
  authStatus: AuthStatus;
  isOpen: boolean;
  client: NavigationGamesClient;
}) => {
  const controller = useMemo(
    () => createNavigationGamesController({ client }),
    [client],
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const emptySnapshot = useMemo(
    () => createEmptyNavigationGamesSnapshot(profileId),
    [profileId],
  );
  const visibleSnapshot =
    snapshot.profileId === profileId ? snapshot : emptySnapshot;

  useLayoutEffect(() => () => controller.dispose(), [controller]);
  useLayoutEffect(() => {
    controller.setContext({ profileId, authStatus, isOpen });
  }, [controller, profileId, authStatus, isOpen]);

  const getEventParticipantPreview = useCallback(
    (eventId: string) =>
      snapshot.profileId === profileId
        ? controller.getEventParticipantPreview(eventId)
        : [],
    [controller, profileId, snapshot],
  );

  return {
    ...visibleSnapshot,
    hydrateFromCache: controller.hydrateFromCache,
    // NavigationPicker rechecks blocked auto-load attempts when this callback changes.
    loadMore: () => controller.loadMore(),
    removeWaitingGame: controller.removeWaitingGame,
    setOptimisticPendingAutomatch: controller.setOptimisticPendingAutomatch,
    createProfileRequestGuard: controller.createProfileRequestGuard,
    getEventParticipantPreview,
  };
};
