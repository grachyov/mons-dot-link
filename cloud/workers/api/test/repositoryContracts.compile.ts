import type { EventMutation } from "../../../runtime/eventCommands.js";
import type { GameSessionChange } from "../../../runtime/gameSessionChanges.js";
import type { EventStore } from "../src/eventStoreContracts.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import type { MatchStatePort } from "../src/repositoryContracts.ts";
import type { WagerKey } from "../src/wagerStateRepository.ts";
import type { TelegramStorage } from "../../../runtime/telegram/repositoryCore.js";

type Assert<T extends true> = T;
type Rejects<Value, Contract> = Value extends Contract ? false : true;
type RetiredMethod =
  | "getPath"
  | "patchRoot"
  | "transactPath"
  | "getStatePath"
  | "patchStateRoot"
  | "transactStatePath"
  | "replacePaths";

export type DomainPortsHaveNoPathMethods = Assert<
  Extract<
    keyof EventStore | keyof GameplayRepository | keyof TelegramStorage,
    RetiredMethod
  > extends never
    ? true
    : false
>;
export type MatchMethodsAreRequired = Assert<
  MatchStatePort extends Required<MatchStatePort> ? true : false
>;
export type InvalidEventStatusIsRejected = Assert<
  Rejects<
    { kind: "event-field"; eventId: "event"; field: "status"; value: 123 },
    EventMutation
  >
>;
export type UnknownEventFieldIsRejected = Assert<
  Rejects<
    { kind: "event-field"; eventId: "event"; field: "arbitrary"; value: true },
    EventMutation
  >
>;
export type ArbitrarySessionPathIsRejected = Assert<
  Rejects<
    { kind: "patch"; path: "invites/invite/guestId"; value: "guest" },
    GameSessionChange
  >
>;
export type WagerIdentityRequiresMatch = Assert<
  Rejects<{ inviteId: "invite" }, WagerKey>
>;
