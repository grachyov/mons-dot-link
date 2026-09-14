import { VALID_REACTION_IDS } from "@mons/shared/nfts";
import { FIXED_STICKER_IDS } from "@mons/shared/reactions";
import type { AuthState } from "../../connection/authModels";
import {
  getNftIdentityKey,
  NFT_CACHE_TTL_MS,
  type NftFetchSnapshot,
} from "../../services/nftService";
import type { ReactionExtraStickerCache } from "../../utils/storage";

export type StickerEntitlementState = {
  stickerIds: readonly number[];
  ownerKey: string | null;
  expiresAtMs: number;
};

export const EMPTY_STICKER_ENTITLEMENT: StickerEntitlementState = {
  stickerIds: FIXED_STICKER_IDS,
  ownerKey: null,
  expiresAtMs: 0,
};

const normalizeStickerIds = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (id): id is number =>
      typeof id === "number" &&
      Number.isSafeInteger(id) &&
      VALID_REACTION_IDS.includes(id),
  );
};

const getSwagpackReactionStickerIds = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  return normalizeStickerIds(
    value.map((item) => (item as { id?: unknown }).id),
  );
};

const mergeStickerIds = (extra: readonly number[]): number[] =>
  Array.from(new Set([...FIXED_STICKER_IDS, ...extra]));

const areStickerIdArraysEqual = (
  left: readonly number[],
  right: readonly number[],
): boolean =>
  left.length === right.length &&
  left.every((id, index) => id === right[index]);

export const toUsableStickerEntitlement = (
  cache: ReactionExtraStickerCache | null,
  expectedOwnerKey: string,
  now: number,
): StickerEntitlementState | null => {
  if (
    !cache ||
    getNftIdentityKey(cache) !== expectedOwnerKey ||
    !(cache.expiresAtMs > now && cache.expiresAtMs <= now + NFT_CACHE_TTL_MS)
  ) {
    return null;
  }
  return {
    stickerIds: mergeStickerIds(normalizeStickerIds(cache.extraIds)),
    ownerKey: expectedOwnerKey,
    expiresAtMs: cache.expiresAtMs,
  };
};

export const retainStickerEntitlementForOwner = (
  current: StickerEntitlementState,
  ownerKey: string | null,
): StickerEntitlementState =>
  current.ownerKey === null || current.ownerKey === ownerKey
    ? current
    : EMPTY_STICKER_ENTITLEMENT;

export const preferNewerStickerEntitlement = (
  current: StickerEntitlementState,
  next: StickerEntitlementState,
): StickerEntitlementState =>
  current.ownerKey === next.ownerKey && current.expiresAtMs > next.expiresAtMs
    ? current
    : next;

export const getStickerPickerState = (
  entitlement: StickerEntitlementState,
  ownerKey: string | null,
  now: number,
) => {
  const hasCurrentOwner =
    ownerKey !== null && entitlement.ownerKey === ownerKey;
  return {
    visibleStickerIds: hasCurrentOwner
      ? entitlement.stickerIds
      : FIXED_STICKER_IDS,
    hasFreshStickerEntitlement:
      hasCurrentOwner && entitlement.expiresAtMs > now,
  };
};

export const canSendSticker = (
  stickerId: number,
  entitlement: StickerEntitlementState,
  ownerKey: string | null,
  getStoredOwnerKey: () => string | null,
  now: number,
): boolean =>
  FIXED_STICKER_IDS.includes(stickerId) ||
  (ownerKey !== null &&
    entitlement.ownerKey === ownerKey &&
    entitlement.expiresAtMs > now &&
    entitlement.stickerIds.includes(stickerId) &&
    getStoredOwnerKey() === ownerKey);

export const getStickerRefreshResult = ({
  snapshot,
  authState,
  storedOwnerKey,
  cache,
  now,
}: {
  snapshot: NftFetchSnapshot;
  authState: AuthState;
  storedOwnerKey: string | null;
  cache: ReactionExtraStickerCache | null;
  now: number;
}): {
  entitlement: StickerEntitlementState;
  cacheToWrite: ReactionExtraStickerCache | null;
} | null => {
  const ownerKey =
    authState.authStatus === "authenticated"
      ? getNftIdentityKey(authState)
      : null;
  const { data, expiresAtMs } = snapshot;
  if (
    ownerKey === null ||
    storedOwnerKey !== ownerKey ||
    data.ok !== true ||
    expiresAtMs <= now
  ) {
    return null;
  }
  const cachedEntitlement = toUsableStickerEntitlement(cache, ownerKey, now);
  if (cachedEntitlement && cachedEntitlement.expiresAtMs > expiresAtMs) {
    return { entitlement: cachedEntitlement, cacheToWrite: null };
  }
  const extraIds = getSwagpackReactionStickerIds(data.swagpack_reactions);
  const shouldWriteCache =
    !cachedEntitlement ||
    cachedEntitlement.expiresAtMs !== expiresAtMs ||
    !areStickerIdArraysEqual(normalizeStickerIds(cache?.extraIds), extraIds);
  return {
    entitlement: {
      stickerIds: mergeStickerIds(extraIds),
      ownerKey,
      expiresAtMs,
    },
    cacheToWrite: shouldWriteCache
      ? {
          profileId: authState.profileId,
          ethAddress: authState.ethAddress,
          solAddress: authState.solAddress,
          extraIds,
          expiresAtMs,
        }
      : null,
  };
};
