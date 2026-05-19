import { useRef, useCallback } from 'react';

export function useAudioEngine() {
  const ctxRef = useRef(null);
  const decksRef = useRef({});

  function getCtx() {
    if (!ctxRef.current) {
      ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctxRef.current.state === 'suspended') {
      ctxRef.current.resume();
    }
    return ctxRef.current;
  }

  async function createReverbIR(ctx, duration = 2.5) {
    const sr = ctx.sampleRate;
    const len = sr * duration;
    const buf = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
      }
    }
    return buf;
  }

  const loadTrack = useCallback(async (deckId, file) => {
    const ctx = getCtx();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    if (decksRef.current[deckId]?.source) {
      try { decksRef.current[deckId].source.stop(); } catch (_) {}
    }

    // EQ nodes
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 320;

    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value = 0.7;

    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 3200;

    // Reverb
    const convolver = ctx.createConvolver();
    createReverbIR(ctx).then(ir => { convolver.buffer = ir; });
    const reverbGain = ctx.createGain();
    reverbGain.gain.value = 0;
    const dryGain = ctx.createGain();
    dryGain.gain.value = 1;

    // Delay
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.375;
    const delayFeedback = ctx.createGain();
    delayFeedback.gain.value = 0;
    const delayWet = ctx.createGain();
    delayWet.gain.value = 0;

    // Channel gain (for crossfader)
    const channelGain = ctx.createGain();
    channelGain.gain.value = 1;

    // Analyser for waveform visualization
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    // Chain: source → low → mid → high → dryGain → channelGain → analyser → destination
    //                                              → reverbGain → convolver → channelGain
    //                                              → delayWet → delay → delayFeedback (loop) → channelGain

    low.connect(mid);
    mid.connect(high);
    high.connect(dryGain);
    high.connect(reverbGain);
    high.connect(delayWet);

    dryGain.connect(channelGain);
    reverbGain.connect(convolver);
    convolver.connect(channelGain);

    delayWet.connect(delay);
    delay.connect(delayFeedback);
    delayFeedback.connect(delay);
    delay.connect(channelGain);

    channelGain.connect(analyser);
    analyser.connect(ctx.destination);

    decksRef.current[deckId] = {
      audioBuffer,
      source: null,
      low, mid, high,
      reverbGain, dryGain,
      delay, delayFeedback, delayWet,
      channelGain,
      analyser,
      startTime: 0,
      offset: 0,
      isPlaying: false,
      fadeDuration: 0.45,
    };

    return { duration: audioBuffer.duration };
  }, []);

  const play = useCallback((deckId) => {
    const ctx = getCtx();
    const deck = decksRef.current[deckId];
    if (!deck || deck.isPlaying) return;

    const source = ctx.createBufferSource();
    source.buffer = deck.audioBuffer;
    source.connect(deck.low);

    deck.channelGain.gain.cancelScheduledValues(ctx.currentTime);
    deck.channelGain.gain.setValueAtTime(0, ctx.currentTime);
    deck.channelGain.gain.linearRampToValueAtTime(1, ctx.currentTime + deck.fadeDuration);

    source.start(0, deck.offset);

    deck.source = source;
    deck.startTime = ctx.currentTime;
    deck.isPlaying = true;

    source.onended = () => {
      if (deck.isPlaying) deck.isPlaying = false;
    };
  }, []);

  const pause = useCallback((deckId) => {
    const ctx = getCtx();
    const deck = decksRef.current[deckId];
    if (!deck || !deck.isPlaying) return;

    deck.offset += ctx.currentTime - deck.startTime;

    deck.channelGain.gain.cancelScheduledValues(ctx.currentTime);
    deck.channelGain.gain.setValueAtTime(deck.channelGain.gain.value, ctx.currentTime);
    deck.channelGain.gain.linearRampToValueAtTime(0, ctx.currentTime + deck.fadeDuration);

    setTimeout(() => {
      try { deck.source.stop(); } catch (_) {}
    }, deck.fadeDuration * 1000);

    deck.isPlaying = false;
  }, []);

  const seek = useCallback((deckId, time) => {
    const deck = decksRef.current[deckId];
    if (!deck) return;
    const wasPlaying = deck.isPlaying;
    if (wasPlaying) pause(deckId);
    deck.offset = time;
    if (wasPlaying) play(deckId);
  }, [play, pause]);

  const getCurrentTime = useCallback((deckId) => {
    const ctx = ctxRef.current;
    const deck = decksRef.current[deckId];
    if (!deck) return 0;
    if (!deck.isPlaying) return deck.offset;
    return deck.offset + (ctx.currentTime - deck.startTime);
  }, []);

  const setEQ = useCallback((deckId, band, gainDb) => {
    const deck = decksRef.current[deckId];
    if (!deck) return;
    deck[band].gain.value = gainDb;
  }, []);

  const setReverb = useCallback((deckId, wet) => {
    const deck = decksRef.current[deckId];
    if (!deck) return;
    deck.reverbGain.gain.value = wet;
    deck.dryGain.gain.value = 1 - wet * 0.5;
  }, []);

  const setDelay = useCallback((deckId, wet) => {
    const deck = decksRef.current[deckId];
    if (!deck) return;
    deck.delayWet.gain.value = wet;
    deck.delayFeedback.gain.value = wet * 0.5;
  }, []);

  const setCrossfader = useCallback((value) => {
    // value: 0 = full deck A, 1 = full deck B
    const deckA = decksRef.current['A'];
    const deckB = decksRef.current['B'];
    const ctx = getCtx();
    if (deckA) {
      deckA.channelGain.gain.linearRampToValueAtTime(Math.cos(value * Math.PI / 2), ctx.currentTime + 0.08);
    }
    if (deckB) {
      deckB.channelGain.gain.linearRampToValueAtTime(Math.cos((1 - value) * Math.PI / 2), ctx.currentTime + 0.08);
    }
  }, []);

  const getAnalyser = useCallback((deckId) => {
    return decksRef.current[deckId]?.analyser || null;
  }, []);

  return { loadTrack, play, pause, seek, getCurrentTime, setEQ, setReverb, setDelay, setCrossfader, getAnalyser };
}
