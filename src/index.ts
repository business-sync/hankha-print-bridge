import { localInterfaces } from './lan.js';
import { enroll, startRelay } from './relay.js';
import { createBridgeServer } from './server.js';
import { statePath } from './identity.js';
import { BRIDGE_SERVICE, BRIDGE_VERSION } from './version.js';

const DEFAULT_PORT = 9200;
/**
 * Every interface by default — unchanged from the days when one bridge on a venue PC served
 * several tills. The installers override this to `127.0.0.1`, because a POS served over https
 * can only reach a bridge on loopback anyway (mixed content blocks every other address), so on
 * a real till there is nothing to gain from listening wider.
 */
const DEFAULT_HOST = '0.0.0.0';

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(BRIDGE_VERSION);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`${BRIDGE_SERVICE} v${BRIDGE_VERSION}

Forwards POS print jobs to a network (ESC/POS-over-TCP) printer. A browser cannot open a raw
TCP socket, so the POS terminal POSTs its bytes here and this dials the printer's IP:port.

Usage: hankha-print-bridge [options]

Options:
  -v, --version      Print the version and exit
  -h, --help         Print this help and exit
  --enroll <code>    Redeem an enrollment code from Settings > Printing, then exit.
                     Links this bridge to your organization so the POS can send it jobs
                     from any device, including a phone.

Environment:
  PRINT_BRIDGE_PORT   TCP port to listen on               (default ${DEFAULT_PORT})
  PRINT_BRIDGE_HOST   Address to bind                     (default ${DEFAULT_HOST})
                      Set to 127.0.0.1 to accept only connections from this machine.
  PRINT_BRIDGE_RELAY_URL   Cloud API to poll for jobs    (default https://api.hankha.la)
  PRINT_BRIDGE_STATE_DIR   Where to keep relay.json      (default per-OS, see --enroll)

Endpoints:
  GET  /health   liveness, identity, version and this machine's networks
  POST /probe    { ip, port? }            can the bridge reach this printer?
  POST /scan     { port? }                sweep this machine's subnets for printers
  POST /print    { ip, port, payload_base64 }`);
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
} else {
  runService();
}

function runService(): void {
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
  console.log(`${BRIDGE_SERVICE} v${BRIDGE_VERSION} listening on http://${HOST}:${PORT}`);
  if (HOST === '127.0.0.1' || HOST === 'localhost') {
    // Not a warning — this is the intended setup on a till, and saying so out loud stops
    // someone "fixing" it when another terminal can't connect.
    console.log('  bound to loopback: only this computer can reach the bridge');
  } else {
    // The operator needs this to point other terminals at the right address, and it's the
    // fastest way to spot "the printers are on a different network than this PC".
    for (const iface of localInterfaces()) {
      console.log(`  reachable on this LAN at http://${iface.address}:${PORT}  (${iface.cidr})`);
    }
  }
});

// The outbound half: dial the cloud API and long-poll for jobs, so a phone or a till on
// mobile data can print through this bridge without reaching the LAN itself. A no-op (with one
// log line) until someone runs `--enroll`, so an existing LAN-only install is unaffected.
startRelay();

// launchd and Task Scheduler both stop the process with a signal; exiting cleanly keeps a
// restart from being logged as a crash.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Don't let an in-flight scan (up to ~2s per subnet) hold shutdown open indefinitely.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
}
