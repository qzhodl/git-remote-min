#!/usr/bin/env node
/**
 * Minimal Git remote helper (min://) — robust push (self-pack) version.
 * Node ≥ 18 (uses global fetch).
 *
 * Push strategy:
 *   - Ignore stdin payload from Git.
 *   - Always self-generate a full pack via `git pack-objects --stdout --all`.
 *   - Upload that pack and call updateRefs with oldOid="".
 */

import { createInterface } from "node:readline";
import { stdin, stdout, stderr } from "node:process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
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
    const url = new URL(u.replace("min://", "http://")); // transport via HTTP
    return { base: `${url.protocol}//${url.host}`, repo: url.pathname.replace(/^\/+/, "") };
}
const { base, repo } = parseUrl(REMOTE_URL);
log("MIN base:", base, "repo:", repo);

// ---- HTTP helper ----
async function http(method, path, {
    body = null,
    responseType = "json",
    contentType = undefined
} = {}) {
    const headers = {};
    if (body != null) {
        if (contentType) {
            headers["Content-Type"] = contentType;
        } else if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
            headers["Content-Type"] = "application/octet-stream";
        } else {
            headers["Content-Type"] = "application/json";
            if (typeof body !== "string") body = JSON.stringify(body);
        }
    }

    const res = await fetch(base + path, { method, body, headers });

    const buf = await res.arrayBuffer();                  // 先读原始字节
    const text = new TextDecoder().decode(buf);           // 方便出错时打印
    if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path} ${text}`);

    if (responseType === "binary") return new Uint8Array(buf);
    if (responseType === "text") return text;

    // 默认 json
    try { return JSON.parse(text); }
    catch { throw new Error(`Non-JSON response: ${text}`); }
}
// ---- protocol state ----
let refToPackId = new Map();
let pendingPushes = [];
let readingPushBatch = false;

// ---- main loop ----
const rl = createInterface({ input: stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
    if (line === "") {
        if (readingPushBatch) {
            readingPushBatch = false;
            try {
                await handlePushSelfPack();
                for (const { dst } of pendingPushes) out(`ok ${dst}`);
                out(""); // end push status report
            } catch (e) {
                stderr.write(`[push] failed: ${e.message}\n`);
                for (const { dst } of pendingPushes) out(`error ${dst} "${e.message.replace(/"/g, '\\"')}"`);
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

        default:
            break;
    }
});

// ---- handlers ----
async function handleList() {
    const j = await http("GET", `/repos/${encodeURIComponent(repo)}/refs`);
    refToPackId.clear();
    for (const r of (j.refs || [])) {
        out(`${r.oid} ${r.name}`);
        if (r.packId) refToPackId.set(r.name, r.packId);
    }
    out("");
}

async function handleFetch(refname) {
    const packId = refToPackId.get(refname);
    if (!packId) { out(""); return; }

    const buf = await http("GET",
        `/repos/${encodeURIComponent(repo)}/packs/${encodeURIComponent(packId)}`,
        { responseType: "binary" }
    );

    const packDir = join(GIT_DIR, "objects", "pack");       // <<< use GIT_DIR
    if (!existsSync(packDir)) mkdirSync(packDir, { recursive: true });
    const tmpPack = join(packDir, `min-fetch-${Date.now()}.pack`);
    writeFileSync(tmpPack, buf);

    await runGit(["index-pack", "--keep", "-v", tmpPack]);  // <<< use -v

    const keepPath = join(packDir, `min-helper-${Date.now()}.keep`);
    writeFileSync(keepPath, "keep\n");
    out(`lock ${keepPath}`);
    out("");
}
async function handlePushSelfPack() {
    // 1) 用 git pack-objects 自己打包整个仓库
    const packBuf = await runGitCaptureBuf(["pack-objects", "--stdout", "--all"]);

    // 2) 上传 pack
    const up = await http("POST", `/repos/${encodeURIComponent(repo)}/packs`, {
        body: packBuf,
        responseType: "json",                         // 解析成 JSON
        contentType: "application/octet-stream"       // 请求体是二进制
    });

    if (!up || !up.packId) {
        throw new Error("upload /packs returned no packId: " + JSON.stringify(up));
    }
    const packId = up.packId;
    if (process.env.DEBUG) {
        stderr.write(`[helper] uploaded packId=${packId}\n`);
    }

    // 3) 更新 refs
    const updates = [];
    for (const { src, dst } of pendingPushes) {
        const newOid = (await runGitCapture(["rev-parse", src])).trim();
        if (!newOid) throw new Error(`rev-parse failed for ${src}`);
        updates.push({ name: dst, oldOid: "", newOid, packId });
    }

    const res = await http("POST", `/repos/${encodeURIComponent(repo)}/updateRefs`, {
        body: JSON.stringify({ updates })
    });
    if (process.env.DEBUG) {
        stderr.write(`[helper] updateRefs response: ${JSON.stringify(res)}\n`);
    }
}

// ---- small git helpers ----
function runGit(args) {
    return new Promise((resolve, reject) => {
        const child = spawn("git", args, { stdio: ["ignore", "ignore", "inherit"] });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} exited ${code}`)));
    });
}
function runGitCapture(args) {
    return new Promise((resolve, reject) => {
        const child = spawn("git", args, { stdio: ["ignore", "pipe", "inherit"] });
        let buf = "";
        child.stdout.on("data", (d) => (buf += d.toString()));
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve(buf) : reject(new Error(`git ${args.join(" ")} exited ${code}`)));
    });
}
function runGitCaptureBuf(args) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const child = spawn("git", args, { stdio: ["ignore", "pipe", "inherit"] });
        child.stdout.on("data", (d) => chunks.push(d));
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) resolve(Buffer.concat(chunks));
            else reject(new Error(`git ${args.join(" ")} exited ${code}`));
        });
    });
}