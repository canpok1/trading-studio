// 市場評価の精度（センチメント・リスクそれぞれ得点率と5段階の評価）。ニュース画面の一覧と精度分析のタブで使う

import type {
	AccuracyHorizon,
	AccuracyReport,
	LevelMatch,
} from "@trading-studio/backend";
import type { Judge } from "@trading-studio/core";
import { JUDGE_LABELS, JUDGES } from "@trading-studio/core";
import { useCallback } from "react";
import { Link } from "react-router";
import { useApi } from "../../api";
import type { PrecisionGrade } from "../../lib/grade";
import { gradePrecision } from "../../lib/grade";
import { readJson, useAsync } from "../../lib/useAsync";
import { GradeBadge } from "../Grade";
import { Help } from "../Help";

export const HORIZON_LABELS: Record<AccuracyHorizon, string> = {
	"4h": "4時間後",
	"24h": "24時間後",
};

/** 評価と突き合わせる、値動きの段階の名前 */
export const MOVE_LEVEL_LABELS: Record<Judge, Record<number, string>> = {
	sentiment: {
		[-2]: "大きく下落",
		[-1]: "下落",
		0: "横ばい",
		1: "上昇",
		2: "大きく上昇",
	},
	risk: { 0: "静か", 1: "荒れた", 2: "大荒れ" },
};

export type Precision = {
	badge: PrecisionGrade;
	/** 指標の名前 */
	metric: string;
	/** 指標の値（「48%」）。出せなければ「—」 */
	value: string;
	/** 算出に使った件数の説明 */
	basis: string;
};

/** 出す値と評価が食い違わないよう、四捨五入した値で評価する */
export const roundedRate = (m: LevelMatch) =>
	m.rate === null ? null : Math.round(m.rate);

export const matchCount = (m: LevelMatch) => m.exact + m.near + m.miss;

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
	const of = (judge: Judge): Precision => {
		const m = v[judge].match;
		const rate = roundedRate(m);
		const n = matchCount(m);
		return {
			badge: gradePrecision(
				judge,
				rate,
				n,
				m.levels.some((l) => l.count === 0),
				report.minSamples,
			),
			metric: "得点率",
			value: rate === null ? "—" : `${rate}%`,
			basis: `記事 ${n} 件（2点 ${m.exact}・1点 ${m.near}・0点 ${m.miss}）。値動きの段階ごとの平均点を、さらに平均した割合`,
		};
	};
	return { sentiment: of("sentiment"), risk: of("risk") };
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

/** 精度の測り方。値は精度の設定（期間・長さ・件数・段階の境目）に合わせる */
export type PrecisionBasis = Pick<
	AccuracyReport,
	"days" | "horizon" | "minSamples" | "sentimentBands" | "riskBands"
>;

export function PrecisionHelp({ basis }: { basis: PrecisionBasis | null }) {
	const days = basis ? `直近 ${basis.days} 日` : "直近の期間";
	const after = basis ? HORIZON_LABELS[basis.horizon] : "一定時間後";
	const sb = basis?.sentimentBands;
	const rb = basis?.riskBands;
	return (
		<Help label="精度">
			<p>
				使用中の版の採点を、{days}の記事について、採点した時刻から{after}
				の値動きと突き合わせる。優秀・良い・普通・悪い・非常に悪い
				の5段階。期間・長さ・段階の境目・データ不足の件数は設定の「ニュース」→「精度」で変える。
			</p>
			<p>
				記事ごとに、評価の段階と値動きの段階が一致で2点、1段ずれで1点、それ以外は0点。得点率は、値動きの段階ごとの平均点（2点満点）を、記事のある段階で平均した割合。横ばいばかりの期間に中立を付け続けても高くならない。
			</p>
			<ul className="flex list-disc flex-col gap-1 pl-4">
				<li>
					センチメント: 強い弱気〜強い強気の5段階を、
					{sb
						? `±${sb.small}% 未満=横ばい、±${sb.large}% 未満=上昇・下落、それ以上=大きく上昇・大きく下落`
						: "横ばい・上昇・下落・大きく上昇・大きく下落"}
					と比べる。常に中立で40%、でたらめで36%。55%以上=優秀、45%以上=良い、35%以上=普通、25%以上=悪い、25%未満=非常に悪い
				</li>
				<li>
					リスク: 平常・警戒・危機を、上下を問わない値動きの大きさ
					{rb
						? `（±${rb.rough}% 未満=静か、±${rb.wild}% 未満=荒れた、それ以上=大荒れ）`
						: "（静か・荒れた・大荒れ）"}
					と比べる。常に平常で50%、でたらめで56%。70%以上=優秀、60%以上=良い、50%以上=普通、40%以上=悪い、40%未満=非常に悪い
				</li>
			</ul>
			<p>
				数えた記事が{basis ? ` ${basis.minSamples} ` : "一定"}
				件未満のときや、記事の無い値動きの段階があるときは偶然と区別できないので、評価に「データ不足」を添える。
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
