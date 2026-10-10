import type {
	RetentionSettings,
	RetentionStatus,
} from "@trading-studio/backend";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../api";
import { formatDateTime } from "../format";
import { errorMessage, readJson, useAsync } from "../lib/useAsync";
import { Help } from "./Help";
import { Button, Card } from "./ui";

/** 保持期間の選択肢。null は削除しない */
const DAY_OPTIONS: (number | null)[] = [30, 90, 180, 365, 730, null];
const YEAR_OPTIONS: (number | null)[] = [1, 2, 3, 5, 10, null];

function formatBytes(n: number): string {
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const ITEMS: {
	key: keyof RetentionSettings;
	label: string;
	note: string;
	options: (number | null)[];
	unit: string;
}[] = [
	{
		key: "decisionsDays",
		label: "判断の記録",
		note: "自動取引の判断ごとの記録。注文を出した判断は期間を過ぎても残す",
		options: DAY_OPTIONS,
		unit: "日",
	},
	{
		key: "backtestsDays",
		label: "バックテストの実行",
		note: "実行を始めた日で数え、結果・アドバイスごと削除する",
		options: DAY_OPTIONS,
		unit: "日",
	},
	{
		key: "marketDataYears",
		label: "足・ニュース・採点",
		note: "1分・5分・15分足と、公開から期間を過ぎたニュースとその採点を削除する。1時間足より粗い足は残す。期間を過ぎた相場データは相場ごとに最新の1件だけ残し、その期間の足とニュース（開始の1か月前から）も残す。消した期間は市場評価の記録が無いものとして扱う",
		options: YEAR_OPTIONS,
		unit: "年",
	},
];

const periodLabel = (d: number | null, unit: string) =>
	d === null ? "無期限" : `${d}${unit}`;

/** 古いデータの保持期間。判断の記録（取引）とバックテストにまたがるので、設定画面の「全般」に置く */
export function RetentionSetting() {
	const api = useApi();
	const load = useCallback(
		() => api.api.retention.$get().then((r) => readJson<RetentionStatus>(r)),
		[api],
	);
	const { state, reload } = useAsync(load);
	const [value, setValue] = useState<RetentionSettings | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
		null,
	);
	const current = state.kind === "ok" ? state.data.settings : null;
	useEffect(() => {
		if (current) setValue(current);
	}, [current]);
	const changed =
		value !== null &&
		current !== null &&
		ITEMS.some(({ key }) => value[key] !== current[key]);

	const save = async () => {
		if (value === null) return;
		setBusy(true);
		setMessage(null);
		try {
			await api.api.retention.$put({ json: value }).then((r) => readJson(r));
			setMessage({ ok: true, text: "保存した。次の削除から反映する" });
			reload();
		} catch (e) {
			setMessage({ ok: false, text: errorMessage(e) });
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card className="flex flex-col gap-2.5">
			<div className="flex items-center gap-1.5">
				<h2 className="text-[15px] font-bold">データの保持</h2>
				<Help label="データの保持">
					{ITEMS.map(({ key, label, note }) => (
						<p key={key}>
							{label}: {note}。
						</p>
					))}
				</Help>
			</div>
			{state.kind === "error" ? (
				<p role="alert" className="text-xs font-semibold text-loss">
					読み込めなかった: {state.message}
				</p>
			) : (
				<>
					{ITEMS.map(({ key, label, options, unit }) => (
						<div key={key} className="flex flex-col gap-1">
							<div className="flex items-center justify-between gap-2">
								<label htmlFor={`retention-${key}`} className="text-[13px]">
									{label}
								</label>
								<select
									id={`retention-${key}`}
									value={value ? String(value[key]) : ""}
									disabled={value === null}
									onChange={(e) => {
										const d =
											e.target.value === "null" ? null : Number(e.target.value);
										setValue((v) => (v ? { ...v, [key]: d } : v));
										setMessage(null);
									}}
									className="h-11 w-32 rounded-lg border border-line bg-surface px-3 text-[15px]"
								>
									{/* 選択肢に無い日数（API で入れたもの）もそのまま見せる */}
									{[
										...options,
										...(value && !options.includes(value[key])
											? [value[key]]
											: []),
									].map((d) => (
										<option key={String(d)} value={String(d)}>
											{periodLabel(d, unit)}
										</option>
									))}
								</select>
							</div>
						</div>
					))}
					<div className="flex justify-end">
						<Button size="sm" disabled={busy || !changed} onClick={save}>
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
					{state.kind === "ok" && <RetentionInfo status={state.data} />}
				</>
			)}
		</Card>
	);
}

function RetentionInfo({ status }: { status: RetentionStatus }) {
	const last = status.lastRun;
	return (
		<div className="flex flex-col gap-1.5 border-t border-line pt-2.5 text-xs text-text-2">
			<p>
				毎日 4:00 に期間を過ぎたものを削除する。次回:{" "}
				{formatDateTime(status.nextRunAt)}
			</p>
			<p>
				前回:{" "}
				{last === null
					? "まだ削除していない"
					: last.error !== null
						? `${formatDateTime(last.at)} 失敗（${last.error}）`
						: `${formatDateTime(last.at)} 判断の記録 ${last.decisions.toLocaleString()} 件・バックテスト ${last.backtests.toLocaleString()} 件${last.candles === undefined ? "" : `・足 ${last.candles.toLocaleString()} 本・ニュース ${(last.news ?? 0).toLocaleString()} 件・相場データ ${(last.segments ?? 0).toLocaleString()} 件`}`}
			</p>
			<p>
				DB の大きさ: {formatBytes(status.dbBytes)}（うち削除で空いた{" "}
				{formatBytes(status.freeBytes)} は次の書き込みで再利用する）
			</p>
			<table className="w-full">
				<caption className="sr-only">テーブルごとの行数</caption>
				<tbody>
					{status.tables.map((t) => (
						<tr key={t.name}>
							<th scope="row" className="py-0.5 text-left font-normal">
								{t.label}
							</th>
							<td className="py-0.5 text-right tabular-nums">
								{t.rows.toLocaleString()} 行
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
