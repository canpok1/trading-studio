import type { DvolBar } from "@trading-studio/backend";
import type { Timeframe } from "@trading-studio/core";
import { useContext, useEffect, useState } from "react";
import { ApiContext } from "../../lib/api";
import { readJson, useInterval } from "../../lib/useAsync";

const HOUR_MS = 3_600_000;
/** 読み直す間隔。取得は1時間ごとだが時刻の区切りに揃っていないので、新しい足と確定した値を早めに拾う */
const RELOAD_MS = 5 * 60_000;

/**
 * 開始が [from, to) の DVOL の1時間足。averageDays があれば足ごとに直近その日数の平均も付く。on の間だけ読む。読めなければ空にする（小窓に線を出さないだけで、チャートは描く）。
 * to は時間単位に丸めて見るので、ホームで数秒ごとに最新の足が変わっても読み直すのは5分ごと（と期間が変わったとき）だけ
 */
export function useDvolBars(
	on: boolean,
	from: number | null,
	to: number | null,
	timeframe: Timeframe | undefined,
	averageDays: number | null,
): readonly DvolBar[] {
	const api = useContext(ApiContext);
	const [bars, setBars] = useState<readonly DvolBar[]>([]);
	const toHour = to === null ? null : Math.ceil(to / HOUR_MS) * HOUR_MS;
	const [tick, setTick] = useState(0);
	useInterval(() => setTick((n) => n + 1), RELOAD_MS, on);
	// biome-ignore lint/correctness/useExhaustiveDependencies: tick の変化で読み直す
	useEffect(() => {
		if (!on || !api || from === null || toHour === null) {
			setBars([]);
			return;
		}
		let alive = true;
		api.api.dvol.bars
			.$get({
				query: {
					from: String(from),
					to: String(toHour),
					...(timeframe ? { timeframe } : {}),
					...(averageDays ? { averageDays } : {}),
				},
			})
			.then((r) => readJson<{ bars: DvolBar[] }>(r))
			.then((r) => alive && setBars(r.bars))
			.catch(() => alive && setBars([]));
		return () => {
			alive = false;
		};
	}, [api, on, from, toHour, timeframe, averageDays, tick]);
	return bars;
}
