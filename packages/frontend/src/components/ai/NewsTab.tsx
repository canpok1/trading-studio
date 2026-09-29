import type { NewsItem } from "@trading-studio/backend";
import type { AggregationRule } from "@trading-studio/core";
import { JUDGES } from "@trading-studio/core";
import { useId, useState } from "react";
import { useApi } from "../../api";
import {
	formatDateTime,
	formatDateWeekday,
	formatTime,
	formatVersion,
} from "../../format";
import type { AiData } from "../../lib/ai";
import { newsState } from "../../lib/ai";
import { groupByDay } from "../../lib/news-filter";
import { errorMessage, readJson } from "../../lib/useAsync";
import { ChevronIcon } from "../icons";
import { ScoreChip } from "../judgment/JudgmentBadge";
import { EmptyState, Skeleton } from "../States";
import { Button } from "../ui";

export function NewsTab({
	data,
	grouped,
	filtered,
	onClearFilter,
	onChanged,
}: {
	data: AiData;
	/** 日付ごとに区切る（新しい順のとき） */
	grouped: boolean;
	/** 条件で絞っている */
	filtered: boolean;
	onClearFilter: () => void;
	onChanged: () => void;
}) {
	const { news, current, scorer } = data;
	if (news.length === 0) {
		return (
			<div className="rounded-xl border border-line bg-surface">
				{filtered ? (
					<EmptyState
						title="条件に当てはまるニュースが無い"
						description="期間を広げるか、条件を減らす"
						action={
							<Button size="sm" onClick={onClearFilter}>
								条件をクリア
							</Button>
						}
					/>
				) : (
					<EmptyState
						title="ニュースがまだ無い"
						description="取得すると、ここに採点と一緒に並ぶ"
					/>
				)}
			</div>
		);
	}
	const card = (n: NewsItem) => (
		<NewsCard
			key={n.id}
			news={n}
			timeOnly={grouped}
			weight={current.weights[n.id] ?? null}
			rule={current.rule}
			scorerStopped={scorer.state === "stopped"}
			onChanged={onChanged}
		/>
	);
	const groups = grouped
		? groupByDay(news)
		: [{ day: null as string | null, items: news }];
	return (
		<div className="flex flex-col gap-2">
			{groups.map((g) => (
				<section
					key={g.day ?? "all"}
					aria-label={g.day ?? undefined}
					className="flex flex-col gap-1.5"
				>
					{g.day !== null && (
						<h3 className="num px-1 text-xs font-bold text-text-2">
							{formatDateWeekday(g.items[0]?.publishedAt ?? 0)}
						</h3>
					)}
					<div className="overflow-hidden rounded-xl border border-line bg-surface">
						{g.items.map(card)}
					</div>
				</section>
			))}
		</div>
	);
}

function NewsCard({
	news: n,
	timeOnly,
	weight,
	rule,
	scorerStopped,
	onChanged,
}: {
	news: NewsItem;
	/** 日付の区切りの下では時刻だけ出す */
	timeOnly: boolean;
	weight: number | null;
	rule: AggregationRule;
	scorerStopped: boolean;
	onChanged: () => void;
}) {
	const api = useApi();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const detailId = useId();
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
			<span className="num text-xs text-text-2">
				{timeOnly ? formatTime(n.publishedAt) : formatDateTime(n.publishedAt)} ·{" "}
				{n.sourceName}
			</span>
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
					<button
						type="button"
						aria-expanded={open}
						aria-controls={detailId}
						onClick={() => setOpen(!open)}
						className="flex items-start gap-1.5 text-left"
					>
						<span
							className={`min-w-0 flex-1 text-xs leading-relaxed ${open ? "" : "line-clamp-1"}`}
						>
							{n.score.comment}
						</span>
						<span className="flex shrink-0 items-center text-xs text-text-2">
							{open ? "閉じる" : "詳しく"}
							<ChevronIcon open={open} size={14} />
						</span>
					</button>
					{open && (
						<div id={detailId} className="flex flex-col gap-0.5">
							<span className="num text-xs text-text-2">
								採点 {formatDateTime(n.score.scoredAt ?? 0)} · プロンプト v
								{n.score.criteriaVersion} · {n.score.model} ·{" "}
								{formatVersion(n.score.appBuiltAt, "記録なし")}
							</span>
							<span className="num text-xs text-text-2">
								{weight === null
									? `集計の対象外（${rule.windowHours}時間より前）`
									: `集計での重み ${Math.round(weight * 100)}%`}
							</span>
						</div>
					)}
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
