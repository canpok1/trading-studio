// 自動取引の状態。全画面の上部の帯とホームで使うので、画面の枠で1つ持って問い合わせる

import type {
	AutoTradingStatus,
	OrderSummary,
	StoredOrder,
	TradingMode,
} from "@trading-studio/backend";
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
import {
	errorMessage,
	readJson,
	useInterval,
	usePageVisible,
} from "./useAsync";

/** 状態と注文を問い合わせる間隔（ホームの最新価格と同じ） */
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

export type OrderQuery = {
	mode?: TradingMode;
	status?: StoredOrder["status"];
	side?: StoredOrder["side"];
	limit?: number;
};

/** 自動取引の注文を新しい順に読み、5秒ごとに読み直す。条件を変えた直後は前の条件の一覧を出さない */
export function useTradingOrders(query: OrderQuery, active: boolean) {
	const api = useApi();
	const key = JSON.stringify(query);
	const [state, setState] = useState<{
		key: string;
		orders: StoredOrder[] | null;
		summary: OrderSummary | null;
		error: string | null;
	}>({ key, orders: null, summary: null, error: null });
	const seq = useRef(0);
	const load = useCallback(async () => {
		const my = ++seq.current;
		const q = JSON.parse(key) as OrderQuery;
		try {
			const r = await api.api.trading.orders
				.$get({
					query: {
						...(q.mode && { mode: q.mode }),
						...(q.status && { status: q.status }),
						...(q.side && { side: q.side }),
						...(q.limit && { limit: String(q.limit) }),
					},
				})
				.then((res) => readJson<{ orders: StoredOrder[] } & OrderSummary>(res));
			if (my === seq.current) {
				setState({
					key,
					orders: r.orders,
					summary: { count: r.count, realizedPnl: r.realizedPnl },
					error: null,
				});
			}
		} catch (e) {
			if (my === seq.current) {
				setState((s) =>
					s.key === key
						? { ...s, error: errorMessage(e) }
						: { key, orders: null, summary: null, error: errorMessage(e) },
				);
			}
		}
	}, [api, key]);
	useEffect(() => {
		if (active) load();
	}, [active, load]);
	useInterval(load, STATUS_MS, active);
	const fresh = state.key === key;
	return {
		orders: fresh ? state.orders : null,
		/** 件数で切らずに数えた件数と実現損益 */
		summary: fresh ? state.summary : null,
		error: fresh ? state.error : null,
		reload: load,
	};
}
