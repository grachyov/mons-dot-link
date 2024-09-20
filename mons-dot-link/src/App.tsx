import React, { useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import BoardComponent from './BoardComponent';

const App: React.FC = () => {
  const [playerReaction, setPlayerReaction] = useState('');
  const [opponentReaction, setOpponentReaction] = useState('');
  const [showVoiceReaction, setShowVoiceReaction] = useState(false);

  return (
    <div className="app-container">
      <div className="connect-button-container">
        <ConnectButton showBalance={false} />
      </div>
      <BoardComponent />
      
      <button className="invite-button"></button>
      <div className="status-text"></div>
      
      {opponentReaction && (
        <div className="opponents-reaction-text">{opponentReaction}</div>
      )}
      
      {playerReaction && (
        <div className="player-reaction-text">{playerReaction}</div>
      )}
      
      <a
        className="rock-link"
        href="https://opensea.io/collection/super-metal-mons-gen-2"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          position: 'absolute',
          bottom: '10pt',
          right: '12pt',
          display: showVoiceReaction ? 'none' : 'block',
        }}
      >
        <img
          src="data:image/webp;base64,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"
          style={{ width: '1.8rem', height: '1.8rem', opacity: 0.81 }}
          alt="Rock"
        />
      </a>
      
      <select
        className="voice-reaction-select"
        style={{
          position: 'absolute',
          bottom: '10pt',
          right: '12pt',
          outline: 'none',
          display: showVoiceReaction ? 'block' : 'none',
          fontSize: '1.23rem',
          opacity: 0.81,
        }}
        onChange={(e) => setPlayerReaction(e.target.value)}
        value={playerReaction}
      >
        <option value="" disabled>say</option>
        <option value="yo">yo</option>
        <option value="wahoo">wahoo</option>
        <option value="drop">drop</option>
        <option value="slurp">slurp</option>
        <option value="gg">gg</option>
      </select>
      
      <footer>
        <div id="link-container" style={{
          display: 'flex',
          justifyContent: 'left',
          gap: '20px',
          alignItems: 'baseline',
          marginLeft: '12pt',
          marginBottom: '-3pt',
          padding: 0,
        }}>
          <a href="https://github.com/supermetalmons/mons-dot-link" className="footer-link" data-key="github" data-text="&nbsp;github&nbsp;">github</a>
          <a href="https://apps.apple.com/app/id6446702971" className="footer-link" data-key="app store" data-text="&nbsp;app store&nbsp;">app store</a>
          <a href="https://x.com/supermetalx" className="footer-link" data-key="x" data-text="&nbsp;x&nbsp;">x</a>
          <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=3210189942" className="footer-link" data-key="steam" data-text="&nbsp;steam&nbsp;">steam</a>
        </div>
      </footer>
    </div>
  );
};

export default App;