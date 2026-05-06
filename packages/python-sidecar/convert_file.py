#!/usr/bin/env python3
"""
the-brain File Converter — MarkItDown wrapper.

Converts any file to clean Markdown using Microsoft's MarkItDown.
Supports: PDF, DOCX, PPTX, XLSX, HTML, images (OCR), CSV, JSON, XML,
          ZIP archives, and 20+ other formats.

Usage:
  uv run python3 convert_file.py /path/to/file.pdf
  uv run python3 convert_file.py --json /path/to/file.pdf

Output:
  Plain text: just the markdown content
  JSON mode:   {"success": true, "markdown": "...", "meta": {...}}
"""
import argparse
import json
import sys
from pathlib import Path


def convert_file(file_path: str) -> tuple[str, dict]:
    """Convert file to markdown. Returns (markdown, metadata)."""
    try:
        from markitdown import MarkItDown
    except ImportError:
        return "", {"error": "markitdown not installed", "hint": "Run: uv pip install markitdown[all]"}

    path = Path(file_path)
    if not path.exists():
        return "", {"error": f"File not found: {file_path}"}

    if not path.is_file():
        return "", {"error": f"Not a file: {file_path}"}

    meta = {
        "file_name": path.name,
        "file_size": path.stat().st_size,
        "file_extension": path.suffix.lower(),
        "format": "unknown",
    }

    try:
        md = MarkItDown()
        result = md.convert(str(path))
        text = result.text_content.strip() if result.text_content else ""

        # If result is empty, fall back to binary indicator
        if not text:
            text = f"[No extractable text content: {path.name}]"

        # Detect format from the actual converter used
        ext = path.suffix.lower()
        format_map = {
            ".pdf": "pdf",
            ".docx": "docx", ".doc": "doc",
            ".pptx": "pptx", ".ppt": "ppt",
            ".xlsx": "xlsx", ".xls": "xls", ".csv": "csv",
            ".html": "html", ".htm": "html",
            ".md": "markdown", ".txt": "text",
            ".json": "json", ".xml": "xml",
            ".png": "image", ".jpg": "image", ".jpeg": "image",
            ".gif": "image", ".webp": "image", ".bmp": "image",
            ".zip": "archive",
            ".mp3": "audio", ".wav": "audio", ".ogg": "audio",
        }
        meta["format"] = format_map.get(ext, ext.lstrip("."))
        meta["output_length"] = len(text)

        return text, meta

    except Exception as e:
        return "", {"error": f"Conversion failed: {str(e)}", **meta}


def main():
    parser = argparse.ArgumentParser(
        description="Convert any file to markdown using MarkItDown",
    )
    parser.add_argument("file", help="Path to the file to convert")
    parser.add_argument(
        "--json", action="store_true",
        help="Output as JSON with metadata",
    )
    parser.add_argument(
        "--first-chars", type=int, default=0,
        metavar="N",
        help="Output only the first N characters (useful for previews)",
    )
    args = parser.parse_args()

    text, meta = convert_file(args.file)

    if meta.get("error") and not text:
        if args.json:
            json.dump({"success": False, "markdown": "", "meta": meta}, sys.stdout, indent=2, ensure_ascii=False)
        else:
            print(f"ERROR: {meta['error']}", file=sys.stderr)
        sys.exit(1)

    # Trim if requested
    if args.first_chars > 0 and len(text) > args.first_chars:
        text = text[: args.first_chars] + "\n\n[... truncated ...]"

    if args.json:
        json.dump(
            {"success": True, "markdown": text, "meta": meta},
            sys.stdout,
            indent=2,
            ensure_ascii=False,
        )
    else:
        print(text)


if __name__ == "__main__":
    main()
