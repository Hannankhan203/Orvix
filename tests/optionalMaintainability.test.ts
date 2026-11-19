import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatBytes,
  ALLOWED_EXTENSIONS_MAP,
  parseImageDimensions,
  verifyFileSignature
} from '../server/uploadFileValidation.ts';
import * as uploadSubsystem from '../server/uploadSubsystem.ts';
import { formatResponseTime, formatLiveElapsed } from '../src/utils/formatResponseTime.ts';

test('OPTIONAL-01: uploadSubsystem re-exports uploadFileValidation symbols with identical references', () => {
  assert.strictEqual(uploadSubsystem.formatBytes, formatBytes);
  assert.strictEqual(uploadSubsystem.ALLOWED_EXTENSIONS_MAP, ALLOWED_EXTENSIONS_MAP);
  assert.strictEqual(uploadSubsystem.parseImageDimensions, parseImageDimensions);
  assert.strictEqual(uploadSubsystem.verifyFileSignature, verifyFileSignature);
});

test('OPTIONAL-01: formatBytes formats byte sizes consistently', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-50), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 2.5), '2.5 MB');
});

test('OPTIONAL-01: parseImageDimensions parses PNG and GIF binary headers', () => {
  const pngBuf = Buffer.alloc(24);
  pngBuf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  pngBuf.writeUInt32BE(640, 16);
  pngBuf.writeUInt32BE(480, 20);
  assert.deepEqual(parseImageDimensions(pngBuf, '.png'), { width: 640, height: 480 });

  const gifBuf = Buffer.alloc(10);
  gifBuf.write('GIF89a', 0, 'ascii');
  gifBuf.writeUInt16LE(320, 6);
  gifBuf.writeUInt16LE(200, 8);
  assert.deepEqual(parseImageDimensions(gifBuf, '.gif'), { width: 320, height: 200 });
});

test('OPTIONAL-01: verifyFileSignature validates valid files and rejects spoofed/executable files', async () => {
  const emptyRes = await verifyFileSignature(Buffer.alloc(0), '.txt');
  assert.equal(emptyRes.valid, false);

  const elfBuf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
  const elfRes = await verifyFileSignature(elfBuf, '.txt');
  assert.equal(elfRes.valid, false);
  assert.match(elfRes.reason || '', /ELF/);

  const peBuf = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
  const peRes = await verifyFileSignature(peBuf, '.pdf');
  assert.equal(peRes.valid, false);
  assert.match(peRes.reason || '', /Windows PE/);

  const pdfRes = await verifyFileSignature(Buffer.from('%PDF-1.7\n%test'), '.pdf');
  assert.equal(pdfRes.valid, true);

  const badPdfRes = await verifyFileSignature(Buffer.from('not a pdf'), '.pdf');
  assert.equal(badPdfRes.valid, false);

  const jsonRes = await verifyFileSignature(Buffer.from('{"ok": true}'), '.json');
  assert.equal(jsonRes.valid, true);

  const nullTextRes = await verifyFileSignature(Buffer.from([0x68, 0x69, 0x00, 0x21]), '.txt');
  assert.equal(nullTextRes.valid, false);

  const pngBuf = Buffer.alloc(24);
  pngBuf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  pngBuf.writeUInt32BE(128, 16);
  pngBuf.writeUInt32BE(64, 20);
  const pngRes = await verifyFileSignature(pngBuf, '.png');
  assert.equal(pngRes.valid, true);
  assert.deepEqual(pngRes.dimensions, { width: 128, height: 64 });
});

test('OPTIONAL-02: formatResponseTime formats milliseconds, fractional seconds, minutes, and hours', () => {
  assert.equal(formatResponseTime(null), null);
  assert.equal(formatResponseTime(undefined), null);
  assert.equal(formatResponseTime(0), null);
  assert.equal(formatResponseTime(-100), null);
  assert.equal(formatResponseTime(Number.NaN), null);

  assert.equal(formatResponseTime(40), '0.1s');
  assert.equal(formatResponseTime(850), '0.9s');
  assert.equal(formatResponseTime(4800), '4.8s');
  assert.equal(formatResponseTime(8.7), '8.7s');
  assert.equal(formatResponseTime(68000), '1m 08s');
  assert.equal(formatResponseTime(135000), '2m 15s');
  assert.equal(formatResponseTime(3725000), '1h 02m 05s');
});

test('OPTIONAL-02: formatLiveElapsed formats continuous mm:ss and hh:mm:ss durations', () => {
  assert.equal(formatLiveElapsed(0), '00:00');
  assert.equal(formatLiveElapsed(-5), '00:00');

  const base = 1_700_000_000_000;
  assert.equal(formatLiveElapsed(base, base), '00:00');
  assert.equal(formatLiveElapsed(base, base + 59_000), '00:59');
  assert.equal(formatLiveElapsed(base, base + 65_000), '01:05');
  assert.equal(formatLiveElapsed(base, base + 3_725_000), '01:02:05');
});
