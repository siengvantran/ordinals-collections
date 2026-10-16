import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { root } from './helpers.mjs';

test('the Edge Function copy of js/core and the dictionary is up to date', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, [join(root, 'scripts/sync-core.mjs'), '--check'], { stdio: 'pipe' }));
});
