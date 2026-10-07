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

function SummaryCard({
	judge,
	result,
}: {
	judge: Judge;
	result: AccuracySummaryResult;
}) {
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
			<table className="w-full text-[13px]">
				<thead>
					<tr className="text-xs text-text-2">
						<th className="py-1 text-left font-normal">精度</th>
						<th className="py-1 text-right font-normal">件数</th>
					</tr>
				</thead>
				<tbody>
					{result.rows.map((row) => (
						<tr
							key={row.precision}
							className={`border-t border-line ${row.count === 0 ? "text-text-2" : ""}`}
						>
							<td className="num py-1.5">{row.precision}</td>
							<td className="num py-1.5 text-right">{row.count}件</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}
