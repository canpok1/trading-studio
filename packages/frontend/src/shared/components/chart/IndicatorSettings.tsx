// チャートの EMA・RSI・ボリンジャーバンドの本数を変えるモーダル

import { LIMITS } from "@trading-studio/core";
import { useState } from "react";
import type {
	BbSetting,
	EmaSetting,
	IndicatorControl,
	RsiSetting,
} from "../../lib/chart-indicators";
import { validBb, validEma, validRsi } from "../../lib/chart-indicators";
import { Modal } from "../Modal";
import { NumberInput } from "../NumberInput";
import { Button } from "../ui";

const range = (r: { min: number; max: number }) => `${r.min}〜${r.max}`;

const FIELD = "flex items-center justify-between gap-3 text-[15px]";

function Footer({
	control,
	canApply,
	onApply,
	onClose,
}: {
	control: Pick<IndicatorControl<null>, "custom" | "fromStrategy" | "save">;
	canApply: boolean;
	onApply: () => void;
	onClose: () => void;
}) {
	return (
		<div className="flex flex-col gap-2">
			<Button variant="primary" disabled={!canApply} onClick={onApply}>
				表示する
			</Button>
			<Button
				disabled={!control.custom}
				onClick={() => {
					control.save(null);
					onClose();
				}}
			>
				{control.fromStrategy ? "戦略の値に戻す" : "既定の値に戻す"}
			</Button>
			<Button variant="link" onClick={onClose}>
				やめる
			</Button>
		</div>
	);
}

export function EmaSettingsModal({
	control,
	onClose,
}: {
	control: IndicatorControl<EmaSetting>;
	onClose: () => void;
}) {
	const [first, setFirst] = useState(control.value[0] ?? Number.NaN);
	const [second, setSecond] = useState(control.value[1] ?? Number.NaN);
	// 2本目は空欄なら1本だけ描く
	const next = Number.isNaN(second) ? [first] : [first, second];
	const ok = validEma(next);
	return (
		<Modal title="EMA の本数" onClose={onClose}>
			<p className="text-xs text-text-2">
				{range(LIMITS.emaPeriod)} 本。2本目は空欄なら1本だけ描く。
				{control.fromStrategy
					? `戦略の値は ${control.base.join("・")} 本`
					: `戦略で使っていないときの既定は ${control.base.join("・")} 本`}
			</p>
			<div className={FIELD}>
				1本目
				<NumberInput
					value={first}
					onChange={setFirst}
					invalid={!ok}
					inputMode="numeric"
					aria-label="EMA 1本目の本数"
					className="w-20"
				/>
			</div>
			<div className={FIELD}>
				2本目
				<NumberInput
					value={second}
					onChange={setSecond}
					invalid={!ok}
					inputMode="numeric"
					aria-label="EMA 2本目の本数"
					className="w-20"
				/>
			</div>
			{!ok && (
				<p role="alert" className="text-xs font-semibold text-loss">
					{range(LIMITS.emaPeriod)} の整数で、2本は別の値にする
				</p>
			)}
			<Footer
				control={control}
				canApply={ok}
				onApply={() => {
					control.save(next);
					onClose();
				}}
				onClose={onClose}
			/>
		</Modal>
	);
}

export function RsiSettingsModal({
	control,
	onClose,
}: {
	control: IndicatorControl<RsiSetting>;
	onClose: () => void;
}) {
	const [v, setV] = useState(control.value);
	const ok = validRsi(v);
	const b = control.base;
	return (
		<Modal title="RSI の本数としきい値" onClose={onClose}>
			<p className="text-xs text-text-2">
				本数は {range(LIMITS.rsiPeriod)}、しきい値は{" "}
				{range(LIMITS.rsiThreshold)}
				。しきい値は小窓に点線で引く。
				{control.fromStrategy ? "戦略の値" : "戦略で使っていないときの既定"}は{" "}
				{b.period} 本・{b.lower}/{b.upper}
			</p>
			<div className={FIELD}>
				本数
				<NumberInput
					value={v.period}
					onChange={(period) => setV({ ...v, period })}
					invalid={!ok}
					inputMode="numeric"
					aria-label="RSI の本数"
					className="w-20"
				/>
			</div>
			<div className={FIELD}>
				下のしきい値
				<NumberInput
					value={v.lower}
					onChange={(lower) => setV({ ...v, lower })}
					invalid={!ok}
					inputMode="numeric"
					aria-label="RSI の下のしきい値"
					className="w-20"
				/>
			</div>
			<div className={FIELD}>
				上のしきい値
				<NumberInput
					value={v.upper}
					onChange={(upper) => setV({ ...v, upper })}
					invalid={!ok}
					inputMode="numeric"
					aria-label="RSI の上のしきい値"
					className="w-20"
				/>
			</div>
			{!ok && (
				<p role="alert" className="text-xs font-semibold text-loss">
					整数で入れ、下のしきい値は上より小さくする
				</p>
			)}
			<Footer
				control={control}
				canApply={ok}
				onApply={() => {
					control.save(v);
					onClose();
				}}
				onClose={onClose}
			/>
		</Modal>
	);
}

export function BbSettingsModal({
	control,
	onClose,
}: {
	control: IndicatorControl<BbSetting>;
	onClose: () => void;
}) {
	const [v, setV] = useState(control.value);
	const ok = validBb(v);
	const b = control.base;
	return (
		<Modal title="ボリンジャーバンドの本数と σ" onClose={onClose}>
			<p className="text-xs text-text-2">
				本数は {range(LIMITS.bollingerPeriod)}、σ は{" "}
				{range(LIMITS.bollingerSigma)}（0.1 刻み）。
				{control.fromStrategy ? "戦略の値" : "戦略で使っていないときの既定"}は{" "}
				{b.period} 本・{b.sigma}σ
			</p>
			<div className={FIELD}>
				本数
				<NumberInput
					value={v.period}
					onChange={(period) => setV({ ...v, period })}
					invalid={!ok}
					inputMode="numeric"
					aria-label="ボリンジャーバンドの本数"
					className="w-20"
				/>
			</div>
			<div className={FIELD}>
				σ
				<NumberInput
					value={v.sigma}
					onChange={(sigma) => setV({ ...v, sigma })}
					invalid={!ok}
					inputMode="decimal"
					aria-label="ボリンジャーバンドの σ"
					className="w-20"
				/>
			</div>
			{!ok && (
				<p role="alert" className="text-xs font-semibold text-loss">
					本数は整数、σ は 0.1 刻みで範囲内に入れる
				</p>
			)}
			<Footer
				control={control}
				canApply={ok}
				onApply={() => {
					control.save(v);
					onClose();
				}}
				onClose={onClose}
			/>
		</Modal>
	);
}
