package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/color"
	_ "image/jpeg"
	_ "image/png"
	"strings"

	"github.com/deepteams/webp"
)

const (
	maxImageInputBytes = 15 * 1024 * 1024
	maxImagePixels     = 40_000_000
	maxStoredDimension = 2400
)

func convertImageDataURLToWebP(value string) ([]byte, error) {
	header, encoded, found := strings.Cut(value, ",")
	if !found || !strings.HasPrefix(header, "data:image/") ||
		!strings.HasSuffix(strings.ToLower(header), ";base64") {
		return nil, errors.New("clipboard image is not a base64 image data URL")
	}
	declaredType := strings.TrimSuffix(
		strings.TrimPrefix(strings.ToLower(header), "data:"),
		";base64",
	)
	switch declaredType {
	case "image/png", "image/jpeg", "image/jpg", "image/webp":
	default:
		return nil, errors.New("only PNG, JPEG, and WebP images are supported")
	}
	if base64.StdEncoding.DecodedLen(len(encoded)) > maxImageInputBytes {
		return nil, errors.New("clipboard image exceeds the 15 MiB input limit")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, errors.New("clipboard image contains invalid base64")
	}
	if len(data) == 0 || len(data) > maxImageInputBytes {
		return nil, errors.New("clipboard image has an invalid size")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || !supportedDecodedImageFormat(format) {
		return nil, errors.New("clipboard image is not a valid PNG, JPEG, or WebP image")
	}
	if config.Width <= 0 || config.Height <= 0 ||
		int64(config.Width)*int64(config.Height) > maxImagePixels {
		return nil, errors.New("clipboard image dimensions are too large")
	}
	decoded, decodedFormat, err := image.Decode(bytes.NewReader(data))
	if err != nil || decodedFormat != format {
		return nil, errors.New("clipboard image could not be decoded")
	}
	decoded = resizeImage(decoded, maxStoredDimension)
	var output bytes.Buffer
	if err := webp.Encode(&output, decoded, &webp.EncoderOptions{
		Quality: 86,
		Method:  4,
	}); err != nil {
		return nil, fmt.Errorf("convert clipboard image to WebP: %w", err)
	}
	if output.Len() == 0 {
		return nil, errors.New("clipboard image conversion produced no data")
	}
	return output.Bytes(), nil
}

func supportedDecodedImageFormat(format string) bool {
	return format == "png" || format == "jpeg" || format == "webp"
}

func resizeImage(source image.Image, maximum int) image.Image {
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= maximum && height <= maximum {
		return source
	}
	scale := float64(maximum) / float64(max(width, height))
	targetWidth := max(1, int(float64(width)*scale))
	targetHeight := max(1, int(float64(height)*scale))
	target := image.NewNRGBA(image.Rect(0, 0, targetWidth, targetHeight))
	for y := 0; y < targetHeight; y++ {
		sourceY := bounds.Min.Y + y*height/targetHeight
		for x := 0; x < targetWidth; x++ {
			sourceX := bounds.Min.X + x*width/targetWidth
			target.Set(x, y, color.NRGBAModel.Convert(source.At(sourceX, sourceY)))
		}
	}
	return target
}
