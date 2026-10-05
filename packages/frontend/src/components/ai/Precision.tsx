// 市場評価の精度（センチメント・リスクそれぞれ1つの指標と5段階の評価）。ニュース画面の一覧と精度分析のタブで使う

import type {
	AccuracyHorizon,
	AccuracyReport,
	VersionStats,
} from "@trading-studio/backend";
import type { Judge } from "@trading-studio/core";
import { JUDGE_LABELS, JUDGES } from "@trading-studio/core";
import { useCallback } from "react";
import { Link } from "react-router";
import { useApi } from "../../api";
import type { PrecisionGrade } from "../../lib/grade";
import { gradeRiskPrecision, gradeSentimentPrecision } from "../../lib/grade";
import { readJson, useAsync } from "../../lib/useAsync";
import { GradeBadge } from "../Grade";
import { Help } from "../Help";

export const HORIZON_LABELS: Record<AccuracyHorizon, string> = {
	"4h": "4時間後",
	"24h": "24時間後",
};

export type Precision = {
	badge: PrecisionGrade;
	/** 指標の名前 */
	metric: string;
	/** 指標の値（的中率は「35%」、倍率は「1.07倍」）。出せなければ「—」 */
	value: string;
	/** 算出に使った件数の説明 */
	basis: string;
};

/**
 * リスクの見分け率（%）。荒れた記事のうち警戒以上と言えた割合と、静かだった記事のうち平常と言えた割合の平均。
 * 平常ばかり付けても高くならないよう、単純な的中率にしない。片側が無ければ null
 */
export function riskDiscrimination(r: VersionStats["risk"]): number | null {
	if (r.rough === 0 || r.calm === 0) return null;
	return ((r.roughHigh / r.rough + r.calmNormal / r.calm) / 2) * 100;
}

/** 使用中の版の、設定の長さの後の値動きで測った精度。採点した記事が無ければ null */
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
	// 出す値と評価が食い違わないよう、四捨五入した値で評価する
	const hitRate =
		s.directed === 0 ? null : Math.round((s.hits / s.directed) * 100);
	const r = v.risk;
	const raw = riskDiscrimination(r);
	const rate = raw === null ? null : Math.round(raw);
	return {
		sentiment: {
			badge: gradeSentimentPrecision(hitRate, s.directed, report.minSamples),
			metric: "的中率",
			value: hitRate === null ? "—" : `${hitRate}%`,
			basis: `強気・弱気の材料 ${s.directed} 件のうち、値動きの向きが合った ${s.hits} 件の割合`,
		},
		risk: {
			badge: gradeRiskPrecision(rate, r.rough, report.minSamples),
			metric: "見分け率",
			value: rate === null ? "—" : `${rate}%`,
			basis: `荒れた記事 ${r.rough} 件のうち警戒以上 ${r.roughHigh} 件、静かだった記事 ${r.calm} 件のうち平常 ${r.calmNormal} 件。それぞれの割合の平均`,
		},
	};
}

/** 精度の計算に使う集計（設定の長さ）。重いので開いたときに1回だけ読む */
export function usePrecisionReport() {
	const api = useApi();
	const load = useCallback(
		() =>
			api.api.scoring.accuracy
				.$get({ query: {} })
				.then((r) => readJson<AccuracyReport>(r)),
		[api],
	);
	return useAsync(load);
}

const dashed =
	"inline-block rounded-full border border-dashed border-line px-1.5 text-[11px] leading-4 font-semibold whitespace-nowrap text-text-2";

/** 5段階の評価と、件数が足りないときの「データ不足」 */
export function PrecisionBadge({ value }: { value: PrecisionGrade }) {
	return (
		<span className="inline-flex items-center gap-1">
			{value.grade === null ? (
				<span data-testid="grade-badge" data-grade="none" className={dashed}>
					評価なし
				</span>
			) : (
				<GradeBadge value={value.grade} />
			)}
			{value.insufficient && (
				<span data-testid="precision-insufficient" className={dashed}>
					データ不足
				</span>
			)}
		</span>
	);
}

/** 読み上げ用の評価の文言 */
const badgeText = (b: PrecisionGrade) =>
	`${b.grade?.label ?? "評価なし"}${b.insufficient ? "・データ不足" : ""}`;

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
			className="inline-flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-text-2"
			aria-label={`精度 ${badgeText(precision.badge)}（${precision.metric} ${precision.value}）。精度分析を開く`}
		>
			<span className="whitespace-nowrap">精度</span>
			<PrecisionBadge value={precision.badge} />
			<span className="num whitespace-nowrap">
				（{precision.metric} {precision.value}）
			</span>
		</Link>
	);
}

/** 精度の測り方。値は精度の設定（期間・長さ・件数）に合わせる */
export type PrecisionBasis = Pick<
	AccuracyReport,
	"days" | "horizon" | "roughPct" | "minSamples"
>;

export function PrecisionHelp({ basis }: { basis: PrecisionBasis | null }) {
	const days = basis ? `直近 ${basis.days} 日` : "直近の期間";
	const after = basis ? HORIZON_LABELS[basis.horizon] : "一定時間後";
	const rough = basis ? `±${basis.roughPct}%` : "一定以上";
	return (
		<Help label="精度">
			<p>
				使用中の版の採点を、{days}の記事について、採点した時刻から{after}
				の値動きと突き合わせる。優秀・良い・普通・悪い・非常に悪い
				の5段階。期間・長さ・データ不足の件数は設定の「ニュース」→「精度」で変える。
			</p>
			<ul className="flex list-disc flex-col gap-1 pl-4">
				<li>
					センチメント:
					的中率。やや強気以上・やや弱気以下の記事のうち、値動きの向きが合った割合。偶然でも50%前後になる。65%以上=優秀、55%以上=良い、45%以上=普通、35%以上=悪い、35%未満=非常に悪い
				</li>
				<li>
					リスク: 見分け率。{rough}
					以上動いた（荒れた）記事のうち警戒以上と言えた割合と、静かだった記事のうち平常と言えた割合の平均。平常ばかり付けても高くならず、50%が当てずっぽうと同じ。基準はセンチメントと同じ
				</li>
			</ul>
			<p>
				センチメントは強気・弱気の材料、リスクは荒れた記事が
				{basis ? ` ${basis.minSamples} ` : "一定"}
				件未満のときは偶然と区別できないので、評価に「データ不足」を添える。
			</p>
		</Help>
	);
}

/** 精度分析のタブの先頭。観点ごとの精度と、その算出に使った件数 */
export function PrecisionSummary({
	precision,
	basis,
}: {
	precision: Record<Judge, Precision> | null;
	basis: PrecisionBasis;
}) {
	return (
		<>
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">精度</h2>
				<PrecisionHelp basis={basis} />
			</div>
			<section
				aria-label="精度"
				className="overflow-hidden rounded-xl border border-line bg-surface"
			>
				{precision === null ? (
					<p className="px-3.5 py-3 text-xs text-text-2">
						直近 {basis.days} 日に採点した記事が無い
					</p>
				) : (
					JUDGES.map((j) => (
						<div
							key={j}
							data-testid={`precision-${j}`}
							className="flex flex-col gap-1 border-b border-line px-3.5 py-3 last:border-b-0"
						>
							<span className="flex items-center justify-between gap-2">
								<strong>{JUDGE_LABELS[j]}</strong>
								<PrecisionBadge value={precision[j].badge} />
							</span>
							<span className="flex items-baseline gap-1.5">
								<span className="text-xs text-text-2">
									{precision[j].metric}
								</span>
								<span className="num text-lg font-bold">
									{precision[j].value}
								</span>
							</span>
							<span className="num text-xs text-text-2">
								{precision[j].basis}
							</span>
						</div>
					))
				)}
			</section>
		</>
	);
}
