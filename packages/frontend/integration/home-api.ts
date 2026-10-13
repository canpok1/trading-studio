// ホームが読む口をまとめて偽物にする。タブの操作（戦略の選択・オンオフ・追加・削除・リセット）は state に反映し、次の読み込みで画面に返す
import type {
	AutoTradingStatus,
	CollectorStatus,
	StoredOrder,
	StoredStrategy,
} from "@trading-studio/backend";
import type { StrategyWatch, Timeframe } from "@trading-studio/core";
import { TIMEFRAME_MS } from "@trading-studio/core";
import type { FakeApi } from "./fake-api";
import { routes } from "./fake-api";
import {
	chartBars,
	judgmentSeries,
	marketLatest,
	neutralJudgment,
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
};

/** 運用する戦略を選んでいれば、買いの発動価格が1つある見張り */
function watchOf(price: number): StrategyWatch {
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
	};
}

const RUN_NOT_FOUND = {
	kind: "not_found",
	message: "運用が見つからない",
} as const;

export function onHome(api: FakeApi, init: Partial<HomeState> = {}): HomeState {
	const state: HomeState = {
		strategies: [],
		runs: [tradingRun({ id: 1, name: "デモ" })],
		orders: [],
		price: 10_000_000,
		collector: marketLatest().collector,
		...init,
	};
	const find = (id: string) => state.runs.find((r) => r.id === Number(id));
	const update = (id: string, patch: Partial<AutoTradingStatus>) => {
		const run = find(id);
		if (run) Object.assign(run, patch);
		return run;
	};
	const named = (id: number | null) => {
		const s = state.strategies.find((x) => x.id === id);
		return s ? { id: s.id, name: s.name } : null;
	};
	api
		.on(routes.api.market.latest, "$get", () =>
			marketLatest({
				price: state.price,
				priceTime: Date.now(),
				price24hAgo: 9_800_000,
				collector: state.collector,
			}),
		)
		.on(routes.api.market.bars, "$get", (req) => ({
			bars: chartBars(req.query.get("timeframe") as Timeframe, Date.now()),
		}))
		.on(routes.api.data.coverage, "$get", () => ({ timeframes: [] }))
		.on(routes.api.data.latest, "$get", () => ({ latest: null }))
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
		.on(routes.api.trading.runs, "$get", () => ({ runs: state.runs }))
		.on(routes.api.trading.runs, "$post", (req, reply) => {
			const body = req.body as {
				name: string;
				mode: AutoTradingStatus["mode"];
				strategyId: number | null;
			};
			const run = tradingRun({
				id: Math.max(...state.runs.map((r) => r.id)) + 1,
				name: body.name,
				mode: body.mode,
				strategy: named(body.strategyId),
			});
			state.runs.push(run);
			return reply(201, { status: run });
		})
		.on(routes.api.trading.runs[":id"], "$patch", (req, reply) => {
			const body = req.body as { name?: string; strategyId?: number | null };
			const run = update(req.params.id as string, {
				...(body.name !== undefined && { name: body.name }),
				...(body.strategyId !== undefined && {
					strategy: named(body.strategyId),
				}),
			});
			return run ? { status: run } : reply(404, RUN_NOT_FOUND);
		})
		.on(routes.api.trading.runs[":id"], "$delete", (req) => {
			state.runs = state.runs.filter((r) => r.id !== Number(req.params.id));
			return { ok: true as const };
		})
		.on(routes.api.trading.runs[":id"].start, "$post", (req, reply) => {
			const run = update(req.params.id as string, {
				enabled: true,
				strategyLock: "running",
			});
			return run ? { status: run } : reply(404, RUN_NOT_FOUND);
		})
		.on(routes.api.trading.runs[":id"].stop, "$post", (req, reply) => {
			const run = update(req.params.id as string, {
				enabled: false,
				strategyLock: null,
			});
			return run ? { status: run } : reply(404, RUN_NOT_FOUND);
		})
		.on(routes.api.trading.runs[":id"].reset, "$post", (req, reply) => {
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
			return { status: run };
		})
		.on(routes.api.trading.runs[":id"].performance, "$get", (req, reply) => {
			const run = find(req.params.id as string);
			if (!run) return reply(404, RUN_NOT_FOUND);
			const { account } = run;
			return {
				performance: tradingPerformance({
					resetAt: account.resetAt,
					initialCash: account.initialCash,
					cash: account.cash,
					position: account.position,
					price: state.price,
					equity: account.equity,
					trades: state.orders.filter((o) => o.side === "sell").length,
				}),
			};
		})
		.on(routes.api.trading.runs[":id"].watch, "$get", (req, reply) => {
			const run = find(req.params.id as string);
			if (!run) return reply(404, RUN_NOT_FOUND);
			return { watch: run.strategy ? watchOf(state.price) : null };
		})
		.on(routes.api.trading.orders, "$get", (req) => {
			const q = req.query;
			const hit = state.orders.filter(
				(o) =>
					(!q.has("run") || o.runId === Number(q.get("run"))) &&
					(!q.has("status") || o.status === q.get("status")) &&
					(!q.has("side") || o.side === q.get("side")),
			);
			return {
				orders: hit.slice(0, Number(q.get("limit") ?? hit.length)),
				count: hit.length,
				realizedPnl: hit.reduce((n, o) => n + (o.pnl ?? 0), 0),
			};
		})
		.on(routes.api.trading.orders[":run"][":id"], "$get", (req, reply) => {
			const order = state.orders.find((o) => o.id === req.params.id);
			if (!order) return reply(404, { message: "注文が見つからない" });
			return { order, judgments: { sentiment: "+1", risk: "calm" } };
		});
	return state;
}
