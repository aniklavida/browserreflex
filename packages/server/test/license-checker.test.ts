import { describe, expect, it } from 'vitest';
import {
  isLicenseAllowed,
  validatePackageList,
  runCheck,
} from '../../../scripts/check-licenses.mjs';

describe('license compliance checker', () => {
  it('allows approved open-source licenses', () => {
    expect(isLicenseAllowed('MIT')).toBe(true);
    expect(isLicenseAllowed('Apache-2.0')).toBe(true);
    expect(isLicenseAllowed('BSD-2-Clause')).toBe(true);
    expect(isLicenseAllowed('BSD-3-Clause')).toBe(true);
    expect(isLicenseAllowed('ISC')).toBe(true);
    expect(isLicenseAllowed('(MIT OR Apache-2.0)')).toBe(true);
  });

  it('rejects copyleft and non-approved licenses', () => {
    expect(isLicenseAllowed('GPL-3.0-only')).toBe(false);
    expect(isLicenseAllowed('AGPL-3.0')).toBe(false);
    expect(isLicenseAllowed('SSPL-1.0')).toBe(false);
    expect(isLicenseAllowed('BSL-1.1')).toBe(false);
    expect(isLicenseAllowed('Proprietary')).toBe(false);
    expect(isLicenseAllowed('')).toBe(false);
  });

  it('detects violations in package lists', () => {
    const { checked, violations } = validatePackageList([
      { name: 'good-lib', version: '1.0.0', license: 'MIT' },
      { name: 'bad-lib', version: '2.0.0', license: 'GPL-3.0' },
    ]);

    expect(checked).toHaveLength(2);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.name).toBe('bad-lib');
    expect(violations[0]?.license).toBe('GPL-3.0');
  });

  it('rejects packages from fixture file', () => {
    const result = runCheck(['--fixture', 'scripts/fixtures/rejected-license.json']);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
