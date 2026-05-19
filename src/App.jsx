import { useState, useRef, useEffect, useCallback } from "react";

/* ─── BPM DETECTOR ─── */
async function detectBPM(audioBuffer) {
  const data = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  const windowSize = 512;
  const energies = [];
  for (let i = 0; i < data.length - windowSize; i += windowSize) {
    let e = 0;
    for (let j = 0; j < windowSize; j++) e += data[i + j] ** 2;
    energies.push(e / windowSize);
  }
  const avg = energies.reduce((a, b) => a + b, 0) / energies.length;
  const threshold = avg * 1.5;
  const beats = [];
  let lastBeat = -1;
  for (let i = 1; i < energies.length - 1; i++) {
    if (energies[i] > threshold && energies[i] > energies[i - 1] && energies[i] > energies[i + 1]) {
      const t = (i * windowSize) / sr;
      if (lastBeat < 0 || t - lastBeat > 0.3) { beats.push(t); lastBeat = t; }
    }
  }
  if (beats.length < 4) return null;
  const intervals = [];
  for (let i = 1; i < Math.min(beats.length, 40); i++) intervals.push(beats[i] - beats[i - 1]);
  const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const bpm = Math.round(60 / avgInterval);
  return bpm > 60 && bpm < 200 ? bpm : null;
}

/* ─── AUDIO ENGINE ─── */
function useAudioEngine() {
  const ctxRef = useRef(null);
  const decksRef = useRef({});

  function getCtx() {
    if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    if (ctxRef.current.state === "suspended") ctxRef.current.resume();
    return ctxRef.current;
  }

  async function createReverbIR(ctx) {
    const sr = ctx.sampleRate, len = sr * 2.5;
    const buf = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
    }
    return buf;
  }

  const loadTrack = useCallback(async (deckId, file) => {
    const ctx = getCtx();
    const ab = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(ab);
    const existing = decksRef.current[deckId];
    if (existing?.source) { try { existing.source.stop(); } catch (_) {} }

    const low = ctx.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 320;
    const mid = ctx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 0.7;
    const high = ctx.createBiquadFilter(); high.type = "highshelf"; high.frequency.value = 3200;
    const convolver = ctx.createConvolver();
    createReverbIR(ctx).then(ir => { convolver.buffer = ir; });
    const reverbGain = ctx.createGain(); reverbGain.gain.value = 0;
    const dryGain = ctx.createGain(); dryGain.gain.value = 1;
    const delay = ctx.createDelay(2);
    const delayWet = ctx.createGain(); delayWet.gain.value = 0;
    const delayFeedback = ctx.createGain(); delayFeedback.gain.value = 0;
    delay.delayTime.value = 0.32;
    const channelGain = ctx.createGain(); channelGain.gain.value = 1;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 2048;

    low.connect(mid); mid.connect(high);
    high.connect(dryGain); dryGain.connect(channelGain);
    high.connect(reverbGain); reverbGain.connect(convolver); convolver.connect(channelGain);
    high.connect(delayWet); delayWet.connect(delay); delay.connect(delayFeedback);
    delayFeedback.connect(delay); delay.connect(channelGain);
    channelGain.connect(analyser); analyser.connect(ctx.destination);

    const bpm = await detectBPM(audioBuffer);
    decksRef.current[deckId] = {
      audioBuffer, source: null, low, mid, high, reverbGain, dryGain,
      delayWet, delayFeedback, channelGain, analyser,
      startTime: 0, offset: 0, isPlaying: false, duration: audioBuffer.duration, bpm,
    };
    return { duration: audioBuffer.duration, bpm };
  }, []);

  const play = useCallback((deckId) => {
    const ctx = getCtx(); const deck = decksRef.current[deckId];
    if (!deck || deck.isPlaying) return;
    if (deck.offset >= deck.duration) deck.offset = 0;
    const source = ctx.createBufferSource(); source.buffer = deck.audioBuffer; source.connect(deck.low);
    deck.channelGain.gain.cancelScheduledValues(ctx.currentTime);
    deck.channelGain.gain.setValueAtTime(0, ctx.currentTime);
    deck.channelGain.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.08);
    source.start(0, deck.offset);
    deck.source = source; deck.startTime = ctx.currentTime; deck.isPlaying = true;
    source.onended = () => { if (!deck.isPlaying) return; deck.isPlaying = false; deck.offset = 0; deck.source = null; };
  }, []);

  const pause = useCallback((deckId) => {
    const ctx = getCtx(); const deck = decksRef.current[deckId];
    if (!deck || !deck.isPlaying) return;
    deck.offset += ctx.currentTime - deck.startTime;
    try {
      deck.channelGain.gain.cancelScheduledValues(ctx.currentTime);
      deck.channelGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.05);
      setTimeout(() => { try { deck.source?.stop(); } catch (_) {} }, 60);
    } catch (_) {}
    deck.isPlaying = false;
  }, []);

  const seek = useCallback((deckId, time) => {
    const deck = decksRef.current[deckId]; if (!deck) return;
    const safeTime = Math.max(0, Math.min(time, deck.duration));
    const wasPlaying = deck.isPlaying;
    if (wasPlaying) { try { deck.source?.stop(); } catch (_) {} deck.isPlaying = false; }
    deck.offset = safeTime;
    if (wasPlaying) setTimeout(() => play(deckId), 10);
  }, [play]);

  const getCurrentTime = useCallback((deckId) => {
    const deck = decksRef.current[deckId]; const ctx = ctxRef.current;
    if (!deck) return 0;
    if (!deck.isPlaying) return deck.offset;
    const current = deck.offset + (ctx.currentTime - deck.startTime);
    if (current >= deck.duration) { deck.isPlaying = false; deck.offset = 0; return deck.duration; }
    return current;
  }, []);

  const setEQ = useCallback((deckId, band, gainDb) => {
    const deck = decksRef.current[deckId];
    if (deck?.[band]) deck[band].gain.value = gainDb;
  }, []);

  const setReverb = useCallback((deckId, wet) => {
    const deck = decksRef.current[deckId]; if (!deck) return;
    deck.reverbGain.gain.value = wet; deck.dryGain.gain.value = 1 - wet * 0.4;
  }, []);

  const setDelay = useCallback((deckId, wet) => {
    const deck = decksRef.current[deckId]; if (!deck) return;
    deck.delayWet.gain.value = wet; deck.delayFeedback.gain.value = wet * 0.45;
  }, []);

  const setCrossfader = useCallback((value) => {
    const deckA = decksRef.current.A; const deckB = decksRef.current.B;
    if (deckA) deckA.channelGain.gain.value = Math.cos(value * Math.PI * 0.5);
    if (deckB) deckB.channelGain.gain.value = Math.cos((1 - value) * Math.PI * 0.5);
  }, []);

  const getAnalyser = useCallback((deckId) => decksRef.current[deckId]?.analyser || null, []);

  return { loadTrack, play, pause, seek, getCurrentTime, setEQ, setReverb, setDelay, setCrossfader, getAnalyser };
}

/* ─── WAVEFORM ─── */
function Waveform({ analyser, color, progress, onClick }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d");
    function draw() {
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H); ctx.fillStyle = "#080810"; ctx.fillRect(0, 0, W, H);
      if (analyser) {
        const buf = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(buf);
        ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.9;
        for (let i = 0; i < buf.length; i++) {
          const x = (i / buf.length) * W, y = ((buf[i] / 128) - 1) * (H / 2) + H / 2;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke(); ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
      }
      const px = progress * W;
      ctx.fillStyle = "rgba(200,240,68,0.12)"; ctx.fillRect(0, 0, px, H);
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H);
      ctx.strokeStyle = "#c8f044"; ctx.lineWidth = 1.5; ctx.stroke();
      rafRef.current = requestAnimationFrame(draw);
    }
    draw();
    return () => cancelAnimationFrame(rafRef.current);
  }, [analyser, color, progress]);
  function handleClick(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    onClick((e.clientX - rect.left) / rect.width);
  }
  return <canvas ref={canvasRef} width={600} height={72} style={{ width: "100%", height: "72px", cursor: "crosshair", display: "block" }} onClick={handleClick} />;
}

/* ─── KNOB ─── */
function Knob({ label, value, min, max, onChange, color, size = 42 }) {
  const startY = useRef(null), startVal = useRef(null);
  function onMouseDown(e) {
    startY.current = e.clientY; startVal.current = value;
    const onMove = ev => onChange(Math.max(min, Math.min(max, startVal.current + (startY.current - ev.clientY) / 80 * (max - min))));
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
  }
  const pct = (value - min) / (max - min), angle = -135 + pct * 270;
  const r = size / 2 - 4, rad = angle * Math.PI / 180;
  const x = size / 2 + r * Math.sin(rad), y = size / 2 - r * Math.cos(rad);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, userSelect: "none" }}>
      <svg width={size} height={size} onMouseDown={onMouseDown} style={{ cursor: "ns-resize" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={3} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={3}
          strokeDasharray={`${pct * 2 * Math.PI * r} ${2 * Math.PI * r}`}
          strokeDashoffset={2 * Math.PI * r * 0.25}
          transform={`rotate(-135 ${size/2} ${size/2})`} strokeLinecap="round" />
        <line x1={size/2} y1={size/2} x2={x} y2={y} stroke={color} strokeWidth={2} strokeLinecap="round" />
        <circle cx={size/2} cy={size/2} r={4} fill="#16161f" />
      </svg>
      <span style={{ fontSize: 8, color: "#55576a", letterSpacing: "1px", textTransform: "uppercase" }}>{label}</span>
    </div>
  );
}

/* ─── VU METER ─── */
function VUMeter({ analyser, color }) {
  const canvasRef = useRef(null), rafRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d");
    function draw() {
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H); ctx.fillStyle = "#080810"; ctx.fillRect(0, 0, W, H);
      let level = 0;
      if (analyser) { const buf = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(buf); level = buf.reduce((a,b)=>a+b,0)/buf.length/255; }
      const bars = 12;
      for (let i = 0; i < bars; i++) {
        const pct = i / bars;
        ctx.fillStyle = level * bars > i ? (pct > 0.8 ? "#ff4444" : pct > 0.6 ? "#ffaa00" : color) : "rgba(255,255,255,0.05)";
        ctx.fillRect(2, H - (i+1)*(H/bars)+1, W-4, H/bars-2);
      }
      rafRef.current = requestAnimationFrame(draw);
    }
    draw();
    return () => cancelAnimationFrame(rafRef.current);
  }, [analyser, color]);
  return <canvas ref={canvasRef} width={18} height={80} style={{ width: 18, height: 80, borderRadius: 3 }} />;
}

/* ─── DECK ─── */
function Deck({ id, engine, crossfade, onDeckInfo, extEQ, extReverb, extDelay }) {
  const [trackName, setTrackName] = useState(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [eq, setEqState] = useState({ low: 0, mid: 0, high: 0 });
  const [reverb, setReverbState] = useState(0);
  const [delay, setDelayState] = useState(0);
  const [analyser, setAnalyser] = useState(null);
  const [bpm, setBpm] = useState(null);
  const timerRef = useRef(null);
  const fileRef = useRef(null);
  const color = id === "A" ? "#3b82f6" : "#f59e0b";

  useEffect(() => () => clearInterval(timerRef.current), []);

  // Apply external overrides from automix/AI
  useEffect(() => { if (extEQ) setEqState(prev => ({...prev, ...extEQ})); }, [JSON.stringify(extEQ)]);
  useEffect(() => { if (extReverb !== undefined && extReverb !== null) setReverbState(extReverb); }, [extReverb]);
  useEffect(() => { if (extDelay !== undefined && extDelay !== null) setDelayState(extDelay); }, [extDelay]);

  useEffect(() => { onDeckInfo(id, { track: trackName, duration, eq, reverb, delay, bpm }); }, [trackName, duration, eq, reverb, delay, bpm]);

  function startTimer() {
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const t = engine.getCurrentTime(id); setCurrentTime(t);
      if (t >= duration && duration > 0) { setIsPlaying(false); clearInterval(timerRef.current); }
    }, 100);
  }

  async function handleFile(e) {
    const file = e.target.files[0]; if (!file) return;
    setTrackName(file.name.replace(/\.[^.]+$/, ""));
    const result = await engine.loadTrack(id, file);
    setDuration(result.duration); setCurrentTime(0);
    setAnalyser(engine.getAnalyser(id)); setBpm(result.bpm);
  }

  function togglePlay() {
    if (!trackName) { fileRef.current.click(); return; }
    if (isPlaying) { engine.pause(id); clearInterval(timerRef.current); setIsPlaying(false); }
    else { engine.play(id); setIsPlaying(true); startTimer(); }
  }

  function handleSeek(pct) {
    const t = pct * duration; engine.seek(id, t); setCurrentTime(t);
    if (isPlaying) startTimer();
  }

  function handleEQ(band, val) {
    const v = parseFloat(val); setEqState(prev => ({...prev, [band]: v})); engine.setEQ(id, band, v);
  }
  function handleReverb(val) { const v = parseFloat(val); setReverbState(v); engine.setReverb(id, v); }
  function handleDelay(val) { const v = parseFloat(val); setDelayState(v); engine.setDelay(id, v); }

  const fmt = s => !s || isNaN(s) ? "0:00" : `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,"0")}`;
  const progress = duration > 0 ? currentTime / duration : 0;

  return (
    <div style={{ background: "#0e0e18", border: "0.5px solid rgba(255,255,255,0.08)", borderTop: `2px solid ${color}`, borderRadius: 8, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "rgba(255,255,255,0.02)", borderBottom: "0.5px solid rgba(255,255,255,0.06)" }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "3px", color, minWidth: 52 }}>DECK {id}</span>
        <span style={{ flex: 1, fontSize: 10, color: "#dde0f0", opacity: 0.65, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{trackName || "Sin track · click para cargar"}</span>
        {bpm && <span style={{ fontSize: 9, color, background: `${color}18`, padding: "2px 6px", borderRadius: 3, letterSpacing: "1px" }}>{bpm} BPM</span>}
        <span style={{ fontSize: 10, color: "#55576a", minWidth: 80, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt(currentTime)} / {fmt(duration)}</span>
      </div>
      <div style={{ background: "#080810", borderBottom: "0.5px solid rgba(255,255,255,0.05)" }}>
        <Waveform analyser={analyser} color={color} progress={progress} onClick={handleSeek} />
      </div>
      <div style={{ display: "flex", gap: 16, padding: "14px 14px", alignItems: "flex-start", flex: 1 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, minWidth: 50 }}>
          <VUMeter analyser={analyser} color={color} />
          <button onClick={() => handleSeek(0)} style={{ background: "none", border: "0.5px solid rgba(255,255,255,0.1)", color: "#55576a", borderRadius: "50%", width: 26, height: 26, cursor: "pointer", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>⏮</button>
          <button onClick={togglePlay} style={{ width: 44, height: 44, borderRadius: "50%", border: `2px solid ${color}`, background: isPlaying ? color : `${color}18`, color: isPlaying ? "#000" : color, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s" }}>
            {isPlaying ? "⏸" : "▶"}
          </button>
          <input ref={fileRef} type="file" accept="audio/*" style={{ display: "none" }} onChange={handleFile} />
          <button onClick={() => fileRef.current.click()} style={{ fontSize: 8, fontFamily: "inherit", padding: "4px 7px", borderRadius: 4, border: "0.5px solid rgba(255,255,255,0.1)", background: "none", color: "#55576a", cursor: "pointer", letterSpacing: "0.5px", whiteSpace: "nowrap" }}>📂 LOAD</button>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 8, color: "#55576a", letterSpacing: "2px", marginBottom: 10 }}>EQ</div>
          <div style={{ display: "flex", gap: 12, justifyContent: "space-around" }}>
            {["high", "mid", "low"].map(band => (
              <Knob key={band} label={band} value={eq[band]} min={-12} max={12} color={color} size={42} onChange={v => handleEQ(band, v)} />
            ))}
          </div>
        </div>
        <div style={{ minWidth: 90 }}>
          <div style={{ fontSize: 8, color: "#55576a", letterSpacing: "2px", marginBottom: 8 }}>FX</div>
          {[{ label: "REVERB", value: reverb, onChange: handleReverb }, { label: "DELAY", value: delay, onChange: handleDelay }].map(fx => (
            <div key={fx.label} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 8, color: "#55576a", letterSpacing: "1px" }}>{fx.label}</span>
                <span style={{ fontSize: 8, color: "#55576a" }}>{Math.round(fx.value * 100)}%</span>
              </div>
              <input type="range" min={0} max={1} step={0.01} value={fx.value} onChange={e => fx.onChange(e.target.value)} style={{ width: "100%", accentColor: color, height: 3 }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── CROSSFADER ─── */
function Crossfader({ value, onChange }) {
  return (
    <div style={{ background: "#0e0e18", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "12px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "#3b82f6", opacity: value < 0.5 ? 1 : 0.3, transition: "opacity 0.1s" }}>A</span>
        <span style={{ fontSize: 8, letterSpacing: "3px", color: "#55576a" }}>CROSSFADER</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: "#f59e0b", opacity: value > 0.5 ? 1 : 0.3, transition: "opacity 0.1s" }}>B</span>
      </div>
      <input type="range" min={0} max={1} step={0.01} value={value} onChange={e => onChange(parseFloat(e.target.value))} style={{ width: "100%", height: 4, accentColor: "#c8f044" }} />
      <div style={{ display: "flex", height: 3, borderRadius: 2, overflow: "hidden", background: "rgba(255,255,255,0.05)" }}>
        <div style={{ width: `${Math.round((1-value)*100)}%`, background: "#3b82f6", transition: "width 0.05s", borderRadius: "2px 0 0 2px" }} />
        <div style={{ width: `${Math.round(value*100)}%`, background: "#f59e0b", transition: "width 0.05s", borderRadius: "0 2px 2px 0", marginLeft: "auto" }} />
      </div>
    </div>
  );
}

/* ─── AI PANEL ─── */
function AIPanel({ decksInfo, crossfade, onApply, onAutomix, automixRunning, automixPhase, automixProgress, onStopAutomix }) {
  const [messages, setMessages] = useState([
    { role: "assistant", content: "¡Hola! Soy tu asistente de mezcla IA.\n\nCargá tracks en los decks y te ayudo. Podés pedirme:\n• \"transición suave de A a B\"\n• \"activá el automix\"\n• \"mezcla para medianoche\"\n• \"analizá mis decks\"" }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const chatRef = useRef(null);

  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [messages]);

  // Receive external AI messages from automix
  const addMsg = useCallback((content, role = "assistant", extra = {}) => {
    setMessages(prev => [...prev, { role, content, ...extra }]);
  }, []);

  // Expose addMsg for automix engine
  useEffect(() => { window.__aiAddMsg = addMsg; }, [addMsg]);

  async function sendMessage() {
    const userMsg = input.trim() || "Analizá mis decks";
    if (!input.trim() && !decksInfo.A.track && !decksInfo.B.track) return;
    setInput(""); addMsg(userMsg, "user"); setLoading(true);

    const hour = new Date().getHours();
    const timeCtx = hour < 6 ? "madrugada íntima" : hour < 12 ? "mañana fresca" : hour < 18 ? "tarde relajada" : hour < 22 ? "noche calentando" : "medianoche, fiesta en su pico";

    const system = `Eres un DJ experto. Analiza los decks y da consejos o ejecuta automix.

ESTADO:
- Hora: ${new Date().toLocaleTimeString('es')} (${timeCtx})
- Deck A: "${decksInfo.A.track||'vacío'}" BPM:${decksInfo.A.bpm||'?'} EQ:L${decksInfo.A.eq.low} M${decksInfo.A.eq.mid} H${decksInfo.A.eq.high} Rev:${Math.round(decksInfo.A.reverb*100)}% Del:${Math.round(decksInfo.A.delay*100)}%
- Deck B: "${decksInfo.B.track||'vacío'}" BPM:${decksInfo.B.bpm||'?'} EQ:L${decksInfo.B.eq.low} M${decksInfo.B.eq.mid} H${decksInfo.B.eq.high} Rev:${Math.round(decksInfo.B.reverb*100)}% Del:${Math.round(decksInfo.B.delay*100)}%
- Crossfader: ${Math.round(crossfade*100)}% → B
- Automix: ${automixRunning ? 'ACTIVO' : 'inactivo'}

Para aplicar ajustes instantáneos, incluí al final:
[APPLY:{"deckA":{"eq":{"low":0,"mid":0,"high":0},"reverb":0.0,"delay":0.0},"deckB":{"eq":{"low":0,"mid":0,"high":0},"reverb":0.0,"delay":0.0},"crossfade":0.5}]

Para transición automática (automix), incluí al final:
[AUTOMIX:{"steps":[
{"type":"eq","deck":"A","band":"low","value":-8,"description":"Bajo graves del Deck A"},
{"type":"reverb","deck":"A","value":0.5,"description":"Agrego reverb al Deck A"},
{"type":"wait","duration":2,"description":"Espero 2 segundos"},
{"type":"crossfade","from":0.05,"to":0.95,"duration":10,"description":"Transición suave de 10 segundos","label":"transitioning"},
{"type":"reverb","deck":"A","value":0,"description":"Quito reverb del Deck A"},
{"type":"eq","deck":"A","band":"low","value":0,"description":"Restauro EQ del Deck A"}
]}]

Responde en español, máximo 3 párrafos, sé específico y creativo.`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 1000,
          system,
          messages: [...messages.filter((_,i)=>i>0).map(m=>({role:m.role,content:m.content})), { role:"user", content:userMsg }]
        })
      });
      const data = await res.json();
      const text = data.content?.map(b => b.text||"").join("") || "Error.";
      const applyMatch = text.match(/\[APPLY:([\s\S]*?)\]/);
      const automixMatch = text.match(/\[AUTOMIX:([\s\S]*?)\]/);
      const clean = text.replace(/\[APPLY:[\s\S]*?\]/,"").replace(/\[AUTOMIX:[\s\S]*?\]/,"").trim();
      let applyData = null, automixData = null;
      try { if (applyMatch) applyData = JSON.parse(applyMatch[1]); } catch(_) {}
      try { if (automixMatch) automixData = JSON.parse(automixMatch[1]); } catch(_) {}
      addMsg(clean, "assistant", { applyData, automixData });
    } catch(e) { addMsg("Error de conexión."); }
    setLoading(false);
  }

  const quickActions = ["Transición suave", "Subir energía", "Mezcla nocturna", "Analizar decks", "Automix ahora"];

  return (
    <div style={{ background: "#0e0e18", border: "0.5px solid rgba(200,240,68,0.2)", borderRadius: 8, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "10px 14px", borderBottom: "0.5px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 7, height: 7, borderRadius: "50%", background: automixRunning ? "#f59e0b" : "#c8f044", boxShadow: `0 0 6px ${automixRunning ? "#f59e0b" : "#c8f044"}`, animation: "pulse 2s infinite" }} />
        <span style={{ fontSize: 10, letterSpacing: "2px", color: automixRunning ? "#f59e0b" : "#c8f044", fontWeight: 500 }}>{automixRunning ? "AUTOMIX ACTIVO" : "AI MIXER"}</span>
        {automixRunning && (
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 50, height: 3, background: "rgba(255,255,255,0.1)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${automixProgress}%`, height: "100%", background: "#f59e0b", transition: "width 0.1s", borderRadius: 2 }} />
            </div>
            <button onClick={onStopAutomix} style={{ fontSize: 8, padding: "2px 7px", border: "0.5px solid #ff4444", background: "rgba(255,68,68,0.1)", color: "#ff4444", borderRadius: 3, cursor: "pointer", fontFamily: "inherit" }}>STOP</button>
          </div>
        )}
      </div>

      {automixRunning && (
        <div style={{ padding: "5px 14px", background: "rgba(245,158,11,0.05)", borderBottom: "0.5px solid rgba(245,158,11,0.15)", fontSize: 9, color: "#f59e0b", letterSpacing: "1px" }}>
          ⚡ {automixPhase?.toUpperCase() || "PROCESANDO"}
        </div>
      )}

      {/* Chat */}
      <div ref={chatRef} style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start", gap: 4 }}>
            <div style={{
              maxWidth: "90%", padding: "8px 11px",
              borderRadius: m.role === "user" ? "10px 10px 2px 10px" : "10px 10px 10px 2px",
              background: m.role === "user" ? "rgba(200,240,68,0.1)" : "rgba(255,255,255,0.03)",
              border: `0.5px solid ${m.role === "user" ? "rgba(200,240,68,0.2)" : "rgba(255,255,255,0.06)"}`,
              fontSize: 11, lineHeight: 1.65, color: m.role === "user" ? "#c8f044" : "#ccd0e8", whiteSpace: "pre-wrap"
            }}>{m.content}</div>
            <div style={{ display: "flex", gap: 5 }}>
              {m.applyData && (
                <button onClick={() => onApply(m.applyData)} style={{ fontSize: 9, padding: "3px 8px", borderRadius: 4, border: "0.5px solid rgba(200,240,68,0.4)", background: "rgba(200,240,68,0.08)", color: "#c8f044", cursor: "pointer", fontFamily: "inherit" }}>
                  ⚡ APLICAR
                </button>
              )}
              {m.automixData && !automixRunning && (
                <button onClick={() => onAutomix(m.automixData, addMsg)} style={{ fontSize: 9, padding: "3px 8px", borderRadius: 4, border: "0.5px solid rgba(245,158,11,0.4)", background: "rgba(245,158,11,0.08)", color: "#f59e0b", cursor: "pointer", fontFamily: "inherit" }}>
                  🎛️ INICIAR AUTOMIX
                </button>
              )}
            </div>
          </div>
        ))}
        {loading && <div style={{ fontSize: 11, color: "#55576a", fontStyle: "italic" }}>Analizando...</div>}
      </div>

      {/* Quick actions */}
      <div style={{ padding: "7px 12px", borderTop: "0.5px solid rgba(255,255,255,0.05)", display: "flex", gap: 4, flexWrap: "wrap" }}>
        {quickActions.map(q => (
          <button key={q} onClick={() => setInput(q)} style={{ fontSize: 8, padding: "3px 7px", borderRadius: 10, border: "0.5px solid rgba(255,255,255,0.08)", background: "none", color: "#55576a", cursor: "pointer", fontFamily: "inherit" }}>{q}</button>
        ))}
      </div>

      {/* Input */}
      <div style={{ padding: "8px 12px", borderTop: "0.5px solid rgba(255,255,255,0.06)", display: "flex", gap: 8 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage()}
          placeholder="Pedí una sugerencia..."
          style={{ flex: 1, background: "rgba(255,255,255,0.04)", border: "0.5px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "7px 10px", fontSize: 11, color: "#dde0f0", outline: "none", fontFamily: "inherit" }}
        />
        <button onClick={sendMessage} disabled={loading} style={{ padding: "7px 12px", borderRadius: 6, border: "none", background: loading ? "rgba(200,240,68,0.2)" : "#c8f044", color: "#000", fontSize: 11, fontWeight: 700, cursor: loading ? "default" : "pointer", fontFamily: "inherit" }}>↑</button>
      </div>
    </div>
  );
}

/* ─── APP ─── */
export default function App() {
  const engine = useAudioEngine();
  const [crossfade, setCrossfade] = useState(0.5);
  const [decksInfo, setDecksInfo] = useState({
    A: { track: null, duration: 0, eq: { low:0, mid:0, high:0 }, reverb: 0, delay: 0, bpm: null },
    B: { track: null, duration: 0, eq: { low:0, mid:0, high:0 }, reverb: 0, delay: 0, bpm: null }
  });
  const [extOverrides, setExtOverrides] = useState({ A: {}, B: {} });

  // Automix state
  const [automixRunning, setAutomixRunning] = useState(false);
  const [automixPhase, setAutomixPhase] = useState(null);
  const [automixProgress, setAutomixProgress] = useState(0);
  const automixAbortRef = useRef(false);

  function handleCrossfade(val) { setCrossfade(val); engine.setCrossfader(val); }
  function handleDeckInfo(id, info) { setDecksInfo(prev => ({...prev, [id]: info})); }

  function applyExt(deck, patch) { setExtOverrides(prev => ({...prev, [deck]: {...prev[deck], ...patch}})); }

  function handleApply(data) {
    if (data.deckA) {
      if (data.deckA.eq) { Object.entries(data.deckA.eq).forEach(([b,v]) => engine.setEQ("A",b,v)); applyExt("A", { eq: data.deckA.eq }); }
      if (data.deckA.reverb !== undefined) { engine.setReverb("A", data.deckA.reverb); applyExt("A", { reverb: data.deckA.reverb }); }
      if (data.deckA.delay !== undefined) { engine.setDelay("A", data.deckA.delay); applyExt("A", { delay: data.deckA.delay }); }
    }
    if (data.deckB) {
      if (data.deckB.eq) { Object.entries(data.deckB.eq).forEach(([b,v]) => engine.setEQ("B",b,v)); applyExt("B", { eq: data.deckB.eq }); }
      if (data.deckB.reverb !== undefined) { engine.setReverb("B", data.deckB.reverb); applyExt("B", { reverb: data.deckB.reverb }); }
      if (data.deckB.delay !== undefined) { engine.setDelay("B", data.deckB.delay); applyExt("B", { delay: data.deckB.delay }); }
    }
    if (data.crossfade !== undefined) handleCrossfade(data.crossfade);
  }

  async function handleAutomix(plan, addMsg) {
    automixAbortRef.current = false;
    setAutomixRunning(true);
    addMsg("🎛️ **AUTOMIX INICIADO** — ejecutando secuencia...", "assistant");

    for (const step of plan.steps) {
      if (automixAbortRef.current) break;
      setAutomixPhase(step.description || step.type);

      if (step.type === "eq") {
        engine.setEQ(step.deck, step.band, step.value);
        applyExt(step.deck, { eq: { [step.band]: step.value } });
        addMsg(`▶ ${step.description}`);
        await new Promise(r => setTimeout(r, 400));
      } else if (step.type === "reverb") {
        engine.setReverb(step.deck, step.value);
        applyExt(step.deck, { reverb: step.value });
        addMsg(`▶ ${step.description}`);
        await new Promise(r => setTimeout(r, 400));
      } else if (step.type === "delay") {
        engine.setDelay(step.deck, step.value);
        applyExt(step.deck, { delay: step.value });
        addMsg(`▶ ${step.description}`);
        await new Promise(r => setTimeout(r, 400));
      } else if (step.type === "wait") {
        addMsg(`⏱ ${step.description}`);
        setAutomixProgress(0);
        const end = Date.now() + step.duration * 1000;
        await new Promise(resolve => {
          const tick = setInterval(() => {
            if (automixAbortRef.current) { clearInterval(tick); resolve(); return; }
            const remaining = end - Date.now();
            setAutomixProgress(Math.max(0, Math.min(100, 100 - (remaining / (step.duration * 1000)) * 100)));
            if (remaining <= 0) { clearInterval(tick); resolve(); }
          }, 100);
        });
      } else if (step.type === "crossfade") {
        addMsg(`🎚 ${step.description}`);
        const from = step.from ?? crossfade, to = step.to, duration = step.duration * 1000;
        const start = Date.now();
        await new Promise(resolve => {
          const tick = setInterval(() => {
            if (automixAbortRef.current) { clearInterval(tick); resolve(); return; }
            const elapsed = Date.now() - start;
            const t = Math.min(elapsed / duration, 1);
            const eased = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
            const val = from + (to - from) * eased;
            setCrossfade(val); engine.setCrossfader(val);
            setAutomixProgress(t * 100);
            if (t >= 1) { clearInterval(tick); resolve(); }
          }, 50);
        });
      }
    }

    if (!automixAbortRef.current) {
      addMsg("✅ **Transición completada.**", "assistant");
    } else {
      addMsg("⛔ Automix detenido.", "assistant");
    }
    setAutomixRunning(false); setAutomixPhase(null); setAutomixProgress(0);
  }

  function stopAutomix() { automixAbortRef.current = true; }

  const bpmDiff = decksInfo.A.bpm && decksInfo.B.bpm ? Math.abs(decksInfo.A.bpm - decksInfo.B.bpm) : null;

  return (
    <div style={{ minHeight: "100vh", background: "#080810", color: "#dde0f0", fontFamily: "'DM Mono','Courier New',monospace", WebkitFontSmoothing: "antialiased", backgroundImage: "radial-gradient(ellipse at 20% 50%, rgba(59,130,246,0.04) 0%, transparent 60%), radial-gradient(ellipse at 80% 20%, rgba(245,158,11,0.04) 0%, transparent 60%)" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input[type=range] { cursor: pointer; }
        ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-track{background:transparent} ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:2px}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
      `}</style>

      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "0 16px", display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 16, padding: "14px 0", borderBottom: "0.5px solid rgba(255,255,255,0.06)", marginBottom: 14 }}>
          <div style={{ fontSize: 20, fontWeight: 500, letterSpacing: 1 }}>
            <span style={{ color: "#c8f044" }}>DJ</span><span style={{ color: "#55576a" }}>.WEB</span>
          </div>
          <div style={{ fontSize: 10, color: "#55576a" }}>Mixer IA · BPM Detection · Automix</div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
            {bpmDiff !== null && (
              <span style={{ fontSize: 9, color: "#55576a" }}>
                Δ BPM <span style={{ color: bpmDiff < 5 ? "#c8f044" : bpmDiff < 15 ? "#ffaa00" : "#ff4444", fontWeight: 600 }}>{bpmDiff}</span>
              </span>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: automixRunning ? "#f59e0b" : "#c8f044", boxShadow: `0 0 8px ${automixRunning ? "#f59e0b" : "#c8f044"}`, animation: "pulse 2s infinite" }} />
              <span style={{ fontSize: 9, color: automixRunning ? "#f59e0b" : "#c8f044", letterSpacing: "2px" }}>{automixRunning ? "AUTOMIX" : "AI ONLINE"}</span>
            </div>
          </div>
        </header>

        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 310px", gap: 12, paddingBottom: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Deck id="A" engine={engine} crossfade={crossfade} onDeckInfo={handleDeckInfo}
                extEQ={extOverrides.A.eq} extReverb={extOverrides.A.reverb} extDelay={extOverrides.A.delay} />
              <Deck id="B" engine={engine} crossfade={crossfade} onDeckInfo={handleDeckInfo}
                extEQ={extOverrides.B.eq} extReverb={extOverrides.B.reverb} extDelay={extOverrides.B.delay} />
            </div>
            <Crossfader value={crossfade} onChange={handleCrossfade} />
          </div>

          <AIPanel
            decksInfo={decksInfo} crossfade={crossfade}
            onApply={handleApply} onAutomix={handleAutomix}
            automixRunning={automixRunning} automixPhase={automixPhase}
            automixProgress={automixProgress} onStopAutomix={stopAutomix}
          />
        </div>
      </div>
    </div>
  );
}
