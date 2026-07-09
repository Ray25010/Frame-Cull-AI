#!/bin/zsh
set -u
export TK_SILENCE_DEPRECATION=1

cd "$(dirname "$0")"

echo "FrameCull Lightroom rating exporter"
echo "This tool only reads Lightroom Classic catalogs and writes a return zip."
echo

OUTPUT_DIR=$(/usr/bin/osascript <<'APPLESCRIPT'
try
  set chosenFolder to choose folder with prompt "Choose where to save the FrameCull rating return file"
  POSIX path of chosenFolder
on error
  POSIX path of (path to desktop folder)
end try
APPLESCRIPT
)

PHOTO_DIR=$(/usr/bin/osascript <<'APPLESCRIPT'
try
  display dialog "Optional: choose the photo folder to match only this shoot. Click Skip if you do not know it." buttons {"Skip", "Choose Folder"} default button "Skip"
  if button returned of result is "Choose Folder" then
    set chosenFolder to choose folder with prompt "Optional: choose the photo folder"
    POSIX path of chosenFolder
  else
    ""
  end if
on error
  ""
end try
APPLESCRIPT
)

echo "Output folder: $OUTPUT_DIR"
if [ -n "$PHOTO_DIR" ]; then
  echo "Photo folder: $PHOTO_DIR"
  python3 lightroom_rating_exporter.py --output "$OUTPUT_DIR" --photo-dir "$PHOTO_DIR"
else
  echo "Photo folder: not specified"
  python3 lightroom_rating_exporter.py --output "$OUTPUT_DIR"
fi

STATUS=$?

echo
if [ "$STATUS" -eq 0 ]; then
  echo "Done. Please send back the generated framecull-lr-ratings-*.zip file."
  /usr/bin/open "$OUTPUT_DIR" >/dev/null 2>&1 || true
else
  echo "Failed. Please copy the error text in this Terminal window and send it back."
fi
echo
echo "Press Enter to close."
read
