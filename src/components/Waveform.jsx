import { useEffect, useRef } from 'react';

export default function Waveform({ analyser, color = '#3b82f6', progress = 0, onClick }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const staticRef = useRef(null);

  // Draw static background waveform (procedural)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.offsetWidth || 600;
    const H = canvas.offsetHeight || 64;
    canvas.width = W;
    canvas.height = H;

    staticRef.current = { W, H };

    function drawStatic(prog) {
      ctx.clearRect(0, 0, W, H);
      const bars = Math.floor(W / 3);
      for (let i = 0; i < bars; i++) {
        const x = i * 3;
        const seed = Math.sin(i * 0.37) * Math.cos(i * 0.13) * 0.5 + 0.5;
        const h = (0.1 + seed * 0.8) * H;
        const y = (H - h) / 2;
        const played = x / W < prog;
        ctx.fillStyle = played ? color + 'e6' : color + '44';
        ctx.fillRect(x, y, 2, h);
      }
      // playhead line
      const px = prog * W;
      ctx.fillStyle = '#c8f044';
      ctx.fillRect(px - 1, 0, 2, H);
    }

    staticRef.current.draw = drawStatic;
    drawStatic(progress);
  }, [color]);

  // Redraw on progress change (no analyser)
  useEffect(() => {
    if (analyser) return;
    if (staticRef.current?.draw) {
      staticRef.current.draw(progress);
    }
  }, [progress, analyser]);

  // Live analyser animation
  useEffect(() => {
    if (!analyser) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const bufLen = analyser.frequencyBinCount;
    const dataArr = new Uint8Array(bufLen);

    function draw() {
      animRef.current = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(dataArr);
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      // Static bg
      if (staticRef.current?.draw) staticRef.current.draw(progress);

      // Live overlay
      ctx.beginPath();
      ctx.strokeStyle = '#c8f04488';
      ctx.lineWidth = 1.5;
      const sliceW = W / bufLen;
      let x = 0;
      for (let i = 0; i < bufLen; i++) {
        const v = dataArr[i] / 128.0;
        const y = (v * H) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceW;
      }
      ctx.stroke();
    }

    draw();
    return () => cancelAnimationFrame(animRef.current);
  }, [analyser, progress]);

  function handleClick(e) {
    if (!onClick) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    onClick(pct);
  }

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      style={{ width: '100%', height: '64px', display: 'block', cursor: 'crosshair' }}
    />
  );
}
