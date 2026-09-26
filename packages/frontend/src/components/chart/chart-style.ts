// 価格の描き方（線 / ローソク足）。選んだものをブラウザに保存し、ホームとバックテスト結果で共有する

import { useCallback, useState } from "react";
import type { ChartStyle } from "./chart-data";

const STORAGE_KEY = "chart-style";

function readStyle(): ChartStyle {
	try {
		return localStorage.getItem(STORAGE_KEY) === "candle" ? "candle" : "line";
	} catch {
		return "line";
	}
}

export function useChartStyle(): [ChartStyle, (s: ChartStyle) => void] {
	const [style, setStyle] = useState(readStyle);
	const set = useCallback((s: ChartStyle) => {
		setStyle(s);
		try {
			localStorage.setItem(STORAGE_KEY, s);
		} catch {
			// 保存できない環境（プライベートモードなど）では、この画面を開いている間だけ効く
		}
	}, []);
	return [style, set];
}
