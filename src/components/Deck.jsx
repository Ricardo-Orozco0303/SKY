import { useState, useRef, useEffect } from 'react';
import Waveform from './Waveform';

const COLORS = { A: '#3b82f6', B: '#f59e0b' };

export default function Deck({ id, engine, crossfade }) {
  const [trackName, setTrackName] = useState(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [eq, setEqState] = useState({ low: 0, mid: 0, high: 0 });
  const [reverb, setReverbState] = useState(0);
  const [delay, setDelayState] = useState(0);
  const [analyser, setAnalyser] = useState(null);
  const timerRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    return () => clearInterval(timerRef.current);
  }, []);

  function startTimer() {
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const t = engine.getCurrentTime(id);
      setCurrentTime(t);
      if (t >= duration && duration > 0) {
        setIsPlaying(false);
        clearInterval(timerRef.current);
      }
    }, 100);
  }

  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setTrackName(file.name.replace(/\.[^.]+$/, ''));
    const result = await engine.loadTrack(id, file);
    setDuration(result.duration);
    setCurrentTime(0);
    setAnalyser(engine.getAnalyser(id));
  }

  function togglePlay() {
    if (!trackName) { fileRef.current.click(); return; }
    if (isPlaying) {
      engine.pause(id);
      clearInterval(timerRef.current);
      setIsPlaying(false);
    } else {
      engine.play(id);
      setIsPlaying(true);
      startTimer();
    }
  }

  function handleSeek(pct) {
    const t = pct * duration;
    engine.seek(id, t);
    setCurrentTime(t);
    if (isPlaying) startTimer();
  }

  function handleEQ(band, val) {
    setEqState(prev => ({ ...prev, [band]: val }));
    engine.setEQ(id, band, parseFloat(val));
  }

  function handleReverb(val) {
    setReverbState(val);
    engine.setReverb(id, parseFloat(val));
  }

  function handleDelay(val) {
    setDelayState(val);
    engine.setDelay(id, parseFloat(val));
  }

  function fmt(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  const progress = duration > 0 ? currentTime / duration : 0;
  const color = COLORS[id];

  return (
    <div className={`deck deck-${id.toLowerCase()}`}>
      <div className="deck-header">
        <span className="deck-label" style={{ color }}>DECK {id}</span>
        <span className="deck-track-name">{trackName || 'Sin track — haz click para cargar'}</span>
        <span className="deck-time">{fmt(currentTime)} / {fmt(duration)}</span>
      </div>

      <div className="deck-waveform">
        <Waveform
          analyser={analyser}
          color={color}
          progress={progress}
          onClick={handleSeek}
        />
      </div>

      <div className="deck-controls">
        <div className="deck-transport">
          <button className="btn-icon" onClick={() => handleSeek(0)} title="Inicio">⏮</button>
          <button
            className={`btn-play ${isPlaying ? 'playing' : ''}`}
            style={{ '--deck-color': color }}
            onClick={togglePlay}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            style={{ display: 'none' }}
            onChange={handleFile}
          />
          <button className="btn-load" onClick={() => fileRef.current.click()}>
            📂 Cargar
          </button>
        </div>

        <div className="deck-eq">
          <span className="section-label">EQ</span>
          {['high', 'mid', 'low'].map(band => (
            <div key={band} className="eq-knob">
              <label>{band.toUpperCase()}</label>
              <input
                type="range"
                min="-12" max="12" step="0.5"
                value={eq[band]}
                onChange={e => handleEQ(band, e.target.value)}
                className="eq-slider"
                style={{ '--track-color': color }}
              />
              <span>{eq[band] > 0 ? '+' : ''}{eq[band]} dB</span>
            </div>
          ))}
        </div>

        <div className="deck-fx">
          <span className="section-label">FX</span>
          <div className="fx-row">
            <label>REVERB</label>
            <input
              type="range" min="0" max="1" step="0.01"
              value={reverb}
              onChange={e => handleReverb(e.target.value)}
              style={{ '--track-color': color }}
            />
            <span>{Math.round(reverb * 100)}%</span>
          </div>
          <div className="fx-row">
            <label>DELAY</label>
            <input
              type="range" min="0" max="1" step="0.01"
              value={delay}
              onChange={e => handleDelay(e.target.value)}
              style={{ '--track-color': color }}
            />
            <span>{Math.round(delay * 100)}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}
