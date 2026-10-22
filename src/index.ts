import { localInterfaces } from './lan.js';
import { discoverAll } from './discovery.js';
import { ENROLL_CODE_HINT, isValidEnrollCode, normalizeEnrollCode } from './enroll-code.js';
import { registerStopper } from './lifecycle.js';
import { log } from './log.js';
import { diagIntervalMs, startDiagnostics } from './diagnostics.js';
import { enroll, isRelayRejected, isRelayRunning, relayDiagnostics, relayStatus, startRelay } from './relay.js';
import { createWatchdog, watchdogLimitMs } from './watchdog.js';
import { startPairing } from './pairing.js';
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
  PRINT_BRIDGE_CONNECT_TIMEOUT_MS  Time a network printer gets to accept a connection
                                (default 5000)
  PRINT_BRIDGE_SERVICE_CONTROL  on | off. 'off' removes the /service routes and the
                                "This computer" card from the page.       (default on)
  PRINT_BRIDGE_MANAGED          What supervises this process, stamped by the installer:
                                launchd-daemon | launchd-agent | scheduled-task | systemd |
                                container. Worked out by probing when unset.

Endpoints:
  GET  /         a status page for a browser: printers, queue, addresses, recent jobs
  GET  /health   liveness, identity, version and this machine's networks
  GET  /status   printers online/offline, queue depth, transports, relay
  POST /probe    { ip, port? }                  can the bridge reach this printer?
  POST /scan     { port? }                      sweep this machine's subnets for printers
  POST /discover { port?, network? }            every printer this machine can see
  POST /print    { ip, port, payload_base64 }   print now, and wait for the answer
  POST /jobs     { printer_id | target, receipt | label | payload_base64 }
  GET  /jobs, GET /jobs/:id, POST /jobs/:id/cancel
  GET  /printers, PUT /printers, POST /printers/:id/test, POST /printers/:id/identify
  GET  /service  what supervises this bridge, where its files are, and what may be done
  GET  /service/cache, POST /service/{restart,autostart,uninstall,reboot,cache}
                 loopback only, origin-pinned, and each needs a confirmation from /service`);
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
  const given = args[enrollAt + 1];
  if (!given || given.startsWith('-')) {
    console.error('--enroll needs a code, e.g. `hankha-print-bridge --enroll ABCD-2345`');
    process.exit(2);
  }
  // Folded and checked before it is sent, exactly as the pairing page does. Argv used to go
  // upstream verbatim, so a pasted lowercase code was hashed to something the API had never
  // minted and came back as "not valid" — the same sentence a genuinely wrong code gets, and
  // the reason a correct code could look like the wrong one.
  const code = normalizeEnrollCode(given);
  if (!isValidEnrollCode(code)) {
    console.error(ENROLL_CODE_HINT);
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

  log.info(`starting ${BRIDGE_SERVICE} v${BRIDGE_VERSION}`, {
    event: 'app.starting', version: BRIDGE_VERSION, pid: process.pid, platform: process.platform,
    arch: process.arch,
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
  });
  // The settings that shape connection and printing behaviour, as this process actually resolved
  // them. Support otherwise has to guess what a venue's bridge.env said. Nothing secret: the
  // token is reported only as whether one is set.
  log.info('config: effective settings', {
    event: 'app.config', host: HOST, port: PORT,
    log_level: process.env.PRINT_BRIDGE_LOG_LEVEL?.trim() || 'info',
    log_format: process.env.PRINT_BRIDGE_LOG_FORMAT?.trim() || 'text',
    relay_transport: process.env.PRINT_BRIDGE_RELAY_TRANSPORT?.trim() || 'auto',
    heartbeat_ms: process.env.PRINT_BRIDGE_HEARTBEAT_MS?.trim() || undefined,
    ack_timeout_ms: process.env.PRINT_BRIDGE_ACK_TIMEOUT_MS?.trim() || undefined,
    watchdog_ms: watchdogLimitMs(),
    send_timeout_ms: process.env.PRINT_BRIDGE_SEND_TIMEOUT_MS?.trim() || undefined,
    connect_timeout_ms: process.env.PRINT_BRIDGE_CONNECT_TIMEOUT_MS?.trim() || undefined,
    sync_timeout_ms: process.env.PRINT_BRIDGE_SYNC_TIMEOUT_MS?.trim() || undefined,
    diag_interval_ms: diagIntervalMs(),
    managed: process.env.PRINT_BRIDGE_MANAGED?.trim() || undefined,
    auth_required: Boolean(process.env.PRINT_BRIDGE_TOKEN?.trim()),
    tls: isTlsEnabled(),
  });

  const server = createBridgeServer();

  // Installed as a service, the only trace of a failed start is this line in the log file — so
  // say which address was refused rather than dumping a bare stack trace.
  server.on('error', (err: NodeJS.ErrnoException) => {
    const fields = { event: 'server.listen_failed', host: HOST, port: PORT, err };
    if (err.code === 'EADDRINUSE') {
      log.error(
        `Port ${PORT} is already in use — another copy of the print bridge (or some other app) ` +
          `is running. Stop it, or set PRINT_BRIDGE_PORT to a free port.`,
        fields
      );
    } else if (err.code === 'EADDRNOTAVAIL' || err.code === 'EACCES') {
      log.error(`Cannot bind ${HOST}:${PORT} — ${err.code}. Check PRINT_BRIDGE_HOST.`, fields);
    } else {
      log.error(`Print bridge failed to start: ${err.message}`, { ...fields, expected: false });
    }
    process.exit(1);
  });

  // Started once the port is ours, alongside the relay; stopped by `stop()`.
  let diagnostics: ReturnType<typeof startDiagnostics> | null = null;

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
    // The one line in this banner an operator can act on: everything else here is for whoever
    // reads the log file afterwards, and this is where they find out there is a page at all.
    log.info(`  open ${scheme}://localhost:${PORT} in a browser to see printers, queue and jobs`, {
      event: 'server.page', url: `${scheme}://localhost:${PORT}`,
    });

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

    // Started only once the port is ours: a second copy that loses `EADDRINUSE` must not have
    // already sent a heartbeat or claimed work on its way out.
    // The outbound half: dial the cloud API and wait for jobs, so a phone or a till on mobile data
    // can print through this bridge without reaching the LAN itself. A no-op (with one log line)
    // until this bridge holds a credential, so an existing LAN-only install is unaffected.
    startRelay();

    // The other outbound half, and the only one a brand-new install exercises: announce this
    // machine to the API and put a code on screen for a tablet to scan. Returns immediately when
    // a credential already exists, so the two are safe to call unconditionally and in this order
    // — `startRelay` gets first refusal on an already-paired bridge.
    startPairing();

    diagnostics = startDiagnostics();
    log.info(`ready in ${Math.round(process.uptime() * 1000)}ms`, {
      event: 'app.ready', startup_ms: Math.round(process.uptime() * 1000),
    });
  });

  // Reads the spool back and resumes anything a previous run left behind, before the first request
  // can add to it. `queue()` loads on creation; this call is what forces that to happen HERE
  // rather than lazily inside the first request, and `load()` is idempotent so the two cannot
  // race into a double recovery.
  queue().load();


  /*
   * Survive an unexpected throw instead of vanishing.
   *
   * Node's default for an unhandled rejection is to end the process, and this one is a printer
   * daemon with no window: it comes back only when launchd or Task Scheduler notices, and the
   * operator's evidence is a till that has stopped printing. `runRoute` in server.ts already
   * answers the request that caused it — these are the backstop for everything off the request
   * path (a relay dispatch, a queue lane, a transport callback), where the right move is to log
   * loudly and keep taking print jobs rather than take the venue down over one bad frame.
   */
  process.on('unhandledRejection', (reason) => {
    log.error(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`, {
      event: 'process.unhandled_rejection', err: reason, expected: false,
    });
  });
  process.on('uncaughtException', (err) => {
    log.error(`uncaught exception: ${err.message}`, { event: 'process.uncaught_exception', err, expected: false });
  });
  // The last line any process writes. Paired with `server.shutdown`, it tells a clean stop from a
  // crash (no shutdown line) and a watchdog restart (exit 1) apart from a service stop (exit 0).
  process.on('exit', (code) => {
    log.info(`exiting with code ${code} after ${Math.round(process.uptime())}s`, {
      event: 'process.exit', code, uptime_s: Math.round(process.uptime()),
    });
  });

  /*
   * One graceful stop, three callers: SIGINT, SIGTERM, and `POST /service/restart`.
   *
   * launchd and Task Scheduler both stop the process with a signal, and exiting cleanly keeps a
   * restart from being logged as a crash. The restart route needs exactly this sequence too, so
   * it is registered rather than reimplemented — see lifecycle.ts.
   *
   * `exitCode` is not decoration on Windows: a scheduled task that ends CLEANLY is not restarted
   * by `-RestartInterval`, which only fires when the task ends in error. Exiting 1 is what the
   * restart route falls back to when it could not write its respawn helper.
   */
  let shuttingDown = false;
  const stop = (exitCode: number, why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // The relay is not closed here — the process exit ends it — so the server sees this as an
    // abnormal close. Recording the session that was open is what lets the two logs be matched.
    const relay = relayDiagnostics();
    log.info(`${BRIDGE_SERVICE} shutting down`, {
      event: 'server.shutdown', signal: why, exitCode, uptime_s: Math.round(process.uptime()),
      relay_connected: relay.connected, connection_id: relay.connection_id ?? undefined,
      queue_pending: queue().pending(),
    });
    diagnostics?.stop();

    server.close();
    // Let the write already on the wire finish. Jobs still WAITING are left on disk on purpose:
    // they resume next start, and printing a backlog during a restart is how a service bounce
    // turns into a paper jam.
    const drainStartedAt = Date.now();
    void queue()
      .drain(DRAIN_TIMEOUT_MS)
      .then(() => {
        log.info(`queue drained in ${Date.now() - drainStartedAt}ms`, {
          event: 'server.drain', duration_ms: Date.now() - drainStartedAt, pending_left: queue().pending(),
        });
        process.exit(exitCode);
      })
      .catch((err: unknown) => {
        log.error('draining the queue failed during shutdown', { event: 'server.drain_failed', err, expected: false });
        process.exit(exitCode);
      });

    // Backstop, in case a socket or an in-flight scan refuses to settle.
    setTimeout(() => {
      log.warn(`shutdown did not finish within ${(DRAIN_TIMEOUT_MS + 4000) / 1000}s — forcing exit`, {
        event: 'server.shutdown_timeout', timeout_ms: DRAIN_TIMEOUT_MS + 4000, pending_left: queue().pending(),
      });
      process.exit(exitCode);
    }, DRAIN_TIMEOUT_MS + 4000).unref();
  };

  registerStopper((exitCode) => stop(exitCode, 'service-request'));

  createWatchdog({
    limitMs: watchdogLimitMs(),
    probe: () => {
      const st = relayStatus();
      return { enrolled: st.enrolled, connected: st.connected, rejected: isRelayRejected(), running: isRelayRunning() };
    },
    // Exit code 1: a Windows scheduled task only restarts on failure (see above).
    exit: (reason) => stop(1, `watchdog: ${reason}`),
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => stop(0, signal));
  }
}
