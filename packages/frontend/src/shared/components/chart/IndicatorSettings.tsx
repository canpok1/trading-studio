// チャートの設定の中で、EMA・RSI・ボリンジャーバンドの本数を変える欄

import { LIMITS } from "@trading-studio/core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type {
	BbSetting,
	EmaSetting,
	IndicatorControl,
	RsiSetting,
} from "../../lib/chart-indicators";
import { validBb, validEma, validRsi } from "../../lib/chart-indicators";
import { NumberInput } from "../NumberInput";

const range = (r: { min: number; max: number }) => `${r.min}〜${r.max}`;

const FIELD = "flex items-center gap-1.5 text-[13px]";

/**
 * 入力中の値。正しい値になったらすぐ保存して描き直す。
 * 外から値が変わったとき（戻す・戦略の切り替え）だけ合わせ直す。保存した値と同じ内容なら入力中の形を保つ（EMA は並べ替えて保存するので、打っている途中で欄が入れ替わらないように）
 */
function useDraft<D, V>(
	value: D,
	save: (v: V) => void,
	toValue: (draft: D) => unknown,
	valid: (v: unknown) => v is V,
) {
	const [draft, setDraft] = useState(value);
	const key = JSON.stringify(normalize(toValue(value)));
	// biome-ignore lint/correctness/useExhaustiveDependencies: 保存した値が変わったときだけ見る
	useEffect(() => {
		setDraft((cur) => {
			const v = toValue(cur);
			return valid(v) && JSON.stringify(normalize(v)) === key ? cur : value;
		});
	}, [key]);
	const change = (next: D) => {
		setDraft(next);
		const v = toValue(next);
		if (valid(v)) save(v);
	};
	return { draft, setDraft, change, ok: valid(toValue(draft)) };
}

/** 保存のときと同じ形にそろえる（EMA は小さい順） */
function normalize(v: unknown) {
	return Array.isArray(v) ? [...v].sort((a, b) => a - b) : v;
}

/** 保存した値が戻す先と同じ（戦略を切り替えた後など）だと値が変わらず欄が合わせ直されないので、欄も直接戻す */
function Reset({
	control,
	onReset,
}: {
	control: Pick<IndicatorControl<null>, "custom" | "fromStrategy" | "save">;
	onReset: () => void;
}) {
	if (!control.custom) return null;
	return (
		<button
			type="button"
			onClick={() => {
				control.save(null);
				onReset();
			}}
			className="text-xs font-semibold text-accent underline"
		>
			{control.fromStrategy ? "戦略の値に戻す" : "既定の値に戻す"}
		</button>
	);
}

function Note({ children }: { children: ReactNode }) {
	return <p className="text-xs text-text-2">{children}</p>;
}

function Invalid({ children }: { children: ReactNode }) {
	return (
		<p role="alert" className="text-xs font-semibold text-loss">
			{children}
		</p>
	);
}

// 2本目は空欄なら1本だけ描く
const emaValue = (d: [number, number]) =>
	Number.isNaN(d[1]) ? [d[0]] : [d[0], d[1]];

export function EmaFields({
	control,
}: {
	control: IndicatorControl<EmaSetting>;
}) {
	const pair = (v: EmaSetting): [number, number] => [
		v[0] ?? Number.NaN,
		v[1] ?? Number.NaN,
	];
	const { draft, setDraft, change, ok } = useDraft(
		pair(control.value),
		control.save,
		emaValue,
		validEma,
	);
	return (
		<>
			<div className="flex flex-wrap items-center gap-3">
				<span className={FIELD}>
					1本目
					<NumberInput
						value={draft[0]}
						onChange={(n) => change([n, draft[1]])}
						invalid={!ok}
						inputMode="numeric"
						aria-label="EMA 1本目の本数"
						className="w-16"
					/>
				</span>
				<span className={FIELD}>
					2本目
					<NumberInput
						value={draft[1]}
						onChange={(n) => change([draft[0], n])}
						invalid={!ok}
						inputMode="numeric"
						aria-label="EMA 2本目の本数"
						className="w-16"
					/>
				</span>
				<Reset control={control} onReset={() => setDraft(pair(control.base))} />
			</div>
			{ok ? (
				<Note>
					{range(LIMITS.emaPeriod)} 本。2本目は空欄なら1本だけ描く。
					{control.fromStrategy ? "戦略の値" : "既定"}は{" "}
					{control.base.join("・")} 本
				</Note>
			) : (
				<Invalid>{range(LIMITS.emaPeriod)} の整数で、2本は別の値にする</Invalid>
			)}
		</>
	);
}

export function RsiFields({
	control,
}: {
	control: IndicatorControl<RsiSetting>;
}) {
	const { draft, setDraft, change, ok } = useDraft(
		control.value,
		control.save,
		(d) => d,
		validRsi,
	);
	const b = control.base;
	return (
		<>
			<div className="flex flex-wrap items-center gap-3">
				<span className={FIELD}>
					本数
					<NumberInput
						value={draft.period}
						onChange={(period) => change({ ...draft, period })}
						invalid={!ok}
						inputMode="numeric"
						aria-label="RSI の本数"
						className="w-14"
					/>
				</span>
				<span className={FIELD}>
					下
					<NumberInput
						value={draft.lower}
						onChange={(lower) => change({ ...draft, lower })}
						invalid={!ok}
						inputMode="numeric"
						aria-label="RSI の下のしきい値"
						className="w-14"
					/>
				</span>
				<span className={FIELD}>
					上
					<NumberInput
						value={draft.upper}
						onChange={(upper) => change({ ...draft, upper })}
						invalid={!ok}
						inputMode="numeric"
						aria-label="RSI の上のしきい値"
						className="w-14"
					/>
				</span>
				<Reset control={control} onReset={() => setDraft(control.base)} />
			</div>
			{ok ? (
				<Note>
					本数は {range(LIMITS.rsiPeriod)}、下・上のしきい値は{" "}
					{range(LIMITS.rsiThreshold)}。
					{control.fromStrategy ? "戦略の値" : "既定"}は {b.period} 本・
					{b.lower}/{b.upper}
				</Note>
			) : (
				<Invalid>整数で入れ、下のしきい値は上より小さくする</Invalid>
			)}
		</>
	);
}

export function BbFields({
	control,
}: {
	control: IndicatorControl<BbSetting>;
}) {
	const { draft, setDraft, change, ok } = useDraft(
		control.value,
		control.save,
		(d) => d,
		validBb,
	);
	const b = control.base;
	return (
		<>
			<div className="flex flex-wrap items-center gap-3">
				<span className={FIELD}>
					本数
					<NumberInput
						value={draft.period}
						onChange={(period) => change({ ...draft, period })}
						invalid={!ok}
						inputMode="numeric"
						aria-label="ボリンジャーバンドの本数"
						className="w-14"
					/>
				</span>
				<span className={FIELD}>
					σ
					<NumberInput
						value={draft.sigma}
						onChange={(sigma) => change({ ...draft, sigma })}
						invalid={!ok}
						inputMode="decimal"
						aria-label="ボリンジャーバンドの σ"
						className="w-14"
					/>
				</span>
				<Reset control={control} onReset={() => setDraft(control.base)} />
			</div>
			{ok ? (
				<Note>
					本数は {range(LIMITS.bollingerPeriod)}、σ は{" "}
					{range(LIMITS.bollingerSigma)}（0.1 刻み）。
					{control.fromStrategy ? "戦略の値" : "既定"}は {b.period} 本・
					{b.sigma}σ
				</Note>
			) : (
				<Invalid>本数は整数、σ は 0.1 刻みで範囲内に入れる</Invalid>
			)}
		</>
	);
}
