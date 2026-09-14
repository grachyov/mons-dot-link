import assert from "node:assert/strict";
import test from "node:test";
import { readSocketAdmission } from "../src/socketAdmission.ts";
import { socketCapacityFull } from "../src/socketCapacity.ts";
import {
  socketTestIdentity,
  socketTestSessionHeaders,
} from "./socketTestSession.ts";

for (const headerPrefix of ["Match", "Metadata", "Wagers"] as const) {
  test(`${headerPrefix} admission normalizes participant and public spectator headers`, () => {
    const protocol = `${headerPrefix.toLowerCase()}-test`;
    const headers = new Headers({
      "Sec-WebSocket-Protocol": protocol,
      [`X-Mons-${headerPrefix}-Role`]: "host",
      [`X-Mons-${headerPrefix}-Revision`]: String(Number.MAX_SAFE_INTEGER),
      [`X-Mons-${headerPrefix}-Protected`]: "1",
      [`X-Mons-${headerPrefix}-Authenticated`]: "1",
      ...socketTestSessionHeaders(),
    });
    const read = (actorUid: string | null) =>
      readSocketAdmission(new Request("https://room.internal", { headers }), {
        headerPrefix,
        protocol,
        actorUid,
      });
    const participant = read("host-login");
    assert.equal(participant.status, "ok");
    if (participant.status !== "ok") return;
    assert.deepEqual(participant.admission, {
      role: "host",
      ip: "unknown",
      revision: Number.MAX_SAFE_INTEGER,
      passwordProtected: true,
      session: {
        authenticated: true,
        sid: socketTestIdentity("host-login").sid,
        authExpiresAtMs: Number(headers.get("X-Mons-Session-Expires-At")),
      },
    });
    headers.set(`X-Mons-${headerPrefix}-Role`, "spectator");
    headers.set(`X-Mons-${headerPrefix}-IP`, "x".repeat(64));
    headers.set(`X-Mons-${headerPrefix}-Authenticated`, "0");
    headers.delete("X-Mons-Session-Id");
    assert.equal(read("host-login").status, "invalid");
    const spectator = read(null);
    assert.equal(spectator.status, "ok");
    if (spectator.status !== "ok") return;
    assert.equal(spectator.admission.ip.length, 64);
    assert.deepEqual(spectator.admission.session, { authenticated: false });
  });
}

test("socket caps reserve participant capacity and reject the first excess admission", () => {
  const limits = {
    sockets: 256,
    spectators: 248,
    spectatorsPerIp: 8,
    socketsPerParticipant: 4,
  };
  const counts = {
    sockets: 247,
    spectators: 247,
    spectatorsPerIp: 7,
    socketsForRole: 3,
  };
  for (const role of ["host", "guest", "spectator"]) {
    assert.equal(socketCapacityFull(role, counts, limits), false);
    assert.equal(
      socketCapacityFull(role, { ...counts, sockets: 256 }, limits),
      true,
    );
  }
  for (const excess of [{ spectators: 248 }, { spectatorsPerIp: 8 }]) {
    assert.equal(
      socketCapacityFull("spectator", { ...counts, ...excess }, limits),
      true,
    );
    for (const role of ["host", "guest"])
      assert.equal(
        socketCapacityFull(role, { ...counts, ...excess }, limits),
        false,
      );
  }
  for (const role of ["host", "guest"])
    assert.equal(
      socketCapacityFull(role, { ...counts, socketsForRole: 4 }, limits),
      true,
    );
  assert.equal(
    socketCapacityFull("spectator", { ...counts, socketsForRole: 248 }, limits),
    false,
  );
});
