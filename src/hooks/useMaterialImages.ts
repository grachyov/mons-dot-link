import { useEffect, useState } from "react";
import { MATERIAL_KEYS, type MiningMaterialName } from "@mons/shared/mining";
import {
  getCachedMaterialImageUrls,
  getMaterialImageUrl,
  subscribeMaterialImageLoads,
  type MaterialImageUrls,
} from "../resources/materialImageResources";

export const useMaterialImages = (enabled: boolean): MaterialImageUrls => {
  const [urls, setUrls] = useState(getCachedMaterialImageUrls);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const updateUrl = (name: MiningMaterialName, url: string | null) => {
      if (cancelled) return;
      setUrls((current) =>
        current[name] === url ? current : { ...current, [name]: url },
      );
    };
    const unsubscribe = subscribeMaterialImageLoads(updateUrl);
    MATERIAL_KEYS.forEach((name) => {
      void getMaterialImageUrl(name).then((url) => {
        updateUrl(name, url);
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled]);

  return urls;
};
