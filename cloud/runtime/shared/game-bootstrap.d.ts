import type {
  InviteMetadataSnapshot,
  InviteMetadataViewer,
} from "./invite-metadata";
import type { MatchSyncSnapshot } from "./match-sync";

export type ReadGameBootstrapResponse = {
  ok: true;
  schemaVersion: 1;
  metadata: InviteMetadataSnapshot;
  viewer: InviteMetadataViewer;
  match: MatchSyncSnapshot;
  hasPendingProposal: boolean;
};

export const GAME_BOOTSTRAP_MAX_RESPONSE_BYTES: number;

export function isReadGameBootstrapResponse(
  value: unknown,
): value is ReadGameBootstrapResponse;
