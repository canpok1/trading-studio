// 判定の値ごとの色・表示名（モックに合わせる）。チャートの背景と帯でも使う

import type { Judge, JudgmentValue } from "@trading-studio/core";

export type ValueStyle = {
	label: string;
	/** 背景の塗り（CSS 変数名） */
	bg: string;
	/** 塗り・帯の色（CSS 変数名） */
	solid: string;
};

export const VALUE_STYLES: {
	[J in Judge]: Record<JudgmentValue<J>, ValueStyle>;
} = {
	risk: {
		calm: {
			label: "平常",
			bg: "--color-normal-bg",
			solid: "--color-normal",
		},
		mild: {
			label: "やや警戒",
			bg: "--color-mild-bg",
			solid: "--color-mild",
		},
		alert: {
			label: "警戒",
			bg: "--color-caution-bg",
			solid: "--color-caution",
		},
		severe: {
			label: "かなり警戒",
			bg: "--color-severe-bg",
			solid: "--color-severe",
		},
		crisis: {
			label: "危機",
			bg: "--color-crisis-bg",
			solid: "--color-crisis",
		},
	},
	sentiment: {
		"+2": {
			label: "かなり強気",
			bg: "--color-sp2-bg",
			solid: "--color-sp2",
		},
		"+1": {
			label: "やや強気",
			bg: "--color-sp1-bg",
			solid: "--color-sp1",
		},
		"0": {
			label: "中立",
			bg: "--color-s0-bg",
			solid: "--color-s0",
		},
		"-1": {
			label: "やや弱気",
			bg: "--color-sm1-bg",
			solid: "--color-sm1",
		},
		"-2": {
			label: "かなり弱気",
			bg: "--color-sm2-bg",
			solid: "--color-sm2",
		},
	},
};

/** リスクが3段階だった頃の値（取引の判断の記録に残っている）は、同じ名前の今の値の見た目にする */
const LEGACY_VALUES: Record<string, string> = {
	normal: "calm",
	caution: "alert",
};

export function valueStyle<J extends Judge>(
	judge: J,
	value: JudgmentValue<J>,
): ValueStyle {
	const styles = VALUE_STYLES[judge] as Record<string, ValueStyle>;
	return (styles[value] ?? styles[LEGACY_VALUES[value] ?? ""]) as ValueStyle;
}
