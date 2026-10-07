// 評価詳細のタブの「市場評価の分析」の見せ方。ブラウザに保存する

import { useState } from "react";

export const ANALYSIS_VIEWS = [
	["precision", "精度ごと"],
	["level", "評価ごと"],
	["matrix", "評価×値動き"],
] as const;
export type AnalysisView = (typeof ANALYSIS_VIEWS)[number][0];

export const ANALYSIS_UNITS = [
	["count", "件数"],
	["ratio", "割合"],
] as const;
export type AnalysisUnit = (typeof ANALYSIS_UNITS)[number][0];

function useStored<T extends string>(
	key: string,
	options: readonly (readonly [T, string])[],
	fallback: T,
): [T, (v: T) => void] {
	const read = (): T => {
		try {
			const v = localStorage.getItem(key);
			return options.find(([x]) => x === v)?.[0] ?? fallback;
		} catch {
			return fallback;
		}
	};
	const [value, setValue] = useState<T>(read);
	const change = (v: T) => {
		setValue(v);
		try {
			localStorage.setItem(key, v);
		} catch {
			// 保存できなくても、この画面の間は切り替わる
		}
	};
	return [value, change];
}

export const useAnalysisView = () =>
	useStored<AnalysisView>("eval-analysis-view", ANALYSIS_VIEWS, "precision");
export const useAnalysisUnit = () =>
	useStored<AnalysisUnit>("eval-analysis-unit", ANALYSIS_UNITS, "count");
