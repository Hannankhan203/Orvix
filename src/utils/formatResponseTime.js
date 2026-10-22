/**
 * Formats an elapsed duration in milliseconds into a concise, human-readable
 * response time indicator string.
 *
 * Formatting rules:
 * - Under 60 seconds: seconds with one decimal point (e.g. 0.8s, 1.2s, 4.8s, 12.6s)
 * - 60 seconds to under 1 hour: minutes and seconds (e.g. 1m 8s, 2m 15s)
 * - 1 hour or more: hours, minutes, and seconds (e.g. 1h 2m 5s)
 *
 * @param {number|null|undefined} ms - Duration in milliseconds
 * @returns {string|null} Formatted duration or null if invalid
 */
export function formatResponseTime(ms) {
  if (typeof ms !== 'number' || isNaN(ms) || ms <= 0) {
    return null;
  }

  // Normalize: if a duration in fractional seconds is supplied (< 100 with decimals or <= 60),
  // convert to milliseconds so 8.7s is never miscalculated as 8.7ms.
  let durationMs = ms;
  if (ms > 0 && ms < 60 && !Number.isInteger(ms)) {
    durationMs = ms * 1000;
  }

  // Under 60 seconds: format as seconds with one decimal place (e.g. 0.1s, 0.8s, 2.4s, 8.7s, 10.2s)
  if (durationMs < 60000) {
    const sec = durationMs / 1000;
    const rounded = Math.max(0.1, Math.round(sec * 10) / 10);
    return `${rounded.toFixed(1)}s`;
  }

  // 1 minute to 59 minutes: format as minutes and seconds (e.g. "1m 04s", "1m 08s", "2m 15s")
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  const secPadded = remainingSeconds < 10 ? `0${remainingSeconds}` : `${remainingSeconds}`;

  if (minutes < 60) {
    return `${minutes}m ${secPadded}s`;
  }

  // 1 hour or more
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const minPadded = remainingMinutes < 10 ? `0${remainingMinutes}` : `${remainingMinutes}`;
  return `${hours}h ${minPadded}m ${secPadded}s`;
}
