import {
  isMaterialName,
  normalizeCount,
  type MiningMaterialName,
} from "@mons/shared/mining";
import type { WagerAgreement } from "@mons/shared/wagers";
import type { TransactionDecision } from "./repositoryContracts.ts";

export type WagerKey = { inviteId: string; matchId: string };
export type WagerRecord = Record<string, unknown>;
export type ModernProposalLineage = {
  count: number;
  material: MiningMaterialName;
  operationId: string;
  reservationOperationId: string;
};
type WagerProposalTransition = {
  decision: "replayed" | "unavailable" | "write";
  value?: WagerRecord;
};
export type SendWagerProposalCommand = {
  material: MiningMaterialName;
  now: number;
  opponentAdjustmentOperationId: string;
  opponentProposal: ModernProposalLineage | null;
  operationId: string;
  opponentUid: string;
  playerUid: string;
  reservationOperationId: string;
  reservedCount: number;
  selfAdjustmentOperationId: string;
};
export type AcceptWagerProposalCommand = {
  playerUid: string;
  opponentUid: string;
  operationId: string;
  material: MiningMaterialName;
  proposedCount: number;
  opponentProposalOperationId: string;
  opponentReservationOperationId: string;
  hasOwnProposal: boolean;
  ownMaterial: string;
  ownCount: number;
  ownProposalOperationId: string;
  ownReservationOperationId: string;
  acceptedCount: number;
  now: number;
  proposerAdjustmentOperationId: string;
  reservationOperationId: string;
};
export type RemoveWagerProposalCommand = {
  proposalUid: string;
  operationId: string;
  expectedReservationOperationId: string;
};
export type MarkWagerLineageReadyCommand = {
  operationId: string;
  fingerprint: string;
};
export type WagerSettlementResolution = {
  loserProfileId: string;
  loserUid: string;
  winnerProfileId: string;
  winnerUid: string;
};
export type ClaimWagerSettlementCommand = {
  resolution: WagerSettlementResolution;
  operationId: string;
  now: number;
  acceptReservationOperationIdByUid: Readonly<Record<string, string>>;
};
export type CompleteWagerSettlementCommand = {
  settlement: WagerSettlement;
  completedAtMs: number;
  insufficientMaterials: boolean;
};
function toRecord(value: unknown): WagerRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WagerRecord)
    : null;
}
function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function validOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
const SETTLEMENT_VERSION = 2;
export const WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON =
  "insufficient-materials";

type WagerSettlementFailureReason =
  typeof WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON;

export type SettlementRelease = {
  reservationOperationIds: string[];
  uid: string;
};

type SettlementBase = {
  claimedAtMs: number;
  completedAtMs: number | null;
  failureReason: WagerSettlementFailureReason | null;
  fingerprint: string;
  operationId: string;
  state: "completed" | "pending";
  version: typeof SETTLEMENT_VERSION;
};

type AgreedSettlement = SettlementBase & {
  count: number;
  kind: "agreed";
  loserProfileId: string;
  loserUid: string;
  material: MiningMaterialName;
  releases: SettlementRelease[];
  winnerProfileId: string;
  winnerUid: string;
};

type ProposalSettlement = SettlementBase & {
  kind: "proposals";
  releases: SettlementRelease[];
};

export type WagerSettlement = AgreedSettlement | ProposalSettlement;

function withoutReady(value: unknown): Record<string, unknown> {
  const operation = toRecord(value);
  const { reservationLineageReady: _ready, ...rest } = operation || {};
  return rest;
}

export function lineageFingerprint(value: unknown): string {
  const wager = toRecord(value);
  return JSON.stringify([
    wager?.agreed,
    withoutReady(wager?.agreementOperation),
  ]);
}

export function transitionWagerProposal(
  current: unknown,
  input: {
    material: MiningMaterialName;
    now: number;
    opponentAdjustmentOperationId: string;
    opponentProposal: ModernProposalLineage | null;
    operationId: string;
    opponentUid: string;
    playerUid: string;
    reservationOperationId: string;
    reservedCount: number;
    selfAdjustmentOperationId: string;
  },
): WagerProposalTransition {
  const wager = toRecord(current) || {};
  const agreement = toRecord(wager.agreed);
  const agreementOperation = toRecord(wager.agreementOperation);
  if (
    agreementOperation?.id === input.operationId &&
    agreement?.accepterId === input.playerUid
  ) {
    return { decision: "replayed" };
  }
  const proposals = { ...(toRecord(wager.proposals) || {}) };
  const ownProposal = toRecord(proposals[input.playerUid]);
  if (ownProposal?.operationId === input.operationId) {
    return { decision: "replayed" };
  }
  if (wager.resolved || wager.agreed || wager.settlement) {
    return { decision: "unavailable" };
  }
  const proposedBy = { ...(toRecord(wager.proposedBy) || {}) };
  if (proposals[input.playerUid] || proposedBy[input.playerUid]) {
    return { decision: "unavailable" };
  }
  const opponentProposal = toRecord(proposals[input.opponentUid]);
  const opponentCount = normalizeCount(opponentProposal?.count);
  if (
    opponentProposal &&
    opponentProposal.material === input.material &&
    opponentCount > 0
  ) {
    if (
      !input.opponentProposal ||
      input.opponentProposal.material !== input.material ||
      input.opponentProposal.count !== opponentCount ||
      opponentProposal.operationId !== input.opponentProposal.operationId ||
      opponentProposal.reservationOperationId !==
        input.opponentProposal.reservationOperationId
    ) {
      return { decision: "unavailable" };
    }
    const acceptedCount = Math.min(input.reservedCount, opponentCount);
    if (acceptedCount <= 0) {
      return { decision: "unavailable" };
    }
    const agreement: WagerAgreement = {
      material: input.material,
      count: acceptedCount,
      total: acceptedCount * 2,
      proposerId: input.opponentUid,
      accepterId: input.playerUid,
      acceptedAt: input.now,
    };
    proposedBy[input.playerUid] = true;
    const opponentReservationOperationId =
      input.opponentProposal.reservationOperationId;
    const opponentOperationId = input.opponentProposal.operationId;
    const reservationAdjustments = [
      ...(acceptedCount !== input.reservedCount
        ? [
            {
              uid: input.playerUid,
              operationId: input.selfAdjustmentOperationId,
              kind: "send-self-adjustment",
              material: input.material,
              delta: acceptedCount - input.reservedCount,
            },
          ]
        : []),
      ...(acceptedCount !== opponentCount
        ? [
            {
              uid: input.opponentUid,
              operationId: input.opponentAdjustmentOperationId,
              kind: "send-proposer-adjustment",
              material: input.material,
              delta: acceptedCount - opponentCount,
            },
          ]
        : []),
    ];
    return {
      decision: "write",
      value: {
        ...wager,
        proposals: null,
        proposedBy,
        agreed: agreement,
        agreementOperation: {
          id: input.operationId,
          proposerOperationId: opponentOperationId,
          proposerReservedCount: opponentCount,
          reservationLineageVersion: 1,
          reservationLineageReady: reservationAdjustments.length === 0,
          ...(reservationAdjustments.length > 0
            ? { reservationAdjustments }
            : {}),
          accepterReservationOperationIds: [
            input.selfAdjustmentOperationId,
            input.reservationOperationId,
          ],
          proposerReservationOperationIds: [
            input.opponentAdjustmentOperationId,
            opponentReservationOperationId,
          ],
        },
      },
    };
  }
  proposals[input.playerUid] = {
    material: input.material,
    count: input.reservedCount,
    createdAt: input.now,
    operationId: input.operationId,
    reservationOperationId: input.reservationOperationId,
  };
  proposedBy[input.playerUid] = true;
  return {
    decision: "write",
    value: { ...wager, proposals, proposedBy },
  };
}

export function sendProposalDecision(
  current: unknown,
  input: SendWagerProposalCommand,
): TransactionDecision<WagerRecord> {
  const transition = transitionWagerProposal(current, input);
  return transition.decision === "write"
    ? { value: transition.value! }
    : { commit: false, decision: transition.decision };
}
export function acceptProposalDecision(
  current: unknown,
  input: AcceptWagerProposalCommand,
): TransactionDecision<WagerRecord> {
  const {
    playerUid,
    opponentUid,
    operationId,
    material,
    proposedCount,
    opponentProposalOperationId,
    opponentReservationOperationId,
    hasOwnProposal,
    ownMaterial,
    ownCount,
    ownProposalOperationId,
    ownReservationOperationId,
    acceptedCount,
    now,
    proposerAdjustmentOperationId,
    reservationOperationId,
  } = input;

  const currentWager = toRecord(current);
  const existingOperation = toRecord(currentWager?.agreementOperation);
  const existingAgreement = toRecord(currentWager?.agreed);
  if (
    existingOperation?.id === operationId &&
    existingAgreement?.accepterId === playerUid
  ) {
    return { commit: false, decision: "replayed" };
  }
  if (
    !currentWager ||
    currentWager.resolved ||
    currentWager.agreed ||
    currentWager.settlement
  ) {
    return { commit: false, decision: "proposal-unavailable" };
  }
  const currentProposals = toRecord(currentWager.proposals) || {};
  const currentOpponentProposal = toRecord(currentProposals[opponentUid]);
  const currentOwnProposal = toRecord(currentProposals[playerUid]);
  const opponentMatches =
    currentOpponentProposal?.material === material &&
    normalizeCount(currentOpponentProposal.count) === proposedCount &&
    normalizeString(currentOpponentProposal.operationId) ===
      opponentProposalOperationId &&
    normalizeString(currentOpponentProposal.reservationOperationId) ===
      opponentReservationOperationId;
  const ownMatches = hasOwnProposal
    ? currentOwnProposal?.material === ownMaterial &&
      normalizeCount(currentOwnProposal.count) === ownCount &&
      normalizeString(currentOwnProposal.operationId) ===
        ownProposalOperationId &&
      normalizeString(currentOwnProposal.reservationOperationId) ===
        ownReservationOperationId
    : !currentOwnProposal;
  if (!opponentMatches || !ownMatches) {
    return { commit: false, decision: "proposal-unavailable" };
  }
  const agreement: WagerAgreement = {
    material,
    count: acceptedCount,
    total: acceptedCount * 2,
    proposerId: opponentUid,
    accepterId: playerUid,
    acceptedAt: now,
  };
  const reservationAdjustments =
    acceptedCount !== proposedCount
      ? [
          {
            uid: opponentUid,
            operationId: proposerAdjustmentOperationId,
            kind: "accept-proposer-adjustment",
            material,
            delta: acceptedCount - proposedCount,
          },
        ]
      : [];
  return {
    value: {
      ...currentWager,
      agreed: agreement,
      proposals: null,
      agreementOperation: {
        id: operationId,
        proposerOperationId: opponentProposalOperationId,
        proposerReservedCount: proposedCount,
        reservationLineageVersion: 1,
        reservationLineageReady: reservationAdjustments.length === 0,
        ...(reservationAdjustments.length > 0
          ? { reservationAdjustments }
          : {}),
        accepterReservationOperationIds: [
          reservationOperationId,
          ...(ownReservationOperationId ? [ownReservationOperationId] : []),
        ],
        proposerReservationOperationIds: [
          proposerAdjustmentOperationId,
          opponentReservationOperationId,
        ],
      },
    },
  };
}
export function removeProposalDecision(
  current: unknown,
  input: RemoveWagerProposalCommand,
): TransactionDecision<WagerRecord> {
  const { proposalUid, operationId, expectedReservationOperationId } = input;

  const wager = toRecord(current);
  const removalOperations = toRecord(wager?.proposalRemovalOperations) || {};
  const replayOperation = toRecord(removalOperations[operationId]);
  if (replayOperation) {
    return replayOperation.reservationOperationId ===
      expectedReservationOperationId &&
      validOperationId(replayOperation.proposalOperationId)
      ? { commit: false, decision: "replayed" }
      : { commit: false, decision: "proposal-invalid" };
  }
  const proposals = toRecord(wager?.proposals);
  const proposal = toRecord(proposals?.[proposalUid]);
  if (
    !wager ||
    wager.agreed ||
    wager.resolved ||
    wager.settlement ||
    !proposals ||
    !proposal
  ) {
    return { commit: false, decision: "proposal-missing" };
  }
  const proposalOperationId = normalizeString(proposal.operationId);
  const reservationOperationId = normalizeString(
    proposal.reservationOperationId,
  );
  if (
    !validOperationId(proposalOperationId) ||
    reservationOperationId !== expectedReservationOperationId
  ) {
    return { commit: false, decision: "proposal-invalid" };
  }
  const nextProposals = { ...proposals };
  delete nextProposals[proposalUid];
  const nextWager = { ...wager };
  if (Object.keys(nextProposals).length > 0) {
    nextWager.proposals = nextProposals;
  } else {
    delete nextWager.proposals;
  }
  nextWager.proposalRemovalOperations = {
    ...removalOperations,
    [operationId]: {
      proposalOperationId,
      reservationOperationId,
    },
  };
  return { value: nextWager };
}
export function markLineageReadyDecision(
  current: unknown,
  input: MarkWagerLineageReadyCommand,
): TransactionDecision<WagerRecord> {
  const { operationId, fingerprint } = input;
  const wager = toRecord(current);
  const agreementOperation = toRecord(wager?.agreementOperation);
  if (
    !wager ||
    !wager.agreed ||
    agreementOperation?.id !== operationId ||
    agreementOperation.reservationLineageVersion !== 1 ||
    lineageFingerprint(wager) !== fingerprint
  ) {
    return { commit: false, decision: "agreement-missing" };
  }
  if (agreementOperation.reservationLineageReady === true) {
    return { commit: false, decision: "agreement-ready" };
  }
  return {
    value: {
      ...wager,
      agreementOperation: {
        ...agreementOperation,
        reservationLineageReady: true,
      },
    },
  };
}
function settlementFingerprint(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function parseReservationOperationIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const operationIds = value.map(normalizeString);
  return operationIds.length > 0 &&
    operationIds.every(
      (operationId, index) =>
        /^[a-f0-9]{64}$/.test(operationId) &&
        operationIds.indexOf(operationId) === index,
    )
    ? operationIds
    : null;
}

function parseRelease(value: unknown): SettlementRelease | null {
  const release = toRecord(value);
  const uid = normalizeString(release?.uid);
  const operationIds = parseReservationOperationIds(
    release?.reservationOperationIds,
  );
  return release &&
    Object.keys(release).length === 2 &&
    Object.hasOwn(release, "uid") &&
    Object.hasOwn(release, "reservationOperationIds") &&
    uid &&
    operationIds
    ? { uid, reservationOperationIds: operationIds }
    : null;
}

function parseSettlement(value: unknown): WagerSettlement | null {
  const settlement = toRecord(value);
  const state = settlement?.state;
  const completedAtMs = settlement?.completedAtMs;
  const failureReason = settlement?.failureReason;
  if (
    settlement?.version !== SETTLEMENT_VERSION ||
    (state !== "pending" && state !== "completed") ||
    typeof settlement.fingerprint !== "string" ||
    !settlement.fingerprint ||
    typeof settlement.operationId !== "string" ||
    !settlement.operationId ||
    !Number.isSafeInteger(settlement.claimedAtMs) ||
    (completedAtMs !== undefined &&
      completedAtMs !== null &&
      !Number.isSafeInteger(completedAtMs)) ||
    (failureReason !== undefined &&
      failureReason !== null &&
      failureReason !== WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON) ||
    (state === "pending" &&
      failureReason !== undefined &&
      failureReason !== null) ||
    (state === "completed" && !Number.isSafeInteger(completedAtMs))
  ) {
    return null;
  }
  const base: SettlementBase = {
    version: SETTLEMENT_VERSION,
    state,
    fingerprint: settlement.fingerprint,
    operationId: settlement.operationId,
    claimedAtMs: Number(settlement.claimedAtMs),
    completedAtMs: Number.isSafeInteger(completedAtMs)
      ? Number(completedAtMs)
      : null,
    failureReason:
      failureReason === WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON
        ? failureReason
        : null,
  };
  if (settlement.kind === "agreed") {
    const winnerUid = normalizeString(settlement.winnerUid);
    const loserUid = normalizeString(settlement.loserUid);
    const winnerProfileId = normalizeString(settlement.winnerProfileId);
    const loserProfileId = normalizeString(settlement.loserProfileId);
    const material = normalizeString(settlement.material);
    const count = normalizeCount(settlement.count);
    const storedReleases = settlement.releases;
    const releases = Array.isArray(storedReleases)
      ? storedReleases.map(parseRelease)
      : [null];
    return winnerUid &&
      loserUid &&
      winnerProfileId &&
      loserProfileId &&
      isMaterialName(material) &&
      count > 0 &&
      releases.length === 2 &&
      releases.every((release) => release !== null)
      ? {
          ...base,
          kind: "agreed",
          winnerUid,
          loserUid,
          winnerProfileId,
          loserProfileId,
          material,
          count,
          releases: releases.filter(
            (release): release is SettlementRelease => release !== null,
          ),
        }
      : null;
  }
  const storedReleases = settlement.releases ?? [];
  if (
    settlement.kind !== "proposals" ||
    !Array.isArray(storedReleases) ||
    base.failureReason
  ) {
    return null;
  }
  const releases = storedReleases.map(parseRelease);
  if (releases.some((release) => release === null)) {
    return null;
  }
  return {
    ...base,
    kind: "proposals",
    releases: releases.filter(
      (release): release is SettlementRelease => release !== null,
    ),
  };
}

export function readStoredSettlement(
  wager: Record<string, unknown> | null,
): WagerSettlement | null {
  const rawSettlement = wager?.settlement;
  const settlement = parseSettlement(rawSettlement);
  if (rawSettlement !== null && rawSettlement !== undefined && !settlement) {
    throw new Error("wager-settlement-malformed");
  }
  return settlement;
}

function createLineageRelease(
  uid: string,
  operationIds: readonly string[],
): SettlementRelease {
  return {
    uid,
    reservationOperationIds: [...operationIds],
  };
}

function createSettlement(
  wager: Record<string, unknown>,
  resolution: WagerSettlementResolution,
  operationId: string,
  nowMs: number,
  acceptReservationOperationIdByUid: Readonly<Record<string, string>>,
): WagerSettlement {
  const base = {
    version: 2 as const,
    state: "pending" as const,
    operationId,
    claimedAtMs: nowMs,
    completedAtMs: null,
  };
  const agreement = toRecord(wager.agreed);
  const material = normalizeString(agreement?.material);
  const count = normalizeCount(agreement?.count);
  const proposerUid = normalizeString(agreement?.proposerId);
  const accepterUid = normalizeString(agreement?.accepterId);
  if (isMaterialName(material) && count > 0) {
    const agreementOperation = toRecord(wager.agreementOperation);
    if (agreementOperation?.reservationLineageVersion !== 1) {
      throw new Error("wager-reservation-lineage-invalid");
    }
    if (agreementOperation.reservationLineageReady !== true) {
      throw new Error("wager-reservation-lineage-pending");
    }
    const proposerOperationIds = parseReservationOperationIds(
      agreementOperation.proposerReservationOperationIds,
    );
    const accepterOperationIds = parseReservationOperationIds(
      agreementOperation.accepterReservationOperationIds,
    );
    if (
      !proposerOperationIds ||
      !accepterOperationIds ||
      Object.hasOwn(agreementOperation, "proposerLegacyReservation") ||
      Object.hasOwn(agreementOperation, "accepterLegacyReservation")
    ) {
      throw new Error("wager-reservation-lineage-invalid");
    }
    const proposerRelease = createLineageRelease(
      proposerUid,
      proposerOperationIds,
    );
    const accepterRelease = createLineageRelease(
      accepterUid,
      accepterOperationIds,
    );
    const releaseByUid = new Map([
      [proposerRelease.uid, proposerRelease],
      [accepterRelease.uid, accepterRelease],
    ]);
    const winnerRelease = releaseByUid.get(resolution.winnerUid);
    const loserRelease = releaseByUid.get(resolution.loserUid);
    if (!winnerRelease || !loserRelease) {
      throw new Error("wager-reservation-lineage-invalid");
    }
    const releases = [winnerRelease, loserRelease];
    const candidate = {
      ...base,
      kind: "agreed" as const,
      ...resolution,
      material,
      count,
      releases,
    };
    return {
      ...candidate,
      failureReason: null,
      fingerprint: settlementFingerprint(candidate),
    };
  }
  const proposals = toRecord(wager.proposals) || {};
  const releases = [resolution.winnerUid, resolution.loserUid].map((uid) => {
    const proposal = toRecord(proposals[uid]);
    const proposalReservationOperationId = normalizeString(
      proposal?.reservationOperationId,
    );
    const proposalOperationId = normalizeString(proposal?.operationId);
    if (
      proposal &&
      (!/^[a-f0-9]{64}$/.test(proposalReservationOperationId) ||
        !/^[a-f0-9]{64}$/.test(proposalOperationId))
    ) {
      throw new Error("wager-reservation-lineage-invalid");
    }
    return createLineageRelease(uid, [
      acceptReservationOperationIdByUid[uid],
      ...(proposalReservationOperationId
        ? [proposalReservationOperationId]
        : []),
    ]);
  });
  const candidate = {
    ...base,
    kind: "proposals" as const,
    releases,
  };
  return {
    ...candidate,
    failureReason: null,
    fingerprint: settlementFingerprint(candidate),
  };
}

export function claimSettlementDecision(
  value: unknown,
  input: ClaimWagerSettlementCommand,
): TransactionDecision<WagerRecord> {
  const { resolution, operationId, now, acceptReservationOperationIdByUid } =
    input;

  const wager = toRecord(value);
  if (!wager) {
    return { commit: false, decision: "no-wager" };
  }
  const existing = readStoredSettlement(wager);
  if (wager.resolved) {
    return { commit: false, decision: "already-resolved" };
  }
  if (existing) {
    return {
      commit: false,
      decision:
        existing.state !== "completed"
          ? "resume"
          : existing.failureReason ===
              WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON
            ? WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON
            : "already-resolved",
    };
  }
  const settlement = createSettlement(
    wager,
    resolution,
    operationId,
    now,
    acceptReservationOperationIdByUid,
  );
  return { value: { ...wager, settlement } };
}
export function completeSettlementDecision(
  value: unknown,
  input: CompleteWagerSettlementCommand,
): TransactionDecision<WagerRecord> {
  const wager = toRecord(value);
  const current = readStoredSettlement(wager);
  const { settlement, completedAtMs, insufficientMaterials } = input;
  if (
    !wager ||
    !current ||
    current.operationId !== settlement.operationId ||
    current.fingerprint !== settlement.fingerprint
  )
    throw new Error("wager-settlement-unavailable");
  if (current.state === "completed")
    return { commit: false, decision: "completed" };
  const next: WagerRecord = {
    ...wager,
    settlement: {
      ...toRecord(wager.settlement),
      state: "completed",
      completedAtMs,
    },
  };
  delete next.proposals;
  if (insufficientMaterials) {
    (next.settlement as WagerRecord).failureReason =
      WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON;
    delete next.agreed;
  } else if (settlement.kind === "agreed")
    next.resolved = {
      winnerId: settlement.winnerUid,
      loserId: settlement.loserUid,
      material: settlement.material,
      count: settlement.count,
      total: settlement.count * 2,
      resolvedAt: completedAtMs,
    };
  return { value: next };
}
