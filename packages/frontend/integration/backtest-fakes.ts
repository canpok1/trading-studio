// バックテストの画面のテスト（backtest.test.tsx・backtest.pw.ts）で使う偽物の API の口と値
import type {
	BacktestChart,
	BacktestRun,
	CriteriaVersion,
	EventCriteriaVersion,
	StoredStrategy,
} from "@trading-studio/backend";
import type {
	BacktestOrder,
	Condition,
	ConditionSet,
	Timeframe,
} from "@trading-studio/core";
import {
	BTC_JPY,
	DEFAULT_AGGREGATION_RULE,
	ETH_JPY,
	strategyTemplate,
	withSellDetails,
	XRP_JPY,
} from "@trading-studio/core";
import type { FakeApi } from "./fake-api";
import { routes } from "./fake-api";
import { backtestRun, timeframeCoverage } from "./fixtures";

export const H = 3_600_000;
/** 過去データは JST 2026-05-01 00:00 から 40 日分 */
export const START = Date.UTC(2026, 3, 30, 15);
export const END = START + 40 * 24 * H;

const USABLE: Timeframe[] = ["1h", "4h"];

const blank = strategyTemplate("blank").params;
const buyRule = blank.buys[0] as ConditionSet["buys"][number];

/** 買いの条件で買い、±1% で売る。既定は1時間足の高値の上抜けで買う */
export function params(
	buy: Condition[] = [
		{ type: "breakout", timeframe: "1h", lookback: 5, direction: "high" },
	],
	over: Partial<ConditionSet> = {},
	takeProfit: Condition[] = [
		{ type: "entryChange", percent: 1, direction: "up" },
	],
): ConditionSet {
	return {
		...blank,
		frequency: {
			flat: { value: 1, unit: "h" },
			holding: { value: 1, unit: "h" },
		},
		buys: [
			{
				...buyRule,
				buy: { match: "all", conditions: buy },
				takeProfit: { match: "any", conditions: takeProfit },
				stopLoss: {
					match: "any",
					conditions: [{ type: "entryChange", percent: 1, direction: "down" }],
				},
			},
		],
		...over,
	};
}

export type RunPageSetup = {
	strategies?: StoredStrategy[];
	/** 採点の記録の始まり。null はまだ無い */
	firstScoredAt?: number | null;
	criteriaVersions?: CriteriaVersion[];
	/** 予定の評価基準の版。最後のものを使用中にする */
	eventCriteriaVersions?: EventCriteriaVersion[];
	/** 30日目の1時間足を3本欠かす */
	gap?: boolean;
};

/** 実行の画面が読む口。過去データは1時間足と4時間足。相場データ・データセットは無い */
export function onRunPage(
	api: FakeApi,
	{
		strategies = [],
		firstScoredAt = null,
		criteriaVersions = [],
		eventCriteriaVersions = [],
		gap = false,
	}: RunPageSetup = {},
): FakeApi {
	const gapFrom = START + 30 * 24 * H;
	const gaps = gap ? [{ from: gapFrom, to: gapFrom + 3 * H, missing: 3 }] : [];
	return api
		.on(routes.api.strategies, "$get", () => ({ strategies }))
		.on(routes.api.data.coverage, "$get", () => ({
			timeframes: [
				timeframeCoverage("1h", START, END, { gaps, gapCount: gaps.length }),
				timeframeCoverage("4h", START, END),
			],
		}))
		.on(routes.api.data.latest, "$get", () => ({
			instrument: BTC_JPY,
			latest: null,
		}))
		.on(routes.api.data["usable-timeframes"], "$get", () => ({
			timeframes: USABLE,
		}))
		.on(routes.api.judgments.current, "$get", () => ({
			time: END,
			rule: DEFAULT_AGGREGATION_RULE,
			results: {
				sentiment: { value: "0" as const, average: null, count: 0 },
				risk: { value: "calm" as const, average: null, count: 0 },
			},
			weights: {},
			breakdown: { sentiment: [], risk: [] },
			firstScoredAt,
		}))
		.on(routes.api.scoring.criteria, "$get", () => ({
			versions: criteriaVersions,
			activeVersion: criteriaVersions.at(-1)?.version ?? null,
			template: "",
		}))
		.on(routes.api.calendar.criteria, "$get", () => ({
			versions: eventCriteriaVersions,
			activeVersion: eventCriteriaVersions.at(-1)?.version ?? null,
			template: "",
		}))
		.on(routes.api.segments, "$get", () => ({ segments: [] }))
		.on(routes.api.datasets, "$get", () => ({ datasets: [] }));
}

/** 買って +1% で売った往復 */
export const ORDERS: BacktestOrder[] = [
	{
		id: "o1",
		side: "buy",
		type: "limit",
		price: 10_000_000,
		quantity: 1_000_000,
		placedAt: Date.UTC(2026, 4, 5),
		status: "filled",
		filledAt: Date.UTC(2026, 4, 5, 1),
		fillPrice: 10_000_000,
		fee: 0,
		canceledAt: null,
		cancelReason: null,
		reason: "1時間足の終値が直近 5 本の最高値を上抜けた",
		pairId: "o2",
		pnl: null,
	},
	{
		id: "o2",
		side: "sell",
		type: "market",
		price: null,
		quantity: 1_000_000,
		placedAt: Date.UTC(2026, 4, 5, 3),
		status: "filled",
		filledAt: Date.UTC(2026, 4, 5, 3),
		fillPrice: 10_100_000,
		fee: 101,
		canceledAt: null,
		cancelReason: null,
		reason: "買値から +1.0%。買値 10,000,000円 のロットを売却（利確の条件）",
		pairId: "o1",
		pnl: 899,
		exitKind: "takeProfit",
	},
];

/** from から1時間足を n 本。2日周期で ±5% 動く */
export function chartBars(from: number, n: number): BacktestChart["bars"] {
	return Array.from({ length: n }, (_, i) => {
		const close = Math.round(
			10_000_000 * (1 + 0.05 * Math.sin((2 * Math.PI * i) / 48)),
		);
		return {
			time: from + i * H,
			open: close,
			high: close + 10_000,
			low: close - 10_000,
			close,
		};
	});
}

/**
 * 結果の画面が読む口。実行中の実行は、問い合わせると終わる。
 * chart を渡さなければチャートは読み込み中のまま（lightweight-charts は happy-dom で描けないため）
 */
export function onResults(
	api: FakeApi,
	runs: Map<number, BacktestRun>,
	chart?: BacktestChart,
): FakeApi {
	return api
		.on(routes.api.backtests[":id"], "$get", ({ params }, reply) => {
			const run = runs.get(Number(params.id));
			if (!run) return reply(404, { message: "無い" });
			if (run.status === "running") {
				runs.set(run.id, { ...run, status: "done", progress: 1 });
			}
			return { run };
		})
		.on(routes.api.backtests[":id"].chart, "$get", () =>
			chart ? chart : new Promise<never>(() => {}),
		)
		.on(routes.api.backtests[":id"].orders, "$get", () => ({
			orders: withSellDetails(ORDERS, BTC_JPY),
			total: ORDERS.length,
		}))
		.on(
			routes.api.backtests[":id"].orders[":orderId"],
			"$get",
			({ params }, reply) => {
				const order = withSellDetails(ORDERS, BTC_JPY).find(
					(o) => o.id === params.orderId,
				);
				return order ? { order } : reply(404, { message: "無い" });
			},
		)
		.on(routes.api.advice.runs[":id"], "$get", () => ({ advice: null }));
}

/** 結果の画面で使う、成績まで出た実行。期間は JST 2026-05-03〜05-25 */
export function resultRun(
	over: Partial<BacktestRun> & Pick<BacktestRun, "id" | "name">,
): BacktestRun {
	return backtestRun({
		params: strategyTemplate("blank").params,
		timeframe: "1h",
		from: Date.UTC(2026, 4, 2, 15),
		to: Date.UTC(2026, 4, 25, 15),
		initialCash: 2_000_000,
		fees: { limitPpm: 0, marketPpm: 1_000 },
		skipGaps: false,
		stepTimeframe: "1h",
		stepLimited: false,
		status: "done",
		progress: 1,
		startedAt: Date.UTC(2026, 5, 1),
		finishedAt: Date.UTC(2026, 5, 1),
		barCount: 552,
		summary: {
			initialCash: 2_000_000,
			finalEquity: 2_010_000,
			pnl: 10_000,
			pnlPercent: 0.5,
			trades: 1,
			wins: 1,
			losses: 0,
			winRate: 100,
			profitFactor: null,
			maxDrawdownPercent: 0.2,
			maxDrawdownFrom: null,
			maxDrawdownTo: null,
			averageHoldingMs: 3_600_000,
			openPositionQuantity: 0,
		},
		filledCount: 0,
		orderCount: 0,
		error: null,
		aggregationRule: null,
		criteriaVersion: null,
		newsDelayMs: null,
		newsDataVersion: null,
		segment: null,
		datasetRunId: null,
		dailyLossLimitApplied: true,
		...over,
	});
}

/** 候補が BTC・ETH・XRP の実行の ETH の往復（0.15 ETH を 50 万円で買い 51 万円で売る） */
export const ETH_ORDERS: BacktestOrder[] = [
	{
		...(ORDERS[0] as BacktestOrder),
		id: "e1",
		instrument: ETH_JPY.id,
		price: 500_000,
		fillPrice: 500_000,
		quantity: 15_000,
		pairId: "e2",
		placedAt: Date.UTC(2026, 4, 6),
		filledAt: Date.UTC(2026, 4, 6, 1),
	},
	{
		...(ORDERS[1] as BacktestOrder),
		id: "e2",
		instrument: ETH_JPY.id,
		fillPrice: 510_000,
		quantity: 15_000,
		pairId: "e1",
		reason: "買値から +2.0%（利確の条件）",
		pnl: 1_347,
		placedAt: Date.UTC(2026, 4, 7),
		filledAt: Date.UTC(2026, 4, 7),
	},
];

/** 候補が BTC・ETH・XRP、同時に2銘柄まで、順位付きの実行。pnl は銘柄ごとの損益を上書きする */
export function multiRun(
	id: number,
	pnl: Partial<Record<string, number>> = {},
): BacktestRun {
	const base = resultRun({
		id,
		name: "3銘柄で上昇率順",
		instruments: [BTC_JPY, ETH_JPY, XRP_JPY],
		params: params(undefined, {
			maxHoldings: 2,
			ranking: {
				indicator: "return",
				timeframe: "1h",
				period: 24,
				order: "desc",
			},
			buys: [{ ...buyRule, orderAmount: 100_000 }],
		}),
		orderCount: ORDERS.length + ETH_ORDERS.length,
		filledCount: ORDERS.length + ETH_ORDERS.length,
	});
	const summary = base.summary as NonNullable<BacktestRun["summary"]>;
	const one = {
		trades: 1,
		wins: 1,
		losses: 0,
		winRate: 100,
		profitFactor: null,
		averageHoldingMs: 3_600_000,
		buyHoldPercent: 1.5,
		openPositionQuantity: 0,
	};
	return {
		...base,
		summary: {
			...summary,
			trades: 2,
			wins: 2,
			buyHoldPercent: 1.1,
			byInstrument: {
				[BTC_JPY.id]: { ...one, pnl: pnl[BTC_JPY.id] ?? 899 },
				[ETH_JPY.id]: { ...one, pnl: pnl[ETH_JPY.id] ?? 1_347 },
				[XRP_JPY.id]: {
					...one,
					pnl: pnl[XRP_JPY.id] ?? -200,
					trades: 0,
					wins: 0,
					winRate: null,
					averageHoldingMs: null,
					buyHoldPercent: -2.3,
					openPositionQuantity: 50_000,
				},
			},
		},
	};
}

/** 候補が2つ以上の実行の結果の画面が読む口。注文は銘柄で絞る */
export function onMultiResults(
	api: FakeApi,
	run: BacktestRun,
	chart?: BacktestChart,
): FakeApi {
	const all = [
		...withSellDetails(ORDERS, BTC_JPY),
		...withSellDetails(ETH_ORDERS, ETH_JPY),
	];
	const of = (q: URLSearchParams) => {
		const i = q.get("instrument");
		return i ? all.filter((o) => (o.instrument ?? BTC_JPY.id) === i) : all;
	};
	return onResults(api, new Map([[run.id, run]]), chart)
		.on(routes.api.backtests[":id"].orders, "$get", ({ query }) => ({
			orders: of(query),
			total: of(query).length,
		}))
		.on(
			routes.api.backtests[":id"].orders[":orderId"],
			"$get",
			({ params }, reply) => {
				const order = all.find((o) => o.id === params.orderId);
				return order ? { order } : reply(404, { message: "無い" });
			},
		)
		.on(routes.api.backtests[":id"].equity, "$get", () => ({
			equity: Array.from({ length: 23 }, (_, i) => ({
				time: run.from + i * 24 * H,
				value: 2_000_000 + Math.round(5_000 * Math.sin(i / 3)) + i * 100,
			})),
		}));
}
