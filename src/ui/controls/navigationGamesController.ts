import type { NavigationGamesCursor } from "@mons/shared/navigation";
import type { AuthStatus } from "../../connection/authModels";
import type {
  EventNavigationPreviewParticipant,
  NavigationGameItem,
  NavigationItem,
} from "../../connection/connectionModels";
import {
  clearNavigationGamesRuntimeCacheScope,
  readNavigationGamesCacheSnapshot,
  resolveNavigationGamesCacheScope,
  writeNavigationGamesPersistedTopCache,
  writeNavigationGamesRuntimeCache,
} from "../../services/navigationGamesCache";
import { compareNavigationItems } from "../../services/navigationItemOrdering";

const PAGE_SIZE = 80;
const LOAD_MORE_PAGE_SIZE = 50;

type PageCursor = NavigationGamesCursor | null;

type NavigationGamesPage = {
  items: NavigationItem[];
  nextCursor: PageCursor;
  hasMore: boolean;
};

export type NavigationGamesClient = {
  createSessionGuard: () => () => boolean;
  subscribeProfileGames: (
    limit: number,
    onUpdate: (items: NavigationItem[]) => void,
    onError: (error: unknown) => void,
    onPageMeta: (page: NavigationGamesPage) => void,
  ) => () => void;
  getProfileGamesPage: (
    limit: number,
    cursor: PageCursor,
  ) => Promise<NavigationGamesPage>;
  removeWaitingNavigationGame: (
    inviteId: string,
  ) => Promise<{ ok: boolean; skipped?: boolean } | null | undefined>;
};

type NavigationGamesContext = {
  profileId: string;
  authStatus: AuthStatus;
  isOpen: boolean;
};

export type NavigationGamesSnapshot = {
  profileId: string;
  topGames: NavigationItem[];
  pagedGames: NavigationItem[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  removingInviteIds: Set<string>;
};

export const createEmptyNavigationGamesSnapshot = (
  profileId: string,
): NavigationGamesSnapshot => ({
  profileId,
  topGames: [],
  pagedGames: [],
  isLoading: false,
  isLoadingMore: false,
  hasMore: false,
  removingInviteIds: new Set(),
});

export const createNavigationGamesController = ({
  client,
  profileId = "",
  authStatus = "loading",
  isOpen = false,
}: { client: NavigationGamesClient } & Partial<NavigationGamesContext>) => {
  let context: NavigationGamesContext = { profileId, authStatus, isOpen };
  let scope = resolveNavigationGamesCacheScope(profileId);
  let snapshot = createEmptyNavigationGamesSnapshot(profileId);
  let projectedGames: NavigationItem[] = [];
  let pagedGames: NavigationItem[] = [];
  let optimisticPendingAutomatch: NavigationGameItem | null = null;
  let hydrated = false;
  let running = false;
  let profileGeneration = 0;
  let popupGeneration = 0;
  let pageGeneration = 0;
  let pageInFlight = false;
  let cursor: PageCursor = null;
  let unsubscribe: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const removals = new Map<string, object>();

  const publish = (persist = false) => {
    if (
      optimisticPendingAutomatch &&
      [...projectedGames, ...pagedGames].some(
        (item) => item.id === optimisticPendingAutomatch?.id,
      )
    ) {
      optimisticPendingAutomatch = null;
    }
    const isVisible = (item: NavigationItem) =>
      item.entityType !== "game" ||
      item.status !== "waiting" ||
      !snapshot.removingInviteIds.has(item.inviteId);
    const cachedTopGames = hydrated
      ? projectedGames.filter(isVisible).sort(compareNavigationItems)
      : [];
    const topGames = cachedTopGames.slice();
    if (optimisticPendingAutomatch) {
      topGames.push(optimisticPendingAutomatch);
      topGames.sort(compareNavigationItems);
    }
    const topIds = new Set(topGames.map((item) => item.id));
    const uniquePagedGames = new Map<string, NavigationItem>();
    if (hydrated) {
      pagedGames.forEach((item) => {
        if (!topIds.has(item.id)) uniquePagedGames.set(item.id, item);
      });
    }
    const visiblePagedGames = Array.from(uniquePagedGames.values())
      .filter(isVisible)
      .sort(compareNavigationItems);
    snapshot = { ...snapshot, topGames, pagedGames: visiblePagedGames };
    if (persist && hydrated && scope) {
      writeNavigationGamesRuntimeCache(
        scope,
        cachedTopGames,
        visiblePagedGames,
      );
      writeNavigationGamesPersistedTopCache(scope, cachedTopGames, PAGE_SIZE);
    }
    listeners.forEach((listener) => listener());
  };

  const createProfileRequestGuard = () => {
    const generation = profileGeneration;
    const sessionGuard = client.createSessionGuard();
    return () => running && generation === profileGeneration && sessionGuard();
  };

  const stopPopup = () => {
    popupGeneration += 1;
    pageGeneration += 1;
    pageInFlight = false;
    const stop = unsubscribe;
    unsubscribe = null;
    stop?.();
    snapshot = { ...snapshot, isLoading: false, isLoadingMore: false };
  };

  const hydrateFromCache = () => {
    const cached = readNavigationGamesCacheSnapshot(scope);
    projectedGames = cached.topGames;
    pagedGames = cached.pagedGames;
    hydrated = scope !== null;
    publish(true);
    return {
      hasHydratedPagedGames: pagedGames.length > 0,
      hasProfileScope: !!scope,
    };
  };

  const requestPage = (nextCursor: NavigationGamesCursor, warm: boolean) => {
    const popup = popupGeneration;
    const generation = ++pageGeneration;
    const isProfileCurrent = createProfileRequestGuard();
    const isCurrent = () =>
      popup === popupGeneration &&
      generation === pageGeneration &&
      isProfileCurrent();
    pageInFlight = true;
    if (!warm) {
      snapshot = { ...snapshot, isLoadingMore: true };
      publish();
    }
    void client
      .getProfileGamesPage(LOAD_MORE_PAGE_SIZE, nextCursor)
      .then((page) => {
        if (!isCurrent()) return;
        const uniqueById = new Map<string, NavigationItem>();
        if (warm) {
          const topIds = new Set(snapshot.topGames.map((item) => item.id));
          page.items.forEach((item) => {
            if (!topIds.has(item.id)) uniqueById.set(item.id, item);
          });
          if (page.hasMore) {
            pagedGames.forEach((item) => {
              if (!topIds.has(item.id) && !uniqueById.has(item.id)) {
                uniqueById.set(item.id, item);
              }
            });
          }
        } else {
          pagedGames.forEach((item) => uniqueById.set(item.id, item));
          page.items.forEach((item) => uniqueById.set(item.id, item));
        }
        pagedGames = Array.from(uniqueById.values());
        cursor = page.nextCursor;
        snapshot = { ...snapshot, hasMore: page.hasMore };
        publish(true);
      })
      .catch(() => {
        if (!isCurrent() || warm) return;
        snapshot = { ...snapshot, hasMore: false };
        publish();
      })
      .finally(() => {
        if (popup !== popupGeneration || generation !== pageGeneration) return;
        pageInFlight = false;
        snapshot = { ...snapshot, isLoadingMore: false };
        publish();
      });
  };

  const startPopup = () => {
    const { hasHydratedPagedGames, hasProfileScope } = hydrateFromCache();
    if (!hasProfileScope) return;
    const popup = popupGeneration;
    const isProfileCurrent = createProfileRequestGuard();
    const isPopupCurrent = () => running && popup === popupGeneration;
    let didAttemptWarmRefresh = false;
    const stopLoading = () => {
      snapshot = { ...snapshot, isLoading: false };
      publish();
    };
    const onError = () => {
      if (!isPopupCurrent()) return;
      if (!isProfileCurrent()) {
        pageInFlight = false;
        snapshot = { ...snapshot, isLoading: false, isLoadingMore: false };
        publish();
        return;
      }
      stopPopup();
      cursor = null;
      snapshot = { ...snapshot, hasMore: false };
      publish();
    };
    snapshot = { ...snapshot, isLoading: true };
    publish();
    try {
      const stop = client.subscribeProfileGames(
        PAGE_SIZE,
        (items) => {
          if (!isPopupCurrent()) return;
          if (!isProfileCurrent()) {
            stopLoading();
            return;
          }
          projectedGames = items;
          snapshot = { ...snapshot, isLoading: false };
          publish(true);
        },
        onError,
        (page) => {
          if (!isPopupCurrent()) return;
          if (!isProfileCurrent()) {
            stopLoading();
            return;
          }
          if (!page.hasMore) {
            pagedGames = [];
            cursor = page.nextCursor;
            snapshot = { ...snapshot, hasMore: false };
          } else if (snapshot.pagedGames.length === 0) {
            cursor = page.nextCursor;
            snapshot = { ...snapshot, hasMore: true };
          } else {
            cursor ??= page.nextCursor;
            snapshot = { ...snapshot, hasMore: true };
          }
          publish(true);
          if (
            page.hasMore &&
            page.nextCursor &&
            hasHydratedPagedGames &&
            !didAttemptWarmRefresh &&
            !pageInFlight
          ) {
            didAttemptWarmRefresh = true;
            requestPage(page.nextCursor, true);
          }
        },
      );
      if (isPopupCurrent()) unsubscribe = stop;
      else stop();
    } catch {
      onError();
    }
  };

  const setContext = (next: NavigationGamesContext) => {
    const profileChanged = context.profileId !== next.profileId;
    if (
      running &&
      !profileChanged &&
      context.authStatus === next.authStatus &&
      context.isOpen === next.isOpen
    )
      return;
    stopPopup();
    if (profileChanged) {
      if (scope) clearNavigationGamesRuntimeCacheScope(scope.scopeKey);
      profileGeneration += 1;
      scope = resolveNavigationGamesCacheScope(next.profileId);
      projectedGames = [];
      pagedGames = [];
      optimisticPendingAutomatch = null;
      hydrated = false;
      removals.clear();
      cursor = null;
      snapshot = createEmptyNavigationGamesSnapshot(next.profileId);
    }
    context = next;
    running = true;
    if (next.isOpen) {
      startPopup();
    } else {
      cursor = null;
      snapshot = { ...snapshot, hasMore: false, removingInviteIds: new Set() };
      publish(true);
    }
  };

  const loadMore = () => {
    if (
      !running ||
      !context.isOpen ||
      !snapshot.hasMore ||
      snapshot.isLoading ||
      pageInFlight
    )
      return;
    if (!cursor) {
      snapshot = { ...snapshot, hasMore: false };
      publish();
      return;
    }
    requestPage(cursor, false);
  };

  const removeWaitingGame = (inviteId: string) => {
    if (!running || !scope || !inviteId || removals.has(inviteId)) return;
    const isProfileCurrent = createProfileRequestGuard();
    const operation = {};
    removals.set(inviteId, operation);
    snapshot = {
      ...snapshot,
      removingInviteIds: new Set([...snapshot.removingInviteIds, inviteId]),
    };
    publish(true);
    const finish = (removed: boolean) => {
      if (removals.get(inviteId) !== operation) return;
      removals.delete(inviteId);
      if (!isProfileCurrent()) return;
      if (removed) {
        const keep = (item: NavigationItem) =>
          item.entityType !== "game" ||
          item.inviteId !== inviteId ||
          item.status !== "waiting";
        projectedGames = projectedGames.filter(keep);
        pagedGames = pagedGames.filter(keep);
      }
      const removingInviteIds = new Set(snapshot.removingInviteIds);
      removingInviteIds.delete(inviteId);
      snapshot = { ...snapshot, removingInviteIds };
      publish(true);
    };
    void client.removeWaitingNavigationGame(inviteId).then(
      (result) => finish(!!result?.ok && !result.skipped),
      () => finish(false),
    );
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setContext,
    hydrateFromCache,
    loadMore,
    removeWaitingGame,
    createProfileRequestGuard,
    setOptimisticPendingAutomatch: (item: NavigationGameItem | null) => {
      if (!running) return;
      optimisticPendingAutomatch = item;
      publish();
    },
    getEventParticipantPreview: (
      eventId: string,
    ): EventNavigationPreviewParticipant[] => {
      const id = `event_${eventId}`;
      const visible = [...snapshot.topGames, ...snapshot.pagedGames].find(
        (item) => item.entityType === "event" && item.id === id,
      );
      const cached = visible ? null : readNavigationGamesCacheSnapshot(scope);
      const item =
        visible ??
        [...(cached?.topGames ?? []), ...(cached?.pagedGames ?? [])].find(
          (entry) => entry.entityType === "event" && entry.id === id,
        );
      return item?.entityType === "event"
        ? item.participantPreview.slice()
        : [];
    },
    dispose: () => {
      running = false;
      profileGeneration += 1;
      stopPopup();
      optimisticPendingAutomatch = null;
      removals.clear();
      cursor = null;
      snapshot = { ...snapshot, hasMore: false, removingInviteIds: new Set() };
      publish();
    },
  };
};
