import type { DvolBar } from "@trading-studio/backend";
import { useContext, useEffect, useState } from "react";
import { ApiContext } from "../../lib/api";
import { readJson } from "../../lib/useAsync";

const HOUR_MS = 3_600_000;

/**
 * 開始が [from, to) の DVOL の1時間足。on の間だけ読む。読めなければ空にする（小窓に線を出さないだけで、チャートは描く）。
 * to は時間単位に丸めて見るので、ホームで数秒ごとに最新の足が変わっても1時間に1回しか読み直さない
 */
export function useDvolBars(
	on: boolean,
	from: number | null,
	to: number | null,
): readonly DvolBar[] {
	const api = useContext(ApiContext);
	const [bars, setBars] = useState<readonly DvolBar[]>([]);
	const toHour = to === null ? null : Math.ceil(to / HOUR_MS) * HOUR_MS;
	useEffect(() => {
		if (!on || !api || from === null || toHour === null) {
			setBars([]);
			return;
		}
		let alive = true;
		api.api.dvol.bars
			.$get({ query: { from: String(from), to: String(toHour) } })
			.then((r) => readJson<{ bars: DvolBar[] }>(r))
			.then((r) => alive && setBars(r.bars))
			.catch(() => alive && setBars([]));
		return () => {
			alive = false;
		};
	}, [api, on, from, toHour]);
	return bars;
}
