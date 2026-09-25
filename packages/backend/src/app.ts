import { Hono } from "hono";

const api = new Hono().get("/health", (c) => c.json({ status: "ok" as const }));

// frontend は Hono RPC でこの型を使う。Bun 固有の API はここに持ち込まない（frontend の型チェックに Bun の型を入れないため）
export const app = new Hono().route("/api", api);

export type AppType = typeof app;
