// Files attached in the composer: caps, and which ones go to pi as images.
import type { FileInput, ImageInput } from "../../../shared/src/protocol.ts";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 40 * 1024 * 1024;
export const FILE_TOO_BIG = "Files up to 20 MB can be attached.";
export const MESSAGE_TOO_BIG = "Up to 40 MB of files per message.";

// One picked thing. Images stay images until send time, when the model decides (routeAttachments).
export type Attachment = { kind: "image"; name: string; size: number; image: ImageInput } | { kind: "file"; file: FileInput };

export function attachmentBytes(list: Attachment[]): number {
	return list.reduce((n, a) => n + (a.kind === "image" ? a.size : a.file.size), 0);
}

// Drops over-cap files; the error is the first toast to show, if any.
export function acceptFiles<T extends { name: string; type: string; size: number }>(files: T[], already: number): { ok: T[]; error: string | null } {
	const ok: T[] = [];
	let error: string | null = null;
	let total = already;
	for (const f of files) {
		if (f.size > MAX_FILE_BYTES) {
			error ??= FILE_TOO_BIG;
			continue;
		}
		if (total + f.size > MAX_MESSAGE_BYTES) {
			error ??= MESSAGE_TOO_BIG;
			continue;
		}
		total += f.size;
		ok.push(f);
	}
	return { ok, error };
}

// An image goes to pi as an image only when the model can see it; otherwise it is a file like any other.
export function routeAttachments(list: Attachment[], canImages: boolean): { images: ImageInput[]; files: FileInput[] } {
	const images: ImageInput[] = [];
	const files: FileInput[] = [];
	for (const a of list) {
		if (a.kind === "file") files.push(a.file);
		else if (canImages) images.push(a.image);
		else files.push({ name: a.name, mimeType: a.image.mimeType, size: a.size, data: a.image.data });
	}
	return { images, files };
}

export function readAsBase64(f: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
		r.onerror = () => reject(r.error);
		r.readAsDataURL(f);
	});
}
