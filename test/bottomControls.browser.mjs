import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const repository = fileURLToPath(new URL("../", import.meta.url));
const sharedManifest = JSON.parse(
  readFileSync(
    new URL("../cloud/runtime/shared/package.json", import.meta.url),
    "utf8",
  ),
);
const sharedImports = Object.keys(sharedManifest.exports).map(
  (subpath) => sharedManifest.name + subpath.slice(1),
);
const environmentSource = `
export const environment = {
  route: { mode: 'home', path: '' },
  epoch: 0,
  calls: [],
  callbacks: {},
  automatchRequests: [],
  cancelRequests: [],
  subscriptions: [],
  transientHandlers: new Set(),
};
export const pendingGame = (inviteId) => ({
  id: inviteId, inviteId, entityType: 'game', kind: 'auto',
  status: 'pending', sortBucket: 20, listSortAtMs: 1,
});
`;
const controllerSource = `
import { environment } from 'bottom-environment';
const invoke = (name, ...args) => {
  environment.calls.push([name, ...args]);
  environment.callbacks[name]?.(...args);
};
export const didClickStartTimerButton = () => invoke('timer');
export const didClickClaimVictoryByTimerButton = () => invoke('claim');
export const didClickPrimaryActionButton = action => invoke('primary', action);
export const didClickAutomatchButton = callback => environment.automatchRequests.push(callback);
export const dismissPendingAutomatchTransition = () => invoke('dismiss');
export const canHandleUndo = () => true;
export const isGameWithBot = false;
export const puzzleMode = false;
export const isOnlineGame = false;
export const isWatchOnly = false;
export const isMatchOver = () => false;
export const getBoardViewMode = () => 'activeLive';
export const getRematchSeriesNavigatorItems = () => [];
export const preloadRematchSeriesScores = async () => false;
export const getSelectedPuzzleId = () => null;
export const didClickUndoButton = () => invoke('undo');
export const didClickAutomoveButton = () => invoke('automove');
export const didClickHomeButton = () => invoke('home');
export const didClickInviteActionButtonBeforeThereIsInviteReady = () => {};
export const didClickStartBotGameButton = () => {};
export const didClickEndMatchButton = () => invoke('end');
export const didClickConfirmResignButton = () => invoke('resign');
export const playSameCompletedPuzzleAgain = () => {};
export const didSelectRematchSeriesMatch = () => {};
export const didSelectPuzzle = () => {};
`;
const connectionSource = `
import { environment, pendingGame } from 'bottom-environment';
export const connection = {
  createSessionGuard() { const epoch = environment.epoch; return () => epoch === environment.epoch; },
  subscribeProfileGames(limit, update, error, meta) {
    const subscription = { update, meta, active: true };
    environment.subscriptions.push(subscription);
    return () => { subscription.active = false; };
  },
  getProfileGamesPage: async () => ({ items: [], nextCursor: null, hasMore: false }),
  removeWaitingNavigationGame: async () => ({ ok: true }),
  createOptimisticPendingAutomatchItem: pendingGame,
  cancelAutomatch: () => new Promise((resolve, reject) => environment.cancelRequests.push({ resolve, reject })),
  connectToInvite(inviteId) {
    environment.calls.push(['connect', inviteId]);
    environment.route = { mode: 'invite', inviteId, path: inviteId };
  },
  getCurrentInviteEventId: () => null,
  isCurrentInviteEventOwned: () => false,
  rematchSeriesEndIsIndicated: () => false,
};
`;
const sessionSource = `
import { environment } from 'bottom-environment';
export const getCurrentTarget = () => environment.route;
export const isTransitionInProgress = () => false;
export const transitionToHome = async options => {
  environment.calls.push(['transitionHome', options]);
  environment.route = { mode: 'home', path: '' };
};
`;
const transientSource = `
import { environment } from 'bottom-environment';
export const registerBottomControlsTransientUiHandler = (close, clear) => {
  const handlers = { close, clear };
  environment.transientHandlers.add(handlers);
  return () => environment.transientHandlers.delete(handlers);
};
`;
const navigationSource = `
import React from 'react';
export default function NavigationPicker({ topGames, onSelectGame }) {
  return React.createElement('div', { 'data-testid': 'navigation-picker' },
    topGames.map(item => React.createElement('button', {
      key: item.id, onClick: () => onSelectGame(item, { status: item.status }),
    }, 'Open ' + item.id)));
}
`;
const harnessSource = `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import BottomControls from '/src/ui/BottomControls.tsx';
import * as port from '/src/ui/controls/bottomControlsPort.ts';
import { getLifecycleCounters } from '/src/lifecycle/lifecycleDiagnostics.ts';
import { environment, pendingGame } from 'bottom-environment';
let root = createRoot(document.getElementById('root'));
const run = callback => flushSync(callback);
const settle = async callback => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try { await act(callback); }
  finally { globalThis.IS_REACT_ACT_ENVIRONMENT = false; }
};
window.harness = {
  environment, port, run,
  render(profileId = 'a') {
    run(() => root.render(React.createElement(React.StrictMode, null,
      React.createElement(BottomControls, {
        authState: { profileId, authStatus: 'authenticated', solAddress: '', ethAddress: '' },
      }))));
  },
  async respondAutomatch(index, response, enterWaiting = true) {
    await settle(async () => {
      environment.automatchRequests[index](response);
      if (enterWaiting) {
        environment.route = { mode: 'invite', inviteId: response.inviteId, path: response.inviteId };
        port.setAutomatchWaitingState(true);
      }
    });
  },
  async respondCancel(index, result, reject = false) {
    await settle(async () => {
      const request = environment.cancelRequests[index];
      if (reject) request.reject(new Error('temporary cancellation failure'));
      else request.resolve(result);
    });
  },
  publishPending(inviteId) {
    run(() => environment.subscriptions.findLast(subscription => subscription.active).update([pendingGame(inviteId)]));
  },
  resetMatch() {
    run(() => environment.transientHandlers.forEach(({ close, clear }) => { close(); clear(); }));
  },
  counters: getLifecycleCounters,
  dispose() { run(() => root.unmount()); },
};
window.harness.render();
`;

async function fixture(run) {
  const modules = new Map([
    ["bottom-environment", environmentSource],
    ["bottom-controller", controllerSource],
    ["bottom-connection", connectionSource],
    ["bottom-session", sessionSource],
    ["bottom-transient", transientSource],
    ["bottom-navigation", navigationSource],
    ["bottom-harness", harnessSource],
  ]);
  const replacements = new Map([
    ["../game/gameController", "bottom-controller"],
    ["../connection/connection", "bottom-connection"],
    ["../session/AppSessionManager", "bottom-session"],
    ["./uiSession", "bottom-transient"],
    ["./NavigationPicker", "bottom-navigation"],
  ]);
  const stubs = new Map([
    [
      "../hooks/useAvailableMaterials",
      "export const useAvailableMaterials = () => ({ availableMaterials: {}, frozenMaterialsStatus: 'ready', hasConfirmedSnapshot: true });",
    ],
    [
      "../hooks/useMaterialImages",
      "export const useMaterialImages = () => ({});",
    ],
    [
      "../utils/misc",
      "export const isMobile = false; export const defaultEarlyInputEventName = 'mousedown';",
    ],
    [
      "../utils/SoundPlayer",
      "export const soundPlayer = { initializeOnUserInteraction() {} };",
    ],
    [
      "../content/sounds",
      "export const playReaction = () => {}; export const playSounds = () => {}; export const newReactionOfKind = () => ({}); export const newStickerReaction = () => ({});",
    ],
    [
      "./controls/boardReactionPort",
      "export const showVoiceReactionText = () => {}; export const showVideoReaction = () => {}; export const isMetadataSideDisplayedAtOpponentSlot = () => false; export const getPlayerReactionUid = () => null; export const getOpponentReactionUid = () => null;",
    ],
    [
      "./controls/useReactionPicker",
      "export const STICKER_IMAGE_BASE_URL = ''; export const useReactionPicker = () => ({ visibleStickerIds: [], hasFreshStickerEntitlement: false, stickerUrls: {}, canSendSticker: () => false });",
    ],
    ["./controls/menuPort", "export const closeMenuAndInfoIfAny = () => {};"],
    [
      "./BoardStylePicker",
      "export default () => null; export const preloadPangchiuBoardPreview = () => {};",
    ],
    ["../utils/gameModels", "export const Sound = {};"],
    ["./MoveHistoryPopup", "export default () => null;"],
    [
      "./controls/moveHistoryPopupStore",
      "export const subscribeMoveHistoryPopupReload = () => () => {}; export const triggerMoveHistoryPopupSelectionReset = () => {};",
    ],
    ["../services/rocksMiningService", "export const MATERIALS = [];"],
    [
      "../game/wagerState",
      "export const subscribeToWagerState = () => () => {};",
    ],
    [
      "../utils/playerMetadata",
      "export const getStashedPlayerProfile = () => undefined;",
    ],
    [
      "../navigation/routeState",
      "import { environment } from 'bottom-environment'; export const getCurrentRouteState = () => environment.route;",
    ],
    ["../content/problems", "export const problems = [];"],
    ["../content/emojis", "export const emojis = {};"],
    [
      "./eventModalController",
      "export const getEventModalState = () => ({ isOpen: false, eventId: null }); export const openEventModal = () => {}; export const subscribeToEventModalState = () => () => {};",
    ],
  ]);
  for (const [id, source] of stubs) {
    const name = "bottom-stub-" + id;
    replacements.set(id, name);
    modules.set(name, source);
  }
  const server = await createServer({
    root: repository,
    cacheDir: `node_modules/.vite-bottom-controls-${process.pid}`,
    configFile: false,
    logLevel: "error",
    optimizeDeps: { include: sharedImports },
    server: {
      host: "127.0.0.1",
      port: 0,
      open: false,
      hmr: false,
      watch: null,
    },
    plugins: [
      {
        name: "bottom-controls-browser-fixture",
        enforce: "pre",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__bottom") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<div id="root"></div><script type="module" src="/__bottom-harness.js"></script>',
            );
          });
        },
        resolveId(id, importer) {
          if (id === "/__bottom-harness.js") return "\0bottom-harness";
          if (modules.has(id)) return "\0" + id;
          if (
            importer?.endsWith("/BottomControls.tsx") &&
            replacements.has(id)
          ) {
            return "\0" + replacements.get(id);
          }
          if (
            importer?.endsWith("/outsideTapState.ts") &&
            id === "../../utils/misc"
          ) {
            return "\0" + replacements.get("../utils/misc");
          }
        },
        load(id) {
          return modules.get(id.slice(1));
        },
      },
    ],
  });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.MONS_BROWSER_EXECUTABLE
        ? { executablePath: process.env.MONS_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
    });
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
    });
    context.setDefaultTimeout(15000);
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const start = new Date("2026-01-01T00:00:00Z");
    await page.clock.install({ time: start });
    await page.clock.pauseAt(start);
    await page.goto(`${origin}/__bottom`);
    await page.waitForFunction(() => !!window.harness, null, { polling: 50 });
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}

const button = (page, name) => page.getByRole("button", { name, exact: true });
const click = async (page, name) =>
  button(page, name).evaluate((element) =>
    window.harness.run(() => element.click()),
  );
const count = (page, name) => button(page, name).count();
const startAutomatch = async (page) => {
  await page.evaluate(() =>
    window.harness.run(() => {
      window.harness.port.setAutomatchVisible(true);
      window.harness.port.setAutomatchEnabled(true);
    }),
  );
  await click(page, "Automatch");
};

test(
  "BottomControls preserves synchronous controller callback ordering and exclusive confirmations",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => {
        const { port, environment, run } = window.harness;
        environment.callbacks.timer = () =>
          port.showTimerButtonProgressing(20, 20, true);
        environment.callbacks.claim = () => port.enableTimerVictoryClaim();
        environment.callbacks.primary = () =>
          port.showPrimaryAction(port.PrimaryActionType.Rematch);
        run(() => {
          port.setUndoVisible(true);
          port.setUndoEnabled(true);
          port.setAutomoveActionVisible(true);
          port.showResignButton();
          port.showTimerButtonProgressing(10, 10, true);
        });
      });
      assert.equal(await count(page, "Undo"), 0);
      assert.equal(await count(page, "Bot"), 0);
      await click(page, "Timer");
      assert.equal(await count(page, "Start a Timer"), 1);
      await click(page, "Start a Timer");
      assert.equal(await count(page, "Start a Timer"), 0);
      assert.equal(await button(page, "Timer").isDisabled(), true);
      await page.evaluate(() =>
        window.harness.run(() => window.harness.port.enableTimerVictoryClaim()),
      );
      await click(page, "Claim Victory");
      assert.equal(await count(page, "Claim Victory"), 2);
      await button(page, "Claim Victory")
        .last()
        .evaluate((element) => window.harness.run(() => element.click()));
      assert.equal(await count(page, "Claim Victory"), 1);
      assert.equal(await button(page, "Claim Victory").isDisabled(), true);
      await click(page, "Resign");
      assert.equal(await count(page, "Resign"), 2);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.showTimerButtonProgressing(1, 1, true),
        ),
      );
      assert.equal(await count(page, "Resign"), 2);
      await click(page, "Timer");
      assert.equal(await count(page, "Resign"), 1);
      assert.equal(await count(page, "Start a Timer"), 1);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.disableAndHideUndoResignAndTimerControls(),
        ),
      );
      assert.equal(await count(page, "Resign"), 0);
      assert.equal(await count(page, "Start a Timer"), 0);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.showPrimaryAction(
            window.harness.port.PrimaryActionType.JoinGame,
          ),
        ),
      );
      await click(page, "Join Game");
      assert.equal(await count(page, "Join Game"), 0);
      assert.equal(await count(page, "Play Again"), 0);
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.calls),
        [["timer"], ["claim"], ["primary", "joinGame"]],
      );
    });
  },
);

test(
  "ending a match immediately shows Finished and removes Play Again",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => {
        const { port, environment, run } = window.harness;
        environment.callbacks.end = () => {
          port.showPrimaryAction(port.PrimaryActionType.None);
          port.setEndMatchConfirmed(true);
        };
        run(() => {
          port.setEndMatchVisible(true);
          port.showPrimaryAction(port.PrimaryActionType.Rematch);
        });
      });
      assert.equal(await button(page, "End Match").isDisabled(), false);
      assert.equal(await count(page, "Play Again"), 1);
      await click(page, "End Match");
      assert.equal(await button(page, "Finished").isDisabled(), true);
      assert.equal(await count(page, "End Match"), 0);
      assert.equal(await count(page, "Play Again"), 0);
      await click(page, "Finished");
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.calls),
        [["end"]],
      );
    });
  },
);

test(
  "fresh automatch retains its 10-second Cancel deadline across waiting updates and pending navigation reveals immediately",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await startAutomatch(page);
      assert.equal(await count(page, "Cancel"), 0);
      await page.clock.runFor(3000);
      await page.evaluate(() =>
        window.harness.respondAutomatch(0, {
          ok: true,
          mode: "pending",
          inviteId: "fresh",
        }),
      );
      await page.clock.runFor(3000);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.setAutomatchWaitingState(true),
        ),
      );
      await page.clock.runFor(3999);
      assert.equal(await count(page, "Cancel"), 0);
      await page.clock.runFor(1);
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.setAutomatchWaitingState(false),
        ),
      );
      assert.equal(await count(page, "Cancel"), 0);
      assert.equal(await button(page, "Automatch").isDisabled(), true);
      await click(page, "Navigation");
      await page.evaluate(() => window.harness.publishPending("existing"));
      await click(page, "Open existing");
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.setAutomatchWaitingState(true),
        ),
      );
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.calls),
        [["connect", "existing"]],
      );
    });
  },
);

test(
  "automatch cancellation restores retry and ignores results from stale profiles",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.setAutomatchWaitingState(true),
        ),
      );
      await click(page, "Cancel");
      assert.equal(await button(page, "Canceling").isDisabled(), true);
      assert.equal(await count(page, "Automatching"), 0);
      await page.evaluate(() => window.harness.respondCancel(0, { ok: false }));
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      await click(page, "Cancel");
      await page.evaluate(() => window.harness.respondCancel(1, null, true));
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      await click(page, "Cancel");
      await page.evaluate(() => window.harness.render("b"));
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      await click(page, "Cancel");
      await page.evaluate(() => window.harness.respondCancel(2, { ok: true }));
      assert.equal(await button(page, "Canceling").isDisabled(), true);
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.calls),
        [],
      );
      await page.evaluate(() => window.harness.respondCancel(3, { ok: false }));
      await click(page, "Cancel");
      await page.evaluate(() => window.harness.respondCancel(4, { ok: true }));
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.calls),
        [["dismiss"], ["transitionHome", { forceMatchScopeReset: true }]],
      );
    });
  },
);

test(
  "foreground events recover timer and Cancel deadlines without waiting for throttled callbacks",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await startAutomatch(page);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.showTimerButtonProgressing(0, 10, true),
        ),
      );
      assert.equal(await button(page, "Timer").isDisabled(), true);
      await page.clock.setSystemTime(new Date("2026-01-01T00:00:11Z"));
      assert.equal(await button(page, "Timer").isDisabled(), true);
      assert.equal(await count(page, "Cancel"), 0);
      await page.evaluate(() =>
        window.harness.run(() => {
          document.dispatchEvent(new Event("visibilitychange"));
          window.dispatchEvent(new Event("focus"));
          window.dispatchEvent(new Event("pageshow"));
        }),
      );
      assert.equal(await button(page, "Timer").isDisabled(), false);
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      assert.equal(
        await page.evaluate(() => window.harness.counters().uiTimeouts),
        0,
      );
    });
  },
);

test(
  "match reset and StrictMode unmount clear deadlines, transient bindings, and late automatch responses",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      assert.equal(
        await page.evaluate(
          () => window.harness.environment.transientHandlers.size,
        ),
        1,
      );
      await startAutomatch(page);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.showTimerButtonProgressing(0, 10, true),
        ),
      );
      assert.equal(
        await page.evaluate(() => window.harness.counters().uiTimeouts),
        2,
      );
      await page.evaluate(() => window.harness.resetMatch());
      assert.equal(
        await page.evaluate(() => window.harness.counters().uiTimeouts),
        0,
      );
      await page.clock.runFor(10001);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      assert.equal(await button(page, "Timer").isDisabled(), true);
      assert.equal(await count(page, "Cancel"), 0);
      await page.evaluate(() =>
        window.harness.run(() => {
          window.harness.port.setAutomatchWaitingState(false);
          window.harness.port.hideTimerButtons();
        }),
      );
      await startAutomatch(page);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.showTimerButtonProgressing(0, 10, true),
        ),
      );
      assert.equal(
        await page.evaluate(() => window.harness.counters().uiTimeouts),
        2,
      );
      await page.evaluate(() => window.harness.dispose());
      assert.equal(
        await page.evaluate(() => window.harness.counters().uiTimeouts),
        0,
      );
      assert.equal(
        await page.evaluate(
          () => window.harness.environment.transientHandlers.size,
        ),
        0,
      );
      await page.evaluate(() =>
        window.harness.respondAutomatch(1, { ok: false }, false),
      );
      await page.clock.runFor(10001);
      await page.evaluate(() =>
        window.harness.run(() => {
          window.harness.port.showResignButton();
          window.dispatchEvent(new Event("focus"));
        }),
      );
      assert.equal(await page.locator("#root").textContent(), "");
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.calls),
        [],
      );
    });
  },
);
