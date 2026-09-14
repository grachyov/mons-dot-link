import { MATERIAL_KEYS, type MiningMaterialName } from "@mons/shared/mining";
import { createCachedResource } from "./cachedResource";

export type MaterialImageUrls = Record<MiningMaterialName, string | null>;

type MaterialImageListener = (name: MiningMaterialName, url: string) => void;

const listeners = new Set<MaterialImageListener>();
const pendingNotifications = new Set<MiningMaterialName>();

const materialImageResources = new Map(
  MATERIAL_KEYS.map((name) => [
    name,
    createCachedResource<string>(
      async () => {
        const response = await fetch(
          `https://cdn.lil.org/mons/rocks/materials/${name}.webp`,
        );
        if (!response.ok) {
          throw new Error("Failed to fetch material image");
        }
        return URL.createObjectURL(await response.blob());
      },
      () => {},
    ),
  ]),
);

export const getCachedMaterialImageUrl = (
  name: MiningMaterialName,
): string | null => materialImageResources.get(name)!.getCachedValue();

export const getMaterialImageUrl = (
  name: MiningMaterialName,
): Promise<string | null> => {
  const resource = materialImageResources.get(name)!;
  const promise = resource.load();
  if (resource.getCachedValue() === null && !pendingNotifications.has(name)) {
    pendingNotifications.add(name);
    void promise.then((url) => {
      pendingNotifications.delete(name);
      if (url !== null) {
        listeners.forEach((listener) => listener(name, url));
      }
    });
  }
  return promise;
};

export const subscribeMaterialImageLoads = (
  listener: MaterialImageListener,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getCachedMaterialImageUrls = (): MaterialImageUrls =>
  Object.fromEntries(
    MATERIAL_KEYS.map((name) => [name, getCachedMaterialImageUrl(name)]),
  ) as MaterialImageUrls;
