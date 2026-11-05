"""Offline CPU text + formula OCR. All model paths are local; no request-time downloads."""
import json
import os
import sys
import time
from pathlib import Path

os.environ['OMP_NUM_THREADS'] = '1'
import cv2
import numpy as np
import onnxruntime as ort
import pymupdf
from PIL import Image, ImageOps
from tokenizers import Tokenizer
from rapidocr_onnxruntime import RapidOCR


class FormulaOCR:
    def __init__(self, root):
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.enable_cpu_mem_arena = False
        def session(path):
            return ort.InferenceSession(str(root / path), sess_options=options,
                                        providers=['CPUExecutionProvider'])
        self.detector = session('mfd/pix2text-mfd-1.5.onnx')
        self.encoder = session('mfr/encoder_model.onnx')
        self.decoder = session('mfr/decoder_model.onnx')
        self.tokenizer = Tokenizer.from_file(str(root / 'mfr/tokenizer.json'))
        self.text = RapidOCR(intra_op_num_threads=1, inter_op_num_threads=1)

    def boxes(self, image):
        h, w = image.shape[:2]
        ratio = min(768 / h, 768 / w)
        nh, nw = round(h * ratio), round(w * ratio)
        top, left = (768 - nh) // 2, (768 - nw) // 2
        resized = cv2.resize(image, (nw, nh))
        padded = cv2.copyMakeBorder(resized, top, 768 - nh - top, left, 768 - nw - left,
                                    cv2.BORDER_CONSTANT, value=(114, 114, 114))
        values = padded[:, :, ::-1].transpose(2, 0, 1)[None].astype('float32') / 255
        output = self.detector.run(None, {'images': values})[0][0].T
        scores = output[:, 4:].max(1)
        output, scores = output[scores > .35], scores[scores > .35]
        boxes = output[:, :4].copy()
        boxes[:, :2] -= boxes[:, 2:] / 2
        indices = cv2.dnn.NMSBoxes(boxes.tolist(), scores.tolist(), .35, .45)
        result = []
        for i in list(indices)[:32]:
            x, y, bw, bh = boxes[i]
            x1, y1 = max(0, round((x - left) / ratio) - 3), max(0, round((y - top) / ratio) - 3)
            x2, y2 = min(w, round((x + bw - left) / ratio) + 3), min(h, round((y + bh - top) / ratio) + 3)
            if x2 > x1 and y2 > y1:
                result.append((x1, y1, x2, y2))
        return result

    def formula(self, crop, deadline):
        image = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY))
        # Remove light watermarks without converting antialiased dark strokes to binary.
        image = image.point(lambda x: 255 if x > 180 else x)
        image = ImageOps.expand(image, border=8, fill=255).convert('RGB')
        image = image.resize((384, 384), Image.Resampling.BICUBIC)
        pixels = (np.asarray(image).astype('float32') / 127.5 - 1).transpose(2, 0, 1)[None]
        hidden = self.encoder.run(None, {'pixel_values': pixels})[0]
        tokens = [1]
        for _ in range(256):
            if time.monotonic() >= deadline:
                raise TimeoutError('formula OCR deadline')
            logits = self.decoder.run(None, {'input_ids': np.array([tokens], dtype=np.int64),
                                            'encoder_hidden_states': hidden})[0]
            token = int(logits[0, -1].argmax())
            tokens.append(token)
            if token == 2:
                return self.tokenizer.decode(tokens, skip_special_tokens=True)
        raise ValueError('formula token limit; incomplete formula discarded')

    def page(self, image, deadline):
        formulas = self.boxes(image)
        masked = image.copy()
        elements = []
        for x1, y1, x2, y2 in formulas:
            formula = self.formula(image[y1:y2, x1:x2], deadline)
            elements.append((y1, x1, y2, '$' + formula + '$'))
            masked[y1:y2, x1:x2] = 255
        if time.monotonic() >= deadline:
            raise TimeoutError('page OCR deadline')
        texts, _ = self.text(masked)
        for box, text, score in texts or []:
            if score < .5:
                continue
            points = np.array(box)
            elements.append((float(points[:, 1].min()), float(points[:, 0].min()),
                             float(points[:, 1].max()), text))
        # Group same-line elements, then order left to right, preserving equations in context.
        lines = []
        for element in sorted(elements):
            y1, x1, y2, text = element
            line = next((line for line in lines if min(y2, line[1]) - max(y1, line[0]) > .5 * min(y2 - y1, line[1] - line[0])), None)
            if line is None:
                line = [y1, y2, []]
                lines.append(line)
            line[2].append((x1, text))
        return '\n'.join(' '.join(text for _, text in sorted(line[2])) for line in lines)


def main():
    root, pdf_path, pages_json = sys.argv[1:4]
    pages = json.loads(pages_json)
    if not isinstance(pages, list) or len(pages) > 16 or any(type(p) is not int or p < 1 for p in pages):
        raise ValueError('invalid OCR pages')
    deadline = time.monotonic() + 35
    model = FormulaOCR(Path(root))
    results, warnings = [], []
    with pymupdf.open(pdf_path) as pdf:
        for page in pages:
            if time.monotonic() >= deadline:
                break
            try:
                p = pdf[page - 1]
                scale = min(1600 / max(p.rect.width, p.rect.height), 3)
                pix = p.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False, colorspace=pymupdf.csRGB)
                rgb = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
                text = model.page(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), deadline)
                results.append({'page': page, 'text': text})
            except (TimeoutError, ValueError) as error:
                warnings.append(f'第 {page} 页公式 OCR 未完成，保留原文本。')
                if time.monotonic() >= deadline:
                    break
    print(json.dumps({'pages': results, 'warnings': warnings}, ensure_ascii=False))


if __name__ == '__main__':
    main()
