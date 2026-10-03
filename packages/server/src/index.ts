/**
 * BrowserReflex server entry point and scaffold helpers.
 *
 * Core claims and invariants:
 * - The safety check is advisory; it never prevents an agent from acting.
 * - Claims use the four permitted states: implemented and tested, experimental, planned, unsupported.
 */

export const SCAFFOLD_STATUS = 'implemented and tested';

/**
 * Returns true indicating that the safety check is advisory.
 * Per docs/SPEC.md and docs/ARCHITECTURE.md, safety checks provide advisory signals
 * and do not enforce host-level prevention.
 */
export function isSafetyAdvisory(): boolean {
  return true;
}

export * from './core/schema.js';
