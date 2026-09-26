// 実行中のバックテストを画面全体で追う。他の画面へ移っても進捗を問い合わせ続け、タブに印を出す

import type { BacktestRun } from "@trading-studio/backend";
import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { useApi } from "../api";
import { readJson, useInterval } from "./useAsync";

type JobState = {
	/** 実行中のバックテスト */
	running: BacktestRun | null;
	/** 直近に終わったバックテスト。見た側が clearFinished で消す */
	finished: BacktestRun | null;
	track: (run: BacktestRun) => void;
	clearFinished: () => void;
};

const JobContext = createContext<JobState | null>(null);

const POLL_MS = 700;

export function BacktestJobProvider({ children }: { children: ReactNode }) {
	const api = useApi();
	const [running, setRunning] = useState<BacktestRun | null>(null);
	const [finished, setFinished] = useState<BacktestRun | null>(null);

	// 画面を開き直したときに、実行中のものがあれば追う
	useEffect(() => {
		api.api.backtests.current
			.$get()
			.then((r) => readJson<{ run: BacktestRun | null }>(r))
			.then((r) => setRunning((cur) => cur ?? r.run ?? null))
			.catch(() => {});
	}, [api]);

	const poll = useCallback(async () => {
		if (!running) return;
		try {
			const r = await api.api.backtests[":id"]
				.$get({ param: { id: String(running.id) } })
				.then((res) => readJson<{ run: BacktestRun }>(res));
			if (r.run.status === "running") {
				setRunning(r.run);
			} else {
				setRunning(null);
				setFinished(r.run);
			}
		} catch {
			// 一時的に問い合わせられなくても、次の問い合わせで追いつく
		}
	}, [api, running]);
	useInterval(poll, POLL_MS, running !== null);

	const track = useCallback((run: BacktestRun) => {
		setFinished(null);
		setRunning(run);
	}, []);
	const clearFinished = useCallback(() => setFinished(null), []);

	return (
		<JobContext.Provider value={{ running, finished, track, clearFinished }}>
			{children}
		</JobContext.Provider>
	);
}

export function useBacktestJob(): JobState {
	const v = useContext(JobContext);
	if (!v)
		throw new Error("BacktestJobProvider の外で useBacktestJob を使っている");
	return v;
}
