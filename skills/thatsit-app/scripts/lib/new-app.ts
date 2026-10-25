import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkName, dnsRecords, getPage, repoExists, ORG, ZONE, NAME_RE } from "./names.ts";
import { fail, must, type Run } from "./run.ts";

export type NewAppOpts = { name: string; title: string; description: string; color: string; resume: boolean; appsDir: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The machine may have no global git identity; commits use one from the gh account, set clone-locally.
export async function ghIdentity(run: Run): Promise<{ gitName: string; gitEmail: string }> {
	const idArgs = ["api", "user", "--jq", "{id,login,name}"];
	const idr = await run("gh", idArgs);
	if (idr.code !== 0) throw new Error(`could not read the GitHub account identity (needed for git commits): ${fail("gh", idArgs, idr).message}`);
	let who: { id: number; login: string; name?: string | null };
	try {
		who = JSON.parse(idr.stdout);
	} catch {
		throw new Error(`could not read the GitHub account identity: unexpected output from gh api user: ${idr.stdout.slice(0, 200)}`);
	}
	if (!who.login || !who.id) throw new Error("could not read the GitHub account identity: gh api user returned no id/login");
	const gitName = who.name || who.login;
	const gitEmail = `${who.id}+${who.login}@users.noreply.github.com`;
	return { gitName, gitEmail };
}

export async function setIdentity(dir: string, id: { gitName: string; gitEmail: string }, run: Run): Promise<void> {
	await must(run, "git", ["config", "user.name", id.gitName], { cwd: dir });
	await must(run, "git", ["config", "user.email", id.gitEmail], { cwd: dir });
}

export async function newApp(o: NewAppOpts, run: Run): Promise<{ dir: string; pagesSubdomain: string }> {
	const { name } = o;
	const fqdn = `${name}.${ZONE}`;
	if (!/^#[0-9A-Fa-f]{6}$/.test(o.color)) throw new Error(`color must look like #RRGGBB, got "${o.color}"`);
	if (!NAME_RE.test(name)) throw new Error(`invalid name "${name}"`);

	// Resolve the identity before creating anything.
	const id = await ghIdentity(run);

	// 1. name check (a resume expects its own half-made resources to exist)
	if (o.resume) {
		if (!(await repoExists(name, run))) throw new Error(`nothing to resume: ${ORG}/${name} doesn't exist — run new without --resume`);
	} else {
		const c = await checkName(name, run);
		if (!c.ok) throw new Error(c.reason);
		// Fail before any create call, not after the repo exists.
		if (existsSync(join(o.appsDir, name))) throw new Error(`${join(o.appsDir, name)} already exists`);
	}

	// 2. repo from template
	if (!(o.resume && (await repoExists(name, run)))) {
		await must(run, "gh", ["repo", "create", `${ORG}/${name}`, "--public", "--template", `${ORG}/app-template`]);
	}

	// 3. clone
	mkdirSync(o.appsDir, { recursive: true });
	const dir = join(o.appsDir, name);
	if (existsSync(dir)) {
		const r = await run("git", ["remote", "get-url", "origin"], { cwd: dir });
		if (r.code !== 0 || !r.stdout.trim().replace(/\.git$/, "").endsWith(`${ORG}/${name}`)) {
			throw new Error(`${dir} exists but is not a clone of ${ORG}/${name}`);
		}
	} else {
		// A template-generated repo can take a moment to become cloneable.
		for (let i = 1; ; i++) {
			const args = ["repo", "clone", `${ORG}/${name}`, dir];
			const r = await run("gh", args);
			if (r.code === 0) break;
			if (i >= 5) throw fail("gh", args, r);
			await sleep(2000);
		}
	}

	await setIdentity(dir, id, run);

	// 4. configure
	if (!(o.resume && (await configured(dir, name, run)))) {
		const cfg = { name, title: o.title, description: o.description, color: o.color };
		writeFileSync(join(dir, "app.config.json"), `${JSON.stringify(cfg, null, "\t")}\n`);
		await must(run, "npm", ["ci"], { cwd: dir });
		await must(run, "npm", ["run", "icons"], { cwd: dir });
		await must(run, "git", ["add", "-A"], { cwd: dir });
		await must(run, "git", ["commit", "-m", `Configure ${name}`], { cwd: dir });
	}

	// 5. Pages project; the real subdomain may carry a suffix, so always read it back
	const existing = o.resume ? await getPage(name, run) : undefined;
	let pagesSubdomain: string;
	if (existing) pagesSubdomain = existing.subdomain;
	else {
		const out = await must(run, "cf", ["pages", "create", "--name", name, "--production-branch", "main"]);
		pagesSubdomain = JSON.parse(out).subdomain;
		if (typeof pagesSubdomain !== "string" || !pagesSubdomain) throw new Error("cf pages create returned no subdomain");
	}

	// 6. custom domain
	const attached = o.resume && (await run("cf", ["pages", "domains", "get", fqdn, "--project-name", name])).code === 0;
	if (!attached) await must(run, "cf", ["pages", "domains", "create", name, "--name", fqdn]);

	// 7. proxied CNAME
	const recs = o.resume ? await dnsRecords(name, run) : [];
	const rec = recs.find((r) => r.name === fqdn);
	if (rec) {
		if (rec.type !== "CNAME" || rec.content !== pagesSubdomain) {
			throw new Error(`DNS record ${fqdn} already exists as ${rec.type} -> ${rec.content}, expected CNAME -> ${pagesSubdomain}; not overwriting`);
		}
	} else {
		const body = JSON.stringify({ type: "CNAME", name, content: pagesSubdomain, proxied: true });
		await must(run, "cf", ["dns", "records", "create", "-z", ZONE, "--body", body]);
	}

	return { dir, pagesSubdomain };
}

async function configured(dir: string, name: string, run: Run): Promise<boolean> {
	try {
		if (JSON.parse(readFileSync(join(dir, "app.config.json"), "utf8")).name !== name) return false;
	} catch {
		return false;
	}
	const r = await run("git", ["log", "--format=%s", "--fixed-strings", `--grep=Configure ${name}`], { cwd: dir });
	return r.code === 0 && r.stdout.split("\n").includes(`Configure ${name}`);
}
