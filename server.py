from flask import Flask, request, jsonify, send_file, abort
import os, uuid, hashlib, json

app = Flask(__name__)
ROOT = "./data"
os.makedirs(ROOT, exist_ok=True)

def repo_dir(r):
    d = os.path.join(ROOT, r)
    os.makedirs(d, exist_ok=True)
    os.makedirs(os.path.join(d, "packs"), exist_ok=True)
    if not os.path.exists(os.path.join(d, "refs.json")):
        with open(os.path.join(d, "refs.json"), "w") as f:
            json.dump({"oidAlgo":"sha1","refs":{}}, f)
    return d

@app.get("/repos/<repo>/refs")
def list_refs(repo):
    d = repo_dir(repo)
    meta = json.load(open(os.path.join(d, "refs.json")))
    arr = []
    for name, v in meta["refs"].items():
        arr.append({"name": name, "oid": v["oid"], "packId": v["packId"]})
    return jsonify({"repo":repo, "oidAlgo":meta["oidAlgo"], "refs":arr})

@app.post("/repos/<repo>/packs")
def upload_pack(repo):
    d = repo_dir(repo)
    data = request.get_data()
    pack_hash = hashlib.sha256(data).hexdigest()
    pack_id = uuid.uuid4().hex[:8]
    path = os.path.join(d, "packs", f"{pack_id}.pack")
    open(path, "wb").write(data)
    return jsonify({"packId": pack_id, "packHash": f"sha256:{pack_hash}", "size": len(data)}), 201

@app.get("/repos/<repo>/packs/<pack_id>")
def download_pack(repo, pack_id):
    d = repo_dir(repo)
    path = os.path.join(d, "packs", f"{pack_id}.pack")
    if not os.path.exists(path): abort(404)
    return send_file(path, mimetype="application/octet-stream")

@app.post("/repos/<repo>/updateRefs")
def update_refs(repo):
    d = repo_dir(repo)
    meta_path = os.path.join(d, "refs.json")
    meta = json.load(open(meta_path))

    payload = request.get_json(silent=True) or {}
    print("[updateRefs] payload =", payload) 
    updates = payload.get("updates", [])
    if not isinstance(updates, list) or not updates:
        return jsonify({"ok": False, "error": "BadRequest: updates missing"}), 400

    # 并发/FF 校验
    for u in updates:
        name   = u.get("name")
        oldOid = u.get("oldOid", "")
        newOid = u.get("newOid")
        packId = u.get("packId")

        if not (name and newOid and packId):
            return jsonify({"ok": False, "error": f"BadRequest: field missing in {u}"}), 400

        cur = meta["refs"].get(name)
        old = (cur["oid"] if cur else "")
        if old != oldOid:
            return jsonify({"ok": False, "error": "NonFastForward"}), 409

    # 原子更新
    for u in updates:
        meta["refs"][u["name"]] = {"oid": u["newOid"], "packId": u["packId"]}

    json.dump(meta, open(meta_path,"w"))
    return jsonify({"ok": True})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)