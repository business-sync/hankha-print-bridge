import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type LogRecord, setLogSink } from './log.js';
import { isAllowedSerialDevice, parseRegistry } from './registry.js';

/*
 * The serial driver opens `device` write-only as SYSTEM / root. These pin what a registry may
 * name there, and that an upgrade never makes an existing printer disappear over it.
 */

let restoreLog: (() => void) | null = null;
let records: LogRecord[] = [];
beforeEach(() => {
  records = [];
  restoreLog = setLogSink((r) => records.push(r));
});
afterEach(() => restoreLog?.());

describe('isAllowedSerialDevice', () => {
  it('accepts the device nodes a serial printer really has, on macOS and Linux', () => {
    for (const device of [
      '/dev/cu.RPP02N',
      '/dev/cu.usbserial-1410',
      '/dev/tty.Bluetooth-Incoming-Port',
      '/dev/ttyUSB0',
      '/dev/ttyACM1',
      '/dev/ttyS0',
      '/dev/rfcomm0',
      '/dev/usb/lp0',
      '/dev/lp0',
      '/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0',
      '/dev/serial/by-path/pci-0000:00:14.0-usb-0:2:1.0-port0',
    ]) {
      assert.equal(isAllowedSerialDevice(device, 'darwin'), true, device);
      assert.equal(isAllowedSerialDevice(device, 'linux'), true, device);
    }
  });

  it('refuses a path to an ordinary file or anywhere outside /dev', () => {
    for (const device of [
      '/etc/passwd',
      '/etc/hosts',
      '/Library/LaunchDaemons/la.hankha.print-bridge.plist',
      '/var/root/.zshrc',
      'C:\\Windows\\System32\\config\\SAM',
      'relative/path',
      '',
    ]) {
      assert.equal(isAllowedSerialDevice(device, 'darwin'), false, device);
      assert.equal(isAllowedSerialDevice(device, 'linux'), false, device);
    }
  });

  it('refuses traversal and anything in /dev that is not a printer port', () => {
    for (const device of [
      '/dev/../etc/passwd',
      '/dev/tty/../../etc/passwd',
      '/dev/cu.x/../../etc/passwd',
      '/dev/sda',
      '/dev/disk0',
      '/dev/mem',
      '/dev/null',
      '/dev/ttyUSB0 ',
      '/dev/ttyUSB0\n/etc/passwd',
      '/dev/serial/by-id/../../../etc/passwd',
      '/dev/serial/by-id/a/b',
    ]) {
      assert.equal(isAllowedSerialDevice(device, 'linux'), false, JSON.stringify(device));
    }
  });

  it('on Windows accepts COM ports only', () => {
    for (const device of ['COM1', 'COM3', 'com7', 'COM12', 'COM255', '\\\\.\\COM3', '\\\\.\\COM14']) {
      assert.equal(isAllowedSerialDevice(device, 'win32'), true, device);
    }
    for (const device of [
      'COM0', 'COM', 'COM1000', 'COM3:', 'C:\\Windows\\System32\\config\\SAM', '\\\\.\\PhysicalDrive0',
      '\\\\server\\share\\file', '/dev/ttyUSB0', 'COM3\\..\\..\\x', '',
    ]) {
      assert.equal(isAllowedSerialDevice(device, 'win32'), false, device);
    }
  });
});

describe('parseRegistry and the device allow-list', () => {
  const serial = (device: string) => ({
    printers: [{ id: 'serial-1', name: 'Serial', transport: 'serial', device, type: 'receipt', language: 'escpos' }],
  });

  it('strict mode (a registry arriving over the network) rejects a device outside the list', () => {
    const { registry, errors } = parseRegistry(serial('/etc/passwd'), { strictDevice: true });
    assert.equal(registry.printers.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /printers\[0\].*\/etc\/passwd.*not a serial port path/);
  });

  it('strict mode accepts a real port', () => {
    const { registry, errors } = parseRegistry(serial('/dev/cu.RPP02N'), { strictDevice: true });
    assert.deepEqual(errors, []);
    assert.equal(registry.printers[0]?.device, '/dev/cu.RPP02N');
  });

  it('reading the file already on disk keeps the printer and only warns', () => {
    const { registry, errors } = parseRegistry(serial('/opt/odd/ttyThing'));
    assert.deepEqual(errors, [], 'an upgrade must not make a working printer vanish');
    assert.equal(registry.printers[0]?.device, '/opt/odd/ttyThing');
    const warned = records.find((r) => r.event === 'registry.device_unusual');
    assert.ok(warned, 'the operator should still hear about it');
  });

  it('does not warn about a normal port', () => {
    parseRegistry(serial('/dev/ttyUSB0'));
    assert.equal(records.some((r) => r.event === 'registry.device_unusual'), false);
  });

  it('a device on a printer of another transport is checked too — it is stored either way', () => {
    const body = {
      printers: [{ id: 'net-1', name: 'Net', transport: 'network', address: '192.168.1.5', device: '/etc/passwd', type: 'receipt', language: 'escpos' }],
    };
    assert.equal(parseRegistry(body, { strictDevice: true }).errors.length, 1);
  });
});
