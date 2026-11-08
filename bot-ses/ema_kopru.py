"""Çerezcord bot sesi köprüsü.

EMA (Türkçe TTS) modelini bir kez yükler ve 127.0.0.1:8790'da küçük bir HTTP sunucusu açar.
Çerezcord sayfası botun sözünü buraya gönderir, WAV alır ve odadaki herkese yollar.

Model CPU'da çalışır (oyunda ekran kartına dokunmaz). İş parçacığı sayısı sınırlıdır.

  POST /tts   {"text": "...", "pitch": 1.0}  ->  audio/wav (24 kHz, mono, 16 bit)
  POST /stt   ham PCM (float32, 16 kHz, mono) ->  {"ok": true, "metin": "..."}   (Whisper small, CPU)
  GET  /durum                                ->  {"ok": true, "ses": "ema", "stt": true}
"""

import io
import json
import os
import re
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch

PORT = 8790
RATE = 24_000
MAX_TEXT = 500
ALLOWED_ORIGINS = re.compile(r"^(https://yusufcihan1\.github\.io|http://(localhost|127\.0\.0\.1)(:\d+)?)$")

torch.set_num_threads(4)

print("EMA yükleniyor (CPU)...", flush=True)
_t = time.time()
from ema_lightning import EMA  # noqa: E402

TTS = EMA(device="cpu")
TTS.say("Hazır.", seed=0)  # ilk çağrıdaki gecikmeyi burada öde
print(f"Hazır ({time.time() - _t:.1f} sn). http://127.0.0.1:{PORT}", flush=True)
LOCK = threading.Lock()

# Konuşmayı yazıya çevirme (botlar odadakilerin sesini duysun diye). Yoksa köprü yalnız ses üretir.
STT_RATE = 16_000
STT_MAX_BYTES = 25 * STT_RATE * 4  # en fazla 25 sn
STT_LOCK = threading.Lock()
# Ekran kartı varsa Whisper orada çalışır (medium ~0,5 sn); yoksa ya da yer kalmadıysa CPU'da small (~2,5 sn).
# CUDA 12 cuBLAS'ı pip paketinden (nvidia-cublas-cu12), cuDNN'i torch'un klasöründen bulsun.
for _d in ("nvidia/cublas/bin", "torch/lib"):
    _p = os.path.join(sys.prefix, "Lib", "site-packages", _d)
    if os.path.isdir(_p):
        os.add_dll_directory(_p)
        os.environ["PATH"] = _p + os.pathsep + os.environ.get("PATH", "")


def _load_stt(gpu: bool):
    from faster_whisper import WhisperModel

    if gpu:
        return WhisperModel("medium", device="cuda", compute_type="int8_float16"), "medium, ekran kartı"
    return WhisperModel("small", device="cpu", compute_type="int8", cpu_threads=8), "small, CPU"


STT = None
STT_GPU = False
for _gpu in (True, False):
    try:
        _t = time.time()
        STT, _ad = _load_stt(_gpu)
        STT.transcribe(np.zeros(STT_RATE, dtype=np.float32), language="tr")  # ilk çağrının gecikmesini burada öde
        STT_GPU = _gpu
        print(f"Whisper hazır ({_ad}, {time.time() - _t:.1f} sn).", flush=True)
        break
    except Exception as e:  # noqa: BLE001
        STT = None
        print(f"Whisper {'ekran kartında' if _gpu else 'CPU da'} açılamadı:", str(e)[:150], flush=True)
if STT is None:
    print("Whisper yok, botlar sesi duyamaz.", flush=True)

# Whisper sessizlikte ya da gürültüde bunları uydurur (altyazı verisinden kalma).
_HALLUCINATION = re.compile(
    r"altyaz|abone ol|izlediğiniz için|^\W*(teşekkür ederim|teşekkürler|müzik|alkış)\W*$|devam edecek|www\.|\.com",
    re.IGNORECASE,
)


def _run_stt(pcm: np.ndarray) -> list[str]:
    segs, _ = STT.transcribe(
        pcm,
        language="tr",
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
        no_speech_threshold=0.5,
    )
    return [s.text.strip() for s in segs if s.no_speech_prob < 0.6 and s.avg_logprob > -1.0]


def transcribe(pcm: np.ndarray) -> str:
    global STT, STT_GPU
    with STT_LOCK:
        try:
            parts = _run_stt(pcm)
        except Exception as e:  # noqa: BLE001
            if not STT_GPU:
                raise
            # Ekran kartında yer kalmadı (oyun vb.): CPU'ya geç ve devam et.
            print("Whisper ekran kartında hata verdi, CPU'ya geçiliyor:", str(e)[:150], flush=True)
            STT, _ = _load_stt(False)
            STT_GPU = False
            parts = _run_stt(pcm)
    text = re.sub(r"\s+", " ", " ".join(parts)).strip()
    if len(text) < 2 or _HALLUCINATION.search(text):
        return ""
    return text[:MAX_TEXT]

_DIGITS = "sıfır bir iki üç dört beş altı yedi sekiz dokuz".split()


def clean(text: str) -> str:
    text = re.sub(r"[\U0001F000-\U0001FAFF☀-➿️]", "", text)  # emoji
    text = re.sub(r"[*_#\"“”‘’`]", "", text)
    text = re.sub(r"(\w)'(\w)", r"\1\2", text)  # Ali'nin -> Alinin
    text = re.sub(r"\d", lambda m: f" {_DIGITS[int(m.group())]} ", text)
    return re.sub(r"\s+", " ", text).strip()[:MAX_TEXT]


def synth(text: str, pitch: float) -> bytes:
    pitch = min(1.35, max(0.75, pitch))
    with LOCK:
        # Perdeyi kaydırırken süreyi korumak için önce o oranda yavaş/hızlı üret, sonra yeniden örnekle.
        speech = TTS.say(text, speed=1.0 / pitch, seed=None, sample_rate=RATE)
    audio = np.asarray(speech.audio, dtype=np.float32)
    if abs(pitch - 1.0) > 0.01:
        n = int(len(audio) / pitch)
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
    if peak > 0:
        audio = audio * (0.9 / peak)
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin", "")
        if ALLOWED_ORIGINS.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "content-type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/durum"):
            self._json(200, {"ok": True, "ses": "ema", "stt": STT is not None})
        else:
            self._json(404, {"ok": False})

    def do_POST(self):
        origin = self.headers.get("Origin")
        if origin and not ALLOWED_ORIGINS.match(origin):
            return self._json(403, {"ok": False})
        if self.path.startswith("/stt"):
            return self._stt()
        if not self.path.startswith("/tts"):
            return self._json(404, {"ok": False})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(min(size, 8192)) or b"{}")
            text = clean(str(data.get("text", "")))
            pitch = float(data.get("pitch", 1.0))
        except (ValueError, TypeError):
            return self._json(400, {"ok": False, "hata": "istek bozuk"})
        if not text:
            return self._json(400, {"ok": False, "hata": "metin boş"})
        t = time.time()
        try:
            wav = synth(text, pitch)
        except Exception as e:  # noqa: BLE001
            print("HATA:", e, file=sys.stderr, flush=True)
            return self._json(500, {"ok": False, "hata": str(e)[:200]})
        print(f"{time.time() - t:.2f} sn  {text[:70]}", flush=True)
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)

    def _stt(self):
        if STT is None:
            return self._json(503, {"ok": False, "hata": "whisper yok"})
        size = int(self.headers.get("Content-Length", "0") or 0)
        if size <= 0 or size > STT_MAX_BYTES or size % 4:
            return self._json(400, {"ok": False, "hata": "ses bozuk"})
        pcm = np.frombuffer(self.rfile.read(size), dtype="<f4").astype(np.float32)
        t = time.time()
        try:
            text = transcribe(pcm)
        except Exception as e:  # noqa: BLE001
            print("STT HATA:", e, file=sys.stderr, flush=True)
            return self._json(500, {"ok": False, "hata": str(e)[:200]})
        print(f"{time.time() - t:.2f} sn  duydu ({len(pcm) / STT_RATE:.1f} sn): {text[:70]}", flush=True)
        self._json(200, {"ok": True, "metin": text})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except OSError:
        print(f"{PORT} portu dolu: köprü zaten açık olabilir.", flush=True)
        time.sleep(5)
