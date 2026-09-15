import { isMobile } from "../../utils/misc";
import {
  didOutsideTapDismissWindowPass,
  rewindOutsideTapDismissedAtForReset,
} from "./controlTiming";
let latestModalOutsideTapDismissDate: number | null = null;

export const didDismissSomethingWithOutsideTapJustNow = (): void => {
  latestModalOutsideTapDismissDate = Date.now();
};

export const resetOutsideTapDismissTimeout = (): void => {
  if (latestModalOutsideTapDismissDate === null) return;
  latestModalOutsideTapDismissDate = rewindOutsideTapDismissedAtForReset(
    latestModalOutsideTapDismissDate,
    isMobile,
  );
};

export const didNotDismissAnythingWithOutsideTapJustNow = (): boolean => {
  if (latestModalOutsideTapDismissDate === null) return true;
  return didOutsideTapDismissWindowPass(
    latestModalOutsideTapDismissDate,
    Date.now(),
    isMobile,
  );
};
