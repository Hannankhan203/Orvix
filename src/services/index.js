/**
 * Orvix Services Module
 * Unified service registry exporting AI routing, provider integrations, and document services.
 */

export const ServiceRegistry = {
  version: '1.0.0',
  isInitialized: true
};

export * from './aiRouter.js';
export * from './geminiService.js';
export * from './groqService.js';
export * from './openrouterService.js';
export * from './documentContextService.js';
