// 判定の値ごとの色・記号・表示名（モックに合わせる）。チャートの背景と帯でも使う

import type { Judge, JudgmentValue } from "@trading-studio/core";

export type Shape = "up" | "down" | "bar" | "circle" | "tri" | "oct" | "sq";

export type ValueStyle = {
	label: string;
	/** 背景の塗り（CSS 変数名） */
	bg: string;
	/** 記号・帯の色（CSS 変数名） */
	solid: string;
	shape: Shape;
};

export const VALUE_STYLES: {
	[J in Judge]: Record<JudgmentValue<J>, ValueStyle>;
} = {
	trend: {
		up: {
			label: "上昇",
			bg: "--color-up-bg",
			solid: "--color-up",
			shape: "up",
		},
		range: {
			label: "レンジ",
			bg: "--color-range-bg",
			solid: "--color-range",
			shape: "bar",
		},
		down: {
			label: "下落",
			bg: "--color-down-bg",
			solid: "--color-down",
			shape: "down",
		},
	},
	risk: {
		normal: {
			label: "平常",
			bg: "--color-normal-bg",
			solid: "--color-normal",
			shape: "circle",
		},
		caution: {
			label: "警戒",
			bg: "--color-caution-bg",
			solid: "--color-caution",
			shape: "tri",
		},
		crisis: {
			label: "危機",
			bg: "--color-crisis-bg",
			solid: "--color-crisis",
			shape: "oct",
		},
	},
	sentiment: {
		"+2": {
			label: "+2 強い楽観",
			bg: "--color-sp2-bg",
			solid: "--color-sp2",
			shape: "sq",
		},
		"+1": {
			label: "+1 やや楽観",
			bg: "--color-sp1-bg",
			solid: "--color-sp1",
			shape: "sq",
		},
		"0": {
			label: "0 中立",
			bg: "--color-s0-bg",
			solid: "--color-s0",
			shape: "sq",
		},
		"-1": {
			label: "−1 やや悲観",
			bg: "--color-sm1-bg",
			solid: "--color-sm1",
			shape: "sq",
		},
		"-2": {
			label: "−2 強い悲観",
			bg: "--color-sm2-bg",
			solid: "--color-sm2",
			shape: "sq",
		},
	},
};

export function valueStyle<J extends Judge>(
	judge: J,
	value: JudgmentValue<J>,
): ValueStyle {
	return (VALUE_STYLES[judge] as Record<string, ValueStyle>)[
		value
	] as ValueStyle;
}
