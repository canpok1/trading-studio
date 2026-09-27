import { useCallback } from "react";
import { useApi } from "../api";
import { formatVersion } from "../format";
import { readJson, useAsync } from "../lib/useAsync";

/** 動いているアプリのバージョン（ビルド日時）。開発中は「開発版」 */
export function AppVersion({ className = "" }: { className?: string }) {
	const api = useApi();
	const load = useCallback(
		async () =>
			(
				await api.api.version
					.$get()
					.then((r) => readJson<{ builtAt: number | null }>(r))
			).builtAt ?? null,
		[api],
	);
	const { state } = useAsync(load);
	if (state.kind !== "ok") return null;
	return (
		<span
			data-testid="app-version"
			className={`num text-xs text-text-2 ${className}`}
		>
			{formatVersion(state.data, "開発版")}
		</span>
	);
}
