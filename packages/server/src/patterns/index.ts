/**
 * Pattern engine: typed rules, specificity scoring, and microsecond rule matching.
 *
 * Status: **implemented and tested**.
 *
 * The safety check is advisory; it never prevents an agent from acting.
 */

export * from './types.js';
export * from './specificity.js';
export * from './matchers.js';
export * from './engine.js';
export * from './loader.js';
