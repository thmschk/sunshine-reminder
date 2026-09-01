from PIL import Image, ImageDraw, ImageFont
import qrcode
import pathlib

HERE = pathlib.Path(__file__).resolve().parent

R = "/usr/share/fonts/truetype/roboto/unhinted/RobotoTTF/Roboto-%s.ttf"
def font(s, n): return ImageFont.truetype(R % s, n)

W, H = 1240, 1754
CREAM, BERRY, YELLOW = (255, 252, 240), (160, 24, 80), (248, 216, 0)
INK, GREY = (30, 27, 19), (95, 90, 78)

im = Image.new("RGB", (W, H), CREAM)
d = ImageDraw.Draw(im)

M = 90
y = 90

def wrap(t, f, maxw):
    out, cur = [], ""
    for w in t.split():
        s = (cur + " " + w).strip()
        if d.textlength(s, font=f) <= maxw: cur = s
        else: out.append(cur); cur = w
    if cur: out.append(cur)
    return out

def block(t, f, fill, lh, gap=0, maxw=W - 2*M, x=M):
    global y
    for line in wrap(t, f, maxw):
        d.text((x, y), line, font=f, fill=fill); y += lh
    y += gap

d.text((M, y), "Schulessen vergessen?", font=font("Bold", 60), fill=BERRY); y += 76
d.text((M, y), "Das Handy erinnert dich.", font=font("Light", 46), fill=INK); y += 86

block("Eine kleine App sieht werktags von allein nach, ob für die nächsten "
      "Tage etwas bestellt ist — und meldet sich nur, wenn noch etwas offen ist.",
      font("Regular", 33), INK, 46, gap=24)
block("Kostenlos, ohne Werbung, ohne Server: Geprüft wird auf dem Handy, die "
      "Zugangsdaten verlassen es nur Richtung Bestellsystem.",
      font("Regular", 33), GREY, 46, gap=34)

# --- Screenshots, auf den Inhalt beschnitten ------------------------------
BOX = (0, 120, 1080, 1900)
sh = 505
top = y
for path, x in (("screenshot-status.png", M + 70), ("screenshot-einstellungen.png", W - M - 70 - 340)):
    s = Image.open(HERE / path).convert("RGB").crop(BOX)
    s = s.resize((int(s.width * sh / s.height), sh), Image.LANCZOS)
    d.rectangle([x-3, top-3, x+s.width+3, top+sh+3], outline=(224, 218, 200), width=3)
    im.paste(s, (x, top))
y = top + sh + 34
d.text((M, y), "Links: ein offener Tag.   Rechts: Uhrzeit und Vorwarnzeit einstellbar.",
       font=font("Italic", 26), fill=GREY); y += 56

# --- Kasten mit QR --------------------------------------------------------
# Der QR zeigt direkt auf die Datei, nicht auf die Projektseite: Wer den Zettel
# in der Hand haelt, will die App, nicht den Quelltext. Die Warnung beim
# Installieren steht darunter, die Anleitung ist also dabei.
APK = ("https://github.com/thmschk/sunshine-reminder"
       "/releases/latest/download/sunshine-reminder.apk")
bh = 318
d.rounded_rectangle([M, y, W - M, y + bh], radius=24,
                    fill=(255, 248, 214), outline=YELLOW, width=4)
qr = qrcode.QRCode(border=1, box_size=10, error_correction=qrcode.constants.ERROR_CORRECT_M)
qr.add_data(APK); qr.make(fit=True)
qs = 240
qx, qy = M + 28, y + (bh - qs)//2
im.paste(qr.make_image().convert("RGB").resize((qs, qs), Image.NEAREST), (qx, qy))
print(f"QR: {qs}px bei {qx},{qy} -> {APK}")

tx, ty = M + 28 + qs + 34, y + 40
d.text((tx, ty), "App herunterladen:", font=font("Medium", 31), fill=INK); ty += 48
for line in ("github.com/thmschk/sunshine-reminder/",
             "releases/latest/download/",
             "sunshine-reminder.apk"):
    d.text((tx, ty), line, font=font("Bold", 25), fill=BERRY); ty += 34
ty += 16
d.text((tx, ty), "Nur für Android — nicht fürs iPhone.", font=font("Regular", 26), fill=GREY)
ty += 38
d.text((tx, ty), "Quelltext: github.com/thmschk/sunshine-reminder",
       font=font("Regular", 22), fill=GREY)
y += bh + 30

block("Beim Installieren warnt Android, es kenne den Entwickler nicht. Das ist "
      "kein Fund, sondern heißt nur: Diese App kennt Google noch nicht. Der große "
      "Knopf bricht ab — weiter geht es über die kleine Zeile „Trotzdem "
      "installieren“.",
      font("Regular", 28), INK, 40)

# --- Fusszeile ------------------------------------------------------------
foot = wrap("Kein offizielles Angebot: Das Projekt steht in keiner Verbindung zu "
            "Sunshine Catering oder zum Hersteller des Bestellsystems. Privat "
            "gebaut, quelloffen, Nutzung auf eigene Verantwortung.",
            font("Regular", 22), W - 2*M)
fy = H - 40 - len(foot)*30
d.line([M, fy - 26, W - M, fy - 26], fill=(228, 222, 202), width=2)
for i, line in enumerate(foot):
    d.text((M, fy + i*30), line, font=font("Regular", 22), fill=GREY)

print("Inhalt endet bei y =", y, " Fusszeile beginnt bei", fy - 26,
      "->", "OK" if y < fy - 40 else "ÜBERLAUF")
im.save(HERE / "flugblatt.png"); im.save(HERE / "flugblatt.pdf", "PDF", resolution=150)
