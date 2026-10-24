// ホームと戦略の画面が読む口をまとめて偽物にする。戦略の操作（オンオフ・名前・条件・削除・リセット）は state に反映し、次の読み込みで画面に返す
import type {
	AutoTradingStatus,
	CollectorStatus,
	StoredOrder,
	StoredStrategy,
} from "@trading-studio/backend";
import type {
	Instrument,
	StrategyWatch,
	Timeframe,
	WatchMove,
} from "@trading-studio/core";
import {
	BTC_JPY,
	ETH_JPY,
	findInstrument,
	TIMEFRAME_MS,
	XRP_JPY,
} from "@trading-studio/core";
import type { FakeApi } from "./fake-api";
import { routes } from "./fake-api";
import {
	chartBars,
	judgmentSeries,
	marketLatest,
	neutralJudgment,
	storedStrategy,
	tradingPerformance,
	tradingRun,
} from "./fixtures";

export type HomeState = {
	strategies: StoredStrategy[];
	runs: AutoTradingStatus[];
	orders: StoredOrder[];
	/** 今の価格。最新価格の口が返す */
	price: number;
	collector: CollectorStatus;
	/** 見張りの次の動き。null なら買いの発動価格1つ */
	moves: WatchMove[] | null;
	/** 買いが2つ以上の戦略として次の動きを返す（種類に買いの名前を添える） */
	multiBuy?: boolean;
	/** BTC/JPY 以外の銘柄の今の価格（銘柄の id ごと）。無ければ price */
	prices?: Record<string, number>;
	/** 銘柄ごとの見張りの次の動き。無ければ moves */
	movesOf?: Record<string, WatchMove[]>;
};

/** BTC・ETH・XRP を候補にし、ETH と XRP を持っている戦略（ADR 0037） */
export function multiInstrumentRun(
	over: Partial<AutoTradingStatus> & Pick<AutoTradingStatus, "id" | "name">,
): AutoTradingStatus {
	const base = tradingRun(over);
	const holding = (
		instrument: Instrument,
		quantity: number,
		entry: number,
		price: number,
	) => ({
		instrument: instrument.id,
		position: { quantity, entryPrice: entry, openedAt: 0 },
		lots: [
			{
				id: `${instrument.quantityUnit}1`,
				quantity,
				entryPrice: entry,
				openedAt: 0,
				partialExitDone: false,
				buyId: "b1",
			},
		],
		price,
	});
	return {
		...base,
		instruments: [BTC_JPY, ETH_JPY, XRP_JPY],
		account: {
			...base.account,
			cash: 800_000,
			holdings: [
				{
					instrument: BTC_JPY.id,
					position: { quantity: 0, entryPrice: null, openedAt: null },
					lots: [],
					price: 10_000_000,
				},
				holding(ETH_JPY, 18_000, 500_000, 520_000),
				holding(XRP_JPY, 52_000, 200_000, 210_000),
			],
		},
		...over,
	};
}

/** 買いの発動価格が1つある見張り */
function watchOf(price: number, moves: WatchMove[] | null): StrategyWatch {
	const trigger = Math.round(price * 0.98);
	return {
		price,
		buys: [
			{
				id: "b1",
				name: "買い1",
				maxPositions: 1,
				holding: 0,
				status: { kind: "ready" },
				buy: {
					match: "all",
					conditions: [
						{
							condition: {
								type: "breakout",
								timeframe: "1h",
								lookback: 24,
								direction: "low",
							},
							met: false,
							detail: "",
							edge: { price: trigger, metAbove: false },
						},
					],
					met: false,
					triggers: [trigger],
				},
				lots: [],
			},
		],
		actions: [
			{
				kind: "entry",
				price: trigger,
				buyId: "b1",
				buyName: "買い1",
				lotId: null,
			},
		],
		moves: moves ?? [
			{
				kind: "entry",
				buyId: "b1",
				buyName: "買い1",
				trigger: { kind: "price", price: trigger },
			},
		],
	};
}

const RUN_NOT_FOUND = {
	kind: "not_found",
	message: "戦略が見つからない",
} as const;

export function onHome(api: FakeApi, init: Partial<HomeState> = {}): HomeState {
	const state: HomeState = {
		strategies: [],
		runs: [tradingRun({ id: 1, name: "デモ" })],
		orders: [],
		price: 10_000_000,
		collector: marketLatest().collector,
		moves: null,
		...init,
	};
	const find = (id: string) => state.runs.find((r) => r.id === Number(id));
	const priceOf = (id: string | null | undefined) =>
		(id && state.prices?.[id]) || state.price;
	const instrumentQuery = (q: URLSearchParams) =>
		findInstrument(q.get("instrument") ?? "") ?? BTC_JPY;
	const performanceOf = (run: AutoTradingStatus) => {
		const { initialCash, equity } = run.account;
		const pnl = equity === null ? null : equity - initialCash;
		const sells = (id: string) =>
			state.orders.filter(
				(o) => o.runId === run.id && o.side === "sell" && o.instrument === id,
			);
		return tradingPerformance({
			...(run.instruments.length > 1
				? {
						realizedPnl: run.instruments.reduce(
							(n, i) => n + sells(i.id).reduce((m, o) => m + (o.pnl ?? 0), 0),
							0,
						),
						byInstrument: Object.fromEntries(
							run.instruments.map((i) => [
								i.id,
								{
									realizedPnl: sells(i.id).reduce(
										(n, o) => n + (o.pnl ?? 0),
										0,
									),
									trades: sells(i.id).length,
									wins: 0,
									losses: 0,
									winRate: null,
									profitFactor: null,
									averageHoldingMs: null,
								},
							]),
						),
					}
				: {}),
			resetAt: run.account.resetAt,
			initialCash,
			cash: run.account.cash,
			position: run.account.position,
			price: state.price,
			equity,
			pnl,
			pnlPercent: pnl === null ? null : (pnl / initialCash) * 100,
			trades: state.orders.filter((o) => o.side === "sell").length,
		});
	};
	const update = (id: string, patch: Partial<AutoTradingStatus>) => {
		const run = find(id);
		if (run) Object.assign(run, patch);
		return run;
	};
	api
		.on(routes.api.market.latest, "$get", (req) =>
			marketLatest({
				price: priceOf(req.query.get("instrument")),
				priceTime: Date.now(),
				price24hAgo: 9_800_000,
				collector: state.collector,
			}),
		)
		.on(routes.api.market.bars, "$get", (req) => ({
			instrument: instrumentQuery(req.query),
			bars: chartBars(req.query.get("timeframe") as Timeframe, Date.now()),
		}))
		.on(routes.api.data.coverage, "$get", () => ({ timeframes: [] }))
		.on(routes.api.data.latest, "$get", () => ({
			instrument: BTC_JPY,
			latest: null,
		}))
		.on(routes.api.strategies, "$get", () => ({
			strategies: state.strategies,
		}))
		.on(routes.api.judgments.current, "$get", () => neutralJudgment(Date.now()))
		.on(routes.api.judgments.series, "$get", (req) => {
			const step = TIMEFRAME_MS[req.query.get("timeframe") as Timeframe];
			return judgmentSeries(
				Number(req.query.get("from")),
				Number(req.query.get("to")),
				step,
			);
		})
		.on(routes.api.trading.strategies, "$get", () => ({
			strategies: state.runs,
		}))
		.on(routes.api.strategies, "$post", (req) => {
			const { name, from } = req.body as {
				name: string;
				from: { copyOf: number } | { template: string };
			};
			const id = Math.max(0, ...state.runs.map((r) => r.id)) + 1;
			const source =
				"copyOf" in from
					? state.strategies.find((x) => x.id === from.copyOf)
					: undefined;
			const strategy = storedStrategy({
				id,
				name,
				...(source ? { params: source.params } : {}),
			});
			state.strategies.push(strategy);
			state.runs.push(tradingRun({ id, name }));
			return { strategy };
		})
		.on(routes.api.strategies[":id"].name, "$put", (req, reply) => {
			const { name } = req.body as { name: string };
			const run = update(req.params.id as string, { name });
			return run
				? { strategy: storedStrategy({ id: run.id, name }) }
				: reply(404, RUN_NOT_FOUND);
		})
		.on(routes.api.strategies[":id"].params, "$put", (req, reply) => {
			const s = state.strategies.find((x) => x.id === Number(req.params.id));
			if (!s) return reply(404, RUN_NOT_FOUND);
			s.params = (req.body as { params: StoredStrategy["params"] }).params;
			return { strategy: s };
		})
		.on(routes.api.strategies[":id"], "$delete", (req) => {
			state.runs = state.runs.filter((r) => r.id !== Number(req.params.id));
			return { ok: true as const };
		})
		.on(routes.api.trading.strategies[":id"].start, "$post", (req, reply) => {
			const run = update(req.params.id as string, {
				enabled: true,
				strategyLock: "running",
			});
			return run ? { status: run } : reply(404, RUN_NOT_FOUND);
		})
		.on(routes.api.trading.strategies[":id"].stop, "$post", (req, reply) => {
			const run = update(req.params.id as string, {
				enabled: false,
				strategyLock: null,
			});
			return run ? { status: run } : reply(404, RUN_NOT_FOUND);
		})
		.on(routes.api.trading.strategies[":id"].reset, "$post", (req, reply) => {
			const run = find(req.params.id as string);
			if (!run) return reply(404, RUN_NOT_FOUND);
			const { initialCash } = req.body as { initialCash: number };
			run.account = {
				...tradingRun({ id: run.id, name: run.name }).account,
				initialCash,
				cash: initialCash,
				equity: initialCash,
				resetAt: Date.now(),
			};
			run.ranSinceReset = false;
			return { status: run };
		})
		.on(
			routes.api.trading.strategies[":id"].performance,
			"$get",
			(req, reply) => {
				const run = find(req.params.id as string);
				if (!run) return reply(404, RUN_NOT_FOUND);
				return { performance: performanceOf(run) };
			},
		)
		.on(routes.api.trading.strategies[":id"].watch, "$get", (req, reply) => {
			const run = find(req.params.id as string);
			if (!run) return reply(404, RUN_NOT_FOUND);
			const instrument = instrumentQuery(req.query);
			return {
				instrument,
				watch: watchOf(
					priceOf(instrument.id),
					state.movesOf?.[instrument.id] ?? state.moves,
				),
			};
		})
		.on(routes.api.trading.summaries, "$get", () => ({
			summaries: state.runs
				.filter(
					(r) =>
						r.mode === "paper" && (r.enabled || r.strategyLock === "holding"),
				)
				.map((status) => {
					const watchFor = (id: string) =>
						watchOf(priceOf(id), state.movesOf?.[id] ?? state.moves);
					const w = watchFor(status.instrument.id);
					return {
						status,
						performance: performanceOf(status),
						nextMoves: {
							price: w.price,
							moves: w.moves,
							multiBuy: state.multiBuy ?? false,
							...(status.instruments.length > 1
								? {
										markets: status.instruments.map((i) => {
											const m = watchFor(i.id);
											return {
												instrument: i.id,
												price: m.price,
												moves: m.moves,
											};
										}),
									}
								: {}),
						},
					};
				}),
		}))
		.on(routes.api.trading.orders, "$get", (req) => {
			const q = req.query;
			const hit = state.orders.filter(
				(o) =>
					(!q.has("strategy") || o.runId === Number(q.get("strategy"))) &&
					(!q.has("status") || o.status === q.get("status")) &&
					(!q.has("side") || o.side === q.get("side")) &&
					(!q.has("instrument") || o.instrument === q.get("instrument")),
			);
			return {
				orders: hit.slice(0, Number(q.get("limit") ?? hit.length)),
				count: hit.length,
				realizedPnl: hit.reduce((n, o) => n + (o.pnl ?? 0), 0),
				currency: BTC_JPY.currency,
			};
		})
		.on(routes.api.trading.orders[":strategy"][":id"], "$get", (req, reply) => {
			const order = state.orders.find((o) => o.id === req.params.id);
			if (!order) return reply(404, { message: "注文が見つからない" });
			return { order, judgments: { sentiment: "+1", risk: "calm" } };
		});
	return state;
}
