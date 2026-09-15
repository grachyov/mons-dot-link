import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    )
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const { createInitialGameBootstrap, getInitialGameBootstrapSelection } =
  await import("../src/services/initialGameBootstrap.ts");
const { readPendingRematchEnd, rematchEndDeliveryStorageKey } =
  await import("../src/connection/rematchEndDelivery.ts");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const invite = (inviteId = "match-a") => ({
  mode: "invite",
  path: inviteId,
  inviteId,
  snapshotId: null,
  eventId: null,
  autojoin: false,
});

function fixture({
  mode = "invite",
  selection = "current",
  anonymous = false,
  combined = false,
} = {}) {
  const response = deferred();
  const user = {
    uid: "a".repeat(28),
    sessionId: "session-a",
    generation: "generation-a",
    getIdToken: async () => "token",
  };
  const routeListeners = new Set();
  const authListeners = new Set();
  let route =
    mode === "invite" ? invite() : { ...invite(), mode, inviteId: null };
  const requests = [];
  const preparations = [];
  let anonymousStarts = 0;
  const auth = {
    currentUser: anonymous ? null : user,
    authStateReady: async () => {},
    signInAnonymously: async () => {
      anonymousStarts += 1;
      auth.currentUser = user;
    },
    async prepareInitialGame(inviteId, options) {
      preparations.push({ inviteId, options });
      if (!auth.currentUser) await auth.signInAnonymously();
      return {
        user: auth.currentUser,
        selection: options.selectionForUid(auth.currentUser.uid),
        bootstrap: combined ? await response.promise : null,
      };
    },
    onAuthStateChanged(listener) {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },
  };
  const bootstrap = createInitialGameBootstrap({
    auth,
    route: () => route,
    subscribeRoute(listener) {
      routeListeners.add(listener);
      return () => routeListeners.delete(listener);
    },
    selection: () => selection,
    async read(inviteId, tokenProvider, options) {
      requests.push({ inviteId, options });
      tokenProvider.assertCurrentUser();
      return response.promise;
    },
  });
  return {
    bootstrap,
    response,
    user,
    auth,
    requests,
    preparations,
    routeListeners,
    authListeners,
    start() {
      bootstrap.start(route);
    },
    anonymousStarts: () => anonymousStarts,
    setSelection(next) {
      selection = next;
    },
    navigate(next) {
      route = next;
      routeListeners.forEach((listener) => listener(route));
    },
    changeUser(next) {
      auth.currentUser = next;
      authListeners.forEach((listener) => listener(next));
    },
  };
}

test("initial request starts independently and is adopted exactly once, before or after response", async () => {
  for (const completedFirst of [false, true]) {
    const h = fixture();
    h.start();
    h.start();
    await flush();
    assert.equal(h.requests.length, 1);
    const value = { ok: true };
    if (completedFirst) {
      h.response.resolve(value);
      await flush();
    }
    const taken = h.bootstrap.take("match-a", h.user, "current");
    assert.ok(taken);
    assert.equal(h.bootstrap.take("match-a", h.user, "current"), null);
    assert.equal(h.routeListeners.size, 0);
    assert.equal(h.authListeners.size, 0);
    h.response.resolve(value);
    assert.equal(await taken.promise, value);
    assert.equal(h.requests.length, 1);
  }
});

test("combined session results are adopted once without a separate game read", async () => {
  for (const completedFirst of [false, true]) {
    const h = fixture({ combined: true });
    h.start();
    assert.equal(h.preparations.length, 1);
    const value = { ok: true, schemaVersion: 1 };
    if (completedFirst) {
      h.response.resolve(value);
      await flush();
    }
    const taken = h.bootstrap.take("match-a", h.user);
    assert.ok(taken);
    h.response.resolve(value);
    assert.equal(await taken.promise, value);
    assert.equal(h.bootstrap.take("match-a", h.user), null);
    assert.equal(h.requests.length, 0);
  }
});

test("selection changes after early adoption are distinguished from authentication changes", async () => {
  for (const original of ["current", "approved"]) {
    const latest = original === "current" ? "approved" : "current";
    const h = fixture({ selection: original });
    const preparation = deferred();
    h.auth.prepareInitialGame = () => preparation.promise;
    h.start();
    const taken = h.bootstrap.take("match-a", h.user, original);
    assert.ok(taken);
    h.setSelection(latest);
    const rejected = assert.rejects(taken.promise, {
      name: "GameBootstrapApiError",
      code: "initial-game-bootstrap-selection-changed",
    });
    preparation.resolve({ user: h.user, selection: latest, bootstrap: null });
    h.response.resolve({ ok: true });
    await rejected;
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].options.selection, latest);
    assert.equal(h.bootstrap.take("match-a", h.user, latest), null);
  }
});

test("explicit combined game failures remain adoptable before and after session completion", async () => {
  for (const completedFirst of [false, true]) {
    const h = fixture({ combined: true });
    h.start();
    const failure = { ok: false, status: 429, retryAfterMs: 3000 };
    if (completedFirst) {
      h.response.resolve(failure);
      await flush();
      assert.equal(h.routeListeners.size, 1);
      assert.equal(h.authListeners.size, 1);
    }
    const taken = h.bootstrap.take("match-a", h.user);
    assert.ok(taken);
    const rejected = assert.rejects(taken.promise, {
      name: "GameBootstrapApiError",
      code: "http-429",
      status: 429,
      retryAfterMs: 3000,
    });
    h.response.resolve(failure);
    await rejected;
    assert.equal(h.requests.length, 0);
    assert.equal(h.bootstrap.take("match-a", h.user), null);
    assert.equal(h.routeListeners.size, 0);
    assert.equal(h.authListeners.size, 0);
  }
});

test("navigation discards a combined failure before it can be adopted", async () => {
  const h = fixture({ combined: true });
  h.start();
  h.navigate(invite("match-b"));
  h.response.resolve({ ok: false, status: 404 });
  await flush();
  assert.equal(h.bootstrap.take("match-a", h.user), null);
  assert.equal(h.requests.length, 0);
  assert.equal(h.preparations[0].options.signal.aborted, true);
});

test("completed response is discarded when leaving and returning to the initial invite", async () => {
  const h = fixture();
  h.start();
  await flush();
  h.response.resolve({ ok: true });
  await flush();
  assert.equal(h.routeListeners.size, 1);
  h.navigate(invite("match-b"));
  h.navigate(invite());
  assert.equal(h.bootstrap.take("match-a", h.user), null);
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.routeListeners.size, 0);
  assert.equal(h.authListeners.size, 0);
});

test("same-background overlays preserve the response; another auth object with the same UID invalidates it", async () => {
  const h = fixture();
  h.start();
  await flush();
  h.response.resolve({ ok: true });
  await flush();
  h.navigate({ ...invite(), eventId: "event-a" });
  assert.equal(h.requests[0].options.signal.aborted, false);
  h.changeUser({ ...h.user });
  assert.equal(h.bootstrap.take("match-a", h.auth.currentUser), null);
  assert.equal(h.requests[0].options.signal.aborted, true);
});

test("approved/current selection is part of adoption identity", async () => {
  const h = fixture({ selection: "approved" });
  h.start();
  await flush();
  assert.equal(h.requests[0].options.selection, "approved");
  assert.equal(h.bootstrap.take("match-a", h.user, "current"), null);
  assert.equal(h.requests[0].options.signal.aborted, true);
  h.response.resolve({ ok: true });
  await flush();
});

test("caller abort owns an adopted request, and early failures release listeners", async () => {
  const h = fixture();
  h.start();
  await flush();
  const taken = h.bootstrap.take("match-a", h.user);
  taken.abort();
  assert.equal(h.requests[0].options.signal.aborted, true);
  h.response.resolve({ ok: true });
  await assert.rejects(taken.promise, /canceled/);
  const failure = fixture();
  failure.start();
  await flush();
  failure.response.reject(new Error("unavailable"));
  await flush();
  assert.equal(failure.routeListeners.size, 0);
  assert.equal(failure.authListeners.size, 0);
  assert.equal(failure.bootstrap.take("match-a", failure.user), null);
});

test("local, bots, snapshot, and event modes warm the shared session without reading a game", async () => {
  for (const mode of ["home", "watch", "snapshot", "event"]) {
    const h = fixture({ mode, anonymous: true });
    h.start();
    await flush();
    assert.equal(h.anonymousStarts(), 1);
    assert.equal(h.requests.length, 0);
    assert.equal(h.routeListeners.size, 0);
  }
});

test("pending rematch-end selection uses the same validated persisted record as delivery", () => {
  const scope = { loginUid: "a".repeat(28), inviteId: "match-a" };
  const record = {
    ...scope,
    matchId: "match-a1",
    actorUid: scope.loginUid,
    operationId: crypto.randomUUID(),
  };
  const persistence = {
    getItem(key) {
      assert.equal(key, rematchEndDeliveryStorageKey(scope));
      return JSON.stringify({ version: 1, record });
    },
  };
  assert.deepEqual(readPendingRematchEnd(scope, persistence), record);
  assert.equal(readPendingRematchEnd(scope, { getItem: () => null }), null);
  assert.throws(
    () => readPendingRematchEnd(scope, { getItem: () => "{}" }),
    /invalid-stored/,
  );
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage: persistence,
      localStorage: { getItem: () => null },
    },
  });
  try {
    assert.equal(
      getInitialGameBootstrapSelection(scope.inviteId, { uid: scope.loginUid }),
      "approved",
    );
  } finally {
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  }
});
