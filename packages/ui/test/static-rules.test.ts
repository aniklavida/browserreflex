import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sourceFiles = walk(src).filter((file) => /\.(tsx?|css)$/.test(file));

/** A colour written as a value: hex, rgb(a), hsl(a), oklch, or a named colour keyword in CSS. */
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/;

describe('theme discipline', () => {
  it('holds no colour value outside theme.css', () => {
    const offenders = sourceFiles
      .filter((file) => !file.endsWith('theme.css'))
      .filter((file) => COLOUR.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });

  it('defines the dark and the light token sets in theme.css', () => {
    const css = readFileSync(join(src, 'theme.css'), 'utf8');
    expect(css).toContain(":root[data-theme='light']");
    for (const token of ['--bg', '--ink', '--line', '--acc', '--auto', '--ai', '--human']) {
      expect(css).toContain(`${token}:`);
    }
  });

  it('collapses the sidebar below 1280px and holds a 960px minimum width', () => {
    const css = readFileSync(join(src, 'theme.css'), 'utf8');
    expect(css).toMatch(/@media \(max-width: 1279px\)/);
    expect(css).toMatch(/min-width: 960px/);
  });

  it('uses no radius, shadow or gradient for structure', () => {
    const css = readFileSync(join(src, 'theme.css'), 'utf8').replace(
      /linear-gradient\(var\(--hair\)[^;]*;/g,
      '',
    );
    expect(css).not.toMatch(/box-shadow|text-shadow/);
    expect(css).not.toMatch(/border-radius:\s*[1-9]/);
  });
});

describe('no remote requests', () => {
  it('has no http(s) address in the page, the styles or the sources', () => {
    const files = [join(root, 'index.html'), ...sourceFiles];
    const offenders = files
      .filter((file) => /https?:\/\//.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });

  it('bundles its fonts from packages and never links a font service', () => {
    const main = readFileSync(join(src, 'main.tsx'), 'utf8');
    expect(main).toContain('@fontsource/archivo');
    expect(main).toContain('@fontsource/dm-mono');
    for (const file of [join(root, 'index.html'), ...sourceFiles]) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    }
  });
});
