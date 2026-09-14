type QueueMessageLog = {
  entry: { event: string; [field: string]: unknown };
  level: "error" | "info";
  logger: Pick<Console, "error" | "info">;
};

function logQueueMessage(
  message: Message<unknown>,
  { entry, level, logger }: QueueMessageLog,
): void {
  logger[level](
    JSON.stringify({
      ...entry,
      messageId: message.id,
      attempts: message.attempts,
    }),
  );
}

export function ackQueueMessage(
  message: Message<unknown>,
  log: QueueMessageLog,
): void {
  message.ack();
  logQueueMessage(message, log);
}

export function retryQueueMessage(
  message: Message<unknown>,
  delaySeconds: number,
  log: QueueMessageLog,
): void {
  message.retry({ delaySeconds });
  logQueueMessage(message, log);
}
