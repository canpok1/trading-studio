import { Hono } from "hono";

export type AppDeps = {
	isDbReachable: () => boolean;
};

// frontend は Hono RPC でこの型を使う。Bun 固有の API はここに持ち込まない（frontend の型チェックに Bun の型を入れないため）
export function createApp({ isDbReachable }: AppDeps) {
	const api = new Hono().get("/health", (c) =>
		c.json({
			status: "ok" as const,
			db: isDbReachable() ? ("ok" as const) : ("error" as const),
		}),
	);
	return new Hono().route("/api", api);
}

export type AppType = ReturnType<typeof createApp>;
