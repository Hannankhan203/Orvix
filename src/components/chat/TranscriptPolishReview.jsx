import React from 'react';
import { Sparkles, Loader2, X, Check } from 'lucide-react';
import Button from '../ui/Button.jsx';

/**
 * TranscriptPolishReview Component
 * Displays the optional AI transcript refinement offer banner and the side-by-side
 * review/comparison card for accepting or rejecting polished speech text.
 */
export default function TranscriptPolishReview({
  lastSessionTranscript,
  suggestedRefinement,
  isCleaningTranscript = false,
  onImproveTranscript,
  onApplyRefinement,
  onDismissReview,
  onDismissTranscript
}) {
  return (
    <>
      {/* Optional AI Transcript Refinement Notification */}
      {lastSessionTranscript && !suggestedRefinement && (
        <div className="transcript-cleanup-banner" role="region" aria-label="Transcript helper">
          <div className="cleanup-banner-left">
            <Sparkles size={13} className="cleanup-icon" />
            <span className="cleanup-hint">Dictated speech:</span>
            <span className="cleanup-snippet">
              "{lastSessionTranscript.length > 52 ? lastSessionTranscript.slice(0, 52) + '...' : lastSessionTranscript}"
            </span>
          </div>
          <div className="cleanup-banner-actions">
            <button
              type="button"
              className="cleanup-action-trigger"
              onClick={onImproveTranscript}
              disabled={isCleaningTranscript}
              title="Polish punctuation and capitalization without changing words"
            >
              {isCleaningTranscript ? (
                <Loader2 size={12} className="spin-icon" />
              ) : (
                <Sparkles size={12} />
              )}
              <span>{isCleaningTranscript ? 'Polishing...' : 'Polish text'}</span>
            </button>
            <button
              type="button"
              className="cleanup-dismiss-btn"
              onClick={onDismissTranscript}
              title="Dismiss helper"
              aria-label="Dismiss transcript helper"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* AI Refinement Comparison Card */}
      {suggestedRefinement && (
        <div className="transcript-review-card" role="dialog" aria-labelledby="review-card-title">
          <div className="review-card-header">
            <div className="review-header-left">
              <Sparkles size={14} className="review-icon" />
              <span id="review-card-title" className="review-title">Review Transcript Polish</span>
            </div>
            <button
              type="button"
              className="review-close-btn"
              onClick={onDismissReview}
              aria-label="Close review"
            >
              <X size={14} />
            </button>
          </div>

          <div className="review-card-body">
            <div className="review-field">
              <span className="field-label">Original:</span>
              <p className="field-content original-text">{lastSessionTranscript}</p>
            </div>
            <div className="review-field">
              <span className="field-label">Suggested Polish:</span>
              <p className="field-content suggested-text">{suggestedRefinement}</p>
            </div>
          </div>

          <div className="review-card-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={onDismissReview}
            >
              Keep original
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={onApplyRefinement}
              icon={<Check size={13} />}
            >
              Apply Polish
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
