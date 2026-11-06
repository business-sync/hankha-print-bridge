/*
 * Writes that survive a power cut.
 *
 * `writeFileSync` + `renameSync` is atomic against a CRASH of this process, but not against the
 * machine losing power: the data can still be sitting in the OS cache when the rename is
 * journalled, which leaves a complete-looking file with nothing in it. On a till that gets its
 * plug pulled at closing time, that is a spooled job that reads back empty.
 *
 * So the file is flushed before the rename, and the directory after it. Directory fsync is
 * best-effort: Windows cannot open a directory for it, and a filesystem that refuses it has
 * nothing better to offer.
 */
import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Flush a directory's entries (a rename, a new file) to disk. Never throws. */
export function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* Windows, or a filesystem without directory fsync */
  }
}

/** `writeSync` may write less than asked (a full pipe, a signal); keep going until it is all out. */
function writeAll(fd: number, data: string | Buffer): void {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

/** Write `data` to `path` so that afterwards it is either the old file or the whole new one, on disk. */
export function writeFileDurable(path: string, data: string | Buffer, temp = `${path}.tmp`): void {
  const fd = openSync(temp, 'w');
  try {
    writeAll(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  fsyncDir(dirname(path));
}

/** Append `data` to `path` and flush it. */
export function appendFileDurable(path: string, data: string): void {
  const fd = openSync(path, 'a');
  try {
    writeAll(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
