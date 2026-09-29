/**
 * Token bucket: `capacity` tokens, refilled continuously so that `capacity`
 * tokens come back every `windowMs`.
 */
export class TokenBucket {
    constructor({ capacity, windowMs }, now = Date.now) {
        this.capacity = capacity;
        this.refillPerMs = capacity / windowMs;
        this.tokens = capacity;
        this.now = now;
        this.updatedAt = now();
    }

    take(cost = 1) {
        const t = this.now();
        this.tokens = Math.min(this.capacity, this.tokens + (t - this.updatedAt) * this.refillPerMs);
        this.updatedAt = t;
        if (this.tokens < cost) return false;
        this.tokens -= cost;
        return true;
    }

    isFull() {
        this.take(0);
        return this.tokens >= this.capacity;
    }
}

/** One bucket per key (IP address, player id...), with periodic pruning. */
export class KeyedRateLimiter {
    constructor(options, now = Date.now) {
        this.options = options;
        this.now = now;
        this.buckets = new Map();
    }

    take(key, cost = 1) {
        let bucket = this.buckets.get(key);
        if (!bucket) {
            bucket = new TokenBucket(this.options, this.now);
            this.buckets.set(key, bucket);
        }
        return bucket.take(cost);
    }

    /** Drops buckets that have fully refilled, so memory stays bounded. */
    prune() {
        for (const [key, bucket] of this.buckets) if (bucket.isFull()) this.buckets.delete(key);
    }
}
