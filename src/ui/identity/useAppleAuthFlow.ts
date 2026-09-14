import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { connection } from "../../connection/connection";
import {
  preloadAppleSignInLibrary,
  signInWithApplePopup,
} from "../../connection/appleConnection";
import {
  createAppleAuthFlowController,
  type AppleAuthFlowOptions,
  type AppleConsentSource,
} from "./appleAuthFlowController";

export const useAppleAuthFlow = ({
  consentSource,
  shouldPreload,
  ...options
}: AppleAuthFlowOptions & {
  consentSource: AppleConsentSource;
  shouldPreload: boolean;
}) => {
  const controller = useMemo(
    () =>
      createAppleAuthFlowController({
        consentSource,
        dependencies: {
          beginIntent: () => connection.beginAuthIntent("apple"),
          preload: preloadAppleSignInLibrary,
          openPopup: signInWithApplePopup,
          verify: (intentId, idToken, source) =>
            connection.verifyAppleToken(intentId, idToken, source),
          flushUi: flushSync,
        },
      }),
    [consentSource],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );

  useLayoutEffect(() => {
    controller.attach();
    return controller.detach;
  }, [controller]);
  useLayoutEffect(() => controller.setOptions(options));
  useEffect(() => {
    if (shouldPreload) void controller.prepare().catch(() => {});
  }, [controller, shouldPreload]);

  return {
    state,
    isBusy:
      state === "preparing" || state === "connecting" || state === "verifying",
    start: controller.start,
    resetUi: controller.resetUi,
    invalidateAction: controller.invalidateAction,
    clearIntent: controller.clearIntent,
  };
};
