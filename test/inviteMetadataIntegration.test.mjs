import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { InviteMetadataState } from "../src/connection/inviteMetadataState.ts";
import { InviteMetadataApiError } from "../src/services/inviteMetadataApi.ts";
import { withAutomatchOperationLock } from "../src/connection/automatchOperationLock.ts";
import { moveDeliveryStorageKey } from "../src/connection/moveDelivery.ts";
import {
  RematchEndDelivery,
  rematchEndDeliveryStorageKey,
  REMATCH_END_STORAGE_PREFIX,
} from "../src/connection/rematchEndDelivery.ts";
import { isAutoInviteId } from "../cloud/runtime/shared/ids.js";
import {
  parseRematchIndices,
  rematchSeriesEnded,
} from "../cloud/runtime/shared/rematches.js";

const source = ts.createSourceFile(
  "connection.ts",
  readFileSync(
    new URL("../src/connection/connection.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const declaration = source.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name?.text === "Connection",
);
const names = [
  "clearPendingAutomatchRequest",
  "reconcilePendingAutomatchRequest",
  "beginConnectAttempt",
  "isConnectAttemptActive",
  "isContextActive",
  "isCurrentAuthUser",
  "registerObserverCleanup",
  "unregisterObserverCleanup",
  "cleanupObserverContext",
  "clearAllObserverContexts",
  "buildRuntimeContext",
  "activateContext",
  "clearActiveContext",
  "bumpSessionEpoch",
  "isSessionEpochActive",
  "createMatchContextGuard",
  "requireWritableContext",
  "detachFromMatchSession",
  "fetchInviteWithPendingCreation",
  "connectToGame",
  "applyInviteMetadata",
  "observeInviteMetadata",
  "observeWagers",
  "updateWagerStateForCurrentMatch",
  "setWagerViewMatchId",
  "setLocalWagerState",
  "beginWagerSnapshotMutation",
  "runWagerMutation",
  "createWagerContextGuard",
  "restoreOptimisticWagerResolution",
  "cleanupInviteMetadataObserver",
  "cleanupInviteReactionObserver",
  "cleanupWagerObserver",
  "stopObservingAllMatches",
  "rematchSeriesEndIsIndicatedForInvite",
  "getLatestBothSidesApprovedRematchIndexForInvite",
  "getLatestBothSidesApprovedRematchIndex",
  "getLatestMatchIdForActor",
  "approvedRematchIndices",
  "maybeRefreshContextAfterRematchMetadata",
  "tryNavigateWatchOnlyToLatestApprovedMatch",
  "sendRematchProposal",
  "sendEndMatchIndicator",
  "getRematchEndDelivery",
  "isRematchEndPending",
  "refreshRematchEndDeliveries",
  "submitRematchEnd",
  "confirmRematchEndFromMetadata",
  "rematchSeriesEndIsIndicated",
  "subscribeToAuthChanges",
  "surrender",
  "moveDeliveryScope",
  "isCurrentMoveBoard",
  "recoverMoveBoard",
];
const methods = names.map((name) => {
  const method = declaration.members.find(
    (node) => node.name?.getText(source) === name,
  );
  assert.ok(method, `missing Connection.${name}`);
  return method.getText(source);
});
const { outputText } = ts.transpileModule(
  `class Connection { ${methods.join("\n")} }`.replaceAll(
    "import.meta.env.DEV",
    "false",
  ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
const controllerSource = ts.createSourceFile(
  "gameController.ts",
  readFileSync(
    new URL("../src/game/gameController.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const endMatchHandler = controllerSource.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "didClickEndMatchButton",
);
const { outputText: endMatchHandlerOutput } = ts.transpileModule(
  endMatchHandler.getText(controllerSource).replace(/^export /, ""),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);

function clickEndMatch(h) {
  const dependencies = {
    connection: h.instance,
    isReconnect: false,
    didConnect: true,
    isWaitingForRematchResponse: true,
    boardViewMode: "waitingLive",
    pendingRematchNavigationToLiveBoard: false,
    PrimaryActionType: { None: "none" },
    showPrimaryAction: () => h.events.ui.push("hide-primary"),
    setEndMatchConfirmed: () => {
      assert.ok(h.instance.rematchSeriesEndIsIndicated());
      h.events.ui.push("optimistic-ended");
    },
    showWaitingStateText: () => {},
    Board: { stopMonsBoardAsDisplayAnimations: () => {} },
    navigateFromWaitingLiveToLastCompletedMatch: () =>
      h.events.ui.push("return-to-completed"),
    triggerMoveHistoryPopupReload: () => {},
  };
  return new Function(
    ...Object.keys(dependencies),
    `${endMatchHandlerOutput}\nreturn didClickEndMatchButton();`,
  )(...Object.values(dependencies));
}

const snapshot = (overrides = {}) => ({
  inviteId: "invite",
  revision: 1,
  hostId: "host",
  guestId: "guest",
  hostColor: "white",
  hostRematches: "",
  guestRematches: "",
  automatchStateHint: null,
  eventId: null,
  eventOwned: false,
  ...overrides,
});
const response = (value = snapshot(), viewer = {}) => ({
  ok: true,
  snapshot: value,
  viewer: {
    role: "host",
    actorUid: "host",
    automatchOperationId: null,
    ...viewer,
  },
});
const match = {
  version: 1,
  color: "white",
  emojiId: 1,
  fen: "fen",
  gameVariant: "classic",
  status: "",
  flatMovesString: "",
  timer: "",
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function harness({
  initial = response(),
  loginUid = "login",
  wagers = { invite: { proposals: {} } },
  read,
  join,
  propose,
  end,
  onMetadata,
  readWagers,
  readMatch,
  ensureMatch,
  surrender,
  records = new Map(),
} = {}) {
  const events = {
    reads: [],
    legacyReads: [],
    matchReads: [],
    ensuredMatches: [],
    recoveredMatches: [],
    surrenders: [],
    auth: [],
    home: [],
    ui: [],
    observed: [],
    channels: [],
    metadata: [],
    errors: [],
    wagering: [],
    wagerReads: [],
    wagerChannels: [],
    wagerStates: [],
    frozenRefreshes: 0,
  };
  const cleanups = new Map();
  const counters = new Map();
  const operations = new Map();
  let instance;
  let authCallback;
  let currentResponse = initial;
  let publishedWagerState = null;
  const noop = () => undefined;
  const dependencies = {
    navigator: { onLine: true },
    RematchEndDelivery,
    rematchEndDeliveryStorageKey,
    REMATCH_END_STORAGE_PREFIX,
    window: {
      sessionStorage: {
        getItem: (key) => records.get(key) ?? null,
        setItem: (key, value) => records.set(key, value),
        removeItem: (key) => records.delete(key),
        key: (index) => [...records.keys()][index] ?? null,
        get length() {
          return records.size;
        },
      },
    },
    moveDeliveryStorageKey,
    InviteMetadataState,
    InviteMetadataApiError,
    withAutomatchOperationLock,
    isAutoInviteId,
    summarizeWagerState: (value) => value,
    parseRematchIndices,
    rematchSeriesEnded,
    storage: {
      getPendingAutomatchOperation: (uid) => operations.get(uid) ?? null,
      setPendingAutomatchOperation: (uid, value) =>
        value ? operations.set(uid, value) : operations.delete(uid),
      getPlayerEmojiAura: () => "",
    },
    InviteMetadataChannel: class {
      constructor(dependencies) {
        this.dependencies = dependencies;
        this.controller = new AbortController();
        this.signal = this.controller.signal;
        this.stops = 0;
        this.refreshes = 0;
        events.channels.push(this);
      }
      stop() {
        this.stops++;
        this.controller.abort();
      }
      requestRefresh() {
        this.refreshes++;
      }
      emit(value, viewer) {
        this.dependencies.onSnapshot(value, viewer);
      }
    },
    InviteWagersChannel: class {
      constructor(dependencies) {
        this.dependencies = dependencies;
        this.controller = new AbortController();
        this.signal = this.controller.signal;
        this.stops = 0;
        this.refreshes = 0;
        events.wagerChannels.push(this);
      }
      stop() {
        this.stops++;
        this.controller.abort();
      }
      requestRefresh() {
        this.refreshes++;
      }
      emit(
        value,
        source = "socket",
        generation = this.dependencies.captureGeneration(),
      ) {
        this.dependencies.onSnapshot(value, {
          source,
          requestGeneration: generation,
        });
      }
    },
    createInviteWagersSocketProtocols: (token) => [
      "mons-invite-wagers-v1",
      `bearer.${token}`,
    ],
    readInviteWagersViaApi: async (inviteId, provider, options) => {
      events.wagerReads.push({ inviteId, provider, signal: options.signal });
      return readWagers
        ? readWagers(events.wagerReads.length, options.signal)
        : { ok: true, snapshot: { inviteId, revision: 1, wagers } };
    },
    readInviteMetadataViaApi: async (inviteId, provider, options) => {
      events.reads.push({ inviteId, provider, signal: options.signal });
      return read ? read(events.reads.length, options.signal) : currentResponse;
    },
    createInviteMetadataSocketProtocols: (token) => [
      "mons-invite-metadata-v1",
      `bearer.${token}`,
    ],
    joinInviteViaApi: async (...args) => {
      events.ui.push("join-request");
      return join ? join(...args) : { ok: true };
    },
    proposeRematchViaApi: async (...args) =>
      propose
        ? propose(...args)
        : {
            ok: true,
            inviteId: "invite",
            actorUid: "host",
            matchId: "invite1",
            rematches: "1",
            match,
          },
    endRematchViaApi: async (...args) =>
      end
        ? end(...args)
        : { ok: true, inviteId: "invite", actorUid: "host", rematches: "x" },
    surrenderMatchViaApi: async (request, provider) => {
      provider.assertCurrentUser();
      events.surrenders.push(request);
      return surrender ? surrender(request) : { ok: true };
    },
    ref: (_db, path) => path,
    get: async (path) => {
      events.legacyReads.push(path);
      assert.fail(`unexpected legacy read: ${path}`);
    },
    readMatchSnapshotViaApi: async (input, options = {}) => {
      events.matchReads.push({ ...input, ...options });
      return {
        ok: true,
        ...input,
        match: readMatch
          ? await readMatch(events.matchReads.length, input, options)
          : match,
      };
    },
    ensureMatchViaApi: async (input, provider) => {
      events.ensuredMatches.push(input);
      return ensureMatch ? ensureMatch(input, provider) : { ok: true, match };
    },
    off: noop,
    getPlayersEmojiId: () => 1,
    transitionToHome: async (options) => {
      events.home.push(options);
      instance.detachFromMatchSession();
    },
    didFailToLoadPendingInvite: () => events.ui.push("pending-failed"),
    didFindInviteThatCanBeJoined: () => events.ui.push("join-button"),
    enterWatchOnlyMode: () => events.ui.push("watch"),
    didRecoverMyMatch: (value) => {
      events.ui.push("recover");
      events.recoveredMatches.push({ ...value });
    },
    didDiscoverExistingRematchProposalWaitingForResponse: () =>
      events.ui.push("pending-rematch"),
    didFindYourOwnInviteThatNobodyJoined: () => events.ui.push("waiting"),
    didUpdateRematchSeriesMetadata: () => {
      events.metadata.push([
        instance.latestInvite.hostRematches,
        instance.latestInvite.guestRematches,
      ]);
      onMetadata?.(instance);
    },
    didReceiveRematchesSeriesEndIndicator: () => events.ui.push("ended"),
    didJustCreateRematchProposalSuccessfully: () =>
      events.ui.push("proposal-created"),
    failedToCreateRematchProposal: () => events.ui.push("proposal-failed"),
    setCurrentWagerMatch: () => {
      publishedWagerState = null;
    },
    getWagerState: () => publishedWagerState,
    setWagerState: (matchId, state) => {
      publishedWagerState = state;
      events.wagerStates.push({ matchId, state });
    },
    syncCurrentWagerMatchState: (matchId, state) => {
      publishedWagerState = state;
      events.wagerStates.push({ matchId, state });
      events.wagering.push(instance.latestInvite?.wagers);
    },
    isWagerClientUpdateRequired: () => false,
    incrementLifecycleCounter: (key) =>
      counters.set(key, (counters.get(key) ?? 0) + 1),
    decrementLifecycleCounter: (key, count = 1) =>
      counters.set(key, (counters.get(key) ?? 0) - count),
    console: {
      log: noop,
      warn: noop,
      error: (...args) => events.errors.push(args),
    },
  };
  const Constructor = new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn Connection;`,
  )(...Object.values(dependencies));
  instance = Object.assign(new Constructor(), {
    auth: {
      currentUser: { uid: loginUid },
      getTokenRemainingMs: () => 300_000,
      onAuthStateChanged: (callback) => {
        authCallback = callback;
        return noop;
      },
    },
    currentUid: loginUid,
    authUnsubscribers: new Set(),
    sessionEpoch: 1,
    connectAttemptId: 0,
    nextContextId: 1,
    activeContext: null,
    rematchEndDeliveries: new Map(),
    moveDeliveries: new Map(),
    reconcilingMoveKeys: new Set(),
    confirmedSurrenders: new Set(),
    moveRecoveryTimers: new Map(),
    moveReconnectCooldownMs: 0,
    moveReconnectLastAttemptAt: 0,
    moveReconnectInFlight: false,
    reconnectAfterMatchUpdateFailure: noop,
    getMoveDelivery: (scope, match) => {
      const delivery = {
        reconcile: () => match,
        resume: noop,
        suspend: noop,
        pause: noop,
        flush: async () => {},
        hasPendingMoves: false,
      };
      instance.moveDeliveries.set(moveDeliveryStorageKey(scope), delivery);
      return delivery;
    },
    flushPendingMoves: async () => {},
    refreshMoveDeliveries: noop,
    matchRefs: {},
    observedMatchSnapshots: new Map(),
    matchPresentations: new Map(),
    optimisticResolvedMatchIds: new Set(),
    pendingWagerMutations: new Set(),
    inviteWagersSnapshot: null,
    wagerSnapshotGeneration: 0,
    wagerSnapshotRevisionFloor: -1,
    wagerSnapshotNeedsReconciliation: false,
    getUserBoundAuthTokenProvider: (expectedUid = loginUid) => {
      events.auth.push(expectedUid);
      return Object.assign(async () => "header.payload.signature", {
        assertCurrentUser: () =>
          assert.equal(instance.auth.currentUser?.uid, expectedUid),
      });
    },
    hasPendingInviteCreationFor: () => false,
    waitForPendingInviteCreation: async () => false,
    notifyNavigationGamesChanged: noop,
    logContextEvent: noop,
    setSameProfilePlayerUid: (uid) => {
      instance.sameProfilePlayerUid = uid;
    },
    ensureAuthenticated: async () => {},
    miningFrozenPoller: {
      refresh: () => {
        events.frozenRefreshes++;
      },
      runMutation: async (action) => action(),
    },
    clearEventSyncCaches: noop,
    logWagerDebug: noop,
    observeInviteReactions: noop,
    observeMatch: (uid, matchId) => events.observed.push([uid, matchId]),
    refreshTokenIfNeeded: async () => events.ui.push("refresh-claims"),
    getRematchIndexAvailableForNewProposal: () => 1,
    getCachedHistoricalMatchPair: () => null,
    observerRegistry: {
      register(contextId, key, cleanup) {
        const name = `${contextId}:${key}`;
        if (cleanups.has(name)) return false;
        cleanups.set(name, cleanup);
        return true;
      },
      unregister: (contextId, key) => cleanups.delete(`${contextId}:${key}`),
      cleanupContext: (contextId) => {
        for (const [key, cleanup] of cleanups)
          if (key.startsWith(`${contextId}:`)) cleanup();
      },
      clear: () => {
        for (const cleanup of cleanups.values()) cleanup();
      },
    },
  });
  return {
    instance,
    records,
    pauseEnds: () => {
      for (const item of instance.rematchEndDeliveries.values()) item.pause();
    },
    events,
    counters,
    operations,
    cleanups,
    setResponse: (value) => {
      currentResponse = value;
    },
    async connect(autojoin = false) {
      instance.connectToGame(loginUid, initial.snapshot.inviteId, autojoin);
      await settle();
      assert.deepEqual(events.errors, []);
    },
    channel: () => events.channels.at(-1),
    wagerChannel: () => events.wagerChannels.at(-1),
    authChange: (user) => {
      instance.auth.currentUser = user;
      authCallback(user);
    },
  };
}

test("metadata bootstrap preserves linked-login actors and loads existing wagers before recovery", async () => {
  const wagers = { invite: { agreed: { count: 3 } } };
  const h = harness({ wagers });
  await h.connect();
  assert.deepEqual(
    h.events.matchReads.map(({ playerId, matchId }) => ({ playerId, matchId })),
    [{ playerId: "host", matchId: "invite" }],
  );
  assert.ok(h.events.matchReads[0].signal instanceof AbortSignal);
  assert.deepEqual(h.events.legacyReads, []);
  assert.equal(h.events.wagerReads.length, 1);
  assert.equal(h.instance.activeContext.loginUid, "login");
  assert.equal(h.instance.activeContext.actorUid, "host");
  assert.deepEqual(h.events.wagering[0], wagers);
  assert.equal(h.events.ui.includes("refresh-claims"), false);
  h.channel().emit(snapshot({ revision: 2, hostRematches: "1" }));
  assert.deepEqual(h.instance.latestInvite.wagers, wagers);
  h.instance.detachFromMatchSession();
});

test("reconnect ensures a participant match only after a successful missing Worker snapshot", async () => {
  const ensuredMatch = { ...match, fen: "ensured-fen" };
  const h = harness({
    readMatch: (attempt) => (attempt === 1 ? match : null),
    ensureMatch: async () => ({ ok: true, match: ensuredMatch }),
  });
  await h.connect();
  const previousContext = h.instance.activeContext;
  h.instance.connectToGame("login", "invite", false);
  await settle();
  assert.deepEqual(h.events.errors, []);
  assert.equal(h.events.matchReads.length, 2);
  assert.equal(h.events.ensuredMatches.length, 1);
  assert.equal(h.events.ensuredMatches[0].inviteId, "invite");
  assert.equal(h.events.ensuredMatches[0].matchId, "invite");
  assert.notEqual(h.instance.activeContext, previousContext);
  assert.equal(h.instance.activeContext.actorUid, "host");
  assert.deepEqual(h.instance.myMatch, ensuredMatch);
  assert.equal(h.events.ui.filter((value) => value === "recover").length, 2);
  assert.deepEqual(h.events.legacyReads, []);
  h.instance.detachFromMatchSession();
});

test("a failed Worker snapshot during reconnect preserves the session without ensuring or reading legacy storage", async () => {
  const h = harness({
    readMatch: (attempt) => {
      if (attempt > 1) throw new Error("snapshot-unavailable");
      return match;
    },
  });
  await h.connect();
  const previousContext = h.instance.activeContext;
  const previousChannel = h.channel();
  h.instance.connectToGame("login", "invite", false);
  await settle();
  assert.equal(h.events.errors.length, 1);
  assert.equal(h.events.errors[0][0], "Failed to connect to invite:");
  assert.equal(h.events.errors[0][1].message, "snapshot-unavailable");
  assert.equal(h.events.matchReads.length, 2);
  assert.deepEqual(h.events.ensuredMatches, []);
  assert.equal(h.instance.activeContext, previousContext);
  assert.equal(h.channel(), previousChannel);
  assert.deepEqual(h.instance.myMatch, match);
  assert.equal(h.events.ui.filter((value) => value === "recover").length, 1);
  assert.deepEqual(h.events.legacyReads, []);
  h.instance.detachFromMatchSession();
});

for (const invalidation of ["account replacement", "navigation"]) {
  test(`a missing reconnect snapshot after ${invalidation} cannot ensure or restore the old match`, async () => {
    const pending = deferred();
    const h = harness({
      readMatch: (attempt) => (attempt === 1 ? match : pending.promise),
    });
    await h.connect();
    const unsubscribe = h.instance.subscribeToAuthChanges(() => {});
    h.instance.connectToGame("login", "invite", false);
    await settle();
    assert.equal(h.events.matchReads.length, 2);
    const { signal } = h.events.matchReads[1];
    assert.equal(signal.aborted, false);
    if (invalidation === "account replacement") {
      h.authChange({ uid: "replacement" });
    } else {
      h.instance.detachFromMatchSession();
    }
    const contextAfterInvalidation = h.instance.activeContext;
    assert.equal(signal.aborted, true);
    pending.resolve(null);
    await settle();
    assert.deepEqual(h.events.errors, []);
    assert.deepEqual(h.events.ensuredMatches, []);
    assert.equal(h.instance.activeContext, contextAfterInvalidation);
    assert.equal(h.events.ui.filter((value) => value === "recover").length, 1);
    assert.deepEqual(h.events.legacyReads, []);
    unsubscribe();
    h.instance.detachFromMatchSession();
  });
}

test("private automatch denial joins before metadata retry and never reads the old invite root", async () => {
  const paired = response(snapshot({ inviteId: "auto_invite" }), {
    actorUid: "guest",
    role: "guest",
  });
  const h = harness({
    initial: paired,
    read: (attempt) => {
      if (attempt === 1) throw new InviteMetadataApiError("http-403", 403);
      return paired;
    },
  });
  await h.connect(true);
  assert.equal(h.events.reads.length, 2);
  assert.deepEqual(
    h.events.ui.filter((value) => value === "join-request"),
    ["join-request"],
  );
  assert.equal(h.instance.activeContext.actorUid, "guest");
  h.instance.detachFromMatchSession();
});

test("pending invite creation waits after missing metadata and reads the created invite", async () => {
  const h = harness({
    read: (attempt) => {
      if (attempt === 1) throw new InviteMetadataApiError("http-404", 404);
      return response();
    },
  });
  h.instance.pendingInviteCreation = {
    inviteId: "invite",
    promise: Promise.resolve(true),
  };
  h.instance.hasPendingInviteCreationFor = () => true;
  h.instance.waitForPendingInviteCreation = async () => true;
  await h.connect();
  assert.equal(h.events.reads.length, 2);
  assert.ok(h.events.ui.includes("recover"));
  assert.ok(!h.events.ui.includes("pending-failed"));
  h.instance.detachFromMatchSession();
});

test("a late bootstrap result after account replacement cannot activate a game", async () => {
  const pending = deferred();
  const h = harness({ read: () => pending.promise });
  h.instance.connectToGame("login", "invite", false);
  h.instance.auth.currentUser = { uid: "replacement" };
  pending.resolve(response());
  await settle();
  assert.equal(h.instance.activeContext, null);
  assert.equal(h.events.matchReads.length, 0);
  assert.equal(h.events.legacyReads.length, 0);
  assert.equal(h.events.channels.length, 0);
});

test("uncertain manual joining recovers the authoritative viewer and paired metadata", async () => {
  const pending = response(snapshot({ guestId: null }), {
    actorUid: null,
    role: "watch",
  });
  const paired = response(snapshot({ revision: 2 }), {
    actorUid: "guest",
    role: "guest",
  });
  const h = harness({
    initial: pending,
    read: (attempt) => (attempt === 1 ? pending : paired),
    join: () => {
      throw new Error("request-timeout");
    },
  });
  await h.connect(true);
  assert.equal(h.instance.activeContext.role, "guest");
  assert.deepEqual(
    h.events.matchReads.map(({ playerId, matchId }) => ({ playerId, matchId })),
    [{ playerId: "guest", matchId: "invite" }],
  );
  assert.deepEqual(h.events.legacyReads, []);
  h.instance.detachFromMatchSession();
});

test("pending hosts observe a guest arrival and retain their existing wager snapshot", async () => {
  const h = harness({ initial: response(snapshot({ guestId: null })) });
  await h.connect();
  const current = h.instance.activeContext;
  h.instance.inviteReactionSubscription = {
    channel: { refresh: () => h.events.ui.push("reactions-woke") },
    stop() {},
  };
  h.channel().emit(snapshot({ revision: 2 }));
  assert.strictEqual(h.instance.activeContext, current);
  assert.deepEqual(h.events.observed, [["guest", "invite"]]);
  assert.ok(h.events.ui.includes("reactions-woke"));
  h.instance.detachFromMatchSession();
});

test("pending watchers re-resolve their role when another player takes the guest slot", async () => {
  const h = harness({
    initial: response(snapshot({ guestId: null }), {
      actorUid: null,
      role: "watch",
    }),
  });
  await h.connect();
  const reconnects = [];
  h.instance.connectToGame = (...args) => reconnects.push(args);
  h.channel().emit(snapshot({ revision: 2 }));
  assert.deepEqual(reconnects, [["login", "invite", false]]);
  assert.ok(h.events.ui.includes("join-button"));
  h.instance.detachFromMatchSession();
});

test("HTTP viewer updates reconcile private operation IDs even when metadata revision is unchanged", async () => {
  const h = harness();
  await h.connect();
  h.operations.set("login", {
    operationId: "private-operation",
    resolvedInviteId: null,
  });
  h.channel().emit(snapshot(), {
    role: "host",
    actorUid: "host",
    automatchOperationId: "private-operation",
  });
  await settle();
  assert.equal(h.operations.has("login"), false);
  assert.equal("automatchOperationId" in h.instance.latestInvite, false);
  h.instance.detachFromMatchSession();
});

test("both rematch sides update atomically and spectator navigation discards the old channel", async () => {
  const h = harness({
    initial: response(snapshot(), { actorUid: null, role: "watch" }),
    onMetadata: (instance) =>
      instance.tryNavigateWatchOnlyToLatestApprovedMatch(),
  });
  await h.connect();
  const old = h.channel();
  let staleRefreshes = 0;
  h.instance.maybeRefreshContextAfterRematchMetadata = () => staleRefreshes++;
  old.emit(snapshot({ revision: 2, hostRematches: "1", guestRematches: "1" }));
  assert.deepEqual(h.events.metadata, [["1", "1"]]);
  assert.equal(h.instance.activeContext.matchId, "invite1");
  assert.equal(old.stops, 1);
  assert.equal(staleRefreshes, 0);
  old.emit(
    snapshot({ revision: 3, hostRematches: "1;2", guestRematches: "1;2" }),
  );
  assert.equal(h.instance.activeContext.matchId, "invite1");
  assert.equal(h.events.metadata.length, 1);
  h.instance.detachFromMatchSession();
});

test("an unchanged first snapshot still reconciles rematch UI once for its new context", async () => {
  const value = snapshot({ hostRematches: "1", guestRematches: "1" });
  const h = harness({ initial: response(value) });
  await h.connect();
  h.channel().emit(value);
  h.channel().emit(value);
  assert.deepEqual(h.events.metadata, [["1", "1"]]);
  h.instance.detachFromMatchSession();
});

test("a pending local proposal defers context rotation and preserves a committed response against stale metadata", async () => {
  const pending = deferred();
  const h = harness({ propose: () => pending.promise });
  await h.connect();
  const previous = h.instance.activeContext;
  h.instance.sendRematchProposal();
  h.channel().emit(
    snapshot({ revision: 2, hostRematches: "1", guestRematches: "1" }),
  );
  assert.strictEqual(h.instance.activeContext, previous);
  pending.resolve({
    ok: true,
    inviteId: "invite",
    actorUid: "host",
    matchId: "invite1",
    rematches: "1",
    match,
  });
  await settle();
  assert.equal(h.instance.activeContext.matchId, "invite1");
  h.channel().emit(snapshot({ revision: 2 }));
  assert.equal(h.instance.latestInvite.hostRematches, "1");
  assert.equal(h.instance.latestInvite.guestRematches, "1");
  assert.ok(h.events.ui.includes("proposal-created"));
  h.instance.detachFromMatchSession();
});

test("end intent is durable before optimistic Finished and survives busy rejection and reload", async () => {
  const pending = deferred();
  const records = new Map();
  let originalRequest;
  const h = harness({
    records,
    end: (request) => {
      originalRequest = request;
      return pending.promise;
    },
  });
  await h.connect();
  assert.equal(clickEndMatch(h), true);
  assert.ok(h.events.ui.includes("optimistic-ended"));
  assert.equal(h.instance.latestInvite.hostRematches, "");
  assert.equal(h.instance.rematchSeriesEndIsIndicated(), true);
  assert.equal(records.size, 1);
  await settle();
  pending.reject(Object.assign(new Error("invite-busy"), { code: "aborted" }));
  await settle();
  assert.equal(records.size, 1);
  assert.equal(h.instance.rematchSeriesEndIsIndicated(), true);
  h.channel().emit(snapshot({ revision: 2 }));
  assert.equal(records.size, 1);
  h.pauseEnds();
  h.instance.detachFromMatchSession();

  const resumed = deferred();
  let resumedRequest;
  const reloaded = harness({
    records,
    end: (request) => {
      resumedRequest = request;
      return resumed.promise;
    },
  });
  await reloaded.connect();
  assert.ok(reloaded.events.ui.includes("ended"));
  assert.equal(reloaded.instance.rematchSeriesEndIsIndicated(), true);
  await settle();
  assert.deepEqual(resumedRequest, originalRequest);
  resumed.resolve({
    ok: true,
    inviteId: "invite",
    actorUid: "host",
    rematches: "x",
  });
  await settle();
  assert.equal(records.size, 0);
  assert.equal(reloaded.instance.latestInvite.hostRematches, "x");
  reloaded.instance.detachFromMatchSession();
});

test("an end still finishes optimistically and saves when browser storage is full", async () => {
  const records = new Map();
  records.set = () => {
    throw new Error("storage-full");
  };
  const pending = deferred();
  let request;
  const h = harness({
    records,
    end: (value) => {
      request = value;
      return pending.promise;
    },
  });
  await h.connect();
  assert.equal(clickEndMatch(h), true);
  assert.ok(h.events.ui.includes("optimistic-ended"));
  assert.equal(h.instance.rematchSeriesEndIsIndicated(), true);
  await settle();
  assert.equal(request.inviteId, "invite");
  pending.resolve({
    ok: true,
    inviteId: "invite",
    actorUid: "host",
    rematches: "x",
  });
  await settle();
  assert.equal(h.instance.latestInvite.hostRematches, "x");
  assert.equal(
    h.instance.getRematchEndDelivery("login", "invite").pending,
    null,
  );
  assert.equal(records.size, 0);
  h.instance.detachFromMatchSession();
});

test("a late failure cannot undo authoritative end confirmation or restore its journal", async () => {
  const pending = deferred();
  const h = harness({ end: () => pending.promise });
  await h.connect();
  assert.equal(clickEndMatch(h), true);
  await settle();
  h.channel().emit(snapshot({ revision: 2, guestRematches: "x" }));
  assert.equal(h.records.size, 0);
  pending.reject(new Error("network-error"));
  await settle();
  assert.equal(h.records.size, 0);
  assert.equal(h.instance.latestInvite.guestRematches, "x");
  h.instance.detachFromMatchSession();
});

test("a successful end updates the current context after same-invite reconnect", async () => {
  const pending = deferred();
  const h = harness({ end: () => pending.promise });
  await h.connect();
  clickEndMatch(h);
  await settle();
  const originalChannel = h.channel();
  await h.connect();
  pending.resolve({
    ok: true,
    inviteId: "invite",
    actorUid: "host",
    rematches: "x",
  });
  await settle();
  assert.equal(h.instance.latestInvite.hostRematches, "x");
  assert.equal(h.records.size, 0);
  assert.equal(originalChannel.refreshes, 0);
  assert.ok(h.channel().refreshes >= 1);
  h.instance.detachFromMatchSession();
});

test("accepted end survives navigation without finishing the replacement invite", async () => {
  const pending = deferred();
  const h = harness({ end: () => pending.promise });
  await h.connect();
  clickEndMatch(h);
  await settle();
  h.setResponse(response(snapshot({ inviteId: "other" })));
  h.instance.connectToGame("login", "other", false);
  await settle();
  pending.resolve({
    ok: true,
    inviteId: "invite",
    actorUid: "host",
    rematches: "x",
  });
  await settle();
  assert.equal(h.instance.latestInvite.hostRematches, "");
  assert.equal(h.records.size, 0);
  assert.equal(h.channel().refreshes, 0);
  h.instance.detachFromMatchSession();
});

test("auth replacement retains the original pending end without changing the new account's invite", async () => {
  const pending = deferred();
  const h = harness({ end: () => pending.promise });
  await h.connect();
  clickEndMatch(h);
  await settle();
  h.instance.auth.currentUser = { uid: "replacement" };
  pending.resolve({
    ok: true,
    inviteId: "invite",
    actorUid: "host",
    rematches: "x",
  });
  await settle();
  assert.equal(h.instance.latestInvite.hostRematches, "");
  assert.equal(h.instance.rematchSeriesEndIsIndicated(), false);
  assert.equal(h.records.size, 1);
  h.pauseEnds();
  h.instance.detachFromMatchSession();
});

for (const rejected of [false, true]) {
  test(`a late ${rejected ? "failed" : "successful"} rematch proposal cannot reopen an optimistically ended series`, async () => {
    const proposal = deferred();
    const ending = deferred();
    const h = harness({
      propose: () => proposal.promise,
      end: () => ending.promise,
    });
    await h.connect();
    const context = h.instance.activeContext;
    h.instance.sendRematchProposal();
    assert.equal(clickEndMatch(h), true);
    await settle();
    if (rejected) proposal.reject(new Error("proposal-unavailable"));
    else
      proposal.resolve({
        ok: true,
        inviteId: "invite",
        actorUid: "host",
        matchId: "invite1",
        rematches: "1",
        match,
      });
    await settle();
    assert.equal(h.instance.activeContext, context);
    assert.equal(h.events.ui.includes("proposal-created"), false);
    assert.equal(h.events.ui.includes("proposal-failed"), false);
    assert.equal(h.instance.rematchSeriesEndIsIndicated(), true);
    ending.resolve({
      ok: true,
      inviteId: "invite",
      actorUid: "host",
      rematches: rejected ? "x" : "1x",
    });
    await settle();
    assert.equal(h.records.size, 0);
    h.instance.detachFromMatchSession();
  });
}

test("reload restores Finished on the completed board while flushing the original pending-rematch scope", async () => {
  const record = {
    loginUid: "login",
    inviteId: "invite",
    actorUid: "host",
    matchId: "invite1",
    operationId: "00000000-0000-4000-8000-000000000123",
  };
  const records = new Map([
    [
      rematchEndDeliveryStorageKey(record),
      JSON.stringify({ version: 1, record }),
    ],
  ]);
  const ending = deferred();
  const h = harness({
    records,
    initial: response(snapshot({ hostRematches: "1" })),
    end: () => ending.promise,
  });
  await h.connect();
  assert.equal(h.instance.activeContext.matchId, "invite");
  assert.ok(h.events.ui.includes("ended"));
  assert.equal(h.events.ui.includes("pending-rematch"), false);
  assert.ok(h.events.matchReads.some((value) => value.matchId === "invite1"));
  ending.resolve({
    ok: true,
    inviteId: "invite",
    actorUid: "host",
    rematches: "1x",
  });
  await settle();
  assert.equal(records.size, 0);
  h.instance.detachFromMatchSession();
});

test("an authenticated wake resumes a stored end even without reopening that invite", async () => {
  const record = {
    loginUid: "login",
    inviteId: "invite",
    actorUid: "host",
    matchId: "invite",
    operationId: "00000000-0000-4000-8000-000000000124",
  };
  const records = new Map([
    [
      rematchEndDeliveryStorageKey(record),
      JSON.stringify({ version: 1, record }),
    ],
  ]);
  let request;
  const h = harness({
    records,
    end: (value) => {
      request = value;
      return { ok: true, inviteId: "invite", actorUid: "host", rematches: "x" };
    },
  });
  h.instance.refreshRematchEndDeliveries();
  await settle();
  assert.equal(request.operationId, record.operationId);
  assert.equal(records.size, 0);
  assert.equal(h.events.ui.includes("ended"), false);
});

test("saved end metadata cannot discard the original move barrier after reload on another route", async () => {
  const record = {
    loginUid: "login",
    inviteId: "invite",
    actorUid: "host",
    matchId: "invite1",
    operationId: "00000000-0000-4000-8000-000000000125",
  };
  const records = new Map([
    [
      rematchEndDeliveryStorageKey(record),
      JSON.stringify({ version: 1, record }),
    ],
  ]);
  const barrier = deferred();
  let endRequests = 0;
  const h = harness({
    records,
    initial: response(snapshot({ hostRematches: "1x" })),
    end: () => {
      endRequests++;
    },
  });
  const moves = { hasPendingMoves: true, flush: () => barrier.promise };
  h.instance.getMoveDelivery = (scope) => {
    assert.equal(scope.matchId, "invite1");
    h.instance.moveDeliveries.set(moveDeliveryStorageKey(scope), moves);
    return moves;
  };
  h.instance.refreshRematchEndDeliveries();
  await settle();
  h.instance.confirmRematchEndFromMetadata("login", "invite");
  assert.equal(records.size, 1);
  moves.hasPendingMoves = false;
  barrier.resolve();
  await settle();
  assert.equal(records.size, 0);
  assert.equal(endRequests, 0);
});

test("auth replacement tears down host and spectator metadata resources before callbacks", async () => {
  for (const viewer of [
    { role: "host", actorUid: "host" },
    { role: "watch", actorUid: null },
  ]) {
    const h = harness({ initial: response(snapshot(), viewer) });
    await h.connect();
    const channel = h.channel();
    const wagerChannel = h.wagerChannel();
    const before = h.instance.latestInvite;
    const unsubscribe = h.instance.subscribeToAuthChanges(() => {
      assert.equal(channel.signal.aborted, true);
      assert.equal(wagerChannel.signal.aborted, true);
    });
    h.authChange({ uid: "replacement" });
    assert.equal(channel.stops, 1);
    assert.equal(wagerChannel.stops, 1);
    assert.equal(h.cleanups.size, 0);
    assert.equal(h.counters.get("connectionObservers"), 0);
    channel.emit(snapshot({ revision: 2, hostRematches: "1" }));
    assert.strictEqual(h.instance.latestInvite, before);
    unsubscribe();
    h.instance.detachFromMatchSession();
  }
});

const wagerSnapshot = (revision, wagers = {}, inviteId = "invite") => ({
  inviteId,
  revision,
  wagers,
});
const proposalState = (count) => ({
  proposals: { host: { material: "dust", count } },
});

test("empty Worker wager bootstrap clears the displayed match without any legacy wager read", async () => {
  const h = harness({ wagers: {} });
  await h.connect();
  assert.deepEqual(h.instance.latestInvite.wagers, {});
  assert.deepEqual(h.events.wagerStates.at(-1), {
    matchId: "invite",
    state: null,
  });
  assert.deepEqual(
    h.events.wagerReads.map((read) => read.inviteId),
    ["invite"],
  );
  h.instance.detachFromMatchSession();
  assert.equal(h.wagerChannel().signal.aborted, true);
  assert.equal(h.counters.get("connectionObservers"), 0);
});

test("detaching during wager bootstrap aborts the read and drops its late response", async () => {
  const pending = deferred();
  const h = harness({ readWagers: () => pending.promise });
  h.instance.connectToGame("login", "invite", false);
  await settle();
  assert.equal(h.events.wagerReads.length, 1);
  h.instance.detachFromMatchSession();
  assert.equal(h.events.wagerReads[0].signal.aborted, true);
  pending.resolve({ ok: true, snapshot: wagerSnapshot(2) });
  await settle();
  assert.equal(h.instance.activeContext, null);
  assert.equal(h.events.wagerChannels.length, 0);
  assert.equal(h.events.legacyReads.length, 0);
});

test("account replacement during wager bootstrap never publishes the old account snapshot", async () => {
  const pending = deferred();
  const h = harness({ readWagers: () => pending.promise });
  const unsubscribe = h.instance.subscribeToAuthChanges(() => {});
  h.instance.connectToGame("login", "invite", false);
  await settle();
  h.authChange({ uid: "replacement" });
  assert.equal(h.events.wagerReads[0].signal.aborted, true);
  pending.resolve({ ok: true, snapshot: wagerSnapshot(2) });
  await settle();
  assert.equal(h.instance.activeContext, null);
  assert.equal(h.events.wagerChannels.length, 0);
  assert.equal(h.events.wagerStates.length, 0);
  unsubscribe();
});

test("invite-wide wager snapshots update historical selection and empty snapshots clear it", async () => {
  const h = harness({
    wagers: { invite: proposalState(1), invite1: proposalState(2) },
  });
  await h.connect();
  h.instance.setWagerViewMatchId("invite1");
  assert.equal(h.events.wagerStates.at(-1).state.proposals.host.count, 2);
  h.wagerChannel().emit(
    wagerSnapshot(2, { invite: proposalState(3), invite1: proposalState(4) }),
  );
  assert.equal(h.instance.activeContext.matchId, "invite");
  assert.deepEqual(h.events.wagerStates.at(-1), {
    matchId: "invite1",
    state: proposalState(4),
  });
  assert.equal(h.events.frozenRefreshes, 1);
  h.wagerChannel().emit(wagerSnapshot(3));
  assert.deepEqual(h.events.wagerStates.at(-1), {
    matchId: "invite1",
    state: null,
  });
  assert.deepEqual(h.instance.latestInvite.wagers, {});
  h.instance.detachFromMatchSession();
});

test("internal-only revisions refresh frozen balances while duplicate and older snapshots do not", async () => {
  const wagers = { invite: proposalState(1) };
  const h = harness({ wagers });
  await h.connect();
  h.wagerChannel().emit(wagerSnapshot(2, wagers));
  h.wagerChannel().emit(wagerSnapshot(2, wagers));
  h.wagerChannel().emit(wagerSnapshot(1), "http");
  assert.equal(h.events.frozenRefreshes, 1);
  assert.deepEqual(h.instance.latestInvite.wagers, wagers);
  assert.equal(h.instance.inviteWagersSnapshot.revision, 2);
  h.instance.detachFromMatchSession();
});

test("a stale HTTP response cannot replace a newer socket snapshot", async () => {
  const h = harness();
  await h.connect();
  h.wagerChannel().emit(wagerSnapshot(4, { invite: proposalState(4) }));
  h.wagerChannel().emit(wagerSnapshot(3, { invite: proposalState(3) }), "http");
  assert.equal(h.instance.inviteWagersSnapshot.revision, 4);
  assert.deepEqual(h.instance.latestInvite.wagers.invite, proposalState(4));
  h.instance.detachFromMatchSession();
});

test("mutation generations protect optimistic state and reconcile only a fresh authoritative HTTP snapshot", async () => {
  const h = harness({ wagers: { invite: proposalState(1) } });
  await h.connect();
  const channel = h.wagerChannel();
  const beforeMutation = channel.dependencies.captureGeneration();
  const finish = h.instance.beginWagerSnapshotMutation(
    h.instance.activeContext,
  );
  h.instance.setLocalWagerState(proposalState(9));
  assert.deepEqual(
    h.instance.inviteWagersSnapshot.wagers.invite,
    proposalState(1),
  );
  channel.emit(wagerSnapshot(2, { invite: proposalState(2) }));
  assert.deepEqual(h.instance.latestInvite.wagers.invite, proposalState(9));
  finish();
  assert.equal(channel.refreshes, 1);
  channel.emit(
    wagerSnapshot(2, { invite: proposalState(2) }),
    "http",
    beforeMutation,
  );
  channel.emit(wagerSnapshot(3, { invite: proposalState(3) }));
  channel.emit(wagerSnapshot(2, { invite: proposalState(2) }), "http");
  assert.deepEqual(h.instance.latestInvite.wagers.invite, proposalState(9));
  assert.equal(channel.dependencies.needsHttpRefresh(), true);
  channel.emit(wagerSnapshot(3, { invite: proposalState(3) }), "http");
  assert.deepEqual(h.instance.latestInvite.wagers.invite, proposalState(3));
  assert.equal(channel.dependencies.needsHttpRefresh(), false);
  h.instance.detachFromMatchSession();
});

test("successful and failed mutations both reconcile optimistic changes at the same canonical revision", async () => {
  for (const fails of [false, true]) {
    const h = harness({ wagers: {} });
    await h.connect();
    const pending = deferred();
    const channel = h.wagerChannel();
    const mutation = h.instance.runWagerMutation(async () => {
      h.instance.setLocalWagerState(proposalState(9));
      return pending.promise;
    }, false);
    const completion = fails
      ? assert.rejects(mutation, /mutation-failed/)
      : mutation;
    await settle();
    assert.equal(h.instance.pendingWagerMutations.size, 1);
    if (fails) pending.reject(new Error("mutation-failed"));
    else pending.resolve({ ok: true });
    await completion;
    assert.equal(h.instance.pendingWagerMutations.size, 0);
    assert.equal(channel.refreshes, 1);
    channel.emit(wagerSnapshot(1), "http");
    assert.deepEqual(h.instance.latestInvite.wagers, {});
    assert.equal(h.events.wagerStates.at(-1).state, null);
    h.instance.detachFromMatchSession();
  }
});

test("overlapping mutations hold snapshots until every mutation finishes", async () => {
  const h = harness({ wagers: {} });
  await h.connect();
  const first = h.instance.beginWagerSnapshotMutation(h.instance.activeContext);
  const second = h.instance.beginWagerSnapshotMutation(
    h.instance.activeContext,
  );
  h.instance.setLocalWagerState(proposalState(9));
  first();
  h.wagerChannel().emit(wagerSnapshot(2), "http");
  assert.deepEqual(h.instance.latestInvite.wagers.invite, proposalState(9));
  second();
  h.wagerChannel().emit(wagerSnapshot(2), "http");
  assert.deepEqual(h.instance.latestInvite.wagers, {});
  h.instance.detachFromMatchSession();
});

test("rematch contexts retain historical wagers and refresh the new channel when an old settlement finishes", async () => {
  const h = harness({
    wagers: { invite: proposalState(1), invite1: proposalState(2) },
  });
  await h.connect();
  const oldChannel = h.wagerChannel();
  const finish = h.instance.beginWagerSnapshotMutation(
    h.instance.activeContext,
  );
  h.instance.sendRematchProposal();
  await settle();
  assert.equal(oldChannel.stops, 1);
  assert.equal(h.instance.activeContext.matchId, "invite1");
  assert.deepEqual(h.events.wagerStates.at(-1), {
    matchId: "invite1",
    state: proposalState(2),
  });
  oldChannel.emit(wagerSnapshot(8));
  assert.equal(h.instance.inviteWagersSnapshot.revision, 1);
  finish();
  assert.equal(h.wagerChannel().refreshes, 1);
  h.wagerChannel().emit(
    wagerSnapshot(2, { invite: proposalState(3), invite1: proposalState(2) }),
    "http",
  );
  h.instance.setWagerViewMatchId("invite");
  assert.deepEqual(h.events.wagerStates.at(-1).state, proposalState(3));
  h.instance.detachFromMatchSession();
  assert.equal(h.counters.get("connectionObservers"), 0);
});

test("a stale in-flight match snapshot cannot undo a confirmed surrender", async () => {
  const pendingRead = deferred();
  const h = harness({
    readMatch: (attempt) =>
      attempt === 1 ? { ...match } : pendingRead.promise,
  });
  await h.connect();
  h.instance.connectToGame("login", "invite", false);
  await settle();
  assert.equal(h.events.matchReads.length, 2);
  assert.equal(h.instance.surrender(), true);
  await settle();
  assert.equal(h.events.surrenders.length, 1);
  pendingRead.resolve({ ...match, status: "" });
  await settle();
  assert.deepEqual(h.events.errors, []);
  assert.equal(h.instance.myMatch.status, "surrendered");
  assert.equal(h.events.recoveredMatches.at(-1).status, "surrendered");
  h.instance.detachFromMatchSession();
});

test("confirmed surrender hydration is restricted to its original login and match", async () => {
  for (const overrides of [
    { loginUid: "other" },
    { inviteId: "other" },
    { matchId: "invite1" },
    { playerId: "guest" },
  ]) {
    const h = harness();
    h.instance.confirmedSurrenders.add(
      moveDeliveryStorageKey({
        loginUid: "login",
        inviteId: "invite",
        matchId: "invite",
        playerId: "host",
        ...overrides,
      }),
    );
    await h.connect();
    assert.equal(h.instance.myMatch.status, "");
    assert.equal(h.events.recoveredMatches.at(-1).status, "");
    h.instance.detachFromMatchSession();
  }
});

test("reconnect keeps the latest wager snapshot received while metadata bootstrap is pending", async () => {
  const pending = deferred();
  const h = harness({
    read: (attempt) => (attempt === 1 ? response() : pending.promise),
  });
  await h.connect();
  h.instance.connectToGame("login", "invite", false);
  h.wagerChannel().emit(wagerSnapshot(3, { invite: proposalState(3) }));
  pending.resolve(response());
  await settle();
  assert.deepEqual(h.events.errors, []);
  assert.equal(h.instance.inviteWagersSnapshot.revision, 3);
  assert.deepEqual(h.instance.latestInvite.wagers.invite, proposalState(3));
  assert.equal(h.events.wagerReads.length, 1);
  h.instance.detachFromMatchSession();
});

test("same-invite reconnect preserves pending wager mutations and reconciles after completion", async () => {
  for (const fails of [false, true]) {
    const h = harness({ wagers: {} });
    await h.connect();
    const pending = deferred();
    const mutation = h.instance.runWagerMutation(async () => {
      h.instance.setLocalWagerState(proposalState(9));
      return pending.promise;
    }, false);
    await settle();
    const oldContext = h.instance.activeContext;
    const oldChannel = h.wagerChannel();
    h.instance.connectToGame("login", "invite", false);
    await settle();
    assert.deepEqual(h.events.errors, []);
    assert.notEqual(
      h.instance.activeContext.sessionEpoch,
      oldContext.sessionEpoch,
    );
    assert.equal(oldChannel.stops, 1);
    assert.equal(h.instance.pendingWagerMutations.size, 1);
    const channel = h.wagerChannel();
    const beforeCompletion = channel.dependencies.captureGeneration();
    channel.emit(wagerSnapshot(1), "http");
    assert.deepEqual(h.instance.latestInvite.wagers.invite, proposalState(9));
    if (fails) pending.reject(new Error("mutation-failed"));
    else pending.resolve({ ok: true });
    await mutation;
    assert.equal(h.instance.pendingWagerMutations.size, 0);
    assert.equal(oldChannel.refreshes, 0);
    assert.equal(channel.refreshes, 1);
    assert.ok(channel.dependencies.captureGeneration() > beforeCompletion);
    channel.emit(wagerSnapshot(1), "http", beforeCompletion);
    assert.deepEqual(h.instance.latestInvite.wagers.invite, proposalState(9));
    assert.equal(channel.dependencies.needsHttpRefresh(), true);
    channel.emit(wagerSnapshot(1), "http");
    assert.deepEqual(h.instance.latestInvite.wagers, {});
    assert.equal(channel.dependencies.needsHttpRefresh(), false);
    h.instance.detachFromMatchSession();
    assert.equal(h.counters.get("connectionObservers"), 0);
  }
});

test("an account switch invalidates old wager tickets even if that account reconnects again", async () => {
  const h = harness({ wagers: {} });
  await h.connect();
  h.instance.subscribeToAuthChanges(() => {});
  const pending = deferred();
  const mutation = h.instance.runWagerMutation(
    async () => pending.promise,
    false,
  );
  await settle();
  assert.equal(h.instance.pendingWagerMutations.size, 1);
  h.authChange({ uid: "replacement" });
  assert.equal(h.instance.pendingWagerMutations.size, 0);
  h.authChange({ uid: "login" });
  h.instance.connectToGame("login", "invite", false);
  await settle();
  const channel = h.wagerChannel();
  pending.resolve({ ok: true });
  await mutation;
  assert.equal(channel.refreshes, 0);
  h.instance.detachFromMatchSession();
});

test("stale settlement restoration cannot modify another invite even with a matching match ID", async () => {
  const h = harness();
  await h.connect();
  const optimistic = { resolved: { optimistic: true } };
  h.instance.setLocalWagerState(optimistic);
  h.instance.restoreOptimisticWagerResolution(
    "invite",
    proposalState(1),
    () => false,
    () => false,
  );
  assert.deepEqual(h.instance.latestInvite.wagers.invite, optimistic);
  h.instance.restoreOptimisticWagerResolution(
    "invite",
    proposalState(1),
    () => false,
    () => true,
  );
  assert.deepEqual(h.instance.latestInvite.wagers.invite, proposalState(1));
  h.instance.detachFromMatchSession();
});

test("detaching invalidates pending mutation completion and stale channel callbacks without observer leaks", async () => {
  const h = harness();
  await h.connect();
  const finish = h.instance.beginWagerSnapshotMutation(
    h.instance.activeContext,
  );
  const channel = h.wagerChannel();
  h.instance.detachFromMatchSession();
  finish();
  channel.emit(wagerSnapshot(9));
  assert.equal(h.instance.latestInvite, null);
  assert.equal(channel.refreshes, 0);
  assert.equal(channel.stops, 1);
  assert.equal(h.instance.pendingWagerMutations.size, 0);
  assert.equal(h.counters.get("connectionObservers"), 0);
  assert.equal(h.cleanups.size, 0);
});

test("a replacement account reconnecting to the same invite bootstraps its own canonical wager snapshot", async () => {
  const h = harness({ wagers: {} });
  await h.connect();
  const finish = h.instance.beginWagerSnapshotMutation(
    h.instance.activeContext,
  );
  h.instance.setLocalWagerState(proposalState(9));
  h.instance.auth.currentUser = { uid: "replacement" };
  h.instance.connectToGame("replacement", "invite", false);
  await settle();
  assert.deepEqual(h.events.errors, []);
  assert.equal(h.instance.activeContext.loginUid, "replacement");
  assert.equal(h.events.wagerReads.length, 2);
  assert.deepEqual(h.instance.latestInvite.wagers, {});
  finish();
  assert.equal(h.wagerChannel().refreshes, 0);
  h.instance.detachFromMatchSession();
});
