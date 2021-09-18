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
        if re.search("tutorial/(\d+).*\.png", x.filename)
    }
    img_names_aligned = sorted(
        pngs.keys(), key=lambda x: int(re.search(r"tutorial/(\d+)\.", x).groups()[0])
    )

    def save_img_using_original_keyname(img: Image.Image, keyname: str):
        img.save((OUTPUT_PATH / keyname.strip("tutorial/")).open("wb"))

    IMG_1_KEY = "tutorial/1.input-login-info.png"
    img_1 = pngs[IMG_1_KEY]
    assert img_1.size == (WIDTH_DEFAULT, HEIGHT_DEFAULT)
    img_1 = crop_relative(img_1, 0.0, 0, 1.0, 0.5)
    save_img_using_original_keyname(img_1, IMG_1_KEY)

    IMG_2_KEY = "tutorial/2.project-top.png"
    img_2 = pngs[IMG_2_KEY]
    assert img_2.size == (WIDTH_DEFAULT, HEIGHT_DEFAULT)
    img_2 = add_box(img_2, 0.55, 0.1, 0.73, 0.17, linewidth=3)
    img_2 = crop_relative(img_2, 0.0, 0, 1.0, 0.6)
    save_img_using_original_keyname(img_2, IMG_2_KEY)

    IMG_3_KEY = "tutorial/3.fill-project-info.png"
    img_3 = pngs[IMG_3_KEY]
    img_3 = crop_relative(img_3, 0.0, 0, 1.0, 0.8)
    save_img_using_original_keyname(img_3, IMG_3_KEY)

    IMG_4_KEY = "tutorial/4.empty-project-top.png"
    img_4 = pngs[IMG_4_KEY]
    img_4 = crop_relative(img_4, 0.0, 0, 1.0, 0.6)
    save_img_using_original_keyname(img_4, IMG_4_KEY)

    IMG_5_KEY = "tutorial/5.file-input.png"
    img_5 = pngs[IMG_5_KEY]
    img_5 = add_box(img_5, 0.117, 0.3, 0.955, 0.365)
    img_5 = crop_relative(img_5, 0, 0, 1, 0.6)
    save_img_using_original_keyname(img_5, IMG_5_KEY)

    IMG_6_KEY = "tutorial/6.file-selection-done.png"
    img_6 = pngs[IMG_6_KEY]
    img_6 = crop_relative(img_6, 0, 0, 1, 0.6)
    save_img_using_original_keyname(img_6, IMG_6_KEY)

    IMG_7_KEY = "tutorial/7.split-config.png"
    img_7 = pngs[IMG_7_KEY]
    img_7 = crop_relative(img_7, 0, 0, 1, 0.7)
    save_img_using_original_keyname(img_7, IMG_7_KEY)

    IMG_8_KEY = "tutorial/8.evaluation-config.png"
    img_8 = pngs[IMG_8_KEY]
    img_8 = crop_relative(img_8, 0, 0, 1, 0.7)
    save_img_using_original_keyname(img_8, IMG_8_KEY)

    IMG_9_KEY = "tutorial/9.job-config.png"
    img_9 = pngs[IMG_9_KEY]
    img_9 = crop_relative(img_9, 0, 0, 1, 0.7)
    save_img_using_original_keyname(img_9, IMG_9_KEY)

    IMG_10_KEY = "tutorial/10.tuning-job.png"
    img_10 = pngs[IMG_10_KEY]
    img_10 = add_box(img_10, 0.075, 0.89, 0.97, 0.975, linewidth=3)
    save_img_using_original_keyname(img_10, IMG_10_KEY)

    IMG_11_KEY = "tutorial/11.tuning-logs.png"
    img_11 = pngs[IMG_11_KEY]
    save_img_using_original_keyname(img_11, IMG_11_KEY)

    IMG_12_KEY = "tutorial/12.tuning-results.png"
    img_12 = pngs[IMG_12_KEY]
    img_12 = add_box(img_12, 0.275, 0.51, 0.306, 0.57, linewidth=4)
    save_img_using_original_keyname(img_12, IMG_12_KEY)

    img_13 = pngs[img_names_aligned[12]]
    img_13 = crop_relative(img_13, 0.0, 0.0, 1, 0.6)
    save_img_using_original_keyname(img_13, img_names_aligned[12])

    img_14 = pngs[img_names_aligned[13]]
    save_img_using_original_keyname(img_14, img_names_aligned[13])

    img_15 = pngs[img_names_aligned[14]]
    img_15 = add_box(img_15, 0, 0.19, 0.043, 0.29, linewidth=3)
    img_15 = add_box(img_15, 0.85, 0.48, 0.96, 0.565, linewidth=3, color="blue")
    save_img_using_original_keyname(
        crop_relative(img_15, 0, 0, 1.0, 0.8), img_names_aligned[14]
    )

    img_16 = pngs[img_names_aligned[15]]
    img_16 = add_box(img_16, 0.215, 0.43, 0.81, 0.5, linewidth=3)
    save_img_using_original_keyname(
        crop_relative(img_16, 0, 0.3, 1, 0.7), img_names_aligned[15]
    )

    img_17 = pngs[img_names_aligned[16]]
    img_17 = add_box(img_17, 0, 0.365, 0.043, 0.47, linewidth=3)
    img_17 = add_box(img_17, 0.09, 0.295, 0.943, 0.37, linewidth=3, color="blue")
    save_img_using_original_keyname(
        crop_relative(img_17, 0, 0, 1, 0.6), img_names_aligned[16]
    )

    img_18 = pngs[img_names_aligned[17]]
    img_18 = add_box(img_18, 0.77, 0.41, 0.96, 0.48, linewidth=3)
    save_img_using_original_keyname(
        crop_relative(img_18, 0, 0, 1, 0.6), img_names_aligned[17]
    )

    save_img_using_original_keyname(pngs[img_names_aligned[18]], img_names_aligned[18])

    img_names_aligned[18]
