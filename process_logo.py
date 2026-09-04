import sys
import subprocess

try:
    from PIL import Image
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pillow"])
    from PIL import Image

path = "c:/settings/www/rabar-electron/logo.png"

# Open the image
img = Image.open(path)

# Use grayscale as an alpha mask
mask = img.convert("L")

# Create a solid red background (Brand color #9F191E)
red_bg = Image.new("RGBA", img.size, (159, 25, 30, 255))

# Create a solid white foreground (for the logo itself)
white_fg = Image.new("RGBA", img.size, (255, 255, 255, 255))

# Composite them together - makes black perfectly red, keeps white as white
result = Image.composite(white_fg, red_bg, mask)

# Save the result, overwriting logo.png so it is red!
result.save(path)
print("Logo perfectly colored red and saved to logo.png!")
