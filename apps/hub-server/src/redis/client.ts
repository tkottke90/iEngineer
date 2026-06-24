import Redis from "ioredis";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";

export const redis = new Redis(url);
export const redisSub = new Redis(url);

redis.on("error", (err) => console.error("Redis error:", err));
redisSub.on("error", (err) => console.error("Redis sub error:", err));
