"""Explicit, offline regression check against the reported exam (not committed to Git).
Usage: python verify_sample.py /runtime /path/to/exam.pdf
"""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

pdf = Path(sys.argv[2])
expected = 'c131dac357bc2ec4f91c6c9aa2ebd85f0c3e1e996fde2b4eff245ea69ba22c10'
assert hashlib.sha256(pdf.read_bytes()).hexdigest() == expected, 'wrong reference PDF'
raw = subprocess.check_output([sys.executable, str(Path(__file__).with_name('recognize.py')),
                               sys.argv[1] + '/models', str(pdf), '[2,3]'], timeout=40)
result = json.loads(raw)
assert not result['warnings'], result['warnings']
pages = {p['page']: p['text'] for p in result['pages']}
def compact(text):
    text = re.sub(r'\\(?:operatorname|mathrm)', '', text)
    return re.sub(r'[{}\s&]', '', text)
p2, p3 = compact(pages[2]), compact(pages[3])
for fragment in [r'\int_0^1', r'\sqrt1-x^2', 'arcsinxdx', 'x=a(t-sint)', 'y=a(1-cost)', r'[0,2\pi]']:
    assert fragment in p2, (fragment, pages[2])
for fragment in ['f(x)=x^3lnx', 'x=1', 'y-z+1=0', 'x=0', 'z=0']:
    assert fragment in p3, (fragment, pages[3])
print('PASS: integral bounds, radical/power, inverse sine, two-row parametric equations, interval, cubic log, Taylor expansion point, line system and plane condition')
