import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as timing from "../src/ui/controls/controlTiming.ts";

const { outputText } = ts.transpileModule(
  readFileSync(
    new URL("../src/ui/controls/outsideTapState.ts", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  },
);

for (const mobile of [false, true]) {
  test(`first board input is available before a real popup dismissal (${mobile ? "mobile" : "desktop"})`, () => {
    let now = 0;
    const exports = {};
    new Function("exports", "require", "Date", outputText)(
      exports,
      (specifier) =>
        specifier === "../../utils/misc" ? { isMobile: mobile } : timing,
      { now: () => now },
    );
    assert.equal(exports.didNotDismissAnythingWithOutsideTapJustNow(), true);
    exports.resetOutsideTapDismissTimeout();
    assert.equal(exports.didNotDismissAnythingWithOutsideTapJustNow(), true);
    exports.didDismissSomethingWithOutsideTapJustNow();
    assert.equal(exports.didNotDismissAnythingWithOutsideTapJustNow(), false);
    now = timing.getOutsideTapDismissThresholdMs(mobile) - 1;
    assert.equal(exports.didNotDismissAnythingWithOutsideTapJustNow(), false);
    now++;
    assert.equal(exports.didNotDismissAnythingWithOutsideTapJustNow(), true);
    exports.didDismissSomethingWithOutsideTapJustNow();
    exports.resetOutsideTapDismissTimeout();
    assert.equal(exports.didNotDismissAnythingWithOutsideTapJustNow(), !mobile);
  });
}
