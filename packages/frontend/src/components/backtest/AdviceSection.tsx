import type {
	AdviceContent,
	BacktestAdvice,
	ImprovedStrategy,
} from "@trading-studio/backend";
import type { ConditionSet } from "@trading-studio/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useApi } from "../../api";
import { formatDateTime, formatVersion } from "../../format";
import {
	errorMessage,
	readJson,
	useInterval,
	usePageVisible,
} from "../../lib/useAsync";
import { Help } from "../Help";
import { Skeleton } from "../States";
import { Button } from "../ui";
import { ExternalAdviceModal } from "./ExternalAdviceModal";

/** 生成中に状態を問い合わせる間隔 */
const POLL_MS = 3_000;

const HEADINGS: [Exclude<keyof AdviceContent, "improved">, string][] = [
	["analysis", "結果の分析"],
	["good", "うまくいった点"],
	["bad", "悪かった点"],
	["improvements", "改善案"],
];

/**
 * バックテスト結果の AI アドバイス。ボタンで生成を始め、結果は実行ごとに最新の1件を残す。
 * 改善案を反映した戦略があれば、onImprove でそれを使ってバックテストし直せる
 */
export function AdviceSection({
	runId,
	onImprove,
}: {
	runId: number;
	onImprove: (params: ConditionSet) => void;
}) {
	const api = useApi();
	const visible = usePageVisible();
	const [advice, setAdvice] = useState<BacktestAdvice | null | undefined>(
		undefined,
	);
	const [error, setError] = useState<string | null>(null);
	const [startError, setStartError] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);
	const [external, setExternal] = useState(false);
	// 生成を始めた直後と定期の問い合わせが重なると応答の順が入れ替わりうるので、最後に出したものだけ使う
	const seq = useRef(0);

	const load = useCallback(async () => {
		const id = ++seq.current;
		try {
			const r = await api.api.advice.runs[":id"]
				.$get({ param: { id: String(runId) } })
				.then((res) => readJson<{ advice: BacktestAdvice | null }>(res));
			if (id !== seq.current) return;
			setAdvice(r.advice);
			setError(null);
		} catch (e) {
			if (id === seq.current) setError(errorMessage(e));
		}
	}, [api, runId]);
	useEffect(() => {
		load();
	}, [load]);
	const running = advice?.status === "running";
	useInterval(load, POLL_MS, running && visible);

	const start = async () => {
		setStarting(true);
		setStartError(null);
		seq.current++;
		try {
			const r = await api.api.advice.runs[":id"]
				.$post({ param: { id: String(runId) } })
				.then((res) => readJson<{ advice: BacktestAdvice }>(res));
			setAdvice(r.advice);
		} catch (e) {
			setStartError(errorMessage(e));
		} finally {
			setStarting(false);
		}
	};

	const content = advice?.content ?? null;
	return (
		<section
			aria-label="AI アドバイス"
			className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-4 py-3.5"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-1.5">
					<h2 className="text-[15px] font-bold whitespace-nowrap">
						AI アドバイス
					</h2>
					<Help label="AI アドバイス">
						<p>
							結果の分析と改善案を AI
							が作る。使うモデルと指示は設定の「バックテスト」で変える。
						</p>
						<p>
							「別の AI で作る」は、ChatGPT などのチャット型の AI
							に渡す文をコピーし、返ってきた答えを貼って取り込む。Gemini
							が混雑して作れないときや、別の AI と比べたいときに使う。
						</p>
					</Help>
				</div>
				{advice !== undefined && (
					<div className="ml-auto flex gap-2">
						<Button
							size="sm"
							disabled={running}
							onClick={() => setExternal(true)}
						>
							別の AI で作る
						</Button>
						<Button
							size="sm"
							variant={content ? "default" : "primary"}
							disabled={starting || running}
							onClick={start}
						>
							{running ? "作成中" : content ? "作り直す" : "アドバイスを作る"}
						</Button>
					</div>
				)}
			</div>
			{advice === undefined && !error && <Skeleton className="h-10 w-full" />}
			{error && (
				<p role="alert" className="text-xs font-semibold text-loss">
					読み込めなかった（{error}）
				</p>
			)}
			{startError && (
				<p role="alert" className="text-xs font-semibold text-loss">
					作れなかった: {startError}
					{startError.includes("API キー") && (
						<>
							{" "}
							<Link to="/settings" className="text-accent">
								設定を開く
							</Link>
						</>
					)}
				</p>
			)}
			{advice?.status === "failed" && (
				<p role="alert" className="text-xs font-semibold text-loss">
					作れなかった: {advice.error ?? "原因不明"}
					{content && "。下は前に作ったアドバイス"}
				</p>
			)}
			{running && (
				<div role="status" aria-label="作成中" className="flex flex-col gap-2">
					<span className="text-xs text-text-2">
						AI が作成中。画面を離れても作成は続く
						{content && "。終わると下のアドバイスを置き換える"}
					</span>
					<Skeleton className="h-4 w-2/3" />
					<Skeleton className="h-4 w-full" />
				</div>
			)}
			{content && advice && (
				<div data-testid="advice-content" className="flex flex-col gap-3">
					{HEADINGS.map(([key, label]) => (
						<div key={key} className="flex flex-col gap-1">
							<h3 className="text-[13px] font-bold">{label}</h3>
							<p className="text-[13px] leading-relaxed whitespace-pre-wrap">
								{content[key]}
							</p>
						</div>
					))}
					<ImproveButton
						improved={content.improved}
						disabled={running}
						onImprove={onImprove}
					/>
					<span className="num text-xs text-text-2">
						作成 {formatDateTime(advice.finishedAt ?? 0)} · {advice.model} ·
						指示 v{advice.instructionsVersion} ·{" "}
						{formatVersion(advice.appBuiltAt, "開発版")}
					</span>
				</div>
			)}
			{external && (
				<ExternalAdviceModal
					runId={runId}
					onClose={() => setExternal(false)}
					onImported={(a) => {
						seq.current++;
						setAdvice(a);
						setStartError(null);
						setExternal(false);
					}}
				/>
			)}
		</section>
	);
}

/** 改善案を反映した戦略でバックテストし直すボタン。使えなければ押せなくして理由を出す */
function ImproveButton({
	improved,
	disabled,
	onImprove,
}: {
	improved: ImprovedStrategy | undefined;
	disabled: boolean;
	onImprove: (params: ConditionSet) => void;
}) {
	const reason = !improved
		? "改善版の戦略を持たないアドバイス。作り直すと使える"
		: improved.ok
			? null
			: improved.reason;
	return (
		<div className="flex flex-col items-start gap-1">
			<Button
				size="sm"
				variant="primary"
				disabled={disabled || !improved?.ok}
				onClick={() => improved?.ok && onImprove(improved.params)}
			>
				改善版でバックテストする
			</Button>
			{reason && <span className="text-xs text-text-2">{reason}</span>}
		</div>
	);
}
