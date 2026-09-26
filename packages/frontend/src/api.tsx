import type { AppType } from "@trading-studio/backend";
import { hc } from "hono/client";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";

export type ApiClient = ReturnType<typeof hc<AppType>>;

export function createApiClient(fetchFn: typeof fetch = fetch): ApiClient {
	return hc<AppType>("/", { fetch: fetchFn });
}

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({
	client,
	children,
}: {
	client: ApiClient;
	children: ReactNode;
}) {
	return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
	const client = useContext(ApiContext);
	if (!client) throw new Error("ApiProvider の外で useApi を使っている");
	return client;
}
