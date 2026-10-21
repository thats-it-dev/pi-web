// Image sniffing and size reading from header bytes. Browser-safe: no Buffer.
export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const ascii = (b: Uint8Array, at: number, s: string): boolean => {
	if (b.length < at + s.length) return false;
	for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
	return true;
};

export function sniffImageType(bytes: Uint8Array): ImageMime | null {
	if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, "PNG\r\n\x1a\n")) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return "image/gif";
	if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "image/webp";
	return null;
}

type Size = { width: number; height: number };

export function imageDimensions(bytes: Uint8Array, mime: ImageMime): Size | null {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const size = (width: number, height: number): Size | null => (width > 0 && height > 0 ? { width, height } : null);
	switch (mime) {
		case "image/png":
			return bytes.length >= 24 ? size(v.getUint32(16), v.getUint32(20)) : null;
		case "image/gif":
			return bytes.length >= 10 ? size(v.getUint16(6, true), v.getUint16(8, true)) : null;
		case "image/webp": {
			if (bytes.length < 20) return null;
			if (ascii(bytes, 12, "VP8X")) {
				if (bytes.length < 30) return null;
				const u24 = (at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
				return size(u24(24) + 1, u24(27) + 1);
			}
			if (ascii(bytes, 12, "VP8 ")) {
				if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
				return size(v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff);
			}
			if (ascii(bytes, 12, "VP8L")) {
				if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
				const bits = v.getUint32(21, true);
				return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
			}
			return null;
		}
		case "image/jpeg": {
			let i = 2;
			while (i + 4 <= bytes.length) {
				if (bytes[i] !== 0xff) return null;
				const marker = bytes[i + 1];
				if (marker === 0xff) { i++; continue; } // fill byte
				// SOF0-SOF15, except DHT (c4), JPG (c8) and DAC (cc)
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return i + 9 <= bytes.length ? size(v.getUint16(i + 7), v.getUint16(i + 5)) : null;
				}
				i += 2 + v.getUint16(i + 2);
			}
			return null;
		}
	}
}
