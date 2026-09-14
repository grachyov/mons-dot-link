import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import BoardComponent, * as boardUi from "../../src/ui/BoardComponent";
import { createEmptyPlayerInfoOverlayState } from "../../src/game/boardUiPort";
import {
  createWagerPile,
  syncWagerPileIcons,
  updateWagerPileLayout,
  buildWagerRenderState,
  MAX_WAGER_WIN_PILE_ITEMS,
} from "../../src/game/boardWagerModels";
import {
  environment as e,
  materialImage,
  setWatchOnly,
  playerSideMetadata,
  opponentSideMetadata,
} from "./boardWagersEnvironment";
import "../../src/index.css";
let root: ReturnType<typeof createRoot>;
let revision = 0;
const empty = () => ({
  player: null,
  opponent: null,
  winner: null,
  playerDisappearing: null,
  opponentDisappearing: null,
  winAnimationActive: false,
});
let renderState: any = empty();
const pileKeys = [
  "player",
  "opponent",
  "winner",
  "playerDisappearing",
  "opponentDisappearing",
] as const;
const run = (callback: () => void) => flushSync(callback);
function names(long = false, flipped = false) {
  const value = createEmptyPlayerInfoOverlayState();
  for (const side of ["player", "opponent"] as const) {
    value[side] = {
      ...value[side],
      visible: true,
      nameVisible: true,
      nameText: long
        ? side + "_a_very_long_player_name"
        : side === "player"
          ? "Moss"
          : "Luna",
      scoreText: side === "player" ? "12" : "8",
      timerText: "00:42",
      timerVisible: true,
      nameReactionText: "Wow!",
      profileMetadataIsOpponent: flipped
        ? side === "player"
        : side === "opponent",
    };
  }
  value.wagerLayoutRevision = ++revision;
  e.requestedLayoutRevision = revision;
  run(() => boardUi.setBoardPlayerInfoOverlayState(value));
}
function pile(
  side: "player" | "opponent" | "winner",
  count = 8,
  material = "obsidian",
  animation = "none",
  pending = true,
) {
  const model = createWagerPile();
  syncWagerPileIcons(
    model,
    material as any,
    count,
    undefined,
    side === "winner" ? MAX_WAGER_WIN_PILE_ITEMS : undefined,
  );
  const layout = e.layouts?.[side === "winner" ? "player" : side];
  if (!layout) throw new Error("Missing wager slot layout for " + side);
  updateWagerPileLayout(
    model,
    side === "winner" ? layout.winner : layout.pile,
    0.777,
  );
  model.materialUrl = materialImage(material === "gold");
  return buildWagerRenderState(model, side, animation as any, pending);
}
e.replay = () => {
  const hasPiles = pileKeys.some((key) => renderState[key] !== null);
  if (hasPiles && !e.layouts) return;
  const next = { ...renderState };
  for (const key of pileKeys) {
    const previous = next[key];
    if (previous)
      next[key] = pile(
        previous.side,
        previous.actualCount,
        previous.materialUrl === materialImage(true) ? "gold" : "obsidian",
        "none",
        previous.isPending,
      );
  }
  renderState = next;
  if (e.render) e.renderReplays++;
  e.render?.(renderState);
};
const harness = {
  e,
  run,
  names,
  pile,
  bridge(playerUid: string, opponentUid: string) {
    playerSideMetadata.uid = playerUid;
    opponentSideMetadata.uid = opponentUid;
    run(() => boardUi.updateWagerPlayerUids(playerUid, opponentUid));
  },
  mount() {
    root = createRoot(document.getElementById("root")!);
    run(() =>
      root.render(
        <React.StrictMode>
          <BoardComponent />
        </React.StrictMode>,
      ),
    );
    names();
  },
  state(state: any) {
    e.state = state;
    run(() => e.subscribers.forEach((callback) => callback(state)));
  },
  proposals(playerCount = 4, opponentCount = 8) {
    this.state({
      proposals: {
        p: { material: "obsidian", count: playerCount },
        o: { material: "obsidian", count: opponentCount },
      },
    });
  },
  balance(count: number, status = "ready") {
    e.balance = {
      availableMaterials: { obsidian: count, gold: count },
      frozenMaterialsStatus: status,
    };
    run(() => e.materialSubscribers.forEach((callback) => callback()));
  },
  materialBalances(obsidian: number, gold: number) {
    e.balance = {
      availableMaterials: { obsidian, gold },
      frozenMaterialsStatus: "ready",
    };
    run(() => e.materialSubscribers.forEach((callback) => callback()));
  },
  watch(value: boolean) {
    run(() => setWatchOnly(value));
  },
  style(value: string) {
    e.style = value;
    run(() => e.styleSubscribers.forEach((callback) => callback()));
  },
  emit(options: any = {}) {
    renderState = {
      ...empty(),
      player: pile(
        "player",
        options.playerCount ?? 4,
        options.material ?? "obsidian",
        options.animation ?? "none",
      ),
      opponent: pile(
        "opponent",
        options.opponentCount ?? 8,
        options.material ?? "obsidian",
        options.animation ?? "none",
      ),
      ...options.overrides,
    };
    if (options.image) {
      renderState.player.materialUrl = options.image;
      renderState.opponent.materialUrl = options.image;
    }
    run(() => e.render?.(renderState));
  },
  disappear() {
    renderState = {
      ...empty(),
      playerDisappearing: renderState.player,
      opponentDisappearing: renderState.opponent,
    };
    run(() => e.render?.(renderState));
  },
  winner(active = false) {
    renderState = {
      ...empty(),
      winner: pile("winner", 26, "gold", "none", false),
      winAnimationActive: active,
    };
    run(() => e.render?.(renderState));
  },
  clearPiles() {
    renderState = empty();
    run(() => e.render?.(renderState));
  },
  reset() {
    run(() => e.transient?.(false));
  },
  videos() {
    run(() => {
      e.video?.(false, 1);
      e.video?.(true, 2);
    });
  },
  dispose() {
    run(() => root.unmount());
  },
  bindings() {
    return {
      wager: e.subscribers.size,
      watch: e.watchSubscribers.size,
      material: e.materialSubscribers.size,
      styles: e.styleSubscribers.size,
      squares: e.squareSubscribers.size,
      render: !!e.render,
      layouts: !!e.layouts,
      outside: !!e.outside,
      visible: e.visible(),
      transient: !!e.transient,
      video: !!e.video,
    };
  },
};
(window as any).harness = harness;
harness.mount();
