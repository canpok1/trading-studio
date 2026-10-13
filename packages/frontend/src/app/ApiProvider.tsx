import type { ReactNode } from "react";
import type { ApiClient } from "../shared/lib/api";
import { ApiContext } from "../shared/lib/api";

export function ApiProvider({
	client,
	children,
}: {
	client: ApiClient;
	children: ReactNode;
}) {
	return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}
