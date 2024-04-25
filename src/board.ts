import { didClickSquare } from "./index";
import { Highlight, HighlightKind, Location, Trace } from "./models";
import { colors } from "./colors";
import { Color as ColorModel, MonKind, ItemModelKind, ItemModel, SquareModel, ManaKind, SquareModelKind } from "mons-web";

const assets = (await import("./assets")).assets;
const board = document.getElementById("monsboard");
const highlightsLayer = document.getElementById("highlightsLayer");
const itemsLayer = document.getElementById("itemsLayer");
const items: { [key: string]: SVGElement } = {};
const basesPlaceholders: { [key: string]: SVGElement } = {};

const drainer = loadImage(assets.drainer);
const angel = loadImage(assets.angel);
const demon = loadImage(assets.demon);
const spirit = loadImage(assets.spirit);
const mystic = loadImage(assets.mystic);
const mana = loadImage(assets.mana);
const drainerB = loadImage(assets.drainerB);
const angelB = loadImage(assets.angelB);
const demonB = loadImage(assets.demonB);
const spiritB = loadImage(assets.spiritB);
const mysticB = loadImage(assets.mysticB);
const manaB = loadImage(assets.manaB);
const bombOrPotion = loadImage(assets.bombOrPotion);
const bomb = loadImage(assets.bomb);
const potion = loadImage(assets.potion);
const supermana = loadImage(assets.supermana);
const supermanaSimple = loadImage(assets.supermanaSimple);

export function removeItem(location: Location) {
  const locationKey = location.toString();
  const toRemove = items[locationKey];
  if (toRemove !== undefined) {
    toRemove.remove();
    delete items[locationKey];
  }
}

export function putItem(item: ItemModel, location: Location) {
  switch (item.kind) {
    case ItemModelKind.Mon:
      const isBlack = item.mon.color == ColorModel.Black;
      const isFainted = item.mon.is_fainted();
      switch (item.mon.kind) {
        case MonKind.Demon:
          placeItem(isBlack ? demonB : demon, location, isFainted);
          break;
        case MonKind.Drainer:
          placeItem(isBlack ? drainerB : drainer, location, isFainted);
          break;
        case MonKind.Angel:
          placeItem(isBlack ? angelB : angel, location, isFainted);
          break;
        case MonKind.Spirit:
          placeItem(isBlack ? spiritB : spirit, location, isFainted);
          break;
        case MonKind.Mystic:
          placeItem(isBlack ? mysticB : mystic, location, isFainted);
          break;
      }
      break;
    case ItemModelKind.Mana:
      switch (item.mana.kind) {
        case ManaKind.Regular:
          const isBlack = item.mana.color == ColorModel.Black;
          placeItem(isBlack ? manaB : mana, location);
          break;
        case ManaKind.Supermana:
          placeItem(supermana, location);
          break;
      }
      break;
    case ItemModelKind.MonWithMana:
      const isBlackDrainer = item.mon.color == ColorModel.Black;
      const isSupermana = item.mana.kind == ManaKind.Supermana;
      if (isSupermana) {
        placeMonWithSupermana(isBlackDrainer ? drainerB : drainer, location);
      } else {
        const isBlackMana = item.mana.color == ColorModel.Black;
        placeMonWithMana(isBlackDrainer ? drainerB : drainer,isBlackMana ? manaB : mana, location);
      }
      break;
    case ItemModelKind.MonWithConsumable:
      const isBlackWithConsumable = item.mon.color == ColorModel.Black;
      switch (item.mon.kind) {
        case MonKind.Demon:
          placeMonWithBomb(isBlackWithConsumable ? demonB : demon, location);
          break;
        case MonKind.Drainer:
          placeMonWithBomb(isBlackWithConsumable ? drainerB : drainer, location);
          break;
        case MonKind.Angel:
          placeMonWithBomb(isBlackWithConsumable ? angelB : angel, location);
          break;
        case MonKind.Spirit:
          placeMonWithBomb(isBlackWithConsumable ? spiritB : spirit, location);
          break;
        case MonKind.Mystic:
          placeMonWithBomb(isBlackWithConsumable ? mysticB : mystic, location);
          break;
      }
      break;
    case ItemModelKind.Consumable:
      placeItem(bombOrPotion, location);
      break;
  }
}

export function setupSquare(square: SquareModel, location: Location) {
  if (square.kind == SquareModelKind.MonBase) {
    const isBlack = square.color == ColorModel.Black;
    switch (square.mon_kind) {
      case MonKind.Demon:
        setBase(isBlack ? demonB : demon, location);
        break;
      case MonKind.Drainer:
        setBase(isBlack ? drainerB : drainer, location);
        break;
      case MonKind.Angel:
        setBase(isBlack ? angelB : angel, location);
        break;
      case MonKind.Spirit:
        setBase(isBlack ? spiritB : spirit, location);
        break;
      case MonKind.Mystic:
        setBase(isBlack ? mysticB : mystic, location);
        break;
    }
  }
}

export function setupBoard() {
  for (let y = 0; y < 11; y++) {
    for (let x = 0; x < 11; x++) {
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", x.toString());
      rect.setAttribute("y", y.toString());
      rect.setAttribute("width", "1");
      rect.setAttribute("height", "1");
      rect.setAttribute("fill", "rgba(255, 255, 255, 0)");
      rect.addEventListener("click", function () {
        didClickSquare(new Location(y, x));
      });
      itemsLayer.appendChild(rect);
    }
  }
}

export function removeHighlights() {
  while (highlightsLayer.firstChild) {
    highlightsLayer.removeChild(highlightsLayer.firstChild);
  }
}

export function applyHighlights(highlights: Highlight[]) {
  highlights.forEach((highlight) => {
    switch (highlight.kind) {
      case HighlightKind.Selected:
        highlightSelectedItem(highlight.location, highlight.color);
        break;
      case HighlightKind.EmptySquare:
        highlightEmptyDestination(highlight.location, highlight.color);
        break;
      case HighlightKind.TargetSuggestion:
        highlightDestinationItem(highlight.location, highlight.isBlink, highlight.color);
        break;
    }
  });
}

function loadImage(data: string) {
  const image = document.createElementNS("http://www.w3.org/2000/svg", "image");
  image.setAttributeNS("http://www.w3.org/1999/xlink", "href", `data:image/png;base64,${data}`);
  image.setAttribute("width", "1");
  image.setAttribute("height", "1");
  image.setAttribute("class", "item");
  return image;
}

function placeMonWithBomb(item: SVGElement, location: Location) {
  const img = item.cloneNode() as SVGElement;
  img.setAttribute("x", location.j.toString());
  img.setAttribute("y", location.i.toString());

  const carriedBomb = bomb.cloneNode() as SVGElement;
  carriedBomb.setAttribute("x", (location.j + 0.52).toString());
  carriedBomb.setAttribute("y", (location.i + 0.495).toString());
  carriedBomb.setAttribute("width", (0.54).toString());
  carriedBomb.setAttribute("height", (0.54).toString());

  const container = document.createElementNS("http://www.w3.org/2000/svg", "g");
  container.appendChild(img);
  container.appendChild(carriedBomb);

  itemsLayer.appendChild(container);
  items[location.toString()] = container;
}

function placeMonWithSupermana(item: SVGElement, location: Location) {
  const img = item.cloneNode() as SVGElement;
  img.setAttribute("x", location.j.toString());
  img.setAttribute("y", location.i.toString());

  const carriedMana = supermanaSimple.cloneNode() as SVGElement;
  carriedMana.setAttribute("x", (location.j + 0.13).toString());
  carriedMana.setAttribute("y", (location.i - 0.13).toString());
  carriedMana.setAttribute("width", (0.74).toString());
  carriedMana.setAttribute("height", (0.74).toString());

  const container = document.createElementNS("http://www.w3.org/2000/svg", "g");
  container.appendChild(img);
  container.appendChild(carriedMana);

  itemsLayer.appendChild(container);
  items[location.toString()] = container;
}

function placeMonWithMana(item: SVGElement, mana: SVGElement, location: Location) {
  const img = item.cloneNode() as SVGElement;
  img.setAttribute("x", location.j.toString());
  img.setAttribute("y", location.i.toString());

  const carriedMana = mana.cloneNode() as SVGElement;
  carriedMana.setAttribute("x", (location.j + 0.34).toString());
  carriedMana.setAttribute("y", (location.i + 0.27).toString());
  carriedMana.setAttribute("width", (0.93).toString());
  carriedMana.setAttribute("height", (0.93).toString());

  const container = document.createElementNS("http://www.w3.org/2000/svg", "g");
  container.appendChild(img);
  container.appendChild(carriedMana);

  itemsLayer.appendChild(container);
  items[location.toString()] = container;
}

function placeItem(item: SVGElement, location: Location, fainted = false) {
  const key = location.toString();
  if (hasBasePlaceholder(key)) {
    basesPlaceholders[key].style.display = 'none';
  }
  const img = item.cloneNode() as SVGElement;
  if (fainted) {
    img.setAttribute("x", "0");
    img.setAttribute("y", "0");
    const container = document.createElementNS("http://www.w3.org/2000/svg", "g");
    container.setAttribute("transform", `translate(${location.j + 1}, ${location.i}) rotate(90)`);
    container.appendChild(img); 
    itemsLayer.appendChild(container);
    items[key] = container;
  } else {
    img.setAttribute("x", location.j.toString());
    img.setAttribute("y", location.i.toString());
    itemsLayer.appendChild(img);
    items[key] = img;
  }
}

function setBase(item: SVGElement, location: Location) {
  const key = location.toString();
  if (hasBasePlaceholder(key)) {
    basesPlaceholders[key].style.display = '';
  } else {
    const img = item.cloneNode() as SVGElement;
    img.setAttribute("width", "0.6");
    img.setAttribute("height", "0.6");
    const adjustedX = location.j + 0.2;
    const adjustedY = location.i + 0.2;
    img.setAttribute("x", adjustedX.toString());
    img.setAttribute("y", adjustedY.toString());
    img.style.opacity = "0.4";
    board.appendChild(img);
    basesPlaceholders[key] = img;
  }
}

function highlightEmptyDestination(location: Location, color: string) {
  const highlight = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  highlight.style.pointerEvents = "none";
  const circleRadius = 0.15;
  const circleCenter = { x: location.j + 0.5, y: location.i + 0.5 };
  highlight.setAttribute("cx", circleCenter.x.toString());
  highlight.setAttribute("cy", circleCenter.y.toString());
  highlight.setAttribute("r", circleRadius.toString());
  highlight.setAttribute("fill", color);
  highlightsLayer.append(highlight);
}

function highlightSelectedItem(location: Location, color: string) {
  const highlight = document.createElementNS("http://www.w3.org/2000/svg", "g");
  highlight.style.pointerEvents = "none";

  const circleRadius = 0.56;
  const circleCenter = { x: location.j + 0.5, y: location.i + 0.5 };

  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", circleCenter.x.toString());
  circle.setAttribute("cy", circleCenter.y.toString());
  circle.setAttribute("r", circleRadius.toString());
  circle.setAttribute("fill", color);

  const mask = document.createElementNS("http://www.w3.org/2000/svg", "mask");
  mask.setAttribute("id", `highlight-mask-${location.toString()}`);
  const maskRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  maskRect.setAttribute("x", location.j.toString());
  maskRect.setAttribute("y", location.i.toString());
  maskRect.setAttribute("width","1");
  maskRect.setAttribute("height", "1");
  maskRect.setAttribute("fill", "white");
  mask.appendChild(maskRect);
  highlight.appendChild(mask);

  circle.setAttribute("mask", `url(#highlight-mask-${location.toString()})`);
  highlight.appendChild(circle);
  highlightsLayer.append(highlight);
}

function highlightDestinationItem(location: Location, blink = false, color: string) {
  const highlight = document.createElementNS("http://www.w3.org/2000/svg", "g");
  highlight.style.pointerEvents = "none";

  const circleRadius = 0.56;
  const circleCenter = { x: location.j + 0.5, y: location.i + 0.5 };

  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", location.j.toString());
  rect.setAttribute("y", location.i.toString());
  rect.setAttribute("width", "1");
  rect.setAttribute("height", "1");
  rect.setAttribute("fill", color);

  const mask = document.createElementNS("http://www.w3.org/2000/svg", "mask");
  mask.setAttribute("id", `highlight-mask-${location.toString()}`);

  const maskRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  maskRect.setAttribute("x", location.j.toString());
  maskRect.setAttribute("y", location.i.toString());
  maskRect.setAttribute("width", "1");
  maskRect.setAttribute("height", "1");
  maskRect.setAttribute("fill", "white");
  mask.appendChild(maskRect);

  const maskCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  maskCircle.setAttribute("cx", circleCenter.x.toString());
  maskCircle.setAttribute("cy", circleCenter.y.toString());
  maskCircle.setAttribute("r", circleRadius.toString());
  maskCircle.setAttribute("fill", "black");
  mask.appendChild(maskCircle);

  highlight.appendChild(mask);
  highlight.appendChild(rect);

  rect.setAttribute("mask", `url(#highlight-mask-${location.toString()})`);

  highlightsLayer.append(highlight);

  if (blink) {
    setTimeout(() => {
      highlight.remove();
    }, 100);
  }
}

export function drawTrace(trace: Trace) {
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  const fromCenter = { x: trace.from.j + 0.5, y: trace.from.i + 0.5 };
  const toCenter = { x: trace.to.j + 0.5, y: trace.to.i + 0.5 };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  const transform = `translate(${fromCenter.x},${fromCenter.y}) rotate(${angle})`;
  
  rect.setAttribute("x", "0");
  rect.setAttribute("y", "-0.025");
  rect.setAttribute("width", length.toString());
  rect.setAttribute("height", "0.05");
  rect.setAttribute("transform", transform);
  
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke", getTraceColor());
  rect.setAttribute("stroke-width", "0.2");
  rect.setAttribute("opacity", "0.69");
  board.append(rect);

  setTimeout(() => {
    rect.remove();
  }, 230);
}

export function hasBasePlaceholder(locationString: string): boolean {
  return basesPlaceholders.hasOwnProperty(locationString);
}

let traceIndex = 0;

function getTraceColor(): string {
  traceIndex += 1;
  if (traceIndex > 7) {
    traceIndex = 1;
  }

  switch (traceIndex) {
    case 1:
      return colors.trace1;
    case 2:
      return colors.trace2;
    case 3:
      return colors.trace3;
    case 4:
      return colors.trace4;
    case 5:
      return colors.trace5;
    case 6:
      return colors.trace6;
    case 7:
      return colors.trace7;
  }

}