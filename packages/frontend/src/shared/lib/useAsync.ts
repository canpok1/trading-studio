import { useCallback, useEffect, useRef, useState } from "react";

export type AsyncState<T> =
	| { kind: "loading" }
	| { kind: "ok"; data: T }
	| { kind: "error"; message: string };

export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** 非同期の読み込み。load は useCallback で固定して渡す。reload で読み直す（読み直しの間は前の値を出したまま） */
export function useAsync<T>(load: () => Promise<T>) {
	const [state, setState] = useState<AsyncState<T>>({ kind: "loading" });
	const seq = useRef(0);
	const reload = useCallback(async () => {
		const my = ++seq.current;
		try {
			const data = await load();
			if (my === seq.current) setState({ kind: "ok", data });
		} catch (e) {
			if (my === seq.current)
				setState({ kind: "error", message: errorMessage(e) });
		}
	}, [load]);
	useEffect(() => {
		setState({ kind: "loading" });
		reload();
		return () => {
			seq.current++;
		};
	}, [reload]);
	return { state, reload };
}

/** fn を interval ミリ秒ごとに呼ぶ。active が false の間は止める */
export function useInterval(fn: () => void, interval: number, active: boolean) {
	const ref = useRef(fn);
	ref.current = fn;
	useEffect(() => {
		if (!active) return;
		const id = setInterval(() => ref.current(), interval);
		return () => clearInterval(id);
	}, [interval, active]);
}

/** API の応答を JSON で読む。ok でなければ本文の message を例外にする */
export async function readJson<T>(res: {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}): Promise<T> {
	const body = (await res.json().catch(() => null)) as {
		message?: string;
	} | null;
	if (!res.ok) {
		throw new Error(
			body?.message ?? `サーバーがエラーを返した（HTTP ${res.status}）`,
		);
	}
	return body as T;
}

/** 画面が見えているか。見えていない間は問い合わせを止める */
export function usePageVisible(): boolean {
	const [visible, setVisible] = useState(
		() => document.visibilityState !== "hidden",
	);
	useEffect(() => {
		const on = () => setVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", on);
		return () => document.removeEventListener("visibilitychange", on);
	}, []);
	return visible;
}
