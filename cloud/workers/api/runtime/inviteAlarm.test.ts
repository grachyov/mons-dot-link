import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import type { InviteReactions } from "../src/inviteReactions.ts";

type Room = DurableObjectStub<InviteReactions>;
type AlarmComponents = {
  socketSessions: { nextExpiry: () => number | null };
  inviteChannels: {
    alarm: () => Promise<void>;
    nextAlarm: () => number | null;
  };
  matchSync: {
    alarm: () => Promise<void>;
    nextAlarm: () => number | null;
  };
  matchState: { nextEffectAt: () => number | null };
  matchEffects: { dispatch: () => Promise<void> };
};

const rooms: Room[] = [];

function fixture() {
  const room = env.INVITE_REACTIONS.getByName(`alarm-${crypto.randomUUID()}`);
  rooms.push(room);
  return room;
}

afterEach(async () => {
  await Promise.all(
    rooms
      .splice(0)
      .map((room) =>
        runInDurableObject(room, (_instance, state) =>
          state.storage.deleteAlarm(),
        ),
      ),
  );
});

it("refreshes sockets and expiry before awaiting effects, then schedules the earliest deadline", async () => {
  await runInDurableObject(fixture(), async (instance, state) => {
    const target = instance as unknown as AlarmComponents;
    const phases: string[] = [];
    const now = Date.now();
    let started!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    target.socketSessions.nextExpiry = () => {
      phases.push("expiry");
      return now + 2_000;
    };
    target.inviteChannels.alarm = async () => {
      phases.push("invite");
    };
    target.inviteChannels.nextAlarm = () => now + 5_000;
    target.matchSync.alarm = async () => {
      phases.push("match");
    };
    target.matchSync.nextAlarm = () => now + 4_000;
    target.matchState.nextEffectAt = () => now + 60_000;
    target.matchEffects.dispatch = async () => {
      phases.push("effects");
      started();
      await gate;
    };
    let finished = false;
    const pending = instance.alarm().then(() => {
      finished = true;
    });
    await began;
    try {
      expect(phases).toEqual([
        "expiry",
        "invite",
        "match",
        "expiry",
        "effects",
      ]);
      expect(finished).toBe(false);
    } finally {
      release();
      await pending;
    }
    expect(await state.storage.getAlarm()).toBe(now + 2_000);
  });
});

for (const failed of ["invite", "match", "effects"] as const) {
  it(`continues after a ${failed} failure, reschedules and surfaces the original error`, async () => {
    await runInDurableObject(fixture(), async (instance, state) => {
      const target = instance as unknown as AlarmComponents;
      const phases: string[] = [];
      const error = new Error(`${failed}-alarm-failed`);
      const deadline = Date.now() + 5_000;
      const run = async (phase: string) => {
        phases.push(phase);
        if (phase === failed) throw error;
        if (phase === "effects") throw new Error("later-effect-failure");
      };
      target.socketSessions.nextExpiry = () => {
        phases.push("expiry");
        return null;
      };
      target.inviteChannels.alarm = () => run("invite");
      target.inviteChannels.nextAlarm = () => deadline;
      target.matchSync.alarm = () => run("match");
      target.matchSync.nextAlarm = () => deadline + 1_000;
      target.matchState.nextEffectAt = () => deadline + 60_000;
      target.matchEffects.dispatch = () => run("effects");
      await expect(instance.alarm()).rejects.toBe(error);
      expect(phases).toEqual([
        "expiry",
        "invite",
        "match",
        "expiry",
        "effects",
        "expiry",
      ]);
      expect(await state.storage.getAlarm()).toBe(deadline);
    });
  });
}

it("schedules surviving deadlines when another component cannot read its deadline", async () => {
  await runInDurableObject(fixture(), async (instance, state) => {
    const target = instance as unknown as AlarmComponents;
    const error = new Error("invite-deadline-unavailable");
    const deadline = Date.now() + 2_000;
    target.socketSessions.nextExpiry = () => deadline;
    target.inviteChannels.alarm = async () => {};
    target.inviteChannels.nextAlarm = () => {
      throw error;
    };
    target.matchSync.alarm = async () => {};
    target.matchSync.nextAlarm = () => deadline + 5_000;
    target.matchState.nextEffectAt = () => deadline + 60_000;
    target.matchEffects.dispatch = async () => {};
    await expect(instance.alarm()).rejects.toBe(error);
    expect(await state.storage.getAlarm()).toBe(deadline);
  });
});
