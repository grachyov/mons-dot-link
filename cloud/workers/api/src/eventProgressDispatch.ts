import type { EventGameplayRepository } from "./eventRepository.ts";
import type {
  EventProgressPlan,
  EventProgressWorkflowParams,
} from "./eventProgressCodec.ts";
import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import {
  acquireEventWriteAdmission,
  EventWritesDisabled,
  releaseEventWriteAdmission,
  type EventWriteAdmission,
} from "./eventD1.ts";

export async function withEventProgressDispatchAdmission(
  db: D1Database,
  work: (admission: EventWriteAdmission) => Promise<void>,
): Promise<void> {
  let admission: EventWriteAdmission;
  try {
    admission = await acquireEventWriteAdmission(db);
  } catch (error) {
    if (error instanceof EventWritesDisabled) return;
    throw error;
  }
  try {
    await work(admission);
  } finally {
    let failureKind: string | null = null;
    try {
      if (!(await releaseEventWriteAdmission(db, admission))) {
        failureKind = "unconfirmed";
      }
    } catch (error) {
      failureKind = error instanceof Error ? error.name : typeof error;
    }
    if (failureKind) {
      console.error(
        JSON.stringify({
          event: "event_progress_dispatch_admission_release_failed",
          kind: failureKind,
        }),
      );
    }
  }
}

async function ensureEventProgressWorkflowInstance(
  workflow: Workflow<EventProgressWorkflowParams>,
  plan: EventProgressPlan,
): Promise<void> {
  try {
    await workflow.createBatch([
      {
        id: plan.workflowId,
        params: plan.params,
        retention: { successRetention: "1 day", errorRetention: "30 days" },
      },
    ]);
  } catch (error) {
    try {
      await workflow.get(plan.workflowId);
    } catch {
      throw error;
    }
  }
}

export async function ensureEventProgressWorkflow(
  env: Pick<Env, "EVENT_DB" | "EVENT_PROGRESS_WORKFLOW" | "PROFILE_GAMES_DB">,
  plan: EventProgressPlan,
): Promise<void> {
  await requireActiveDurableMatchState(env.PROFILE_GAMES_DB);
  await withEventProgressDispatchAdmission(env.EVENT_DB, () =>
    ensureEventProgressWorkflowInstance(env.EVENT_PROGRESS_WORKFLOW, plan),
  );
}

export async function removeOutbox(
  repository: Pick<EventGameplayRepository, "commitEventPlan">,
  outboxId: string,
): Promise<void> {
  await repository.commitEventPlan([
    { kind: "progress-outbox", outboxId, value: null },
  ]);
}

export async function dispatchOutboxPlan(
  env: Env,
  repository: Pick<EventGameplayRepository, "commitEventPlan">,
  plan: EventProgressPlan,
  now: () => number,
): Promise<void> {
  await ensureEventProgressWorkflowInstance(env.EVENT_PROGRESS_WORKFLOW, plan);
  const instance = await env.EVENT_PROGRESS_WORKFLOW.get(plan.workflowId);
  const status = await instance.status();
  if (status.status === "errored" || status.status === "terminated") {
    await instance.delete();
    await ensureEventProgressWorkflowInstance(
      env.EVENT_PROGRESS_WORKFLOW,
      plan,
    );
    return;
  }
  if (status.status === "complete") {
    await removeOutbox(repository, plan.outboxId);
    return;
  }
  await repository.commitEventPlan([
    { kind: "progress-dispatched", outboxId: plan.outboxId, value: now() },
  ]);
}
