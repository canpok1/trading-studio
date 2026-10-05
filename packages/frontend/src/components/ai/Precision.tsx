// 市場評価の精度（センチメント・リスクそれぞれ1つの指標と5段階の評価）。ニュース画面の一覧と精度分析のタブで使う

import type { AccuracyReport } from "@trading-studio/backend";
import type { Judge } from "@trading-studio/core";
import { JUDGE_LABELS, JUDGES } from "@trading-studio/core";
import { useCallback } from "react";
import { Link } from "react-router";
import { useApi } from "../../api";
import type { PrecisionBadgeValue } from "../../lib/grade";
import {
	gradeRiskPrecision,
	gradeSentimentPrecision,
	PRECISION_MIN_SAMPLES,
} from "../../lib/grade";
import { readJson, useAsync } from "../../lib/useAsync";
import { GradeBadge } from "../Grade";
import { Help } from "../Help";

export type Precision = {
	badge: PrecisionBadgeValue;
	/** 指標の値（的中率は「35%」、倍率は「1.07倍」）。出せなければ「—」 */
	value: string;
	/** 算出に使った件数の説明 */
	basis: string;
};

/** 使用中の版の、24時間後の値動きで測った精度。採点した記事が無ければ null */
export function precisionOf(
	report: AccuracyReport,
): Record<Judge, Precision> | null {
	// 使用中の版が期間内に採点していなければ、ほかの版の値を使用中の版の精度として出さない
	const v =
		report.activeVersion === null
			? report.versions[0]
			: report.versions.find((x) => x.version === report.activeVersion);
	if (!v) return null;
	const s = v.sentiment;
	const hitRate = s.directed === 0 ? null : (s.hits / s.directed) * 100;
	const r = v.risk;
	const ratio =
		r.highMeanAbsPct === null || !r.baseMeanAbsPct
			? null
			: r.highMeanAbsPct / r.baseMeanAbsPct;
	return {
		sentiment: {
			badge: gradeSentimentPrecision(hitRate, s.directed),
			value: hitRate === null ? "—" : `${Math.round(hitRate)}%`,
			basis: `${s.hits} / ${s.directed} 件が的中`,
		},
		risk: {
			badge: gradeRiskPrecision(ratio, r.high),
			value: ratio === null ? "—" : `${ratio.toFixed(2)}倍`,
			basis: `警戒以上 ${r.high} 件`,
		},
	};
}

/** 精度の計算に使う集計（24時間後）。重いので開いたときに1回だけ読む */
export function usePrecisionReport() {
	const api = useApi();
	const load = useCallback(
		() =>
			api.api.scoring.accuracy
				.$get({ query: { horizon: "24h" } })
				.then((r) => readJson<AccuracyReport>(r)),
		[api],
	);
	return useAsync(load);
}

export function PrecisionBadge({ value }: { value: PrecisionBadgeValue }) {
	if (value.grade === "none") {
		return (
			<span
				data-testid="grade-badge"
				data-grade="none"
				className="inline-block rounded-full border border-dashed border-line px-1.5 text-[11px] leading-4 font-semibold whitespace-nowrap text-text-2"
			>
				{value.label}
			</span>
		);
	}
	return <GradeBadge value={value} />;
}

/** 市場評価の行に置く精度。押すと精度分析のタブを開く */
export function PrecisionLink({
	precision,
	to,
}: {
	precision: Precision;
	/** 精度分析のタブの URL。一覧の絞り込みの条件を残すため、呼ぶ側で組み立てる */
	to: string;
}) {
	return (
		<Link
			to={to}
			className="inline-flex items-center gap-1 text-xs text-text-2"
			aria-label={`精度 ${precision.badge.label} ${precision.value}。精度分析を開く`}
		>
			精度
			<PrecisionBadge value={precision.badge} />
			<span className="num">{precision.value}</span>
		</Link>
	);
}

export function PrecisionHelp() {
	return (
		<Help label="精度">
			<p>
				使用中の版の採点を、直近 30
				日の記事について、採点した時刻から24時間後の値動きと突き合わせる。優秀・良い・普通・悪い・非常に悪い
				の5段階。
			</p>
			<ul className="flex list-disc flex-col gap-1 pl-4">
				<li>
					センチメント:
					的中率。やや強気以上・やや弱気以下の記事のうち、値動きの向きが合った割合。偶然でも50%前後になる。65%以上=優秀、55%以上=良い、45%以上=普通、35%以上=悪い、35%未満=非常に悪い
				</li>
				<li>
					リスク:
					警戒以上の記事の後の値動きの大きさが、すべての記事の後の何倍か。1倍なら危険を見分けられていない。1.5倍以上=優秀、1.2倍以上=良い、0.9倍以上=普通、0.7倍以上=悪い、0.7倍未満=非常に悪い
				</li>
			</ul>
			<p>
				対象の記事が {PRECISION_MIN_SAMPLES}{" "}
				件未満のときは偶然と区別できないので「データ不足」。
			</p>
		</Help>
	);
}

/** 精度分析のタブの先頭。観点ごとの精度と、その算出に使った件数 */
export function PrecisionSummary({
	precision,
}: {
	precision: Record<Judge, Precision> | null;
}) {
	return (
		<>
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">精度</h2>
				<PrecisionHelp />
			</div>
			<section
				aria-label="精度"
				className="overflow-hidden rounded-xl border border-line bg-surface"
			>
				{precision === null ? (
					<p className="px-3.5 py-3 text-xs text-text-2">
						直近 30 日に採点した記事が無い
					</p>
				) : (
					JUDGES.map((j) => (
						<div
							key={j}
							data-testid={`precision-${j}`}
							className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-3 last:border-b-0"
						>
							<span className="flex flex-col">
								<strong>{JUDGE_LABELS[j]}</strong>
								<span className="num text-xs text-text-2">
									{precision[j].basis}
								</span>
							</span>
							<span className="flex items-center gap-2">
								<span className="num text-lg font-bold">
									{precision[j].value}
								</span>
								<PrecisionBadge value={precision[j].badge} />
							</span>
						</div>
					))
				)}
			</section>
		</>
	);
}
