# -*- coding: utf-8 -*-
"""
真实数据导入 —— 周转物资平台

源文件（仅这两份是周转物资）：
  1. 周转物资-车队三楼库存清单.xls车队三楼床上用品，7 条，负责人张巧玲
  2. 李师傅周转物资明细.xlsx          田径场 / 活动中心物资，11 条（含同名多规格）

不导入：
  · 资产信息查询.xlsx —— 里面的电脑、打印机等固定资产已分配到具体部门/使用人，
    不属于周转物资申领范畴，不进本平台数据库。

设计要点：
  · 同名不同规格必须视为不同物资条目，否则库存会混在一起
    （长条桌 160*40 / 120*50 / 120*40 各有独立数量）
  · 数量字段 "990+" 这类模糊值单独记录到 qty_note，total_qty 取下限 990
"""
import sys, os, re, json
sys.stdout.reconfigure(encoding='utf-8')
import xlrd, openpyxl

DESK = r'C:\Users\Administrator\Desktop'
PROJ = r'C:\Users\Administrator\WorkBuddy\2026-10-14-15-00-19\zhouzhuan-platform'
OUT_JSON = os.path.join(PROJ, 'scripts', 'import_payload.json')

# ---------- 源文件 1：车队三楼库存清单（OLE2 .xls）----------
def read_chedui():
    book = xlrd.open_workbook(os.path.join(DESK, '周转物资-车队三楼库存清单(1).xls'))
    sh = book.sheet_by_index(0)
    rows = []
    # r0 是大标题「周转物资」，r1 是表头，数据从 r2 开始
    for r in range(2, sh.nrows):
        name = str(sh.cell_value(r, 1)).strip()
        if not name:
            continue
        qty = sh.cell_value(r, 2)
        rows.append({
            'name': name,
            'spec': str(sh.cell_value(r, 3)).strip(),
            'qty': int(qty) if qty else 0,
            'location': str(sh.cell_value(r, 4)).strip(),
            'contact': str(sh.cell_value(r, 5)).strip(),
            'phone': str(int(sh.cell_value(r, 6))) if sh.cell_value(r, 6) else '',
            'category': '床上用品',
        })
    return rows

# ---------- 源文件 2：李师傅周转物资明细 ----------
# 该文件无联系人列，按存放地点推断负责老师
LOCATION_OWNER = {
    '田径场入口北侧': ('wh004', '田径场组王师傅'),
    '活动中心三楼，北八一楼': ('wh005', '活动中心刘师傅'),
    '北八一楼': ('wh005', '活动中心刘师傅'),
    '活动中心三楼': ('wh005', '活动中心刘师傅'),
    '田径场看台北侧': ('wh004', '田径场组王师傅'),
    '田径场西仓库': ('wh004', '田径场组王师傅'),
}
CATEGORY_BY_NAME = {
    '红木桌': '桌椅', '长条桌': '桌椅', '塑料凳': '桌椅', '黑皮椅': '桌椅',
    '平板车': '搬运工具', '隔离带': '场地器材', '电油汀': '电器', '电风扇': '电器', '马扎': '座椅',
}

def read_lishifu():
    wb = openpyxl.load_workbook(os.path.join(DESK, '李师傅周转物资明细(1).xlsx'), read_only=True, data_only=True)
    ws = wb.active
    rows = []
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i < 2:      # r0 大标题，r1 表头
            continue
        name = str(row[0]).strip() if row[0] else ''
        if not name:
            continue
        spec = str(row[1]).strip() if row[1] else ''
        unit = str(row[2]).strip() if row[2] else '件'
        qty_raw = str(row[3]).strip() if row[3] else '0'
        loc = str(row[4]).strip() if row[4] else ''

        # 处理 "990+" 这类模糊数量：取下限，原始值存 qty_note
        m = re.match(r'^(\d+)\s*\+\s*$', qty_raw)
        if m:
            qty, note = int(m.group(1)), f'约{qty_raw}'
        else:
            try:
                qty, note = int(float(qty_raw)), ''
            except ValueError:
                qty, note = 0, qty_raw

        owner = LOCATION_OWNER.get(loc, ('wh004', '田径场组王师傅'))
        rows.append({
            'name': name, 'spec': spec, 'unit': unit, 'qty': qty, 'qty_note': note,
            'location': loc, 'owner_username': owner[0], 'owner_name': owner[1],
            'category': CATEGORY_BY_NAME.get(name, '其他'),
        })
    wb.close()
    return rows

if __name__ == '__main__':
    chedui = read_chedui()
    lishifu = read_lishifu()
    payload = {'materials_chedui': chedui, 'materials_lishifu': lishifu}
    with open(OUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f'车队三楼库存清单：{len(chedui)} 条，合计 {sum(x["qty"] for x in chedui)} 件')
    for x in chedui:
        print(f'    {x["name"]:<6} {x["spec"]:<12} {x["qty"]:>5} {x["location"]} / {x["contact"]}')
    print(f'\n李师傅周转物资明细：{len(lishifu)} 条，合计 {sum(x["qty"] for x in lishifu)} 件')
    for x in lishifu:
        note = f'  [{x["qty_note"]}]' if x['qty_note'] else ''
        print(f'    {x["name"]:<6} {x["spec"]:<10} {x["qty"]:>5}{note}  {x["location"]} / {x["owner_name"]}')
    print(f'\n合计 {len(chedui)+len(lishifu)} 条，{sum(x["qty"] for x in chedui+lishifu)} 件')
    print(f'payload -> {OUT_JSON}')
