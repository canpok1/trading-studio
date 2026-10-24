// 自動取引の状態（戦略ごと）。全画面の上部の帯と戦略の画面で使うので、画面の枠で1つ持って問い合わせる

import type {
	AutoTradingStatus,
	OrderSummary,
	StoredOrder,
	StrategyLock,
	TradingMode,
	TradingPerformance,
} from "@trading-studio/backend";
import type { Instrument, StrategyWatch } from "@trading-studio/core";
import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { useApi } from "./api";
import {
	errorMessage,
	readJson,
	useInterval,
	usePageVisible,
} from "./useAsync";

/** 状態と注文を問い合わせる間隔（ホームの最新価格と同じ） */
const STATUS_MS = 5_000;

type TradingStatusValue = {
	/** 戦略ごとの状態（作った順）。まだ読めていなければ null */
	runs: AutoTradingStatus[] | null;
	/** 読み直す。操作の後など */
	refresh: () => Promise<void>;
	/** 操作の応答で受け取った状態をすぐ反映する。無い戦略なら足す */
	set: (s: AutoTradingStatus) => void;
	/** 消した戦略をすぐ外す */
	drop: (id: number) => void;
};

const TradingStatusContext = createContext<TradingStatusValue | null>(null);

export const MODE_LABELS: Record<TradingMode, string> = {
	paper: "デモ",
	live: "リアル",
};

export function TradingStatusProvider({ children }: { children: ReactNode }) {
	const api = useApi();
	const visible = usePageVisible();
	const [runs, setRuns] = useState<AutoTradingStatus[] | null>(null);
	// 操作の応答より前に出した問い合わせの結果で、新しい状態を上書きしないため
	const seq = useRef(0);
	const set = useCallback((s: AutoTradingStatus) => {
		seq.current++;
		setRuns((rs) => {
			const list = rs ?? [];
			return list.some((r) => r.id === s.id)
				? list.map((r) => (r.id === s.id ? s : r))
				: [...list, s];
		});
	}, []);
	const drop = useCallback((id: number) => {
		seq.current++;
		setRuns((rs) => rs?.filter((r) => r.id !== id) ?? rs);
	}, []);
	const refresh = useCallback(async () => {
		const my = ++seq.current;
		try {
			const r = await api.api.trading.strategies
				.$get()
				.then((res) => readJson<{ strategies: AutoTradingStatus[] }>(res));
			if (my === seq.current) setRuns(r.strategies);
		} catch {
			// 帯とホームの表示は前のまま残す。ホームの操作の失敗はホームで出す
		}
	}, [api]);
	useEffect(() => {
		if (visible) refresh();
	}, [visible, refresh]);
	useInterval(refresh, STATUS_MS, visible);
	return (
		<TradingStatusContext.Provider value={{ runs, refresh, set, drop }}>
			{children}
		</TradingStatusContext.Provider>
	);
}

export function useTradingStatus(): TradingStatusValue {
	const v = useContext(TradingStatusContext);
	if (!v) throw new Error("TradingStatusProvider の外で使っている");
	return v;
}

/** 戦略の条件の変更を止めている理由（サーバーも 409 で止める）。オンなら running、保有か未約定の注文があれば holding */
export function strategyLockOf(
	runs: readonly AutoTradingStatus[] | null,
	strategyId: number,
): StrategyLock | null {
	return runs?.find((r) => r.id === strategyId)?.strategyLock ?? null;
}

export type OrderQuery = {
	strategyId?: number;
	status?: StoredOrder["status"];
	side?: StoredOrder["side"];
	/** 銘柄の id */
	instrument?: string;
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
						...(q.strategyId !== undefined && {
							strategy: String(q.strategyId),
						}),
						...(q.status && { status: q.status }),
						...(q.side && { side: q.side }),
						...(q.instrument && { instrument: q.instrument }),
						...(q.limit && { limit: String(q.limit) }),
					},
				})
				.then((res) => readJson<{ orders: StoredOrder[] } & OrderSummary>(res));
			if (my === seq.current) {
				setState({
					key,
					orders: r.orders,
					summary: {
						count: r.count,
						realizedPnl: r.realizedPnl,
						currency: r.currency,
					},
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

/** 口座をリセットした時点以降の成績を読み、5秒ごとに読み直す。読めなければ前の値を残す */
export function useTradingPerformance(strategyId: number, active: boolean) {
	const api = useApi();
	// どの戦略の成績かを持ち、切り替え直後に別の戦略の成績を出さない
	const [loaded, setLoaded] = useState<{
		strategyId: number;
		performance: TradingPerformance;
	} | null>(null);
	const [error, setError] = useState<{
		strategyId: number;
		message: string;
	} | null>(null);
	const seq = useRef(0);
	const load = useCallback(async () => {
		const my = ++seq.current;
		try {
			const r = await api.api.trading.strategies[":id"].performance
				.$get({ param: { id: String(strategyId) } })
				.then((res) => readJson<{ performance: TradingPerformance }>(res));
			if (my === seq.current) {
				setLoaded({ strategyId, performance: r.performance });
				setError(null);
			}
		} catch (e) {
			if (my === seq.current)
				setError({ strategyId, message: errorMessage(e) });
		}
	}, [api, strategyId]);
	useEffect(() => {
		if (active) load();
	}, [active, load]);
	useInterval(load, STATUS_MS, active);
	return {
		performance: loaded?.strategyId === strategyId ? loaded.performance : null,
		error: error?.strategyId === strategyId ? error.message : null,
		reload: load,
	};
}

/**
 * 戦略を今の価格で試算した見張りを読み、5秒ごとに読み直す。読めなければ前の値を残す。
 * instrument は見張る銘柄の id（null なら候補の先頭）
 */
export function useStrategyWatch(
	strategyId: number,
	instrument: string | null,
	active: boolean,
) {
	const api = useApi();
	// どの戦略・銘柄の見張りかを持ち、切り替え直後に前の見張りを出さない
	const key = `${strategyId}:${instrument}`;
	const [loaded, setLoaded] = useState<{
		key: string;
		instrument: Instrument;
		watch: StrategyWatch | null;
	} | null>(null);
	const seq = useRef(0);
	const load = useCallback(async () => {
		const my = ++seq.current;
		// 銘柄は API の型に出していないので、変数に入れて渡す
		const args: {
			param: { id: string };
			query: { instrument?: string };
		} = {
			param: { id: String(strategyId) },
			query: instrument ? { instrument } : {},
		};
		try {
			const r = await api.api.trading.strategies[":id"].watch
				.$get(args)
				.then((res) =>
					readJson<{ instrument: Instrument; watch: StrategyWatch | null }>(
						res,
					),
				);
			if (my === seq.current) {
				setLoaded({ key, instrument: r.instrument, watch: r.watch });
			}
		} catch {
			// 見張りは補助の表示なので、読めなければ前の値のまま残す
		}
	}, [api, strategyId, instrument, key]);
	useEffect(() => {
		if (active) load();
	}, [active, load]);
	useInterval(load, STATUS_MS, active);
	// 見張る銘柄は見張りと一緒に返す。見張りが無ければ null
	return loaded?.key === key && loaded.watch
		? { instrument: loaded.instrument, watch: loaded.watch }
		: null;
}
