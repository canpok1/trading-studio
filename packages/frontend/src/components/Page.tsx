import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { BackIcon } from "./icons";

/** 1画面の枠。広い画面でも幅の上限を設けず、左右に余白を作らない */
export function Page({
	title,
	description,
	back,
	actions,
	children,
}: {
	title: string;
	description?: ReactNode;
	/** 戻る先。指定するとスマホで上部に戻るボタンを出す */
	back?: string;
	actions?: ReactNode;
	children?: ReactNode;
}) {
	const navigate = useNavigate();
	return (
		<>
			{back && (
				<div className="flex min-h-[52px] items-center gap-1 border-b border-line bg-surface px-2 lg:hidden">
					<button
						type="button"
						aria-label="戻る"
						onClick={() => navigate(back)}
						className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-surface-2"
					>
						<BackIcon />
					</button>
					<h1 className="flex-1 text-base font-bold">{title}</h1>
					{actions}
				</div>
			)}
			<div className="mx-auto flex max-w-[720px] flex-col gap-3.5 px-4 pt-4 pb-2 lg:max-w-none lg:px-6">
				<div className={back ? "hidden lg:flex" : "flex"}>
					<div className="flex flex-1 flex-col gap-1">
						<h1 className="text-[22px] font-bold">{title}</h1>
						{description && (
							<p className="text-xs text-text-2">{description}</p>
						)}
					</div>
					{actions && <div className="flex items-start gap-2">{actions}</div>}
				</div>
				{children}
			</div>
		</>
	);
}
