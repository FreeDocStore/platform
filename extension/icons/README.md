Extension toolbar icons at 16/48/128 px. Chrome's manifest requires PNG
for `manifest.icons`, so we ship rasters here even though the source of
truth is `brand/assets/monogram.svg`.

To regenerate after a monogram change, from the repo root:

```sh
for size in 16 48 128; do
  sips -s format png --resampleHeightWidth $size $size \
    brand/assets/monogram.svg \
    --out extension/icons/icon-$size.png >/dev/null
done
```

`sips` is macOS-only; on Linux use `rsvg-convert` or ImageMagick's
`magick convert` instead. Commit the regenerated PNGs - Chrome can't
load SVGs from `manifest.icons`.

The build copies `extension/icons/` verbatim into `dist/icons/`.
