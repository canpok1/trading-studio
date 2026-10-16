import type { JudgmentCoverage } from "@trading-studio/backend";
import { useCallback, useEffect, useState } from "react";
import { Button, ProgressBar } from "../../../shared/components/ui";
import { useApi } from "../../../shared/lib/api";
import { formatInt } from "../../../shared/lib/number";
import { errorMessage, readJson } from "../../../shared/lib/useAsync";

/** 判断の進み具合を問い合わせる間隔。判断はニュースの採点と合わせて1件5秒以上空けて進む */
const POLL_MS = 5_000;
const PER_EVENT_MS = 5_000;

/** 版の判断がそろっていて実行できるか。失敗して止まった予定は除いて実行する */
export const judgmentsReady = (c: JudgmentCoverage) =>
	c.done + c.failed >= c.total;

/**
 * 予定の前後の条件で見る予定に、指定した版の重要度の判断がそろっているか。
 * そろっていなければ判断を頼むボタンを出し、判断している間は進み具合を出す
 */
export function EventJudgmentStatus({
	from,
	to,
	version,
	onChange,
}: {
	from: number;
	to: number;
	version: number;
	/** そろったかどうかが分かるたびに呼ぶ。問い合わせ中・失敗は null */
	onChange: (coverage: JudgmentCoverage | null) => void;
}) {
	const api = useApi();
	const [coverage, setCoverage] = useState<JudgmentCoverage | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const show = useCallback(
		(c: JudgmentCoverage | null) => {
			setCoverage(c);
			onChange(c);
		},
		[onChange],
	);
	const key = `${from}:${to}:${version}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: 期間と版が変わったときだけ問い合わせ直す
	useEffect(() => {
		let alive = true;
		show(null);
		setError(null);
		const load = () =>
			api.api.calendar.judgments
				.$get({
					query: {
						from: String(from),
						to: String(to),
						version: String(version),
					},
				})
				.then((res) => readJson<{ coverage: JudgmentCoverage }>(res))
				.then((r) => {
					if (!alive) return;
					show(r.coverage);
					setError(null);
				})
				.catch((e) => {
					if (alive) setError(errorMessage(e));
				});
		load();
		const timer = setInterval(load, POLL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [key]);

	const request = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await api.api.calendar.judgments.$post({
				json: { from, to, version },
			});
			show((await readJson<{ coverage: JudgmentCoverage }>(res)).coverage);
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};

	if (error)
		return (
			<span role="alert" className="text-xs font-semibold text-loss">
				予定の重要度の判断の状態を読めなかった（{error}）
			</span>
		);
	if (!coverage)
		return (
			<span className="text-xs text-text-2">予定の重要度の判断を確認中…</span>
		);

	const c = coverage;
	const left = c.total - c.done - c.failed;
	const minutes = Math.max(1, Math.ceil((left * PER_EVENT_MS) / 60_000));
	const failedNote = c.failed > 0 && (
		<span className="flex flex-wrap items-center gap-x-2 text-xs text-text-2">
			<span className="num">
				{formatInt(c.failed)} 件は判断に失敗したため除いて実行する
			</span>
			<Button variant="link" disabled={busy} onClick={request}>
				失敗した予定を判断し直す
			</Button>
		</span>
	);
	if (left > 0)
		return (
			<div className="flex flex-col gap-2">
				<div
					role="alert"
					className="flex flex-col gap-2 rounded-[10px] bg-warn px-3.5 py-3 text-xs"
				>
					<strong className="num text-[13px]">
						予定の前後の条件で見る予定のうち {formatInt(left)} 件に v{version}{" "}
						の重要度の判断が無い
					</strong>
					<span>
						判断がそろうと実行できる（1件5秒ほど、約 {minutes} 分）。
						{c.pending > 0
							? "他の画面へ移っても判断は続く。"
							: "先に判断するよう頼むと早く終わる。"}
					</span>
					{c.pending < left && (
						<Button
							size="sm"
							className="self-start"
							disabled={busy}
							onClick={request}
						>
							v{version} で先に判断する
						</Button>
					)}
					{c.pending > 0 && (
						<ProgressBar
							value={c.total === 0 ? 100 : (c.done / c.total) * 100}
							label={`v${version} で予定の重要度を判断している進み具合`}
						/>
					)}
				</div>
				{failedNote}
			</div>
		);
	return (
		<div className="flex flex-col gap-1 text-xs text-text-2">
			<span className="num">
				v{version} の重要度の判断: {formatInt(c.done)} / {formatInt(c.total)} 件
			</span>
			{failedNote}
		</div>
	);
}
