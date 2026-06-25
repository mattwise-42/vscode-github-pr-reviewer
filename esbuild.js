const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const sharedOptions = {
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
};

const buildOptions = [
  {
    ...sharedOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    sourcemap: true,
    minify: !watch,
  },
  {
    ...sharedOptions,
    entryPoints: ['src/github.ts', 'src/comments.ts', 'src/review-tree.ts'],
    outdir: 'dist-tests',
    sourcemap: false,
    minify: false,
  },
];

async function main() {
  if (watch) {
    const contexts = await Promise.all(buildOptions.map((options) => esbuild.context(options)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('watching for changes...');
    return;
  }

  await Promise.all(buildOptions.map((options) => esbuild.build(options)));
}

main().catch(() => process.exit(1));
