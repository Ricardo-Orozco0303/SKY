import { useState } from 'react';
import Deck from './components/Deck';
import Crossfader from './components/Crossfader';
import { useAudioEngine } from './hooks/useAudioEngine';
import './app.css';

export default function App() {
  const engine = useAudioEngine();
  const [crossfade, setCrossfade] = useState(0.5);

  function handleCrossfade(val) {
    setCrossfade(val);
    engine.setCrossfader(val);
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">
          <span className="logo-dj">DJ</span>
          <span className="logo-web">.WEB</span>
        </div>
        <div className="header-sub">Mixer de audio en el navegador · Web Audio API</div>
      </header>

      <main className="mixer">
        <div className="decks-row">
          <Deck id="A" engine={engine} crossfade={crossfade} />
          <Deck id="B" engine={engine} crossfade={crossfade} />
        </div>

        <Crossfader value={crossfade} onChange={handleCrossfade} />
      </main>

      <footer className="app-footer">
        <span>Carga archivos de audio en cada deck · Todos los efectos corren en tiempo real</span>
      </footer>
    </div>
  );
}
