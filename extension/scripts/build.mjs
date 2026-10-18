import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const contentEntry = resolve(rootDir, 'src/content/index.ts');
const backgroundEntry = resolve(rootDir, 'src/background.ts');

const supportedTargets = ['chrome', 'firefox'];

function parseRequestedTargets(argv) {
  const requested = [];
  for (const arg of argv) {
    if (!arg.startsWith('--target=')) {
      continue;
    }
    const target = arg.slice('--target='.length);
    if (!supportedTargets.includes(target)) {
      throw new Error(`Unknown build target "${target}". Supported targets: ${supportedTargets.join(', ')}`);
    }
    requested.push(target);
  }
  return requested.length > 0 ? [...new Set(requested)] : supportedTargets;
}

async function buildContent(target, outDir) {
  await build({
    configFile: false,
    root: rootDir,
    publicDir: 'public',
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        input: {
          content: contentEntry
        },
        output: {
          entryFileNames: 'content.js',
          format: 'iife',
          inlineDynamicImports: true
        }
      }
    }
  });
}

async function buildBackground(outDir) {
  await build({
    configFile: false,
    root: rootDir,
    publicDir: false,
    build: {
      outDir,
      emptyOutDir: false,
      sourcemap: true,
      rollupOptions: {
        input: {
          background: backgroundEntry
        },
        output: {
          entryFileNames: 'background.js',
          format: 'iife',
          inlineDynamicImports: true
        }
      }
    }
  });
}

async function patchManifestForTarget(manifestPath, target) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  if (target === 'chrome') {
    manifest.background = { service_worker: 'background.js' };
    delete manifest.browser_specific_settings;
  } else {
    manifest.background = { scripts: ['background.js'] };
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
}

async function buildTarget(target) {
  const outDir = `dist/${target}`;

  await buildContent(target, outDir);
  await buildBackground(outDir);
  await patchManifestForTarget(resolve(rootDir, outDir, 'manifest.json'), target);

  console.log(`[build] target=${target} -> ${outDir}`);
}

for (const target of parseRequestedTargets(process.argv.slice(2))) {
  await buildTarget(target);
}
