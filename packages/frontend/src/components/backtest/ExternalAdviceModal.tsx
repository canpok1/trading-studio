import type { BacktestAdvice } from "@trading-studio/backend";
import { useEffect, useRef, useState } from "react";
import { useApi } from "../../api";
import { saveBlob } from "../../lib/download";
import { errorMessage, readJson } from "../../lib/useAsync";
import { Modal } from "../Modal";
import { Skeleton } from "../States";
import { Button } from "../ui";

/** 文をクリップボードへ入れる。http で開いていて Clipboard API が使えないときは古い方法で試す */
async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const el = document.createElement("textarea");
		el.value = text;
		el.setAttribute("readonly", "");
		el.style.position = "fixed";
		el.style.opacity = "0";
		document.body.appendChild(el);
		el.select();
		try {
			return document.execCommand("copy");
		} catch {
			return false;
		} finally {
			el.remove();
		}
	}
}

type Source = {
	prompt: string;
	file: { name: string; content: string };
	instructionsVersion: number;
};

/**
 * チャット型の AI（ChatGPT など）でアドバイスを作る。資料をファイルで添付し、指示をコピーして貼り、
 * 返ってきた答えを貼って取り込む。資料は文字数が多く入力欄に貼れないため、ファイルに分ける。
 * Gemini が混雑で使えないときの代わりと、別の AI と比べるのに使う
 */
export function ExternalAdviceModal({
	runId,
	onClose,
	onImported,
}: {
	runId: number;
	onClose: () => void;
	onImported: (advice: BacktestAdvice) => void;
}) {
	const api = useApi();
	const [source, setSource] = useState<Source | null | undefined>(undefined);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [copied, setCopied] = useState<boolean | null>(null);
	const [model, setModel] = useState("");
	const [answer, setAnswer] = useState("");
	const [busy, setBusy] = useState(false);
	const [importError, setImportError] = useState<string | null>(null);
	const manual = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		let alive = true;
		api.api.advice.runs[":id"]["external-prompt"]
			.$get({ param: { id: String(runId) } })
			.then((res) => readJson<Source>(res))
			.then((r) => alive && setSource(r))
			.catch((e) => {
				if (!alive) return;
				setSource(null);
				setLoadError(errorMessage(e));
			});
		return () => {
			alive = false;
		};
	}, [api, runId]);

	useEffect(() => {
		if (copied === false) manual.current?.select();
	}, [copied]);

	const download = () => {
		if (source) {
			saveBlob(
				new Blob([source.file.content], { type: "text/markdown" }),
				source.file.name,
			);
		}
	};

	const copy = async () => {
		if (source) setCopied(await copyText(source.prompt));
	};

	const submit = async () => {
		if (!source) return;
		setBusy(true);
		setImportError(null);
		try {
			const r = await api.api.advice.runs[":id"].import
				.$post({
					param: { id: String(runId) },
					json: {
						text: answer,
						model,
						instructionsVersion: source.instructionsVersion,
					},
				})
				.then((res) => readJson<{ advice: BacktestAdvice }>(res));
			onImported(r.advice);
		} catch (e) {
			setImportError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal title="別の AI で作る" onClose={onClose}>
			<p className="text-[13px] leading-relaxed text-text-2">
				ChatGPT などのチャット型の AI
				に、資料のファイルを添付して指示を貼って送り、返ってきた答えをそのまま下に貼る。取り込むと今のアドバイスを置き換える。
			</p>
			<div className="flex flex-col items-start gap-1.5">
				<span className="text-xs font-semibold">1. AI に渡すもの</span>
				{source === undefined && <Skeleton className="h-9 w-40" />}
				{loadError && (
					<p role="alert" className="text-xs font-semibold text-loss">
						用意できなかった: {loadError}
					</p>
				)}
				{source && (
					<>
						<div className="flex flex-wrap gap-2">
							<Button size="sm" onClick={download}>
								資料をダウンロード
							</Button>
							<Button size="sm" variant="primary" onClick={copy}>
								指示をコピー
							</Button>
						</div>
						<span className="num text-xs text-text-2">
							資料 {source.file.name}（
							{source.file.content.length.toLocaleString("ja-JP")} 文字）· 指示
							v{source.instructionsVersion}（
							{source.prompt.length.toLocaleString("ja-JP")} 文字）
							{copied && " · コピーした"}
						</span>
						{copied === false && (
							<>
								<span role="alert" className="text-xs text-loss">
									自動でコピーできなかった。下の指示を全選択してコピーする
								</span>
								<textarea
									ref={manual}
									aria-label="AI に渡す指示"
									readOnly
									rows={4}
									value={source.prompt}
									className="num w-full rounded-lg border border-line bg-surface p-2 text-xs"
								/>
							</>
						)}
					</>
				)}
			</div>
			<div className="flex flex-col gap-1.5">
				<label htmlFor="external-answer" className="text-xs font-semibold">
					2. 返ってきた答え
				</label>
				<textarea
					id="external-answer"
					rows={6}
					value={answer}
					onChange={(e) => {
						setAnswer(e.target.value);
						setImportError(null);
					}}
					placeholder='{"analysis": ...}'
					className="num w-full rounded-lg border-[1.5px] border-accent bg-surface p-3 text-[13px] leading-relaxed"
				/>
			</div>
			<div className="flex flex-col gap-1.5">
				<label htmlFor="external-model" className="text-xs font-semibold">
					使った AI の名前（任意）
				</label>
				<input
					id="external-model"
					value={model}
					maxLength={40}
					onChange={(e) => setModel(e.target.value)}
					placeholder="外部の AI"
					className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-[15px]"
				/>
			</div>
			{importError && (
				<p role="alert" className="text-xs font-semibold text-loss">
					取り込めなかった: {importError}
				</p>
			)}
			<div className="flex justify-end gap-2">
				<Button onClick={onClose}>閉じる</Button>
				<Button
					variant="primary"
					disabled={!source || !answer.trim() || busy}
					onClick={submit}
				>
					取り込む
				</Button>
			</div>
		</Modal>
	);
}
