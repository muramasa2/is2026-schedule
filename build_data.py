#!/usr/bin/env python3
"""schedule_data.json から schedule_data.js（file:// で開く際のフォールバック）を生成する。
JSON を差し替えたら再実行: python3 build_data.py"""
import json, pathlib
here = pathlib.Path(__file__).parent
data = json.loads((here / 'schedule_data.json').read_text(encoding='utf-8'))
(here / 'schedule_data.js').write_text('window.SCHEDULE_DATA = ' + json.dumps(data, ensure_ascii=False) + ';\n', encoding='utf-8')
print('wrote schedule_data.js')
