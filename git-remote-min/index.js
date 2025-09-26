#!/usr/bin/env node
// git-remote-min — delta prototype (raw-thin only, no server-side validation)
// Node >= 18

import { createInterface } from "node:readline";
import { stdin, stdout, stderr } from "node:process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GIT_DIR = process.env.GIT_DIR || ".git";
const DEBUG = !!process.env.DEBUG;
const log = (...a) => { if (DEBUG) stderr.write(a.join(" ") + "\n"); };
const out = (line = "") => { stdout.write(line + "\n"); };

// ---- parse min://host[:port]/repo ----
const REMOTE_URL = process.argv[3];
if (!REMOTE_URL) {
    stderr.write("Usage: git-remote-min <name> <url>\n");
    process.exit(1);
}
function parseUrl(u) {
    if (!u.startsWith("min://")) throw new Error("Only min:// supported");
    const url = new URL(u.replace("min://", "http://"));
    return { base: `${url.protocol}//${url.host}`, repo: url.pathname.replace(/^\/+/, "") };
}
const { base, repo } = parseUrl(REMOTE_URL);
log("MIN base:", base, "repo:", repo);

// ---- HTTP helper ----
async function http(method, path, { body = null, responseType = "json", contentType } = {}) {
    const headers = {};
    if (body != null) {
        if (contentType) headers["Content-Type"] = contentType;
        else if (body instanceof Uint8Array || Buffer.isBuffer(body)) headers["Content-Type"] = "application/octet-stream";
        else { headers["Content-Type"] = "application/json"; if (typeof body !== "string") body = JSON.stringify(body); }
    }
    const res = await fetch(base + path, { method, body, headers });
    const buf = await res.arrayBuffer();
    const text = new TextDecoder().decode(buf);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path} ${text}`);
    if (responseType === "binary") return new Uint8Array(buf);
    if (responseType === "text") return text;
    try { return JSON.parse(text); } catch { throw new Error(`Non-JSON: ${text}`); }
}

// ---- protocol state ----
let refTips = new Map();     // name -> oid
let pendingPushes = [];      // {src,dst}
let readingPushBatch = false;

// ---- main loop ----
const rl = createInterface({ input: stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
    if (line === "") {
        if (readingPushBatch) {
            readingPushBatch = false;
            try {
                await handlePushDelta();
                for (const { dst } of pendingPushes) out(`ok ${dst}`);
                out("");
            } catch (e) {
                stderr.write(`[push] failed: ${e.message}\n`);
                for (const { dst } of pendingPushes) out(`error ${dst} "${String(e.message).replace(/"/g, '\\"')}"`);
                out("");
            } finally {
                pendingPushes = [];
            }
        }
        return;
    }

    const parts = line.trim().split(" ");
    const cmd = parts[0];
    log("CMD:", line);

    switch (cmd) {
        case "capabilities":
            out("option");
            out("fetch");
            out("push");
            out("");
            break;

        case "option":
            out("ok");
            break;

        case "list":
            await handleList();
            break;

        case "fetch": {
            const refname = parts.slice(2).join(" ");
            await handleFetch(refname);
            break;
        }

        case "push": {
            const [src, dst] = (parts[1] || "").split(":");
            pendingPushes.push({ src, dst });
            readingPushBatch = true;
            break;
        }
    }
});

// ---- handlers ----
async function handleList() {
    const j = await http("GET", `/repos/${encodeURIComponent(repo)}/refs`);
    refTips.clear();
    for (const r of (j.refs || [])) {
        out(`${r.oid} ${r.name}`);
        refTips.set(r.name, r.oid);
    }
    out("");
}

async function handleFetch(refname) {
    // 1) 计算 base：优先用本地 remote-tracking
    const short = refname.startsWith("refs/heads/") ? refname.slice("refs/heads/".length) : refname;
    let baseOid = "";
    try { baseOid = (await runGitCapture(["rev-parse", `refs/remotes/origin/${short}`])).trim(); } catch { }

    // 2) 请求 delta 列表
    const q = new URLSearchParams({ ref: refname, base: baseOid }).toString();
    const j = await http("GET", `/repos/${encodeURIComponent(repo)}/delta?${q}`);
    if (!j.ok) {
        if (j.reason === "BaseNotFound") throw new Error(`BaseNotFound for ${refname}`);
        throw new Error(`delta error: ${JSON.stringify(j)}`);
    }
    const packs = j.packs || [];
    if (packs.length === 0) { out(""); return; }

    // 3) 逐个下载 raw-thin 并导入（本地用 index-pack 修薄为全）
    for (const name of packs) {
        const buf = await http("GET", `/repos/${encodeURIComponent(repo)}/packs/${encodeURIComponent(name)}`, { responseType: "binary" });
        await runGitIndexPackFromBuf(buf);
    }

    // 4) keep 锁防止 GC
    const packDir = join(GIT_DIR, "objects", "pack");
    if (!existsSync(packDir)) mkdirSync(packDir, { recursive: true });
    const keepPath = join(packDir, `min-helper-${Date.now()}.keep`);
    writeFileSync(keepPath, "keep\n");
    out(`lock ${keepPath}`);
    out("");
}

async function handlePushDelta() {
    for (const { src, dst } of pendingPushes) {
        const newOid = (await runGitCapture(["rev-parse", src])).trim();
        const oldOid = refTips.get(dst) || "";

        // 1) 针对 old->new 自打 thin pack
        let revs = `${newOid}\n`;
        if (oldOid) revs += `^${oldOid}\n`;
        const packBuf = await runGitCaptureBufWithStdin(
            ["pack-objects", "--stdout", "--revs", "--thin", "--delta-base-offset"],
            revs
        );

        // 2) 上传 raw-thin
        const up = await http("POST", `/repos/${encodeURIComponent(repo)}/uploadRawPack`, {
            body: packBuf, responseType: "json", contentType: "application/octet-stream"
        });
        const rawPack = up.rawPack;

        // 3) 原子前移 refs
        const body = { updates: [{ name: dst, oldOid, newOid, rawPack }] };
        await http("POST", `/repos/${encodeURIComponent(repo)}/updateRefs`, { body });
    }
}

// ---- small git helpers ----
function runGitCapture(args) {
    return new Promise((resolve, reject) => {
        const child = spawn("git", args, { stdio: ["ignore", "pipe", "inherit"] });
        let buf = "";
        child.stdout.on("data", d => buf += d.toString());
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve(buf) : reject(new Error(`git ${args.join(" ")} exited ${code}`)));
    });
}
function runGitCaptureBufWithStdin(args, stdinStr) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const child = spawn("git", args, { stdio: ["pipe", "pipe", "inherit"] });
        child.stdout.on("data", d => chunks.push(d));
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git ${args.join(" ")} exited ${code}`)));
        child.stdin.end(Buffer.from(stdinStr, "utf-8"));
    });
}
function runGitIndexPackFromBuf(buf) {
    return new Promise((resolve, reject) => {
        const child = spawn("git", ["index-pack", "--stdin", "--fix-thin", "--keep", "-v"], { stdio: ["pipe", "ignore", "inherit"] });
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve() : reject(new Error(`git index-pack --stdin exited ${code}`)));
        child.stdin.end(buf);
    });
}