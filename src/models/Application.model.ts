export interface RateLimit {
    /** Length of the rate limit window in seconds (default 60). */
    windowSeconds?: number;
    /** Maximum requests per client IP and window (default 300). */
    max?: number;
}

export interface Application {
    id: string;
    name?: string;
    key: string;
    /** Maximum upstream response size, for example "1MB". */
    limit?: string;
    timeout?: number;
    accept?: string[];
    cacheTimeout?: number;
    /** Optional per-application rate limit. */
    rateLimit?: RateLimit;
}
