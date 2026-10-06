import type { CurrentJudgment } from "@trading-studio/backend";
import type { Judge } from "@trading-studio/core";
import {
	JUDGE_LABELS,
	JUDGES,
	JUDGMENT_VALUE_LABELS,
} from "@trading-studio/core";
import { JudgmentBadge } from "../judgment/JudgmentBadge";

/** 重みの割合を整数の % で出す。0 件でないのに 0% に丸まるものは「1%未満」 */
function percent(share: number, count: number): string {
	if (count === 0) return "0%";
	const p = Math.round(share * 100);
	return p === 0 ? "1%未満" : `${p}%`;
}

/** 市場評価に使った記事を、記事の点数の段階ごとに件数・平均点・重みの割合で出す */
export function BreakdownCards({ current }: { current: CurrentJudgment }) {
	return (
		<>
			{JUDGES.map((j) => (
				<BreakdownCard key={j} judge={j} current={current} />
			))}
		</>
	);
}

function BreakdownCard({
	judge,
	current,
}: {
	judge: Judge;
	current: CurrentJudgment;
}) {
	const r = current.results[judge];
	return (
		<section
			aria-label={`${JUDGE_LABELS[judge]}の内訳`}
			data-testid={`breakdown-${judge}`}
			className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-3.5 py-3"
		>
			<div className="flex items-center justify-between gap-2">
				<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<strong>{JUDGE_LABELS[judge]}</strong>
					<span className="num text-xs text-text-2">
						{r.average === null
							? "対象のニュースなし"
							: `${r.average}点 · ${r.count}件から算出`}
					</span>
				</span>
				<JudgmentBadge judge={judge} value={r.value} />
			</div>
			<table className="w-full text-[13px]">
				<thead>
					<tr className="text-xs text-text-2">
						<th className="py-1 text-left font-normal">記事の点数の段階</th>
						<th className="py-1 text-right font-normal">件数</th>
						<th className="py-1 text-right font-normal">平均点</th>
						<th className="py-1 text-right font-normal">重みの割合</th>
					</tr>
				</thead>
				<tbody>
					{current.breakdown[judge].map((row) => (
						<tr
							key={row.value}
							className={`border-t border-line ${row.count === 0 ? "text-text-2" : ""}`}
						>
							<td className="py-1.5">{JUDGMENT_VALUE_LABELS[row.value]}</td>
							<td className="num py-1.5 text-right">{row.count}件</td>
							<td className="num py-1.5 text-right">
								{row.average === null ? "—" : `${row.average}点`}
							</td>
							<td className="num py-1.5 text-right">
								{percent(row.share, row.count)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}
