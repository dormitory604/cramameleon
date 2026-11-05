"""Fail a release before activation if any required OCR dependency/model is missing."""
import hashlib
import json
import sys
from pathlib import Path
import cv2
import onnxruntime
import pymupdf
from tokenizers import Tokenizer
from rapidocr_onnxruntime import RapidOCR

root = Path(sys.argv[1]) / 'models'
for model in json.loads(Path(__file__).with_name('models.json').read_text()):
    digest = hashlib.sha256()
    with (root / model['path']).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != model['sha256']:
        raise RuntimeError(f"OCR model checksum mismatch: {model['path']}")
print('OCR dependencies and model checksums verified')
