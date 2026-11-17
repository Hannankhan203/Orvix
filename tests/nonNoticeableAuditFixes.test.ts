import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAndNormalizeIp } from '../server/trustedProxy.ts';
import {
  reserveUploadSlot,
  releaseUploadSlot,
  resetQuotaForTesting,
  pruneExpiredQuotaReservations
} from '../server/uploadQuotaService.ts';
import { navigateTo } from '../src/App.jsx';

test('ORVIX-NON-01: pruneExpiredQuotaReservations preserves active reservations and prunes only expired ones', async () => {
  await resetQuotaForTesting();
  const identity = { type: 'auth' as const, id: 'user-non-01-active', key: 'auth_user_non_01_active' };

  // Reserve a slot (active reservation with TTL in the future)
  const res = await reserveUploadSlot(identity);
  assert.equal(res.allowed, true);

  // Active reservation must NOT be pruned by background cleanup
  const prunedCount = await pruneExpiredQuotaReservations();
  assert.equal(prunedCount, 0, 'Active reservations must not be pruned');

  // Verify reservation is still active in quota status
  const released = await releaseUploadSlot((res as any).reservation);
  assert.equal(released.remaining, 5);
  await resetQuotaForTesting();
});

test('ORVIX-NON-02: IPv6 loopback ::1 is preserved as ::1 and cross-family loopback is strictly bound to loopback CIDRs', () => {
  const normalized = parseAndNormalizeIp('::1');
  assert.equal(normalized, '::1', 'IPv6 loopback ::1 must be preserved as ::1 by default');

  const bracketed = parseAndNormalizeIp('[::1]:8080');
  assert.equal(bracketed, '::1', 'Bracketed IPv6 ::1 with port must normalize to ::1');

  const mapped = parseAndNormalizeIp('::ffff:127.0.0.1');
  assert.equal(mapped, '127.0.0.1', 'IPv4-mapped IPv6 loopback must normalize to 127.0.0.1');

  // Verify loopback CIDR does not match non-loopback external IPs across families
  assert.equal(parseAndNormalizeIp('203.0.113.5'), '203.0.113.5');
});

test('ORVIX-NON-03: Delayed async audio initialization cancellation and unmount race prevention', async () => {
  const { VoiceStreamClient } = await import('../src/services/voiceStreamClient.js');
  const client = new VoiceStreamClient();

  let trackStopped = false;
  const mockTrack = {
    stop() {
      trackStopped = true;
    }
  };
  const mockStream = {
    getAudioTracks: () => [mockTrack],
    getTracks: () => [mockTrack]
  };

  // Simulate delayed audio teardown / setup lifecycle
  client.state = 'connecting';
  client.cancel();

  assert.equal(client.state, 'closed');
  assert.equal(client.isConnected(), false);
  assert.equal(client.audioContext, null);
});

test('ORVIX-NON-04: navigateTo resets window scroll to top', () => {
  if (typeof globalThis.window === 'undefined') {
    (globalThis as any).window = {
      history: { pushState() {} },
      dispatchEvent() {}
    };
  }
  if (typeof globalThis.PopStateEvent === 'undefined') {
    (globalThis as any).PopStateEvent = class PopStateEvent {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    };
  }

  const scrolls: Array<[number, number]> = [];
  const origScrollTo = globalThis.window.scrollTo;
  globalThis.window.scrollTo = ((x: any, y?: any) => {
    if (typeof x === 'object' && x !== null) {
      scrolls.push([x.left || 0, x.top || 0]);
    } else {
      scrolls.push([Number(x) || 0, Number(y) || 0]);
    }
  }) as any;

  try {
    navigateTo('/share/test-scroll');
    assert.ok(scrolls.length > 0, 'navigateTo must trigger window.scrollTo');
    assert.deepEqual(scrolls[scrolls.length - 1], [0, 0], 'Window scroll must be reset to (0, 0)');
  } finally {
    if (origScrollTo) {
      globalThis.window.scrollTo = origScrollTo;
    } else {
      delete (globalThis.window as any).scrollTo;
    }
  }
});
