// チャートの足の粒度。既定は日足で、最後に選んだ粒度をブラウザに保存し、ホームとバックテスト結果で共有する。
// 戦略の条件は足を条件ごとに持つので、チャートの粒度は戦略から決めない

import type { Timeframe } from "@trading-studio/core";
import { isTimeframe, TIMEFRAME_MS } from "@trading-studio/core";
import { useState } from "react";

const STORAGE_KEY = "chart-timeframe";

export const DEFAULT_CHART_TIMEFRAME: Timeframe = "1d";

function read(): Timeframe {
	try {
		const v = localStorage.getItem(STORAGE_KEY);
		return isTimeframe(v) ? v : DEFAULT_CHART_TIMEFRAME;
	} catch {
		return DEFAULT_CHART_TIMEFRAME;
	}
}

export function useChartTimeframe(): [Timeframe, (t: Timeframe) => void] {
	const [tf, setTf] = useState<Timeframe>(read);
	const change = (t: Timeframe) => {
		setTf(t);
		try {
			localStorage.setItem(STORAGE_KEY, t);
		} catch {
			// 保存できなくても、この画面の間は切り替わる
		}
	};
	return [tf, change];
}

/** 最初に見せる長さ（最新から遡る）。1日か、足 60 本ぶんの長いほう */
export function initialSpanMs(timeframe: Timeframe): number {
	return Math.max(TIMEFRAME_MS["1d"], 60 * TIMEFRAME_MS[timeframe]);
}
