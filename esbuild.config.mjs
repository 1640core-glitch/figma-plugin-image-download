import * as esbuild from 'esbuild';
import * as fs from 'fs';

const isProd = process.env.NODE_ENV === 'production';
const isWatch = process.argv.includes('--watch');

const codeOptions = {
  entryPoints: ['src/code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  format: 'iife',
  target: 'es2017',
  platform: 'browser',
  minify: isProd,
  sourcemap: isProd ? false : 'inline',
};

const uiOptions = {
  entryPoints: ['src/ui.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2017',
  platform: 'browser',
  minify: isProd,
  sourcemap: isProd ? false : 'inline',
};

async function buildUiHtml() {
  const uiResult = await esbuild.build(uiOptions);
  const uiJs = uiResult.outputFiles[0].text;
  const uiHtml = fs.readFileSync('src/ui.html', 'utf8');
  const finalHtml = uiHtml.replace(
    '</body>',
    `<script>${uiJs}</script>\n</body>`
  );
  fs.writeFileSync('dist/ui.html', finalHtml);
}

if (isWatch) {
  const codeCtx = await esbuild.context(codeOptions);
  await codeCtx.watch();

  const uiWatchOptions = {
    ...uiOptions,
    write: false,
    plugins: [
      {
        name: 'ui-html-inject',
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length > 0) return;
            const uiJs = result.outputFiles[0].text;
            const uiHtml = fs.readFileSync('src/ui.html', 'utf8');
            const finalHtml = uiHtml.replace(
              '</body>',
              `<script>${uiJs}</script>\n</body>`
            );
            fs.writeFileSync('dist/ui.html', finalHtml);
          });
        },
      },
    ],
  };
  const uiCtx = await esbuild.context(uiWatchOptions);
  await uiCtx.watch();

  console.log('Watching for changes...');
} else {
  await esbuild.build(codeOptions);
  await buildUiHtml();
  console.log('Build complete: dist/code.js, dist/ui.html');
}
