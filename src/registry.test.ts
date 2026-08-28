import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  defaultPrinter, findPrinter, loadRegistry, parseRegistry, registryPath,
  resetRegistryCache, resolveByAddress, saveRegistry,
} from './registry.js';

let dir = '';
let originalStateDir: string | undefined;

before(() => {
  originalStateDir = process.env.PRINT_BRIDGE_STATE_DIR;
  dir = mkdtempSync(join(tmpdir(), 'hankha-registry-'));
  process.env.PRINT_BRIDGE_STATE_DIR = dir;
  resetRegistryCache();
});
after(() => {
  if (originalStateDir === undefined) delete process.env.PRINT_BRIDGE_STATE_DIR;
  else process.env.PRINT_BRIDGE_STATE_DIR = originalStateDir;
  rmSync(dir, { recursive: true, force: true });
});

const network = { id: 'counter', name: 'Counter', transport: 'network', address: '192.168.18.103', port: 9100 };

describe('validation', () => {
  it('fills in the defaults a receipt printer can be trusted to have', () => {
    const { registry, errors } = parseRegistry({ printers: [network] });
    assert.deepEqual(errors, []);
    const printer = registry.printers[0];
    assert.equal(printer?.type, 'receipt');
    assert.equal(printer?.language, 'escpos');
    assert.equal(printer?.enabled, true);
    assert.equal(printer?.dots_per_line, 576);
  });

  it('requires a language for a label printer, because there is no safe default', () => {
    // ZPL sent to a TSPL head prints the commands as text, one label per line, until the roll
    // runs out. Guessing is worse than refusing.
    const { errors } = parseRegistry({
      printers: [{ ...network, id: 'labels', type: 'label', width_mm: 50, height_mm: 30 }],
    });
    assert.ok(errors.some((e) => e.includes('language is required for a label printer')));
  });

  it('treats language: auto as escpos rather than probing anything', () => {
    const { registry, errors } = parseRegistry({ printers: [{ ...network, language: 'auto' }] });
    assert.deepEqual(errors, []);
    assert.equal(registry.printers[0]?.language, 'escpos');
  });

  it('reports every problem at once, not just the first', () => {
    const { errors } = parseRegistry({
      printers: [{ id: 'bad', transport: 'network', port: 70000, dots_per_line: 2 }],
    });
    // A registry is edited whole; one error per round trip would mean four round trips.
    assert.ok(errors.length >= 3, `expected several errors, got ${JSON.stringify(errors)}`);
  });

  it('refuses an address this bridge could never dial', () => {
    const { errors } = parseRegistry({ printers: [{ ...network, address: '8.8.8.8' }] });
    assert.ok(errors.some((e) => e.includes('RFC1918')));
  });

  it('refuses a duplicate id, which would make routing ambiguous', () => {
    const { registry, errors } = parseRegistry({ printers: [network, { ...network, name: 'Other' }] });
    assert.equal(registry.printers.length, 1);
    assert.ok(errors.some((e) => e.includes('duplicate id')));
  });

  it('refuses a default naming a printer that is not listed', () => {
    const { errors } = parseRegistry({ printers: [network], default_receipt_printer: 'ghost' });
    assert.ok(errors.some((e) => e.includes('not one of the printers listed')));
  });

  it('requires the field each transport actually needs', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ id: 'a', transport: 'network' }, 'needs an address'],
      [{ id: 'b', transport: 'usb' }, 'needs a queue name'],
      [{ id: 'c', transport: 'serial' }, 'needs a device path'],
    ];
    for (const [entry, expected] of cases) {
      const { errors } = parseRegistry({ printers: [entry] });
      assert.ok(errors.some((e) => e.includes(expected)), `${JSON.stringify(entry)} -> ${expected}`);
    }
  });
});

describe('persistence', () => {
  it('writes atomically and reads back', () => {
    const { registry } = parseRegistry({ printers: [network], default_receipt_printer: 'counter' });
    saveRegistry(registry);
    resetRegistryCache();

    const loaded = loadRegistry();
    assert.equal(loaded.printers.length, 1);
    assert.equal(loaded.default_receipt_printer, 'counter');
    // No temp files left behind: the save is a write-then-rename.
    assert.ok(!readFileSync(registryPath(), 'utf8').includes('tmp'));
  });

  it('starts empty rather than refusing to run when the file is corrupt', () => {
    // A bridge that would not start because its printer list had a typo would take the raw
    // /print passthrough down with it — and that path needs no registry at all.
    const broken = mkdtempSync(join(tmpdir(), 'hankha-registry-bad-'));
    const previous = process.env.PRINT_BRIDGE_STATE_DIR;
    process.env.PRINT_BRIDGE_STATE_DIR = broken;
    try {
      writeFileSync(join(broken, 'printers.json'), '{ not json');
      resetRegistryCache();
      assert.deepEqual(loadRegistry().printers, []);
    } finally {
      process.env.PRINT_BRIDGE_STATE_DIR = previous;
      rmSync(broken, { recursive: true, force: true });
      resetRegistryCache();
    }
  });
});

describe('resolution', () => {
  const { registry } = parseRegistry({
    printers: [
      network,
      // A USB printer given an address. This is the mechanism that lets a cloud job — which only
      // ever carries target_ip/target_port — reach a printer that has no IP of its own.
      { id: 'kitchen', name: 'Kitchen', transport: 'usb', queue: 'SPRT_SP_EP', address: '192.168.18.200', port: 9100 },
      { id: 'off', name: 'Off', transport: 'network', address: '192.168.18.9', enabled: false },
    ],
    default_receipt_printer: 'counter',
  });

  it('finds a printer by id', () => {
    assert.equal(findPrinter(registry, 'kitchen')?.queue, 'SPRT_SP_EP');
    assert.equal(findPrinter(registry, 'nope'), null);
  });

  it('routes a bare ip:port onto a USB printer when one claims that address', () => {
    const found = resolveByAddress(registry, '192.168.18.200', 9100);
    assert.equal(found?.id, 'kitchen');
    assert.equal(found?.transport, 'usb');
  });

  it('ignores a disabled printer when resolving an address', () => {
    assert.equal(resolveByAddress(registry, '192.168.18.9', 9100), null);
  });

  it('uses the configured default', () => {
    assert.equal(defaultPrinter(registry, 'receipt')?.id, 'counter');
  });

  it('needs no default when there is exactly one candidate', () => {
    // A one-printer venue should never have to name a default.
    const single = parseRegistry({ printers: [{ ...network, id: 'only' }] }).registry;
    assert.equal(defaultPrinter(single, 'receipt')?.id, 'only');
  });

  it('refuses to guess between two equal candidates', () => {
    const two = parseRegistry({ printers: [network, { ...network, id: 'second', address: '192.168.18.104' }] }).registry;
    assert.equal(defaultPrinter(two, 'receipt'), null);
  });
});
