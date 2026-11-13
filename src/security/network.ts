import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';

/** Maximum length of a target URI accepted by the proxy. */
export const MAX_URL_LENGTH = 2048;

/** Default response size limit when an application does not configure one. */
export const DEFAULT_RESPONSE_LIMIT = 1024 * 1024;

/** An error that maps directly to an HTTP status code. */
export class ProxyRequestError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'ProxyRequestError';
        this.status = status;
    }
}

const BLOCKED_IPV4 = new net.BlockList();
[
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
].forEach(([address, prefix]) => BLOCKED_IPV4.addSubnet(address as string, prefix as number, 'ipv4'));

const BLOCKED_IPV6 = new net.BlockList();
[
    ['::', 128],
    ['::1', 128],
    ['100::', 64],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
].forEach(([address, prefix]) => BLOCKED_IPV6.addSubnet(address as string, prefix as number, 'ipv6'));

/**
 * Whether an IP address is in a range the proxy must never connect to.
 * @param address IPv4 or IPv6 address
 */
export function isBlockedAddress(address: string): boolean {
    if (net.isIPv4(address)) {
        return BLOCKED_IPV4.check(address, 'ipv4');
    }
    if (net.isIPv6(address)) {
        const mapped = mappedIpv4(address);
        if (mapped !== undefined) {
            return BLOCKED_IPV4.check(mapped, 'ipv4');
        }
        return BLOCKED_IPV6.check(address, 'ipv6');
    }
    // Not an IP address: never treat it as safe.
    return true;
}

/**
 * Extract the IPv4 address from an IPv4-mapped IPv6 address.
 * @param address IPv6 address
 */
function mappedIpv4(address: string): string | undefined {
    const lower = address.toLowerCase();
    if (!lower.startsWith('::ffff:')) {
        return undefined;
    }
    const rest = address.slice(7);
    return net.isIPv4(rest) ? rest : undefined;
}

/**
 * Remove the brackets from an IPv6 literal hostname.
 * @param hostname Hostname, possibly `[::1]`
 */
export function normalizeHostname(hostname: string): string {
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Hostnames that must not be resolved, even before DNS is consulted.
 * @param hostname Hostname without port
 */
export function isBlockedHostname(hostname: string): boolean {
    const host = normalizeHostname(hostname).toLowerCase().replace(/\.$/, '');
    if (host === 'localhost' || host === 'localhost.localdomain') {
        return true;
    }
    return ['.localhost', '.local', '.internal', '.home.arpa'].some((suffix) => host.endsWith(suffix));
}

/**
 * Resolve a hostname and reject it when any answer is in a blocked range.
 * @param hostname Hostname to resolve
 */
export async function resolvePublicAddresses(hostname: string): Promise<dns.LookupAddress[]> {
    const host = normalizeHostname(hostname);
    if (isBlockedHostname(host)) {
        throw new ProxyRequestError(403, 'Host is not allowed');
    }
    if (net.isIP(host)) {
        if (isBlockedAddress(host)) {
            throw new ProxyRequestError(403, 'Host is not allowed');
        }
        return [{ address: host, family: net.isIPv4(host) ? 4 : 6 }];
    }
    let addresses: dns.LookupAddress[];
    try {
        addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
    } catch {
        throw new ProxyRequestError(502, 'Could not resolve host');
    }
    if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
        throw new ProxyRequestError(403, 'Host is not allowed');
    }
    return addresses;
}

/**
 * DNS lookup used by the HTTP agents. Validating at connection time also covers
 * redirects and prevents DNS rebinding between the pre-check and the connection.
 * @param hostname Hostname to resolve
 * @param options Lookup options
 * @param callback Lookup callback
 */
export function safeLookup(hostname: string, options: any, callback: any): void {
    resolvePublicAddresses(hostname)
        .then((addresses) => {
            const all = typeof options === 'object' && options !== null && options.all;
            if (all) {
                callback(null, addresses);
            } else {
                callback(null, addresses[0].address, addresses[0].family);
            }
        })
        .catch((error) => callback(error));
}

/**
 * Whether a string contains ASCII control characters.
 * @param value Input string
 */
function hasControlCharacters(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code <= 0x1f || code === 0x7f) {
            return true;
        }
    }
    return false;
}

/**
 * Validate a target URI before it is proxied.
 * @param raw Target URI from the request
 */
export function validateTargetUrl(raw: string): URL {
    if (!raw || raw.length > MAX_URL_LENGTH) {
        throw new ProxyRequestError(400, 'Please provide a valid uri= GET parameter!');
    }
    // Control characters are never valid in a URL and could be used to smuggle headers.
    if (hasControlCharacters(raw)) {
        throw new ProxyRequestError(400, 'Please provide a valid uri= GET parameter!');
    }
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new ProxyRequestError(400, 'Please provide a valid uri= GET parameter!');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ProxyRequestError(400, 'Only http and https URIs are supported');
    }
    if (url.username || url.password) {
        throw new ProxyRequestError(400, 'URIs with credentials are not supported');
    }
    if (!url.hostname) {
        throw new ProxyRequestError(400, 'Please provide a valid uri= GET parameter!');
    }
    return url;
}

/**
 * Parse a configured size such as "1MB" into bytes.
 * @param value Configured value
 * @param fallback Value used when the configuration is missing or invalid
 */
export function parseByteSize(value: string | undefined, fallback: number): number {
    if (!value) {
        return fallback;
    }
    const match = /^(\d+)\s*(b|kb|mb|gb)?$/i.exec(value.trim());
    if (!match) {
        return fallback;
    }
    const unit = (match[2] ?? 'b').toLowerCase();
    const factor = unit === 'kb' ? 1024 : unit === 'mb' ? 1024 * 1024 : unit === 'gb' ? 1024 * 1024 * 1024 : 1;
    const bytes = Number(match[1]) * factor;
    return Number.isFinite(bytes) && bytes > 0 ? bytes : fallback;
}

/**
 * Whether a response content type is allowed by the application configuration.
 * @param contentType Content-Type header value
 * @param allowed Configured media types
 */
export function isAllowedContentType(contentType: string | undefined, allowed: string[] | undefined): boolean {
    if (!allowed || allowed.length === 0 || !contentType) {
        return true;
    }
    const type = contentType.split(';')[0].trim().toLowerCase();
    return allowed.some((entry) => entry.toLowerCase() === type);
}

/**
 * Build a cache key that separates representations by Accept header.
 * @param appId Application id
 * @param accept Accept header of the request
 * @param uri Target URI
 */
export function buildCacheKey(appId: string, accept: string, uri: string): string {
    const hash = crypto.createHash('sha256').update(`${accept}\n${uri}`).digest('hex');
    return `${appId.toLowerCase()}:cache:${hash}`;
}
