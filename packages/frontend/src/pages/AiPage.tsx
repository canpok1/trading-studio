import type {
	CurrentJudgment,
	NewsCollectorStatus,
	NewsItem,
	ScorerStatus,
} from "@trading-studio/backend";
import { JUDGE_LABELS, JUDGES } from "@trading-studio/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useApi } from "../api";
import { NewsTab } from "../components/ai/NewsTab";
import { PromptTab } from "../components/ai/PromptTab";
import { RuleTab } from "../components/ai/RuleTab";
import { SourcesTab } from "../components/ai/SourcesTab";
import { JudgmentBadge, ZoneBar } from "../components/judgment/JudgmentBadge";
import { Page } from "../components/Page";
import { ErrorState, Skeleton } from "../components/States";
import { Button } from "../components/ui";
import { formatDateTime } from "../format";
import type { AiData } from "../lib/ai";
import { aiTroubles } from "../lib/ai";
import {
	errorMessage,
	readJson,
	useInterval,
	usePageVisible,
} from "../lib/useAsync";

/** 判定とニュースを問い合わせる間隔 */
const POLL_MS = 5_000;
const NEWS_LIMIT = 100;

const TABS = [
	["news", "ニュースごと"],
	["rule", "集計ルール"],
	["prompt", "プロンプト"],
	["sources", "収集と採点"],
] as const;
type Tab = (typeof TABS)[number][0];
const isTab = (v: string | null): v is Tab => TABS.some(([t]) => t === v);

export function AiPage() {
	const api = useApi();
	const visible = usePageVisible();
	const [params, setParams] = useSearchParams();
	const tabParam = params.get("tab");
	const tab: Tab = isTab(tabParam) ? tabParam : "news";

	const [data, setData] = useState<AiData | null>(null);
	const [error, setError] = useState<string | null>(null);
	// 操作の直後と定期の問い合わせが重なると応答の順が入れ替わりうるので、最後に出したものだけ使う
	const seq = useRef(0);
	const load = useCallback(async () => {
		const id = ++seq.current;
		try {
			const [current, news, collector, scorer] = await Promise.all([
				api.api.judgments.current
					.$get()
					.then((r) => readJson<CurrentJudgment>(r)),
				api.api.news
					.$get({ query: { limit: String(NEWS_LIMIT) } })
					.then((r) => readJson<{ news: NewsItem[] }>(r)),
				api.api.news.status
					.$get()
					.then((r) => readJson<NewsCollectorStatus>(r)),
				api.api.scoring.status.$get().then((r) => readJson<ScorerStatus>(r)),
			]);
			if (id !== seq.current) return;
			setData({ current, news: news.news, collector, scorer });
			setError(null);
		} catch (e) {
			if (id === seq.current) setError(errorMessage(e));
		}
	}, [api]);
	useEffect(() => {
		if (visible) load();
	}, [visible, load]);
	useInterval(load, POLL_MS, visible);

	if (!data) {
		return (
			<Page title="AI判定">
				{error ? (
					<ErrorState
						what="AI判定を読み込めなかった"
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
	return (
		<Page title="AI判定">
			<section
				aria-label="今の判定"
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
								<span>
									<strong>{JUDGE_LABELS[j]}</strong>{" "}
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
				直近 {current.rule.windowHours}{" "}
				時間のニュースの点数を、新しいほど重く平均（半減期{" "}
				{current.rule.halfLifeHours} 時間）· {formatDateTime(current.time)} 時点
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
				</div>
			))}
			{error && (
				<p role="alert" className="text-xs font-semibold text-loss">
					最新の状態を読み込めなかった（{error}）。5秒ごとに読み直している
				</p>
			)}
			<div
				role="tablist"
				aria-label="AI判定の表示"
				className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-[10px] bg-surface-2 p-[3px]"
			>
				{TABS.map(([t, label]) => (
					<button
						key={t}
						type="button"
						role="tab"
						aria-selected={tab === t}
						onClick={() =>
							setParams(t === "news" ? {} : { tab: t }, { replace: true })
						}
						className={`h-9 rounded-lg px-0.5 text-xs whitespace-nowrap sm:text-[13px] ${tab === t ? "bg-surface font-bold text-text shadow-sm" : "text-text-2"}`}
					>
						{label}
					</button>
				))}
			</div>
			<div role="tabpanel" className="flex flex-col gap-3">
				{tab === "news" && <NewsTab data={data} onChanged={load} />}
				{tab === "rule" && <RuleTab saved={current.rule} onSaved={load} />}
				{tab === "prompt" && <PromptTab rule={current.rule} onChanged={load} />}
				{tab === "sources" && (
					<SourcesTab collector={data.collector} onChanged={load} />
				)}
			</div>
		</Page>
	);
}
