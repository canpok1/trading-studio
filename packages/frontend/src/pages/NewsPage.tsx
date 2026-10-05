import type {
	CurrentJudgment,
	NewsCollectorStatus,
	NewsSearchResult,
	ScorerStatus,
} from "@trading-studio/backend";
import { JUDGE_LABELS, JUDGES } from "@trading-studio/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useApi } from "../api";
import { AccuracyCard } from "../components/ai/AccuracyCard";
import { BulkRescore } from "../components/ai/BulkRescore";
import { NewsFilterBar } from "../components/ai/NewsFilter";
import { NewsTab } from "../components/ai/NewsTab";
import {
	PrecisionLink,
	PrecisionSummary,
	precisionOf,
	usePrecisionReport,
} from "../components/ai/Precision";
import { Help } from "../components/Help";
import { SettingsIcon } from "../components/icons";
import { JudgmentBadge, ZoneBar } from "../components/judgment/JudgmentBadge";
import { Page } from "../components/Page";
import { ErrorState, Skeleton } from "../components/States";
import { Button, buttonClass, Tabs } from "../components/ui";
import { formatDateTime } from "../format";
import type { AiData } from "../lib/ai";
import { aiTroubles } from "../lib/ai";
import type { NewsFilterState } from "../lib/news-filter";
import {
	EMPTY_FILTER,
	evaluationTime,
	isFiltered,
	newsFilterParams,
	newsQuery,
	parseNewsFilter,
} from "../lib/news-filter";
import {
	errorMessage,
	readJson,
	useInterval,
	usePageVisible,
} from "../lib/useAsync";

/** 判定とニュースを問い合わせる間隔 */
const POLL_MS = 5_000;
/** 一度に読むニュースの件数。「さらに読み込む」でこの件数ずつ増やす */
const NEWS_PAGE = 100;
/** 読み込める件数の上限（API の上限） */
const NEWS_MAX = 1000;

const VIEWS = [
	["list", "一覧"],
	["accuracy", "精度分析"],
] as const;
type View = (typeof VIEWS)[number][0];

export function NewsPage() {
	const api = useApi();
	const visible = usePageVisible();

	const [params, setParams] = useSearchParams();
	const view: View = params.get("tab") === "accuracy" ? "accuracy" : "list";
	// 絞り込みの条件は残したまま切り替える
	const viewParams = (v: View) => {
		const next = new URLSearchParams(params);
		if (v === "list") next.delete("tab");
		else next.set("tab", v);
		return next;
	};
	const setView = (v: View) => setParams(viewParams(v), { replace: true });
	const precisionReport = usePrecisionReport();
	const precision =
		precisionReport.state.kind === "ok"
			? precisionOf(precisionReport.state.data)
			: null;
	const filter = parseNewsFilter(params);
	const filterKey = newsFilterParams(filter).toString();
	const setFilter = useCallback(
		(f: NewsFilterState) => setParams(newsFilterParams(f), { replace: true }),
		[setParams],
	);
	const [limit, setLimit] = useState(NEWS_PAGE);
	// 条件を変えたら読む件数を戻す
	// biome-ignore lint/correctness/useExhaustiveDependencies: filterKey が変わったときだけ戻す
	useEffect(() => setLimit(NEWS_PAGE), [filterKey]);

	const [data, setData] = useState<AiData | null>(null);
	const [error, setError] = useState<string | null>(null);
	// 操作の直後と定期の問い合わせが重なると応答の順が入れ替わりうるので、最後に出したものだけ使う
	const seq = useRef(0);
	const load = useCallback(async () => {
		const id = ++seq.current;
		const f = parseNewsFilter(new URLSearchParams(filterKey));
		const now = Date.now();
		const at = evaluationTime(f, now);
		try {
			const [current, news, collector, scorer] = await Promise.all([
				api.api.judgments.current
					.$get({ query: at === null ? {} : { at: String(at) } })
					.then((r) => readJson<CurrentJudgment>(r)),
				api.api.news
					.$get({ query: newsQuery(f, now, limit) })
					.then((r) => readJson<NewsSearchResult>(r)),
				api.api.news.status
					.$get()
					.then((r) => readJson<NewsCollectorStatus>(r)),
				api.api.scoring.status.$get().then((r) => readJson<ScorerStatus>(r)),
			]);
			if (id !== seq.current) return;
			setData({
				current,
				news: news.news,
				total: news.total,
				at,
				collector,
				scorer,
			});
			setError(null);
		} catch (e) {
			if (id === seq.current) setError(errorMessage(e));
		}
	}, [api, filterKey, limit]);
	useEffect(() => {
		if (visible) load();
	}, [visible, load]);
	useInterval(load, POLL_MS, visible);

	if (!data) {
		return (
			<Page title="ニュース" actions={<SettingsLink />}>
				{error ? (
					<ErrorState
						what="ニュースと市場評価を読み込めなかった"
						next={error}
						action={<Button onClick={load}>もう一度読み込む</Button>}
					/>
				) : (
					<div
						role="status"
						aria-label="読み込み中"
						className="flex flex-col gap-3"
					>
						<Skeleton className="h-[150px] w-full" />
						<Skeleton className="h-9 w-full" />
						<Skeleton className="h-[240px] w-full" />
					</div>
				)}
			</Page>
		);
	}

	const { current } = data;
	const troubles = aiTroubles(data.collector, data.scorer);
	if (view === "accuracy") {
		return (
			<Page title="ニュース" actions={<SettingsLink />}>
				<Tabs
					label="ニュースの表示"
					items={VIEWS}
					current={view}
					onSelect={setView}
				/>
				{precisionReport.state.kind === "error" ? (
					<ErrorState
						what="精度を読み込めなかった"
						next={precisionReport.state.message}
						action={
							<Button onClick={precisionReport.reload}>もう一度読み込む</Button>
						}
					/>
				) : precisionReport.state.kind === "loading" ? (
					<Skeleton className="h-[120px] w-full" />
				) : (
					<PrecisionSummary
						precision={precision}
						basis={precisionReport.state.data}
					/>
				)}
				<AccuracyCard rule={current.rule} />
			</Page>
		);
	}
	return (
		<Page title="ニュース" actions={<SettingsLink />}>
			<Tabs
				label="ニュースの表示"
				items={VIEWS}
				current={view}
				onSelect={setView}
			/>
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">
					{data.at === null ? "今の市場評価" : "過去の時点の市場評価"}
				</h2>
				<Help label="市場評価">
					<p>
						直近 {current.rule.windowHours}{" "}
						時間のニュースの点数を、新しいほど重く平均する（半減期{" "}
						{current.rule.halfLifeHours} 時間）。
					</p>
				</Help>
			</div>
			<section
				aria-label="市場評価"
				className="overflow-hidden rounded-xl border border-line bg-surface"
			>
				{JUDGES.map((j) => {
					const r = current.results[j];
					return (
						<div
							key={j}
							data-testid={`judge-${j}`}
							className="flex flex-col gap-2 border-b border-line px-3.5 py-3 last:border-b-0"
						>
							<div className="flex items-center justify-between gap-2">
								<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
									<strong>{JUDGE_LABELS[j]}</strong>
									<span className="num text-xs text-text-2">
										{r.average === null
											? "対象のニュースなし"
											: `${r.average}点 · ${r.count}件から算出`}
									</span>
									{precision && (
										<PrecisionLink
											precision={precision[j]}
											to={`/news?${viewParams("accuracy")}`}
										/>
									)}
								</span>
								<JudgmentBadge judge={j} value={r.value} />
							</div>
							<ZoneBar judge={j} rule={current.rule} score={r.average} />
						</div>
					);
				})}
			</section>
			<p className="num text-xs text-text-2">
				{formatDateTime(current.time)} 時点
			</p>
			{troubles.map((t) => (
				<div
					key={t.title}
					role="alert"
					className="flex flex-col gap-1 rounded-[10px] bg-warn px-3.5 py-3 text-xs leading-relaxed"
				>
					<b className="text-[13px]">{t.title}</b>
					{t.lines.map((l) => (
						<span key={l}>{l}</span>
					))}
					{t.since !== null && (
						<span className="num text-text-2">
							止まった時刻: {formatDateTime(t.since)}
						</span>
					)}
					<Link
						to={`/settings?section=news&tab=${t.tab}`}
						className="self-start font-semibold text-accent"
					>
						{t.tab === "sources" ? "取得の設定を開く" : "採点の設定を開く"}
					</Link>
				</div>
			))}
			{error && (
				<p role="alert" className="text-xs font-semibold text-loss">
					最新の状態を読み込めなかった（{error}）。5秒ごとに読み直している
				</p>
			)}
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">ニュースごと</h2>
				<Help label="ニュースごと">
					<p>
						{data.collector.intervalMinutes}
						分ごとにニュースを取得し、新着だけを1回ずつ採点する。—
						は関係なし（その観点の集計に入れない）。
					</p>
					<p>
						重みは市場評価の平均でのその記事の重さ。新しい記事が 100% で、
						{current.rule.halfLifeHours} 時間ごとに半分になる。
						{current.rule.windowHours} 時間より前は対象外。
					</p>
					<p>
						強気材料・弱気材料・リスク高は、評価基準のやや強気以上・やや弱気以下・警戒以上の点数が付いたもの。影響の大きい順は、センチメントの点数の絶対値とリスクの点数の大きい方で並べる。
					</p>
				</Help>
			</div>
			<NewsFilterBar filter={filter} onChange={setFilter} />
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="num text-xs text-text-2" aria-live="polite">
					{isFiltered(filter) ? "条件に当てはまる" : "全部で"} {data.total} 件
					{data.scorer.rescorePending > 0 &&
						` · 採点し直しを待っている ${data.scorer.rescorePending} 件`}
				</p>
				<BulkRescore
					filter={filter}
					total={data.total}
					activeVersion={data.scorer.activeCriteriaVersion}
					onDone={load}
				/>
			</div>
			<NewsTab
				data={data}
				grouped={filter.sort === "new"}
				filtered={isFiltered(filter)}
				onClearFilter={() => setFilter(EMPTY_FILTER)}
				onChanged={load}
			/>
			{data.news.length < data.total &&
				(limit < NEWS_MAX ? (
					<Button
						size="sm"
						className="self-center"
						onClick={() => setLimit(Math.min(NEWS_MAX, limit + NEWS_PAGE))}
					>
						さらに読み込む（あと {data.total - data.news.length} 件）
					</Button>
				) : (
					<p className="text-center text-xs text-text-2">
						{NEWS_MAX} 件まで出す。続きは期間や条件で絞って見る
					</p>
				))}
		</Page>
	);
}

/** ニュースの設定（評価ルール・プロンプト・取得）は設定画面に置く */
function SettingsLink() {
	return (
		<Link to="/settings?section=news" className={buttonClass("default", "sm")}>
			<SettingsIcon size={18} />
			設定
		</Link>
	);
}
