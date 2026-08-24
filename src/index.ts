import { localInterfaces } from './lan.js';
import { createBridgeServer } from './server.js';
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
  -v, --version   Print the version and exit
  -h, --help      Print this help and exit

Environment:
  PRINT_BRIDGE_PORT   TCP port to listen on               (default ${DEFAULT_PORT})
  PRINT_BRIDGE_HOST   Address to bind                     (default ${DEFAULT_HOST})
                      Set to 127.0.0.1 to accept only connections from this machine.

Endpoints:
  GET  /health   liveness, identity, version and this machine's networks
  POST /probe    { ip, port? }            can the bridge reach this printer?
  POST /scan     { port? }                sweep this machine's subnets for printers
  POST /print    { ip, port, payload_base64 }`);
  process.exit(0);
}

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

// launchd and Task Scheduler both stop the process with a signal; exiting cleanly keeps a
// restart from being logged as a crash.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Don't let an in-flight scan (up to ~2s per subnet) hold shutdown open indefinitely.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
