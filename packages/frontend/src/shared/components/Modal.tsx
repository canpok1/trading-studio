import type { ReactNode } from "react";
import { useEffect, useId } from "react";

/** 画面中央に出す確認・入力の枠。背景を押すか Esc で閉じる */
export function Modal({
	title,
	onClose,
	children,
}: {
	title: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const titleId = useId();
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<>
			<div
				aria-hidden="true"
				className="fixed inset-0 z-70 bg-scrim"
				onClick={onClose}
			/>
			<section
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				className="fixed top-1/2 left-1/2 z-80 flex max-h-[85vh] w-[calc(100%-32px)] max-w-[480px] -translate-x-1/2 -translate-y-1/2 flex-col gap-3.5 overflow-auto rounded-2xl bg-surface px-4 py-5 shadow-2xl"
			>
				<h2 id={titleId} className="text-lg font-bold">
					{title}
				</h2>
				{children}
			</section>
		</>
	);
}
