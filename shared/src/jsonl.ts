// Pi's JSONL protocols split records on LF only. JSON strings may contain
// U+2028/U+2029, which node:readline would treat as line breaks.
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
	let buf = "";
	return (chunk) => {
		buf += chunk;
		let nl = buf.indexOf("\n");
		while (nl !== -1) {
			const line = buf.slice(0, nl).replace(/\r$/, "");
			buf = buf.slice(nl + 1);
			if (line) onLine(line);
			nl = buf.indexOf("\n");
		}
	};
}
