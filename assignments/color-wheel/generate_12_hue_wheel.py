from math import cos, radians, sin
from pathlib import Path


SIZE = 800
CX = CY = SIZE / 2
OUTER_R = 280
INNER_R = 170

COLORS = [
    ("红", "#e53935"),
    ("红橙", "#f4511e"),
    ("橙", "#fb8c00"),
    ("黄橙", "#fbc02d"),
    ("黄", "#fdd835"),
    ("黄绿", "#c0ca33"),
    ("绿", "#43a047"),
    ("蓝绿", "#26a69a"),
    ("蓝", "#1e88e5"),
    ("蓝紫", "#5e35b1"),
    ("紫", "#8e24aa"),
    ("红紫", "#d81b60"),
]


def polar(radius: float, angle_deg: float) -> tuple[float, float]:
    angle = radians(angle_deg - 90)
    return CX + radius * cos(angle), CY + radius * sin(angle)


def ring_wedge(start_deg: float, end_deg: float) -> str:
    x1, y1 = polar(OUTER_R, start_deg)
    x2, y2 = polar(OUTER_R, end_deg)
    x3, y3 = polar(INNER_R, end_deg)
    x4, y4 = polar(INNER_R, start_deg)
    large_arc = 1 if end_deg - start_deg > 180 else 0
    return (
        f"M {x1:.2f} {y1:.2f} "
        f"A {OUTER_R} {OUTER_R} 0 {large_arc} 1 {x2:.2f} {y2:.2f} "
        f"L {x3:.2f} {y3:.2f} "
        f"A {INNER_R} {INNER_R} 0 {large_arc} 0 {x4:.2f} {y4:.2f} Z"
    )


def build_svg() -> str:
    pieces = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}">',
        """
        <defs>
          <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="10" stdDeviation="18" flood-color="#111827" flood-opacity="0.18"/>
          </filter>
        </defs>
        """,
        '<rect width="100%" height="100%" fill="#f8fafc"/>',
        f'<circle cx="{CX}" cy="{CY}" r="{OUTER_R + 36}" fill="#fff" filter="url(#shadow)"/>',
    ]

    step = 360 / len(COLORS)
    for i, (name, color) in enumerate(COLORS):
        start = i * step
        end = (i + 1) * step
        mid = start + step / 2
        lx, ly = polar(OUTER_R + 50, mid)
        pieces.append(
            f'<path d="{ring_wedge(start, end)}" fill="{color}" stroke="#ffffff" stroke-width="4"/>'
        )
        pieces.append(
            f'<text x="{lx:.2f}" y="{ly:.2f}" fill="#111827" font-size="20" '
            f'font-family="Arial, Helvetica, sans-serif" text-anchor="middle" dominant-baseline="middle">'
            f'{name}</text>'
        )

    pieces.extend(
        [
            f'<circle cx="{CX}" cy="{CY}" r="{INNER_R - 18}" fill="#ffffff"/>',
            f'<circle cx="{CX}" cy="{CY}" r="{INNER_R - 18}" fill="none" stroke="#d1d5db" stroke-width="2"/>',
            f'<text x="{CX}" y="{CY - 16}" fill="#111827" font-size="34" font-weight="700" '
            f'font-family="Arial, Helvetica, sans-serif" text-anchor="middle">12色相环</text>',
            f'<text x="{CX}" y="{CY + 24}" fill="#4b5563" font-size="18" '
            f'font-family="Arial, Helvetica, sans-serif" text-anchor="middle">红 - 红橙 - 橙 - 黄橙 - 黄 - 黄绿</text>',
            f'<text x="{CX}" y="{CY + 52}" fill="#4b5563" font-size="18" '
            f'font-family="Arial, Helvetica, sans-serif" text-anchor="middle">绿 - 蓝绿 - 蓝 - 蓝紫 - 紫 - 红紫</text>',
            "</svg>",
        ]
    )
    return "\n".join(pieces)


def main() -> None:
    output = Path(__file__).with_name("12_hue_wheel.svg")
    output.write_text(build_svg(), encoding="utf-8")
    print(f"Wrote {output}")


if __name__ == "__main__":
    main()
