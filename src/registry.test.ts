import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  defaultPrinter, findPrinter, loadRegistry, parseRegistry, registryPath,
  resetRegistryCache, resolveByAddress, saveRegistry,
} from './registry.js';
import { describeRegistry } from './relay.js';

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

describe('what the bridge reports upstream', () => {
  // The cloud can only offer a printer a remote till can pick if the bridge has told it the
  // printer exists. A network sweep finds sockets; only this list can contain a USB or serial
  // printer, and that is the whole reason a tablet could not print to one.
  it('reports every configured printer, including the ones with no address', () => {
    saveRegistry({
      version: 1,
      printers: [
        { id: 'counter', name: 'Counter', transport: 'network', address: '192.168.18.103', port: 9100 },
        { id: 'kitchen-usb', name: 'Kitchen', transport: 'usb', queue: 'EPSON_TM_T20' },
      ],
    });
    const reported = describeRegistry();

    assert.equal(reported.length, 2);
    const usb = reported.find((p) => p.id === 'kitchen-usb');
    assert.equal(usb?.transport, 'usb');
    // Null rather than absent: the server column is NOT NULL-defaulted and the POS branches on
    // it to decide whether a printer can be addressed by socket at all.
    assert.equal(usb?.address, null);
    assert.equal(reported.find((p) => p.id === 'counter')?.address, '192.168.18.103');
  });

  // The heartbeat runs every 30 seconds forever; a serial port name is this machine's business
  // and nothing remote can act on it.
  it('sends a summary, not the whole record', () => {
    saveRegistry({
      version: 1,
      printers: [{ id: 'labels', name: 'Labels', transport: 'serial', device: '/dev/cu.RPP02N', baud: 19200, type: 'label', language: 'tspl', width_mm: 40, height_mm: 30 }],
    });
    const [reported] = describeRegistry();
    assert.deepEqual(Object.keys(reported ?? {}).sort(), [
      'address', 'enabled', 'id', 'name', 'port', 'role', 'transport', 'type',
    ]);
    // Not `device`, not `baud`, not `language`: the summary carries only what the server can
    // act on. `role` earns its place because role-addressed jobs are resolved server-side.
    assert.equal('device' in (reported ?? {}), false);
  });

  it('accepts a role, folds its case, and refuses one that is not a role', () => {
    // Unset is normal and silent. A VALUE that is not a role is a typo in a hand-edited config,
    // and swallowing it would leave the printer permanently unreachable by role with nothing on
    // screen to say why.
    const ok = parseRegistry({
      version: 1,
      printers: [
        { id: 'pass', name: 'Pass', transport: 'network', address: '192.168.18.104', role: 'KITCHEN' },
        { id: 'till', name: 'Till', transport: 'network', address: '192.168.18.103' },
      ],
    });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.registry?.printers.find((p) => p.id === 'pass')?.role, 'kitchen');
    assert.equal(ok.registry?.printers.find((p) => p.id === 'till')?.role, undefined);

    const bad = parseRegistry({
      version: 1,
      printers: [{ id: 'x', name: 'X', transport: 'network', address: '192.168.18.103', role: 'dessert' }],
    });
    assert.equal(bad.errors.length, 1);
    assert.match(bad.errors[0] ?? '', /role must be one of/);
  });

  it('reports an untagged printer as role null, so the server can tell it apart from a tag', () => {
    saveRegistry({
      version: 1,
      printers: [
        { id: 'till', name: 'Till', transport: 'network', address: '192.168.18.103' },
        { id: 'pass', name: 'Pass', transport: 'network', address: '192.168.18.104', role: 'kitchen' },
      ],
    });
    const reported = describeRegistry();
    assert.equal(reported.find((p) => p.id === 'till')?.role, null);
    assert.equal(reported.find((p) => p.id === 'pass')?.role, 'kitchen');
  });
})
