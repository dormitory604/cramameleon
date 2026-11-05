#!/usr/bin/env bash
set -euo pipefail
runtime=${1:?Usage: install.sh /absolute/path/to/ocr-runtime}
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$runtime"
python3 -m venv "$runtime/venv"
"$runtime/venv/bin/python" -m pip install --no-cache-dir -r "$source_dir/requirements.txt"
"$runtime/venv/bin/python" - "$source_dir/models.json" "$runtime/models" <<'PY'
import hashlib,json,sys,urllib.request,os,shutil
from pathlib import Path
root=Path(sys.argv[2])
for model in json.load(open(sys.argv[1])):
    path=root/model['path'];path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest()==model['sha256']:continue
    url=f"{os.environ.get('HF_ENDPOINT','https://huggingface.co').rstrip('/')}/{model['repo']}/resolve/{model['revision']}/{Path(model['path']).name}"
    bundled=Path(sys.argv[1]).parent/Path(model['path']).name
    if bundled.exists() and hashlib.sha256(bundled.read_bytes()).hexdigest()==model['sha256']:
        shutil.copyfile(bundled,path);continue
    temporary=path.with_suffix('.download')
    with urllib.request.urlopen(url,timeout=120) as response,temporary.open('wb') as output:
        while chunk:=response.read(1024*1024):output.write(chunk)
    if hashlib.sha256(temporary.read_bytes()).hexdigest()!=model['sha256']:
        temporary.unlink();raise RuntimeError(f'Checksum mismatch: {path}')
    temporary.replace(path)
PY
"$runtime/venv/bin/python" -c 'import cv2, onnxruntime, pymupdf, tokenizers; from rapidocr_onnxruntime import RapidOCR; RapidOCR(intra_op_num_threads=1)'
echo 'Formula OCR runtime is ready.'
