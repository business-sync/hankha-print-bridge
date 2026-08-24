# hankha-print-bridge

Local LAN helper that lets the POS terminal (a browser PWA, which cannot open a raw TCP socket)
print to a network ESC/POS printer. Run this on a PC on the venue's LAN; the POS terminal talks
to it over HTTP, and it opens the real TCP connection to the printer's IP:port.

## Run

```bash
npm install
npm run dev     # tsx watch, port 9200 by default
```

or build once and run the compiled output:

```bash
npm run build
npm start
```

Override the port with `PRINT_BRIDGE_PORT`. On start it prints every LAN address it can be
reached at — use one of those as the bridge URL on terminals other than this PC.

```bash
npm test          # node:test, no test framework dependency
```

## API

- `GET /health` → `{ ok, service: "hankha-print-bridge", version, interfaces: [{ address, cidr }] }`.
  `service` lets the terminal tell a real bridge from some other app answering on that port;
  `interfaces` lets it warn when a configured printer sits on a different network.
- `POST /probe` — body `{ ip, port? }` (port defaults to 9100) →
  `{ ok, reachable, latency_ms, reason? }` with `reason: "timeout" | "refused" | "unreachable"`.
  Opens a TCP connection and drops it **without writing** — a printer that receives stray bytes
  prints garbage. `refused` means a device is alive there but that port is closed (right host,
  wrong port); `timeout` means nothing answered at all.
- `POST /scan` — body `{ port? }` → `{ ok, subnets, duration_ms, printers: [{ ip, port, latency_ms }] }`.
  Sweeps every address on this machine's own subnets, so an operator can pick a printer from a
  list instead of typing an IP. Each interface is clamped to the /24 around its own address
  (a /16 would mean 65k connect attempts), 64 sockets in parallel, 500 ms per host — about
  2 seconds for a typical venue. Concurrent callers share one run.
- `POST /print` — body `{ ip, port, payload_base64 }`. Opens a TCP socket to `ip:port`, writes the
  decoded bytes, closes it. Responds `{ ok: true }` or
  `{ ok: false, reason: "connect-refused" | "timeout" | "invalid-body" | "invalid-payload" }`.

Every endpoint that dials an address refuses anything outside RFC1918 private space. CORS is `*`
(the terminal's origin varies too much to pin down), so that restriction is what stops a random
page from using the bridge to scan the public internet from inside the venue's network.

## Scope

This process only forwards bytes — it has no printer-specific logic (that's built into the POS
terminal's ESC/POS payload before it gets here) and no persistence. Packaging it as an
autostarting service (Windows service, macOS launchd, etc.) for a real venue deployment is a
separate follow-up.
