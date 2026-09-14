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
const harnessSource = `import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useNavigationGames } from '/src/ui/controls/useNavigationGames.ts';
import NavigationPicker from '/src/ui/NavigationPicker.tsx';
import { resolveNavigationGamesCacheScope, writeNavigationGamesRuntimeCache } from '/src/services/navigationGamesCache.ts';
const subscriptions = [];
const pages = [];
const commits = [];
let epoch = 0;
let current;
const root = createRoot(document.getElementById('root'));
const client = {
  createSessionGuard() { const start = epoch; return () => start === epoch; },
  subscribeProfileGames(limit, update, error, meta) {
    const entry = { limit, update, error, meta, active: true };
    subscriptions.push(entry);
    return () => { entry.active = false; };
  },
  getProfileGamesPage(limit, cursor) {
    return new Promise((resolve, reject) => pages.push({limit, cursor, resolve, reject}));
  },
  removeWaitingNavigationGame() { return Promise.resolve({ok: true}); },
};
const game = (id, n = 1) => ({ id, entityType: 'game', inviteId: id, kind: 'direct', status: 'waiting', sortBucket: 30, listSortAtMs: n });
const event = (profile) => ({ id: 'event_e', entityType: 'event', eventId: 'e', status: 'active', sortBucket: 10, listSortAtMs: 1, startAtMs: 1, updatedAtMs: 1, endedAtMs: null, participantCount: 1, participantPreview: [{profileId: profile, displayName: profile, emojiId: 1, aura: null}], winnerDisplayName: null });
function Probe({profileId, isOpen, showPicker}) {
  const nav = useNavigationGames({profileId, authStatus: profileId ? 'authenticated' : 'unauthenticated', isOpen, client});
  const [avatars, setAvatars] = useState([]);
  const eventRef = useRef(null);
  useEffect(() => { eventRef.current = null; setAvatars([]); }, [profileId]);
  useEffect(() => {
    if (eventRef.current === 'e') return;
    eventRef.current = 'e';
    setAvatars(nav.getEventParticipantPreview('e').slice(0, 4));
  }, [nav.getEventParticipantPreview]);
  const shownAvatars = useMemo(() => avatars.length ? avatars : nav.getEventParticipantPreview('e').slice(0,4), [avatars, nav.getEventParticipantPreview]);
  const state = {profileId, snapshotProfile: nav.profileId, top: nav.topGames.map(x=>x.id), paged: nav.pagedGames.map(x=>x.id), loading:nav.isLoading, loadingMore:nav.isLoadingMore, hasMore:nav.hasMore, avatars:shownAvatars.map(x=>x.profileId)};
  useLayoutEffect(() => { current = nav; commits.push(state); });
  return React.createElement(React.Fragment, null,
    React.createElement('pre', {id:'state'}, JSON.stringify(state)),
    showPicker && isOpen ? React.createElement(NavigationPicker, {showsHomeNavigation:false, topGames:nav.topGames, pagedGames:nav.pagedGames, isGamesLoading:nav.isLoading, isLoadingMoreGames:nav.isLoadingMore, hasMoreGames:nav.hasMore, onSelectProblem:()=>{}, onLoadMoreGames:nav.loadMore}) : null);
}
function render(profileId='a', isOpen=true, showPicker=false) {
  flushSync(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Probe, {profileId,isOpen,showPicker}))));
}
const cursor = n => ({sortBucket:30,listSortAtMs:n,id:'cursor_'+n});
window.harness = {
  render, game, event, cursor, commits, subscriptions, pages,
  seed(profile, top, paged=[]) { writeNavigationGamesRuntimeCache(resolveNavigationGamesCacheScope(profile), top, paged); },
  snapshot() { return JSON.parse(document.getElementById('state').textContent); },
  update(items, meta) {const sub=subscriptions.findLast(x=>x.active); flushSync(()=>{sub.update(items); if(meta)sub.meta(meta);});},
  deliverItems(subscription, items) { flushSync(() => subscription.update(items)); },
  guard() { return current.createProfileRequestGuard(); },
  setOptimistic(item) {flushSync(()=>current.setOptimisticPendingAutomatch(item));},
  async resolvePage(index, result) {pages[index].resolve(result); await new Promise(r=>setTimeout(r,0));},
  dispose() {flushSync(()=>root.unmount());},
};
`;

async function fixture(run) {
  const server = await createServer({
    root: repository,
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
        name: "navigation-browser-fixture",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__navigation") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<div id="root"></div><script type="module" src="/__navigation-harness.js"></script>',
            );
          });
        },
        resolveId(id, importer) {
          if (id === "/__navigation-harness.js") return "\0navigation-harness";
          if (
            importer?.endsWith("/NavigationPicker.tsx") &&
            id === "../content/problems"
          )
            return "\0navigation-problems";
          if (
            importer?.endsWith("/NavigationPicker.tsx") &&
            id === "../hooks/useGameAssets"
          )
            return "\0navigation-assets";
        },
        load(id) {
          if (id === "\0navigation-harness") return harnessSource;
          if (id === "\0navigation-problems")
            return "export const problems=[]; export const getCompletedProblemIds=()=>new Set();";
          if (id === "\0navigation-assets")
            return "export const useGameAssets=()=>({assets:null,isLoading:false});";
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
    await page.goto(`${origin}/__navigation`);
    await page.waitForFunction(() => !!window.harness);
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}

test(
  "navigation hook survives StrictMode replay and isolates profile rows, guards, and avatar consumers",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const result = await page.evaluate(() => {
        const h = window.harness;
        h.seed("a", [h.event("a"), h.game("a-game")]);
        h.seed("b", [h.event("b"), h.game("b-game")]);
        h.render("a", true);
        const initial = h.snapshot();
        const activeAfterMount = h.subscriptions.filter(
          (subscription) => subscription.active,
        ).length;
        const mountStarts = h.subscriptions.length;
        const guard = h.guard();
        const oldSubscription = h.subscriptions.find(
          (subscription) => subscription.active,
        );
        h.render("b", true);
        const profileB = h.snapshot();
        const guardAfterSwitch = guard();
        h.deliverItems(oldSubscription, [h.game("stale-a")]);
        const afterStale = h.snapshot();
        h.render("a", true);
        const guardAfterRoundTrip = guard();
        const closingGuard = h.guard();
        h.render("a", false);
        const closed = h.snapshot();
        const guardAfterClose = closingGuard();
        const activeClosed = h.subscriptions.filter(
          (subscription) => subscription.active,
        ).length;
        h.render("a", true);
        const reopened = h.snapshot();
        const leakingCommits = h.commits.filter(
          (commit) => commit.profileId === "b" && commit.top.includes("a-game"),
        );
        h.render("", false);
        h.setOptimistic({
          ...h.game("anonymous-pending"),
          status: "pending",
          kind: "auto",
          isOptimistic: true,
        });
        const anonymous = h.snapshot();
        const unmountGuard = h.guard();
        h.dispose();
        return {
          initial,
          activeAfterMount,
          mountStarts,
          profileB,
          afterStale,
          guardAfterSwitch,
          guardAfterRoundTrip,
          closed,
          guardAfterClose,
          activeClosed,
          reopened,
          leakingCommits,
          anonymous,
          guardAfterUnmount: unmountGuard(),
        };
      });
      assert.equal(result.activeAfterMount, 1);
      assert.equal(result.mountStarts, 2);
      assert.deepEqual(result.initial.avatars, ["a"]);
      assert.deepEqual(result.profileB.avatars, ["b"]);
      assert.equal(result.guardAfterSwitch, false);
      assert.equal(result.guardAfterRoundTrip, false);
      assert.equal(result.guardAfterClose, true);
      assert.equal(result.activeClosed, 0);
      assert.equal(result.closed.loading, false);
      assert.equal(result.reopened.loading, true);
      assert.equal(result.guardAfterUnmount, false);
      assert.deepEqual(result.leakingCommits, []);
      assert.deepEqual(result.anonymous.top, ["anonymous-pending"]);
      assert.equal(result.afterStale.top.includes("stale-a"), false);
    });
  },
);

test(
  "navigation picker can load the next page after scrolling during a warm cache refresh",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => {
        const h = window.harness;
        const top = Array.from({ length: 35 }, (_, index) =>
          h.game(`top_${index}`, index),
        );
        const paged = Array.from({ length: 10 }, (_, index) =>
          h.game(`page_${index}`, 100 + index),
        );
        h.seed("a", top, paged);
        h.render("a", true, true);
        h.update(top, { items: top, hasMore: true, nextCursor: h.cursor(1) });
      });
      const scrollToBottom = () =>
        page.evaluate(() => {
          const scrollable = Array.from(document.querySelectorAll("div")).find(
            (element) => getComputedStyle(element).overflowY === "auto",
          );
          scrollable.scrollTop = scrollable.scrollHeight;
          scrollable.dispatchEvent(new Event("scroll", { bubbles: true }));
          return {
            pageRequests: window.harness.pages.length,
            isScrollable: scrollable.scrollHeight > scrollable.clientHeight,
          };
        });
      assert.deepEqual(await scrollToBottom(), {
        pageRequests: 1,
        isScrollable: true,
      });
      await page.evaluate(async () => {
        const h = window.harness;
        await h.resolvePage(0, {
          items: Array.from({ length: 10 }, (_, index) =>
            h.game(`page_${index}`, 200 + index),
          ),
          hasMore: true,
          nextCursor: h.cursor(2),
        });
      });
      await scrollToBottom();
      await page.waitForFunction(() => window.harness.pages.length === 2);
      const nextPage = await page.evaluate(() => ({
        request: window.harness.pages[1].cursor,
        expected: window.harness.cursor(2),
        snapshot: window.harness.snapshot(),
      }));
      assert.deepEqual(nextPage.request, nextPage.expected);
      assert.equal(nextPage.snapshot.loadingMore, true);
    });
  },
);
