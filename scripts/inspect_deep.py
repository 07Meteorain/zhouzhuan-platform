# -*- coding: utf-8 -*-
"""深度排查两个源文件：所有 sheet / 所有行列 / 隐藏内容 / 公式 / 合并单元格"""
import sys, os
sys.stdout.reconfigure(encoding='utf-8')
import xlrd, openpyxl

DESK = r'C:\Users\Administrator\Desktop'

print('=' * 72)
print('【一】周转物资-车队三楼库存清单.xls')
print('=' * 72)
b = xlrd.open_workbook(os.path.join(DESK, '周转物资-车队三楼库存清单(1).xls'),
                      formatting_info=False)
print(f'sheet 列表: {b.sheet_names()}  (共 {b.nsheets} 个)')
for si in range(b.nsheets):
    sh = b.sheet_by_index(si)
    print(f'\n--- Sheet[{si}] "{sh.name}": {sh.nrows} 行 x {sh.ncols} 列 ---')
    if sh.nrows == 0:
        print('    （空 sheet）')
        continue
    for r in range(sh.nrows):
        cells = []
        for c in range(sh.ncols):
            v = sh.cell_value(r, c)
            t = sh.cell_type(r, c)
            if t == 2:      # 数字
                v = int(v) if float(v).is_integer() else round(v, 2)
            elif t == 0:
                v = ''
            cells.append(str(v)[:22])
        # 标出空行
        mark = '  <== 空行' if not any(cells) else ''
        print(f'  r{r}: ' + ' | '.join(cells) + mark)

print()
print('=' * 72)
print('【二】李师傅周转物资明细.xlsx')
print('=' * 72)
wb = openpyxl.load_workbook(os.path.join(DESK, '李师傅周转物资明细(1).xlsx'),
                            read_only=False, data_only=True)
print(f'sheet 列表: {wb.sheetnames}  (共 {len(wb.sheetnames)} 个)')
for name in wb.sheetnames:
    ws = wb[name]
    print(f'\n--- sheet "{name}": {ws.max_row} 行 x {ws.max_column} 列 ---')
    print(f'    合并单元格: {[str(m) for m in ws.merged_cells.ranges] or "无"}')
    for r in range(1, ws.max_row + 1):
        vals = []
        for c in range(1, ws.max_column + 1):
            v = ws.cell(row=r, column=c).value
            vals.append('' if v is None else str(v)[:24])
        mark = '  <== 空行' if not any(vals) else ''
        print(f'  r{r}: ' + ' | '.join(vals) + mark)
    # 隐藏行
    hidden = [r for r, d in ws.row_dimensions.items() if d.hidden]
    if hidden:
        print(f'    隐藏行: {hidden}')
wb.close()

print()
print('=' * 72)
print('【三】两个文件是否与已入库数据一致')
print('=' * 72)
import json, os
pj = r'C:\Users\Administrator\WorkBuddy\2026-10-14-15-00-19\zhouzhuan-platform\scripts\import_payload.json'
if os.path.exists(pj):
    d = json.load(open(pj, encoding='utf-8'))
    print(f"payload 中 materials_chedui {len(d['materials_chedui'])} 条，materials_lishifu {len(d['materials_lishifu'])} 条")
else:
    print('payload 不存在')