import type {
	CurrentJudgment,
	NewsCollectorStatus,
	NewsSearchResult,
	ScorerStatus,
} from "@trading-studio/backend";
import {
	HALF_LIVES_IN_WINDOW,
	JUDGE_LABELS,
	JUDGES,
} from "@trading-studio/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useApi } from "../api";
import { BreakdownCards } from "../components/ai/Breakdown";
import { BulkRescore } from "../components/ai/BulkRescore";
import { NewsFilterBar } from "../components/ai/NewsFilter";
import { NewsTab } from "../components/ai/NewsTab";
import { useArticlePrecisions } from "../components/ai/Precision";
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
	["evaluation", "評価詳細"],
] as const;
type View = (typeof VIEWS)[number][0];

export function NewsPage() {
	const api = useApi();
	const visible = usePageVisible();

	const [params, setParams] = useSearchParams();
	const view: View = params.get("tab") === "evaluation" ? "evaluation" : "list";
	// 絞り込みの条件は残したまま切り替える
	const setView = (v: View) => {
		const next = new URLSearchParams(params);
		if (v === "list") next.delete("tab");
		else next.set("tab", v);
		setParams(next, { replace: true });
	};
	const filter = parseNewsFilter(params);
	const filterKey = newsFilterParams(filter).toString();
	const setFilter = useCallback(
		(f: NewsFilterState) => {
			const next = newsFilterParams(f);
			if (view !== "list") next.set("tab", view);
			setParams(next, { replace: true });
		},
		[setParams, view],
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
	const precisions = useArticlePrecisions(data?.news ?? [], visible);

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
	const tabs = (
		<Tabs
			label="ニュースの表示"
			items={VIEWS}
			current={view}
			onSelect={setView}
		/>
	);
	if (view === "evaluation") {
		return (
			<Page title="ニュース" actions={<SettingsLink />}>
				{tabs}
				<div className="flex items-center gap-1.5">
					<h2 className="text-[15px] font-bold">
						{data.at === null
							? "今の市場評価の内訳"
							: "過去の時点の市場評価の内訳"}
					</h2>
					<Help label="市場評価の内訳">
						<p>
							市場評価に使っている記事（重みが 0%
							より大きいもの）を、記事ごとの点数を評価基準に当てた段階で分け、件数・平均点・重みの割合を出す。平均点はその段階の記事の点数を重みで平均したもの。
						</p>
						<p>
							市場評価の平均点は、段階ごとの 平均点 × 重みの割合
							を足したものになる。重みの割合が一番大きい段階がそのまま評価になるとは限らない。関係ある記事の
							0 点は中立・平常に入る。
						</p>
					</Help>
				</div>
				<BreakdownCards current={current} />
				<p className="num text-xs text-text-2">
					{formatDateTime(current.time)} 時点
				</p>
				{error && (
					<p role="alert" className="text-xs font-semibold text-loss">
						最新の状態を読み込めなかった（{error}）。5秒ごとに読み直している
					</p>
				)}
			</Page>
		);
	}
	return (
		<Page title="ニュース" actions={<SettingsLink />}>
			{tabs}
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">
					{data.at === null ? "今の市場評価" : "過去の時点の市場評価"}
				</h2>
				<Help label="市場評価">
					<p>
						ニュースの点数を、重みを付けて平均する。重みは新しいほど重く、AI
						が付けた持続ごとの半減期（短期 {current.rule.halfLifeHours.short}
						・中期 {current.rule.halfLifeHours.medium}・長期{" "}
						{current.rule.halfLifeHours.long} 時間）で半分になる。
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
						分ごとにニュースを取得し、新着だけを1回ずつ採点する。センチはセンチメントの略。関係ない観点は
						0 点。
					</p>
					<p>
						持続は相場への影響が続く長さで、AI
						が短期・中期・長期・なしで付ける。
					</p>
					<p>
						重みは市場評価の平均でのその記事の重さ。新しい記事が 100%
						で、持続ごとの半減期（短期 {current.rule.halfLifeHours.short}・中期{" "}
						{current.rule.halfLifeHours.medium}・長期{" "}
						{current.rule.halfLifeHours.long} 時間）で半分になる。半減期の{" "}
						{HALF_LIVES_IN_WINDOW}{" "}
						倍より前と、持続が「なし」（相場に関係ない）の記事は
						0%（集計の対象外）。
					</p>
					<p>
						精度は、採点した時刻から（）の時間がたった後の値動きと点数の段階を比べたもの。一致で
						5、1段ずれるごとに 1 下げる。センチメントは かなり弱気〜かなり強気を
						大きく下落〜大きく上昇 と比べる。リスクは値動きの大きさを
						静か・やや荒れ・荒れた・かなり荒れ・大荒れ
						に分け、平常〜危機の5段階と順に比べる。時間と段階の境目は設定の「ニュース」→「精度」で変える。
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
				precisions={precisions}
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
