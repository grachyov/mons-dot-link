export async function sendQueueTasks<T>(
  queue: Pick<Queue<T>, "sendBatch">,
  tasks: readonly T[],
): Promise<void> {
  for (let index = 0; index < tasks.length; index += 100) {
    await queue.sendBatch(
      tasks.slice(index, index + 100).map((task) => ({ body: task })),
    );
  }
}

export async function collectSuccessfulClaims<T>(
  items: readonly T[],
  claim: (item: T) => Promise<boolean>,
  fallbackErrorMessage: string,
): Promise<{ claimed: T[]; failure: Error | null }> {
  const claimed: T[] = [];
  let failure: Error | null = null;
  for (const item of items) {
    try {
      if (await claim(item)) {
        claimed.push(item);
      }
    } catch (error) {
      failure ||=
        error instanceof Error ? error : new Error(fallbackErrorMessage);
    }
  }
  return { claimed, failure };
}

export async function claimAndEnqueueProjectionTasks<Candidate, Task>({
  candidates,
  claim,
  toTask,
  queue,
  initialTasks = [],
  fallbackErrorMessage,
}: {
  candidates: readonly Candidate[];
  claim: (candidate: Candidate) => Promise<boolean>;
  toTask: (candidate: Candidate) => Task;
  queue: Pick<Queue<Task>, "sendBatch">;
  initialTasks?: readonly Task[];
  fallbackErrorMessage: string;
}): Promise<{ sentCount: number; claimFailure: Error | null }> {
  const claims = await collectSuccessfulClaims(
    candidates,
    claim,
    fallbackErrorMessage,
  );
  const tasks = [...initialTasks, ...claims.claimed.map(toTask)];
  await sendQueueTasks(queue, tasks);
  return { sentCount: tasks.length, claimFailure: claims.failure };
}
