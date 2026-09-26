import type { ReactNode } from "react";

/** 1画面の枠。広い画面でも幅の上限を設けず、左右に余白を作らない */
export function Page({
	title,
	description,
	actions,
	children,
}: {
	title: string;
	description?: ReactNode;
	actions?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="mx-auto flex max-w-[720px] flex-col gap-3.5 px-4 pt-4 pb-2 lg:max-w-none lg:px-6">
			<div className="flex">
				<div className="flex flex-1 flex-col gap-1">
					<h1 className="text-[22px] font-bold">{title}</h1>
					{description && <p className="text-xs text-text-2">{description}</p>}
				</div>
				{actions && <div className="flex items-start gap-2">{actions}</div>}
			</div>
			{children}
		</div>
	);
}
