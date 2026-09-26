// 分析用の ZIP を作る。表ごとの CSV と、列の意味・単位を書いた README.md を入れる。
// README は表の定義（TABLES の列）から作るので、列を足せば説明も必ず載る

import type {
	AggregationRule,
	BacktestOrder,
	DecisionLog,
	Judge,
	ScoredNews,
	Trade,
} from "@trading-studio/core";
import {
	CSV_HEADER,
	formatCandleCsvRow,
	formatJstRfc3339,
	JUDGES,
	judgeAt,
} from "@trading-studio/core";
import type { BacktestRepository } from "../backtests/repository";
import type { BacktestRun } from "../backtests/types";
import type { MarketDataService } from "../market-data/types";
import type { ScoreRepository } from "../news/score-repository";
import type {
	AnalysisExportRepository,
	DecisionExportRow,
	NewsExportRow,
	OrderExportRow,
	StrategyExportRow,
} from "./repository";
import type { AnalysisExportService } from "./types";
import { createZip } from "./zip";

const HOUR = 3_600_000;

type Cell = string | number | boolean | null | undefined;

type Column<T> = { name: string; desc: string; value: (row: T) => Cell };

type Table<T> = {
	file: string;
	desc: string;
	columns: Column<T>[];
};

/** 時刻の列。エポックミリ秒と JST の文字列の2列にする */
function time<T>(
	name: string,
	desc: string,
	get: (row: T) => number | null,
): Column<T>[] {
	return [
		{ name, desc: `${desc}（UTC のエポックミリ秒）`, value: get },
		{
			name: `${name}_jst`,
			desc: `${desc}（JST）`,
			value: (r) => {
				const v = get(r);
				return v === null ? null : formatJstRfc3339(v);
			},
		},
	];
}

function col<T>(
	name: string,
	desc: string,
	value: (row: T) => Cell,
): Column<T> {
	return { name, desc, value };
}

function csvCell(v: Cell): string {
	if (v === null || v === undefined) return "";
	const s = String(v);
	return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv<T>(table: Table<T>, rows: readonly T[]): string {
	const lines = [table.columns.map((c) => c.name).join(",")];
	for (const r of rows) {
		lines.push(table.columns.map((c) => csvCell(c.value(r))).join(","));
	}
	return `${lines.join("\n")}\n`;
}

const json = (v: unknown) => JSON.stringify(v);

// ---- AI 判定の精度向上用 ----

const SCORE_STATUS =
	"採点の状態。done: 採点済み / retry: 再試行を待っている / failed: 採点に失敗 / skipped: 古いので採点しない / unscored: まだ採点していない";

const newsTable: Table<NewsExportRow> = {
	file: "news.csv",
	desc: "ニュースと AI の採点。1行が1記事。採点に失敗したもの・まだ採点していないものも状態付きで入れる",
	columns: [
		col("news_id", "ニュースの ID", (r) => r.id),
		col("source_id", "取得元の ID", (r) => r.source_id),
		col("source_name", "取得したときの取得元の名前", (r) => r.source_name),
		col("language", "言語（ja / en）", (r) => r.language),
		col("title", "見出し", (r) => r.title),
		col("summary", "概要（RSS の本文。無ければ空）", (r) => r.summary),
		col("url", "記事の URL", (r) => r.url),
		...time<NewsExportRow>(
			"published_at",
			"公開時刻。RSS に無ければ取得時刻",
			(r) => r.published_at,
		),
		...time<NewsExportRow>("fetched_at", "取得時刻", (r) => r.fetched_at),
		col("score_status", SCORE_STATUS, (r) => r.status ?? "unscored"),
		col(
			"trend",
			"トレンドの点数（0〜100、高いほど上昇）。関係なし・採点済みでなければ空",
			(r) => (r.status === "done" ? r.trend : null),
		),
		col(
			"risk",
			"リスクの点数（0〜100、高いほど危険）。関係なし・採点済みでなければ空",
			(r) => (r.status === "done" ? r.risk : null),
		),
		col(
			"sentiment",
			"センチメントの点数（0〜100、高いほど強気）。関係なし・採点済みでなければ空",
			(r) => (r.status === "done" ? r.sentiment : null),
		),
		col("comment", "AI が書いた採点の理由", (r) => r.comment),
		...time<NewsExportRow>(
			"scored_at",
			"採点した時刻。これより前の判定には使わない",
			(r) => r.scored_at,
		),
		col(
			"criteria_version",
			"採点に使った基準の版（scoring_criteria.csv の version）",
			(r) => r.criteria_version,
		),
		col("model", "採点に使った AI のモデル", (r) => r.model),
		col("attempts", "採点に失敗した回数", (r) => r.attempts),
		col("error", "最後に採点に失敗した理由", (r) => r.error),
	],
};

type Criteria = {
	version: number;
	text: string;
	note: string;
	createdAt: number;
	active: boolean;
};

const criteriaTable: Table<Criteria> = {
	file: "scoring_criteria.csv",
	desc: "AI に渡す採点の基準。全版を入れる（版は上書きせずに足していく）",
	columns: [
		col("version", "版", (r) => r.version),
		col("active", "今使っている版なら true", (r) => r.active),
		...time<Criteria>("created_at", "版を作った時刻", (r) => r.createdAt),
		col("note", "版の説明", (r) => r.note),
		col("text", "基準の本文", (r) => r.text),
	],
};

type RuleRow = { key: string; value: number; desc: string };

const ruleTable: Table<RuleRow> = {
	file: "aggregation_rule.csv",
	desc: "今の集計ルール（ニュースの点数から判定を出すルール）。judgments.csv はこのルールで計算している",
	columns: [
		col("key", "項目", (r) => r.key),
		col("value", "値", (r) => r.value),
		col("description", "項目の意味", (r) => r.desc),
	],
};

function ruleRows(rule: AggregationRule): RuleRow[] {
	const t = rule.thresholds;
	return [
		{
			key: "window_hours",
			value: rule.windowHours,
			desc: "集計に使うニュースの期間（時間）。新しさの時刻がこの時間内のものを使う",
		},
		{
			key: "half_life_hours",
			value: rule.halfLifeHours,
			desc: "重みの半減期（時間）。新しさの時刻からこの時間で重みが半分になる",
		},
		{ key: "trend_up", value: t.trend.up, desc: "平均点がこれ以上なら上昇" },
		{
			key: "trend_down",
			value: t.trend.down,
			desc: "平均点がこれ以下なら下落（間はレンジ）",
		},
		{
			key: "risk_caution",
			value: t.risk.caution,
			desc: "平均点がこれ以上なら警戒",
		},
		{
			key: "risk_crisis",
			value: t.risk.crisis,
			desc: "平均点がこれ以上なら危機（警戒未満は平常）",
		},
		{
			key: "sentiment_plus2",
			value: t.sentiment.plus2,
			desc: "平均点がこれ以上なら +2",
		},
		{
			key: "sentiment_plus1",
			value: t.sentiment.plus1,
			desc: "平均点がこれ以上なら +1",
		},
		{
			key: "sentiment_minus1",
			value: t.sentiment.minus1,
			desc: "平均点がこれ未満なら −1",
		},
		{
			key: "sentiment_minus2",
			value: t.sentiment.minus2,
			desc: "平均点がこれ未満なら −2（どれにも当たらなければ 0）",
		},
	];
}

type JudgmentRow = {
	time: number;
	/** 採点の記録が始まる前は null */
	results: ReturnType<typeof judgeAt>["results"] | null;
};

const JUDGE_DESC: Record<Judge, string> = {
	trend: "トレンドの判定（up: 上昇 / range: レンジ / down: 下落）",
	risk: "リスクの判定（normal: 平常 / caution: 警戒 / crisis: 危機）",
	sentiment: "センチメントの判定（+2 / +1 / 0 / -1 / -2）",
};

const judgmentsTable: Table<JudgmentRow> = {
	file: "judgments.csv",
	desc: "1時間ごとの AI 判定。1時間足の終わりの時刻ごとに、今の集計ルール（aggregation_rule.csv）で計算した。採点の記録が始まる前の時刻は判定の列が空",
	columns: [
		...time<JudgmentRow>(
			"time",
			"判定した時刻（1時間足の終わり）。この時刻までに採点されたニュースだけを使う",
			(r) => r.time,
		),
		...JUDGES.flatMap((j): Column<JudgmentRow>[] => [
			col(j, JUDGE_DESC[j], (r) => r.results?.[j].value ?? null),
			col(
				`${j}_average`,
				"重み付き平均点（整数に丸めたもの。判定はこの値としきい値を比べる）。対象のニュースが無ければ空",
				(r) => r.results?.[j].average ?? null,
			),
			col(
				`${j}_count`,
				"平均に使ったニュースの件数（この観点が関係なしのものは数えない）",
				(r) => r.results?.[j].count ?? null,
			),
		]),
	],
};

/** 1時間ごとの判定。ニュースは採点時刻の順に並んでいる前提 */
function hourlyJudgments(
	news: readonly ScoredNews[],
	from: number,
	to: number,
	now: number,
	rule: AggregationRule,
	firstScoredAt: number | null,
): JudgmentRow[] {
	const windowMs = rule.windowHours * HOUR;
	const rows: JudgmentRow[] = [];
	let lo = 0;
	let hi = 0;
	for (let t = from + HOUR; t <= Math.min(to, now); t += HOUR) {
		if (firstScoredAt === null || t < firstScoredAt) {
			rows.push({ time: t, results: null });
			continue;
		}
		// 新しさの時刻 <= 採点時刻なので、期間内のニュースは採点時刻も (t - 期間, t] にある
		while (hi < news.length && (news[hi] as ScoredNews).scoredAt <= t) hi++;
		while (lo < hi && (news[lo] as ScoredNews).scoredAt <= t - windowMs) lo++;
		rows.push({
			time: t,
			results: judgeAt(news.slice(lo, hi), t, rule).results,
		});
	}
	return rows;
}

// ---- 戦略の勝率アップ用 ----

const strategiesTable: Table<StrategyExportRow> = {
	file: "strategies.csv",
	desc: "今ある戦略（名前を付けた条件のセット）。削除した戦略は入らない",
	columns: [
		col("strategy_id", "戦略の ID", (r) => r.id),
		col("name", "戦略の名前", (r) => r.name),
		col(
			"params",
			"条件のセット（JSON）。金額は円、数量は satoshi",
			(r) => r.params,
		),
		...time<StrategyExportRow>("created_at", "作った時刻", (r) => r.created_at),
		...time<StrategyExportRow>(
			"updated_at",
			"最後に変えた時刻",
			(r) => r.updated_at,
		),
	],
};

/** 判断ログの列（ペーパーとバックテストで共通） */
function decisionColumns<T>(get: (r: T) => DecisionLog): Column<T>[] {
	return [
		...time<T>("time", "判断した時刻", (r) => get(r).time),
		col("price", "判断したときの現在値（円）", (r) => get(r).price),
		col("cash", "判断したときの現金（円）", (r) => get(r).cash),
		col(
			"position_quantity",
			"判断したときの保有数量（satoshi）。0 ならポジションなし",
			(r) => get(r).position.quantity,
		),
		col(
			"position_entry_price",
			"保有の平均約定価格（円、手数料を含めない）",
			(r) => get(r).position.entryPrice,
		),
		...time<T>(
			"position_opened_at",
			"保有の買いが約定した時刻",
			(r) => get(r).position.openedAt,
		),
		col(
			"open_order_ids",
			"判断したときの未約定の注文の ID（空白区切り）",
			(r) => get(r).openOrderIds.join(" "),
		),
		col(
			"intents",
			"この判断で出した発注・取消（JSON）。price は円、quantity は satoshi",
			(r) => json(get(r).intents),
		),
		...time<T>("next_eval_at", "次に判断する時刻", (r) => get(r).nextEvalAt),
		col("note", "判断の理由", (r) => get(r).note),
		col("state", "戦略の状態（JSON）", (r) => json(get(r).state)),
	];
}

type PaperDecision = DecisionExportRow & {
	log: DecisionLog;
	values: Record<string, string>;
};

const paperDecisionsTable: Table<PaperDecision> = {
	file: "paper_decisions.csv",
	desc: "自動取引（ペーパー）の判断の記録。評価のたびに1行",
	columns: [
		col("decision_id", "判断の ID", (r) => r.id),
		col("mode", "paper: ペーパー / live: ライブ", (r) => r.mode),
		col("strategy_id", "戦略の ID", (r) => r.strategy_id),
		col("strategy_name", "判断したときの戦略名", (r) => r.strategy_name),
		...decisionColumns<PaperDecision>((r) => r.log),
		...JUDGES.map((j) =>
			col<PaperDecision>(
				`judgment_${j}`,
				`判断したときの${JUDGE_DESC[j]}`,
				(r) => r.values[j] ?? null,
			),
		),
	],
};

/** 注文の列（ペーパーとバックテストで共通） */
function orderColumns<T>(get: (r: T) => BacktestOrder): Column<T>[] {
	return [
		col("order_id", "注文の ID", (r) => get(r).id),
		col("side", "buy: 買い / sell: 売り", (r) => get(r).side),
		col("type", "limit: 指値 / market: 成行", (r) => get(r).type),
		col("price", "指値の価格（円）。成行は空", (r) => get(r).price),
		col("quantity", "数量（satoshi）", (r) => get(r).quantity),
		...time<T>("placed_at", "発注した時刻", (r) => get(r).placedAt),
		col(
			"status",
			"open: 未約定 / filled: 約定 / canceled: 取消",
			(r) => get(r).status,
		),
		...time<T>("filled_at", "約定した時刻", (r) => get(r).filledAt),
		col("fill_price", "約定価格（円）", (r) => get(r).fillPrice),
		col("fee", "手数料（円）", (r) => get(r).fee),
		...time<T>("canceled_at", "取り消した時刻", (r) => get(r).canceledAt),
		col("cancel_reason", "取り消した理由", (r) => get(r).cancelReason),
		col("reason", "発注した判断の理由", (r) => get(r).reason),
		col("pair_id", "対応する買い / 売りの注文の ID", (r) => get(r).pairId),
		col(
			"pnl",
			"売りの約定で確定した往復の損益（円、手数料込み）",
			(r) => get(r).pnl,
		),
	];
}

const toTradeOrder = (r: OrderExportRow): BacktestOrder => ({
	id: r.id,
	side: r.side as BacktestOrder["side"],
	type: r.type as BacktestOrder["type"],
	price: r.price,
	quantity: r.quantity,
	placedAt: r.placed_at,
	status: r.status as BacktestOrder["status"],
	filledAt: r.filled_at,
	fillPrice: r.fill_price,
	fee: r.fee,
	canceledAt: r.canceled_at,
	cancelReason: r.cancel_reason,
	reason: r.reason,
	pairId: r.pair_id,
	pnl: r.pnl,
});

const paperOrdersTable: Table<OrderExportRow> = {
	file: "paper_orders.csv",
	desc: "自動取引（ペーパー）の注文。発注から約定・取消までを1行で持つ。発注時刻が期間内のもの",
	columns: [
		col("mode", "paper: ペーパー / live: ライブ", (r) => r.mode),
		...orderColumns<OrderExportRow>(toTradeOrder),
		col(
			"decision_id",
			"発注した判断の ID（paper_decisions.csv の decision_id）",
			(r) => r.decision_id,
		),
		col("strategy_id", "戦略の ID", (r) => r.strategy_id),
		col("strategy_name", "発注したときの戦略名", (r) => r.strategy_name),
	],
};

const backtestRunsTable: Table<BacktestRun> = {
	file: "backtest_runs.csv",
	desc: "選んだバックテストの実行。実行したときの条件・集計ルールの写しと成績",
	columns: [
		col("run_id", "実行の ID", (r) => r.id),
		col("strategy_id", "元の戦略の ID", (r) => r.strategyId),
		col("strategy_name", "元の戦略の名前", (r) => r.strategyName),
		...time<BacktestRun>("started_at", "実行した時刻", (r) => r.startedAt),
		col("timeframe", "戦略の足の粒度", (r) => r.timeframe),
		col("step_timeframe", "判定と約定に使った足の粒度", (r) => r.stepTimeframe),
		col(
			"step_limited",
			"データが足りず、判定頻度より粗い間隔でしか判定できなかったなら true",
			(r) => r.stepLimited,
		),
		...time<BacktestRun>("from", "期間の始まり", (r) => r.from),
		...time<BacktestRun>(
			"to",
			"期間の終わり（この時刻は含まない）",
			(r) => r.to,
		),
		col("initial_cash", "開始時の資金（円）", (r) => r.initialCash),
		col(
			"fee_limit_ppm",
			"指値の手数料率（ppm。10000 で 1%）",
			(r) => r.fees.limitPpm,
		),
		col(
			"fee_market_ppm",
			"成行の手数料率（ppm。10000 で 1%）",
			(r) => r.fees.marketPpm,
		),
		col(
			"skip_gaps",
			"期間内の欠損を承知で実行したなら true",
			(r) => r.skipGaps,
		),
		col(
			"daily_loss_limit_applied",
			"1日の損失上限を効かせて実行したなら true",
			(r) => r.dailyLossLimitApplied,
		),
		col(
			"params",
			"実行したときの条件のセット（JSON）。金額は円、数量は satoshi",
			(r) => json(r.params),
		),
		col(
			"aggregation_rule",
			"実行したときの AI 判定の集計ルール（JSON）。記録する前の実行は空",
			(r) => (r.aggregationRule ? json(r.aggregationRule) : null),
		),
		col("bar_count", "期間内の足の数", (r) => r.barCount),
		col("order_count", "注文の数", (r) => r.orderCount),
		col("filled_count", "約定の数", (r) => r.filledCount),
		col(
			"final_equity",
			"最終資金（円）。未決済のポジションは最後の足の終値で評価",
			(r) => r.summary?.finalEquity,
		),
		col("pnl", "損益（円）", (r) => r.summary?.pnl),
		col("pnl_percent", "損益率（%）", (r) => r.summary?.pnlPercent),
		col(
			"buy_and_hold_percent",
			"同期間のガチホ（買って持ち続けた場合）の損益率（%）",
			(r) => r.summary?.buyAndHoldPercent,
		),
		col("trades", "往復の回数（未決済は含めない）", (r) => r.summary?.trades),
		col("wins", "勝ちの往復の数", (r) => r.summary?.wins),
		col("losses", "負けの往復の数", (r) => r.summary?.losses),
		col("win_rate", "勝率（%）。取引が無ければ空", (r) => r.summary?.winRate),
		col(
			"profit_factor",
			"損益比率（総利益 ÷ 総損失）。損失が 0 なら空",
			(r) => r.summary?.profitFactor,
		),
		col(
			"max_drawdown_percent",
			"最大ドローダウン（%、0 以上）",
			(r) => r.summary?.maxDrawdownPercent,
		),
		...time<BacktestRun>(
			"max_drawdown_from",
			"最大ドローダウンの始まり",
			(r) => r.summary?.maxDrawdownFrom ?? null,
		),
		...time<BacktestRun>(
			"max_drawdown_to",
			"最大ドローダウンの底",
			(r) => r.summary?.maxDrawdownTo ?? null,
		),
		col(
			"average_holding_ms",
			"平均保有期間（ミリ秒）。取引が無ければ空",
			(r) => r.summary?.averageHoldingMs,
		),
		col(
			"open_position_quantity",
			"期間の最後に持っていた数量（satoshi）",
			(r) => r.summary?.openPositionQuantity,
		),
	],
};

type RunOrder = { runId: number; order: BacktestOrder };
const backtestOrdersTable: Table<RunOrder> = {
	file: "backtest_orders.csv",
	desc: "選んだバックテストの注文",
	columns: [
		col("run_id", "実行の ID（backtest_runs.csv の run_id）", (r) => r.runId),
		...orderColumns<RunOrder>((r) => r.order),
	],
};

type RunTrade = { runId: number; trade: Trade };
const backtestTradesTable: Table<RunTrade> = {
	file: "backtest_trades.csv",
	desc: "選んだバックテストの往復の取引（買いと、それを決済した売りの組）",
	columns: [
		col("run_id", "実行の ID（backtest_runs.csv の run_id）", (r) => r.runId),
		col("buy_order_id", "買いの注文の ID", (r) => r.trade.buyOrderId),
		col("sell_order_id", "売りの注文の ID", (r) => r.trade.sellOrderId),
		...time<RunTrade>(
			"entry_time",
			"買いが約定した時刻",
			(r) => r.trade.entryTime,
		),
		...time<RunTrade>(
			"exit_time",
			"売りが約定した時刻",
			(r) => r.trade.exitTime,
		),
		col("quantity", "数量（satoshi）", (r) => r.trade.quantity),
		col("pnl", "損益（円、手数料込み）", (r) => r.trade.pnl),
	],
};

type RunDecision = { runId: number; log: DecisionLog };
const backtestDecisionsTable: Table<RunDecision> = {
	file: "backtest_decisions.csv",
	desc: "選んだバックテストの判断ログ。評価のたびに1行。そのときの AI 判定は、実行の集計ルール（backtest_runs.csv の aggregation_rule）で news.csv から計算できる",
	columns: [
		col("run_id", "実行の ID（backtest_runs.csv の run_id）", (r) => r.runId),
		...decisionColumns<RunDecision>((r) => r.log),
	],
};

const CANDLE_FILE = "candles_1m.csv";

/** README に載せる表と行数 */
type Listed = { table: Table<never>; rows: number };

function readme({
	from,
	to,
	now,
	rule,
	ai,
	candleRows,
	strategy,
}: {
	from: number;
	to: number;
	now: number;
	rule: AggregationRule;
	ai: Listed[];
	candleRows: number;
	strategy: Listed[];
}): string {
	const out: string[] = [
		"# trading-studio 分析用データ",
		"",
		"BTC/JPY の自動売買アプリ trading-studio の記録。AI 判定の精度と戦略の成績の分析に使う。",
		"",
		`- 期間: ${formatJstRfc3339(from)} 〜 ${formatJstRfc3339(to)}（終わりの時刻は含まない）`,
		`- 書き出した時刻: ${formatJstRfc3339(now)}`,
		"",
		"## 共通の書式",
		"",
		'- 文字コードは UTF-8、改行は LF。1行目は列名。値に `,` `"` 改行を含むときは `"` で囲む',
		"- 時刻の列は、UTC のエポックミリ秒（列名そのまま）と JST の文字列（列名に `_jst` を付けた列、例 `2026-09-26T12:00:00.000+09:00`）の2列で出す",
		"- 金額は円の整数、数量は satoshi の整数（1 BTC = 100,000,000 satoshi）。ただし candles_1m.csv の出来高だけは BTC の小数",
		"- 空の値は「無い」「当てはまらない」を表す",
		"- API キーなどの設定値は入れていない",
		"",
		"## 期間で絞る基準",
		"",
		`- news.csv: 新しさの時刻（公開時刻と取得時刻の早いほう）が、期間の始まりの ${rule.windowHours} 時間（集計に使う期間）前から期間の終わりまでのもの。期間の最初の判定に使うニュースも入れるため`,
		"- judgments.csv: 期間内の1時間足の終わりの時刻。書き出した時刻より後は入れない",
		`- ${CANDLE_FILE}: 開始時刻が期間内の1分足`,
		"- paper_decisions.csv: 判断した時刻が期間内のもの。paper_orders.csv: 発注した時刻が期間内のもの",
		"- scoring_criteria.csv・aggregation_rule.csv・strategies.csv: 期間に関係なく今あるもの全部",
		"- backtest_*.csv: 画面で選んだ実行だけ",
		"",
		"## AI 判定のしくみ",
		"",
		"ニュースを取得するたびに AI が3観点（トレンド・リスク・センチメント）を 0〜100 で採点する。判定は、ある時刻までに採点済みで、新しさの時刻が集計の期間内のニュースの点数を、新しいほど重くして（半減期で半分になる指数の重み）平均し、平均点を整数に丸めてしきい値と比べて決める。対象のニュースが無ければ レンジ・平常・0。",
		"",
		"## ファイル",
		"",
		"### AI 判定の精度向上用",
		"",
	];
	const section = ({ table, rows }: Listed) => {
		out.push(`#### ${table.file}（${rows} 行）`, "", table.desc, "");
		out.push("| 列 | 意味 |", "|---|---|");
		for (const c of table.columns) {
			out.push(`| ${c.name} | ${c.desc.replaceAll("|", "\\|")} |`);
		}
		out.push("");
	};
	for (const f of ai) section(f);
	out.push(
		`#### ${CANDLE_FILE}（${candleRows} 行）`,
		"",
		"価格の1分足。アプリの過去データの取り込みと同じ形式で、そのまま取り込み直せる。",
		"",
		"| 列 | 意味 |",
		"|---|---|",
		"| 日時 | 足の開始時刻（JST、RFC 3339） |",
		"| 始値・高値・安値・終値 | 円 |",
		"| 出来高 | BTC（小数） |",
		"",
		"欠損した時刻の足は入れていない（埋めない）。",
		"",
		"### 戦略の勝率アップ用",
		"",
	);
	for (const f of strategy) section(f);
	return out.join("\n");
}

export function createAnalysisExportService({
	repo,
	scoreRepo,
	backtestRepo,
	marketData,
	now = Date.now,
}: {
	repo: AnalysisExportRepository;
	scoreRepo: ScoreRepository;
	backtestRepo: BacktestRepository;
	marketData: Pick<MarketDataService, "exportCandles">;
	now?: () => number;
}): AnalysisExportService {
	return {
		backtestRuns: (from, to) => backtestRepo.listDoneStartedBetween(from, to),

		build({ from, to, backtestIds }) {
			const runs: BacktestRun[] = [];
			for (const id of backtestIds) {
				const run = backtestRepo.get(id);
				if (run?.status !== "done") {
					return { ok: false, message: `バックテスト ${id} が見つからない` };
				}
				runs.push(run);
			}
			const t = now();
			const rule = scoreRepo.aggregationRule();
			const windowMs = rule.windowHours * HOUR;
			const encoder = new TextEncoder();
			const files: { name: string; data: Uint8Array }[] = [];
			const ai: Listed[] = [];
			const strategy: Listed[] = [];
			let listed = ai;
			const add = <T>(table: Table<T>, rows: readonly T[]) => {
				files.push({
					name: table.file,
					data: encoder.encode(toCsv(table, rows)),
				});
				listed.push({ table: table as Table<never>, rows: rows.length });
			};

			add(newsTable, repo.news(from - windowMs, to));
			const active = scoreRepo.activeCriteriaVersion();
			add(
				criteriaTable,
				scoreRepo
					.listCriteria()
					.map((c) => ({ ...c, active: c.version === active })),
			);
			add(ruleTable, ruleRows(rule));
			// 期間内の判定に使うニュースは、採点時刻が (期間の始まり − 集計の期間, 期間の終わり] にある
			const scored = scoreRepo.scoredNews(from - windowMs, to + 1);
			add(
				judgmentsTable,
				hourlyJudgments(scored, from, to, t, rule, scoreRepo.firstScoredAt()),
			);

			const candles = marketData.exportCandles("1m", from, to);
			const lines = [CSV_HEADER];
			for (const page of candles?.pages ?? []) {
				for (const c of page) lines.push(formatCandleCsvRow(c));
			}
			files.push({
				name: CANDLE_FILE,
				data: encoder.encode(`${lines.join("\n")}\n`),
			});

			listed = strategy;
			add(strategiesTable, repo.strategies());
			add(
				paperDecisionsTable,
				repo.decisions(from, to).map((d) => ({
					...d,
					log: JSON.parse(d.decision) as DecisionLog,
					values: JSON.parse(d.judgments) as Record<string, string>,
				})),
			);
			add(paperOrdersTable, repo.orders(from, to));
			add(backtestRunsTable, runs);
			const orders: RunOrder[] = [];
			const trades: RunTrade[] = [];
			const decisions: RunDecision[] = [];
			for (const run of runs) {
				const c = backtestRepo.contents(run.id);
				if (!c) continue;
				for (const order of c.orders) orders.push({ runId: run.id, order });
				for (const trade of c.trades) trades.push({ runId: run.id, trade });
				for (const log of c.decisions) decisions.push({ runId: run.id, log });
			}
			add(backtestOrdersTable, orders);
			add(backtestTradesTable, trades);
			add(backtestDecisionsTable, decisions);

			files.unshift({
				name: "README.md",
				data: encoder.encode(
					readme({
						from,
						to,
						now: t,
						rule,
						ai,
						candleRows: lines.length - 1,
						strategy,
					}),
				),
			});
			const day = (ms: number) =>
				formatJstRfc3339(ms).slice(0, 10).replaceAll("-", "");
			return {
				ok: true,
				fileName: `trading-studio-analysis-${day(from)}-${day(to - 1)}.zip`,
				data: createZip(files, t),
			};
		},
	};
}
