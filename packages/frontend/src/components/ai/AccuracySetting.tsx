import type {
	AccuracyHorizon,
	AccuracySettings,
} from "@trading-studio/backend";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../api";
import { errorMessage, readJson, useAsync } from "../../lib/useAsync";
import { Help } from "../Help";
import { NumberInput } from "../NumberInput";
import { Button, Card, Segmented } from "../ui";
import type { PeriodKey } from "./AccuracySummary";
import { PERIOD_OPTIONS, periodKey, periodOf } from "./AccuracySummary";
import { HORIZON_LABELS } from "./Precision";

/** 入力の範囲。backend の検査と合わせる */
const BAND_MAX = 50;
const HORIZONS = ["4h", "24h"] as const;

/** 0 < 小さい順に増える ≦ 上限 */
const validBands = (b: readonly number[]) =>
	b.every(
		(v, i) => Number.isFinite(v) && v > (i === 0 ? 0 : (b[i - 1] as number)),
	) && (b[b.length - 1] as number) <= BAND_MAX;

const errorsOf = (s: AccuracySettings) => ({
	sentimentBands: HORIZONS.every((h) =>
		validBands([s.sentimentBands[h].small, s.sentimentBands[h].large]),
	)
		? undefined
		: `0 より大きく、横ばい < 大きく動いた ≦ ${BAND_MAX}`,
	riskBands: HORIZONS.every((h) => {
		const r = s.riskBands[h];
		return validBands([r.slight, r.rough, r.heavy, r.wild]);
	})
		? undefined
		: `0 より大きく、やや荒れ < 荒れた < かなり荒れ < 大荒れ ≦ ${BAND_MAX}`,
});

/** ニュース画面の記事ごとの精度を測る条件 */
export function AccuracySetting() {
	const api = useApi();
	const load = useCallback(
		() =>
			api.api.scoring.accuracy.settings
				.$get()
				.then((r) => readJson<AccuracySettings>(r)),
		[api],
	);
	const { state, reload } = useAsync(load);
	const saved = state.kind === "ok" ? state.data : null;
	const [draft, setDraft] = useState<AccuracySettings | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
		null,
	);
	useEffect(() => {
		if (saved) setDraft(saved);
	}, [saved]);

	if (state.kind === "error") {
		return (
			<Card>
				<p role="alert" className="text-xs font-semibold text-loss">
					読み込めなかった: {state.message}
				</p>
			</Card>
		);
	}
	if (draft === null || saved === null) return null;

	const errors = errorsOf(draft);
	const invalid = Object.values(errors).some((e) => e !== undefined);
	const changed = JSON.stringify(draft) !== JSON.stringify(saved);
	const edit = (patch: Partial<AccuracySettings>) => {
		setMessage(null);
		setDraft((d) => (d ? { ...d, ...patch } : d));
	};
	const save = async () => {
		setBusy(true);
		setMessage(null);
		try {
			await api.api.scoring.accuracy.settings
				.$put({ json: draft })
				.then((r) => readJson(r));
			setMessage({
				ok: true,
				text: "保存した。ニュース画面の精度と評価詳細のタブに反映する",
			});
			reload();
		} catch (e) {
			setMessage({ ok: false, text: errorMessage(e) });
		} finally {
			setBusy(false);
		}
	};

	// スマホ幅に収めるため、段階を行・測る長さを列にする
	const bands = <K extends "sentimentBands" | "riskBands">(
		key: K,
		title: string,
		rows: readonly (readonly [string, string])[],
	) => (
		<div className="flex flex-col gap-1">
			<table className="w-full max-w-[360px] text-[13px]">
				<caption className="pb-1 text-left">{title}</caption>
				<thead>
					<tr className="text-xs text-text-2">
						<th />
						{HORIZONS.map((h) => (
							<th key={h} className="text-left font-normal">
								{HORIZON_LABELS[h]}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map(([k, label]) => (
						<tr key={k}>
							<th className="py-0.5 pr-2 text-left font-normal">{label}</th>
							{HORIZONS.map((h) => (
								<td key={h} className="py-0.5 pr-2">
									<span className="inline-flex items-center gap-1">
										<span>±</span>
										<NumberInput
											aria-label={`${title} ${HORIZON_LABELS[h]} ${label}`}
											inputMode="decimal"
											value={
												(draft[key][h] as Record<string, number>)[k] ??
												Number.NaN
											}
											onChange={(v) =>
												edit({
													[key]: {
														...draft[key],
														[h]: { ...draft[key][h], [k]: v },
													},
												})
											}
											invalid={errors[key] !== undefined}
											className="w-[64px]"
										/>
										<span>%</span>
									</span>
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
			{errors[key] && (
				<p className="text-xs font-semibold text-loss">{errors[key]}</p>
			)}
		</div>
	);

	return (
		<Card className="flex flex-col gap-2.5">
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">精度の測り方</h2>
				<Help label="精度の測り方">
					<p>
						ニュース画面の各記事の精度と、評価詳細のタブの「市場評価の分析」に使う。
					</p>
					<p>値動きを測る長さ: 採点した時刻から何時間後の値動きと比べるか。</p>
					<p>
						値動きの段階の境目:
						点数の段階と突き合わせる値動きの段階を分ける騰落率（%、上下とも同じ幅）。測る長さごとに決める。センチメントは横ばい（未満）・大きく動いた（以上）の2つ、リスクはやや荒れ・荒れた・かなり荒れ・大荒れ（それぞれ以上）の4つ。
					</p>
					<p>
						集計する期間:
						評価詳細のタブで、市場評価の時点から遡ってどこまでに採点した記事を数えるか。
					</p>
				</Help>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<span className="min-w-[120px]">値動きを測る長さ</span>
				<div className="w-44">
					<Segmented
						name="accuracy-setting-horizon"
						label="値動きを測る長さ"
						size="sm"
						options={(["4h", "24h"] as const).map(
							(h) => [h, HORIZON_LABELS[h]] as const,
						)}
						value={draft.horizon}
						onChange={(h: AccuracyHorizon) => edit({ horizon: h })}
					/>
				</div>
			</div>
			{bands("sentimentBands", "センチメントの境目", [
				["small", "横ばい（未満）"],
				["large", "大きく動いた（以上）"],
			])}
			{bands("riskBands", "リスクの境目", [
				["slight", "やや荒れ（以上）"],
				["rough", "荒れた（以上）"],
				["heavy", "かなり荒れ（以上）"],
				["wild", "大荒れ（以上）"],
			])}
			<div className="flex flex-wrap items-center gap-2">
				<span className="min-w-[120px]">集計する期間</span>
				<div className="w-60">
					<Segmented
						name="accuracy-setting-period"
						label="集計する期間"
						size="sm"
						options={PERIOD_OPTIONS}
						value={periodKey(draft.periodDays)}
						onChange={(k: PeriodKey) => edit({ periodDays: periodOf(k) })}
					/>
				</div>
			</div>
			<div className="flex justify-end">
				<Button size="sm" disabled={busy || !changed || invalid} onClick={save}>
					保存
				</Button>
			</div>
			{message && (
				<p
					role={message.ok ? "status" : "alert"}
					className={`text-xs font-semibold ${message.ok ? "" : "text-loss"}`}
				>
					{message.text}
				</p>
			)}
		</Card>
	);
}
