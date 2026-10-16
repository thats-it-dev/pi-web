import { HttpError } from "./errors.ts";

export interface Part {
	name: string;
	filename?: string;
	contentType?: string;
	data: Buffer;
}

function boundaryOf(contentType: string | undefined): string {
	const m = contentType?.match(/(?:^|;)\s*boundary\s*=\s*(?:"([^"]*)"|([^;\s]+))/i);
	const boundary = m?.[1] ?? m?.[2];
	if (!boundary) throw new HttpError(400, "Missing multipart boundary");
	return boundary;
}

function parseHeaders(block: string): Map<string, string> {
	const headers = new Map<string, string>();
	for (const line of block.split("\r\n")) {
		const i = line.indexOf(":");
		if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
	}
	return headers;
}

function param(value: string | undefined, key: string): string | undefined {
	const m = value?.match(new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i"));
	return m?.[1] ?? m?.[2];
}

export function parseMultipart(body: Buffer, contentType: string | undefined): Part[] {
	const boundary = boundaryOf(contentType);
	// Prefix CRLF so the first delimiter matches like every other one.
	const buf = Buffer.concat([Buffer.from("\r\n"), body]);
	const delim = Buffer.from(`\r\n--${boundary}`);
	const parts: Part[] = [];
	let pos = buf.indexOf(delim);
	if (pos < 0) throw new HttpError(400, "Malformed multipart body");
	for (;;) {
		pos += delim.length;
		if (buf.subarray(pos, pos + 2).toString("latin1") === "--") return parts;
		if (buf.subarray(pos, pos + 2).toString("latin1") !== "\r\n") throw new HttpError(400, "Malformed multipart body");
		pos += 2;
		const next = buf.indexOf(delim, pos);
		if (next < 0) throw new HttpError(400, "Missing closing multipart delimiter");
		const part = buf.subarray(pos, next);
		const end = part.indexOf("\r\n\r\n");
		// A part with no headers starts directly with the blank line.
		const headerEnd = part.subarray(0, 2).toString("latin1") === "\r\n" ? -2 : end;
		if (headerEnd === -1) throw new HttpError(400, "Malformed multipart part");
		const headers = parseHeaders(headerEnd === -2 ? "" : part.subarray(0, end).toString("utf8"));
		const data = Buffer.from(part.subarray(headerEnd === -2 ? 2 : end + 4));
		const disposition = headers.get("content-disposition");
		const name = param(disposition, "name");
		if (name === undefined) throw new HttpError(400, "Multipart part without a name");
		parts.push({ name, filename: param(disposition, "filename"), contentType: headers.get("content-type"), data });
		pos = next;
	}
}
