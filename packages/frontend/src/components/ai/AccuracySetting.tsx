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
import { HORIZON_LABELS } from "./Precision";

/** 入力の範囲。backend の検査と合わせる */
const DAYS_MAX = 92;
const MIN_SAMPLES_MAX = 1000;

const errorsOf = (s: AccuracySettings) => ({
	days:
		Number.isInteger(s.days) && s.days >= 1 && s.days <= DAYS_MAX
			? undefined
			: `1〜${DAYS_MAX} の整数`,
	minSamples:
		Number.isInteger(s.minSamples) &&
		s.minSamples >= 1 &&
		s.minSamples <= MIN_SAMPLES_MAX
			? undefined
			: `1〜${MIN_SAMPLES_MAX} の整数`,
});

/** ニュース画面の精度分析で、精度を測る条件 */
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
	const invalid = errors.days !== undefined || errors.minSamples !== undefined;
	const changed =
		draft.days !== saved.days ||
		draft.horizon !== saved.horizon ||
		draft.minSamples !== saved.minSamples;
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
				text: "保存した。次に精度を開いたときから反映する",
			});
			reload();
		} catch (e) {
			setMessage({ ok: false, text: errorMessage(e) });
		} finally {
			setBusy(false);
		}
	};

	const number = (key: "days" | "minSamples", label: string, unit: string) => (
		<div className="flex flex-col gap-1">
			<div className="flex flex-wrap items-center gap-2">
				<label htmlFor={`accuracy-${key}`} className="min-w-[120px]">
					{label}
				</label>
				<NumberInput
					id={`accuracy-${key}`}
					inputMode="numeric"
					value={draft[key]}
					onChange={(v) => edit({ [key]: v })}
					invalid={errors[key] !== undefined}
					className="w-[76px]"
				/>
				<span>{unit}</span>
			</div>
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
					<p>ニュース画面の精度と精度分析に使う。</p>
					<p>
						集計する期間:
						直近の何日の記事を数えるか。記事の新しさの時刻（公開と取得の早いほう）で測る。
					</p>
					<p>
						値動きを測る長さ:
						採点した時刻から何時間後の値動きと比べるか。精度分析の「精度の内訳」で最初に出す長さにもなる。
					</p>
					<p>
						データ不足の件数:
						対象（センチメントは強気・弱気の材料、リスクは荒れた記事）がこれ未満なら、偶然と区別できないとして評価に「データ不足」を添える。
					</p>
				</Help>
			</div>
			{number("days", "集計する期間", "日")}
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
			{number("minSamples", "データ不足の件数", "件未満")}
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
