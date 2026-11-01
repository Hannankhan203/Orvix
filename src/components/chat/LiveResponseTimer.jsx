import React, { useState, useEffect } from 'react';
import { Timer } from 'lucide-react';
import { formatLiveElapsed } from '../../utils/formatResponseTime.js';

/**
 * LiveResponseTimer Component
 * Lightweight, self-contained live timer that updates every 100ms (or 250ms for local GPU)
 * while AI generation is actively running.
 * Only re-renders this tiny badge component, avoiding chat message re-renders.
 */
export default function LiveResponseTimer({ startTime, isLocalGpu = false }) {
  const [elapsedText, setElapsedText] = useState(() => formatLiveElapsed(startTime));

  useEffect(() => {
    if (typeof startTime !== 'number' || startTime <= 0) return;

    const updateTimer = () => {
      const next = formatLiveElapsed(startTime);
      setElapsedText((prev) => (prev === next ? prev : next));
    };

    updateTimer();
    const intervalMs = isLocalGpu ? 250 : 100;
    const intervalId = setInterval(updateTimer, intervalMs);

    return () => clearInterval(intervalId);
  }, [startTime, isLocalGpu]);

  return (
    <span
      className="response-time-badge live"
      title={`Thinking... ${elapsedText}`}
      aria-label={`Thinking... ${elapsedText}`}
    >
      <Timer size={11} className="response-time-icon" aria-hidden="true" />
      <span>Thinking... {elapsedText}</span>
    </span>
  );
}
