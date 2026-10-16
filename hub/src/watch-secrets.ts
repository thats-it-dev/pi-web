// Secrets for the watch API: the bearer token the Pebble app presents, and the
// secret the Index 01 ring uses. Made once, kept in <dataDir>/watch.json.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./push.ts";

export interface WatchSecrets {
	token: string;
	indexSecret: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function loadWatchSecrets(dataDir: string, log: (m: string) => void = () => {}): WatchSecrets {
	const file = join(dataDir, "watch.json");
	if (existsSync(file)) {
		try {
			const s = JSON.parse(readFileSync(file, "utf8")) as Partial<WatchSecrets>;
			if (typeof s?.token === "string" && HEX64.test(s.token) && typeof s.indexSecret === "string" && HEX64.test(s.indexSecret)) {
				return { token: s.token, indexSecret: s.indexSecret };
			}
		} catch {}
		log(`watch: ${file} was unreadable; made new secrets, so the watch and ring must be set up again`);
	}
	const secrets = { token: randomBytes(32).toString("hex"), indexSecret: randomBytes(32).toString("hex") };
	writeAtomic(file, `${JSON.stringify(secrets, null, 2)}\n`);
	return secrets;
}

export function bearerMatches(authorization: string | undefined, token: string): boolean {
	if (!authorization || !/^bearer /i.test(authorization)) return false;
	const given = Buffer.from(authorization.slice(7));
	const want = Buffer.from(token);
	return given.length === want.length && timingSafeEqual(given, want);
}
