import type { TelegramRepository } from "./deliveryEngine.js";
import type {
  TransactionDecision,
  TransactionResult,
} from "../transactions.js";

export type TelegramStoredRecord = Record<string, unknown>;
export type TelegramTransactionResult = TransactionResult<TelegramStoredRecord>;

export type TelegramStorage = {
  readMessage(messageKey: string): Promise<TelegramStoredRecord | null>;
  transactMessage(
    messageKey: string,
    updater: (
      current: TelegramStoredRecord | null,
    ) => TransactionDecision<TelegramStoredRecord>,
  ): Promise<TelegramTransactionResult>;
  readControl(): Promise<TelegramStoredRecord | null>;
  transactControl(
    updater: (
      current: TelegramStoredRecord | null,
    ) => TransactionDecision<TelegramStoredRecord>,
  ): Promise<TelegramTransactionResult>;
};

export function createTelegramRepository(
  input: TelegramStorage,
): TelegramRepository;
