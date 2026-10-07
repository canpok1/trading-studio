// バックテストの API が使う型。app.ts から参照されるため、Bun 固有の型を持ち込まない

import type {
	AggregationRule,
	BacktestOrder,
	BacktestSummary,
	ConditionSet,
	FeeRates,
	Gap,
	Timeframe,
	ValidationError,
} from "@trading-studio/core";
import type { JudgmentSeries } from "../judgments/types";
import type { RescoreCoverage } from "../news/types";
import type { StoredStrategy } from "../strategies/types";

export type BacktestStatus = "running" | "done" | "failed" | "canceled";

export type BacktestInput = {
	/** バックテスト名。戦略とは切り離し、テンプレートにした戦略の名前は引き継がない */
	name: string;
	params: ConditionSet;
	from: number;
	/** この時刻は含まない */
	to: number;
	initialCash: number;
	fees: FeeRates;
	/** 期間内の欠損を承知で実行する */
	skipGaps: boolean;
	/** 市場評価に使う採点の基準の版。null は運用どおり（記事ごとに運用で採点した版）。市場評価の条件が無ければ無視する */
	criteriaVersion: number | null;
};

export type BacktestRun = {
	id: number;
	/** バックテスト名。名前を入れる前の実行は、実行したときの戦略名 */
	name: string;
	params: ConditionSet;
	/**
	 * 条件で使う足のうち最も細かいもの（足を使う条件が無ければ判定に使った足）。AI アドバイスで注文の前後を見せる足に使う。
	 * 条件ごとに足を持つ前の実行は戦略の足の粒度
	 */
	timeframe: Timeframe;
	from: number;
	to: number;
	initialCash: number;
	fees: FeeRates;
	skipGaps: boolean;
	/** 判定と約定に使った足の粒度 */
	stepTimeframe: Timeframe;
	/** データが足りず、判定頻度より粗い間隔でしか判定できなかった */
	stepLimited: boolean;
	status: BacktestStatus;
	/** 実行中の進み具合（0〜1） */
	progress: number;
	startedAt: number;
	finishedAt: number | null;
	barCount: number;
	summary: BacktestSummary | null;
	filledCount: number;
	orderCount: number;
	error: string | null;
	/** 実行したときの AI 判定の集計ルール。記録する前の実行は null */
	aggregationRule: AggregationRule | null;
	/** 市場評価に使った採点の基準の版。null は運用どおり */
	criteriaVersion: number | null;
	/** 1日の損失上限を効かせて実行したか。上限を持つ前の実行は false（params には既定の上限が入って読まれる） */
	dailyLossLimitApplied: boolean;
};

/** チャートに出す注文。時刻と価格は、約定・取消・発注のうち最後の状態のもの */
export type BacktestMarker = {
	id: string;
	side: BacktestOrder["side"];
	status: BacktestOrder["status"];
	time: number;
	price: number;
};

/** チャートに出す足と注文 */
export type BacktestChart = {
	/** bars の粒度。頼んだ粒度の足が期間に無ければ、結果に残した足の粒度 */
	timeframe: Timeframe;
	/** 始値・高値・安値は、4本値を保存する前の実行には無い */
	bars: {
		time: number;
		close: number;
		open?: number;
		high?: number;
		low?: number;
		/** 出来高（satoshi）。結果に残した足には無い */
		volume?: number;
	}[];
	markers: BacktestMarker[];
	/** 足ごとの AI 判定（実行したときの集計ルールで計算）。ルールを記録する前の実行は null */
	judgments: JudgmentSeries | null;
};

export type OrderFilter = "filled" | "all";

/** 実行の一覧の並び。new=実行の新しい順、pnl=損益率の高い順（成績の無いものは最後） */
export type RunSort = "new" | "pnl";

export type RunFilter = {
	limit: number;
	/** 名前のキーワード。空白で区切った語をすべて含むもの */
	q: string;
	/** 失敗・中止を除く */
	hideFailed: boolean;
	sort: RunSort;
};

export type RunListResult = { runs: BacktestRun[]; total: number };

export type StartBacktestResult =
	| { ok: true; run: BacktestRun }
	| { ok: false; error: StartBacktestFailure };

export type StartBacktestFailure =
	| { kind: "busy"; run: BacktestRun }
	| { kind: "invalid_params"; errors: ValidationError[] }
	| { kind: "invalid_input"; field: string; message: string }
	/** データが無い・粗いなど、実行できない */
	| { kind: "no_data"; message: string }
	/** 期間に AI 判定の記録が始まる前が含まれる。firstScoredAt は記録の開始（無ければ null） */
	| { kind: "no_judgments"; message: string; firstScoredAt: number | null }
	/** 指定した版の採点が無い記事がある。採点し直すと実行できる */
	| {
			kind: "missing_scores";
			message: string;
			version: number;
			coverage: RescoreCoverage;
	  }
	/** 期間内に欠損がある。skipGaps で実行し直せる */
	| { kind: "gaps"; gaps: Gap[]; gapCount: number; missingBars: number };

export type SaveRunResult =
	| { ok: true; strategy: StoredStrategy }
	| { ok: false; kind: "not_found" }
	| { ok: false; kind: "strategy"; status: 400 | 404 | 409; message: string };

export interface BacktestService {
	start(input: BacktestInput): StartBacktestResult;
	get(id: number): BacktestRun | null;
	/** 実行中のバックテスト。無ければ null */
	current(): BacktestRun | null;
	/** 実行中なら中止を求める。中止は計算の区切りで効く */
	cancel(id: number): BacktestRun | null;
	list(filter?: Partial<RunFilter>): RunListResult;
	/** timeframe の足で返す。足が maxBars（既定はチャートの上限）より多ければ too_many */
	chart(
		id: number,
		timeframe: Timeframe,
		maxBars?: number,
	):
		| { ok: true; chart: BacktestChart }
		| { ok: false; kind: "not_found" }
		| { ok: false; kind: "too_many"; count: number; max: number };
	orders(
		id: number,
		filter: OrderFilter,
		offset: number,
		limit: number,
	): { orders: ListedBacktestOrder[]; total: number } | null;
	order(id: number, orderId: string): ListedBacktestOrder | null;
	/** 結果の条件を新しい戦略として保存する */
	saveToStrategy(id: number, name: string): SaveRunResult;
}

/** 一覧・詳細で返す注文。売りには売るロットの買値を添える */
export type ListedBacktestOrder = BacktestOrder & { lotPrice: number | null };
