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

const ENTRY_KEY = "chart-entry";

/** 買値の線を出すか。既定は出す。選んだものをブラウザに保存する */
export function useShowEntry(): [boolean, (on: boolean) => void] {
	const [on, setOn] = useState(() => {
		try {
			return localStorage.getItem(ENTRY_KEY) !== "off";
		} catch {
			return true;
		}
	});
	const set = useCallback((v: boolean) => {
		setOn(v);
		try {
			localStorage.setItem(ENTRY_KEY, v ? "on" : "off");
		} catch {
			// 保存できない環境では、この画面を開いている間だけ効く
		}
	}, []);
	return [on, set];
}

const VOLUME_KEY = "chart-volume";

/** 出来高の棒を出すか。既定は出す。選んだものをブラウザに保存する */
export function useShowVolume(): [boolean, (on: boolean) => void] {
	const [on, setOn] = useState(() => {
		try {
			return localStorage.getItem(VOLUME_KEY) !== "off";
		} catch {
			return true;
		}
	});
	const set = useCallback((v: boolean) => {
		setOn(v);
		try {
			localStorage.setItem(VOLUME_KEY, v ? "on" : "off");
		} catch {
			// 保存できない環境では、この画面を開いている間だけ効く
		}
	}, []);
	return [on, set];
}
