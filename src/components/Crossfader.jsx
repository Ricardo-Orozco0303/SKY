export default function Crossfader({ value, onChange }) {
  return (
    <div className="crossfader-section">
      <div className="crossfader-labels">
        <span style={{ color: '#3b82f6', opacity: value < 0.5 ? 1 : 0.4 }}>A</span>
        <span className="crossfader-title">CROSSFADER</span>
        <span style={{ color: '#f59e0b', opacity: value > 0.5 ? 1 : 0.4 }}>B</span>
      </div>
      <div className="crossfader-track">
        <input
          type="range"
          min="0" max="1" step="0.01"
          value={value}
          onChange={e => onChange(parseFloat(e.target.value))}
          className="crossfader-input"
        />
      </div>
      <div className="crossfader-meter">
        <div
          className="cf-bar-a"
          style={{ width: `${Math.round((1 - value) * 100)}%` }}
        />
        <div
          className="cf-bar-b"
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </div>
    </div>
  );
}
