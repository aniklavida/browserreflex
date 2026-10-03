import { describe, expect, it } from 'vitest';
import { isSafetyAdvisory, SCAFFOLD_STATUS } from '../src/index.js';

describe('server scaffold', () => {
  it('confirms the safety check is advisory', () => {
    expect(isSafetyAdvisory()).toBe(true);
  });

  it('declares valid scaffold status claim', () => {
    expect(SCAFFOLD_STATUS).toBe('implemented and tested');
  });
});
