// 自動取引の状態。全画面の上部の帯とホームで使うので、画面の枠で1つ持って問い合わせる

import type { AutoTradingStatus } from "@trading-studio/backend";
import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { useApi } from "../api";
import { readJson, useInterval, usePageVisible } from "./useAsync";

/** 状態を問い合わせる間隔（ホームの最新価格と同じ） */
const STATUS_MS = 5_000;

type TradingStatusValue = {
	/** まだ読めていなければ null */
	status: AutoTradingStatus | null;
	/** 読み直す。操作の後など */
	refresh: () => Promise<void>;
	/** 操作の応答で受け取った状態をすぐ反映する */
	set: (s: AutoTradingStatus) => void;
};

const TradingStatusContext = createContext<TradingStatusValue | null>(null);

export function TradingStatusProvider({ children }: { children: ReactNode }) {
	const api = useApi();
	const visible = usePageVisible();
	const [status, setStatus] = useState<AutoTradingStatus | null>(null);
	// 開始・停止の応答より前に出した問い合わせの結果で、新しい状態を上書きしないため
	const seq = useRef(0);
	const set = useCallback((s: AutoTradingStatus) => {
		seq.current++;
		setStatus(s);
	}, []);
	const refresh = useCallback(async () => {
		const my = ++seq.current;
		try {
			const r = await api.api.trading.status
				.$get()
				.then((res) => readJson<{ status: AutoTradingStatus }>(res));
			if (my === seq.current) setStatus(r.status);
		} catch {
			// 帯とホームの表示は前のまま残す。ホームの操作の失敗はホームで出す
		}
	}, [api]);
	useEffect(() => {
		if (visible) refresh();
	}, [visible, refresh]);
	useInterval(refresh, STATUS_MS, visible);
	return (
		<TradingStatusContext.Provider value={{ status, refresh, set }}>
			{children}
		</TradingStatusContext.Provider>
	);
}

export function useTradingStatus(): TradingStatusValue {
	const v = useContext(TradingStatusContext);
	if (!v) throw new Error("TradingStatusProvider の外で使っている");
	return v;
}
