// チャートの背景に塗る判定の選択。ブラウザに保存し、ホームとバックテスト結果で共有する

import type { Judge } from "@trading-studio/core";
import { useState } from "react";
import { isJudge } from "../components/chart/judgment-data";

const STORAGE_KEY = "chart-bg";

function read(): Judge {
	try {
		const v = localStorage.getItem(STORAGE_KEY);
		return isJudge(v) ? v : "trend";
	} catch {
		return "trend";
	}
}

export function useChartBg(): [Judge, (j: Judge) => void] {
	const [bg, setBg] = useState<Judge>(read);
	const change = (j: Judge) => {
		setBg(j);
		try {
			localStorage.setItem(STORAGE_KEY, j);
		} catch {
			// 保存できなくても、この画面の間は切り替わる
		}
	};
	return [bg, change];
}
