import net from 'net';
import type express from 'express';
import type { IncomingMessage } from 'http';

export type TrustProxyMode =
  | 'disabled'
  | 'hops'
  | 'allowlist'
  | 'platform-vercel'
  | 'platform-cloud-run';

export interface CidrRange {
  family: 4 | 6;
  network: bigint;
  maskBits: number;
}

export interface TrustedProxyPolicy {
  mode: TrustProxyMode;
  hops: number;
  cidrs: CidrRange[];
  configuredSource: string;
}

const LOOPBACK_CIDRS = ['127.0.0.0/8', '::1/128'];
const LINKLOCAL_CIDRS = ['169.254.0.0/16', 'fe80::/10'];
const UNIQUELOCAL_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'];

let lastInvalidProxyConfigWarningMs = 0;

function warnProxyConfigThrottled(msg: string): void {
  const now = Date.now();
  if (now - lastInvalidProxyConfigWarningMs > 30_000) {
    lastInvalidProxyConfigWarningMs = now;
    console.warn(msg);
  }
}

/**
 * Normalizes a raw IP token (stripping brackets, ports, IPv4-mapped IPv6 prefixes, and zone IDs)
 * and validates it strictly via Node's `net.isIP`. Returns null if invalid.
 */
export function parseAndNormalizeIp(
  rawValue: unknown,
  preserveIpv6Loopback = false
): string | null {
  if (typeof rawValue !== 'string') return null;
  let candidate = rawValue.trim();
  if (!candidate || candidate.length > 128) return null;

  // Strip surrounding quotes if present
  if (
    (candidate.startsWith('"') && candidate.endsWith('"')) ||
    (candidate.startsWith("'") && candidate.endsWith("'"))
  ) {
    candidate = candidate.slice(1, -1).trim();
  }

  // Handle bracketed IPv6 e.g. "[2001:db8::1]:8443" or "[::1]"
  if (candidate.startsWith('[')) {
    const closeIdx = candidate.indexOf(']');
    if (closeIdx === -1) return null;
    candidate = candidate.slice(1, closeIdx).trim();
  } else {
    // Handle IPv4 with port e.g. "203.0.113.5:54321"
    const firstColon = candidate.indexOf(':');
    const lastColon = candidate.lastIndexOf(':');
    if (firstColon !== -1 && firstColon === lastColon) {
      const possibleHost = candidate.slice(0, firstColon);
      const possiblePort = candidate.slice(firstColon + 1);
      if (net.isIPv4(possibleHost) && /^\d{1,5}$/.test(possiblePort)) {
        candidate = possibleHost;
      }
    }
  }

  // Strip IPv6 zone index e.g. "fe80::1%eth0"
  const zoneIdx = candidate.indexOf('%');
  if (zoneIdx !== -1) {
    candidate = candidate.slice(0, zoneIdx);
  }

  // Normalize IPv4-mapped IPv6 prefix
  if (candidate.toLowerCase().startsWith('::ffff:')) {
    const mapped = candidate.slice(7);
    if (net.isIPv4(mapped)) {
      candidate = mapped;
    }
  }

  const family = net.isIP(candidate);
  if (family === 0) {
    return null;
  }

  if (candidate === '::1' && !preserveIpv6Loopback) {
    return '127.0.0.1';
  }

  return family === 6 ? candidate.toLowerCase() : candidate;
}

function ipv4ToBigInt(ip: string): bigint {
  const parts = ip.split('.');
  let result = 0n;
  for (const part of parts) {
    result = (result << 8n) + BigInt(Number(part));
  }
  return result;
}

function expandIpv6ToBigInt(ip: string): bigint {
  // Handle embedded IPv4 suffix if present (e.g. ::ffff:192.0.2.128)
  let working = ip;
  const lastColon = working.lastIndexOf(':');
  if (lastColon !== -1 && working.slice(lastColon + 1).includes('.')) {
    const ipv4Part = working.slice(lastColon + 1);
    const v4 = ipv4ToBigInt(ipv4Part);
    const hi = Number((v4 >> 16n) & 0xffffn).toString(16);
    const lo = Number(v4 & 0xffffn).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const [leftRaw, rightRaw] = working.split('::');
  const leftParts = leftRaw ? leftRaw.split(':').filter(Boolean) : [];
  const rightParts = rightRaw !== undefined && rightRaw !== '' ? rightRaw.split(':').filter(Boolean) : [];
  const missing = 8 - (leftParts.length + rightParts.length);
  const fullParts = [
    ...leftParts,
    ...Array(Math.max(0, missing)).fill('0'),
    ...rightParts
  ];

  let result = 0n;
  for (const part of fullParts) {
    result = (result << 16n) + BigInt(parseInt(part || '0', 16));
  }
  return result;
}

function ipToBigInt(ip: string, preserveIpv6Loopback = false): { family: 4 | 6; value: bigint } | null {
  const normalized = parseAndNormalizeIp(ip, preserveIpv6Loopback);
  if (!normalized) return null;
  const family = net.isIP(normalized);
  if (family === 4) {
    return { family: 4, value: ipv4ToBigInt(normalized) };
  }
  if (family === 6) {
    return { family: 6, value: expandIpv6ToBigInt(normalized) };
  }
  return null;
}

function parseCidrToken(token: string): CidrRange | null {
  const trimmed = token.trim();
  if (!trimmed) return null;

  const slashIdx = trimmed.indexOf('/');
  if (slashIdx === -1) {
    const normalized = parseAndNormalizeIp(trimmed, true);
    if (!normalized) return null;
    const parsed = ipToBigInt(normalized, true);
    if (!parsed) return null;
    return {
      family: parsed.family,
      network: parsed.value,
      maskBits: parsed.family === 4 ? 32 : 128
    };
  }

  const ipPart = trimmed.slice(0, slashIdx).trim();
  const prefixRaw = trimmed.slice(slashIdx + 1).trim();
  if (!/^\d{1,3}$/.test(prefixRaw)) return null;

  const normalized = parseAndNormalizeIp(ipPart, true);
  if (!normalized) return null;
  const parsed = ipToBigInt(normalized, true);
  if (!parsed) return null;

  const maxBits = parsed.family === 4 ? 32 : 128;
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxBits) {
    return null;
  }

  const shift = BigInt(maxBits - prefix);
  const maskedNetwork = prefix === 0 ? 0n : (parsed.value >> shift) << shift;

  return {
    family: parsed.family,
    network: maskedNetwork,
    maskBits: prefix
  };
}

function isIpInCidr(ip: string, range: CidrRange): boolean {
  const parsed = ipToBigInt(ip);
  if (!parsed) return false;

  // Treat 127.0.0.1 as matching ::1/128 if checked against IPv6 loopback or 127.0.0.0/8
  if (parsed.family !== range.family) {
    if (ip === '127.0.0.1' && range.family === 6 && range.network === 1n && range.maskBits === 128) {
      return true;
    }
    return false;
  }

  const totalBits = parsed.family === 4 ? 32 : 128;
  const shift = BigInt(totalBits - range.maskBits);
  const masked = range.maskBits === 0 ? 0n : (parsed.value >> shift) << shift;
  return masked === range.network;
}

export function isIpInCidrList(ip: string, cidrs: CidrRange[]): boolean {
  return cidrs.some((range) => isIpInCidr(ip, range));
}

/**
 * Resolves the trusted reverse-proxy policy from explicit environment configuration
 * (`TRUST_PROXY` / `ORVIX_TRUST_PROXY`) or the verified deployment platform topology.
 *
 * Security defaults:
 * - Unconfigured standalone / local server: `disabled` (never trusts client-supplied `X-Forwarded-For`).
 * - Vercel (`VERCEL=1` / `VERCEL_ENV`): trusts Vercel Edge proxy headers (`x-vercel-forwarded-for`, 1 hop).
 * - Google Cloud Run (`K_SERVICE`): trusts 1 proxy hop from the right of `X-Forwarded-For`.
 */
export function resolveTrustedProxyPolicy(): TrustedProxyPolicy {
  const rawExplicit = process.env.TRUST_PROXY ?? process.env.ORVIX_TRUST_PROXY;
  if (typeof rawExplicit === 'string' && rawExplicit.trim()) {
    const trimmed = rawExplicit.trim();
    const lower = trimmed.toLowerCase();

    if (lower === 'false' || lower === '0' || lower === 'off' || lower === 'no' || lower === 'none') {
      return {
        mode: 'disabled',
        hops: 0,
        cidrs: [],
        configuredSource: 'explicit-disabled'
      };
    }

    if (/^\d+$/.test(trimmed)) {
      const hops = Math.min(10, Math.max(1, parseInt(trimmed, 10)));
      return {
        mode: 'hops',
        hops,
        cidrs: [],
        configuredSource: `explicit-hops:${hops}`
      };
    }

    if (lower === 'true') {
      // Never interpret TRUST_PROXY=true as trusting arbitrary leftmost entries; cap to 1 rightmost proxy hop.
      return {
        mode: 'hops',
        hops: 1,
        cidrs: [],
        configuredSource: 'explicit-true-1hop'
      };
    }

    const tokens = trimmed.split(',').map((t) => t.trim()).filter(Boolean);
    const expandedTokens: string[] = [];
    for (const token of tokens) {
      const tokLower = token.toLowerCase();
      if (tokLower === 'loopback') {
        expandedTokens.push(...LOOPBACK_CIDRS);
      } else if (tokLower === 'linklocal') {
        expandedTokens.push(...LINKLOCAL_CIDRS);
      } else if (tokLower === 'uniquelocal' || tokLower === 'private') {
        expandedTokens.push(...UNIQUELOCAL_CIDRS);
      } else {
        expandedTokens.push(token);
      }
    }

    const cidrs: CidrRange[] = [];
    for (const tok of expandedTokens) {
      const parsed = parseCidrToken(tok);
      if (!parsed) {
        warnProxyConfigThrottled(
          `[TrustedProxy] Ignoring invalid TRUST_PROXY entry '${tok}'. Falling back safely.`
        );
        return {
          mode: 'disabled',
          hops: 0,
          cidrs: [],
          configuredSource: 'invalid-explicit-disabled'
        };
      }
      cidrs.push(parsed);
    }

    if (cidrs.length > 0) {
      return {
        mode: 'allowlist',
        hops: 0,
        cidrs,
        configuredSource: 'explicit-allowlist'
      };
    }
  }

  // Platform auto-detection only when TRUST_PROXY is not explicitly overridden
  if (process.env.VERCEL === '1' || process.env.VERCEL === 'true' || Boolean(process.env.VERCEL_ENV)) {
    return {
      mode: 'platform-vercel',
      hops: 1,
      cidrs: [],
      configuredSource: 'platform-vercel'
    };
  }

  if (Boolean(process.env.K_SERVICE)) {
    return {
      mode: 'platform-cloud-run',
      hops: 1,
      cidrs: [],
      configuredSource: 'platform-cloud-run'
    };
  }

  return {
    mode: 'disabled',
    hops: 0,
    cidrs: [],
    configuredSource: 'default-disabled'
  };
}

/**
 * Returns an Express `app.set('trust proxy', ...)` value aligned with `resolveTrustedProxyPolicy()`.
 */
export function getExpressTrustProxySetting(): boolean | number | ((ip: string) => boolean) {
  const policy = resolveTrustedProxyPolicy();
  if (policy.mode === 'disabled') {
    return false;
  }
  if (policy.mode === 'allowlist') {
    return (ip: string) => {
      const normalized = parseAndNormalizeIp(ip);
      if (!normalized) return false;
      return isIpInCidrList(normalized, policy.cidrs);
    };
  }
  return policy.hops;
}

export function applyTrustedProxySetting(app: express.Express): void {
  app.set('trust proxy', getExpressTrustProxySetting());
}

function parseHeaderIpChain(headerVal: string | string[] | undefined): Array<string | null> {
  if (!headerVal) return [];
  const joined = Array.isArray(headerVal) ? headerVal.join(',') : headerVal;
  if (typeof joined !== 'string' || !joined.trim()) return [];
  return joined
    .split(',')
    .map((part) => parseAndNormalizeIp(part));
}

/**
 * Securely extracts and normalizes the real client IP address from HTTP or WebSocket upgrade requests.
 *
 * Security guarantees:
 * - NEVER trusts client-supplied `X-Forwarded-For` unless proxy forwarding is explicitly configured
 *   via `TRUST_PROXY` / `ORVIX_TRUST_PROXY` or running on a verified proxy platform (Vercel / Cloud Run).
 * - Evaluates forwarding chains from RIGHT to LEFT so client-prepended spoofed IPs are ignored.
 * - Rejects malformed header entries cleanly by falling back to the verified TCP socket peer IP.
 */
export function extractClientIp(
  req: Pick<IncomingMessage, 'headers' | 'socket'> & { ip?: string }
): string {
  const policy = resolveTrustedProxyPolicy();
  const socketIp = parseAndNormalizeIp(req.socket?.remoteAddress);

  // When proxy trust is disabled, NEVER trust X-Forwarded-For / X-Real-IP / X-Vercel-Forwarded-For.
  if (policy.mode === 'disabled') {
    if (socketIp) return socketIp;
    const reqIpFallback = parseAndNormalizeIp(req.ip);
    return reqIpFallback || 'unknown';
  }

  // Platform: Vercel edge-authenticated header
  if (policy.mode === 'platform-vercel') {
    const vercelChain = parseHeaderIpChain(req.headers?.['x-vercel-forwarded-for']);
    if (vercelChain.length > 0) {
      const rightmost = vercelChain[vercelChain.length - 1];
      if (rightmost) return rightmost;
    }
  }

  const xffChain = parseHeaderIpChain(req.headers?.['x-forwarded-for']);

  // Hop-count mode (explicit TRUST_PROXY=N, Cloud Run 1-hop, or Vercel XFF fallback)
  if (policy.mode === 'hops' || policy.mode === 'platform-cloud-run' || policy.mode === 'platform-vercel') {
    if (xffChain.length === 0) {
      if (socketIp) return socketIp;
      const reqIpFallback = parseAndNormalizeIp(req.ip);
      return reqIpFallback || 'unknown';
    }

    const targetIdx = Math.max(0, xffChain.length - policy.hops);
    // Validate the trusted right-hand suffix from rightmost down to targetIdx
    for (let i = xffChain.length - 1; i >= targetIdx; i -= 1) {
      if (!xffChain[i]) {
        return socketIp || 'unknown';
      }
    }
    return xffChain[targetIdx] || socketIp || 'unknown';
  }

  // Explicit trusted proxy IP/CIDR allowlist mode
  if (policy.mode === 'allowlist') {
    if (!socketIp) {
      return 'unknown';
    }
    // Immediate TCP peer MUST be in the trusted proxy allowlist before inspecting headers
    if (!isIpInCidrList(socketIp, policy.cidrs)) {
      return socketIp;
    }

    let lastValidIp = socketIp;
    for (let i = xffChain.length - 1; i >= 0; i -= 1) {
      const entry = xffChain[i];
      if (!entry) {
        return lastValidIp;
      }
      if (!isIpInCidrList(entry, policy.cidrs)) {
        return entry;
      }
      lastValidIp = entry;
    }
    return lastValidIp;
  }

  return socketIp || 'unknown';
}

export interface ForwardedRequestLike {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined; encrypted?: boolean | undefined } | null;
  protocol?: string;
  get?: (name: string) => unknown;
}

/**
 * Determines whether forwarding headers (`X-Forwarded-Host`, `X-Forwarded-Proto`) on `req`
 * may be trusted under the active reverse-proxy policy.
 *
 * Security guarantees:
 * - `disabled` mode NEVER trusts forwarded headers.
 * - `allowlist` mode requires the immediate TCP socket peer IP to match a configured trusted CIDR.
 * - `hops`, `platform-vercel`, and `platform-cloud-run` trust proxy headers inserted by the edge/proxy hop(s).
 */
export function shouldTrustForwardedHeaders(req?: ForwardedRequestLike | null): boolean {
  const policy = resolveTrustedProxyPolicy();
  if (policy.mode === 'disabled') {
    return false;
  }

  if (policy.mode === 'allowlist') {
    const socketIp = parseAndNormalizeIp(req?.socket?.remoteAddress);
    if (!socketIp) {
      return false;
    }
    return isIpInCidrList(socketIp, policy.cidrs);
  }

  return true;
}

/**
 * Strictly validates and normalizes a single HTTP `Host` authority token (`hostname[:port]` or `[ipv6][:port]`).
 * Rejects empty values, whitespace, control characters, path separators, `@` userinfo injection,
 * query/fragment delimiters, and invalid port numbers.
 */
export function sanitizeHostHeaderValue(rawValue: unknown): string {
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  if (typeof raw !== 'string') return '';

  const candidate = raw.trim().toLowerCase();
  if (!candidate || candidate.length > 255) return '';

  // Reject control chars, whitespace, commas, delimiters, and authority-spoofing characters
  if (/[\x00-\x20\x7f\/\\@?#;,'"`<>]/.test(candidate)) {
    return '';
  }

  // Bracketed IPv6 literal with optional port
  if (candidate.startsWith('[')) {
    const match = /^\[([0-9a-f:]+)\](?::(\d{1,5}))?$/.exec(candidate);
    if (!match) return '';
    const ipPart = match[1];
    const portPart = match[2];
    if (!net.isIPv6(ipPart)) return '';
    if (portPart !== undefined) {
      const port = Number(portPart);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return '';
      return `[${ipPart}]:${port}`;
    }
    return `[${ipPart}]`;
  }

  // Hostname or IPv4 with optional single :port
  const firstColon = candidate.indexOf(':');
  const lastColon = candidate.lastIndexOf(':');
  if (firstColon !== lastColon) {
    return '';
  }

  let hostPart = candidate;
  let portSuffix = '';
  if (firstColon !== -1) {
    hostPart = candidate.slice(0, firstColon);
    const portRaw = candidate.slice(firstColon + 1);
    if (!/^\d{1,5}$/.test(portRaw)) return '';
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return '';
    portSuffix = `:${port}`;
  }

  const isValidIpv4 = net.isIPv4(hostPart);
  const isValidHostname =
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
      hostPart
    );

  if (!isValidIpv4 && !isValidHostname) {
    return '';
  }

  return `${hostPart}${portSuffix}`;
}

function selectForwardedHeaderToken(rawHeader: string | string[] | undefined, hops: number): string {
  if (!rawHeader) return '';
  const joined = Array.isArray(rawHeader) ? rawHeader.join(',') : rawHeader;
  if (typeof joined !== 'string' || !joined.trim()) return '';
  const parts = joined
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';
  const effectiveHops = hops > 0 ? hops : 1;
  const targetIdx = Math.max(0, parts.length - effectiveHops);
  return parts[targetIdx] || '';
}

function sanitizeProtocolToken(rawToken: string): 'http' | 'https' | null {
  const lower = rawToken.trim().toLowerCase();
  if (lower === 'https' || lower === 'http') {
    return lower;
  }
  return null;
}

/**
 * Returns the configured application origin (`APP_URL` or `VITE_PUBLIC_APP_URL`) if valid,
 * otherwise `null`.
 */
export function getConfiguredFallbackOrigin(): string | null {
  const candidates = [process.env.APP_URL, process.env.VITE_PUBLIC_APP_URL];
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      const parsed = new URL(raw.trim());
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return `${parsed.protocol}//${parsed.host}`;
      }
    } catch (_) {
      // Ignore malformed URL env values
    }
  }
  return null;
}

/**
 * Resolves the effective request host (`hostname[:port]`) enforcing trusted-proxy verification.
 * Untrusted `X-Forwarded-Host` headers are completely ignored, falling back safely to the HTTP `Host` header.
 */
export function resolveEffectiveRequestHost(req?: ForwardedRequestLike | null): string {
  const policy = resolveTrustedProxyPolicy();

  if (shouldTrustForwardedHeaders(req)) {
    const hops = policy.mode === 'allowlist' ? 1 : policy.hops;
    const forwardedToken = selectForwardedHeaderToken(req?.headers?.['x-forwarded-host'], hops);
    const sanitizedForwarded = sanitizeHostHeaderValue(forwardedToken);
    if (sanitizedForwarded) {
      return sanitizedForwarded;
    }
  }

  const rawDirectHost =
    req?.headers?.host ?? (typeof req?.get === 'function' ? req.get('host') : undefined);
  return sanitizeHostHeaderValue(rawDirectHost);
}

/**
 * Resolves the effective request protocol (`'http'` or `'https'`) enforcing trusted-proxy verification.
 * Untrusted `X-Forwarded-Proto` headers are completely ignored, falling back to TLS socket state.
 */
export function resolveEffectiveRequestProtocol(req?: ForwardedRequestLike | null): 'http' | 'https' {
  const policy = resolveTrustedProxyPolicy();

  if (shouldTrustForwardedHeaders(req)) {
    const hops = policy.mode === 'allowlist' ? 1 : policy.hops;
    const forwardedToken = selectForwardedHeaderToken(req?.headers?.['x-forwarded-proto'], hops);
    const sanitizedProto = sanitizeProtocolToken(forwardedToken);
    if (sanitizedProto) {
      return sanitizedProto;
    }
  }

  if (req?.socket && typeof req.socket.encrypted === 'boolean') {
    return req.socket.encrypted ? 'https' : 'http';
  }

  // Only honor req.protocol === 'https' if no untrusted X-Forwarded-Proto header was supplied
  if (!req?.headers?.['x-forwarded-proto'] && req?.protocol === 'https') {
    return 'https';
  }

  return 'http';
}

/**
 * Resolves a validated request origin (`http(s)://host`) enforcing trusted-proxy policy,
 * falling back safely to configured `APP_URL`/`VITE_PUBLIC_APP_URL` or a local default.
 */
export function resolveSafeRequestOrigin(
  req?: ForwardedRequestLike | null,
  defaultOrigin = 'http://127.0.0.1:3000'
): string {
  const host = resolveEffectiveRequestHost(req);
  if (host) {
    const proto = resolveEffectiveRequestProtocol(req);
    return `${proto}://${host}`;
  }

  return getConfiguredFallbackOrigin() || defaultOrigin;
}

