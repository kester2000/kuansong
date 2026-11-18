"""Render the archived Markdown action report and its contemporary map figures."""
import os
import subprocess
import tempfile
import json
import re
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageChops

base = Path(sys.argv[1])
font_path = next(p for p in (Path('C:/Windows/Fonts/msyh.ttc'), Path('C:/Windows/Fonts/simhei.ttf'),
                             Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')) if p.exists())
def font(size):
    return ImageFont.truetype(str(font_path), size)

def render_maps(frames):
    if not frames:
        return
    browser = next((p for p in [os.getenv('LN_SCREENSHOT_BROWSER'),
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe'] if p and Path(p).is_file()), None)
    if not browser:
        raise RuntimeError('生成看板配图需要 Edge 或 Chrome，可设置 LN_SCREENSHOT_BROWSER')
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        folder = Path(tmp)
        for i, frame in enumerate(frames):
            page = folder / f'{i}.html'
            shot = folder / f'{i}.png'
            page.write_text(frame['html'], encoding='utf8')
            subprocess.run([browser, '--headless', '--disable-gpu', '--disable-extensions',
                '--no-first-run', '--allow-file-access-from-files', '--hide-scrollbars',
                '--user-data-dir='+str(folder/'profile'), '--screenshot='+str(shot),
                '--window-size=900,'+str(frame['height']), page.as_uri()],
                timeout=30, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            with Image.open(shot) as image:
                rgb = image.convert('RGB')
                bounds = ImageChops.difference(rgb, Image.new('RGB',rgb.size,rgb.getpixel((0,0)))).getbbox()
                if not bounds:
                    raise RuntimeError('看板地图截图为空')
                rgb.crop((0,0,rgb.width,min(rgb.height,bounds[3]+12))).save(base.parent/frame['file'])

render_maps(json.loads(sys.stdin.buffer.read()))

width = 900
rows = []
for line in Path(str(base)+'.md').read_text(encoding='utf8').splitlines():
    picture = re.fullmatch(r'!\[.*?\]\(([^)]+)\)',line)
    if picture:
        with Image.open(base.parent/picture.group(1)) as src:
            figure = src.copy()
            if figure.width > width-72:
                figure = figure.resize((width-72, round(figure.height*(width-72)/figure.width)), Image.Resampling.LANCZOS)
            rows.append(('image',figure,figure.height+14))
        continue
    if not line:
        continue
    level = len(line)-len(line.lstrip('#'))
    size = {1:38,2:32,3:26}.get(level,23)
    face = font(size)
    text = line[level:].strip()
    wrapped = ''
    for char in text:
        if wrapped and face.getlength(wrapped+char)>width-72:
            rows.append(('text',(wrapped,face,level),size+9))
            wrapped = ''
        wrapped += char
    if level:
        rows.append(('space',None,14))
    rows.append(('text',(wrapped,face,level),size+10))
canvas = Image.new('RGB',(width,56+sum(h for _,_,h in rows)),'#faf9f5')
draw = ImageDraw.Draw(canvas)
y = 24
for kind,item,h in rows:
    if kind=='image':
        canvas.paste(item,(36,y))
    if kind=='text':
        text,face,level = item
        draw.text((36,y),text,font=face,fill='#145b59' if level else '#28333d')
    y += h
canvas.save(str(base)+'.png',optimize=True)

# Bound the height sent through QQ; keep the full-resolution PNG in the archive.
if canvas.height > 10000:
    for number, top in enumerate(range(0, canvas.height, 6000), 1):
        page = canvas.crop((0, top, canvas.width, min(top + 6000, canvas.height)))
        page.save(str(base)+f'.page-{number:03}.jpg', quality=88, optimize=True)
