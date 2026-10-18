import React from 'react';

/**
 * OrvixLogo Component
 * Renders the official Orvix vector application mark:
 * - Royal blue gradient squircle base with ambient top sheen
 * - Precision-crafted Orvix robot bot glyph with glowing antenna, visor, and eyes
 * - Ambient 4-point AI sparkle in the top-right
 * - Fully scalable (default: 24px) with high-DPI crispness and accessibility
 *
 * @param {Object} props
 * @param {number|string} [props.size=24] - Width and height in pixels
 * @param {string} [props.className=''] - Extra CSS classes
 * @param {boolean} [props.showText=false] - If true, renders "Orvix" brand text alongside
 * @param {string} [props.textClassName=''] - Optional typography class
 */
export default function OrvixLogo({
  size = 24,
  className = '',
  showText = false,
  textClassName = ''
}) {
  const pixelSize = typeof size === 'number' ? `${size}px` : size;

  return (
    <div
      className={`inline-flex items-center gap-2 select-none ${className}`}
      style={{ verticalAlign: 'middle' }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 512 512"
        width={pixelSize}
        height={pixelSize}
        className="flex-shrink-0 transition-transform duration-200 hover:scale-105"
        style={{ width: pixelSize, height: pixelSize }}
        role="img"
        aria-label="Orvix Logo"
      >
        <defs>
          <linearGradient id="orvixBrandBg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#3b82f6" />
            <stop offset="50%" stopColor="#2563eb" />
            <stop offset="100%" stopColor="#1d4ed8" />
          </linearGradient>

          <linearGradient id="orvixBrandHighlight" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.32" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>

          <linearGradient id="orvixBotFace" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#e2e8f0" />
          </linearGradient>

          <filter id="orvixShadow" x="-10%" y="-10%" width="120%" height="125%" filterUnits="userSpaceOnUse">
            <feDropShadow dx="0" dy="12" stdDeviation="14" floodColor="#0b1329" floodOpacity="0.4" />
          </filter>
        </defs>

        {/* Base Squircle Canvas */}
        <rect
          x="24"
          y="24"
          width="464"
          height="464"
          rx="116"
          ry="116"
          fill="url(#orvixBrandBg)"
          filter="url(#orvixShadow)"
        />

        {/* Top Surface Sheen */}
        <rect
          x="24"
          y="24"
          width="464"
          height="232"
          rx="116"
          ry="116"
          fill="url(#orvixBrandHighlight)"
        />

        {/* Outer Accent Stroke */}
        <rect
          x="24"
          y="24"
          width="464"
          height="464"
          rx="116"
          ry="116"
          fill="none"
          stroke="#60a5fa"
          strokeWidth="4"
          strokeOpacity="0.4"
        />

        {/* Robot Glyph */}
        <g id="orvix-bot-mark">
          {/* Antenna */}
          <path d="M 256 180 L 256 122" stroke="#ffffff" strokeWidth="22" strokeLinecap="round" />
          <circle cx="256" cy="106" r="26" fill="#ffffff" />
          <circle cx="256" cy="106" r="14" fill="#60a5fa" />

          {/* Left & Right Ear Nodes */}
          <rect x="76" y="260" width="32" height="64" rx="14" fill="#93c5fd" />
          <rect x="404" y="260" width="32" height="64" rx="14" fill="#93c5fd" />

          {/* Robot Head Frame */}
          <rect x="98" y="176" width="316" height="232" rx="48" fill="url(#orvixBotFace)" />

          {/* Screen Visor Display Area */}
          <rect x="130" y="212" width="252" height="136" rx="28" fill="#0f172a" />

          {/* Glowing Expressive Eyes */}
          <circle cx="196" cy="272" r="24" fill="#38bdf8" />
          <circle cx="196" cy="272" r="14" fill="#ffffff" />

          <circle cx="316" cy="272" r="24" fill="#38bdf8" />
          <circle cx="316" cy="272" r="14" fill="#ffffff" />

          {/* Friendly Smile Wave */}
          <path
            d="M 216 368 Q 256 388 296 368"
            fill="none"
            stroke="#2563eb"
            strokeWidth="12"
            strokeLinecap="round"
          />

          {/* Ambient AI Sparkle Star (Top-Right Accent) */}
          <path
            d="M 390 82 Q 390 106 370 106 Q 390 106 390 130 Q 390 106 410 106 Q 390 106 390 82 Z"
            fill="#ffffff"
            opacity="0.95"
          />
        </g>
      </svg>

      {showText && (
        <span
          className={`font-semibold tracking-tight text-white ${textClassName}`}
          style={{ letterSpacing: '-0.02em' }}
        >
          Orvix
        </span>
      )}
    </div>
  );
}
