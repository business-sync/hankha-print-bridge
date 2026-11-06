import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { appendFileDurable, fsyncDir, writeFileDurable } from './durable-fs.js';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hankha-durable-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('writeFileDurable', () => {
  it('writes the whole content and leaves no temp file behind', () => {
    const dir = scratch();
    writeFileDurable(join(dir, 'a.json'), '{"x":1}');
    assert.equal(readFileSync(join(dir, 'a.json'), 'utf8'), '{"x":1}');
    assert.deepEqual(readdirSync(dir), ['a.json']);
  });

  it('replaces an existing file in one step', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'a.json'), 'old and much longer than the replacement');
    writeFileDurable(join(dir, 'a.json'), 'new');
    assert.equal(readFileSync(join(dir, 'a.json'), 'utf8'), 'new');
  });

  it('writes binary content untouched', () => {
    const dir = scratch();
    const bytes = Buffer.from([0x1b, 0x40, 0x00, 0xff, 0x80]);
    writeFileDurable(join(dir, 'b.bin'), bytes);
    assert.deepEqual(readFileSync(join(dir, 'b.bin')), bytes);
  });

  it('writes content larger than one OS write', () => {
    const dir = scratch();
    const big = 'x'.repeat(5 * 1024 * 1024);
    writeFileDurable(join(dir, 'big.txt'), big);
    assert.equal(readFileSync(join(dir, 'big.txt'), 'utf8').length, big.length);
  });

  it('throws when the directory is missing, and leaves the target alone', () => {
    const dir = scratch();
    assert.throws(() => writeFileDurable(join(dir, 'missing', 'a.json'), 'x'));
    assert.equal(existsSync(join(dir, 'missing')), false);
  });
});

describe('appendFileDurable', () => {
  it('appends in order', () => {
    const dir = scratch();
    appendFileDurable(join(dir, 'ring.jsonl'), 'one\n');
    appendFileDurable(join(dir, 'ring.jsonl'), 'two\n');
    assert.equal(readFileSync(join(dir, 'ring.jsonl'), 'utf8'), 'one\ntwo\n');
  });
});

describe('fsyncDir', () => {
  it('never throws, even for a directory that does not exist', () => {
    assert.doesNotThrow(() => fsyncDir(join(scratch(), 'nope')));
    assert.doesNotThrow(() => fsyncDir(scratch()));
  });
});
