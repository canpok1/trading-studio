/** 応答の本文をファイルとして保存させる。ファイル名は content-disposition から取る */
export async function saveResponse(
	res: Pick<Response, "blob" | "headers">,
	fallback: string,
) {
	const blob = await res.blob();
	const name =
		/filename="([^"]+)"/.exec(
			res.headers.get("content-disposition") ?? "",
		)?.[1] ?? fallback;
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	// すぐ無効にすると、保存が始まる前に URL が消えるブラウザがある
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
