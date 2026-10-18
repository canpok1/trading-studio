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

const TRIGGER_KEY = "chart-trigger";

/** 発動価格（戦略の次の行動）の線を出すか。既定は出す。選んだものをブラウザに保存する */
export function useShowTriggers(): [boolean, (on: boolean) => void] {
	const [on, setOn] = useState(() => {
		try {
			return localStorage.getItem(TRIGGER_KEY) !== "off";
		} catch {
			return true;
		}
	});
	const set = useCallback((v: boolean) => {
		setOn(v);
		try {
			localStorage.setItem(TRIGGER_KEY, v ? "on" : "off");
		} catch {
			// 保存できない環境では、この画面を開いている間だけ効く
		}
	}, []);
	return [on, set];
}

const VALUES_KEY = "chart-values";

/** チャート上の値の表示で、日時と終値のほか（始値・高値・安値・出来高・市場評価・線の値）も出すか。既定は畳む。選んだものをブラウザに保存する */
export function useShowValues(): [boolean, (on: boolean) => void] {
	const [on, setOn] = useState(() => {
		try {
			return localStorage.getItem(VALUES_KEY) === "open";
		} catch {
			return false;
		}
	});
	const set = useCallback((v: boolean) => {
		setOn(v);
		try {
			localStorage.setItem(VALUES_KEY, v ? "open" : "closed");
		} catch {
			// 保存できない環境では、この画面を開いている間だけ効く
		}
	}, []);
	return [on, set];
}

const DVOL_KEY = "chart-dvol";

/**
 * DVOL の小窓を出すか。戦略で DVOL の条件を使っていれば最初は出し、そうでなければ最後に選んだもの（既定は出さない）。
 * 選んだものをブラウザに保存する。戦略が DVOL を使うかが変わったら最初の状態へ戻す
 */
export function useShowDvol(
	strategyUses: boolean,
): [boolean, (on: boolean) => void] {
	const [saved, setSaved] = useState(() => {
		try {
			return localStorage.getItem(DVOL_KEY) === "on";
		} catch {
			return false;
		}
	});
	// この画面で選んだ値と、そのときの strategyUses。strategyUses が変われば選んだ値を捨てる
	const [chosen, setChosen] = useState<{ uses: boolean; on: boolean } | null>(
		null,
	);
	const set = useCallback(
		(v: boolean) => {
			setChosen({ uses: strategyUses, on: v });
			setSaved(v);
			try {
				localStorage.setItem(DVOL_KEY, v ? "on" : "off");
			} catch {
				// 保存できない環境では、この画面を開いている間だけ効く
			}
		},
		[strategyUses],
	);
	return [
		chosen && chosen.uses === strategyUses ? chosen.on : strategyUses || saved,
		set,
	];
}
