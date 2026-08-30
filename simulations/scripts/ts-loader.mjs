/**
 * Minimal ESM loader hook that transpiles TypeScript on import, so the
 * verification scripts can exercise the real `src/` modules instead of a
 * hand-maintained copy. Types are stripped, not checked; `npm run typecheck`
 * covers correctness.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export async function resolve(specifier, context, next) {
  // Vite resolves extensionless relative imports; Node does not.
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // Fall through to the unmodified specifier.
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    const source = readFileSync(fileURLToPath(url), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
      fileName: url,
    });
    return { format: 'module', source: outputText, shortCircuit: true };
  }
  return next(url, context);
}
