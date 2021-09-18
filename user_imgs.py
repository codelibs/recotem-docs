import argparse
from pathlib import Path
import re
import sys
from zipfile import ZipFile

from PIL import Image, ImageDraw
from matplotlib import pyplot as plt
from matplotlib.patches import Rectangle


WIDTH_DEFAULT, HEIGHT_DEFAULT = (1280, 720)


def crop_relative(
    img: Image.Image, left: float, upper: float, right: float, lower: float
):
    return img.crop(
        (
            int(left * WIDTH_DEFAULT),
            int(upper * HEIGHT_DEFAULT),
            int(right * WIDTH_DEFAULT),
            int(lower * HEIGHT_DEFAULT),
        )
    )


def add_box(
    img, left: float, upper: float, right: float, lower: float, color="red", linewidth=1
):
    img = img.copy()
    xy1 = (int(left * WIDTH_DEFAULT), int(upper * HEIGHT_DEFAULT))
    xy2 = (int(right * WIDTH_DEFAULT), int(lower * HEIGHT_DEFAULT))
    draw = ImageDraw.Draw(img)
    draw.rectangle((xy1, xy2), fill=None, outline=color, width=linewidth)
    return img


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="A script to convert recotem Github Actions's img output to a tutorial page imgs."
    )
    parser.add_argument("input_zip_path", nargs=1)
    parser.add_argument("output_path", nargs=1)
    args = parser.parse_args()

    INPUT_ZIP_PATH = Path(args.input_zip_path[0])
    OUTPUT_PATH = Path(args.output_path[0])

    zf = ZipFile(INPUT_ZIP_PATH)
    pngs = {
        x.filename: Image.open(zf.open(x))
        for x in zf.filelist
        if re.search("user\/[^\.]+\.[^\.]+\.png", x.filename)
    }
    pagename: str
    imgname: str
    for key, img in pngs.items():
        match = re.search("user\/([^\.]+)\.([^\.]+)\.png", key)
        pagename, imgname = match.groups()
        print(pagename, imgname)
        dir = OUTPUT_PATH / pagename
        dir.mkdir(parents=True, exist_ok=True)
        img.save(dir / f"{imgname}.png")
