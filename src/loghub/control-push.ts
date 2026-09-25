/**
 * Debug Dashboard — Control Push (optional, on top of polling)
 *
 * By default a source learns about control changes by polling GET /control.
 * That costs the source a request every few seconds even when nothing changes,
 * and a button press only arrives at the next poll. A source that runs its own
 * HTTP server can instead SUBSCRIBE (POST /control/subscribe) with a callback
 * URL; the hub then POSTs every change to that URL right away.
 *
 * Push is an ADDITION, never a replacement: GET /control keeps working, and a
 * source should keep a slow poll as a safety net (a missed push is repaired by
 * the next poll — for buttons that is exactly why they are counters).
 *
 * Rules the hub follows when calling out:
 *   - Fire & forget. Delivery never blocks the dashboard's request.
 *   - One request in flight per subscriber. Changes that arrive meanwhile are
 *     coalesced (latest value per id wins) and sent as one follow-up batch, so
 *     a fast slider drag can never arrive out of order.
 *   - Short timeout. After MAX_FAILURES failed deliveries in a row the
 *     subscription is dropped — the hub must not keep knocking on a dead
 *     device. The source re-subscribes whenever it likes (idempotent).
 *   - Callback URLs are foreign input: plain http to an IP literal (or
 *     localhost) in loopback/private/link-local ranges only, no redirects.
 *
 * Payload: a flat { id: value } object — the same shape GET /control returns,
 * so a source can feed both through the same parser.
 */

import { isIP } from 'net';

const DELIVERY_TIMEOUT_MS = 1500;
const MAX_FAILURES = 3;
const MAX_SUBSCRIBERS = 32;
const MAX_IDS_PER_SUBSCRIBER = 500;

export type ControlValue = number | string;

export interface SubscribeRequest {
    url?: string;       // full callback URL, e.g. "http://192.168.1.50/control"
    port?: number;      // shorthand: sender's own IP + this port (+ path)
    path?: string;      // with `port`: callback path (default "/control")
    ids?: string[];     // only these ids (default: every control)
}

export interface SubscriberInfo {
    url: string;
    ids: string[] | null;       // null = all
    failures: number;
    delivered: number;
    lastError?: string;
}

interface Subscriber extends SubscriberInfo {
    idSet: Set<string> | null;
    pending: Map<string, ControlValue>;
    inFlight: boolean;
}

export type PushEventLogger = (level: 'info' | 'warn', message: string) => void;

export class ControlPush {
    private subs = new Map<string, Subscriber>();
    private closed = false;

    constructor(private readonly log: PushEventLogger = () => {}) {}

    /**
     * Register (or refresh) a callback. `remoteAddress` is the socket address
     * of the subscribing request, used when only a port is given. Returns the
     * normalized URL or an error text. Re-subscribing the same URL replaces the
     * id filter and resets the failure count.
     */
    subscribe(req: SubscribeRequest, remoteAddress: string | undefined): { url: string } | { error: string } {
        let raw: string;
        if (typeof req.url === 'string' && req.url.trim()) {
            raw = req.url.trim();
        } else if (typeof req.port === 'number' && Number.isInteger(req.port) && req.port > 0 && req.port < 65536) {
            const host = normalizeRemoteAddress(remoteAddress);
            if (!host) return { error: 'cannot determine sender address — pass a full "url" instead' };
            let path = typeof req.path === 'string' && req.path.trim() ? req.path.trim() : '/control';
            if (!path.startsWith('/')) path = '/' + path;
            raw = `http://${isIP(host) === 6 ? `[${host}]` : host}:${req.port}${path}`;
        } else {
            return { error: 'subscribe requires "url" or "port"' };
        }

        const checked = validateCallbackUrl(raw);
        if ('error' in checked) return checked;
        const url = checked.url;

        let ids: string[] | null = null;
        if (req.ids !== undefined) {
            if (!Array.isArray(req.ids) || req.ids.some(i => typeof i !== 'string' || !i.trim())) {
                return { error: '"ids" must be an array of non-empty strings' };
            }
            if (req.ids.length > MAX_IDS_PER_SUBSCRIBER) {
                return { error: `at most ${MAX_IDS_PER_SUBSCRIBER} ids per subscription` };
            }
            ids = [...new Set(req.ids.map(i => i.trim()))];
        }

        const existing = this.subs.get(url);
        if (!existing && this.subs.size >= MAX_SUBSCRIBERS) {
            return { error: `too many subscribers (max ${MAX_SUBSCRIBERS})` };
        }
        if (existing) {
            existing.ids = ids;
            existing.idSet = ids ? new Set(ids) : null;
            existing.failures = 0;
            existing.lastError = undefined;
        } else {
            this.subs.set(url, {
                url, ids, idSet: ids ? new Set(ids) : null,
                failures: 0, delivered: 0,
                pending: new Map(), inFlight: false,
            });
            this.log('info', `control push: subscribed ${url}${ids ? ` (${ids.length} ids)` : ''}`);
        }
        return { url };
    }

    /** Remove a subscription by URL. Returns true if it existed. */
    unsubscribe(url: string): boolean {
        const checked = validateCallbackUrl(url);
        const key = 'url' in checked ? checked.url : url;
        return this.subs.delete(key);
    }

    /** A control changed — queue it for every interested subscriber. */
    notify(id: string, value: ControlValue): void {
        if (this.closed) return;
        for (const sub of this.subs.values()) {
            if (sub.idSet && !sub.idSet.has(id)) continue;
            sub.pending.set(id, value);
            if (!sub.inFlight) this.flush(sub);
        }
    }

    list(): SubscriberInfo[] {
        return [...this.subs.values()].map(s => ({
            url: s.url, ids: s.ids, failures: s.failures, delivered: s.delivered,
            ...(s.lastError ? { lastError: s.lastError } : {}),
        }));
    }

    get size(): number {
        return this.subs.size;
    }

    /** Hub shutdown: forget everything, stop sending follow-up batches. */
    close(): void {
        this.closed = true;
        this.subs.clear();
    }

    private flush(sub: Subscriber): void {
        if (sub.pending.size === 0 || this.closed) return;
        const batch: Record<string, ControlValue> = {};
        for (const [k, v] of sub.pending) batch[k] = v;
        sub.pending.clear();
        sub.inFlight = true;

        fetch(sub.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batch),
            redirect: 'manual',
            signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        }).then(res => {
            // Drain the body so the socket is released.
            res.arrayBuffer().catch(() => {});
            if (res.status >= 200 && res.status < 300) return null;
            return `HTTP ${res.status}`;
        }, (err: unknown) => {
            const e = err as { name?: string; message?: string; cause?: { code?: string } };
            if (e?.name === 'TimeoutError') return `timeout after ${DELIVERY_TIMEOUT_MS} ms`;
            return e?.cause?.code ?? e?.message ?? String(err);
        }).then(error => {
            sub.inFlight = false;
            if (this.subs.get(sub.url) !== sub) return;   // unsubscribed meanwhile
            if (error === null) {
                sub.failures = 0;
                sub.lastError = undefined;
                sub.delivered++;
            } else {
                sub.failures++;
                sub.lastError = error;
                if (sub.failures >= MAX_FAILURES) {
                    this.subs.delete(sub.url);
                    this.log('warn', `control push: dropped ${sub.url} after ${sub.failures} failed deliveries (${error}) — source must re-subscribe`);
                    return;
                }
                // The failed batch is not re-sent on its own; values changed
                // meanwhile go out next. The source's slow poll repairs the rest.
            }
            this.flush(sub);
        });
    }
}

/**
 * Socket address → plain host. Express/Node report IPv4 peers on a dual-stack
 * socket as "::ffff:192.168.1.50" (IPv4-mapped IPv6), which is not usable as
 * a URL host as-is.
 */
export function normalizeRemoteAddress(addr: string | undefined): string | null {
    if (!addr) return null;
    let a = addr.trim();
    const zone = a.indexOf('%');
    if (zone >= 0) a = a.slice(0, zone);       // fe80::1%eth0 — zone ids don't belong in URLs
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
    if (mapped) a = mapped[1];
    return isIP(a) ? a : null;
}

/** Only plain http to loopback / private / link-local IP literals (or localhost). */
export function validateCallbackUrl(raw: string): { url: string } | { error: string } {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return { error: 'invalid callback url' };
    }
    if (u.protocol !== 'http:') return { error: 'callback url must use http://' };
    if (u.username || u.password) return { error: 'callback url must not contain credentials' };

    let host = u.hostname;
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (host.toLowerCase() === 'localhost') {
        // fine
    } else if (!isIP(host)) {
        return { error: 'callback host must be an IP address or localhost (no DNS names)' };
    } else if (!isPrivateAddress(host)) {
        return { error: 'callback host must be loopback, private or link-local' };
    }
    u.hash = '';
    return { url: u.toString() };
}

function isPrivateAddress(ip: string): boolean {
    if (isIP(ip) === 4) {
        const [a, b] = ip.split('.').map(Number);
        return a === 127
            || a === 10
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 169 && b === 254);
    }
    const v6 = ip.toLowerCase();
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v6);
    if (mapped) return isPrivateAddress(mapped[1]);
    // WHATWG URL rewrites [::ffff:192.168.1.5] to [::ffff:c0a8:105].
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
    if (mappedHex) {
        const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
        return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return v6 === '::1'
        || /^f[cd][0-9a-f]{0,2}:/.test(v6)          // fc00::/7 unique local
        || /^fe[89ab][0-9a-f]?:/.test(v6);          // fe80::/10 link-local
}
