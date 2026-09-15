import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { createServer as createViteServer } from "vite";
import { Game } from "mons-rules";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const repository = fileURLToPath(new URL("../", import.meta.url));
const inviteId = "FastLoadingGame";
const hostId = "h".repeat(28);
const guestId = "g".repeat(28);
const fen = new Game({ variant: "Classic" }).toFen();
const record = (color) => ({
  version: 2,
  color,
  emojiId: 1,
  aura: "",
  gameVariant: "Classic",
  fen,
  status: "",
  flatMovesString: "",
  timer: "",
});
const metadata = {
  inviteId,
  revision: 1,
  hostId,
  guestId,
  hostColor: "white",
  hostRematches: "",
  guestRematches: "",
  automatchStateHint: null,
  eventId: null,
  eventOwned: false,
};
const viewer = { role: "host", actorUid: hostId, automatchOperationId: null };
const match = {
  inviteId,
  matchId: inviteId,
  revision: 1,
  hostPlayerId: hostId,
  guestPlayerId: guestId,
  hostMatch: record("white"),
  guestMatch: record("black"),
};
const bootstrap = {
  ok: true,
  schemaVersion: 1,
  metadata,
  viewer,
  match,
  hasPendingProposal: false,
};
const benchmark = process.env.MONS_LOADING_BENCHMARK === "1";
const deferred = () => Promise.withResolvers();

async function withinDeadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("loading-fixture-timeout")),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function serve() {
  if (!process.env.MONS_LOADING_BUILD) {
    const server = await createViteServer({
      root: repository,
      logLevel: "error",
      server: {
        host: "127.0.0.1",
        port: 0,
        open: false,
        watch: null,
        hmr: false,
      },
    });
    await server.listen();
    return {
      origin: `http://127.0.0.1:${server.httpServer.address().port}`,
      close: () => server.close(),
    };
  }
  const root = resolve(process.env.MONS_LOADING_BUILD);
  const server = createHttpServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const relative = pathname.startsWith("/assets/")
      ? pathname.slice(1)
      : "index.html";
    try {
      const content = await readFile(resolve(root, relative));
      const type =
        { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[
          extname(relative)
        ] || "application/octet-stream";
      response.writeHead(200, {
        "Content-Type": type,
        "Content-Encoding": "gzip",
      });
      response.end(gzipSync(content));
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

async function fixture(
  run,
  {
    apiDelayMs = 0,
    holdAssets = false,
    holdBootstrap = false,
    holdExtras = true,
    spectator = false,
    paired = true,
    pendingRematch = false,
  } = {},
) {
  const currentMetadata = {
    ...metadata,
    guestId: paired ? guestId : null,
    hostRematches: pendingRematch ? "1" : "",
  };
  const currentViewer = spectator
    ? { role: "watch", actorUid: null, automatchOperationId: null }
    : viewer;
  const currentMatch = {
    ...match,
    matchId: pendingRematch ? `${inviteId}1` : inviteId,
    guestPlayerId: paired ? guestId : null,
    guestMatch: paired && !pendingRematch ? match.guestMatch : null,
  };
  const server = await serve();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.MONS_BROWSER_EXECUTABLE
      ? { executablePath: process.env.MONS_BROWSER_EXECUTABLE }
      : { channel: "chrome" }),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  const assetsGate = deferred();
  const bootstrapGate = deferred();
  const extrasGate = deferred();
  const bootstrapRequested = deferred();
  const selectedAssetsRequested = deferred();
  const requests = [];
  const resources = [];
  const pageErrors = [];
  let closed = false;
  if (!holdAssets) assetsGate.resolve();
  if (!holdBootstrap) bootstrapGate.resolve();
  if (!holdExtras) extrasGate.resolve();
  try {
    await context.routeWebSocket(/wss:\/\/api\.mons\.link\/.*/, () => {});
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      resources.push(url.pathname);
      if (url.origin === server.origin) {
        if (/gameAssetsPixel/.test(url.pathname)) {
          selectedAssetsRequested.resolve();
          await assetsGate.promise;
        }
        if (!closed) await route.continue();
        return;
      }
      if (url.origin !== "https://api.mons.link") return route.abort();
      const headers = {
        "Access-Control-Allow-Origin": server.origin,
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      };
      if (request.method() === "OPTIONS")
        return route.fulfill({ status: 204, headers });
      requests.push({ path: url.pathname, at: Date.now() });
      let body;
      if (url.pathname === "/auth/session/anonymous") {
        const { sessionId } = request.postDataJSON();
        const expiresAt = Math.floor(Date.now() / 1000) + 300;
        body = {
          ok: true,
          sessionId,
          uid: spectator ? "s".repeat(28) : hostId,
          accessToken: `header.${Buffer.from(JSON.stringify({ iat: expiresAt - 300, exp: expiresAt })).toString("base64url")}.signature`,
          accessExpiresAtMs: expiresAt * 1000,
        };
      } else if (url.pathname === `/invites/${inviteId}/bootstrap`) {
        bootstrapRequested.resolve();
        await bootstrapGate.promise;
        body = {
          ...bootstrap,
          metadata: currentMetadata,
          viewer: currentViewer,
          match: currentMatch,
          hasPendingProposal: pendingRematch,
        };
      } else if (url.pathname === `/invites/${inviteId}/metadata`) {
        body = { ok: true, snapshot: currentMetadata, viewer: currentViewer };
      } else if (url.pathname === `/invites/${inviteId}/wagers`) {
        await extrasGate.promise;
        body = { ok: true, snapshot: { inviteId, revision: 1, wagers: {} } };
      } else if (url.pathname === "/matches/snapshot") {
        body = {
          ok: true,
          playerId: hostId,
          matchId: inviteId,
          match: match.hostMatch,
        };
      } else if (
        url.pathname === `/invites/${inviteId}/matches/${inviteId}/snapshot`
      ) {
        body = { ok: true, snapshot: currentMatch };
      } else {
        await extrasGate.promise;
      }
      if (apiDelayMs) await new Promise((done) => setTimeout(done, apiDelayMs));
      if (closed) return;
      await route.fulfill({
        status: body ? 200 : 503,
        headers,
        json: body || {
          ok: false,
          error: "unavailable",
          message: "Local loading fixture",
        },
      });
    });
    await context.addInitScript(() => {
      localStorage.setItem("preferredAssetsSet", "pixel");
      const timing = { shell: null, populated: null };
      window.loadingProbe = timing;
      new MutationObserver(() => {
        if (timing.shell === null && document.getElementById("monsboard"))
          timing.shell = performance.now();
        if (
          timing.populated === null &&
          document.querySelectorAll("#itemsLayer .item").length >= 20
        ) {
          requestAnimationFrame(() => {
            timing.populated ??= performance.now();
          });
        }
      }).observe(document, { childList: true, subtree: true });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    if (benchmark) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    }
    await page.goto(`${server.origin}/${inviteId}`, { waitUntil: "commit" });
    await run({
      page,
      requests,
      resources,
      assetsGate,
      bootstrapGate,
      extrasGate,
      bootstrapRequested,
      selectedAssetsRequested,
    });
    assert.deepEqual(pageErrors, []);
  } finally {
    closed = true;
    assetsGate.resolve();
    bootstrapGate.resolve();
    extrasGate.resolve();
    await browser.close();
    await server.close();
  }
}

async function assertBoardAcceptsInput(page) {
  await page.waitForFunction(() => window.loadingProbe.populated !== null);
  await page.locator('.board-rect[x="500"][y="1000"]').dispatchEvent("click");
  await page.waitForFunction(
    () => document.querySelector("#highlightsLayer")?.childElementCount > 0,
  );
}

test(
  "game bootstrap starts before board assets and is adopted once",
  { skip: benchmark, timeout: 60_000 },
  async () => {
    await fixture(
      async ({
        page,
        requests,
        assetsGate,
        selectedAssetsRequested,
        bootstrapRequested,
      }) => {
        await withinDeadline(
          Promise.all([
            selectedAssetsRequested.promise,
            bootstrapRequested.promise,
          ]),
        );
        assert.equal(await page.locator("#monsboard").count(), 0);
        assetsGate.resolve();
        await assertBoardAcceptsInput(page);
        assert.equal(
          requests.filter(({ path }) => path.endsWith("/bootstrap")).length,
          1,
        );
        assert.equal(
          requests.some(
            ({ path }) =>
              path === "/matches/snapshot" ||
              path.endsWith("/metadata") ||
              path.endsWith("/snapshot"),
          ),
          false,
        );
      },
      { holdAssets: true },
    );
  },
);

test(
  "a populated game accepts input while wagers, profiles and sockets remain unresolved",
  { skip: benchmark, timeout: 60_000 },
  async () => {
    await fixture(
      async ({
        page,
        bootstrapRequested,
        bootstrapGate,
        requests,
        resources,
      }) => {
        await withinDeadline(bootstrapRequested.promise);
        await page.waitForSelector("#monsboard");
        assert.equal(await page.locator("#itemsLayer .item").count(), 0);
        assert.deepEqual(
          resources.filter((path) =>
            /gameAssetsOriginal|gameAssetsPangchiu|monsSprites|IslandButton|particle-effects|\/boards\/backgrounds\/thumbs\//.test(
              path,
            ),
          ),
          [],
        );
        bootstrapGate.resolve();
        await assertBoardAcceptsInput(page);
        assert.equal(
          requests.filter(({ path }) => path.endsWith("/bootstrap")).length,
          1,
        );
      },
      { holdBootstrap: true },
    );
  },
);

test(
  "spectator installs both sides without enabling player input",
  { skip: benchmark, timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page, requests }) => {
        await page.waitForFunction(
          () => window.loadingProbe.populated !== null,
        );
        await page
          .locator('.board-rect[x="500"][y="1000"]')
          .dispatchEvent("click");
        assert.equal(await page.locator("#highlightsLayer > *").count(), 0);
        assert.equal(
          await page.evaluate(
            () =>
              performance.getEntriesByName("main-game:interaction-ready")
                .length,
          ),
          0,
        );
        assert.equal(
          requests.filter(({ path }) => path.endsWith("/bootstrap")).length,
          1,
        );
        assert.equal(
          requests.some(({ path }) => path.endsWith("/snapshot")),
          false,
        );
      },
      { spectator: true },
    );
  },
);

test(
  "an unjoined host settles the waiting view without enabling game input",
  { skip: benchmark, timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page }) => {
        await page.waitForFunction(
          () =>
            performance.getEntriesByName("main-game:initial-view-ready")
              .length > 0,
        );
        assert.equal(
          await page.evaluate(
            () =>
              performance.getEntriesByName("main-game:interaction-ready")
                .length,
          ),
          0,
        );
      },
      { paired: false },
    );
  },
);

test(
  "an existing rematch proposal settles while the opponent response remains pending",
  { skip: benchmark, timeout: 60_000 },
  async () => {
    await fixture(
      async ({ page }) => {
        await page
          .getByRole("button", { name: "End Match", exact: true })
          .waitFor({ state: "visible" });
        await page.waitForFunction(
          () =>
            performance.getEntriesByName("main-game:initial-view-ready")
              .length > 0,
        );
        assert.equal(
          await page.evaluate(
            () =>
              performance.getEntriesByName("main-game:interaction-ready")
                .length,
          ),
          0,
        );
        await page
          .locator('.board-rect[x="500"][y="1000"]')
          .dispatchEvent("click");
        assert.equal(await page.locator("#highlightsLayer > *").count(), 0);
      },
      { pendingRematch: true },
    );
  },
);

test(
  "production loading benchmark",
  { skip: !benchmark, timeout: 60_000 },
  async (t) => {
    const samples = [];
    for (let index = 0; index < 5; index++) {
      await fixture(
        async ({ page, requests }) => {
          await assertBoardAcceptsInput(page);
          samples.push({
            ...(await page.evaluate(() => window.loadingProbe)),
            requestPaths: requests.map(({ path }) => path),
          });
        },
        { apiDelayMs: 200, holdExtras: false },
      );
    }
    const median = (key) =>
      [...samples].map((sample) => sample[key]).sort((a, b) => a - b)[2];
    t.diagnostic(
      JSON.stringify({
        build: process.env.MONS_LOADING_BUILD,
        cpuSlowdown: 4,
        apiDelayMs: 200,
        runs: samples,
        medianShellMs: median("shell"),
        medianPopulatedMs: median("populated"),
      }),
    );
  },
);
