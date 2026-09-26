// データなし・読み込み中・エラーの共通部品

import type { ReactNode } from "react";
import { EmptyIcon, ErrorIcon } from "./icons";

export function EmptyState({
	title,
	description,
	action,
}: {
	title: string;
	description?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center gap-2.5 px-5 py-8 text-center">
			<span className="text-text-2">
				<EmptyIcon />
			</span>
			<p className="text-[15px] font-bold">{title}</p>
			{description && <p className="text-[13px] text-text-2">{description}</p>}
			{action}
		</div>
	);
}

/** エラーは「何が起きたか」と「次に何をすればいいか」を並べる */
export function ErrorState({
	what,
	next,
	action,
}: {
	what: ReactNode;
	next: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div
			role="alert"
			className="flex flex-col items-center gap-2.5 px-5 py-8 text-center"
		>
			<span className="text-loss">
				<ErrorIcon />
			</span>
			<p className="text-[15px] font-bold">{what}</p>
			<p className="text-[13px] text-text-2">{next}</p>
			{action}
		</div>
	);
}

/** 読み込み中の骨組み。表示する内容と同じ形を灰色で出す */
export function Skeleton({ className = "" }: { className?: string }) {
	return (
		<div
			aria-hidden="true"
			className={`animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none ${className}`}
		/>
	);
}

export function LoadingCard({ lines = 3 }: { lines?: number }) {
	return (
		<div
			role="status"
			aria-label="読み込み中"
			className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-4"
		>
			<Skeleton className="h-5 w-1/3" />
			{Array.from({ length: lines }, (_, i) => (
				// 骨組みは並びが変わらないので番号で識別してよい
				// biome-ignore lint/suspicious/noArrayIndexKey: 同上
				<Skeleton key={i} className="h-4 w-full" />
			))}
		</div>
	);
}
