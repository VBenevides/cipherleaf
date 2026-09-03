package app

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"

	"github.com/deepteams/webp"
)

func TestConvertPNGAndJPEGDataURLsToWebP(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 4, 3))
	source.SetNRGBA(1, 1, color.NRGBA{R: 20, G: 140, B: 220, A: 255})
	tests := []struct {
		name     string
		mimeType string
		encode   func(*bytes.Buffer) error
	}{
		{
			name:     "PNG",
			mimeType: "image/png",
			encode:   func(output *bytes.Buffer) error { return png.Encode(output, source) },
		},
		{
			name:     "JPEG",
			mimeType: "image/jpeg",
			encode: func(output *bytes.Buffer) error {
				return jpeg.Encode(output, source, &jpeg.Options{Quality: 90})
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var encoded bytes.Buffer
			if err := test.encode(&encoded); err != nil {
				t.Fatal(err)
			}
			dataURL := "data:" + test.mimeType + ";base64," +
				base64.StdEncoding.EncodeToString(encoded.Bytes())
			converted, err := convertImageDataURLToWebP(dataURL)
			if err != nil {
				t.Fatal(err)
			}
			if len(converted) < 12 ||
				string(converted[:4]) != "RIFF" ||
				string(converted[8:12]) != "WEBP" {
				t.Fatal("converted image is not WebP")
			}
			config, err := webp.DecodeConfig(bytes.NewReader(converted))
			if err != nil {
				t.Fatal(err)
			}
			if config.Width != 4 || config.Height != 3 {
				t.Fatalf("converted size = %dx%d", config.Width, config.Height)
			}
		})
	}
}

func TestConvertImageDataURLRejectsUnsupportedFormats(t *testing.T) {
	if _, err := convertImageDataURLToWebP("data:image/svg+xml;base64,PHN2Zz4="); err == nil {
		t.Fatal("SVG input unexpectedly accepted")
	}
}

func TestResizeImage(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 4, 2))
	if got := resizeImage(source, 10); got != source {
		t.Fatal("image larger than the limit should not be resized")
	}
	resized := resizeImage(source, 2)
	if resized.Bounds().Dx() != 2 || resized.Bounds().Dy() != 1 {
		t.Fatalf("resized bounds = %v", resized.Bounds())
	}
}
