import { useState, useCallback, useEffect } from "react";
import { newReactionOfKind, playReaction } from "../content/sounds";
import { sendVoiceReaction } from "../connection/connection";
import { showVoiceReactionText } from "../game/board";

export interface BottomControlsActionsInterface {
  isMuted: boolean;
  isReactionPickerVisible: boolean;
  handleUndo: (event: React.MouseEvent<HTMLButtonElement>) => void;
  handleMuteToggle: (event: React.MouseEvent<HTMLButtonElement>) => void;
  handleResign: (event: React.MouseEvent<HTMLButtonElement>) => void;
  handleVoiceReaction: (event: React.MouseEvent<HTMLButtonElement>) => void;
  handleReactionSelect: (reaction: string) => void;
  hideReactionPicker: () => void;
  isVoiceReactionDisabled: boolean;
}

let globalIsMuted = localStorage.getItem("isMuted") === "true";

export const useBottomControlsActions = (): BottomControlsActionsInterface => {
  const [isMuted, setIsMuted] = useState(globalIsMuted);
  const [isReactionPickerVisible, setIsReactionPickerVisible] = useState(false);
  const [isVoiceReactionDisabled, setIsVoiceReactionDisabled] = useState(false);

  useEffect(() => {
    localStorage.setItem("isMuted", isMuted.toString());
    globalIsMuted = isMuted;
  }, [isMuted]);

  const handleUndo = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    // TODO: Implement undo logic
    console.log("Undo");
  }, []);

  const handleMuteToggle = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setIsMuted((prev) => !prev);
  }, []);

  const handleResign = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    // TODO: Implement resign logic
    console.log("Resign");
  }, []);

  const handleVoiceReaction = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setIsReactionPickerVisible((prev) => !prev);
  }, []);

  const handleReactionSelect = useCallback((reaction: string) => {
    setIsReactionPickerVisible(false);
    const reactionObj = newReactionOfKind(reaction);
    sendVoiceReaction(reactionObj);
    playReaction(reactionObj);
    showVoiceReactionText(reaction, false);
    setIsVoiceReactionDisabled(true);
    setTimeout(() => {
      setIsVoiceReactionDisabled(false);
    }, 9999);
  }, []);

  const hideReactionPicker = useCallback(() => {
    setIsReactionPickerVisible(false);
  }, []);

  return {
    isMuted,
    isReactionPickerVisible,
    handleUndo,
    handleMuteToggle,
    handleResign,
    handleVoiceReaction,
    handleReactionSelect,
    hideReactionPicker,
    isVoiceReactionDisabled,
  };
};

export const getIsMuted = (): boolean => globalIsMuted;
