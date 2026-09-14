import {
  MATERIAL_KEYS,
  normalizeMiningSnapshot,
  type MiningSnapshot,
} from "@mons/shared/mining";
import {
  CanonicalProfileConflict,
  readCanonicalProfileOwnershipSnapshot,
  resolveCanonicalProfile,
} from "./profileCanonicalD1.ts";
import {
  commitCanonicalProfileUpdate,
  materializeCanonicalProfileUpdate,
} from "./profileMutationD1.ts";
import type { ProfileOwnershipReader } from "./profileOwnership.ts";
import { mapCanonicalOwnershipSnapshot } from "./profileOwnershipMapping.ts";

export type MiningProfile = {
  readonly mining: MiningSnapshot;
  readonly profileId: string;
  commitMining: (mining: MiningSnapshot) => Promise<"conflict" | "updated">;
};

export type MiningRepository = ProfileOwnershipReader & {
  getProfileSnapshot: (profileId: string) => Promise<MiningProfile | null>;
};

type MiningRepositoryDependencies = {
  d1?: D1Database;
  now?: () => number;
};

export function createMiningRepository(
  env: Env,
  { d1 = env.PROFILE_DB, now = Date.now }: MiningRepositoryDependencies = {},
): MiningRepository {
  return {
    async readProfileOwnershipSnapshot(query) {
      return mapCanonicalOwnershipSnapshot(
        await readCanonicalProfileOwnershipSnapshot(d1, query),
      );
    },

    async getProfileSnapshot(profileId) {
      const profile = await resolveCanonicalProfile(d1, profileId);
      if (!profile || profile.state !== "active") return null;
      return {
        profileId: profile.profileId,
        mining: normalizeMiningSnapshot(profile.profile.mining),
        async commitMining(mining) {
          const value = materializeCanonicalProfileUpdate(
            profile,
            { ...profile.profile, mining },
            now(),
            {
              sortUpdates: Object.fromEntries(
                MATERIAL_KEYS.map((key) => [key, mining.materials[key]]),
              ),
            },
          );
          try {
            await commitCanonicalProfileUpdate(d1, profile, value);
            return "updated";
          } catch (error) {
            if (error instanceof CanonicalProfileConflict) return "conflict";
            throw error;
          }
        },
      };
    },
  };
}
