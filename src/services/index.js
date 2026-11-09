/**
 * Orvix Services Module
 * Unified service registry exporting AI routing, provider integrations, and document services.
 */

export const ServiceRegistry = {
  version: '1.0.0',
  isInitialized: true
};

export * from './aiRouter.js';
export * from './documentContextService.js';
export * from './alternativeResponseService.js';
export * from './providerModelSanitizer.js';
export * from './transcriptionService.js';
export * from './browserDocumentExtractor.js';
export * from './errorNormalizationService.js';
export * from './attachmentStorageService.js';
export * from './authService.js';
export * from './semanticChunkingService.js';
export * from './semanticEmbeddingService.js';
export * from './semanticVectorStorage.js';
export * from './semanticRetrievalService.js';


