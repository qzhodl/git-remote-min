# server.py
from flask import Flask, request, jsonify, send_file
import os, json, hashlib

app = Flask(__name__)
BASE = os.path.abspath("./data")

def repo_dir(repo):
    d = os.path.join(BASE, repo)
    pk = os.path.join(d, "objects", "pack")
    os.makedirs(pk, exist_ok=True)
    # init refs.json and updates.json if not exist
    refs_p = os.path.join(d, "refs.json")
    upds_p = os.path.join(d, "updates.json")
    if not os.path.exists(refs_p):
        with open(refs_p, "w") as f: json.dump({"refs": {}}, f)
    if not os.path.exists(upds_p):
        with open(upds_p, "w") as f: json.dump([], f)
    return d

@app.get("/repos/<repo>/refs")
def list_refs(repo):
    d = repo_dir(repo)
    refs = json.load(open(os.path.join(d, "refs.json")))["refs"]
    out = [{"name": name, "oid": info["oid"]} for name, info in refs.items()]
    return jsonify({"refs": out})

@app.post("/repos/<repo>/uploadRawPack")
def upload_raw_pack(repo):
    """
    receive a raw thin pack uploaded by client, save it as raw-<sha256>.pack without validation.
    return rawPack filename, sha256 and size.
    """
    d = repo_dir(repo)
    data = request.get_data(cache=False)
    sha = hashlib.sha256(data).hexdigest()
    raw_name = f"raw-{sha}.pack"
    raw_path = os.path.join(d, "objects", "pack", raw_name)
    with open(raw_path, "wb") as f:
        f.write(data)
    size = os.path.getsize(raw_path)
    return jsonify({"ok": True, "rawPack": raw_name, "sha256": sha, "size": size})

@app.post("/repos/<repo>/updateRefs")
def update_refs(repo):
    """
    Move refs forward and append this push to updates.json.
    Save rawPack (raw-*.pack)
    """    
    d = repo_dir(repo)
    refs_path = os.path.join(d, "refs.json")
    upds_path = os.path.join(d, "updates.json")
    meta = json.load(open(refs_path))

    payload = request.get_json(silent=True) or {}
    updates = payload.get("updates", [])

    for u in updates:
        name = u.get("name"); old = u.get("oldOid", ""); new = u.get("newOid"); rawp = u.get("rawPack")
        if not (name and new and rawp):
            return jsonify({"ok": False, "error": f"bad update {u}"}), 400
        cur = meta["refs"].get(name, {"oid": ""})
        if cur["oid"] != old:
            return jsonify({"ok": False, "error": "NonFastForward"}), 409
        raw_file = os.path.join(d, "objects", "pack", rawp)
        if not os.path.exists(raw_file):
            return jsonify({"ok": False, "error": f"rawPack not found: {rawp}"}), 400

    # Write back refs
    for u in updates:
        meta["refs"][u["name"]] = {"oid": u["newOid"]}
    with open(refs_path, "w") as f: json.dump(meta, f)

    # Record delta chain
    log = json.load(open(upds_path))
    for u in updates:
        log.append({
            "name": u["name"],
            "oldOid": u.get("oldOid", ""),
            "newOid": u["newOid"],
            "rawPack": u["rawPack"],
            "size": u.get("size", 0),
            "sha256": u.get("sha256", "")
        })
    with open(upds_path, "w") as f: json.dump(log, f)
    return jsonify({"ok": True})

@app.get("/repos/<repo>/delta")
def delta_chain(repo):
    """
    Return the raw-thin list for base→tip:
      - base == tip         → empty list
      - base is empty (new clone) → full chain
      - base is not on chain       → BaseNotFound (this prototype does not return snapshots)
    """
    d = repo_dir(repo)
    ref = request.args.get("ref")
    base = request.args.get("base", "")
    if not ref:
        return jsonify({"ok": False, "error": "ref required"}), 400

    updates_all = json.load(open(os.path.join(d, "updates.json")))
    updates = [u for u in updates_all if u["name"] == ref]

    refs = json.load(open(os.path.join(d, "refs.json")))["refs"]
    tip = refs.get(ref, {}).get("oid", "")
    if not tip:
        return jsonify({"ok": True, "packs": [], "finalOid": ""})

    if base == tip:
        return jsonify({"ok": True, "packs": [], "finalOid": tip})

    if base == "":
        packs = [u["rawPack"] for u in updates]
        return jsonify({"ok": True, "packs": packs, "finalOid": tip})

    start = -1
    for i, u in enumerate(updates):
        if u.get("oldOid", "") == base:
            start = i
            break
    if start == -1:
        return jsonify({"ok": False, "reason": "BaseNotFound", "finalOid": tip}), 404

    packs = [u["rawPack"] for u in updates[start:]]
    return jsonify({"ok": True, "packs": packs, "finalOid": tip})

@app.get("/repos/<repo>/packs/<packname>")
def get_pack(repo, packname):
    # only allow downloading raw-*.pack
    d = repo_dir(repo)
    if not (packname.startswith("raw-") and packname.endswith(".pack")):
        return ("forbidden", 403)
    p = os.path.join(d, "objects", "pack", packname)
    if not os.path.exists(p):
        return ("not found", 404)
    return send_file(p, mimetype="application/octet-stream")

if __name__ == "__main__":
    os.makedirs(BASE, exist_ok=True)
    app.run(host="0.0.0.0", port=8080, debug=True)