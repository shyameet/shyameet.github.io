"""Crop and compress the deity images into public/art/photos/<id>.jpg.

Every image here is public domain -- Ravi Varma Press chromolithographs and a
Trichinopoly gouache, via Wikimedia Commons and the Wellcome Collection
(Public Domain Mark). Most devotional images online are NOT free to publish
(calendar art, wallpapers, digital paintings), so nothing enters this folder
without a stated licence; the credit shows under each on /darshan/.

The originals are not kept in the repo. To rebuild, fetch them from SOURCES
into a folder and run:   python src/make_photos.py <folder>

Crops are fractions of the original (x, y, width, height), chosen so the
face sits high in the arched frame the site puts round each image.
"""
import sys
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "public" / "art" / "photos"
MAX_W = 480   # frames show at <=200px; 480 stays sharp at 2x

SOURCES = {
    "surya":   "https://upload.wikimedia.org/wikipedia/commons/d/db/Surya_Narayana.jpg",
    "shiva":   "https://iiif.wellcomecollection.org/image/V0045134/full/1600,/0/default.jpg",
    "hanuman": "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1b/Hanuman_fetches_the_herb-bearing_mountain%2C_in_a_print_from_the_Ravi_Varma_Press%2C_1910%27s.jpg/960px-Hanuman_fetches_the_herb-bearing_mountain%2C_in_a_print_from_the_Ravi_Varma_Press%2C_1910%27s.jpg",
    "ganesha": "https://iiif.wellcomecollection.org/image/V0044933/full/960,/0/default.jpg",
    "vishnu":  "https://iiif.wellcomecollection.org/image/V0045133/full/960,/0/default.jpg",
    "kali":    "https://iiif.wellcomecollection.org/image/V0045118/full/960,/0/default.jpg",
    "bhairav": "https://upload.wikimedia.org/wikipedia/commons/3/36/Bhairava_drawing.jpg",
}

# left, top and width as fractions of the original; the height follows at 3:4
CROPS = {
    "surya":   (0.18, 0.06, 0.64),   # Surya and the sun disc, above the horses and the caption
    "shiva":   (0.335, 0.235, 0.43),  # Shiva with the Ganga falling onto his hair
    "hanuman": (0.10, 0.02, 0.80),   # face, gada and mountain; the caption strip dropped
    "ganesha": (0.00, 0.00, 1.00),   # already an arch around him
    "vishnu":  (0.12, 0.00, 0.76),   # Vishnu under Shesha's hood, the goddesses at the edges
    "kali":    (0.17, 0.01, 0.63),   # face, halo and arms, above the battlefield
    "bhairav": (0.00, 0.00, 1.00),   # whole, so his dog stays in
}


def main(src_dir):
    src_dir = Path(src_dir)
    OUT.mkdir(parents=True, exist_ok=True)
    for key, (fx, fy, fw) in CROPS.items():
        im = Image.open(src_dir / f"{key}.jpg").convert("RGB")
        W, H = im.size
        w = round(W * fw)
        h = round(w * 4 / 3)
        x = round(W * fx)
        y = round(H * fy)
        if y + h > H:                    # a tall crop on a short image: fit to height instead
            h = H - y
            w = round(h * 3 / 4)
            x = max(0, min(x, W - w))
        crop = im.crop((x, y, x + w, y + h))
        if crop.size[0] > MAX_W:
            crop = crop.resize((MAX_W, round(MAX_W * crop.size[1] / crop.size[0])), Image.LANCZOS)
        out = OUT / f"{key}.jpg"
        crop.save(out, "JPEG", quality=82, optimize=True, progressive=True)
        print(f"{key:8s} {crop.size[0]}x{crop.size[1]}  {out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
