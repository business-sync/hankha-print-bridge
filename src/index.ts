import { localInterfaces } from './lan.js';
import { discoverAll } from './discovery.js';
import { log } from './log.js';
import { enroll, startRelay } from './relay.js';
import { queue } from './queue.js';
import { findPrinter, loadRegistry, registryPath } from './registry.js';
import { render } from './render/index.js';
import { sampleLabel, sampleReceipt } from './samples.js';
import { createBridgeServer, isTlsEnabled } from './server.js';
import { statePath } from './identity.js';
import { driverFor } from './transports/index.js';
import { BRIDGE_SERVICE, BRIDGE_VERSION } from './version.js';

const DEFAULT_PORT = 9200;
/**
 * Every interface by default — unchanged from the days when one bridge on a venue PC served
 * several tills. The installers override this to `127.0.0.1`, because a POS served over https
 * can only reach a bridge on loopback anyway (mixed content blocks every other address), so on
 * a real till there is nothing to gain from listening wider.
 */
const DEFAULT_HOST = '0.0.0.0';
/** How long a shutdown waits for the write that is already on the wire. */
const DRAIN_TIMEOUT_MS = 8000;

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(BRIDGE_VERSION);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`${BRIDGE_SERVICE} v${BRIDGE_VERSION}

Sends POS print jobs to receipt and label printers over the network, a USB print queue, or a
serial/Bluetooth port. A browser cannot open any of those, so the POS terminal posts here — and
this also dials out to the cloud API, so a phone can print through it without reaching the LAN.

Usage: hankha-print-bridge [options]

Options:
  -v, --version         Print the version and exit
  -h, --help            Print this help and exit
  --enroll <code>       Redeem an enrollment code from Settings > Printing, then exit.
                        Links this bridge to your organization so the POS can send it jobs
                        from any device, including a phone.
  --list-printers       List configured printers and everything this machine can see, then exit
  --test-print <id>     Print a test slip on a configured printer, then exit

Environment:
  PRINT_BRIDGE_PORT     TCP port to listen on               (default ${DEFAULT_PORT})
  PRINT_BRIDGE_HOST     Address to bind                     (default ${DEFAULT_HOST})
                        Set to 127.0.0.1 to accept only connections from this machine.
  PRINT_BRIDGE_RELAY_URL        Cloud API to poll for jobs  (default https://api.hankha.la)
  PRINT_BRIDGE_RELAY_TRANSPORT  auto | ws | poll            (default auto)
  PRINT_BRIDGE_STATE_DIR        Config, spool and relay.json  (default per-OS)
  PRINT_BRIDGE_TOKEN            Require an 'Authorization: Bearer <token>' header on every
                                route but /health. Set this whenever the bridge binds beyond
                                loopback.
  PRINT_BRIDGE_TLS_CERT         PEM certificate — serve https instead of http (both required)
  PRINT_BRIDGE_TLS_KEY          PEM private key
  PRINT_BRIDGE_LOG_FORMAT       text | json                 (default text)
  PRINT_BRIDGE_LOG_LEVEL        debug | info | warn | error (default info)
  PRINT_BRIDGE_MAX_ATTEMPTS     Retries per job, when nothing printed   (default 3)

Endpoints:
  GET  /health   liveness, identity, version and this machine's networks
  GET  /status   printers online/offline, queue depth, transports, relay
  POST /probe    { ip, port? }                  can the bridge reach this printer?
  POST /scan     { port? }                      sweep this machine's subnets for printers
  POST /discover { port?, network? }            every printer this machine can see
  POST /print    { ip, port, payload_base64 }   print now, and wait for the answer
  POST /jobs     { printer_id | target, receipt | label | payload_base64 }
  GET  /jobs, GET /jobs/:id, POST /jobs/:id/cancel
  GET  /printers, PUT /printers, POST /printers/:id/test, POST /printers/:id/identify`);
  process.exit(0);
}

/**
 * `--enroll <code>` redeems a one-time code from Settings > Printing and exits.
 *
 * A separate invocation rather than a flag on the long-running service, because enrolling is a
 * one-off act by a person: the installed daemon keeps running untouched, and the operator gets
 * an exit code and a sentence instead of having to read a service log.
 */
const enrollAt = args.indexOf('--enroll');
const testPrintAt = args.indexOf('--test-print');

if (enrollAt !== -1) {
  const code = args[enrollAt + 1];
  if (!code || code.startsWith('-')) {
    console.error('--enroll needs a code, e.g. `hankha-print-bridge --enroll ABCD-2345`');
    process.exit(2);
  }
  enroll(code)
    .then(({ bridge_id }) => {
      console.log(`Enrolled as bridge ${bridge_id}. Credentials saved to ${statePath()}`);
      console.log('Restart the Print Bridge service to start accepting cloud print jobs.');
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
} else if (args.includes('--list-printers')) {
  void listPrinters();
} else if (testPrintAt !== -1) {
  void testPrint(args[testPrintAt + 1]);
} else {
  runService();
}

/**
 * Both halves of "what printers are there": the ones configured, and the ones present.
 *
 * Shown together because the useful question is almost always the difference between them — a
 * queue that has been renamed, or a printer that is plugged in but not yet in `printers.json`.
 */
async function listPrinters(): Promise<void> {
  const registry = loadRegistry();
  console.log(`Configured printers (${registryPath()}):`);
  if (registry.printers.length === 0) {
    console.log('  (none) — add some with PUT /printers, or write the file directly');
  }
  for (const printer of registry.printers) {
    const where = printer.queue ?? printer.device ?? `${printer.address ?? '?'}:${printer.port ?? ''}`;
    console.log(
      `  ${printer.id.padEnd(16)} ${printer.transport.padEnd(8)} ${printer.type.padEnd(8)} ` +
        `${printer.language.padEnd(7)} ${where}${printer.enabled ? '' : '  (disabled)'}`
    );
  }

  console.log('\nVisible on this machine:');
  const found = await discoverAll();
  for (const transport of found.transports) {
    if (!transport.available) console.log(`  ${transport.kind}: unavailable — ${transport.reason}`);
  }
  if (found.printers.length === 0) console.log('  (nothing found)');
  for (const printer of found.printers) {
    console.log(`  ${printer.transport.padEnd(8)} ${printer.label}${printer.detail ? `  (${printer.detail})` : ''}`);
  }
  process.exit(0);
}

/**
 * Print the same test slip the settings screen prints, straight through the driver.
 *
 * Deliberately NOT through the queue: this is a diagnostic, and the answer wanted is "did this
 * printer take the bytes, right now" rather than "was it accepted for printing later".
 */
async function testPrint(printerId: string | undefined): Promise<void> {
  if (!printerId || printerId.startsWith('-')) {
    console.error('--test-print needs a printer id. Run --list-printers to see them.');
    process.exit(2);
  }
  const printer = findPrinter(loadRegistry(), printerId);
  if (!printer) {
    console.error(`No printer with id '${printerId}'. Run --list-printers to see them.`);
    process.exit(1);
  }

  try {
    const payload = render(printer.type === 'label' ? sampleLabel(printer) : sampleReceipt(printer), printer);
    const outcome = await driverFor(printer.transport).send(printer, payload, 15_000);
    if (outcome.ok) {
      console.log(`Sent ${payload.length} bytes to ${printer.id} in ${outcome.duration_ms}ms.`);
      process.exit(0);
    }
    console.error(`Failed: ${outcome.reason} (${outcome.printed_certainty}) — ${outcome.detail}`);
    process.exit(1);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function runService(): void {
  // Every supported flag exits before this point, so anything dash-prefixed still here is a typo.
  const unknown = args.filter((a) => a.startsWith('-'));
  if (unknown.length > 0) {
    console.error(`Unknown option: ${unknown[0]}\nRun with --help to see the supported options.`);
    process.exit(2);
  }

  const PORT = Number(process.env.PRINT_BRIDGE_PORT ?? DEFAULT_PORT);
  const HOST = process.env.PRINT_BRIDGE_HOST?.trim() || DEFAULT_HOST;

  if (!Number.isInteger(PORT) || PORT <= 0 || PORT >= 65536) {
    console.error(`PRINT_BRIDGE_PORT must be a port number, got: ${process.env.PRINT_BRIDGE_PORT}`);
    process.exit(2);
  }

  const server = createBridgeServer();

  // Installed as a service, the only trace of a failed start is this line in the log file — so
  // say which address was refused rather than dumping a bare stack trace.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `Port ${PORT} is already in use — another copy of the print bridge (or some other app) ` +
          `is running. Stop it, or set PRINT_BRIDGE_PORT to a free port.`
      );
    } else if (err.code === 'EADDRNOTAVAIL' || err.code === 'EACCES') {
      console.error(`Cannot bind ${HOST}:${PORT} — ${err.code}. Check PRINT_BRIDGE_HOST.`);
    } else {
      console.error(`Print bridge failed to start: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const scheme = isTlsEnabled() ? 'https' : 'http';
    log.info(`${BRIDGE_SERVICE} v${BRIDGE_VERSION} listening on ${scheme}://${HOST}:${PORT}`, {
      event: 'server.listening', host: HOST, port: PORT, scheme, version: BRIDGE_VERSION,
    });
    if (process.env.PRINT_BRIDGE_TOKEN?.trim()) {
      log.info('  a bearer token is required on every route except /health', { event: 'server.auth_required' });
    } else if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
      // Not fatal, but worth saying out loud: on a shop box this means every device on the
      // venue Wi-Fi, guest phones included, can drive the printers.
      log.warn('  WARNING: bound beyond loopback with no PRINT_BRIDGE_TOKEN set', { event: 'server.open_lan' });
    }
    if (HOST === '127.0.0.1' || HOST === 'localhost') {
      // Not a warning — this is the intended setup on a till, and saying so out loud stops
      // someone "fixing" it when another terminal can't connect.
      log.info('  bound to loopback: only this computer can reach the bridge', { event: 'server.loopback' });
    } else {
      // The operator needs this to point other terminals at the right address, and it's the
      // fastest way to spot "the printers are on a different network than this PC".
      for (const iface of localInterfaces()) {
        log.info(`  reachable on this LAN at ${scheme}://${iface.address}:${PORT}  (${iface.cidr})`, {
          event: 'server.interface', address: iface.address, cidr: iface.cidr,
        });
      }
    }

    const registry = loadRegistry();
    log.info(
      `  ${registry.printers.length} printer(s) configured in ${registryPath()}`,
      { event: 'registry.loaded', printers: registry.printers.length, path: registryPath() }
    );
  });

  // Reads the spool back and resumes anything a previous run left behind, before the first request
  // can add to it.
  queue().load();

  // The outbound half: dial the cloud API and wait for jobs, so a phone or a till on mobile data
  // can print through this bridge without reaching the LAN itself. A no-op (with one log line)
  // until someone runs `--enroll`, so an existing LAN-only install is unaffected.
  startRelay();

  // launchd and Task Scheduler both stop the process with a signal; exiting cleanly keeps a
  // restart from being logged as a crash.
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info(`${BRIDGE_SERVICE} shutting down`, { event: 'server.shutdown', signal });

      server.close();
      // Let the write already on the wire finish. Jobs still WAITING are left on disk on purpose:
      // they resume next start, and printing a backlog during a restart is how a service bounce
      // turns into a paper jam.
      void queue()
        .drain(DRAIN_TIMEOUT_MS)
        .then(() => process.exit(0))
        .catch(() => process.exit(0));

      // Backstop, in case a socket or an in-flight scan refuses to settle.
      setTimeout(() => process.exit(0), DRAIN_TIMEOUT_MS + 4000).unref();
    });
  }
}
