import type { AuthVerificationResponse } from "@mons/shared/auth";
import {
  APPLE_INTENT_REFRESH_BUFFER_MS,
  isAppleIntentUsable,
  type AppleButtonUiState,
  type AuthIntentResponse,
} from "./authFlowState";

export type AppleConsentSource = "signin" | "settings";

export type AppleAuthFlowOptions = {
  canStart: () => boolean;
  canConfirm: () => boolean;
  onStart: () => void;
  onPopupStart?: () => void;
  onPopupSettled?: (current: boolean, mounted: boolean) => void;
  onVerified: (result: AuthVerificationResponse, mounted: boolean) => void;
  onError: (error: unknown, phase: "prepare" | "connect") => void;
};

type AppleAuthFlowDependencies = {
  beginIntent: () => Promise<AuthIntentResponse>;
  preload: () => Promise<void>;
  openPopup: (
    intent: AuthIntentResponse & { consentSource: AppleConsentSource },
  ) => Promise<{ idToken: string } | null>;
  verify: (
    intentId: string,
    idToken: string,
    consentSource: AppleConsentSource,
  ) => Promise<AuthVerificationResponse>;
  flushUi: (update: () => void) => void;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export const createAppleAuthFlowController = ({
  consentSource,
  dependencies,
}: {
  consentSource: AppleConsentSource;
  dependencies: AppleAuthFlowDependencies;
}) => {
  const now = dependencies.now ?? Date.now;
  const scheduleTimeout = dependencies.setTimeout ?? setTimeout;
  const cancelTimeout = dependencies.clearTimeout ?? clearTimeout;
  const listeners = new Set<() => void>();
  let state: AppleButtonUiState = "idle";
  let preparedIntent: AuthIntentResponse | null = null;
  let pendingIntent: Promise<AuthIntentResponse> | null = null;
  let expiryTimeout: ReturnType<typeof setTimeout> | null = null;
  let latestAction = 0;
  let running = false;
  let mounted = true;
  let options: AppleAuthFlowOptions | null = null;

  const clearExpiryTimeout = () => {
    if (expiryTimeout !== null) {
      cancelTimeout(expiryTimeout);
      expiryTimeout = null;
    }
  };

  const updateState = (nextState: AppleButtonUiState) => {
    if (!mounted) return;
    clearExpiryTimeout();
    if (
      nextState === "confirm" &&
      !isAppleIntentUsable(preparedIntent, now())
    ) {
      nextState = "idle";
    }
    if (state !== nextState) {
      state = nextState;
      listeners.forEach((listener) => listener());
    }
    if (state === "confirm" && preparedIntent) {
      expiryTimeout = scheduleTimeout(
        () => {
          expiryTimeout = null;
          updateState("confirm");
        },
        preparedIntent.expiresAtMs -
          now() -
          APPLE_INTENT_REFRESH_BUFFER_MS +
          50,
      );
    }
  };

  const ensureIntent = (): Promise<AuthIntentResponse> => {
    if (isAppleIntentUsable(preparedIntent, now())) {
      return Promise.resolve(preparedIntent);
    }
    if (!pendingIntent) {
      const request = dependencies
        .beginIntent()
        .then((intent) => {
          if (pendingIntent === request) preparedIntent = intent;
          return intent;
        })
        .finally(() => {
          if (pendingIntent === request) pendingIntent = null;
        });
      pendingIntent = request;
    }
    return pendingIntent;
  };

  const prepare = async () => {
    await Promise.all([dependencies.preload(), ensureIntent()]);
  };

  const resetUi = () => updateState("idle");

  const start = async (): Promise<void> => {
    if (!mounted || running || !options?.canStart()) return;
    const callbacks = options;
    const action = ++latestAction;
    const isCurrent = () => action === latestAction;
    let popupStarted = false;
    running = true;
    try {
      callbacks.onStart();
      const intent = isAppleIntentUsable(preparedIntent, now())
        ? preparedIntent
        : null;
      if (!intent) {
        updateState("preparing");
        await prepare();
        if (isCurrent()) {
          updateState(options?.canConfirm() ? "confirm" : "idle");
        }
        return;
      }
      preparedIntent = null;
      popupStarted = true;
      dependencies.flushUi(() => {
        updateState("connecting");
        callbacks.onPopupStart?.();
      });
      const result = await dependencies.openPopup({ ...intent, consentSource });
      if (!isCurrent() || !result) return;
      updateState("verifying");
      const verified = await dependencies.verify(
        intent.intentId,
        result.idToken,
        consentSource,
      );
      if (isCurrent()) callbacks.onVerified(verified, mounted);
    } catch (error) {
      if (isCurrent()) {
        resetUi();
        if (mounted) {
          callbacks.onError(error, popupStarted ? "connect" : "prepare");
        }
      }
    } finally {
      running = false;
      if (popupStarted) {
        if (isCurrent()) resetUi();
        callbacks.onPopupSettled?.(isCurrent(), mounted);
      }
    }
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setOptions: (nextOptions: AppleAuthFlowOptions) => {
      options = nextOptions;
      if (state === "confirm" && !options.canConfirm()) resetUi();
    },
    attach: () => {
      mounted = true;
      updateState(state);
    },
    detach: () => {
      mounted = false;
      clearExpiryTimeout();
    },
    prepare,
    start,
    resetUi,
    invalidateAction: () => {
      latestAction += 1;
      resetUi();
    },
    clearIntent: () => {
      preparedIntent = null;
      pendingIntent = null;
      resetUi();
    },
  };
};
