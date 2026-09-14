import { useCallback, useEffect, useState } from "react";
import type { AuthState } from "../../connection/authModels";
import { getImageResource } from "../../resources/imageResources";
import {
  fetchNftsForIdentity,
  getNftIdentityKey,
} from "../../services/nftService";
import { storage } from "../../utils/storage";
import {
  canSendSticker as canSendEntitledSticker,
  EMPTY_STICKER_ENTITLEMENT,
  getStickerPickerState,
  getStickerRefreshResult,
  preferNewerStickerEntitlement,
  retainStickerEntitlementForOwner,
  toUsableStickerEntitlement,
  type StickerEntitlementState,
} from "./reactionPickerModel";

export const STICKER_IMAGE_BASE_URL =
  "https://cdn.lil.org/mons/emojipack/swagpack/64";

const getStoredStickerOwnerKey = (): string | null =>
  getNftIdentityKey(storage.getAuthIdentity());

export const useReactionPicker = ({
  authState,
  isOpen,
}: {
  authState: AuthState;
  isOpen: boolean;
}) => {
  const [entitlement, setEntitlement] = useState<StickerEntitlementState>(
    EMPTY_STICKER_ENTITLEMENT,
  );
  const [stickerUrls, setStickerUrls] = useState<Record<number, string | null>>(
    {},
  );
  const ownerKey =
    authState.authStatus === "authenticated"
      ? getNftIdentityKey(authState)
      : null;
  const { visibleStickerIds, hasFreshStickerEntitlement } =
    getStickerPickerState(entitlement, ownerKey, Date.now());

  useEffect(() => {
    if (!isOpen) return;
    if (ownerKey === null || getStoredStickerOwnerKey() !== ownerKey) {
      setEntitlement(EMPTY_STICKER_ENTITLEMENT);
      return;
    }
    let isCancelled = false;
    const cachedEntitlement = toUsableStickerEntitlement(
      storage.getReactionExtraStickerCache(null),
      ownerKey,
      Date.now(),
    );
    setEntitlement((current) =>
      cachedEntitlement
        ? preferNewerStickerEntitlement(current, cachedEntitlement)
        : retainStickerEntitlementForOwner(current, ownerKey),
    );
    const refresh = async () => {
      try {
        const snapshot = await fetchNftsForIdentity(authState);
        if (isCancelled) return;
        const result = getStickerRefreshResult({
          snapshot,
          authState,
          storedOwnerKey: getStoredStickerOwnerKey(),
          cache: storage.getReactionExtraStickerCache(null),
          now: Date.now(),
        });
        if (!result) return;
        setEntitlement((current) =>
          preferNewerStickerEntitlement(current, result.entitlement),
        );
        if (result.cacheToWrite) {
          storage.setReactionExtraStickerCache(result.cacheToWrite);
        }
      } catch {}
    };
    void refresh();
    return () => {
      isCancelled = true;
    };
  }, [authState, isOpen, ownerKey]);

  useEffect(() => {
    setEntitlement((current) =>
      retainStickerEntitlementForOwner(current, ownerKey),
    );
  }, [ownerKey]);

  useEffect(() => {
    if (!isOpen) return;
    let isCancelled = false;
    visibleStickerIds.forEach((id) => {
      void getImageResource(`${STICKER_IMAGE_BASE_URL}/${id}.webp`)
        .load()
        .then((url) => {
          if (isCancelled) return;
          setStickerUrls((current) =>
            current[id] === url ? current : { ...current, [id]: url },
          );
        });
    });
    return () => {
      isCancelled = true;
    };
  }, [isOpen, visibleStickerIds]);

  const canSendSticker = useCallback(
    (stickerId: number) =>
      canSendEntitledSticker(
        stickerId,
        entitlement,
        ownerKey,
        getStoredStickerOwnerKey,
        Date.now(),
      ),
    [entitlement, ownerKey],
  );

  return {
    visibleStickerIds,
    hasFreshStickerEntitlement,
    stickerUrls,
    canSendSticker,
  };
};
