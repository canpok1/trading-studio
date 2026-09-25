import type { AppType } from "@trading-studio/backend";
import { hc } from "hono/client";

export type ApiClient = ReturnType<typeof hc<AppType>>;

export function createApiClient(fetchFn: typeof fetch = fetch): ApiClient {
	return hc<AppType>("/", { fetch: fetchFn });
}
