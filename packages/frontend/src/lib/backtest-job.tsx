// 実行中のバックテストを画面全体で追う。他の画面へ移っても進捗を問い合わせ続け、タブに印を出す。
// データセットでまとめて実行しているときは、含む実行ではなくまとめた実行を追う

import type { BacktestRun, DatasetRun } from "@trading-studio/backend";
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
	/** 実行中のバックテスト（単独） */
	running: BacktestRun | null;
	/** 実行中のまとめた実行 */
	runningDataset: DatasetRun | null;
	/** 直近に終わったバックテスト。見た側が clearFinished で消す */
	finished: BacktestRun | null;
	/** 直近に終わったまとめた実行。見た側が clearFinished で消す */
	finishedDataset: DatasetRun | null;
	track: (run: BacktestRun) => void;
	trackDataset: (run: DatasetRun) => void;
	clearFinished: () => void;
};

const JobContext = createContext<JobState | null>(null);

const POLL_MS = 700;

export function BacktestJobProvider({ children }: { children: ReactNode }) {
	const api = useApi();
	const [running, setRunning] = useState<BacktestRun | null>(null);
	const [runningDataset, setRunningDataset] = useState<DatasetRun | null>(null);
	const [finished, setFinished] = useState<BacktestRun | null>(null);
	const [finishedDataset, setFinishedDataset] = useState<DatasetRun | null>(
		null,
	);

	// 画面を開き直したときに、実行中のものがあれば追う
	useEffect(() => {
		Promise.all([
			api.api["dataset-runs"].current
				.$get()
				.then((r) => readJson<{ run: DatasetRun | null }>(r)),
			api.api.backtests.current
				.$get()
				.then((r) => readJson<{ run: BacktestRun | null }>(r)),
		])
			.then(([d, b]) => {
				if (d.run) setRunningDataset((cur) => cur ?? d.run);
				else if (b.run && b.run.datasetRunId === null) {
					setRunning((cur) => cur ?? b.run);
				}
			})
			.catch(() => {});
	}, [api]);

	const poll = useCallback(async () => {
		try {
			if (running) {
				const r = await api.api.backtests[":id"]
					.$get({ param: { id: String(running.id) } })
					.then((res) => readJson<{ run: BacktestRun }>(res));
				if (r.run.status === "running") {
					setRunning(r.run);
				} else {
					setRunning(null);
					setFinished(r.run);
				}
			}
			if (runningDataset) {
				const r = await api.api["dataset-runs"][":id"]
					.$get({ param: { id: String(runningDataset.id) } })
					.then((res) => readJson<{ run: DatasetRun }>(res));
				if (r.run.status === "running") {
					setRunningDataset(r.run);
				} else {
					setRunningDataset(null);
					setFinishedDataset(r.run);
				}
			}
		} catch {
			// 一時的に問い合わせられなくても、次の問い合わせで追いつく
		}
	}, [api, running, runningDataset]);
	useInterval(poll, POLL_MS, running !== null || runningDataset !== null);

	const track = useCallback((run: BacktestRun) => {
		setFinished(null);
		setFinishedDataset(null);
		setRunning(run);
	}, []);
	const trackDataset = useCallback((run: DatasetRun) => {
		setFinished(null);
		setFinishedDataset(null);
		setRunningDataset(run);
	}, []);
	const clearFinished = useCallback(() => {
		setFinished(null);
		setFinishedDataset(null);
	}, []);

	return (
		<JobContext.Provider
			value={{
				running,
				runningDataset,
				finished,
				finishedDataset,
				track,
				trackDataset,
				clearFinished,
			}}
		>
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
