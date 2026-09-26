import type { NewsItem } from "@trading-studio/backend";
import type { AggregationRule } from "@trading-studio/core";
import { JUDGES } from "@trading-studio/core";
import { useState } from "react";
import { useApi } from "../../api";
import { formatDateTime } from "../../format";
import type { AiData } from "../../lib/ai";
import { newsState } from "../../lib/ai";
import { errorMessage, readJson } from "../../lib/useAsync";
import { ScoreChip } from "../judgment/JudgmentBadge";
import { EmptyState, Skeleton } from "../States";
import { Button } from "../ui";

export function NewsTab({
	data,
	onChanged,
}: {
	data: AiData;
	onChanged: () => void;
}) {
	const { news, current, collector, scorer } = data;
	return (
		<>
			<p className="text-xs text-text-2">
				{collector.intervalMinutes}
				分ごとにニュースを集め、新着だけを1回ずつ採点する。—
				は関係なし（その観点の集計に入れない）。
			</p>
			{news.length === 0 ? (
				<div className="rounded-xl border border-line bg-surface">
					<EmptyState
						title="ニュースがまだ無い"
						description="収集すると、ここに採点と一緒に並ぶ"
					/>
				</div>
			) : (
				<div className="overflow-hidden rounded-xl border border-line bg-surface">
					{news.map((n) => (
						<NewsCard
							key={n.id}
							news={n}
							weight={current.weights[n.id] ?? null}
							rule={current.rule}
							scorerStopped={scorer.state === "stopped"}
							onChanged={onChanged}
						/>
					))}
				</div>
			)}
		</>
	);
}

function NewsCard({
	news: n,
	weight,
	rule,
	scorerStopped,
	onChanged,
}: {
	news: NewsItem;
	weight: number | null;
	rule: AggregationRule;
	scorerStopped: boolean;
	onChanged: () => void;
}) {
	const api = useApi();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const state = newsState(n, scorerStopped);

	const retry = async () => {
		setBusy(true);
		setError(null);
		try {
			await api.api.scoring.news[":id"].retry
				.$post({ param: { id: String(n.id) } })
				.then((r) => readJson(r));
			onChanged();
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<article
			data-testid="news-card"
			className={`flex flex-col gap-2 border-b border-line p-3.5 last:border-b-0 ${state.kind === "done" && weight === null ? "opacity-60" : ""}`}
		>
			<div className="flex items-center justify-between gap-2">
				<span className="num text-xs text-text-2">
					{formatDateTime(n.publishedAt)} · {n.sourceName}
				</span>
				{state.kind === "done" && (
					<span className="num text-xs text-text-2">
						{weight === null
							? `集計の対象外（${rule.windowHours}時間より前）`
							: `重み ${Math.round(weight * 100)}%`}
					</span>
				)}
			</div>
			<a
				href={n.url}
				target="_blank"
				rel="noreferrer"
				className="text-[15px] leading-normal font-bold [overflow-wrap:anywhere]"
			>
				{n.title}
			</a>
			{state.kind === "done" && n.score && (
				<>
					<div className="flex flex-wrap gap-1.5">
						{JUDGES.map((j) => (
							<ScoreChip
								key={j}
								judge={j}
								score={n.score?.scores?.[j] ?? null}
								rule={rule}
							/>
						))}
					</div>
					<p className="text-xs leading-relaxed">{n.score.comment}</p>
					<span className="num text-xs text-text-2">
						採点 {formatDateTime(n.score.scoredAt ?? 0)} · プロンプト v
						{n.score.criteriaVersion} · {n.score.model}
					</span>
				</>
			)}
			{state.kind === "waiting" &&
				(state.stopped ? (
					<span className="text-xs text-text-2">
						未採点（採点が止まっている）
					</span>
				) : (
					<div className="flex items-center gap-2 text-xs text-text-2">
						<Skeleton className="h-6 w-3/5" />
						採点中
					</div>
				))}
			{state.kind === "retry" && (
				<span className="text-xs">
					<span className="font-semibold text-loss">採点に失敗</span>（
					{state.error}）。
					{state.nextAttemptAt !== null &&
						`${formatDateTime(state.nextAttemptAt)} に自動で再試行する`}
				</span>
			)}
			{state.kind === "failed" && (
				<div className="flex items-center justify-between gap-2">
					<span className="text-xs">
						<span className="font-semibold text-loss">採点に失敗</span>（
						{state.error}）。集計には入れていない
					</span>
					<Button size="sm" onClick={retry} disabled={busy}>
						再試行
					</Button>
				</div>
			)}
			{state.kind === "skipped" && (
				<span className="text-xs text-text-2">
					集計の対象外（取得した時点で{rule.windowHours}
					時間より前のため採点していない）
				</span>
			)}
			{error && (
				<p role="alert" className="text-xs font-semibold text-loss">
					再試行できなかった: {error}
				</p>
			)}
		</article>
	);
}
