import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

export const ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
]);

/**
 * Checks whether a license identifier or expression is allowed.
 * Permitted licences: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC.
 */
export function isLicenseAllowed(license) {
  if (!license || typeof license !== 'string') return false;
  const clean = license.trim().replace(/[()]/g, '');

  if (ALLOWED_LICENSES.has(clean)) return true;

  if (clean.includes(' OR ')) {
    const parts = clean.split(' OR ').map((p) => p.trim());
    return parts.some((p) => ALLOWED_LICENSES.has(p));
  }

  if (clean.includes(' AND ')) {
    const parts = clean.split(' AND ').map((p) => p.trim());
    return parts.every((p) => ALLOWED_LICENSES.has(p));
  }

  return false;
}

/**
 * Validates a list of package items: [{ name, version, license }]
 */
export function validatePackageList(packages) {
  const violations = [];
  const checked = [];

  for (const pkg of packages) {
    const { name, version, license } = pkg;
    const allowed = isLicenseAllowed(license);
    checked.push({ name, version, license, allowed });
    if (!allowed) {
      violations.push({ name, version, license: license || 'UNKNOWN' });
    }
  }

  return { checked, violations };
}

/**
 * Validates a map of licenses as returned by `pnpm licenses list --json`:
 * { "MIT": [{ name, version, ... }], "GPL-3.0": [...] }
 */
export function validateLicenseMap(licenseMap) {
  const packages = [];

  for (const [license, pkgList] of Object.entries(licenseMap)) {
    if (Array.isArray(pkgList)) {
      for (const pkg of pkgList) {
        packages.push({
          name: pkg.name || 'unnamed',
          version: pkg.version || '0.0.0',
          license,
        });
      }
    }
  }

  return validatePackageList(packages);
}

/**
 * Runs the license check against a fixture file or the current pnpm workspace.
 */
export function runCheck(args = process.argv.slice(2)) {
  const allowedList = Array.from(ALLOWED_LICENSES).sort().join(', ');
  console.log(`Allowed production licences: ${allowedList}`);

  let fixturePath = null;
  const fixtureIndex = args.indexOf('--fixture');
  if (fixtureIndex !== -1 && args[fixtureIndex + 1]) {
    fixturePath = resolve(process.cwd(), args[fixtureIndex + 1]);
  }

  let packagesToCheck = [];

  if (fixturePath) {
    console.log(`Checking fixture: ${fixturePath}`);
    if (!existsSync(fixturePath)) {
      console.error(`Error: Fixture file not found: ${fixturePath}`);
      return { ok: false, exitCode: 1 };
    }

    const content = JSON.parse(readFileSync(fixturePath, 'utf8'));
    if (Array.isArray(content)) {
      packagesToCheck = content;
    } else if (typeof content === 'object' && content !== null) {
      return executeValidation(validateLicenseMap(content));
    }
    return executeValidation(validatePackageList(packagesToCheck));
  }

  console.log('Checking resolved production dependencies in workspace...');
  let rawJson = '{}';
  try {
    rawJson = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error('Failed to run `pnpm licenses list --prod --json`:', err.message);
    return { ok: false, exitCode: 1 };
  }

  let licenseMap = {};
  try {
    licenseMap = JSON.parse(rawJson || '{}');
  } catch (err) {
    console.error('Failed to parse license output JSON:', err.message);
    return { ok: false, exitCode: 1 };
  }

  return executeValidation(validateLicenseMap(licenseMap));
}

function executeValidation({ checked, violations }) {
  if (checked.length === 0) {
    console.log('No production dependencies found.');
    console.log('Licence check passed (0 production dependencies).');
    return { ok: true, exitCode: 0 };
  }

  console.log(`Checked ${checked.length} resolved production dependencies:`);
  for (const pkg of checked) {
    const status = pkg.allowed ? 'OK' : 'DISALLOWED';
    console.log(`  [${status}] ${pkg.name}@${pkg.version} (${pkg.license})`);
  }

  if (violations.length > 0) {
    console.error('\nDisallowed production licences detected:');
    for (const v of violations) {
      console.error(`  - ${v.name}@${v.version}: ${v.license}`);
    }
    console.error(
      `\nError: ${violations.length} dependency/dependencies violate the licence policy.`,
    );
    return { ok: false, exitCode: 1 };
  }

  console.log('\nAll resolved production dependencies conform to licence policy.');
  return { ok: true, exitCode: 0 };
}

// When run directly as a script
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const result = runCheck();
  if (!result.ok) {
    process.exit(result.exitCode);
  }
}
