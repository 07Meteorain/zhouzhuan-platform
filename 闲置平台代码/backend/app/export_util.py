# -*- coding: utf-8 -*-
"""
交接单导出工具：生成标准 Word（.docx）与 PDF
------------------------------------------------------------------
被 routers/handovers.py 的 GET /api/handovers/{no}/export 调用。

设计要点：
  1. 服务端真实生成，不依赖浏览器打印，产出的是标准 docx / pdf 文件，可直接存档；
  2. 内容严格对齐设计说明书 2.5 交接单字段清单，末尾保留签字栏；
  3. PDF 中文字体按「系统字体 -> reportlab 内置 CID 字体」三级回退，
     保证 Windows 开发机与 Linux 容器（无中文字体包）都能正常出中文。
"""
import io
import os

# ---------------------------------------------------------------- 字段定义

# 两列表格：每行两个字段（左标签、右标签）
FIELD_ROWS = [
    ("asset_no", "资产编号", "asset_name", "资产名称"),
    ("unit", "计量单位", "quantity", "数量"),
    ("from_dept_name", "转出部门", "to_dept_name", "转入部门"),
    ("receiver_name", "接收人姓名", "receiver_emp_no", "接收人工号"),
    ("using_person", "使用人", "usage_direction", "使用方向"),
    ("manage_dept", "使用的管理部门", "location", "存放地点"),
    ("contact_person", "联系人", "contact_phone", "联系电话"),
    ("claim_time", "交接时间", "generated_time", "生成时间"),
]

FULL_WIDTH_ROWS = [
    ("category", "分类"),
    ("spec", "尺寸规格"),
    ("condition_desc", "成色/状态说明"),
    ("remark", "备注"),
]


def _text(detail: dict, key: str) -> str:
    v = detail.get(key, "")
    if v is None:
        return "-"
    s = str(v).strip()
    return s if s else "-"


def _two_column_rows(detail: dict):
    """
    产出主体表格行（docx / pdf 共用，保证两种格式内容完全一致）。
    FIELD_ROWS 每项为 (左键, 左标签, 右键, 右标签)，
    返回 [(左标签, 左值, 右标签, 右值), ...]
    """
    return [
        (label1, _text(detail, key1), label2, _text(detail, key2))
        for key1, label1, key2, label2 in FIELD_ROWS
    ]


def _full_width_rows(detail: dict):
    """产出整行字段（分类 / 尺寸规格 / 成色说明 / 备注），返回 [(标签, 值), ...]"""
    return [(label, _text(detail, key)) for key, label in FULL_WIDTH_ROWS]


# ---------------------------------------------------------------- Word

def build_docx(detail: dict) -> bytes:
    """生成 .docx：标题 + 单号 + 字段表 + 签字栏"""
    from docx import Document
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    doc = Document()
    # 中文字体：设置默认样式，避免 Word 打开时中文回退成宋体以外的字体导致排版异常
    style = doc.styles["Normal"]
    style.font.name = "宋体"
    style.font.size = Pt(10.5)

    title = doc.add_heading("闲置资产交接单", level=0)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    sub = doc.add_paragraph(f"公共资产闲置平台 · 单号 {_text(detail, 'handover_no')}")
    sub.alignment = WD_ALIGN_PARAGRAPH.CENTER

    table = doc.add_table(rows=0, cols=4)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER

    for label1, value1, label2, value2 in _two_column_rows(detail):
        cells = table.add_row().cells
        cells[0].text = label1
        cells[1].text = value1
        cells[2].text = label2
        cells[3].text = value2

    for label, value in _full_width_rows(detail):
        cells = table.add_row().cells
        cells[0].text = label
        # 合并后三列作为值区域
        merged = cells[1].merge(cells[2]).merge(cells[3])
        merged.text = value

    doc.add_paragraph()
    sign = doc.add_table(rows=2, cols=4)
    sign.style = "Table Grid"
    hdr = sign.rows[0].cells
    hdr[0].text = "转出部门签字"
    hdr[1].text = ""
    hdr[2].text = "转入部门签字"
    hdr[3].text = ""
    row2 = sign.rows[1].cells
    row2[0].text = "经办人签字"
    row2[1].text = ""
    row2[2].text = "日期"
    row2[3].text = ""

    doc.add_paragraph()
    tip = doc.add_paragraph(
        "本交接单由公共资产闲置平台生成，流转记录与打印行为均记入日志中心，不可删除。"
    )
    tip.runs[0].font.size = Pt(9)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


# ---------------------------------------------------------------- PDF

_CJK_FONT_NAME = None


def _register_cjk_font():
    """
    注册 PDF 中文字体，返回字体名。
    优先级：系统中文字体文件 -> reportlab 内置 Adobe CID 字体（STSong-Light，无需字体文件）
    """
    global _CJK_FONT_NAME
    if _CJK_FONT_NAME:
        return _CJK_FONT_NAME

    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    candidates = [
        # Windows
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simsun.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        # Linux 常见中文字体
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/arphic/uming.ttc",
        "/usr/share/fonts/truetype/arphic/ukai.ttc",
        # macOS
        "/System/Library/Fonts/PingFang.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                pdfmetrics.registerFont(TTFont("PAIP-CJK", path))
                _CJK_FONT_NAME = "PAIP-CJK"
                return _CJK_FONT_NAME
            except Exception:
                continue

    # 回退：Adobe 简体中文 CID 字体，reportlab 内置，不依赖任何字体文件
    try:
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont

        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        _CJK_FONT_NAME = "STSong-Light"
        return _CJK_FONT_NAME
    except Exception:
        _CJK_FONT_NAME = "Helvetica"
        return _CJK_FONT_NAME


def build_pdf(detail: dict) -> bytes:
    """生成 .pdf：标题 + 单号 + 字段表 + 签字栏"""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    font = _register_cjk_font()
    title_style = ParagraphStyle(
        "PAIPTitle", fontName=font, fontSize=18, leading=24, alignment=TA_CENTER,
        spaceAfter=4,
    )
    sub_style = ParagraphStyle(
        "PAIPSub", fontName=font, fontSize=9, leading=14, alignment=TA_CENTER,
        textColor=colors.HexColor("#666666"), spaceAfter=12,
    )
    cell_style = ParagraphStyle("PAIPCell", fontName=font, fontSize=9, leading=13)
    head_style = ParagraphStyle(
        "PAIPHead", fontName=font, fontSize=9, leading=13,
        textColor=colors.HexColor("#333333"),
    )
    foot_style = ParagraphStyle(
        "PAIPFoot", fontName=font, fontSize=8, leading=12,
        textColor=colors.HexColor("#666666"),
    )

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=f"闲置资产交接单 {_text(detail, 'handover_no')}",
    )

    story = [
        Paragraph("闲置资产交接单", title_style),
        Paragraph(f"公共资产闲置平台 · 单号 {_text(detail, 'handover_no')}", sub_style),
    ]

    # 主体字段：两列一组
    data = []
    for label1, value1, label2, value2 in _two_column_rows(detail):
        data.append([
            Paragraph(label1, head_style),
            Paragraph(value1, cell_style),
            Paragraph(label2, head_style),
            Paragraph(value2, cell_style),
        ])
    for label, value in _full_width_rows(detail):
        data.append([
            Paragraph(label, head_style),
            Paragraph(value, cell_style),
            "",
            "",
        ])

    table = Table(data, colWidths=[28 * mm, 52 * mm, 28 * mm, 52 * mm])
    table.setStyle(
        TableStyle([
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#b9bec7")),
            ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f5f6f8")),
            ("BACKGROUND", (2, 0), (2, -1), colors.HexColor("#f5f6f8")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            # 整行值的字段（分类/规格/成色/备注）跨后三列
            ("SPAN", (1, len(FIELD_ROWS)), (3, len(FIELD_ROWS))),
            ("SPAN", (1, len(FIELD_ROWS) + 1), (3, len(FIELD_ROWS) + 1)),
            ("SPAN", (1, len(FIELD_ROWS) + 2), (3, len(FIELD_ROWS) + 2)),
            ("SPAN", (1, len(FIELD_ROWS) + 3), (3, len(FIELD_ROWS) + 3)),
        ])
    )
    story.append(table)
    story.append(Spacer(1, 10 * mm))

    # 签字栏：留出空白供手写
    sign_data = [
        [
            Paragraph("转出部门签字", head_style),
            Paragraph("", cell_style),
            Paragraph("转入部门签字", head_style),
            Paragraph("", cell_style),
        ],
        [
            Paragraph("经办人签字", head_style),
            Paragraph("", cell_style),
            Paragraph("日期", head_style),
            Paragraph("", cell_style),
        ],
    ]
    sign = Table(sign_data, colWidths=[28 * mm, 52 * mm, 28 * mm, 52 * mm], rowHeights=[22 * mm, 18 * mm])
    sign.setStyle(
        TableStyle([
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#b9bec7")),
            ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f5f6f8")),
            ("BACKGROUND", (2, 0), (2, -1), colors.HexColor("#f5f6f8")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ])
    )
    story.append(sign)
    story.append(Spacer(1, 6 * mm))
    story.append(
        Paragraph(
            "本交接单由公共资产闲置平台生成，流转记录与打印行为均记入日志中心，不可删除。",
            foot_style,
        )
    )

    doc.build(story)
    return buf.getvalue()
