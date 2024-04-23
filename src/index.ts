import init, { MonsGameModel, Location as LocationModel, Modifier as ModifierModel, Color as ColorModel, OutputModelKind } from "mons-web";
import { setupBoard, blinkLocations } from "./board";
import { Location } from "./models";

setupBoard();

await init();
const game = MonsGameModel.new();

var currentInputs: Location[] = [];

export function didClickSquare(location: Location) {
  console.log(location);
  currentInputs.push(location);
  processCurrentInputs();
}

function processCurrentInputs() {
  const gameInput = currentInputs.map(input => new LocationModel(input.i, input.j));
  let output = game.process_input(gameInput);

  switch (output.kind) {
    case OutputModelKind.InvalidInput:
      currentInputs = [];
      processCurrentInputs(); // TODO: tune
      break;
    case OutputModelKind.LocationsToStartFrom:
      const locations: Location[] = output.locations().map(loc => ({i: loc.i, j: loc.j}));
      blinkLocations(locations);
      break;
    case OutputModelKind.NextInputOptions:

      const nextInputs = output.next_inputs;

      console.log("next input options");
      break;
    case OutputModelKind.Events:
      currentInputs = [];
      console.log("events");
      break;
    default:
      console.log("unknown output kind");
  }
}