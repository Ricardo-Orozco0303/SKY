import { useRef, useCallback } from 'react';

export function useAudioEngine() {
  const ctxRef = useRef(null);
  const decksRef = useRef({});

  function getCtx() {
    if (typeof window === 'undefined') return null;

    if (!ctxRef.current) {
      ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (ctxRef.current.state === 'suspended') {
      ctxRef.current.resume();
    }

    return ctxRef.current;
  }

  async function createReverbIR(ctx, duration = 2) {
    const sr = ctx.sampleRate;
    const len = sr * duration;
    const buf = ctx.createBuffer(2, len, sr);

    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
      }
    }

    return buf;
  }

  const loadTrack = useCallback(async (deckId, file) => {
    const ctx = getCtx();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    const existing = decksRef.current[deckId];

    if (existing?.source) {
      try {
        existing.source.stop();
      } catch (_) {}
    }

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

    const convolver = ctx.createConvolver();
    createReverbIR(ctx).then((ir) => {
      convolver.buffer = ir;
    });

    const reverbGain = ctx.createGain();
    reverbGain.gain.value = 0;

    const dryGain = ctx.createGain();
    dryGain.gain.value = 1;

    const delay = ctx.createDelay(2);
    const delayWet = ctx.createGain();
    const delayFeedback = ctx.createGain();

    delayWet.gain.value = 0;
    delayFeedback.gain.value = 0;
    delay.delayTime.value = 0.32;

    const channelGain = ctx.createGain();
    channelGain.gain.value = 1;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    low.connect(mid);
    mid.connect(high);

    high.connect(dryGain);
    dryGain.connect(channelGain);

    high.connect(reverbGain);
    reverbGain.connect(convolver);
    convolver.connect(channelGain);

    high.connect(delayWet);
    delayWet.connect(delay);
    delay.connect(delayFeedback);
    delayFeedback.connect(delay);
    delay.connect(channelGain);

    channelGain.connect(analyser);
    analyser.connect(ctx.destination);

    decksRef.current[deckId] = {
      audioBuffer,
      source: null,
      low,
      mid,
      high,
      reverbGain,
      dryGain,
      delayWet,
      delayFeedback,
      channelGain,
      analyser,
      startTime: 0,
      offset: 0,
      isPlaying: false,
      duration: audioBuffer.duration,
    };

    return {
      duration: audioBuffer.duration,
    };
  }, []);

  const play = useCallback((deckId) => {
    const ctx = getCtx();
    const deck = decksRef.current[deckId];

    if (!deck || deck.isPlaying) return;

    if (deck.offset >= deck.duration) {
      deck.offset = 0;
    }

    const source = ctx.createBufferSource();
    source.buffer = deck.audioBuffer;
    source.connect(deck.low);

    const fade = 0.08;
    deck.channelGain.gain.cancelScheduledValues(ctx.currentTime);
    deck.channelGain.gain.setValueAtTime(0, ctx.currentTime);
    deck.channelGain.gain.linearRampToValueAtTime(1, ctx.currentTime + fade);

    source.start(0, deck.offset);

    deck.source = source;
    deck.startTime = ctx.currentTime;
    deck.isPlaying = true;

    source.onended = () => {
      if (!deck.isPlaying) return;

      deck.isPlaying = false;
      deck.offset = 0;
      deck.source = null;
    };
  }, []);

  const pause = useCallback((deckId) => {
    const ctx = getCtx();
    const deck = decksRef.current[deckId];

    if (!deck || !deck.isPlaying) return;

    deck.offset += ctx.currentTime - deck.startTime;

    try {
      deck.channelGain.gain.cancelScheduledValues(ctx.currentTime);
      deck.channelGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.05);
      setTimeout(() => {
        try {
          deck.source?.stop();
        } catch (_) {}
      }, 60);
    } catch (_) {}

    deck.isPlaying = false;
  }, []);

  const seek = useCallback((deckId, time) => {
    const deck = decksRef.current[deckId];
    if (!deck) return;

    const safeTime = Math.max(0, Math.min(time, deck.duration));
    const wasPlaying = deck.isPlaying;

    if (wasPlaying) {
      try {
        deck.source?.stop();
      } catch (_) {}
      deck.isPlaying = false;
    }

    deck.offset = safeTime;

    if (wasPlaying) {
      setTimeout(() => play(deckId), 10);
    }
  }, [play]);

  const getCurrentTime = useCallback((deckId) => {
    const deck = decksRef.current[deckId];
    const ctx = ctxRef.current;

    if (!deck) return 0;

    if (!deck.isPlaying) {
      return deck.offset;
    }

    const current = deck.offset + (ctx.currentTime - deck.startTime);

    if (current >= deck.duration) {
      deck.isPlaying = false;
      deck.offset = 0;
      return deck.duration;
    }

    return current;
  }, []);

  const setEQ = useCallback((deckId, band, gainDb) => {
    const deck = decksRef.current[deckId];
    if (deck?.[band]) {
      deck[band].gain.value = gainDb;
    }
  }, []);

  const setReverb = useCallback((deckId, wet) => {
    const deck = decksRef.current[deckId];
    if (!deck) return;

    deck.reverbGain.gain.value = wet;
    deck.dryGain.gain.value = 1 - wet * 0.4;
  }, []);

  const setDelay = useCallback((deckId, wet) => {
    const deck = decksRef.current[deckId];
    if (!deck) return;

    deck.delayWet.gain.value = wet;
    deck.delayFeedback.gain.value = wet * 0.45;
  }, []);

  const setCrossfader = useCallback((value) => {
    const deckA = decksRef.current.A;
    const deckB = decksRef.current.B;

    if (deckA) {
      deckA.channelGain.gain.value = Math.cos(value * Math.PI * 0.5);
    }

    if (deckB) {
      deckB.channelGain.gain.value = Math.cos((1 - value) * Math.PI * 0.5);
    }
  }, []);

  const getAnalyser = useCallback((deckId) => {
    return decksRef.current[deckId]?.analyser || null;
  }, []);

  return {
    loadTrack,
    play,
    pause,
    seek,
    getCurrentTime,
    setEQ,
    setReverb,
    setDelay,
    setCrossfader,
    getAnalyser,
  };
}
