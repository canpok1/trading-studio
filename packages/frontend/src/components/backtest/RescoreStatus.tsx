import type { RescoreCoverage } from "@trading-studio/backend";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../api";
import { formatInt } from "../../lib/number";
import { errorMessage, readJson } from "../../lib/useAsync";
import { Button, ProgressBar } from "../ui";

/** 採点し直しの進み具合を問い合わせる間隔。採点は1件5秒以上空けて進むので、それより細かく見ても変わらない */
const POLL_MS = 5_000;
/** 採点1件にかかる時間の目安 */
const PER_NEWS_MS = 5_000;

/** 版の採点が揃っていて実行できるか。失敗して止まった記事は除いて実行する */
export const rescoreReady = (c: RescoreCoverage) =>
	c.done + c.failed >= c.total;

/**
 * バックテストの期間の市場評価に使う記事に、指定した版の採点が揃っているか。
 * 揃っていなければ採点し直しのボタンを出し、採点し直している間は進み具合を出す
 */
export function RescoreStatus({
	from,
	to,
	version,
	onChange,
}: {
	from: number;
	to: number;
	version: number;
	/** 揃ったかどうかが分かるたびに呼ぶ。問い合わせ中・失敗は null */
	onChange: (coverage: RescoreCoverage | null) => void;
}) {
	const api = useApi();
	const [coverage, setCoverage] = useState<RescoreCoverage | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const show = useCallback(
		(c: RescoreCoverage | null) => {
			setCoverage(c);
			onChange(c);
		},
		[onChange],
	);

	const query = {
		from: String(from),
		to: String(to),
		version: String(version),
	};
	const key = `${from}:${to}:${version}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: 期間と版が変わったときだけ問い合わせ直す
	useEffect(() => {
		let alive = true;
		show(null);
		setError(null);
		const load = () =>
			api.api.scoring.rescore
				.$get({ query })
				.then((res) => readJson<{ coverage: RescoreCoverage }>(res))
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
			const res = await api.api.scoring.rescore.$post({
				json: { from, to, version },
			});
			show((await readJson<{ coverage: RescoreCoverage }>(res)).coverage);
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};

	if (error)
		return (
			<span role="alert" className="text-xs font-semibold text-loss">
				採点の版の状態を読めなかった（{error}）
			</span>
		);
	if (!coverage)
		return <span className="text-xs text-text-2">採点の版の状態を確認中…</span>;

	const c = coverage;
	const missing = c.total - c.done - c.pending - c.failed;
	const failedNote = c.failed > 0 && (
		<span className="flex flex-wrap items-center gap-x-2 text-xs text-text-2">
			<span className="num">
				{formatInt(c.failed)} 件は採点し直しに失敗したため除いて実行する
			</span>
			<Button variant="link" disabled={busy} onClick={request}>
				失敗した記事を採点し直す
			</Button>
		</span>
	);

	// 採点し直している間に期間を広げると、頼んでいない記事と待っている記事が両方ある
	const progress = c.pending > 0 && (
		<div role="status" className="flex flex-col gap-1.5 text-xs">
			<span className="num">
				v{version} で採点し直している: {formatInt(c.done)} /{" "}
				{formatInt(c.total)} 件（残り約{" "}
				{Math.max(1, Math.ceil((c.pending * PER_NEWS_MS) / 60_000))} 分）
			</span>
			<ProgressBar
				value={c.total === 0 ? 100 : (c.done / c.total) * 100}
				label={`v${version} で採点し直している進み具合`}
			/>
			{missing === 0 && (
				<span className="text-text-2">
					他の画面へ移っても採点は続く。そろうと実行できる。
				</span>
			)}
		</div>
	);
	if (missing > 0)
		return (
			<div className="flex flex-col gap-2">
				<div
					role="alert"
					className="flex flex-col gap-2 rounded-[10px] bg-warn px-3.5 py-3 text-xs"
				>
					<strong className="num text-[13px]">
						期間の市場評価に使う記事のうち {formatInt(missing)} 件に v{version}{" "}
						の採点が無い
					</strong>
					<span>
						全部を v{version} で採点すると実行できる（1件5秒ほど、約{" "}
						{Math.max(1, Math.ceil((missing * PER_NEWS_MS) / 60_000))} 分）。
					</span>
					<Button
						size="sm"
						className="self-start"
						disabled={busy}
						onClick={request}
					>
						v{version} で採点し直す
					</Button>
				</div>
				{progress}
				{failedNote}
			</div>
		);
	if (c.pending > 0)
		return (
			<div className="flex flex-col gap-1.5">
				{progress}
				{failedNote}
			</div>
		);
	return (
		<div className="flex flex-col gap-1 text-xs text-text-2">
			<span className="num">
				v{version} の採点: {formatInt(c.done)} / {formatInt(c.total)} 件
			</span>
			{failedNote}
		</div>
	);
}
