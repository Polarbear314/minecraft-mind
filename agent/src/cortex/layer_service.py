"""The upper layers' models (docs/design-subsumption.md, stage 6).

One local HTTP service holds the three language-model layers on the GPU, each
loaded in 4-bit so all three fit beside Minecraft on the RTX 3060:

    make     Qwen3-4B-Instruct-2507   (about 4B)
    shelter  Qwen2.5-3B-Instruct      (about 3B)
    gather   Qwen3-1.7B               (about 2B)

A layer doesn't write an answer. Its possible acts are listed as A, B, C...,
and ONE forward pass gives how likely the model finds each letter as the
answer: those are the layer's probabilities (and its "how sure"). That is
reliable even for the smallest model, and fast.

Transformers (not Ollama) so the models' insides are reachable: /activations
returns hidden states, which stage 7b ("the model's insides as a document")
indexes and edits.

    POST /choose       {"layer", "job", "situation", "memories": [..], "acts": [..]}
                       -> {"probs": [..], "pick": i, "p": .., "ms": ..}
    POST /activations  {"layer", "texts": [..], "at": [layer indices]} -> {"means": ...}
    POST /reload       {"layers": [..]} -> re-read logs/layers/patches/<layer>-current.json
    GET  /health       -> which layers are loaded

Run (bot or not): agent\\.venv-laya\\Scripts\\python agent\\src\\cortex\\layer_service.py [--layers make,shelter,gather] [--port 3010]
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

MODELS = {
    "make": "Qwen/Qwen3-4B-Instruct-2507",
    "shelter": "Qwen/Qwen2.5-3B-Instruct",
    "gather": "Qwen/Qwen3-1.7B",
}
LETTERS = "ABCDEFGHIJKL"
PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 3010
WANT = sys.argv[sys.argv.index("--layers") + 1].split(",") if "--layers" in sys.argv else list(MODELS)

loaded = {}
lock = threading.Lock()  # one forward pass at a time on the GPU

# Nightly weight edits (cortex/nightly_write.py): a layer's newest edit that passed
# its gate is named in logs/layers/patches/<layer>-current.json and applied as
# hooks on the model's MLP output weights (down_proj: + x[cols] @ dW^T), kept in
# fp16 beside the 4-bit weights. Every version stays on disk; none = the model as downloaded.
PATCHES = os.path.join(os.path.dirname(__file__), "..", "..", "..", "logs", "layers", "patches")


def apply_patch(layer):
    L = loaded[layer]
    for h in L.get("hooks", []):
        h.remove()
    L["hooks"], L["patch"] = [], None
    cur = os.path.join(PATCHES, f"{layer}-current.json")
    if not os.path.exists(cur):
        return None
    try:
        with open(cur, encoding="utf8") as f:
            meta = json.load(f)
        p = torch.load(os.path.join(PATCHES, meta["file"]))
        for part in p["parts"]:
            ci = torch.tensor(part["cols"], device="cuda")
            dW = part["dW"].half().cuda()
            mlp = L["model"].model.layers[part["layer"]].mlp
            L["hooks"].append(mlp.down_proj.register_forward_hook(lambda m, inp, out, ci=ci, dW=dW: out + inp[0][..., ci] @ dW.T))
        L["patch"] = meta.get("version")
        print(f"[cortex] {layer}: patch v{L['patch']} applied ({meta['file']}, {len(p['parts'])} layer(s))", flush=True)
    except Exception as err:  # a bad patch must not stop the layer: it runs unedited
        for h in L["hooks"]:
            h.remove()
        L["hooks"], L["patch"] = [], None
        print(f"[cortex] {layer}: patch not applied ({err}); running unedited", flush=True)
    return L["patch"]


def load(layer):
    name = MODELS[layer]
    t0 = time.time()
    tok = AutoTokenizer.from_pretrained(name)
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.float16)
    model = AutoModelForCausalLM.from_pretrained(name, quantization_config=quant, device_map="cuda", dtype=torch.float16)
    model.eval()
    # The token id of each answer letter as the model would write it first.
    letter_ids = []
    for L in LETTERS:
        ids = tok.encode(L, add_special_tokens=False)
        letter_ids.append(ids[0])
    loaded[layer] = {"name": name, "tok": tok, "model": model, "letters": letter_ids}
    apply_patch(layer)
    print(f"[cortex] {layer}: {name} loaded in {time.time() - t0:.0f}s "
          f"({torch.cuda.memory_allocated() / 1e9:.1f} GB on the GPU so far)", flush=True)


def prompt_for(layer, req):
    tok = loaded[layer]["tok"]
    acts = req["acts"][: len(LETTERS)]
    lines = [req.get("job", ""), "", "Right now: " + req.get("situation", "")]
    mem = req.get("memories") or []
    if mem:
        lines += ["", "What I remember that fits:"] + [f"- {m}" for m in mem]
    lines += ["", "Which ONE of these should I do now?"] + [f"{LETTERS[i]}. {a}" for i, a in enumerate(acts)]
    lines += ["", "Answer with the letter only."]
    msgs = [{"role": "user", "content": "\n".join(lines)}]
    kw = {"add_generation_prompt": True, "tokenize": False}
    try:
        text = tok.apply_chat_template(msgs, enable_thinking=False, **kw)  # Qwen3: no thinking
    except TypeError:
        text = tok.apply_chat_template(msgs, **kw)
    return text, len(acts)


@torch.no_grad()
def choose(req):
    layer = req["layer"]
    if layer not in loaded:
        raise KeyError(f"layer {layer} is not loaded")
    L = loaded[layer]
    text, n = prompt_for(layer, req)
    t0 = time.time()
    with lock:
        ids = L["tok"](text, return_tensors="pt").to("cuda")
        logits = L["model"](**ids).logits[0, -1].float()
    letter_logits = logits[torch.tensor(L["letters"][:n], device=logits.device)]
    probs = torch.softmax(letter_logits, dim=-1).tolist()
    pick = max(range(n), key=lambda i: probs[i])
    return {"probs": [round(p, 4) for p in probs], "pick": pick, "p": round(probs[pick], 4), "ms": int((time.time() - t0) * 1000), "model": L["name"], "patch": L.get("patch")}


@torch.no_grad()
def activations(req):
    L = loaded[req["layer"]]
    at = req.get("at") or [-1]
    out = []
    for text in req["texts"][:64]:
        with lock:
            ids = L["tok"](text, return_tensors="pt", truncation=True, max_length=512).to("cuda")
            hs = L["model"](**ids, output_hidden_states=True).hidden_states
        out.append({str(a): hs[a][0].float().mean(dim=0).cpu().tolist() for a in at})
    return {"means": out, "layers": len(hs)}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"loaded": {k: v["name"] for k, v in loaded.items()}, "patches": {k: v.get("patch") for k, v in loaded.items()},
                                    "gpuGB": round(torch.cuda.memory_allocated() / 1e9, 2)})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if self.path == "/choose":
                return self._send(200, choose(req))
            if self.path == "/activations":
                return self._send(200, activations(req))
            if self.path == "/reload":  # after a night's edit passed its gate
                with lock:
                    out = {l: apply_patch(l) for l in (req.get("layers") or list(loaded)) if l in loaded}
                return self._send(200, {"patches": out})
            self._send(404, {"error": "not found"})
        except Exception as err:  # one bad request must not stop the service
            self._send(500, {"error": str(err)})

    def log_message(self, *args):  # quiet
        pass


if __name__ == "__main__":
    for layer in WANT:
        load(layer)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[cortex] serving {', '.join(loaded)} on http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
