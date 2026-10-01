// 成績の数値の横に出す評価のバッジと、その基準の説明

import type { Grade, GradeBadgeValue } from "../lib/grade";
import { fewTradesNote } from "../lib/grade";
import { Help } from "./Help";

const TONE: Record<Grade, string> = {
	excellent: "bg-grade-excellent-bg text-grade-excellent",
	good: "bg-grade-good-bg text-grade-good",
	fair: "bg-grade-fair-bg text-grade-fair",
	poor: "bg-grade-poor-bg text-grade-poor",
	bad: "bg-grade-bad-bg text-grade-bad",
};

export function GradeBadge({ value }: { value: GradeBadgeValue | null }) {
	if (!value) return null;
	return (
		<span
			data-testid="grade-badge"
			data-grade={value.grade}
			className={`inline-block rounded-full px-1.5 py-px text-[11px] leading-4 font-semibold whitespace-nowrap ${TONE[value.grade]}`}
		>
			{value.label}
		</span>
	);
}

/** 成績の見出しの横に置く「？」。評価の基準を説明する */
export function GradeHelp() {
	return (
		<Help label="成績の評価">
			<p>数値ごとの評価。優秀・良い・普通・悪い・非常に悪い の5段階。</p>
			<ul className="flex list-disc flex-col gap-1 pl-4">
				<li>
					損益:
					同じ期間ただ買って持っていた場合（ガチホ）と比べる。0以上でガチホより5ポイント以上上=優秀、0以上でガチホ以上=良い、0以上だがガチホ未満=普通、マイナスだがガチホ以上=悪い、マイナスでガチホ未満=非常に悪い。取引も保有も無いときは普通
				</li>
				<li>
					PF:
					2.0以上=優秀、1.5以上=良い、1.2以上=普通、1.0以上=悪い（手数料や誤差で消える水準）、1.0未満=非常に悪い
				</li>
				<li>
					最大DD:
					5%以下=優秀、10%以下=良い、20%以下=普通、30%以下=悪い、30%超=非常に悪い
				</li>
				<li>
					勝率:
					70%以上=優秀、60%以上=良い、40%以上=普通、30%以上=悪い、30%未満=非常に悪い。勝率は1回の利益と損失の大きさと組みで見るもので、単独では当てにならない
				</li>
			</ul>
			<p>
				取引回数は戦略ごとに適切な数が違うので評価しない。30回未満のときは、勝率・PF
				の評価が偶然の可能性があると成績の下に知らせる。
			</p>
		</Help>
	);
}

/** 取引が少なく、勝率・PF の評価を割り引いて見るべきときの注意 */
export function FewTradesNote({ trades }: { trades: number }) {
	const note = fewTradesNote(trades);
	if (!note) return null;
	return (
		<p data-testid="few-trades-note" className="text-xs text-text-2">
			{note}
		</p>
	);
}
