import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    buildCacheKey,
    isAllowedContentType,
    isBlockedAddress,
    isBlockedHostname,
    parseByteSize,
    ProxyRequestError,
    resolvePublicAddresses,
    validateTargetUrl,
} from '../../dist/esm/security/network.js';

describe('isBlockedAddress', () => {
    it('blocks loopback, private and link-local IPv4 ranges', () => {
        ['0.0.0.0', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1'].forEach(
            (address) => assert.equal(isBlockedAddress(address), true, address),
        );
    });

    it('blocks multicast and reserved IPv4 ranges', () => {
        ['224.0.0.1', '240.0.0.1', '255.255.255.255'].forEach((address) =>
            assert.equal(isBlockedAddress(address), true, address),
        );
    });

    it('allows public IPv4 addresses', () => {
        ['8.8.8.8', '1.1.1.1', '93.184.216.34'].forEach((address) =>
            assert.equal(isBlockedAddress(address), false, address),
        );
    });

    it('blocks loopback, link-local and unique-local IPv6 ranges', () => {
        ['::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '2001:db8::1'].forEach((address) =>
            assert.equal(isBlockedAddress(address), true, address),
        );
    });

    it('allows public IPv6 addresses', () => {
        ['2606:4700:4700::1111', '2001:4860:4860::8888'].forEach((address) =>
            assert.equal(isBlockedAddress(address), false, address),
        );
    });

    it('unwraps IPv4-mapped IPv6 addresses', () => {
        assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
        assert.equal(isBlockedAddress('::ffff:8.8.8.8'), false);
    });

    it('treats non-IP input as unsafe', () => {
        assert.equal(isBlockedAddress('example.com'), true);
    });
});

describe('isBlockedHostname', () => {
    it('blocks local hostnames', () => {
        ['localhost', 'localhost.', 'api.localhost', 'printer.local', 'db.internal', 'router.home.arpa'].forEach(
            (hostname) => assert.equal(isBlockedHostname(hostname), true, hostname),
        );
    });

    it('allows public hostnames', () => {
        ['sembeacon.org', 'proxy.sembeacon.org', 'example.com'].forEach((hostname) =>
            assert.equal(isBlockedHostname(hostname), false, hostname),
        );
    });
});

describe('resolvePublicAddresses', () => {
    it('rejects localhost without a DNS lookup', async () => {
        await assert.rejects(resolvePublicAddresses('localhost'), (error) => {
            assert.ok(error instanceof ProxyRequestError);
            assert.equal(error.status, 403);
            return true;
        });
    });

    it('rejects literal private IP addresses', async () => {
        await assert.rejects(resolvePublicAddresses('127.0.0.1'), (error) => {
            assert.ok(error instanceof ProxyRequestError);
            assert.equal(error.status, 403);
            return true;
        });
        await assert.rejects(resolvePublicAddresses('[::1]'), (error) => {
            assert.ok(error instanceof ProxyRequestError);
            assert.equal(error.status, 403);
            return true;
        });
    });
});

describe('validateTargetUrl', () => {
    it('accepts http and https URIs', () => {
        assert.equal(validateTargetUrl('https://sembeacon.org/examples/a.ttl').hostname, 'sembeacon.org');
        assert.equal(validateTargetUrl('http://example.com/').protocol, 'http:');
    });

    it('rejects unsupported schemes', () => {
        ['file:///etc/passwd', 'ftp://example.com/a', 'javascript:alert(1)', 'data:text/plain,hello'].forEach((uri) => {
            assert.throws(() => validateTargetUrl(uri), (error) => {
                assert.ok(error instanceof ProxyRequestError);
                assert.equal(error.status, 400);
                return true;
            });
        });
    });

    it('rejects credentials and control characters', () => {
        assert.throws(() => validateTargetUrl('https://user:pass@example.com/'), ProxyRequestError);
        assert.throws(() => validateTargetUrl('https://example.com/\r\nX-Test: 1'), ProxyRequestError);
    });

    it('rejects empty and oversized URIs', () => {
        assert.throws(() => validateTargetUrl(''), ProxyRequestError);
        assert.throws(() => validateTargetUrl(`https://example.com/${'a'.repeat(2048)}`), ProxyRequestError);
    });
});

describe('parseByteSize', () => {
    it('parses configured sizes', () => {
        assert.equal(parseByteSize('1024', 0), 1024);
        assert.equal(parseByteSize('1KB', 0), 1024);
        assert.equal(parseByteSize('1 MB', 0), 1024 * 1024);
        assert.equal(parseByteSize('2GB', 0), 2 * 1024 * 1024 * 1024);
    });

    it('falls back for missing or invalid values', () => {
        assert.equal(parseByteSize(undefined, 42), 42);
        assert.equal(parseByteSize('lots', 42), 42);
        assert.equal(parseByteSize('0', 42), 42);
    });
});

describe('isAllowedContentType', () => {
    it('accepts configured media types with parameters', () => {
        assert.equal(isAllowedContentType('text/turtle; charset=utf-8', ['text/turtle']), true);
    });

    it('rejects other media types', () => {
        assert.equal(isAllowedContentType('text/html', ['text/turtle']), false);
    });

    it('allows missing content types and empty configuration', () => {
        assert.equal(isAllowedContentType(undefined, ['text/turtle']), true);
        assert.equal(isAllowedContentType('text/html', []), true);
    });
});

describe('buildCacheKey', () => {
    it('separates representations by Accept header', () => {
        const turtle = buildCacheKey('example', 'text/turtle', 'https://example.com/a');
        const json = buildCacheKey('example', 'application/ld+json', 'https://example.com/a');
        assert.notEqual(turtle, json);
        assert.match(turtle, /^example:cache:[0-9a-f]{64}$/);
    });

    it('is stable for the same request', () => {
        assert.equal(
            buildCacheKey('example', 'text/turtle', 'https://example.com/a'),
            buildCacheKey('example', 'text/turtle', 'https://example.com/a'),
        );
    });
});
