export type EventProgressWorkExecutor = (
  workflowId: string,
  work: () => Promise<void>,
) => Promise<void>;

export function createEventProgressWorkExecutor(): EventProgressWorkExecutor {
  const tails = new Map<string, Promise<void>>();
  return async (workflowId, work) => {
    const previous = tails.get(workflowId);
    const current = (async () => {
      if (previous) await previous.catch(() => {});
      await work();
    })();
    tails.set(workflowId, current);
    try {
      await current;
    } finally {
      if (tails.get(workflowId) === current) tails.delete(workflowId);
    }
  };
}
