import React from "react";
import type { WagerPileRect, WagerPileSide } from "../../game/boardWagerModels";
import { isMobile } from "../../utils/misc";
import {
  BOARD_WIDTH_UNITS,
  BOARD_HEIGHT_UNITS,
  getWagerSideForBoardRect,
  toPercentX,
  toPercentY,
} from "../boardOverlayGeometry";

export type BoardWagerLayerProps = {
  pilesLayerRef: React.RefObject<HTMLDivElement | null>;
  activePanelSide: WagerPileSide | "winner" | null;
  activePanelRect: WagerPileRect | null;
  activePanelCount: number | null;
  showOpponentActions: boolean;
  showPlayerActions: boolean;
  canAccept: boolean;
  acceptLabel: string;
  onCancel: (event?: React.SyntheticEvent) => void;
  onDecline: (event?: React.SyntheticEvent) => void;
  onAccept: (event?: React.SyntheticEvent) => void;
  boardPixelSize: { width: number; height: number } | null;
  prefersDarkMode: boolean;
};

const WAGER_PANEL_PADDING_X_FRAC = 0.2;
const WAGER_PANEL_PADDING_Y_FRAC = 0.2;
const WAGER_PANEL_BUTTON_HEIGHT_FRAC = 0.4;
const WAGER_PANEL_BUTTON_GAP_PX = 8;
const WAGER_PANEL_PILE_GAP_FRAC = 0.2;
const WAGER_PANEL_MIN_PADDING_PX = 12;
const WAGER_PANEL_MIN_BUTTON_HEIGHT_PX = 34;
const WAGER_PANEL_MIN_DECLINE_BUTTON_WIDTH_PX = 80;
const WAGER_PANEL_MIN_ACCEPT_BUTTON_WIDTH_PX = 110;
const WAGER_PANEL_MIN_PLAYER_BUTTON_WIDTH_PX = 150;
const WAGER_PANEL_BUTTON_PADDING_X_PX = 16;
const WAGER_PANEL_COUNT_GAP_FRAC = 0.06;
const WAGER_PANEL_COUNT_MIN_GAP_PX = 4;
const WAGER_PANEL_COUNT_MIN_WIDTH_PX = 32;
const WAGER_PANEL_COUNT_Y_OFFSET_FRAC = 0.04;

const getWagerPanelLayout = (
  rect: { x: number; y: number; w: number; h: number },
  isOpponent: boolean,
  boardPixelSize: { width: number; height: number } | null,
  hasActions: boolean,
): {
  x: number;
  y: number;
  width: number;
  height: number;
  gridRows: string;
  paddingXPx: number;
  pileRow: number;
  buttonRow: number;
  buttonGapPx: number;
  declineButtonMinWidthPx: number;
  acceptButtonMinWidthPx: number;
  playerButtonMinWidthPx: number;
  buttonPaddingXPx: number;
  countGap: number;
} => {
  const pxPerUnitX = boardPixelSize
    ? boardPixelSize.width / BOARD_WIDTH_UNITS
    : null;
  const pxPerUnitY = boardPixelSize
    ? boardPixelSize.height / BOARD_HEIGHT_UNITS
    : null;
  const minPaddingX = pxPerUnitX ? WAGER_PANEL_MIN_PADDING_PX / pxPerUnitX : 0;
  const minPaddingY = pxPerUnitY ? WAGER_PANEL_MIN_PADDING_PX / pxPerUnitY : 0;
  const paddingX = Math.max(rect.w * WAGER_PANEL_PADDING_X_FRAC, minPaddingX);
  const paddingY = Math.max(rect.h * WAGER_PANEL_PADDING_Y_FRAC, minPaddingY);
  const minButtonHeight = pxPerUnitY
    ? WAGER_PANEL_MIN_BUTTON_HEIGHT_PX / pxPerUnitY
    : 0;
  const buttonHeight = hasActions
    ? Math.max(rect.h * WAGER_PANEL_BUTTON_HEIGHT_FRAC, minButtonHeight)
    : 0;
  const minCountGap = pxPerUnitX
    ? WAGER_PANEL_COUNT_MIN_GAP_PX / pxPerUnitX
    : 0;
  const countGap = Math.max(rect.w * WAGER_PANEL_COUNT_GAP_FRAC, minCountGap);
  const minCountWidth = pxPerUnitX
    ? WAGER_PANEL_COUNT_MIN_WIDTH_PX / pxPerUnitX
    : 0;
  const pileGap = hasActions ? rect.h * WAGER_PANEL_PILE_GAP_FRAC : 0;
  const borderAndBufferPx = 4;
  const opponentButtonsMinWidthPx =
    WAGER_PANEL_MIN_DECLINE_BUTTON_WIDTH_PX +
    WAGER_PANEL_MIN_ACCEPT_BUTTON_WIDTH_PX +
    WAGER_PANEL_BUTTON_GAP_PX +
    borderAndBufferPx;
  const playerButtonMinWidthPx =
    WAGER_PANEL_MIN_PLAYER_BUTTON_WIDTH_PX + borderAndBufferPx;
  const buttonRowMinWidthPx = isOpponent
    ? opponentButtonsMinWidthPx
    : playerButtonMinWidthPx;
  const buttonRowMinWidthUnits = pxPerUnitX
    ? buttonRowMinWidthPx / pxPerUnitX
    : 0;
  const minPanelContentWidth = rect.w + countGap + minCountWidth;
  const buttonRowWidth = hasActions
    ? Math.max(rect.w, buttonRowMinWidthUnits, minPanelContentWidth)
    : minPanelContentWidth;
  const panelWidth = buttonRowWidth + paddingX * 2;
  const panelHeight = rect.h + paddingY * 2 + pileGap + buttonHeight;
  const centerX = rect.x + rect.w / 2;
  const panelX = centerX - panelWidth / 2;
  const panelY = isOpponent
    ? rect.y - paddingY
    : rect.y - (panelHeight - rect.h - paddingY);
  const rowValues = hasActions
    ? isOpponent
      ? [paddingY, rect.h, pileGap, buttonHeight, paddingY]
      : [paddingY, buttonHeight, pileGap, rect.h, paddingY]
    : [paddingY, rect.h, paddingY];
  const gridRows = rowValues
    .map((value) => `${(value / panelHeight) * 100}%`)
    .join(" ");
  const paddingXPx = pxPerUnitX
    ? paddingX * pxPerUnitX
    : WAGER_PANEL_MIN_PADDING_PX;
  const pileRow = hasActions ? (isOpponent ? 2 : 4) : 2;
  const buttonRow = hasActions ? (isOpponent ? 4 : 2) : 0;

  return {
    x: panelX,
    y: panelY,
    width: panelWidth,
    height: panelHeight,
    gridRows,
    paddingXPx,
    pileRow,
    buttonRow,
    buttonGapPx: WAGER_PANEL_BUTTON_GAP_PX,
    declineButtonMinWidthPx: WAGER_PANEL_MIN_DECLINE_BUTTON_WIDTH_PX,
    acceptButtonMinWidthPx: WAGER_PANEL_MIN_ACCEPT_BUTTON_WIDTH_PX,
    playerButtonMinWidthPx: WAGER_PANEL_MIN_PLAYER_BUTTON_WIDTH_PX,
    buttonPaddingXPx: WAGER_PANEL_BUTTON_PADDING_X_PX,
    countGap,
  };
};

export const BoardWagerLayer: React.FC<BoardWagerLayerProps> = ({
  pilesLayerRef,
  activePanelSide,
  activePanelRect,
  activePanelCount,
  showOpponentActions,
  showPlayerActions,
  canAccept,
  acceptLabel,
  onCancel,
  onDecline,
  onAccept,
  boardPixelSize,
  prefersDarkMode,
}) => {
  const wagerPanelHasActions = showOpponentActions || showPlayerActions;
  const activeWagerPileRect = activePanelSide ? activePanelRect : null;
  const isOpponentPanel =
    activePanelSide === "opponent"
      ? true
      : activePanelSide === "player"
        ? false
        : activeWagerPileRect
          ? getWagerSideForBoardRect(activeWagerPileRect) === "opponent"
          : false;
  const wagerPanelLayout =
    activePanelSide && activeWagerPileRect
      ? getWagerPanelLayout(
          activeWagerPileRect,
          isOpponentPanel,
          boardPixelSize,
          wagerPanelHasActions,
        )
      : null;
  const wagerCountLayout =
    wagerPanelLayout && activeWagerPileRect && activePanelCount !== null
      ? (() => {
          const pxPerUnitX = boardPixelSize
            ? boardPixelSize.width / BOARD_WIDTH_UNITS
            : null;
          const minGap = pxPerUnitX
            ? WAGER_PANEL_COUNT_MIN_GAP_PX / pxPerUnitX
            : 0;
          const gap = Math.max(wagerPanelLayout.countGap, minGap);
          const centerY =
            activeWagerPileRect.y +
            activeWagerPileRect.h / 2 -
            activeWagerPileRect.h * WAGER_PANEL_COUNT_Y_OFFSET_FRAC;
          const left = activeWagerPileRect.x + activeWagerPileRect.w + gap;
          const leftPct =
            ((left - wagerPanelLayout.x) / wagerPanelLayout.width) * 100;
          const topPct =
            ((centerY - wagerPanelLayout.y) / wagerPanelLayout.height) * 100;
          return { leftPct, topPct };
        })()
      : null;
  const wagerPanelTheme = prefersDarkMode
    ? {
        background: "rgba(28, 28, 28, 0.72)",
        border: "rgba(255, 255, 255, 0.12)",
        shadow: "0 10px 22px rgba(0, 0, 0, 0.35)",
        buttonBackground: "rgba(255, 255, 255, 0.1)",
        buttonBorder: "rgba(255, 255, 255, 0.18)",
        buttonText: "var(--color-gray-f0)",
      }
    : {
        background: "rgba(250, 250, 250, 0.78)",
        border: "rgba(0, 0, 0, 0.08)",
        shadow: "0 10px 22px rgba(0, 0, 0, 0.18)",
        buttonBackground: "rgba(0, 0, 0, 0.06)",
        buttonBorder: "rgba(0, 0, 0, 0.08)",
        buttonText: "var(--color-gray-33)",
      };
  const wagerPanelButtonStyle: React.CSSProperties = {
    height: "100%",
    alignSelf: "center",
    justifySelf: "center",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: wagerPanelTheme.buttonBackground,
    border: `1px solid ${wagerPanelTheme.buttonBorder}`,
    color: wagerPanelTheme.buttonText,
    borderRadius: "999px",
    fontWeight: 600,
    fontSize: "0.9em",
    letterSpacing: "0.01em",
    cursor: "pointer",
    whiteSpace: "nowrap",
    minWidth: 0,
    padding: 0,
    margin: 0,
    outline: "none",
    boxSizing: "border-box" as const,
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 0,
      }}
    >
      {wagerPanelLayout && (
        <div
          data-wager-panel="true"
          style={{
            position: "absolute",
            left: `${toPercentX(wagerPanelLayout.x)}%`,
            top: `${toPercentY(wagerPanelLayout.y)}%`,
            width: `${toPercentX(wagerPanelLayout.width)}%`,
            height: `${toPercentY(wagerPanelLayout.height)}%`,
            display: "grid",
            gridTemplateRows: wagerPanelLayout.gridRows,
            paddingLeft: `${wagerPanelLayout.paddingXPx}px`,
            paddingRight: `${wagerPanelLayout.paddingXPx}px`,
            boxSizing: "border-box",
            background: wagerPanelTheme.background,
            border: `1px solid ${wagerPanelTheme.border}`,
            boxShadow: wagerPanelTheme.shadow,
            borderRadius: "16px",
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
            overflow: "visible",
            pointerEvents: "auto",
            userSelect: "none",
            zIndex: 2,
          }}
        >
          {wagerCountLayout && (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                left: `${wagerCountLayout.leftPct}%`,
                top: `${wagerCountLayout.topPct}%`,
                transform: "translate(0, -50%)",
                fontSize: "0.72em",
                fontWeight: 500,
                letterSpacing: "0.02em",
                color: prefersDarkMode
                  ? "rgba(240, 240, 240, 0.6)"
                  : "rgba(40, 40, 40, 0.52)",
                pointerEvents: "none",
                userSelect: "none",
                whiteSpace: "nowrap",
              }}
            >
              ({activePanelCount})
            </div>
          )}
          <div
            aria-hidden="true"
            style={{ gridRow: wagerPanelLayout.pileRow }}
          />
          {wagerPanelHasActions && (
            <div
              data-wager-panel="true"
              style={{
                gridRow: wagerPanelLayout.buttonRow,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: `${wagerPanelLayout.buttonGapPx}px`,
                height: "100%",
                width: "100%",
                overflow: "visible",
              }}
            >
              {showOpponentActions && (
                <>
                  <button
                    data-wager-panel="true"
                    type="button"
                    onClick={!isMobile ? onDecline : undefined}
                    onTouchStart={isMobile ? onDecline : undefined}
                    style={{
                      ...wagerPanelButtonStyle,
                      flex: "1 0 auto",
                      minWidth: `${wagerPanelLayout.declineButtonMinWidthPx}px`,
                      paddingLeft: `${wagerPanelLayout.buttonPaddingXPx}px`,
                      paddingRight: `${wagerPanelLayout.buttonPaddingXPx}px`,
                    }}
                  >
                    Decline
                  </button>
                  <button
                    data-wager-panel="true"
                    type="button"
                    disabled={!canAccept}
                    onClick={!isMobile ? onAccept : undefined}
                    onTouchStart={isMobile ? onAccept : undefined}
                    style={{
                      ...wagerPanelButtonStyle,
                      flex: "1 0 auto",
                      minWidth: `${wagerPanelLayout.acceptButtonMinWidthPx}px`,
                      paddingLeft: `${wagerPanelLayout.buttonPaddingXPx}px`,
                      paddingRight: `${wagerPanelLayout.buttonPaddingXPx}px`,
                      opacity: canAccept ? 1 : 0.5,
                      cursor: "pointer",
                    }}
                  >
                    {acceptLabel}
                  </button>
                </>
              )}
              {showPlayerActions && (
                <button
                  data-wager-panel="true"
                  type="button"
                  onClick={!isMobile ? onCancel : undefined}
                  onTouchStart={isMobile ? onCancel : undefined}
                  style={{
                    ...wagerPanelButtonStyle,
                    flexShrink: 0,
                    minWidth: `${wagerPanelLayout.playerButtonMinWidthPx}px`,
                    paddingLeft: `${wagerPanelLayout.buttonPaddingXPx}px`,
                    paddingRight: `${wagerPanelLayout.buttonPaddingXPx}px`,
                  }}
                >
                  Cancel Proposal
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <div
        ref={pilesLayerRef}
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 3,
        }}
      />
    </div>
  );
};
