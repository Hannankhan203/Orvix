import React, { useState, useEffect, useRef } from 'react';
import { Timer } from 'lucide-react';
import { formatLiveElapsed } from '../../utils/formatResponseTime.js';

/**
 * Helper to get current timestamp aligned with the origin of startTime.
 * If startTime > 1e11 (epoch ms, Date.now()), returns Date.now().
 * Otherwise returns performance.now() (or Date.now() if performance is unavailable).
 */
function getNow(startTime) {
  const isEpoch = typeof startTime === 'number' && startTime > 1e11;
  return isEpoch
    ? Date.now()
    : typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

/**
 * Calculates remaining milliseconds until the next whole-second rollover,
 * ensuring timer updates land directly on second boundaries without drift.
 */
function getMsUntilNextSecond(startTime) {
  const elapsedMs = Math.max(0, getNow(startTime) - startTime);
  const remaining = 1000 - (elapsedMs % 1000);
  // Ensure at least a small positive delay (minimum 25ms) to prevent busy-looping
  return Math.max(25, remaining);
}

/**
 * LiveResponseTimer Component (ORVIX-006 Optimized)
 *
 * Performance-optimized, self-contained live timer badge for active streaming responses.
 *
 * Optimizations:
 * 1. Second-boundary aligned timeout scheduling instead of blind 100ms/250ms polling:
 *    Because the displayed format is whole seconds (mm:ss), scheduling updates to trigger
 *    at the precise whole-second transition reduces timer executions by ~90% (from 10Hz to 1Hz)
 *    while maintaining 100% timestamp accuracy without drift.
 * 2. Redundant React state update prevention:
 *    Tracks last rendered text in a ref and only dispatches React state updates when the
 *    formatted text actually changes.
 * 3. React.memo isolation:
 *    Wrapped in React.memo so parent ChatMessage streaming re-renders do not re-render
 *    LiveResponseTimer unless its props (startTime, isLocalGpu) change.
 *    Conversely, state updates inside LiveResponseTimer only re-render this isolated badge.
 * 4. Resilient lifecycle & cleanup:
 *    Immediately clears pending timeouts on unmount, response completion, or startTime change.
 */
function LiveResponseTimer({ startTime, isLocalGpu = false }) {
  const [elapsedText, setElapsedText] = useState(() => formatLiveElapsed(startTime));
  const lastTextRef = useRef(elapsedText);
  const timeoutRef = useRef(null);

  useEffect(() => {
    if (typeof startTime !== 'number' || startTime <= 0) return;

    // Synchronize initial text if startTime changed while mounted
    const initialText = formatLiveElapsed(startTime);
    if (initialText !== lastTextRef.current) {
      lastTextRef.current = initialText;
      setElapsedText(initialText);
    }

    let isMounted = true;

    const scheduleTick = () => {
      const delay = getMsUntilNextSecond(startTime);

      timeoutRef.current = setTimeout(() => {
        if (!isMounted) return;

        const next = formatLiveElapsed(startTime);
        if (next !== lastTextRef.current) {
          lastTextRef.current = next;
          setElapsedText(next);
        }

        scheduleTick();
      }, delay);
    };

    scheduleTick();

    return () => {
      isMounted = false;
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
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

export default React.memo(LiveResponseTimer);

