// チャートの背景に塗る判定の選択（なしも選べる）。ブラウザに保存し、ホームとバックテスト結果で共有する

import { useState } from "react";
import type { ChartBg } from "../components/chart/judgment-data";
import { isChartBg } from "../components/chart/judgment-data";

const STORAGE_KEY = "chart-bg";

function read(): ChartBg {
	try {
		const v = localStorage.getItem(STORAGE_KEY);
		return isChartBg(v) ? v : "sentiment";
	} catch {
		return "sentiment";
	}
}

export function useChartBg(): [ChartBg, (j: ChartBg) => void] {
	const [bg, setBg] = useState<ChartBg>(read);
	const change = (j: ChartBg) => {
		setBg(j);
		try {
			localStorage.setItem(STORAGE_KEY, j);
		} catch {
			// 保存できなくても、この画面の間は切り替わる
		}
	};
	return [bg, change];
}
