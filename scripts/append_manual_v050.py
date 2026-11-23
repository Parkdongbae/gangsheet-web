# -*- coding: utf-8 -*-
"""사용자 메뉴얼 PDF에 'v0.5.0 업데이트 안내' 섹션을 추가한다 (재현 가능한 생성 스크립트).

사용: 프로젝트 루트에서
  uv run --with pypdf --with reportlab python scripts/append_manual_v050.py
(pypdf·reportlab이 설치된 파이썬이면 직접 실행해도 된다)

- resources/ 원본에 덧붙인 뒤 web/public/ 사본도 같은 내용으로 맞춘다.
- 이미 v0.5.0 섹션이 있으면 그 페이지들을 걷어내고 다시 붙인다(여러 번 실행해도 중복 없음).
"""
import shutil
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

ROOT = Path(__file__).resolve().parent.parent
MANUAL = ROOT / "resources" / "DTF_사용자_메뉴얼.pdf"
WEB_COPY = ROOT / "web" / "public" / "DTF_사용자_메뉴얼.pdf"
FONT = Path("C:/Windows/Fonts/malgun.ttf")
FONT_BOLD = Path("C:/Windows/Fonts/malgunbd.ttf")

pdfmetrics.registerFont(TTFont("Malgun", str(FONT)))
pdfmetrics.registerFont(TTFont("MalgunBold", str(FONT_BOLD)))
registerFontFamily(
    "Malgun", normal="Malgun", bold="MalgunBold", italic="Malgun", boldItalic="MalgunBold"
)

TITLE = "v0.5.0 업데이트 안내"
#: 섹션 식별 문구 — 재실행 시 기존 섹션 페이지를 찾아 걷어내는 기준
MARKER = "v0.5.0 업데이트 안내"

H2 = ParagraphStyle("H2", fontName="Malgun", fontSize=16, leading=24, spaceAfter=6)
H3 = ParagraphStyle("H3", fontName="Malgun", fontSize=12, leading=18, spaceBefore=11, spaceAfter=4)
BODY = ParagraphStyle("BODY", fontName="Malgun", fontSize=10.5, leading=17)
SMALL = ParagraphStyle("SMALL", fontName="Malgun", fontSize=9, leading=14, textColor="#555555")
QUOTE = ParagraphStyle(
    "QUOTE", fontName="Malgun", fontSize=10.5, leading=17, leftIndent=14, textColor="#1f4f8f"
)
CELL = ParagraphStyle("CELL", fontName="Malgun", fontSize=9.5, leading=14)


def table(rows: list[list[str]], widths: list[float]) -> Table:
    data = [[Paragraph(cell, CELL) for cell in row] for row in rows]
    t = Table(data, colWidths=[w * mm for w in widths], repeatRows=1)
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef0ff")),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#c9cdd6")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    return t


def header(subtitle: str) -> list:
    """모든 페이지 첫 줄에 식별 문구를 둔다(재실행 시 섹션 페이지 판별용)."""
    return [Paragraph(f"<b>{TITLE}</b> — {subtitle}", H2)]


flow = [
    *header("화면이 밝고 쉬워졌습니다"),
    Paragraph(
        "이 섹션은 v0.5.0에서 바뀐 화면과 새 기능을 정리합니다. 앞쪽 본문(v0.1.0 기준)의 화면 "
        "설명과 다른 부분은 이 섹션이 우선합니다.",
        BODY,
    ),
    Paragraph("<b>1. 시작 화면</b>", H3),
    Paragraph(
        "프로그램을 열면 큰 안내 화면이 나옵니다. 오른쪽 <b>새 문서 만들기</b>에서 규격(롤·A4·A3)을 "
        "고르고, 롤이면 가로 폭(30·50·60·100cm 바로 선택 또는 목록)과 세로 길이(1m·2m)를 정한 뒤 "
        "<b>문서 만들기</b>를 누릅니다. 저장해 둔 작업은 <b>프로젝트 열기 (.dtf)</b>로 엽니다.",
        BODY,
    ),
    Paragraph(
        "<b>이어서 작업하기</b>: 웹 버전은 작업 내용을 자동으로 저장합니다. 이전 작업이 있으면 "
        "새 문서 카드 위에 “이어서 작업하기” 카드가 나타나고, 누르면 마지막 상태가 그대로 열립니다.",
        BODY,
    ),
    Paragraph("<b>2. 밝은 화면 / 어두운 화면</b>", H3),
    Paragraph(
        "기본은 밝은 화면입니다. 시작 화면 오른쪽 위의 <b>밝게 / 어둡게</b>, 또는 편집 화면 오른쪽 "
        "위의 해·달 모양 버튼으로 언제든 바꿀 수 있고 선택은 다음에도 유지됩니다.",
        BODY,
    ),
    Paragraph("<b>3. 편집 화면 구성</b>", H3),
    table(
        [
            ["위치", "내용"],
            [
                "상단 첫째 줄",
                "문서 이름 · 새 파일 · 열기 · 저장 · 실행취소 · 다시실행 / 오른쪽: 단축키 · "
                "화면 테마 · <b>내보내기</b>",
            ],
            [
                "상단 둘째 줄",
                "<b>이미지 추가</b> / 배치: 자동 배치 · 이미지 복제 · 채우기 · 안에 맞춤 / "
                "보기: 그리드 · 투명 배경 표시 / 여백 자동 제거",
            ],
            ["가운데", "캔버스(문서). 이미지가 없으면 “이미지를 여기에 끌어다 놓으세요” 안내가 보입니다."],
            ["오른쪽", "속성 패널 — 위치·크기, 정렬, 레이어 순서, 배경 제거, 업스케일, 이미지 복제"],
            ["하단", "문서 크기(cm·px) · 이미지 수 · 방향키 이동 거리 · 배율 · 화면 맞춤"],
        ],
        [32, 138],
    ),
    Spacer(1, 3 * mm),
    Paragraph(
        "예전에 화면 아래에 길게 적혀 있던 조작법은 상단의 <b>단축키</b> 버튼을 누르면 주제별로 "
        "정리된 창으로 볼 수 있습니다.",
        BODY,
    ),
    Paragraph("<b>4. 가장 빠른 작업 순서</b>", H3),
    Paragraph(
        "<b>①</b> 규격 고르고 문서 만들기 → <b>②</b> 이미지를 끌어다 놓기(여러 장 가능) → "
        "<b>③</b> 필요하면 이미지를 골라 <b>배경 제거</b> → <b>④</b> <b>자동 배치</b>로 빈틈없이 정리 → "
        "<b>⑤</b> <b>내보내기</b>에서 PSD·PNG·PDF 저장.",
        QUOTE,
    ),
    PageBreak(),
    *header("배경 제거"),
    Paragraph(
        "이미지를 선택하면 속성 패널의 <b>배경 제거</b>에서 방식을 고를 수 있습니다(웹 버전).",
        BODY,
    ),
    Spacer(1, 2 * mm),
    table(
        [
            ["방식", "알맞은 그림", "동작"],
            [
                "<b>AI 자동</b> (기본)",
                "인물·동물·제품 사진, 일러스트",
                "AI가 피사체를 알아보고 배경을 지웁니다. 흰 옷처럼 배경과 비슷한 색도 보존하고 "
                "머리카락 경계를 다듬습니다.",
            ],
            [
                "<b>단색 배경</b>",
                "흰 바탕의 로고·글자·도형",
                "가장자리와 이어진 한 가지 색 배경만 지웁니다. 글자·도형의 또렷한 경계가 그대로 "
                "남습니다. 사진에는 맞지 않습니다.",
            ],
        ],
        [30, 46, 94],
    ),
    Paragraph("<b>진행 상황 보기</b>", H3),
    Paragraph(
        "배경 제거를 누르면 버튼 아래에 진행 상자가 나타나 <b>현재 단계 · 전체 % · 남은 시간</b>을 "
        "보여 줍니다. 단계는 “AI 모델 내려받는 중 → AI 준비 중 → 배경 분석 중 → 경계 다듬는 중 → "
        "결과 저장 중” 순서입니다. 여러 장을 한꺼번에 처리하면 “몇 번째 / 전체 몇 개”도 표시됩니다.",
        BODY,
    ),
    Paragraph(
        "<b>처음 한 번만 오래 걸립니다</b>: AI 모델(그래픽카드 사용 시 약 85MB, 그렇지 않으면 약 "
        "170MB)을 처음에 한 번 내려받아 브라우저에 보관합니다. 다음부터는 내려받지 않고 한 장당 "
        "몇 초면 끝납니다. 남은 시간은 내 컴퓨터에서 실제로 걸린 시간을 기억해 점점 정확해집니다.",
        BODY,
    ),
    Paragraph(
        "<b>내 이미지는 밖으로 나가지 않습니다</b>: 배경 제거와 업스케일은 모두 내 컴퓨터 안에서 "
        "처리됩니다. 인터넷으로 오가는 것은 AI 모델 파일뿐입니다.",
        BODY,
    ),
    Paragraph("<b>문제가 생기면</b>", H3),
    table(
        [
            ["증상", "해결"],
            [
                "진행 상자가 4분 넘게 멈춰 있다가 오류가 뜬다",
                "인터넷 연결을 확인하고 다시 누릅니다. 계속되면 <b>단색 배경</b> 방식이나 아래의 "
                "다른 사이트를 이용합니다.",
            ],
            ["“피사체를 찾지 못했습니다”", "그림 전체가 한 덩어리로 보이는 경우입니다. <b>단색 배경</b> 방식을 써 보세요."],
            [
                "결과가 깨져 보인다(얼룩·줄무늬)",
                "그래픽 드라이버 문제일 수 있습니다. 브라우저를 최신으로 올리거나 다른 브라우저"
                "(Chrome·Edge)에서 시도합니다.",
            ],
            ["경계가 아쉽다", "<b>다른 배경 제거 사이트 보기</b>에서 외부 서비스를 이용한 뒤 PNG를 다시 올립니다."],
        ],
        [62, 108],
    ),
    Paragraph("<b>다른 배경 제거 사이트</b>", H3),
    Paragraph(
        "속성 패널의 <b>다른 배경 제거 사이트 보기</b>에는 <b>Canva</b>(맨 위) · Adobe Express · "
        "Erase.bg · Photoroom · Clipdrop이 정리되어 있습니다. 내려받은 PNG를 캔버스에 끌어다 놓으면 "
        "됩니다. 무료 다운로드가 저해상도인 Remove.bg는 목록에서 뺐습니다.",
        BODY,
    ),
    PageBreak(),
    *header("업스케일 · 기타"),
    Paragraph("<b>웹 버전도 AI 업스케일</b>", H3),
    Paragraph(
        "이전 웹 버전은 단순 확대(리샘플)라 크게 키우면 흐릿했습니다. 이제 웹에서도 AI(Real-ESRGAN)가 "
        "디테일을 복원하며 키웁니다. 사용법은 앞의 “AI 업스케일” 섹션과 같습니다.",
        BODY,
    ),
    Spacer(1, 2 * mm),
    table(
        [
            ["엔진", "알맞은 그림", "참고"],
            ["<b>일반 사진</b>", "사진, 그라데이션이 있는 그래픽", "그래픽카드를 사용해 빠릅니다."],
            [
                "<b>일러스트·애니</b>",
                "선이 뚜렷한 그림, 캐릭터, 로고",
                "선을 또렷하게 정리합니다. CPU로 처리해 조금 더 걸립니다.",
            ],
        ],
        [34, 62, 74],
    ),
    Spacer(1, 2 * mm),
    Paragraph(
        "진행 중에는 <b>전체 % · 타일 진행 수 · 남은 시간</b>이 표시되고 <b>취소</b>할 수 있습니다. "
        "1.5배 이하로 조금만 키울 때는 AI 없이 고품질 확대로 바로 처리합니다. 투명 배경은 그대로 "
        "유지됩니다. AI 모델(약 2~5MB)을 받지 못하면 일반 확대로 대신 처리하고 알려 줍니다.",
        BODY,
    ),
    Paragraph(
        "<b>권장</b>: 결과 한 변이 8,000px을 넘는 큰 확대는 시간이 오래 걸립니다(예: 1,000px → "
        "4,000px 약 20~30초). 아주 큰 작업이나 이어하기(중단 후 재개)는 데스크톱 버전을 권장합니다.",
        QUOTE,
    ),
    Paragraph("<b>웹 버전과 데스크톱 버전의 차이</b>", H3),
    table(
        [
            ["항목", "웹 버전", "데스크톱 버전"],
            ["PSD 색상 모드", "RGB 8bit · 350 DPI", "CMYK · 350 DPI"],
            ["배경 제거", "브라우저 내 AI + 단색 배경 방식", "내장 AI(오프라인 동작)"],
            ["업스케일", "브라우저 내 AI (이어하기 없음)", "내장 AI (이어하기 지원)"],
            ["저장", "자동 저장 + .dtf 파일(원본 내장)", ".dtf 파일"],
            ["권장 브라우저", "Chrome · Edge 최신 버전", "—"],
        ],
        [36, 67, 67],
    ),
    Spacer(1, 2 * mm),
    Paragraph(
        "인쇄소가 CMYK PSD를 요구하면 데스크톱 버전으로 내보내거나 PNG를 사용하세요. 웹 버전의 PSD는 "
        "별도의 백색(스폿) 채널을 만들지 않으며, 투명한 부분이 곧 인쇄되지 않는 영역입니다.",
        BODY,
    ),
    Paragraph("<b>바뀐 안내 (앞 본문과 다른 점)</b>", H3),
    Paragraph(
        "• FAQ의 “첫 사용 시 AI 모델 약 1GB” 안내는 더 이상 해당하지 않습니다(웹 85~170MB, "
        "데스크톱은 프로그램에 포함).<br/>"
        "• “작업 중간 저장을 지원하지 않는다”는 안내도 해당하지 않습니다 — <b>저장</b>(Ctrl+S)으로 "
        ".dtf 프로젝트 파일을 만들 수 있고 웹은 자동 저장됩니다.<br/>"
        "• 하단 단축키 힌트줄은 상단 <b>단축키</b> 버튼으로 옮겨졌습니다.<br/>"
        "• 오픈소스 라이선스 고지에 브라우저 AI 구성요소(onnxruntime-web, ISNet, Real-ESRGAN)가 "
        "추가되었습니다.",
        BODY,
    ),
    Spacer(1, 4 * mm),
    Paragraph("DTF GangSheet Studio v0.5.0 · 2026-11-23", SMALL),
]


def strip_existing_section(reader: PdfReader) -> list:
    """기존 v0.5.0 섹션 페이지를 제외한 페이지 목록."""
    return [page for page in reader.pages if MARKER not in (page.extract_text() or "")]


def main() -> None:
    section = ROOT / "scripts" / "_manual_section.pdf"
    doc = SimpleDocTemplate(
        str(section),
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=TITLE,
    )
    doc.build(flow)

    reader = PdfReader(str(MANUAL))
    kept = strip_existing_section(reader)
    writer = PdfWriter()
    for page in kept:
        writer.add_page(page)
    added = PdfReader(str(section)).pages
    for page in added:
        writer.add_page(page)
    with open(MANUAL, "wb") as fh:
        writer.write(fh)
    section.unlink()
    shutil.copyfile(MANUAL, WEB_COPY)
    print(f"manual: {len(kept)} + {len(added)} = {len(writer.pages)} pages (web copy synced)")


if __name__ == "__main__":
    main()
