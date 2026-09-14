import type {
  CanonicalAuthMethodSnapshot,
  CanonicalLoginOwnerSnapshot,
  CanonicalProfileAggregateSnapshot,
  CanonicalProfileSnapshot,
} from "../profileCanonicalD1.ts";

export type CanonicalIdentityProfile = {
  aggregate: CanonicalProfileAggregateSnapshot;
  owner: CanonicalLoginOwnerSnapshot | null;
  profile: CanonicalProfileSnapshot;
};

export type RepairedVerifiedCaller = {
  identity: CanonicalIdentityProfile;
  method: CanonicalAuthMethodSnapshot;
};

export type CanonicalIdentityReads = {
  identityByProfile: (
    profileId: string,
  ) => Promise<CanonicalIdentityProfile | null>;
  profileByLogin: (uid: string) => Promise<CanonicalIdentityProfile | null>;
};
