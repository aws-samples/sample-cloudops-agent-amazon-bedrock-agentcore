import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileSystem } from 'aws-cdk-lib';
import { LOCAL_ARTIFACTS } from '../lib/image-stack';

// Source.asset stages through FileSystem.copyDirectory with the same exclude
// options, so this is exactly what BucketDeployment would upload.
test('source assets drop local build artifacts at any depth, including dotfiles inside them', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-src-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-dest-'));
  const files = [
    'main.py',
    'tests/test_main.py',
    '.venv/.gitignore',
    '.venv/lib/site.py',
    'node_modules/pkg/index.js',
    '__pycache__/main.cpython-312.pyc',
    'tests/__pycache__/test_main.cpython-312.pyc',
    '.pytest_cache/.gitignore',
    '.hypothesis/examples/x',
    'tests/stray.pyc',
  ];
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    fs.writeFileSync(path.join(src, f), '');
  }

  FileSystem.copyDirectory(src, dest, { exclude: LOCAL_ARTIFACTS });

  const copied = fs.readdirSync(dest, { recursive: true }) as string[];
  expect(copied.filter((f) => fs.statSync(path.join(dest, f)).isFile()).sort())
    .toEqual(['main.py', path.join('tests', 'test_main.py')]);
});
