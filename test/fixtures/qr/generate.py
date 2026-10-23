"""Regenerates matrices.json with qrcode 8.2 (pip install qrcode==8.2). Run once; the result is committed."""
import json, qrcode
from qrcode import constants, util

def make_text(version, length):
    base = 'ctx-room/%d:' % version
    return (base + ''.join(chr(97 + (i * 7 + version) % 26) if i % 5 else chr(48 + i % 10) for i in range(length)))[:length]

def fits(version, text):
    qr = qrcode.QRCode(version=version, error_correction=constants.ERROR_CORRECT_L, border=0)
    qr.add_data(util.QRData(text, mode=util.MODE_8BIT_BYTE))
    try: qr.make(fit=False); return True
    except Exception: return False

def text_for(version):
    lo, hi = 1, 1500  # largest length that still fits this version
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if fits(version, make_text(version, mid)): lo = mid
        else: hi = mid - 1
    return make_text(version, lo)

def matrix(text, version, mask):
    qr = qrcode.QRCode(version=version, error_correction=constants.ERROR_CORRECT_L, border=0, mask_pattern=mask)
    qr.add_data(util.QRData(text, mode=util.MODE_8BIT_BYTE)); qr.make(fit=False)
    return [''.join('1' if c else '0' for c in row) for row in qr.get_matrix()]

out = []
for version in (1, 5, 10, 17, 25):
    text = text_for(version)
    masks = range(8) if version <= 10 else (0, 3, 5)
    out.append({'version': version, 'text': text, 'masks': {str(m): matrix(text, version, m) for m in masks}})
json.dump(out, open('matrices.json', 'w'), separators=(',', ':'))
