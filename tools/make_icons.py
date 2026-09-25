import asyncio
import sys
from pathlib import Path

from playwright.async_api import async_playwright

ICONS = Path(__file__).resolve().parent.parent / "icons"
COLORS = {
    "brand": ("#4f6bff", "#7ddfa0"),
    "active": ("#1fa971", "#d6ffe9"),
    "pending": ("#e8a33d", "#fff1d6"),
    "idle": ("#4c5866", "#aab6c6"),
    "off": ("#5c6067", "#9aa0a6"),
}
SIZES = {"brand": (16, 32, 48, 128), "active": (16, 32), "pending": (16, 32), "idle": (16, 32), "off": (16, 32)}


def svg(background, dot, size):
    node = size >= 32
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 32 32">
  <rect x="0" y="0" width="32" height="32" rx="8" fill="{background}"/>
  <g transform="translate(-0.6 -2.4) scale(0.92)">
    <path d="M9.5 23.5V8.5h6.2a4.1 4.1 0 0 1 0 8.2h-2.4l5 6.8" fill="none" stroke="#ffffff"
          stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  {f'<circle cx="24.6" cy="8.6" r="2.5" fill="{dot}"/>' if node else ""}
</svg>"""


async def main():
    ICONS.mkdir(exist_ok=True)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(channel="chromium")
        page = await browser.new_page()
        for name, (background, dot) in COLORS.items():
            for size in SIZES[name]:
                await page.set_viewport_size({"width": size, "height": size})
                await page.set_content(
                    f'<body style="margin:0">{svg(background, dot, size)}</body>',
                    wait_until="load",
                )
                await page.screenshot(path=ICONS / f"{name}-{size}.png", omit_background=True)
                print(f"{name}-{size}.png")
        await browser.close()
    (ICONS / "icon.svg").write_text(svg(COLORS["brand"][0], COLORS["brand"][1], 128), encoding="utf-8")


asyncio.run(main())
