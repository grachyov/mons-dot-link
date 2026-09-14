import type {
  TransactionDecision,
  TransactionResult,
} from "./repositoryContracts.ts";

type VersionedRecord<T> = { record: T; version: number };

export async function runOptimisticTransaction<T>(input: {
  maxAttempts: number;
  read: () => Promise<VersionedRecord<T> | null>;
  decide: (current: T | null) => TransactionDecision<unknown>;
  write: (
    current: VersionedRecord<T> | null,
    value: unknown,
  ) => Promise<{ applied: boolean; value: T | null }>;
  conflictError: () => Error;
}): Promise<TransactionResult<T>> {
  for (let attempt = 0; attempt < input.maxAttempts; attempt += 1) {
    const current = await input.read();
    const decision = input.decide(current?.record ?? null);
    if ("commit" in decision) {
      return {
        committed: false,
        decision: decision.decision,
        value: current?.record ?? null,
      };
    }
    const written = await input.write(current, decision.value);
    if (written.applied) {
      return {
        committed: true,
        decision: decision.decision,
        value: written.value,
      };
    }
  }
  throw input.conflictError();
}
