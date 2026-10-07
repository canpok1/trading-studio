// 市場評価の精度の集計。ニュース画面の評価詳細のタブに出す（docs/news-page.md）

import type {
	AccuracyPeriod,
	AccuracySummary,
	AccuracySummaryResult,
} from "@trading-studio/backend";
import type { Judge } from "@trading-studio/core";
import { JUDGE_LABELS, JUDGES } from "@trading-studio/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../../api";
import { errorMessage, readJson, useInterval } from "../../lib/useAsync";
import { Help } from "../Help";
import {
	JudgmentLegend,
	LEVEL_ORDER,
	levelFill,
} from "../judgment/JudgmentBadge";
import { valueStyle } from "../judgment/judgment-style";

/** 測定中の記事が測れるようになるのを拾う間隔。記事ごとの精度と合わせる */
const POLL_MS = 60_000;

/** 設定の選択肢。Segmented が文字列しか扱えないので、すべて（null）を "all" で表す */
export const PERIOD_OPTIONS = [
	["7", "7日"],
	["30", "30日"],
	["90", "90日"],
	["all", "すべて"],
] as const;
export type PeriodKey = (typeof PERIOD_OPTIONS)[number][0];
export const periodKey = (p: AccuracyPeriod): PeriodKey =>
	p === null ? "all" : (String(p) as PeriodKey);
export const periodOf = (k: PeriodKey): AccuracyPeriod =>
	k === "all" ? null : (Number(k) as AccuracyPeriod);

const periodText = (p: AccuracyPeriod) =>
	p === null ? "すべての期間" : `直近${p}日`;

/** 見出し「市場評価の精度」と観点ごとのカード。at は集計の時点（null は今） */
export function AccuracySummarySection({
	at,
	active,
}: {
	at: number | null;
	active: boolean;
}) {
	const api = useApi();
	const [data, setData] = useState<AccuracySummary | null>(null);
	const [error, setError] = useState<string | null>(null);
	// 時点を変えた直後と定期の問い合わせが重なっても、最後に出したものだけ使う
	const seq = useRef(0);
	const load = useCallback(async () => {
		const id = ++seq.current;
		try {
			const r = await api.api.scoring.accuracy.summary
				.$get({
					query: at === null ? { at: undefined } : { at: String(at) },
				})
				.then((res) => readJson<AccuracySummary>(res));
			if (id !== seq.current) return;
			setData(r);
			setError(null);
		} catch (e) {
			if (id === seq.current) setError(errorMessage(e));
		}
	}, [api, at]);
	useEffect(() => {
		if (active) load();
	}, [active, load]);
	useInterval(load, POLL_MS, active);

	return (
		<section aria-label="市場評価の精度" className="flex flex-col gap-2.5">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<h2 className="text-[15px] font-bold">市場評価の精度</h2>
				{data && (
					<span
						data-testid="accuracy-summary-setting"
						className="num text-xs text-text-2"
					>
						{periodText(data.periodDays)}・{data.horizon}
					</span>
				)}
				<Help label="市場評価の精度">
					<p>
						期間（設定の「精度」）に採点した記事の精度を、精度ごとに数える。精度は一覧の各記事に出しているものと同じで、記事の点数の段階と、採点から測る長さの後の値動きの段階が一致で
						5、1段ずれるごとに 1 下げる。
					</p>
					<p>
						棒は精度ごとの件数で、記事の点数の段階（評価基準に当てたもの）で色分けする。棒を押すと段階ごとの件数を出す。
					</p>
					<p>
						測る長さがまだたっていない記事（測定中）・値動きが分からない記事・持続が「なし」の記事は数えない。
					</p>
				</Help>
			</div>
			{data ? (
				JUDGES.map((j) => (
					<SummaryCard key={j} judge={j} result={data.results[j]} />
				))
			) : error ? null : (
				<p role="status" className="text-xs text-text-2">
					読み込み中
				</p>
			)}
			{error && (
				<p role="alert" className="text-xs font-semibold text-loss">
					精度を読み込めなかった（{error}）
				</p>
			)}
		</section>
	);
}

/** 棒の高さの最大（px） */
const CHART_H = 120;

function SummaryCard<J extends Judge>({
	judge,
	result,
}: {
	judge: J;
	result: AccuracySummaryResult<J>;
}) {
	const [open, setOpen] = useState<number | null>(null);
	// 横軸は精度の低い順（左が 1）
	const rows = [...result.rows].sort((a, b) => a.precision - b.precision);
	const max = Math.max(1, ...rows.map((r) => r.count));
	const selected = rows.find((r) => r.precision === open);
	return (
		<section
			aria-label={`${JUDGE_LABELS[judge]}の精度`}
			data-testid={`accuracy-summary-${judge}`}
			className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-3.5 py-3"
		>
			<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<strong>{JUDGE_LABELS[judge]}</strong>
				<span className="num text-xs text-text-2">
					{result.average === null
						? "精度を出せた記事なし"
						: `平均 ${result.average.toFixed(1)} · ${result.count}件`}
				</span>
			</span>
			<div className="flex items-end gap-2 border-b border-line">
				{rows.map((r) => (
					<button
						key={r.precision}
						type="button"
						aria-label={`精度 ${r.precision}: ${r.count}件`}
						aria-pressed={open === r.precision}
						disabled={r.count === 0}
						onClick={() => setOpen(open === r.precision ? null : r.precision)}
						className={`flex flex-1 flex-col items-center justify-end gap-1 rounded-t-md pt-1 ${open === r.precision ? "bg-surface-2" : ""}`}
						style={{ height: CHART_H + 24 }}
					>
						<span className="num text-xs">{r.count}</span>
						<span
							className="flex w-3/5 max-w-10 flex-col-reverse overflow-hidden rounded-t-sm"
							style={{ height: (r.count / max) * CHART_H }}
						>
							{LEVEL_ORDER[judge].map((v) => {
								const n = r.levels.find((x) => x.value === v)?.count ?? 0;
								return n === 0 ? null : (
									<i
										key={v}
										data-level={v}
										style={{
											height: `${(n / r.count) * 100}%`,
											...levelFill(judge, v),
										}}
									/>
								);
							})}
						</span>
					</button>
				))}
			</div>
			<div aria-hidden="true" className="-mt-1 flex gap-2 text-xs text-text-2">
				{rows.map((r) => (
					<span key={r.precision} className="num flex-1 text-center">
						{r.precision}
					</span>
				))}
			</div>
			<p className="-mt-1 text-center text-[10px] text-text-2">精度</p>
			{selected && (
				<p data-testid="accuracy-summary-detail" className="num text-xs">
					精度 {selected.precision}:{" "}
					{[...LEVEL_ORDER[judge]]
						.reverse()
						.flatMap((v) => {
							const n = selected.levels.find((x) => x.value === v)?.count ?? 0;
							return n === 0 ? [] : [`${valueStyle(judge, v).label} ${n}件`];
						})
						.join(" · ")}
				</p>
			)}
			<JudgmentLegend judge={judge} />
		</section>
	);
}
