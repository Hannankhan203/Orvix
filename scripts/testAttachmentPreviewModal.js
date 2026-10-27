/**
 * Attachment Preview Modal Validation Suite
 * Verifies component contracts, responsive layout rules, long filename handling,
 * supported file types (images, PDFs, documents), download & copy behavior,
 * and design system token conformance.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

console.log('=== Starting Attachment Preview Modal Verification Suite ===\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(err);
    failed++;
  }
}

// 1. Inspect DocumentPreviewModal.jsx contents
const modalFile = fs.readFileSync(path.resolve('src/components/chat/DocumentPreviewModal.jsx'), 'utf-8');
const stylesFile = fs.readFileSync(path.resolve('src/styles/index.css'), 'utf-8');

test('DocumentPreviewModal handles long filenames safely with multiple fallback properties', () => {
  assert(modalFile.includes("attachment?.name || attachment?.originalName || attachment?.filename || 'Document'"),
    'Must check name, originalName, and filename with fallback');
  assert(modalFile.includes('title={filename}'),
    'Must provide full filename in title attribute for browser tooltip on hover');
  assert(modalFile.includes('id="preview-modal-title"'),
    'Must provide id for accessibility aria-labelledby binding');
});

test('DocumentPreviewModal computes clean format badges and meta details', () => {
  assert(modalFile.includes('getModalFormatBadgeClass'),
    'Must map format extension to color accent badges');
  assert(modalFile.includes('formatBadgeClass'),
    'Must apply format badge class to icon badge');
  assert(modalFile.includes('preview-modal-ext-pill'),
    'Must render extension pill');
  assert(modalFile.includes('metaDetail'),
    'Must support page count or slide count in metadata');
});

test('DocumentPreviewModal preserves image and OCR tab viewing modes', () => {
  assert(modalFile.includes("role=\"tab\""),
    'Must provide ARIA tab role');
  assert(modalFile.includes("activeView === 'image'"),
    'Must support image active view');
  assert(modalFile.includes("activeView === 'ocr'"),
    'Must support ocr text active view');
  assert(modalFile.includes('preview-image-viewport'),
    'Must wrap image in dedicated viewport with aspect ratio preservation');
  assert(modalFile.includes('preview-image-element'),
    'Must style image element with object-contain and max bounds');
});

test('DocumentPreviewModal preserves PDF iframe rendering and error fallbacks', () => {
  assert(modalFile.includes('preview-pdf-container'),
    'Must wrap PDF in responsive container');
  assert(modalFile.includes('preview-pdf-frame'),
    'Must render iframe with preview-pdf-frame class');
  assert(modalFile.includes('preview-office-notice'),
    'Must display informative notice for extracted office documents');
});

test('DocumentPreviewModal preserves download and copy text actions', () => {
  assert(modalFile.includes('handleDownloadOriginal'),
    'Must include handleDownloadOriginal function');
  assert(modalFile.includes('downloadAttachmentFile(attachment)'),
    'Must invoke downloadAttachmentFile with original attachment');
  assert(modalFile.includes('handleCopyText'),
    'Must include handleCopyText function');
  assert(modalFile.includes('navigator.clipboard?.writeText'),
    'Must copy text to clipboard safely');
});

test('DocumentPreviewModal preserves Escape key, focus management, and backdrop click', () => {
  assert(modalFile.includes("e.key === 'Escape'"),
    'Must close on Escape key');
  assert(modalFile.includes('closeBtnRef.current?.focus()'),
    'Must focus close button on open');
  assert(modalFile.includes('e.stopPropagation()'),
    'Must stop click propagation on modal card');
  assert(modalFile.includes('onClick={onClose}'),
    'Must trigger onClose on overlay click');
});

test('Stylesheet defines base responsive and theme rules for modal layout', () => {
  assert(stylesFile.includes('.document-preview-overlay'), 'Must define overlay class');
  assert(stylesFile.includes('.document-preview-modal'), 'Must define modal container');
  assert(stylesFile.includes('.preview-modal-header'), 'Must define modal header');
  assert(stylesFile.includes('.preview-modal-title'), 'Must define title styling with truncation');
  assert(stylesFile.includes('text-overflow: ellipsis;'), 'Must truncate title text with ellipsis');
  assert(stylesFile.includes('.preview-modal-icon-badge'), 'Must define icon badge');
  assert(stylesFile.includes('.preview-modal-ext-pill'), 'Must define extension pill');
  assert(stylesFile.includes('.preview-image-viewport'), 'Must define image viewport');
  assert(stylesFile.includes('.preview-image-element'), 'Must define image element aspect ratio rules');
  assert(stylesFile.includes('.preview-pdf-frame'), 'Must define PDF frame rules');
  assert(stylesFile.includes('.preview-text-content'), 'Must define code/text content area');
  assert(stylesFile.includes('.preview-ocr-stats-bar'), 'Must define OCR stats bar');
  assert(stylesFile.includes('.preview-download-btn'), 'Must define download button');
  assert(stylesFile.includes('.preview-close-btn'), 'Must define close button');
});

test('Stylesheet defines light mode theme overrides for document preview modal', () => {
  assert(stylesFile.includes('[data-theme="light"] .document-preview-modal'),
    'Must define light theme modal background');
  assert(stylesFile.includes('[data-theme="light"] .preview-modal-header'),
    'Must define light theme header background');
  assert(stylesFile.includes('[data-theme="light"] .preview-modal-title'),
    'Must define light theme title text color');
  assert(stylesFile.includes('[data-theme="light"] .preview-text-content'),
    'Must define light theme text content surface');
});

test('Stylesheet defines mobile max-width: 768px layout rules', () => {
  const mobileSection = stylesFile.slice(stylesFile.indexOf('/* Document Preview Modal on Mobile */'), stylesFile.indexOf('/* Document Preview Modal on Mobile */') + 2500);
  assert(mobileSection.includes('.preview-modal-desktop-controls'), 'Must hide desktop controls on mobile');
  assert(mobileSection.includes('.preview-modal-mobile-toolbar'), 'Must display mobile toolbar');
  assert(mobileSection.includes('min-height: 36px'), 'Must provide touch-friendly control heights');
  assert(mobileSection.includes('text-overflow: ellipsis !important'), 'Must enforce single-line truncation on mobile');
});

console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) {
  process.exit(1);
}
