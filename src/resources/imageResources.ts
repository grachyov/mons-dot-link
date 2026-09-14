import { createCachedResource, type CachedResource } from "./cachedResource";

const imageResources = new Map<string, CachedResource<string>>();

export const getImageResource = (url: string): CachedResource<string> => {
  let resource = imageResources.get(url);
  if (!resource) {
    resource = createCachedResource<string>(
      async () => {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error("Failed to fetch image");
        }
        return URL.createObjectURL(await response.blob());
      },
      () => {},
    );
    imageResources.set(url, resource);
  }
  return resource;
};
