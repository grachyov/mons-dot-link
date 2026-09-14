import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const imageResources =
  await import("../src/resources/materialImageResources.ts");

const callbackNames = [
  "pullMaterialToBar",
  "flushMaterialPullQueue",
  "queueMaterialPull",
  "startWalkingAnimation",
];
const source = ts.createSourceFile(
  "IslandView.tsx",
  readFileSync(
    new URL("../src/ui/island/IslandView.tsx", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const callbacks = new Map();
const collectCallbacks = (node) => {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    callbackNames.includes(node.name.text)
  ) {
    callbacks.set(node.name.text, `const ${node.getText(source)};`);
  }
  ts.forEachChild(node, collectCallbacks);
};
collectCallbacks(source);
assert.equal(callbacks.size, callbackNames.length);

const createCallbacks = (dependencies) => {
  const { outputText } = ts.transpileModule(
    callbackNames.map((name) => callbacks.get(name)).join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );
  return new Function(
    ...Object.keys(dependencies),
    `${outputText}; return { startWalkingAnimation };`,
  )(...Object.values(dependencies));
};

const createNode = () => ({
  style: {},
  isConnected: true,
  setAttribute() {},
  appendChild() {},
  remove() {
    this.isConnected = false;
  },
  getBoundingClientRect: () => ({
    left: 0,
    top: 0,
    right: 10,
    bottom: 10,
    width: 10,
    height: 10,
  }),
});

test("retained walking animation collects a material recovered after an image-load failure", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    if (requests === 1) throw new TypeError("network unavailable");
    return new Response("dust-image");
  });
  t.mock.method(URL, "createObjectURL", () => "blob:recovered-dust");
  assert.equal(await imageResources.getMaterialImageUrl("dust"), null);

  const frames = [];
  let walkingStep;
  let displayedAmount = 0;
  const pullImages = [];
  const host = createNode();
  host.querySelector = () => null;
  const materialDropsRef = { current: [] };
  const dependencies = {
    useCallback: (callback) => callback,
    materialUrls: imageResources.getCachedMaterialImageUrls(),
    getCachedMaterialImageUrl: (name) =>
      imageResources.getCachedMaterialImageUrl(name),
    materialItemRefs: { current: { dust: host } },
    fxContainerRef: { current: null },
    amountsDecoupledRef: { current: true },
    setMaterialAmounts: (update) => {
      displayedAmount = update({ dust: displayedAmount }).dust;
    },
    materialPullFlushRef: { current: null },
    materialPullQueueRef: { current: [] },
    requestAnimationFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    document: {
      body: { appendChild() {} },
      createElement: (tag) => {
        const element = createNode();
        if (tag === "img") pullImages.push(element);
        return element;
      },
    },
    performance: { now: () => 0 },
    materialDropsRef,
    islandHeroImgRef: {
      current: {
        getBoundingClientRect: () => ({
          left: 0,
          top: 0,
          width: 100,
          height: 100,
        }),
      },
    },
    getDudeBounds: () => ({ left: 0, top: 0, right: 1, bottom: 1 }),
    computeOverlapArea: (a, b) =>
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)),
    playSounds() {},
    Sound: { CollectingMaterials: "collect" },
    playSheetAnimation: (_kind, options) => {
      walkingStep = options.onStep;
    },
  };
  createCallbacks(dependencies).startWalkingAnimation();

  assert.equal(
    await imageResources.getMaterialImageUrl("dust"),
    "blob:recovered-dust",
  );
  createCallbacks({
    ...dependencies,
    materialUrls: imageResources.getCachedMaterialImageUrls(),
  });
  const drop = { name: "dust", el: createNode(), shadow: createNode() };
  materialDropsRef.current.push(drop);

  walkingStep();
  assert.equal(materialDropsRef.current.length, 0);
  assert.equal(drop.el.isConnected, false);
  assert.equal(drop.shadow.isConnected, false);
  assert.equal(displayedAmount, 0);
  frames.shift()(0);

  assert.equal(displayedAmount, 1);
  assert.equal(pullImages.length, 1);
  assert.equal(pullImages[0].src, "blob:recovered-dust");
  assert.equal(requests, 2);
});
