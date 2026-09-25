import { useEffect, useState } from "react";
import type { ApiClient } from "./api";

type HealthState =
	| { kind: "loading" }
	| { kind: "ok"; status: string; db: string }
	| { kind: "error"; message: string };

export function App({ client }: { client: ApiClient }) {
	const [health, setHealth] = useState<HealthState>({ kind: "loading" });

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await client.api.health.$get();
				if (!res.ok) {
					throw new Error(`HTTP ${res.status}`);
				}
				const body = await res.json();
				if (!cancelled)
					setHealth({ kind: "ok", status: body.status, db: body.db });
			} catch (e) {
				if (!cancelled) {
					setHealth({
						kind: "error",
						message: e instanceof Error ? e.message : String(e),
					});
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [client]);

	return (
		<main>
			<h1>trading-studio</h1>
			{health.kind === "loading" && <p>確認中…</p>}
			{health.kind === "ok" && (
				<>
					<p>health: {health.status}</p>
					<p>DB: {health.db}</p>
				</>
			)}
			{health.kind === "error" && (
				<p role="alert">health の取得に失敗しました: {health.message}</p>
			)}
		</main>
	);
}
