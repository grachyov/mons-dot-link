export const BOARD_WIDTH_UNITS = 11;
export const BOARD_HEIGHT_UNITS = 14.1;

export const toPercentX = (value: number) => (value / BOARD_WIDTH_UNITS) * 100;
export const toPercentY = (value: number) => (value / BOARD_HEIGHT_UNITS) * 100;

export const getWagerSideForBoardRect = (rect: {
  y: number;
}): "player" | "opponent" =>
  rect.y < BOARD_HEIGHT_UNITS * 0.5 ? "opponent" : "player";
