from pathlib import Path
from shutil import copyfile

from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph


ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT.parent / "output" / "pdf"
OUTPUT = OUTPUT_DIR / "みちのーと_サービス概要_A4_2ページ.pdf"
LEGACY_OUTPUT = ROOT / "みちのーと資料.pdf"

FONT_REGULAR = r"C:\Windows\Fonts\YuGothR.ttc"
FONT_BOLD = r"C:\Windows\Fonts\YuGothB.ttc"

W, H = A4
M = 42

INK = HexColor("#16363A")
MUTED = HexColor("#687A79")
LAKE = HexColor("#0F4449")
LAKE_2 = HexColor("#1D666B")
TEAL = HexColor("#2F7A7E")
SAGE = HexColor("#8BA88B")
SAGE_SOFT = HexColor("#E9F0E6")
CREAM = HexColor("#F5F1E7")
PAPER = HexColor("#FFFCF6")
LINE = HexColor("#D7DED7")
ORANGE = HexColor("#E27B45")
ORANGE_SOFT = HexColor("#FDEDE2")
BLUE_SOFT = HexColor("#E5F0F0")
SOFT_WHITE = HexColor("#F7F5EC")


def register_fonts():
    pdfmetrics.registerFont(TTFont("YuGothic", FONT_REGULAR, subfontIndex=0))
    pdfmetrics.registerFont(TTFont("YuGothic-Bold", FONT_BOLD, subfontIndex=0))


def paragraph(
    c,
    text,
    x,
    top,
    width,
    font_size=10,
    color=INK,
    leading=None,
    bold=False,
    align=0,
):
    style = ParagraphStyle(
        "body",
        fontName="YuGothic-Bold" if bold else "YuGothic",
        fontSize=font_size,
        leading=leading or font_size * 1.55,
        textColor=color,
        alignment=align,
        spaceAfter=0,
        spaceBefore=0,
        allowWidows=0,
        allowOrphans=0,
    )
    p = Paragraph(text, style)
    _, height = p.wrap(width, 1000)
    p.drawOn(c, x, top - height)
    return height


def rounded(c, x, y, width, height, fill, stroke=None, radius=12, line_width=0.8):
    c.setFillColor(fill)
    c.setStrokeColor(stroke or fill)
    c.setLineWidth(line_width)
    c.roundRect(x, y, width, height, radius, fill=1, stroke=1 if stroke else 0)


def pill(c, text, x, y, width, fill, color, font_size=7.8):
    rounded(c, x, y, width, 20, fill, radius=10)
    c.setFillColor(color)
    c.setFont("YuGothic-Bold", font_size)
    c.drawCentredString(x + width / 2, y + 6.1, text)


def small_footer(c, page, dark=False):
    color = HexColor("#C7D9D6") if dark else MUTED
    line = HexColor("#3B676A") if dark else LINE
    c.setStrokeColor(line)
    c.setLineWidth(0.7)
    c.line(M, 31, W - M, 31)
    c.setFillColor(color)
    c.setFont("YuGothic", 7.5)
    c.drawString(M, 17, "みちのーと  |  個別支援計画ワークベンチ  |  サービス紹介")
    c.drawRightString(W - M, 17, f"{page:02d} / 02")


def page_one(c):
    c.setFillColor(CREAM)
    c.rect(0, 0, W, H, fill=1, stroke=0)

    dark_bottom = 292
    c.setFillColor(LAKE)
    c.rect(0, dark_bottom, W, H - dark_bottom, fill=1, stroke=0)

    # Decorative support-cycle rings.
    c.setStrokeColor(HexColor("#2B6165"))
    c.setLineWidth(1)
    for radius in (78, 126, 175):
        c.circle(W - 38, H - 73, radius, stroke=1, fill=0)

    c.setFillColor(ORANGE)
    c.setFont("YuGothic-Bold", 8.5)
    c.drawString(M, H - 52, "MICHINOTE  /  SERVICE BRIEF")
    c.setFillColor(SOFT_WHITE)
    c.setFont("YuGothic-Bold", 19)
    c.drawString(M, H - 92, "みちのーと")
    c.setFillColor(HexColor("#B7CDCA"))
    c.setFont("YuGothic", 8.8)
    c.drawString(M, H - 111, "放課後等デイサービスのための 個別支援計画ワークベンチ")

    c.setFillColor(SOFT_WHITE)
    c.setFont("YuGothic-Bold", 31)
    c.drawString(M, H - 225, "日誌を、")
    c.drawString(M, H - 274, "次の支援の根拠に。")
    paragraph(
        c,
        "日々の記録・連絡帳・相談支援の方針をひとつにつなぎ、<br/>"
        "面談、モニタリング、個別支援計画の下書きづくりを支えます。",
        M,
        H - 320,
        335,
        10.2,
        HexColor("#C7D9D6"),
        18,
    )

    # Right-side cycle spine.
    spine_x = 431
    c.setStrokeColor(HexColor("#89B6B2"))
    c.setLineWidth(1.7)
    c.line(spine_x, H - 216, spine_x, H - 493)
    cycle_items = [
        ("1", "相談支援の方針", "本人・家族の希望を受け取る"),
        ("2", "事業所でアセスメント", "支援の進め方をすり合わせる"),
        ("3", "日誌・連絡帳", "日々の様子と家庭の声を残す"),
        ("4", "モニタリング", "期間の変化と課題を振り返る"),
        ("5", "次の個別支援計画", "根拠をもとに下書きを整える"),
    ]
    for index, (number, title, body) in enumerate(cycle_items):
        cy = H - 216 - index * 69
        accent = ORANGE if index in (0, 4) else HexColor("#99C2BD")
        c.setFillColor(accent)
        c.circle(spine_x, cy, 8, fill=1, stroke=0)
        c.setFillColor(white)
        c.setFont("YuGothic-Bold", 7)
        c.drawCentredString(spine_x, cy - 2.5, number)
        c.setFillColor(SOFT_WHITE)
        c.setFont("YuGothic-Bold", 9.3)
        c.drawString(spine_x + 18, cy + 1, title)
        c.setFillColor(HexColor("#ACC4C1"))
        c.setFont("YuGothic", 7.2)
        c.drawString(spine_x + 18, cy - 14, body)

    # Cream outcome panel.
    c.setFillColor(ORANGE)
    c.setFont("YuGothic-Bold", 8.3)
    c.drawString(M, 257, "記録を、次の支援に変えるために")
    c.setFillColor(INK)
    c.setFont("YuGothic-Bold", 19)
    c.drawString(M, 222, "支援の意図が、途中で途切れない。")

    c.setStrokeColor(LINE)
    c.setLineWidth(0.8)
    c.line(M, 194, W - M, 194)

    benefit_width = (W - 2 * M) / 3
    benefits = [
        ("01", "方針をつなぐ", "サービス等利用計画（案）から<br/>事業所の支援方針へ"),
        ("02", "根拠を残す", "日誌・連絡帳を<br/>下書きの根拠としてたどれる"),
        ("03", "見直しを支える", "モニタリングから<br/>次の支援計画へつなげる"),
    ]
    for index, (number, title, body) in enumerate(benefits):
        x = M + index * benefit_width
        if index:
            c.setStrokeColor(LINE)
            c.line(x, 86, x, 176)
        c.setFillColor(ORANGE)
        c.setFont("YuGothic-Bold", 8.1)
        c.drawString(x + (14 if index else 0), 166, number)
        c.setFillColor(INK)
        c.setFont("YuGothic-Bold", 11.5)
        c.drawString(x + (14 if index else 0), 140, title)
        paragraph(
            c,
            body,
            x + (14 if index else 0),
            118,
            benefit_width - 26,
            8.1,
            MUTED,
            14,
        )

    c.setFillColor(LAKE)
    c.rect(0, 0, W, 48, fill=1, stroke=0)
    small_footer(c, 1, dark=True)


def flow_card(c, number, label, title, body, x, y, width, height, fill, accent):
    rounded(c, x, y, width, height, fill, LINE, radius=11)
    c.setFillColor(accent)
    c.circle(x + 18, y + height - 18, 9, fill=1, stroke=0)
    c.setFillColor(white)
    c.setFont("YuGothic-Bold", 7.3)
    c.drawCentredString(x + 18, y + height - 20.5, str(number))
    c.setFillColor(accent)
    c.setFont("YuGothic-Bold", 7.1)
    c.drawString(x + 34, y + height - 20.5, label)
    paragraph(c, title, x + 13, y + height - 42, width - 26, 10, INK, 14, bold=True)
    paragraph(c, body, x + 13, y + height - 67, width - 26, 7.6, MUTED, 11.8)


def mini_feature(c, kicker, title, body, x, y, width, accent):
    c.setFillColor(accent)
    c.rect(x, y, 4, 78, fill=1, stroke=0)
    c.setFillColor(accent)
    c.setFont("YuGothic-Bold", 7.1)
    c.drawString(x + 13, y + 64, kicker)
    c.setFillColor(INK)
    c.setFont("YuGothic-Bold", 10.1)
    c.drawString(x + 13, y + 43, title)
    paragraph(c, body, x + 13, y + 31, width - 15, 7.5, MUTED, 11.8)


def page_two(c):
    c.setFillColor(CREAM)
    c.rect(0, 0, W, H, fill=1, stroke=0)
    c.setFillColor(LAKE)
    c.rect(0, H - 13, W, 13, fill=1, stroke=0)

    c.setFillColor(ORANGE)
    c.setFont("YuGothic-Bold", 8.3)
    c.drawString(M, H - 55, "HOW IT WORKS")
    c.setFillColor(INK)
    c.setFont("YuGothic-Bold", 24)
    c.drawString(M, H - 94, "支援は、ひとつの書類で終わらない。")
    paragraph(
        c,
        "相談支援の方針から日々の記録、モニタリング、次の計画まで。<br/>"
        "利用児ごとの支援サイクルを、根拠がたどれる形でつなぎます。",
        M,
        H - 122,
        W - 2 * M,
        9.2,
        MUTED,
        15.5,
    )

    pill(c, "利用開始", M, H - 178, 66, ORANGE_SOFT, ORANGE)
    c.setFillColor(MUTED)
    c.setFont("YuGothic-Bold", 7.5)
    c.drawString(M + 78, H - 171, "本人・家族・相談支援・事業所をつなぐ6つのステップ")

    gap = 10
    card_width = (W - 2 * M - gap * 2) / 3
    card_height = 105
    first_row_y = H - 303
    second_row_y = H - 423
    cards = [
        (1, "相談", "相談・面談", "相談支援員が、本人・家族の希望や困りごと、望む生活を聞き取ります。", ORANGE_SOFT, ORANGE),
        (2, "全体方針", "サービス等利用計画（案）", "生活全体の目標と、各サービスが担う役割を別の文書として整理します。", ORANGE_SOFT, ORANGE),
        (3, "把握", "事業所アセスメント", "全体方針を受け、現在の状況・強み・課題と支援の進め方を整理します。", BLUE_SOFT, TEAL),
        (4, "計画", "個別支援計画", "目標、具体的な支援、担当、評価時期を確認し、説明・同意後に確定します。", SAGE_SOFT, SAGE),
        (5, "実施", "日誌・連絡帳", "支援内容、本人の反応、家庭からの要望を、計画の目標と結び付けて記録します。", BLUE_SOFT, TEAL),
        (6, "評価・更新", "モニタリングと次期計画", "期間の記録を振り返り、続ける支援や見直す点を次の計画へつなげます。", SAGE_SOFT, SAGE),
    ]
    for index, card in enumerate(cards):
        row = 0 if index < 3 else 1
        col = index % 3
        x = M + col * (card_width + gap)
        y = first_row_y if row == 0 else second_row_y
        number, label, title, body, fill, accent = card
        flow_card(c, number, label, title, body, x, y, card_width, card_height, fill, accent)

    # Flow arrows between cards and rows.
    c.setStrokeColor(HexColor("#A7B8B4"))
    c.setFillColor(HexColor("#A7B8B4"))
    c.setLineWidth(1)
    for row_y in (first_row_y, second_row_y):
        for col in (0, 1):
            start_x = M + (col + 1) * card_width + col * gap + 2
            cy = row_y + card_height / 2
            c.line(start_x, cy, start_x + gap - 4, cy)
            c.line(start_x + gap - 7, cy + 2, start_x + gap - 4, cy)
            c.line(start_x + gap - 7, cy - 2, start_x + gap - 4, cy)

    # Outcome summary.
    section_top = H - 463
    c.setFillColor(INK)
    c.setFont("YuGothic-Bold", 14)
    c.drawString(M, section_top, "みちのーとが残すもの")
    paragraph(
        c,
        "「何を根拠に、どのような支援を選んだか」を、あとから確認できる状態にします。",
        M,
        section_top - 12,
        W - 2 * M,
        8.3,
        MUTED,
        13,
    )

    feature_y = 220
    feature_gap = 14
    feature_width = (W - 2 * M - feature_gap * 2) / 3
    mini_feature(c, "01 / TRACE", "方針のつながり", "相談支援の方針から、事業所で行う支援までを一続きで確認。", M, feature_y, feature_width, ORANGE)
    mini_feature(c, "02 / EVIDENCE", "日々の根拠", "下書きに使った日誌・連絡帳をたどり、内容を検討できます。", M + feature_width + feature_gap, feature_y, feature_width, TEAL)
    mini_feature(c, "03 / REVIEW", "見直しの材料", "モニタリングの結果を、次の個別支援計画の検討へ引き継ぎます。", M + (feature_width + feature_gap) * 2, feature_y, feature_width, SAGE)

    c.setFillColor(MUTED)
    c.setFont("YuGothic-Bold", 6.8)
    c.drawCentredString(
        W / 2,
        202,
        "正式提供に向けた設計：法人・事業所単位の権限管理  ｜  同時編集の競合検知  ｜  版管理・操作履歴  ｜  AWS本番構成を準備",
    )

    # Human-review and trust band.
    band_y = 78
    rounded(c, M, band_y, W - 2 * M, 108, LAKE, radius=14)
    pill(c, "大切にすること", M + 16, band_y + 72, 94, HexColor("#275C60"), ORANGE, 7.3)
    c.setFillColor(SOFT_WHITE)
    c.setFont("YuGothic-Bold", 14)
    c.drawString(M + 16, band_y + 44, "下書きは、専門職の判断の代わりではありません。")
    paragraph(
        c,
        "日誌から自動で入るのは、根拠を持つ候補だけ。本人・家族の意向と専門職の確認をもとに、<br/>"
        "内容を編集・説明・同意してから正式な計画として確定します。",
        M + 16,
        band_y + 32,
        W - 2 * M - 32,
        7.7,
        HexColor("#C7D9D6"),
        12.5,
    )

    c.setFillColor(ORANGE)
    c.setFont("YuGothic-Bold", 7.5)
    c.drawString(M, 57, "デモでご確認いただけること")
    c.setFillColor(INK)
    c.setFont("YuGothic-Bold", 9.3)
    c.drawString(M + 125, 57, "利用児の切替から、記録・下書き・確認・PDF出力までを一連で体験できます。")
    small_footer(c, 2, dark=False)


def build():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    register_fonts()
    c = canvas.Canvas(str(OUTPUT), pagesize=A4, pageCompression=1)
    c.setTitle("みちのーと サービス概要")
    c.setAuthor("みちのーと")
    c.setSubject("放課後等デイサービス向け 個別支援計画ワークベンチ")
    c.setCreator("みちのーと サービス資料ジェネレーター")
    page_one(c)
    c.showPage()
    page_two(c)
    c.save()
    copyfile(OUTPUT, LEGACY_OUTPUT)
    print(OUTPUT)


if __name__ == "__main__":
    build()
