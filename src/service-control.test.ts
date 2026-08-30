import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import {
  beginAction,
  consumeConfirmToken,
  currentAction,
  endAction,
  gateServiceRequest,
  issueConfirmToken,
  resetConfirmTokens,
  serviceControlEnabled,
} from './service-control.js';

/*
 * These are the tests that keep the escalation closed.
 *
 * Every other route on this bridge is CORS-open to the venue LAN, which is a fine trade for
 * printing and an unacceptable one for rebooting a till. If any assertion in this file stops
 * holding, a web page an operator happens to open could reach `/service/*` — so treat a failure
 * here as a security regression rather than a test to relax.
 */

function request(headers: Record<string, string> = {}): IncomingMessage {
  return { headers: { host: '127.0.0.1:9200', ...headers } } as unknown as IncomingMessage;
}

const allow = { loopback: true, mutating: true };

afterEach(() => {
  resetConfirmTokens();
  endAction();
  delete process.env.PRINT_BRIDGE_SERVICE_CONTROL;
});

describe('the /service gate', () => {
  it('lets a same-origin request from this machine through', () => {
    assert.equal(gateServiceRequest(request(), allow), null);
    assert.equal(
      gateServiceRequest(
        request({ origin: 'http://localhost:9200', 'sec-fetch-site': 'same-origin' }),
        allow
      ),
      null
    );
  });

  it('refuses anything that did not arrive on loopback', () => {
    assert.deepEqual(gateServiceRequest(request(), { loopback: false, mutating: true }), {
      status: 403,
      reason: 'not-loopback',
    });
  });

  it('refuses a Host header that is not this machine, which is what DNS rebinding sends', () => {
    // The attack this exists for: evil.example resolves to 127.0.0.1, so the socket IS loopback
    // and the Origin IS the attacker's own page — but the Host header gives it away.
    assert.deepEqual(gateServiceRequest(request({ host: 'evil.example' }), allow), {
      status: 403,
      reason: 'bad-host',
    });
    assert.deepEqual(gateServiceRequest(request({ host: 'bridge.local:9200' }), allow), {
      status: 403,
      reason: 'bad-host',
    });
  });

  it('accepts every shape of a local Host header', () => {
    for (const host of ['localhost', 'localhost:9200', '127.0.0.1:9200', '127.1.2.3', '[::1]:9200']) {
      assert.equal(gateServiceRequest(request({ host }), allow), null, host);
    }
  });

  it('refuses a cross-origin post, including the form POST that skips a preflight', () => {
    assert.deepEqual(gateServiceRequest(request({ origin: 'https://evil.example' }), allow), {
      status: 403,
      reason: 'cross-origin',
    });
  });

  it('refuses a cross-site fetch even when its Origin is missing', () => {
    assert.deepEqual(gateServiceRequest(request({ 'sec-fetch-site': 'cross-site' }), allow), {
      status: 403,
      reason: 'cross-site',
    });
    assert.deepEqual(gateServiceRequest(request({ 'sec-fetch-site': 'same-site' }), allow), {
      status: 403,
      reason: 'cross-site',
    });
  });

  it('disappears entirely when a fleet turns it off', () => {
    process.env.PRINT_BRIDGE_SERVICE_CONTROL = 'off';
    assert.equal(serviceControlEnabled(), false);
    // 404, not 403: a bridge with the family switched off should look like one that never had it.
    assert.deepEqual(gateServiceRequest(request(), allow), { status: 404, reason: 'not-found' });
  });

  it('stays on for anything but an explicit off, so a typo cannot disable it', () => {
    process.env.PRINT_BRIDGE_SERVICE_CONTROL = 'yes please';
    assert.equal(serviceControlEnabled(), true);
  });
});

describe('confirmations', () => {
  it('accepts a minted token exactly once', () => {
    const { confirm_token } = issueConfirmToken();
    assert.equal(consumeConfirmToken(confirm_token), true);
    // The reason this matters: a captured confirmation is worth one action the operator already
    // intended, never a second one they did not.
    assert.equal(consumeConfirmToken(confirm_token), false);
  });

  it('rejects anything it did not mint', () => {
    issueConfirmToken();
    assert.equal(consumeConfirmToken('0'.repeat(32)), false);
    assert.equal(consumeConfirmToken(''), false);
    assert.equal(consumeConfirmToken(undefined), false);
    assert.equal(consumeConfirmToken(42), false);
  });

  it('keeps several alive at once, so the poll cannot invalidate the one in use', () => {
    // The page fetches /service on a ten-second timer AND once more just before it submits. With
    // a single slot those two race and the operator's button fails for no visible reason.
    const first = issueConfirmToken().confirm_token;
    const second = issueConfirmToken().confirm_token;
    assert.equal(consumeConfirmToken(first), true);
    assert.equal(consumeConfirmToken(second), true);
  });
});

describe('one action at a time', () => {
  it('refuses a second action while one is running, and names it', () => {
    assert.equal(beginAction('restart'), true);
    assert.equal(beginAction('reboot'), false);
    assert.equal(currentAction(), 'restart');
    endAction();
    assert.equal(currentAction(), null);
    assert.equal(beginAction('reboot'), true);
  });
});
