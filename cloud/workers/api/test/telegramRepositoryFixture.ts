import {
  createTelegramRepository,
  type TelegramStoredRecord,
  type TelegramTransactionResult,
} from "../../../runtime/telegram/repositoryCore.js";

export function telegramRepositoryFixture(storage: {
  getPath(path: string): Promise<unknown>;
  transactPath(
    path: string,
    updater: (current: unknown) => unknown,
  ): Promise<{ committed: boolean; decision?: string; value: unknown }>;
}) {
  return createTelegramRepository({
    readMessage: async (key) =>
      (await storage.getPath(
        `telegramMessages/${key}`,
      )) as TelegramStoredRecord | null,
    transactMessage: async (key, updater) =>
      (await storage.transactPath(`telegramMessages/${key}`, (current) =>
        updater(current as TelegramStoredRecord | null),
      )) as TelegramTransactionResult,
    readControl: async () =>
      (await storage.getPath(
        "telegramDeliveryControl",
      )) as TelegramStoredRecord | null,
    transactControl: async (updater) =>
      (await storage.transactPath("telegramDeliveryControl", (current) =>
        updater(current as TelegramStoredRecord | null),
      )) as TelegramTransactionResult,
  });
}
